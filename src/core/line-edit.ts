// Line-range editing: the text side of the edit_lines tool (src/line-edit.ts).
//
// RWKV cannot look back at a file it read, so copying old_string verbatim is
// where its literal edits fail (longer quotes fail more). Here the model names
// lines by the numbers read showed it and writes only the new text. Whether
// those numbers still describe the file is DSH's observation guard: the edit
// applies only to the version the session last read or wrote itself.
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
  /** Model-facing result: what changed and the changed lines as read shows them. */
  readonly summary: string
}

const CONTEXT = 2

/** The edited file, or a model-facing error message. */
export function applyLineEdit(text: string, displayPath: string, edit: LineEdit): LineEditResult | string {
  const { startLine: start, endLine: end } = edit
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'start_line and end_line must be whole numbers'
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = eol === '\r\n' ? text.replace(/\r\n/g, '\n') : text
  const trailingNewline = normalized.endsWith('\n')
  const body = trailingNewline ? normalized.slice(0, -1) : normalized
  const lines = normalized === '' ? [] : body.split('\n')
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
  return { content, summary: summarize(displayPath, edit, removed.length, newLines.length, after) }
}

function newLinesOf(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
}

const plural = (count: number) => `${count} line${count === 1 ? '' : 's'}`

function summarize(displayPath: string, edit: LineEdit, removed: number, added: number, after: readonly string[]): string {
  const { startLine: start, endLine: end } = edit
  let what: string
  if (removed === 0) what = start > 1 ? `Inserted ${plural(added)} after line ${start - 1}` : `Inserted ${plural(added)} at the start`
  else if (added === 0) what = `Deleted lines ${start}-${end}`
  else what = `Replaced lines ${start}-${end} with ${plural(added)}`
  const parts = [`The file ${displayPath} has been updated. ${what}.`]
  const delta = added - removed
  if (delta !== 0 && end < after.length - delta) {
    parts.push(`Lines after it moved ${delta > 0 ? 'down' : 'up'} by ${Math.abs(delta)}: old line ${end + 1} is now line ${end + 1 + delta}.`)
  }
  if (after.length === 0) {
    parts.push('The file is now empty.')
    return parts.join(' ')
  }
  const from = Math.max(1, start - CONTEXT)
  const to = Math.min(after.length, start + Math.max(added, 1) - 1 + CONTEXT)
  const window = after.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`)
  return `${parts.join(' ')}\nLines ${from}-${to} now:\n${window.join('\n')}`
}
