import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCatalog, type DshToolSchema } from '../src/core/tools.ts'
import { findRegion, reindent, resolveTolerantEdit } from '../src/core/tolerant-edit.ts'
import { introducedSyntaxError } from '../src/syntax-check.ts'
import { setFoldedUnreadPaths } from '../src/folded-read-guard.ts'
import { applyTolerantEdit } from '../src/tolerant-edit.ts'

test('tolerant-edit: catalog restores standard edit when edit_lines is excluded', () => {
  const offered: DshToolSchema[] = ['read', 'edit', 'write', 'edit_lines'].map(name => ({
    name, description: `${name}.`, parameters: { properties: { file_path: { type: 'string' } } },
  }))
  const lineMode = buildCatalog(offered, { mode: 'mapped', names: 'dsh' }).map(t => t.dshName)
  assert.deepEqual(lineMode.sort(), ['edit_lines', 'read', 'write'])

  const tolerantMode = buildCatalog(offered, { mode: 'mapped', names: 'dsh', exclude: ['edit_lines'] }).map(t => t.dshName)
  assert.deepEqual(tolerantMode.sort(), ['edit', 'read', 'write'])
})

test('tolerant-edit: exact matches pass through untouched, drifted indentation re-indents to tabs/spaces', () => {
  const goFile = 'package auth\n\nfunc Verify(tok string) bool {\n\tif tok == "" {\n\t\treturn false\n\t}\n\treturn true\n}\n'
  assert.deepEqual(resolveTolerantEdit(goFile, '\tif tok == "" {', '\tif len(tok) < 16 {', 'auth.go'), { kind: 'exact' })

  const drifted = resolveTolerantEdit(
    goFile,
    '    if tok == "" {\n        return false\n    }',
    '    if len(tok) < 16 {\n        return false\n    }',
    'auth.go',
  )
  assert.equal(drifted.kind, 'repaired')
  if (drifted.kind === 'repaired') {
    assert.equal(drifted.oldString, '\tif tok == "" {\n\t\treturn false\n\t}')
    assert.equal(drifted.newString, '\tif len(tok) < 16 {\n\t\treturn false\n\t}')
    assert.match(drifted.note, /ignoring indentation; re-indented the replacement/)
  }
})

test('tolerant-edit: omitted blank lines, inner whitespace, and drifted context lines keep file bytes intact', () => {
  const pyFile = 'def sum_prices(items):\n    total = 0\n\n    for item in items:\n        total += item.price\n    return total\n'
  const repaired = resolveTolerantEdit(
    pyFile,
    'def sum_prices(items):\n    total = 0\n    for item in item:\n        total += item.price\n    return total',
    'def sum_prices(items):\n    total = 0\n    for item in item:\n        total += item.price * item.qty\n    return total',
    'sum.py',
  )
  assert.equal(repaired.kind, 'repaired')
  if (repaired.kind === 'repaired') {
    const after = pyFile.replace(repaired.oldString, repaired.newString)
    assert.equal(
      after,
      'def sum_prices(items):\n    total = 0\n\n    for item in items:\n        total += item.price * item.qty\n    return total\n',
    )
    assert.match(repaired.note, /kept 1 unchanged line\(s\) as the file has them/)
  }
})

test('tolerant-edit: dual-anchor guard refuses omitted-middle sliding windows on repetitive blocks', () => {
  const body = Array.from({ length: 40 }, (_, i) => `  step_${i + 1}(ctx, ${i});`)
  const tsFile = ['export function runPipeline(ctx: Record<string, unknown>) {', ...body, '  return ctx;', '}', ''].join('\n')
  const omittedMiddle = [...body.slice(0, 14), ...body.slice(24), '  return ctx;'].join('\n')

  const res = resolveTolerantEdit(tsFile, omittedMiddle, '  return executeFastPipeline(ctx);', 'pipeline.ts')
  assert.equal(res.kind, 'refused')
  if (res.kind === 'refused') {
    assert.match(res.message, /closest text is lines 2-42/)
  }
})

test('tolerant-edit: ambiguous regions stop at the ambiguous level and already-applied edits are reported', () => {
  assert.equal(findRegion('  a()\nb\n\ta()\n', 'a()\n').kind, 'ambiguous')
  assert.equal(reindent('    x\n        y', [['    ', '\t']]), '\tx\n\t\ty')

  const updated = 'def calc(items):\n    result = 10\n    return result\n'
  const repeat = resolveTolerantEdit(updated, '    result = 0\n    return result', '    result = 10\n    return result', 'calc.py')
  assert.equal(repeat.kind, 'refused')
  if (repeat.kind === 'refused') {
    assert.match(repeat.message, /already applied/)
    assert.doesNotMatch(repeat.message, /Read .* again before editing/i)
  }

  // Closest-text refusal shows numbered surrounding context without the blind "Copy old_string" imperative.
  const nearby = 'line1\nline2\n<h3>Alic</h3>\n<p class="title">Engineer</p>\nline5\nline6\n'
  const miss = resolveTolerantEdit(nearby, '<p class="title">Designer</p>', '<p class="title">Alic</p>', 'index.html')
  assert.equal(miss.kind, 'refused')
  if (miss.kind === 'refused') {
    assert.match(miss.message, /Current file around lines 2-6/)
    assert.match(miss.message, /3: <h3>Alic<\/h3>/)
    assert.doesNotMatch(miss.message, /Copy old_string from these exact lines/)
  }
})

test('syntax-check: validates TypeScript (.ts/.mts/.cts) alongside Go, Python, JS, shell, and JSON', async () => {
  const validTs = 'import {\n  type Stats,\n} from "node:fs"\nexport function ok(n: number): boolean {\n  return Number.isFinite(n) && n > 0\n}\n'
  const brokenTs = 'export function ok(n: number): boolean {\n  return Number.isFinite(n && n > 0\n}\n'
  assert.equal(await introducedSyntaxError(validTs, validTs, 'check.ts'), undefined)
  assert.match(String(await introducedSyntaxError(validTs, brokenTs, 'check.ts')), /^SyntaxError: /)
  assert.equal(await introducedSyntaxError(brokenTs, 'export function ok(n: number): boolean {\n  return Number.isFinite(n\n', 'check.ts'), undefined)
  // Non-erasable TS syntax (enum / parameter properties) must not be rejected as a syntax error.
  assert.equal(await introducedSyntaxError('export enum Mode { A = 1 }\n', 'export enum Mode { A = 1, B = 2 }\n', 'enum.ts'), undefined)
  const validGo = 'package main\n\nfunc ok(x int) int {\n\treturn x + 1\n}\n'
  const brokenGo = 'package main\n\nfunc ok(x int) int {\n\treturn x +\n}\n'
  assert.equal(await introducedSyntaxError(validGo, validGo, 'main.go'), undefined)
  assert.match(String(await introducedSyntaxError(validGo, brokenGo, 'main.go')), /expected operand|syntax error|<standard input>/)
})

test('tolerant-edit hook: blocks syntax-breaking edits before disk write, delegates exact edits, and stamps sandbox policy on repaired edits', async () => {
  const files = new Map<string, string>([
    ['/ws/v.ts', 'export class Svc {\n  run(x: number): number {\n    const base = 1\n    return x + base\n  }\n}\n'],
  ])
  let listener: ((exec: any, next: () => Promise<any>) => Promise<any>) | undefined
  let nextCalls = 0
  let writtenPolicy: unknown
  const observed: unknown[] = []
  const mockFs = {
    resolve: async (p: string) => ({ displayPath: p }),
    readText: async (t: { displayPath: string }) => files.get(`/ws/${t.displayPath}`)!,
    editText: async (t: { displayPath: string }, edit: { oldString: string; newString: string }, _intent: unknown, _sig: unknown, policy: unknown) => {
      writtenPolicy = policy
      const before = files.get(`/ws/${t.displayPath}`)!
      const after = before.replace(edit.oldString, edit.newString)
      files.set(`/ws/${t.displayPath}`, after)
      return { version: 'v2', before, after }
    },
    processPath: (t: { displayPath: string }) => `/ws/${t.displayPath}`,
  }

  applyTolerantEdit({
    get fs() {
      throw new Error('cannot get property "fs" without inject')
    },
    on: (_ev: string, fn: typeof listener) => { listener = fn },
    waterfall: async () => ({ version: 'v1' }),
    emit: (...args: unknown[]) => { observed.push(args) },
    get: (name: string) => {
      if (name === 'fs') return mockFs
      if (name === 'sandboxPolicy') return { resolve: () => 'session-policy-token' }
      return undefined
    },
  }, {
    providers: () => ['rwkv'],
    enabled: () => true,
    outputRepairs: () => true,
    syntaxGuard: () => true,
  })

  const makeExec = (old_string: string, new_string: string) => ({
    name: 'edit',
    arguments: { file_path: 'v.ts', old_string, new_string },
    agent: { session: {}, options: { provider: 'rwkv' } },
  })

  // 1. Syntax-breaking edit is blocked before next() or editText() runs
  const bad = await listener!(makeExec('    return x + base', '    return (x + base'), async () => {
    nextCalls++
    return { content: [{ type: 'text', text: 'delegated' }], isError: false }
  })
  assert.equal(bad.isError, true)
  assert.equal(nextCalls, 0)
  assert.match(bad.content[0].text, /NOT applied: it introduces a syntax error/)

  // 2. Exact valid edit delegates straight to next()
  const exact = await listener!(makeExec('    const base = 1', '    const base = 2'), async () => {
    nextCalls++
    return { content: [{ type: 'text', text: 'delegated' }], isError: false }
  })
  assert.equal(exact.isError, false)
  assert.equal(nextCalls, 1)

  // 3. Drifted-indentation edit repairs, re-indents, stamps session sandboxPolicy, and emits fs/observed
  const drifted = await listener!(makeExec('  const base = 1\n  return x + base', '  const base = 10\n  return x + base'), async () => {
    nextCalls++
    return { content: [{ type: 'text', text: 'delegated' }], isError: false }
  })
  assert.equal(drifted.isError, false)
  assert.equal(nextCalls, 1)
  assert.equal(writtenPolicy, 'session-policy-token')
  assert.equal(observed.length, 1)
  assert.match(drifted.content[0].text, /updated successfully\.\nMatched the edit at lines 3-4 of v\.ts ignoring indentation; re-indented/)
  assert.equal(files.get('/ws/v.ts'), 'export class Svc {\n  run(x: number): number {\n    const base = 10\n    return x + base\n  }\n}\n')
})

test('tolerant-edit: strips copied read line-number prefixes and refuses silent no-op context resets', () => {
  const cssFile = '.card {\n  padding: 1rem;\n}\n.deprecated {\n  color: #444;\n  display: block;\n}\n'
  const stripped = resolveTolerantEdit(
    cssFile,
    '4: .deprecated {\n5:   color: #444;\n6:   display: block;\n7: }',
    '4: .deprecated {\n5:   color: #0a7d55;\n6:   display: block;\n7: }',
    'site.css',
  )
  assert.equal(stripped.kind, 'repaired')
  if (stripped.kind === 'repaired') {
    assert.equal(stripped.oldString, '.deprecated {\n  color: #444;\n  display: block;\n}')
    assert.equal(stripped.newString, '.deprecated {\n  color: #0a7d55;\n  display: block;\n}')
    assert.match(stripped.note, /stripping line-number prefixes/)
  }

  // Model accidentally writes the target new line into both old_string and new_string in a similar block.
  const javaFile = [
    'public class Service {',
    '    public int processOrder(int count, int discount, int tax, int shipping, int fee) {',
    '        int subtotal = count * 10;',
    '        int total = subtotal - discount;',
    '        return total + tax + shipping + fee;',
    '    }',
    '}',
    '',
  ].join('\n')
  const noop = resolveTolerantEdit(
    javaFile,
    [
      '    public int processOrder(int count, int discount, int tax, int shipping, int fee) {',
      '        int subtotal = count * 10;',
      '        int total = subtotal - discount + 5;',
      '        return total + tax + shipping + fee;',
      '    }',
    ].join('\n'),
    [
      '    public int processOrder(int count, int discount, int tax, int shipping, int fee) {',
      '        int subtotal = count * 10;',
      '        int total = subtotal - discount + 5;',
      '        return total + tax + shipping + fee;',
      '    }',
    ].join('\n'),
    'Service.java',
  )
  assert.equal(noop.kind, 'refused')
  if (noop.kind === 'refused') {
    assert.match(noop.message, /already contains the modified text instead of the current file text/)
  }
})

test('tolerant-edit hook: blocks blind edits to folded-unread files until re-read', async () => {
  let listener: ((exec: any, next: () => Promise<any>) => Promise<any>) | undefined
  let nextCalls = 0
  const mockFs = {
    resolve: async (p: string) => ({ displayPath: p }),
    readText: async () => 'const x = 1\n',
    editText: async () => ({ version: 'v2', before: 'const x = 1\n', after: 'const x = 2\n' }),
    processPath: (t: { displayPath: string }) => `/ws/${t.displayPath}`,
  }
  applyTolerantEdit({
    on: (_ev: string, fn: typeof listener) => { listener = fn },
    emit: () => {},
    get: (name: string) => {
      if (name === 'fs') return mockFs
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

  const makeExec = (extra?: Record<string, unknown>) => ({
    name: 'edit',
    arguments: { file_path: 'a.ts', old_string: 'const x = 1', new_string: 'const x = 2', ...extra },
    agent: { session: { header: { id: 'sess-fold-1' } }, options: { provider: 'rwkv' } },
  })

  setFoldedUnreadPaths('sess-fold-1', ['/ws/a.ts'])
  const blocked = await listener!(makeExec(), async () => {
    nextCalls++
    return { content: [{ type: 'text', text: 'delegated' }], isError: false }
  })
  assert.equal(blocked.isError, true)
  assert.equal(nextCalls, 0)
  assert.match(blocked.content[0].text, /folded out of the active context window/)

  // Also blocks replace_all edits on folded-unread files.
  const blockedAll = await listener!(makeExec({ replace_all: true }), async () => {
    nextCalls++
    return { content: [{ type: 'text', text: 'delegated' }], isError: false }
  })
  assert.equal(blockedAll.isError, true)
  assert.equal(nextCalls, 0)

  // Clearing folded-unread (e.g., after re-read) allows the edit to proceed.
  setFoldedUnreadPaths('sess-fold-1', [])
  const allowed = await listener!(makeExec(), async () => {
    nextCalls++
    return { content: [{ type: 'text', text: 'delegated' }], isError: false }
  })
  assert.equal(allowed.isError, false)
  assert.equal(nextCalls, 1)
})
