import { randomUUID } from 'node:crypto'
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
import type { EditMode } from './core/defaults.ts'
import { dshSystemSections } from './core/dsh-prompt.ts'
import { currentDateLine } from './core/prompt.ts'
import type { RelayOptions } from './core/relay.ts'
import { buildCatalog, type ToolMode, type ToolNames, type ToolOverride } from './core/tools.ts'
import type { WorklistOptions } from './core/worklist.ts'
import { setFoldedUnreadPaths } from './folded-read-guard.ts'
import { historyFromMessages, systemText } from './history.ts'
import { liveWire } from './live-wire.ts'
import { repairToolPaths, runtimeCwd } from './paths.ts'
import { RelayCardStore } from './relay-store.ts'
import { buildExcludedTools } from './session-setup.ts'
import {
  appendSessionTrace,
  argumentChanges,
  clipArguments,
  TraceLocation,
  type ArgumentChange,
  type TraceRecord,
} from './traces.ts'

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
  /** rwkv_lightning only: initial state uploaded through /v1/state/upload. */
  readonly stateId?: string
  /** rwkv_lightning only: adapter id for request-level adaptation. */
  readonly adapterId?: string
  /** Legacy (pre-94b3734) form of adapterId; only its id is read. */
  readonly adapter?: { readonly id?: string }
  /** Per-model harness overrides (e.g. thinking: off for a non-thinking checkpoint). */
  readonly thinking?: 'off' | 'full'
  /** agent-wire-think-v2.0 history for think-sft checkpoints. */
  readonly historyEmptyThink?: boolean
}

export interface AdapterSettings {
  readonly models: readonly ModelConfig[]
  readonly harness: HarnessConfig
  readonly toolMode: ToolMode
  readonly toolNames: ToolNames
  readonly editMode?: EditMode
  readonly excludeTools: readonly string[]
  readonly toolOverrides?: Readonly<Record<string, ToolOverride>>
  readonly includeDeveloper: boolean
  readonly currentDate?: boolean
  readonly timeZone?: string
  readonly loopGuard: boolean
  readonly traces?: TraceLocation
  readonly relay?: RelayOptions
  readonly worklist?: WorklistOptions
  readonly onFoldEvent?: (sessionId: string, fold: { readonly kind: string; readonly beforeTokens: number; readonly afterTokens: number; readonly foldedTools: number }) => void
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
  private readonly current: () => AdapterSettings
  private readonly clients = new Map<string, Generator>()
  private readonly relayCards = new RelayCardStore()

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
    return Promise.resolve(this.settings.models.map(model => {
      const adapterId = model.adapterId ?? model.adapter?.id
      return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        description: `${model.backend === 'irwkv' ? 'iRWKV' : 'rwkv_lightning'} · ${model.model}${model.stateId ? ` · state ${model.stateId}` : ''}${adapterId ? ` · adapter ${adapterId}` : ''}`,
        inputModalities: ['text'] as const,
      }
    }))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const config = this.model(model)
    return Promise.resolve({
      provider,
      id: model,
      name: config.name ?? config.id,
      inputModalities: ['text'] as const,
      context: { contextWindow: config.contextWindow ?? 32768 },
      defaultMaxTokens: this.settings.harness.answerMaxTokens,
    })
  }

  private model(id: string): ModelConfig {
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
    const adapterId = config.adapterId ?? config.adapter?.id
    if (config.backend === 'irwkv') {
      if (config.stateId || adapterId) {
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
        ...config.stateId ? { stateId: config.stateId } : {},
        ...adapterId ? { adapterId } : {},
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
      ...this.settings.relay === undefined ? {} : { relay: this.settings.relay },
      ...this.settings.worklist === undefined ? {} : { worklist: this.settings.worklist },
    }
    const names = this.settings.toolNames
    const exclude = buildExcludedTools({
      excludeTools: this.settings.excludeTools,
      editMode: this.settings.editMode,
      worklist: this.settings.worklist,
    })
    const catalog = buildCatalog(options.tools ?? [], { mode: this.settings.toolMode, names, exclude, overrides: this.settings.toolOverrides })
    const history = historyFromMessages(options.messages, catalog, {
      includeDeveloper: this.settings.includeDeveloper,
      names,
      dropTimeContext: this.settings.currentDate === true,
    })
    const systemHead = names === 'dsh' ? dshSystemSections(options.system ?? systemText(options.messages)) : undefined

    const queue: StreamChunk[] = []
    let wake: (() => void) | undefined
    const push = (chunk: StreamChunk) => {
      queue.push(chunk)
      wake?.()
    }
    let reasoningOpen = false
    let reasoning = ''
    let textOpen = false
    let textIndex = 0
    let streamedText = ''
    let nextIndex = 0
    let attempts = 0
    const closeReasoning = () => {
      if (!reasoningOpen) return
      push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
      reasoningOpen = false
      nextIndex = Math.max(nextIndex, 1)
    }
    const reasoningDelta = (text: string) => {
      if (textOpen) return
      if (!reasoningOpen) {
        push({ type: 'block-start', index: 0, blockType: 'reasoning' })
        reasoningOpen = true
        nextIndex = 1
      }
      reasoning += text
      push({ type: 'reasoning-delta', index: 0, text })
    }
    const textDelta = (text: string) => {
      if (text === '') return
      if (!textOpen) {
        closeReasoning()
        textIndex = nextIndex++
        push({ type: 'block-start', index: textIndex, blockType: 'text' })
        textOpen = true
      }
      streamedText += text
      push({ type: 'text-delta', index: textIndex, text })
    }
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const cwd = runtimeCwd(history)
    const location = this.settings.traces
    const writeLine = (fields: Record<string, unknown>) => {
      const record = { at: new Date().toISOString(), model: config.id, purpose: options.purpose, ...fields } as TraceRecord
      appendSessionTrace(sessionId, location, record)
    }
    const writeTrace = (trace: GenerationTrace) => writeLine({ ...trace })

    let settled = false
    const work = (async () => {
      const relayLocation = location ?? new TraceLocation()
      return decideStep({
        history,
        tools: catalog,
        config: harness,
        generator: this.client(config),
        ...systemHead ? { systemHead } : {},
        ...options.signal ? { signal: options.signal } : {},
        ...sessionId ? { sessionId } : {},
        ...cwd !== undefined ? { cwd } : {},
        ...this.settings.relay === undefined || sessionId === undefined ? {} : {
          relay: {
            cards: this.relayCards.load(relayLocation, sessionId),
            save: card => this.relayCards.append(relayLocation, sessionId, card),
          },
        },
        hooks: {
          ...harness.thinking === 'full' ? { reasoning: reasoningDelta } : {},
          text: textDelta,
          attempt: label => {
            if (attempts++ > 0 && reasoningOpen) reasoningDelta(`\n\n[harness: ${label}]\n\n`)
          },
          trace: writeTrace,
          ...(sessionId !== undefined && options.purpose === undefined ? {
            wireStart: info => liveWire.start(sessionId, { model: config.id, ...info }),
            wireDelta: delta => liveWire.delta(sessionId, delta),
            wireEnd: info => liveWire.finish(sessionId, info),
          } : {}),
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
      if (textOpen) yield { type: 'block-end', index: textIndex, block: { type: 'text', text: streamedText } }
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'rwkv: request aborted', code: 'ABORTED' } } }
        return
      }
      throw llmError(error)
    }
    setFoldedUnreadPaths(sessionId, step.foldedUnread ?? [])
    if (sessionId !== undefined && step.foldEvent !== undefined && options.purpose === undefined) {
      this.settings.onFoldEvent?.(sessionId, step.foldEvent)
    }
    if (reasoningOpen) {
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      reasoningOpen = false
      nextIndex = Math.max(nextIndex, 1)
    }
    const { decision } = step
    const repairs = decision.type === 'tool' ? [...decision.repairs] : []
    let handed: { args: Record<string, unknown>; changes: ArgumentChange[] } | undefined
    if (decision.type === 'final') {
      if (textOpen) {
        if (decision.text.startsWith(streamedText)) {
          const rest = decision.text.slice(streamedText.length)
          if (rest !== '') {
            streamedText += rest
            yield { type: 'text-delta', index: textIndex, text: rest }
          }
        }
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: streamedText || decision.text } }
      } else {
        const index = nextIndex++
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: decision.text }
        yield { type: 'block-end', index, block: { type: 'text', text: decision.text } }
      }
    } else {
      if (textOpen) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: streamedText } }
        textOpen = false
      }
      const index = nextIndex++
      const id = brandString<ToolCallId>(`call_${randomUUID().replace(/-/g, '').slice(0, 24)}`)
      const dshArgs = decision.tool.toDsh(decision.args)
      const pathed = harness.outputRepairs ? repairToolPaths(decision.tool.dshName, dshArgs, cwd) : dshArgs
      if (pathed !== dshArgs) repairs.push('path_repaired')
      const argumentsText = JSON.stringify(pathed)
      handed = {
        args: clipArguments(pathed),
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
    writeLine({
      stage: 'step',
      decision: decision.type === 'tool' ? `tool ${decision.tool.dshName}` : `final ${decision.via}`,
      repairs,
      ...handed ? { args: handed.args, changes: handed.changes } : {},
      generations: step.generations,
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
