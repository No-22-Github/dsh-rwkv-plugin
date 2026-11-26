// Path repair for file tool calls. G1 copies the long absolute working
// directory from the runtime context and often drops its last component
// (".../task/ws/a.py" written as ".../task/a.py"). A path is rewritten only
// when it does not exist and the repaired path does, so a correct path, a new
// file, or a deliberate path outside the workspace is passed through as is.

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const GHOST_WORKSPACE_ROOTS = [
  '/home/user/project',
  '/home/user',
  '/workspace',
  '/home/agent',
  '/app',
] as const

const SPILL_SUFFIX_PATTERN = /\/(dsh-spill-[^/]+(?:\/.*)?)$/i

/**
 * macOS spill-path self-healing: models trained in Linux containers often
 * rewrite `/var/folders/.../T/dsh-spill-...` as `/tmp/dsh-spill-...` (or
 * mangle the random macOS tmpdir prefix). Remap to the real OS tmpdir only
 * when the original path does not exist and the remapped spill path does.
 */
function repairSpillPath(path: string, tempDir: string): string | undefined {
  if (!isAbsolute(path) || existsSync(path)) return undefined
  const match = SPILL_SUFFIX_PATTERN.exec(path)
  if (!match) return undefined
  const suffix = match[1]!
  const normalized = suffix.replace(/^dsh-spill-/i, 'dsh-spill-')
  const candidates = normalized === suffix
    ? [join(tempDir, normalized)]
    : [join(tempDir, normalized), join(tempDir, suffix)]
  return candidates.find(candidate => existsSync(candidate))
}

function repairPath(path: string, cwd: string): string {
  if (!isAbsolute(path) || existsSync(path)) return path
  const parent = dirname(cwd)
  const candidates: string[] = []
  if (path.startsWith(`${parent}/`) && !path.startsWith(`${cwd}/`)) candidates.push(join(cwd, path.slice(parent.length + 1)))
  for (const root of GHOST_WORKSPACE_ROOTS) {
    if (path === root) {
      candidates.push(cwd)
    } else if (path.startsWith(`${root}/`) && cwd !== root && !cwd.startsWith(`${root}/`)) {
      candidates.push(join(cwd, path.slice(root.length + 1)))
    }
  }
  candidates.push(join(cwd, basename(path)))
  return candidates.find(candidate => existsSync(candidate)) ?? path
}

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'edit_lines', 'glob', 'grep'])

/** DSH-side arguments with file_path / path repaired; the same object when nothing changed. */
export function repairToolPaths(
  dshName: string,
  args: Record<string, unknown>,
  cwd: string | undefined,
  tempDir: string = tmpdir(),
): Record<string, unknown> {
  if (!FILE_TOOLS.has(dshName)) return args
  const hasCwd = cwd !== undefined && existsSync(cwd)
  let out: Record<string, unknown> | undefined
  for (const key of ['file_path', 'path']) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const repaired = repairSpillPath(value, tempDir) ?? (hasCwd ? repairPath(value, cwd) : value)
    if (repaired !== value) {
      out ??= { ...args }
      out[key] = repaired
    }
  }
  return out ?? args
}
