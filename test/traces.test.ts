import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { handleTraceRoute } from '../src/routes.ts'
import { allSessions, exportTask, joinGeneration, listSessions, MemoryTraces, sessionRecords, traceStats, transcriptWithThinks, type TraceRecord } from '../src/traces.ts'

const SYSTEM = 'System: rules\n\nUser: 读 a.txt\n\nAssistant: <think'
// Request 1: a repaired call. Request 2: one re-ask, then the answer.
const records: TraceRecord[] = [
  { model: 'm', purpose: 'session-title', stage: 'decision', prompt: 'title', output: 'x', outcome: 'final', repairs: [] },
  { model: 'm', stage: 'decision', prompt: SYSTEM, output: '<think>先读文件</think><tool_call>{"type":"function","function":{"name":"read","arguments":{"file_path":"a.txt"}}}', outcome: 'run', repairs: ['function_wrapper'] },
  { model: 'm', stage: 'step', decision: 'tool read', repairs: ['function_wrapper'], attempts: 1 },
  { model: 'm', stage: 'decision', prompt: 'p2', output: '<think>…', finish: 'length', outcome: 're-ask', repairs: [] },
  {
    model: 'm', stage: 'decision',
    prompt: `${SYSTEM.slice(0, -6)}<think></think><tool_call>{"name":"read","arguments":{"file_path":"a.txt"}}</tool_call>\n\nUser: <tool_response>{"ok":true}</tool_response>\n\nAssistant: <think`,
    output: '<think>内容是 1</think>是 1。', outcome: 'final', repairs: [],
  },
  { model: 'm', stage: 'step', decision: 'final model', repairs: [], attempts: 2 },
]

test('trace stats count agent generations and requests; side requests are left out', () => {
  const [stats] = traceStats(records)
  assert.equal(stats!.generations, 3)
  assert.equal(stats!.clean, 1)
  assert.equal(stats!.steps, 2)
  assert.equal(stats!.cleanSteps, 0)
  assert.deepEqual(stats!.outcomes, { run: 1, 're-ask': 1, final: 1 })
  assert.deepEqual(stats!.repairs, { function_wrapper: 1 })
})

test('export: last generation as one RWKV text, and the same text with the real past thinks', () => {
  assert.equal(joinGeneration('Assistant: <think', '<think>a</think>b'), 'Assistant: <think>a</think>b')
  const transcript = transcriptWithThinks(records)!
  assert.match(transcript, /Assistant: <think>先读文件<\/think><tool_call>\{"name":"read"/)
  assert.ok(transcript.endsWith('Assistant: <think>内容是 1</think>是 1。'))
  // A trace cut before the last request record cannot be aligned.
  assert.equal(transcriptWithThinks(records.slice(0, -1)), undefined)
  const task = exportTask('s1', records)
  assert.equal((task.records as unknown[]).length, records.length)
  assert.match(String(task.text), /<think><\/think><tool_call>/)
})

test('trace routes: list, one session without prompts, one record with its prompt, export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwkv-traces-'))
  writeFileSync(join(dir, 'session-1.jsonl'), `${records.map(record => JSON.stringify(record)).join('\n')}\n{"broken`)
  assert.equal(listSessions(dir)[0]!.task, '读 a.txt')
  const call = (url: string) => {
    let status = 0
    let body = ''
    const response = {
      headersSent: false,
      writeHead(this: { headersSent: boolean }, code: number) { status = code; this.headersSent = true },
      write(chunk: string) { body += chunk },
      end(chunk?: string) { body += chunk ?? '' },
    } as unknown as ServerResponse
    const handled = handleTraceRoute({ url, method: 'GET' } as IncomingMessage, response, () => ({ dir, recording: true }))
    return { handled, status, body }
  }
  assert.equal(call('/api/rwkv/adapters').handled, false)
  const list = JSON.parse(call('/api/rwkv/traces').body) as { sessions: unknown[]; stats: unknown[] }
  assert.equal(list.sessions.length, 1)
  const session = JSON.parse(call('/api/rwkv/traces/session-1').body) as { records: TraceRecord[] & { promptChars?: number }[] }
  assert.equal(session.records[1]!.prompt, undefined)
  assert.equal(JSON.parse(call('/api/rwkv/traces/session-1?index=1').body).record.prompt, SYSTEM)
  assert.equal(call('/api/rwkv/traces/..%2Fetc').status, 200)
  const exported = call('/api/rwkv/trace-export').body.trim().split('\n')
  assert.equal(exported.length, 1)
  assert.equal(JSON.parse(exported[0]!).session, 'session-1')
})

test('memory traces: kept per session, oldest sessions dropped past the limit; disk or memory, whichever holds more', () => {
  const memory = new MemoryTraces(2, 1_000_000)
  memory.add('a', { stage: 'decision', outcome: 'run', at: '1' })
  memory.add('b', { stage: 'decision', outcome: 'run', at: '2' })
  memory.add('a', { stage: 'step', decision: 'tool read', attempts: 1, at: '3' })
  memory.add('c', { stage: 'decision', outcome: 'final', at: '4' })
  assert.equal(memory.get('b'), undefined)
  assert.equal(memory.get('a')!.length, 2)
  const dir = mkdtempSync(join(tmpdir(), 'rwkv-traces-'))
  writeFileSync(join(dir, 'c.jsonl'), `${JSON.stringify({ stage: 'decision', at: '0' })}\n${JSON.stringify({ stage: 'step', at: '0' })}\n`)
  assert.equal(sessionRecords(dir, 'c', memory).length, 2)
  assert.equal(sessionRecords(dir, 'a', memory).length, 2)
  const listed = allSessions(dir, memory)
  assert.deepEqual(listed.map(item => [item.session, item.persisted]).sort(), [['a', false], ['c', true]])
})
