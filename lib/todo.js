// src/todo.ts
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { defineTool, ToolArgsError } from "@deepseek-ai/dsh-tools";

// src/core/todo-state.ts
var TODO_PLAN_TOOL = "todo_plan";
var TODO_UPDATE_TOOL = "todo_update";
var TODO_PLAN_DESCRIPTION = "Create or revise the ordered work list for multi-step tasks (touching multiple methods/files, code + docs/tests, or 3+ distinct subgoals). Skip this tool for casual chat, quick single-goal lookups (1-3 reads or searches), or a trivial one-spot edit. For multi-step changes, you may inspect 1-2 files first to understand the layout, then call todo_plan BEFORE making your first file edit \u2014 do not wait until after editing to plan. Calling todo_plan mid-turn keeps completed/dropped items and their notes intact and replaces only unfinished items.";
var TODO_UPDATE_DESCRIPTION = "Update one item in the current work list by id. As soon as an item is finished, mark it completed with a concise factual note (<= 120 words: exact /app/... file paths, updated line ranges, signatures, and test exit codes \u2014 never mark unexecuted work completed). Older exploratory tool outputs before the recent workspace actions are folded once note is saved, while your initial todo_plan and the latest workspace results stay visible. The next pending item becomes in_progress automatically; you may also checkpoint an in_progress item with an interim note before context fills up.";
var WORKLIST_TOOLS = /* @__PURE__ */ new Set([TODO_PLAN_TOOL, TODO_UPDATE_TOOL]);
function isWorklistTool(name2) {
  return WORKLIST_TOOLS.has(name2);
}
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
function applyTodoPlan(current, rawItems) {
  const parsed = parsePlanItems(rawItems);
  if (parsed === void 0 || parsed.length === 0) {
    return "items must be a non-empty array of step strings";
  }
  const locked = current.filter((item) => item.status === "completed" || item.status === "dropped").map((item, idx) => ({ ...item, id: idx + 1 }));
  const lockedTitles = new Set(locked.map((item) => item.content));
  const remaining = parsed.filter((title) => !lockedTitles.has(title));
  if (locked.length === 0 && remaining.length < 2) {
    return "todo_plan requires at least 2 steps; execute single-step tasks directly without todo_plan";
  }
  if (remaining.length === 0) {
    return "todo_plan requires at least 1 new unfinished step after completed items";
  }
  if (locked.length + remaining.length > 12) {
    return `todo_plan accepts at most 12 total items (got ${locked.length + remaining.length}); group micro-actions into coarser subgoals`;
  }
  const seen = /* @__PURE__ */ new Set();
  for (const [idx, title] of remaining.entries()) {
    if (seen.has(title)) {
      return `items[${idx}] duplicates ${JSON.stringify(title)}`;
    }
    seen.add(title);
  }
  const tail = remaining.map((content, idx) => ({
    id: locked.length + idx + 1,
    content,
    status: idx === 0 ? "in_progress" : "pending"
  }));
  return [...locked, ...tail];
}
function applyTodoUpdate(current, input) {
  if (current.length === 0) {
    return "no active todo list in this turn; call todo_plan first if this task has multiple subgoals";
  }
  const rawId = typeof input.id === "string" ? Number(input.id.trim()) : input.id;
  if (typeof rawId !== "number" || !Number.isInteger(rawId) || rawId < 1 || rawId > current.length) {
    return `id must be an integer between 1 and ${current.length} (got ${JSON.stringify(input.id)})`;
  }
  const status = normalizeWorklistStatus(input.status);
  if (status === void 0 || status === "pending") {
    return "status must be one of: in_progress, completed, dropped";
  }
  const target = current[rawId - 1];
  const providedNote = typeof input.note === "string" ? sanitizeWorklistField(input.note) : "";
  const effectiveNote = providedNote !== "" ? providedNote : target.note;
  if ((status === "completed" || status === "dropped") && (!effectiveNote || effectiveNote === "")) {
    return "note is required when status is completed or dropped: record concrete findings, exact file paths/lines, applied edits, or test results";
  }
  const updatedContent = typeof input.content === "string" && sanitizeWorklistField(input.content) !== "" ? sanitizeWorklistField(input.content) : target.content;
  const next = current.map((item, index) => {
    if (index === rawId - 1) {
      return {
        id: item.id,
        content: updatedContent,
        status,
        ...effectiveNote ? { note: effectiveNote } : {}
      };
    }
    if (status === "in_progress" && item.status === "in_progress") {
      const autoDone = index < rawId - 1 && Boolean(item.note && item.note.trim() !== "");
      return { ...item, status: autoDone ? "completed" : "pending" };
    }
    return item;
  });
  if (!next.some((item) => item.status === "in_progress")) {
    const afterIdx = next.findIndex((item, idx) => idx > rawId - 1 && item.status === "pending");
    const promoteIdx = afterIdx >= 0 ? afterIdx : next.findIndex((item) => item.status === "pending");
    if (promoteIdx >= 0) {
      next[promoteIdx] = { ...next[promoteIdx], status: "in_progress" };
    }
  }
  return { items: next, noted: providedNote !== "" };
}
function formatWorklist(items) {
  const lines = ["Todo list:"];
  for (const item of items) {
    lines.push(`[${item.id}] (${item.status}) ${item.content}`);
    if (item.note) lines.push(`  note: ${item.note}`);
  }
  return lines.join("\n");
}
function projectNativeTodos(items, options) {
  const settleActive = options?.turnEnded === true;
  return items.map((item) => ({
    content: item.status === "dropped" ? `[${item.id}] [\u5DF2\u8DF3\u8FC7] ${item.content}` : `[${item.id}] ${item.content}`,
    status: item.status === "dropped" ? "completed" : settleActive && item.status === "in_progress" ? "pending" : item.status
  }));
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

// src/core/policy.ts
var POST_TOOL_REMINDER = `Use the Tool results above to continue the current task.
If the evidence is sufficient, answer now. Call another tool only for a specific missing fact.
Never repeat a successful tool call. Do not open a <think> block or repeat the Tool payload.`;
var POST_TOOL_REMINDER_THINK = POST_TOOL_REMINDER.replace(
  "Do not open a <think> block or repeat the Tool payload.",
  "Do not repeat the Tool payload."
);
var SHELL_WRITE = new RegExp([
  String.raw`(?<![<>&=-])\d?>>?(?![>&=])\s*(?!/dev/null\b)[^\s&|;)]`,
  String.raw`\bsed\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i`,
  String.raw`\b(?:tee|mv|cp|rm|rmdir|touch|mkdir|chmod|ln|patch|truncate|unzip|tar)\b`,
  String.raw`\bgit\s+(?:apply|checkout|restore|reset|commit|merge|rebase|stash|am|cherry-pick|add|rm|mv)\b`,
  String.raw`\b(?:pip3?|npm|pnpm|yarn|uv|cargo|go)\s+(?:install|add|get)\b`
].join("|"));

// src/todo.ts
var name = "rwkv-todo";
var inject = ["tools"];
var STATE_RECORD = "plugin:rwkv-todo/state";
var appendRecord = appendPluginRecord;
var recordOf = pluginRecordOf;
var VALID_STATUSES = /* @__PURE__ */ new Set(["pending", "in_progress", "completed", "dropped"]);
function decodeItems(raw) {
  if (!Array.isArray(raw)) return void 0;
  const items = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return void 0;
    const { id, content, status, note } = entry;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return void 0;
    if (typeof content !== "string" || content === "") return void 0;
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) return void 0;
    if (note !== void 0 && typeof note !== "string") return void 0;
    items.push({
      id,
      content,
      status,
      ...typeof note === "string" && note !== "" ? { note } : {}
    });
  }
  return items;
}
function turnIndexOf(events) {
  if (events === void 0) return 1;
  let turns = 0;
  for (const event of events) {
    if (event.type === "turn/start") turns++;
  }
  return Math.max(1, turns);
}
function blockedBackToBackComplete(events) {
  if (events === void 0 || events.length === 0) return false;
  let skippedCurrentCall = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "turn/start") return false;
    if (ev.type === "tool/call") {
      if (!skippedCurrentCall) {
        skippedCurrentCall = true;
        continue;
      }
      const toolName = typeof ev.data === "object" && ev.data !== null ? ev.data.name : void 0;
      if (typeof toolName === "string" && !isWorklistTool(toolName) && toolName !== "todo_write") {
        return false;
      }
      continue;
    }
    const rec = recordOf(ev);
    if (rec?.type === STATE_RECORD && typeof rec.data === "object" && rec.data !== null) {
      if (rec.data.completed === true) {
        return true;
      }
    }
  }
  return false;
}
var WorklistStore = class {
  bySession = /* @__PURE__ */ new WeakMap();
  hydrated = /* @__PURE__ */ new WeakSet();
  fallback = [];
  get(session) {
    if (session === void 0) return { turn: 1, items: this.fallback };
    const events = session.snapshotEvents?.();
    const currentTurn = turnIndexOf(events);
    if (!this.hydrated.has(session)) {
      this.hydrated.add(session);
      let items = [];
      if (events !== void 0) {
        let logTurn = 0;
        for (const event of events) {
          if (event.type === "turn/start") {
            logTurn++;
            items = [];
            continue;
          }
          const rec = recordOf(event);
          if (rec?.type !== STATE_RECORD || typeof rec.data !== "object" || rec.data === null) continue;
          const decoded = decodeItems(rec.data.items);
          const recTurn = rec.data.turn;
          if (decoded !== void 0 && (typeof recTurn !== "number" || recTurn === Math.max(1, logTurn))) {
            items = decoded;
          }
        }
      }
      const entry = { turn: currentTurn, items };
      this.bySession.set(session, entry);
      return entry;
    }
    const existing = this.bySession.get(session);
    if (existing === void 0 || existing.turn !== currentTurn) {
      const fresh = { turn: currentTurn, items: [] };
      this.bySession.set(session, fresh);
      return fresh;
    }
    return existing;
  }
  save(session, turn, items, completed = false) {
    if (session === void 0) {
      this.fallback = items;
      return;
    }
    this.bySession.set(session, { turn, items });
    const payload = { turn, items, ...completed ? { completed: true } : {} };
    try {
      appendRecord(session, STATE_RECORD, payload);
    } catch {
    }
    try {
      session.append?.("todo/write", { todos: projectNativeTodos(items) });
    } catch {
    }
  }
  /**
   * Settle any lingering `in_progress` indicator in the Desktop `TodoPanel` once
   * `turn/end` commits so an unfinished item does not keep spinning while idle.
   */
  settleTurnEnd(session) {
    if (session === void 0) return;
    const { items } = this.get(session);
    if (!items.some((item) => item.status === "in_progress")) return;
    try {
      session.append?.("todo/write", { todos: projectNativeTodos(items, { turnEnded: true }) });
    } catch {
    }
  }
};
var STATUS_CN = {
  completed: "\u5DF2\u5B8C\u6210",
  in_progress: "\u8BB0\u5F55\u8FDB\u5C55",
  dropped: "\u5DF2\u8DF3\u8FC7"
};
function apply(ctx) {
  const host = ctx;
  const store = new WorklistStore();
  host.on?.("session/event", (session, ev) => {
    if (ev?.type === "turn/end") store.settleTurnEnd(session);
  });
  host.tools.register(defineTool({
    name: TODO_PLAN_TOOL,
    description: TODO_PLAN_DESCRIPTION,
    parameters: {
      items: {
        type: "array",
        required: true,
        description: "Ordered list of concrete subgoals (2-10 short action lines, without numbers). Mid-turn calls keep completed/dropped items and their notes and replace only unfinished items.",
        items: { type: "string" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.summary }]
    },
    execute(args, exec) {
      const session = exec.agent?.session;
      const current = store.get(session);
      const updated = applyTodoPlan(current.items, args.items);
      if (typeof updated === "string") throw new ToolArgsError([updated]);
      store.save(session, current.turn, updated);
      return Promise.resolve({ summary: formatWorklist(updated) });
    },
    presentCall: (args) => ({
      card: "generic",
      title: `\u89C4\u5212\u5DE5\u5355\uFF08${Array.isArray(args.items) ? args.items.length : 0} \u9879\uFF09`,
      kind: "other",
      rawInput: args.items
    })
  }));
  host.tools.register(defineTool({
    name: TODO_UPDATE_TOOL,
    description: TODO_UPDATE_DESCRIPTION,
    parameters: {
      id: {
        type: "number",
        required: true,
        description: "1-based item number from the current todo list."
      },
      status: {
        type: "string",
        required: true,
        enum: ["in_progress", "completed", "dropped"],
        description: "in_progress | completed | dropped. Marking completed or dropped automatically sets the next pending item to in_progress."
      },
      note: {
        type: "string",
        description: "Concrete findings, exact file paths/lines, applied edits, or test outcomes. Required when status is completed or dropped; also used on in_progress to checkpoint progress."
      },
      content: {
        type: "string",
        description: "Optional refined title for this item if the initial wording was inaccurate."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.summary }]
    },
    execute(args, exec) {
      const session = exec.agent?.session;
      const statusNorm = normalizeWorklistStatus(args.status);
      if (statusNorm === "completed" && blockedBackToBackComplete(session?.snapshotEvents?.())) {
        throw new ToolArgsError([
          'Cannot mark another item completed immediately after a previous completion with no workspace tool call in between. Execute or verify this item with a workspace tool first (read, edit_lines, write, or bash), or use status="in_progress" / "dropped".'
        ]);
      }
      const current = store.get(session);
      const updated = applyTodoUpdate(current.items, args);
      if (typeof updated === "string") throw new ToolArgsError([updated]);
      store.save(session, current.turn, updated.items, statusNorm === "completed");
      return Promise.resolve({ summary: formatWorklist(updated.items) });
    },
    presentCall: (args) => {
      const st = typeof args.status === "string" ? STATUS_CN[args.status] ?? args.status : "\u66F4\u65B0";
      return {
        card: "generic",
        title: `\u66F4\u65B0\u5DE5\u5355 #${String(args.id ?? "?")} \xB7 ${st}`,
        kind: "other",
        rawInput: args
      };
    }
  }));
}
export {
  TODO_PLAN_DESCRIPTION,
  TODO_UPDATE_DESCRIPTION,
  apply,
  blockedBackToBackComplete,
  inject,
  name,
  projectNativeTodos
};
//# sourceMappingURL=todo.js.map
