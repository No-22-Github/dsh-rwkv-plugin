// Re-export shim: pure `line-edit` engine and shared coordinate helpers live
// in `src/core/edit-modes/line-edit.ts` and `src/core/edit-modes/shared.ts`.
export {
  applyAnchoredLineEdits,
  applyLineEdit,
  batchEditSummary,
  batchSyntaxRejection,
  editSummary,
  isNonTrivialAnchor,
  LINE_EDIT_CONTEXT_LINES,
  LINE_EDIT_MODE,
  MAX_LINE_EDIT_READ_LINES,
  normalizeLineEditArgs,
  parseLineEditHunks,
  syntaxRejection,
  type ApplyLineEditsOptions,
  type BatchLineEditResult,
  type RawLineEditHunk,
  type ResolvedLineEdit,
} from './edit-modes/line-edit.ts'
export {
  addSeen,
  formatRanges,
  renderWindow,
  sandboxPolicyFor,
  seenAfterBatchEdit,
  seenAfterEdit,
  unseenLines,
  unseenRejection,
  type LineEdit,
  type LineEditResult,
  type SeenLines,
} from './edit-modes/shared.ts'
