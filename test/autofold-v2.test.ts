import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerateRequest, GenerateResult, Generator } from '../src/backend/generator.ts'
import { decideStep, DEFAULT_HARNESS, type HarnessConfig } from '../src/core/agent.ts'
import { FOLDED_OUTPUT_MARKER, foldCompletedTurnCompact, foldedUnreadPaths, maskResultInPlace } from '../src/core/fold-pairs.ts'
import { analyseHistory, analyzeTurn, POST_TOOL_REMINDER_THINK, type HistoryItem } from '../src/core/policy.ts'
import { renderPrompt, systemPrompt } from '../src/core/prompt.ts'
import { buildCatalog } from '../src/core/tools.ts'
import { foldWorklist, worklistEntries } from '../src/core/worklist.ts'
import { setFoldedUnreadPaths } from '../src/folded-read-guard.ts'
import { runtimeCwd } from '../src/paths.ts'
import { resolveHistoryModeConfig } from '../src/session-setup.ts'
import { countTokens } from '../src/tokenizer.ts'
import { applyTolerantEdit } from '../src/tolerant-edit.ts'

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

const offeredTools = [
  { name: 'read', description: 'Read a file.', parameters: { properties: { file_path: { type: 'string' } } } },
  { name: 'write', description: 'Write a file.', parameters: { properties: { file_path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'edit', description: 'Edit a file.', parameters: { properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } } },
  { name: 'grep', description: 'Search text.', parameters: { properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'bash', description: 'Run command.', parameters: { properties: { command: { type: 'string' } } } },
]

function makeLines(prefix: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `${i + 1}: const ${prefix}_${i + 1} = "token_payload_value_${i + 1}";`).join('\n')
}

test('auto-fold v2 defaults: resolveHistoryModeConfig sets 13500->9000, prior<=2000, keep=3, exempt=250, hardCap=14500, in-place & immediate', () => {
  const resolved = resolveHistoryModeConfig({ historyMode: 'auto-fold' })
  assert.deepEqual(resolved.worklist, {
    passive: true,
    systemGuidance: false,
    immediatePriorFold: true,
    inPlaceMask: true,
    backboneMaxTokens: 2000,
    minFoldTokens: 0,
    budgetTokens: 13500,
    epochTargetTokens: 9000,
    keepRecentPairs: 3,
    exemptResultTokens: 250,
    hardCapTokens: 14500,
  })
})

test('Module 1: immediate prior-turn compaction (<= 2000 tok) preserves Turn 1 runtime-context cwd and emits [Modified files in this turn]', () => {
  const runtimeNote = 'Current working directory: "/app".\nCurrent DSH file policy: workspace-write.'
  const turn1History: HistoryItem[] = [
    { kind: 'user', text: 'Turn 1: fix handlers and add route.' },
    { kind: 'note', text: runtimeNote },
    { kind: 'call', id: 'c1', name: 'read', args: { file_path: '/app/src/handlers.py' }, reasoning: 'Read handlers.' },
    { kind: 'result', id: 'c1', name: 'read', ok: true, text: makeLines('handler', 80) },
    { kind: 'call', id: 'c2', name: 'edit', args: { file_path: '/app/src/handlers.py', old_string: 'a', new_string: 'b' } },
    { kind: 'result', id: 'c2', name: 'edit', ok: true, text: 'updated' },
    { kind: 'call', id: 'c3', name: 'write', args: { file_path: 'src/routes.py', content: 'route = 1\n' } },
    { kind: 'result', id: 'c3', name: 'write', ok: true, text: 'created' },
    { kind: 'call', id: 'c4', name: 'edit', args: { file_path: './src/handlers.py', old_string: 'b', new_string: 'c' } },
    { kind: 'result', id: 'c4', name: 'edit', ok: true, text: 'updated again' },
    { kind: 'assistant', text: 'Updated handlers.py and added routes.py.', reasoning: 'PAST_TURN_THINK' },
  ]

  // Immediate compaction at start of Turn 2 — even though total tokens are well below 8,000!
  const turn2Start: HistoryItem[] = [
    ...turn1History,
    { kind: 'user', text: 'Turn 2: now add healthcheck tests.' },
  ]
  const v2Cfg = resolveHistoryModeConfig({ historyMode: 'auto-fold' }).worklist!
  const folded = foldWorklist(turn2Start, {
    systemTokens: 900,
    historyEmptyThink: true,
    cwd: '/app',
    ...v2Cfg,
  })

  // Turn 1 tool call/result pairs are immediately dropped; runtime-context and modified-files note are preserved!
  assert.ok(!folded.items.some(item => item.kind === 'call' || item.kind === 'result'), 'prior-turn tool pairs immediately dropped')
  assert.equal(runtimeCwd(folded.items), '/app', 'Turn 1 runtime-context cwd note is preserved in Turn 2+')
  assert.ok(
    folded.items.some(item => item.kind === 'note' && item.text === '[Modified files in this turn: src/handlers.py, src/routes.py]'),
    'deduped clean relative paths in [Modified files in this turn]',
  )
  const a1 = folded.items.find(item => item.kind === 'assistant')
  assert.ok(a1 && a1.kind === 'assistant')
  assert.equal(a1.reasoning, undefined, 'past reasoning stripped on prior-turn assistant reply')
  // Turn 1 read/written files are marked foldedUnread in Turn 2 until re-read.
  assert.deepEqual([...folded.foldedUnread].sort(), ['/app/src/handlers.py', '/app/src/routes.py'])

  // Over-budget multi-turn (> 2000 backboneMaxTokens): truncates replies / drops oldest non-Turn-1 turns while ALWAYS keeping Turn 1 runtime-context!
  const longReply = 'Detailed summary sentence with verified test results and module explanations. '.repeat(90)
  const manyTurns: HistoryItem[] = [
    ...turn1History.slice(0, -1),
    { kind: 'assistant', text: longReply },
    { kind: 'user', text: `Turn 2 big request: ${'requirement detail '.repeat(220)}` },
    { kind: 'assistant', text: longReply },
    { kind: 'user', text: `Turn 3 big request: ${'requirement detail '.repeat(220)}` },
    { kind: 'assistant', text: longReply },
    { kind: 'user', text: `Turn 4 big request: ${'requirement detail '.repeat(220)}` },
    { kind: 'assistant', text: longReply },
    { kind: 'user', text: 'Turn 5 active prompt.' },
  ]
  const capped = foldWorklist(manyTurns, {
    systemTokens: 900,
    historyEmptyThink: true,
    cwd: '/app',
    ...v2Cfg,
  })
  assert.equal(runtimeCwd(capped.items), '/app', 'Turn 1 runtime-context note survives <= 2000 backbone cap!')
  // Prior items are everything before the last user item ('Turn 5 active prompt.')
  const turn5Idx = capped.items.findIndex(item => item.kind === 'user' && item.text === 'Turn 5 active prompt.')
  assert.ok(turn5Idx > 0)
  const priorRenderedTok = capped.items
    .slice(0, turn5Idx)
    .reduce((sum, item) => sum + countTokens(`${item.kind === 'assistant' ? 'Assistant: <think></think>' : 'User: '}${'text' in item ? item.text : ''}\n\n`), 0)
  assert.ok(priorRenderedTok <= 2050, `expected prior turns <= ~2000 tokens, got ${priorRenderedTok}`)
})

test('Module 2: 13500 -> 9000 batch in-place masking, <250 tok exemption, keepRecentPairs=3 (no 2800 downgrade), and append-only prefix stability', async () => {
  const tools = buildCatalog(offeredTools, { mode: 'mapped', names: 'dsh' })
  const v2Cfg = resolveHistoryModeConfig({ historyMode: 'auto-fold' }).worklist!
  const harnessCfg: HarnessConfig = { ...DEFAULT_HARNESS, worklist: v2Cfg }

  // Construct 9 steps:
  // p1 (big read ~2700 tok), p2 (short grep < 250 exempt!), p3 (big bash ~2700 tok, exit 1),
  // p4 (big read ~2700 tok), p4b (medium read ~1400 tok — stays unmasked once <=9000 reached!),
  // p5 (short edit < 250 exempt!),
  // p6 (~1550 tok), p7 (~1550 tok), p8 (~1550 tok) -> recent 3 pairs p6,p7,p8 (p7+p8 > 2800 tok!)
  const bigReadA = makeLines('modA', 140)
  const shortGrep = 'src/modA.ts:12: export function initA()\nsrc/modB.ts:44: initA()' // < 250 tokens
  const bigBashFail = `${makeLines('pytest_err', 140)}\n[exit code: 1]`
  const bigReadB = makeLines('modB', 140)
  const midReadKeep = makeLines('modMid', 65) // >= 250 tok, outside last 3, kept once <= 9000 is hit!
  const shortEdit = 'The file /app/src/modB.ts has been updated successfully.'
  const recentRead1 = makeLines('recent1', 80) // ~1550 tok
  const recentRead2 = makeLines('recent2', 80) // ~1550 tok (recent2 + recent3 > 2800 tok!)
  const recentRead3 = makeLines('recent3', 80) // ~1550 tok

  assert.ok(countTokens(shortGrep) < 250)
  assert.ok(countTokens(shortEdit) < 250)
  assert.ok(countTokens(midReadKeep) >= 250)
  assert.ok(countTokens(recentRead2) + countTokens(recentRead3) > 2800, 'recent tail exceeds legacy 2800 threshold')

  const baseHistory: HistoryItem[] = [
    { kind: 'user', text: 'Refactor modA/modB and fix failing tests.' },
    { kind: 'note', text: 'Current working directory: "/app".' },
    { kind: 'call', id: 'p1', name: 'read', args: { file_path: 'src/modA.ts' } },
    { kind: 'result', id: 'p1', name: 'read', ok: true, text: bigReadA },
    { kind: 'call', id: 'p2', name: 'grep', args: { pattern: 'initA', path: 'src' } },
    { kind: 'result', id: 'p2', name: 'grep', ok: true, text: shortGrep },
    { kind: 'call', id: 'p3', name: 'bash', args: { command: 'pytest -q' } },
    { kind: 'result', id: 'p3', name: 'bash', ok: true, text: bigBashFail },
    { kind: 'call', id: 'p4', name: 'read', args: { file_path: 'src/modB.ts' } },
    { kind: 'result', id: 'p4', name: 'read', ok: true, text: bigReadB },
    { kind: 'call', id: 'p4b', name: 'read', args: { file_path: 'src/modMid.ts' } },
    { kind: 'result', id: 'p4b', name: 'read', ok: true, text: midReadKeep },
    { kind: 'call', id: 'p5', name: 'edit', args: { file_path: 'src/modB.ts', old_string: 'OLD_CODE_KEEP', new_string: 'NEW_CODE_KEEP' } },
    { kind: 'result', id: 'p5', name: 'edit', ok: true, text: shortEdit },
    { kind: 'call', id: 'p6', name: 'read', args: { file_path: 'src/recent1.ts' } },
    { kind: 'result', id: 'p6', name: 'read', ok: true, text: recentRead1 },
    { kind: 'call', id: 'p7', name: 'read', args: { file_path: 'src/recent2.ts' } },
    { kind: 'result', id: 'p7', name: 'read', ok: true, text: recentRead2 },
    { kind: 'call', id: 'p8', name: 'read', args: { file_path: 'src/recent3.ts' } },
    { kind: 'result', id: 'p8', name: 'read', ok: true, text: recentRead3 },
  ]

  // At p7 (baseHistory without p8), raw tokens first cross 13,500 -> triggers batch in-place fold down to <= 9,000!
  const jumpHistory = baseHistory.slice(0, -2)
  const genJump = new ScriptedGenerator(['>Read recent3.</think><tool_call>{"name":"read","arguments":{"file_path":"src/recent3.ts"}}'])
  await decideStep({ history: jumpHistory, tools, config: harnessCfg, cwd: '/app', generator: genJump })
  const promptJump = genJump.prompts[0]!
  const promptJumpTokens = countTokens(promptJump)
  assert.ok(promptJumpTokens <= 9020, `expected batch jump down to <= ~9000 tokens, got ${promptJumpTokens}`)

  // No top ledger injected!
  assert.ok(!promptJump.includes('[Earlier workspace steps'), 'in-place mode does NOT emit top ledger')
  // Assistant tool calls stay 100% untouched in place!
  assert.ok(promptJump.includes('<tool_call>{"name":"read","arguments":{"file_path":"src/modA.ts"}}</tool_call>'), 'p1 call untouched in place')
  assert.ok(promptJump.includes('"old_string":"OLD_CODE_KEEP","new_string":"NEW_CODE_KEEP"'), 'p5 edit arguments untouched in place')
  // Old >=250-tok results masked in place with FOLDED_OUTPUT_MARKER + metadata!
  assert.ok(!promptJump.includes('modA_1 ='), 'p1 large read body omitted')
  assert.match(promptJump, /\[Old read output omitted \(src\/modA\.ts, 140 lines, \d+ tokens\); re-read if exact content is needed before edit\]/)
  assert.match(promptJump, /\[Old bash output omitted \(pytest -q, 141 lines, \d+ tokens\), exit 1; re-read if exact content is needed before edit\]/)
  // < 250-tok results (p2 grep, p5 edit) stay 100% unmasked!
  assert.ok(promptJump.includes(JSON.stringify(shortGrep)), '<250 tok grep output is exempt from masking')
  assert.ok(promptJump.includes(shortEdit), '<250 tok edit output is exempt from masking')
  // Recent 3 pairs at jump (p5, p6, p7) stay 100% unmasked!
  assert.ok(promptJump.includes('recent1_1 ='), 'recent1 kept unmasked at jump')
  assert.ok(promptJump.includes('recent2_1 ='), 'recent2 kept unmasked at jump')

  // Next step (p8) and step after (p9) stay between 9,000 and 13,500: prefixes MUST be 100% byte-for-byte append-only!
  const gen8 = new ScriptedGenerator(['>Check next.</think><tool_call>{"name":"read","arguments":{"file_path":"src/step9.ts"}}'])
  await decideStep({ history: baseHistory, tools, config: harnessCfg, cwd: '/app', generator: gen8 })
  const prompt8 = gen8.prompts[0]!
  const prefixJump = promptJump.slice(0, promptJump.length - 'Assistant: <think'.length)
  assert.ok(prompt8.startsWith(prefixJump), 'first step after jump (9k -> ~10.1k) is 100% byte-for-byte append-only!')
  // Recent 3 pairs in baseHistory (p6, p7, p8 > 2800 tok combined) are all unmasked!
  assert.ok(prompt8.includes('recent1_1 =') && prompt8.includes('recent2_1 =') && prompt8.includes('recent3_1 ='), 'all 3 recent pairs kept unmasked (no 2800 downgrade!)')

  // Next step (Step 9) adds ~1200 tokens (stays between 9,000 and 13,500): prompt prefix MUST be 100% byte-for-byte append-only!
  const step9History: HistoryItem[] = [
    ...baseHistory,
    { kind: 'call', id: 'p9', name: 'read', args: { file_path: 'src/step9.ts' } },
    { kind: 'result', id: 'p9', name: 'read', ok: true, text: makeLines('step9', 90) },
  ]
  const gen9 = new ScriptedGenerator(['>Done.</think>All verified.'])
  await decideStep({ history: step9History, tools, config: harnessCfg, cwd: '/app', generator: gen9 })
  const prompt9 = gen9.prompts[0]!
  const prefix8 = prompt8.slice(0, prompt8.length - 'Assistant: <think'.length)
  assert.ok(countTokens(prompt9) <= 13500)
  assert.ok(prompt9.startsWith(prefix8), 'steps between 9,000 and 13,500 are 100% byte-for-byte append-only!')
})

test('Per-result postToolReminder token accounting matches rendered RWKV prompt within 25 tokens across 18 in-place pairs', () => {
  const tools = buildCatalog(offeredTools, { mode: 'mapped', names: 'dsh' })
  const system = systemPrompt(tools, 'full', undefined, 'You are a coding agent powered by the rwkv model.')
  const v2Cfg = resolveHistoryModeConfig({ historyMode: 'auto-fold' }).worklist!

  const history: HistoryItem[] = [
    { kind: 'user', text: 'Check 18 files and commands.' },
    { kind: 'note', text: 'Current working directory: "/app".' },
  ]
  for (let i = 1; i <= 18; i++) {
    history.push({ kind: 'call', id: `c${i}`, name: i % 4 === 0 ? 'bash' : 'read', args: i % 4 === 0 ? { command: `cmd_${i}` } : { file_path: `src/f${i}.ts` } })
    history.push({
      kind: 'result',
      id: `c${i}`,
      name: i % 4 === 0 ? 'bash' : 'read',
      ok: i !== 8,
      text: i % 3 === 0 ? `short_output_${i}` : makeLines(`f${i}`, 65),
    })
  }

  const { entries, fold } = worklistEntries(history, {
    tools,
    postToolReminder: POST_TOOL_REMINDER_THINK,
    systemTokens: countTokens(system),
    historyEmptyThink: true,
    cwd: '/app',
    ...v2Cfg,
  })
  const rendered = renderPrompt([{ role: 'system', text: system }, ...entries], {
    thinking: 'full',
    historyEmptyThink: true,
  })
  const trueTokens = countTokens(rendered)
  const diff = Math.abs(fold.promptTokens - trueTokens)
  assert.ok(diff <= 25, `expected fold.promptTokens (${fold.promptTokens}) within 25 tokens of rendered prompt (${trueTokens}), diff=${diff}`)
})

test('Safety Couplings 1 & 2: in-place masked read blocks blind edit via foldedUnreadPaths AND allows re-read in policy.ts while short calls keep duplicate gate', async () => {
  const tools = buildCatalog(offeredTools, { mode: 'mapped', names: 'dsh' })
  const v2Cfg = resolveHistoryModeConfig({ historyMode: 'auto-fold' }).worklist!
  // Use scaled-down watermarks (budget 2600 -> target 1700) to test exact mechanics cleanly
  const compactV2 = { ...v2Cfg, budgetTokens: 2600, epochTargetTokens: 1700, hardCapTokens: 5000 }
  const config: HarnessConfig = { ...DEFAULT_HARNESS, worklist: compactV2 }

  const history: HistoryItem[] = [
    { kind: 'user', text: 'Update src/a.py.' },
    { kind: 'note', text: 'Current working directory: "/ws".' },
    { kind: 'call', id: 'r_a', name: 'read', args: { file_path: 'src/a.py' } },
    { kind: 'result', id: 'r_a', name: 'read', ok: true, text: makeLines('alpha', 65) }, // > 250 tok -> gets masked!
    { kind: 'call', id: 'g_short', name: 'grep', args: { pattern: 'alpha_1', path: 'src' } },
    { kind: 'result', id: 'g_short', name: 'grep', ok: true, text: 'src/a.py:1: alpha_1' }, // < 250 tok -> stays unmasked!
    { kind: 'call', id: 'r_b', name: 'read', args: { file_path: 'src/b.py' } },
    { kind: 'result', id: 'r_b', name: 'read', ok: true, text: makeLines('beta', 50) },
    { kind: 'call', id: 'r_c', name: 'read', args: { file_path: 'src/c.py' } },
    { kind: 'result', id: 'r_c', name: 'read', ok: true, text: makeLines('gamma', 50) },
    { kind: 'call', id: 'r_d', name: 'read', args: { file_path: 'src/d.py' } },
    { kind: 'result', id: 'r_d', name: 'read', ok: true, text: makeLines('delta', 50) },
  ]

  // 1. Direct maskResultInPlace + foldedUnreadPaths + analyseHistory check
  const maskedRes = maskResultInPlace(
    history[2] as Extract<HistoryItem, { kind: 'call' }>,
    history[3] as Extract<HistoryItem, { kind: 'result' }>,
  )
  assert.ok(maskedRes.text.startsWith(FOLDED_OUTPUT_MARKER))
  const manualFolded = [history[0]!, history[1]!, history[2]!, maskedRes, history[4]!, history[5]!]
  assert.deepEqual(foldedUnreadPaths(history.slice(0, 6), manualFolded, '/ws'), ['/ws/src/a.py'])
  const directState = analyseHistory(manualFolded)
  assert.equal([...directState.successKeys].some(k => k.startsWith('read\u0000')), false, 'in-place masked read is NOT in successKeys')
  assert.equal([...directState.successKeys].some(k => k.startsWith('grep\u0000')), true, 'unmasked <250-tok grep IS in successKeys')

  // 2. End-to-end decideStep: re-reading masked "src/a.py" succeeds on 1st generation (NOT duplicate-rejected!)
  const genReread = new ScriptedGenerator([
    '>Need exact lines of src/a.py after masking.</think><tool_call>{"name":"read","arguments":{"file_path":"src/a.py"}}',
  ])
  const stepReread = await decideStep({ history, tools, config, cwd: '/ws', sessionId: 'sess-v2-1', generator: genReread })
  assert.equal(stepReread.generations, 1, 're-reading in-place masked file is NOT rejected as duplicate')
  assert.equal(stepReread.decision.type, 'tool')
  assert.deepEqual(stepReread.foldedUnread, ['/ws/src/a.py'], 'src/a.py is in step.foldedUnread before re-read')

  // 3. End-to-end tolerant-edit folded-read-guard blocks blind edit on /ws/src/a.py!
  let editHook: ((exec: any, next: () => Promise<any>) => Promise<any>) | undefined
  applyTolerantEdit({
    on: (_ev: string, fn: typeof editHook) => { editHook = fn },
    emit: () => {},
    get: (name: string) => {
      if (name === 'fs') {
        return {
          resolve: async (p: string) => ({ displayPath: p }),
          readText: async () => 'const alpha_1 = 1\n',
          editText: async () => ({ version: 'v2', before: '', after: '' }),
          processPath: (t: { displayPath: string }) => `/ws/${t.displayPath}`,
        }
      }
      if (name === 'workingDirectory') return { ensure: async () => '/ws' }
      return undefined
    },
  }, {
    providers: () => ['rwkv'],
    enabled: () => true,
    outputRepairs: () => true,
    syntaxGuard: () => true,
    foldedReadGuard: () => true,
  })
  setFoldedUnreadPaths('sess-v2-1', stepReread.foldedUnread ?? [])
  const blindEditRes = await editHook!({
    name: 'edit',
    arguments: { file_path: 'src/a.py', old_string: 'alpha_1', new_string: 'alpha_2' },
    agent: { session: { header: { id: 'sess-v2-1' } }, options: { provider: 'rwkv' } },
  }, async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }))
  assert.equal(blindEditRes.isError, true, 'folded-read-guard blocks blind edit on in-place-masked file')
  assert.match(blindEditRes.content[0].text, /folded out of the active context window/)

  // 4. Meanwhile, repeating the UNMASKED <250-tok grep IS caught by the duplicate gate!
  const genDupGrep = new ScriptedGenerator([
    '>Repeat unmasked grep.</think><tool_call>{"name":"grep","arguments":{"pattern":"alpha_1","path":"src"}}',
    '>Now read src/a.py instead.</think><tool_call>{"name":"read","arguments":{"file_path":"src/a.py"}}',
  ])
  const stepDupGrep = await decideStep({ history, tools, config, cwd: '/ws', generator: genDupGrep })
  assert.equal(stepDupGrep.generations, 2, 'repeating unmasked <250-tok grep triggers duplicate retry')
  if (stepDupGrep.decision.type === 'tool') assert.equal(stepDupGrep.decision.tool.name, 'read')

  // 5. After re-reading src/a.py, foldedUnread clears!
  const afterRereadHistory: HistoryItem[] = [
    ...history,
    { kind: 'call', id: 'r_a2', name: 'read', args: { file_path: 'src/a.py' } },
    { kind: 'result', id: 'r_a2', name: 'read', ok: true, text: makeLines('alpha', 65) },
  ]
  const afterRereadFold = foldWorklist(afterRereadHistory, {
    systemTokens: 800,
    historyEmptyThink: true,
    cwd: '/ws',
    ...compactV2,
  })
  assert.ok(!afterRereadFold.foldedUnread.includes('/ws/src/a.py'), 're-reading src/a.py clears it from foldedUnread')
})

test('Module 2 Safety Valve: git-free 14,500 Stage Archive triggers when huge write calls exceed hardCap after masking all >=250 results', () => {
  const v2Cfg = resolveHistoryModeConfig({ historyMode: 'auto-fold' }).worklist!
  // Create 5 huge `write` calls whose `result` is tiny (<250 tok: "created") while `call.args.content` is ~3,400 RWKV tokens each!
  // Total unarchived tokens ~ 900 + 5 * 3450 = ~18,150 > 14,500 hardCap!
  const bigWriteBody = makeLines('generated_module', 260) // ~3,350 RWKV tokens inside Assistant call args!
  assert.ok(countTokens(bigWriteBody) > 3000)

  const history: HistoryItem[] = [
    { kind: 'user', text: 'Generate all 5 service modules.' },
    { kind: 'note', text: 'Current working directory: "/app".' },
  ]
  for (let i = 1; i <= 5; i++) {
    history.push({ kind: 'call', id: `w${i}`, name: 'write', args: { file_path: `/app/src/svc${i}.ts`, content: bigWriteBody } })
    history.push({ kind: 'result', id: `w${i}`, name: 'write', ok: true, text: `The file /app/src/svc${i}.ts has been created.` })
  }

  const folded = foldWorklist(history, {
    systemTokens: 900,
    reminderTokens: 43,
    historyEmptyThink: true,
    cwd: '/app',
    ...v2Cfg,
  })

  assert.ok(folded.promptTokens <= 14500, `expected Stage Archive to bring tokens <= 14500, got ${folded.promptTokens}`)
  assert.equal(runtimeCwd(folded.items), '/app', 'Turn 1 runtime-context cwd survives Stage Archive')
  const archiveNote = folded.items.find(
    (item): item is Extract<HistoryItem, { kind: 'note' }> => item.kind === 'note' && item.text.startsWith('[Stage archive'),
  )
  assert.ok(archiveNote, 'git-free [Stage archive ...] note is emitted')
  assert.match(
    archiveNote.text,
    /^\[Stage archive — earlier steps in this turn modified: src\/svc1\.ts(?:, src\/svc\d\.ts)*; \d+ steps archived\. Re-read any file before editing\.\]$/,
  )
  // Kept write calls NEVER have their content mutated!
  const keptWriteCalls = folded.items.filter((item): item is Extract<HistoryItem, { kind: 'call' }> => item.kind === 'call' && item.name === 'write')
  assert.ok(keptWriteCalls.length >= 1)
  for (const call of keptWriteCalls) {
    assert.equal(call.args.content, bigWriteBody, 'kept write call arguments are NEVER mutated')
  }
  // Archived write files are tracked in foldedUnread so editing them requires reading first!
  assert.ok(folded.foldedUnread.includes('/app/src/svc1.ts'))
})
