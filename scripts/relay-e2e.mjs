// End-to-end relay check without a model: a fake iRWKV server answers with
// scripted tool calls, a recap, and a final answer while DSH runs the real
// loop. Needs the sibling deepseek-harness checkout (it runs DSH from source).
//
//   node scripts/relay-e2e.mjs
//
// Asserts: a mid-turn card and a turn-boundary card are generated, every recap
// request carries the nudge, the last prompt is turn 2 rendered as cards, the
// old tool output is gone from it, a step after the cut keeps the latest output
// verbatim, and the card sidecar exists. Exit code 0 = all checks passed.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = resolve(PLUGIN, '../deepseek-harness')
const ROOT = join(tmpdir(), 'rwkv-relay-e2e')
const PORT = 18099
const THINK_END = '<｜end▁of▁thinking｜>'
const MARKER_A = 'AAAA-observer-alpha'
const MARKER_B = 'BBBB-observer-beta'

if (!existsSync(join(DSH, 'apps/cli/src/bin.ts'))) {
  console.error(`relay-e2e: no DSH source checkout at ${DSH} (needed to run DSH from source)`)
  process.exit(2)
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'ws'), { recursive: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
writeFileSync(join(ROOT, 'ws/a.txt'), `${MARKER_A}\n${'a'.repeat(700)}\n`)
writeFileSync(join(ROOT, 'ws/b.txt'), `${MARKER_B}\n${'b'.repeat(700)}\n`)

const prompts = []
let actions = 0
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    const prompt = JSON.parse(body).prompt
    prompts.push(prompt)
    let text
    if (prompt.includes('Stop work. Write only a concise handoff recap')) {
      text = `>Summarising.${THINK_END}1. Objective: summarise the work so far.\n`
        + '2. Established facts: one of a.txt / b.txt was read; it holds an observer marker.\n'
        + '3. Applied changes: none.\n4. Verification: none.\n5. Dead ends: none.\n6. Remaining plan: continue.'
    } else if (++actions === 1) {
      text = '>Look.</think><tool_call>{"name":"bash","arguments":{"command":"cat a.txt"}}</tool_call>'
    } else if (actions === 2) {
      text = '>Look again.</think><tool_call>{"name":"bash","arguments":{"command":"cat b.txt"}}</tool_call>'
    } else {
      text = '>Done.</think>Both files contain an alpha and a beta marker.'
    }
    const payload = {
      choices: [{ index: 0, text, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 12 },
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

function run(args, stdin) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('node', [join(PLUGIN, 'scripts/headless.ts'), ...args], {
      cwd: join(ROOT, 'ws'),
      env: { ...process.env, DSH_ROOT: DSH, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`headless timed out\n${err.slice(-2000)}`)) }, 180_000)
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`headless exited ${code}\n${err.slice(-2000)}`))
      else resolveRun(out)
    })
    child.stdin.end(stdin)
  })
}

function sessionOf(output) {
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'session' && event.sessionId) return String(event.sessionId)
    } catch {
      // not a JSON event
    }
  }
  return ''
}

function traces(session) {
  for (const workspace of readdirSync(join(ROOT, 'home/sessions'))) {
    const file = join(ROOT, 'home/sessions', workspace, session, 'rwkv-trace.jsonl')
    if (existsSync(file)) {
      return { file, records: readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    }
  }
  throw new Error(`no trace for session ${session}`)
}

// One pair (~430 tokens) fits, two do not: a mid-turn card covers the first.
const config = JSON.stringify({ historyMode: 'relay', relayBudgetTokens: 800, relayCardMaxTokens: 256 })
const common = [
  '--backend', 'irwkv',
  '--base-url', `http://127.0.0.1:${PORT}`,
  '--model', 'fake',
  '--home', join(ROOT, 'home'),
  '--plugin-config', config,
  '--max-steps', '6',
]

try {
  await new Promise(listen => server.listen(PORT, '127.0.0.1', listen))
  const first = await run([...common, 'Read a.txt and b.txt and tell me what they contain.'], '')
  const session = sessionOf(first)
  if (!session) throw new Error('no session id in the first run')
  const second = await run([...common, '--session-id', session, 'Now add a one-line note to README.md about it.'], '')
  if (!sessionOf(second)) throw new Error('no session id in the second run')

  const { file, records } = traces(session)
  const cards = records.filter(record => record.stage === 'card')
  const decisions = records.filter(record => record.stage === 'decision')
  const last = decisions[decisions.length - 1]
  console.log('trace:', file)
  console.log('generations:', records.map(record => record.stage).join(','))
  console.log('card count:', cards.length)

  const checks = [
    ['a mid-turn and a turn-boundary recap were generated', cards.length >= 2],
    ['every recap prompt carries the nudge', cards.every(record => record.prompt.includes('Stop work. Write only a concise handoff recap'))],
    ['the last prompt is turn 2 rendered as cards', last.prompt.includes('[Handoff recap · turn 1 · part 1]')],
    ['the last prompt holds the new task', last.prompt.includes('Now add a one-line note')],
    ['the old tool output is gone', !last.prompt.includes(MARKER_A) && !last.prompt.includes(MARKER_B)],
    ['the first summary saw the first output only', cards.some(record => record.prompt.includes(MARKER_A) && !record.prompt.includes(MARKER_B))],
    ['a step kept the latest output verbatim', decisions.some(record => record.prompt.includes(MARKER_B) && !record.prompt.includes(MARKER_A))],
    ['the sidecar exists', existsSync(file.replace(/rwkv-trace\.jsonl$/, 'rwkv-relay.jsonl'))],
  ]
  let failed = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
    if (!ok) failed++
  }
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  server.close()
}
