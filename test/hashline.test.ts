import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyHashEdit,
  formatHashReadResult,
  hashEditSummary,
  lineHash,
  stripHashPrefixes,
} from '../src/core/hashline.ts'

describe('hashline core', () => {
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
})
