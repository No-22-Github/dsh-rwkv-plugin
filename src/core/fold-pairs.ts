// History pair pairing, folded ledger formatting, completed-turn backbone
// compaction, and path-level read/write tracking (`foldedUnreadPaths` +
// `findLatestUneditedReadPair`) shared by `auto-fold` and active `worklist`.

import { countTokens } from '../tokenizer.ts'
import type { HistoryItem } from './policy.ts'
import { collapseBlock, recordToolCall, toolResponse } from './prompt.ts'
import { isNotedTodoUpdateCall, isWorklistTool } from './todo-state.ts'

export const MAX_PINNED_UNEDITED_READ_TOKENS = 2400
const MAX_PRIOR_TURN_FALLBACK_RESULT_CHARS = 1600
const PRIOR_TURN_FOLDED_MARKER = '...(prior-turn output folded)...'

export const READ_PIN_TOOLS: ReadonlySet<string> = new Set(['read', 'read_file'])
export const WRITE_PIN_TOOLS: ReadonlySet<string> = new Set(['edit', 'edit_file', 'edit_lines', 'write', 'write_file'])
const READ_WRITE_TOOLS: ReadonlySet<string> = new Set(['read', 'read_file', 'write', 'write_file'])

export interface CallPair {
  readonly callIndex: number
  readonly resultIndex: number
  readonly name: string
  readonly ok: boolean
  readonly notedUpdate: boolean
}

/** Rendering of one HistoryItem as prompt bytes, for exact RWKV token counting. */
export function historyItemPromptBytes(item: HistoryItem, historyEmptyThink = false): string {
  switch (item.kind) {
    case 'call': {
      const action = recordToolCall(item.name, item.args)
      const think = historyEmptyThink ? '' : collapseBlock(item.reasoning ?? '')
      return `Assistant: <think>${think}</think>${action}\n\n`
    }
    case 'assistant': {
      const action = collapseBlock(item.text)
      const think = historyEmptyThink ? '' : collapseBlock(item.reasoning ?? '')
      return `Assistant: <think>${think}</think>${action}\n\n`
    }
    case 'result':
      return `User: ${toolResponse(item.name, item.ok, item.text)}\n\n`
    default:
      return `User: ${item.text}\n\n`
  }
}

export function itemsTokens(items: readonly HistoryItem[], historyEmptyThink = false): number {
  let total = 0
  for (const item of items) total += countTokens(historyItemPromptBytes(item, historyEmptyThink))
  return total
}

/** Completed (call, result) pairs inside `history[from..to)`. */
export function collectPairs(history: readonly HistoryItem[], from: number, to: number): CallPair[] {
  const calls = new Map<string, { index: number; item: Extract<HistoryItem, { kind: 'call' }> }>()
  const pairs: CallPair[] = []
  for (let index = from; index < to; index++) {
    const item = history[index]!
    if (item.kind === 'call') {
      calls.set(item.id, { index, item })
    } else if (item.kind === 'result') {
      const match = calls.get(item.id)
      if (match !== undefined) {
        pairs.push({
          callIndex: match.index,
          resultIndex: index,
          name: match.item.name,
          ok: item.ok,
          notedUpdate: item.ok && isNotedTodoUpdateCall(match.item),
        })
      }
    }
  }
  return pairs
}

function summarizeCallPair(
  callItem: Extract<HistoryItem, { kind: 'call' }>,
  resultItem: Extract<HistoryItem, { kind: 'result' }>,
): string {
  const args = callItem.args
  const rawKey = args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.url ?? args.query
  let target = ''
  if (typeof rawKey === 'string' && rawKey.trim() !== '') {
    const clean = rawKey.trim().replace(/\s+/g, ' ')
    target = clean.length > 80 ? `${clean.slice(0, 77)}...` : clean
    if (callItem.name === 'edit_lines' && args.start_line !== undefined && args.end_line !== undefined) {
      target = `${target}:${String(args.start_line)}-${String(args.end_line)}`
    }
  }
  let outcome = resultItem.ok ? 'ok' : 'error'
  if (resultItem.ok && callItem.name === 'bash') {
    const m = /\[exit code: (\d+)\]/.exec(resultItem.text)
    outcome = m ? `exit ${m[1]}` : 'exit 0'
  }
  return `- ${callItem.name}${target ? ` ${target}` : ''} -> ${outcome}`
}

export function formatFoldedStepsNote(pairs: readonly CallPair[], history: readonly HistoryItem[]): string {
  const lines = pairs.map(pair =>
    summarizeCallPair(
      history[pair.callIndex] as Extract<HistoryItem, { kind: 'call' }>,
      history[pair.resultIndex] as Extract<HistoryItem, { kind: 'result' }>,
    ),
  )
  return `[Earlier workspace steps in this turn (raw outputs folded; re-read a file before calling edit if its read output is no longer shown):\n${lines.join('\n')}]`
}

function compactPriorResult(item: Extract<HistoryItem, { kind: 'result' }>): HistoryItem {
  if (item.text.length <= MAX_PRIOR_TURN_FALLBACK_RESULT_CHARS) return item
  const trimmed = item.text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return item
  const head = 1100
  const tail = 400
  return {
    ...item,
    text: `${item.text.slice(0, head)}\n${PRIOR_TURN_FOLDED_MARKER}\n${item.text.slice(item.text.length - tail)}`,
  }
}

/**
 * Fold one finished earlier turn `[from, to)` down to its user/final backbone:
 * - when a worklist was used, keep its final `todo_plan`/`todo_update` snapshot;
 * - when NO worklist was used (unplanned fallback), always keep the last real
 *   workspace call/result pair (plus a 1-line-per-step ledger of earlier pairs)
 *   so subsequent turns retain concrete workspace context and tool-calling shape.
 */
export function foldCompletedTurn(history: readonly HistoryItem[], from: number, to: number): HistoryItem[] {
  const pairs = collectPairs(history, from, to)
  const lastWorklist = [...pairs].reverse().find(pair => pair.ok && isWorklistTool(pair.name))
  const fallbackPair = lastWorklist === undefined
    ? ([...pairs].reverse().find(pair => pair.ok) ?? pairs[pairs.length - 1])
    : undefined
  const earlierUnplannedPairs = lastWorklist === undefined && fallbackPair !== undefined
    ? pairs.filter(pair => pair.callIndex !== fallbackPair.callIndex)
    : []
  const hasFinal = history.slice(from, to).some(item => item.kind === 'assistant')

  const keptIndices = new Set<number>()
  for (let index = from; index < to; index++) {
    const kind = history[index]!.kind
    if (kind === 'user' || kind === 'note' || kind === 'assistant') keptIndices.add(index)
  }
  if (lastWorklist !== undefined) {
    keptIndices.add(lastWorklist.callIndex)
    keptIndices.add(lastWorklist.resultIndex)
  } else if (fallbackPair !== undefined) {
    keptIndices.add(fallbackPair.callIndex)
    keptIndices.add(fallbackPair.resultIndex)
  }

  const out: HistoryItem[] = []
  let insertedLedger = false
  for (let index = from; index < to; index++) {
    if (!keptIndices.has(index)) continue
    if (!insertedLedger && earlierUnplannedPairs.length > 0 && fallbackPair !== undefined && index === fallbackPair.callIndex) {
      out.push({ kind: 'note', text: formatFoldedStepsNote(earlierUnplannedPairs, history) })
      insertedLedger = true
    }
    const item = history[index]!
    if (hasFinal && fallbackPair !== undefined && index === fallbackPair.resultIndex && item.kind === 'result') {
      out.push(compactPriorResult(item))
    } else if ((item.kind === 'call' || item.kind === 'assistant') && item.reasoning) {
      out.push({ ...item, reasoning: undefined })
    } else {
      out.push(item)
    }
  }
  return out
}

function normalizePosixPath(raw: string): string {
  const isAbs = raw.startsWith('/')
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!isAbs) parts.push('..')
      continue
    }
    parts.push(part)
  }
  if (isAbs) return `/${parts.join('/')}`
  return parts.length > 0 ? parts.join('/') : '.'
}

function canonicalToolTarget(raw: unknown, cwd?: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('/')) return normalizePosixPath(trimmed)
  if (cwd !== undefined && cwd.trim() !== '') {
    const base = cwd.trim().replace(/\/+$/, '') || '/'
    return normalizePosixPath(`${base}/${trimmed}`)
  }
  return normalizePosixPath(trimmed)
}

function pairTargetPath(pair: CallPair, history: readonly HistoryItem[], cwd?: string): string | undefined {
  const item = history[pair.callIndex]
  if (item?.kind !== 'call') return undefined
  return canonicalToolTarget(item.args.file_path ?? item.args.path, cwd)
}

/**
 * Files whose earlier successful `read` or `write` output was folded out of
 * `foldedItems` without a subsequent verbatim `read` or `write` remaining in
 * the active window.
 */
export function foldedUnreadPaths(
  history: readonly HistoryItem[],
  foldedItems: readonly HistoryItem[],
  cwd?: string,
): string[] {
  const everObserved = new Set<string>()
  for (const pair of collectPairs(history, 0, history.length)) {
    if (!pair.ok || !READ_WRITE_TOOLS.has(pair.name)) continue
    const callItem = history[pair.callIndex] as Extract<HistoryItem, { kind: 'call' }>
    const target = canonicalToolTarget(callItem.args.file_path ?? callItem.args.path, cwd)
    if (target !== undefined) everObserved.add(target)
  }
  if (everObserved.size === 0) return []

  const visibleInWindow = new Set<string>()
  for (const pair of collectPairs(foldedItems, 0, foldedItems.length)) {
    if (!pair.ok || !READ_WRITE_TOOLS.has(pair.name)) continue
    const callItem = foldedItems[pair.callIndex] as Extract<HistoryItem, { kind: 'call' }>
    const resultItem = foldedItems[pair.resultIndex] as Extract<HistoryItem, { kind: 'result' }>
    if ((pair.name === 'read' || pair.name === 'read_file') && resultItem.text.includes(PRIOR_TURN_FOLDED_MARKER)) {
      continue
    }
    const target = canonicalToolTarget(callItem.args.file_path ?? callItem.args.path, cwd)
    if (target !== undefined) visibleInWindow.add(target)
  }

  return [...everObserved].filter(path => !visibleInWindow.has(path))
}

/**
 * Find the most recent successful `read` pair among `foldedPairs` that has not
 * been followed by a write, fits within `MAX_PINNED_UNEDITED_READ_TOKENS`, and
 * is not already superseded by a read/write on the same path in `activePairs`.
 */
export function findLatestUneditedReadPair(
  foldedPairs: readonly CallPair[],
  history: readonly HistoryItem[],
  pairTokens: (pair: CallPair) => number,
  cwd: string | undefined,
  activePairs: readonly CallPair[],
): CallPair | undefined {
  let candidate: CallPair | undefined
  for (let i = foldedPairs.length - 1; i >= 0; i--) {
    const pair = foldedPairs[i]!
    if (pair.ok && WRITE_PIN_TOOLS.has(pair.name)) return undefined
    if (pair.ok && READ_PIN_TOOLS.has(pair.name) && pairTargetPath(pair, history, cwd) !== undefined) {
      if (pairTokens(pair) > MAX_PINNED_UNEDITED_READ_TOKENS) return undefined
      candidate = pair
      break
    }
  }
  if (candidate === undefined) return undefined
  const target = pairTargetPath(candidate, history, cwd)
  const superseded = activePairs.some(pair =>
    pair.ok
    && (READ_PIN_TOOLS.has(pair.name) || WRITE_PIN_TOOLS.has(pair.name))
    && pairTargetPath(pair, history, cwd) === target,
  )
  return superseded ? undefined : candidate
}
