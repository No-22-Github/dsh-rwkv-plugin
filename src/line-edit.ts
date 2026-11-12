// DSH plugin `rwkv-edit-lines`: the `edit_lines` tool, a line-range edit for
// RWKV (see src/core/line-edit.ts for why). Mounted only where RWKV should get
// it (headless --line-edit, the teacher profile); when DSH offers edit_lines,
// the RWKV catalog drops the literal `edit` (core/tools.ts buildCatalog).
//
// An ordinary DSH file tool: paths resolve in the session's working directory
// through ctx.fs and the write is atomic. Line numbers are only meaningful for
// the file as the model last saw it, so the write is guarded by that version:
// read, write and edit report what a session saw (`fs/observed`, emitted by
// DSH's file tools whether or not DSH's own fs-observation-policy is on, which
// the stock bundle leaves off) and this plugin keeps the last one per session
// and file. edit_lines reports its own result too, so a further edit_lines
// without re-reading is allowed (its result shows the new numbering). A
// change made any other way (bash, another process) makes the next edit_lines
// fail until the file is read again; a file never read is refused. Within a
// version it also keeps which lines the model was shown (read reports its
// window after the RWKV result budget cut it, src/result-budget.ts, through
// READ_SHOWN_EVENT): an edit touching lines never shown is refused with the
// offset to read; without that report (no budget mounted) a read counts as
// showing the whole file. As in
// SWE-agent, an edit that breaks a file that parsed before (src/syntax-check.ts)
// is not written: the result shows it next to the original lines.

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  addSeen, applyLineEdit, editSummary, seenAfterEdit, syntaxRejection, unseenLines, unseenRejection, type SeenLines,
} from './core/line-edit.ts'
import { READ_SHOWN_EVENT } from './result-budget.ts'
import { introducedSyntaxError } from './syntax-check.ts'

export const name = 'rwkv-edit-lines'
export const inject = ['tools', 'fs']

export const EDIT_LINES_TOOL = 'edit_lines'

interface EditLinesArgs {
  file_path: string
  start_line: number
  end_line: number
  new_text: string
}

// The DSH services as this tool uses them (types from @deepseek-ai/dsh-fs,
// dsh-tools; kept structural so the plugin does not import those packages).
interface FsTargetLike { readonly displayPath: string; readonly targetKey: string }
type Observation = { readonly kind: 'present'; readonly version: unknown } | { readonly kind: 'absent' }
interface FsLike {
  resolve(path: string, options: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>
  writeText(target: FsTargetLike, content: string, expected?: unknown, signal?: AbortSignal): Promise<{ version: unknown }>
  processPath(target: FsTargetLike): string
}
interface ExecLike {
  readonly name?: string
  readonly agent?: { readonly session?: object }
  readonly signal?: AbortSignal
}
interface ContextLike {
  readonly fs: FsLike
  readonly tools: { register(definition: unknown): () => void }
  on(event: 'fs/observed', listener: (target: FsTargetLike, observation: Observation, actor: ExecLike | undefined) => void): () => void
  on(event: typeof READ_SHOWN_EVENT, listener: (exec: ExecLike, window: { first: number; last: number }) => void): () => void
  emit(event: 'fs/observed', target: FsTargetLike, observation: Observation, actor: ExecLike): void
  get(name: string): unknown
}

interface Seen {
  readonly observation: Observation
  /** Lines of this version shown to the model. */
  lines: SeenLines
}

const sameVersion = (a: Observation | undefined, b: Observation): boolean =>
  a?.kind === 'present' && b.kind === 'present' && JSON.stringify(a.version) === JSON.stringify(b.version)

/** Last version each session saw of each file, and its lines shown (DSH fs-observation-policy's gate, for this tool only). */
class Observations {
  private readonly bySession = new WeakMap<object, Map<string, Seen>>()
  /** The file each read observed, until its window is reported. */
  private readonly readTargets = new WeakMap<object, { session: object; targetKey: string; before: SeenLines }>()

  record(actor: ExecLike | undefined, target: FsTargetLike, observation: Observation): void {
    const session = actor?.agent?.session
    if (session === undefined) return
    let byTarget = this.bySession.get(session)
    if (byTarget === undefined) this.bySession.set(session, byTarget = new Map())
    const previous = byTarget.get(target.targetKey)
    // Until read reports its window, a read shows the whole file (no budget mounted: no report).
    byTarget.set(target.targetKey, { observation, lines: 'all' })
    if (actor !== undefined && actor.name === 'read') {
      const before: SeenLines = previous !== undefined && sameVersion(previous.observation, observation) ? previous.lines : new Set()
      this.readTargets.set(actor, { session, targetKey: target.targetKey, before })
    }
  }

  /** read's window as the model got it: the version's lines seen so far plus these. */
  shown(exec: ExecLike, first: number, last: number): void {
    const read = this.readTargets.get(exec)
    if (read === undefined) return
    this.readTargets.delete(exec)
    const seen = this.bySession.get(read.session)?.get(read.targetKey)
    if (seen !== undefined) seen.lines = addSeen(read.before, first, last)
  }

  /** After this tool's own write (recorded through fs/observed first). */
  setLines(actor: ExecLike, target: FsTargetLike, lines: SeenLines): void {
    const seen = actor.agent?.session === undefined ? undefined : this.bySession.get(actor.agent.session)?.get(target.targetKey)
    if (seen !== undefined) seen.lines = lines
  }

  /** The guard for a write and the lines seen, or the model-facing reason to refuse. */
  guard(actor: ExecLike, target: FsTargetLike): { kind: 'replaceIfVersion'; version: unknown; lines: SeenLines } | string {
    const session = actor.agent?.session
    // Outside an agent session (tests, tooling) there is nothing to check against.
    if (session === undefined) return { kind: 'replaceIfVersion', version: undefined, lines: 'all' }
    const seen = this.bySession.get(session)?.get(target.targetKey)
    if (seen === undefined) return `cannot modify "${target.displayPath}": file has not been read — read the file, then retry`
    if (seen.observation.kind === 'absent') return `cannot edit "${target.displayPath}": not found — use write to create it`
    return { kind: 'replaceIfVersion', version: seen.observation.version, lines: seen.lines }
  }
}

function remediate(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code !== 'FS_STALE_VERSION') return error
  return new Error(`${(error as Error).message} — its line numbers may have moved; re-read the file, then retry`, { cause: error })
}

export function apply(ctx: Context): void {
  const host = ctx as unknown as ContextLike
  const observations = new Observations()
  host.on('fs/observed', (target, observation, actor) => observations.record(actor, target, observation))
  host.on(READ_SHOWN_EVENT, (exec, window) => observations.shown(exec, window.first, window.last))

  async function resolveOptions(exec: ExecLike): Promise<{ cwd?: string; signal?: AbortSignal }> {
    const workingDirectory = host.get('workingDirectory') as { ensure(agent: unknown, signal?: AbortSignal): Promise<string> } | undefined
    const cwd = exec.agent === undefined || workingDirectory === undefined ? undefined : await workingDirectory.ensure(exec.agent, exec.signal)
    return { ...cwd !== undefined ? { cwd } : {}, ...exec.signal ? { signal: exec.signal } : {} }
  }

  host.tools.register(defineTool({
    name: EDIT_LINES_TOOL,
    description: 'Edit an existing UTF-8 text file by replacing a range of lines, numbered as read shows them.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend. Read the file first.' },
      start_line: { type: 'number', required: true, description: 'First line to replace (1-based, as numbered by read).' },
      end_line: { type: 'number', required: true, description: 'Last line to replace. start_line - 1 inserts before start_line without replacing.' },
      new_text: { type: 'string', required: true, description: 'Lines that replace start_line..end_line, without line numbers. Empty deletes them.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { summary: string }) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: EditLinesArgs, exec: ExecLike) {
      if (args.file_path.trim() === '') throw new Error('file_path must be a non-empty string')
      const target = await host.fs.resolve(args.file_path, await resolveOptions(exec))
      const guard = observations.guard(exec, target)
      if (typeof guard === 'string') throw new Error(guard)
      try {
        const text = await host.fs.readText(target, exec.signal)
        const edit = { startLine: args.start_line, endLine: args.end_line, newText: args.new_text }
        const edited = applyLineEdit(text, target.displayPath, edit)
        if (typeof edited === 'string') throw new Error(edited)
        const missing = unseenLines(guard.lines, edit, edited.before.length)
        if (missing.length > 0 && guard.lines !== 'all') {
          throw new Error(unseenRejection(target.displayPath, missing, guard.lines, edited.before.length))
        }
        const broken = await introducedSyntaxError(text, edited.content, target.displayPath)
        if (broken !== undefined) throw new Error(syntaxRejection(target.displayPath, edit, edited, broken))
        // Guarded by the version the model saw, not the text just read: a file
        // changed since then fails here instead of being edited by stale numbers.
        const expected = guard.version === undefined ? undefined : { kind: guard.kind, version: guard.version }
        const outcome = await host.fs.writeText(target, edited.content, expected, exec.signal)
        host.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        observations.setLines(exec, target, seenAfterEdit(guard.lines, edit, edited))
        return { path: host.fs.processPath(target), summary: editSummary(target.displayPath, edit, edited) }
      } catch (error: unknown) {
        throw remediate(error)
      }
    },
  } as never))
}
