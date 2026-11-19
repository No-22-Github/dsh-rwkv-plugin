// Context-folding orchestrator shared by `auto-fold` (`passive: true`) and
// active stateful worklist (`todo_plan` + `todo_update`).
//
// Submodules:
//   - `todo-state.ts`: active `todo_plan` / `todo_update` state transitions & UI projection
//   - `fold-pairs.ts`: pair extraction, completed-turn backbone, `foldedUnreadPaths`, unedited-read pinning
//   - `fold-window.ts`: active-turn window assembly, reminder replay, sliding/epoch cuts, hardCap safety valve
//
// Shared by the student plugin (`decideStep`), the teacher overlay (`teacher.ts`)
// and the training exporter (`export.ts`) so prompt bytes match everywhere.

import { countTokens } from '../tokenizer.ts'
import {
  DEFAULT_BACKBONE_MAX_TOKENS,
  DEFAULT_KEEP_RECENT_PAIRS,
  DEFAULT_WORKLIST_BUDGET_TOKENS,
  DEFAULT_WORKLIST_HARD_SLACK_TOKENS,
  DEFAULT_WORKLIST_MIN_FOLD_TOKENS,
} from './defaults.ts'
import {
  collectPairs,
  foldCompletedTurn,
  foldedUnreadPaths,
  historyItemPromptBytes,
  itemsTokens,
} from './fold-pairs.ts'
import {
  buildActiveWindow,
  buildEpochJumpWindow,
  CHECKPOINT_NUDGE_COOLDOWN_STEPS,
  INIT_NUDGE_COOLDOWN_STEPS,
  nudgeTextOf,
  WORKLIST_CHECKPOINT_NUDGE,
  WORKLIST_INIT_NUDGE,
  type ActiveWindowResult,
  type InternalNudge,
  type RecordedWorklistNudge,
  type WorklistNudgeKind,
} from './fold-window.ts'
import { transcriptEntries, type HistoryItem, type TranscriptOptions } from './policy.ts'
import type { Entry } from './prompt.ts'
import { isWorklistTool } from './todo-state.ts'

export {
  DEFAULT_BACKBONE_MAX_TOKENS,
  DEFAULT_KEEP_RECENT_PAIRS,
  DEFAULT_WORKLIST_BUDGET_TOKENS,
  DEFAULT_WORKLIST_HARD_SLACK_TOKENS,
  DEFAULT_WORKLIST_MIN_FOLD_TOKENS,
}

export {
  applyTodoPlan,
  applyTodoUpdate,
  formatWorklist,
  isNotedTodoUpdateCall,
  isWorklistTool,
  normalizeWorklistStatus,
  parsePlanItems,
  projectNativeTodos,
  TODO_PLAN_TOOL,
  TODO_UPDATE_TOOL,
  WORKLIST_TOOLS,
  type TodoUpdateInput,
  type WorklistItem,
  type WorklistStatus,
} from './todo-state.ts'

export { foldedUnreadPaths }

export {
  nudgeTextOf,
  WORKLIST_CHECKPOINT_NUDGE,
  WORKLIST_INIT_NUDGE,
  type RecordedWorklistNudge,
  type WorklistNudgeKind,
}

export interface WorklistOptions {
  /** Minimum RWKV prompt tokens required before folding kicks in (default: 8000 in plugin config). */
  readonly minFoldTokens?: number
  /** Total RWKV token high watermark (default: 12000). */
  readonly budgetTokens: number
  /** Hard RWKV token safety ceiling (defaults to `budgetTokens + 3000`). */
  readonly hardCapTokens?: number
  /** Maximum RWKV tokens kept for completed earlier user turns (default: 5000). */
  readonly backboneMaxTokens?: number
  /** Recent workspace call/result pairs kept verbatim across a fold (default: 2). */
  readonly keepRecentPairs?: number
  /** Whether to retain the initial `todo_plan` pair in the folded active turn (default: true). */
  readonly keepInitialPlan?: boolean
  /** Whether to inject `WORKLIST_SYSTEM_GUIDANCE` into the system prompt (default: true). */
  readonly systemGuidance?: boolean
  /** Auto-fold (`passive: true`): omit active `todo_*` tools, guidance, and budget nudges. */
  readonly passive?: boolean
  /** Optional epoch-jump target in `auto-fold` (`passive: true`, default: 0 disabled). */
  readonly epochTargetTokens?: number
  /** Pin up to one latest unedited `read` pair (<= 2400 tokens) across a fold boundary (default: false). */
  readonly pinUneditedRead?: boolean
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
  /** Optional epoch-jump target in passive auto-fold mode (0 disables). */
  readonly epochTargetTokens?: number
  /** Pin latest unedited `read` across a fold boundary (default: false). */
  readonly pinUneditedRead?: boolean
  /** Session working directory for normalizing relative vs absolute paths in `foldedUnread`. */
  readonly cwd?: string
}

export interface WorklistFoldResult {
  readonly items: HistoryItem[]
  readonly duplicateFrom: number
  readonly promptTokens: number
  readonly nudge?: string
  readonly nudges?: readonly RecordedWorklistNudge[]
  readonly checkpointAt?: number
  readonly foldedUnread: readonly string[]
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
  readonly epochTargetTokens?: number
  readonly pinUneditedRead?: boolean
  readonly cwd?: string
}

function foldPriorTurns(
  history: readonly HistoryItem[],
  userStarts: readonly number[],
  turnStart: number,
  emptyThink: boolean,
  passive: boolean,
  minFoldTokens: number,
  backboneMax: number,
  baseFixed: number,
): { priorItems: HistoryItem[]; priorTokens: number } {
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

  let priorTokens = priorTurns.reduce((sum, turn) => sum + itemsTokens(turn, emptyThink), 0)
  while (priorTurns.length > 0 && priorTokens > backboneMax) {
    const dropped = priorTurns.shift()!
    priorTokens -= itemsTokens(dropped, emptyThink)
  }
  return { priorItems: priorTurns.flat(), priorTokens }
}

/**
 * Pure context-folding plan over `history`. Produces the exact `HistoryItem[]`
 * sequence kept in the prompt, the `duplicateFrom` gate boundary, and whether
 * a new budget reminder triggered at the tail of this step.
 */
export function foldWorklist(history: readonly HistoryItem[], input: FoldWorklistInput): WorklistFoldResult {
  const emptyThink = input.historyEmptyThink ?? false
  if (history.length === 0) {
    return { items: [], duplicateFrom: 0, promptTokens: input.systemTokens, foldedUnread: [] }
  }

  const userStarts: number[] = []
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.kind === 'user') userStarts.push(i)
  }
  if (userStarts.length === 0) {
    const tok = input.systemTokens + itemsTokens(history, emptyThink)
    return { items: [...history], duplicateFrom: 0, promptTokens: tok, foldedUnread: [] }
  }

  const passive = input.passive === true
  const minFoldTokens = Math.max(0, input.minFoldTokens ?? 0)
  const turnStart = userStarts.length === 1 ? 0 : userStarts[userStarts.length - 1]!
  const backboneMax = input.backboneMaxTokens ?? DEFAULT_BACKBONE_MAX_TOKENS
  const baseFixed = input.systemTokens + (input.reminderTokens ?? 0)

  const { priorItems, priorTokens } = foldPriorTurns(
    history, userStarts, turnStart, emptyThink, passive, minFoldTokens, backboneMax, baseFixed,
  )

  const pairs = collectPairs(history, turnStart, history.length)
  const baseOverhead = input.systemTokens + priorTokens + (input.reminderTokens ?? 0)
  const hardCap = input.hardCapTokens ?? (input.budgetTokens + DEFAULT_WORKLIST_HARD_SLACK_TOKENS)
  const keepRecentCount = Math.max(0, input.keepRecentPairs ?? DEFAULT_KEEP_RECENT_PAIRS)
  const keepInitialPlan = input.keepInitialPlan !== false
  const emitLiveNudge = input.emitLiveNudge !== false

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
    pinUneditedRead: input.pinUneditedRead === true,
    cwd: input.cwd,
    fullTok,
    bareTok,
  }

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

  const epochTargetTokens = Math.max(0, input.epochTargetTokens ?? 0)
  const finalWin: ActiveWindowResult = passive && epochTargetTokens > 0 && epochTargetTokens < input.budgetTokens
    ? buildEpochJumpWindow(history, turnStart, pairs, triggeredNudges, activeCheckpoints, windowOpts, epochTargetTokens)
    : buildActiveWindow(history, turnStart, history.length, pairs, triggeredNudges, activeCheckpoints, windowOpts)

  const recorded: RecordedWorklistNudge[] = triggeredNudges.map(({ afterResultIndex, kind }) => ({ afterResultIndex, kind }))
  const items = [...priorItems, ...finalWin.items]

  return {
    items,
    duplicateFrom: finalWin.duplicateFrom,
    promptTokens: finalWin.totalTokens,
    ...(finalWin.liveNudge !== undefined ? { nudge: finalWin.liveNudge } : {}),
    ...(recorded.length > 0 ? { nudges: recorded } : {}),
    ...(finalWin.checkpointAt !== undefined ? { checkpointAt: finalWin.checkpointAt } : {}),
    foldedUnread: foldedUnreadPaths(history, items, input.cwd),
  }
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
    ...options.epochTargetTokens === undefined ? {} : { epochTargetTokens: options.epochTargetTokens },
    ...options.pinUneditedRead === undefined ? {} : { pinUneditedRead: options.pinUneditedRead },
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    emitLiveNudge: options.reminders !== false,
  })
  const entries = transcriptEntries(fold.items, options)
  return { entries, fold }
}
