// In-memory live RWKV wire state + pub/sub for real-time SSE streaming to the
// right-sidebar "RWKV 实时上下文" panel (`/api/rwkv/live/<session>`).

import type { ContextFoldEvent } from './core/fold-window.ts'
import { countTokens } from './tokenizer.ts'

const WIRE_SPLIT_RE = /(?=\n\n(?:System:|User:|Assistant:|Tool:))/g

/** Exact RWKV token count per role block (matches `WirePanel.tsx` block splitting). */
export function countWireBlockTokens(raw: string): number[] {
  if (raw === '') return []
  return raw.split(WIRE_SPLIT_RE).map(part => countTokens(part.replace(/^\n+/, '')))
}

export interface LiveWireSnapshot {
  readonly sessionId: string
  readonly model: string
  readonly stage: 'decision' | 'answer' | 'card' | 'idle'
  readonly streaming: boolean
  readonly prompt: string
  readonly fullPrompt?: string
  readonly promptTokens: number
  readonly blockTokens?: readonly number[]
  readonly fullBlockTokens?: readonly number[]
  readonly pastThinks?: readonly string[]
  readonly output: string
  readonly outputTokens: number
  readonly fold?: ContextFoldEvent
  readonly updatedAt: string
}

export type LiveWireEvent =
  | { readonly type: 'snapshot'; readonly state: LiveWireSnapshot }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly output: string; readonly outputTokens: number; readonly updatedAt: string }

type Listener = (event: LiveWireEvent) => void

class LiveWireHub {
  private readonly states = new Map<string, LiveWireSnapshot>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly maxSessions = 50

  get(sessionId: string): LiveWireSnapshot | undefined {
    return this.states.get(sessionId)
  }

  start(
    sessionId: string,
    info: {
      readonly model: string
      readonly stage: 'decision' | 'answer' | 'card'
      readonly prompt: string
      readonly fullPrompt?: string
      readonly promptTokens: number
      readonly pastThinks?: readonly string[]
      readonly fold?: ContextFoldEvent
    },
  ): void {
    const state: LiveWireSnapshot = {
      sessionId,
      model: info.model,
      stage: info.stage,
      streaming: true,
      prompt: info.prompt,
      ...(info.fullPrompt === undefined ? {} : { fullPrompt: info.fullPrompt }),
      promptTokens: info.promptTokens,
      blockTokens: countWireBlockTokens(info.prompt),
      ...(info.fullPrompt === undefined ? {} : { fullBlockTokens: countWireBlockTokens(info.fullPrompt) }),
      ...(info.pastThinks === undefined ? {} : { pastThinks: info.pastThinks }),
      output: '',
      outputTokens: 0,
      ...(info.fold === undefined ? {} : { fold: info.fold }),
      updatedAt: new Date().toISOString(),
    }
    this.states.delete(sessionId)
    this.states.set(sessionId, state)
    for (const key of this.states.keys()) {
      if (this.states.size <= this.maxSessions) break
      if (!this.listeners.has(key)) this.states.delete(key)
    }
    this.emit(sessionId, { type: 'snapshot', state })
  }

  delta(sessionId: string, text: string): void {
    if (text === '') return
    const current = this.states.get(sessionId)
    if (current === undefined) return
    this.states.set(sessionId, { ...current, output: current.output + text })
    this.emit(sessionId, { type: 'delta', text })
  }

  finish(sessionId: string, info: { readonly output: string; readonly outputTokens: number }): void {
    const current = this.states.get(sessionId)
    if (current === undefined) return
    const updatedAt = new Date().toISOString()
    this.states.set(sessionId, {
      ...current,
      streaming: false,
      output: info.output,
      outputTokens: info.outputTokens,
      updatedAt,
    })
    this.emit(sessionId, { type: 'done', output: info.output, outputTokens: info.outputTokens, updatedAt })
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  private emit(sessionId: string, event: LiveWireEvent): void {
    const set = this.listeners.get(sessionId)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener(event)
      } catch {
        // Ignore broken subscriber streams.
      }
    }
  }
}

export const liveWire = new LiveWireHub()
