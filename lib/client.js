window.__ModuleLoader__.load({ id: "dsh-rwkv-plugin", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  NAMESPACE: () => NAMESPACE,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/RwkvSettings.tsx
var import_react4 = require("react");

// src/client/AdapterPicker.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var ROUTE = "/api/rwkv/adapters";
function connectionHeader(connection) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    baseURL: connection.baseURL.trim(),
    ...connection.apiKey ? { apiKey: connection.apiKey } : {},
    ...connection.headers ? { headers: connection.headers } : {}
  }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function failureOf(response) {
  try {
    const body = await response.json();
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
function methodLabel(method) {
  const value = method.trim().toLowerCase();
  if (value === "miss") return "MiSS";
  if (value === "nora") return "NoRA";
  return value.toUpperCase();
}
function suggestID(path) {
  const parts = path.trim().split(/[\\/]+/).filter(Boolean);
  const stem = (parts.at(-1) || "").replace(/\.pth$/i, "");
  if (stem === "adapter-final" || stem === "training") {
    const parent = parts.at(-2) || "";
    if (/^checkpoint-\d+$/.test(parent) && parts.length >= 3) return `${parts.at(-3)}-${parent}`;
    return parent || stem;
  }
  return stem;
}
function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}
function AdapterPicker(props) {
  const { connection } = props;
  const ready = isHttpUrl(connection.baseURL);
  const key = JSON.stringify(connection);
  const [adapters, setAdapters] = (0, import_react.useState)();
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const [pending, setPending] = (0, import_react.useState)();
  const [progress, setProgress] = (0, import_react.useState)();
  const [deleting, setDeleting] = (0, import_react.useState)();
  const fileInput = (0, import_react.useRef)(null);
  const request = (0, import_react.useRef)(0);
  const refresh = async () => {
    if (!ready) return;
    const current2 = ++request.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(ROUTE, { headers: { "x-rwkv-connection": connectionHeader(connection) }, credentials: "same-origin" });
      if (!response.ok) throw new Error(await failureOf(response));
      const body = await response.json();
      if (current2 === request.current) setAdapters(body.adapters);
    } catch (cause) {
      if (current2 === request.current) {
        setAdapters(void 0);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (current2 === request.current) setLoading(false);
    }
  };
  (0, import_react.useEffect)(() => {
    setAdapters(void 0);
    if (!ready) return;
    const timer = setTimeout(() => {
      void refresh();
    }, 400);
    return () => clearTimeout(timer);
  }, [key, ready]);
  const upload = (file, id) => {
    setError("");
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${ROUTE}/${encodeURIComponent(id)}?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("x-rwkv-connection", connectionHeader(connection));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(Math.round(event.loaded * 100 / event.total));
    };
    xhr.onload = () => {
      setProgress(void 0);
      if (xhr.status >= 200 && xhr.status < 300) {
        setPending(void 0);
        props.onChange(id);
        void refresh();
      } else {
        let message = `HTTP ${xhr.status}`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch {
        }
        setError(message);
      }
    };
    xhr.onerror = () => {
      setProgress(void 0);
      setError("\u4E0A\u4F20\u4E2D\u65AD\uFF1A\u8FDE\u63A5\u88AB\u65AD\u5F00");
    };
    xhr.send(file);
  };
  const remove = async (id) => {
    setDeleting(void 0);
    setError("");
    try {
      const response = await fetch(`${ROUTE}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "x-rwkv-connection": connectionHeader(connection) },
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(await failureOf(response));
      if (props.value === id) props.onChange(void 0);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const current = props.value?.trim() || "";
  const busy = props.disabled || loading || progress !== void 0;
  const missing = adapters !== void 0 && current !== "" && !adapters.some((adapter) => adapter.id === current);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rwkv-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rwkv-block-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-label", children: "Adapter" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "rwkv-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rwkv-link", disabled: busy || !ready, onClick: () => {
          void refresh();
        }, children: loading ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: busy || !ready, onClick: () => fileInput.current?.click(), children: "\u4E0A\u4F20" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          ref: fileInput,
          type: "file",
          accept: ".pth",
          hidden: true,
          onChange: (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) setPending({ file, id: suggestID(file.name) });
          }
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rwkv-list", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "rwkv-option", "aria-pressed": current === "", disabled: props.disabled, onClick: () => props.onChange(void 0), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-option-name", children: "\u57FA\u6A21" }),
        current === "" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-option-state", children: "\u4F7F\u7528\u4E2D" }) : null
      ] }),
      (adapters ?? []).map((adapter) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rwkv-option", "aria-pressed": current === adapter.id, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "rwkv-option-main", disabled: props.disabled, onClick: () => props.onChange(adapter.id), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-option-name", children: adapter.id }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-option-meta", children: [methodLabel(adapter.method), adapter.rank ? `rank ${adapter.rank}` : "", adapter.version.slice(0, 8)].filter(Boolean).join(" \xB7 ") }),
          current === adapter.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-option-state", children: "\u4F7F\u7528\u4E2D" }) : null
        ] }),
        deleting === adapter.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "rwkv-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rwkv-link", onClick: () => setDeleting(void 0), children: "\u53D6\u6D88" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small rwkv-danger", onClick: () => {
            void remove(adapter.id);
          }, children: "\u4ECE\u670D\u52A1\u5668\u5220\u9664" })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rwkv-link", disabled: busy, onClick: () => setDeleting(adapter.id), children: "\u5220\u9664" })
      ] }, adapter.id)),
      missing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rwkv-option", "aria-pressed": true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "rwkv-option-main", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-option-name", children: current }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rwkv-error", children: "\u4E0D\u5728\u670D\u52A1\u5668\u4E0A" })
      ] }) }) : null
    ] }),
    pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rwkv-upload", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "rwkv-option-meta", title: pending.file.name, children: [
        pending.file.name,
        " \xB7 ",
        (pending.file.size / 1048576).toFixed(1),
        " MB"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rwkv-upload-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "rwkv-input", value: pending.id, spellCheck: false, placeholder: "adapter id", disabled: progress !== void 0, onChange: (event) => setPending({ ...pending, id: event.target.value }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rwkv-btn rwkv-primary rwkv-small", disabled: !pending.id.trim() || progress !== void 0, onClick: () => upload(pending.file, pending.id.trim()), children: progress === void 0 ? "\u4E0A\u4F20" : `${progress}%` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rwkv-link", disabled: progress !== void 0, onClick: () => setPending(void 0), children: "\u53D6\u6D88" })
      ] })
    ] }) : null,
    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "rwkv-error", children: error }) : null
  ] });
}

// src/client/DeveloperPanel.tsx
var import_react3 = require("react");

// src/client/TraceFrames.tsx
var import_react2 = require("react");

// src/client/traces-api.ts
var TRACE_ROUTE = "/api/rwkv/traces";
var TRACE_EXPORT_ROUTE = "/api/rwkv/trace-export";
async function getJSON(url, signal) {
  const response = await fetch(url, { credentials: "same-origin", ...signal ? { signal } : {} });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error ?? message;
    } catch {
    }
    throw new Error(message);
  }
  return await response.json();
}
function fetchSessions(signal) {
  return getJSON(TRACE_ROUTE, signal);
}
function fetchSession(session, signal) {
  return getJSON(`${TRACE_ROUTE}/${encodeURIComponent(session)}`, signal);
}
function fetchRecord(session, index) {
  return getJSON(`${TRACE_ROUTE}/${encodeURIComponent(session)}?index=${index}`);
}
async function downloadExport(sessions) {
  const query = sessions.length > 0 ? `?sessions=${sessions.map(encodeURIComponent).join(",")}` : "";
  const response = await fetch(`${TRACE_EXPORT_ROUTE}${query}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`\u5BFC\u51FA\u5931\u8D25\uFF1AHTTP ${response.status}`);
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "rwkv-traces.jsonl";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e4);
}
var OUTCOME_LABEL = {
  "run": "\u6267\u884C\u8C03\u7528",
  "final": "\u4F5C\u7B54",
  "re-ask": "\u683C\u5F0F\u91CD\u95EE",
  "duplicate-retry": "\u91CD\u590D\u8C03\u7528\uFF0C\u518D\u7ED9\u4E00\u6B21",
  "closeout": "\u5F3A\u5236\u6536\u5C3E",
  "rejected unknown-tool": "\u672A\u77E5\u5DE5\u5177",
  "rejected blocked": "\u8FDE\u7EED\u5931\u8D25\u5C01\u7981",
  "empty-exit": "no_tool \u6CA1\u5199\u56DE\u7B54",
  "raw": "\u539F\u6837\u8F93\u51FA\uFF08\u672A\u4FEE\uFF09"
};
var REPAIR_LABEL = {
  json_repaired: "\u53BB\u6389\u591A\u4F59\u7684 }",
  array_unwrapped: "\u62C6\u5F00\u5355\u5143\u7D20\u6570\u7EC4",
  function_wrapper: "\u62C6 OpenAI \u5916\u58F3",
  name_alias: "name \u5B57\u6BB5\u5199\u9519",
  arguments_alias: "arguments \u5B57\u6BB5\u5199\u9519",
  arguments_lifted: "\u53C2\u6570\u5199\u5728\u9876\u5C42",
  path_argument: "\u53EA\u5199\u4E86\u8DEF\u5F84",
  stringified_arguments: "arguments \u662F\u5B57\u7B26\u4E32",
  tool_renamed: "\u5DE5\u5177\u540D\u6539\u5199",
  preamble_stripped: "\u53BB\u6389\u8C03\u7528\u524D\u7684\u8BDD",
  envelope_recovered: "\u5916\u9762\u591A\u5957\u4E00\u5C42",
  legacy_xml_call: "\u81EA\u95ED\u5408\u6807\u7B7E\u8C03\u7528",
  tool_name_alias: "\u5DE5\u5177\u540D\u522B\u540D",
  argument_alias: "\u53C2\u6570\u540D\u522B\u540D",
  scalar_coerced: "\u6570\u503C/\u5E03\u5C14\u8F6C\u6362",
  unknown_arguments_dropped: "\u5220\u6389\u591A\u4F59\u53C2\u6570",
  pattern_array: "pattern \u662F\u6570\u7EC4",
  glob_default_pattern: "glob \u8865 pattern",
  offset_below_one: "offset \u6539\u6210 1",
  limit_below_one: "\u53BB\u6389 limit",
  path_repaired: "\u8DEF\u5F84\u4FEE\u590D",
  bash_description_filled: "bash \u8865 description",
  answer_stage_tool: "\u6536\u5C3E\u9636\u6BB5\u7684\u8C03\u7528"
};
var isGeneration = (record) => record.stage === "decision" || record.stage === "answer";
function touched(record) {
  if (!isGeneration(record) || record.outcome === void 0) return false;
  return !((record.outcome === "run" || record.outcome === "final") && (record.repairs ?? []).length === 0);
}
var percent = (part, whole) => whole === 0 ? "\u2013" : `${(100 * part / whole).toFixed(1)}%`;

// src/client/TraceFrames.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var OUTCOME_TAG = {
  "run": "\u8C03\u7528",
  "final": "\u4F5C\u7B54",
  "re-ask": "\u91CD\u95EE",
  "duplicate-retry": "\u91CD\u590D",
  "closeout": "\u6536\u5C3E",
  "rejected unknown-tool": "\u62D2\u7EDD",
  "rejected blocked": "\u62D2\u7EDD",
  "empty-exit": "\u7A7A\u7B54",
  "raw": "\u539F\u6837"
};
function toneOf(record) {
  if (record.outcome === void 0) return "neutral";
  if (record.outcome === "raw" || record.outcome.startsWith("rejected")) return "error";
  return touched(record) ? "touched" : "clean";
}
function afterThink(output) {
  const text = output.trimStart();
  if (!text.startsWith("<think")) return text;
  const end = text.indexOf("</think>");
  return end < 0 ? "" : text.slice(end + "</think>".length).trim();
}
function thinkOf(output) {
  const text = output.trimStart();
  if (!text.startsWith("<think")) return "";
  const end = text.indexOf("</think>");
  return text.slice(text.indexOf(">") + 1, end < 0 ? void 0 : end).trim();
}
function Preview(props) {
  const output = props.record.output ?? "";
  const action = afterThink(output);
  const call = /<tool_calls?>\s*([\s\S]*)/.exec(action);
  if (call !== null) {
    let name = "";
    let payload = call[1].replace(/<\/tool_calls?>\s*$/, "").trim();
    try {
      const parsed = JSON.parse(payload);
      const inner = parsed.function ?? parsed;
      if (typeof inner.name === "string") {
        name = inner.name;
        payload = JSON.stringify(inner.arguments ?? {});
      }
    } catch {
    }
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rl-text", children: [
      name ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-call-name", children: name }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-call-payload", children: payload })
    ] });
  }
  const text = action || thinkOf(output);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `rl-text${action ? "" : " rl-dim"}`, children: text.replace(/\s+/g, " ") || "\uFF08\u7A7A\u8F93\u51FA\uFF09" });
}
function time(at) {
  if (at === void 0) return "";
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}
function KeyValue(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-kv-key", children: props.label }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-kv-value", children: props.children })
  ] });
}
function Inspector(props) {
  const { row, step } = props;
  const { record } = row;
  const [tab, setTab] = (0, import_react2.useState)("overview");
  const [prompt, setPrompt] = (0, import_react2.useState)();
  const [error, setError] = (0, import_react2.useState)("");
  (0, import_react2.useEffect)(() => {
    setPrompt(void 0);
    setError("");
  }, [row.index]);
  (0, import_react2.useEffect)(() => {
    if (tab !== "prompt" || prompt !== void 0) return;
    let stopped = false;
    fetchRecord(props.session, row.index).then((body) => {
      if (!stopped) setPrompt(body.record.prompt ?? "");
    }).catch((cause) => {
      if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      stopped = true;
    };
  }, [tab, prompt, props.session, row.index]);
  const tone = toneOf(record);
  const repairs = record.repairs ?? [];
  const think = thinkOf(record.output ?? "");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("aside", { className: "rl-inspector", "aria-label": "\u751F\u6210\u8BE6\u60C5", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rl-inspector-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `rl-tag rl-tone-${tone}`, children: OUTCOME_TAG[record.outcome ?? ""] ?? "\u751F\u6210" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rl-inspector-title", children: [
        "\u8BF7\u6C42 ",
        row.request,
        " \xB7 \u7B2C ",
        row.generation,
        " \u6B21\u751F\u6210",
        record.stage === "answer" ? " \xB7 \u6536\u5C3E\u9636\u6BB5" : ""
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rl-icon", "aria-label": "\u5173\u95ED", onClick: props.onClose, children: "\xD7" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rl-tabs", role: "tablist", children: [["overview", "\u6982\u8FF0"], ["output", "\u539F\u59CB\u8F93\u51FA"], ["prompt", "\u63D0\u793A\u8BCD"]].map(([id, label]) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", role: "tab", "aria-selected": tab === id, onClick: () => setTab(id), children: label }, id)) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rl-inspector-body", children: tab === "overview" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rl-kv", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(KeyValue, { label: "\u63D2\u4EF6\u5904\u7406", children: record.outcome === void 0 ? `${record.action ?? "\u2014"}\uFF08\u65E7\u8BB0\u5F55\uFF0C\u6CA1\u6709\u5224\u5B9A\uFF09` : OUTCOME_LABEL[record.outcome] ?? record.outcome }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(KeyValue, { label: "\u7528\u5230\u7684\u4FEE\u590D", children: repairs.length === 0 ? "\u65E0" : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-chips", children: repairs.map((repair) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-chip", title: repair, children: REPAIR_LABEL[repair] ?? repair }, repair)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(KeyValue, { label: "\u89E3\u6790\u4E3A", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: record.action ?? "\u2014" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(KeyValue, { label: "\u505C\u6B62\u539F\u56E0", children: [
          record.finish === "length" ? "\u5199\u6EE1 token \u4E0A\u9650" : record.finish ?? "\u2014",
          record.stop ? `\uFF08${record.stop}\uFF09` : ""
        ] }),
        step ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(KeyValue, { label: "\u4EA4\u7ED9 DSH", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: step.decision }),
          step.attempts && step.attempts > 1 ? ` \xB7 \u8FD9\u6B21\u8BF7\u6C42\u751F\u6210\u4E86 ${step.attempts} \u6B21` : ""
        ] }) : null,
        step && (step.outputRepairs === false || step.guards === false) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(KeyValue, { label: "\u5F00\u5173", children: [
          step.outputRepairs === false ? "\u4FEE\u6B63\u6A21\u578B\u8F93\u51FA\uFF1A\u5173 " : "",
          step.guards === false ? "\u63D2\u4EF6\u5E72\u9884\uFF1A\u5173" : ""
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(KeyValue, { label: "\u6A21\u578B", children: record.model ?? "\u2014" }),
        record.purpose ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(KeyValue, { label: "\u7528\u9014", children: record.purpose }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(KeyValue, { label: "\u65F6\u95F4", children: time(record.at) })
      ] }),
      think ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rl-section-title", children: "\u601D\u8003" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rl-prose", children: think })
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rl-section-title", children: "\u52A8\u4F5C" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "rl-pre", children: afterThink(record.output ?? "") || "\uFF08\u65E0\uFF09" })
    ] }) : tab === "output" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "rl-pre rl-pre-full", children: record.output ?? "" }) : error ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-error", children: error }) : prompt === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-hint", children: "\u52A0\u8F7D\u4E2D\u2026" }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "rl-pre rl-pre-full", children: prompt }) })
  ] });
}
function TraceFrames(props) {
  const [selected, setSelected] = (0, import_react2.useState)();
  const rows = [];
  const steps = /* @__PURE__ */ new Map();
  let request = 1;
  let generation = 0;
  props.records.forEach((record, index) => {
    if (!props.showSide && record.purpose !== void 0) return;
    if (record.stage === "step") {
      steps.set(request, record);
      rows.push({ index, record, request, generation, first: false });
      request++;
      generation = 0;
      return;
    }
    if (!isGeneration(record)) return;
    generation++;
    rows.push({ index, record, request, generation, first: generation === 1 });
  });
  const visible = props.onlyTouched ? rows.filter((row) => row.record.stage !== "step" && touched(row.record)) : rows;
  const current = rows.find((row) => row.index === selected);
  if (visible.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rl-empty", children: props.onlyTouched ? "\u8FD9\u4E2A\u4F1A\u8BDD\u91CC\u6CA1\u6709\u7528\u5230\u515C\u5E95\u7684\u751F\u6210\u3002" : "\u8FD9\u4E2A\u4F1A\u8BDD\u8FD8\u6CA1\u6709 RWKV \u8BB0\u5F55\u3002" });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rl-ledger", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rl-scroll", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "rl-table", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("colgroup", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("col", { className: "rl-event-col" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("col", {})
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: visible.map((row) => {
        if (row.record.stage === "step") {
          const repairs2 = row.record.repairs ?? [];
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { className: "rl-step-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "rl-event", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-rail" }) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "rl-content", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rl-step", children: [
              "\u2192 \u4EA4\u7ED9 DSH ",
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: row.record.decision }),
              row.record.attempts && row.record.attempts > 1 ? ` \xB7 \u751F\u6210 ${row.record.attempts} \u6B21` : "",
              repairs2.length > 0 ? ` \xB7 \u4FEE\u590D ${repairs2.map((repair) => REPAIR_LABEL[repair] ?? repair).join("\u3001")}` : ""
            ] }) })
          ] }, row.index);
        }
        const tone = toneOf(row.record);
        const repairs = row.record.repairs ?? [];
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          "tr",
          {
            tabIndex: 0,
            "data-selected": row.index === selected,
            "data-turn-start": row.first && !props.onlyTouched,
            onClick: () => setSelected((current2) => current2 === row.index ? void 0 : row.index),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelected(row.index);
              }
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { className: "rl-event", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `rl-rail rl-rail-${tone}` }),
                row.first || props.onlyTouched ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rl-turn-label", children: [
                  "\u8BF7\u6C42 ",
                  row.request
                ] }) : null,
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `rl-tag rl-tone-${tone}`, title: row.record.outcome === void 0 ? "\u65E7\u8BB0\u5F55" : OUTCOME_LABEL[row.record.outcome] ?? row.record.outcome, children: row.record.outcome === void 0 ? "\u751F\u6210" : OUTCOME_TAG[row.record.outcome] ?? row.record.outcome })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "rl-content", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rl-content-inner", children: [
                row.record.stage === "answer" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-chip rl-chip-muted", children: "\u6536\u5C3E\u9636\u6BB5" }) : null,
                row.record.finish === "length" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-chip rl-chip-warn", children: "\u5199\u6EE1\u4E0A\u9650" }) : null,
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Preview, { record: row.record }),
                repairs.map((repair) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rl-chip rl-chip-warn", title: repair, children: REPAIR_LABEL[repair] ?? repair }, repair))
              ] }) })
            ]
          },
          row.index
        );
      }) })
    ] }) }),
    current ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Inspector, { session: props.session, row: current, step: steps.get(current.request), onClose: () => setSelected(void 0) }) : null
  ] });
}

// src/client/DeveloperPanel.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var DEVELOPER_DEFAULTS = {
  recordTraces: false,
  traceDir: "",
  outputRepairs: true,
  guards: true
};
function Toggle(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "rwkv-check rwkv-toggle", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: props.checked, disabled: props.disabled, onChange: (event) => props.onChange(event.target.checked) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
      props.label,
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-hint rwkv-toggle-hint", children: props.hint })
    ] })
  ] });
}
function Counts(props) {
  const entries = Object.entries(props.counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-counts", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-block-title", children: props.title }),
    entries.map(([key, count]) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-count", title: key, children: [
      props.labels[key] ?? key,
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("b", { children: count }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-hint", children: percent(count, props.total) })
    ] }, key))
  ] });
}
function StatsCard(props) {
  const counted = props.stats.filter((stats) => stats.generations > 0 || stats.steps > 0);
  if (counted.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-hint", children: "\u8FD8\u6CA1\u6709\u5E26\u5224\u5B9A\u7684\u8BB0\u5F55\uFF08\u65E7\u7248\u63D2\u4EF6\u5199\u7684\u8F68\u8FF9\u6CA1\u6709\u5224\u5B9A\u5B57\u6BB5\uFF09\u3002\u6253\u5F00\u8BB0\u5F55\u540E\u8DD1\u51E0\u8F6E\u4EFB\u52A1\uFF0C\u8FD9\u91CC\u4F1A\u51FA\u73B0\u7EDF\u8BA1\u3002" });
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_jsx_runtime3.Fragment, { children: counted.map((stats) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-stats", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-stats-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-name", children: stats.model }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-stat", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("b", { children: percent(stats.clean, stats.generations) }),
        " \u751F\u6210\u539F\u6837\u53EF\u7528\uFF08",
        stats.clean,
        "/",
        stats.generations,
        "\uFF09"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-stat", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("b", { children: percent(stats.cleanSteps, stats.steps) }),
        " \u8BF7\u6C42\u4E00\u6B21\u5B9A\u4E0B\u4E14\u65E0\u4FEE\u590D\uFF08",
        stats.cleanSteps,
        "/",
        stats.steps,
        "\uFF09"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Counts, { title: "\u63D2\u4EF6\u600E\u4E48\u5904\u7406\u7684", counts: stats.outcomes, total: stats.generations, labels: OUTCOME_LABEL }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Counts, { title: "\u7528\u5230\u7684\u4FEE\u590D\uFF08\u6309\u751F\u6210\u8BA1\uFF09", counts: stats.repairs, total: stats.generations, labels: REPAIR_LABEL })
  ] }, stats.model)) });
}
function SessionRow(props) {
  const { item } = props;
  const [open, setOpen] = (0, import_react3.useState)(false);
  const [records, setRecords] = (0, import_react3.useState)();
  const [onlyTouched, setOnlyTouched] = (0, import_react3.useState)(true);
  const [error, setError] = (0, import_react3.useState)("");
  (0, import_react3.useEffect)(() => {
    if (!open || records !== void 0) return;
    const abort = new AbortController();
    fetchSession(item.session, abort.signal).then((body) => setRecords(body.records)).catch((cause) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => abort.abort();
  }, [open, records, item.session]);
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("li", { className: "rwkv-session", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-session-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: props.selected, onChange: (event) => props.onSelect(event.target.checked), "aria-label": "\u9009\u4E2D\u8FD9\u4E2A\u4F1A\u8BDD" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("button", { type: "button", className: "rwkv-session-title", onClick: () => setOpen((value) => !value), "aria-expanded": open, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-session-task", children: item.task || item.session }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-session-meta", children: [
          new Date(item.modified).toLocaleString(),
          " \xB7 ",
          item.models.join(", "),
          " \xB7 ",
          item.steps,
          " \u6B21\u8BF7\u6C42 \xB7 ",
          item.generations,
          " \u6B21\u751F\u6210",
          item.touchedGenerations > 0 ? ` \xB7 ${item.touchedGenerations} \u6B21\u7528\u5230\u515C\u5E95` : "",
          item.persisted ? "" : " \xB7 \u4EC5\u5728\u5185\u5B58"
        ] })
      ] })
    ] }),
    open ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-session-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "rwkv-check", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: onlyTouched, onChange: (event) => setOnlyTouched(event.target.checked) }),
        "\u53EA\u770B\u7528\u5230\u515C\u5E95\u7684\u751F\u6210"
      ] }),
      error ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-error", children: error }) : records === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-hint", children: "\u52A0\u8F7D\u4E2D\u2026" }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(TraceFrames, { session: item.session, records, onlyTouched, showSide: false })
    ] }) : null
  ] });
}
function Traces(props) {
  const [data, setData] = (0, import_react3.useState)();
  const [error, setError] = (0, import_react3.useState)("");
  const [selected, setSelected] = (0, import_react3.useState)(/* @__PURE__ */ new Set());
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [reload, setReload] = (0, import_react3.useState)(0);
  (0, import_react3.useEffect)(() => {
    const abort = new AbortController();
    setError("");
    fetchSessions(abort.signal).then((body) => setData(body)).catch((cause) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => abort.abort();
  }, [reload, props.recording]);
  const exportSessions = async (sessions) => {
    setBusy(true);
    setError("");
    try {
      await downloadExport(sessions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  };
  const select = (session, value) => setSelected((current) => {
    const next = new Set(current);
    if (value) next.add(session);
    else next.delete(session);
    return next;
  });
  if (error && data === void 0) return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-error", children: error });
  if (data === void 0) return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-hint", children: "\u52A0\u8F7D\u4E2D\u2026" });
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-block-title", children: "\u515C\u5E95\u7EDF\u8BA1\uFF08\u5185\u5B58\u548C\u78C1\u76D8\u91CC\u7684\u5168\u90E8\u4F1A\u8BDD\uFF0C\u4E0D\u542B\u4F1A\u8BDD\u6807\u9898\u8FD9\u7C7B\u9644\u5E26\u8BF7\u6C42\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "rwkv-link", onClick: () => setReload((value) => value + 1), children: "\u5237\u65B0" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(StatsCard, { stats: data.stats })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-block-title", children: [
          "\u5DF2\u8BB0\u5F55\u7684\u4F1A\u8BDD \xB7 ",
          data.sessions.length,
          " \u4E2A \xB7 ",
          data.dir
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: busy || selected.size === 0, onClick: () => {
            void exportSessions([...selected]);
          }, children: [
            "\u5BFC\u51FA\u6240\u9009\uFF08",
            selected.size,
            "\uFF09"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: busy || data.sessions.length === 0, onClick: () => {
            void exportSessions([]);
          }, children: "\u5BFC\u51FA\u5168\u90E8" })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-hint", children: "\u5BFC\u51FA\u4E3A JSONL\uFF0C\u6BCF\u884C\u4E00\u4E2A\u4EFB\u52A1\uFF1A\u5168\u90E8\u539F\u59CB\u8BB0\u5F55\uFF08\u6BCF\u6B21\u751F\u6210\u7684\u63D0\u793A\u8BCD\u3001\u539F\u59CB\u8F93\u51FA\u3001\u63D2\u4EF6\u7684\u5904\u7406\u548C\u4FEE\u590D\uFF0C\u5305\u62EC\u91CD\u95EE\u548C\u88AB\u62E6\u7684\u751F\u6210\uFF09\uFF0C \u6700\u540E\u4E00\u6B21\u751F\u6210\u7684\u5B8C\u6574 RWKV \u6587\u672C\uFF08text\uFF09\uFF0C\u4EE5\u53CA\u628A\u5386\u53F2\u6B65\u9AA4\u7684\u771F\u5B9E\u601D\u8003\u586B\u56DE\u53BB\u7684\u7248\u672C\uFF08textWithThinks\uFF0C\u8BB0\u5F55\u5B8C\u6574\u65F6\u624D\u6709\uFF09\u3002" }),
      error ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-error", children: error }) : null,
      data.sessions.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-hint", children: "\u8FD8\u6CA1\u6709\u8F68\u8FF9\u3002\u7528 RWKV \u6A21\u578B\u8DD1\u4E00\u8F6E\u4EFB\u52A1\u540E\u8FD9\u91CC\u4F1A\u51FA\u73B0\u3002" }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("ul", { className: "rwkv-sessions", children: data.sessions.map((item) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(SessionRow, { item, selected: selected.has(item.session), onSelect: (value) => select(item.session, value) }, item.session)) })
    ] })
  ] });
}
function DirInput(props) {
  const [text, setText] = (0, import_react3.useState)(props.value);
  (0, import_react3.useEffect)(() => setText(props.value), [props.value]);
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-dir", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      "input",
      {
        className: "rwkv-input",
        value: text,
        disabled: props.disabled,
        spellCheck: false,
        autoComplete: "off",
        placeholder: "\u7559\u7A7A = $DSH_HOME/rwkv-traces\uFF08\u9ED8\u8BA4 ~/.dsh/rwkv-traces\uFF09",
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") props.onSave(text.trim());
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: props.disabled || text.trim() === props.value, onClick: () => props.onSave(text.trim()), children: "\u4FDD\u5B58" })
  ] });
}
function DeveloperCard(props) {
  const { settings, disabled, write } = props;
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const set = async (field, value) => {
    setBusy(true);
    await write(field, value);
    setBusy(false);
  };
  const off = disabled || busy;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("details", { className: "rwkv-card rwkv-developer", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("summary", { className: "rwkv-head rwkv-developer-summary", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-identity", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-name", children: "\u5F00\u53D1\u8005" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rwkv-meta", children: [
        settings.recordTraces ? "\u8F68\u8FF9\u4FDD\u5B58\u5230\u78C1\u76D8" : "\u8F68\u8FF9\u53EA\u5728\u5185\u5B58",
        settings.outputRepairs ? "" : " \xB7 \u4FEE\u6B63\u5DF2\u5173",
        settings.guards ? "" : " \xB7 \u5E72\u9884\u5DF2\u5173"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rwkv-developer-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        Toggle,
        {
          label: "\u628A\u8F68\u8FF9\u4FDD\u5B58\u5230\u78C1\u76D8",
          checked: settings.recordTraces,
          disabled: off,
          onChange: (value) => {
            void set("recordTraces", value);
          },
          hint: "\u8F68\u8FF9\uFF08\u53D1\u7ED9 RWKV \u7684\u63D0\u793A\u8BCD\u539F\u6587\u3001\u539F\u59CB\u8F93\u51FA\u3001\u63D2\u4EF6\u600E\u4E48\u5904\u7406\u7684\u3001\u7528\u4E86\u54EA\u4E9B\u4FEE\u590D\uFF09\u4E00\u76F4\u8BB0\u5728\u5185\u5B58\u91CC\uFF0C\u5BF9\u8BDD\u89C6\u56FE\u7684 RWKV \u6807\u7B7E\u9875\u548C\u4E0B\u9762\u7684\u7EDF\u8BA1\u3001\u5BFC\u51FA\u90FD\u80FD\u7528\uFF0CDSH \u91CD\u542F\u540E\u6E05\u7A7A\u3002\u52FE\u9009\u540E\u540C\u65F6\u5199\u8FDB\u8F68\u8FF9\u76EE\u5F55\uFF0C\u6BCF\u4E2A\u4F1A\u8BDD\u4E00\u4E2A\u6587\u4EF6\u3002"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "rwkv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "rwkv-label", children: "\u8F68\u8FF9\u76EE\u5F55" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(DirInput, { value: settings.traceDir, disabled: off, onSave: (value) => {
          void set("traceDir", value);
        } })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        Toggle,
        {
          label: "\u4FEE\u6B63\u6A21\u578B\u8F93\u51FA",
          checked: settings.outputRepairs,
          disabled: off,
          onChange: (value) => {
            void set("outputRepairs", value);
          },
          hint: "\u683C\u5F0F\u4FEE\u590D\u3001\u5DE5\u5177\u540D\u548C\u53C2\u6570\u540D\u7EA0\u6B63\u3001\u6570\u503C\u8F6C\u6362\u3001DSH \u53C2\u6570\u503C\u4FEE\u590D\u3001\u8DEF\u5F84\u4FEE\u590D\u3002\u5173\u6389\u540E\u53EA\u8BA4\u6807\u51C6\u5199\u6CD5\uFF0C\u53C2\u6570\u539F\u6837\u4EA4\u7ED9 DSH\uFF0C\u7531 DSH \u62A5\u9519\u3002"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        Toggle,
        {
          label: "\u63D2\u4EF6\u5E72\u9884",
          checked: settings.guards,
          disabled: off,
          onChange: (value) => {
            void set("guards", value);
          },
          hint: "\u683C\u5F0F\u91CD\u95EE\u3001\u91CD\u590D\u8C03\u7528\u62E6\u622A\u3001\u8FDE\u7EED\u5931\u8D25\u5C01\u7981\u3001\u601D\u8003\u5199\u6EE1\u65F6\u66FF\u5B83\u6536\u4F4F\u3001\u6536\u5C3E\u9636\u6BB5\u7684\u91CD\u95EE\u548C\u515C\u5E95\u603B\u7ED3\u3002\u5173\u6389\u540E\u6A21\u578B\u8F93\u51FA\u4EC0\u4E48\u5C31\u662F\u4EC0\u4E48\uFF0C\u89E3\u6790\u4E0D\u4E86\u7684\u539F\u6837\u4F5C\u4E3A\u56DE\u7B54\u3002"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rwkv-hint", children: "\u6D4B\u6A21\u578B\u672C\u8EAB\u65F6\u4E24\u4E2A\u90FD\u5173\uFF1B\u590D\u8BFB\u622A\u65AD\u7531\u8FD0\u884C\u53C2\u6570\u91CC\u7684 loop-guard \u5355\u72EC\u63A7\u5236\u3002\u4FEE\u590D\u540E\u7684\u8C03\u7528\u4F1A\u8FDB\u5165 DSH \u7684\u8BB0\u5F55\uFF0C\u6A21\u578B\u4E0B\u4E00\u6B65\u770B\u5230\u7684\u662F\u4FEE\u597D\u7684\u7248\u672C\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Traces, { recording: settings.recordTraces })
    ] })
  ] });
}

// src/client/RwkvSettings.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
var AGENT_FAST = { temperature: 0.3, topK: 65536, topP: 0.5, presencePenalty: 0.5, frequencyPenalty: 0.1, penaltyDecay: 0.996 };
var RUN_DEFAULTS = {
  thinking: "full",
  historyEmptyThink: true,
  maxSteps: 12,
  maxConsecutiveFailures: 2,
  protocolRetries: 2,
  decisionMaxTokens: 4096,
  answerMaxTokens: 4096,
  maxResultChars: 12e3,
  sampling: AGENT_FAST,
  taskContract: "",
  toolMode: "mapped",
  excludeTools: [],
  includeDeveloper: false,
  loopGuard: true
};
var RUN_FIELDS = Object.keys(RUN_DEFAULTS);
function normalize(value) {
  const config = { ...RUN_DEFAULTS, ...DEVELOPER_DEFAULTS, models: [], ...typeof value === "object" && value !== null ? value : {} };
  return { ...config, sampling: { ...AGENT_FAST, ...config.sampling }, models: (config.models ?? []).map((model) => ({ ...model })) };
}
function cleanModel(model) {
  const result = {};
  for (const [key, value] of Object.entries(model)) {
    if (value === "" || value === void 0) continue;
    if (key === "adapter") {
      const adapter = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== void 0));
      if (typeof adapter.id === "string" && adapter.id !== "") result.adapter = adapter;
      continue;
    }
    if (key === "headers" && Object.keys(value).length === 0) continue;
    result[key] = value;
  }
  return result;
}
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function isHttpUrl2(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
function Field(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("label", { className: props.wide ? "rwkv-field rwkv-wide" : "rwkv-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-label", children: props.label }),
    props.children,
    props.hint ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "rwkv-hint", children: props.hint }) : null
  ] });
}
function TextInput(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "input",
    {
      className: "rwkv-input",
      type: props.type ?? "text",
      value: props.value ?? "",
      placeholder: props.placeholder,
      disabled: props.disabled,
      spellCheck: false,
      autoComplete: "off",
      onChange: (event) => props.onChange(event.target.value)
    }
  );
}
function NumberInput(props) {
  const [text, setText] = (0, import_react4.useState)(props.value === void 0 ? "" : String(props.value));
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "input",
    {
      className: "rwkv-input",
      inputMode: "decimal",
      value: text,
      placeholder: props.placeholder,
      disabled: props.disabled,
      onChange: (event) => {
        const next = event.target.value;
        setText(next);
        const parsed = Number(next);
        if (next.trim() === "") props.onChange(void 0);
        else if (Number.isFinite(parsed)) props.onChange(parsed);
      }
    }
  );
}
function SelectInput(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("select", { className: "rwkv-input rwkv-select", value: props.value, disabled: props.disabled, onChange: (event) => props.onChange(event.target.value), children: props.options.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("option", { value, children: label }, value)) });
}
function Segment(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "rwkv-segment", role: "group", children: props.options.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", "aria-pressed": props.value === value, disabled: props.disabled, onClick: () => props.onChange(value), children: label }, value)) });
}
function Check(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("label", { className: "rwkv-check", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("input", { type: "checkbox", checked: props.checked, disabled: props.disabled, onChange: (event) => props.onChange(event.target.checked) }),
    props.label
  ] });
}
function HeadersInput(props) {
  const [text, setText] = (0, import_react4.useState)(() => props.value && Object.keys(props.value).length > 0 ? JSON.stringify(props.value, null, 2) : "");
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "textarea",
    {
      className: "rwkv-input",
      value: text,
      disabled: props.disabled,
      spellCheck: false,
      placeholder: '{"CF-Access-Client-Id": "\u2026", "CF-Access-Client-Secret": "\u2026"}',
      onChange: (event) => {
        setText(event.target.value);
        if (event.target.value.trim() === "") return props.onChange(void 0);
        try {
          const parsed = JSON.parse(event.target.value);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("\u9700\u8981\u4E00\u4E2A JSON \u5BF9\u8C61");
          props.onChange(Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])));
        } catch (cause) {
          props.onChange(void 0, `\u8BF7\u6C42\u5934\u4E0D\u662F\u6709\u6548\u7684 JSON\uFF1A${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
  );
}
function EditorActions(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-editor-actions", children: [
    props.error ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "rwkv-error", children: props.error }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary", disabled: props.busy, onClick: props.onCancel, children: "\u53D6\u6D88" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "rwkv-btn rwkv-primary", disabled: props.busy || !props.canSave, onClick: props.onSave, children: props.busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" })
  ] });
}
var BACKEND_LABEL = { lightning: "rwkv_lightning", irwkv: "iRWKV" };
function modelFailure(model, others) {
  if (!model.id.trim()) return "\u8BF7\u586B\u5199\u6A21\u578B ID";
  if (!/^[A-Za-z0-9][\w.-]*$/.test(model.id.trim())) return "\u6A21\u578B ID \u53EA\u80FD\u5305\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u548C\u8FDE\u5B57\u7B26";
  if (others.some((other) => other.id === model.id.trim())) return `\u5DF2\u6709\u4E00\u4E2A\u6A21\u578B\u53EB ${model.id}`;
  if (!isHttpUrl2(model.baseURL.trim())) return "\u670D\u52A1\u5730\u5740\u9700\u8981\u662F http(s) \u5730\u5740";
  if (!model.model.trim()) return "\u8BF7\u586B\u5199\u4E0A\u6E38\u6A21\u578B ID";
  return void 0;
}
function ModelEditor(props) {
  const [draft, setDraft] = (0, import_react4.useState)(props.initial);
  const [idLinked, setIdLinked] = (0, import_react4.useState)(props.initial.id === "" || props.initial.id === props.initial.model);
  const [nameLinked, setNameLinked] = (0, import_react4.useState)(!props.initial.name || props.initial.name === props.initial.model);
  const [touched2, setTouched] = (0, import_react4.useState)(false);
  const [headersError, setHeadersError] = (0, import_react4.useState)();
  const [busy, setBusy] = (0, import_react4.useState)(false);
  const [failure, setFailure] = (0, import_react4.useState)();
  const set = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setTouched(true);
    setFailure(void 0);
  };
  const setUpstream = (value) => {
    setDraft((current) => ({
      ...current,
      model: value,
      ...idLinked ? { id: value.trim() } : {},
      ...nameLinked ? { name: value.trim() } : {}
    }));
    setTouched(true);
    setFailure(void 0);
  };
  const lightning = draft.backend === "lightning";
  const disabled = props.disabled || busy;
  const invalid = modelFailure(draft, props.others) ?? headersError;
  const save = async () => {
    setBusy(true);
    const ok = await props.onSave(cleanModel({ ...draft, id: draft.id.trim(), baseURL: draft.baseURL.trim(), model: draft.model.trim() }));
    setBusy(false);
    if (!ok) setFailure("Host \u6CA1\u6709\u63A5\u53D7\u8FD9\u4EFD\u914D\u7F6E\uFF08\u6821\u9A8C\u5931\u8D25\uFF0C\u6216\u914D\u7F6E\u5DF2\u5728\u522B\u5904\u4FEE\u6539\uFF09\uFF0C\u8349\u7A3F\u5DF2\u4FDD\u7559");
  };
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-editor", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-editor-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-editor-title", children: draft.name || draft.id || "\u65B0\u6A21\u578B" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "rwkv-editor-sub", children: [
        "rwkv/",
        draft.id || "\u2026"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u540E\u7AEF", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      Segment,
      {
        value: draft.backend,
        disabled,
        options: [["lightning", "rwkv_lightning CUDA"], ["irwkv", "iRWKV\uFF08vLLM\uFF09"]],
        onChange: (value) => set("backend", value)
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-grid", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u4E0A\u6E38\u6A21\u578B ID", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(TextInput, { value: draft.model, disabled, placeholder: "rwkv7-g1l-7.2b", onChange: setUpstream }) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u670D\u52A1\u5730\u5740", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(TextInput, { value: draft.baseURL, disabled, placeholder: "http://host:8000", onChange: (value) => set("baseURL", value) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u6A21\u578B ID", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(TextInput, { value: draft.id, disabled, placeholder: "\u9ED8\u8BA4\u540C\u4E0A\u6E38\u6A21\u578B ID", onChange: (value) => {
        setIdLinked(value.trim() === "");
        set("id", value);
      } }) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u663E\u793A\u540D", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(TextInput, { value: draft.name, disabled, placeholder: "\u9ED8\u8BA4\u540C\u4E0A\u6E38\u6A21\u578B ID", onChange: (value) => {
        setNameLinked(value.trim() === "");
        set("name", value);
      } }) })
    ] }),
    lightning ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      AdapterPicker,
      {
        connection: { baseURL: draft.baseURL, apiKey: draft.apiKey, headers: draft.headers },
        value: draft.adapter?.id,
        disabled,
        onChange: (id) => set("adapter", id ? { id } : void 0)
      }
    ) : null,
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("details", { className: "rwkv-details", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("summary", { className: "rwkv-summary", children: "\u81EA\u5B9A\u4E49\u8BBE\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "rwkv-details-body", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: lightning ? "\u5BC6\u7801" : "API \u5BC6\u94A5", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(TextInput, { type: "password", value: draft.apiKey, disabled, placeholder: "\u7559\u7A7A\u8868\u793A\u4E0D\u9700\u8981", onChange: (value) => set("apiKey", value) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u4E0A\u4E0B\u6587\u7A97\u53E3", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(NumberInput, { value: draft.contextWindow, disabled, placeholder: "32768", onChange: (value) => set("contextWindow", value) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u601D\u8003\u683C\u5F0F", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          SelectInput,
          {
            value: draft.thinking ?? "",
            disabled,
            options: [["", "\u8DDF\u968F\u8FD0\u884C\u53C2\u6570"], ["full", "\u5F00\u601D\u8003"], ["off", "\u4E0D\u601D\u8003"]],
            onChange: (value) => set("thinking", value || void 0)
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u5386\u53F2\u7A7A\u601D\u8003\u5757", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          SelectInput,
          {
            value: draft.historyEmptyThink === void 0 ? "" : draft.historyEmptyThink ? "on" : "off",
            disabled,
            options: [["", "\u8DDF\u968F\u8FD0\u884C\u53C2\u6570"], ["on", "\u5F00"], ["off", "\u5173"]],
            onChange: (value) => set("historyEmptyThink", value === "" ? void 0 : value === "on")
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u989D\u5916\u8BF7\u6C42\u5934\uFF08JSON\uFF09", wide: true, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(HeadersInput, { value: draft.headers, disabled, onChange: (value, error) => {
          setHeadersError(error);
          if (!error) set("headers", value);
        } }) })
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      EditorActions,
      {
        error: failure ?? (touched2 ? invalid : void 0),
        busy,
        canSave: !disabled && invalid === void 0,
        onCancel: props.onCancel,
        onSave: () => {
          void save();
        }
      }
    )
  ] });
}
function ModelCard(props) {
  const { model } = props;
  const [confirming, setConfirming] = (0, import_react4.useState)(false);
  const adapterId = model.backend === "lightning" ? model.adapter?.id : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("li", { className: "rwkv-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "rwkv-identity", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-name", children: model.name || model.id }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-tag", children: BACKEND_LABEL[model.backend] }),
        adapterId ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-dot", title: `adapter ${adapterId}` }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "rwkv-meta", children: [
        model.model,
        adapterId ? ` \xB7 ${adapterId}` : ""
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-actions", children: props.editing ? null : confirming ? /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "rwkv-link", onClick: () => setConfirming(false), children: "\u53D6\u6D88" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small rwkv-danger", disabled: props.disabled, onClick: () => {
          void props.onRemove();
        }, children: "\u786E\u8BA4\u5220\u9664" })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "rwkv-link", disabled: props.disabled, onClick: () => setConfirming(true), children: "\u5220\u9664" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: props.disabled, onClick: props.onEdit, children: "\u7F16\u8F91" })
      ] }) })
    ] }),
    props.editing ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(ModelEditor, { initial: model, others: props.others, disabled: props.disabled, onCancel: props.onClose, onSave: props.onSave }) : null
  ] });
}
function runSummary(run) {
  const sampling = same(run.sampling, AGENT_FAST) ? "agent-fast" : `T ${run.sampling.temperature} \xB7 top_p ${run.sampling.topP}`;
  const tools = run.toolMode === "mapped" ? "\u8BAD\u7EC3\u8FC7\u7684\u5DE5\u5177" : "\u5168\u90E8\u5DE5\u5177";
  return `${run.thinking === "full" ? "\u5F00\u601D\u8003" : "\u4E0D\u601D\u8003"} \xB7 \u6BCF\u8F6E ${run.maxSteps} \u6B65 \xB7 ${sampling} \xB7 ${tools}`;
}
function RunEditor(props) {
  const [draft, setDraft] = (0, import_react4.useState)(props.initial);
  const [samplingKey, setSamplingKey] = (0, import_react4.useState)(0);
  const [busy, setBusy] = (0, import_react4.useState)(false);
  const [failure, setFailure] = (0, import_react4.useState)();
  const disabled = props.disabled || busy;
  const update = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFailure(void 0);
  };
  const num = (key) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(NumberInput, { value: draft[key], disabled, onChange: (value) => update({ [key]: value ?? RUN_DEFAULTS[key] }) });
  const sampling = (key) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(NumberInput, { value: draft.sampling[key], disabled, onChange: (value) => update({ sampling: { ...draft.sampling, [key]: value ?? AGENT_FAST[key] } }) }, `${key}-${samplingKey}`);
  const save = async () => {
    setBusy(true);
    const ok = await props.onSave(draft);
    setBusy(false);
    if (!ok) setFailure("Host \u6CA1\u6709\u63A5\u53D7\u8FD9\u4EFD\u914D\u7F6E\uFF0C\u8349\u7A3F\u5DF2\u4FDD\u7559");
  };
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-editor", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u601D\u8003\u683C\u5F0F", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      Segment,
      {
        value: draft.thinking,
        disabled,
        options: [["full", "\u5F00\u601D\u8003\uFF08agent-wire-think\uFF09"], ["off", "\u4E0D\u601D\u8003\uFF08agent-wire\uFF09"]],
        onChange: (value) => update({ thinking: value })
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-grid3", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u6BCF\u8F6E\u6700\u591A\u5DE5\u5177\u6B65\u6570", children: num("maxSteps") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u540C\u4E00\u5DE5\u5177\u8FDE\u7EED\u5931\u8D25\u4E0A\u9650", children: num("maxConsecutiveFailures") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u683C\u5F0F\u9519\u8BEF\u91CD\u95EE\u6B21\u6570", children: num("protocolRetries") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u51B3\u7B56\u6B65 max tokens", children: num("decisionMaxTokens") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u4F5C\u7B54 max tokens", children: num("answerMaxTokens") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u5DE5\u5177\u7ED3\u679C\u6700\u591A\u5B57\u7B26", children: num("maxResultChars") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-checks", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Check, { label: "\u5386\u53F2\u7A7A\u601D\u8003\u5757\uFF08\u4E0D\u56DE\u4F20\u601D\u7EF4\u94FE\uFF09", checked: draft.historyEmptyThink, disabled, onChange: (value) => update({ historyEmptyThink: value }) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Check, { label: "\u590D\u8BFB\u68C0\u6D4B\u622A\u65AD\uFF08loop-guard\uFF09", checked: draft.loopGuard, disabled, onChange: (value) => update({ loopGuard: value }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-block-title", children: "\u91C7\u6837" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "button",
          {
            type: "button",
            className: "rwkv-link",
            disabled: disabled || same(draft.sampling, AGENT_FAST),
            onClick: () => {
              update({ sampling: AGENT_FAST });
              setSamplingKey((key) => key + 1);
            },
            children: "\u6062\u590D agent-fast"
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-grid3", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "temperature", children: sampling("temperature") }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "top_p", children: sampling("topP") }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "top_k", children: sampling("topK") }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "presence penalty", children: sampling("presencePenalty") }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "frequency penalty", children: sampling("frequencyPenalty") }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "penalty decay", children: sampling("penaltyDecay") })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-block-title", children: "\u5DE5\u5177" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u7ED9\u6A21\u578B\u770B\u54EA\u4E9B\u5DE5\u5177", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          SelectInput,
          {
            value: draft.toolMode,
            disabled,
            options: [["mapped", "\u53EA\u7ED9\u8BAD\u7EC3\u8FC7\u7684\u5DE5\u5177\uFF08\u63A8\u8350\uFF09"], ["passthrough", "\u5168\u90E8\u5DE5\u5177"]],
            onChange: (value) => update({ toolMode: value || "mapped" })
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u9690\u85CF\u7684\u5DE5\u5177", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          TextInput,
          {
            value: draft.excludeTools.join(", "),
            disabled,
            placeholder: "bash, web_fetch",
            onChange: (value) => update({ excludeTools: value.split(",").map((item) => item.trim()).filter(Boolean) })
          }
        ) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Check, { label: "\u628A DSH \u7684\u4E0A\u4E0B\u6587\u6D88\u606F\uFF08developer\uFF09\u4E5F\u7ED9\u6A21\u578B\u770B", checked: draft.includeDeveloper, disabled, onChange: (value) => update({ includeDeveloper: value }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("details", { className: "rwkv-details", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("summary", { className: "rwkv-summary", children: "\u81EA\u5B9A\u4E49\u8BBE\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "rwkv-details-body", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Field, { label: "\u4EFB\u52A1\u5951\u7EA6", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("textarea", { className: "rwkv-input rwkv-prose", value: draft.taskContract, disabled, onChange: (event) => update({ taskContract: event.target.value }) }) }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(EditorActions, { error: failure, busy, canSave: !disabled, onCancel: props.onCancel, onSave: () => {
      void save();
    } })
  ] });
}
var BLANK = { id: "", backend: "lightning", baseURL: "", model: "", contextWindow: 32768 };
function RwkvSettings(props) {
  const { form } = props;
  const [writeError, setWriteError] = (0, import_react4.useState)("");
  const write = async (field, value) => {
    setWriteError("");
    const settled = await Promise.race([
      form.set(field, value),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 8e3))
    ]);
    if (settled === true) return true;
    const reason = await props.explain?.(field, value);
    if (settled === "timeout" && !reason) return true;
    setWriteError(`\u4FDD\u5B58\u5931\u8D25${reason ? `\uFF1A${reason}` : ""}`);
    return false;
  };
  const getSnapshot = () => form.getSnapshot();
  const snapshot = (0, import_react4.useSyncExternalStore)((listener) => form.subscribe(listener), getSnapshot, getSnapshot);
  const [editing, setEditing] = (0, import_react4.useState)();
  if (snapshot.status === "loading") return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "rwkv-section", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "rwkv-intro", children: "\u52A0\u8F7D\u4E2D\u2026" }) });
  if (snapshot.status === "unavailable") return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "rwkv-section", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "rwkv-intro", children: "rwkv-llm \u63D2\u4EF6\u5F53\u524D\u6CA1\u6709\u52A0\u8F7D\uFF0C\u6682\u65F6\u65E0\u6CD5\u914D\u7F6E\u3002" }) });
  const config = normalize(snapshot.value);
  const disabled = !snapshot.writable;
  const saveModels = async (models) => {
    const ok = await write("models", models.map(cleanModel));
    if (ok) setEditing(void 0);
    return ok;
  };
  const saveRun = async (run) => {
    for (const field of RUN_FIELDS) {
      if (same(run[field], config[field])) continue;
      if (!await write(field, run[field])) return false;
    }
    setEditing(void 0);
    return true;
  };
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("h2", { className: "rwkv-title", children: "RWKV" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "rwkv-intro", children: "\u901A\u8FC7\u7EED\u5199\u63A5\u53E3\u63A5\u5165\u7684 RWKV-7 G1 \u6A21\u578B\u3002\u6BCF\u4E2A\u6A21\u578B\u90FD\u4F1A\u51FA\u73B0\u5728\u6A21\u578B\u9009\u62E9\u7684\u300Crwkv\u300D\u4E0B\uFF0C\u4E5F\u53EF\u4EE5\u4F5C\u4E3A\u5B50 Agent \u5DE5\u5177 rwkv_agent \u7684\u6267\u884C\u6A21\u578B\u3002" }),
    disabled ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "rwkv-hint", children: "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u662F\u53EA\u8BFB\u7684\u3002" }) : null,
    writeError ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "rwkv-error", children: writeError }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("ul", { className: "rwkv-rows", children: [
      config.models.map((model, index) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        ModelCard,
        {
          model,
          editing: editing === index,
          others: config.models.filter((_, at) => at !== index),
          disabled: disabled || editing !== void 0 && editing !== index,
          onEdit: () => setEditing(index),
          onClose: () => setEditing(void 0),
          onSave: (next) => saveModels(config.models.map((item, at) => at === index ? next : item)),
          onRemove: () => saveModels(config.models.filter((_, at) => at !== index))
        },
        `${model.id}-${index}`
      )),
      editing === "new" ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("li", { className: "rwkv-card", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        ModelEditor,
        {
          initial: BLANK,
          others: config.models,
          disabled,
          onCancel: () => setEditing(void 0),
          onSave: (model) => saveModels([...config.models, model])
        }
      ) }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("button", { type: "button", className: "rwkv-add", disabled: disabled || editing !== void 0, onClick: () => setEditing("new"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { "aria-hidden": "true", className: "rwkv-plus", children: "+" }),
        "\u6DFB\u52A0\u6A21\u578B"
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("h3", { className: "rwkv-subtitle", children: "\u8FD0\u884C\u53C2\u6570" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rwkv-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-identity", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-name", children: "Agent \u5FAA\u73AF\u4E0E\u91C7\u6837" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-meta", children: runSummary(config) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "rwkv-actions", children: editing === "run" ? null : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: disabled || editing !== void 0, onClick: () => setEditing("run"), children: "\u7F16\u8F91" }) })
      ] }),
      editing === "run" ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(RunEditor, { initial: config, disabled, onCancel: () => setEditing(void 0), onSave: saveRun }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(DeveloperCard, { settings: config, disabled, write })
  ] });
}

// src/client/TraceView.tsx
var import_react5 = require("react");
var import_jsx_runtime5 = require("react/jsx-runtime");
var POLL_MS = 2500;
function RwkvTraceView(props) {
  const [records, setRecords] = (0, import_react5.useState)();
  const [recording, setRecording] = (0, import_react5.useState)(false);
  const [error, setError] = (0, import_react5.useState)("");
  const [onlyTouched, setOnlyTouched] = (0, import_react5.useState)(false);
  const [showSide, setShowSide] = (0, import_react5.useState)(false);
  (0, import_react5.useEffect)(() => {
    setRecords(void 0);
    let stopped = false;
    let timer;
    let first = true;
    const load = async () => {
      if (first || document.visibilityState === "visible") {
        first = false;
        try {
          const body = await fetchSession(props.session);
          if (stopped) return;
          setRecording(body.recording);
          setRecords((current) => current !== void 0 && current.length === body.records.length ? current : body.records);
          setError("");
        } catch (cause) {
          if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (!stopped) timer = setTimeout(() => {
        void load();
      }, POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== void 0) clearTimeout(timer);
    };
  }, [props.session]);
  const generations = (records ?? []).filter((record) => isGeneration(record) && record.purpose === void 0);
  const judged = generations.filter((record) => record.outcome !== void 0);
  const hit = judged.filter(touched).length;
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "rl-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "rl-toolbar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "rl-toggles", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "rl-toggle", "aria-pressed": onlyTouched, onClick: () => setOnlyTouched((value) => !value), children: "\u53EA\u770B\u515C\u5E95" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "rl-toggle", "aria-pressed": showSide, onClick: () => setShowSide((value) => !value), children: "\u9644\u5E26\u8BF7\u6C42" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "rl-summary", children: [
        generations.length,
        " \u6B21\u751F\u6210 \xB7 ",
        hit,
        " \u6B21\u7528\u5230\u515C\u5E95",
        judged.length > 0 ? ` \xB7 \u539F\u6837\u53EF\u7528 ${percent(judged.length - hit, judged.length)}` : ""
      ] })
    ] }),
    error ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "rl-notice rwkv-error", children: error }) : null,
    records !== void 0 && records.length > 0 && !recording ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "rl-notice", children: "\u8F68\u8FF9\u53EA\u5728\u5185\u5B58\u91CC\uFF0CDSH \u91CD\u542F\u540E\u6E05\u7A7A\u3002\u8981\u4FDD\u5B58\u5230\u78C1\u76D8\uFF0C\u53BB\u8BBE\u7F6E \u2192 RWKV \u2192 \u5F00\u53D1\u8005\u52FE\u9009\u3002" }) : null,
    records === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "rl-empty", children: "\u52A0\u8F7D\u4E2D\u2026" }) : records.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "rl-empty", children: "\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709 RWKV \u8BB0\u5F55\uFF1A\u5B83\u6CA1\u7528 RWKV \u6A21\u578B\uFF0C\u6216\u8005\u662F\u5728\u8FD9\u6B21\u542F\u52A8 DSH \u4E4B\u524D\u8DD1\u7684\uFF08\u6CA1\u4FDD\u5B58\u5230\u78C1\u76D8\uFF09\u3002" }) : /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(TraceFrames, { session: props.session, records, onlyTouched, showSide })
  ] });
}

// src/client/styles.ts
var CSS = `
.rwkv-section{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}
.rwkv-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rwkv-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.rwkv-subtitle{margin:20px 0 0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rwkv-rows{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.rwkv-checks{display:flex;gap:20px;flex-wrap:wrap}
.rwkv-block-head{display:flex;align-items:center;justify-content:space-between}
.rwkv-plus{font-size:18px;line-height:1}
textarea.rwkv-prose{font-family:inherit;font-size:14px;line-height:22px}
.rwkv-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.rwkv-head{display:flex;align-items:center;gap:10px;min-height:28px}
.rwkv-identity{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:60%}
.rwkv-name{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwkv-tag{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.rwkv-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.rwkv-meta{flex:1 1 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rwkv-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex:none}
.rwkv-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.rwkv-btn:disabled{opacity:.4;cursor:default}
.rwkv-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.rwkv-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.rwkv-secondary{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.rwkv-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.rwkv-small{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}
.rwkv-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.rwkv-link{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.rwkv-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.rwkv-editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);padding:14px 16px;display:flex;flex-direction:column;gap:14px}
.rwkv-editor-head{display:flex;align-items:baseline;gap:8px}
.rwkv-editor-title{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rwkv-editor-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rwkv-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
.rwkv-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 14px}
.rwkv-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.rwkv-wide{grid-column:1/-1}
.rwkv-label{display:inline-flex;align-items:center;gap:10px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.rwkv-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rwkv-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.rwkv-saved{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}
.rwkv-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.rwkv-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.rwkv-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.rwkv-input:disabled{opacity:.6;cursor:default}
textarea.rwkv-input{height:auto;min-height:64px;padding:6px 10px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.rwkv-select{appearance:none;cursor:pointer;padding-right:32px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px}
.rwkv-check{display:inline-flex;align-items:center;gap:8px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}
.rwkv-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-button-primary-fill)}
.rwkv-details{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.rwkv-summary{display:flex;align-items:center;gap:6px;width:fit-content;padding:2px 4px;margin-left:-4px;border-radius:var(--dsw-radius-sm);cursor:pointer;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);list-style:none}
.rwkv-summary::-webkit-details-marker{display:none}
.rwkv-summary::before{content:'';width:5px;height:5px;border-right:1.5px solid currentcolor;border-bottom:1.5px solid currentcolor;transform:rotate(-45deg) translate(-1px,-1px);transition:transform 120ms ease}
.rwkv-details[open]>.rwkv-summary::before{transform:rotate(45deg) translate(-1px,-1px)}
.rwkv-summary:hover{color:var(--dsw-alias-label-primary)}
.rwkv-details-body{display:flex;flex-direction:column;gap:12px;padding-top:12px}
.rwkv-block{display:flex;flex-direction:column;gap:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.rwkv-block-title{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.rwkv-editor-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.rwkv-editor-actions .rwkv-error,.rwkv-editor-actions .rwkv-saved{margin-right:auto}
.rwkv-add{box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:center;gap:6px;height:56px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;cursor:pointer}
.rwkv-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rwkv-add:disabled{opacity:.4;cursor:default}
.rwkv-segment{display:inline-flex;padding:2px;gap:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);width:fit-content}
.rwkv-segment button{height:26px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.rwkv-segment button[aria-pressed=true]{background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3)}
.rwkv-list{display:flex;flex-direction:column;gap:4px}
.rwkv-option{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:36px;padding:0 6px 0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
button.rwkv-option{cursor:pointer;padding-right:10px}
.rwkv-option[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary)}
.rwkv-option-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:34px;padding:0;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.rwkv-option-main:disabled,button.rwkv-option:disabled{cursor:default}
.rwkv-option-name{font-size:14px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwkv-option-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rwkv-option-state{margin-left:auto;flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary)}
.rwkv-upload{display:flex;flex-direction:column;gap:6px;padding-top:4px}
.rwkv-upload-row{display:flex;align-items:center;gap:8px}
@container (max-width:560px){.rwkv-grid,.rwkv-grid3{grid-template-columns:minmax(0,1fr)}}
.rwkv-developer>summary{list-style:none;cursor:pointer}
.rwkv-developer>summary::-webkit-details-marker{display:none}
.rwkv-developer-body{display:flex;flex-direction:column;gap:12px;padding-top:4px}
.rwkv-toggle{align-items:flex-start}
.rwkv-toggle input{margin-top:4px}
.rwkv-toggle-hint{display:block}
.rwkv-dir{display:flex;gap:8px;align-items:center}
.rwkv-dir .rwkv-btn{flex:none;white-space:nowrap}
.rwkv-session-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rwkv-block-head .rwkv-actions .rwkv-btn{white-space:nowrap}
.rwkv-actions{display:inline-flex;gap:6px;align-items:center}
.rwkv-stats{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.rwkv-stats-head{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}
.rwkv-stat{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rwkv-stat b{font-size:16px;margin-right:4px;color:var(--dsw-alias-label-primary)}
.rwkv-counts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rwkv-count{display:inline-flex;gap:4px;align-items:baseline;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}
.rwkv-sessions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.rwkv-session{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);padding:6px 10px}
.rwkv-session-head{display:flex;gap:8px;align-items:center}
.rwkv-session-title{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;border:none;background:transparent;padding:0;text-align:left;font:inherit;color:inherit;cursor:pointer}
.rwkv-session-task{font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwkv-session-body{display:flex;flex-direction:column;gap:8px;padding:8px 0 4px}
.rwkv-session-body .rl-ledger{height:420px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
/* RWKV trace ledger, after DSH's Trajectory view (ui-trajectory TrajectoryTable / Toolbar). */
.rl-root{isolation:isolate;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rl-toolbar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;box-sizing:border-box;min-height:32px;padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rl-toggles{display:flex;flex-wrap:wrap;align-items:center;gap:2px}
.rl-toggle{display:inline-flex;align-items:center;height:20px;padding:0 7px;gap:4px;border:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer;font:var(--dsw-font-xxs-12)}
.rl-toggle:hover,.rl-toggle[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.rl-summary{margin-left:auto;padding-right:4px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rl-notice{flex:none;margin:0;padding:6px 12px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.rl-ledger{position:relative;flex:1;min-height:0;overflow:hidden;display:flex}
.rl-root .rl-ledger{--rl-bottom:calc(var(--dsh-composer-height,152px) + 16px)}
.rl-scroll{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;padding-bottom:var(--rl-bottom,0px)}
.rl-table{width:100%;table-layout:fixed;border-spacing:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.rl-event-col{width:96px}
.rl-table td{box-sizing:border-box;height:30px;padding:0 8px;overflow:hidden;border-bottom:.5px solid var(--dsw-alias-border-l1);white-space:nowrap;text-overflow:ellipsis}
.rl-table tr{outline:none;transition:background-color 120ms}
.rl-table tr:not(.rl-step-row){cursor:pointer}
.rl-table tr:not(.rl-step-row):hover{background:var(--dsw-alias-interactive-bg-hover)}
.rl-table tr[data-selected=true]{background:var(--dsw-alias-interactive-bg-active)}
.rl-table tr:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
.rl-table tr[data-turn-start=true]:not(:first-child) td{border-top:1.5px solid var(--dsw-alias-border-l1)}
.rl-event{position:relative;overflow:visible!important;padding-left:36px!important;padding-right:4px!important;text-align:right}
.rl-rail{position:absolute;left:0;top:-1px;bottom:-1px;width:2px;background:color-mix(in srgb,var(--dsw-static-blue-500,#3b82f6) 22%,var(--dsw-alias-bg-layer-1))}
.rl-rail-touched{background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#d9822b) 45%,var(--dsw-alias-bg-layer-1))}
.rl-rail-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-bg-layer-1))}
.rl-turn-label{position:absolute;top:0;left:0;padding:1px 5px;border-radius:0 0 2px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);font:8px/10px var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap}
.rl-tag{display:inline-flex;align-items:center;box-sizing:border-box;height:19px;padding:0 5px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:16px;font-weight:650;letter-spacing:.035em;white-space:nowrap}
.rl-tone-clean{color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%,var(--dsw-alias-state-error-secondary));background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 55%,var(--dsw-alias-state-error-secondary)) 15%,var(--dsw-alias-bg-layer-1))}
.rl-tone-touched{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.rl-tone-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1))}
.rl-tone-neutral{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.rl-content{padding-left:4px!important}
.rl-content-inner{display:flex;align-items:center;gap:6px;min-width:0}
.rl-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rl-dim{color:var(--dsw-alias-label-tertiary)}
.rl-call-name{color:var(--dsw-alias-label-primary);font:400 12px/18px Menlo,Consolas,'Liberation Mono','PingFang SC',monospace}
.rl-call-payload{margin-left:7px;color:var(--dsw-alias-label-secondary);font:400 12px/18px var(--ds-font-family-code,ui-monospace,monospace)}
.rl-chips{display:inline-flex;flex-wrap:wrap;gap:4px}
.rl-chip{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);white-space:nowrap}
.rl-chip-warn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.rl-chip-muted{color:var(--dsw-alias-label-tertiary)}
.rl-step-row td{height:22px;border-bottom:.5px dashed var(--dsw-alias-border-l1)}
.rl-step{color:var(--dsw-alias-label-tertiary);font-size:11px}
.rl-step code,.rl-kv code{font:11px/16px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}
.rl-empty{margin:0;padding:16px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.rl-inspector{position:absolute;top:0;right:0;bottom:0;z-index:5;width:min(560px,72%);display:flex;flex-direction:column;box-sizing:border-box;padding-bottom:var(--rl-bottom,0px);border-left:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel,-8px 0 24px rgba(0,0,0,.06))}
.rl-inspector-head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 12px 8px 16px}
.rl-inspector-title{flex:1;min-width:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rl-icon{width:24px;height:24px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer}
.rl-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rl-tabs{flex:none;display:flex;gap:16px;padding:0 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.rl-tabs button{height:32px;padding:0;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);cursor:pointer}
.rl-tabs button[aria-selected=true]{color:var(--dsw-alias-state-business-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}
.rl-inspector-body{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.rl-kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px 12px;font:var(--dsw-font-xs-13)}
.rl-kv-key{color:var(--dsw-alias-label-tertiary)}
.rl-kv-value{min-width:0;overflow-wrap:anywhere}
.rl-section-title{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);font-weight:500}
.rl-prose{font:var(--dsw-font-xs-13);line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.rl-pre{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);font:12px/18px var(--ds-font-family-code,ui-monospace,monospace);white-space:pre-wrap;word-break:break-word}
.rl-pre-full{flex:1}
`;
function mountStyles() {
  if (typeof document === "undefined") return () => {
  };
  const id = "dsh-rwkv-plugin-styles";
  document.getElementById(id)?.remove();
  const tag = document.createElement("style");
  tag.id = id;
  tag.dataset.plugin = "dsh-rwkv-plugin";
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => tag.remove();
}

// src/client/index.tsx
var NAMESPACE = "rwkv-llm";
var inject = ["slots", "configForms", "remote"];
function apply(ctx) {
  const services = ctx;
  const form = services.configForms.get(NAMESPACE);
  const explain = async (field, value) => {
    const mutate = services.remote?.settings?.mutate;
    if (mutate === void 0) return "";
    try {
      const result = await mutate.call(services.remote.settings, NAMESPACE, [{ op: "set", path: [field], value }], form.getSnapshot().revision);
      return result.ok ? "" : result.error?.message ?? result.error?.code ?? "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  ctx.effect(() => mountStyles(), "rwkv-llm: settings styles");
  ctx.effect(() => services.configForms.whileServed([NAMESPACE], () => services.slots.inject("settings.section", () => services.slots.register({
    name: "settings.section",
    id: "rwkv",
    order: 15,
    label: () => "RWKV",
    inject: () => ({ form, explain })
  }, RwkvSettings))), "rwkv-llm: settings section");
  ctx.effect(() => services.configForms.whileServed([NAMESPACE], () => services.slots.inject("conversation.view", () => services.slots.register({
    name: "conversation.view",
    id: "rwkv-trace",
    order: 45,
    label: () => "RWKV",
    inject: (sessionId) => ({ session: String(sessionId) })
  }, RwkvTraceView))), "rwkv-llm: trace view");
}
return module.exports; } });
//# sourceMappingURL=client.js.map
