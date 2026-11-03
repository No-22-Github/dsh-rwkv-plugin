// iRWKV (vLLM fork) raw continuation: POST /v1/completions with the RWKV
// sampling fields. No state or adapter support; the server prepends token 0,
// so add_special_tokens stays false. Ported from RWKV-Agent
// internal/continuation/irwkv.

import {
  responseError,
  v1Root,
  type GenerateRequest,
  type GenerateResult,
  type Generator,
} from './generator.ts'
import { readCompletionStream } from './stream.ts'

export interface IRWKVConfig {
  readonly baseURL: string
  readonly model: string
  readonly apiKey?: string
  /** Token-id stops; 24281 (bare "User") is never forwarded, see LightningConfig.stopTokens. */
  readonly stopTokenIds?: readonly number[]
  readonly headers?: Readonly<Record<string, string>>
  readonly loopGuard?: boolean
}

export class IRWKVClient implements Generator {
  private readonly config: IRWKVConfig
  private readonly root: string

  constructor(config: IRWKVConfig) {
    this.config = config
    this.root = v1Root(config.baseURL)
  }

  async generate(request: GenerateRequest, onDelta?: (text: string) => void): Promise<GenerateResult> {
    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    const stopTokenIds = (this.config.stopTokenIds ?? []).filter(id => id !== 24281)
    const body = {
      model: this.config.model,
      prompt: request.prompt,
      max_tokens: request.maxTokens,
      temperature: request.sampling.temperature,
      top_k: request.sampling.topK,
      top_p: request.sampling.topP,
      presence_penalty: request.sampling.presencePenalty,
      frequency_penalty: request.sampling.frequencyPenalty,
      penalty_decay: request.sampling.penaltyDecay,
      stop: request.stops,
      ...stopTokenIds.length > 0 ? { stop_token_ids: stopTokenIds } : {},
      add_special_tokens: false,
      stream: true,
      stream_options: { include_usage: true },
    }
    const response = await fetch(`${this.root}/completions`, {
      method: 'POST',
      headers: {
        ...this.config.headers,
        'content-type': 'application/json',
        ...this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
        ...request.sessionId ? { 'x-rwkv-session-id': request.sessionId } : {},
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok || response.body === null) throw await responseError(response, this.config.apiKey)
    try {
      return await readCompletionStream(response.body, data => {
        const chunk = data as {
          choices?: { index?: number; text?: string; finish_reason?: string | null; stop_reason?: unknown }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
          error?: unknown
          object?: string
          message?: string
        }
        const choice = chunk.choices?.find(item => (item.index ?? 0) === 0)
        const error = chunk.error ? JSON.stringify(chunk.error) : chunk.object === 'error' ? chunk.message ?? 'error' : undefined
        return {
          delta: choice?.text ?? '',
          ...choice?.finish_reason ? { finish: choice.finish_reason } : {},
          ...typeof choice?.stop_reason === 'string' ? { stop: choice.stop_reason } : {},
          ...chunk.usage?.prompt_tokens ? { promptTokens: chunk.usage.prompt_tokens } : {},
          ...chunk.usage?.completion_tokens ? { completionTokens: chunk.usage.completion_tokens } : {},
          ...error ? { error } : {},
        }
      }, {
        // The server already matched the text stops; matching again catches split variants.
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
}
