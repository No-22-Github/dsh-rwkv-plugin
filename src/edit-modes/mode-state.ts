// Process-wide reactive `EditMode` store keyed by `Symbol.for(...)` so separate
// esbuild entry bundles (`lib/index.js` and `lib/line-edit.js`) share live mode
// updates when the user toggles `editMode` in Desktop Settings without reload.

import type { EditMode } from '../core/defaults.ts'

interface EditModeBus {
  current: EditMode | undefined
  readonly listeners: Set<(mode: EditMode) => void>
}

const BUS_KEY = Symbol.for('dsh-rwkv-plugin/edit-mode-bus')

function bus(): EditModeBus {
  const host = globalThis as Record<symbol, unknown>
  let existing = host[BUS_KEY] as EditModeBus | undefined
  if (existing === undefined) {
    existing = { current: undefined, listeners: new Set() }
    host[BUS_KEY] = existing
  }
  return existing
}

export function getActiveEditMode(): EditMode | undefined {
  return bus().current
}

export function setActiveEditMode(mode: EditMode): void {
  const state = bus()
  if (state.current === mode) return
  state.current = mode
  for (const listener of [...state.listeners]) {
    listener(mode)
  }
}

export function onActiveEditModeChange(listener: (mode: EditMode) => void): () => void {
  const state = bus()
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}
