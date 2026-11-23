// Pure engine and specification for `editMode: 'tolerant'` (default).
//
// Keeps the standard `{ file_path, old_string, new_string }` contract unchanged
// and resolves near-miss `old_string` regions through a strict-to-loose
// uniqueness ladder:
//   1. single-line leading-indent alignment (prevents partial-indent substring hits);
//   2. Unicode/trailing-space fuzzy match;
//   3. indentation-insensitive match;
//   4. blank-line-insensitive match;
//   5. inner-whitespace-insensitive match;
//   6. unique close match (>= 90% bigram Dice similarity) guarded by dual
//      boundary anchors (>= 88% on both first and last lines + split-anchor
//      omitted-middle detection so shortened blocks never slide across
//      repetitive lines).
//
// Replacements are automatically re-indented to the file's indentation style,
// and unchanged context lines keep the file's exact bytes so recall drift in
// surrounding lines never reaches disk.

import type { EditModeSpec } from './literal.ts'

export const TOLERANT_EDIT_MODE: EditModeSpec = {
  id: 'tolerant',
  excludedTools: ['edit_lines'],
  mountsEditLinesPlugin: false,
  usesTolerantHook: true,
}

export type MatchLevel = 'fuzzy' | 'indentation' | 'blank-lines' | 'whitespace' | 'similar'

const LEVEL_TEXT: Readonly<Record<MatchLevel, string>> = {
  fuzzy: 'after normalizing trailing whitespace/quotes',
  indentation: 'ignoring indentation',
  'blank-lines': 'ignoring blank lines',
  whitespace: 'ignoring whitespace differences',
  similar: 'as the closest match',
}

export interface RegionMatch {
  readonly level: MatchLevel
  /** Character offsets in the LF-normalized file. */
  readonly start: number
  readonly end: number
  /** 1-based inclusive line range. */
  readonly firstLine: number
  readonly lastLine: number
  /** Aligned [oldText line, file line] pairs of the matched lines. */
  readonly pairs: readonly (readonly [string, string])[]
  /** Blank lines in the file skipped between consecutive matched pairs. */
  readonly gaps?: readonly (readonly string[])[]
  readonly midStart?: boolean
  readonly midEnd?: boolean
  readonly similarity?: number
}

export type RegionResult =
  | { readonly kind: 'match'; readonly match: RegionMatch }
  | { readonly kind: 'ambiguous'; readonly level: MatchLevel; readonly lines: readonly number[] }
  | { readonly kind: 'none'; readonly closest?: { readonly firstLine: number; readonly lastLine: number; readonly similarity: number } }

export type ResolvedTolerantEdit =
  | { readonly kind: 'exact' }
  | { readonly kind: 'repaired'; readonly oldString: string; readonly newString: string; readonly note: string }
  | { readonly kind: 'refused'; readonly message: string }

export const toLF = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0]
const isBlank = (line: string): boolean => line.trim() === ''
const trimKey = (line: string): string => line.trim()
const spaceKey = (line: string): string => line.replace(/\s+/g, ' ').trim()

function normalizeFuzzyLine(line: string): string {
  return line
    .normalize('NFKC')
    .trimEnd()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
}

function bigrams(text: string): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2)
    map.set(gram, (map.get(gram) ?? 0) + 1)
  }
  return map
}

/** Dice coefficient over character bigrams. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const x = bigrams(a)
  const y = bigrams(b)
  let shared = 0
  for (const [gram, count] of x) shared += Math.min(count, y.get(gram) ?? 0)
  return (2 * shared) / (a.length - 1 + b.length - 1)
}

interface Lines {
  readonly text: readonly string[]
  readonly starts: readonly number[]
}

function splitLines(content: string): Lines {
  const text = content.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of text) {
    starts.push(offset)
    offset += line.length + 1
  }
  return { text, starts }
}

function blankGaps(file: Lines, window: readonly number[]): string[][] {
  return window.map((line, t) => (t === 0 ? [] : file.text.slice(window[t - 1]! + 1, line) as string[]))
}

/**
 * Locate `oldText` in LF-normalized `content` under the strictest tolerance
 * level that finds a match. A level with multiple hits stops immediately as
 * `ambiguous` instead of falling through to looser matching.
 */
export function findRegion(content: string, oldText: string): RegionResult {
  const file = splitLines(content)
  const oldLF = toLF(oldText)
  const endsWithNewline = oldLF.endsWith('\n')
  const old = (endsWithNewline ? oldLF.slice(0, -1) : oldLF).split('\n')

  const levels: readonly {
    readonly level: MatchLevel
    readonly key: (line: string) => string
    readonly skipBlank: boolean
    readonly partial: boolean
  }[] = [
    { level: 'fuzzy', key: normalizeFuzzyLine, skipBlank: false, partial: false },
    { level: 'indentation', key: trimKey, skipBlank: false, partial: true },
    { level: 'blank-lines', key: trimKey, skipBlank: true, partial: true },
    { level: 'whitespace', key: spaceKey, skipBlank: true, partial: false },
  ]

  for (const { level, key, skipBlank, partial } of levels) {
    const oldIndex = old.map((_, i) => i).filter(i => !skipBlank || !isBlank(old[i]!))
    if (oldIndex.length === 0 || oldIndex.every(i => isBlank(old[i]!))) return { kind: 'none' }
    const pool = file.text.map((_, i) => i).filter(i => !skipBlank || !isBlank(file.text[i]!))
    const oldKeys = oldIndex.map(i => key(old[i]!))
    const found: RegionMatch[] = []

    for (let p = 0; p + oldIndex.length <= pool.length; p++) {
      const window = pool.slice(p, p + oldIndex.length)
      if (!skipBlank && window[window.length - 1]! - window[0]! !== oldIndex.length - 1) continue
      const fileKeys = window.map(i => key(file.text[i]!))
      const single = oldKeys.length === 1
      let ok = true
      for (let t = 0; t < oldKeys.length && ok; t++) {
        const fileKey = fileKeys[t]!
        const oldKey = oldKeys[t]!
        if (single) ok = partial ? oldKey.length > 0 && fileKey.includes(oldKey) : fileKey === oldKey
        else if (t === 0 && partial) ok = fileKey.endsWith(oldKey) && oldKey.length > 0
        else if (t === oldKeys.length - 1 && partial) ok = fileKey.startsWith(oldKey) && oldKey.length > 0
        else ok = fileKey === oldKey
      }
      if (!ok) continue

      const first = window[0]!
      const last = window[window.length - 1]!
      const firstLine = file.text[first]!
      const lastLine = file.text[last]!
      const oldFirst = old[oldIndex[0]!]!
      const oldLast = old[oldIndex[oldIndex.length - 1]!]!
      const pairs = oldIndex.map((i, t) => [old[i]!, file.text[window[t]!]!] as const)
      const gaps = skipBlank ? blankGaps(file, window) : undefined

      if (single && partial && key(firstLine) !== key(oldFirst)) {
        const needle = oldFirst.trim()
        for (let at = firstLine.indexOf(needle); at >= 0; at = firstLine.indexOf(needle, at + 1)) {
          let end = file.starts[first]! + at + needle.length
          if (endsWithNewline && at + needle.length === firstLine.length && first < file.text.length - 1) end += 1
          found.push({
            level,
            start: file.starts[first]! + at,
            end,
            firstLine: first + 1,
            lastLine: first + 1,
            pairs,
            midStart: true,
            midEnd: true,
          })
        }
        continue
      }

      const midStart = partial && key(firstLine) !== key(oldFirst)
      const start = midStart ? file.starts[first]! + firstLine.trimEnd().length - oldFirst.trim().length : file.starts[first]!
      const midEnd = partial && key(lastLine) !== key(oldLast)
      let end = midEnd ? file.starts[last]! + indentOf(lastLine).length + oldLast.trim().length : file.starts[last]! + lastLine.length
      if (!midEnd && endsWithNewline && last < file.text.length - 1) end += 1
      found.push({
        level,
        start,
        end,
        firstLine: first + 1,
        lastLine: last + 1,
        pairs,
        ...gaps ? { gaps } : {},
        ...midStart ? { midStart } : {},
        ...midEnd ? { midEnd } : {},
      })
    }

    if (found.length === 1) return { kind: 'match', match: found[0]! }
    if (found.length > 1) return { kind: 'ambiguous', level, lines: found.map(m => m.firstLine) }
  }

  return similarRegion(file, old)
}

/**
 * Unique non-blank region with >= 0.9 average per-line similarity, anchored on
 * both boundary lines (>= 0.88) and guarded against omitted-middle sliding.
 */
function similarRegion(file: Lines, old: readonly string[]): RegionResult {
  const oldLines = old.filter(line => !isBlank(line))
  const pool = file.text.map((_, i) => i).filter(i => !isBlank(file.text[i]!))
  const n = oldLines.length
  if (n === 0 || pool.length < n) return { kind: 'none' }

  const oldKeys = oldLines.map(spaceKey)
  const fileKeys = pool.map(i => spaceKey(file.text[i]!))
  const firstScores = fileKeys.map(line => similarity(oldKeys[0]!, line))
  const lastScores = fileKeys.map(line => similarity(oldKeys[n - 1]!, line))

  const scored: { p: number; score: number }[] = []
  for (let p = 0; p + n <= pool.length; p++) {
    if (firstScores[p]! < 0.5 && lastScores[p + n - 1]! < 0.5) continue
    let total = 0
    for (let t = 0; t < n; t++) {
      total += t === 0 ? firstScores[p]! : t === n - 1 ? lastScores[p + t]! : similarity(oldKeys[t]!, fileKeys[p + t]!)
    }
    scored.push({ p, score: total / n })
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) return { kind: 'none' }

  const runner = scored.find(entry => Math.abs(entry.p - best.p) >= n)
  let first = pool[best.p]!
  let last = pool[best.p + n - 1]!

  // Omitted-middle sliding-window detection: if oldText's first line matches
  // strictly better earlier (or last line later) while the opposite end anchors
  // `best`, middle lines were left out of a repetitive block.
  let splitAnchor = false
  if (firstScores[best.p]! < 1) {
    for (let q = Math.max(0, best.p - n); q < best.p; q++) {
      if (firstScores[q]! >= 0.95 && firstScores[q]! > firstScores[best.p]! + 0.03) {
        first = pool[q]!
        splitAnchor = true
        break
      }
    }
  }
  if (lastScores[best.p + n - 1]! < 1) {
    for (let r = Math.min(pool.length - 1, best.p + 2 * n - 1); r > best.p + n - 1; r--) {
      if (lastScores[r]! >= 0.95 && lastScores[r]! > lastScores[best.p + n - 1]! + 0.03) {
        last = pool[r]!
        splitAnchor = true
        break
      }
    }
  }

  const anchorsOk = !splitAnchor && firstScores[best.p]! >= 0.88 && lastScores[best.p + n - 1]! >= 0.88
  const closest = { firstLine: first + 1, lastLine: last + 1, similarity: best.score }
  if (n < 2 || best.score < 0.9 || !anchorsOk || (runner && runner.score > best.score - 0.1)) {
    return { kind: 'none', ...best.score >= 0.5 ? { closest } : {} }
  }

  return {
    kind: 'match',
    match: {
      level: 'similar',
      start: file.starts[first]!,
      end: file.starts[last]! + file.text[last]!.length,
      firstLine: first + 1,
      lastLine: last + 1,
      pairs: oldLines.map((line, t) => [line, file.text[pool[best.p + t]!]!] as const),
      gaps: blankGaps(file, pool.slice(best.p, best.p + n)),
      similarity: best.score,
    },
  }
}

/**
 * Re-indent `text` from the model's indentation to the file's indentation using
 * matched `[oldLine, fileLine]` pairs, converting spaces <-> tabs for deeper nesting.
 */
export function reindent(text: string, indents: readonly (readonly [string, string])[]): string {
  if (indents.every(([from, to]) => from === to)) return text
  const map = new Map<string, string>()
  for (const [from, to] of indents) if (!map.has(from)) map.set(from, to)
  let spacesPerTab = 0
  let tabToSpaces = 0
  for (const [from, to] of indents) {
    if (!spacesPerTab && /^ +$/.test(from) && /^\t+$/.test(to) && from.length % to.length === 0) spacesPerTab = from.length / to.length
    if (!tabToSpaces && /^\t+$/.test(from) && /^ +$/.test(to) && to.length % from.length === 0) tabToSpaces = to.length / from.length
  }
  return text.split('\n').map(line => {
    if (isBlank(line)) return line
    const ws = indentOf(line)
    const mapped = map.get(ws)
    if (mapped !== undefined) return mapped + line.slice(ws.length)
    const from = [...map.keys()].filter(key => ws.startsWith(key)).sort((a, b) => b.length - a.length)[0]
    if (from === undefined) return line
    let rest = ws.slice(from.length)
    if (spacesPerTab) rest = rest.replace(new RegExp(` {${spacesPerTab}}`, 'g'), '\t')
    if (tabToSpaces) rest = rest.replace(/\t/g, ' '.repeat(tabToSpaces))
    return map.get(from)! + rest + line.slice(ws.length)
  }).join('\n')
}

/**
 * Fit `newText` onto a matched region: re-indents whole lines to the file's
 * indentation and keeps unchanged context lines verbatim as the file has them.
 */
export function fitReplacement(
  newText: string,
  match: Pick<RegionMatch, 'pairs' | 'gaps' | 'midStart' | 'midEnd'>,
): { text: string; reindented: boolean; kept: number } {
  const { pairs, gaps, midStart = false, midEnd = false } = match
  const lines = toLF(newText).split('\n')
  const last = lines.length - 1
  if (midStart) {
    const lead = indentOf(pairs[0]![0])
    if (lines[0]!.startsWith(lead)) lines[0] = lines[0]!.slice(lead.length)
  }
  if (midEnd) {
    const trail = /[ \t]*$/.exec(pairs[pairs.length - 1]![0])![0]
    if (trail && lines[last]!.endsWith(trail)) lines[last] = lines[last]!.slice(0, -trail.length)
  }
  const from = midStart ? 1 : 0
  const seen = new Map<string, number>()
  for (const [oldLine] of pairs) seen.set(oldLine, (seen.get(oldLine) ?? 0) + 1)
  const context = new Map<string, number>()
  pairs.forEach(([oldLine], t) => {
    if (t >= from && !(midEnd && t === pairs.length - 1) && !isBlank(oldLine) && seen.get(oldLine) === 1) {
      context.set(oldLine, t)
    }
  })
  const indents = pairs.slice(from).map(([oldLine, fileLine]) => [indentOf(oldLine), indentOf(fileLine)] as const)
  const reindented = indents.some(([a, b]) => a !== b)
  const body = lines.slice(from)
  const moved = [...lines.slice(0, from), ...(reindented ? reindent(body.join('\n'), indents).split('\n') : body)]
  let kept = 0
  let lastContext = -1
  const out: string[] = []
  moved.forEach((line, i) => {
    const t = i >= from && !(midEnd && i === last) ? context.get(lines[i]!) : undefined
    if (t === undefined) {
      out.push(line)
      return
    }
    if (out.length > 0 && !isBlank(out[out.length - 1]!) && t > lastContext) out.push(...(gaps?.[t] ?? []))
    const fileLine = pairs[t]![1]
    if (fileLine.trim() !== lines[i]!.trim()) kept++
    out.push(fileLine)
    lastContext = t
  })
  return { text: out.join('\n'), reindented, kept }
}

const lineAt = (content: string, offset: number): number => content.slice(0, offset).split('\n').length

const numberedExcerpt = (content: string, first: number, last: number): string =>
  content.split('\n').slice(first - 1, last).map((line, i) => `${first + i}: ${line}`).join('\n')

function isSingleIndentedLine(oldText: string, newText: string): boolean {
  const old = toLF(oldText)
  const body = old.endsWith('\n') ? old.slice(0, -1) : old
  return /^[ \t]/.test(body) && !body.includes('\n') && (old !== body || toLF(newText).includes('\n'))
}

function hasAllLineNumberPrefixes(text: string): boolean {
  const nonEmpty = text.split('\n').filter(line => line !== '')
  return nonEmpty.length > 0
    && nonEmpty.every(line => /^\s*\d+: ?/.test(line))
    && nonEmpty.some(line => /^\s*\d+: /.test(line))
}

function stripLineNumberPrefixes(text: string): string {
  return text.split('\n').map(line => (line === '' ? '' : line.replace(/^\s*\d+: ?/, ''))).join('\n')
}

/**
 * Resolve a single `{ oldString, newString }` edit against `rawContent`,
 * preserving CRLF when present. Exact unique matches return `{ kind: 'exact' }`.
 */
export function resolveTolerantEdit(
  rawContent: string,
  oldString: string,
  newString: string,
  displayPath: string,
): ResolvedTolerantEdit {
  if (oldString === '') return { kind: 'exact' }
  const eol = rawContent.includes('\r\n') ? '\r\n' : '\n'
  const restoreEol = (lf: string): string => (eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf)
  const content = toLF(rawContent.startsWith('\uFEFF') ? rawContent.slice(1) : rawContent)
  const oldLF = toLF(oldString)
  const newLF = toLF(newString)

  // Widen a single indented line whose leading whitespace drifted short, so a
  // multi-line replacement does not land under-indented inside the line's indent.
  if (isSingleIndentedLine(oldLF, newLF)) {
    const at = content.indexOf(oldLF)
    if (at >= 0 && content.indexOf(oldLF, at + 1) < 0) {
      const prefix = content.slice(content.lastIndexOf('\n', at - 1) + 1, at)
      if (/^[ \t]+$/.test(prefix)) {
        const line = oldLF.endsWith('\n') ? oldLF.slice(0, -1) : oldLF
        const { text } = fitReplacement(newLF, { pairs: [[line, prefix + line]] })
        return {
          kind: 'repaired',
          oldString: restoreEol(prefix + oldLF),
          newString: restoreEol(text),
          note: `Matched the edit at line ${lineAt(content, at)} of ${displayPath} ignoring indentation; re-indented the replacement to the file.`,
        }
      }
    }
  }

  const exactAt = content.indexOf(oldLF)
  if (exactAt >= 0) {
    if (content.indexOf(oldLF, exactAt + 1) >= 0) {
      return { kind: 'exact' } // Let DSH's own multiple-match error report it consistently.
    }
    return eol === '\r\n' && (!oldString.includes('\r\n') || (newString.includes('\n') && !newString.includes('\r\n')))
      ? {
          kind: 'repaired',
          oldString: restoreEol(oldLF),
          newString: restoreEol(newLF),
          note: `Matched the edit in ${displayPath} normalizing CRLF line endings.`,
        }
      : { kind: 'exact' }
  }

  // Strip accidental `123: ` line-number prefixes copied from `read` output.
  let effectiveOldLF = oldLF
  let effectiveNewLF = newLF
  let strippedPrefixes = false
  if (hasAllLineNumberPrefixes(oldLF) && !content.includes(oldLF)) {
    const candidateOld = stripLineNumberPrefixes(oldLF)
    if (candidateOld.trim() !== '') {
      effectiveOldLF = candidateOld
      strippedPrefixes = true
      if (hasAllLineNumberPrefixes(newLF)) {
        effectiveNewLF = stripLineNumberPrefixes(newLF)
      }
      const strippedAt = content.indexOf(effectiveOldLF)
      if (strippedAt >= 0 && content.indexOf(effectiveOldLF, strippedAt + 1) < 0) {
        if (effectiveOldLF === effectiveNewLF) {
          return {
            kind: 'refused',
            message: `Could not apply edit in ${displayPath}: old_string and new_string are identical after stripping line-number prefixes.`,
          }
        }
        return {
          kind: 'repaired',
          oldString: restoreEol(effectiveOldLF),
          newString: restoreEol(effectiveNewLF),
          note: `Matched the edit at line ${lineAt(content, strippedAt)} of ${displayPath} after stripping line-number prefixes.`,
        }
      }
    }
  }

  const result = findRegion(content, effectiveOldLF)
  if (result.kind === 'match') {
    const { match } = result
    const exact = content.slice(match.start, match.end)
    const fit = fitReplacement(effectiveNewLF, match)
    const range = match.firstLine === match.lastLine ? `line ${match.firstLine}` : `lines ${match.firstLine}-${match.lastLine}`
    if (fit.text === exact) {
      return {
        kind: 'refused',
        message: `Could not apply edit in ${displayPath}: old_string already contains the modified text instead of the current file text at ${range}. `
          + `Copy old_string from these exact lines:\n${exact}`,
      }
    }
    let note = `Matched the edit at ${range} of ${displayPath} ${LEVEL_TEXT[match.level]}`
    if (strippedPrefixes) note += ' after stripping line-number prefixes'
    if (match.similarity !== undefined) note += ` (${Math.round(match.similarity * 100)}% similar)`
    if (fit.reindented) note += '; re-indented the replacement to the file'
    if (fit.kept > 0) note += `; kept ${fit.kept} unchanged line(s) as the file has them`
    note += '.'
    if (match.level === 'similar') note += ` Replaced text:\n${exact}`
    return {
      kind: 'repaired',
      oldString: restoreEol(exact),
      newString: restoreEol(fit.text),
      note,
    }
  }

  if (result.kind === 'none' && result.closest && effectiveNewLF.trim().length >= 8) {
    const present = findRegion(content, effectiveNewLF)
    const { firstLine, lastLine } = result.closest
    if (present.kind === 'match' && present.match.level !== 'similar' && present.match.firstLine <= lastLine && present.match.lastLine >= firstLine) {
      return {
        kind: 'refused',
        message: `No edit needed in ${displayPath}: old_string is not in the file, and new_string is already present (line ${present.match.firstLine}). `
          + 'This change is already applied; do not repeat this edit. Continue with any remaining changes, or answer the user directly if all work is done.',
      }
    }
  }

  if (result.kind === 'ambiguous') {
    return {
      kind: 'refused',
      message: `Could not apply edit in ${displayPath}: when ${LEVEL_TEXT[result.level]}, old_string matches ${result.lines.length} places `
        + `(lines ${result.lines.slice(0, 8).join(', ')}). Include more surrounding lines so it matches uniquely.`,
    }
  }

  let message = `Could not find old_string in ${displayPath}.`
  if (result.closest) {
    const { firstLine, lastLine, similarity: score } = result.closest
    const totalLines = content.split('\n').length
    const ctxFirst = Math.max(1, firstLine - 2)
    const ctxLast = Math.min(totalLines, lastLine + 2)
    message += ` The closest text is lines ${firstLine}-${lastLine} (${Math.round(score * 100)}% similar). `
      + `Current file around lines ${ctxFirst}-${ctxLast} (verify these are the intended lines before editing):\n`
      + numberedExcerpt(content, ctxFirst, ctxLast)
  } else {
    message += ` Nothing similar was found; read ${displayPath} first to inspect its current content.`
  }
  return { kind: 'refused', message }
}
