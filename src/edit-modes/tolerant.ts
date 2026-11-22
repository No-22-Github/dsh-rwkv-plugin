// Host `tools/execute` wrapper for `editMode: 'tolerant'`.
//
// Combines `src/core/edit-modes/tolerant.ts` (content-anchored recall tolerance +
// auto-reindent + dual-anchor sliding-window guard), `folded-read-guard.ts`, and
// `syntax-check.ts` (pre-write incremental syntax validation) on standard `edit`.

import { resolve } from 'node:path'
import { sandboxPolicyFor } from '../core/edit-modes/shared.ts'
import { resolveTolerantEdit } from '../core/edit-modes/tolerant.ts'
import {
  ensureExecWorkingDir,
  providerOfExec,
  sessionIdOfExec,
  type AgentLike,
  type SandboxPolicyLike,
} from '../dsh-host.ts'
import { foldedUnreadErrorMessage, isFoldedUnreadPath } from './folded-read-guard.ts'
import { introducedSyntaxError } from './syntax-check.ts'

interface FsTargetLike { readonly displayPath: string }
interface FsLike {
  resolve(path: string, options: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>
  editText(
    target: FsTargetLike,
    edit: { oldString: string; newString: string; replaceAll: boolean },
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<{ version: unknown; before: string; after: string }>
  processPath(target: FsTargetLike): string
}

interface ExecLike {
  readonly name: string
  readonly arguments: unknown
  readonly parent?: unknown
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

interface ToolResultLike {
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly isError: boolean
  readonly value?: unknown
  readonly error?: { readonly message: string }
}

export interface TolerantEditOptions {
  readonly providers: () => readonly string[]
  readonly enabled: () => boolean
  readonly outputRepairs: () => boolean
  readonly syntaxGuard: () => boolean
  readonly foldedReadGuard?: () => boolean
}

function errorResult(message: string): ToolResultLike {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message },
  }
}

function previewSingleEdit(before: string, oldString: string, newString: string): string | undefined {
  if (oldString === '') return undefined
  const at = before.indexOf(oldString)
  if (at < 0 || before.indexOf(oldString, at + 1) >= 0) return undefined
  return before.slice(0, at) + newString + before.slice(at + oldString.length)
}

export function applyTolerantEdit(ctx: unknown, options: TolerantEditOptions): void {
  const host = ctx as {
    on(event: 'tools/execute', listener: (exec: ExecLike, next: () => Promise<ToolResultLike>) => Promise<ToolResultLike>): unknown
    waterfall?(event: 'fs/edit-intent', target: FsTargetLike, exec: ExecLike, fallback: () => undefined): Promise<unknown>
    emit(event: 'fs/observed', target: FsTargetLike, observation: { kind: 'present'; version: unknown }, actor: ExecLike): void
    get(name: string): unknown
  }

  host.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'edit' || exec.parent !== undefined || !options.enabled()) return next()
    const provider = providerOfExec(exec)
    if (provider === undefined || !options.providers().includes(provider)) return next()
    const fs = host.get('fs') as FsLike | undefined
    if (fs === undefined || typeof exec.arguments !== 'object' || exec.arguments === null) return next()

    const args = exec.arguments as {
      file_path?: unknown
      old_string?: unknown
      new_string?: unknown
      replace_all?: unknown
    }
    if (typeof args.file_path !== 'string' || args.file_path.trim() === '') return next()

    const cwd = await ensureExecWorkingDir(host, exec)
    const resolveOpts = { ...cwd !== undefined ? { cwd } : {}, ...exec.signal ? { signal: exec.signal } : {} }

    let target: FsTargetLike
    let before: string
    try {
      target = await fs.resolve(args.file_path, resolveOpts)
      if ((options.foldedReadGuard?.() ?? true) && isFoldedUnreadPath(sessionIdOfExec(exec), [
        fs.processPath(target),
        target.displayPath,
        ...(cwd !== undefined ? [resolve(cwd, args.file_path.trim())] : []),
      ])) {
        return errorResult(foldedUnreadErrorMessage(target.displayPath, 'edit'))
      }
      if (
        typeof args.old_string !== 'string' || args.old_string === '' ||
        typeof args.new_string !== 'string' ||
        args.old_string === args.new_string ||
        args.replace_all === true
      ) {
        return next()
      }
      before = await fs.readText(target, exec.signal)
    } catch {
      return next()
    }

    const resolved = options.outputRepairs()
      ? resolveTolerantEdit(before, args.old_string, args.new_string, target.displayPath)
      : { kind: 'exact' as const }

    if (resolved.kind === 'refused') return errorResult(resolved.message)

    const effectiveOld = resolved.kind === 'repaired' ? resolved.oldString : args.old_string
    const effectiveNew = resolved.kind === 'repaired' ? resolved.newString : args.new_string

    if (options.syntaxGuard()) {
      const afterPreview = previewSingleEdit(before, effectiveOld, effectiveNew)
      if (afterPreview !== undefined) {
        const broken = await introducedSyntaxError(before, afterPreview, target.displayPath)
        if (broken !== undefined) {
          return errorResult(
            `Your edit to ${target.displayPath} was NOT applied: it introduces a syntax error (${broken}). `
            + 'Fix new_string (check parentheses, braces, quotes, and indentation) and try again.',
          )
        }
      }
    }

    if (resolved.kind === 'exact') return next()

    try {
      const intent = host.waterfall
        ? await host.waterfall('fs/edit-intent', target, exec, () => undefined)
        : undefined
      const policy = sandboxPolicyFor(host.get('sandboxPolicy') as SandboxPolicyLike | undefined, exec.agent?.session)
      const outcome = await fs.editText(
        target,
        { oldString: effectiveOld, newString: effectiveNew, replaceAll: false },
        intent,
        exec.signal,
        policy,
      )
      const canonicalPath = fs.processPath(target)
      host.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        content: [{ type: 'text', text: `The file ${canonicalPath} has been updated successfully.\n${resolved.note}` }],
        isError: false,
        value: { path: canonicalPath, before: outcome.before, after: outcome.after },
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return errorResult(msg)
    }
  })
}
