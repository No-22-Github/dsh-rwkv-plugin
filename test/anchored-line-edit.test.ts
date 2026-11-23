import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EDIT_MODES,
  excludedToolsForEditMode,
  isEditMode,
  maxReadLinesForEditMode,
  mountsEditLinesPlugin,
  usesTolerantEditHook,
} from '../src/core/edit-modes/index.ts'
import {
  applyAnchoredLineEdits,
  batchEditSummary,
  isNonTrivialAnchor,
  MAX_LINE_EDIT_READ_LINES,
  parseLineEditHunks,
} from '../src/core/edit-modes/line-edit.ts'
import { seenAfterBatchEdit } from '../src/core/edit-modes/shared.ts'
import { buildCatalog, normalizeArguments, resolveTool, type DshToolSchema } from '../src/core/tools.ts'
import { setFoldedUnreadPaths } from '../src/edit-modes/folded-read-guard.ts'
import { createLineEditToolDefinition } from '../src/edit-modes/line-edit.ts'
import { attachObservations, type LineEditHostContext } from '../src/edit-modes/observations.ts'
import { capReadResult, READ_SHOWN_EVENT, RESULT_TOKEN_BUDGET } from '../src/result-budget.ts'

const BUCKET_PY = [
  'class TokenBucket:',
  '    def __init__(self, cap: float, rate: float):',
  '        self.cap = cap',
  '        self.rate = rate',
  '        self.tokens = cap',
  '',
  '    def consume(self, cost: float) -> bool:',
  '        if cost <= 0:',
  '            return True',
  '        if self.tokens > cost:',
  '            self.tokens -= cost',
  '            return True',
  '        return False',
  '',
  '    def reset(self) -> None:',
  '        self.tokens = 0',
].join('\n') + '\n'

describe('anchored batch line-edit engine', () => {
  it('Tier 2 self-heals ±15 line drift via start_text without silent corruption', () => {
    // True target is line 10 (`if self.tokens > cost:`); simulate RWKV -3 drift to line 7.
    const res = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [{
      startLine: 7,
      endLine: 7,
      startText: 'if self.tokens > cost:',
      newText: '        if self.tokens >= cost:',
    }])
    assert.equal(typeof res, 'object', String(res))
    if (typeof res === 'string') return
    assert.equal(res.hunks[0]!.startLine, 10)
    assert.equal(res.hunks[0]!.endLine, 10)
    assert.equal(res.hunks[0]!.anchorVerified, true)
    assert.match(res.hunks[0]!.alignedNote ?? '', /Auto-aligned.*7-7 -> 10-10/)
    assert.ok(res.content.includes('if cost <= 0:'))
    assert.ok(res.content.includes('if self.tokens >= cost:'))
  })

  it('Tier 2 aborts when 2+ exact local matches exist, while exact beats fuzzy', () => {
    const dup = [
      'def a():',
      '    return True',
      'def b():',
      '    return True',
      'def c():',
      '    return False',
    ].join('\n') + '\n'
    const err = applyAnchoredLineEdits(dup, 'dup.py', [{
      startLine: 6,
      endLine: 6,
      startText: 'return True',
      newText: '    return 1',
    }])
    assert.equal(typeof err, 'string')
    assert.match(String(err), /matched multiple nearby lines/)

    // Exact match strictly beats fuzzy runner-ups in Tier 3 fallback too.
    const big = Array.from({ length: 60 }, (_, i) => `    return x + ${i + 1}`).join('\n') + '\n'
    const healed = applyAnchoredLineEdits(big, 'big.py', [{
      startLine: 5,
      endLine: 5,
      startText: 'return x + 45',
      newText: '    return x + 450',
    }])
    assert.equal(typeof healed, 'object', String(healed))
    if (typeof healed === 'string') return
    assert.equal(healed.hunks[0]!.startLine, 45)
    assert.match(healed.hunks[0]!.alignedNote ?? '', /file-wide start_text/)
  })

  it('auto-aligns end_line drift via end_text for multi-line spans', () => {
    const res = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [{
      startLine: 10,
      endLine: 13, // off by +1 (true end is line 12 `return True`)
      startText: 'if self.tokens > cost:',
      endText: 'return True',
      newText: '        if self.tokens >= cost:\n            self.tokens -= cost\n            return True',
    }])
    assert.equal(typeof res, 'object', String(res))
    if (typeof res === 'string') return
    assert.equal(res.hunks[0]!.endLine, 12)
    assert.match(res.hunks[0]!.alignedNote ?? '', /end_line 13 -> 12/)
    assert.ok(res.content.includes('        return False'))
  })

  it('applies atomic multi-hunk edits bottom-up against pre-edit coordinates and rejects overlaps', () => {
    const res = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [
      // Deliberately out of order
      {
        startLine: 16,
        endLine: 16,
        startText: 'self.tokens = 0',
        newText: '        self.tokens = self.cap',
      },
      {
        startLine: 10,
        endLine: 10,
        startText: 'if self.tokens > cost:',
        newText: '        if self.tokens >= cost:',
      },
    ])
    assert.equal(typeof res, 'object', String(res))
    if (typeof res === 'string') return
    assert.equal(res.hunks.length, 2)
    assert.ok(res.content.includes('if self.tokens >= cost:'))
    assert.ok(res.content.includes('self.tokens = self.cap'))
    const summary = batchEditSummary('bucket.py', res)
    assert.match(summary, /2 atomic edits/)
    assert.match(summary, /=== bucket\.py \(lines /)
    assert.doesNotMatch(summary, /\[File: /)

    const overlap = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [
      { startLine: 9, endLine: 11, newText: '            pass' },
      { startLine: 11, endLine: 12, newText: '            pass' },
    ])
    assert.equal(typeof overlap, 'string')
    assert.match(String(overlap), /overlaps/)
  })

  it('auto-reindents replacement, strips copied line numbers, and blocks elision & boundary duplication', () => {
    // 1. Auto-reindent when start_text lost 4 leading spaces
    const reindented = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [{
      startLine: 10,
      endLine: 10,
      startText: '    if self.tokens > cost:',
      newText: '    if self.tokens >= cost:',
    }])
    assert.equal(typeof reindented, 'object', String(reindented))
    if (typeof reindented !== 'string') {
      assert.equal(reindented.hunks[0]!.reindented, true)
      assert.ok(reindented.content.includes('        if self.tokens >= cost:'))
    }

    // 2. Copied `N: ` prefix stripping
    const stripped = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [{
      startLine: 10,
      endLine: 11,
      startText: 'if self.tokens > cost:',
      newText: '10:         if self.tokens >= cost:\n11:             self.tokens -= cost',
    }])
    assert.equal(typeof stripped, 'object', String(stripped))
    if (typeof stripped !== 'string') {
      assert.equal(stripped.hunks[0]!.strippedLineNumbers, true)
      assert.ok(!stripped.content.includes('10: '))
    }

    // 3. Elision placeholder guard
    const elided = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [{
      startLine: 8,
      endLine: 12,
      newText: '        # ... existing code ...\n        return True',
    }])
    assert.equal(typeof elided, 'string')
    assert.match(String(elided), /elision placeholder/)

    // 4. Boundary duplication guard (accidentally copying untouched line 9 above start_line=10)
    const dupAbove = applyAnchoredLineEdits(BUCKET_PY, 'bucket.py', [{
      startLine: 10,
      endLine: 10,
      startText: 'if self.tokens > cost:',
      newText: '            return True\n        if self.tokens >= cost:',
    }])
    assert.equal(typeof dupAbove, 'string')
    assert.match(String(dupAbove), /duplicates line 9/)
  })

  it('parses batch, JSON-stringified edits, camelCase aliases, and single-hunk shorthand', () => {
    const fromJson = parseLineEditHunks({
      edits: JSON.stringify([{ startLine: '10', endLine: '10', startText: 'if x:', newText: 'if y:' }]),
    })
    assert.ok(Array.isArray(fromJson))
    assert.equal(fromJson[0]!.startLine, 10)
    assert.equal(fromJson[0]!.startText, 'if x:')

    const fromShorthand = parseLineEditHunks({ start_line: 3, end_line: 4, start_text: 'a = 1', new_text: 'a = 2' })
    assert.ok(Array.isArray(fromShorthand))
    assert.equal(fromShorthand[0]!.endLine, 4)

    assert.equal(isNonTrivialAnchor('return', 8), false)
    assert.equal(isNonTrivialAnchor('if self.tokens > cost:', 8), true)
  })
})

describe('edit-modes registry, tool routing, and <=200-line read cap', () => {
  it('removes hashline from EDIT_MODES and enforces 200-line read cap in line-edit mode', () => {
    assert.deepEqual(EDIT_MODES, ['tolerant', 'line-edit', 'literal'])
    assert.equal(isEditMode('hashline'), false)
    assert.equal(isEditMode('line-edit'), true)
    assert.equal(mountsEditLinesPlugin('line-edit'), true)
    assert.equal(usesTolerantEditHook('tolerant'), true)
    assert.equal(maxReadLinesForEditMode('line-edit'), MAX_LINE_EDIT_READ_LINES)
    assert.equal(maxReadLinesForEditMode('tolerant'), undefined)
    assert.deepEqual(excludedToolsForEditMode('line-edit'), [])
    assert.deepEqual(excludedToolsForEditMode('tolerant'), ['edit_lines'])

    // Short lines that fit easily under 3000 tokens still get capped at 200 lines in line-edit mode.
    const lines = Array.from({ length: 320 }, (_, i) => `${i + 1}: x = ${i + 1}`)
    const readText = `<path>/w/a.py</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n(End of file - total 320 lines)\n</content>`
    const capped = capReadResult(readText, RESULT_TOKEN_BUDGET, body => body, MAX_LINE_EDIT_READ_LINES)
    assert.ok(capped !== undefined)
    assert.match(capped, /Showing lines 1-200 of 320\. Use offset=201 to continue\./)
    assert.ok(!capped.includes('\n201: '))
  })

  it('routes cross-harness `edit` / `edit_file` calls to `edit_lines` when line-edit is active', () => {
    const offered: DshToolSchema[] = ['read', 'edit', 'write', 'edit_lines'].map(name => ({
      name,
      description: `${name}.`,
      parameters: { properties: { file_path: { type: 'string' }, edits: { type: 'array' } } },
    }))
    const catalog = buildCatalog(offered, { mode: 'mapped', names: 'dsh' })
    assert.equal(resolveTool(catalog, 'edit')?.tool.dshName, 'edit_lines')
    assert.equal(resolveTool(catalog, 'edit_file')?.tool.dshName, 'edit_lines')
    const editTool = catalog.find(t => t.dshName === 'edit_lines')!
    const norm = normalizeArguments(editTool, {
      path: 'bucket.py',
      edits: JSON.stringify([{ startLine: 10, endLine: 10, startText: 'if x:', newText: 'if y:' }]),
    })
    assert.equal(norm.file_path, 'bucket.py')
    assert.ok(Array.isArray(norm.edits))
    assert.equal((norm.edits as Record<string, unknown>[])[0]!.start_line, 10)
  })
})

describe('host edit_lines tool: verified-anchor folded-read bypass & batch seen tracking', () => {
  it('allows verified-anchor edit on folded observed file while refusing unanchored folded edit', async () => {
    let content = BUCKET_PY
    let version = 1
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    const registered: { execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
    const emitEvent = (event: string, ...args: unknown[]) => {
      for (const l of listeners.get(event) ?? []) l(...args)
    }
    const host = {
      fs: {
        resolve: async (p: string) => ({ displayPath: p, targetKey: `k:${p}` }),
        readText: async () => content,
        writeText: async (_t: unknown, next: string) => { content = next; version++; return { version } },
        processPath: (t: { displayPath: string }) => `/ws/${t.displayPath}`,
      },
      tools: {
        register: (def: unknown) => { registered.push(def as never); return () => {} },
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return () => {}
      },
      emit: emitEvent,
      get: () => undefined,
    } as unknown as LineEditHostContext
    const observations = attachObservations(host)
    host.tools.register(createLineEditToolDefinition(host, observations))
    const tool = registered[0]!

    const session = { header: { id: 'sess-anchored-1' } }
    const readExec = { name: 'read', agent: { session, options: { provider: 'rwkv' } } }
    const editExec = { name: 'edit_lines', agent: { session, options: { provider: 'rwkv' } } }

    // Observe file via read (lines 1..16), then mark folded out by auto-fold.
    emitEvent('fs/observed', { displayPath: 'bucket.py', targetKey: 'k:bucket.py' }, { kind: 'present', version }, readExec)
    emitEvent(READ_SHOWN_EVENT, readExec, { first: 1, last: 16 })
    setFoldedUnreadPaths('sess-anchored-1', ['/ws/bucket.py'])

    // Unanchored edit on folded file is STILL rejected!
    await assert.rejects(
      () => tool.execute({ file_path: 'bucket.py', start_line: 10, end_line: 10, new_text: '        if self.tokens >= cost:' }, editExec),
      /folded/i,
    )

    // Verified non-trivial start_text edit on observed file bypasses folded-read guard and self-heals -2 drift!
    const result = await tool.execute({
      file_path: 'bucket.py',
      edits: [
        { start_line: 8, end_line: 8, start_text: 'if self.tokens > cost:', new_text: '        if self.tokens >= cost:' },
        { start_line: 16, end_line: 16, start_text: 'self.tokens = 0', new_text: '        self.tokens = self.cap' },
      ],
    }, editExec) as { summary: string }
    assert.match(result.summary, /2 atomic edits/)
    assert.ok(content.includes('if self.tokens >= cost:'))
    assert.ok(content.includes('self.tokens = self.cap'))

    // Verify batch seen-line tracking helper renumbers cleanly.
    const nextSeen = seenAfterBatchEdit(
      new Set([1, 2, 3, 10, 11, 12, 20]),
      [{ startLine: 3, endLine: 3, removed: 1, added: 3 }, { startLine: 11, endLine: 12, removed: 2, added: 1 }],
      21,
      1,
    ) as Set<number>
    assert.ok(nextSeen.has(21), 'line 20 shifted +2 -1 = 21')

    setFoldedUnreadPaths('sess-anchored-1', [])
  })
})
