import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { GenerateRequest, GenerateResult, Generator } from '../src/backend/generator.ts'
import { LoopGuard, splitAtStop, v1Root } from '../src/backend/generator.ts'
import { decideStep, DEFAULT_HARNESS, type HarnessConfig } from '../src/core/agent.ts'
import { parseAction } from '../src/core/parse.ts'
import { dshSystemSections } from '../src/core/dsh-prompt.ts'
import { analyzeTurn, isMutatingCall, toolFailureReminder, transcriptEntries, POST_TOOL_REMINDER_THINK, type HistoryItem } from '../src/core/policy.ts'
import { currentDateLine, promptJSON, recordToolCall, renderPrompt, systemPrompt, toolResponse } from '../src/core/prompt.ts'
import { historyFromMessages } from '../src/history.ts'
import { runtimeCwd } from '../src/paths.ts'
import { buildCatalog, coerceArguments, normalizeArguments, repairNativeValues, resolveTool, type DshToolSchema, type WireTool } from '../src/core/tools.ts'

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
    ...transcriptEntries(history, { tools, postToolReminder: POST_TOOL_REMINDER_THINK }),
  ], { thinking: 'full' })
  // The plugin's bash sentence drops the sandbox wording (DSH bash is not the RWKV-Agent sandbox).
  const guidance = (text: string) => text.split('\n').filter(line => !line.startsWith('bash runs in ')).join('\n')
  // Go escapes < > & in JSON; the plugin writes them raw (G1 copies the escapes into its arguments).
  const unescaped = golden.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')
  assert.equal(guidance(prompt), guidance(unescaped))
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
  private readonly outputs: (string | { text: string; finish: 'length' })[]

  constructor(outputs: (string | { text: string; finish: 'length' })[]) {
    this.outputs = [...outputs]
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.prompts.push(request.prompt)
    const next = this.outputs.shift()
    if (next === undefined) throw new Error('no scripted output left')
    if (typeof next !== 'string') return Promise.resolve({ text: next.text, finish: next.finish, completionTokens: 4096 })
    const text = next
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

const call = (id: string, name: string, args: Record<string, unknown>, ok = true): HistoryItem[] => [
  { kind: 'call', id, name, args },
  { kind: 'result', id, name, ok, text: 'ok' },
]
const gateTools = buildCatalog([
  { name: 'read', description: '', parameters: {} },
  { name: 'edit', description: '', parameters: {} },
  { name: 'bash', description: '', parameters: {} },
], { mode: 'mapped' })
const decideWith = async (history: HistoryItem[], output: string) => {
  const generator = new ScriptedGenerator([output, '>x</think>done'])
  return (await decideStep({ history, tools: gateTools, config: { ...DEFAULT_HARNESS, maxSteps: 20 }, generator })).decision.type
}
const readA = '>x</think><tool_call>{"name":"read_file","arguments":{"path":"a.py"}}'
const runTests = '>x</think><tool_call>{"name":"bash","arguments":{"command":"python3 -m unittest"}}'

test('a successful edit lets the edited file be reread and the same test rerun', async () => {
  const base: HistoryItem[] = [
    { kind: 'user', text: 'Fix a.py' },
    ...call('c1', 'read_file', { path: 'a.py' }),
    ...call('c2', 'bash', { command: 'python3 -m unittest' }),
  ]
  // No change in between: still a repeat.
  assert.equal(await decideWith(base, readA), 'final')
  const edited = [...base, ...call('c3', 'edit_file', { path: 'a.py', old_text: 'x', new_text: 'y' })]
  assert.equal(await decideWith(edited, readA), 'tool')
  assert.equal(await decideWith(edited, runTests), 'tool')
  // A failed edit changes nothing.
  const failed = [...base, ...call('c3', 'edit_file', { path: 'a.py', old_text: 'x', new_text: 'y' }, false)]
  assert.equal(await decideWith(failed, readA), 'final')
  // Calls made after the edit are repeats again.
  const reread = [...edited, ...call('c4', 'read_file', { path: 'a.py' })]
  assert.equal(await decideWith(reread, readA), 'final')
  // The edit itself cannot be repeated.
  assert.equal(await decideWith(edited, '>x</think><tool_call>{"name":"edit_file","arguments":{"path":"a.py","old_text":"x","new_text":"y"}}'), 'final')
})

test('state analysis: only successful mutating calls reset the repeat set', () => {
  const history: HistoryItem[] = [
    { kind: 'user', text: 'task' },
    ...call('c1', 'read', { file_path: 'a' }),
    ...call('c2', 'bash', { command: 'ls' }),
    ...call('c3', 'bash', { command: "sed -i 's/a/b/' a" }),
    ...call('c4', 'read', { file_path: 'a' }),
  ]
  const state = analyzeTurn(history)
  assert.equal(state.successKeys.size, 2)
  assert.equal(state.successfulCalls, 4)
})

test('shell commands that write are recognised; reads and fd duplication are not', () => {
  const writes = ['echo x > a.txt', 'cat >> log <<EOF', 'sed -i "s/a/b/" f', 'sed -E -i.bak s/a/b/ f', 'python3 gen.py | tee out.txt',
    'mv a b', 'rm -f x', 'mkdir -p d', 'git apply p.diff', 'pip install requests', 'cmd 2> err.txt']
  const reads = ['ls -la', 'cat a.txt', 'python3 -m pytest 2>&1 | tail -20', 'grep -n foo a.py', 'cmd > /dev/null 2>&1',
    'awk \'$3 >= 5\' f.csv', 'git status', 'git diff', 'sed -n 1,20p f', 'python3 -m unittest discover -s tests']
  for (const command of writes) assert.ok(isMutatingCall('bash', { command }), command)
  for (const command of reads) assert.ok(!isMutatingCall('bash', { command }), command)
  assert.ok(isMutatingCall('write', { file_path: 'a' }))
  assert.ok(!isMutatingCall('read_file', { path: 'a' }))
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

const editTools = buildCatalog([
  { name: 'read', description: '', parameters: {} },
  { name: 'edit', description: '', parameters: {} },
  { name: 'bash', description: '', parameters: {} },
], { mode: 'mapped' })

test('tool names resolve case-insensitively and by alias; Claude-style argument keys are renamed', async () => {
  assert.equal(resolveTool(editTools, 'Bash')?.tool.name, 'bash')
  assert.equal(resolveTool(editTools, 'str_replace')?.tool.name, 'edit_file')
  assert.equal(resolveTool(editTools, 'edit')?.tool.name, 'edit_file')
  assert.equal(resolveTool(editTools, 'nope'), undefined)
  const read = resolveTool(editTools, 'read_file')!.tool
  assert.deepEqual(normalizeArguments(read, { file_path: 'a.py', offset: '3', limit: '2' }), { path: 'a.py', start_line: 3, end_line: 4 })
  const plain = { path: 'a.py' }
  assert.equal(normalizeArguments(read, plain), plain)

  const generator = new ScriptedGenerator([
    '>Fix it.</think><tool_call>{"name":"Edit","arguments":{"file_path":"/workspace/a.py","old_string":"x = 1","new_string":"x = 2"}}',
  ])
  const step = await decideStep({ history: afterRead, tools: editTools, config: harness, generator })
  assert.equal(step.decision.type, 'tool')
  if (step.decision.type === 'tool') {
    assert.equal(step.decision.tool.dshName, 'edit')
    assert.deepEqual(step.decision.tool.toDsh(step.decision.args), { file_path: 'a.py', old_string: 'x = 1', new_string: 'x = 2' })
    assert.deepEqual(step.decision.repairs, ['tool_name_alias', 'argument_alias'])
  }
})

test('a think that runs out of budget is closed in place and the model continues with its action', async () => {
  const generator = new ScriptedGenerator([
    { text: '>Check the cases again. Check the cases again.', finish: 'length' },
    '<tool_call>{"name":"bash","arguments":{"command":"python3 a.py"}}',
  ])
  const step = await decideStep({ history: afterRead, tools: editTools, config: harness, generator })
  assert.equal(step.decision.type, 'tool')
  assert.equal(generator.prompts.length, 2)
  assert.ok(generator.prompts[1]!.endsWith('Check the cases again.\n</think>\n'))
})

test('closeout after unparseable output runs a valid tool call; a policy closeout still refuses it', async () => {
  const generator = new ScriptedGenerator([
    '>a</think>', '>b</think>', '>c</think>',
    '>Now I know.</think><tool_call>{"name":"edit_file","arguments":{"path":"a.py","old_text":"x = 1","new_text":"x = 2"}}',
  ])
  const step = await decideStep({ history: afterRead, tools: editTools, config: harness, generator })
  assert.equal(step.decision.type, 'tool')
  assert.ok(step.decision.type === 'tool' && step.decision.repairs.includes('answer_stage_tool'))
  assert.match(generator.prompts[3]!, /Tool execution is complete and tools are now unavailable/)
})

test('file paths missing the last workspace component are repaired only when the repair exists', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { repairToolPaths, runtimeCwd } = await import('../src/paths.ts')
  const root = mkdtempSync(join(tmpdir(), 'rwkv-paths-'))
  const cwd = join(root, 'task', 'ws')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'a.py'), 'x = 1\n')
  const history: HistoryItem[] = [{ kind: 'note', text: `Current working directory: "${cwd}".` }]
  assert.equal(runtimeCwd(history), cwd)
  // Dropped "ws": repaired. A wrong directory with the right file name: repaired.
  assert.deepEqual(repairToolPaths('read', { file_path: join(root, 'task', 'a.py') }, cwd), { file_path: join(cwd, 'a.py') })
  assert.deepEqual(repairToolPaths('edit', { file_path: '/workspace2/a.py', old_string: 'x' }, cwd), { file_path: join(cwd, 'a.py'), old_string: 'x' })
  // An existing directory (the parent) is a real path: left alone.
  const parent = { pattern: '*', path: join(root, 'task') }
  assert.equal(repairToolPaths('glob', parent, cwd), parent)
  // Correct, relative, new-file and non-file-tool arguments pass through unchanged.
  const ok = { file_path: join(cwd, 'a.py') }
  assert.equal(repairToolPaths('read', ok, cwd), ok)
  const fresh = { file_path: join(root, 'task', 'new.py'), content: '' }
  assert.equal(repairToolPaths('write', fresh, cwd), fresh)
  const rel = { file_path: 'a.py' }
  assert.equal(repairToolPaths('edit', rel, cwd), rel)
  const cmd = { command: `cat ${join(root, 'task', 'a.py')}` }
  assert.equal(repairToolPaths('bash', cmd, cwd), cmd)
})

// ── RWKV Agent preset (toolNames: dsh) ─────────────────────────────────────

const dshSchemas = JSON.parse(readFileSync(new URL('./fixtures/dsh-tool-schemas.json', import.meta.url), 'utf8')) as DshToolSchema[]
const dshTools = buildCatalog(dshSchemas, { mode: 'mapped', names: 'dsh' })

test('Standard system prompt keeps its 11 sections for the RWKV Agent tools and drops the other 10', () => {
  const standard = readFileSync(new URL('./fixtures/dsh-standard-system-prompt.txt', import.meta.url), 'utf8')
  assert.equal(standard.trim().split(/\n{2,}/).length, 21)
  const kept = dshSystemSections(standard).split('\n\n')
  assert.equal(kept.length, 11)
  assert.equal(kept[0], 'You are an AI agent powered by DeepSeek Harness.')
  for (const gone of ['apply_patch', 'job_output', 'create_goal', 'scheduled tasks', 'workflow tool', 'subagent', 'different working directories', 'present', 'checkout', 'Web GUI']) {
    assert.ok(!kept.some(section => section.includes(gone)), gone)
  }
  for (const word of ['@', '[exit code: N]', 'read tool', 'with write', 'before editing', 'glob tool', 'grep tool', 'web_search results', 'web_fetch returns']) {
    assert.ok(kept.some(section => section.includes(word)), word)
  }
  // The bundle's global rwkv_agent delegation tool adds the same section under its own name.
  assert.equal(dshSystemSections('Start independent delegations with `rwkv_agent` together in one assistant message.'), '')
  const prompt = systemPrompt(dshTools, 'full', undefined, kept.join('\n\n'))
  assert.ok(prompt.startsWith('You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent'))
  assert.ok(prompt.includes('Choose one action:') && prompt.includes('<tools>[\n{"name":"bash"'))
  assert.ok(!prompt.includes('read_file') && !prompt.includes('local-first'))
})

test('RWKV Agent catalog keeps DSH names and arguments; trained names and keys still resolve', () => {
  assert.deepEqual(dshTools.map(tool => tool.name), ['bash', 'edit', 'glob', 'grep', 'read', 'web_fetch', 'web_search', 'write'])
  const read = dshTools.find(tool => tool.name === 'read')!
  assert.equal(read.description, 'Read a UTF-8 text file and return line-numbered content.')
  assert.equal(read.arguments, '{"file_path":"Path to read, resolved by the filesystem backend","offset":"optional number","limit":"optional number"}')
  assert.equal(resolveTool(dshTools, 'read_file')?.tool.name, 'read')
  assert.equal(resolveTool(dshTools, 'list_files')?.tool.name, 'glob')
  assert.equal(resolveTool(dshTools, 'search_text')?.tool.name, 'grep')
  assert.equal(resolveTool(dshTools, 'str_replace')?.tool.name, 'edit')
  assert.deepEqual(normalizeArguments(read, { path: 'a.py', start_line: 3, end_line: 4 }), { file_path: 'a.py', offset: 3, limit: 2 })
  const plain = { file_path: 'a.py' }
  assert.equal(normalizeArguments(read, plain), plain)
  const edit = dshTools.find(tool => tool.name === 'edit')!
  assert.deepEqual(normalizeArguments(edit, { path: 'a.py', old_text: 'x', new_text: 'y' }), { file_path: 'a.py', old_string: 'x', new_string: 'y' })
  const search = dshTools.find(tool => tool.name === 'web_search')!
  assert.deepEqual(normalizeArguments(search, { query: 'rwkv' }), { queries: ['rwkv'] })
  const bash = dshTools.find(tool => tool.name === 'bash')!
  assert.deepEqual(normalizeArguments(bash, { command: 'ls -la' }), { command: 'ls -la', description: 'ls -la' })
  assert.match(toolFailureReminder('read', 'not found', false, dshTools), /use glob or grep before another read call/)
})

test('runtime context keeps only the working directory and sandbox policy, as a note rather than the task', () => {
  const sections = [
    { name: 'working-directory:current', text: 'Current working directory: "/Users/me/ws".' },
    { name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "/Users/me/ws". Some platform temporary areas may also be writable.' },
    { name: 'approval:policy', text: 'Approval prompts are enabled in this session.' },
    { name: 'harness:source', text: 'Current DeepSeek Harness implementation checkout: "/Applications/x".' },
    { name: 'app:web-surface', text: 'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:1".' },
  ]
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
    { role: 'user', content: [{ type: 'text', text: '帮我写一个 HTML 简历模板' }], source: { kind: 'user' } },
    {
      role: 'user',
      content: [{ type: 'text', text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${sections.map(s => s.text).join('\n\n')}` }],
      source: { kind: 'runtime-context', form: 'snapshot', sections },
    },
    { role: 'user', content: [{ type: 'text', text: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' }], source: { kind: 'runtime-context' } },
  ] as never
  const history = historyFromMessages(messages, [], { includeDeveloper: false })
  assert.deepEqual(history, [
    { kind: 'user', text: '帮我写一个 HTML 简历模板' },
    { kind: 'note', text: `${sections[0]!.text}\n${sections[1]!.text}` },
  ])
  assert.equal(analyzeTurn(history).task, '帮我写一个 HTML 简历模板')
  assert.equal(runtimeCwd(history), '/Users/me/ws')
})

test('DSH time-context readings become a timestamp note, never the task', () => {
  // As the desktop app's standard preset sends them (rwkv-trace, 2026-11-06).
  const reading = 'Time sampled while preparing turn 1, step 1: 2026-11-06T15:45:09+08:00[Asia/Shanghai]\n'
    + 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n'
    + 'Elapsed since the preceding model-visible message: unavailable.'
  const later = 'Time sampled while preparing turn 1, step 4: 2026-11-06T15:56:10+08:00[Asia/Shanghai]\n'
    + 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n'
    + 'Elapsed since the preceding step context: 11m 1s.'
  const timeMessage = (text: string) => ({
    role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] },
  })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '帮我查一下 iPhone 最新的型号' }], source: { kind: 'user' } },
    timeMessage(reading),
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'web_search', arguments: '{"queries":["iPhone"]}' }] },
    { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'results' }] },
    timeMessage(later),
  ] as never
  const history = historyFromMessages(messages, [], { includeDeveloper: false, names: 'dsh' })
  assert.deepEqual(history.filter(item => item.kind === 'note'), [
    { kind: 'note', text: 'Current time: 2026-11-06T15:45:09+08:00[Asia/Shanghai].' },
    { kind: 'note', text: 'Current time: 2026-11-06T15:56:10+08:00[Asia/Shanghai].' },
  ])
  const state = analyzeTurn(history)
  assert.equal(state.task, '帮我查一下 iPhone 最新的型号')
  assert.equal(state.successKeys.size, 1)
})

test('date line: day precision, zone and UTC offset, last line of the system prompt', async () => {
  const at = Date.UTC(2026, 10, 6, 17, 30) // 01:30 on the 7th in Shanghai
  assert.equal(currentDateLine(at, 'Asia/Shanghai'), 'Current date: 2026-11-07 (Asia/Shanghai, UTC+08:00).')
  assert.equal(currentDateLine(at, 'UTC'), 'Current date: 2026-11-06 (UTC, UTC+00:00).')
  assert.equal(currentDateLine(at, 'America/New_York'), 'Current date: 2026-11-06 (America/New_York, UTC-05:00).')
  const line = currentDateLine(at, 'Asia/Shanghai')
  const generator = new ScriptedGenerator(['>x</think>ok'])
  await decideStep({ history: [{ kind: 'user', text: 'hi' }], tools, config: { ...harness, dateLine: line }, generator })
  const system = generator.prompts[0]!.split('\n\nUser: ')[0]!
  assert.ok(system.endsWith(`\n${line}`))
  const plain = new ScriptedGenerator(['>x</think>ok'])
  await decideStep({ history: [{ kind: 'user', text: 'hi' }], tools, config: harness, generator: plain })
  assert.equal(generator.prompts[0], plain.prompts[0]!.replace('\n\nUser: ', `\n${line}\n\nUser: `))
  // With the date in the system prompt, time-context readings stay out of the history.
  const reading = 'Time sampled while preparing turn 1, step 1: 2026-11-06T15:45:09+08:00[Asia/Shanghai]'
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: reading }], source: { kind: 'time-context', form: 'snapshot', sections: [] } },
  ] as never
  assert.deepEqual(historyFromMessages(messages, [], { includeDeveloper: false, dropTimeContext: true }), [{ kind: 'user', text: 'hi' }])
})

test('history JSON keeps < > & raw: no \\u003c for the model to copy into HTML arguments', () => {
  const html = '<p class="a">x & y</p>'
  assert.equal(recordToolCall('write', { file_path: 'a.html', content: html }), `<tool_call>{"name":"write","arguments":{"file_path":"a.html","content":${JSON.stringify(html)}}}</tool_call>`)
  assert.ok(!toolResponse('read', true, `1: ${html}`).includes('\\u003c'))
  assert.equal(promptJSON('a\u2028b'), '"a\\u2028b"')
})

test('DSH-named tools: value shapes 7B writes from other harnesses are repaired after coercion', () => {
  const byName = (name: string) => dshTools.find(tool => tool.name === name)!
  const grep = byName('grep')
  // <tool_calls> + OpenAI wrapper + Claude Code's output_mode, from a 7B rollout.
  assert.deepEqual(repairNativeValues(grep, { pattern: 'parse_duration', path: 'src', output_mode: 'content' }),
    { args: { pattern: 'parse_duration', path: 'src' }, repairs: ['unknown_arguments_dropped'] })
  assert.deepEqual(repairNativeValues(grep, { pattern: ['get_val', 'get_value'] }).args, { pattern: 'get_val|get_value' })
  // list_files{path} habit: glob has no pattern.
  assert.deepEqual(repairNativeValues(byName('glob'), { path: 'src/' }),
    { args: { path: 'src/', pattern: '*' }, repairs: ['glob_default_pattern'] })
  const read = byName('read')
  assert.deepEqual(repairNativeValues(read, coerceArguments({ file_path: 'a.py', offset: '0', limit: '20' }, read.schema)).args,
    { file_path: 'a.py', offset: 1, limit: 20 })
  const plain = { file_path: 'a.py', offset: 3 }
  assert.equal(repairNativeValues(read, plain).args, plain)
  // Trained-name tools keep their own path.
  const trained = buildCatalog(dshSchemas, { mode: 'mapped' }).find(tool => tool.name === 'list_files')!
  const args = { path: 'src' }
  assert.equal(repairNativeValues(trained, args).args, args)
})

test('outputRepairs off: near-miss output is a shape error, names and arguments pass through as written', async () => {
  // OpenAI wrapper parses with a repair; strict mode refuses it.
  const wrapped = '<tool_call>{"type":"function","function":{"name":"read_file","arguments":{"path":"b.txt"}}}</tool_call>'
  assert.equal(parseAction(wrapped, 'stop').type, 'tool')
  assert.equal(parseAction(wrapped, 'stop', { strict: true }).type, 'error')
  assert.equal(parseAction('Let me read it.\n<tool_call>{"name":"read_file","arguments":{"path":"b.txt"}}</tool_call>', 'stop', { strict: true }).type, 'error')
  assert.equal(parseAction('<tool_call>{"name":"read_file","arguments":{"path":"b.txt"}}</tool_call>', 'stop', { strict: true }).type, 'tool')

  const strict: HarnessConfig = { ...harness, outputRepairs: false }
  const traces: string[] = []
  const generator = new ScriptedGenerator(['>Need lines.</think><tool_call>{"name":"read_file","arguments":{"path":"b.txt","start_line":"5"}}'])
  const step = await decideStep({ history: afterRead, tools, config: strict, generator, hooks: { trace: trace => traces.push(`${trace.outcome}:${trace.repairs.join(',')}`) } })
  assert.equal(step.decision.type, 'tool')
  // "5" stays a string: DSH (or the mapping) reports it, the plugin does not coerce.
  assert.deepEqual(step.decision.type === 'tool' && step.decision.args, { path: 'b.txt', start_line: '5' })
  assert.deepEqual(traces, ['run:'])

  // An alias name is an unknown tool, not a rename.
  const aliased = new ScriptedGenerator(['>x</think><tool_call>{"name":"cat","arguments":{"path":"b.txt"}}', '>ok</think>done'])
  const after = await decideStep({ history: afterRead, tools, config: strict, generator: aliased })
  assert.match(aliased.prompts[1]!, /unknown tool \\"cat\\"/)
  assert.deepEqual(after.decision, { type: 'final', text: 'done', via: 'model' })
})

test('guards off: no duplicate gate, no re-ask; unparseable output becomes the answer as written', async () => {
  const bare: HarnessConfig = { ...harness, guards: false }
  const repeat = new ScriptedGenerator(['>again</think><tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}'])
  const ran = await decideStep({ history: afterRead, tools, config: bare, generator: repeat })
  assert.equal(ran.decision.type, 'tool')
  assert.equal(repeat.prompts.length, 1)

  const broken = new ScriptedGenerator(['>x</think><tool_call>{"name":"read_file","arguments":{"path":'])
  const outcomes: string[] = []
  const answered = await decideStep({ history: afterRead, tools, config: bare, generator: broken, hooks: { trace: trace => outcomes.push(trace.outcome) } })
  assert.equal(broken.prompts.length, 1)
  assert.equal(answered.decision.type === 'final' && answered.decision.via, 'raw')
  assert.match(answered.decision.type === 'final' ? answered.decision.text : '', /<tool_call>/)
  assert.deepEqual(outcomes, ['raw'])

  // With guards on the same output is re-asked.
  const guarded = new ScriptedGenerator(['>x</think><tool_call>{"name":"read_file","arguments":{"path":', '>ok</think>BUDGET-READY'])
  const fixed = await decideStep({ history: afterRead, tools, config: harness, generator: guarded })
  assert.equal(guarded.prompts.length, 2)
  assert.deepEqual(fixed.decision, { type: 'final', text: 'BUDGET-READY', via: 'model' })
})

test('a filled bash description is its own repair, not an argument alias', async () => {
  const generator = new ScriptedGenerator(['>x</think><tool_call>{"name":"bash","arguments":{"command":"ls -la"}}'])
  const step = await decideStep({ history: [{ kind: 'user', text: 'ls' }], tools: dshTools, config: harness, generator })
  assert.deepEqual(step.decision.type === 'tool' && step.decision.repairs, ['bash_description_filled'])
})

test('toolOverrides replace description and named argument placeholders only', () => {
  const offered: DshToolSchema[] = [{
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: { type: 'object', required: ['file_path', 'old_string', 'new_string'], properties: {
      file_path: { type: 'string', description: 'Path to edit.' },
      old_string: { type: 'string', description: 'Literal text to replace.' },
      new_string: { type: 'string', description: 'Literal replacement text.' },
    } },
  }]
  const plain = buildCatalog(offered, { mode: 'mapped', names: 'dsh' })
  const same = buildCatalog(offered, { mode: 'mapped', names: 'dsh', overrides: {} })
  assert.deepEqual(same.map(t => [t.description, t.arguments]), plain.map(t => [t.description, t.arguments]))
  const [edited] = buildCatalog(offered, { mode: 'mapped', names: 'dsh', overrides: { edit: { description: 'D', arguments: { old_string: 'O', nope: 'x' } } } })
  assert.equal(edited!.description, 'D')
  assert.equal(edited!.arguments, '{"file_path":"Path to edit","old_string":"O","new_string":"Literal replacement text"}')
})
