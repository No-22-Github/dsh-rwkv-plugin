# 提示词格式、采样与解析兜底

> **TL;DR（分层速读）**
> - 本文档覆盖 RWKV 字节级提示词拼装、`Assistant:` 无空格生成点、停止符与 `agent-fast` 采样，以及输出解析与强制收尾的完整兜底链。
> - 改任何会影响提示词字节的内容（如 `src/core/dsh-prompt.ts`、`prompt.ts`、`tools.ts`），都必须同步重采训练数据并对齐评测 commit。
> - 协议标签说明统一用 `<思考开始>`/`<思考结束>`、`<工具调用开始>`/`<工具调用结束>`、`<工具结果开始>`/`<工具结果结束>` 表示。

---

## 1. 字节级提示词格式

### System 块构成（约 1331 token）

RWKV 看到的 `System:` 块由三部分组成（按 DSH Standard 快照以 `rwkv-tokenizer-go` 计数，因模型名与 `bash` 参数不同略有浮动）：

| 部分 | 内容 | token |
|---|---|---|
| DSH 系统提示词 | Standard 提示词 21 段中保留的 11 段 | 336 |
| 动作协议 | 怎样调用工具、怎样直接回答 | 约 164 |
| 工具清单 | 8 个工具的名字、描述、压平参数 | 831 |
| **合计** | | **1331** |

- **保留的 11 段**：DeepSeek Harness 身份句、persona（`You are a coding agent powered by …`）、`@` 路径说明、`bash` 的 exit code、`read`、`write`、`edit`（读后再改）、`glob`、`grep`、`web_search`、`web_fetch`。
- **删掉的 10 段**（共省约 1045 token）：`apply_patch`、后台 `job`、`goal`、`schedule`、`workflow`、subagent 并行委派、subagent 共享文件、`present`、DSH 源码 checkout 路径、Web GUI。其中后两段全局注册，由 [src/core/dsh-prompt.ts](../src/core/dsh-prompt.ts) 按段首匹配裁剪；DSH 改措辞时需同步更新。
- **动作协议**（`src/core/prompt.ts`）：要求每步只输出一个 `<工具调用开始>{"name":"TOOL_NAME","arguments":{...}}<工具调用结束>`，否则直接用普通文本回答；禁止混写解释与工具调用、禁止 Markdown 代码围栏与角色标签、禁止编造文件内容，并在 `<思考结束>` 后紧接动作。
- **`promptJSON` 不转义 `< > &`**：Go 端曾将 `< > &` 转义为 `\u003c` 等导致代码/HTML 翻倍并触发复读，插件仅转义 `U+2028`/`U+2029`。

### 运行时上下文、工具清单与日期行

- **运行时上下文 5 留 2**（约 64 token，作为用户消息后的附注）：仅保留 `working-directory:current`（路径修复也依赖它）和 `sandbox:policy`；删去 `approval:policy`、`harness:source`、`app:web-surface`。额外约束可写在设置的 `taskContract` 中，附于 System 块末尾。
- **8 个基础工具**（`bash`、`read`、`write`、`edit`/`edit_lines`、`glob`、`grep`、`web_search`、`web_fetch`；开启 `worklist` 时追加 `todo_plan`/`todo_update`）：参数不走完整 JSON Schema，而是压平成一行占位说明（如 `{"file_path":"Path to read, …","offset":"optional number"}`）。`bash` 在 Windows 预设中禁用。
- **未挂载的 Standard 能力**：`AGENTS.md`（`agent-instructions`）、`time-context`、`apply_patch`、`read_image`、后台 `job`、`schedule`、`goal`、`skill`、`plan`、`ask_user_question`、`subagent`/`workflow`、`present`、插件管理与 DSH 内置压缩。
- **当前日期行**（`currentDate`，设置默认开）：System 块末尾写 `Current date: YYYY-MM-DD (Zone, UTC+XX:XX).`，天级变化不破前缀缓存；开启时 `time-context` 不进历史，关闭时以 `Current time: <时间戳>.` 备注出现。`headless` 默认关闭（可传 `--current-date` 打开）以与训练数据对齐。

### `Assistant:` 无空格铁律与历史思考

- **生成点绝不带尾随空格**：提示词末尾必须以 `Assistant: <思考开始`（或关闭思考时 `Assistant:` 无空格）收尾；带空格会破坏 RWKV 分词边界，导致总分大幅下跌与英文题误答成中文。
- **历史思考（`historyEmptyThink`）**：默认保留历史步骤思考（与新权重对齐）；使用旧版空思考权重时，可在设置中勾选「历史步骤不带思考」，使历史 assistant 调用只保留空 `<思考开始><思考结束>`。
- **调用后提醒**：每条工具结果后附一句提醒（证据够了就回答、别重复成功调用），仅出现在当前轮，历史轮次不保留。

---

## 2. 采样参数、停止符与生成中保护

### `agent-fast` 采样与后端扩展

默认值定义于 [src/core/defaults.ts](../src/core/defaults.ts)：

- **`agent-fast` 预设**：`temperature: 0.5`、`topK: 65536`、`topP: 0.7`、`presencePenalty: 0.5`、`frequencyPenalty: 0.2`、`penaltyDecay: 0.996`。DSH 界面只能覆盖温度，其余参数由插件控制。
- **停止符**：插件统一管理停止符（DSH 侧传 `stop` 会报错），以 `<工具调用结束>` 及角色边界为停机信号。
- **state / adapter**：`rwkv_lightning` 支持上传初始 state（`stateId`）和请求级 `adapterId`，存于服务临时目录（重启需重传）。注意部分老版服务曾忽略 `adapter_id` 回退基模，对照实验前务必先确认生效。

### 生成中保护（3 项）

1. **复读截断（`loopGuard`，默认开）**：客户端检测到同段文本反复复读时提前掐断生成。
2. **思考中引用了停止符**：模型还在思考块内提及了 `<工具调用结束>` 停止符时，插件把标签补回并续写，最多续 4 次。
3. **思考写满 token 上限**：在断开处替模型补上 `<思考结束>`，再给 `1024` token 输出动作，避免整轮重问重演长思考。

---

## 3. 输出解析、工具检查与强制收尾

### 输出解析与 `recover-preamble`（11 条容错）

由 [src/core/parse.ts](../src/core/parse.ts) 负责修复常见格式偏差，修不好的分成五类交由重问：**思考没闭合、超长、JSON 解析不了、结构不对、空输出**。

1. **`recover-preamble`（先说话再调用）**：一句话 + 换行 + 末尾单个完整调用时，剥离前置废话（引用示例、多调用、代码块内均不触发）。
2. **OpenAI 外壳**：拆掉 `{"type":"function","function":{...}}` 外壳。
3. **多余 `}`**：去掉完整 JSON 对象末尾多出的右括号。
4. **单元素数组**：拆开 `[{...}]`。
5. **字段名写错**：`tool`/`cmd`/`function` → `name`；`args`/`parameters`/`input` → `arguments`；无 `arguments` 时其余顶层字段归入参数。
6. **字符串化参数**：`arguments` 为 JSON 字符串时再解析一层。
7. **只写了路径**：`{"path":...}` 无工具名，或工具名为 `reader`/`file_reader` 时，按读文件处理。
8. **外层多包一层**：剥离外层的 `<工具结果开始>` / 复数调用标签。
9. **自闭合标签**：识别 `<read_file path="a.txt"/>` 写法。
10. **清理最终回答**：剔除残留思考块、未停住写出的 `User:` 等角色标签，以及 `✿` 之后的内容。
11. **纯花括号 JSON 不算调用**：未带 `<工具调用开始>` 的 JSON 视作普通回答，确保用户索要 JSON 时正常返回。

### 工具调用检查（`gateToolCall`）

调用交给 DSH 前，由 [src/core/agent.ts](../src/core/agent.ts) 执行 7 项检查（另含 [src/paths.ts](../src/paths.ts) 路径修复）：

1. **工具名纠正**：精确 → 忽略大小写 → 别名（`str_replace` → `edit`、`shell` → `bash`、`ls` → `glob`）与训练名（`read_file`/`write_file`/`edit_file`/`list_files`/`search_text`）自动映射；未知工具回传失败提示。
2. **参数名纠正**：`path` → `file_path`、`old_text` → `old_string`、`query` → `pattern`、`start_line`/`end_line` → `offset`/`limit`；`web_search` 单串包成 `queries` 数组；`bash` 缺 `description` 时取命令首行补齐。
3. **数值宽松**：`"5"` → `5`、`"true"` → `true`、`"6,412"` 去千分位；结构不符原样交工具报错。
4. **重复成功调用**：参数排序后与本轮已成功调用完全一致时拦截；发生成功写操作（`edit_lines`/`edit`/`write` 或写文件类 `bash` 如重定向、`sed -i`、`tee`、`mv/cp/rm`、`git apply`、`pip install`）后重置计数。首次拦截给重试提示，第二次强制收尾。
5. **重复失败调用**：与此前失败调用相同且期间无新成功结果时，直接强制收尾。
6. **连续失败封禁**：同一工具连续失败 `2` 次（`maxConsecutiveFailures`）后拒绝再调，建议换工具或直接作答（`read` 失败会提示先 `glob`/`grep`）。
7. **拦截上限**：单次请求内被拦超过 `3` 次，强制收尾。
- **路径修复（`src/paths.ts`）**：针对 G1 抄写工作目录漏最后一级目录的问题，仅在原路径不存在且补齐后路径存在时修正。

### 格式重问与强制收尾（5 层保底）

- **格式重问（`protocolRetries=2`）**：按「思考没闭合 / 超长 / 其他」附纠正提示最多重问 2 次；用完后若本轮已调过工具则强制收尾，否则直接给兜底总结。
- **强制收尾触发条件**：达到 `maxSteps=15`、第二次重复调用、调用 `no_tool` 却无文本、重问或拦截超限。
- **5 层保底**：撤掉工具后依次尝试：① 直接要回答 → ② 强制用 Markdown 作答且禁调工具 → ③ 关思考时预填中文开头（`根据上面的工具结果，`）续写 → ④ 捞取工具调用前非计划性正文（salvage）→ ⑤ 插件生成不编造事实的调用汇总与建议。（若因格式问题进入收尾，模型偶发给出的合法调用仍会执行。）

---

## 4. 兜底开关与轨迹排查

### 双开关测模型原样能力

设置 → RWKV Agent → 开发者中默认开启两个开关（**提示词拼装、`maxSteps`、未知工具失败、`loopGuard`、`toolNames: trained` 映射均不受开关影响**）：

| 开关 | 覆盖范围 | 关闭后行为 |
|---|---|---|
| **修正模型输出**（`outputRepairs`） | 格式修复、工具/参数名与数值宽松、DSH 参数修复（`glob` 补 pattern、`read` offset 0→1 等）、路径修复 | 仅认标准 `<工具调用开始>{"name":…,"arguments":{…}}<工具调用结束>` 与精确工具名，其余直接报格式错误或未知工具 |
| **插件修复**（`guards`） | 思考写满补闭合、重复拦截、连续失败封禁、格式重问、收尾重问/预填/salvage/兜底总结 | 解析不了的原样作为回答交 DSH（`via: raw`），不重问不拦截 |

### 原始合格率与轨迹排查

- **视图差异**：DSH 界面显示的是修复后调用与未裁剪全文；要看 RWKV 实际收到的文本与每次重问，请点对话视图的**「RWKV」标签页**（紫色=原样可用，橙色=触发兜底，红色=原样输出或被拒；右侧面板分「概述 / 原始输出 / 提示词」）。
- **落盘与统计**：默认开启 `recordTraces`，写入 `~/.dsh/sessions/<工作区>/<会话id>/rwkv-trace.jsonl`（可用 `traceDir` 改目录；关掉后仅存内存，上限 100 会话 / 约 1 亿字符）。每次生成记录 `prompt`、`output`、`action`、`outcome`、`repairs`，请求结束追加 `stage: "step"`。命令行汇总：

```bash
node scripts/trace-stats.ts ~/.dsh/sessions/*/*/rwkv-trace.jsonl
```

- **导出 JSONL 字段**：每行含 `records`（含重问与附带请求）、`text`（末次生成完整文本，按设置保留或清空历史思考）、`textWithThinks`（回填历史真实思考版本，记录完整时生成）、`stats`（兜底统计）。
