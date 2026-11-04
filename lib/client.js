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
var import_react2 = require("react");

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

// src/client/RwkvSettings.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
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
  loopGuard: true,
  traceDir: ""
};
var RUN_FIELDS = Object.keys(RUN_DEFAULTS);
function normalize(value) {
  const config = { ...RUN_DEFAULTS, models: [], ...typeof value === "object" && value !== null ? value : {} };
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
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: props.wide ? "rwkv-field rwkv-wide" : "rwkv-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-label", children: props.label }),
    props.children,
    props.hint ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-hint", children: props.hint }) : null
  ] });
}
function TextInput(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
  const [text, setText] = (0, import_react2.useState)(props.value === void 0 ? "" : String(props.value));
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "rwkv-input rwkv-select", value: props.value, disabled: props.disabled, onChange: (event) => props.onChange(event.target.value), children: props.options.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value, children: label }, value)) });
}
function Segment(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rwkv-segment", role: "group", children: props.options.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", "aria-pressed": props.value === value, disabled: props.disabled, onClick: () => props.onChange(value), children: label }, value)) });
}
function Check(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "rwkv-check", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "checkbox", checked: props.checked, disabled: props.disabled, onChange: (event) => props.onChange(event.target.checked) }),
    props.label
  ] });
}
function HeadersInput(props) {
  const [text, setText] = (0, import_react2.useState)(() => props.value && Object.keys(props.value).length > 0 ? JSON.stringify(props.value, null, 2) : "");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-editor-actions", children: [
    props.error ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-error", children: props.error }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary", disabled: props.busy, onClick: props.onCancel, children: "\u53D6\u6D88" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rwkv-btn rwkv-primary", disabled: props.busy || !props.canSave, onClick: props.onSave, children: props.busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" })
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
  const [draft, setDraft] = (0, import_react2.useState)(props.initial);
  const [idLinked, setIdLinked] = (0, import_react2.useState)(props.initial.id === "" || props.initial.id === props.initial.model);
  const [nameLinked, setNameLinked] = (0, import_react2.useState)(!props.initial.name || props.initial.name === props.initial.model);
  const [touched, setTouched] = (0, import_react2.useState)(false);
  const [headersError, setHeadersError] = (0, import_react2.useState)();
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [failure, setFailure] = (0, import_react2.useState)();
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
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-editor", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-editor-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-editor-title", children: draft.name || draft.id || "\u65B0\u6A21\u578B" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rwkv-editor-sub", children: [
        "rwkv/",
        draft.id || "\u2026"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u540E\u7AEF", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      Segment,
      {
        value: draft.backend,
        disabled,
        options: [["lightning", "rwkv_lightning CUDA"], ["irwkv", "iRWKV\uFF08vLLM\uFF09"]],
        onChange: (value) => set("backend", value)
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-grid", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u4E0A\u6E38\u6A21\u578B ID", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TextInput, { value: draft.model, disabled, placeholder: "rwkv7-g1l-7.2b", onChange: setUpstream }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u670D\u52A1\u5730\u5740", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TextInput, { value: draft.baseURL, disabled, placeholder: "http://host:8000", onChange: (value) => set("baseURL", value) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u6A21\u578B ID", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TextInput, { value: draft.id, disabled, placeholder: "\u9ED8\u8BA4\u540C\u4E0A\u6E38\u6A21\u578B ID", onChange: (value) => {
        setIdLinked(value.trim() === "");
        set("id", value);
      } }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u663E\u793A\u540D", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TextInput, { value: draft.name, disabled, placeholder: "\u9ED8\u8BA4\u540C\u4E0A\u6E38\u6A21\u578B ID", onChange: (value) => {
        setNameLinked(value.trim() === "");
        set("name", value);
      } }) })
    ] }),
    lightning ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      AdapterPicker,
      {
        connection: { baseURL: draft.baseURL, apiKey: draft.apiKey, headers: draft.headers },
        value: draft.adapter?.id,
        disabled,
        onChange: (id) => set("adapter", id ? { id } : void 0)
      }
    ) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("details", { className: "rwkv-details", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("summary", { className: "rwkv-summary", children: "\u81EA\u5B9A\u4E49\u8BBE\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rwkv-details-body", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: lightning ? "\u5BC6\u7801" : "API \u5BC6\u94A5", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TextInput, { type: "password", value: draft.apiKey, disabled, placeholder: "\u7559\u7A7A\u8868\u793A\u4E0D\u9700\u8981", onChange: (value) => set("apiKey", value) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u4E0A\u4E0B\u6587\u7A97\u53E3", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(NumberInput, { value: draft.contextWindow, disabled, placeholder: "32768", onChange: (value) => set("contextWindow", value) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u601D\u8003\u683C\u5F0F", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          SelectInput,
          {
            value: draft.thinking ?? "",
            disabled,
            options: [["", "\u8DDF\u968F\u8FD0\u884C\u53C2\u6570"], ["full", "\u5F00\u601D\u8003"], ["off", "\u4E0D\u601D\u8003"]],
            onChange: (value) => set("thinking", value || void 0)
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u5386\u53F2\u7A7A\u601D\u8003\u5757", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          SelectInput,
          {
            value: draft.historyEmptyThink === void 0 ? "" : draft.historyEmptyThink ? "on" : "off",
            disabled,
            options: [["", "\u8DDF\u968F\u8FD0\u884C\u53C2\u6570"], ["on", "\u5F00"], ["off", "\u5173"]],
            onChange: (value) => set("historyEmptyThink", value === "" ? void 0 : value === "on")
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u989D\u5916\u8BF7\u6C42\u5934\uFF08JSON\uFF09", wide: true, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(HeadersInput, { value: draft.headers, disabled, onChange: (value, error) => {
          setHeadersError(error);
          if (!error) set("headers", value);
        } }) })
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      EditorActions,
      {
        error: failure ?? (touched ? invalid : void 0),
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
  const [confirming, setConfirming] = (0, import_react2.useState)(false);
  const adapterId = model.backend === "lightning" ? model.adapter?.id : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { className: "rwkv-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rwkv-identity", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-name", children: model.name || model.id }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-tag", children: BACKEND_LABEL[model.backend] }),
        adapterId ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-dot", title: `adapter ${adapterId}` }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rwkv-meta", children: [
        model.model,
        adapterId ? ` \xB7 ${adapterId}` : ""
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-actions", children: props.editing ? null : confirming ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rwkv-link", onClick: () => setConfirming(false), children: "\u53D6\u6D88" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small rwkv-danger", disabled: props.disabled, onClick: () => {
          void props.onRemove();
        }, children: "\u786E\u8BA4\u5220\u9664" })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rwkv-link", disabled: props.disabled, onClick: () => setConfirming(true), children: "\u5220\u9664" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: props.disabled, onClick: props.onEdit, children: "\u7F16\u8F91" })
      ] }) })
    ] }),
    props.editing ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ModelEditor, { initial: model, others: props.others, disabled: props.disabled, onCancel: props.onClose, onSave: props.onSave }) : null
  ] });
}
function runSummary(run) {
  const sampling = same(run.sampling, AGENT_FAST) ? "agent-fast" : `T ${run.sampling.temperature} \xB7 top_p ${run.sampling.topP}`;
  const tools = run.toolMode === "mapped" ? "\u8BAD\u7EC3\u8FC7\u7684\u5DE5\u5177" : "\u5168\u90E8\u5DE5\u5177";
  return `${run.thinking === "full" ? "\u5F00\u601D\u8003" : "\u4E0D\u601D\u8003"} \xB7 \u6BCF\u8F6E ${run.maxSteps} \u6B65 \xB7 ${sampling} \xB7 ${tools}`;
}
function RunEditor(props) {
  const [draft, setDraft] = (0, import_react2.useState)(props.initial);
  const [samplingKey, setSamplingKey] = (0, import_react2.useState)(0);
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [failure, setFailure] = (0, import_react2.useState)();
  const disabled = props.disabled || busy;
  const update = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFailure(void 0);
  };
  const num = (key) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(NumberInput, { value: draft[key], disabled, onChange: (value) => update({ [key]: value ?? RUN_DEFAULTS[key] }) });
  const sampling = (key) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(NumberInput, { value: draft.sampling[key], disabled, onChange: (value) => update({ sampling: { ...draft.sampling, [key]: value ?? AGENT_FAST[key] } }) }, `${key}-${samplingKey}`);
  const save = async () => {
    setBusy(true);
    const ok = await props.onSave(draft);
    setBusy(false);
    if (!ok) setFailure("Host \u6CA1\u6709\u63A5\u53D7\u8FD9\u4EFD\u914D\u7F6E\uFF0C\u8349\u7A3F\u5DF2\u4FDD\u7559");
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-editor", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u601D\u8003\u683C\u5F0F", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      Segment,
      {
        value: draft.thinking,
        disabled,
        options: [["full", "\u5F00\u601D\u8003\uFF08agent-wire-think\uFF09"], ["off", "\u4E0D\u601D\u8003\uFF08agent-wire\uFF09"]],
        onChange: (value) => update({ thinking: value })
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-grid3", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u6BCF\u8F6E\u6700\u591A\u5DE5\u5177\u6B65\u6570", children: num("maxSteps") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u540C\u4E00\u5DE5\u5177\u8FDE\u7EED\u5931\u8D25\u4E0A\u9650", children: num("maxConsecutiveFailures") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u683C\u5F0F\u9519\u8BEF\u91CD\u95EE\u6B21\u6570", children: num("protocolRetries") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u51B3\u7B56\u6B65 max tokens", children: num("decisionMaxTokens") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u4F5C\u7B54 max tokens", children: num("answerMaxTokens") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u5DE5\u5177\u7ED3\u679C\u6700\u591A\u5B57\u7B26", children: num("maxResultChars") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-checks", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Check, { label: "\u5386\u53F2\u7A7A\u601D\u8003\u5757\uFF08\u4E0D\u56DE\u4F20\u601D\u7EF4\u94FE\uFF09", checked: draft.historyEmptyThink, disabled, onChange: (value) => update({ historyEmptyThink: value }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Check, { label: "\u590D\u8BFB\u68C0\u6D4B\u622A\u65AD\uFF08loop-guard\uFF09", checked: draft.loopGuard, disabled, onChange: (value) => update({ loopGuard: value }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-block-title", children: "\u91C7\u6837" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-grid3", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "temperature", children: sampling("temperature") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "top_p", children: sampling("topP") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "top_k", children: sampling("topK") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "presence penalty", children: sampling("presencePenalty") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "frequency penalty", children: sampling("frequencyPenalty") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "penalty decay", children: sampling("penaltyDecay") })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-block-title", children: "\u5DE5\u5177" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u7ED9\u6A21\u578B\u770B\u54EA\u4E9B\u5DE5\u5177", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          SelectInput,
          {
            value: draft.toolMode,
            disabled,
            options: [["mapped", "\u53EA\u7ED9\u8BAD\u7EC3\u8FC7\u7684\u5DE5\u5177\uFF08\u63A8\u8350\uFF09"], ["passthrough", "\u5168\u90E8\u5DE5\u5177"]],
            onChange: (value) => update({ toolMode: value || "mapped" })
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u9690\u85CF\u7684\u5DE5\u5177", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          TextInput,
          {
            value: draft.excludeTools.join(", "),
            disabled,
            placeholder: "bash, web_fetch",
            onChange: (value) => update({ excludeTools: value.split(",").map((item) => item.trim()).filter(Boolean) })
          }
        ) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Check, { label: "\u628A DSH \u7684\u4E0A\u4E0B\u6587\u6D88\u606F\uFF08developer\uFF09\u4E5F\u7ED9\u6A21\u578B\u770B", checked: draft.includeDeveloper, disabled, onChange: (value) => update({ includeDeveloper: value }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("details", { className: "rwkv-details", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("summary", { className: "rwkv-summary", children: "\u81EA\u5B9A\u4E49\u8BBE\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-details-body", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u4EFB\u52A1\u5951\u7EA6", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("textarea", { className: "rwkv-input rwkv-prose", value: draft.taskContract, disabled, onChange: (event) => update({ taskContract: event.target.value }) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: "\u8F68\u8FF9\u76EE\u5F55", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TextInput, { value: draft.traceDir, disabled, placeholder: "/path/to/traces", onChange: (value) => update({ traceDir: value }) }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(EditorActions, { error: failure, busy, canSave: !disabled, onCancel: props.onCancel, onSave: () => {
      void save();
    } })
  ] });
}
var BLANK = { id: "", backend: "lightning", baseURL: "", model: "", contextWindow: 32768 };
function RwkvSettings(props) {
  const { form } = props;
  const [writeError, setWriteError] = (0, import_react2.useState)("");
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
  const snapshot = (0, import_react2.useSyncExternalStore)((listener) => form.subscribe(listener), getSnapshot, getSnapshot);
  const [editing, setEditing] = (0, import_react2.useState)();
  if (snapshot.status === "loading") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rwkv-section", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-intro", children: "\u52A0\u8F7D\u4E2D\u2026" }) });
  if (snapshot.status === "unavailable") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "rwkv-section", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-intro", children: "rwkv-llm \u63D2\u4EF6\u5F53\u524D\u6CA1\u6709\u52A0\u8F7D\uFF0C\u6682\u65F6\u65E0\u6CD5\u914D\u7F6E\u3002" }) });
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
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "rwkv-title", children: "RWKV" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-intro", children: "\u901A\u8FC7\u7EED\u5199\u63A5\u53E3\u63A5\u5165\u7684 RWKV-7 G1 \u6A21\u578B\u3002\u6BCF\u4E2A\u6A21\u578B\u90FD\u4F1A\u51FA\u73B0\u5728\u6A21\u578B\u9009\u62E9\u7684\u300Crwkv\u300D\u4E0B\uFF0C\u4E5F\u53EF\u4EE5\u4F5C\u4E3A\u5B50 Agent \u5DE5\u5177 rwkv_agent \u7684\u6267\u884C\u6A21\u578B\u3002" }),
    disabled ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-hint", children: "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u662F\u53EA\u8BFB\u7684\u3002" }) : null,
    writeError ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "rwkv-error", children: writeError }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("ul", { className: "rwkv-rows", children: [
      config.models.map((model, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
      editing === "new" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: "rwkv-card", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        ModelEditor,
        {
          initial: BLANK,
          others: config.models,
          disabled,
          onCancel: () => setEditing(void 0),
          onSave: (model) => saveModels([...config.models, model])
        }
      ) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "rwkv-add", disabled: disabled || editing !== void 0, onClick: () => setEditing("new"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { "aria-hidden": "true", className: "rwkv-plus", children: "+" }),
        "\u6DFB\u52A0\u6A21\u578B"
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "rwkv-subtitle", children: "\u8FD0\u884C\u53C2\u6570" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "rwkv-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-identity", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-name", children: "Agent \u5FAA\u73AF\u4E0E\u91C7\u6837" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-meta", children: runSummary(config) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rwkv-actions", children: editing === "run" ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "rwkv-btn rwkv-secondary rwkv-small", disabled: disabled || editing !== void 0, onClick: () => setEditing("run"), children: "\u7F16\u8F91" }) })
      ] }),
      editing === "run" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(RunEditor, { initial: config, disabled, onCancel: () => setEditing(void 0), onSave: saveRun }) : null
    ] })
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
}
return module.exports; } });
//# sourceMappingURL=client.js.map
