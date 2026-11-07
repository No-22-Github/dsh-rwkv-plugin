// rwkv_lightning CUDA raw continuation: POST /v1/batch/completions with
// `contents`, integer stop_tokens, optional uploaded state_id. Request-level
// adapters were removed upstream (the server answers adapter_id with HTTP 400);
// fine-tunes are served as merged weights instead.
// Ported from RWKV-Agent internal/continuation/rwkvlightning.

import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import {
  BackendError,
  responseError,
  v1Root,
  type GenerateRequest,
  type GenerateResult,
  type Generator,
} from './generator.ts'
import { readCompletionStream } from './stream.ts'

/** rwkv_lightning_cuda rejects state uploads over 512 MiB. */
export const MAX_STATE_UPLOAD_BYTES = 512 << 20

export interface LightningConfig {
  readonly baseURL: string
  readonly model: string
  readonly password?: string
  readonly stateId?: string
  /** EOS only: 24281 (bare "User") also cuts "User(...)" inside thinking and code. */
  readonly stopTokens?: readonly number[]
  readonly headers?: Readonly<Record<string, string>>
  readonly loopGuard?: boolean
}

/** One entry of `GET /v1/state/list` (and the upload response). */
export interface StateInfo {
  readonly state_id: string
  readonly filename?: string
  readonly original_filename?: string
  readonly size_bytes?: number
  readonly layers?: number
  readonly heads?: number
  readonly head_size?: number
  readonly created_ms?: number
  readonly uploaded_at?: string
}

export class LightningClient implements Generator {
  private readonly config: LightningConfig
  private readonly root: string

  constructor(config: LightningConfig) {
    this.config = config
    this.root = v1Root(config.baseURL)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.config.headers, ...extra }
  }

  async generate(request: GenerateRequest, onDelta?: (text: string) => void): Promise<GenerateResult> {
    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    const body = {
      model: this.config.model,
      contents: [request.prompt],
      max_tokens: request.maxTokens,
      stop_tokens: this.config.stopTokens ?? [0],
      temperature: request.sampling.temperature,
      top_k: request.sampling.topK,
      top_p: request.sampling.topP,
      alpha_presence: request.sampling.presencePenalty,
      alpha_frequency: request.sampling.frequencyPenalty,
      alpha_decay: request.sampling.penaltyDecay,
      stream: true,
      chunk_size: 1,
      ...this.config.stateId ? { state_id: this.config.stateId } : {},
      ...this.config.password ? { password: this.config.password } : {},
    }
    const response = await fetch(`${this.root}/batch/completions`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        ...request.sessionId ? { 'x-rwkv-session-id': request.sessionId } : {},
      }),
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok || response.body === null) throw await responseError(response, this.config.password)
    try {
      return await readCompletionStream(response.body, data => {
        const chunk = data as {
          choices?: { index?: number; delta?: { content?: string }; finish_reason?: string }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
          error?: unknown
        }
        const choice = chunk.choices?.find(item => (item.index ?? 0) === 0)
        return {
          delta: choice?.delta?.content ?? '',
          ...choice?.finish_reason ? { finish: choice.finish_reason } : {},
          ...chunk.usage?.prompt_tokens ? { promptTokens: chunk.usage.prompt_tokens } : {},
          ...chunk.error ? { error: JSON.stringify(chunk.error) } : {},
        }
      }, {
        stops: request.stops,
        maxTokens: request.maxTokens,
        loopGuard: this.config.loopGuard ?? true,
        ...onDelta ? { onDelta } : {},
        abort: () => controller.abort(),
      })
    } catch (error) {
      if (request.signal?.aborted) return { text: '', finish: 'cancelled' }
      throw error
    }
  }

  /** Initial states uploaded to the server (`GET /v1/state/list`), newest first. */
  async listStates(): Promise<StateInfo[]> {
    const response = await fetch(`${this.root}/state/list`, { headers: this.headers(this.auth()) })
    if (response.status === 404 || response.status === 405) {
      throw new BackendError(`deployment has no /v1/state/list route (HTTP ${response.status})`, 'STATES_UNSUPPORTED', response.status)
    }
    if (!response.ok) throw await responseError(response, this.config.password)
    const body = await response.json() as { data?: StateInfo[] }
    return body.data ?? []
  }

  /** Uploads a local state file (`.pth`). Returns the server's entry; its `state_id` is the file stem plus a UUID. */
  async uploadState(file: string): Promise<StateInfo> {
    return this.uploadStateBlob(await openAsBlob(file), basename(file))
  }

  /** Uploads state bytes already in memory (the settings page sends the browser's file through the Host). */
  async uploadStateBlob(blob: Blob, fileName: string): Promise<StateInfo> {
    if (blob.size > MAX_STATE_UPLOAD_BYTES) {
      throw new BackendError(`state file is ${blob.size >> 20} MB, over the server's ${MAX_STATE_UPLOAD_BYTES >> 20} MB upload limit`, 'PAYLOAD_TOO_LARGE')
    }
    const form = new FormData()
    form.set('file', blob, fileName)
    const response = await fetch(`${this.root}/state/upload`, { method: 'POST', headers: this.headers(this.auth()), body: form })
    if (response.status === 404 || response.status === 405) {
      throw new BackendError(`deployment has no /v1/state/upload route (HTTP ${response.status})`, 'STATES_UNSUPPORTED', response.status)
    }
    if (!response.ok) throw await responseError(response, this.config.password)
    const body = await response.json() as StateInfo
    if (!body.state_id) throw new BackendError('upload response has no state_id', 'PROVIDER_PROTOCOL_ERROR')
    return body
  }

  async deleteState(stateId: string): Promise<void> {
    const response = await fetch(`${this.root}/state/delete`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json', ...this.auth() }),
      body: JSON.stringify({ state_id: stateId }),
    })
    if (!response.ok) throw await responseError(response, this.config.password)
  }

  /** The password as a bearer token, for routes that take no JSON body (multipart upload, list). */
  private auth(): Record<string, string> {
    return this.config.password ? { authorization: `Bearer ${this.config.password}` } : {}
  }
}
