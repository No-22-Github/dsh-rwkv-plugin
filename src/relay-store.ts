// Handoff cards of RWKV relay sessions: one JSON line per card, stored next to
// the session's trace file. The evaluators run one DSH process per user turn,
// so a resumed session rebuilds its cards from here instead of regenerating
// them (a model-written card is not reproducible).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RelayCard } from './core/relay.ts'
import type { TraceLocation } from './traces.ts'

function decode(line: string): RelayCard | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const card = value as Partial<RelayCard>
  if (!Number.isInteger(card.at) || typeof card.turn !== 'number' || typeof card.task !== 'string'
    || typeof card.text !== 'string' || typeof card.hash !== 'string') return undefined
  return { at: card.at!, turn: card.turn, task: card.task, text: card.text, hash: card.hash }
}

/** Per-session card lists; reads the file once, then follows appends in memory. */
export class RelayCardStore {
  private readonly bySession = new Map<string, RelayCard[]>()

  /** Cards of `session`, oldest first; empty when nothing is stored yet. */
  load(location: TraceLocation, session: string): readonly RelayCard[] {
    const cached = this.bySession.get(session)
    if (cached !== undefined) return cached
    const file = location.relayPath(session)
    const cards: RelayCard[] = []
    if (file !== undefined && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const card = decode(line)
        if (card !== undefined) cards.push(card)
      }
    }
    this.bySession.set(session, cards)
    return cards
  }

  /** Append one card; the file is created on demand. Failures leave the card in memory only. */
  append(location: TraceLocation, session: string, card: RelayCard): void {
    const cards = this.bySession.get(session)
    if (cards !== undefined) cards.push(card)
    const file = location.relayPath(session)
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(card)}\n`)
    } catch {
      // The session keeps the card in memory; a resumed process regenerates it.
    }
  }
}
