import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyHashEdit,
  formatHashReadResult,
  hashEditSummary,
  hashSyntaxRejection,
  lineHash,
  stripHashPrefixes,
} from '../src/core/edit-modes/hashline.ts'
import {
  EDIT_MODES,
  excludedToolsForEditMode,
  isEditMode,
  mountsEditLinesPlugin,
  usesHashReadFormat,
  usesTolerantEditHook,
} from '../src/core/edit-modes/index.ts'
import { gateToolCall, repairArguments } from '../src/core/step-gates.ts'
import { analyzeTurn } from '../src/core/policy.ts'
import { buildCatalog, type DshToolSchema } from '../src/core/tools.ts'
import { setFoldedUnreadPaths } from '../src/edit-modes/folded-read-guard.ts'
import { getActiveEditMode, onActiveEditModeChange, setActiveEditMode } from '../src/edit-modes/mode-state.ts'
import { apply as applyLineEditEntry } from '../src/line-edit.ts'

describe('hashline core & decoupled edit-modes registry', () => {
  it('formats read output with 2-hex line hashes and preserves footer', () => {
    const raw = [
      '<path>app.py</path>',
      '<type>file</type>',
      '<content>',
      '1: import os',
      '2: print("hi")',
      '',
      '(End of file - total 2 lines)',
      '</content>',
    ].join('\n')
    const out = formatHashReadResult(raw)
    assert.match(out, new RegExp(`1:${lineHash('import os')}\\| import os`))
    assert.match(out, new RegExp(`2:${lineHash('print("hi")')}\\| print\\("hi"\\)`))
    assert.match(out, /\(End of file - total 2 lines\)/)
  })

  it('replaces a multi-line range when both hashes match and rejects stale hashes', () => {
    const src = 'a = 1\nb = 2\nc = 3\n'
    const h1 = lineHash('a = 1')
    const h2 = lineHash('b = 2')
    const h3 = lineHash('c = 3')

    const ok = applyHashEdit(src, 'x.py', {
      start: `2:${h2}`,
      end: `3:${h3}`,
      newText: 'b = 20\nc = 30',
    })
    assert.notEqual(typeof ok, 'string')
    if (typeof ok === 'string') throw new Error(ok)
    assert.equal(ok.result.content, 'a = 1\nb = 20\nc = 30\n')
    assert.match(hashEditSummary('x.py', ok), new RegExp(`1:${h1}\\| a = 1`))

    const rejection = hashSyntaxRejection('x.py', ok, 'SyntaxError: invalid syntax (line 2)')
    assert.match(rejection, new RegExp(`2:${lineHash('b = 20')}\\| b = 20`))
    assert.match(rejection, new RegExp(`2:${h2}\\| b = 2`))
    assert.match(rejection, /Fix start\/end or new_text/)

    const stale = applyHashEdit(src, 'x.py', {
      start: '2:00',
      end: `3:${h3}`,
      newText: 'b = 99',
    })
    assert.equal(typeof stale, 'string')
    assert.match(String(stale), /hash mismatch/)
  })

  it('supports insert_after, delete, and stripping accidental hash prefixes', () => {
    const src = 'first\nsecond\nthird\n'
    const h1 = lineHash('first')
    const ins = applyHashEdit(src, 'x.txt', {
      start: `1:${h1}`,
      op: 'insert_after',
      newText: `1:${h1}| inserted`,
    })
    assert.notEqual(typeof ins, 'string')
    if (typeof ins === 'string') throw new Error(ins)
    assert.equal(ins.result.content, 'first\ninserted\nsecond\nthird\n')

    assert.equal(stripHashPrefixes('12:ab| foo\n13:cd| bar'), 'foo\nbar')
  })

  it('preserves start/end anchors for student tool-repairs in hashline mode without clobbering line-edit aliases', () => {
    const hashlineOffered: DshToolSchema[] = [{
      name: 'edit_lines',
      description: 'Hash edit.',
      parameters: {
        properties: {
          file_path: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          op: { type: 'string' },
          new_text: { type: 'string' },
        },
      },
    }]
    const [hashDshTool] = buildCatalog(hashlineOffered, { mode: 'mapped', names: 'dsh' })
    assert.ok(hashDshTool)

    // Canonical hashline arguments must survive `repairArguments` intact!
    const canonical = repairArguments(hashDshTool, {
      file_path: 'src/app.py',
      start: '12:a3',
      end: '15:f9',
      op: 'replace',
      new_text: 'x = 1',
    }, false)
    assert.deepEqual(canonical.args, {
      file_path: 'src/app.py',
      start: '12:a3',
      end: '15:f9',
      op: 'replace',
      new_text: 'x = 1',
    })
    assert.deepEqual(canonical.repairs, [])

    // Aliased keys (`path`, `start_line`, `end_line`, `operation`, `replacement`) repair into hashline keys!
    const aliased = repairArguments(hashDshTool, {
      path: 'src/app.py',
      start_line: '12:a3',
      end_line: '15:f9',
      operation: 'delete',
    }, false)
    assert.deepEqual(aliased.args, {
      file_path: 'src/app.py',
      start: '12:a3',
      end: '15:f9',
      op: 'delete',
    })

    // Model calling `hashline` tool alias resolves to `edit_lines` via `gateToolCall`.
    const gated = gateToolCall(
      { type: 'tool', name: 'hashline', args: { file_path: 'a.py', start: '1:aa', new_text: 'ok' }, repairs: [] },
      analyzeTurn([{ kind: 'user', text: 'fix a.py' }]),
      [hashDshTool],
      { outputRepairs: true, guards: true, maxConsecutiveFailures: 2 },
      false,
    )
    assert.equal(gated.type, 'run')
    if (gated.type === 'run') {
      assert.equal(gated.tool.dshName, 'edit_lines')
      assert.deepEqual(gated.args, { file_path: 'a.py', start: '1:aa', new_text: 'ok' })
    }

    //Trained-wire catalog (`names: 'trained'`) also preserves hashline schema.
    const [hashTrainedTool] = buildCatalog(hashlineOffered, { mode: 'mapped', names: 'trained' })
    assert.ok(hashTrainedTool)
    assert.deepEqual(hashTrainedTool.toDsh({ path: '/workspace/a.py', start: '3:0f', op: 'delete' }), {
      file_path: 'a.py',
      start: '3:0f',
      op: 'delete',
    })

    // Coordinate `line-edit` mode continues to alias `start`/`end` -> `start_line`/`end_line`.
    const lineOffered: DshToolSchema[] = [{
      name: 'edit_lines',
      description: 'Line edit.',
      parameters: {
        properties: {
          file_path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          new_text: { type: 'string' },
        },
      },
    }]
    const [lineDshTool] = buildCatalog(lineOffered, { mode: 'mapped', names: 'dsh' })
    assert.ok(lineDshTool)
    const repairedLine = repairArguments(lineDshTool, { path: 'a.py', start: '10', end: '12', text: 'hi' }, false)
    assert.deepEqual(repairedLine.args, { file_path: 'a.py', start_line: 10, end_line: 12, new_text: 'hi' })
  })

  it('exposes consistent capabilities across all four edit modes and notifies live mode listeners', () => {
    assert.deepEqual(EDIT_MODES, ['tolerant', 'line-edit', 'hashline', 'literal'])
    for (const m of EDIT_MODES) assert.equal(isEditMode(m), true)
    assert.equal(isEditMode('unknown'), false)

    assert.deepEqual(excludedToolsForEditMode('tolerant'), ['edit_lines'])
    assert.deepEqual(excludedToolsForEditMode('literal'), ['edit_lines'])
    assert.deepEqual(excludedToolsForEditMode('line-edit'), [])
    assert.deepEqual(excludedToolsForEditMode('hashline'), [])

    assert.equal(mountsEditLinesPlugin('line-edit'), true)
    assert.equal(mountsEditLinesPlugin('hashline'), true)
    assert.equal(mountsEditLinesPlugin('tolerant'), false)
    assert.equal(mountsEditLinesPlugin('literal'), false)

    assert.equal(usesHashReadFormat('hashline'), true)
    assert.equal(usesHashReadFormat('line-edit'), false)
    assert.equal(usesTolerantEditHook('tolerant'), true)
    assert.equal(usesTolerantEditHook('literal'), false)

    const seenModes: string[] = []
    setActiveEditMode('tolerant')
    const unsub = onActiveEditModeChange(mode => seenModes.push(mode))
    setActiveEditMode('hashline')
    setActiveEditMode('line-edit')
    unsub()
    setActiveEditMode('tolerant')
    assert.deepEqual(seenModes, ['hashline', 'line-edit'])
    assert.equal(getActiveEditMode(), 'tolerant')
  })

  it('hot-swaps registered edit_lines schema on live mode changes and enforces folded-read-guard', async () => {
    setActiveEditMode('line-edit')
    const files = new Map<string, string>([['/ws/demo.py', 'x = 1\ny = 2\n']])
    let activeTool: any
    let disposals = 0
    let observedListener: ((target: any, obs: any, actor: any) => void) | undefined
    let cleanups: (() => void)[] = []

    const mockHost = {
      fs: {
        resolve: async (p: string) => ({ displayPath: p, targetKey: `/ws/${p}` }),
        readText: async (t: { targetKey: string }) => files.get(t.targetKey)!,
        writeText: async (t: { targetKey: string }, content: string) => {
          files.set(t.targetKey, content)
          return { version: `v-${content.length}` }
        },
        processPath: (t: { targetKey: string }) => t.targetKey,
      },
      tools: {
        register: (def: any) => {
          activeTool = def
          return () => {
            disposals++
            if (activeTool === def) activeTool = undefined
          }
        },
      },
      on: (ev: string, fn: any) => {
        if (ev === 'fs/observed') observedListener = fn
        return () => {}
      },
      emit: (ev: string, target: any, obs: any, actor: any) => {
        if (ev === 'fs/observed') observedListener?.(target, obs, actor)
      },
      effect: (fn: () => () => void) => {
        cleanups.push(fn())
      },
      get: (name: string) => (name === 'workingDirectory' ? { ensure: async () => '/ws' } : undefined),
    }

    applyLineEditEntry(mockHost as any)
    assert.ok(activeTool)
    assert.ok('start_line' in activeTool.parameters.properties)

    const session = { header: { id: 'sess-live-swap' } }
    const exec = { name: 'edit_lines', agent: { session, options: { provider: 'rwkv' } } }
    observedListener!(
      { displayPath: 'demo.py', targetKey: '/ws/demo.py' },
      { kind: 'present', version: 'v1' },
      { name: 'read', agent: { session } },
    )

    // Switch live to `hashline`: tool re-registers with `start` anchor schema while keeping observations!
    setActiveEditMode('hashline')
    assert.equal(disposals, 1)
    assert.ok('start' in activeTool.parameters.properties)
    assert.equal('start_line' in activeTool.parameters.properties, false)

    // Folded-read-guard blocks blind edit until re-read.
    setFoldedUnreadPaths('sess-live-swap', ['/ws/demo.py'])
    await assert.rejects(
      () => activeTool.execute({ file_path: 'demo.py', start: `1:${lineHash('x = 1')}`, new_text: 'x = 10' }, exec),
      /folded out of the active context window/,
    )

    // Clear folded-unread and apply hash-anchored edit successfully.
    setFoldedUnreadPaths('sess-live-swap', [])
    const out = await activeTool.execute({ file_path: 'demo.py', start: `1:${lineHash('x = 1')}`, new_text: 'x = 10' }, exec)
    assert.equal(files.get('/ws/demo.py'), 'x = 10\ny = 2\n')
    assert.match(out.summary, /Replaced line 1/)

    for (const cleanup of cleanups) cleanup()
    setActiveEditMode('tolerant')
  })
})
