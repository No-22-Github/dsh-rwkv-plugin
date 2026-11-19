import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerateRequest, GenerateResult, Generator } from '../src/backend/generator.ts'
import { decideStep, DEFAULT_HARNESS, type HarnessConfig } from '../src/core/agent.ts'
import { analyzeTurn, type HistoryItem } from '../src/core/policy.ts'
import { buildCatalog } from '../src/core/tools.ts'
import {
  applyTodoPlan,
  applyTodoUpdate,
  foldWorklist,
  formatWorklist,
  projectNativeTodos,
  TODO_PLAN_TOOL,
  TODO_UPDATE_TOOL,
  WORKLIST_CHECKPOINT_NUDGE,
  WORKLIST_INIT_NUDGE,
} from '../src/core/worklist.ts'

class ScriptedGenerator implements Generator {
  readonly prompts: string[] = []
  private readonly outputs: string[]

  constructor(outputs: string[]) {
    this.outputs = [...outputs]
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.prompts.push(request.prompt)
    const next = this.outputs.shift()
    if (next === undefined) throw new Error('no scripted output left')
    return Promise.resolve({ text: next, finish: 'stop', completionTokens: 10 })
  }
}

const offeredWithTodo = [
  { name: 'read', description: 'Read a file.', parameters: { properties: { file_path: { type: 'string' } } } },
  { name: 'write', description: 'Write a file.', parameters: { properties: { file_path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'todo_write', description: 'Stock DSH todo.', parameters: { properties: { todos: { type: 'array' } } } },
  { name: TODO_PLAN_TOOL, description: 'Plan work.', parameters: { properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] } },
  {
    name: TODO_UPDATE_TOOL,
    description: 'Update item.',
    parameters: {
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['in_progress', 'completed', 'dropped'] },
        note: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['id', 'status'],
    },
  },
]

test('worklist: applyTodoPlan activates #1 and preserves completed notes on mid-turn replan', () => {
  const initial = applyTodoPlan([], ['Locate token config', 'Change default TTL to 3600s', 'Run unit tests'])
  assert.ok(Array.isArray(initial))
  assert.equal(initial.length, 3)
  assert.equal(initial[0]!.status, 'in_progress')
  assert.equal(initial[1]!.status, 'pending')

  // Missing note on completed is rejected.
  const missingNote = applyTodoUpdate(initial, { id: 1, status: 'completed' })
  assert.equal(typeof missingNote, 'string')
  assert.match(missingNote as string, /note is required/)

  // Valid completion records note and auto-advances #2 to in_progress.
  const doneOne = applyTodoUpdate(initial, {
    id: 1,
    status: 'completed',
    note: 'src/auth/jwt.ts:18 DEFAULT_EXP=900',
  })
  assert.equal(typeof doneOne, 'object')
  if (typeof doneOne === 'string') throw new Error(doneOne)
  assert.equal(doneOne.noted, true)
  assert.equal(doneOne.items[0]!.status, 'completed')
  assert.equal(doneOne.items[0]!.note, 'src/auth/jwt.ts:18 DEFAULT_EXP=900')
  assert.equal(doneOne.items[1]!.status, 'in_progress')

  // Mid-turn replan splits remaining work while locking #1 and its note.
  const replanned = applyTodoPlan(doneOne.items, [
    'Update src/auth/jwt.ts DEFAULT_EXP to 3600',
    'Sync config/default.json tokenTtl',
    'Add expiry test and run npm test',
  ])
  assert.ok(Array.isArray(replanned))
  assert.equal(replanned.length, 4)
  assert.equal(replanned[0]!.status, 'completed')
  assert.equal(replanned[0]!.note, 'src/auth/jwt.ts:18 DEFAULT_EXP=900')
  assert.equal(replanned[1]!.status, 'in_progress')
  assert.equal(replanned[1]!.content, 'Update src/auth/jwt.ts DEFAULT_EXP to 3600')
  assert.equal(replanned[2]!.status, 'pending')
})

test('worklist: catalog hides todo_write when todo_plan is active, and hides todo_* when excluded', () => {
  const active = buildCatalog(offeredWithTodo, { mode: 'passthrough', names: 'dsh' })
  assert.ok(active.some(t => t.name === TODO_PLAN_TOOL))
  assert.ok(active.some(t => t.name === TODO_UPDATE_TOOL))
  assert.ok(!active.some(t => t.name === 'todo_write'))

  const fullMode = buildCatalog(offeredWithTodo, {
    mode: 'mapped',
    names: 'dsh',
    exclude: [TODO_PLAN_TOOL, TODO_UPDATE_TOOL],
  })
  assert.ok(!fullMode.some(t => t.name === TODO_PLAN_TOOL))
  assert.ok(!fullMode.some(t => t.name === TODO_UPDATE_TOOL))
})

test('worklist: gentle folding keeps initial todo_plan + latest 2 workspace pairs while folding older exploration', async () => {
  const tools = buildCatalog(offeredWithTodo, { mode: 'mapped', names: 'dsh' })
  const listAfterOne = formatWorklist([
    { id: 1, status: 'completed', content: 'Locate auth config', note: 'src/auth/jwt.ts:18 DEFAULT_EXP=900' },
    { id: 2, status: 'in_progress', content: 'Edit DEFAULT_EXP to 3600' },
  ])
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Change login TTL to 3600 and verify.' },
    { kind: 'call', id: 'c1', name: TODO_PLAN_TOOL, args: { items: ['Locate auth config', 'Edit DEFAULT_EXP to 3600'] } },
    { kind: 'result', id: 'c1', name: TODO_PLAN_TOOL, ok: true, text: 'Todo list:\n[1] (in_progress) Locate auth config\n[2] (pending) Edit DEFAULT_EXP to 3600' },
    { kind: 'call', id: 'c2', name: 'read', args: { file_path: 'src/old-explore.ts' } },
    { kind: 'result', id: 'c2', name: 'read', ok: true, text: '// FOLDED_EXPLORATION_MARKER' },
    { kind: 'call', id: 'c3', name: 'read', args: { file_path: 'src/other.ts' } },
    { kind: 'result', id: 'c3', name: 'read', ok: true, text: '// SECOND_FOLDED_MARKER' },
    { kind: 'call', id: 'c4', name: 'read', args: { file_path: 'src/auth/jwt.ts' } },
    { kind: 'result', id: 'c4', name: 'read', ok: true, text: '18: export const DEFAULT_EXP = 900 // KEPT_RECENT_PAIR_1' },
    { kind: 'call', id: 'c5', name: 'bash', args: { command: 'npm test' } },
    { kind: 'result', id: 'c5', name: 'bash', ok: true, text: 'KEPT_RECENT_PAIR_2\n[exit code: 0]' },
    { kind: 'call', id: 'c6', name: TODO_UPDATE_TOOL, args: { id: 1, status: 'completed', note: 'src/auth/jwt.ts:18 DEFAULT_EXP=900' } },
    { kind: 'result', id: 'c6', name: TODO_UPDATE_TOOL, ok: true, text: listAfterOne },
  ]

  // Re-reading folded `src/old-explore.ts` after checkpoint must NOT be blocked as duplicate.
  const gen = new ScriptedGenerator([
    '>Re-check old-explore.ts.</think><tool_call>{"name":"read","arguments":{"file_path":"src/old-explore.ts"}}',
  ])
  const config: HarnessConfig = { ...DEFAULT_HARNESS, worklist: { budgetTokens: 8000 } }
  const step = await decideStep({ history, tools, config, generator: gen })
  assert.equal(step.decision.type, 'tool')
  if (step.decision.type === 'tool') assert.equal(step.decision.tool.name, 'read')

  const prompt = gen.prompts[0]!
  assert.match(prompt, /call todo_plan early before editing, and call todo_update with a concise note/, 'worklist system guidance is injected')
  assert.doesNotMatch(prompt, /FOLDED_EXPLORATION_MARKER/, 'older exploratory read is folded out')
  assert.doesNotMatch(prompt, /SECOND_FOLDED_MARKER/, 'second older exploratory read is folded out')
  assert.match(prompt, /"name":"todo_plan"/, 'initial todo_plan call is kept for ownership continuity')
  assert.match(prompt, /KEPT_RECENT_PAIR_1/, '2nd-most-recent workspace pair before checkpoint is kept')
  assert.match(prompt, /KEPT_RECENT_PAIR_2/, 'most-recent workspace pair before checkpoint is kept')
  assert.match(prompt, /src\/auth\/jwt\.ts:18 DEFAULT_EXP=900/, 'note stays in the worklist anchor')
  assert.match(prompt, /\[2\] \(in_progress\) Edit DEFAULT_EXP to 3600/)

  // Bookkeeping steps do not consume the 15-step workspace budget.
  const turnState = analyzeTurn(history)
  assert.equal(turnState.steps, 4)
})

test('worklist: hardCap strips bloated old reasoning before dropping workspace read results', () => {
  const bloatedReasoning = 'Wait let me reconsider the interface contract. '.repeat(900)
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Fix RestockBook.java.' },
    { kind: 'call', id: 'r1', name: 'read', args: { file_path: 'RestockBook.java' }, reasoning: 'Read source.' },
    { kind: 'result', id: 'r1', name: 'read', ok: true, text: '27: public static List<String> process() // MUST_KEEP_SOURCE' },
    { kind: 'call', id: 'b1', name: 'bash', args: { command: 'javac' }, reasoning: bloatedReasoning },
    { kind: 'result', id: 'b1', name: 'bash', ok: true, text: '[exit code: 0]' },
  ]
  const folded = foldWorklist(history, { systemTokens: 1000, budgetTokens: 3000, hardCapTokens: 4500, historyEmptyThink: false })
  assert.ok(folded.items.some(item => item.kind === 'result' && item.text.includes('MUST_KEEP_SOURCE')), 'source file read is preserved!')
  assert.ok(folded.items.every(item => (item.kind !== 'call' && item.kind !== 'assistant') || !item.reasoning?.includes('Wait let me reconsider')), 'bloated reasoning stripped first')
})

test('worklist: exceeding configurable budgetTokens injects checkpoint nudge; completed turn keeps backbone', () => {
  const bigRead = 'line content '.repeat(600)
  const turnOne: HistoryItem[] = [
    { kind: 'user', text: 'Turn 1 multi-step edit.' },
    { kind: 'call', id: 't1c1', name: TODO_PLAN_TOOL, args: { items: ['Step A', 'Step B'] } },
    { kind: 'result', id: 't1c1', name: TODO_PLAN_TOOL, ok: true, text: 'Todo list:\n[1] (in_progress) Step A\n[2] (pending) Step B' },
    { kind: 'call', id: 't1c2', name: 'read', args: { file_path: 'big.ts' } },
    { kind: 'result', id: 't1c2', name: 'read', ok: true, text: bigRead },
  ]

  // With a tight budget (e.g. 1500), nudge triggers; with a 12000 budget, it does not.
  const tight = foldWorklist(turnOne, { systemTokens: 800, budgetTokens: 1500 })
  assert.equal(tight.nudge, WORKLIST_CHECKPOINT_NUDGE)

  const generous = foldWorklist(turnOne, { systemTokens: 800, budgetTokens: 12000 })
  assert.equal(generous.nudge, undefined)

  // Without an active worklist yet, exceeding budget nudges `todo_plan`.
  const unplanned: HistoryItem[] = [
    { kind: 'user', text: 'Investigate failure.' },
    { kind: 'call', id: 'u1', name: 'read', args: { file_path: 'big.ts' } },
    { kind: 'result', id: 'u1', name: 'read', ok: true, text: bigRead },
  ]
  const unplannedFold = foldWorklist(unplanned, { systemTokens: 800, budgetTokens: 1500 })
  assert.equal(unplannedFold.nudge, WORKLIST_INIT_NUDGE)

  // Once Turn 1 finishes and Turn 2 starts, Turn 1 keeps user + final worklist + final answer, dropping bigRead.
  const multiTurn: HistoryItem[] = [
    ...turnOne,
    { kind: 'call', id: 't1c3', name: TODO_UPDATE_TOOL, args: { id: 1, status: 'completed', note: 'big.ts checked' } },
    { kind: 'result', id: 't1c3', name: TODO_UPDATE_TOOL, ok: true, text: 'Todo list:\n[1] (completed) Step A\n  note: big.ts checked\n[2] (in_progress) Step B' },
    { kind: 'assistant', text: 'Finished Turn 1.' },
    { kind: 'user', text: 'Turn 2 follow-up question.' },
  ]
  const turnTwoFold = foldWorklist(multiTurn, { systemTokens: 800, budgetTokens: 8000 })
  assert.ok(!turnTwoFold.items.some(item => item.kind === 'result' && item.text === bigRead))
  assert.ok(turnTwoFold.items.some(item => item.kind === 'user' && item.text === 'Turn 1 multi-step edit.'))
  assert.ok(turnTwoFold.items.some(item => item.kind === 'result' && item.text.includes('note: big.ts checked')))
  assert.ok(turnTwoFold.items.some(item => item.kind === 'assistant' && item.text === 'Finished Turn 1.'))
  assert.ok(turnTwoFold.items.some(item => item.kind === 'user' && item.text === 'Turn 2 follow-up question.'))
})

test('worklist: consecutive worklist spin guard blocks a third consecutive bookkeeping call', async () => {
  const tools = buildCatalog(offeredWithTodo, { mode: 'mapped', names: 'dsh' })
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Fix bug.' },
    { kind: 'call', id: 'c1', name: TODO_PLAN_TOOL, args: { items: ['Step 1', 'Step 2'] } },
    { kind: 'result', id: 'c1', name: TODO_PLAN_TOOL, ok: true, text: 'Todo list...' },
    { kind: 'call', id: 'c2', name: TODO_UPDATE_TOOL, args: { id: 1, status: 'in_progress', note: 'partial' } },
    { kind: 'result', id: 'c2', name: TODO_UPDATE_TOOL, ok: true, text: 'Todo list...' },
  ]
  const gen = new ScriptedGenerator([
    // 3rd consecutive worklist call -> blocked by spin guard; model then calls `read` on retry.
    '>Spin.</think><tool_call>{"name":"todo_update","arguments":{"id":1,"status":"in_progress","note":"more"}}',
    '>Now read.</think><tool_call>{"name":"read","arguments":{"file_path":"a.ts"}}',
  ])
  const config: HarnessConfig = { ...DEFAULT_HARNESS, worklist: { budgetTokens: 8000 } }
  const step = await decideStep({ history, tools, config, generator: gen })
  assert.equal(step.generations, 2)
  assert.equal(step.decision.type, 'tool')
  if (step.decision.type === 'tool') assert.equal(step.decision.tool.name, 'read')
})

test('historyEmptyThink defaults to true; explicit false keeps unfolded reasoning and collapses blank lines', async () => {
  const tools = buildCatalog(offeredWithTodo, { mode: 'mapped', names: 'dsh' })
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Inspect and edit a.ts.' },
    { kind: 'call', id: 'c1', name: 'read', args: { file_path: 'a.ts' }, reasoning: 'First paragraph.\n\nSecond paragraph.' },
    { kind: 'result', id: 'c1', name: 'read', ok: true, text: '1: const x = 1' },
  ]
  const genEmpty = new ScriptedGenerator(['>Now answer.</think>x is 1.'])
  await decideStep({ history, tools, config: DEFAULT_HARNESS, generator: genEmpty })
  assert.equal(DEFAULT_HARNESS.historyEmptyThink, true)
  assert.match(genEmpty.prompts[0]!, /Assistant: <think><\/think><tool_call>/)

  const genFull = new ScriptedGenerator(['>Now answer.</think>x is 1.'])
  await decideStep({ history, tools, config: { ...DEFAULT_HARNESS, historyEmptyThink: false }, generator: genFull })
  assert.match(genFull.prompts[0]!, /Assistant: <think>First paragraph\.\nSecond paragraph\.<\/think><tool_call>/)
})

test('worklist: non-withdrawn budget reminders preserve strict append-only prefix continuity and cooldown', async () => {
  const tools = buildCatalog(offeredWithTodo, { mode: 'mapped', names: 'dsh' })
  const bigRead = 'line content '.repeat(500)
  const config: HarnessConfig = { ...DEFAULT_HARNESS, worklist: { budgetTokens: 1500, hardCapTokens: 8000 } }

  // Step 1 finishes a large read -> triggers WORKLIST_INIT_NUDGE at the tail.
  const h1: HistoryItem[] = [
    { kind: 'user', text: 'Inspect big.ts and make the quick fix.' },
    { kind: 'call', id: 'u1', name: 'read', args: { file_path: 'big.ts' }, reasoning: 'Read big.ts first.' },
    { kind: 'result', id: 'u1', name: 'read', ok: true, text: bigRead },
  ]
  const gen1 = new ScriptedGenerator(['>Budget reminder noted, but only 1 write left.</think><tool_call>{"name":"write","arguments":{"file_path":"big.ts","content":"ok"}}'])
  await decideStep({ history: h1, tools, config, generator: gen1 })
  const p1 = gen1.prompts[0]!
  assert.ok(p1.includes(WORKLIST_INIT_NUDGE), 'step 2 prompt contains WORKLIST_INIT_NUDGE')

  // Case A: Model skips todo_plan and writes directly -> INIT nudge stays in history (NOT withdrawn!) and cooldown prevents nag spam.
  const h2Skip: HistoryItem[] = [
    ...h1,
    { kind: 'call', id: 'u2', name: 'write', args: { file_path: 'big.ts', content: 'ok' }, reasoning: 'Budget reminder noted, but only 1 write left.' },
    { kind: 'result', id: 'u2', name: 'write', ok: true, text: 'wrote big.ts' },
  ]
  const fold2Skip = foldWorklist(h2Skip, { systemTokens: 800, budgetTokens: 1500, hardCapTokens: 8000 })
  assert.equal(fold2Skip.nudge, undefined, 'cooldown suppresses nagging on the very next workspace step')
  const gen2Skip = new ScriptedGenerator(['>Done.</think>Updated big.ts.'])
  await decideStep({ history: h2Skip, tools, config, generator: gen2Skip })
  const p2Skip = gen2Skip.prompts[0]!
  const prefixBeforeGeneration1 = p1.slice(0, p1.length - 'Assistant: <think'.length)
  assert.ok(p2Skip.startsWith(prefixBeforeGeneration1), 'step 3 prompt starts with exact byte-for-byte prefix of step 2 (reminder not withdrawn!)')

  // Case B: Model obeys INIT nudge with todo_plan -> INIT nudge stays before todo_plan, and CHECKPOINT nudge fires right after todo_plan.
  const h2Plan: HistoryItem[] = [
    ...h1,
    { kind: 'call', id: 'p1', name: TODO_PLAN_TOOL, args: { items: ['Inspect big.ts', 'Rewrite big.ts'] }, reasoning: 'Budget reached, creating plan.' },
    { kind: 'result', id: 'p1', name: TODO_PLAN_TOOL, ok: true, text: 'Todo list:\n[1] (in_progress) Inspect big.ts\n[2] (pending) Rewrite big.ts' },
  ]
  const fold2Plan = foldWorklist(h2Plan, { systemTokens: 800, budgetTokens: 1500, hardCapTokens: 8000 })
  assert.equal(fold2Plan.nudge, WORKLIST_CHECKPOINT_NUDGE)
  const gen2Plan = new ScriptedGenerator(['>Now checkpoint.</think><tool_call>{"name":"todo_update","arguments":{"id":1,"status":"completed","note":"big.ts inspected"}}'])
  await decideStep({ history: h2Plan, tools, config, generator: gen2Plan })
  const p2Plan = gen2Plan.prompts[0]!
  assert.ok(p2Plan.startsWith(prefixBeforeGeneration1), 'todo_plan step preserves exact byte-for-byte prefix including INIT nudge')
  assert.ok(p2Plan.includes(WORKLIST_CHECKPOINT_NUDGE), 'CHECKPOINT nudge appended after todo_plan')
})

test('worklist: clears stale reasoning on discontinuous pinned firstPlan and preserves unplanned cross-turn + hardCap fallbacks', () => {
  // 1. Discontinuous firstPlan clears reasoning once intermediate steps fold out.
  const historyFoldedGap: HistoryItem[] = [
    { kind: 'user', text: 'Refactor module.' },
    { kind: 'call', id: 'p0', name: TODO_PLAN_TOOL, args: { items: ['Read files', 'Apply fix'] }, reasoning: 'STALE_STEP1_OPENING_THOUGHT' },
    { kind: 'result', id: 'p0', name: TODO_PLAN_TOOL, ok: true, text: 'Todo list...' },
    { kind: 'call', id: 'r1', name: 'read', args: { file_path: 'a.ts' }, reasoning: 'Read a.' },
    { kind: 'result', id: 'r1', name: 'read', ok: true, text: 'a' },
    { kind: 'call', id: 'r2', name: 'read', args: { file_path: 'b.ts' }, reasoning: 'Read b.' },
    { kind: 'result', id: 'r2', name: 'read', ok: true, text: 'b' },
    { kind: 'call', id: 'r3', name: 'read', args: { file_path: 'c.ts' }, reasoning: 'Read c.' },
    { kind: 'result', id: 'r3', name: 'read', ok: true, text: 'c' },
    { kind: 'call', id: 'u1', name: TODO_UPDATE_TOOL, args: { id: 1, status: 'completed', note: 'a,b,c read' }, reasoning: 'CHECKPOINT_THOUGHT' },
    { kind: 'result', id: 'u1', name: TODO_UPDATE_TOOL, ok: true, text: 'Todo list:\n[1] (completed) Read files\n  note: a,b,c read\n[2] (in_progress) Apply fix' },
  ]
  const foldedGap = foldWorklist(historyFoldedGap, { systemTokens: 500, budgetTokens: 8000 })
  const pinnedPlanCall = foldedGap.items.find(item => item.kind === 'call' && item.name === TODO_PLAN_TOOL)
  assert.ok(pinnedPlanCall && pinnedPlanCall.kind === 'call')
  assert.equal(pinnedPlanCall.reasoning, undefined, 'discontinuous pinned todo_plan clears stale reasoning')
  const checkpointCall = foldedGap.items.find(item => item.kind === 'call' && item.name === TODO_UPDATE_TOOL)
  assert.ok(checkpointCall && checkpointCall.kind === 'call')
  assert.equal(checkpointCall.reasoning, 'CHECKPOINT_THOUGHT', 'active checkpoint reasoning stays intact')

  // 2. Cross-turn unplanned fallback keeps last workspace call/result + ledger so Turn 2 never sees pure zero-tool chat.
  const unplannedMultiTurn: HistoryItem[] = [
    { kind: 'user', text: 'Turn 1: clean CSV.' },
    { kind: 'call', id: 't1r', name: 'read', args: { file_path: '/app/orders.csv' } },
    { kind: 'result', id: 't1r', name: 'read', ok: true, text: 'id,amt\n1,10' },
    { kind: 'call', id: 't1w', name: 'write', args: { file_path: '/app/clean.csv', content: 'id,amt\n1,10\n' } },
    { kind: 'result', id: 't1w', name: 'write', ok: true, text: 'wrote /app/clean.csv' },
    { kind: 'assistant', text: 'Cleaned orders into /app/clean.csv.' },
    { kind: 'user', text: 'Turn 2: drop rows with amt < 20.' },
  ]
  const crossTurn = foldWorklist(unplannedMultiTurn, { systemTokens: 500, budgetTokens: 8000 })
  assert.ok(crossTurn.items.some(item => item.kind === 'note' && item.text.includes('- read /app/orders.csv -> ok')), 'earlier unplanned turn step summarized in ledger')
  assert.ok(crossTurn.items.some(item => item.kind === 'call' && item.name === 'write'), 'completed unplanned turn retains its final real tool call')

  // 3. In-turn unplanned hardCap overflow summarizes dropped oldest steps in a ledger instead of silently erasing them.
  const huge = 'x '.repeat(1200)
  const overflowTurn: HistoryItem[] = [
    { kind: 'user', text: 'Fix failing service.' },
    { kind: 'call', id: 'o1', name: 'read', args: { file_path: '/app/svc.py' } },
    { kind: 'result', id: 'o1', name: 'read', ok: true, text: huge },
    { kind: 'call', id: 'o2', name: 'bash', args: { command: 'pytest -q' } },
    { kind: 'result', id: 'o2', name: 'bash', ok: true, text: `${huge}\n[exit code: 1]` },
  ]
  const hardFold = foldWorklist(overflowTurn, { systemTokens: 500, budgetTokens: 1500, hardCapTokens: 2500 })
  assert.ok(hardFold.items.some(item => item.kind === 'note' && item.text.includes('- read /app/svc.py -> ok')), 'hardCap overflow inserts deterministic step ledger')
})

test('worklist UI: advancing to next in_progress auto-completes noted item and TodoPanel projection stays clean and settles on turn/end', () => {
  const initial = applyTodoPlan([], ['Inspect todo.ts', 'Inspect worklist.ts', 'Run tests'])
  assert.ok(Array.isArray(initial))

  // Item #1 checkpoints with in_progress + note, then model jumps to #2 in_progress -> #1 auto-completes instead of turning gray pending!
  const step1 = applyTodoUpdate(initial, { id: 1, status: 'in_progress', note: 'src/todo.ts: L40 STATE_RECORD' })
  assert.equal(typeof step1, 'object')
  if (typeof step1 === 'string') throw new Error(step1)
  const step2 = applyTodoUpdate(step1.items, { id: 2, status: 'in_progress', note: 'src/core/worklist.ts: L448' })
  assert.equal(typeof step2, 'object')
  if (typeof step2 === 'string') throw new Error(step2)
  assert.equal(step2.items[0]!.status, 'completed', 'earlier noted item auto-completes when advancing to #2')
  assert.equal(step2.items[1]!.status, 'in_progress')

  // Unnoted active item still demotes back to pending if focus switches before any note is written.
  const unnotedSwitch = applyTodoUpdate(initial, { id: 2, status: 'in_progress' })
  assert.equal(typeof unnotedSwitch, 'object')
  if (typeof unnotedSwitch === 'string') throw new Error(unnotedSwitch)
  assert.equal(unnotedSwitch.items[0]!.status, 'pending')

  // Native TodoPanel projection omits verbose note tails during the turn and settles in_progress -> pending on turn/end.
  const liveProj = projectNativeTodos(step2.items)
  assert.deepEqual(liveProj, [
    { content: '[1] Inspect todo.ts', status: 'completed' },
    { content: '[2] Inspect worklist.ts', status: 'in_progress' },
    { content: '[3] Run tests', status: 'pending' },
  ])
  const settledProj = projectNativeTodos(step2.items, { turnEnded: true })
  assert.deepEqual(settledProj, [
    { content: '[1] Inspect todo.ts', status: 'completed' },
    { content: '[2] Inspect worklist.ts', status: 'pending' },
    { content: '[3] Run tests', status: 'pending' },
  ])
})

test('worklist minFoldTokens low watermark: skips folding below threshold without retroactive folding', () => {
  const planOut = '[1] [in_progress] Read\n[2] [pending] Edit'
  const u1Out = '[1] [completed] Read\n  note: read a.py\n[2] [in_progress] Edit'
  const u2Out = '[1] [completed] Read\n  note: read a.py\n[2] [completed] Edit\n  note: edited a.py'
  const bigChunk = 'alpha beta gamma delta epsilon '.repeat(400)
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Update a.py and b.py.' },
    { kind: 'call', id: 'p1', name: 'todo_plan', args: { items: ['Read', 'Edit'] } },
    { kind: 'result', id: 'p1', name: 'todo_plan', ok: true, text: planOut },
    { kind: 'call', id: 'r1', name: 'read', args: { file_path: '/app/a.py' } },
    { kind: 'result', id: 'r1', name: 'read', ok: true, text: 'def f(): return 1' },
    { kind: 'call', id: 'r2', name: 'read', args: { file_path: '/app/b.py' } },
    { kind: 'result', id: 'r2', name: 'read', ok: true, text: 'def g(): return 2' },
    { kind: 'call', id: 'r3', name: 'read', args: { file_path: '/app/c.py' } },
    { kind: 'result', id: 'r3', name: 'read', ok: true, text: 'def h(): return 3' },
    // Early noted todo_update while total prompt is well below minFoldTokens (3000): should NOT fold r1.
    { kind: 'call', id: 'u1', name: 'todo_update', args: { id: 1, status: 'completed', note: 'read a.py' } },
    { kind: 'result', id: 'u1', name: 'todo_update', ok: true, text: u1Out },
    // Later large read pushes prompt past minFoldTokens (3000): u1 must NOT retroactively fold!
    { kind: 'call', id: 'r4', name: 'read', args: { file_path: '/app/big.py' } },
    { kind: 'result', id: 'r4', name: 'read', ok: true, text: bigChunk },
  ]

  const belowWatermark = foldWorklist(history.slice(0, 11), { systemTokens: 1000, minFoldTokens: 3000, budgetTokens: 12000 })
  assert.equal(belowWatermark.checkpointAt, undefined, 'below minFoldTokens does not activate checkpoint')
  assert.ok(belowWatermark.items.some(item => item.kind === 'call' && item.id === 'r1'), 'keeps earliest read when below minFoldTokens')

  const afterGrowthNoNewUpdate = foldWorklist(history, { systemTokens: 1000, minFoldTokens: 3000, budgetTokens: 12000 })
  assert.equal(afterGrowthNoNewUpdate.checkpointAt, undefined, 'earlier below-watermark todo_update never retroactively folds')
  assert.ok(afterGrowthNoNewUpdate.items.some(item => item.kind === 'call' && item.id === 'r1'), 'keeps r1 without retroactive fold')

  // Once above minFoldTokens, a new noted todo_update triggers folding normally.
  const withSecondUpdate: HistoryItem[] = [
    ...history,
    { kind: 'call', id: 'u2', name: 'todo_update', args: { id: 2, status: 'completed', note: 'edited a.py' } },
    { kind: 'result', id: 'u2', name: 'todo_update', ok: true, text: u2Out },
  ]
  const aboveWatermark = foldWorklist(withSecondUpdate, { systemTokens: 1000, minFoldTokens: 3000, budgetTokens: 12000 })
  assert.equal(aboveWatermark.checkpointAt, 13, 'noted todo_update above minFoldTokens activates checkpoint')
  assert.ok(!aboveWatermark.items.some(item => item.kind === 'call' && item.id === 'r1'), 'folds oldest read beyond keepRecentPairs')
})

test('auto-fold (passive: true): hides todo tools/guidance/nudges, keeps short multi-turn intact under minFoldTokens, and folds past budgetTokens', async () => {
  const toolsWithoutTodo = buildCatalog(offeredWithTodo, { mode: 'mapped', names: 'dsh', exclude: [TODO_PLAN_TOOL, TODO_UPDATE_TOOL] })
  assert.ok(!toolsWithoutTodo.some(t => t.name === TODO_PLAN_TOOL || t.name === TODO_UPDATE_TOOL))

  // 1. Short 3-turn conversation under minFoldTokens (8000): keeps all intermediate read/edit steps verbatim.
  const shortMultiTurn: HistoryItem[] = [
    { kind: 'user', text: 'Turn 1: write resume.html.' },
    { kind: 'call', id: 't1r', name: 'read', args: { file_path: '/app/template.html' }, reasoning: 'STALE_R1' },
    { kind: 'result', id: 't1r', name: 'read', ok: true, text: '<html><body>old</body></html>' },
    { kind: 'call', id: 't1w', name: 'write', args: { file_path: '/app/resume.html', content: '<html><body>v1</body></html>' } },
    { kind: 'result', id: 't1w', name: 'write', ok: true, text: 'wrote /app/resume.html' },
    { kind: 'assistant', text: 'Created resume.html.', reasoning: 'STALE_A1' },
    { kind: 'user', text: 'Turn 2: change background to light blue.' },
    { kind: 'call', id: 't2w', name: 'write', args: { file_path: '/app/resume.html', content: '<html><body style="background:#e6f4ff">v1</body></html>' } },
    { kind: 'result', id: 't2w', name: 'write', ok: true, text: 'wrote /app/resume.html' },
    { kind: 'assistant', text: 'Changed background to light blue.' },
    { kind: 'user', text: 'Turn 3: tighten intro text.' },
  ]
  const shortFold = foldWorklist(shortMultiTurn, {
    systemTokens: 800,
    minFoldTokens: 8000,
    budgetTokens: 12000,
    historyEmptyThink: true,
    passive: true,
  })
  assert.ok(shortFold.items.some(item => item.kind === 'call' && item.id === 't1r'), 'short multi-turn under minFoldTokens keeps turn 1 intermediate read verbatim')
  assert.ok(!shortFold.items.some(item => item.kind === 'note' && item.text.includes('Earlier workspace steps')), 'short multi-turn emits no fold ledger')

  // 2. When total prompt reaches minFoldTokens (e.g. 950), oldest completed turn folds to ledger + final pair (with reasoning stripped).
  const crossedFold = foldWorklist(shortMultiTurn, {
    systemTokens: 800,
    minFoldTokens: 950,
    budgetTokens: 12000,
    historyEmptyThink: false,
    passive: true,
  })
  assert.ok(!crossedFold.items.some(item => item.kind === 'call' && item.id === 't1r'), 'oldest turn above minFoldTokens folds intermediate steps')
  assert.ok(crossedFold.items.some(item => item.kind === 'note' && item.text.includes('- read /app/template.html -> ok')), 'folded turn records deterministic ledger')
  for (const item of crossedFold.items.slice(0, 6)) {
    if (item.kind === 'call' || item.kind === 'assistant') {
      assert.equal(item.reasoning, undefined, 'folded prior turn clears stale reasoning on fallback pair and final reply')
    }
  }

  // 3. In-turn overflow past budgetTokens (1600) deterministically folds oldest steps to ledger while keeping recent 2 pairs + zero nudges/guidance.
  const chunk = 'const line = "payload token filler";\n'.repeat(55)
  const inTurnLong: HistoryItem[] = [
    { kind: 'user', text: 'Fix service bug.' },
    { kind: 'call', id: 's1', name: 'read', args: { file_path: '/app/a.ts' } },
    { kind: 'result', id: 's1', name: 'read', ok: true, text: `OLD_S1\n${chunk}` },
    { kind: 'call', id: 's2', name: 'read', args: { file_path: '/app/b.ts' } },
    { kind: 'result', id: 's2', name: 'read', ok: true, text: `KEEP_S2\n${chunk}` },
    { kind: 'call', id: 's3', name: 'read', args: { file_path: '/app/c.ts' } },
    { kind: 'result', id: 's3', name: 'read', ok: true, text: `KEEP_S3\n${chunk}` },
  ]
  const gen = new ScriptedGenerator(['>All clear.</think>Fixed.'])
  await decideStep({
    history: inTurnLong,
    tools: toolsWithoutTodo,
    config: {
      ...DEFAULT_HARNESS,
      worklist: { passive: true, systemGuidance: false, minFoldTokens: 800, budgetTokens: 1600, hardCapTokens: 5000, keepRecentPairs: 2 },
    },
    generator: gen,
  })
  const prompt = gen.prompts[0]!
  assert.ok(!prompt.includes('todo_plan'), 'auto-fold prompt omits todo_plan from system/tools/nudges')
  assert.ok(!prompt.includes('call todo_plan early'), 'auto-fold prompt omits WORKLIST_SYSTEM_GUIDANCE')
  assert.ok(!prompt.includes(WORKLIST_INIT_NUDGE), 'auto-fold never emits INIT_NUDGE')
  assert.ok(prompt.includes('- read /app/a.ts -> ok'), 'oldest in-turn step folded into deterministic ledger')
  assert.ok(!prompt.includes('OLD_S1'), 'folded raw payload removed')
  assert.ok(prompt.includes('KEEP_S2') && prompt.includes('KEEP_S3'), 'recent 2 workspace pairs kept verbatim')

  const passiveFold = foldWorklist(inTurnLong, {
    systemTokens: 800,
    minFoldTokens: 800,
    budgetTokens: 1600,
    hardCapTokens: 5000,
    keepRecentPairs: 2,
    historyEmptyThink: true,
    passive: true,
    pinUneditedRead: true,
    cwd: '/app',
  })
  assert.equal(passiveFold.nudge, undefined)
  assert.equal(passiveFold.duplicateFrom, 3, 'duplicateFrom advances past folded step 1')
  assert.deepEqual(passiveFold.foldedUnread, ['/app/a.ts'], 'folded read step marks a.ts unread until re-read')
  assert.ok(prompt.includes('re-read a file before calling edit'), 'ledger header reminds to re-read folded files')

  // Re-reading a.ts brings it back into the active window and clears foldedUnread.
  const rereadHistory: HistoryItem[] = [
    ...inTurnLong,
    { kind: 'call', id: 's4', name: 'read', args: { file_path: 'a.ts' } },
    { kind: 'result', id: 's4', name: 'read', ok: true, text: '1: re-read\n' },
  ]
  const afterReread = foldWorklist(rereadHistory, {
    systemTokens: 800,
    minFoldTokens: 800,
    budgetTokens: 1600,
    hardCapTokens: 5000,
    keepRecentPairs: 2,
    historyEmptyThink: true,
    passive: true,
    pinUneditedRead: true,
    cwd: '/app',
  })
  assert.ok(!afterReread.foldedUnread.includes('/app/a.ts'), 'relative re-read clears foldedUnread for /app/a.ts')
})

test('auto-fold pins latest unedited read within budget and omits it from foldedUnread', () => {
  const bigOut = 'log line with unique payload\n'.repeat(45)
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Inspect target.ts and run checks.' },
    { kind: 'call', id: 'r1', name: 'read', args: { file_path: '/app/target.ts' } },
    { kind: 'result', id: 'r1', name: 'read', ok: true, text: 'PINNED_TARGET_BODY\nexport const x = 1\n' },
    { kind: 'call', id: 'b1', name: 'bash', args: { command: 'echo 1' } },
    { kind: 'result', id: 'b1', name: 'bash', ok: true, text: `B1\n${bigOut}` },
    { kind: 'call', id: 'b2', name: 'bash', args: { command: 'echo 2' } },
    { kind: 'result', id: 'b2', name: 'bash', ok: true, text: `B2\n${bigOut}` },
    { kind: 'call', id: 'b3', name: 'bash', args: { command: 'echo 3' } },
    { kind: 'result', id: 'b3', name: 'bash', ok: true, text: `B3\n${bigOut}` },
  ]
  const pinned = foldWorklist(history, {
    systemTokens: 500,
    minFoldTokens: 500,
    budgetTokens: 1400,
    hardCapTokens: 4000,
    keepRecentPairs: 2,
    historyEmptyThink: true,
    passive: true,
    pinUneditedRead: true,
    cwd: '/app',
  })
  const rendered = JSON.stringify(pinned.items)
  assert.ok(rendered.includes('PINNED_TARGET_BODY'), 'unedited read is pinned verbatim after folding')
  assert.ok(!rendered.includes('B1\n'), 'older bash output is still folded into the ledger')
  assert.deepEqual(pinned.foldedUnread, [], 'pinned read is visible and not marked foldedUnread')

  // If a write occurred after the read, stop scanning and do not pin the older read.
  const afterEditHistory: HistoryItem[] = [
    { kind: 'user', text: 'Edit and check.' },
    { kind: 'call', id: 'r1', name: 'read', args: { file_path: '/app/old.ts' } },
    { kind: 'result', id: 'r1', name: 'read', ok: true, text: 'OLD_BODY\n' },
    { kind: 'call', id: 'e1', name: 'edit', args: { file_path: '/app/other.ts', old_string: 'a', new_string: 'b' } },
    { kind: 'result', id: 'e1', name: 'edit', ok: true, text: 'ok' },
    { kind: 'call', id: 'b1', name: 'bash', args: { command: 'echo 1' } },
    { kind: 'result', id: 'b1', name: 'bash', ok: true, text: `B1\n${bigOut}` },
    { kind: 'call', id: 'b2', name: 'bash', args: { command: 'echo 2' } },
    { kind: 'result', id: 'b2', name: 'bash', ok: true, text: `B2\n${bigOut}` },
    { kind: 'call', id: 'b3', name: 'bash', args: { command: 'echo 3' } },
    { kind: 'result', id: 'b3', name: 'bash', ok: true, text: `B3\n${bigOut}` },
  ]
  const unpinned = foldWorklist(afterEditHistory, {
    systemTokens: 500,
    minFoldTokens: 500,
    budgetTokens: 1400,
    hardCapTokens: 4000,
    keepRecentPairs: 2,
    historyEmptyThink: true,
    passive: true,
    pinUneditedRead: true,
    cwd: '/app',
  })
  assert.ok(!JSON.stringify(unpinned.items).includes('OLD_BODY'), 'read before a write is not pinned')
  assert.deepEqual(unpinned.foldedUnread, ['/app/old.ts'])
})

test('auto-fold with epochTargetTokens preserves append-only prefix between epochs', () => {
  const stepText = 'step output line for epoch test\n'.repeat(40)
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Run multi-step checks.' },
    { kind: 'call', id: 's1', name: 'bash', args: { command: 'echo 1' } },
    { kind: 'result', id: 's1', name: 'bash', ok: true, text: `S1\n${stepText}` },
    { kind: 'call', id: 's2', name: 'bash', args: { command: 'echo 2' } },
    { kind: 'result', id: 's2', name: 'bash', ok: true, text: `S2\n${stepText}` },
    { kind: 'call', id: 's3', name: 'bash', args: { command: 'echo 3' } },
    { kind: 'result', id: 's3', name: 'bash', ok: true, text: `S3\n${stepText}` },
    { kind: 'call', id: 's4', name: 'bash', args: { command: 'echo 4' } },
    { kind: 'result', id: 's4', name: 'bash', ok: true, text: `S4\n${stepText}` },
  ]
  const opts = {
    systemTokens: 600,
    minFoldTokens: 600,
    budgetTokens: 1500,
    epochTargetTokens: 1150,
    hardCapTokens: 4000,
    keepRecentPairs: 1,
    historyEmptyThink: true,
    passive: true,
  }
  // At 3 pairs: exceeds 1500, jumps back to <= 1150 (folding s1, s2 into a ledger).
  const at3 = foldWorklist(history.slice(0, 7), opts)
  assert.ok(at3.promptTokens <= 1150, `expected epoch jump <= 1150, got ${at3.promptTokens}`)
  assert.equal(at3.items[1]?.kind, 'note', 'epoch jump inserts a folded-steps ledger note')
  // At 4 pairs (with a short s4 that stays <= 1500): prefix from at3 must be 100% append-only!
  const withShortS4: HistoryItem[] = [
    ...history.slice(0, 7),
    { kind: 'call', id: 's4', name: 'bash', args: { command: 'echo 4' } },
    { kind: 'result', id: 's4', name: 'bash', ok: true, text: 'S4_SHORT' },
  ]
  const at4 = foldWorklist(withShortS4, opts)
  assert.ok(at4.promptTokens <= 1500, `expected <= 1500, got ${at4.promptTokens}`)
  assert.deepEqual(
    at4.items.slice(0, at3.items.length),
    at3.items,
    'within the same epoch, ledger and prefix stay byte-for-byte append-only',
  )
})
