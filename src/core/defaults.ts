// Shared scalar and sampling defaults across the host plugin, headless CLI,
// pipeline teacher overlay, and browser settings UI. Kept free of Node and
// WASM imports so browser bundles can import directly without side effects.

export interface SamplingDefaults {
  readonly temperature: number
  readonly topK: number
  readonly topP: number
  readonly presencePenalty: number
  readonly frequencyPenalty: number
  readonly penaltyDecay: number
}

export const AGENT_FAST_SAMPLING: SamplingDefaults = {
  temperature: 0.5,
  topK: 65536,
  topP: 0.7,
  presencePenalty: 0.5,
  frequencyPenalty: 0.2,
  penaltyDecay: 0.996,
}

export type EditMode = 'tolerant' | 'line-edit' | 'hashline' | 'literal'
export type HistoryMode = 'auto-fold' | 'full' | 'relay' | 'worklist'

export const DEFAULT_EDIT_MODE: EditMode = 'tolerant'
export const DEFAULT_HISTORY_MODE: HistoryMode = 'auto-fold'

export const DEFAULT_MAX_STEPS = 15
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2
export const DEFAULT_PROTOCOL_RETRIES = 2
export const DEFAULT_DECISION_MAX_TOKENS = 4096
export const DEFAULT_ANSWER_MAX_TOKENS = 4096

export const DEFAULT_RELAY_BUDGET_TOKENS = 8000
export const DEFAULT_RELAY_CARD_MAX_TOKENS = 768

export const DEFAULT_WORKLIST_MIN_FOLD_TOKENS = 8000
export const DEFAULT_ACTIVE_WORKLIST_BUDGET_TOKENS = 12000
export const DEFAULT_WORKLIST_BUDGET_TOKENS = 13500
export const DEFAULT_WORKLIST_EPOCH_TARGET_TOKENS = 9000
export const DEFAULT_WORKLIST_EXEMPT_RESULT_TOKENS = 250
export const DEFAULT_WORKLIST_HARD_SLACK_TOKENS = 3000
export const DEFAULT_AUTOFOLD_HARD_SLACK_TOKENS = 1000
export const DEFAULT_AUTOFOLD_HARD_CAP_TOKENS = 14500
export const DEFAULT_BACKBONE_MAX_TOKENS = 5000
export const DEFAULT_AUTOFOLD_BACKBONE_MAX_TOKENS = 2000
export const DEFAULT_KEEP_RECENT_PAIRS = 2
export const DEFAULT_AUTOFOLD_KEEP_RECENT_PAIRS = 3

export const FOLDED_OUTPUT_MARKER = '[Old '
