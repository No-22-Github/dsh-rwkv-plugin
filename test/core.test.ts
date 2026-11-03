import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { GenerateRequest, GenerateResult, Generator } from '../src/backend/generator.ts'
import { LoopGuard, splitAtStop, v1Root } from '../src/backend/generator.ts'
import { decideStep, DEFAULT_HARNESS, type HarnessConfig } from '../src/core/agent.ts'
import { parseAction } from '../src/core/parse.ts'
import { transcriptEntries, POST_TOOL_REMINDER_THINK, type HistoryItem } from '../src/core/policy.ts'
import { renderPrompt, systemPrompt } from '../src/core/prompt.ts'
import { buildCatalog, coerceArguments, type WireTool } from '../src/core/tools.ts'

const identity = (args: Record<string, unknown>) => args

function wireTool(name: string, description: string, args: string): WireTool {
  return { name, description, arguments: args, dshName: name, toDsh: identity, fromDsh: identity }
}

test('renders the bytes of a real Go harness prompt (agent-wire-think-v1.0)', () => {
  const golden = readFileSync(new URL('./fixtures/go-think-prompt.txt', import.meta.url), 'utf8')
  const catalog = golden.slice(golden.indexOf('<tools>[\n') + 9, golden.indexOf('\n]</tools>'))
  const tools = catalog.split(',\n')
    .map(line => JSON.parse(line) as { name: string; description: string; arguments: unknown })
    .filter(entry => entry.name !== 'no_tool')
    .map(entry => wireTool(entry.name, entry.description, typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments)))
  const contract = golden.slice(golden.indexOf('Task-specific contract:\n') + 24, golden.indexOf('\n\nUser:'))
  const history: HistoryItem[] = [
    { kind: 'user', text: '运行 make test，告诉我输出了什么。' },
    { kind: 'call', id: 'c1', name: 'bash', args: { command: 'make' } },
    { kind: 'result', id: 'c1', name: 'bash', ok: true, text: '{"exit_code":127,"stdout":"","stderr":"bash: make: command not found\\n"}' },
    { kind: 'assistant', text: '这个环境里没有 make 命令，所以没法运行 make test。' },
    { kind: 'user', text: '那查一下示例城的天气呢？' },
    { kind: 'call', id: 'c2', name: 'get_weather', args: { location: '示例城' } },
    { kind: 'result', id: 'c2', name: 'get_weather', ok: false, text: 'location not found: 示例城' },
  ]
  const prompt = renderPrompt([
    { role: 'system', text: systemPrompt(tools, 'full', contract) },
    ...transcriptEntries(history, { tools, postToolReminder: POST_TOOL_REMINDER_THINK, maxResultChars: 0 }),
  ], { thinking: 'full' })
  // The plugin's bash sentence drops the sandbox wording (DSH bash is not the RWKV-Agent sandbox).
  const guidance = (text: string) => text.split('\n').filter(line => !line.startsWith('bash runs in ')).join('\n')
  assert.equal(guidance(prompt), guidance(golden))
})

test('parser repairs: preamble, OpenAI wrapper, extra braces, stringified args, unclosed think', () => {
  const preamble = parseAction('<think>check</think>我先读一下。\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}', 'stop')
  assert.equal(preamble.type, 'tool')
  assert.ok(preamble.type === 'tool' && preamble.repairs.includes('preamble_stripped'))

  const wrapped = parseAction('<think>x</think>\n<tool_call>\n{"id":"call_1","type":"function","function":{"name":"web_search","arguments":{"query":"q"}}}}\n', 'stop')
  assert.deepEqual(wrapped.type === 'tool' && [wrapped.name, wrapped.args], ['web_search', { query: 'q' }])

  const stringified = parseAction('<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>', 'stop')
  assert.deepEqual(stringified.type === 'tool' && stringified.args, { command: 'ls' })

  const withheld = parseAction('<think>The user greets.</think>你好！', 'stop')
  assert.deepEqual(withheld, { type: 'final', text: '你好！' })

  assert.equal(parseAction('<think>still thinking', 'length').type, 'error')
  assert.deepEqual(parseAction('<think>…</think><tool_call>{"name":"no_tool","arguments":{"reason":"25"}}', 'stop'), { type: 'exit', answer: '25', repairs: [] })
  // A quoted template inside prose is not a call.
  assert.equal(parseAction('Output exactly one <tool_call>{"name":"TOOL_NAME"}</tool_call> here', 'stop').type, 'final')
})

test('tool catalog maps DSH tools to trained names and back', () => {
  const catalog = buildCatalog([
    { name: 'read', description: '', parameters: {} },
    { name: 'grep', description: '', parameters: {} },
    { name: 'todo_write', description: '', parameters: {} },
  ], { mode: 'mapped' })
  assert.deepEqual(catalog.map(tool => tool.name), ['read_file', 'search_text'])
  const read = catalog[0]!
  assert.deepEqual(read.toDsh({ path: '/home/x/workspace/src/a.ts', start_line: 10, end_line: 19 }), { file_path: 'src/a.ts', offset: 10, limit: 10 })
  assert.deepEqual(read.fromDsh({ file_path: 'src/a.ts', offset: 10, limit: 10 }), { path: 'src/a.ts', start_line: 10, end_line: 19 })
  assert.deepEqual(catalog[1]!.toDsh({ query: 'a.b(' }), { pattern: 'a\\.b\\(' })
  assert.deepEqual(coerceArguments({ start_line: '10', end_line: '2,000' }, read.schema), { start_line: 10, end_line: 2000 })
})

class ScriptedGenerator implements Generator {
  readonly prompts: string[] = []
  private readonly outputs: string[]

  constructor(outputs: string[]) {
    this.outputs = [...outputs]
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.prompts.push(request.prompt)
    const text = this.outputs.shift()
    if (text === undefined) throw new Error('no scripted output left')
    const stop = text.includes('<tool_call>') ? '</tool_call>' : undefined
    return Promise.resolve({ text, finish: 'stop', ...stop ? { stop } : {}, completionTokens: 10 })
  }
}

const harness: HarnessConfig = { ...DEFAULT_HARNESS, maxSteps: 3 }
const tools = buildCatalog([
  { name: 'read', description: '', parameters: {} },
  { name: 'write', description: '', parameters: {} },
], { mode: 'mapped' })
const afterRead: HistoryItem[] = [
  { kind: 'user', text: 'What is in a.txt?' },
  { kind: 'call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
  { kind: 'result', id: 'c1', name: 'read_file', ok: true, text: '1\tBUDGET-READY' },
]

test('first repeat of a successful call gets one retry with a hint (harness v26)', async () => {
  const generator = new ScriptedGenerator([
    '>Read it again.</think><tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}',
    '>Got it.</think>BUDGET-READY',
  ])
  const step = await decideStep({ history: afterRead, tools, config: harness, generator })
  assert.deepEqual(step.decision, { type: 'final', text: 'BUDGET-READY', via: 'model' })
  assert.match(generator.prompts[1]!, /repeats a successful call; its result is already above/)
  assert.match(generator.prompts[1]!, /make the change now with write_file/)
  // The rejected repeat is not echoed back.
  assert.equal(generator.prompts[1]!.split('"name":"read_file"').length, generator.prompts[0]!.split('"name":"read_file"').length)
})

test('second repeat forces the closeout; a tool call there falls back to the summary', async () => {
  const call = '>x</think><tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}'
  const generator = new ScriptedGenerator([call, call, call, call])
  const step = await decideStep({ history: afterRead, tools, config: harness, generator })
  assert.equal(step.decision.type, 'final')
  assert.equal(step.decision.type === 'final' && step.decision.via, 'summary')
  assert.match(generator.prompts[2]!, /Tool execution is complete and tools are now unavailable/)
  assert.match(generator.prompts[3]!, /This is your final answer; tool calls are forbidden/)
})

test('step limit goes straight to the answer stage', async () => {
  const history: HistoryItem[] = [{ kind: 'user', text: '统计一下' }]
  for (let index = 0; index < 3; index++) {
    history.push({ kind: 'call', id: `c${index}`, name: 'read_file', args: { path: `f${index}` } })
    history.push({ kind: 'result', id: `c${index}`, name: 'read_file', ok: true, text: String(index) })
  }
  const generator = new ScriptedGenerator(['>ok</think>共 3 个。'])
  const step = await decideStep({ history, tools, config: harness, generator })
  assert.deepEqual(step.decision, { type: 'final', text: '共 3 个。', via: 'answer-stage' })
})

test('a new call returns the mapped tool with coerced arguments', async () => {
  const generator = new ScriptedGenerator(['>Need lines.</think><tool_call>{"name":"read_file","arguments":{"path":"b.txt","start_line":"5"}}'])
  const step = await decideStep({ history: afterRead, tools, config: harness, generator })
  assert.equal(step.decision.type, 'tool')
  if (step.decision.type === 'tool') {
    assert.equal(step.decision.tool.dshName, 'read')
    assert.deepEqual(step.decision.tool.toDsh(step.decision.args), { file_path: 'b.txt', offset: 5 })
  }
})

test('client stops hold back a split stop; loop guard trips on repetition', () => {
  assert.deepEqual(splitAtStop('answer\nUs', ['\nUser:']), { safe: 'answer', tail: '\nUs' })
  assert.deepEqual(splitAtStop('answer\nUser: hi', ['\nUser:']), { safe: 'answer', tail: '', stop: '\nUser:' })
  const guard = new LoopGuard()
  let tripped = false
  for (let index = 0; index < 200 && !tripped; index++) tripped = guard.write('同一句话反复出现。')
  assert.ok(tripped)
  assert.equal(v1Root('http://h:8000/v1/batch/completions'), 'http://h:8000/v1')
  assert.equal(v1Root('http://h:8103'), 'http://h:8103/v1')
})
