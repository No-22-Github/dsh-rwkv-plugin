// Pure specification for `editMode: 'literal'`.
//
// Exposes DSH's native `edit` tool (`{ file_path, old_string, new_string, replace_all? }`)
// directly without recall-tolerant matching or pre-write syntax interception.
// Used as the stock literal baseline in A/B evaluations.

import type { EditMode } from '../defaults.ts'

export interface EditModeSpec {
  readonly id: EditMode
  /** Tools hidden from the model catalog when this mode is active. */
  readonly excludedTools: readonly string[]
  /** Whether a dedicated line-editing DSH tool plugin (`edit_lines`) must be mounted. */
  readonly mountsEditLinesPlugin: boolean
  /** Optional maximum lines per `read` result (keeps RWKV-7 inside its <=200-line recall cliff). */
  readonly maxReadLines?: number
  /** Whether the `tools/execute` recall-tolerant `edit` wrapper is enabled. */
  readonly usesTolerantHook: boolean
}

export const LITERAL_EDIT_MODE: EditModeSpec = {
  id: 'literal',
  excludedTools: ['edit_lines'],
  mountsEditLinesPlugin: false,
  usesTolerantHook: false,
}
