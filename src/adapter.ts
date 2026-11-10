import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
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
import { dshSystemSections } from './core/dsh-prompt.ts'
import { currentDateLine } from './core/prompt.ts'
import { buildCatalog, type ToolMode, type ToolNames } from './core/tools.ts'
import { historyFromMessages, systemText } from './history.ts'
import { argumentChanges, clipArguments, memoryTraces, type ArgumentChange, type TraceLocation } from './traces.ts'
import { repairToolPaths, runtimeCwd } from './paths.ts'

/** Pending appends per trace file, so records keep their order. */
const traceWrites = new Map<string, Promise<void>>()
/** Trace files this process has started writing; the first write also flushes what memory held before. */
const traceStarted = new Set<string>()

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
  /** rwkv_lightning only: initial state uploaded through /v1/state/upload (the server drops uploads when it restarts). */
  readonly stateId?: string
  /** Per-model harness overrides (e.g. thinking: off for a non-thinking checkpoint). */
  readonly thinking?: 'off' | 'full'
  /** agent-wire-think-v2.0 history for think-sft checkpoints. */
  readonly historyEmptyThink?: boolean
}

export interface AdapterSettings {
  readonly models: readonly ModelConfig[]
  readonly harness: HarnessConfig
  readonly toolMode: ToolMode
  /** dsh: DSH tool names and DSH's system prompt (filtered); trained: the agent-tool-v3 names and the Go-aligned prompt. */
  readonly toolNames: ToolNames
  readonly excludeTools: readonly string[]
  readonly includeDeveloper: boolean
  /** System prompt ends with currentDateLine; time-context readings are dropped from the history. */
  readonly currentDate?: boolean
  /** IANA zone for the date line; absent: the zone of the process (its TZ). */
  readonly timeZone?: string
  readonly loopGuard: boolean
  /** Where to write per-session JSONL traces (absent: memory only). */
  readonly traces?: TraceLocation
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
      description: `${model.backend === 'irwkv' ? 'iRWKV' : 'rwkv_lightning'} · ${model.model}${model.stateId ? ` · state ${model.stateId}` : ''}`,
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
      if (config.stateId) {
        throw new LlmError(`rwkv: model "${config.id}" sets stateId, which iRWKV does not support`, 'INVALID_MODEL_CONFIG')
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
        ...config.stateId ? { stateId: config.stateId } : {},
        ...config.headers ? { headers: config.headers } : {},
        loopGuard: this.settings.loopGuard,
      })
    }
    this.clients.set(key, client)
    return client
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
      ...this.settings.currentDate ? { dateLine: currentDateLine(Date.now(), this.settings.timeZone) } : {},
    }
    const names = this.settings.toolNames
    const catalog = buildCatalog(options.tools ?? [], { mode: this.settings.toolMode, names, exclude: this.settings.excludeTools })
    const history = historyFromMessages(options.messages, catalog, { includeDeveloper: this.settings.includeDeveloper, names, dropTimeContext: this.settings.currentDate === true })
    const systemHead = names === 'dsh' ? dshSystemSections(options.system ?? systemText(options.messages)) : undefined

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
    const location = this.settings.traces
    const writeLine = (fields: Record<string, unknown>) => {
      const record = { at: new Date().toISOString(), model: config.id, purpose: options.purpose, ...fields }
      const memoryKey = sessionId ?? 'no-session'
      // Always kept in memory for the RWKV tab; written to disk only when recording is on.
      memoryTraces.add(memoryKey, record)
      // Next to the DSH session log; undefined until DSH has created the session directory.
      const traceFile = sessionId === undefined ? undefined : location?.path(sessionId)
      if (traceFile === undefined) return
      const traceDir = dirname(traceFile)
      let records: readonly unknown[] = [record]
      if (!traceStarted.has(traceFile)) {
        traceStarted.add(traceFile)
        // A new file gets what memory collected before the directory existed (or before recording was on).
        if (!existsSync(traceFile)) records = memoryTraces.get(memoryKey) ?? [record]
      }
      const line = records.map(item => `${JSON.stringify(item)}\n`).join('')
      // One append chain per file: a request summary must land after the generations it summarizes.
      const previous = traceWrites.get(traceFile) ?? Promise.resolve()
      const next = previous.then(() => mkdir(traceDir, { recursive: true })).then(() => appendFile(traceFile, line)).catch(() => {})
      traceWrites.set(traceFile, next)
      void next.then(() => { if (traceWrites.get(traceFile) === next) traceWrites.delete(traceFile) })
    }
    const writeTrace = (trace: GenerationTrace) => writeLine({ ...trace })

    let settled = false
    const work = (async () => {
      return decideStep({
        history,
        tools: catalog,
        config: harness,
        generator: this.client(config),
        ...systemHead ? { systemHead } : {},
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
    const repairs = decision.type === 'tool' ? [...decision.repairs] : []
    let handed: { args: Record<string, unknown>; changes: ArgumentChange[] } | undefined
    if (decision.type === 'final') {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: decision.text }
      yield { type: 'block-end', index, block: { type: 'text', text: decision.text } }
    } else {
      const id = brandString<ToolCallId>(`call_${randomUUID().replace(/-/g, '').slice(0, 24)}`)
      const dshArgs = decision.tool.toDsh(decision.args)
      const pathed = harness.outputRepairs ? repairToolPaths(decision.tool.dshName, dshArgs, runtimeCwd(history)) : dshArgs
      if (pathed !== dshArgs) repairs.push('path_repaired')
      const argumentsText = JSON.stringify(pathed)
      handed = {
        args: clipArguments(pathed),
        // Model's arguments vs the repaired ones (same names), then the path repair on the DSH side.
        changes: [...argumentChanges(decision.rawArgs, decision.args), ...argumentChanges(dshArgs, pathed)].map(change => ({
          ...change,
          ...'before' in change ? { before: clipArguments({ value: change.before }, 200).value } : {},
          ...'after' in change ? { after: clipArguments({ value: change.after }, 200).value } : {},
        })),
      }
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: decision.tool.dshName, argumentsDelta: argumentsText }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: decision.tool.dshName, arguments: argumentsText } }
    }
    // One record per DSH request: what was handed to DSH and what it took to get there.
    writeLine({
      stage: 'step',
      decision: decision.type === 'tool' ? `tool ${decision.tool.dshName}` : `final ${decision.via}`,
      repairs,
      ...handed ? { args: handed.args, changes: handed.changes } : {},
      generations: step.generations,
      /** Generation attempts (first try + re-asks); think resumes are not attempts. */
      attempts,
      outputRepairs: harness.outputRepairs,
      guards: harness.guards,
    })
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
