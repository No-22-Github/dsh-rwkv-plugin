// Dedicated DSH plugin entry `dsh-rwkv-plugin/hashline`: mounts the hash-anchored
// `edit_lines` tool (`src/edit-modes/hashline.ts`) directly for CLI, headless,
// teacher distillation, and eval profiles using `--edit-mode hashline`.

import type { Context } from '@deepseek-ai/cordis'
import { applyHashlinePlugin } from './edit-modes/hashline.ts'
import { EDIT_LINES_TOOL } from './edit-modes/observations.ts'

export { EDIT_LINES_TOOL }

export const name = 'rwkv-hashline'
export const inject = ['tools', 'fs']

export function apply(ctx: Context): void {
  applyHashlinePlugin(ctx)
}
