// Host handler for `editMode: 'literal'`.
//
// In `literal` mode, `edit_lines` is excluded from the model catalog and the
// `tolerant` hook is inactive, so calls to `edit` delegate straight to DSH's
// built-in `@deepseek-ai/dsh-tool-fs` literal replacement implementation.

export function applyLiteralEditMode(): void {
  // Intentional pass-through to stock `@deepseek-ai/dsh-tool-fs` `edit`.
}
