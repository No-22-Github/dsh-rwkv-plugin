// Raw output quality from trace JSONL: how often the model's own output was
// used as written, versus how often the plugin had to repair or intervene.
// The same numbers as the developer section of the settings page.
//
//   node scripts/trace-stats.ts <traceDir or .jsonl files...>

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readTrace, traceStats } from '../src/traces.ts'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node scripts/trace-stats.ts <traceDir or .jsonl files...>')
  process.exit(1)
}
const files = args.flatMap(path => statSync(path).isDirectory()
  ? readdirSync(path).filter(name => name.endsWith('.jsonl')).map(name => join(path, name))
  : [path])

const percent = (part: number, whole: number) => whole === 0 ? '-' : `${(100 * part / whole).toFixed(1)}%`
const sorted = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1])
for (const stats of traceStats(files.flatMap(readTrace))) {
  console.log(`## ${stats.model}`)
  console.log(`clean generations: ${stats.clean}/${stats.generations} (${percent(stats.clean, stats.generations)})  — used as written, no repair, no re-ask`)
  console.log(`requests decided on the first try, no repair: ${stats.cleanSteps}/${stats.steps} (${percent(stats.cleanSteps, stats.steps)})`)
  console.log('outcomes:')
  for (const [key, count] of sorted(stats.outcomes)) console.log(`  ${key.padEnd(24)} ${count} (${percent(count, stats.generations)})`)
  if (Object.keys(stats.repairs).length > 0) {
    console.log('repairs (per generation):')
    for (const [key, count] of sorted(stats.repairs)) console.log(`  ${key.padEnd(24)} ${count} (${percent(count, stats.generations)})`)
  }
  console.log()
}
