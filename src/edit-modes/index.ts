// Unified host-side installer for edit-mode hooks (`tolerant` / `literal`).
// Kept free of `@deepseek-ai/*` runtime imports so both `src/index.ts` and
// container teacher overlays can mount it.

import type { EditMode } from '../core/defaults.ts'
import { usesTolerantEditHook } from '../core/edit-modes/index.ts'
import { applyLiteralEditMode } from './literal.ts'
import { applyTolerantEdit } from './tolerant.ts'

export interface EditModeHostHooksOptions {
  readonly providers: () => readonly string[]
  readonly editMode: () => EditMode
  readonly outputRepairs: () => boolean
  readonly guards: () => boolean
}

export function installEditModeHooks(ctx: unknown, options: EditModeHostHooksOptions): void {
  applyLiteralEditMode()
  applyTolerantEdit(ctx, {
    providers: options.providers,
    enabled: () => usesTolerantEditHook(options.editMode()),
    outputRepairs: options.outputRepairs,
    syntaxGuard: options.guards,
    foldedReadGuard: options.guards,
  })
}
