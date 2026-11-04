import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { BackendError, type Generator } from './backend/generator.ts'
import { IRWKVClient } from './backend/irwkv.ts'
import { LightningClient } from './backend/lightning.ts'
import { decideStep, type GenerationTrace, type HarnessConfig } from './core/agent.ts'
import { buildCatalog, type ToolMode } from './core/tools.ts'
import { historyFromMessages } from './history.ts'
import { repairToolPaths, runtimeCwd } from './paths.ts'

/** Route model id that resolves to the first configured model. */
export const DEFAULT_MODEL_ID = 'default'

export interface ModelConfig {
  readonly id: string
  readonly name?: string
  readonly backend: 'lightning' | 'irwkv'
  readonly baseURL: string
  /** Upstream model id. */
  readonly model: string
  /** iRWKV bearer key or rwkv_lightning password. */
  readonly apiKey?: string
  /** Extra request headers, e.g. Cloudflare Access service-token headers. */
  readonly headers?: Record<string, string>
  readonly contextWindow?: number
  /** rwkv_lightning only: uploaded state id. */
  readonly stateId?: string
  /** rwkv_lightning only: MiSS / LoRA / NoRA adapter used for every request of this model. */
  readonly adapter?: {
    readonly id?: string
    /** Local adapter package, uploaded when the server does not list the id. */
    readonly file?: string
    /** Path on the inference server, registered when the server does not list the id. */
    readonly serverPath?: string
  }
  /** Per-model harness overrides (e.g. thinking: off for a non-thinking checkpoint). */
  readonly thinking?: 'off' | 'full'
  /** agent-wire-think-v2.0 history for think-sft checkpoints. */
  readonly historyEmptyThink?: boolean
}

export interface AdapterSettings {
  readonly models: readonly ModelConfig[]
  readonly harness: HarnessConfig
  readonly toolMode: ToolMode
  readonly excludeTools: readonly string[]
  readonly includeDeveloper: boolean
  readonly loopGuard: boolean
  /** Directory for per-session JSONL traces of every generation (prompt bytes and raw output). */
  readonly traceDir?: string
  readonly log?: (message: string) => void
}

function llmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof BackendError) {
    return new LlmError(`rwkv: ${error.message}`, error.code, error.status === undefined ? undefined : { status: error.status })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new LlmError(`rwkv: ${message || 'request failed'}`, 'PROVIDER_NETWORK_ERROR')
}

export class RwkvAdapter extends LlmAdapter {
  /** Live settings: read per call, so edits saved from the settings page apply to the next request. */
  private readonly current: () => AdapterSettings
  private readonly clients = new Map<string, Generator>()
  private readonly adapterReady = new Map<string, Promise<void>>()

  constructor(settings: () => AdapterSettings) {
    super()
    this.current = settings
  }

  private get settings(): AdapterSettings {
    return this.current()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'RWKV' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.settings.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      description: `${model.backend === 'irwkv' ? 'iRWKV' : 'rwkv_lightning'} · ${model.model}${model.adapter?.id ? ` · adapter ${model.adapter.id}` : ''}`,
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const config = this.model(model)
    return Promise.resolve({
      provider,
      // The requested id, so a `default` route resolves to itself.
      id: model,
      name: config.name ?? config.id,
      inputModalities: ['text'] as const,
      context: { contextWindow: config.contextWindow ?? 32768 },
      defaultMaxTokens: this.settings.harness.answerMaxTokens,
    })
  }

  private model(id: string): ModelConfig {
    // `default` names the first configured model, so the bundle's rwkv_agent
    // row works before the user has picked model ids of their own.
    const models = this.settings.models
    const config = id === DEFAULT_MODEL_ID && !models.some(model => model.id === id) ? models[0] : models.find(model => model.id === id)
    if (config === undefined) {
      throw new LlmError(`rwkv: unknown model "${id}"; configured: ${this.settings.models.map(model => model.id).join(', ') || 'none'}`, 'MODEL_NOT_FOUND')
    }
    return config
  }

  client(config: ModelConfig): Generator {
    const key = JSON.stringify([config, this.settings.loopGuard])
    let client = this.clients.get(key)
    if (client !== undefined) return client
    if (config.backend === 'irwkv') {
      if (config.adapter?.id || config.stateId) {
        throw new LlmError(`rwkv: model "${config.id}" sets adapter/stateId, which iRWKV does not support`, 'INVALID_MODEL_CONFIG')
      }
      client = new IRWKVClient({
        baseURL: config.baseURL,
        model: config.model,
        ...config.apiKey ? { apiKey: config.apiKey } : {},
        ...config.headers ? { headers: config.headers } : {},
        loopGuard: this.settings.loopGuard,
      })
    } else {
      client = new LightningClient({
        baseURL: config.baseURL,
        model: config.model,
        ...config.apiKey ? { password: config.apiKey } : {},
        ...config.adapter?.id ? { adapterId: config.adapter.id } : {},
        ...config.stateId ? { stateId: config.stateId } : {},
        ...config.headers ? { headers: config.headers } : {},
        loopGuard: this.settings.loopGuard,
      })
    }
    this.clients.set(key, client)
    return client
  }

  /**
   * Makes sure the model's adapter exists on the server: uploads the local
   * file or registers the server path when the id is not listed. A restart
   * of the inference server drops uploads, so a failed check is retried on
   * the next request.
   */
  ensureAdapter(config: ModelConfig): Promise<void> {
    const adapter = config.adapter
    const adapterId = adapter?.id
    if (config.backend !== 'lightning' || adapter === undefined || !adapterId) return Promise.resolve()
    const key = JSON.stringify([config.baseURL, adapter])
    let ready = this.adapterReady.get(key)
    if (ready === undefined) {
      const client = this.client(config) as LightningClient
      ready = (async () => {
        const listed = await client.listAdapters()
        if (listed.some(item => item.id === adapterId)) return
        if (adapter.file) {
          this.settings.log?.(`uploading adapter ${adapterId} from ${adapter.file}`)
          const version = await client.uploadAdapter(adapterId, adapter.file)
          this.settings.log?.(`adapter ${adapterId} registered as version ${version}`)
        } else if (adapter.serverPath) {
          const version = await client.registerAdapterPath(adapterId, adapter.serverPath)
          this.settings.log?.(`adapter ${adapterId} registered from server path as version ${version}`)
        } else {
          throw new LlmError(`rwkv: adapter "${adapterId}" is not on ${config.baseURL} and the model config gives no file or serverPath`, 'ADAPTER_MISSING')
        }
      })()
      ready.catch(() => this.adapterReady.delete(key))
      this.adapterReady.set(key, ready)
    }
    return ready
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = this.model(options.model)
    if (options.stop !== undefined && options.stop.length > 0) {
      throw new LlmError('rwkv: custom stop sequences are not supported; the harness owns the RWKV stops', 'UNSUPPORTED_OPTION')
    }
    const harness: HarnessConfig = {
      ...this.settings.harness,
      ...config.thinking ? { thinking: config.thinking } : {},
      ...config.historyEmptyThink === undefined ? {} : { historyEmptyThink: config.historyEmptyThink },
      ...options.temperature === undefined ? {} : { sampling: { ...this.settings.harness.sampling, temperature: options.temperature } },
      ...options.maxTokens === undefined ? {} : {
        decisionMaxTokens: Math.min(this.settings.harness.decisionMaxTokens, options.maxTokens),
        answerMaxTokens: Math.min(this.settings.harness.answerMaxTokens, options.maxTokens),
      },
    }
    const catalog = buildCatalog(options.tools ?? [], { mode: this.settings.toolMode, exclude: this.settings.excludeTools })
    const history = historyFromMessages(options.messages, catalog, { includeDeveloper: this.settings.includeDeveloper })

    // Bridge the harness callbacks to this async generator.
    const queue: StreamChunk[] = []
    let wake: (() => void) | undefined
    const push = (chunk: StreamChunk) => {
      queue.push(chunk)
      wake?.()
    }
    let reasoningOpen = false
    let reasoning = ''
    let attempts = 0
    const reasoningDelta = (text: string) => {
      if (!reasoningOpen) {
        push({ type: 'block-start', index: 0, blockType: 'reasoning' })
        reasoningOpen = true
      }
      reasoning += text
      push({ type: 'reasoning-delta', index: 0, text })
    }
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const traceFile = this.settings.traceDir ? join(this.settings.traceDir, `${sessionId ?? 'no-session'}.jsonl`) : undefined
    const writeTrace = (trace: GenerationTrace) => {
      if (traceFile === undefined) return
      const line = `${JSON.stringify({ at: new Date().toISOString(), model: config.id, purpose: options.purpose, ...trace })}\n`
      void mkdir(this.settings.traceDir!, { recursive: true }).then(() => appendFile(traceFile, line)).catch(() => {})
    }

    let settled = false
    const work = (async () => {
      await this.ensureAdapter(config)
      return decideStep({
        history,
        tools: catalog,
        config: harness,
        generator: this.client(config),
        ...options.signal ? { signal: options.signal } : {},
        ...sessionId ? { sessionId } : {},
        hooks: {
          ...harness.thinking === 'full' ? { reasoning: reasoningDelta } : {},
          attempt: label => {
            // Each retry is a fresh generation; mark it inside the reasoning.
            if (attempts++ > 0 && reasoningOpen) reasoningDelta(`\n\n[harness: ${label}]\n\n`)
          },
          trace: writeTrace,
        },
      })
    })().finally(() => {
      settled = true
      wake?.()
    })
    work.catch(() => {})

    while (!settled || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
        wake = undefined
        continue
      }
      yield queue.shift()!
    }

    let step
    try {
      step = await work
    } catch (error) {
      if (reasoningOpen) yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'rwkv: request aborted', code: 'ABORTED' } } }
        return
      }
      throw llmError(error)
    }
    let index = 0
    if (reasoningOpen) {
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      index = 1
    }
    const { decision } = step
    if (decision.type === 'final') {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: decision.text }
      yield { type: 'block-end', index, block: { type: 'text', text: decision.text } }
    } else {
      const id = brandString<ToolCallId>(`call_${randomUUID().replace(/-/g, '').slice(0, 24)}`)
      const argumentsText = JSON.stringify(repairToolPaths(decision.tool.dshName, decision.tool.toDsh(decision.args), runtimeCwd(history)))
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: decision.tool.dshName, argumentsDelta: argumentsText }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: decision.tool.dshName, arguments: argumentsText } }
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens: step.promptTokens,
        outputTokens: step.completionTokens,
        totalTokens: step.promptTokens + step.completionTokens,
      },
    }
    yield { type: 'finish', reason: decision.type === 'tool' ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }
}
