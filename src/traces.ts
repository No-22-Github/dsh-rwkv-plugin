// RWKV trace storage and I/O: session directory discovery, bounded in-memory
// ring, ordered async JSONL append, readback, and deletion. Pure statistics
// and export helpers live in `trace-stats.ts` and are re-exported here.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { summarizeSession, type SessionSummary, type TraceRecord } from './trace-stats.ts'

export {
  argumentChanges,
  cleanGeneration,
  cleanStep,
  clipArguments,
  exportTask,
  joinGeneration,
  summarizeSession,
  traceStats,
  transcriptWithThinks,
  type ArgumentChange,
  type ModelStats,
  type SessionSummary,
  type TraceRecord,
} from './trace-stats.ts'

export function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** File name of the RWKV trace inside a DSH session directory. */
export const SESSION_TRACE_FILE = 'rwkv-trace.jsonl'

/** File name of the relay handoff cards inside a DSH session directory. */
export const RELAY_CARD_FILE = 'rwkv-relay.jsonl'

const SESSION_ID = /^[\w.-]+$/
const SESSION_FILE = /^[\w.-]+\.jsonl$/
const validSession = (session: string) => SESSION_ID.test(session) && !session.includes('..')

/** Session id -> its DSH session directory; found once by scanning the workspace directories. */
const sessionDirs = new Map<string, string>()

/** Pending appends per trace file, so records keep their order. */
const traceWrites = new Map<string, Promise<void>>()
/** Trace files this process has started writing; the first write also flushes what memory held before. */
const traceStarted = new Set<string>()

function findSessionDir(root: string, session: string): string | undefined {
  const cached = sessionDirs.get(session)
  if (cached !== undefined && existsSync(cached)) return cached
  let workspaces: string[]
  try {
    workspaces = readdirSync(root)
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    const dir = join(root, workspace, session)
    if (existsSync(dir)) {
      sessionDirs.set(session, dir)
      return dir
    }
  }
  return undefined
}

/** Where trace files are: next to the DSH session logs, or in a custom directory. */
export class TraceLocation {
  readonly customDir: string | undefined
  readonly sessionsRoot: string

  constructor(customDir?: string, sessionsRoot = join(dshHome(), 'sessions')) {
    this.customDir = customDir?.trim() || undefined
    this.sessionsRoot = sessionsRoot
  }

  /** Human-readable place, for the settings page. */
  describe(): string {
    const place = this.customDir ?? `${this.sessionsRoot}/<工作区>/<会话>/${SESSION_TRACE_FILE}`
    const home = homedir()
    return place.startsWith(`${home}/`) ? `~${place.slice(home.length)}` : place
  }

  /** The session's trace file; undefined while its DSH session directory does not exist yet. */
  path(session: string): string | undefined {
    if (!validSession(session)) return undefined
    if (this.customDir !== undefined) return join(this.customDir, `${session}.jsonl`)
    const dir = findSessionDir(this.sessionsRoot, session)
    return dir === undefined ? undefined : join(dir, SESSION_TRACE_FILE)
  }

  /** The session's relay-card file: same place as the trace, different name. */
  relayPath(session: string): string | undefined {
    if (!validSession(session)) return undefined
    if (this.customDir !== undefined) return join(this.customDir, `${session}.relay.jsonl`)
    const dir = findSessionDir(this.sessionsRoot, session)
    return dir === undefined ? undefined : join(dir, RELAY_CARD_FILE)
  }

  /** Every existing trace file. */
  list(): { session: string; path: string }[] {
    const found: { session: string; path: string }[] = []
    if (this.customDir !== undefined) {
      try {
        for (const name of readdirSync(this.customDir)) {
          if (SESSION_FILE.test(name)) found.push({ session: basename(name, '.jsonl'), path: join(this.customDir, name) })
        }
      } catch {
        // No directory yet.
      }
      return found
    }
    let workspaces: string[] = []
    try {
      workspaces = readdirSync(this.sessionsRoot)
    } catch {
      return found
    }
    for (const workspace of workspaces) {
      let sessions: string[] = []
      try {
        sessions = readdirSync(join(this.sessionsRoot, workspace))
      } catch {
        continue
      }
      for (const session of sessions) {
        const path = join(this.sessionsRoot, workspace, session, SESSION_TRACE_FILE)
        if (existsSync(path)) {
          sessionDirs.set(session, join(this.sessionsRoot, workspace, session))
          found.push({ session, path })
        }
      }
    }
    return found
  }
}

export function readTrace(path: string): TraceRecord[] {
  const records: TraceRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as TraceRecord)
    } catch {
      // A line cut by a crash mid-append: skip it, keep the rest.
    }
  }
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => (a.record.at ?? '').localeCompare(b.record.at ?? '') || a.index - b.index)
    .map(item => item.record)
}

/** Sessions on disk only. */
export function listSessions(location: TraceLocation): SessionSummary[] {
  return location.list()
    .map(({ session, path }) => {
      const info = statSync(path)
      return summarizeSession(session, readTrace(path), info.mtime.toISOString(), info.size, true)
    })
    .sort((a, b) => b.modified.localeCompare(a.modified))
}

/**
 * Traces of this DSH process, kept in memory whether or not they are written
 * to disk, so the RWKV tab works without recording.
 */
export class MemoryTraces {
  private readonly sessions = new Map<string, { records: TraceRecord[]; chars: number; modified: string }>()
  private total = 0
  private readonly maxSessions: number
  private readonly maxChars: number

  constructor(maxSessions = 100, maxChars = 100_000_000) {
    this.maxSessions = maxSessions
    this.maxChars = maxChars
  }

  add(session: string, record: TraceRecord): void {
    const chars = JSON.stringify(record).length
    const entry = this.sessions.get(session) ?? { records: [], chars: 0, modified: '' }
    this.sessions.delete(session)
    entry.records.push(record)
    entry.chars += chars
    entry.modified = record.at ?? new Date().toISOString()
    this.sessions.set(session, entry)
    this.total += chars
    for (const [key, oldest] of this.sessions) {
      if (this.sessions.size <= 1 || (this.sessions.size <= this.maxSessions && this.total <= this.maxChars)) break
      this.sessions.delete(key)
      this.total -= oldest.chars
    }
  }

  get(session: string): TraceRecord[] | undefined {
    return this.sessions.get(session)?.records
  }

  delete(session: string): void {
    const entry = this.sessions.get(session)
    if (entry === undefined) return
    this.sessions.delete(session)
    this.total -= entry.chars
  }

  list(): SessionSummary[] {
    return [...this.sessions].map(([session, entry]) => summarizeSession(session, entry.records, entry.modified, entry.chars, false))
  }
}

export const memoryTraces = new MemoryTraces()

/**
 * Record one trace entry into `memory` and, when `location` resolves a file for
 * `sessionId`, serialize writes per file so step summaries always follow their
 * generations.
 */
export function appendSessionTrace(
  sessionId: string | undefined,
  location: TraceLocation | undefined,
  record: TraceRecord,
  memory: MemoryTraces = memoryTraces,
): void {
  const memoryKey = sessionId ?? 'no-session'
  memory.add(memoryKey, record)
  const traceFile = sessionId === undefined ? undefined : location?.path(sessionId)
  if (traceFile === undefined) return
  const traceDir = dirname(traceFile)
  let records: readonly unknown[] = [record]
  if (!traceStarted.has(traceFile)) {
    traceStarted.add(traceFile)
    if (!existsSync(traceFile)) records = memory.get(memoryKey) ?? [record]
  }
  const line = records.map(item => `${JSON.stringify(item)}\n`).join('')
  const previous = traceWrites.get(traceFile) ?? Promise.resolve()
  const next = previous.then(() => mkdir(traceDir, { recursive: true })).then(() => appendFile(traceFile, line)).catch(() => {})
  traceWrites.set(traceFile, next)
  void next.then(() => { if (traceWrites.get(traceFile) === next) traceWrites.delete(traceFile) })
}

/** One session's records: from disk or memory, whichever holds more. */
export function sessionRecords(location: TraceLocation, session: string, memory: MemoryTraces = memoryTraces): TraceRecord[] {
  const path = location.path(session)
  const disk = path !== undefined && existsSync(path) ? readTrace(path) : []
  const live = memory.get(session) ?? []
  return live.length > disk.length ? [...live] : disk
}

/** Removes a session's RWKV trace (the file and the memory copy); DSH's own session log is not touched. */
export function deleteTrace(location: TraceLocation, session: string, memory: MemoryTraces = memoryTraces): boolean {
  if (!validSession(session)) return false
  const path = location.path(session)
  const existed = path !== undefined && existsSync(path)
  if (existed) rmSync(path)
  const inMemory = memory.get(session) !== undefined
  memory.delete(session)
  return existed || inMemory
}

/** Disk and memory sessions together, newest first. */
export function allSessions(location: TraceLocation, memory: MemoryTraces = memoryTraces): SessionSummary[] {
  const byId = new Map(listSessions(location).map(item => [item.session, item]))
  for (const item of memory.list()) {
    const disk = byId.get(item.session)
    if (disk === undefined || item.generations + item.steps > disk.generations + disk.steps) {
      byId.set(item.session, { ...item, persisted: disk !== undefined })
    }
  }
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified))
}
