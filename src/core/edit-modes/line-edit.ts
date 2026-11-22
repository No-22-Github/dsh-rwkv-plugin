// Pure engine, wire mapping, and argument aliases for `editMode: 'line-edit'`.
//
// Modelled on SWE-agent's windowed `edit <start>:<end>`: 1-based inclusive
// line range, `end_line = start_line - 1` inserts before `start_line` without
// replacing, empty `new_text` deletes the range, and one trailing newline on
// `new_text` is ignored.

import type { EditModeSpec } from './literal.ts'
import {
  joinDocumentLines,
  pluralLines,
  renderWindow,
  splitDocumentLines,
  type LineEdit,
  type LineEditResult,
} from './shared.ts'

export const LINE_EDIT_MODE: EditModeSpec = {
  id: 'line-edit',
  excludedTools: [],
  mountsEditLinesPlugin: true,
  formatsHashRead: false,
  usesTolerantHook: false,
}

export const LINE_EDIT_CONTEXT_LINES = 3

const PATH_ALIASES = ['file_path', 'filepath', 'file', 'filename', 'file_name'] as const
const NATIVE_PATH_ALIASES = ['path', 'filepath', 'file', 'filename', 'file_name'] as const

export const LINE_EDIT_WIRE_SCHEMA: Record<string, unknown> = {
  properties: {
    path: { type: 'string' },
    start_line: { type: 'integer' },
    end_line: { type: 'integer' },
    new_text: { type: 'string' },
  },
}

export const LINE_EDIT_TRAINED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  path: PATH_ALIASES,
  start_line: ['line_start', 'from_line', 'start', 'line'],
  end_line: ['line_end', 'to_line', 'end'],
  new_text: ['new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
}

export const LINE_EDIT_NATIVE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  file_path: NATIVE_PATH_ALIASES,
  start_line: ['line_start', 'from_line', 'start', 'line', 'offset'],
  end_line: ['line_end', 'to_line', 'end'],
  new_text: ['new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
}

function newLinesOf(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
}

/** Apply a 1-based coordinate line edit, or return a model-facing error message. */
export function applyLineEdit(text: string, displayPath: string, edit: LineEdit): LineEditResult | string {
  const { startLine: start, endLine: end } = edit
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'start_line and end_line must be whole numbers'
  const { eol, trailingNewline, lines } = splitDocumentLines(text)
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
  const content = joinDocumentLines(after, eol, trailingNewline, total === 0)
  return { content, before: lines, after, removed: removed.length, added: newLines.length }
}

function resultWindow(displayPath: string, edit: LineEdit, result: LineEditResult): string {
  return renderWindow(
    displayPath,
    result.after,
    edit.startLine - LINE_EDIT_CONTEXT_LINES,
    edit.startLine + Math.max(result.added, 1) - 1 + LINE_EDIT_CONTEXT_LINES,
  )
}

/** Model-facing result of an applied coordinate line edit: what changed, line shift, and window. */
export function editSummary(displayPath: string, edit: LineEdit, result: LineEditResult): string {
  const { startLine: start, endLine: end } = edit
  const { removed, added } = result
  let what: string
  if (removed === 0) what = start > 1 ? `Inserted ${pluralLines(added)} after line ${start - 1}` : `Inserted ${pluralLines(added)} at the start`
  else if (added === 0) what = `Deleted lines ${start}-${end}`
  else what = `Replaced lines ${start}-${end} with ${pluralLines(added)}`
  const parts = [`File updated. ${what}.`]
  const delta = added - removed
  if (delta !== 0 && end < result.before.length) {
    parts.push(`Lines after it moved ${delta > 0 ? 'down' : 'up'} by ${Math.abs(delta)}: old line ${end + 1} is now line ${end + 1 + delta}.`)
  }
  parts.push('Review the change (correct indentation, no duplicate or missing lines) and edit again if necessary.')
  return `${parts.join(' ')}\n${resultWindow(displayPath, edit, result)}`
}

/** Model-facing refusal of a coordinate edit that would break the file's syntax (not applied). */
export function syntaxRejection(displayPath: string, edit: LineEdit, result: LineEditResult, error: string): string {
  const original = renderWindow(
    displayPath,
    result.before,
    edit.startLine - LINE_EDIT_CONTEXT_LINES,
    Math.max(edit.endLine, edit.startLine) + LINE_EDIT_CONTEXT_LINES,
  )
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
