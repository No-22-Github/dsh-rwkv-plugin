// Re-export shim: pure `line-edit` engine and shared coordinate helpers now
// live in `src/core/edit-modes/line-edit.ts` and `src/core/edit-modes/shared.ts`.
export {
  applyLineEdit,
  editSummary,
  LINE_EDIT_CONTEXT_LINES,
  LINE_EDIT_MODE,
  syntaxRejection,
} from './edit-modes/line-edit.ts'
export {
  addSeen,
  formatRanges,
  renderWindow,
  sandboxPolicyFor,
  seenAfterEdit,
  unseenLines,
  unseenRejection,
  type LineEdit,
  type LineEditResult,
  type SeenLines,
} from './edit-modes/shared.ts'
