// DSH plugin entry `dsh-rwkv-plugin/line-edit`: mounts `edit_lines` and
// dynamically switches between coordinate-based (`src/edit-modes/line-edit.ts`)
// and hash-anchored (`src/edit-modes/hashline.ts`) implementations when the
// live `editMode` setting changes in Desktop Settings.

import type { Context } from '@deepseek-ai/cordis'
import { createHashlineToolDefinition } from './edit-modes/hashline.ts'
import { createLineEditToolDefinition } from './edit-modes/line-edit.ts'
import { getActiveEditMode, onActiveEditModeChange } from './edit-modes/mode-state.ts'
import { attachObservations, EDIT_LINES_TOOL, type LineEditHostContext } from './edit-modes/observations.ts'

export { EDIT_LINES_TOOL }

export const name = 'rwkv-edit-lines'
export const inject = ['tools', 'fs']

export interface LineEditConfig {
  readonly hashline?: boolean
}

export function apply(ctx: Context, config?: LineEditConfig): void {
  const host = ctx as unknown as LineEditHostContext
  const observations = attachObservations(host)
  const pinnedHashline = config?.hashline === true || process.env.RWKV_HASHLINE === '1'

  let currentHashline: boolean | undefined
  let disposeTool: (() => void) | undefined

  const syncRegistration = (wantHashline: boolean) => {
    if (currentHashline === wantHashline && disposeTool !== undefined) return
    disposeTool?.()
    currentHashline = wantHashline
    const definition = wantHashline
      ? createHashlineToolDefinition(host, observations)
      : createLineEditToolDefinition(host, observations)
    disposeTool = host.tools.register(definition)
  }

  syncRegistration(pinnedHashline || getActiveEditMode() === 'hashline')

  if (!pinnedHashline) {
    const unsubscribe = onActiveEditModeChange(mode => {
      syncRegistration(mode === 'hashline')
    })
    if (typeof host.effect === 'function') {
      host.effect(() => () => {
        unsubscribe()
        disposeTool?.()
        disposeTool = undefined
      })
    }
  }
}
