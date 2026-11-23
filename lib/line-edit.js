// src/edit-modes/line-edit.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/core/edit-modes/shared.ts
var pluralLines = (count) => `${count} line${count === 1 ? "" : "s"}`;
function splitDocumentLines(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text;
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized === "" ? [] : (trailingNewline ? normalized.slice(0, -1) : normalized).split("\n");
  return { eol, trailingNewline, lines };
}
function joinDocumentLines(after, eol, trailingNewline, wasEmpty) {
  const keepNewline = trailingNewline || wasEmpty && after.length > 0;
  const joined = after.join("\n") + (keepNewline && after.length > 0 ? "\n" : "");
  return eol === "\r\n" ? joined.replace(/\n/g, "\r\n") : joined;
}
function renderWindow(displayPath, lines, from, to) {
  if (lines.length === 0) return `=== ${displayPath} (empty file, 0 lines) ===`;
  const first = Math.max(1, Math.min(lines.length, from));
  const last = Math.max(first, Math.min(lines.length, to));
  const out = [`=== ${displayPath} (lines ${first}-${last} of ${lines.length}) ===`];
  if (first > 1) out.push(`(${pluralLines(first - 1)} above)`);
  for (let n = first; n <= last; n++) out.push(`${n}: ${lines[n - 1]}`);
  if (last < lines.length) out.push(`(${pluralLines(lines.length - last)} below)`);
  return out.join("\n");
}
function addSeen(seen, first, last) {
  if (seen === "all") return seen;
  const next = new Set(seen);
  for (let n = Math.max(1, first); n <= last; n++) next.add(n);
  return next;
}
function unseenLines(seen, edit, total) {
  if (seen === "all") return [];
  const { startLine: start, endLine: end } = edit;
  if (end >= start) {
    const missing = [];
    for (let n = start; n <= end; n++) if (!seen.has(n)) missing.push(n);
    return missing;
  }
  const neighbours = [start - 1, start].filter((n) => n >= 1 && n <= total);
  return neighbours.length === 0 || neighbours.some((n) => seen.has(n)) ? [] : neighbours;
}
function seenAfterBatchEdit(seen, hunks, afterTotal, contextLines = 3) {
  if (seen === "all") return seen;
  const ordered = [...hunks].sort((a, b) => a.startLine - b.startLine);
  const next = /* @__PURE__ */ new Set();
  for (const n of seen) {
    let shift = 0;
    let overwritten = false;
    for (const h of ordered) {
      if (h.endLine >= h.startLine && n >= h.startLine && n <= h.endLine) {
        overwritten = true;
        break;
      }
      if (n > h.endLine || h.endLine < h.startLine && n >= h.startLine) {
        shift += h.added - h.removed;
      }
    }
    if (!overwritten && n + shift >= 1 && n + shift <= afterTotal) {
      next.add(n + shift);
    }
  }
  let cumulativeDelta = 0;
  for (const h of ordered) {
    const postStart = h.startLine + cumulativeDelta;
    const from = Math.max(1, postStart - contextLines);
    const to = Math.min(afterTotal, postStart + Math.max(h.added, 1) - 1 + contextLines);
    for (let n = from; n <= to; n++) next.add(n);
    cumulativeDelta += h.added - h.removed;
  }
  return next;
}
function formatRanges(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(sorted[i] === sorted[j] ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}
function unseenRejection(displayPath, missing, seen, total, contextLines = 3) {
  const offset = Math.max(1, missing[0] - contextLines);
  const shown = seen.size === 0 ? "you have seen none of it" : `you have seen lines ${formatRanges(seen)}`;
  const which = missing.length === 1 ? `line ${missing[0]} of ${displayPath} has` : `lines ${formatRanges(missing)} of ${displayPath} have`;
  return `Your edit was NOT applied: ${which} not been shown to you (the file has ${total} lines; ${shown}). Read them first (read with offset=${offset}), then edit by the numbers you see.`;
}
function sandboxPolicyFor(service, session) {
  if (service === void 0) return void 0;
  return service.resolve(session === void 0 ? {} : { session });
}

// src/core/edit-modes/tolerant.ts
var indentOf = (line) => /^[ \t]*/.exec(line)[0];
var isBlank = (line) => line.trim() === "";
function bigrams(text) {
  const map = /* @__PURE__ */ new Map();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  for (const [gram, count] of x) shared += Math.min(count, y.get(gram) ?? 0);
  return 2 * shared / (a.length - 1 + b.length - 1);
}
function reindent(text, indents) {
  if (indents.every(([from, to]) => from === to)) return text;
  const map = /* @__PURE__ */ new Map();
  for (const [from, to] of indents) if (!map.has(from)) map.set(from, to);
  let spacesPerTab = 0;
  let tabToSpaces = 0;
  for (const [from, to] of indents) {
    if (!spacesPerTab && /^ +$/.test(from) && /^\t+$/.test(to) && from.length % to.length === 0) spacesPerTab = from.length / to.length;
    if (!tabToSpaces && /^\t+$/.test(from) && /^ +$/.test(to) && to.length % from.length === 0) tabToSpaces = to.length / from.length;
  }
  return text.split("\n").map((line) => {
    if (isBlank(line)) return line;
    const ws = indentOf(line);
    const mapped = map.get(ws);
    if (mapped !== void 0) return mapped + line.slice(ws.length);
    const from = [...map.keys()].filter((key) => ws.startsWith(key)).sort((a, b) => b.length - a.length)[0];
    if (from === void 0) return line;
    let rest = ws.slice(from.length);
    if (spacesPerTab) rest = rest.replace(new RegExp(` {${spacesPerTab}}`, "g"), "	");
    if (tabToSpaces) rest = rest.replace(/\t/g, " ".repeat(tabToSpaces));
    return map.get(from) + rest + line.slice(ws.length);
  }).join("\n");
}

// src/core/edit-modes/line-edit.ts
var LINE_EDIT_CONTEXT_LINES = 3;
var ANCHOR_SEARCH_RADIUS = 15;
var END_ANCHOR_SEARCH_RADIUS = 10;
var ERROR_WINDOW_RADIUS = 8;
var MIN_WHOLE_FILE_ANCHOR_LEN = 10;
var TRIVIAL_ANCHORS = /* @__PURE__ */ new Set([
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "},",
  "],",
  ");",
  "};",
  "else:",
  "else {",
  "} else {",
  "try:",
  "try {",
  "finally:",
  "finally {",
  "pass",
  "break",
  "continue",
  "return",
  "return;",
  "return None",
  "return true",
  "return false",
  "end",
  "fi",
  "done",
  "esac"
]);
var ELISION_LINE = /^\s*(?:\/\/|#|\/\*|--|<!--)?\s*(?:\.\.\.|…)\s*(?:existing|unchanged|rest|remaining|omitted|same|code|lines|more|snip|truncated)?[^\n]{0,40}(?:\*\/|-->)?\s*$/i;
var NUMBERED_PREFIX = /^(\d+): ?(.*)$/;
function indentOf2(line) {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}
function normalizeAnchorLine(line) {
  return line.normalize("NFKC").replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ").replace(/\s+/g, " ").trim();
}
function stripOptionalLinePrefix(text) {
  const m = /^\s*\d+:\s?(.*)$/.exec(text);
  return m ? m[1] : text;
}
function isNonTrivialAnchor(anchor, minLen = 8) {
  if (typeof anchor !== "string") return false;
  const cleaned = normalizeAnchorLine(stripOptionalLinePrefix(anchor));
  if (cleaned.length < minLen) return false;
  if (TRIVIAL_ANCHORS.has(cleaned)) return false;
  return /[A-Za-z0-9_\u4e00-\u9fff]{3,}/.test(cleaned);
}
function lineAnchorScore(anchor, fileLine) {
  const raw = stripOptionalLinePrefix(anchor);
  const a = normalizeAnchorLine(raw);
  const b = normalizeAnchorLine(fileLine);
  if (a === "" && b === "") return 1;
  if (a === "" || b === "") return 0;
  if (a === b) return 1;
  if (a.length >= 16 && b.startsWith(a)) return 0.96;
  return similarity(a, b);
}
function newLinesOf(text) {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n");
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}
function stripNumberedReplacement(newLines, startLine, before) {
  if (newLines.length === 0) return { lines: [], stripped: false };
  const existingNear = before.slice(Math.max(0, startLine - 2), Math.min(before.length, startLine + 2));
  if (existingNear.some((line) => NUMBERED_PREFIX.test(line))) {
    return { lines: [...newLines], stripped: false };
  }
  const out = [];
  let expected;
  let numberedCount = 0;
  for (const line of newLines) {
    if (line === "") {
      out.push("");
      if (expected !== void 0) expected++;
      continue;
    }
    const m = NUMBERED_PREFIX.exec(line);
    if (!m) return { lines: [...newLines], stripped: false };
    const num = Number(m[1]);
    if (expected === void 0) {
      if (Math.abs(num - startLine) > 20) return { lines: [...newLines], stripped: false };
      expected = num + 1;
    } else {
      if (num !== expected) return { lines: [...newLines], stripped: false };
      expected++;
    }
    numberedCount++;
    out.push(m[2]);
  }
  if (numberedCount === 0 || numberedCount === 1 && newLines.length > 1) {
    return { lines: [...newLines], stripped: false };
  }
  return { lines: out, stripped: true };
}
function pickUniqueAnchorHit(hits) {
  if (hits.length === 0) return { kind: "none" };
  const exact = hits.filter((h) => h.score >= 0.98);
  if (exact.length === 1) return { kind: "unique", ln: exact[0].ln };
  if (exact.length > 1) return { kind: "ambiguous", lines: exact.map((h) => h.ln) };
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const runner = sorted[1];
  if (best.score >= 0.9 && (!runner || runner.score <= best.score - 0.08)) {
    return { kind: "unique", ln: best.ln };
  }
  return { kind: "ambiguous", lines: sorted.slice(0, 4).map((h) => h.ln) };
}
function refineEndLineWithEndText(before, resolvedStart, resolvedEnd, endText, allowSelfHeal) {
  if (resolvedEnd < resolvedStart || resolvedEnd > before.length) return { ok: false };
  if (lineAnchorScore(endText, before[resolvedEnd - 1]) >= 0.9) {
    return { ok: true, endLine: resolvedEnd };
  }
  if (!allowSelfHeal) return { ok: false };
  const lo = Math.max(resolvedStart, resolvedEnd - END_ANCHOR_SEARCH_RADIUS);
  const hi = Math.min(before.length, resolvedEnd + END_ANCHOR_SEARCH_RADIUS);
  const hits = [];
  for (let ln = lo; ln <= hi; ln++) {
    const score = lineAnchorScore(endText, before[ln - 1]);
    if (score >= 0.9) hits.push({ ln, score });
  }
  const picked = pickUniqueAnchorHit(hits);
  if (picked.kind === "unique") {
    return {
      ok: true,
      endLine: picked.ln,
      note: `Auto-aligned edit end_line ${resolvedEnd} -> ${picked.ln} via end_text.`
    };
  }
  return { ok: false };
}
function resolveSingleHunk(before, displayPath, edit, index, totalHunks, allowSelfHeal) {
  const label = totalHunks > 1 ? `edit #${index + 1}` : "edit";
  const { startLine: start, endLine: end } = edit;
  const total = before.length;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return `${label}: start_line and end_line must be whole numbers`;
  }
  if (start < 1) return `${label}: start_line must be 1 or more (got ${start})`;
  if (start > total + 1) return `${label}: start_line ${start} is past the end: ${displayPath} has ${total} lines`;
  if (end > total) return `${label}: end_line ${end} is past the end: ${displayPath} has ${total} lines`;
  if (end < start - 1) {
    return `${label}: end_line ${end} is before start_line ${start}; use end_line = start_line - 1 to insert without replacing`;
  }
  const isInsert = end === start - 1;
  const rawAnchor = typeof edit.startText === "string" ? edit.startText : "";
  const hasAnchor = rawAnchor.trim() !== "";
  let resolvedStart = start;
  let resolvedEnd = end;
  let alignedNote;
  let anchorVerified = false;
  let endAnchorVerified = false;
  let matchedAnchorLine;
  if (hasAnchor && total > 0) {
    const anchorTargetLine = isInsert ? start <= total ? start : total : start;
    const directLine = before[anchorTargetLine - 1];
    if (directLine !== void 0 && lineAnchorScore(rawAnchor, directLine) >= 0.9) {
      anchorVerified = true;
      matchedAnchorLine = directLine;
    } else if (allowSelfHeal) {
      const lo = Math.max(1, anchorTargetLine - ANCHOR_SEARCH_RADIUS);
      const hi = Math.min(total, anchorTargetLine + ANCHOR_SEARCH_RADIUS);
      const localHits = [];
      for (let ln = lo; ln <= hi; ln++) {
        const score = lineAnchorScore(rawAnchor, before[ln - 1]);
        if (score >= 0.9) localHits.push({ ln, score });
      }
      const localExactHits = localHits.filter((h) => h.score >= 0.98);
      const localPick = pickUniqueAnchorHit(localHits);
      const localIsExact = localExactHits.length === 1 && localPick.kind === "unique" && localPick.ln === localExactHits[0].ln;
      if (localIsExact) {
        const shift = localPick.ln - anchorTargetLine;
        const nextStart = start + shift;
        const nextEnd = end + shift;
        if (nextStart >= 1 && nextStart <= total + 1 && nextEnd <= total && nextEnd >= nextStart - 1) {
          resolvedStart = nextStart;
          resolvedEnd = nextEnd;
          anchorVerified = true;
          matchedAnchorLine = before[localPick.ln - 1];
          alignedNote = `Auto-aligned ${label} lines ${start}-${end} -> ${resolvedStart}-${resolvedEnd} via start_text.`;
        }
      } else if (localExactHits.length > 1) {
        const win = renderWindow(displayPath, before, Math.max(1, anchorTargetLine - ERROR_WINDOW_RADIUS), Math.min(total, anchorTargetLine + ERROR_WINDOW_RADIUS));
        return `Your ${label} in ${displayPath} was NOT applied: start_text (${JSON.stringify(rawAnchor.trim())}) did not match line ${anchorTargetLine}, and matched multiple nearby lines (${localExactHits.map((h) => h.ln).join(", ")}).

Current lines around line ${anchorTargetLine}:
${win}`;
      }
      if (!anchorVerified && isNonTrivialAnchor(rawAnchor, MIN_WHOLE_FILE_ANCHOR_LEN)) {
        const globalHits = [];
        for (let ln = 1; ln <= total; ln++) {
          const score = lineAnchorScore(rawAnchor, before[ln - 1]);
          if (score >= 0.92) globalHits.push({ ln, score });
        }
        const globalExact = globalHits.filter((h) => h.score >= 0.98);
        const globalPick = pickUniqueAnchorHit(globalHits);
        if (globalPick.kind === "unique" && (globalExact.length === 1 || localPick.kind !== "unique")) {
          const shift = globalPick.ln - anchorTargetLine;
          const nextStart = start + shift;
          const nextEnd = end + shift;
          if (nextStart >= 1 && nextStart <= total + 1 && nextEnd <= total && nextEnd >= nextStart - 1) {
            resolvedStart = nextStart;
            resolvedEnd = nextEnd;
            anchorVerified = true;
            matchedAnchorLine = before[globalPick.ln - 1];
            alignedNote = `Auto-aligned ${label} lines ${start}-${end} -> ${resolvedStart}-${resolvedEnd} via unique file-wide start_text.`;
          }
        }
      }
      if (!anchorVerified && localPick.kind === "unique") {
        const shift = localPick.ln - anchorTargetLine;
        const nextStart = start + shift;
        const nextEnd = end + shift;
        if (nextStart >= 1 && nextStart <= total + 1 && nextEnd <= total && nextEnd >= nextStart - 1) {
          resolvedStart = nextStart;
          resolvedEnd = nextEnd;
          anchorVerified = true;
          matchedAnchorLine = before[localPick.ln - 1];
          alignedNote = `Auto-aligned ${label} lines ${start}-${end} -> ${resolvedStart}-${resolvedEnd} via start_text.`;
        }
      }
      if (!anchorVerified) {
        const win = renderWindow(displayPath, before, Math.max(1, anchorTargetLine - ERROR_WINDOW_RADIUS), Math.min(total, anchorTargetLine + ERROR_WINDOW_RADIUS));
        const extraMatches = [];
        for (let ln = 1; ln <= total; ln++) {
          if (lineAnchorScore(rawAnchor, before[ln - 1]) >= 0.8) {
            extraMatches.push(`  ${ln}: ${before[ln - 1]}`);
            if (extraMatches.length >= 4) break;
          }
        }
        const candHint = extraMatches.length > 0 ? `
Matching lines elsewhere in ${displayPath}:
${extraMatches.join("\n")}` : "";
        return `Your ${label} in ${displayPath} was NOT applied: start_text (${JSON.stringify(rawAnchor.trim())}) did not match line ${anchorTargetLine} (${JSON.stringify(before[anchorTargetLine - 1]?.trim() ?? "")}).${candHint}

Current lines around line ${anchorTargetLine}:
${win}`;
      }
    } else {
      const win = renderWindow(displayPath, before, Math.max(1, start - ERROR_WINDOW_RADIUS), Math.min(total, Math.max(end, start) + ERROR_WINDOW_RADIUS));
      return `Your ${label} in ${displayPath} was NOT applied: start_text (${JSON.stringify(rawAnchor.trim())}) did not match line ${anchorTargetLine} (${JSON.stringify(before[anchorTargetLine - 1]?.trim() ?? "")}).
${win}`;
    }
  }
  if (!isInsert && typeof edit.endText === "string" && edit.endText.trim() !== "") {
    const endCheck = refineEndLineWithEndText(before, resolvedStart, resolvedEnd, edit.endText, allowSelfHeal);
    if (!endCheck.ok) {
      const win = renderWindow(displayPath, before, Math.max(1, resolvedStart - 3), Math.min(total, resolvedEnd + ERROR_WINDOW_RADIUS));
      return `Your ${label} in ${displayPath} was NOT applied: end_text (${JSON.stringify(edit.endText.trim())}) did not match line ${resolvedEnd} (${JSON.stringify(before[resolvedEnd - 1]?.trim() ?? "")}).

Current lines around line ${resolvedEnd}:
${win}`;
    }
    resolvedEnd = endCheck.endLine;
    endAnchorVerified = true;
    if (endCheck.note) {
      alignedNote = alignedNote ? `${alignedNote} ${endCheck.note}` : endCheck.note;
    }
  }
  const rawNewLines = newLinesOf(edit.newText);
  const { lines: strippedLines, stripped: strippedLineNumbers } = stripNumberedReplacement(rawNewLines, resolvedStart, before);
  let newLines = strippedLines;
  let reindented = false;
  if (allowSelfHeal && matchedAnchorLine !== void 0 && newLines.length > 0 && hasAnchor) {
    const anchorWithoutPrefix = stripOptionalLinePrefix(rawAnchor);
    const oldIndent = indentOf2(anchorWithoutPrefix);
    const fileIndent = indentOf2(matchedAnchorLine);
    const firstNonBlank = newLines.find((line) => line.trim() !== "");
    if (oldIndent !== fileIndent && firstNonBlank !== void 0 && oldIndent.length > 0 && firstNonBlank.startsWith(oldIndent)) {
      const moved = reindent(newLines.join("\n"), [[oldIndent, fileIndent]]).split("\n");
      if (moved.join("\n") !== newLines.join("\n")) {
        newLines = moved;
        reindented = true;
      }
    }
  }
  const removedSlice = before.slice(resolvedStart - 1, resolvedEnd);
  const oldTrimmedSet = new Set(removedSlice.map((line) => line.trim()));
  for (const nl of newLines) {
    if (ELISION_LINE.test(nl) && !oldTrimmedSet.has(nl.trim())) {
      return `Your ${label} in ${displayPath} was NOT applied: new_text contains an elision placeholder (${JSON.stringify(nl.trim())}), which would delete code. Narrow start_line..end_line to only the lines changing and write complete replacement code.`;
    }
  }
  if (removedSlice.length === newLines.length && removedSlice.every((line, i) => line === newLines[i])) {
    const spanStr = resolvedStart === resolvedEnd ? `line ${resolvedStart}` : `lines ${resolvedStart}-${resolvedEnd}`;
    return `No edit needed in ${displayPath}: new_text is the same as ${spanStr}; nothing changed.`;
  }
  if (newLines.length >= 2 && resolvedStart > 1) {
    const above = before[resolvedStart - 2].trim();
    if (above.length >= 8 && newLines[0].trim() === above && !oldTrimmedSet.has(above)) {
      const win = renderWindow(displayPath, before, Math.max(1, resolvedStart - 4), Math.min(total, Math.max(resolvedEnd, resolvedStart) + 4));
      return `Your ${label} in ${displayPath} was NOT applied: the first line of new_text duplicates line ${resolvedStart - 1} (${JSON.stringify(above)}) immediately above start_line=${resolvedStart}. Drop that unchanged line from new_text or adjust start_line.

${win}`;
    }
  }
  if (newLines.length >= 2 && resolvedEnd < total) {
    const below = before[resolvedEnd].trim();
    if (below.length >= 8 && newLines[newLines.length - 1].trim() === below && !oldTrimmedSet.has(below)) {
      const win = renderWindow(displayPath, before, Math.max(1, resolvedStart - 4), Math.min(total, Math.max(resolvedEnd, resolvedStart) + 4));
      return `Your ${label} in ${displayPath} was NOT applied: the last line of new_text duplicates line ${resolvedEnd + 1} (${JSON.stringify(below)}) immediately below end_line=${resolvedEnd}. Drop that unchanged line from new_text or adjust end_line.

${win}`;
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
    ...alignedNote ? { alignedNote } : {},
    anchorVerified,
    endAnchorVerified
  };
}
function hunksOverlap(a, b) {
  const aInsert = a.endLine < a.startLine;
  const bInsert = b.endLine < b.startLine;
  if (aInsert && bInsert) return a.startLine === b.startLine;
  if (aInsert) return a.startLine > b.startLine && a.startLine <= b.endLine;
  if (bInsert) return b.startLine > a.startLine && b.startLine <= a.endLine;
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}
function applyAnchoredLineEdits(text, displayPath, edits, options = {}) {
  if (edits.length === 0) return "edits must contain at least one edit hunk";
  const allowSelfHeal = options.selfHeal !== false;
  const { eol, trailingNewline, lines: before } = splitDocumentLines(text);
  const resolved = [];
  for (let i = 0; i < edits.length; i++) {
    const out = resolveSingleHunk(before, displayPath, edits[i], i, edits.length, allowSelfHeal);
    if (typeof out === "string") return out;
    resolved.push(out);
  }
  const sortedAsc = [...resolved].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  for (let i = 1; i < sortedAsc.length; i++) {
    if (hunksOverlap(sortedAsc[i - 1], sortedAsc[i])) {
      return `Your batch edit in ${displayPath} was NOT applied: edit #${sortedAsc[i - 1].index + 1} (lines ${sortedAsc[i - 1].startLine}-${sortedAsc[i - 1].endLine}) overlaps edit #${sortedAsc[i].index + 1} (lines ${sortedAsc[i].startLine}-${sortedAsc[i].endLine}). Combine overlapping edits into one range.`;
    }
  }
  const after = [...before];
  const sortedDesc = [...sortedAsc].reverse();
  for (const h of sortedDesc) {
    after.splice(h.startLine - 1, h.removed, ...h.newLines);
  }
  const content = joinDocumentLines(after, eol, trailingNewline, before.length === 0);
  const totalRemoved = resolved.reduce((acc, h) => acc + h.removed, 0);
  const totalAdded = resolved.reduce((acc, h) => acc + h.added, 0);
  return { content, before, after, hunks: sortedAsc, totalRemoved, totalAdded };
}
function resultWindow(displayPath, start, added, after) {
  return renderWindow(
    displayPath,
    after,
    start - LINE_EDIT_CONTEXT_LINES,
    start + Math.max(added, 1) - 1 + LINE_EDIT_CONTEXT_LINES
  );
}
function editSummary(displayPath, edit, result) {
  const start = result.resolvedStart ?? edit.startLine;
  const end = result.resolvedEnd ?? edit.endLine;
  const { removed, added } = result;
  let what;
  if (removed === 0) what = start > 1 ? `Inserted ${pluralLines(added)} after line ${start - 1}` : `Inserted ${pluralLines(added)} at the start`;
  else if (added === 0) what = `Deleted lines ${start}-${end}`;
  else what = `Replaced lines ${start}-${end} with ${pluralLines(added)}`;
  const parts = [`File updated. ${what}.`];
  if (result.alignedNote) parts.push(`(${result.alignedNote})`);
  if (result.strippedLineNumbers) parts.push("(Stripped copied line-number prefixes from new_text.)");
  if (result.reindented) parts.push("(Auto-aligned indentation to match the file.)");
  const delta = added - removed;
  if (delta !== 0 && end < result.before.length) {
    parts.push(`Lines after it moved ${delta > 0 ? "down" : "up"} by ${Math.abs(delta)}: old line ${end + 1} is now line ${end + 1 + delta}.`);
  }
  parts.push("Review the change (correct indentation, no duplicate or missing lines) and edit again if necessary.");
  return `${parts.join(" ")}
${resultWindow(displayPath, start, added, result.after)}`;
}
function batchEditSummary(displayPath, batch) {
  if (batch.hunks.length === 1) {
    const h = batch.hunks[0];
    return editSummary(
      displayPath,
      { startLine: h.startLine, endLine: h.endLine, newText: h.newLines.join("\n") },
      {
        content: batch.content,
        before: batch.before,
        after: batch.after,
        removed: h.removed,
        added: h.added,
        resolvedStart: h.startLine,
        resolvedEnd: h.endLine,
        ...h.alignedNote ? { alignedNote: h.alignedNote } : {},
        anchorVerified: h.anchorVerified,
        strippedLineNumbers: h.strippedLineNumbers,
        reindented: h.reindented
      }
    );
  }
  const notes = [];
  let cumulativeDelta = 0;
  const windows = [];
  for (const h of batch.hunks) {
    const postStart = h.startLine + cumulativeDelta;
    if (h.alignedNote) notes.push(h.alignedNote);
    if (h.strippedLineNumbers) notes.push(`Stripped copied line-number prefixes in edit #${h.index + 1}.`);
    if (h.reindented) notes.push(`Auto-aligned indentation in edit #${h.index + 1}.`);
    windows.push(resultWindow(displayPath, postStart, h.added, batch.after));
    cumulativeDelta += h.added - h.removed;
  }
  const parts = [`File updated with ${batch.hunks.length} atomic edits (${pluralLines(batch.totalRemoved)} removed, ${pluralLines(batch.totalAdded)} added).`];
  if (notes.length > 0) parts.push(`(${notes.join(" ")})`);
  parts.push("Review the updated windows below and edit again if necessary.");
  return `${parts.join(" ")}
${windows.join("\n\n")}`;
}
function syntaxRejection(displayPath, edit, result, error) {
  const start = result.resolvedStart ?? edit.startLine;
  const end = result.resolvedEnd ?? edit.endLine;
  const original = renderWindow(displayPath, result.before, start - LINE_EDIT_CONTEXT_LINES, Math.max(end, start) + LINE_EDIT_CONTEXT_LINES);
  return [
    "Your edit was NOT applied: it introduces a syntax error.",
    `ERROR: ${error}`,
    "",
    "This is how the file would have looked:",
    resultWindow(displayPath, start, result.added, result.after),
    "",
    "This is the original code before your edit:",
    original,
    "",
    "Fix start_line/end_line or new_text (check the indentation) and try again. Do not repeat the same edit."
  ].join("\n");
}
function batchSyntaxRejection(displayPath, batch, error) {
  if (batch.hunks.length === 1) {
    const h = batch.hunks[0];
    return syntaxRejection(
      displayPath,
      { startLine: h.startLine, endLine: h.endLine, newText: h.newLines.join("\n") },
      {
        content: batch.content,
        before: batch.before,
        after: batch.after,
        removed: h.removed,
        added: h.added,
        resolvedStart: h.startLine,
        resolvedEnd: h.endLine
      },
      error
    );
  }
  const first = batch.hunks[0];
  const last = batch.hunks[batch.hunks.length - 1];
  const delta = batch.totalAdded - batch.totalRemoved;
  const afterWin = renderWindow(displayPath, batch.after, first.startLine - LINE_EDIT_CONTEXT_LINES, last.endLine + delta + LINE_EDIT_CONTEXT_LINES);
  const beforeWin = renderWindow(displayPath, batch.before, first.startLine - LINE_EDIT_CONTEXT_LINES, last.endLine + LINE_EDIT_CONTEXT_LINES);
  return [
    `Your batch edit (${batch.hunks.length} hunks) was NOT applied: it introduces a syntax error.`,
    `ERROR: ${error}`,
    "",
    "This is how the file would have looked:",
    afterWin,
    "",
    "This is the original code before your edit:",
    beforeWin,
    "",
    "Fix the affected hunk(s) and try again. Do not repeat the same edit."
  ].join("\n");
}
function toSafeInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, "").trim());
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return void 0;
}
function normalizeRawHunk(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
  const obj = raw;
  const sl = toSafeInt(obj.start_line ?? obj.startLine ?? obj.line_start ?? obj.from_line ?? obj.start ?? obj.line);
  const el = toSafeInt(obj.end_line ?? obj.endLine ?? obj.line_end ?? obj.to_line ?? obj.end);
  const ntRaw = obj.new_text ?? obj.newText ?? obj.new_string ?? obj.new_str ?? obj.text ?? obj.content ?? obj.replacement ?? obj.lines;
  if (sl === void 0 || el === void 0 || typeof ntRaw !== "string") return void 0;
  const stRaw = obj.start_text ?? obj.startText ?? obj.anchor ?? obj.start_anchor ?? obj.first_line;
  const etRaw = obj.end_text ?? obj.endText ?? obj.end_anchor ?? obj.last_line;
  return {
    start_line: sl,
    end_line: el,
    ...typeof stRaw === "string" ? { start_text: stRaw } : {},
    ...typeof etRaw === "string" ? { end_text: etRaw } : {},
    new_text: ntRaw
  };
}
function parseLineEditHunks(args) {
  if (args.edits !== void 0) {
    let source = args.edits;
    if (typeof source === "string") {
      try {
        source = JSON.parse(source);
      } catch {
        return "edits must be a valid JSON array of edit hunks";
      }
    }
    const items = Array.isArray(source) ? source : typeof source === "object" && source !== null ? [source] : void 0;
    if (!items || items.length === 0) return "edits must be a non-empty array of { start_line, end_line, start_text?, new_text } hunks";
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const normalized = normalizeRawHunk(items[i]);
      if (normalized === void 0) {
        return `edits[${i}] is missing required start_line, end_line, or new_text`;
      }
      out.push({
        startLine: normalized.start_line,
        endLine: normalized.end_line,
        ...normalized.start_text !== void 0 ? { startText: normalized.start_text } : {},
        ...normalized.end_text !== void 0 ? { endText: normalized.end_text } : {},
        newText: normalized.new_text
      });
    }
    return out;
  }
  const single = normalizeRawHunk(args);
  if (single === void 0) {
    return "Provide either edits: [{ start_line, end_line, start_text, new_text }] or single-hunk start_line, end_line, new_text";
  }
  return [{
    startLine: single.start_line,
    endLine: single.end_line,
    ...single.start_text !== void 0 ? { startText: single.start_text } : {},
    ...single.end_text !== void 0 ? { endText: single.end_text } : {},
    newText: single.new_text
  }];
}

// src/edit-modes/folded-read-guard.ts
var foldedUnreadBySession = /* @__PURE__ */ new Map();
function isFoldedUnreadPath(sessionId, candidates) {
  if (sessionId === void 0 || sessionId === "") return false;
  const blocked = foldedUnreadBySession.get(sessionId);
  if (blocked === void 0 || blocked.size === 0) return false;
  return candidates.some((candidate) => candidate !== void 0 && candidate !== "" && blocked.has(candidate));
}
function foldedUnreadErrorMessage(displayPath, toolName = "edit") {
  return `The earlier read output for ${displayPath} was folded out of the active context window. Call \`read\` on ${displayPath} again to inspect its current content before calling \`${toolName}\`.`;
}

// src/edit-modes/observations.ts
import { resolve } from "node:path";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";

// src/dsh-host.ts
function sessionIdOfExec(exec) {
  return exec.agent?.session?.header?.id;
}
async function ensureExecWorkingDir(host, exec) {
  const workingDirectory = host.get("workingDirectory");
  if (exec.agent === void 0 || workingDirectory === void 0) return void 0;
  return workingDirectory.ensure(exec.agent, exec.signal);
}

// src/core/todo-state.ts
var TODO_PLAN_TOOL = "todo_plan";
var TODO_UPDATE_TOOL = "todo_update";
var TODO_PLAN_DESCRIPTION = "Create or revise the ordered work list for multi-step tasks (touching multiple methods/files, code + docs/tests, or 3+ distinct subgoals). Skip this tool for casual chat, quick single-goal lookups (1-3 reads or searches), or a trivial one-spot edit. For multi-step changes, you may inspect 1-2 files first to understand the layout, then call todo_plan BEFORE making your first file edit \u2014 do not wait until after editing to plan. Calling todo_plan mid-turn keeps completed/dropped items and their notes intact and replaces only unfinished items.";
var TODO_UPDATE_DESCRIPTION = "Update one item in the current work list by id. As soon as an item is finished, mark it completed with a concise factual note (<= 120 words: exact /app/... file paths, updated line ranges, signatures, and test exit codes \u2014 never mark unexecuted work completed). Older exploratory tool outputs before the recent workspace actions are folded once note is saved, while your initial todo_plan and the latest workspace results stay visible. The next pending item becomes in_progress automatically; you may also checkpoint an in_progress item with an interim note before context fills up.";
var WORKLIST_PROTOCOL_TAG = /<\/?(?:think|tool_call|tool_response)(?:\s[^>]*)?>/gi;
var WORKLIST_LEADING_BULLET = /^\s*(?:\[\d+\]|\d+[.)]|[-*•])\s*/;
function sanitizeWorklistField(text) {
  return text.replace(WORKLIST_PROTOCOL_TAG, "").replace(/\s*\n+\s*/g, " | ").trim();
}
function parsePlanItems(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        const cleaned = sanitizeWorklistField(entry.replace(WORKLIST_LEADING_BULLET, ""));
        if (cleaned !== "") out.push(cleaned);
      } else if (typeof entry === "object" && entry !== null) {
        const obj = entry;
        const candidate = obj.content ?? obj.title ?? obj.text ?? obj.step;
        if (typeof candidate === "string") {
          const cleaned = sanitizeWorklistField(candidate.replace(WORKLIST_LEADING_BULLET, ""));
          if (cleaned !== "") out.push(cleaned);
        }
      } else {
        return void 0;
      }
    }
    return out;
  }
  if (typeof raw === "string") {
    const lines = raw.split(/\r?\n/).map((line) => sanitizeWorklistField(line.replace(WORKLIST_LEADING_BULLET, ""))).filter((line) => line !== "");
    return lines.length > 0 ? lines : void 0;
  }
  return void 0;
}
function normalizeWorklistStatus(raw) {
  if (typeof raw !== "string") return void 0;
  const lower = raw.trim().toLowerCase();
  if (lower === "pending" || lower === "todo" || lower === "not_started") return "pending";
  if (lower === "in_progress" || lower === "in-progress" || lower === "doing" || lower === "active") return "in_progress";
  if (lower === "completed" || lower === "complete" || lower === "done" || lower === "finished") return "completed";
  if (lower === "dropped" || lower === "cancelled" || lower === "canceled" || lower === "skipped") return "dropped";
  return void 0;
}

// src/core/tool-mappings.ts
var nonEmptyStr = (value) => typeof value === "string" && value.trim() !== "" ? value : void 0;
var finiteInt = (value) => typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : void 0;
function stripUndefined(args) {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== void 0));
}
function workspacePath(value) {
  const path = nonEmptyStr(value);
  if (path === void 0) return void 0;
  const index = path.lastIndexOf("workspace/");
  if (path.startsWith("/") && index >= 0) return path.slice(index + "workspace/".length) || ".";
  if (path === "/workspace") return ".";
  return path;
}
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function unescapeRegex(text) {
  return text.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
}
var BUILTIN_MAPPINGS = {
  read: {
    wireName: "read_file",
    description: "Read a UTF-8 text file in the workspace. Lines come numbered. Without start_line/end_line it returns the start of the file.",
    arguments: '{"path":"relative file path","start_line":"optional integer >= 1","end_line":"optional integer >= start_line"}',
    schema: { properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } } },
    toDsh(args) {
      const start = finiteInt(args.start_line);
      const end = finiteInt(args.end_line);
      return stripUndefined({
        file_path: workspacePath(args.path),
        offset: start,
        limit: end !== void 0 ? Math.max(1, end - (start ?? 1) + 1) : void 0
      });
    },
    fromDsh(args) {
      const offset = finiteInt(args.offset);
      const limit = finiteInt(args.limit);
      return stripUndefined({
        path: args.file_path,
        start_line: offset,
        end_line: limit !== void 0 ? (offset ?? 1) + limit - 1 : void 0
      });
    }
  },
  write: {
    wireName: "write_file",
    description: "Create or overwrite a workspace text file with the given content. The content becomes the whole file.",
    arguments: '{"path":"relative file path","content":"full file content"}',
    schema: { properties: { path: { type: "string" }, content: { type: "string" } } },
    toDsh: (args) => ({ file_path: workspacePath(args.path), content: args.content ?? "" }),
    fromDsh: (args) => ({ path: args.file_path, content: args.content })
  },
  edit: {
    wireName: "edit_file",
    description: "Replace one exact piece of text in a workspace text file. old_text must appear exactly once; copy it from read_file without the line numbers.",
    arguments: '{"path":"relative file path","old_text":"exact text to replace","new_text":"replacement text"}',
    schema: { properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } } },
    toDsh: (args) => ({ file_path: workspacePath(args.path), old_string: args.old_text ?? "", new_string: args.new_text ?? "" }),
    fromDsh: (args) => ({ path: args.file_path, old_text: args.old_string, new_text: args.new_string })
  },
  // Line-range edit (src/line-edit.ts); offered only where that plugin is mounted.
  edit_lines: {
    wireName: "edit_lines",
    description: "Replace a range of lines in a workspace text file, numbered as read_file shows them. end_line = start_line - 1 inserts before start_line.",
    arguments: '{"path":"relative file path","start_line":"first line to replace","end_line":"last line to replace","new_text":"replacement lines without line numbers"}',
    schema: { properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" }, new_text: { type: "string" } } },
    toDsh: (args) => ({ file_path: workspacePath(args.path), start_line: args.start_line, end_line: args.end_line, new_text: args.new_text ?? "" }),
    fromDsh: (args) => ({ path: args.file_path, start_line: args.start_line, end_line: args.end_line, new_text: args.new_text })
  },
  glob: {
    wireName: "list_files",
    description: "List files below a workspace-relative path.",
    arguments: '{"path":"optional relative directory","pattern":"optional glob such as *.ts"}',
    schema: { properties: { path: { type: "string" }, pattern: { type: "string" } } },
    toDsh: (args) => stripUndefined({ pattern: nonEmptyStr(args.pattern) ?? "*", path: workspacePath(args.path) }),
    fromDsh: (args) => stripUndefined({ path: args.path, pattern: args.pattern === "*" ? void 0 : args.pattern })
  },
  grep: {
    wireName: "search_text",
    description: "Search literal text in workspace files. Returns matching lines with line numbers.",
    arguments: '{"query":"literal text","path":"optional relative path"}',
    schema: { properties: { query: { type: "string" }, path: { type: "string" } } },
    toDsh: (args) => stripUndefined({ pattern: escapeRegex(String(args.query ?? "")), path: workspacePath(args.path) }),
    fromDsh: (args) => stripUndefined({ query: unescapeRegex(String(args.pattern ?? "")), path: args.path })
  },
  bash: {
    wireName: "bash",
    description: "Run a bash command in the workspace and return stdout and stderr. Each call starts in the workspace and does not keep cd or variables from earlier calls.",
    arguments: '{"command":"bash command line"}',
    schema: { properties: { command: { type: "string" } } },
    toDsh(args) {
      const command = String(args.command ?? "");
      const firstLine = command.split("\n")[0] ?? "";
      return { description: firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || "Run command", command };
    },
    fromDsh: (args) => ({ command: args.command })
  },
  web_search: {
    wireName: "web_search",
    description: "Search the public web and return titles, URLs, snippets, and source IDs.",
    arguments: '{"query":"search query"}',
    schema: { properties: { query: { type: "string" } } },
    toDsh: (args) => ({ queries: [String(args.query ?? "")] }),
    fromDsh: (args) => ({ query: Array.isArray(args.queries) ? args.queries.join(" ") : args.queries })
  },
  web_fetch: {
    wireName: "web_fetch",
    description: "Fetch the readable content of one public web page.",
    arguments: '{"url":"https://example.com/page"}',
    schema: { properties: { url: { type: "string" } } },
    toDsh(args) {
      const url = nonEmptyStr(args.url) ?? (Array.isArray(args.urls) ? nonEmptyStr(args.urls[0]) : void 0);
      return { url: url ?? "" };
    },
    fromDsh: (args) => ({ url: args.url })
  },
  // Stateful work list (src/todo.ts); offered when historyMode === 'worklist'.
  [TODO_PLAN_TOOL]: {
    wireName: TODO_PLAN_TOOL,
    description: TODO_PLAN_DESCRIPTION,
    arguments: '{"items":"array of string"}',
    schema: { properties: { items: { type: "array", items: { type: "string" } } } },
    toDsh: (args) => ({ items: parsePlanItems(args.items) ?? args.items }),
    fromDsh: (args) => ({ items: args.items })
  },
  [TODO_UPDATE_TOOL]: {
    wireName: TODO_UPDATE_TOOL,
    description: TODO_UPDATE_DESCRIPTION,
    arguments: '{"id":"integer","status":"in_progress|completed|dropped","note":"optional Concrete findings, exact file paths/lines, applied edits, or test outcomes","content":"optional Refined title for this item if the initial wording was inaccurate"}',
    schema: {
      properties: {
        id: { type: "integer" },
        status: { type: "string", enum: ["in_progress", "completed", "dropped"] },
        note: { type: "string" },
        content: { type: "string" }
      }
    },
    toDsh: (args) => stripUndefined({
      id: finiteInt(typeof args.id === "string" ? Number(args.id.trim()) : args.id) ?? args.id,
      status: normalizeWorklistStatus(args.status) ?? args.status,
      note: nonEmptyStr(args.note),
      content: nonEmptyStr(args.content)
    }),
    fromDsh: (args) => stripUndefined({
      id: args.id,
      status: args.status,
      note: args.note,
      content: args.content
    })
  }
};

// src/core/tool-repairs.ts
var PATH_ALIASES = ["file_path", "filepath", "file", "filename", "file_name"];
var NATIVE_PATH_ALIASES = ["path", "filepath", "file", "filename", "file_name"];
var ARGUMENT_ALIASES = {
  read_file: { path: PATH_ALIASES, start_line: ["line_start", "from_line"], end_line: ["line_end", "to_line"] },
  write_file: { path: PATH_ALIASES, content: ["text", "file_text", "contents", "data", "code"] },
  edit_file: {
    path: PATH_ALIASES,
    old_text: ["old_string", "old_str", "old", "search", "find", "original"],
    new_text: ["new_string", "new_str", "new", "replace", "replacement", "updated"]
  },
  edit_lines: {
    path: PATH_ALIASES,
    start_line: ["line_start", "from_line", "start", "line"],
    end_line: ["line_end", "to_line", "end"],
    new_text: ["new_string", "new_str", "text", "content", "replacement", "lines"]
  },
  list_files: { path: ["directory", "dir", "folder", "dir_path"], pattern: ["glob"] },
  search_text: { query: ["pattern", "text", "search", "keyword", "regex"], path: ["file_path", "directory", "dir"] },
  bash: { command: ["cmd", "script", "code", "shell"] },
  web_fetch: { url: ["link", "href", "page"] },
  web_search: { query: ["q", "keywords", "search", "search_query"] },
  [TODO_PLAN_TOOL]: { items: ["todos", "tasks", "steps", "plan"] },
  [TODO_UPDATE_TOOL]: {
    id: ["index", "item_id", "task_id", "step"],
    note: ["notes", "summary", "finding", "findings", "conclusion", "result"],
    content: ["title", "task", "text", "description"]
  }
};
var NATIVE_ARGUMENT_ALIASES = {
  read: { file_path: NATIVE_PATH_ALIASES, offset: ["start_line", "line_start", "from_line"] },
  write: { file_path: NATIVE_PATH_ALIASES, content: ["text", "file_text", "contents", "data", "code"] },
  edit: {
    file_path: NATIVE_PATH_ALIASES,
    old_string: ["old_text", "old_str", "old", "search", "find", "original"],
    new_string: ["new_text", "new_str", "new", "replace", "replacement", "updated"]
  },
  edit_lines: {
    file_path: NATIVE_PATH_ALIASES,
    start_line: ["line_start", "from_line", "start", "line", "offset"],
    end_line: ["line_end", "to_line", "end"],
    new_text: ["new_string", "new_str", "text", "content", "replacement", "lines"]
  },
  glob: { pattern: ["glob"], path: ["directory", "dir", "folder", "dir_path"] },
  grep: { pattern: ["query", "text", "search", "keyword", "regex"], path: ["file_path", "directory", "dir"] },
  bash: { command: ["cmd", "script", "code", "shell"] },
  web_fetch: { url: ["link", "href", "page"] },
  web_search: { queries: ["query", "q", "keywords", "search", "search_query"] },
  [TODO_PLAN_TOOL]: ARGUMENT_ALIASES[TODO_PLAN_TOOL],
  [TODO_UPDATE_TOOL]: ARGUMENT_ALIASES[TODO_UPDATE_TOOL]
};

// src/result-budget.ts
var READ_SHOWN_EVENT = "rwkv/read-shown";

// src/edit-modes/observations.ts
var EDIT_LINES_TOOL = "edit_lines";
var OBSERVED_RECORD = "plugin:rwkv-edit-lines/observed";
var appendRecord = appendPluginRecord;
var recordOf = pluginRecordOf;
var encodeLines = (lines) => lines === "all" ? "all" : [...lines].sort((a, b) => a - b);
var decodeLines = (value) => {
  if (value === "all") return "all";
  if (!Array.isArray(value) || !value.every((n) => typeof n === "number" && Number.isSafeInteger(n))) return void 0;
  return new Set(value);
};
var decodeObservation = (data) => {
  if (typeof data !== "object" || data === null) return void 0;
  const { targetKey, observation, lines } = data;
  if (typeof targetKey !== "string" || targetKey === "") return void 0;
  if (typeof observation !== "object" || observation === null) return void 0;
  const kind = observation.kind;
  if (kind !== "present" && kind !== "absent") return void 0;
  if (kind === "present" && observation.version == null) return void 0;
  const decoded = decodeLines(lines);
  if (decoded === void 0) return void 0;
  return { targetKey, observation, lines: decoded };
};
var sameVersion = (a, b) => a?.kind === "present" && b.kind === "present" && JSON.stringify(a.version) === JSON.stringify(b.version);
var Observations = class {
  bySession = /* @__PURE__ */ new WeakMap();
  hydrated = /* @__PURE__ */ new WeakSet();
  readTargets = /* @__PURE__ */ new WeakMap();
  mapFor(session) {
    let byTarget = this.bySession.get(session);
    if (byTarget === void 0) this.bySession.set(session, byTarget = /* @__PURE__ */ new Map());
    return byTarget;
  }
  hydrate(session) {
    if (this.hydrated.has(session)) return;
    this.hydrated.add(session);
    const events = session.snapshotEvents?.();
    if (events === void 0) return;
    for (const event of events) {
      const record = recordOf(event);
      if (record?.type !== OBSERVED_RECORD) continue;
      const entry = decodeObservation(record.data);
      if (entry !== void 0) {
        this.mapFor(session).set(entry.targetKey, { observation: entry.observation, lines: entry.lines });
      }
    }
  }
  persist(session, targetKey, seen) {
    const data = {
      targetKey,
      observation: seen.observation,
      lines: encodeLines(seen.lines)
    };
    try {
      appendRecord(session, OBSERVED_RECORD, data);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("reenter")) return;
      setTimeout(() => {
        try {
          appendRecord(session, OBSERVED_RECORD, data);
        } catch {
        }
      }, 0);
    }
  }
  record(actor, target, observation) {
    const session = actor?.agent?.session;
    if (session === void 0) return;
    this.hydrate(session);
    const byTarget = this.mapFor(session);
    const previous = byTarget.get(target.targetKey);
    const seen = { observation, lines: "all" };
    byTarget.set(target.targetKey, seen);
    if (actor !== void 0 && actor.name === "read") {
      const before = previous !== void 0 && sameVersion(previous.observation, observation) ? previous.lines : /* @__PURE__ */ new Set();
      this.readTargets.set(actor, { session, targetKey: target.targetKey, before });
    } else if (actor?.name !== EDIT_LINES_TOOL) {
      this.persist(session, target.targetKey, seen);
    }
  }
  shown(exec, first, last) {
    const read = this.readTargets.get(exec);
    if (read === void 0) return;
    this.readTargets.delete(exec);
    const seen = this.bySession.get(read.session)?.get(read.targetKey);
    if (seen === void 0) return;
    seen.lines = addSeen(read.before, first, last);
    this.persist(read.session, read.targetKey, seen);
  }
  setLines(actor, target, lines) {
    const session = actor.agent?.session;
    if (session === void 0) return;
    this.hydrate(session);
    const seen = this.bySession.get(session)?.get(target.targetKey);
    if (seen === void 0) return;
    seen.lines = lines;
    this.persist(session, target.targetKey, seen);
  }
  guard(actor, target) {
    const session = actor.agent?.session;
    if (session === void 0) return { kind: "replaceIfVersion", version: void 0, lines: "all" };
    this.hydrate(session);
    const seen = this.bySession.get(session)?.get(target.targetKey);
    if (seen === void 0) return `cannot modify "${target.displayPath}": file has not been read \u2014 read the file, then retry`;
    if (seen.observation.kind === "absent") return `cannot edit "${target.displayPath}": not found \u2014 use write to create it`;
    return { kind: "replaceIfVersion", version: seen.observation.version, lines: seen.lines };
  }
};
function attachObservations(host) {
  const observations = new Observations();
  host.on("fs/observed", (target, observation, actor) => observations.record(actor, target, observation));
  host.on(READ_SHOWN_EVENT, (exec, window) => observations.shown(exec, window.first, window.last));
  return observations;
}
async function resolveTargetWithGuards(host, observations, rawFilePath, exec, options) {
  if (typeof rawFilePath !== "string" || rawFilePath.trim() === "") {
    throw new Error("file_path must be a non-empty string");
  }
  const cwd = await ensureExecWorkingDir(host, exec);
  const resolveOpts = { ...cwd !== void 0 ? { cwd } : {}, ...exec.signal ? { signal: exec.signal } : {} };
  const target = await host.fs.resolve(rawFilePath, resolveOpts);
  const folded = isFoldedUnreadPath(sessionIdOfExec(exec), [
    host.fs.processPath(target),
    target.displayPath,
    ...cwd !== void 0 ? [resolve(cwd, rawFilePath.trim())] : []
  ]);
  if (folded && !options?.allowFolded) {
    throw new Error(foldedUnreadErrorMessage(target.displayPath, EDIT_LINES_TOOL));
  }
  const guard = observations.guard(exec, target);
  if (typeof guard === "string") throw new Error(guard);
  return { target, guard, folded };
}
function remediateStaleVersion(error) {
  if (error?.code !== "FS_STALE_VERSION") return error;
  return new Error(`${error.message} \u2014 its line numbers may have moved; re-read the file, then retry`, { cause: error });
}

// src/edit-modes/syntax-check.ts
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
var stripTsTypes = nodeModule.stripTypeScriptTypes;
var TIMEOUT_MS = 1e4;
var PYTHON_CHECK = String.raw`
import sys
source = sys.stdin.read()
try:
    compile(source, sys.argv[1], "exec", dont_inherit=True)
except SyntaxError as error:
    print(f"{type(error).__name__}: {error.msg} (line {error.lineno})")
    sys.exit(1)
`;
function run(command, args, input) {
  return new Promise((resolve2) => {
    let output = "";
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve2(value);
      }
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    } catch {
      done(void 0);
      return;
    }
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", () => done(void 0));
    child.on("close", (code, signal) => done(signal !== null ? void 0 : code === 0 ? "" : output.trim() || `exit ${code}`));
    child.stdin.on("error", () => void 0);
    child.stdin.end(input);
  });
}
async function nodeCheck(text, extension) {
  const dir = await mkdtemp(join(tmpdir(), "rwkv-edit-check-"));
  try {
    const file = join(dir, `check${extension}`);
    await writeFile(file, text);
    const output = await run(process.execPath, ["--check", file], "");
    if (!output) return output;
    const line = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(output)?.[1];
    const message = output.split("\n").find((lineText) => /^[A-Za-z]*Error: /.test(lineText)) ?? output.split("\n")[0];
    return line === void 0 ? message : `${message} (line ${line})`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function tsOrJsStripCheck(text) {
  if (!stripTsTypes) return void 0;
  try {
    stripTsTypes(text, { mode: "strip" });
    return "";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      return void 0;
    }
    const firstLine = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    return `SyntaxError: ${firstLine}`;
  }
}
async function syntaxError(text, path) {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".py":
      return run("python3", ["-c", PYTHON_CHECK, path], text);
    case ".go":
      return run("gofmt", ["-e"], text);
    case ".ts":
    case ".mts":
    case ".cts":
      return tsOrJsStripCheck(text);
    case ".js":
    case ".mjs":
    case ".cjs":
      return nodeCheck(text, extension);
    case ".sh":
    case ".bash":
      return run("bash", ["-n"], text);
    case ".json":
      if (text.trim() === "") return "";
      try {
        JSON.parse(text);
        return "";
      } catch (error) {
        return `JSON: ${error.message}`;
      }
    default:
      return void 0;
  }
}
async function introducedSyntaxError(before, after, path) {
  const now = await syntaxError(after, path);
  if (!now) return void 0;
  return await syntaxError(before, path) === "" ? now : void 0;
}

// src/edit-modes/line-edit.ts
function createLineEditToolDefinition(host, observations) {
  return defineTool({
    name: EDIT_LINES_TOOL,
    description: "Atomically apply one or more non-overlapping anchored line-range edits to an existing UTF-8 text file. Pass `edits: [{ start_line, end_line, start_text, end_text?, new_text }]` (pre-edit 1-based line numbers; `end_line = start_line - 1` inserts before `start_line`; empty `new_text` deletes). Always include `start_text` (the original text at `start_line` without line-number prefix) so minor line drift auto-aligns cleanly. Single-hunk top-level `start_line`/`end_line`/`new_text` shorthand is also accepted.",
    parameters: {
      file_path: { type: "string", required: true, description: "Path to edit, resolved by the filesystem backend. Read the file first." },
      edits: {
        type: "array",
        description: "One or more non-overlapping anchored edits evaluated against pre-edit 1-based line numbers.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            start_line: { type: "number", required: true, description: "1-based first line to replace (from read output)." },
            end_line: { type: "number", required: true, description: "1-based last line to replace (start_line - 1 inserts before start_line)." },
            start_text: { type: "string", description: "Original text of line start_line without line-number prefix (verifies and auto-aligns line drift)." },
            end_text: { type: "string", description: "Optional original text of line end_line for multi-line spans." },
            new_text: { type: "string", required: true, description: "Replacement lines without line-number prefixes (empty string deletes)." }
          }
        }
      },
      start_line: { type: "number", description: "Single-hunk shorthand: 1-based first line to replace." },
      end_line: { type: "number", description: "Single-hunk shorthand: 1-based last line to replace (start_line - 1 inserts)." },
      start_text: { type: "string", description: "Single-hunk shorthand: original text of line start_line without line-number prefix." },
      end_text: { type: "string", description: "Single-hunk shorthand: optional original text of line end_line." },
      new_text: { type: "string", description: "Single-hunk shorthand: replacement lines without line numbers." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true, description: "Canonical absolute path in the filesystem execution world." },
          summary: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.summary }]
    },
    async execute(args, exec) {
      const hunks = parseLineEditHunks(args);
      if (typeof hunks === "string") throw new Error(hunks);
      const allNonTrivialAnchored = hunks.every((h) => isNonTrivialAnchor(h.startText, 8));
      const { target, guard, folded } = await resolveTargetWithGuards(
        host,
        observations,
        args.file_path,
        exec,
        { allowFolded: allNonTrivialAnchored }
      );
      try {
        const text = await host.fs.readText(target, exec.signal);
        const edited = applyAnchoredLineEdits(text, target.displayPath, hunks);
        if (typeof edited === "string") throw new Error(edited);
        const allVerified = allNonTrivialAnchored && edited.hunks.every((h) => h.anchorVerified);
        if (folded && !allVerified) {
          throw new Error(foldedUnreadErrorMessage(target.displayPath, EDIT_LINES_TOOL));
        }
        if (guard.lines !== "all" && !folded) {
          for (const h of edited.hunks) {
            const rawHunk = hunks[h.index];
            const startAnchored = h.anchorVerified && isNonTrivialAnchor(rawHunk?.startText, 8);
            const endAnchored = h.endAnchorVerified && isNonTrivialAnchor(rawHunk?.endText, 4);
            if (startAnchored && (h.endLine <= h.startLine || endAnchored)) continue;
            const missing = unseenLines(guard.lines, h, edited.before.length);
            if (missing.length > 0) {
              throw new Error(unseenRejection(target.displayPath, missing, guard.lines, edited.before.length, LINE_EDIT_CONTEXT_LINES));
            }
          }
        }
        const broken = await introducedSyntaxError(text, edited.content, target.displayPath);
        if (broken !== void 0) throw new Error(batchSyntaxRejection(target.displayPath, edited, broken));
        const expected = guard.version === void 0 ? void 0 : { kind: guard.kind, version: guard.version };
        const policy = sandboxPolicyFor(host.get("sandboxPolicy"), exec.agent?.session);
        const outcome = await host.fs.writeText(target, edited.content, expected, exec.signal, policy);
        host.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
        observations.setLines(
          exec,
          target,
          seenAfterBatchEdit(guard.lines, edited.hunks, edited.after.length, LINE_EDIT_CONTEXT_LINES)
        );
        return { path: host.fs.processPath(target), summary: batchEditSummary(target.displayPath, edited) };
      } catch (error) {
        throw remediateStaleVersion(error);
      }
    }
  });
}
function applyLineEditPlugin(ctx) {
  const host = ctx;
  const observations = attachObservations(host);
  host.tools.register(createLineEditToolDefinition(host, observations));
}

// src/line-edit.ts
var name = "rwkv-edit-lines";
var inject = ["tools", "fs"];
function apply(ctx) {
  applyLineEditPlugin(ctx);
}
export {
  EDIT_LINES_TOOL,
  apply,
  inject,
  name
};
//# sourceMappingURL=line-edit.js.map
