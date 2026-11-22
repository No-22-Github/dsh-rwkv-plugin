// Re-export shim: pure `hashline` engine now lives in `src/core/edit-modes/hashline.ts`.
export {
  applyHashEdit,
  formatHashReadResult,
  HASHLINE_CONTEXT_LINES,
  HASHLINE_EDIT_MODE,
  hashEditSummary,
  hashSyntaxRejection,
  lineHash,
  parseLineRef,
  renderHashWindow,
  stripHashPrefixes,
  type HashEdit,
  type HashEditApplied,
  type HashEditOp,
} from './edit-modes/hashline.ts'
