// Checks estimateTokens (src/result-budget.ts) against real RWKV World token
// counts from rwkv-tokenizer-go, on tool results as the model sees them
// (inside <tool_response>, JSON-escaped). The estimate should rarely be below
// the real count: report how often it is, and by how much it overestimates.
//
//   node scripts/calibrate-token-estimate.ts [--tokenizer BIN] [--limit N] SOURCE...
//
// SOURCE: DSH --json event logs (events-*.jsonl: tool_result events), files
// holding one <tool_response>...</tool_response> segment, or directories of
// either. Results shorter than 300 characters are skipped; duplicates once.
// Every result is also cut into 1000-character pieces (the cut lands locally).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { toolResponse } from '../src/core/prompt.ts'
import { estimateTokens } from '../src/result-budget.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tokenizer: { type: 'string', default: join(homedir(), 'Projects/rwkv-tokenizer-go/bin/rwkv-tokenizer') },
    limit: { type: 'string', default: '400' },
  },
})
const limit = Number(values.limit)

interface Sample { tool: string; text: string }
const samples: Sample[] = []
const seen = new Set<string>()
const perTool = new Map<string, number>()

function add(tool: string, text: string): void {
  if (text.length < 300) return
  const hash = createHash('md5').update(text).digest('hex')
  if (seen.has(hash)) return
  seen.add(hash)
  const count = (perTool.get(tool) ?? 0) + 1
  perTool.set(tool, count)
  if (count <= limit) samples.push({ tool, text })
}

function readSource(path: string): void {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) readSource(join(path, name))
    return
  }
  const content = readFileSync(path, 'utf8')
  if (content.startsWith('<tool_response>')) {
    const payload = JSON.parse(content.slice('<tool_response>'.length, -'</tool_response>'.length)) as { tool?: string; result?: unknown; error?: unknown }
    const value = payload.result ?? payload.error
    add(String(payload.tool ?? 'tool'), typeof value === 'string' ? value : JSON.stringify(value))
    return
  }
  if (!path.endsWith('.jsonl')) return
  const calls = new Map<string, string>()
  for (const line of content.split('\n')) {
    let event: { type?: string; callId?: string; tool?: string; result?: unknown; error?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'tool_call' && event.callId) calls.set(event.callId, String(event.tool))
    else if (event.type === 'tool_result' && event.callId && calls.has(event.callId)) {
      const value = event.result ?? event.error
      if (typeof value === 'string') add(calls.get(event.callId)!, value)
    }
  }
}

for (const source of positionals) readSource(source)
if (samples.length === 0) {
  console.error('usage: node scripts/calibrate-token-estimate.ts [--tokenizer BIN] [--limit N] SOURCE...')
  process.exit(2)
}

function realTokens(text: string): number {
  const run = spawnSync(values.tokenizer!, ['encode'], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.status !== 0) throw new Error(`tokenizer failed: ${run.stderr}`)
  return run.stdout.split(/\s+/).filter(Boolean).length
}

/** The tool response the model reads; estimateTokens already counts the framing. */
const wire = (tool: string, text: string) => toolResponse(tool, true, text)

const whole: { tool: string; ratio: number }[] = []
const pieces: number[] = []
for (const { tool, text } of samples) {
  whole.push({ tool, ratio: estimateTokens(text) / realTokens(wire(tool, text)) })
  for (let at = 0; at + 1000 <= text.length && at < 6000; at += 1000) {
    const piece = text.slice(at, at + 1000)
    pieces.push(estimateTokens(piece) / realTokens(wire(tool, piece)))
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? NaN
const line = (label: string, xs: number[]) =>
  `${label.padEnd(12)} n=${String(xs.length).padStart(5)}  below real ${(100 * xs.filter(x => x < 1).length / xs.length).toFixed(1).padStart(5)}%  `
  + `min ${Math.min(...xs).toFixed(2)}  median ${median(xs).toFixed(2)}`
console.log('estimate / real RWKV tokens')
console.log(line('results', whole.map(x => x.ratio)))
console.log(line('1000 chars', pieces))
for (const tool of [...new Set(whole.map(x => x.tool))].sort()) {
  console.log(line(`  ${tool}`, whole.filter(x => x.tool === tool).map(x => x.ratio)))
}
