import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { handleTraceRoute } from '../src/routes.ts'
import { allSessions, argumentChanges, clipArguments, deleteTrace, exportTask, TraceLocation, joinGeneration, listSessions, MemoryTraces, sessionRecords, traceStats, transcriptWithThinks, type TraceRecord } from '../src/traces.ts'

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
  assert.equal(listSessions(new TraceLocation(dir))[0]!.task, '读 a.txt')
  const call = (url: string, method = 'GET') => {
    let status = 0
    let body = ''
    const response = {
      headersSent: false,
      writeHead(this: { headersSent: boolean }, code: number) { status = code; this.headersSent = true },
      write(chunk: string) { body += chunk },
      end(chunk?: string) { body += chunk ?? '' },
    } as unknown as ServerResponse
    const handled = handleTraceRoute({ url, method } as IncomingMessage, response, () => ({ location: new TraceLocation(dir), recording: true }))
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
  assert.equal(call('/api/rwkv/traces', 'DELETE').status, 405)
  assert.equal(JSON.parse(call('/api/rwkv/traces/session-1', 'DELETE').body).deleted, true)
  assert.equal(listSessions(new TraceLocation(dir)).length, 0)
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
  assert.equal(sessionRecords(new TraceLocation(dir), 'c', memory).length, 2)
  assert.equal(sessionRecords(new TraceLocation(dir), 'a', memory).length, 2)
  const listed = allSessions(new TraceLocation(dir), memory)
  assert.deepEqual(listed.map(item => [item.session, item.persisted]).sort(), [['a', false], ['c', true]])
})

test('argument changes: changed, added, removed, and a removed + added pair of equal values as a rename', () => {
  assert.deepEqual(
    argumentChanges({ file_path: 'a', offset: 0, include: '*', old_text: 'x' }, { file_path: 'a', offset: 1, old_string: 'x', description: 'd' }),
    [
      { key: 'offset', kind: 'changed', before: 0, after: 1 },
      { key: 'old_string', kind: 'renamed', from: 'old_text', after: 'x' },
      { key: 'description', kind: 'added', after: 'd' },
      { key: 'include', kind: 'removed', before: '*' },
    ],
  )
  assert.deepEqual(argumentChanges({ a: 1 }, { a: 1 }), [])
  assert.equal(clipArguments({ content: 'x'.repeat(10) }, 4).content, 'xxxx…（共 10 字符）')
})

test('session traces sit next to the DSH session log; delete removes only the RWKV trace', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  const sessionDir = join(root, '--Users-me-ws--', 'session-1')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), 'dsh log')
  const location = new TraceLocation('', root)
  assert.equal(location.path('session-1'), join(sessionDir, 'rwkv-trace.jsonl'))
  assert.equal(location.path('session-missing'), undefined)
  assert.equal(location.path('../etc'), undefined)
  assert.deepEqual(location.list(), [])
  writeFileSync(join(sessionDir, 'rwkv-trace.jsonl'), `${JSON.stringify({ stage: 'decision', outcome: 'run', at: '1' })}\n`)
  assert.deepEqual(location.list().map(item => item.session), ['session-1'])
  const memory = new MemoryTraces()
  memory.add('session-1', { stage: 'decision', at: '1' })
  assert.equal(deleteTrace(location, 'session-1', memory), true)
  assert.equal(existsSync(join(sessionDir, 'rwkv-trace.jsonl')), false)
  assert.equal(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), true)
  assert.equal(memory.get('session-1'), undefined)
  assert.equal(deleteTrace(location, 'session-1', memory), false)
})
