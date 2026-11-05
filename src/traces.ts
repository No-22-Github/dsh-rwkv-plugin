// Raw trace files (traceDir/<session id>.jsonl) read back for the developer
// tools: session list, per-generation frames, crutch statistics and the
// export of whole tasks. Pure reading; the adapter is the only writer.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** $DSH_HOME/rwkv-traces (~/.dsh/rwkv-traces): used when recording is on and no directory is set. */
export function defaultTraceDir(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'rwkv-traces')
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

/** Path of one session's trace, or undefined for ids that are not plain file names. */
export function tracePath(dir: string, session: string): string | undefined {
  const file = `${session}.jsonl`
  return SESSION_FILE.test(file) ? join(dir, file) : undefined
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
  readonly task: string
  readonly models: readonly string[]
  readonly generations: number
  readonly steps: number
  /** Generations / requests the plugin had to touch (repair, re-ask, gate). */
  readonly touchedGenerations: number
  readonly touchedSteps: number
}

export function listSessions(dir: string): SessionSummary[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => SESSION_FILE.test(name))
  } catch {
    return []
  }
  const sessions: SessionSummary[] = []
  for (const name of names) {
    const path = join(dir, name)
    const info = statSync(path)
    const records = readTrace(path)
    const agent = records.filter(isAgent)
    const generations = agent.filter(isGeneration)
    const steps = agent.filter(record => record.stage === 'step')
    sessions.push({
      session: basename(name, '.jsonl'),
      modified: info.mtime.toISOString(),
      bytes: info.size,
      task: taskPreview(records),
      models: [...new Set(agent.map(record => record.model ?? '?'))],
      generations: generations.length,
      steps: steps.length,
      touchedGenerations: generations.filter(record => record.outcome !== undefined && !cleanGeneration(record)).length,
      touchedSteps: steps.filter(record => !cleanStep(record)).length,
    })
  }
  return sessions.sort((a, b) => b.modified.localeCompare(a.modified))
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
