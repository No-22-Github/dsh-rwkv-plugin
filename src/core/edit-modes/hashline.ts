// Pure engine, wire mapping, and argument aliases for `editMode: 'hashline'`.
//
// Each line shown by `read` or `edit_lines` carries a 2-hex FNV-1a content tag
// (`12:a3| <code>`). Edits reference `{ start: "12:a3", end?: "15:f9", op, new_text }`
// without quoting `old_string`, verifying both boundary hashes before writing
// and returning a `+-5` line hash-tagged window for immediate hot-refresh.

import type { EditModeSpec } from './literal.ts'
import {
  joinDocumentLines,
  pluralLines,
  splitDocumentLines,
  type LineEditResult,
} from './shared.ts'

export const HASHLINE_EDIT_MODE: EditModeSpec = {
  id: 'hashline',
  excludedTools: [],
  mountsEditLinesPlugin: true,
  formatsHashRead: true,
  usesTolerantHook: false,
}

export type HashEditOp = 'replace' | 'insert_after' | 'delete'

export interface HashEdit {
  readonly start: string
  readonly end?: string
  readonly op?: HashEditOp
  readonly newText?: string
}

export const HASHLINE_CONTEXT_LINES = 5

const READ_LINE_RE = /^(\d+): (.*)$/
const HASH_PREFIX_RE = /^\s*\d+:[0-9a-f]{2}\| ?/i
const LINE_NUM_PREFIX_RE = /^\s*\d+: /
const LINE_REF_RE = /^\s*(\d+)\s*:\s*([0-9a-f]{2})\|?\s*$/i

const PATH_ALIASES = ['file_path', 'filepath', 'file', 'filename', 'file_name'] as const
const NATIVE_PATH_ALIASES = ['path', 'filepath', 'file', 'filename', 'file_name'] as const

export const HASHLINE_WIRE_SCHEMA: Record<string, unknown> = {
  properties: {
    path: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    op: { type: 'string', enum: ['replace', 'insert_after', 'delete'] },
    new_text: { type: 'string' },
  },
}

export const HASHLINE_TRAINED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  path: PATH_ALIASES,
  start: ['start_anchor', 'from', 'from_anchor', 'start_line', 'line_start', 'line'],
  end: ['end_anchor', 'to', 'to_anchor', 'end_line', 'line_end'],
  op: ['operation', 'action', 'mode'],
  new_text: ['new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
}

export const HASHLINE_NATIVE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  file_path: NATIVE_PATH_ALIASES,
  start: ['start_anchor', 'from', 'from_anchor', 'start_line', 'line_start', 'line'],
  end: ['end_anchor', 'to', 'to_anchor', 'end_line', 'line_end'],
  op: ['operation', 'action', 'mode'],
  new_text: ['new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
}

/** 2-hex-char FNV-1a content hash of a single line (without trailing CR/LF). */
export function lineHash(line: string): string {
  const clean = line.endsWith('\r') ? line.slice(0, -1) : line
  let h = 0x811c9dc5
  for (let i = 0; i < clean.length; i++) {
    h ^= clean.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h & 0xff).toString(16).padStart(2, '0')
}

/** Rewrite `<content>\nN: ...` lines in a DSH `read` result to `N:hh| ...`. */
export function formatHashReadResult(text: string): string {
  const open = text.indexOf('<content>\n')
  const close = text.lastIndexOf('\n</content>')
  if (open < 0 || close < open) return text
  const start = open + '<content>\n'.length
  const body = text.slice(start, close)
  const footerAt = body.lastIndexOf('\n\n(')
  const rawLines = (footerAt < 0 ? body : body.slice(0, footerAt)).split('\n')
  const formatted = rawLines.map(line => {
    const m = READ_LINE_RE.exec(line)
    if (!m) return line
    return `${m[1]}:${lineHash(m[2]!)}| ${m[2]}`
  })
  const footer = footerAt < 0 ? '' : body.slice(footerAt)
  return `${text.slice(0, start)}${formatted.join('\n')}${footer}${text.slice(close)}`
}

export function parseLineRef(ref: unknown): { readonly line: number; readonly hash: string } | string {
  if (typeof ref !== 'string') return `line anchor must be a "line:hash" string like "12:a3" (got ${typeof ref})`
  const m = LINE_REF_RE.exec(ref)
  if (!m) return `invalid line anchor ${JSON.stringify(ref)}; expected "line:hash" like "12:a3"`
  const line = Number(m[1])
  if (!Number.isSafeInteger(line) || line < 0) return `invalid line number in anchor ${JSON.stringify(ref)}`
  return { line, hash: m[2]!.toLowerCase() }
}

/** Strip accidental `12:a3| ` or `12: ` prefixes if all non-empty lines carry them. */
export function stripHashPrefixes(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const nonEmpty = lines.filter(l => l !== '')
  if (nonEmpty.length === 0) return text
  if (nonEmpty.every(l => HASH_PREFIX_RE.test(l))) {
    return lines.map(l => (l === '' ? '' : l.replace(HASH_PREFIX_RE, ''))).join('\n')
  }
  if (nonEmpty.every(l => LINE_NUM_PREFIX_RE.test(l))) {
    return lines.map(l => (l === '' ? '' : l.replace(LINE_NUM_PREFIX_RE, ''))).join('\n')
  }
  return text
}

export function renderHashWindow(displayPath: string, lines: readonly string[], from: number, to: number): string {
  const out = [`[File: ${displayPath} (${pluralLines(lines.length)} total)]`]
  if (lines.length === 0) return `${out[0]}\n(empty file)`
  const first = Math.max(1, from)
  const last = Math.min(lines.length, to)
  if (first > 1) out.push(`(${first - 1} more lines above)`)
  for (let n = first; n <= last; n++) {
    const content = lines[n - 1]!
    out.push(`${n}:${lineHash(content)}| ${content}`)
  }
  if (last < lines.length) out.push(`(${lines.length - last} more lines below)`)
  return out.join('\n')
}

function newLinesOf(text: string): string[] {
  if (text === '') return []
  const normalized = stripHashPrefixes(text).replace(/\r\n/g, '\n')
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
}

export interface HashEditApplied {
  readonly result: LineEditResult
  readonly op: HashEditOp
  readonly startLine: number
  readonly endLine: number
}

/** Apply a hash-anchored line edit, or return a model-facing error string. */
export function applyHashEdit(text: string, displayPath: string, edit: HashEdit): HashEditApplied | string {
  const op: HashEditOp = edit.op ?? 'replace'
  if (op !== 'replace' && op !== 'insert_after' && op !== 'delete') {
    return `invalid op ${JSON.stringify(op)}; expected "replace", "insert_after", or "delete"`
  }

  const startRef = parseLineRef(edit.start)
  if (typeof startRef === 'string') return startRef

  const { eol, trailingNewline, lines } = splitDocumentLines(text)
  const total = lines.length

  // Allow inserting into an empty file with start="0:00" or "1:00".
  if (total === 0 && op !== 'delete' && (startRef.line === 0 || startRef.line === 1)) {
    const newLines = newLinesOf(edit.newText ?? '')
    if (newLines.length === 0) return 'new_text is empty; nothing to write to empty file'
    const content = joinDocumentLines(newLines, eol, true, true)
    return {
      result: { content, before: lines, after: newLines, removed: 0, added: newLines.length },
      op,
      startLine: 1,
      endLine: 0,
    }
  }

  if (startRef.line < 1 || startRef.line > total) {
    return `start line ${startRef.line} out of range: ${displayPath} has ${total} lines.\n${renderHashWindow(displayPath, lines, total - HASHLINE_CONTEXT_LINES, total)}`
  }
  const actualStartHash = lineHash(lines[startRef.line - 1]!)
  if (actualStartHash !== startRef.hash) {
    return `hash mismatch at line ${startRef.line} of ${displayPath} (got ${startRef.hash}, current is ${actualStartHash}). `
      + `Re-check the current lines below before editing:\n${renderHashWindow(displayPath, lines, startRef.line - HASHLINE_CONTEXT_LINES, startRef.line + HASHLINE_CONTEXT_LINES)}`
  }

  let endLine = startRef.line
  if (op !== 'insert_after' && edit.end !== undefined && edit.end !== '') {
    const endRef = parseLineRef(edit.end)
    if (typeof endRef === 'string') return endRef
    if (endRef.line < startRef.line || endRef.line > total) {
      return `end line ${endRef.line} out of range for start ${startRef.line} (${displayPath} has ${total} lines).\n`
        + renderHashWindow(displayPath, lines, startRef.line - HASHLINE_CONTEXT_LINES, Math.min(total, endRef.line + HASHLINE_CONTEXT_LINES))
    }
    const actualEndHash = lineHash(lines[endRef.line - 1]!)
    if (actualEndHash !== endRef.hash) {
      return `hash mismatch at end line ${endRef.line} of ${displayPath} (got ${endRef.hash}, current is ${actualEndHash}). `
        + `Re-check the current lines below before editing:\n${renderHashWindow(displayPath, lines, endRef.line - HASHLINE_CONTEXT_LINES, endRef.line + HASHLINE_CONTEXT_LINES)}`
    }
    endLine = endRef.line
  }

  const newLines = op === 'delete' ? [] : newLinesOf(edit.newText ?? '')
  let sliceStart: number
  let sliceEnd: number
  if (op === 'insert_after') {
    if (newLines.length === 0) return 'new_text is empty for op="insert_after"'
    sliceStart = startRef.line
    sliceEnd = startRef.line
  } else {
    sliceStart = startRef.line - 1
    sliceEnd = endLine
    const removed = lines.slice(sliceStart, sliceEnd)
    if (removed.length === newLines.length && removed.every((line, i) => line === newLines[i])) {
      return `new_text is identical to lines ${startRef.line}-${endLine}; nothing changed`
    }
  }

  const after = [...lines.slice(0, sliceStart), ...newLines, ...lines.slice(sliceEnd)]
  const content = joinDocumentLines(after, eol, trailingNewline, total === 0)
  return {
    result: {
      content,
      before: lines,
      after,
      removed: sliceEnd - sliceStart,
      added: newLines.length,
    },
    op,
    startLine: op === 'insert_after' ? startRef.line + 1 : startRef.line,
    endLine: op === 'insert_after' ? startRef.line : endLine,
  }
}

export function hashEditSummary(displayPath: string, applied: HashEditApplied): string {
  const { op, startLine, endLine, result } = applied
  const { removed, added } = result
  let what: string
  if (op === 'insert_after') what = `Inserted ${pluralLines(added)} after line ${startLine - 1}`
  else if (op === 'delete' || added === 0) what = `Deleted lines ${startLine}-${endLine}`
  else if (startLine === endLine) what = `Replaced line ${startLine} with ${pluralLines(added)}`
  else what = `Replaced lines ${startLine}-${endLine} with ${pluralLines(added)}`

  const parts = [`File updated. ${what}.`]
  const delta = added - removed
  if (delta !== 0 && endLine < result.before.length) {
    parts.push(`Lines after it moved ${delta > 0 ? 'down' : 'up'} by ${Math.abs(delta)}.`)
  }
  const winFrom = Math.max(1, startLine - HASHLINE_CONTEXT_LINES)
  const winTo = startLine + Math.max(added, 1) - 1 + HASHLINE_CONTEXT_LINES
  parts.push(renderHashWindow(displayPath, result.after, winFrom, winTo))
  return parts.join('\n')
}

/** Model-facing refusal of a hash-anchored edit that would break syntax, with hash-tagged windows. */
export function hashSyntaxRejection(displayPath: string, applied: HashEditApplied, error: string): string {
  const { startLine, endLine, result } = applied
  const afterTo = startLine + Math.max(result.added, 1) - 1 + HASHLINE_CONTEXT_LINES
  const beforeTo = Math.max(endLine, startLine) + HASHLINE_CONTEXT_LINES
  return [
    'Your edit was NOT applied: it introduces a syntax error.',
    `ERROR: ${error}`,
    '',
    'This is how the file would have looked:',
    renderHashWindow(displayPath, result.after, startLine - HASHLINE_CONTEXT_LINES, afterTo),
    '',
    'This is the original code before your edit (use these line:hash anchors to retry):',
    renderHashWindow(displayPath, result.before, startLine - HASHLINE_CONTEXT_LINES, beforeTo),
    '',
    'Fix start/end or new_text (check parentheses, braces, quotes, and indentation) and try again. Do not repeat the same edit.',
  ].join('\n')
}
