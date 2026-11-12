// src/line-edit.ts
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/core/line-edit.ts
var CONTEXT = 3;
function applyLineEdit(text, displayPath, edit) {
  const { startLine: start, endLine: end } = edit;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "start_line and end_line must be whole numbers";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text;
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized === "" ? [] : (trailingNewline ? normalized.slice(0, -1) : normalized).split("\n");
  const total = lines.length;
  if (start < 1) return `start_line must be 1 or more (got ${start})`;
  if (start > total + 1) return `start_line ${start} is past the end: ${displayPath} has ${total} lines`;
  if (end > total) return `end_line ${end} is past the end: ${displayPath} has ${total} lines`;
  if (end < start - 1) return `end_line ${end} is before start_line ${start}; use end_line = start_line - 1 to insert without replacing`;
  const newLines = newLinesOf(edit.newText);
  const removed = lines.slice(start - 1, end);
  if (removed.length === newLines.length && removed.every((line, index) => line === newLines[index])) {
    return `new_text is the same as lines ${start}-${end}; nothing changed`;
  }
  const after = [...lines.slice(0, start - 1), ...newLines, ...lines.slice(end)];
  const keepNewline = trailingNewline || total === 0 && after.length > 0;
  const joined = after.join("\n") + (keepNewline && after.length > 0 ? "\n" : "");
  const content = eol === "\r\n" ? joined.replace(/\n/g, "\r\n") : joined;
  return { content, before: lines, after, removed: removed.length, added: newLines.length };
}
function newLinesOf(text) {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n");
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}
var plural = (count) => `${count} line${count === 1 ? "" : "s"}`;
function renderWindow(displayPath, lines, from, to) {
  const out = [`[File: ${displayPath} (${plural(lines.length)} total)]`];
  if (lines.length === 0) return `${out[0]}
(empty file)`;
  const first = Math.max(1, from);
  const last = Math.min(lines.length, to);
  if (first > 1) out.push(`(${first - 1} more lines above)`);
  for (let n = first; n <= last; n++) out.push(`${n}: ${lines[n - 1]}`);
  if (last < lines.length) out.push(`(${lines.length - last} more lines below)`);
  return out.join("\n");
}
function resultWindow(displayPath, edit, result) {
  return renderWindow(displayPath, result.after, edit.startLine - CONTEXT, edit.startLine + Math.max(result.added, 1) - 1 + CONTEXT);
}
function editSummary(displayPath, edit, result) {
  const { startLine: start, endLine: end } = edit;
  const { removed, added } = result;
  let what;
  if (removed === 0) what = start > 1 ? `Inserted ${plural(added)} after line ${start - 1}` : `Inserted ${plural(added)} at the start`;
  else if (added === 0) what = `Deleted lines ${start}-${end}`;
  else what = `Replaced lines ${start}-${end} with ${plural(added)}`;
  const parts = [`File updated. ${what}.`];
  const delta = added - removed;
  if (delta !== 0 && end < result.before.length) {
    parts.push(`Lines after it moved ${delta > 0 ? "down" : "up"} by ${Math.abs(delta)}: old line ${end + 1} is now line ${end + 1 + delta}.`);
  }
  parts.push("Review the change (correct indentation, no duplicate or missing lines) and edit again if necessary.");
  return `${parts.join(" ")}
${resultWindow(displayPath, edit, result)}`;
}
function syntaxRejection(displayPath, edit, result, error) {
  const original = renderWindow(displayPath, result.before, edit.startLine - CONTEXT, Math.max(edit.endLine, edit.startLine) + CONTEXT);
  return [
    "Your edit was NOT applied: it introduces a syntax error.",
    `ERROR: ${error}`,
    "",
    "This is how the file would have looked:",
    resultWindow(displayPath, edit, result),
    "",
    "This is the original code before your edit:",
    original,
    "",
    "Fix start_line/end_line or new_text (check the indentation) and try again. Do not repeat the same edit."
  ].join("\n");
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
function seenAfterEdit(seen, edit, result) {
  if (seen === "all") return seen;
  const { startLine: start, endLine: end } = edit;
  const delta = result.added - result.removed;
  const next = /* @__PURE__ */ new Set();
  for (const n of seen) {
    if (n < start) next.add(n);
    else if (n > end) next.add(n + delta);
  }
  const total = result.after.length;
  const from = Math.max(1, start - CONTEXT);
  const to = Math.min(total, start + Math.max(result.added, 1) - 1 + CONTEXT);
  for (let n = from; n <= to; n++) next.add(n);
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
function unseenRejection(displayPath, missing, seen, total) {
  const offset = Math.max(1, missing[0] - CONTEXT);
  const shown = seen.size === 0 ? "you have seen none of it" : `you have seen lines ${formatRanges(seen)}`;
  const which = missing.length === 1 ? `line ${missing[0]} of ${displayPath} has` : `lines ${formatRanges(missing)} of ${displayPath} have`;
  return `Your edit was NOT applied: ${which} not been shown to you (the file has ${total} lines; ${shown}). Read them first (read with offset=${offset}), then edit by the numbers you see.`;
}

// src/result-budget.ts
var READ_SHOWN_EVENT = "rwkv/read-shown";

// src/syntax-check.ts
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
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
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
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
    const message = output.split("\n").find((text2) => /^[A-Za-z]*Error: /.test(text2)) ?? output.split("\n")[0];
    return line === void 0 ? message : `${message} (line ${line})`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function syntaxError(text, path) {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".py":
      return run("python3", ["-c", PYTHON_CHECK, path], text);
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

// src/line-edit.ts
var name = "rwkv-edit-lines";
var inject = ["tools", "fs"];
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
  /** Sessions whose log has been read; the in-memory map is authoritative after that. */
  hydrated = /* @__PURE__ */ new WeakSet();
  /** The file each read observed, until its window is reported. */
  readTargets = /* @__PURE__ */ new WeakMap();
  mapFor(session) {
    let byTarget = this.bySession.get(session);
    if (byTarget === void 0) this.bySession.set(session, byTarget = /* @__PURE__ */ new Map());
    return byTarget;
  }
  /** Rebuild this session's entries from its log, once per process (a resumed session has a new object). */
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
  /** Append the entry's current state. Safe outside a session store (tests): the call is ignored. */
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
  /** read's window as the model got it: the version's lines seen so far plus these. */
  shown(exec, first, last) {
    const read = this.readTargets.get(exec);
    if (read === void 0) return;
    this.readTargets.delete(exec);
    const seen = this.bySession.get(read.session)?.get(read.targetKey);
    if (seen === void 0) return;
    seen.lines = addSeen(read.before, first, last);
    this.persist(read.session, read.targetKey, seen);
  }
  /** After this tool's own write (recorded through fs/observed first). */
  setLines(actor, target, lines) {
    const session = actor.agent?.session;
    if (session === void 0) return;
    this.hydrate(session);
    const seen = this.bySession.get(session)?.get(target.targetKey);
    if (seen === void 0) return;
    seen.lines = lines;
    this.persist(session, target.targetKey, seen);
  }
  /** The guard for a write and the lines seen, or the model-facing reason to refuse. */
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
function remediate(error) {
  if (error?.code !== "FS_STALE_VERSION") return error;
  return new Error(`${error.message} \u2014 its line numbers may have moved; re-read the file, then retry`, { cause: error });
}
function apply(ctx) {
  const host = ctx;
  const observations = new Observations();
  host.on("fs/observed", (target, observation, actor) => observations.record(actor, target, observation));
  host.on(READ_SHOWN_EVENT, (exec, window) => observations.shown(exec, window.first, window.last));
  async function resolveOptions(exec) {
    const workingDirectory = host.get("workingDirectory");
    const cwd = exec.agent === void 0 || workingDirectory === void 0 ? void 0 : await workingDirectory.ensure(exec.agent, exec.signal);
    return { ...cwd !== void 0 ? { cwd } : {}, ...exec.signal ? { signal: exec.signal } : {} };
  }
  host.tools.register(defineTool({
    name: EDIT_LINES_TOOL,
    description: "Edit an existing UTF-8 text file by replacing a range of lines, numbered as read shows them.",
    parameters: {
      file_path: { type: "string", required: true, description: "Path to edit, resolved by the filesystem backend. Read the file first." },
      start_line: { type: "number", required: true, description: "First line to replace (1-based, as numbered by read)." },
      end_line: { type: "number", required: true, description: "Last line to replace. start_line - 1 inserts before start_line without replacing." },
      new_text: { type: "string", required: true, description: "Lines that replace start_line..end_line, without line numbers. Empty deletes them." }
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
      if (args.file_path.trim() === "") throw new Error("file_path must be a non-empty string");
      const target = await host.fs.resolve(args.file_path, await resolveOptions(exec));
      const guard = observations.guard(exec, target);
      if (typeof guard === "string") throw new Error(guard);
      try {
        const text = await host.fs.readText(target, exec.signal);
        const edit = { startLine: args.start_line, endLine: args.end_line, newText: args.new_text };
        const edited = applyLineEdit(text, target.displayPath, edit);
        if (typeof edited === "string") throw new Error(edited);
        const missing = unseenLines(guard.lines, edit, edited.before.length);
        if (missing.length > 0 && guard.lines !== "all") {
          throw new Error(unseenRejection(target.displayPath, missing, guard.lines, edited.before.length));
        }
        const broken = await introducedSyntaxError(text, edited.content, target.displayPath);
        if (broken !== void 0) throw new Error(syntaxRejection(target.displayPath, edit, edited, broken));
        const expected = guard.version === void 0 ? void 0 : { kind: guard.kind, version: guard.version };
        const outcome = await host.fs.writeText(target, edited.content, expected, exec.signal);
        host.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
        observations.setLines(exec, target, seenAfterEdit(guard.lines, edit, edited));
        return { path: host.fs.processPath(target), summary: editSummary(target.displayPath, edit, edited) };
      } catch (error) {
        throw remediate(error);
      }
    }
  }));
}
export {
  EDIT_LINES_TOOL,
  apply,
  inject,
  name
};
//# sourceMappingURL=line-edit.js.map
