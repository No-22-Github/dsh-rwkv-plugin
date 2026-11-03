// rwkv_lightning CUDA raw continuation: POST /v1/batch/completions with
// `contents`, integer stop_tokens, optional MiSS/LoRA adapter_id or state_id.
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

/** Cloudflare-fronted endpoints reject bodies over 100 MB with HTTP 413. */
export const MAX_ADAPTER_UPLOAD_BYTES = 100 << 20

export interface LightningConfig {
  readonly baseURL: string
  readonly model: string
  readonly password?: string
  readonly adapterId?: string
  readonly stateId?: string
  /** EOS only: 24281 (bare "User") also cuts "User(...)" inside thinking and code. */
  readonly stopTokens?: readonly number[]
  readonly headers?: Readonly<Record<string, string>>
  readonly loopGuard?: boolean
}

export interface AdapterInfo {
  readonly id: string
  readonly version?: string
  readonly manifest?: Record<string, unknown>
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
      ...this.config.adapterId ? { adapter_id: this.config.adapterId } : {},
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

  async listAdapters(): Promise<AdapterInfo[]> {
    const response = await fetch(`${this.root}/adapters`, { headers: this.headers() })
    if (response.status === 404 || response.status === 405) {
      throw new BackendError(`deployment has no /v1/adapters route (HTTP ${response.status})`, 'ADAPTERS_UNSUPPORTED', response.status)
    }
    if (!response.ok) throw await responseError(response, this.config.password)
    const body = await response.json() as { data?: AdapterInfo[] }
    return body.data ?? []
  }

  /** Uploads a local adapter package (multipart: adapter_id + file). Returns the registered version. */
  async uploadAdapter(adapterId: string, file: string): Promise<string> {
    const blob = await openAsBlob(file)
    if (blob.size > MAX_ADAPTER_UPLOAD_BYTES) {
      throw new BackendError(
        `adapter file is ${blob.size >> 20} MB, over the ${MAX_ADAPTER_UPLOAD_BYTES >> 20} MB request limit of Cloudflare-fronted endpoints; upload the adapter package, not the full training checkpoint`,
        'PAYLOAD_TOO_LARGE',
      )
    }
    const form = new FormData()
    form.set('adapter_id', adapterId)
    form.set('file', blob, basename(file))
    const response = await fetch(`${this.root}/adapters`, { method: 'POST', headers: this.headers(), body: form })
    return this.registered(response)
  }

  /** Registers an adapter file that already sits on the inference server (path relative to its working directory). */
  async registerAdapterPath(adapterId: string, path: string): Promise<string> {
    const response = await fetch(`${this.root}/adapters`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ adapter_id: adapterId, path }),
    })
    return this.registered(response)
  }

  async deleteAdapter(adapterId: string, version?: string): Promise<void> {
    const response = await fetch(`${this.root}/adapters`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ adapter_id: adapterId, ...version ? { adapter_version: version } : {} }),
    })
    if (!response.ok) throw await responseError(response, this.config.password)
  }

  private async registered(response: Response): Promise<string> {
    if (response.status === 404 || response.status === 405) {
      throw new BackendError(`deployment has no /v1/adapters route (HTTP ${response.status})`, 'ADAPTERS_UNSUPPORTED', response.status)
    }
    if (!response.ok) throw await responseError(response, this.config.password)
    const body = await response.json() as { version?: string }
    if (!body.version) throw new BackendError('register response has no version', 'PROVIDER_PROTOCOL_ERROR')
    return body.version
  }
}
