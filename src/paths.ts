// Path repair for file tool calls. G1 copies the long absolute working
// directory from the runtime context and often drops its last component
// (".../task/ws/a.py" written as ".../task/a.py"). A path is rewritten only
// when it does not exist and the repaired path does, so a correct path, a new
// file, or a deliberate path outside the workspace is passed through as is.

import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { HistoryItem } from './core/policy.ts'

const CWD_PATTERN = /Current working directory: "([^"]+)"/

/** The working directory DSH last announced in its runtime-context message. */
export function runtimeCwd(history: readonly HistoryItem[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index]!
    if (item.kind !== 'user' && item.kind !== 'note') continue
    const match = CWD_PATTERN.exec(item.text)
    if (match) return match[1]
  }
  return undefined
}

function repairPath(path: string, cwd: string): string {
  if (!isAbsolute(path) || existsSync(path)) return path
  const parent = dirname(cwd)
  const candidates: string[] = []
  if (path.startsWith(`${parent}/`) && !path.startsWith(`${cwd}/`)) candidates.push(join(cwd, path.slice(parent.length + 1)))
  candidates.push(join(cwd, basename(path)))
  return candidates.find(candidate => existsSync(candidate)) ?? path
}

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep'])

/** DSH-side arguments with file_path / path repaired; the same object when nothing changed. */
export function repairToolPaths(dshName: string, args: Record<string, unknown>, cwd: string | undefined): Record<string, unknown> {
  if (cwd === undefined || !FILE_TOOLS.has(dshName) || !existsSync(cwd)) return args
  let out: Record<string, unknown> | undefined
  for (const key of ['file_path', 'path']) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const repaired = repairPath(value, cwd)
    if (repaired !== value) {
      out ??= { ...args }
      out[key] = repaired
    }
  }
  return out ?? args
}
