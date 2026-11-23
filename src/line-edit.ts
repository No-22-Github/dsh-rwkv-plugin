// DSH plugin entry `dsh-rwkv-plugin/line-edit`: mounts the Anchored Batch
// `edit_lines` tool (`src/edit-modes/line-edit.ts`).

import type { Context } from '@deepseek-ai/cordis'
import { applyLineEditPlugin } from './edit-modes/line-edit.ts'
import { EDIT_LINES_TOOL } from './edit-modes/observations.ts'

export { EDIT_LINES_TOOL }

export const name = 'rwkv-edit-lines'
export const inject = ['tools', 'fs']

export function apply(ctx: Context): void {
  applyLineEditPlugin(ctx)
}
