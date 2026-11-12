// Line-range editing: the text side of the edit_lines tool (src/line-edit.ts).
//
// RWKV cannot look back at a file it read, so copying old_string verbatim is
// where its literal edits fail (longer quotes fail more). Here the model names
// lines by the numbers read showed it and writes only the new text. Modelled
// on SWE-agent's windowed `edit <start>:<end>` (tools/windowed_edit_linting):
// inclusive range, one trailing newline of the replacement ignored, a window
// of the result after the edit, and an edit that breaks the file's syntax is
// not applied but shown next to the original. Whether the numbers still
// describe the file is the tool's version guard (src/line-edit.ts).
//
// Pure functions, no DSH imports, so the pipeline and tests can use them.

export interface LineEdit {
  /** First line replaced (1-based). */
  readonly startLine: number
  /** Last line replaced; startLine - 1 replaces nothing (an insert before startLine). */
  readonly endLine: number
  /** Lines that take their place; empty deletes them. One trailing newline is ignored. */
  readonly newText: string
}

export interface LineEditResult {
  /** The whole new file text, in the file's own line endings. */
  readonly content: string
  /** Lines before and after the edit (LF, no trailing newline). */
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly removed: number
  readonly added: number
}

/** Lines of context around the edit in the result windows. */
const CONTEXT = 3

/** The edited file, or a model-facing error message. */
export function applyLineEdit(text: string, displayPath: string, edit: LineEdit): LineEditResult | string {
  const { startLine: start, endLine: end } = edit
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'start_line and end_line must be whole numbers'
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = eol === '\r\n' ? text.replace(/\r\n/g, '\n') : text
  const trailingNewline = normalized.endsWith('\n')
  const lines = normalized === '' ? [] : (trailingNewline ? normalized.slice(0, -1) : normalized).split('\n')
  const total = lines.length

  if (start < 1) return `start_line must be 1 or more (got ${start})`
  if (start > total + 1) return `start_line ${start} is past the end: ${displayPath} has ${total} lines`
  if (end > total) return `end_line ${end} is past the end: ${displayPath} has ${total} lines`
  if (end < start - 1) return `end_line ${end} is before start_line ${start}; use end_line = start_line - 1 to insert without replacing`

  const newLines = newLinesOf(edit.newText)
  const removed = lines.slice(start - 1, end)
  if (removed.length === newLines.length && removed.every((line, index) => line === newLines[index])) {
    return `new_text is the same as lines ${start}-${end}; nothing changed`
  }
  const after = [...lines.slice(0, start - 1), ...newLines, ...lines.slice(end)]
  const keepNewline = trailingNewline || (total === 0 && after.length > 0)
  const joined = after.join('\n') + (keepNewline && after.length > 0 ? '\n' : '')
  const content = eol === '\r\n' ? joined.replace(/\n/g, '\r\n') : joined
  return { content, before: lines, after, removed: removed.length, added: newLines.length }
}

function newLinesOf(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
}

const plural = (count: number) => `${count} line${count === 1 ? '' : 's'}`

/** Lines from..to as read shows them, with SWE-agent's status and above/below lines. */
export function renderWindow(displayPath: string, lines: readonly string[], from: number, to: number): string {
  const out = [`[File: ${displayPath} (${plural(lines.length)} total)]`]
  if (lines.length === 0) return `${out[0]}\n(empty file)`
  const first = Math.max(1, from)
  const last = Math.min(lines.length, to)
  if (first > 1) out.push(`(${first - 1} more lines above)`)
  for (let n = first; n <= last; n++) out.push(`${n}: ${lines[n - 1]}`)
  if (last < lines.length) out.push(`(${lines.length - last} more lines below)`)
  return out.join('\n')
}

/** The changed lines of the result plus context, for the success and rejection messages. */
function resultWindow(displayPath: string, edit: LineEdit, result: LineEditResult): string {
  return renderWindow(displayPath, result.after, edit.startLine - CONTEXT, edit.startLine + Math.max(result.added, 1) - 1 + CONTEXT)
}

/** Model-facing result of an applied edit: what changed, the shift, and the window. */
export function editSummary(displayPath: string, edit: LineEdit, result: LineEditResult): string {
  const { startLine: start, endLine: end } = edit
  const { removed, added } = result
  let what: string
  if (removed === 0) what = start > 1 ? `Inserted ${plural(added)} after line ${start - 1}` : `Inserted ${plural(added)} at the start`
  else if (added === 0) what = `Deleted lines ${start}-${end}`
  else what = `Replaced lines ${start}-${end} with ${plural(added)}`
  const parts = [`File updated. ${what}.`]
  const delta = added - removed
  if (delta !== 0 && end < result.before.length) {
    parts.push(`Lines after it moved ${delta > 0 ? 'down' : 'up'} by ${Math.abs(delta)}: old line ${end + 1} is now line ${end + 1 + delta}.`)
  }
  parts.push('Review the change (correct indentation, no duplicate or missing lines) and edit again if necessary.')
  return `${parts.join(' ')}\n${resultWindow(displayPath, edit, result)}`
}

/** Model-facing refusal of an edit that would break the file's syntax (not applied). */
export function syntaxRejection(displayPath: string, edit: LineEdit, result: LineEditResult, error: string): string {
  const original = renderWindow(displayPath, result.before, edit.startLine - CONTEXT, Math.max(edit.endLine, edit.startLine) + CONTEXT)
  return [
    'Your edit was NOT applied: it introduces a syntax error.',
    `ERROR: ${error}`,
    '',
    'This is how the file would have looked:',
    resultWindow(displayPath, edit, result),
    '',
    'This is the original code before your edit:',
    original,
    '',
    'Fix start_line/end_line or new_text (check the indentation) and try again. Do not repeat the same edit.',
  ].join('\n')
}

// --- Which lines the model has seen ---------------------------------------
//
// Line numbers are only safe for lines the model was shown: a read cut at
// line 150 (src/result-budget.ts) says nothing about line 300, and an edit
// there is a guess. The tool keeps, per session and file version, the lines
// read showed (and the lines its own results showed), and refuses an edit
// that touches others; the refusal says which offset to read.

/** Lines (1-based) of the current file version the model has been shown; 'all' when unknown or whole. */
export type SeenLines = ReadonlySet<number> | 'all'

/** Add lines first..last (inclusive) to `seen`. */
export function addSeen(seen: SeenLines, first: number, last: number): SeenLines {
  if (seen === 'all') return seen
  const next = new Set(seen)
  for (let n = Math.max(1, first); n <= last; n++) next.add(n)
  return next
}

/**
 * Lines the edit needs the model to have seen that it has not: the replaced
 * lines, or for an insert a neighbour (the line before or after the gap).
 * `total` is the file's current line count.
 */
export function unseenLines(seen: SeenLines, edit: LineEdit, total: number): number[] {
  if (seen === 'all') return []
  const { startLine: start, endLine: end } = edit
  if (end >= start) {
    const missing: number[] = []
    for (let n = start; n <= end; n++) if (!seen.has(n)) missing.push(n)
    return missing
  }
  const neighbours = [start - 1, start].filter(n => n >= 1 && n <= total)
  return neighbours.length === 0 || neighbours.some(n => seen.has(n)) ? [] : neighbours
}

/** The lines seen after a successful edit: old ones renumbered, plus the new lines and the result window. */
export function seenAfterEdit(seen: SeenLines, edit: LineEdit, result: LineEditResult): SeenLines {
  if (seen === 'all') return seen
  const { startLine: start, endLine: end } = edit
  const delta = result.added - result.removed
  const next = new Set<number>()
  for (const n of seen) {
    if (n < start) next.add(n)
    else if (n > end) next.add(n + delta)
  }
  const total = result.after.length
  const from = Math.max(1, start - CONTEXT)
  const to = Math.min(total, start + Math.max(result.added, 1) - 1 + CONTEXT)
  for (let n = from; n <= to; n++) next.add(n)
  return next
}

/** "1-150, 200-230" */
export function formatRanges(lines: Iterable<number>): string {
  const sorted = [...lines].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(sorted[i] === sorted[j] ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** Model-facing refusal of an edit that touches lines it has not seen. */
export function unseenRejection(displayPath: string, missing: readonly number[], seen: ReadonlySet<number>, total: number): string {
  const offset = Math.max(1, missing[0]! - CONTEXT)
  const shown = seen.size === 0 ? 'you have seen none of it' : `you have seen lines ${formatRanges(seen)}`
  const which = missing.length === 1 ? `line ${missing[0]} of ${displayPath} has` : `lines ${formatRanges(missing)} of ${displayPath} have`
  return `Your edit was NOT applied: ${which} not been shown to you `
    + `(the file has ${total} lines; ${shown}). `
    + `Read them first (read with offset=${offset}), then edit by the numbers you see.`
}
