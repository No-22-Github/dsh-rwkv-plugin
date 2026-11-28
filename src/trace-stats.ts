// Pure statistics, session summaries, past-think transcript reconstruction,
// and argument diff helpers over `TraceRecord` streams.

export interface TraceRecord {
  readonly at?: string
  readonly model?: string
  /** DSH request purpose; absent for the agent itself, e.g. "session-title" for side requests. */
  readonly purpose?: string
  readonly stage?: string
  readonly prompt?: string
  readonly promptTokens?: number
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
  /** Card records only: the history range this handoff card replaced. */
  readonly relay?: { readonly from: number; readonly to: number; readonly turn: number; readonly fallback: boolean; readonly card: string }
  /** Decision records in worklist mode: token budget state and active checkpoint index. */
  readonly worklist?: { readonly promptTokens: number; readonly budgetTokens: number; readonly checkpointAt?: number; readonly nudged: boolean }
  /** Context fold triggered on this step (auto-fold in-place mask, stage archive, prior-turn, or relay). */
  readonly fold?: { readonly kind: string; readonly beforeTokens: number; readonly afterTokens: number; readonly foldedTools: number }
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

export function summarizeSession(
  session: string,
  records: readonly TraceRecord[],
  modified: string,
  bytes: number,
  persisted: boolean,
): SessionSummary {
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
 * think replaced by the think the model really wrote at that step.
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
    ...last?.prompt !== undefined && last.output !== undefined ? { text: joinGeneration(last.prompt, last.output) } : {},
    ...transcript !== undefined ? { textWithThinks: transcript } : {},
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
