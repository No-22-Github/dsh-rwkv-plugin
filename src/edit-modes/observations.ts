// Shared session file-version and visible-line observation store used by the
// `line-edit` DSH tool plugin. Persists per-file versions and
// seen line numbers in session plugin records (`plugin:rwkv-edit-lines/observed`)
// so process-per-turn evaluators keep read state across resumed turns, while
// enforcing `folded-read-guard` when earlier `read` outputs were folded out.

import { resolve } from 'node:path'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { addSeen, type SeenLines } from '../core/edit-modes/shared.ts'
import { ensureExecWorkingDir, sessionIdOfExec, type AgentLike } from '../dsh-host.ts'
import { READ_SHOWN_EVENT } from '../result-budget.ts'
import { foldedUnreadErrorMessage, isFoldedUnreadPath } from './folded-read-guard.ts'

export const EDIT_LINES_TOOL = 'edit_lines'

export interface FsTargetLike {
  readonly displayPath: string
  readonly targetKey: string
}

export type Observation =
  | { readonly kind: 'present'; readonly version: unknown }
  | { readonly kind: 'absent' }

export interface FsLike {
  resolve(path: string, options: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>
  writeText(
    target: FsTargetLike,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<{ version: unknown }>
  processPath(target: FsTargetLike): string
}

export interface LineEditExecLike {
  readonly name?: string
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

export interface LineEditHostContext {
  readonly fs: FsLike
  readonly tools: { register(definition: unknown): () => void }
  on(event: 'fs/observed', listener: (target: FsTargetLike, observation: Observation, actor: LineEditExecLike | undefined) => void): () => void
  on(event: typeof READ_SHOWN_EVENT, listener: (exec: LineEditExecLike, window: { first: number; last: number }) => void): () => void
  emit(event: 'fs/observed', target: FsTargetLike, observation: Observation, actor: LineEditExecLike): void
  effect?(fn: () => () => void): void
  get(name: string): unknown
}

interface Seen {
  readonly observation: Observation
  lines: SeenLines
}

const OBSERVED_RECORD = 'plugin:rwkv-edit-lines/observed'

interface PersistedObservation {
  readonly targetKey: string
  readonly observation: Observation
  readonly lines: 'all' | readonly number[]
}

interface DecodedObservation {
  readonly targetKey: string
  readonly observation: Observation
  readonly lines: SeenLines
}

interface SessionLike {
  snapshotEvents?(): readonly unknown[]
}

const appendRecord = appendPluginRecord as unknown as (session: object, type: string, data: unknown) => unknown
const recordOf = pluginRecordOf as unknown as (event: unknown) => { type: string; data: unknown } | undefined

const encodeLines = (lines: SeenLines): 'all' | number[] =>
  lines === 'all' ? 'all' : [...lines].sort((a, b) => a - b)

const decodeLines = (value: unknown): SeenLines | undefined => {
  if (value === 'all') return 'all'
  if (!Array.isArray(value) || !value.every(n => typeof n === 'number' && Number.isSafeInteger(n))) return undefined
  return new Set(value as number[])
}

const decodeObservation = (data: unknown): DecodedObservation | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const { targetKey, observation, lines } = data as Record<string, unknown>
  if (typeof targetKey !== 'string' || targetKey === '') return undefined
  if (typeof observation !== 'object' || observation === null) return undefined
  const kind = (observation as { kind?: unknown }).kind
  if (kind !== 'present' && kind !== 'absent') return undefined
  if (kind === 'present' && (observation as { version?: unknown }).version == null) return undefined
  const decoded = decodeLines(lines)
  if (decoded === undefined) return undefined
  return { targetKey, observation: observation as Observation, lines: decoded }
}

const sameVersion = (a: Observation | undefined, b: Observation): boolean =>
  a?.kind === 'present' && b.kind === 'present' && JSON.stringify(a.version) === JSON.stringify(b.version)

export class Observations {
  private readonly bySession = new WeakMap<object, Map<string, Seen>>()
  private readonly hydrated = new WeakSet<object>()
  private readonly readTargets = new WeakMap<object, { session: object; targetKey: string; before: SeenLines }>()

  private mapFor(session: object): Map<string, Seen> {
    let byTarget = this.bySession.get(session)
    if (byTarget === undefined) this.bySession.set(session, byTarget = new Map())
    return byTarget
  }

  hydrate(session: object): void {
    if (this.hydrated.has(session)) return
    this.hydrated.add(session)
    const events = (session as SessionLike).snapshotEvents?.()
    if (events === undefined) return
    for (const event of events) {
      const record = recordOf(event)
      if (record?.type !== OBSERVED_RECORD) continue
      const entry = decodeObservation(record.data)
      if (entry !== undefined) {
        this.mapFor(session).set(entry.targetKey, { observation: entry.observation, lines: entry.lines })
      }
    }
  }

  private persist(session: object, targetKey: string, seen: Seen): void {
    const data: PersistedObservation = {
      targetKey,
      observation: seen.observation,
      lines: encodeLines(seen.lines),
    }
    try {
      appendRecord(session, OBSERVED_RECORD, data)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('reenter')) return
      setTimeout(() => {
        try { appendRecord(session, OBSERVED_RECORD, data) } catch { /* stays in memory */ }
      }, 0)
    }
  }

  record(actor: LineEditExecLike | undefined, target: FsTargetLike, observation: Observation): void {
    const session = actor?.agent?.session
    if (session === undefined) return
    this.hydrate(session)
    const byTarget = this.mapFor(session)
    const previous = byTarget.get(target.targetKey)
    const seen: Seen = { observation, lines: 'all' }
    byTarget.set(target.targetKey, seen)
    if (actor !== undefined && actor.name === 'read') {
      const before: SeenLines = previous !== undefined && sameVersion(previous.observation, observation) ? previous.lines : new Set()
      this.readTargets.set(actor, { session, targetKey: target.targetKey, before })
    } else if (actor?.name !== EDIT_LINES_TOOL) {
      this.persist(session, target.targetKey, seen)
    }
  }

  shown(exec: LineEditExecLike, first: number, last: number): void {
    const read = this.readTargets.get(exec)
    if (read === undefined) return
    this.readTargets.delete(exec)
    const seen = this.bySession.get(read.session)?.get(read.targetKey)
    if (seen === undefined) return
    seen.lines = addSeen(read.before, first, last)
    this.persist(read.session, read.targetKey, seen)
  }

  setLines(actor: LineEditExecLike, target: FsTargetLike, lines: SeenLines): void {
    const session = actor.agent?.session
    if (session === undefined) return
    this.hydrate(session)
    const seen = this.bySession.get(session)?.get(target.targetKey)
    if (seen === undefined) return
    seen.lines = lines
    this.persist(session, target.targetKey, seen)
  }

  guard(actor: LineEditExecLike, target: FsTargetLike): { kind: 'replaceIfVersion'; version: unknown; lines: SeenLines } | string {
    const session = actor.agent?.session
    if (session === undefined) return { kind: 'replaceIfVersion', version: undefined, lines: 'all' }
    this.hydrate(session)
    const seen = this.bySession.get(session)?.get(target.targetKey)
    if (seen === undefined) return `cannot modify "${target.displayPath}": file has not been read — read the file, then retry`
    if (seen.observation.kind === 'absent') return `cannot edit "${target.displayPath}": not found — use write to create it`
    return { kind: 'replaceIfVersion', version: seen.observation.version, lines: seen.lines }
  }
}

export function attachObservations(host: LineEditHostContext): Observations {
  const observations = new Observations()
  host.on('fs/observed', (target, observation, actor) => observations.record(actor, target, observation))
  host.on(READ_SHOWN_EVENT, (exec, window) => observations.shown(exec, window.first, window.last))
  return observations
}

export async function resolveTargetWithGuards(
  host: LineEditHostContext,
  observations: Observations,
  rawFilePath: string,
  exec: LineEditExecLike,
  options?: { readonly allowFolded?: boolean },
): Promise<{
  readonly target: FsTargetLike
  readonly guard: { kind: 'replaceIfVersion'; version: unknown; lines: SeenLines }
  readonly folded: boolean
}> {
  if (typeof rawFilePath !== 'string' || rawFilePath.trim() === '') {
    throw new Error('file_path must be a non-empty string')
  }
  const cwd = await ensureExecWorkingDir(host, exec)
  const resolveOpts = { ...cwd !== undefined ? { cwd } : {}, ...exec.signal ? { signal: exec.signal } : {} }
  const target = await host.fs.resolve(rawFilePath, resolveOpts)
  const folded = isFoldedUnreadPath(sessionIdOfExec(exec), [
    host.fs.processPath(target),
    target.displayPath,
    ...(cwd !== undefined ? [resolve(cwd, rawFilePath.trim())] : []),
  ])
  if (folded && !options?.allowFolded) {
    throw new Error(foldedUnreadErrorMessage(target.displayPath, EDIT_LINES_TOOL))
  }
  const guard = observations.guard(exec, target)
  if (typeof guard === 'string') throw new Error(guard)
  return { target, guard, folded }
}

export function remediateStaleVersion(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code !== 'FS_STALE_VERSION') return error
  return new Error(`${(error as Error).message} — its line numbers may have moved; re-read the file, then retry`, { cause: error })
}
