import {
  BackendError,
  flushPending,
  feedDelta,
  LoopGuard,
  sseData,
  type GenerateResult,
  type StreamState,
} from './generator.ts'
import type { FinishReason } from '../core/parse.ts'

export interface StreamChunkView {
  readonly delta: string
  readonly finish?: string
  /** Stop string the server matched (iRWKV stop_reason). */
  readonly stop?: string
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly error?: string
}

export interface ReadStreamOptions {
  readonly stops: readonly string[]
  readonly maxTokens: number
  readonly loopGuard: boolean
  readonly onDelta?: (text: string) => void
  /** Ends the upstream request once a client stop or the loop guard fires. */
  readonly abort: () => void
}

function finishOf(value: string | undefined): FinishReason {
  switch (value) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'abort':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** Reads an OpenAI-style SSE completion stream with client-side stops and the loop guard. */
export async function readCompletionStream(
  body: ReadableStream<Uint8Array>,
  view: (data: unknown) => StreamChunkView,
  options: ReadStreamOptions,
): Promise<GenerateResult> {
  const state: StreamState = { text: '', pending: '' }
  if (options.loopGuard) state.guard = new LoopGuard()
  let finish: FinishReason = 'unknown'
  let deltas = 0
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let serverStop: string | undefined
  const result = (reason: FinishReason): GenerateResult => {
    // rwkv_lightning may report "stop" after running into max_tokens.
    const generated = completionTokens ?? deltas
    const capped = reason !== 'cancelled' && options.maxTokens > 0 && generated >= options.maxTokens * 0.98
      && state.stop === undefined && serverStop === undefined
    return {
      text: state.text,
      finish: capped ? 'length' : reason,
      ...(state.stop ?? serverStop) === undefined ? {} : { stop: state.stop ?? serverStop },
      ...promptTokens === undefined ? {} : { promptTokens },
      completionTokens: completionTokens ?? deltas,
    }
  }
  let ended: 'stop' | 'length' | undefined
  for await (const data of sseData(body)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new BackendError(`undecodable stream chunk: ${data.slice(0, 200)}`, 'PROVIDER_PROTOCOL_ERROR')
    }
    const chunk = view(parsed)
    if (chunk.error) throw new BackendError(`stream error: ${chunk.error}`, 'PROVIDER_STREAM_ERROR')
    if (chunk.promptTokens) promptTokens = chunk.promptTokens
    if (chunk.completionTokens) completionTokens = chunk.completionTokens
    if (chunk.finish) finish = finishOf(chunk.finish)
    if (chunk.stop) serverStop = chunk.stop
    if (chunk.delta === '') continue
    deltas++
    ended = feedDelta(state, chunk.delta, options.stops, options.onDelta)
    // Leave the loop first: its iterator cancels the body cleanly, while an
    // abort issued inside it would surface as this request's error.
    if (ended !== undefined) break
  }
  if (ended !== undefined) {
    options.abort()
    return result(ended)
  }
  flushPending(state, options.onDelta)
  return result(finish)
}
