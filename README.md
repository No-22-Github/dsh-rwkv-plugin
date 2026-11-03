# dsh-rwkv-plugin

把 RWKV-Agent 的 RWKV-7 G1 Agent 移植成 DeepSeek Harness（DSH）的插件：注册一个叫 `rwkv` 的 LLM provider，
可以给主 Agent 用，也可以作为子 Agent（`rwkv_agent` 委派工具）给 DeepSeek 主 Agent 调用。

- **接口**：续写接口不变——rwkv_lightning CUDA（`/v1/batch/completions`，支持 adapter / state）和 iRWKV（`/v1/completions`）。
- **格式**：XML 信封 agent-wire（`<tool_call>{...}</tool_call>`、`User: <tool_response>…`），默认开思考
  （agent-wire-think-v1.0，提示词以 `Assistant: <think` 结尾）；think-sft 模型可开"历史空思考块"（agent-wire-think-v2.0）。
- **采样**：默认 agent-fast（T 0.3 / top_p 0.5 / top_k 不截断 / presence 0.5 / frequency 0.1 / decay 0.996）。
- **兜底**：从 Go harness 移植——recover-preamble、OpenAI 外壳、多余 `}`、字符串化 arguments、键名别名、标量宽松；
  重复成功调用第一次给一次带改文件提示的重试（v26）、第二次强制收尾；重复失败调用直接收尾；同工具连续失败封禁；
  步数上限强制收尾；作答阶段还吐工具调用时重问 → 预填开头 → 截取正文 → 写工具结果摘要；思考里引用 `</tool_call>` 被截停时续写；
  loop-guard 复读截断；停止串 `</tool_call>`、`\nUser:`、`\nSystem:`、`\nTool:`。

## 结构

| 文件 | 内容 |
|---|---|
| `src/index.ts` | 插件入口：Config schema，注册 provider，后台检查/上传 adapter |
| `src/adapter.ts` | DSH `LlmAdapter`：历史 → 一步决策 → StreamChunk（思考实时推为 reasoning 块） |
| `src/history.ts` | DSH 消息 → harness 历史（工具调用按 RWKV 名回显） |
| `src/core/prompt.ts` | 系统提示词与 transcript 字节（与 Go 版逐字节一致，含 Go `json.Marshal` 的 `<` 转义） |
| `src/core/parse.ts` | 动作解析与各类修复 |
| `src/core/policy.ts` | 提醒文案、每轮状态（重复/失败/步数）从历史重建 |
| `src/core/agent.ts` | 单次请求内的决策循环：重问、门控、强制收尾、作答兜底、思考截停续写 |
| `src/core/tools.ts` | DSH 工具 ↔ 训练时的工具名与扁平参数 |
| `src/backend/*` | lightning / iRWKV 流式客户端、客户端停止串、loop-guard、adapter 上传/注册/删除 |
| `src/client/*` | 设置页「RWKV」（浏览器半侧，`npm run build` 打成 `lib/client.js`） |
| `dev.cordis.yml` | 源码 checkout 用的 `--patch` 覆盖层 |
| `cordis.patch.yml` | `dsh plugin add` 安装时的组合包层 |

### 工具映射（toolMode: mapped，默认）

| DSH | 模型看到的 | 说明 |
|---|---|---|
| `read` | `read_file{path,start_line,end_line}` | 行号区间换成 offset/limit |
| `write` | `write_file{path,content}` | |
| `edit` | `edit_file{path,old_text,new_text}` | 训练里没有，模型可能少用 |
| `glob` | `list_files{path,pattern}` | pattern 默认 `*` |
| `grep` | `search_text{query,path}` | 字面量转义成正则 |
| `bash` | `bash{command}` | description 自动取命令首行 |
| `web_search` | `web_search{query}` | → `queries:[query]` |
| `web_fetch` | `web_fetch{url}` | 也接受 `urls:[…]` |

其他 DSH 工具在 mapped 模式下不给模型看；`passthrough` 模式会用扁平占位符全部暴露。
DSH 的系统提示词不发给 RWKV（7B 吃不下，且会带偏），用的是我们训练时的系统提示词，需要补充约束写在 `taskContract`。

## 跑起来

```bash
cd /Users/no22/Projects/deepseek-harness
pnpm run build
```

```bash
/Users/no22/Projects/dsh-rwkv-plugin/scripts/link-dsh.sh
```

```bash
cd /Users/no22/Projects/dsh-rwkv-plugin && npm run build
```

把 `dev.cordis.yml` 里 `- insert:` 那一段放进 profile 自己的 patch（本机已放进 `~/.dsh/profiles/web/cordis.patch.yml`），然后不带 `--patch` 启动：

```bash
cd /Users/no22/Projects/deepseek-harness && pnpm dsh web
```

插件行的 `name` 必须写成 `file:///…/src/index.ts`：DSH 用这个 URL 给行命名，写成裸路径时设置页保存会被拒（「overridden by a home patch or command-line overlay」）。不要再用 `--patch dev.cordis.yml`：设置页保存时写的是 profile patch，而 `--patch` 覆盖层优先级更高，会把保存的值盖掉（DSH 会拒绝写入）。

打开 http://127.0.0.1:3080：

- **主 Agent 用 RWKV**：模型选择里选「RWKV · …」，preset 选「RWKV」（只带训练过的工具）。
  也可以把 `dev.cordis.yml` 底部的 `agent-default-model` 取消注释，让新会话默认就是 RWKV。
- **子 Agent**：保持 DeepSeek 主 Agent，它多了一个 `rwkv_agent` 工具，委派出去的子任务由 RWKV（preset `rwkv`）完成。
  子 Agent 用哪个模型在 `tool-rwkv-agent` 行的 `agentOptions.model` 里改。
- **设置页**：设置里多一个「RWKV」分区，可以增删模型、填端点/上游模型 ID/密码/请求头、adapter（id + 本地文件或服务器路径）、
  思考格式、步数与 token 预算、采样、工具暴露方式。保存后插件按新配置重载，有 adapter 的模型会先检查服务器上有没有该 id，没有就上传或注册。
- **轨迹**：`traceDir`（dev 配置里是 `./traces`）按会话写 JSONL，每次生成一行：完整 prompt 字节、原始输出、解析出的动作。

也可以装进 profile（设置页的浏览器半侧按包名挂载，这条路最稳）：

```bash
cd /Users/no22/Projects/deepseek-harness && pnpm dsh plugin --profile rwkv add /Users/no22/Projects/dsh-rwkv-plugin
```

```bash
cd /Users/no22/Projects/deepseek-harness && pnpm dsh web --profile rwkv
```

## 不经过 DSH 的测试

```bash
cd /Users/no22/Projects/dsh-rwkv-plugin && npm test
```

```bash
cd /Users/no22/Projects/dsh-rwkv-plugin && node scripts/smoke.ts irwkv http://100.64.0.5:8103 rwkv7-g1l-7.2b
```

```bash
cd /Users/no22/Projects/dsh-rwkv-plugin && node scripts/smoke.ts lightning http://100.64.0.9:8000 rwkv7-g1l-7.2b-20261031-ctx34304 --adapter think-sft-mix-g1l --empty-think
```

`smoke.ts` 自己扮演 DSH 的外层循环，用临时目录里的假 read/glob/grep/write 工具跑多步任务。adapter 管理：

```bash
cd /Users/no22/Projects/dsh-rwkv-plugin && node scripts/adapter.ts list http://100.64.0.9:8000
```

## 已知限制

- **还没在 DSH 里实际跑过**：DSH 依赖装好了但没构建，插件的 DSH 侧（adapter.ts、history.ts、index.ts、设置页注册）只做了离线校验
  （设置页 bundle 在 Node 里模拟加载并渲染通过），没有在真 Web UI 里点过。
- **adapter 直连上传没验证通**：经 Tailscale 直连上传 75MB 两次都 EPIPE 并把网络打断，和 RWKV-Agent 里记录的现象一致；
  列表/注册/删除接口和"已注册 adapter 推理"是通的。需要上传时用 Cloudflare 前置的地址，或用 `serverPath` 注册服务器上已有的文件。
- **v26 的"重复重试只给一次"按单次请求计**：DSH 每执行一个工具会重新请求一次，跨请求的重试标记没有保存；
  被拒的重复调用不会进 DSH 历史，所以影响只是极端情况下多给一次机会。
- 设置页的 adapter 列表、上传、删除经宿主转发（`/api/rwkv/adapters`，挂在 DSH `/api` 鉴权之后）；经 Tailscale 直连上传大文件仍会卡住。
- 设置页只编辑 volatile 字段（除 `providers` 外全部是），保存后下一次请求生效，不需要重载插件；`providers` 改了要重启 DSH。
- DSH 的 `stop` 参数不支持（会报 `UNSUPPORTED_OPTION`），`temperature` / `maxTokens` 会覆盖对应设置。
