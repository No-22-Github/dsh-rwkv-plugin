// Raw output quality from traceDir JSONL: how often the model's own output
// was usable as written, versus how often the plugin had to repair or
// intervene. Run on traces of the same task set with the switches on and off
// to see what the crutches carry.
//
//   node scripts/trace-stats.ts <traceDir or .jsonl files...>

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface Line {
  model?: string
  stage?: string
  outcome?: string
  repairs?: string[]
  decision?: string
  attempts?: number
}

function files(paths: readonly string[]): string[] {
  return paths.flatMap(path => statSync(path).isDirectory()
    ? readdirSync(path).filter(name => name.endsWith('.jsonl')).map(name => join(path, name))
    : [path])
}

interface Stats {
  generations: number
  clean: number
  outcomes: Map<string, number>
  repairs: Map<string, number>
  steps: number
  cleanSteps: number
}

const byModel = new Map<string, Stats>()
const stats = (model: string): Stats => {
  let entry = byModel.get(model)
  if (entry === undefined) {
    entry = { generations: 0, clean: 0, outcomes: new Map(), repairs: new Map(), steps: 0, cleanSteps: 0 }
    byModel.set(model, entry)
  }
  return entry
}
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node scripts/trace-stats.ts <traceDir or .jsonl files...>')
  process.exit(1)
}
for (const file of files(args)) {
  for (const text of readFileSync(file, 'utf8').split('\n')) {
    if (text.trim() === '') continue
    const line = JSON.parse(text) as Line
    const entry = stats(line.model ?? '?')
    if (line.stage === 'step') {
      entry.steps++
      // First try, no repair, the model's own answer or call: went from model to DSH untouched.
      const decision = String(line.decision)
      if ((line.repairs ?? []).length === 0 && line.attempts === 1 && (decision.startsWith('tool ') || decision === 'final model' || decision === 'final exit')) {
        entry.cleanSteps++
      }
      continue
    }
    if (line.stage !== 'decision' && line.stage !== 'answer') continue
    if (line.outcome === undefined) continue // traces written before outcome existed
    entry.generations++
    bump(entry.outcomes, line.outcome)
    for (const repair of line.repairs ?? []) bump(entry.repairs, repair)
    if ((line.outcome === 'run' || line.outcome === 'final') && (line.repairs ?? []).length === 0) entry.clean++
  }
}

const percent = (part: number, whole: number) => whole === 0 ? '-' : `${(100 * part / whole).toFixed(1)}%`
const sorted = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1])
for (const [model, entry] of byModel) {
  console.log(`## ${model}`)
  console.log(`clean generations: ${entry.clean}/${entry.generations} (${percent(entry.clean, entry.generations)})  — used as written, no repair, no re-ask`)
  console.log(`requests decided on the first try, no repair: ${entry.cleanSteps}/${entry.steps} (${percent(entry.cleanSteps, entry.steps)})`)
  console.log('outcomes:')
  for (const [key, count] of sorted(entry.outcomes)) console.log(`  ${key.padEnd(24)} ${count} (${percent(count, entry.generations)})`)
  if (entry.repairs.size > 0) {
    console.log('repairs (per generation):')
    for (const [key, count] of sorted(entry.repairs)) console.log(`  ${key.padEnd(24)} ${count} (${percent(count, entry.generations)})`)
  }
  console.log()
}
