// Shared session context assembly used by both the student adapter (`src/adapter.ts`)
// and the teacher distillation overlay (`rwkv-agent-pipeline/plugins/teacher.ts`),
// guaranteeing identical tool exclusion rules, history-mode options, and prompt
// overhead accounting across student and teacher runs.
//
// Zero `@deepseek-ai/*` runtime imports so container collection can load it
// directly from `/opt/dsh-rwkv-plugin/src`.

import {
  DEFAULT_RELAY_BUDGET_TOKENS,
  DEFAULT_RELAY_CARD_MAX_TOKENS,
  DEFAULT_WORKLIST_BUDGET_TOKENS,
  DEFAULT_WORKLIST_MIN_FOLD_TOKENS,
  type EditMode,
  type HistoryMode,
} from './core/defaults.ts'
import { POST_TOOL_REMINDER_THINK } from './core/policy.ts'
import { systemPrompt, WORKLIST_SYSTEM_GUIDANCE } from './core/prompt.ts'
import type { RelayOptions } from './core/relay.ts'
import { TODO_PLAN_TOOL, TODO_UPDATE_TOOL } from './core/todo-state.ts'
import type { WireTool } from './core/tools.ts'
import type { WorklistOptions } from './core/worklist.ts'
import { countTokens } from './tokenizer.ts'

export interface HistoryModeConfigInput {
  readonly historyMode?: HistoryMode
  readonly relayBudgetTokens?: number
  readonly relayCardMaxTokens?: number
  readonly worklistMinFoldTokens?: number
  readonly worklistBudgetTokens?: number
  readonly worklistKeepRecentPairs?: number
  readonly worklistKeepInitialPlan?: boolean
  readonly worklistSystemGuidance?: boolean
  readonly worklistEpochTargetTokens?: number
  readonly worklistPinUneditedRead?: boolean
}

export function resolveHistoryModeConfig(input: HistoryModeConfigInput): {
  readonly relay?: RelayOptions
  readonly worklist?: WorklistOptions
} {
  if (input.historyMode === 'relay') {
    return {
      relay: {
        budgetTokens: input.relayBudgetTokens ?? DEFAULT_RELAY_BUDGET_TOKENS,
        cardMaxTokens: input.relayCardMaxTokens ?? DEFAULT_RELAY_CARD_MAX_TOKENS,
      },
    }
  }
  if (input.historyMode === 'auto-fold' || input.historyMode === 'worklist') {
    const passive = input.historyMode === 'auto-fold'
    return {
      worklist: {
        ...(passive ? { passive: true, systemGuidance: false } : {}),
        ...(!passive && input.worklistSystemGuidance !== undefined ? { systemGuidance: input.worklistSystemGuidance } : {}),
        minFoldTokens: input.worklistMinFoldTokens ?? DEFAULT_WORKLIST_MIN_FOLD_TOKENS,
        budgetTokens: input.worklistBudgetTokens ?? DEFAULT_WORKLIST_BUDGET_TOKENS,
        ...(input.worklistKeepRecentPairs === undefined ? {} : { keepRecentPairs: input.worklistKeepRecentPairs }),
        ...(!passive && input.worklistKeepInitialPlan !== undefined ? { keepInitialPlan: input.worklistKeepInitialPlan } : {}),
        ...(input.worklistEpochTargetTokens !== undefined && input.worklistEpochTargetTokens > 0
          ? { epochTargetTokens: input.worklistEpochTargetTokens }
          : {}),
        ...(input.worklistPinUneditedRead ? { pinUneditedRead: true } : {}),
      },
    }
  }
  return {}
}

export function buildExcludedTools(options: {
  readonly excludeTools?: readonly string[]
  readonly editMode?: EditMode
  readonly worklist?: WorklistOptions
}): string[] {
  return [
    ...(options.excludeTools ?? []),
    ...(options.editMode !== undefined && options.editMode !== 'line-edit' ? ['edit_lines'] : []),
    ...(options.worklist === undefined || options.worklist.passive === true ? [TODO_PLAN_TOOL, TODO_UPDATE_TOOL] : []),
  ]
}

const TRAILING_DATE_LINE_RE = /\n(?:Current date: \d{4}-\d{2}-\d{2} \(.+\)\.)$/

/**
 * Build the teacher-facing system string and exact RWKV token overhead for
 * `worklist` / `auto-fold` mode so teacher folding cuts at the exact same
 * step boundaries the student plugin sees.
 */
export function prepareTeacherWorklistPrompts(options: {
  readonly catalog: readonly WireTool[]
  readonly filteredHead: string
  readonly dateLine?: string
  readonly guidance?: string
  readonly worklist: WorklistOptions
}): {
  readonly teacherSystem: string
  readonly rwkvSystemTokens: number
  readonly reminderTokens: number
} {
  const cleanHead = options.filteredHead.replace(TRAILING_DATE_LINE_RE, '')
  const useGuidance = options.worklist.passive !== true && options.worklist.systemGuidance !== false
  const worklistHead = useGuidance
    ? `${cleanHead}\n\n${WORKLIST_SYSTEM_GUIDANCE}${options.dateLine ? `\n\n${options.dateLine}` : ''}`
    : `${cleanHead}${options.dateLine ? `\n\n${options.dateLine}` : ''}`
  const teacherSystem = options.guidance ? `${worklistHead}\n\n${options.guidance}` : worklistHead
  const rwkvSystem = systemPrompt(options.catalog, 'full', undefined, cleanHead, options.dateLine, { worklistGuidance: useGuidance })
  return {
    teacherSystem,
    rwkvSystemTokens: countTokens(rwkvSystem),
    reminderTokens: countTokens(POST_TOOL_REMINDER_THINK),
  }
}
