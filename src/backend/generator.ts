// Shared continuation contract for the RWKV backends, ported from RWKV-Agent
// internal/continuation (continuation.go, loopguard.go, httputil).

import type { FinishReason } from '../core/parse.ts'

export interface Sampling {
  readonly temperature: number
  readonly topK: number
  readonly topP: number
  readonly presencePenalty: number
  readonly frequencyPenalty: number
  readonly penaltyDecay: number
}

/** agent-fast: the RWKV-Agent default for multi-step agents (light penalties curb repetition). */
export const AGENT_FAST: Sampling = {
  temperature: 0.3,
  topK: 65536,
  topP: 0.5,
  presencePenalty: 0.5,
  frequencyPenalty: 0.1,
  penaltyDecay: 0.996,
}

export interface GenerateRequest {
  readonly prompt: string
  readonly maxTokens: number
  /** Decoded-text stops, matched on the client. */
  readonly stops: readonly string[]
  readonly sampling: Sampling
  readonly signal?: AbortSignal
  /** Sticks a multi-card gateway to one card so the prefix cache hits across steps. */
  readonly sessionId?: string
}

export interface GenerateResult {
  readonly text: string
  readonly finish: FinishReason
  /** The client stop string that ended the generation, consumed from text. */
  readonly stop?: string
  readonly promptTokens?: number
  readonly completionTokens?: number
}

export interface Generator {
  generate(request: GenerateRequest, onDelta?: (text: string) => void): Promise<GenerateResult>
}

export class BackendError extends Error {
  readonly code: string
  readonly status?: number

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/**
 * Splits pending text at the earliest stop. Without a stop, the longest tail
 * that could still begin a stop is held back so a stop split across chunks is
 * never emitted.
 */
export function splitAtStop(pending: string, stops: readonly string[]): { safe: string; tail: string; stop?: string } {
  let best = -1
  let bestStop = ''
  for (const stop of stops) {
    if (stop === '') continue
    const index = pending.indexOf(stop)
    if (index >= 0 && (best < 0 || index < best)) {
      best = index
      bestStop = stop
    }
  }
  if (best >= 0) return { safe: pending.slice(0, best), tail: '', stop: bestStop }
  let hold = 0
  for (const stop of stops) {
    for (let length = Math.min(stop.length - 1, pending.length); length > hold; length--) {
      if (pending.endsWith(stop.slice(0, length))) {
        hold = length
        break
      }
    }
  }
  return { safe: pending.slice(0, pending.length - hold), tail: pending.slice(pending.length - hold) }
}

const GRAM = 24
const WINDOW = 768
const FRESH_PERMILLE = 50

/**
 * Streaming repetition detector calibrated on 7000+ RWKV outputs with no false
 * positive: over the last 768 24-char windows, fewer than 5% seen for the
 * first time means the model is looping.
 */
export class LoopGuard {
  private readonly seen = new Set<string>()
  private readonly fresh: boolean[] = new Array<boolean>(WINDOW).fill(false)
  private runes: string[] = []
  private grams = 0
  private next = 0
  private freshCount = 0
  tripped = false

  write(text: string): boolean {
    if (this.tripped) return true
    for (const char of text) {
      this.runes.push(char)
      if (this.runes.length > GRAM * 4) this.runes = this.runes.slice(-GRAM)
      if (this.runes.length < GRAM) continue
      const gram = this.runes.slice(-GRAM).join('')
      const isNew = !this.seen.has(gram)
      if (isNew) this.seen.add(gram)
      if (this.grams >= WINDOW && this.fresh[this.next]) this.freshCount--
      this.fresh[this.next] = isNew
      if (isNew) this.freshCount++
      this.next = (this.next + 1) % WINDOW
      this.grams++
      if (this.grams >= WINDOW && this.freshCount * 1000 < WINDOW * FRESH_PERMILLE) {
        this.tripped = true
        return true
      }
    }
    return false
  }
}

/** Yields the data payloads of an SSE body until [DONE]. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      if (data !== '') yield data
    }
  }
  const last = buffer.trim()
  if (last.startsWith('data:') && last.slice(5).trim() !== '[DONE]') yield last.slice(5).trim()
}

export interface StreamState {
  text: string
  pending: string
  stop?: string
  guard?: LoopGuard
}

/**
 * Feeds one decoded delta through client stops and the loop guard. Returns
 * 'stop' or 'length' when the generation must end now.
 */
export function feedDelta(
  state: StreamState,
  delta: string,
  stops: readonly string[],
  onDelta?: (text: string) => void,
): 'stop' | 'length' | undefined {
  state.pending += delta
  const { safe, tail, stop } = splitAtStop(state.pending, stops)
  state.pending = tail
  if (safe !== '') {
    state.text += safe
    onDelta?.(safe)
  }
  if (stop !== undefined) {
    state.stop = stop
    return 'stop'
  }
  if (state.guard?.write(safe)) return 'length'
  return undefined
}

export function flushPending(state: StreamState, onDelta?: (text: string) => void): void {
  if (state.pending !== '') {
    state.text += state.pending
    onDelta?.(state.pending)
    state.pending = ''
  }
}

export async function responseError(response: Response, secret?: string): Promise<BackendError> {
  let body = ''
  try {
    body = (await response.text()).slice(0, 500)
  } catch {
    // The status alone still identifies the failure.
  }
  if (secret) body = body.split(secret).join('[REDACTED]')
  const code = response.status === 413 ? 'PAYLOAD_TOO_LARGE' : response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_HTTP_ERROR'
  return new BackendError(`HTTP ${response.status}: ${body || response.statusText}`, code, response.status)
}

/** Normalizes a configured base URL to its /v1 root. */
export function v1Root(baseURL: string): string {
  const url = new URL(baseURL.trim())
  let path = url.pathname.replace(/\/+$/, '')
  for (const suffix of ['/batch/completions', '/chat/completions', '/completions', '/models']) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length)
      break
    }
  }
  if (!path.endsWith('/v1')) path += '/v1'
  url.pathname = path
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

/**
 * Model ids the server lists (`GET /v1/models`; OpenAI shape). rwkv_lightning
 * does not check the password there; iRWKV takes the bearer key.
 */
export async function listModels(baseURL: string, options: { apiKey?: string; headers?: Readonly<Record<string, string>> } = {}): Promise<string[]> {
  const response = await fetch(`${v1Root(baseURL)}/models`, {
    headers: { ...options.headers, ...options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {} },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw await responseError(response, options.apiKey)
  const body = await response.json() as { data?: { id?: unknown; status?: unknown }[]; loaded?: unknown }
  const ids = (body.data ?? []).flatMap(item => typeof item.id === 'string' ? [item.id] : [])
  // Dynamic-loading servers mark the resident model; list it first.
  const loaded = typeof body.loaded === 'string' ? body.loaded : undefined
  return loaded && ids.includes(loaded) ? [loaded, ...ids.filter(id => id !== loaded)] : ids
}
