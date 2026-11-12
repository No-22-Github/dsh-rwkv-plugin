// src/line-edit.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/core/line-edit.ts
var CONTEXT = 2;
function applyLineEdit(text, displayPath, edit) {
  const { startLine: start, endLine: end } = edit;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "start_line and end_line must be whole numbers";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text;
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  const lines = normalized === "" ? [] : body.split("\n");
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
  return { content, summary: summarize(displayPath, edit, removed.length, newLines.length, after) };
}
function newLinesOf(text) {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n");
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}
var plural = (count) => `${count} line${count === 1 ? "" : "s"}`;
function summarize(displayPath, edit, removed, added, after) {
  const { startLine: start, endLine: end } = edit;
  let what;
  if (removed === 0) what = start > 1 ? `Inserted ${plural(added)} after line ${start - 1}` : `Inserted ${plural(added)} at the start`;
  else if (added === 0) what = `Deleted lines ${start}-${end}`;
  else what = `Replaced lines ${start}-${end} with ${plural(added)}`;
  const parts = [`The file ${displayPath} has been updated. ${what}.`];
  const delta = added - removed;
  if (delta !== 0 && end < after.length - delta) {
    parts.push(`Lines after it moved ${delta > 0 ? "down" : "up"} by ${Math.abs(delta)}: old line ${end + 1} is now line ${end + 1 + delta}.`);
  }
  if (after.length === 0) {
    parts.push("The file is now empty.");
    return parts.join(" ");
  }
  const from = Math.max(1, start - CONTEXT);
  const to = Math.min(after.length, start + Math.max(added, 1) - 1 + CONTEXT);
  const window = after.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`);
  return `${parts.join(" ")}
Lines ${from}-${to} now:
${window.join("\n")}`;
}

// src/line-edit.ts
var name = "rwkv-edit-lines";
var inject = ["tools", "fs"];
var EDIT_LINES_TOOL = "edit_lines";
var Observations = class {
  bySession = /* @__PURE__ */ new WeakMap();
  record(actor, target, observation) {
    const session = actor?.agent?.session;
    if (session === void 0) return;
    let byTarget = this.bySession.get(session);
    if (byTarget === void 0) this.bySession.set(session, byTarget = /* @__PURE__ */ new Map());
    byTarget.set(target.targetKey, observation);
  }
  /** The guard for a write, or the model-facing reason to refuse. */
  guard(actor, target) {
    const session = actor.agent?.session;
    if (session === void 0) return { kind: "replaceIfVersion", version: void 0 };
    const seen = this.bySession.get(session)?.get(target.targetKey);
    if (seen === void 0) return `cannot modify "${target.displayPath}": file has not been read \u2014 read the file, then retry`;
    if (seen.kind === "absent") return `cannot edit "${target.displayPath}": not found \u2014 use write to create it`;
    return { kind: "replaceIfVersion", version: seen.version };
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
        const edited = applyLineEdit(text, target.displayPath, {
          startLine: args.start_line,
          endLine: args.end_line,
          newText: args.new_text
        });
        if (typeof edited === "string") throw new Error(edited);
        const outcome = await host.fs.writeText(target, edited.content, guard.version === void 0 ? void 0 : guard, exec.signal);
        host.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
        return { path: host.fs.processPath(target), summary: edited.summary };
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
