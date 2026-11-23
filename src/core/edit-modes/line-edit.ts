// Pure engine, wire mapping, and argument aliases for `editMode: 'line-edit'`
// (Anchored Batch Line-Edit v2).
//
// Designed for RWKV-7's linear-state physics (empirically benchmarked on raw
// rwkv7-g1l-7.2b):
//   - Semantic single-line anchors (`start_text`, optional `end_text`) achieve
//     ~100% recall across long windows + noise, whereas bare integer line
//     numbers drift by ±1..±5 lines (~93.5% silent corruption without anchors)
//     and 2-hex hashline prefixes get 0% recall while destroying line tracking.
//   - 3-tier self-healing:
//       L1: exact `start_line` match (score >= 0.90)
//       L2: local ±15 line window unique relocation (exact >= 0.98 strictly
//           beats fuzzy runner-ups; >=2 local exact hits abort as ambiguous)
//       L3: whole-file unique fallback for non-trivial anchors (trimmed len >= 10)
//   - Atomic multi-hunk `edits[]`: all hunks resolved in pre-edit coordinates,
//     overlap-checked, applied bottom-up, and syntax-checked once before write.
//   - Defensive guards: auto-reindent on anchor indent drift, copied `N: ` line
//     prefix stripping, elision placeholder guard (`...`), no-op guard,
//     boundary duplication guard, and ±8 numbered context on error.
//   - 100% backward compatible with single-hunk `{ start_line, end_line, new_text }`.

import type { EditModeSpec } from './literal.ts'
import {
  joinDocumentLines,
  pluralLines,
  renderWindow,
  splitDocumentLines,
  type LineEdit,
  type LineEditResult,
} from './shared.ts'
import { reindent, similarity } from './tolerant.ts'

/** Empirically verified RWKV-7 line-number fidelity ceiling (95.7% ±5 recall <=200 lines; 0% at 320 lines). */
export const MAX_LINE_EDIT_READ_LINES = 200

export const LINE_EDIT_MODE: EditModeSpec = {
  id: 'line-edit',
  excludedTools: [],
  mountsEditLinesPlugin: true,
  maxReadLines: MAX_LINE_EDIT_READ_LINES,
  usesTolerantHook: false,
}

export const LINE_EDIT_CONTEXT_LINES = 3
const ANCHOR_SEARCH_RADIUS = 15
const END_ANCHOR_SEARCH_RADIUS = 10
const ERROR_WINDOW_RADIUS = 8
const MIN_WHOLE_FILE_ANCHOR_LEN = 10

const PATH_ALIASES = ['file_path', 'filepath', 'file', 'filename', 'file_name'] as const
const NATIVE_PATH_ALIASES = ['path', 'filepath', 'file', 'filename', 'file_name'] as const

export const LINE_EDIT_WIRE_SCHEMA: Record<string, unknown> = {
  properties: {
    path: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          start_text: { type: 'string' },
          end_text: { type: 'string' },
          new_text: { type: 'string' },
        },
      },
    },
    start_line: { type: 'integer' },
    end_line: { type: 'integer' },
    start_text: { type: 'string' },
    end_text: { type: 'string' },
    new_text: { type: 'string' },
  },
}

/**
 * Canonical flat placeholder rendered for `edit_lines` under `toolNames: 'dsh'`.
 * Keeps the nested `edits[]` hunk structure explicit instead of flattening it
 * into `"optional array of object"` via generic JSON-schema summarization.
 */
export const LINE_EDIT_DSH_WIRE_ARGUMENTS =
  '{"file_path":"path to edit (read the file first)","edits":[{"start_line":"1-based first line","end_line":"1-based last line (start_line - 1 inserts)","start_text":"original text at start_line without line number","end_text":"optional original text at end_line","new_text":"replacement lines without line numbers (empty deletes)"}]}'

export const LINE_EDIT_TRAINED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  path: PATH_ALIASES,
  start_line: ['startLine', 'line_start', 'from_line', 'start', 'line'],
  end_line: ['endLine', 'line_end', 'to_line', 'end'],
  start_text: ['startText', 'anchor', 'start_anchor', 'first_line'],
  end_text: ['endText', 'end_anchor', 'last_line'],
  new_text: ['newText', 'new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
}

export const LINE_EDIT_NATIVE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  file_path: NATIVE_PATH_ALIASES,
  start_line: ['startLine', 'line_start', 'from_line', 'start', 'line', 'offset'],
  end_line: ['endLine', 'line_end', 'to_line', 'end'],
  start_text: ['startText', 'anchor', 'start_anchor', 'first_line'],
  end_text: ['endText', 'end_anchor', 'last_line'],
  new_text: ['newText', 'new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
}

export interface RawLineEditHunk {
  readonly start_line: number
  readonly end_line: number
  readonly start_text?: string
  readonly end_text?: string
  readonly new_text: string
}

export interface ResolvedLineEdit {
  readonly index: number
  readonly requestedStart: number
  readonly requestedEnd: number
  readonly startLine: number
  readonly endLine: number
  readonly newLines: readonly string[]
  readonly removed: number
  readonly added: number
  readonly strippedLineNumbers: boolean
  readonly reindented: boolean
  readonly alignedNote?: string
  readonly anchorVerified: boolean
  readonly endAnchorVerified: boolean
}

export interface BatchLineEditResult {
  readonly content: string
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly hunks: readonly ResolvedLineEdit[]
  readonly totalRemoved: number
  readonly totalAdded: number
}

export interface ApplyLineEditsOptions {
  /** Enable ±15 local and whole-file unique `start_text` self-healing + indent alignment (default true). */
  readonly selfHeal?: boolean
}

// --- Normalization & anchor helpers -----------------------------------------

const TRIVIAL_ANCHORS = new Set([
  '{', '}', '(', ')', '[', ']', '},', '],', ');', '};',
  'else:', 'else {', '} else {', 'try:', 'try {', 'finally:', 'finally {',
  'pass', 'break', 'continue', 'return', 'return;', 'return None', 'return true', 'return false',
  'end', 'fi', 'done', 'esac',
])

const ELISION_LINE = /^\s*(?:\/\/|#|\/\*|--|<!--)?\s*(?:\.\.\.|…)\s*(?:existing|unchanged|rest|remaining|omitted|same|code|lines|more|snip|truncated)?[^\n]{0,40}(?:\*\/|-->)?\s*$/i

const NUMBERED_PREFIX = /^(\d+): ?(.*)$/

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

function normalizeAnchorLine(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripOptionalLinePrefix(text: string): string {
  const m = /^\s*\d+:\s?(.*)$/.exec(text)
  return m ? m[1]! : text
}

/** True when `anchor` carries enough semantic content to uniquely verify a target line. */
export function isNonTrivialAnchor(anchor: string | undefined, minLen = 8): boolean {
  if (typeof anchor !== 'string') return false
  const cleaned = normalizeAnchorLine(stripOptionalLinePrefix(anchor))
  if (cleaned.length < minLen) return false
  if (TRIVIAL_ANCHORS.has(cleaned)) return false
  return /[A-Za-z0-9_\u4e00-\u9fff]{3,}/.test(cleaned)
}

function lineAnchorScore(anchor: string, fileLine: string): number {
  const raw = stripOptionalLinePrefix(anchor)
  const a = normalizeAnchorLine(raw)
  const b = normalizeAnchorLine(fileLine)
  if (a === '' && b === '') return 1
  if (a === '' || b === '') return 0
  if (a === b) return 1
  // Allow truncated prefix anchors (model quoted first >= 16 chars of a long line).
  if (a.length >= 16 && b.startsWith(a)) return 0.96
  return similarity(a, b)
}

function newLinesOf(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
}

/**
 * Strip accidentally copied `N: ` line-number prefixes from `new_text` when
 * every non-empty line carries a sequential prefix near `startLine` and the
 * original file doesn't use literal `N: ` lines there.
 */
function stripNumberedReplacement(
  newLines: readonly string[],
  startLine: number,
  before: readonly string[],
): { readonly lines: string[]; readonly stripped: boolean } {
  if (newLines.length === 0) return { lines: [], stripped: false }
  const existingNear = before.slice(Math.max(0, startLine - 2), Math.min(before.length, startLine + 2))
  if (existingNear.some(line => NUMBERED_PREFIX.test(line))) {
    return { lines: [...newLines], stripped: false }
  }
  const out: string[] = []
  let expected: number | undefined
  let numberedCount = 0
  for (const line of newLines) {
    if (line === '') {
      out.push('')
      if (expected !== undefined) expected++
      continue
    }
    const m = NUMBERED_PREFIX.exec(line)
    if (!m) return { lines: [...newLines], stripped: false }
    const num = Number(m[1])
    if (expected === undefined) {
      if (Math.abs(num - startLine) > 20) return { lines: [...newLines], stripped: false }
      expected = num + 1
    } else {
      if (num !== expected) return { lines: [...newLines], stripped: false }
      expected++
    }
    numberedCount++
    out.push(m[2]!)
  }
  if (numberedCount === 0 || (numberedCount === 1 && newLines.length > 1)) {
    return { lines: [...newLines], stripped: false }
  }
  return { lines: out, stripped: true }
}

function pickUniqueAnchorHit(
  hits: readonly { readonly ln: number; readonly score: number }[],
): { readonly kind: 'unique'; readonly ln: number } | { readonly kind: 'ambiguous'; readonly lines: readonly number[] } | { readonly kind: 'none' } {
  if (hits.length === 0) return { kind: 'none' }
  const exact = hits.filter(h => h.score >= 0.98)
  if (exact.length === 1) return { kind: 'unique', ln: exact[0]!.ln }
  if (exact.length > 1) return { kind: 'ambiguous', lines: exact.map(h => h.ln) }
  const sorted = [...hits].sort((a, b) => b.score - a.score)
  const best = sorted[0]!
  const runner = sorted[1]
  if (best.score >= 0.90 && (!runner || runner.score <= best.score - 0.08)) {
    return { kind: 'unique', ln: best.ln }
  }
  return { kind: 'ambiguous', lines: sorted.slice(0, 4).map(h => h.ln) }
}

function refineEndLineWithEndText(
  before: readonly string[],
  resolvedStart: number,
  resolvedEnd: number,
  endText: string,
  allowSelfHeal: boolean,
): { readonly ok: true; readonly endLine: number; readonly note?: string } | { readonly ok: false } {
  if (resolvedEnd < resolvedStart || resolvedEnd > before.length) return { ok: false }
  if (lineAnchorScore(endText, before[resolvedEnd - 1]!) >= 0.90) {
    return { ok: true, endLine: resolvedEnd }
  }
  if (!allowSelfHeal) return { ok: false }
  const lo = Math.max(resolvedStart, resolvedEnd - END_ANCHOR_SEARCH_RADIUS)
  const hi = Math.min(before.length, resolvedEnd + END_ANCHOR_SEARCH_RADIUS)
  const hits: { ln: number; score: number }[] = []
  for (let ln = lo; ln <= hi; ln++) {
    const score = lineAnchorScore(endText, before[ln - 1]!)
    if (score >= 0.90) hits.push({ ln, score })
  }
  const picked = pickUniqueAnchorHit(hits)
  if (picked.kind === 'unique') {
    return {
      ok: true,
      endLine: picked.ln,
      note: `Auto-aligned edit end_line ${resolvedEnd} -> ${picked.ln} via end_text.`,
    }
  }
  return { ok: false }
}

function resolveSingleHunk(
  before: readonly string[],
  displayPath: string,
  edit: LineEdit,
  index: number,
  totalHunks: number,
  allowSelfHeal: boolean,
): ResolvedLineEdit | string {
  const label = totalHunks > 1 ? `edit #${index + 1}` : 'edit'
  const { startLine: start, endLine: end } = edit
  const total = before.length
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return `${label}: start_line and end_line must be whole numbers`
  }
  if (start < 1) return `${label}: start_line must be 1 or more (got ${start})`
  if (start > total + 1) return `${label}: start_line ${start} is past the end: ${displayPath} has ${total} lines`
  if (end > total) return `${label}: end_line ${end} is past the end: ${displayPath} has ${total} lines`
  if (end < start - 1) {
    return `${label}: end_line ${end} is before start_line ${start}; use end_line = start_line - 1 to insert without replacing`
  }

  const isInsert = end === start - 1
  const rawAnchor = typeof edit.startText === 'string' ? edit.startText : ''
  const hasAnchor = rawAnchor.trim() !== ''

  let resolvedStart = start
  let resolvedEnd = end
  let alignedNote: string | undefined
  let anchorVerified = false
  let endAnchorVerified = false
  let matchedAnchorLine: string | undefined

  if (hasAnchor && total > 0) {
    const anchorTargetLine = isInsert ? (start <= total ? start : total) : start
    const directLine = before[anchorTargetLine - 1]
    if (directLine !== undefined && lineAnchorScore(rawAnchor, directLine) >= 0.90) {
      anchorVerified = true
      matchedAnchorLine = directLine
    } else if (allowSelfHeal) {
      // Tier 2: local ±15 line window search.
      const lo = Math.max(1, anchorTargetLine - ANCHOR_SEARCH_RADIUS)
      const hi = Math.min(total, anchorTargetLine + ANCHOR_SEARCH_RADIUS)
      const localHits: { ln: number; score: number }[] = []
      for (let ln = lo; ln <= hi; ln++) {
        const score = lineAnchorScore(rawAnchor, before[ln - 1]!)
        if (score >= 0.90) localHits.push({ ln, score })
      }
      const localExactHits = localHits.filter(h => h.score >= 0.98)
      const localPick = pickUniqueAnchorHit(localHits)
      const localIsExact = localExactHits.length === 1 && localPick.kind === 'unique' && localPick.ln === localExactHits[0]!.ln

      if (localIsExact) {
        const shift = localPick.ln - anchorTargetLine
        const nextStart = start + shift
        const nextEnd = end + shift
        if (nextStart >= 1 && nextStart <= total + 1 && nextEnd <= total && nextEnd >= nextStart - 1) {
          resolvedStart = nextStart
          resolvedEnd = nextEnd
          anchorVerified = true
          matchedAnchorLine = before[localPick.ln - 1]
          alignedNote = `Auto-aligned ${label} lines ${start}-${end} -> ${resolvedStart}-${resolvedEnd} via start_text.`
        }
      } else if (localExactHits.length > 1) {
        const win = renderWindow(displayPath, before, Math.max(1, anchorTargetLine - ERROR_WINDOW_RADIUS), Math.min(total, anchorTargetLine + ERROR_WINDOW_RADIUS))
        return `Your ${label} in ${displayPath} was NOT applied: start_text (${JSON.stringify(rawAnchor.trim())}) did not match line ${anchorTargetLine}, and matched multiple nearby lines (${localExactHits.map(h => h.ln).join(', ')}).\n\nCurrent lines around line ${anchorTargetLine}:\n${win}`
      }

      // Tier 3: whole-file unique fallback for non-trivial anchors (len >= 10) — exact file-wide match beats a fuzzy local hit.
      if (!anchorVerified && isNonTrivialAnchor(rawAnchor, MIN_WHOLE_FILE_ANCHOR_LEN)) {
        const globalHits: { ln: number; score: number }[] = []
        for (let ln = 1; ln <= total; ln++) {
          const score = lineAnchorScore(rawAnchor, before[ln - 1]!)
          if (score >= 0.92) globalHits.push({ ln, score })
        }
        const globalExact = globalHits.filter(h => h.score >= 0.98)
        const globalPick = pickUniqueAnchorHit(globalHits)
        if (globalPick.kind === 'unique' && (globalExact.length === 1 || localPick.kind !== 'unique')) {
          const shift = globalPick.ln - anchorTargetLine
          const nextStart = start + shift
          const nextEnd = end + shift
          if (nextStart >= 1 && nextStart <= total + 1 && nextEnd <= total && nextEnd >= nextStart - 1) {
            resolvedStart = nextStart
            resolvedEnd = nextEnd
            anchorVerified = true
            matchedAnchorLine = before[globalPick.ln - 1]
            alignedNote = `Auto-aligned ${label} lines ${start}-${end} -> ${resolvedStart}-${resolvedEnd} via unique file-wide start_text.`
          }
        }
      }

      // Accept unique fuzzy local match if no exact file-wide match superseded it.
      if (!anchorVerified && localPick.kind === 'unique') {
        const shift = localPick.ln - anchorTargetLine
        const nextStart = start + shift
        const nextEnd = end + shift
        if (nextStart >= 1 && nextStart <= total + 1 && nextEnd <= total && nextEnd >= nextStart - 1) {
          resolvedStart = nextStart
          resolvedEnd = nextEnd
          anchorVerified = true
          matchedAnchorLine = before[localPick.ln - 1]
          alignedNote = `Auto-aligned ${label} lines ${start}-${end} -> ${resolvedStart}-${resolvedEnd} via start_text.`
        }
      }

      if (!anchorVerified) {
        const win = renderWindow(displayPath, before, Math.max(1, anchorTargetLine - ERROR_WINDOW_RADIUS), Math.min(total, anchorTargetLine + ERROR_WINDOW_RADIUS))
        const extraMatches: string[] = []
        for (let ln = 1; ln <= total; ln++) {
          if (lineAnchorScore(rawAnchor, before[ln - 1]!) >= 0.80) {
            extraMatches.push(`  ${ln}: ${before[ln - 1]!}`)
            if (extraMatches.length >= 4) break
          }
        }
        const candHint = extraMatches.length > 0
          ? `\nMatching lines elsewhere in ${displayPath}:\n${extraMatches.join('\n')}`
          : ''
        return `Your ${label} in ${displayPath} was NOT applied: start_text (${JSON.stringify(rawAnchor.trim())}) did not match line ${anchorTargetLine} (${JSON.stringify(before[anchorTargetLine - 1]?.trim() ?? '')}).${candHint}\n\nCurrent lines around line ${anchorTargetLine}:\n${win}`
      }
    } else {
      const win = renderWindow(displayPath, before, Math.max(1, start - ERROR_WINDOW_RADIUS), Math.min(total, Math.max(end, start) + ERROR_WINDOW_RADIUS))
      return `Your ${label} in ${displayPath} was NOT applied: start_text (${JSON.stringify(rawAnchor.trim())}) did not match line ${anchorTargetLine} (${JSON.stringify(before[anchorTargetLine - 1]?.trim() ?? '')}).\n${win}`
    }
  }

  // Optional `end_text` verification & end-line drift auto-alignment for multi-line spans.
  if (!isInsert && typeof edit.endText === 'string' && edit.endText.trim() !== '') {
    const endCheck = refineEndLineWithEndText(before, resolvedStart, resolvedEnd, edit.endText, allowSelfHeal)
    if (!endCheck.ok) {
      const win = renderWindow(displayPath, before, Math.max(1, resolvedStart - 3), Math.min(total, resolvedEnd + ERROR_WINDOW_RADIUS))
      return `Your ${label} in ${displayPath} was NOT applied: end_text (${JSON.stringify(edit.endText.trim())}) did not match line ${resolvedEnd} (${JSON.stringify(before[resolvedEnd - 1]?.trim() ?? '')}).\n\nCurrent lines around line ${resolvedEnd}:\n${win}`
    }
    resolvedEnd = endCheck.endLine
    endAnchorVerified = true
    if (endCheck.note) {
      alignedNote = alignedNote ? `${alignedNote} ${endCheck.note}` : endCheck.note
    }
  }

  const rawNewLines = newLinesOf(edit.newText)
  const { lines: strippedLines, stripped: strippedLineNumbers } = stripNumberedReplacement(rawNewLines, resolvedStart, before)
  let newLines = strippedLines
  let reindented = false

  // Auto-align base indentation only when `start_text` itself carried non-empty
  // leading whitespace (so trimmed anchors never push column-0 additions into an
  // indented block).
  if (allowSelfHeal && matchedAnchorLine !== undefined && newLines.length > 0 && hasAnchor) {
    const anchorWithoutPrefix = stripOptionalLinePrefix(rawAnchor)
    const oldIndent = indentOf(anchorWithoutPrefix)
    const fileIndent = indentOf(matchedAnchorLine)
    const firstNonBlank = newLines.find(line => line.trim() !== '')
    if (
      oldIndent !== fileIndent
      && firstNonBlank !== undefined
      && oldIndent.length > 0
      && firstNonBlank.startsWith(oldIndent)
    ) {
      const moved = reindent(newLines.join('\n'), [[oldIndent, fileIndent]]).split('\n')
      if (moved.join('\n') !== newLines.join('\n')) {
        newLines = moved
        reindented = true
      }
    }
  }

  const removedSlice = before.slice(resolvedStart - 1, resolvedEnd)
  const oldTrimmedSet = new Set(removedSlice.map(line => line.trim()))
  for (const nl of newLines) {
    if (ELISION_LINE.test(nl) && !oldTrimmedSet.has(nl.trim())) {
      return `Your ${label} in ${displayPath} was NOT applied: new_text contains an elision placeholder (${JSON.stringify(nl.trim())}), which would delete code. Narrow start_line..end_line to only the lines changing and write complete replacement code.`
    }
  }

  if (removedSlice.length === newLines.length && removedSlice.every((line, i) => line === newLines[i])) {
    const spanStr = resolvedStart === resolvedEnd ? `line ${resolvedStart}` : `lines ${resolvedStart}-${resolvedEnd}`
    return `No edit needed in ${displayPath}: new_text is the same as ${spanStr}; nothing changed.`
  }

  // Off-by-one boundary duplication guard: catches accidentally duplicating untouched line start-1 or end+1.
  if (newLines.length >= 2 && resolvedStart > 1) {
    const above = before[resolvedStart - 2]!.trim()
    if (above.length >= 8 && newLines[0]!.trim() === above && !oldTrimmedSet.has(above)) {
      const win = renderWindow(displayPath, before, Math.max(1, resolvedStart - 4), Math.min(total, Math.max(resolvedEnd, resolvedStart) + 4))
      return `Your ${label} in ${displayPath} was NOT applied: the first line of new_text duplicates line ${resolvedStart - 1} (${JSON.stringify(above)}) immediately above start_line=${resolvedStart}. Drop that unchanged line from new_text or adjust start_line.\n\n${win}`
    }
  }
  if (newLines.length >= 2 && resolvedEnd < total) {
    const below = before[resolvedEnd]!.trim()
    if (below.length >= 8 && newLines[newLines.length - 1]!.trim() === below && !oldTrimmedSet.has(below)) {
      const win = renderWindow(displayPath, before, Math.max(1, resolvedStart - 4), Math.min(total, Math.max(resolvedEnd, resolvedStart) + 4))
      return `Your ${label} in ${displayPath} was NOT applied: the last line of new_text duplicates line ${resolvedEnd + 1} (${JSON.stringify(below)}) immediately below end_line=${resolvedEnd}. Drop that unchanged line from new_text or adjust end_line.\n\n${win}`
    }
  }

  return {
    index,
    requestedStart: start,
    requestedEnd: end,
    startLine: resolvedStart,
    endLine: resolvedEnd,
    newLines,
    removed: removedSlice.length,
    added: newLines.length,
    strippedLineNumbers,
    reindented,
    ...(alignedNote ? { alignedNote } : {}),
    anchorVerified,
    endAnchorVerified,
  }
}

function hunksOverlap(a: ResolvedLineEdit, b: ResolvedLineEdit): boolean {
  const aInsert = a.endLine < a.startLine
  const bInsert = b.endLine < b.startLine
  if (aInsert && bInsert) return a.startLine === b.startLine
  if (aInsert) return a.startLine > b.startLine && a.startLine <= b.endLine
  if (bInsert) return b.startLine > a.startLine && b.startLine <= a.endLine
  return a.startLine <= b.endLine && b.startLine <= a.endLine
}

/**
 * Atomically resolve and apply one or more non-overlapping anchored line edits
 * against pre-edit file coordinates. Returns either the full batch result or a
 * model-facing error string.
 */
export function applyAnchoredLineEdits(
  text: string,
  displayPath: string,
  edits: readonly LineEdit[],
  options: ApplyLineEditsOptions = {},
): BatchLineEditResult | string {
  if (edits.length === 0) return 'edits must contain at least one edit hunk'
  const allowSelfHeal = options.selfHeal !== false
  const { eol, trailingNewline, lines: before } = splitDocumentLines(text)

  const resolved: ResolvedLineEdit[] = []
  for (let i = 0; i < edits.length; i++) {
    const out = resolveSingleHunk(before, displayPath, edits[i]!, i, edits.length, allowSelfHeal)
    if (typeof out === 'string') return out
    resolved.push(out)
  }

  // Overlap check across all resolved pre-edit ranges.
  const sortedAsc = [...resolved].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  for (let i = 1; i < sortedAsc.length; i++) {
    if (hunksOverlap(sortedAsc[i - 1]!, sortedAsc[i]!)) {
      return `Your batch edit in ${displayPath} was NOT applied: edit #${sortedAsc[i - 1]!.index + 1} (lines ${sortedAsc[i - 1]!.startLine}-${sortedAsc[i - 1]!.endLine}) overlaps edit #${sortedAsc[i]!.index + 1} (lines ${sortedAsc[i]!.startLine}-${sortedAsc[i]!.endLine}). Combine overlapping edits into one range.`
    }
  }

  // Apply bottom-up so earlier pre-edit line numbers stay valid.
  const after = [...before]
  const sortedDesc = [...sortedAsc].reverse()
  for (const h of sortedDesc) {
    after.splice(h.startLine - 1, h.removed, ...h.newLines)
  }

  const content = joinDocumentLines(after, eol, trailingNewline, before.length === 0)
  const totalRemoved = resolved.reduce((acc, h) => acc + h.removed, 0)
  const totalAdded = resolved.reduce((acc, h) => acc + h.added, 0)
  return { content, before, after, hunks: sortedAsc, totalRemoved, totalAdded }
}

/** Backward-compatible single-hunk entry point (`applyLineEdit`). */
export function applyLineEdit(
  text: string,
  displayPath: string,
  edit: LineEdit,
  options: ApplyLineEditsOptions = {},
): LineEditResult | string {
  const batch = applyAnchoredLineEdits(text, displayPath, [edit], options)
  if (typeof batch === 'string') return batch
  const h = batch.hunks[0]!
  return {
    content: batch.content,
    before: batch.before,
    after: batch.after,
    removed: h.removed,
    added: h.added,
    resolvedStart: h.startLine,
    resolvedEnd: h.endLine,
    ...(h.alignedNote ? { alignedNote: h.alignedNote } : {}),
    anchorVerified: h.anchorVerified,
    strippedLineNumbers: h.strippedLineNumbers,
    reindented: h.reindented,
  }
}

// --- Summaries & syntax-error messages --------------------------------------

function resultWindow(displayPath: string, start: number, added: number, after: readonly string[]): string {
  return renderWindow(
    displayPath,
    after,
    start - LINE_EDIT_CONTEXT_LINES,
    start + Math.max(added, 1) - 1 + LINE_EDIT_CONTEXT_LINES,
  )
}

/** Model-facing result of an applied single coordinate line edit. */
export function editSummary(displayPath: string, edit: LineEdit, result: LineEditResult): string {
  const start = result.resolvedStart ?? edit.startLine
  const end = result.resolvedEnd ?? edit.endLine
  const { removed, added } = result
  let what: string
  if (removed === 0) what = start > 1 ? `Inserted ${pluralLines(added)} after line ${start - 1}` : `Inserted ${pluralLines(added)} at the start`
  else if (added === 0) what = `Deleted lines ${start}-${end}`
  else what = `Replaced lines ${start}-${end} with ${pluralLines(added)}`
  const parts = [`File updated. ${what}.`]
  if (result.alignedNote) parts.push(`(${result.alignedNote})`)
  if (result.strippedLineNumbers) parts.push('(Stripped copied line-number prefixes from new_text.)')
  if (result.reindented) parts.push('(Auto-aligned indentation to match the file.)')
  const delta = added - removed
  if (delta !== 0 && end < result.before.length) {
    parts.push(`Lines after it moved ${delta > 0 ? 'down' : 'up'} by ${Math.abs(delta)}: old line ${end + 1} is now line ${end + 1 + delta}.`)
  }
  parts.push('Review the change (correct indentation, no duplicate or missing lines) and edit again if necessary.')
  return `${parts.join(' ')}\n${resultWindow(displayPath, start, added, result.after)}`
}

/** Model-facing result of an applied atomic multi-hunk (or single-hunk) edit. */
export function batchEditSummary(displayPath: string, batch: BatchLineEditResult): string {
  if (batch.hunks.length === 1) {
    const h = batch.hunks[0]!
    return editSummary(
      displayPath,
      { startLine: h.startLine, endLine: h.endLine, newText: h.newLines.join('\n') },
      {
        content: batch.content,
        before: batch.before,
        after: batch.after,
        removed: h.removed,
        added: h.added,
        resolvedStart: h.startLine,
        resolvedEnd: h.endLine,
        ...(h.alignedNote ? { alignedNote: h.alignedNote } : {}),
        anchorVerified: h.anchorVerified,
        strippedLineNumbers: h.strippedLineNumbers,
        reindented: h.reindented,
      },
    )
  }
  const notes: string[] = []
  let cumulativeDelta = 0
  const windows: string[] = []
  for (const h of batch.hunks) {
    const postStart = h.startLine + cumulativeDelta
    if (h.alignedNote) notes.push(h.alignedNote)
    if (h.strippedLineNumbers) notes.push(`Stripped copied line-number prefixes in edit #${h.index + 1}.`)
    if (h.reindented) notes.push(`Auto-aligned indentation in edit #${h.index + 1}.`)
    windows.push(resultWindow(displayPath, postStart, h.added, batch.after))
    cumulativeDelta += h.added - h.removed
  }
  const parts = [`File updated with ${batch.hunks.length} atomic edits (${pluralLines(batch.totalRemoved)} removed, ${pluralLines(batch.totalAdded)} added).`]
  if (notes.length > 0) parts.push(`(${notes.join(' ')})`)
  parts.push('Review the updated windows below and edit again if necessary.')
  return `${parts.join(' ')}\n${windows.join('\n\n')}`
}

/** Model-facing refusal of a single edit that would break the file's syntax (not applied). */
export function syntaxRejection(displayPath: string, edit: LineEdit, result: LineEditResult, error: string): string {
  const start = result.resolvedStart ?? edit.startLine
  const end = result.resolvedEnd ?? edit.endLine
  const original = renderWindow(displayPath, result.before, start - LINE_EDIT_CONTEXT_LINES, Math.max(end, start) + LINE_EDIT_CONTEXT_LINES)
  return [
    'Your edit was NOT applied: it introduces a syntax error.',
    `ERROR: ${error}`,
    '',
    'This is how the file would have looked:',
    resultWindow(displayPath, start, result.added, result.after),
    '',
    'This is the original code before your edit:',
    original,
    '',
    'Fix start_line/end_line or new_text (check the indentation) and try again. Do not repeat the same edit.',
  ].join('\n')
}

/** Model-facing refusal of a batch edit that would break the file's syntax (not applied). */
export function batchSyntaxRejection(displayPath: string, batch: BatchLineEditResult, error: string): string {
  if (batch.hunks.length === 1) {
    const h = batch.hunks[0]!
    return syntaxRejection(
      displayPath,
      { startLine: h.startLine, endLine: h.endLine, newText: h.newLines.join('\n') },
      {
        content: batch.content,
        before: batch.before,
        after: batch.after,
        removed: h.removed,
        added: h.added,
        resolvedStart: h.startLine,
        resolvedEnd: h.endLine,
      },
      error,
    )
  }
  const first = batch.hunks[0]!
  const last = batch.hunks[batch.hunks.length - 1]!
  const delta = batch.totalAdded - batch.totalRemoved
  const afterWin = renderWindow(displayPath, batch.after, first.startLine - LINE_EDIT_CONTEXT_LINES, last.endLine + delta + LINE_EDIT_CONTEXT_LINES)
  const beforeWin = renderWindow(displayPath, batch.before, first.startLine - LINE_EDIT_CONTEXT_LINES, last.endLine + LINE_EDIT_CONTEXT_LINES)
  return [
    `Your batch edit (${batch.hunks.length} hunks) was NOT applied: it introduces a syntax error.`,
    `ERROR: ${error}`,
    '',
    'This is how the file would have looked:',
    afterWin,
    '',
    'This is the original code before your edit:',
    beforeWin,
    '',
    'Fix the affected hunk(s) and try again. Do not repeat the same edit.',
  ].join('\n')
}

// --- Argument parsing & normalization (batch + single-hunk shorthand) -------

function toSafeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/,/g, '').trim())
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

function normalizeRawHunk(raw: unknown): RawLineEditHunk | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const sl = toSafeInt(obj.start_line ?? obj.startLine ?? obj.line_start ?? obj.from_line ?? obj.start ?? obj.line)
  const el = toSafeInt(obj.end_line ?? obj.endLine ?? obj.line_end ?? obj.to_line ?? obj.end)
  const ntRaw = obj.new_text ?? obj.newText ?? obj.new_string ?? obj.new_str ?? obj.text ?? obj.content ?? obj.replacement ?? obj.lines
  if (sl === undefined || el === undefined || typeof ntRaw !== 'string') return undefined
  const stRaw = obj.start_text ?? obj.startText ?? obj.anchor ?? obj.start_anchor ?? obj.first_line
  const etRaw = obj.end_text ?? obj.endText ?? obj.end_anchor ?? obj.last_line
  return {
    start_line: sl,
    end_line: el,
    ...(typeof stRaw === 'string' ? { start_text: stRaw } : {}),
    ...(typeof etRaw === 'string' ? { end_text: etRaw } : {}),
    new_text: ntRaw,
  }
}

/**
 * Parse either canonical batch `edits[]` (array, single object, or JSON string)
 * or single-hunk top-level `{ start_line, end_line, start_text?, end_text?, new_text }`
 * into normalized `LineEdit[]` hunks.
 */
export function parseLineEditHunks(args: Record<string, unknown>): LineEdit[] | string {
  if (args.edits !== undefined) {
    let source: unknown = args.edits
    if (typeof source === 'string') {
      try {
        source = JSON.parse(source)
      } catch {
        return 'edits must be a valid JSON array of edit hunks'
      }
    }
    const items = Array.isArray(source) ? source : (typeof source === 'object' && source !== null ? [source] : undefined)
    if (!items || items.length === 0) return 'edits must be a non-empty array of { start_line, end_line, start_text?, new_text } hunks'
    const out: LineEdit[] = []
    for (let i = 0; i < items.length; i++) {
      const normalized = normalizeRawHunk(items[i])
      if (normalized === undefined) {
        return `edits[${i}] is missing required start_line, end_line, or new_text`
      }
      out.push({
        startLine: normalized.start_line,
        endLine: normalized.end_line,
        ...(normalized.start_text !== undefined ? { startText: normalized.start_text } : {}),
        ...(normalized.end_text !== undefined ? { endText: normalized.end_text } : {}),
        newText: normalized.new_text,
      })
    }
    return out
  }

  const single = normalizeRawHunk(args)
  if (single === undefined) {
    return 'Provide either edits: [{ start_line, end_line, start_text, new_text }] or single-hunk start_line, end_line, new_text'
  }
  return [{
    startLine: single.start_line,
    endLine: single.end_line,
    ...(single.start_text !== undefined ? { startText: single.start_text } : {}),
    ...(single.end_text !== undefined ? { endText: single.end_text } : {}),
    newText: single.new_text,
  }]
}

/** Normalize raw model arguments for `edit_lines` (`edits[]` or single-hunk shorthand) into clean wire/DSH args. */
export function normalizeLineEditArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.edits === undefined) return args
  let source: unknown = args.edits
  if (typeof source === 'string') {
    try { source = JSON.parse(source) } catch { return args }
  }
  const items = Array.isArray(source) ? source : (typeof source === 'object' && source !== null ? [source] : undefined)
  if (!items || items.length === 0) return args
  const normalized = items.map(item => normalizeRawHunk(item) ?? item)
  return { ...args, edits: normalized }
}
