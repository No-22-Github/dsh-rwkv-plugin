// Checks the vendored tokenizer (src/tokenizer.ts) against rwkv-tokenizer-go on
// real tool results as the model reads them (inside <tool_response>,
// JSON-escaped). Both must produce the same ids: the Go binary is the
// reference every training-pack and evaluation token count was taken with.
//
//   node scripts/tokenizer-parity.ts [--tokenizer BIN] [--limit N] SOURCE...
//
// SOURCE: DSH --json event logs (events-*.jsonl: tool_result events), files
// holding one <tool_response>...</tool_response> segment, or directories of
// either. Results shorter than 300 characters are skipped; duplicates once.
// Exits non-zero when any sample differs, printing the first few.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { toolResponse } from '../src/core/prompt.ts'
import { countTokens } from '../src/tokenizer.ts'

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
  let stat
  try {
    stat = statSync(path)
  } catch {
    return
  }
  if (stat.isDirectory()) {
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
  console.error('usage: node scripts/tokenizer-parity.ts [--tokenizer BIN] [--limit N] SOURCE...')
  process.exit(2)
}

function goTokens(text: string): number {
  const run = spawnSync(values.tokenizer!, ['encode'], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.status !== 0) throw new Error(`tokenizer failed: ${run.stderr}`)
  return run.stdout.split(/\s+/).filter(Boolean).length
}

/** The tool response the model reads. */
const wire = (tool: string, text: string) => toolResponse(tool, true, text)

let identical = 0
const different: { tool: string; wasm: number; go: number; preview: string }[] = []
for (const { tool, text } of samples) {
  const body = wire(tool, text)
  const wasm = countTokens(body)
  const go = goTokens(body)
  if (wasm === go) identical++
  else if (different.length < 10) different.push({ tool, wasm, go, preview: text.slice(0, 120) })
}
console.log(`samples ${samples.length}  identical ${identical}  different ${samples.length - identical}`)
for (const row of different) console.log(JSON.stringify(row))
if (different.length > 0) process.exit(1)
