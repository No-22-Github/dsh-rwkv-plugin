// Active turn window assembly for `auto-fold` and active `worklist`:
// checkpoint slicing, budget reminder replay, passive sliding/epoch folding,
// optional unedited-read pinning, and the hardCap safety valve.

import { countTokens } from '../tokenizer.ts'
import {
  findLatestUneditedReadPair,
  formatFoldedStepsNote,
  formatStageArchiveNote,
  historyItemPromptBytes,
  maskResultInPlace,
  READ_PIN_TOOLS,
  type CallPair,
} from './fold-pairs.ts'
import type { HistoryItem } from './policy.ts'
import { isWorklistTool, TODO_PLAN_TOOL } from './todo-state.ts'

const MAX_SECOND_RECENT_PAIR_TOKENS = 2800
export const INIT_NUDGE_COOLDOWN_STEPS = 4
export const CHECKPOINT_NUDGE_COOLDOWN_STEPS = 3

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

export interface InternalNudge extends RecordedWorklistNudge {
  readonly pairIndex: number
}

export interface ActiveWindowOptions {
  readonly baseOverhead: number
  readonly budgetTokens: number
  readonly hardCap: number
  readonly keepRecentCount: number
  readonly keepInitialPlan: boolean
  readonly emptyThink: boolean
  readonly emitLiveNudge: boolean
  readonly passive: boolean
  readonly pinUneditedRead: boolean
  readonly cwd?: string
  readonly fullTok: readonly number[]
  readonly bareTok: readonly number[]
  readonly forcedCutPairCount?: number
  readonly forcedPinnedRead?: CallPair
}

export interface ActiveWindowResult {
  readonly items: HistoryItem[]
  readonly duplicateFrom: number
  readonly totalTokens: number
  readonly checkpointAt?: number
  readonly liveNudge?: string
  readonly maskedCallIds?: ReadonlySet<string>
}

export function buildActiveWindow(
  history: readonly HistoryItem[],
  turnStart: number,
  endIndex: number,
  pairsSub: readonly CallPair[],
  nudges: readonly InternalNudge[],
  activeCheckpoints: ReadonlySet<number>,
  options: ActiveWindowOptions,
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
    if (options.pinUneditedRead && options.keepRecentCount >= 1 && !keptTail.some(pair => pair.ok && READ_PIN_TOOLS.has(pair.name))) {
      const preFolded = preWs.filter(pair => !keepPreIndices.has(pair.callIndex))
      const activeAtCheckpoint = pairsSub.filter(pair => keepPreIndices.has(pair.callIndex) || pair.callIndex >= lastCheckpoint.callIndex)
      const pinnedPreRead = findLatestUneditedReadPair(
        preFolded,
        history,
        pair => options.bareTok[pair.callIndex]! + options.bareTok[pair.resultIndex]!,
        options.cwd,
        activeAtCheckpoint,
      )
      if (pinnedPreRead !== undefined) {
        keepPreIndices.add(pinnedPreRead.callIndex)
        keepPreIndices.add(pinnedPreRead.resultIndex)
      }
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

  const keptSet = new Set<number>(currentIndices)
  const clearedReasoning = new Set<number>()

  if (firstPlanPair !== undefined && keptSet.has(firstPlanPair.callIndex)) {
    const planIdx = pairsSub.indexOf(firstPlanPair)
    if (planIdx >= 0 && planIdx + 1 < pairsSub.length && !keptSet.has(pairsSub[planIdx + 1]!.callIndex)) {
      clearedReasoning.add(firstPlanPair.callIndex)
    }
  }
  for (const pair of pairsSub) {
    if (pair === firstPlanPair || !keptSet.has(pair.callIndex)) continue
    const idx = pairsSub.indexOf(pair)
    if (idx >= 0 && idx + 1 < pairsSub.length && !keptSet.has(pairsSub[idx + 1]!.callIndex)) {
      clearedReasoning.add(pair.callIndex)
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

  const droppablePairs = pairsSub.filter(pair =>
    keptSet.has(pair.callIndex) && !protectedCallIndices.has(pair.callIndex),
  )
  const dropPairFromWindow = (pair: CallPair): void => {
    droppedByHardCap.push(pair)
    keptSet.delete(pair.callIndex)
    keptSet.delete(pair.resultIndex)
    currentIndices = currentIndices.filter(i => i !== pair.callIndex && i !== pair.resultIndex)
    duplicateFrom = Math.max(duplicateFrom, pair.resultIndex + 1)
  }
  const insertPairInOrder = (pair: CallPair): void => {
    keptSet.add(pair.callIndex)
    keptSet.add(pair.resultIndex)
    const next = [...currentIndices, pair.callIndex, pair.resultIndex]
    next.sort((a, b) => a - b)
    currentIndices = next
    clearedReasoning.add(pair.callIndex)
  }

  if (options.passive) {
    if (options.forcedCutPairCount !== undefined) {
      const cutTarget = Math.min(options.forcedCutPairCount, droppablePairs.length)
      for (let c = 0; c < cutTarget; c++) {
        const pair = droppablePairs.shift()!
        if (options.forcedPinnedRead === pair) {
          clearedReasoning.add(pair.callIndex)
          duplicateFrom = Math.max(duplicateFrom, pair.resultIndex + 1)
          continue
        }
        dropPairFromWindow(pair)
      }
      if (cutTarget > 0) built = assemble()
    } else {
      const keepFloor = Math.max(1, options.keepRecentCount)
      while (droppablePairs.length > keepFloor && built.tokens > options.budgetTokens) {
        dropPairFromWindow(droppablePairs.shift()!)
        built = assemble()
      }
      if (options.pinUneditedRead && droppedByHardCap.length > 0 && options.keepRecentCount >= 1) {
        const pinned = findLatestUneditedReadPair(
          droppedByHardCap,
          history,
          pair => options.bareTok[pair.callIndex]! + options.bareTok[pair.resultIndex]!,
          options.cwd,
          droppablePairs,
        )
        if (pinned !== undefined) {
          const pinIdx = droppedByHardCap.indexOf(pinned)
          const prevIndices = currentIndices
          const prevCleared = clearedReasoning.has(pinned.callIndex)
          droppedByHardCap.splice(pinIdx, 1)
          insertPairInOrder(pinned)
          built = assemble()
          if (built.tokens > options.budgetTokens) {
            droppedByHardCap.splice(pinIdx, 0, pinned)
            keptSet.delete(pinned.callIndex)
            keptSet.delete(pinned.resultIndex)
            currentIndices = prevIndices
            if (!prevCleared) clearedReasoning.delete(pinned.callIndex)
            built = assemble()
          }
        }
      }
    }
  }
  while (droppablePairs.length > 1 && built.tokens > options.hardCap) {
    dropPairFromWindow(droppablePairs.shift()!)
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
 * Epoch-jump folding replay (`passive: true` + `0 < epochTargetTokens < budgetTokens`):
 * prefix stays 100% append-only until `totalTokens > budgetTokens`, then cuts
 * oldest pairs down to `<= epochTargetTokens`.
 */
export function buildEpochJumpWindow(
  history: readonly HistoryItem[],
  turnStart: number,
  pairs: readonly CallPair[],
  triggeredNudges: readonly InternalNudge[],
  activeCheckpoints: ReadonlySet<number>,
  windowOpts: ActiveWindowOptions,
  epochTargetTokens: number,
): ActiveWindowResult {
  const keepFloor = Math.max(1, windowOpts.keepRecentCount)
  let cutPairCount = 0
  let frozenPinnedRead: CallPair | undefined
  for (let k = 0; k < pairs.length; k++) {
    const pairsSub = pairs.slice(0, k + 1)
    const endAtK = pairs[k]!.resultIndex + 1
    let win = buildActiveWindow(history, turnStart, endAtK, pairsSub, triggeredNudges, activeCheckpoints, {
      ...windowOpts,
      forcedCutPairCount: cutPairCount,
      forcedPinnedRead: frozenPinnedRead,
    })
    if (win.totalTokens > windowOpts.budgetTokens && (pairsSub.length - cutPairCount) > keepFloor) {
      frozenPinnedRead = undefined
      while ((pairsSub.length - cutPairCount) > keepFloor) {
        cutPairCount++
        win = buildActiveWindow(history, turnStart, endAtK, pairsSub, triggeredNudges, activeCheckpoints, {
          ...windowOpts,
          forcedCutPairCount: cutPairCount,
        })
        if (win.totalTokens <= epochTargetTokens) break
      }
      if (windowOpts.pinUneditedRead && windowOpts.keepRecentCount >= 1 && cutPairCount > 0) {
        const candidatePin = findLatestUneditedReadPair(
          pairsSub.slice(0, cutPairCount),
          history,
          pair => windowOpts.bareTok[pair.callIndex]! + windowOpts.bareTok[pair.resultIndex]!,
          windowOpts.cwd,
          pairsSub.slice(cutPairCount),
        )
        if (candidatePin !== undefined) {
          const withPin = buildActiveWindow(history, turnStart, endAtK, pairsSub, triggeredNudges, activeCheckpoints, {
            ...windowOpts,
            forcedCutPairCount: cutPairCount,
            forcedPinnedRead: candidatePin,
          })
          if (withPin.totalTokens <= windowOpts.budgetTokens) frozenPinnedRead = candidatePin
        }
      }
    }
  }
  return buildActiveWindow(history, turnStart, history.length, pairs, triggeredNudges, activeCheckpoints, {
    ...windowOpts,
    forcedCutPairCount: cutPairCount,
    forcedPinnedRead: frozenPinnedRead,
  })
}

export interface InPlaceWindowOptions {
  readonly baseOverhead: number
  readonly budgetTokens: number
  readonly epochTargetTokens: number
  readonly hardCap: number
  readonly keepRecentCount: number
  readonly exemptResultTokens: number
  readonly emptyThink: boolean
  readonly cwd?: string
  readonly fullTok: readonly number[]
  readonly bareTok: readonly number[]
  readonly rawResultTok: readonly number[]
  readonly reminderTokOfResult: (resultItem: Extract<HistoryItem, { kind: 'result' }>) => number
}

/**
 * Module 2 (`auto-fold v2`): causal batch in-place observation masking (`budgetTokens -> epochTargetTokens`)
 * with `< exemptResultTokens` exemption, `keepRecentCount` floor, and git-free Stage Archive at `hardCap`.
 */
export function buildInPlaceFoldWindow(
  history: readonly HistoryItem[],
  turnStart: number,
  pairs: readonly CallPair[],
  opts: InPlaceWindowOptions,
): ActiveWindowResult {
  const targetLow = opts.epochTargetTokens > 0 && opts.epochTargetTokens < opts.budgetTokens
    ? opts.epochTargetTokens
    : opts.budgetTokens
  const keepFloor = Math.max(0, opts.keepRecentCount)

  const maskedByResultIdx = new Map<number, { item: Extract<HistoryItem, { kind: 'result' }>; tok: number }>()
  const pairByResultIdx = new Map<number, CallPair>()
  for (const pair of pairs) pairByResultIdx.set(pair.resultIndex, pair)

  const getMasked = (pair: CallPair): { item: Extract<HistoryItem, { kind: 'result' }>; tok: number } => {
    let entry = maskedByResultIdx.get(pair.resultIndex)
    if (entry !== undefined) return entry
    const callItem = history[pair.callIndex] as Extract<HistoryItem, { kind: 'call' }>
    const resultItem = history[pair.resultIndex] as Extract<HistoryItem, { kind: 'result' }>
    const maskedItem = maskResultInPlace(callItem, resultItem, opts.rawResultTok[pair.resultIndex])
    const tok = countTokens(historyItemPromptBytes(maskedItem, opts.emptyThink)) + opts.reminderTokOfResult(maskedItem)
    entry = { item: maskedItem, tok }
    maskedByResultIdx.set(pair.resultIndex, entry)
    return entry
  }

  let archivedCount = 0
  const maskedCallIndices = new Set<number>()
  const clearedReasoning = new Set<number>()

  const assembleInPlace = (endIndex: number, pairsSub: readonly CallPair[]): { items: HistoryItem[]; tokens: number } => {
    const archivedPairs = archivedCount > 0 ? pairsSub.slice(0, archivedCount) : []
    const archivedIdxSet = new Set<number>()
    for (const ap of archivedPairs) {
      archivedIdxSet.add(ap.callIndex)
      archivedIdxSet.add(ap.resultIndex)
    }
    const archiveText = archivedPairs.length > 0 ? formatStageArchiveNote(archivedPairs, history, opts.cwd) : undefined
    const archiveTok = archiveText !== undefined ? countTokens(`User: ${archiveText}\n\n`) : 0
    const items: HistoryItem[] = []
    let tokens = opts.baseOverhead
    let archiveInserted = false

    for (let idx = turnStart; idx < endIndex; idx++) {
      if (archivedIdxSet.has(idx)) continue
      const raw = history[idx]!
      if (!archiveInserted && archiveText !== undefined && (raw.kind === 'call' || raw.kind === 'assistant')) {
        items.push({ kind: 'note', text: archiveText })
        tokens += archiveTok
        archiveInserted = true
      }
      const pair = raw.kind === 'result' ? pairByResultIdx.get(idx) : undefined
      if (pair !== undefined && maskedCallIndices.has(pair.callIndex)) {
        const m = getMasked(pair)
        items.push(m.item)
        tokens += m.tok
      } else if ((raw.kind === 'call' || raw.kind === 'assistant') && raw.reasoning && clearedReasoning.has(idx)) {
        items.push({ ...raw, reasoning: undefined })
        tokens += opts.bareTok[idx]!
      } else {
        items.push(raw)
        tokens += opts.fullTok[idx]!
      }
    }
    if (!archiveInserted && archiveText !== undefined) {
      items.push({ kind: 'note', text: archiveText })
      tokens += archiveTok
    }
    return { items, tokens }
  }

  for (let k = 0; k < pairs.length; k++) {
    const pairsSub = pairs.slice(0, k + 1)
    const endAtK = k === pairs.length - 1 ? history.length : pairs[k]!.resultIndex + 1
    let cur = assembleInPlace(endAtK, pairsSub)
    if (cur.tokens > opts.budgetTokens) {
      const maskLimit = pairsSub.length - keepFloor
      let changed = false
      for (let pIdx = archivedCount; pIdx < maskLimit; pIdx++) {
        if (cur.tokens <= targetLow) break
        const pair = pairsSub[pIdx]!
        if (maskedCallIndices.has(pair.callIndex)) continue
        if (opts.rawResultTok[pair.resultIndex]! < opts.exemptResultTokens) continue
        const maskedTok = getMasked(pair).tok
        const saved = opts.fullTok[pair.resultIndex]! - maskedTok
        if (saved <= 0) continue
        maskedCallIndices.add(pair.callIndex)
        cur.tokens -= saved
        changed = true
      }
      if (changed) cur = assembleInPlace(endAtK, pairsSub)
    }
    if (!opts.emptyThink && cur.tokens > opts.hardCap) {
      for (let idx = turnStart; idx < endAtK; idx++) {
        if (cur.tokens <= opts.hardCap) break
        const item = history[idx]!
        if ((item.kind === 'call' || item.kind === 'assistant') && item.reasoning && !clearedReasoning.has(idx)) {
          clearedReasoning.add(idx)
          cur = assembleInPlace(endAtK, pairsSub)
        }
      }
    }
    while (cur.tokens > opts.hardCap && (pairsSub.length - archivedCount) > 1) {
      const droppedPair = pairsSub[archivedCount]!
      archivedCount++
      maskedCallIndices.delete(droppedPair.callIndex)
      cur = assembleInPlace(endAtK, pairsSub)
    }
  }

  const finalBuilt = assembleInPlace(history.length, pairs)
  const duplicateFrom = archivedCount > 0 ? pairs[archivedCount - 1]!.resultIndex + 1 : turnStart
  const maskedCallIds = new Set<string>()
  for (const callIdx of maskedCallIndices) {
    const callItem = history[callIdx]
    if (callItem?.kind === 'call') maskedCallIds.add(callItem.id)
  }

  return {
    items: finalBuilt.items,
    duplicateFrom,
    totalTokens: finalBuilt.tokens,
    ...(maskedCallIds.size > 0 ? { maskedCallIds } : {}),
  }
}
