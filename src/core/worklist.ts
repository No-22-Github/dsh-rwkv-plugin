// Stateful work list (`todo_plan` + `todo_update`): ordered subgoals with a
// per-item `note` slot that carries established facts across steps.
//
// Unlike turn-relay (which pauses work at a token wall to generate an
// out-of-band six-section prose card stored in a sidecar file), every plan and
// item update here is an ordinary tool call in the DSH message history:
//   - each `todo_plan` / `todo_update` result echoes the full current work list
//     (including all earlier notes);
//   - a `todo_update` carrying a non-empty `note` acts as a semantic checkpoint:
//     earlier intermediate tool calls/results in the current turn are folded
//     away, leaving that `todo_update` call/result pair as the head of the
//     active window;
//   - completed earlier user turns keep only the user prompt, the turn's final
//     work list snapshot (when used), and the assistant's final reply.
//
// Shared by the student plugin (`decideStep`), the teacher overlay (`teacher.ts`)
// and the training exporter (`export.ts`) so prompt bytes match everywhere.

import { countTokens } from '../tokenizer.ts'
import { currentTurnStart, transcriptEntries, type HistoryItem, type TranscriptOptions } from './policy.ts'
import { collapseBlock, recordToolCall, toolResponse, type Entry } from './prompt.ts'
import {
  isWorklistTool,
  normalizeWorklistStatus,
  parsePlanItems,
  sanitizeWorklistField as sanitizeField,
  TODO_PLAN_TOOL,
  TODO_UPDATE_TOOL,
  WORKLIST_TOOLS,
  type WorklistStatus,
} from './tools.ts'

export {
  isWorklistTool,
  normalizeWorklistStatus,
  parsePlanItems,
  TODO_PLAN_TOOL,
  TODO_UPDATE_TOOL,
  WORKLIST_TOOLS,
  type WorklistStatus,
}

export interface WorklistItem {
  readonly id: number
  readonly content: string
  readonly status: WorklistStatus
  readonly note?: string
}

export interface WorklistOptions {
  /**
   * Minimum RWKV prompt tokens required before a noted `todo_update` triggers
   * history folding (low watermark). Below this threshold, `todo_update` still
   * updates the list and notes without folding earlier steps. Default: 8000
   * in plugin config (0 when omitted in low-level `foldWorklist`).
   */
  readonly minFoldTokens?: number
  /**
   * Total RWKV token budget (system prompt + folded history + step reminders)
   * before nudging the model to checkpoint established facts into `todo_update`
   * (high watermark). Default: 12000.
   */
  readonly budgetTokens: number
  /**
   * Hard RWKV token safety ceiling. If the model ignores the checkpoint nudge
   * and keeps reading past this limit, oldest unfolded workspace call/result
   * pairs are dropped so the prompt never enters collapse territory.
   * Defaults to `budgetTokens + 3000`.
   */
  readonly hardCapTokens?: number
  /**
   * Maximum RWKV tokens kept for completed earlier user turns before dropping
   * the oldest turns from the conversation backbone. Default: 5000.
   */
  readonly backboneMaxTokens?: number
  /**
   * Number of most-recent workspace call/result pairs right before a noted
   * `todo_update` checkpoint to keep visible so the model retains concrete
   * workspace evidence instead of waking up in an empty window. Default: 2.
   */
  readonly keepRecentPairs?: number
  /** Whether to retain the initial `todo_plan` pair in the folded active turn (default: true). */
  readonly keepInitialPlan?: boolean
  /** Whether to inject `WORKLIST_SYSTEM_GUIDANCE` into the system prompt (default: true). */
  readonly systemGuidance?: boolean
  /**
   * Auto-fold (`passive: true`): omit active `todo_*` tools, guidance, and
   * budget nudges; keep full prior turns until total prompt hits
   * `minFoldTokens` (default 8000), and deterministically fold oldest in-turn
   * steps past `budgetTokens` (default 12000) while keeping `keepRecentPairs`.
   */
  readonly passive?: boolean
}

export const DEFAULT_WORKLIST_MIN_FOLD_TOKENS = 8000
export const DEFAULT_WORKLIST_BUDGET_TOKENS = 12000
export const DEFAULT_WORKLIST_HARD_SLACK_TOKENS = 3000
export const DEFAULT_BACKBONE_MAX_TOKENS = 5000
export const DEFAULT_KEEP_RECENT_PAIRS = 2
const MAX_SECOND_RECENT_PAIR_TOKENS = 2800
const MAX_PRIOR_TURN_FALLBACK_RESULT_CHARS = 1600
const INIT_NUDGE_COOLDOWN_STEPS = 4
const CHECKPOINT_NUDGE_COOLDOWN_STEPS = 3

export const WORKLIST_CHECKPOINT_NUDGE =
  'Context budget reached for the current step. Call `todo_update` once to checkpoint verified facts into a concise `note` (<= 120 words: exact /app/... paths, line ranges, findings, and exit codes; keep `status: "in_progress"` if unfinished, or `"completed"` only if verified), or finish directly if ready to answer.'

export const WORKLIST_INIT_NUDGE =
  'Context budget reached while exploring this task. If multi-step work remains, call `todo_plan` to list the remaining steps (then checkpoint verified /app/... paths and findings with `todo_update`); if only 1-2 quick steps or the final answer remain, finish directly without `todo_plan`.'

export type WorklistNudgeKind = 'init' | 'checkpoint'

export interface RecordedWorklistNudge {
  /** Index in `history` of the `result` item immediately after which this reminder triggered. */
  readonly afterResultIndex: number
  readonly kind: WorklistNudgeKind
}

export function nudgeTextOf(kind: WorklistNudgeKind): string {
  return kind === 'checkpoint' ? WORKLIST_CHECKPOINT_NUDGE : WORKLIST_INIT_NUDGE
}

/**
 * Apply `todo_plan` to the current turn's list. Completed and dropped items
 * (and their notes) are locked and kept at the top; `rawItems` replaces only
 * the remaining unfinished queue, activating the first unfinished item.
 */
export function applyTodoPlan(current: readonly WorklistItem[], rawItems: unknown): WorklistItem[] | string {
  const parsed = parsePlanItems(rawItems)
  if (parsed === undefined || parsed.length === 0) {
    return 'items must be a non-empty array of step strings'
  }
  const locked = current
    .filter(item => item.status === 'completed' || item.status === 'dropped')
    .map((item, idx) => ({ ...item, id: idx + 1 }))
  const lockedTitles = new Set(locked.map(item => item.content))
  // If the model re-sent already completed titles at the top of `items`, skip
  // duplicating them because `locked` already preserves them with their notes.
  const remaining = parsed.filter(title => !lockedTitles.has(title))
  if (locked.length === 0 && remaining.length < 2) {
    return 'todo_plan requires at least 2 steps; execute single-step tasks directly without todo_plan'
  }
  if (remaining.length === 0) {
    return 'todo_plan requires at least 1 new unfinished step after completed items'
  }
  if (locked.length + remaining.length > 12) {
    return `todo_plan accepts at most 12 total items (got ${locked.length + remaining.length}); group micro-actions into coarser subgoals`
  }
  const seen = new Set<string>()
  for (const [idx, title] of remaining.entries()) {
    if (seen.has(title)) {
      return `items[${idx}] duplicates ${JSON.stringify(title)}`
    }
    seen.add(title)
  }
  const tail: WorklistItem[] = remaining.map((content, idx) => ({
    id: locked.length + idx + 1,
    content,
    status: idx === 0 ? 'in_progress' : 'pending',
  }))
  return [...locked, ...tail]
}

export interface TodoUpdateInput {
  readonly id?: unknown
  readonly status?: unknown
  readonly note?: unknown
  readonly content?: unknown
}

/**
 * Apply `todo_update` to one item by 1-based `id`. Requires a non-empty `note`
 * when closing an item (`completed` or `dropped`), keeps at most one item
 * `in_progress`, and automatically advances the next `pending` item when the
 * active item finishes.
 */
export function applyTodoUpdate(
  current: readonly WorklistItem[],
  input: TodoUpdateInput,
): { items: WorklistItem[]; noted: boolean } | string {
  if (current.length === 0) {
    return 'no active todo list in this turn; call todo_plan first if this task has multiple subgoals'
  }
  const rawId = typeof input.id === 'string' ? Number(input.id.trim()) : input.id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId < 1 || rawId > current.length) {
    return `id must be an integer between 1 and ${current.length} (got ${JSON.stringify(input.id)})`
  }
  const status = normalizeWorklistStatus(input.status)
  if (status === undefined || status === 'pending') {
    return 'status must be one of: in_progress, completed, dropped'
  }
  const target = current[rawId - 1]!
  const providedNote = typeof input.note === 'string' ? sanitizeField(input.note) : ''
  const effectiveNote = providedNote !== '' ? providedNote : target.note
  if ((status === 'completed' || status === 'dropped') && (!effectiveNote || effectiveNote === '')) {
    return 'note is required when status is completed or dropped: record concrete findings, exact file paths/lines, applied edits, or test results'
  }
  const updatedContent = typeof input.content === 'string' && sanitizeField(input.content) !== ''
    ? sanitizeField(input.content)
    : target.content

  const next = current.map((item, index): WorklistItem => {
    if (index === rawId - 1) {
      return {
        id: item.id,
        content: updatedContent,
        status,
        ...effectiveNote ? { note: effectiveNote } : {},
      }
    }
    // Single-active discipline: focusing a later item auto-completes an earlier
    // active item that already recorded a note, and demotes an unnoted/later one.
    if (status === 'in_progress' && item.status === 'in_progress') {
      const autoDone = index < rawId - 1 && Boolean(item.note && item.note.trim() !== '')
      return { ...item, status: autoDone ? 'completed' : 'pending' }
    }
    return item
  })

  // Auto-advance: when no item is active anymore, promote the next pending item.
  if (!next.some(item => item.status === 'in_progress')) {
    const afterIdx = next.findIndex((item, idx) => idx > rawId - 1 && item.status === 'pending')
    const promoteIdx = afterIdx >= 0 ? afterIdx : next.findIndex(item => item.status === 'pending')
    if (promoteIdx >= 0) {
      next[promoteIdx] = { ...next[promoteIdx]!, status: 'in_progress' }
    }
  }

  return { items: next, noted: providedNote !== '' }
}

/** Model-facing rendering returned as the tool output of `todo_plan` and `todo_update`. */
export function formatWorklist(items: readonly WorklistItem[]): string {
  const lines = ['Todo list:']
  for (const item of items) {
    lines.push(`[${item.id}] (${item.status}) ${item.content}`)
    if (item.note) lines.push(`  note: ${item.note}`)
  }
  return lines.join('\n')
}

/**
 * Clean single-line projection mirrored onto DSH's native `todo/write` event for
 * the Desktop `TodoPanel` dock (omits long technical notes, and settles lingering
 * `in_progress` spinners to `pending` once `turn/end` fires).
 */
export function projectNativeTodos(
  items: readonly WorklistItem[],
  options?: { readonly turnEnded?: boolean },
): { content: string; status: 'pending' | 'in_progress' | 'completed' }[] {
  const settleActive = options?.turnEnded === true
  return items.map(item => ({
    content: item.status === 'dropped'
      ? `[${item.id}] [已跳过] ${item.content}`
      : `[${item.id}] ${item.content}`,
    status: item.status === 'dropped'
      ? 'completed'
      : (settleActive && item.status === 'in_progress' ? 'pending' : item.status),
  }))
}

/** Rendering of one HistoryItem as prompt bytes, for exact RWKV token counting. */
function historyItemPromptBytes(item: HistoryItem, historyEmptyThink = false): string {
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

function itemsTokens(items: readonly HistoryItem[], historyEmptyThink = false): number {
  let total = 0
  for (const item of items) total += countTokens(historyItemPromptBytes(item, historyEmptyThink))
  return total
}

/** Whether `callItem` is a `todo_update` that wrote a non-empty `note`. */
export function isNotedTodoUpdateCall(item: HistoryItem): boolean {
  if (item.kind !== 'call' || item.name !== TODO_UPDATE_TOOL) return false
  const note = item.args.note ?? item.args.notes ?? item.args.summary ?? item.args.findings ?? item.args.conclusion
  return typeof note === 'string' && sanitizeField(note) !== ''
}

interface CallPair {
  readonly callIndex: number
  readonly resultIndex: number
  readonly name: string
  readonly ok: boolean
  readonly notedUpdate: boolean
}

/** Completed (call, result) pairs inside `history[from..to)`. */
function collectPairs(history: readonly HistoryItem[], from: number, to: number): CallPair[] {
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

function formatFoldedStepsNote(pairs: readonly CallPair[], history: readonly HistoryItem[]): string {
  const lines = pairs.map(pair =>
    summarizeCallPair(
      history[pair.callIndex] as Extract<HistoryItem, { kind: 'call' }>,
      history[pair.resultIndex] as Extract<HistoryItem, { kind: 'result' }>,
    ),
  )
  return `[Earlier workspace steps in this turn (raw outputs folded):\n${lines.join('\n')}]`
}

function compactPriorResult(item: Extract<HistoryItem, { kind: 'result' }>): HistoryItem {
  if (item.text.length <= MAX_PRIOR_TURN_FALLBACK_RESULT_CHARS) return item
  const trimmed = item.text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return item
  const head = 1100
  const tail = 400
  return {
    ...item,
    text: `${item.text.slice(0, head)}\n...(prior-turn output folded)...\n${item.text.slice(item.text.length - tail)}`,
  }
}

/**
 * Fold one finished earlier turn `[from, to)` down to its user/final backbone:
 * - when a worklist was used, keep its final `todo_plan`/`todo_update` snapshot;
 * - when NO worklist was used (unplanned fallback), always keep the last real
 *   workspace call/result pair (plus a 1-line-per-step ledger of earlier pairs)
 *   so subsequent turns retain concrete workspace context and tool-calling shape.
 */
function foldCompletedTurn(history: readonly HistoryItem[], from: number, to: number): HistoryItem[] {
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

export interface FoldWorklistInput {
  readonly systemTokens: number
  readonly minFoldTokens?: number
  readonly budgetTokens: number
  readonly hardCapTokens?: number
  readonly backboneMaxTokens?: number
  readonly keepRecentPairs?: number
  readonly keepInitialPlan?: boolean
  /** Extra per-step reminder tokens rendered on RWKV prompts (e.g. POST_TOOL_REMINDER_THINK). */
  readonly reminderTokens?: number
  /** False (default): include past step reasoning in token count; true: empty `<think></think>`. */
  readonly historyEmptyThink?: boolean
  /** Exact non-withdrawn reminders recorded during teacher collection, used by export.ts for path-mapped parity. */
  readonly recordedNudges?: readonly RecordedWorklistNudge[]
  /** Legacy override for single-step tests. */
  readonly forceNudge?: boolean
  /** Whether to emit a live tail reminder on the current step (default: true). */
  readonly emitLiveNudge?: boolean
  /** Passive auto-fold mode: watermark-gated cross-turn & in-turn folding with zero nudges or todo checkpoints. */
  readonly passive?: boolean
}

export interface WorklistFoldResult {
  /** Folded history items (valid alternating sequence for both RWKV and OpenAI messages, including non-withdrawn reminder notes). */
  readonly items: HistoryItem[]
  /** History index in the ORIGINAL `history` from which duplicate/failure gates start. */
  readonly duplicateFrom: number
  /** Estimated total RWKV prompt tokens (system + folded items + step reminder). */
  readonly promptTokens: number
  /** Live budget reminder attached at the tail of `items` for this step; undefined when no new reminder triggered on this step. */
  readonly nudge?: string
  /** All budget reminders triggered in the active turn up to this step (for deterministic export replay). */
  readonly nudges?: readonly RecordedWorklistNudge[]
  /** Original history index of the active checkpoint `todo_update` call, if one folded the current turn. */
  readonly checkpointAt?: number
}

interface InternalNudge extends RecordedWorklistNudge {
  readonly pairIndex: number
}

interface ActiveWindowResult {
  readonly items: HistoryItem[]
  readonly duplicateFrom: number
  readonly totalTokens: number
  readonly checkpointAt?: number
  readonly liveNudge?: string
}

function buildActiveWindow(
  history: readonly HistoryItem[],
  turnStart: number,
  endIndex: number,
  pairsSub: readonly CallPair[],
  nudges: readonly InternalNudge[],
  activeCheckpoints: ReadonlySet<number>,
  options: {
    readonly baseOverhead: number
    readonly budgetTokens: number
    readonly hardCap: number
    readonly keepRecentCount: number
    readonly keepInitialPlan: boolean
    readonly emptyThink: boolean
    readonly emitLiveNudge: boolean
    readonly passive: boolean
    readonly fullTok: readonly number[]
    readonly bareTok: readonly number[]
  },
): ActiveWindowResult {
  const lastCheckpoint = [...pairsSub].reverse().find(pair => pair.notedUpdate && activeCheckpoints.has(pair.callIndex))
  const firstPlanPair = pairsSub.find(pair => pair.ok && pair.name === TODO_PLAN_TOOL)
  const unclosedPlanPair = lastCheckpoint === undefined
    ? [...pairsSub].reverse().find(pair => pair.ok && isWorklistTool(pair.name))
    : undefined

  let currentIndices: number[] = []
  let duplicateFrom = turnStart
  let checkpointAt: number | undefined

  if (lastCheckpoint !== undefined) {
    checkpointAt = lastCheckpoint.callIndex
    const preWs = pairsSub.filter(pair => pair.callIndex < lastCheckpoint.callIndex && !isWorklistTool(pair.name))
    const keptTail: CallPair[] = []
    if (options.keepRecentCount >= 1 && preWs.length >= 1) {
      const lastWs = preWs[preWs.length - 1]!
      keptTail.unshift(lastWs)
      if (options.keepRecentCount >= 2 && preWs.length >= 2) {
        const prevWs = preWs[preWs.length - 2]!
        const tailTokens = options.fullTok[prevWs.callIndex]! + options.fullTok[prevWs.resultIndex]!
          + options.fullTok[lastWs.callIndex]! + options.fullTok[lastWs.resultIndex]!
        if (tailTokens <= MAX_SECOND_RECENT_PAIR_TOKENS) {
          keptTail.unshift(prevWs)
        }
      }
    }
    duplicateFrom = keptTail.length > 0 ? keptTail[0]!.callIndex : lastCheckpoint.resultIndex + 1

    const keepPreIndices = new Set<number>()
    if (options.keepInitialPlan && firstPlanPair !== undefined && firstPlanPair.callIndex < lastCheckpoint.callIndex) {
      keepPreIndices.add(firstPlanPair.callIndex)
      keepPreIndices.add(firstPlanPair.resultIndex)
    }
    for (const pair of keptTail) {
      keepPreIndices.add(pair.callIndex)
      keepPreIndices.add(pair.resultIndex)
    }
    for (let i = turnStart; i < lastCheckpoint.callIndex; i++) {
      const kind = history[i]!.kind
      if (kind === 'user' || kind === 'note' || keepPreIndices.has(i)) {
        currentIndices.push(i)
      }
    }
    for (let i = lastCheckpoint.callIndex; i < endIndex; i++) {
      currentIndices.push(i)
    }
  } else {
    for (let i = turnStart; i < endIndex; i++) currentIndices.push(i)
  }

  let keptSet = new Set<number>(currentIndices)
  const clearedReasoning = new Set<number>()

  // Discontinuous anchor hygiene: when `firstPlanPair` is pinned across a folded
  // gap after it, clear its stale step-1 reasoning so teacher/student models do
  // not template-copy that opening CoT prefix across dozens of later steps, nor
  // retain orphan references to pre-plan exploration.
  if (firstPlanPair !== undefined && keptSet.has(firstPlanPair.callIndex)) {
    const planIdx = pairsSub.indexOf(firstPlanPair)
    if (planIdx >= 0 && planIdx + 1 < pairsSub.length && !keptSet.has(pairsSub[planIdx + 1]!.callIndex)) {
      clearedReasoning.add(firstPlanPair.callIndex)
    }
  }

  const protectedCallIndices = new Set<number>()
  if (lastCheckpoint !== undefined) protectedCallIndices.add(lastCheckpoint.callIndex)
  if (unclosedPlanPair !== undefined) protectedCallIndices.add(unclosedPlanPair.callIndex)
  if (firstPlanPair !== undefined) protectedCallIndices.add(firstPlanPair.callIndex)

  const droppedByHardCap: CallPair[] = []
  const nudgeTokCache = {
    init: countTokens(`User: ${WORKLIST_INIT_NUDGE}\n\n`),
    checkpoint: countTokens(`User: ${WORKLIST_CHECKPOINT_NUDGE}\n\n`),
  }

  const assemble = (): { items: HistoryItem[]; tokens: number; liveNudge?: string } => {
    const out: HistoryItem[] = []
    let tok = options.baseOverhead
    let liveNudge: string | undefined
    let ledgerInserted = false
    const ledgerText = droppedByHardCap.length > 0 ? formatFoldedStepsNote(droppedByHardCap, history) : undefined

    const byAfterResult = new Map<number, InternalNudge>()
    const byBeforeNextCall = new Map<number, InternalNudge>()
    for (const n of nudges) {
      if (n.pairIndex === pairsSub.length - 1) {
        if (keptSet.has(n.afterResultIndex)) byAfterResult.set(n.afterResultIndex, n)
      } else if (n.pairIndex + 1 < pairsSub.length) {
        const nextCallIdx = pairsSub[n.pairIndex + 1]!.callIndex
        if (!keptSet.has(nextCallIdx)) continue
        if (keptSet.has(n.afterResultIndex)) {
          byAfterResult.set(n.afterResultIndex, n)
        } else {
          const nextItem = history[nextCallIdx]!
          if (nextItem.kind === 'call' && Boolean(nextItem.reasoning) && !clearedReasoning.has(nextCallIdx)) {
            byBeforeNextCall.set(nextCallIdx, n)
          }
        }
      }
    }

    const hasAssistantAfter = (idx: number): boolean => {
      for (let m = idx + 1; m < endIndex; m++) {
        if (keptSet.has(m) && history[m]!.kind === 'assistant') return true
      }
      return false
    }

    for (const idx of currentIndices) {
      const raw = history[idx]!
      if (!ledgerInserted && ledgerText !== undefined && (raw.kind === 'call' || raw.kind === 'assistant')) {
        out.push({ kind: 'note', text: ledgerText })
        tok += countTokens(`User: ${ledgerText}\n\n`)
        ledgerInserted = true
      }
      const preNudge = byBeforeNextCall.get(idx)
      if (preNudge !== undefined) {
        const text = nudgeTextOf(preNudge.kind)
        out.push({ kind: 'note', text })
        tok += nudgeTokCache[preNudge.kind]
      }
      if ((raw.kind === 'call' || raw.kind === 'assistant') && raw.reasoning && clearedReasoning.has(idx)) {
        out.push({ ...raw, reasoning: undefined })
        tok += options.bareTok[idx]!
      } else {
        out.push(raw)
        tok += options.fullTok[idx]!
      }
      const postNudge = byAfterResult.get(idx)
      if (postNudge !== undefined) {
        const isLiveTail = postNudge.pairIndex === pairsSub.length - 1 && !hasAssistantAfter(idx)
        if (!isLiveTail || options.emitLiveNudge) {
          const text = nudgeTextOf(postNudge.kind)
          out.push({ kind: 'note', text })
          tok += nudgeTokCache[postNudge.kind]
          if (isLiveTail) liveNudge = text
        }
      }
    }
    return { items: out, tokens: tok, ...(liveNudge !== undefined ? { liveNudge } : {}) }
  }

  let built = assemble()

  // Hard safety valve:
  //   Phase 1 — strip bloated reasoning on older unfolded steps (oldest first)
  //             so a long CoT never deletes read source files!
  if (!options.emptyThink && built.tokens > options.hardCap) {
    for (const idx of currentIndices) {
      if (built.tokens <= options.hardCap) break
      const item = history[idx]!
      if ((item.kind === 'call' || item.kind === 'assistant') && item.reasoning && !clearedReasoning.has(idx)) {
        clearedReasoning.add(idx)
        built = assemble()
      }
    }
  }

  //   Phase 2 — in passive auto-fold mode, deterministically fold oldest
  //             in-turn pairs past `budgetTokens` while retaining at least
  //             `keepRecentCount` pairs verbatim; then enforce `hardCap` safety
  //             ceiling across both modes.
  const droppablePairs = pairsSub.filter(pair =>
    keptSet.has(pair.callIndex) && !protectedCallIndices.has(pair.callIndex),
  )
  if (options.passive) {
    const keepFloor = Math.max(1, options.keepRecentCount)
    while (droppablePairs.length > keepFloor && built.tokens > options.budgetTokens) {
      const oldest = droppablePairs.shift()!
      droppedByHardCap.push(oldest)
      keptSet.delete(oldest.callIndex)
      keptSet.delete(oldest.resultIndex)
      currentIndices = currentIndices.filter(i => i !== oldest.callIndex && i !== oldest.resultIndex)
      duplicateFrom = Math.max(duplicateFrom, oldest.resultIndex + 1)
      built = assemble()
    }
  }
  while (droppablePairs.length > 1 && built.tokens > options.hardCap) {
    const oldest = droppablePairs.shift()!
    droppedByHardCap.push(oldest)
    keptSet.delete(oldest.callIndex)
    keptSet.delete(oldest.resultIndex)
    currentIndices = currentIndices.filter(i => i !== oldest.callIndex && i !== oldest.resultIndex)
    duplicateFrom = Math.max(duplicateFrom, oldest.resultIndex + 1)
    built = assemble()
  }

  return {
    items: built.items,
    duplicateFrom,
    totalTokens: built.tokens,
    ...(checkpointAt !== undefined ? { checkpointAt } : {}),
    ...(built.liveNudge !== undefined ? { liveNudge: built.liveNudge } : {}),
  }
}

/**
 * Pure context-folding plan over `history`. Produces the exact `HistoryItem[]`
 * sequence kept in the prompt (including non-withdrawn budget reminders and
 * unplanned fallback ledgers), the `duplicateFrom` gate boundary, and whether
 * a new budget reminder triggered at the tail of this step.
 */
export function foldWorklist(history: readonly HistoryItem[], input: FoldWorklistInput): WorklistFoldResult {
  const emptyThink = input.historyEmptyThink ?? false
  if (history.length === 0) {
    return { items: [], duplicateFrom: 0, promptTokens: input.systemTokens }
  }

  // Partition into user turns; any leading runtime notes attach to turn 0.
  const userStarts: number[] = []
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.kind === 'user') userStarts.push(i)
  }
  if (userStarts.length === 0) {
    const tok = input.systemTokens + itemsTokens(history, emptyThink)
    return { items: [...history], duplicateFrom: 0, promptTokens: tok }
  }

  const passive = input.passive === true
  const minFoldTokens = Math.max(0, input.minFoldTokens ?? 0)
  const turnStart = userStarts.length === 1 ? 0 : userStarts[userStarts.length - 1]!
  const backboneMax = input.backboneMaxTokens ?? DEFAULT_BACKBONE_MAX_TOKENS
  const priorTurns: HistoryItem[][] = []
  if (passive && userStarts.length > 1) {
    const rawTurns: HistoryItem[][] = []
    const foldedTurns: HistoryItem[][] = []
    for (let t = 0; t < userStarts.length - 1; t++) {
      const from = t === 0 ? 0 : userStarts[t]!
      const to = userStarts[t + 1]!
      rawTurns.push(history.slice(from, to))
      foldedTurns.push(foldCompletedTurn(history, from, to))
    }
    const activeRawTokens = itemsTokens(history.slice(turnStart), emptyThink)
    const baseFixed = input.systemTokens + (input.reminderTokens ?? 0)
    if (minFoldTokens > 0) {
      for (const raw of rawTurns) priorTurns.push(raw)
      let totalPrior = priorTurns.reduce((sum, turn) => sum + itemsTokens(turn, emptyThink), 0)
      for (let t = 0; t < priorTurns.length; t++) {
        if (baseFixed + totalPrior + activeRawTokens < minFoldTokens) break
        const oldTok = itemsTokens(priorTurns[t]!, emptyThink)
        const newTok = itemsTokens(foldedTurns[t]!, emptyThink)
        priorTurns[t] = foldedTurns[t]!
        totalPrior += newTok - oldTok
      }
      // Fold any remaining un-folded prior turns before dropping whole turns at `backboneMax`.
      for (let t = 0; t < priorTurns.length && totalPrior > backboneMax; t++) {
        if (priorTurns[t] === foldedTurns[t]) continue
        const oldTok = itemsTokens(priorTurns[t]!, emptyThink)
        const newTok = itemsTokens(foldedTurns[t]!, emptyThink)
        priorTurns[t] = foldedTurns[t]!
        totalPrior += newTok - oldTok
      }
    } else {
      for (const folded of foldedTurns) priorTurns.push(folded)
    }
  } else {
    for (let t = 0; t < userStarts.length - 1; t++) {
      const from = t === 0 ? 0 : userStarts[t]!
      const to = userStarts[t + 1]!
      priorTurns.push(foldCompletedTurn(history, from, to))
    }
  }
  // High-water mark on completed prior turns (only hit in 15+ turn marathon chats).
  let priorTokens = priorTurns.reduce((sum, turn) => sum + itemsTokens(turn, emptyThink), 0)
  while (priorTurns.length > 0 && priorTokens > backboneMax) {
    const dropped = priorTurns.shift()!
    priorTokens -= itemsTokens(dropped, emptyThink)
  }
  const priorItems = priorTurns.flat()

  const pairs = collectPairs(history, turnStart, history.length)
  const baseOverhead = input.systemTokens + priorTokens + (input.reminderTokens ?? 0)
  const hardCap = input.hardCapTokens ?? (input.budgetTokens + DEFAULT_WORKLIST_HARD_SLACK_TOKENS)
  const keepRecentCount = Math.max(0, input.keepRecentPairs ?? DEFAULT_KEEP_RECENT_PAIRS)
  const keepInitialPlan = input.keepInitialPlan !== false
  const emitLiveNudge = input.emitLiveNudge !== false

  // Precompute per-item RWKV token counts once for the active turn so step-by-step
  // reminder replay is pure integer arithmetic.
  const fullTok = new Array<number>(history.length).fill(0)
  const bareTok = new Array<number>(history.length).fill(0)
  for (let i = turnStart; i < history.length; i++) {
    const item = history[i]!
    fullTok[i] = countTokens(historyItemPromptBytes(item, emptyThink))
    bareTok[i] = (item.kind === 'call' || item.kind === 'assistant') && item.reasoning && !emptyThink
      ? countTokens(historyItemPromptBytes({ ...item, reasoning: undefined }, emptyThink))
      : fullTok[i]!
  }

  const windowOpts = {
    baseOverhead,
    budgetTokens: input.budgetTokens,
    hardCap,
    keepRecentCount,
    keepInitialPlan,
    emptyThink,
    emitLiveNudge,
    passive,
    fullTok,
    bareTok,
  }

  // Replay completed pairs in the active turn to identify exact non-withdrawn
  // budget reminders. Because `history[0..pair.resultIndex+1]` is immutable
  // across future steps, each triggered reminder stays permanently anchored to
  // its step transition until that segment itself is folded out by a checkpoint.
  const triggeredNudges: InternalNudge[] = []
  const activeCheckpoints = new Set<number>()
  const recordedByResult = input.recordedNudges !== undefined
    ? new Map(input.recordedNudges.map(n => [n.afterResultIndex, n.kind]))
    : undefined

  for (let k = 0; !passive && k < pairs.length; k++) {
    const pair = pairs[k]!
    const pairsSub = pairs.slice(0, k + 1)

    if (pair.notedUpdate) {
      if (minFoldTokens <= 0) {
        activeCheckpoints.add(pair.callIndex)
      } else {
        const winBeforeFold = buildActiveWindow(
          history, turnStart, pair.resultIndex + 1, pairsSub, triggeredNudges, activeCheckpoints, windowOpts,
        )
        if (winBeforeFold.totalTokens >= minFoldTokens) {
          activeCheckpoints.add(pair.callIndex)
        }
      }
    }

    if (recordedByResult !== undefined) {
      const kind = recordedByResult.get(pair.resultIndex)
      if (kind !== undefined) {
        triggeredNudges.push({ pairIndex: k, afterResultIndex: pair.resultIndex, kind })
      }
      continue
    }

    const isFinalStepOverride = input.forceNudge !== undefined && k === pairs.length - 1 && pair.resultIndex === history.length - 1
    if (isFinalStepOverride) {
      if (input.forceNudge) {
        const hasPlanAtK = pairsSub.some(p => p.ok && isWorklistTool(p.name))
        triggeredNudges.push({
          pairIndex: k,
          afterResultIndex: pair.resultIndex,
          kind: hasPlanAtK ? 'checkpoint' : 'init',
        })
      }
      continue
    }

    const winAtK = buildActiveWindow(
      history, turnStart, pair.resultIndex + 1, pairsSub, triggeredNudges, activeCheckpoints, windowOpts,
    )
    const lastCheckpointAtK = [...pairsSub].reverse().find(p => p.notedUpdate && activeCheckpoints.has(p.callIndex))
    const checkpointPairIdx = lastCheckpointAtK !== undefined ? pairsSub.indexOf(lastCheckpointAtK) : -1
    const searchAfter = lastCheckpointAtK !== undefined ? lastCheckpointAtK.resultIndex + 1 : turnStart
    const unfoldedWs = pairsSub.filter(p => p.callIndex >= searchAfter && !isWorklistTool(p.name)).length
    const hasPlanAtK = pairsSub.some(p => p.ok && isWorklistTool(p.name))
    const kind: WorklistNudgeKind = hasPlanAtK ? 'checkpoint' : 'init'
    const cooldown = kind === 'init' ? INIT_NUDGE_COOLDOWN_STEPS : CHECKPOINT_NUDGE_COOLDOWN_STEPS
    const prevSameKind = [...triggeredNudges].reverse().find(n => n.pairIndex > checkpointPairIdx && n.kind === kind)
    const onCooldown = prevSameKind !== undefined && (k - prevSameKind.pairIndex) < cooldown

    if (!onCooldown && unfoldedWs >= 1 && winAtK.totalTokens > input.budgetTokens) {
      triggeredNudges.push({ pairIndex: k, afterResultIndex: pair.resultIndex, kind })
    }
  }

  const finalWin = buildActiveWindow(history, turnStart, history.length, pairs, triggeredNudges, activeCheckpoints, windowOpts)
  const recorded: RecordedWorklistNudge[] = triggeredNudges.map(({ afterResultIndex, kind }) => ({ afterResultIndex, kind }))

  return {
    items: [...priorItems, ...finalWin.items],
    duplicateFrom: finalWin.duplicateFrom,
    promptTokens: finalWin.totalTokens,
    ...(finalWin.liveNudge !== undefined ? { nudge: finalWin.liveNudge } : {}),
    ...(recorded.length > 0 ? { nudges: recorded } : {}),
    ...(finalWin.checkpointAt !== undefined ? { checkpointAt: finalWin.checkpointAt } : {}),
  }
}

export interface WorklistEntryOptions extends TranscriptOptions {
  readonly systemTokens: number
  readonly minFoldTokens?: number
  readonly budgetTokens: number
  readonly hardCapTokens?: number
  readonly backboneMaxTokens?: number
  readonly keepRecentPairs?: number
  readonly keepInitialPlan?: boolean
  readonly historyEmptyThink?: boolean
  readonly recordedNudges?: readonly RecordedWorklistNudge[]
  readonly forceNudge?: boolean
  readonly passive?: boolean
}

/** Build RWKV prompt entries (after System:) + TurnState gate boundary for `worklist` / `auto-fold` mode. */
export function worklistEntries(
  history: readonly HistoryItem[],
  options: WorklistEntryOptions,
): { entries: Entry[]; fold: WorklistFoldResult } {
  const reminderTokens = options.reminders === false || !options.postToolReminder ? 0 : countTokens(options.postToolReminder)
  const fold = foldWorklist(history, {
    systemTokens: options.systemTokens,
    ...options.minFoldTokens === undefined ? {} : { minFoldTokens: options.minFoldTokens },
    budgetTokens: options.budgetTokens,
    ...options.hardCapTokens === undefined ? {} : { hardCapTokens: options.hardCapTokens },
    ...options.backboneMaxTokens === undefined ? {} : { backboneMaxTokens: options.backboneMaxTokens },
    ...options.keepRecentPairs === undefined ? {} : { keepRecentPairs: options.keepRecentPairs },
    ...options.keepInitialPlan === undefined ? {} : { keepInitialPlan: options.keepInitialPlan },
    reminderTokens,
    ...options.historyEmptyThink === undefined ? {} : { historyEmptyThink: options.historyEmptyThink },
    ...options.recordedNudges === undefined ? {} : { recordedNudges: options.recordedNudges },
    ...options.forceNudge === undefined ? {} : { forceNudge: options.forceNudge },
    ...options.passive === undefined ? {} : { passive: options.passive },
    emitLiveNudge: options.reminders !== false,
  })
  const entries = transcriptEntries(fold.items, options)
  return { entries, fold }
}
