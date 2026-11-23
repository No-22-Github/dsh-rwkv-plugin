// Shared coordinate, window rendering, seen-line tracking, and sandbox policy
// primitives used by coordinate-based line editing (`line-edit`).
// Pure functions with zero DSH or Node runtime imports.

export interface LineEdit {
  /** First line replaced (1-based). */
  readonly startLine: number
  /** Last line replaced; startLine - 1 replaces nothing (an insert before startLine). */
  readonly endLine: number
  /** Optional anchor text of line `startLine` (without line-number prefix) for drift verification & self-healing. */
  readonly startText?: string
  /** Optional anchor text of line `endLine` for multi-line spans. */
  readonly endText?: string
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
  /** Resolved 1-based line range (may differ from requested if self-healed via `start_text` / `end_text`). */
  readonly resolvedStart?: number
  readonly resolvedEnd?: number
  readonly alignedNote?: string
  readonly anchorVerified?: boolean
  readonly strippedLineNumbers?: boolean
  readonly reindented?: boolean
}

export const pluralLines = (count: number): string => `${count} line${count === 1 ? '' : 's'}`

/** Split text into LF lines along with its detected line ending and trailing-newline flag. */
export function splitDocumentLines(text: string): {
  readonly eol: '\r\n' | '\n'
  readonly trailingNewline: boolean
  readonly lines: readonly string[]
} {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = eol === '\r\n' ? text.replace(/\r\n/g, '\n') : text
  const trailingNewline = normalized.endsWith('\n')
  const lines = normalized === '' ? [] : (trailingNewline ? normalized.slice(0, -1) : normalized).split('\n')
  return { eol, trailingNewline, lines }
}

/** Reassemble edited LF lines while preserving the original file's EOL and trailing newline. */
export function joinDocumentLines(
  after: readonly string[],
  eol: '\r\n' | '\n',
  trailingNewline: boolean,
  wasEmpty: boolean,
): string {
  const keepNewline = trailingNewline || (wasEmpty && after.length > 0)
  const joined = after.join('\n') + (keepNewline && after.length > 0 ? '\n' : '')
  return eol === '\r\n' ? joined.replace(/\n/g, '\r\n') : joined
}

/**
 * Render lines `from..to` with neutral headers (`=== path (lines X-Y of Z) ===`).
 * Avoids SWE-agent's `[File: path (N lines total)]` banner which empirically
 * hijacks raw RWKV-7 weights into emitting `str_replace_editor` calls.
 */
export function renderWindow(displayPath: string, lines: readonly string[], from: number, to: number): string {
  if (lines.length === 0) return `=== ${displayPath} (empty file, 0 lines) ===`
  const first = Math.max(1, Math.min(lines.length, from))
  const last = Math.max(first, Math.min(lines.length, to))
  const out = [`=== ${displayPath} (lines ${first}-${last} of ${lines.length}) ===`]
  if (first > 1) out.push(`(${pluralLines(first - 1)} above)`)
  for (let n = first; n <= last; n++) out.push(`${n}: ${lines[n - 1]}`)
  if (last < lines.length) out.push(`(${pluralLines(lines.length - last)} below)`)
  return out.join('\n')
}

// --- Seen-line window tracking ----------------------------------------------

/** Lines (1-based) of the current file version shown to the model; `'all'` when whole or untracked. */
export type SeenLines = ReadonlySet<number> | 'all'

/** Add lines `first..last` (inclusive) to `seen`. */
export function addSeen(seen: SeenLines, first: number, last: number): SeenLines {
  if (seen === 'all') return seen
  const next = new Set(seen)
  for (let n = Math.max(1, first); n <= last; n++) next.add(n)
  return next
}

/**
 * Lines the edit needs the model to have seen that it has not: the replaced
 * lines, or for an insert a neighbour (the line before or after the gap).
 */
export function unseenLines(
  seen: SeenLines,
  edit: { readonly startLine: number; readonly endLine: number; readonly newText?: string },
  total: number,
): number[] {
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

/** Lines seen after a single edit: old ones renumbered, plus the new lines and result window. */
export function seenAfterEdit(
  seen: SeenLines,
  edit: { readonly startLine: number; readonly endLine: number; readonly newText?: string },
  result: Pick<LineEditResult, 'added' | 'removed' | 'after'>,
  contextLines = 3,
): SeenLines {
  if (seen === 'all') return seen
  const { startLine: start, endLine: end } = edit
  const delta = result.added - result.removed
  const next = new Set<number>()
  for (const n of seen) {
    if (n < start) next.add(n)
    else if (n > end) next.add(n + delta)
  }
  const total = result.after.length
  const from = Math.max(1, start - contextLines)
  const to = Math.min(total, start + Math.max(result.added, 1) - 1 + contextLines)
  for (let n = from; n <= to; n++) next.add(n)
  return next
}

/** Lines seen after an atomic multi-hunk edit (hunks given in pre-edit ascending order). */
export function seenAfterBatchEdit(
  seen: SeenLines,
  hunks: readonly { readonly startLine: number; readonly endLine: number; readonly removed: number; readonly added: number }[],
  afterTotal: number,
  contextLines = 3,
): SeenLines {
  if (seen === 'all') return seen
  const ordered = [...hunks].sort((a, b) => a.startLine - b.startLine)
  // Remap existing seen line numbers across all pre-edit hunks in one pass.
  const next = new Set<number>()
  for (const n of seen) {
    let shift = 0
    let overwritten = false
    for (const h of ordered) {
      if (h.endLine >= h.startLine && n >= h.startLine && n <= h.endLine) {
        overwritten = true
        break
      }
      if (n > h.endLine || (h.endLine < h.startLine && n >= h.startLine)) {
        shift += h.added - h.removed
      }
    }
    if (!overwritten && n + shift >= 1 && n + shift <= afterTotal) {
      next.add(n + shift)
    }
  }
  // Add every edited hunk's post-edit lines plus ±contextLines window.
  let cumulativeDelta = 0
  for (const h of ordered) {
    const postStart = h.startLine + cumulativeDelta
    const from = Math.max(1, postStart - contextLines)
    const to = Math.min(afterTotal, postStart + Math.max(h.added, 1) - 1 + contextLines)
    for (let n = from; n <= to; n++) next.add(n)
    cumulativeDelta += h.added - h.removed
  }
  return next
}

/** Format a set of 1-based line numbers into compact `"1-150, 200-230"` ranges. */
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

/** Model-facing refusal of an edit that touches lines outside the model's read window. */
export function unseenRejection(
  displayPath: string,
  missing: readonly number[],
  seen: ReadonlySet<number>,
  total: number,
  contextLines = 3,
): string {
  const offset = Math.max(1, missing[0]! - contextLines)
  const shown = seen.size === 0 ? 'you have seen none of it' : `you have seen lines ${formatRanges(seen)}`
  const which = missing.length === 1 ? `line ${missing[0]} of ${displayPath} has` : `lines ${formatRanges(missing)} of ${displayPath} have`
  return `Your edit was NOT applied: ${which} not been shown to you `
    + `(the file has ${total} lines; ${shown}). `
    + `Read them first (read with offset=${offset}), then edit by the numbers you see.`
}

// --- Sandbox policy helper --------------------------------------------------

/**
 * Resolve the calling session's sandbox policy (never the deployment cwd
 * fallback) before mutating via `ctx.fs`.
 */
export function sandboxPolicyFor(
  service: { resolve(request?: { session?: object }): unknown } | undefined,
  session: object | undefined,
): unknown {
  if (service === undefined) return undefined
  return service.resolve(session === undefined ? {} : { session })
}
