// Raw RWKV traces read back for the developer tools: session list,
// per-generation frames, crutch statistics, export and delete. Files sit next
// to DSH's own session logs ($DSH_HOME/sessions/<workspace>/<session>/
// rwkv-trace.jsonl) or in a custom directory (<dir>/<session>.jsonl). The
// adapter is the only writer.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** File name of the RWKV trace inside a DSH session directory. */
export const SESSION_TRACE_FILE = 'rwkv-trace.jsonl'

const SESSION_ID = /^[\w.-]+$/
const validSession = (session: string) => SESSION_ID.test(session) && !session.includes('..')

/** Session id → its DSH session directory; found once by scanning the workspace directories. */
const sessionDirs = new Map<string, string>()

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

/** One generation (stage decision / answer) or one DSH request summary (stage step). */
export interface TraceRecord {
  readonly at?: string
  readonly model?: string
  /** DSH request purpose; absent for the agent itself, e.g. "session-title" for side requests. */
  readonly purpose?: string
  readonly stage?: string
  readonly prompt?: string
  readonly output?: string
  readonly finish?: string
  readonly stop?: string
  readonly action?: string
  readonly outcome?: string
  readonly repairs?: readonly string[]
  readonly decision?: string
  readonly attempts?: number
  readonly generations?: number
  readonly outputRepairs?: boolean
  readonly guards?: boolean
}

const SESSION_FILE = /^[\w.-]+\.jsonl$/

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
  // Writes used to race (a request summary could land before its generation);
  // the timestamp is taken when the record is made, so it restores the order.
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => (a.record.at ?? '').localeCompare(b.record.at ?? '') || a.index - b.index)
    .map(item => item.record)
}


const isGeneration = (record: TraceRecord) => record.stage === 'decision' || record.stage === 'answer'
const isAgent = (record: TraceRecord) => record.purpose === undefined

/** Clean = the model's output was used as written: no repair, no re-ask, no gate. */
export function cleanGeneration(record: TraceRecord): boolean {
  return (record.outcome === 'run' || record.outcome === 'final') && (record.repairs ?? []).length === 0
}

/** Clean request = decided on the first try, no repair, by the model's own call or answer. */
export function cleanStep(record: TraceRecord): boolean {
  const decision = record.decision ?? ''
  return (record.repairs ?? []).length === 0 && record.attempts === 1
    && (decision.startsWith('tool ') || decision === 'final model' || decision === 'final exit')
}

export interface ModelStats {
  readonly model: string
  generations: number
  clean: number
  steps: number
  cleanSteps: number
  readonly outcomes: Record<string, number>
  readonly repairs: Record<string, number>
}

/** Per-model counts over agent requests (side requests such as session titles are left out). */
export function traceStats(records: Iterable<TraceRecord>): ModelStats[] {
  const byModel = new Map<string, ModelStats>()
  const entry = (model: string) => {
    let stats = byModel.get(model)
    if (stats === undefined) {
      stats = { model, generations: 0, clean: 0, steps: 0, cleanSteps: 0, outcomes: {}, repairs: {} }
      byModel.set(model, stats)
    }
    return stats
  }
  for (const record of records) {
    if (!isAgent(record)) continue
    const stats = entry(record.model ?? '?')
    if (record.stage === 'step') {
      stats.steps++
      if (cleanStep(record)) stats.cleanSteps++
      continue
    }
    // Traces written before outcome existed carry no judgement to count.
    if (!isGeneration(record) || record.outcome === undefined) continue
    stats.generations++
    stats.outcomes[record.outcome] = (stats.outcomes[record.outcome] ?? 0) + 1
    for (const repair of record.repairs ?? []) stats.repairs[repair] = (stats.repairs[repair] ?? 0) + 1
    if (cleanGeneration(record)) stats.clean++
  }
  return [...byModel.values()]
}

/** First user message of the agent's first prompt, as a list preview. */
function taskPreview(records: readonly TraceRecord[]): string {
  const prompt = records.find(record => isAgent(record) && isGeneration(record))?.prompt ?? ''
  const match = /\n\nUser: ([\s\S]*?)(?:\n\n(?:User|Assistant):|$)/.exec(prompt)
  return (match?.[1] ?? '').trim().slice(0, 200)
}

export interface SessionSummary {
  readonly session: string
  readonly modified: string
  readonly bytes: number
  /** A file in the trace directory exists for it (otherwise memory only). */
  readonly persisted: boolean
  readonly task: string
  readonly models: readonly string[]
  readonly generations: number
  readonly steps: number
  /** Generations / requests the plugin had to touch (repair, re-ask, gate). */
  readonly touchedGenerations: number
  readonly touchedSteps: number
}

function summarize(session: string, records: readonly TraceRecord[], modified: string, bytes: number, persisted: boolean): SessionSummary {
  const agent = records.filter(isAgent)
  const generations = agent.filter(isGeneration)
  const steps = agent.filter(record => record.stage === 'step')
  return {
    session,
    modified,
    bytes,
    persisted,
    task: taskPreview(records),
    models: [...new Set(agent.map(record => record.model ?? '?'))],
    generations: generations.length,
    steps: steps.length,
    touchedGenerations: generations.filter(record => record.outcome !== undefined && !cleanGeneration(record)).length,
    touchedSteps: steps.filter(record => !cleanStep(record)).length,
  }
}

/** Sessions on disk only. */
export function listSessions(location: TraceLocation): SessionSummary[] {
  return location.list()
    .map(({ session, path }) => {
      const info = statSync(path)
      return summarize(session, readTrace(path), info.mtime.toISOString(), info.size, true)
    })
    .sort((a, b) => b.modified.localeCompare(a.modified))
}

/**
 * Traces of this DSH process, kept in memory whether or not they are written
 * to disk, so the RWKV tab works without recording. Bounded: the least
 * recently written sessions are dropped past the session or size limit.
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
    return [...this.sessions].map(([session, entry]) => summarize(session, entry.records, entry.modified, entry.chars, false))
  }
}

export const memoryTraces = new MemoryTraces()

/** One session's records: from disk or memory, whichever holds more (memory starts with this process). */
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

const WITHHELD_THINK = '<think'
const EMPTY_THINK = 'Assistant: <think></think>'

/** prompt + output as one text: the withheld "<think" generation point is not doubled. */
export function joinGeneration(prompt: string, output: string): string {
  return prompt.endsWith(WITHHELD_THINK) && output.startsWith(WITHHELD_THINK)
    ? prompt.slice(0, -WITHHELD_THINK.length) + output
    : prompt + output
}

function thinkOf(output: string): string | undefined {
  const match = /^\s*<think>([\s\S]*?)<\/think>/.exec(output)
  return match?.[1]
}

/**
 * The agent's last generation as one RWKV text, with each past step's empty
 * think replaced by the think the model really wrote at that step. Past steps
 * map to DSH requests (stage step records) in order; a request answered
 * without a model generation (summary) keeps its empty think. Undefined when
 * the trace has no step records or the counts do not line up.
 */
export function transcriptWithThinks(records: readonly TraceRecord[]): string | undefined {
  const agent = records.filter(isAgent)
  const last = [...agent].reverse().find(isGeneration)
  if (last?.prompt === undefined || last.output === undefined) return undefined
  const thinks: (string | undefined)[] = []
  let accepted: TraceRecord | undefined
  for (const record of agent) {
    if (record.stage === 'step') {
      thinks.push(accepted?.output === undefined ? undefined : thinkOf(accepted.output))
      accepted = undefined
    } else if (isGeneration(record) && (record.outcome === 'run' || record.outcome === 'final' || record.outcome === 'raw')) {
      accepted = record
    }
  }
  const parts = last.prompt.split(EMPTY_THINK)
  // One step record per past step plus the last request's own. Anything else
  // (a trace cut before the last record, recording switched on mid-session, a
  // re-ask prompt echoing a rejected call) cannot be aligned safely.
  if (thinks.length !== parts.length) return undefined
  let text = parts[0]!
  for (let index = 1; index < parts.length; index++) {
    const think = thinks[index - 1]
    text += (think === undefined ? EMPTY_THINK : `Assistant: <think>${think}</think>`) + parts[index]
  }
  return joinGeneration(text, last.output)
}

/** One exported task: every record as written, plus the RWKV texts derived from them. */
export function exportTask(session: string, records: readonly TraceRecord[]): Record<string, unknown> {
  const agent = records.filter(isAgent)
  const last = [...agent].reverse().find(isGeneration)
  const transcript = transcriptWithThinks(records)
  return {
    session,
    models: [...new Set(agent.map(record => record.model ?? '?'))],
    stats: traceStats(records),
    /** What the model saw at its last generation plus what it wrote (past thinks empty, as sent). */
    ...last?.prompt !== undefined && last.output !== undefined ? { text: joinGeneration(last.prompt, last.output) } : {},
    /** The same text with each past step's real think put back. */
    ...transcript !== undefined ? { textWithThinks: transcript } : {},
    /** Every generation and request record in order: re-asks, rejected calls, repairs, side requests. */
    records,
  }
}

/** One argument difference between what the model wrote and what DSH received. */
export interface ArgumentChange {
  readonly key: string
  readonly kind: 'changed' | 'added' | 'removed' | 'renamed'
  /** For renamed: the key the model wrote. */
  readonly from?: string
  readonly before?: unknown
  readonly after?: unknown
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Field-level differences, with a removed + added pair of equal values reported as one rename. */
export function argumentChanges(before: Record<string, unknown>, after: Record<string, unknown>): ArgumentChange[] {
  const changes: ArgumentChange[] = []
  const removed = Object.keys(before).filter(key => !(key in after))
  const added = Object.keys(after).filter(key => !(key in before))
  for (const key of Object.keys(after)) {
    if (key in before && !sameValue(before[key], after[key])) changes.push({ key, kind: 'changed', before: before[key], after: after[key] })
  }
  for (const key of added) {
    const source = removed.find(old => sameValue(before[old], after[key]))
    if (source !== undefined) {
      removed.splice(removed.indexOf(source), 1)
      changes.push({ key, kind: 'renamed', from: source, after: after[key] })
    } else {
      changes.push({ key, kind: 'added', after: after[key] })
    }
  }
  for (const key of removed) changes.push({ key, kind: 'removed', before: before[key] })
  return changes
}

/** Arguments for a trace record: long strings (file content) cut so memory and files stay small. */
export function clipArguments(args: Record<string, unknown>, limit = 2000): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) =>
    [key, typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}…（共 ${value.length} 字符）` : value]))
}
