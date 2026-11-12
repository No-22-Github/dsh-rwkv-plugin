import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyLineEdit } from '../src/core/line-edit.ts'
import { buildCatalog, type DshToolSchema } from '../src/core/tools.ts'
import { capReadResult, spillNotice, spillText, textTokens, RESULT_TOKEN_BUDGET } from '../src/result-budget.ts'

const FILE = 'a\nb\nc\nd\ne\n'

function ok(text: string, start: number, end: number, newText: string) {
  const result = applyLineEdit(text, 'f.txt', { startLine: start, endLine: end, newText })
  assert.equal(typeof result, 'object', String(result))
  return result as Exclude<typeof result, string>
}

test('edit_lines: replace, delete, insert, append', () => {
  assert.equal(ok(FILE, 2, 3, 'B\nC2\nC3').content, 'a\nB\nC2\nC3\nd\ne\n')
  assert.equal(ok(FILE, 2, 3, 'B\n').content, 'a\nB\nd\ne\n', 'one trailing newline in new_text is ignored')
  assert.equal(ok(FILE, 2, 4, '').content, 'a\ne\n')
  assert.equal(ok(FILE, 1, 0, 'top').content, 'top\na\nb\nc\nd\ne\n')
  assert.equal(ok(FILE, 6, 5, 'f').content, 'a\nb\nc\nd\ne\nf\n')
  assert.equal(ok(FILE, 3, 3, '\n').content, 'a\nb\n\nd\ne\n', 'a lone newline is one empty line')
  assert.equal(ok('x\r\ny\r\n', 2, 2, 'Y').content, 'x\r\nY\r\n', 'CRLF kept')
  assert.equal(ok('x\ny', 2, 2, 'Y').content, 'x\nY', 'no trailing newline kept')
  assert.equal(ok('', 1, 0, 'new').content, 'new\n')
})

test('edit_lines: summary shows new numbers and the shift', () => {
  const { summary } = ok(FILE, 2, 2, 'b1\nb2\nb3')
  assert.match(summary, /^The file f\.txt has been updated\. Replaced lines 2-2 with 3 lines\./)
  assert.match(summary, /moved down by 2: old line 3 is now line 5\./)
  assert.match(summary, /\nLines 1-6 now:\n1: a\n2: b1\n3: b2\n4: b3\n5: c\n6: d$/)
  assert.doesNotMatch(ok(FILE, 5, 5, 'E').summary, /moved/, 'no shift note when nothing follows')
  assert.match(ok(FILE, 2, 4, '').summary, /Deleted lines 2-4\. Lines after it moved up by 3: old line 5 is now line 2\./)
})

test('edit_lines: refusals', () => {
  const err = (start: number, end: number, newText = 'x') => applyLineEdit(FILE, 'f.txt', { startLine: start, endLine: end, newText }) as string
  assert.match(err(0, 1), /start_line must be 1 or more/)
  assert.match(err(7, 7), /past the end: f\.txt has 5 lines/)
  assert.match(err(2, 6), /end_line 6 is past the end/)
  assert.match(err(4, 2), /before start_line/)
  assert.match(err(2, 2, 'b'), /nothing changed/)
})

test('catalog: edit_lines replaces edit when offered', () => {
  const offered: DshToolSchema[] = ['read', 'edit', 'write', 'edit_lines'].map(name => ({
    name, description: `${name}.`, parameters: { properties: { file_path: { type: 'string' } } },
  }))
  for (const names of ['dsh', 'trained'] as const) {
    const catalog = buildCatalog(offered, { mode: 'mapped', names }).map(tool => tool.dshName)
    assert.deepEqual(catalog.sort(), ['edit_lines', 'read', 'write'])
  }
  const without = buildCatalog(offered.filter(tool => tool.name !== 'edit_lines'), { mode: 'mapped' })
  assert.ok(without.some(tool => tool.dshName === 'edit'))
})

test('result budget: spill keeps head and tail and names the file', () => {
  const text = `HEAD${'x'.repeat(40_000)}TAIL`
  const out = spillText(text, RESULT_TOKEN_BUDGET, bytes => spillNotice(bytes, '/spill/web_fetch.txt', 'Read it with read.'))
  assert.ok(textTokens(out) <= RESULT_TOKEN_BUDGET, `${textTokens(out)} tokens`)
  assert.ok(out.startsWith('HEAD') && out.includes('TAIL\n\n(Omitted '))
  assert.match(out, /\n\n\[\.\.\.\]\n\n/)
  assert.match(out, /\(Omitted \d+ bytes\. Full formatted result stored at: \/spill\/web_fetch\.txt\. Read it with read\.\)$/)
  const head = out.slice(0, out.indexOf('\n\n[...]\n\n'))
  const tail = out.slice(out.indexOf('\n\n[...]\n\n') + 9, out.lastIndexOf('\n\n(Omitted'))
  assert.equal(Number(/Omitted (\d+) bytes/.exec(out)?.[1]) + head.length + tail.length, text.length)
})

test('result budget: read is shortened at a line with a continuation footer', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `${i + 1}: ${'y'.repeat(40)}`)
  const text = `<path>/w/big.txt</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n(End of file - total 2000 lines)\n</content>`
  const out = capReadResult(text, RESULT_TOKEN_BUDGET)
  assert.ok(out !== undefined)
  assert.ok(textTokens(out) <= RESULT_TOKEN_BUDGET)
  const shown = /Showing lines 1-(\d+)\. Use offset=(\d+) to continue\.\)\n<\/content>$/.exec(out)
  assert.ok(shown, out.slice(-200))
  assert.equal(Number(shown[2]), Number(shown[1]) + 1)
  assert.ok(out.includes(`\n${shown[1]}: y`) && !out.includes(`\n${Number(shown[1]) + 1}: y`))
  assert.equal(capReadResult(text.slice(0, 500), RESULT_TOKEN_BUDGET), undefined, 'short results untouched')
})
