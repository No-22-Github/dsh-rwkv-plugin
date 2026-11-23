// History pair pairing, folded ledger formatting, completed-turn backbone
// compaction, and path-level read/write tracking (`foldedUnreadPaths` +
// `findLatestUneditedReadPair`) shared by `auto-fold` and active `worklist`.

import { countTokens } from '../tokenizer.ts'
import { FOLDED_OUTPUT_MARKER } from './defaults.ts'
import type { HistoryItem } from './policy.ts'
import { collapseBlock, recordToolCall, toolResponse } from './prompt.ts'
import { isNotedTodoUpdateCall, isWorklistTool } from './todo-state.ts'

export { FOLDED_OUTPUT_MARKER }

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
    if (callItem.name === 'edit_lines' && Array.isArray(args.edits) && args.edits.length > 0) {
      const first = args.edits[0] as Record<string, unknown> | undefined
      if (first && first.start_line !== undefined && first.end_line !== undefined) {
        const extra = args.edits.length > 1 ? ` (+${args.edits.length - 1})` : ''
        target = `${target}:${String(first.start_line)}-${String(first.end_line)}${extra}`
      }
    } else if (callItem.name === 'edit_lines' && args.start_line !== undefined && args.end_line !== undefined) {
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

export function isRuntimeContextNote(item: HistoryItem): boolean {
  return item.kind === 'note' && (
    item.text.includes('Current working directory:')
    || item.text.includes('Current DSH file policy:')
  )
}

export function displayCleanPath(raw: unknown, cwd?: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (!trimmed.startsWith('/')) return normalizePosixPath(trimmed)
  const abs = normalizePosixPath(trimmed)
  if (cwd !== undefined && cwd.trim() !== '') {
    const base = normalizePosixPath(cwd.trim())
    if (base !== '/' && abs === base) return '.'
    if (base !== '/' && abs.startsWith(`${base}/`)) return abs.slice(base.length + 1)
  }
  return abs
}

export function collectModifiedFiles(
  pairs: readonly CallPair[],
  history: readonly HistoryItem[],
  cwd?: string,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const pair of pairs) {
    if (!pair.ok || !WRITE_PIN_TOOLS.has(pair.name)) continue
    const callItem = history[pair.callIndex]
    if (callItem?.kind !== 'call') continue
    const path = displayCleanPath(callItem.args.file_path ?? callItem.args.path, cwd)
    if (path !== undefined && !seen.has(path)) {
      seen.add(path)
      out.push(path)
    }
  }
  return out
}

export function maskResultInPlace(
  callItem: Extract<HistoryItem, { kind: 'call' }>,
  resultItem: Extract<HistoryItem, { kind: 'result' }>,
  rawResultTokens?: number,
): Extract<HistoryItem, { kind: 'result' }> {
  if (resultItem.text.startsWith(FOLDED_OUTPUT_MARKER)) return resultItem
  const args = callItem.args
  const firstQuery = Array.isArray(args.queries) && args.queries.length > 0 ? args.queries[0] : undefined
  const rawKey = args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.url ?? args.query ?? firstQuery
  let target = ''
  if (typeof rawKey === 'string' && rawKey.trim() !== '') {
    const clean = rawKey.trim().replace(/\s+/g, ' ')
    target = clean.length > 80 ? `${clean.slice(0, 77)}...` : clean
    if (callItem.name === 'edit_lines' && Array.isArray(args.edits) && args.edits.length > 0) {
      const first = args.edits[0] as Record<string, unknown> | undefined
      if (first && first.start_line !== undefined && first.end_line !== undefined) {
        const extra = args.edits.length > 1 ? ` (+${args.edits.length - 1})` : ''
        target = `${target}:${String(first.start_line)}-${String(first.end_line)}${extra}`
      }
    } else if (callItem.name === 'edit_lines' && args.start_line !== undefined && args.end_line !== undefined) {
      target = `${target}:${String(args.start_line)}-${String(args.end_line)}`
    }
  }
  const trimmedTrailing = resultItem.text.endsWith('\n') ? resultItem.text.slice(0, -1) : resultItem.text
  const lineCount = resultItem.text === '' ? 0 : trimmedTrailing.split('\n').length
  const tokCount = rawResultTokens ?? countTokens(resultItem.text)
  let exitInfo = ''
  if (callItem.name === 'bash') {
    const m = /\[exit code: (\d+)\]/.exec(resultItem.text)
    exitInfo = m ? `, exit ${m[1]}` : (resultItem.ok ? ', exit 0' : ', error')
  } else if (!resultItem.ok) {
    exitInfo = ', error'
  }
  const details = target !== ''
    ? `${target}, ${lineCount} lines, ${tokCount} tokens`
    : `${lineCount} lines, ${tokCount} tokens`
  return {
    ...resultItem,
    text: `${FOLDED_OUTPUT_MARKER}${callItem.name} output omitted (${details})${exitInfo}; re-read if exact content is needed before edit]`,
  }
}

export function formatStageArchiveNote(
  pairs: readonly CallPair[],
  history: readonly HistoryItem[],
  cwd?: string,
): string {
  const files = collectModifiedFiles(pairs, history, cwd)
  const fileSummary = files.length > 0 ? files.join(', ') : 'none'
  return `[Stage archive — earlier steps in this turn modified: ${fileSummary}; ${pairs.length} steps archived. Re-read any file before editing.]`
}

/**
 * Module 1 (`auto-fold v2`): immediately fold a completed prior turn `[from, to)`
 * to `user` message(s) + Turn 1 `runtime-context` `note` + 1-line modified-files
 * summary (if any) + final `assistant` reply (with past reasoning cleared).
 */
export function foldCompletedTurnCompact(
  history: readonly HistoryItem[],
  from: number,
  to: number,
  cwd?: string,
): HistoryItem[] {
  const pairs = collectPairs(history, from, to)
  const modifiedFiles = collectModifiedFiles(pairs, history, cwd)
  const headItems: HistoryItem[] = []
  const assistantItems: HistoryItem[] = []
  for (let index = from; index < to; index++) {
    const item = history[index]!
    if (item.kind === 'user' || isRuntimeContextNote(item)) {
      headItems.push(item)
    } else if (item.kind === 'assistant') {
      assistantItems.push(item.reasoning ? { ...item, reasoning: undefined } : item)
    }
  }
  const out: HistoryItem[] = [...headItems]
  if (modifiedFiles.length > 0) {
    out.push({ kind: 'note', text: `[Modified files in this turn: ${modifiedFiles.join(', ')}]` })
  }
  out.push(...assistantItems)
  return out
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
    const target = canonicalToolTarget(callItem.args.file_path ?? callItem.args.path, cwd)
    if (target === undefined) continue
    if (
      (pair.name === 'read' || pair.name === 'read_file')
      && (resultItem.text.startsWith(FOLDED_OUTPUT_MARKER) || resultItem.text.includes(PRIOR_TURN_FOLDED_MARKER))
    ) {
      visibleInWindow.delete(target)
      continue
    }
    visibleInWindow.add(target)
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
