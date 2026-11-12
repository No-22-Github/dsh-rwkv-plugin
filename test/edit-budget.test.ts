import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addSeen, applyLineEdit, editSummary, formatRanges, seenAfterEdit, syntaxRejection, unseenLines, unseenRejection } from '../src/core/line-edit.ts'
import { introducedSyntaxError } from '../src/syntax-check.ts'
import { buildCatalog, type DshToolSchema } from '../src/core/tools.ts'
import { applyResultBudget, capReadResult, estimateTokens, readWindow, spillNotice, spillText, READ_SHOWN_EVENT, RESULT_TOKEN_BUDGET } from '../src/result-budget.ts'

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

test('edit_lines: summary shows new numbers, the shift and a window', () => {
  const edit = { startLine: 2, endLine: 2, newText: 'b1\nb2\nb3' }
  const summary = editSummary('f.txt', edit, ok(FILE, 2, 2, edit.newText))
  assert.match(summary, /^File updated\. Replaced lines 2-2 with 3 lines\. Lines after it moved down by 2: old line 3 is now line 5\. Review the change/)
  assert.match(summary, /\n\[File: f\.txt \(7 lines total\)\]\n1: a\n2: b1\n3: b2\n4: b3\n5: c\n6: d\n7: e$/)
  const last = { startLine: 5, endLine: 5, newText: 'E' }
  assert.doesNotMatch(editSummary('f.txt', last, ok(FILE, 5, 5, 'E')), /moved/, 'no shift note when nothing follows')
  assert.match(editSummary('f.txt', last, ok(FILE, 5, 5, 'E')), /\(1 more lines above\)\n2: b/)
  const del = { startLine: 2, endLine: 4, newText: '' }
  assert.match(editSummary('f.txt', del, ok(FILE, 2, 4, '')), /Deleted lines 2-4\. Lines after it moved up by 3: old line 5 is now line 2\./)
})

test('edit_lines: a syntax-breaking edit shows both versions', () => {
  const edit = { startLine: 2, endLine: 2, newText: 'B' }
  const message = syntaxRejection('f.txt', edit, ok(FILE, 2, 2, 'B'), 'SyntaxError: x (line 2)')
  assert.match(message, /^Your edit was NOT applied: it introduces a syntax error\.\nERROR: SyntaxError: x \(line 2\)/)
  assert.match(message, /would have looked:\n\[File: f\.txt \(5 lines total\)\]\n1: a\n2: B\n/)
  assert.match(message, /original code before your edit:\n\[File: f\.txt \(5 lines total\)\]\n1: a\n2: b\n/)
})

test('syntax check: only errors the edit introduces', async () => {
  assert.equal(await introducedSyntaxError('x = 1\n', 'x = 1\n', 'a.py'), undefined)
  assert.match(String(await introducedSyntaxError('def f():\n    return 1\n', 'def f():\nreturn 1\n', 'a.py')), /IndentationError: .*\(line 2\)/)
  assert.equal(await introducedSyntaxError('def f(:\n', 'def g(:\n', 'a.py'), undefined, 'already broken: not blocked')
  assert.match(String(await introducedSyntaxError('let a = 1\n', 'let a = (1\n', 'a.js')), /SyntaxError/)
  assert.match(String(await introducedSyntaxError('{"a":1}', '{"a":1,}', 'a.json')), /^JSON: /)
  assert.match(String(await introducedSyntaxError('if true; then :; fi\n', 'if true; then :;\n', 'a.sh')), /syntax error|unexpected/)
  assert.equal(await introducedSyntaxError('a', 'b(', 'notes.txt'), undefined, 'unknown extension: unchecked')
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
  assert.ok(estimateTokens(out) <= RESULT_TOKEN_BUDGET, `${estimateTokens(out)} tokens`)
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
  assert.ok(estimateTokens(out) <= RESULT_TOKEN_BUDGET)
  const shown = /Showing lines 1-(\d+) of 2000\. Use offset=(\d+) to continue\.\)\n<\/content>$/.exec(out)
  assert.ok(shown, out.slice(-200))
  assert.equal(Number(shown[2]), Number(shown[1]) + 1)
  assert.ok(out.includes(`\n${shown[1]}: y`) && !out.includes(`\n${Number(shown[1]) + 1}: y`))
  assert.equal(capReadResult(text.slice(0, 500), RESULT_TOKEN_BUDGET), undefined, 'short results untouched')
})

test('result budget: read footer keeps the total when DSH gave one', () => {
  const lines = Array.from({ length: 900 }, (_, i) => `${i + 1}: ${'z'.repeat(40)}`)
  const wrap = (footer: string) => `<path>/w/f.txt</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n${footer}\n</content>`
  // read's own line-limit footer (offset/limit given): the total survives the cut.
  assert.match(capReadResult(wrap('(Showing lines 1-900 of 4000. Use offset=901 to continue.)'), RESULT_TOKEN_BUDGET)!, /\(Showing lines 1-\d+ of 4000\. Use offset=\d+ to continue\.\)\n<\/content>$/)
  // read's byte cap: no total known, DSH's byte-cap wording.
  assert.match(capReadResult(wrap('(Output capped. Showing lines 1-900. Use offset=901 to continue.)'), RESULT_TOKEN_BUDGET)!, /\(Output capped\. Showing lines 1-\d+\. Use offset=\d+ to continue\.\)\n<\/content>$/)
})

test('result budget: readWindow reads the shown line numbers', () => {
  assert.deepEqual(readWindow('<path>/w/a</path>\n<type>file</type>\n<content>\n7: x\n8: \n9: (y\n\n(Showing lines 7-9 of 20. Use offset=10 to continue.)\n</content>'), { first: 7, last: 9 })
  assert.deepEqual(readWindow('<path>/w/a</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>'), { first: 1, last: 0 })
  assert.equal(readWindow('ENOENT: no such file'), undefined)
})

test('result budget: a read reports the window the model got', async () => {
  let listener: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const events: unknown[][] = []
  applyResultBudget({
    on: (_event: string, l: typeof listener) => { listener = l },
    emit: (...args: unknown[]) => { events.push(args) },
    get: () => undefined,
  }, { providers: () => ['rwkv'] })
  const exec = { name: 'read', callId: 'c1', agent: { options: { provider: 'rwkv' } } }
  const lines = Array.from({ length: 2000 }, (_, i) => `${i + 1}: ${'y'.repeat(40)}`)
  const text = `<path>/w/big.txt</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n(End of file - total 2000 lines)\n</content>`
  const decision = await listener!(exec, { content: [{ type: 'text', text }] }, async () => ({ kind: 'accept' })) as { content: { text: string }[] }
  const last = Number(/Showing lines 1-(\d+) of 2000/.exec(decision.content[0]!.text)?.[1])
  assert.deepEqual(events, [[READ_SHOWN_EVENT, exec, { first: 1, last }]])
  // Short reads are reported too (uncut).
  events.length = 0
  await listener!(exec, { content: [{ type: 'text', text: '<path>/w/s</path>\n<type>file</type>\n<content>\n1: a\n2: b\n\n(End of file - total 2 lines)\n</content>' }] }, async () => ({ kind: 'accept' }))
  assert.deepEqual(events, [[READ_SHOWN_EVENT, exec, { first: 1, last: 2 }]])
})

test('edit_lines: lines seen, refusals and renumbering', () => {
  const edit = (startLine: number, endLine: number) => ({ startLine, endLine, newText: 'x' })
  const seen = addSeen(new Set(), 1, 150)
  assert.deepEqual(unseenLines(seen, edit(140, 150), 400), [])
  assert.deepEqual(unseenLines(seen, edit(149, 152), 400), [151, 152])
  assert.deepEqual(unseenLines(seen, edit(151, 150), 400), [], 'insert right after the last seen line')
  assert.deepEqual(unseenLines(seen, edit(300, 299), 400), [299, 300])
  assert.deepEqual(unseenLines('all', edit(300, 310), 400), [])
  assert.deepEqual(unseenLines(new Set(), edit(1, 0), 0), [], 'empty file')
  const message = unseenRejection('src/a.py', [280, 281, 282], addSeen(addSeen(new Set(), 1, 150), 200, 230) as Set<number>, 412)
  assert.match(message, /NOT applied: lines 280-282 of src\/a\.py have not been shown/)
  assert.match(message, /\(the file has 412 lines; you have seen lines 1-150, 200-230\)/)
  assert.match(unseenRejection('a.py', [300], new Set(), 500), /NOT applied: line 300 of a\.py has not been shown to you \(the file has 500 lines; you have seen none of it\)/)
  assert.match(message, /read with offset=277/)
  // Replace lines 10-11 of a 200-line file with 4 lines: later lines move down 2.
  const before = Array.from({ length: 200 }, (_, i) => `l${i + 1}`)
  const result = ok(before.join('\n') + '\n', 10, 11, 'a\nb\nc\nd')
  const after = seenAfterEdit(addSeen(new Set(), 1, 20), { startLine: 10, endLine: 11, newText: 'a\nb\nc\nd' }, result) as Set<number>
  assert.equal(formatRanges(after), '1-22')
  const far = seenAfterEdit(addSeen(addSeen(new Set(), 1, 20), 100, 110), { startLine: 10, endLine: 11, newText: 'a\nb\nc\nd' }, result) as Set<number>
  assert.equal(formatRanges(far), '1-22, 102-112')
})

// Real RWKV World token counts (rwkv-tokenizer-go, rwkv_vocab_v20230424) of each
// text inside <tool_response>{"ok":true,"tool":"web_fetch","result":...}</tool_response>.
const MEASURED: Record<string, { text: string; tokens: number }> = {
  "english": {
    "text": "Fetched https://docs.python.org/3/library/csv.html (HTTP 200)\n\nThe csv module implements classes to read and write tabular data in CSV format. It allows programmers to say, \"write this data in the format preferred by Excel,\" without knowing the precise details of the CSV format used by Excel.\n\n| Parameter | Default |\n|---|---|\n| delimiter | ',' |\n| quotechar | '\"' |\n",
    "tokens": 126
  },
  "chinese": {
    "text": "根据国家统计局发布的数据，2025年全国居民人均可支配收入为43377元，比上年名义增长5.3%。分城乡看，城镇居民人均可支配收入56502元，农村居民人均可支配收入23119元。",
    "tokens": 106
  },
  "code": {
    "text": "<path>/app/src/tool.py</path>\n<type>file</type>\n<content>\n1: import tempfile\n2: \n3: def generate(render):\n4:     folder = tempfile.mkdtemp()\n5:     return render(folder)\n\n(End of file - total 5 lines)\n</content>",
    "tokens": 107
  },
  "digits": {
    "text": "SKU00003,WH-C,530,retired\nSKU00004,WH-B,367,retired\n0x7f3a9c2e 0x7f3a9c30 1734567890123 3.14159265358979\n",
    "tokens": 95
  }
}

test('result budget: the estimate does not fall below real RWKV token counts', () => {
  for (const [name, { text, tokens }] of Object.entries(MEASURED)) {
    const estimate = estimateTokens(text)
    assert.ok(estimate >= tokens, `${name}: estimate ${estimate} < real ${tokens}`)
    assert.ok(estimate <= tokens * 2, `${name}: estimate ${estimate} more than twice real ${tokens}`)
  }
})
