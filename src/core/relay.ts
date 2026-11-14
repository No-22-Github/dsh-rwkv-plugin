// Turn-relay context: finished stretches of a conversation are replaced by
// model-written handoff cards, and only the current leg (plus the most recent
// call/result pair) stays verbatim. The plugin, the teacher overlay and the
// export script share these functions, so a training row and the prompt the
// student sees are built from the same bytes.
//
// The paper behind it (arXiv 2611.05306) found that frequent compaction keeps
// accuracy while contexts stay short; the card is a brief for the work that is
// still to be done, not a narrative of what happened. Our teacher is a
// quantized open-weight model and loses accuracy under tight compaction
// (Step-3.7-Flash: 70.0 -> 66.8 at 48K/40K, 56.6 at 16K/12K on SWE-bench
// Verified), hence the teacher gate before any bulk collection.

import { countTokens } from '../tokenizer.ts'
import type { Entry } from './prompt.ts'
import { recordToolCall, toolResponse } from './prompt.ts'
import { transcriptEntries, isMutatingCall, type HistoryItem } from './policy.ts'
import type { WireTool } from './tools.ts'

/** One model-written handoff card covering the history items [previous.at, at). */
export interface RelayCard {
  /** Number of history items covered by all cards up to and including this one. */
  readonly at: number
  /** 1-based user-turn number this card belongs to. */
  readonly turn: number
  /** The user request of that turn, verbatim; shown on the turn's first card. */
  readonly task: string
  /** Sanitized recap text written by the model. */
  readonly text: string
  /** Hash of the items this card covers, to notice a rewritten history. */
  readonly hash: string
}

export interface RelayOptions {
  /**
   * Token budget for the part of the leg that is replaced by a card. The most
   * recent call/result pair is always kept verbatim, so the prompt that writes
   * a card stays near this budget + one tool result.
   */
  readonly budgetTokens: number
  /** Output cap for one handoff card (the recap generation's max tokens). */
  readonly cardMaxTokens: number
}

/** The range a new card has to cover before the next action is decided. */
export interface RelayNeed {
  readonly start: number
  readonly end: number
  /** True when the covered items finish a user turn and a new instruction follows. */
  readonly turnEnd: boolean
  /** 1-based turn number of the covered items. */
  readonly turn: number
  /** The user request of that turn. */
  readonly task: string
}

export interface RelayPlan {
  /** Cards whose covered prefix still matches the history. */
  readonly cards: readonly RelayCard[]
  /** A card to write before this request, when the leg has to be shortened. */
  readonly need?: RelayNeed
  /** First history item shown verbatim after the cards. */
  readonly legStart: number
}

const RECAP_BODY = `1. Objective - one line describing the required result.
2. Established facts - exact paths, relevant symbols or commands, observed values, and important errors or output. Separate observations from unverified ideas.
3. Applied changes - each changed or created file, what changed, and whether it was verified.
4. Verification - the exact checks run, their outcomes, failures, obstacles, and workarounds.
5. Dead ends - failed approaches that should not be repeated.
6. Remaining plan - outstanding subgoals in execution order; the immediate next command or edit; and the condition for completion.`

/**
 * The recap shares one small output cap with the model's thinking, and the
 * card text is prompt every later step pays for, so the length is stated as a
 * hard budget instead of "be concise" (Step-3.7-Flash and Qwen both overran
 * 768 tokens and fell back to the deterministic card).
 */
const RECAP_LIMIT = 'Hard limit: the whole recap must stay under 200 words. Plain six numbered sections, no tables, no preamble, no code blocks.'

/** Nudge used when the current user instruction is not finished yet. */
export const RELAY_RECAP_LEG = `Stop work. Write only a concise handoff recap; do not run commands or call tools.
The conversation will reset to the system prompt, the task, and this recap; the same task continues.
Record:
${RECAP_BODY}
${RECAP_LIMIT}
If needed output was truncated, give a narrow command to retrieve it.`

/** Nudge used when a turn is finished and the user's next instruction follows. */
export const RELAY_RECAP_TURN = `Stop work. Write only a concise handoff recap; do not run commands or call tools.
The conversation will reset; the user's next instruction follows after this recap.
Record:
${RECAP_BODY}
${RECAP_LIMIT}
If needed output was truncated, give a narrow command to retrieve it.`

export function recapInstruction(turnEnd: boolean): string {
  return turnEnd ? RELAY_RECAP_TURN : RELAY_RECAP_LEG
}

/** Rendering of one item as the model sees it, for token estimates and hashes. */
function itemText(item: HistoryItem): string {
  switch (item.kind) {
    case 'call':
      return recordToolCall(item.name, item.args)
    case 'result':
      return toolResponse(item.name, item.ok, item.text)
    default:
      return item.text
  }
}

/** Exact RWKV World tokens of the history items as prompt bytes. */
export function itemTokens(items: readonly HistoryItem[]): number {
  let total = 0
  for (const item of items) total += countTokens(itemText(item))
  return total
}

/** FNV-1a over the items; drift detection only, collisions do not matter. */
function hashItems(items: readonly HistoryItem[]): string {
  let hash = 0x811c9dc5
  for (const item of items) {
    const text = `${item.kind}\u0000${itemText(item)}`
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Index of the last user message, or -1. */
export function lastUserIndex(items: readonly HistoryItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]!.kind === 'user') return index
  }
  return -1
}

/** 1-based user-turn number of the item at `index`. */
function turnNumber(items: readonly HistoryItem[], index: number): number {
  let turn = 0
  for (let at = 0; at <= index && at < items.length; at++) {
    if (items[at]!.kind === 'user') turn++
  }
  return turn
}

/** The user request of the turn the item at `index` belongs to. */
function taskOf(items: readonly HistoryItem[], index: number): string {
  for (let at = Math.min(index, items.length - 1); at >= 0; at--) {
    const item = items[at]!
    if (item.kind === 'user') return item.text
  }
  return ''
}

/**
 * Cards whose covered ranges still hash to the history. A resumed session can
 * see a rewritten history (DSH compaction) or a copied prefix; the first card
 * that no longer matches ends the usable chain.
 */
export function validCards(history: readonly HistoryItem[], cards: readonly RelayCard[]): RelayCard[] {
  const valid: RelayCard[] = []
  let at = 0
  for (const card of cards) {
    if (!Number.isInteger(card.at) || card.at <= at || card.at > history.length) break
    if (hashItems(history.slice(at, card.at)) !== card.hash) break
    valid.push(card)
    at = card.at
  }
  return valid
}

/**
 * Largest cut of the leg whose token count stays inside `budget`: cut only after
 * a completed call/result pair, never covering the most recent pair (its result
 * is what the model is about to act on). No complete pair fits: no cut.
 */
function cutIndex(history: readonly HistoryItem[], start: number, budget: number): number {
  let lastCall = -1
  for (let index = start; index < history.length; index++) {
    if (history[index]!.kind === 'call') lastCall = index
  }
  if (lastCall < 0) return start
  let total = 0
  let cut = start
  for (let index = start; index < history.length; index++) {
    total += countTokens(itemText(history[index]!))
    if (history[index]!.kind !== 'result') continue
    // The pair ending here would swallow the most recent call: keep it verbatim.
    if (index + 1 > lastCall) break
    if (total > budget) break
    cut = index + 1
  }
  return cut
}

/**
 * Decide whether this request needs a new card. A new user instruction always
 * cards the finished turns; inside one turn the leg is cut once it exceeds the
 * budget, keeping the most recent call/result pair verbatim.
 */
export function planRelay(history: readonly HistoryItem[], cards: readonly RelayCard[], options: RelayOptions): RelayPlan {
  const valid = validCards(history, cards)
  const legStart = valid.length > 0 ? valid[valid.length - 1]!.at : 0
  if (history.length === 0) return { cards: valid, legStart }
  const user = lastUserIndex(history)
  if (legStart < user) {
    // A new instruction arrived after the last card: card the finished turns.
    // A range holding only notes (a runtime-context refresh) is not worth a call.
    const covered = history.slice(legStart, user)
    if (covered.some(item => item.kind !== 'note')) {
      return {
        cards: valid,
        legStart,
        need: { start: legStart, end: user, turnEnd: true, turn: turnNumber(history, legStart), task: taskOf(history, legStart) },
      }
    }
  }
  const leg = history.slice(legStart)
  // Nothing to recap before the model has observed anything.
  if (!leg.some(item => item.kind === 'call' || item.kind === 'result')) return { cards: valid, legStart }
  if (itemTokens(leg) <= options.budgetTokens) return { cards: valid, legStart }
  const end = cutIndex(history, legStart, options.budgetTokens)
  if (end <= legStart) return { cards: valid, legStart }
  // A card holding only the task (no observation yet) would summarise nothing.
  if (!history.slice(legStart, end).some(item => item.kind === 'call' || item.kind === 'result')) return { cards: valid, legStart }
  return {
    cards: valid,
    legStart,
    need: { start: legStart, end, turnEnd: false, turn: turnNumber(history, legStart), task: taskOf(history, legStart) },
  }
}

/** A card block as the model reads it: header, the turn's task once, then the recap. */
export function cardBlock(card: RelayCard, part: number, withTask: boolean): string {
  const head = `[Handoff recap · turn ${card.turn} · part ${part}]`
  const task = withTask && card.task !== '' ? `Task: ${card.task}\n` : ''
  return `${head}\n${task}${card.text}`
}

/** Prior cards as user blocks; the first card of each turn repeats the task. */
export function cardEntries(cards: readonly RelayCard[]): Entry[] {
  const entries: Entry[] = []
  let turn = -1
  let part = 0
  for (const card of cards) {
    if (card.turn === turn) part++
    else {
      turn = card.turn
      part = 1
    }
    entries.push({ role: 'user', text: cardBlock(card, part, part === 1) })
  }
  return entries
}

export interface RelayEntryOptions {
  readonly tools: readonly WireTool[]
  readonly postToolReminder: string
  /** Legacy prompt-time cut for data recorded before the execution-time budget. */
  readonly maxResultChars?: number
  /** Add the per-step reminders; off for the recap request, which is not a step. */
  readonly reminders?: boolean
}

/** Entries for an execution prompt: the cards, then the current leg verbatim. */
export function relayEntries(history: readonly HistoryItem[], cards: readonly RelayCard[], options: RelayEntryOptions): Entry[] {
  const legStart = cards.length > 0 ? cards[cards.length - 1]!.at : 0
  return [
    ...cardEntries(cards),
    ...transcriptEntries(history.slice(legStart), {
      tools: options.tools,
      postToolReminder: options.postToolReminder,
      ...options.maxResultChars === undefined ? {} : { maxResultChars: options.maxResultChars },
      ...options.reminders === undefined ? {} : { reminders: options.reminders },
    }),
  ]
}

/** Entries for the recap request: prior cards, the covered range, the nudge. */
export function recapEntries(history: readonly HistoryItem[], cards: readonly RelayCard[], need: RelayNeed, options: RelayEntryOptions): Entry[] {
  return [
    ...cardEntries(cards),
    ...transcriptEntries(history.slice(need.start, need.end), {
      tools: options.tools,
      postToolReminder: '',
      ...options.maxResultChars === undefined ? {} : { maxResultChars: options.maxResultChars },
      reminders: false,
    }),
    { role: 'user', text: recapInstruction(need.turnEnd) },
  ]
}

/** Build the card for a covered range; `text` must already be sanitized. */
export function makeCard(history: readonly HistoryItem[], need: RelayNeed, text: string): RelayCard {
  return {
    at: need.end,
    turn: need.turn,
    task: need.task,
    text,
    hash: hashItems(history.slice(need.start, need.end)),
  }
}

/** Prompt tags inside card text would read as protocol to the model: drop them. */
const PROTOCOL_TAG = /<\/?(?:think|tool_call|tool_response)(?:\s[^>]*)?>/gi

const THINK_END = '<｜end▁of▁thinking｜>'

/**
 * The model's recap output as card text: no leading think block (an unclosed
 * one fails the card), no tool-call frame, no protocol tags. The prompt withholds
 * the closing ">" of the think opener, so "<think" without it is handled too.
 */
export function cleanCardText(output: string): string {
  let text = output.trimStart()
  if (text.startsWith('<think')) {
    const close = text.indexOf(THINK_END)
    if (close < 0) return ''
    text = text.slice(close + THINK_END.length).trimStart()
    if (text.startsWith('<think')) return ''
  }
  const frame = text.toLowerCase().indexOf('<tool_call')
  if (frame >= 0) text = text.slice(0, frame)
  text = text.replace(PROTOCOL_TAG, '')
  return text.trim()
}

function clampText(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text
  const lines = text.split('\n')
  let low = 1
  let high = lines.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const piece = `${lines.slice(0, middle).join('\n')}\n…`
    if (countTokens(piece) <= maxTokens) low = middle
    else high = middle - 1
  }
  return `${lines.slice(0, low).join('\n')}\n…`
}

/** Short, exact-enough rendering of call arguments for the fallback card. */
function describeArgs(args: Record<string, unknown>): string {
  const path = args.file_path ?? args.path
  if (typeof path === 'string') return path
  if (typeof args.command === 'string') return args.command.length > 120 ? `${args.command.slice(0, 117)}...` : args.command
  if (typeof args.pattern === 'string') return args.pattern
  const text = JSON.stringify(args)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/**
 * Deterministic card used when the recap generation fails or writes protocol
 * garbage: the exact calls, changed paths, failed checks and the task. It is
 * not a substitute for a model recap, only a way to keep the session going.
 */
export function fallbackCard(history: readonly HistoryItem[], need: RelayNeed, maxTokens = 500): string {
  const items = history.slice(need.start, need.end)
  const names = new Map<string, { name: string; args: Record<string, unknown> }>()
  const facts: string[] = []
  const changed: string[] = []
  const checks: string[] = []
  const failed: string[] = []
  for (const item of items) {
    if (item.kind === 'call') {
      names.set(item.id, { name: item.name, args: item.args })
      const path = item.args.file_path ?? item.args.path
      if (typeof path === 'string' && isMutatingCall(item.name, item.args)) changed.push(path)
      continue
    }
    if (item.kind !== 'result') continue
    const call = names.get(item.id)
    const name = call?.name ?? item.name
    const args = call?.args ?? {}
    const target = describeArgs(args)
    const outcome = item.ok ? 'ok' : 'failed'
    facts.push(`- ${name} ${target} -> ${outcome}`)
    if (name === 'bash') checks.push(`- ${target} -> ${outcome}`)
    if (!item.ok) {
      const error = item.text.trim().split('\n')[0] ?? ''
      failed.push(`- ${name} ${target}: ${error.length > 140 ? `${error.slice(0, 137)}...` : error}`)
    }
  }
  const body = [
    `1. Objective: ${need.task === '' ? 'continue the current task' : need.task}`,
    '2. Established facts:',
    ...facts.length > 0 ? facts : ['- none recorded'],
    `3. Applied changes: ${[...new Set(changed)].join(', ') || 'none recorded'}`,
    '4. Verification:',
    ...checks.length > 0 ? checks : ['- none recorded'],
    '5. Dead ends:',
    ...failed.length > 0 ? failed : ['- none recorded'],
    '6. Remaining plan: continue the task; re-read files whose content is needed.',
  ].join('\n')
  return clampText(body, maxTokens)
}
