import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerateRequest, GenerateResult, Generator } from '../src/backend/generator.ts'
import { decideStep, DEFAULT_HARNESS, type GenerationTrace, type HarnessConfig } from '../src/core/agent.ts'
import { analyzeTurn, type HistoryItem } from '../src/core/policy.ts'
import {
  cleanCardText,
  cardEntries,
  itemTokens,
  fallbackCard,
  makeCard,
  planRelay,
  recapEntries,
  validCards,
  type RelayCard,
} from '../src/core/relay.ts'
import { buildCatalog } from '../src/core/tools.ts'

class ScriptedGenerator implements Generator {
  readonly prompts: string[] = []
  readonly requests: GenerateRequest[] = []
  private readonly outputs: string[]

  constructor(outputs: string[]) {
    this.outputs = [...outputs]
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.prompts.push(request.prompt)
    this.requests.push(request)
    const next = this.outputs.shift()
    if (next === undefined) throw new Error('no scripted output left')
    return Promise.resolve({ text: next, finish: 'stop', completionTokens: 10 })
  }
}

const tools = buildCatalog([
  { name: 'read', description: '', parameters: {} },
  { name: 'write', description: '', parameters: {} },
], { mode: 'mapped' })

const THINK_END = '</think>'
/** A recap generation as the thinking wire shows it: withheld opener, then the card. */
const recapOutput = (text: string) => `>I will summarise the work so far.${THINK_END}${text}`

const LONG = 'x'.repeat(1200)

/** Turn 1: read a, read b, edit a, run tests. */
const turnOne: HistoryItem[] = [
  { kind: 'user', text: 'Rename the timeout field in a.txt and run the tests.' },
  { kind: 'call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
  { kind: 'result', id: 'c1', name: 'read_file', ok: true, text: `1\talpha ${LONG}` },
  { kind: 'call', id: 'c2', name: 'read_file', args: { path: 'b.txt' } },
  { kind: 'result', id: 'c2', name: 'read_file', ok: true, text: `1\tbeta ${LONG}` },
  { kind: 'call', id: 'c3', name: 'write_file', args: { file_path: 'a.txt', content: 'timeout_ms = 30' } },
  { kind: 'result', id: 'c3', name: 'write_file', ok: true, text: 'wrote 1 line' },
  { kind: 'call', id: 'c4', name: 'bash', args: { command: 'python -m pytest -q' } },
  { kind: 'result', id: 'c4', name: 'bash', ok: false, text: 'FAILED test_a.py::test_timeout - assert 10 == 30' },
]

test('relay: a new user turn cards the finished work and keeps the new task', async () => {
  const generator = new ScriptedGenerator([
    '>Start.</think><tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}', // turn 1 action
    recapOutput('1. Objective: rename the timeout field.\n3. Applied changes: a.txt (unverified).'), // recap
    '>Check the failure.</think><tool_call>{"name":"read_file","arguments":{"path":"test_a.py"}}', // turn 2 action
  ])
  const saved: RelayCard[] = []
  const config: HarnessConfig = { ...DEFAULT_HARNESS, maxSteps: 5, relay: { budgetTokens: 100_000, cardMaxTokens: 256 } }
  const first = await decideStep({ history: turnOne, tools, config, generator, relay: { cards: [], save: card => saved.push(card) } })
  assert.equal(first.decision.type, 'tool')
  assert.equal(generator.prompts.length, 1)

  // Turn 2 arrives; the plugin runs in a new request of the same session.
  const turnTwo: HistoryItem[] = [...turnOne, { kind: 'user', text: 'Now add a short note about it to README.md.' }]
  const second = await decideStep({ history: turnTwo, tools, config, generator, relay: { cards: saved, save: card => saved.push(card) } })
  assert.equal(second.decision.type, 'tool')
  assert.equal(generator.prompts.length, 3)

  const recap = generator.prompts[1]!
  assert.match(recap, /Stop work\. Write only a concise handoff recap/)
  assert.match(recap, /the user's next instruction follows/)
  assert.doesNotMatch(recap, /Now add a short note/) // the new task is not part of the recap
  assert.match(recap, /Rename the timeout field/)
  assert.match(recap, /FAILED test_a\.py::test_timeout/) // the covered range ends at the new task

  const execution = generator.prompts[2]!
  assert.match(execution, /\[Handoff recap · turn 1 · part 1\]/)
  assert.match(execution, /Task: Rename the timeout field/)
  assert.match(execution, /1\. Objective: rename the timeout field/)
  assert.match(execution, /Now add a short note/)
  assert.equal(execution.split('Now add a short note about it to README.md.').length - 1, 1)
  assert.ok(execution.endsWith('User: Now add a short note about it to README.md.\n\nAssistant: <think'))
  assert.doesNotMatch(execution, /FAILED test_a\.py::test_timeout/) // covered by the card
  assert.doesNotMatch(execution, /1\talpha/) // the old tool result is gone

  assert.equal(saved.length, 1)
  assert.equal(saved[0]!.at, turnOne.length)
  assert.equal(saved[0]!.turn, 1)
  assert.equal(saved[0]!.task, 'Rename the timeout field in a.txt and run the tests.')
  // The card survives a resumed process: the same history validates it.
  assert.equal(validCards(turnTwo, saved).length, 1)
})

test('relay: an over-budget leg is cut without splitting a call from its result', () => {
  const lastCall = turnOne.length - 2 // c4
  const budget = itemTokens(turnOne.slice(0, 6))
  const plan = planRelay(turnOne, [], { budgetTokens: budget, cardMaxTokens: 256 })
  assert.ok(plan.need !== undefined)
  assert.equal(plan.need!.turnEnd, false)
  assert.equal(turnOne[plan.need!.end]?.kind, 'call') // never starts the tail with a result
  assert.ok(plan.need!.end <= lastCall) // the most recent pair stays verbatim
  assert.ok(plan.need!.end > 0)
  const tail = turnOne.slice(plan.need!.end)
  assert.ok(tail.some(item => item.kind === 'result' && item.text.includes('FAILED')))
  const card = makeCard(turnOne, plan.need!, 'recap body')
  const after = planRelay([...turnOne, { kind: 'assistant', text: 'done' }], [card], { budgetTokens: 100_000, cardMaxTokens: 256 })
  assert.equal(after.cards.length, 1)
  assert.equal(after.need, undefined)
})

test('relay: the recap request has no per-step reminders; the execution prompt does', async () => {
  const budget = itemTokens(turnOne.slice(0, 6))
  const generator = new ScriptedGenerator([
    recapOutput('recap: a.txt was edited; pytest failed.'),
    '>Done.</think>All set.',
  ])
  const config: HarnessConfig = { ...DEFAULT_HARNESS, maxSteps: 5, relay: { budgetTokens: budget, cardMaxTokens: 256 } }
  await decideStep({ history: turnOne, tools, config, generator, relay: { cards: [] } })
  assert.doesNotMatch(generator.prompts[0]!, /Use the Tool results above/)
  assert.match(generator.prompts[1]!, /Use the Tool results above/)
  assert.ok(generator.prompts[1]!.endsWith('Choose a different useful tool or answer with the limitation. Do not guess.\n\nUser: Rename the timeout field in a.txt and run the tests.\n\nAssistant: <think'))
})

test('relay: card blocks number the parts and repeat the task only on the first', () => {
  const entries = cardEntries([
    { at: 3, turn: 1, task: 'first task', text: 'one', hash: 'a' },
    { at: 6, turn: 1, task: 'first task', text: 'two', hash: 'b' },
    { at: 9, turn: 2, task: 'second task', text: 'three', hash: 'c' },
  ])
  assert.deepEqual(entries.map(entry => entry.text.split('\n')[0]), [
    '[Handoff recap · turn 1 · part 1]',
    '[Handoff recap · turn 1 · part 2]',
    '[Handoff recap · turn 2 · part 1]',
  ])
  assert.match(entries[0]!.text, /^\[Handoff recap · turn 1 · part 1\]\nTask: first task\none$/)
  assert.doesNotMatch(entries[1]!.text, /Task:/)
  assert.match(entries[2]!.text, /Task: second task/)
})

test('relay: the duplicate gate restarts at the leg; steps still count from the turn start', () => {
  const duplicateFrom = 4 // after the second result: the first read is no longer "seen"
  const state = analyzeTurn(turnOne, { duplicateFrom })
  assert.equal(state.steps, 4)
  assert.ok(!state.successKeys.has('read_file\u0000{"path":"a.txt"}'))
  // The later write clears earlier keys; the failure stays in the current epoch.
  assert.ok(state.successKeys.has('write_file\u0000{"content":"timeout_ms = 30","file_path":"a.txt"}'))
  assert.ok(state.failedEpochs.has('bash\u0000{"command":"python -m pytest -q"}'))
})

test('relay: card text drops a think block and refuses protocol garbage', () => {
  assert.equal(cleanCardText(`<think>I read the file.${THINK_END}1. Objective: x`), '1. Objective: x')
  assert.equal(cleanCardText('<think>unfinished'), '')
  assert.equal(cleanCardText('<tool_call>{"name":"read_file"}</tool_call>'), '')
  assert.equal(cleanCardText('1. Objective: keep <tool_response> out'), '1. Objective: keep  out')
})

test('relay: a recap that writes a tool call falls back to the deterministic card', async () => {
  const generator = new ScriptedGenerator([
    '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>',
    '>Reading.</think><tool_call>{"name":"read_file","arguments":{"path":"test_a.py"}}',
  ])
  const budget = itemTokens(turnOne.slice(0, 6))
  const config: HarnessConfig = { ...DEFAULT_HARNESS, maxSteps: 5, relay: { budgetTokens: budget, cardMaxTokens: 256 } }
  const saved: RelayCard[] = []
  await decideStep({ history: turnOne, tools, config, generator, relay: { cards: [], save: card => saved.push(card) } })
  assert.equal(saved.length, 1)
  assert.match(saved[0]!.text, /1\. Objective: Rename the timeout field/)
  assert.match(saved[0]!.text, /read_file a\.txt -> ok/)
  assert.doesNotMatch(saved[0]!.text, /FAILED/) // the failing check stays in the verbatim tail
  assert.match(generator.prompts[1]!, /\[Handoff recap · turn 1 · part 1\]\nTask: /)
})

test('relay: a card whose covered history changed is dropped', () => {
  const card = makeCard(turnOne, { start: 0, end: turnOne.length, turnEnd: true, turn: 1, task: 'x' }, 'body')
  assert.equal(validCards(turnOne, [card]).length, 1)
  const rewritten: HistoryItem[] = turnOne.map((item, index) => index === 2 ? { ...item, text: 'different' } : item)
  assert.equal(validCards(rewritten, [card]).length, 0)
})

test('relay: the fallback card lists the exact changes and the failure', () => {
  const card = fallbackCard(turnOne, { start: 0, end: turnOne.length, turnEnd: false, turn: 1, task: 'x' })
  assert.match(card, /1\. Objective: x/)
  assert.match(card, /read_file a\.txt -> ok/)
  assert.match(card, /3\. Applied changes: a\.txt/)
  assert.match(card, /4\. Verification:\n- python -m pytest -q -> failed/)
  assert.match(card, /FAILED test_a\.py::test_timeout/)
})

// The trace is how a run is inspected afterwards: a card must show up as its
// own generation carrying the exact range it replaced, or the RWKV tab cannot
// answer "where did the context get cut and what did the model see instead".
test('relay: the trace records the card generation and the range it cut', async () => {
  const generator = new ScriptedGenerator([
    '>Start.</think><tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}',
    recapOutput('1. Objective: rename the timeout field.'),
    '>Check the failure.</think><tool_call>{"name":"read_file","arguments":{"path":"test_a.py"}}',
  ])
  const traces: GenerationTrace[] = []
  const config: HarnessConfig = { ...DEFAULT_HARNESS, maxSteps: 5, relay: { budgetTokens: 100_000, cardMaxTokens: 256 } }
  const saved: RelayCard[] = []
  const first = await decideStep({ history: turnOne, tools, config, generator, relay: { cards: [], save: card => saved.push(card) } })
  assert.equal(first.decision.type, 'tool')
  const turnTwo: HistoryItem[] = [...turnOne, { kind: 'user', text: 'Now add a short note about it to README.md.' }]
  await decideStep({
    history: turnTwo, tools, config, generator,
    relay: { cards: saved, save: card => saved.push(card) },
    hooks: { trace: trace => { traces.push(trace) } },
  })
  const cards = traces.filter(trace => trace.stage === 'card')
  assert.equal(cards.length, 1, 'the card generation is traced')
  const card = cards[0]!
  assert.equal(card.outcome, 'card')
  assert.match(card.prompt, /Stop work\. Write only a concise handoff recap/, 'the cut prompt itself is kept')
  assert.ok(card.relay !== undefined, 'the record says what the card replaced')
  assert.equal(card.relay!.from, 0)
  assert.equal(card.relay!.to, turnOne.length)
  assert.equal(card.relay!.turn, 1)
  assert.equal(card.relay!.fallback, false)
  assert.match(card.relay!.card, /1\. Objective: rename the timeout field/)
  // The decision that followed saw the card, not the covered tool results.
  const execution = traces.filter(trace => trace.stage === 'decision').at(0)!
  assert.match(execution.prompt, /\[Handoff recap · turn 1 · part 1\]/)
  assert.doesNotMatch(execution.prompt, /1\talpha/)
})

test('relay: a card that fell back to the summary is marked as such in the trace', async () => {
  const generator = new ScriptedGenerator([
    '>Start.</think><tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}',
    recapOutput(''), // the model wrote nothing usable
    '>Check the failure.</think><tool_call>{"name":"read_file","arguments":{"path":"test_a.py"}}',
  ])
  const traces: GenerationTrace[] = []
  const config: HarnessConfig = { ...DEFAULT_HARNESS, maxSteps: 5, relay: { budgetTokens: 100_000, cardMaxTokens: 256 } }
  const saved: RelayCard[] = []
  await decideStep({ history: turnOne, tools, config, generator, relay: { cards: [], save: card => saved.push(card) } })
  const turnTwo: HistoryItem[] = [...turnOne, { kind: 'user', text: 'Now add a short note about it to README.md.' }]
  await decideStep({
    history: turnTwo, tools, config, generator,
    relay: { cards: saved, save: card => saved.push(card) },
    hooks: { trace: trace => { traces.push(trace) } },
  })
  const card = traces.find(trace => trace.stage === 'card')!
  assert.equal(card.outcome, 'card-empty')
  assert.equal(card.relay?.fallback, true)
  assert.ok((card.relay?.card.length ?? 0) > 0, 'the summary the model will read is recorded')
})

test('relay: recapEntries omits prior-turn cards and keeps at most the last same-turn card', () => {
  const history: HistoryItem[] = [
    ...turnOne,
    { kind: 'user', text: 'Turn 2 question' },
    { kind: 'call', id: 't2c1', name: 'read_file', args: { path: 'c.txt' } },
    { kind: 'result', id: 't2c1', name: 'read_file', ok: true, text: 'c content' },
    { kind: 'call', id: 't2c2', name: 'read_file', args: { path: 'd.txt' } },
    { kind: 'result', id: 't2c2', name: 'read_file', ok: true, text: 'd content' },
    { kind: 'call', id: 't2c3', name: 'read_file', args: { path: 'e.txt' } },
    { kind: 'result', id: 't2c3', name: 'read_file', ok: true, text: 'e content' },
  ]
  const cardTurn1 = makeCard(history, { start: 0, end: turnOne.length, turnEnd: true, turn: 1, task: turnOne[0]!.text }, 'turn 1 recap body')
  const firstPartEnd = turnOne.length + 3 // user + t2c1 call/result
  const secondPartEnd = turnOne.length + 5 // + t2c2 call/result
  const thirdPartEnd = turnOne.length + 7 // + t2c3 call/result

  // First card of Turn 2: must NOT include Turn 1's card.
  const entriesPart1 = recapEntries(
    history,
    [cardTurn1],
    { start: turnOne.length, end: firstPartEnd, turnEnd: false, turn: 2, task: 'Turn 2 question' },
    { tools, postToolReminder: '' },
  )
  assert.ok(!entriesPart1.some(e => e.text.includes('turn 1 recap body')))
  assert.equal(entriesPart1[0]?.text, 'Turn 2 question')

  // Third card of Turn 2: includes only part 2 of Turn 2 (with Task), not Turn 1 and not part 1 of Turn 2.
  const cardTurn2Part1 = makeCard(history, { start: turnOne.length, end: firstPartEnd, turnEnd: false, turn: 2, task: 'Turn 2 question' }, 'turn 2 part 1 body')
  const cardTurn2Part2 = makeCard(history, { start: firstPartEnd, end: secondPartEnd, turnEnd: false, turn: 2, task: 'Turn 2 question' }, 'turn 2 part 2 body')
  const entriesPart3 = recapEntries(
    history,
    [cardTurn1, cardTurn2Part1, cardTurn2Part2],
    { start: secondPartEnd, end: thirdPartEnd, turnEnd: true, turn: 2, task: 'Turn 2 question' },
    { tools, postToolReminder: '' },
  )
  assert.ok(!entriesPart3.some(e => e.text.includes('turn 1 recap body')))
  assert.ok(!entriesPart3.some(e => e.text.includes('turn 2 part 1 body')))
  assert.match(entriesPart3[0]!.text, /^\[Handoff recap · turn 2 · part 2\]\nTask: Turn 2 question\nturn 2 part 2 body$/)
})

test('relay: retry and answer-stage additions stay before the trailing user task', async () => {
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Check a.txt' },
    { kind: 'call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
    { kind: 'result', id: 'c1', name: 'read_file', ok: true, text: 'hello' },
  ]
  const generator = new ScriptedGenerator([
    `>Repeat.${THINK_END}<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}`,
    `>Done.${THINK_END}hello`,
  ])
  const config: HarnessConfig = { ...DEFAULT_HARNESS, maxSteps: 5, relay: { budgetTokens: 100_000, cardMaxTokens: 256 } }
  const step = await decideStep({ history, tools, config, generator, relay: { cards: [] } })
  assert.equal(step.decision.type, 'final')
  assert.equal(generator.prompts.length, 2)
  const retryPrompt = generator.prompts[1]!
  assert.match(retryPrompt, /repeats a successful call/)
  assert.ok(retryPrompt.endsWith('\n\nUser: Check a.txt\n\nAssistant: <think'))
})

test('relay: web_fetch and web_search stay deduplicated across mid-turn card cuts', async () => {
  const { readFileSync } = await import('node:fs')
  const dshSchemas = JSON.parse(readFileSync(new URL('./fixtures/dsh-tool-schemas.json', import.meta.url), 'utf8'))
  const webTools = buildCatalog(dshSchemas, { mode: 'mapped', names: 'dsh' })
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Find RWKV engine info' },
    { kind: 'call', id: 'w1', name: 'web_search', args: { queries: ['RWKV C++ engine 2025 2026'] } },
    { kind: 'result', id: 'w1', name: 'web_search', ok: true, text: `Results ${LONG}` },
    { kind: 'call', id: 'w2', name: 'web_fetch', args: { url: 'https://example.com/repo#1' } },
    { kind: 'result', id: 'w2', name: 'web_fetch', ok: true, text: 'Page not found (404)' },
  ]
  // Simulate a mid-turn card covering w1..w2 so legStart moves past them.
  const state = analyzeTurn(history, { duplicateFrom: history.length })
  assert.equal(state.webCalls, 2)
  assert.ok(state.seenSearchQueries.has('2025 2026 c++ engine rwkv'))

  // Re-fetching without #1 or re-searching same words in reversed order must hit duplicate gate.
  const generator = new ScriptedGenerator([
    `>Retry URL.${THINK_END}<tool_call>{"name":"web_fetch","arguments":{"url":"https://example.com/repo"}}`,
    `>Re-search.${THINK_END}<tool_call>{"name":"web_search","arguments":{"queries":["rwkv engine c++ 2026 2025"]}}`,
    `>Okay.${THINK_END}Here is the summary.`,
  ])
  const card = makeCard(history, { start: 0, end: 3, turnEnd: false, turn: 1, task: 'Find RWKV engine info' }, '1. Objective: x')
  const step = await decideStep({
    history,
    tools: webTools,
    config: { ...DEFAULT_HARNESS, maxSteps: 10, relay: { budgetTokens: 100_000, cardMaxTokens: 256 } },
    generator,
    relay: { cards: [card] },
  })
  assert.deepEqual(step.decision, { type: 'final', text: 'Here is the summary.', via: 'answer-stage' })
  assert.match(generator.prompts[1]!, /repeats a successful call/)
  // answerStage strips "Call another tool" and puts the closeout ban AFTER the user task.
  const answerPrompt = generator.prompts[2]!
  assert.doesNotMatch(answerPrompt, /Call another tool only for a specific missing fact/)
  assert.ok(answerPrompt.indexOf('User: Find RWKV engine info') < answerPrompt.indexOf('Tool execution is complete and tools are now unavailable'))
  assert.ok(answerPrompt.endsWith('If they are insufficient, say what could not be verified.\n\nAssistant: <think'))
})

test('relay: card truncated mid-body after </think> continues once cleanly', async () => {
  class CardLengthGenerator implements Generator {
    readonly prompts: string[] = []
    private calls = 0
    generate(request: GenerateRequest): Promise<GenerateResult> {
      this.prompts.push(request.prompt)
      this.calls++
      if (this.calls === 1) {
        return Promise.resolve({ text: `>Plan.${THINK_END}1. Objective: x\n2. Facts: partial`, finish: 'length', completionTokens: 256 })
      }
      if (this.calls === 2) {
        return Promise.resolve({ text: ' and complete.\n6. Remaining plan: done.', finish: 'stop', completionTokens: 20 })
      }
      return Promise.resolve({ text: `>Answer.${THINK_END}Done.`, finish: 'stop', completionTokens: 10 })
    }
  }
  const generator = new CardLengthGenerator()
  const saved: RelayCard[] = []
  const budget = itemTokens(turnOne.slice(0, 6))
  await decideStep({
    history: turnOne,
    tools,
    config: { ...DEFAULT_HARNESS, maxSteps: 10, relay: { budgetTokens: budget, cardMaxTokens: 256 } },
    generator,
    relay: { cards: [], save: card => saved.push(card) },
  })
  assert.equal(saved.length, 1)
  assert.match(saved[0]!.text, /partial and complete\./)
  assert.match(saved[0]!.text, /6\. Remaining plan: done\./)
})
