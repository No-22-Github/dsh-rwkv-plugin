// Pure specification for `editMode: 'literal'`.
//
// Exposes DSH's native `edit` tool (`{ file_path, old_string, new_string, replace_all? }`)
// directly without recall-tolerant matching, line-hash formatting, or pre-write
// syntax interception. Used as the stock literal baseline in A/B evaluations.

import type { EditMode } from '../defaults.ts'

export interface EditModeSpec {
  readonly id: EditMode
  /** Tools hidden from the model catalog when this mode is active. */
  readonly excludedTools: readonly string[]
  /** Whether a dedicated line-editing DSH tool plugin (`edit_lines`) must be mounted. */
  readonly mountsEditLinesPlugin: boolean
  /** Whether `read` results should be decorated with `N:hh| ` 2-hex content hashes. */
  readonly formatsHashRead: boolean
  /** Whether the `tools/execute` recall-tolerant `edit` wrapper is enabled. */
  readonly usesTolerantHook: boolean
}

export const LITERAL_EDIT_MODE: EditModeSpec = {
  id: 'literal',
  excludedTools: ['edit_lines'],
  mountsEditLinesPlugin: false,
  formatsHashRead: false,
  usesTolerantHook: false,
}
