# RWKV Agent 与原生接入的差距

「原生接入」指 DeepSeek 这类模型在 DSH 里的正常用法：走对话接口，用 Standard 预设，系统提示词和工具 schema 原样发给模型，模型自己用接口的工具调用字段发起调用。

RWKV 通过续写接口接入：插件把整段对话拼成一段文本，让模型往下写，再从写出来的文字里把工具调用解析出来，交回 DSH 执行。下面说明这样做和原生接入相比少了什么、多了什么。

## 1. 系统提示词：裁剪过

RWKV 看到的 `System:` 块由三部分组成：

| 部分 | 内容 | token |
|---|---|---|
| DSH 系统提示词 | Standard 提示词 21 段中保留的 11 段 | 336 |
| 动作协议 | 怎样调用工具、怎样直接回答（见下文） | 约 164 |
| 工具清单 | 8 个工具的名字、描述、参数 | 831 |
| **合计** | | **1331** |

token 用 rwkv-tokenizer-go 计数，按 DSH 的 Standard 快照算。实际会有少许出入，因为模型名不同，bash 参数也可能不同。

**保留的 11 段**：DeepSeek Harness 身份句、persona（"You are a coding agent powered by …"）、@路径说明、bash 的 exit code、read、write、edit（读后再改）、glob、grep、web_search、web_fetch。

**删掉的 10 段**（共 1045 token，讲的都是这个预设没挂的东西）：

1. apply_patch
2. 后台 job
3. goal
4. schedule
5. workflow
6. subagent：并行委派
7. subagent：多个 Agent 共享文件
8. present
9. DSH 源码 checkout 路径
10. Web GUI

第 9、10 段是 DSH 全局注册的，不论用哪个预设都会出现，所以插件按段落开头的几个字把它们去掉（[src/core/dsh-prompt.ts](../src/core/dsh-prompt.ts)）。DSH 改了这几段的措辞，就要同步更新这里的开头句列表。

**动作协议**是 RWKV 训练时用的格式，原生接入没有这一段：

```
Choose one action:
- If new tool evidence is needed, output exactly one tool call and nothing else:
  <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>
- Otherwise, answer the user directly in ordinary text without an envelope.
Greetings, thanks, casual conversation, and questions that do not need new tool evidence must be answered directly. Never invoke tools merely because they are available.
After a Tool result, make the same choice again: call one tool if more evidence is needed, or answer directly.
Never mix commentary with a tool call. Close your thinking with </think>, then output exactly one action. Do not use Markdown fences around tool JSON or emit role labels.
Never invent file content.
```

**运行时上下文只发两段**：DSH 会在用户消息后面追加一条运行时上下文，内容变化时才追加新的一条，共 5 段，约 170 token。原生模型看到的是全部 5 段；插件只转给 RWKV 其中两段，约 64 token：

| 段 | 内容 | RWKV |
|---|---|---|
| working-directory:current | 当前工作目录 | 保留（路径修复也靠它，见 3.6 节） |
| sandbox:policy | 文件沙箱策略：只读 / 工作区可写 / 完全放开 | 保留 |
| approval:policy | 审批策略：越权操作会不会弹窗问用户 | 删 |
| harness:source | DSH 源码 checkout 路径 | 删 |
| app:web-surface | Web GUI 地址 | 删 |

保留的两段作为一条附注放在用户消息之后，不会被当成本轮任务。额外的约束可以写在插件设置的 `taskContract` 里，会附在 System 块末尾。

注意：裁剪只发生在插件拼 RWKV 提示词这一步，DSH 自己的会话记录不受影响。所以会话「轨迹」页的「上下文」一行仍会显示全部 5 段，「初始系统提示词」也是删段之前的全文。要看 RWKV 实际收到了什么，见第 6 节。

## 2. 工具：只有 8 个

| 工具 | 说明 |
|---|---|
| bash | 跑命令（Windows 上没有，预设里禁用了） |
| read / write / edit | 读、写、改文本文件 |
| glob / grep | 按路径找文件、按内容搜索 |
| web_search / web_fetch | 网页搜索、抓取网页 |

名字、描述、参数都用 DSH 原样的，没有改成训练时的名字。参数不是以 JSON Schema 的形式给出的，而是压平成一行占位说明，例如 `{"file_path":"Path to read, …","offset":"optional number","limit":"optional number"}`。

Standard 预设里有、RWKV Agent 没挂的东西：

- **AGENTS.md 等项目说明**（agent-instructions）、**当前时间**（time-context）
- **apply_patch**、**read_image**（看图）
- **后台 job**、**schedule**、**goal**、**skill**
- **plan 模式**、**todo**、**向用户提问**（ask_user_question）
- **subagent / subagent_fork / workflow**（RWKV 自己不能再往下委派）
- **present**、插件管理
- **上下文压缩**（compaction 和超长工具结果裁剪）：没有压缩，长会话迟早撑满上下文窗口（默认按 32768 token 报给 DSH），iRWKV 超出后会直接返回 400。

## 3. 兜底手段

原生模型由接口保证输出格式，插件不用操心。RWKV 是自由续写，所以插件在每次请求内部做了下面这些兜底，DSH 看不到这些过程。一次 DSH 请求在插件里可能对应 RWKV 的好几次生成。

### 3.1 生成过程中

1. **复读截断**：同一段话反复出现时，客户端提前掐断这次生成（`loopGuard`，默认开）。
2. **思考里引用了停止符**：停止符是 `</tool_call>`。如果模型还在 `<think>` 里，只是在思考中提到了这个标签，插件就把它补回去接着生成，最多续 4 次。
3. **思考写满了 token 上限**：插件在断开的地方替它补上 `</think>`，再给 1024 token 让它说出动作，而不是从头重问一遍、再写一遍同样长的思考。

### 3.2 解析模型输出

能修的格式错误直接修好（[src/core/parse.ts](../src/core/parse.ts)）：

1. **先说一句话再调用**：一句话、换行、再接一个完整调用时，去掉前面那句话（recover-preamble）。只接受末尾单独的一个调用，引用的示例、多个调用、代码块里的内容都不算。
2. **OpenAI 外壳**：`{"type":"function","function":{...}}` 拆掉外壳。
3. **多余的 `}`**：完整对象后面多出的右括号去掉。
4. **单元素数组**：`[{...}]` 拆开。
5. **字段名写错**：`tool` / `cmd` / `function` 当作 `name`，`args` / `parameters` / `input` 当作 `arguments`；没写 `arguments` 时，顶层其余字段当作参数。
6. **arguments 是字符串**：再按 JSON 解析一层。
7. **只写了路径**：`{"path":...}` 没有工具名时，当作读文件；工具名写成 `reader` / `file_reader` 也当作读文件。
8. **外面多套了一层**：外面包着 `<tool_response>` / `<tool_result>` / `<tool_calls>` 时，取出里面的调用。
9. **自闭合标签**：`<read_file path="a.txt"/>` 这种写法认作调用。
10. **清理最终回答**：去掉残留的思考块、生成没停住时写出的 `User:` 等角色标签，以及 `✿` 之后的内容。
11. **花括号 JSON 不算调用**：没有 `<tool_call>` 包着的 JSON 当作普通回答，所以用户要 JSON 时能正常拿到。

修不好的输出分成五类：思考没闭合、超长、JSON 解析不了、结构不对、空输出。这些交给 3.4 节的重问处理。

### 3.3 工具调用检查

调用交给 DSH 执行之前，插件先过一遍检查（[src/core/agent.ts](../src/core/agent.ts) 的 `gateToolCall`）：

1. **工具名纠正**：先精确匹配，再不分大小写，再查别名（`str_replace` → edit、`shell` → bash、`ls` → glob 等）。训练时的名字（read_file、write_file、edit_file、list_files、search_text）也会认回 DSH 的名字。认不出时回一条失败结果，提示它改选别的工具。
2. **参数名纠正**：别名改成 DSH 的参数名，例如 `path` → `file_path`、`old_text` → `old_string`、`query` → grep 的 `pattern`、`start_line` / `end_line` → `offset` / `limit`。web_search 只给了一个字符串时包成 `queries` 数组；bash 没写 `description` 时用命令的第一行补上。
3. **数值宽松**：`"5"` 转成 5，`"true"` 转成 true，`"6,412"` 去掉千分位。结构不对的参数原样交给工具，让工具自己报错。
4. **重复成功调用**：和本轮已经成功过的调用完全一样时（参数先排好顺序再比较）：
   - 第一次：拦下来，提示"结果已经在上面了；要改已读过的文件就直接用 edit 或 write"，再给一次决策机会。
   - 第二次：强制收尾（见 3.5 节）。
5. **重复失败调用**：和之前失败过的调用一样，并且这期间没有新的成功结果，直接强制收尾。
6. **连续失败封禁**：同一个工具连续失败 2 次（`maxConsecutiveFailures`）后，再调它就拒绝，提示换工具或者直接回答。read 失败时还会提示"路径不确定就先用 glob 或 grep"。
7. **拦截上限**：同一次请求里被拦超过 3 次，强制收尾。

### 3.4 格式重问

输出解析不了，或者是空的，就按出错类型附一句纠正提示重新生成，最多 2 次（`protocolRetries`）：

- 思考没闭合："别重新开始思考，马上用 `</think>` 收住，然后输出一个动作。"
- 超长："回答被截断了，简短得多，直接给动作。"
- 其他："上一条输出无效，要么直接回答，要么只输出一个工具调用。"

重问用完后：本轮已经调过工具，就强制收尾；还没调过，就直接给出兜底总结（3.5 节第 4 步）。

### 3.5 强制收尾（作答阶段）

触发条件：

- 本轮工具调用到了 12 次（`maxSteps`）
- 重复调用第二次被拦
- 用了 `no_tool` 但没写回答
- 重问次数用完、或者被拦次数超限

做法是撤掉工具，要求它只根据已有的工具结果作答，依次尝试：

1. 直接要求作答。
2. 不行，补一句"现在就用 Markdown 回答，禁止调用工具"再生成一次。
3. 关掉思考时，再试一次，并预填一个开头（中文题是"根据上面的工具结果，"），让模型接着这句话写下去。开思考时没有这一步。
4. 都不行，就从最后一次输出里捞出工具调用之前的文字（salvage）。像"让我再查一下"这种计划性的话不算回答。
5. 还是没有，插件自己写一段兜底总结：列出本轮调过哪些工具、各自成功还是失败，再给一句建议，例如"可以换个说法，或者告诉我具体的文件或网址"。这段总结不会编造事实。

如果是因为格式问题进的收尾（不是步数或重复这类规则拦下的），这时模型给出的合法调用会照常执行，不会扔掉。

### 3.6 其他

1. **工具结果截断**：单条结果超过 12000 字符（`maxResultChars`）时，保留前 80% 和末尾 20%，中间注明省略了多少字符。
2. **调用后的提醒**：每条工具结果后面附一句提醒，让它"证据够了就回答，只为缺的那个事实再调工具，不要重复成功的调用"。这句只在当前这一轮出现，历史轮次里没有。
3. **路径修复**（[src/paths.ts](../src/paths.ts)）：G1 抄工作目录时常常漏掉最后一级目录（把 `…/task/ws/a.py` 写成 `…/task/a.py`）。只在原路径不存在、修复后的路径存在时才改，正确的路径、新建的文件和故意指向工作区外的路径都原样放行。
4. **adapter 自动就位**：rwkv_lightning 上没有配置的 adapter 时，自动上传本地文件或注册服务器路径。推理服务重启后会重新传。

### 3.7 开关：关掉兜底测模型本身

兜底会改变模型之后看到的内容：DSH 存下来的是修复后的调用，插件每一步又从 DSH 的记录重建历史，所以模型在历史里看到的是一串它自己没写过的正确调用。测"模型自己能做到什么"时要把兜底关掉。设置页的运行参数里有两个开关，默认都开：

| 开关 | 管哪些 | 关掉后 |
| --- | --- | --- |
| **修正模型输出**（`outputRepairs`） | 3.2 节的格式修复，3.3 节第 1–3 条（工具名、参数名、数值），DSH 参数值修复（`glob` 补 pattern、`read` offset 0 改 1、pattern 数组、删掉 schema 外的键），3.6 节第 3 条路径修复 | 只认标准写法 `<tool_call>{"name":…,"arguments":{…}}</tool_call>`；需要修才能解析的输出算格式错误；工具名必须和清单完全一致，否则回"未知工具"；参数原样交给 DSH，错了由 DSH 报错 |
| **插件干预**（`guards`） | 3.1 节第 3 条（思考写满时替它收住），3.3 节第 4–6 条（重复拦截、连续失败封禁），3.4 节重问，3.5 节的重问、预填开头、salvage 和兜底总结 | 模型输出什么就是什么：解析不了的输出原样作为回答交给 DSH（`via: raw`），不重问、不拦截 |

两个开关都**不管**的东西：
- 提示词怎么拼：转义、空思考、提醒语、运行时上下文、工具目录。这些是协议，训练数据要和它一致，不算兜底。
- `maxSteps` 步数上限和"未知工具"的失败结果：前者是预算，后者相当于环境给的回答。
- 复读截断：单独由 `loopGuard` 控制。
- 训练名模式（`toolNames: trained`）的参数映射：那是名字翻译，不是修复。

两个开关在设置 → RWKV → 开发者里。

**统计原始合格率**：每次生成的记录里有 `outcome`（`run`、`final`、`re-ask`、`duplicate-retry`、`closeout`、`rejected unknown-tool`、`raw` 等）和 `repairs`（这次输出用到的全部修复）两个字段；每次 DSH 请求结束时还会追加一条 `stage: "step"` 记录，包含交给 DSH 的决定、修复项（含 `path_repaired`）和生成次数。设置页开发者区直接显示统计；保存到磁盘的轨迹也可以用下面的命令汇总：

```bash
node scripts/trace-stats.ts <轨迹目录>
```

脚本按模型输出两个比例：
- 原样可用的生成：没修、没被拦、没被重问，模型写的直接就用上了
- 一次就定下来的请求：第一次生成就交给了 DSH，而且没有任何修复

开着兜底时这两个数和通过率之间的差，就是插件替模型扛下来的那部分。设置页的开发者区会直接显示同样的统计。

## 4. 其他差距

- **一步只调一个工具**：每次请求最多一个工具调用，不能像原生模型那样一次并行发出多个。
- **只认文字**：图片和文件附件换成 `[image]` / `[file]` 占位。
- **不支持自定义停止符**：停止符由插件管，DSH 传 `stop` 会直接报错。
- **采样参数**：DSH 只能覆盖温度；top_p 和各项惩罚用插件设置（默认 agent-fast）。
- **token 用量**：后端没返回用量时，按字符数除以 3 估算。
- **计数不跨请求**：重复调用的"给一次重试"、重问次数、被拦次数都只在单次 DSH 请求内计数，下一次请求重新从历史推算，不会记住。
- **思考过程**：开思考时，思考内容作为 reasoning 显示在 DSH 里；插件内部的重问会在里面标一行 `[harness: …]`。

## 5. 和原生接入一样的地方

- 工具都由 DSH 执行，沙箱、审批和工具结果的保存和原生接入一样。
- 会话历史存在 DSH 里，可以中途和别的模型互相切换；别的模型留下的工具调用会按 RWKV 能看懂的样子重新呈现。

## 6. 排查：怎么看 RWKV 实际收到的内容

DSH 界面里看到的都是 DSH 自己的记录，和 RWKV 实际收到的不完全一样：

| 界面上看到的 | RWKV 实际收到的 |
|---|---|
| 「初始系统提示词」：DSH 拼好的全文 | 删掉 10 段后的 11 段，加动作协议和工具清单 |
| 「上下文」：5 段运行时上下文 | 只有工作目录和沙箱策略两段，作为附注 |
| 工具 schema：完整 JSON Schema | 压平的一行占位说明，只有 8 个工具 |
| 助手的思维链 | 多次生成拼在一起，中间的重问标着 `[harness: …]` |

要看原始内容，打开对话视图里的「RWKV」标签页。插件把每次生成都记在内存里（DSH 重启后清空），所以这个标签页、设置页的统计和导出默认就能用。要长期保存，在设置 → RWKV → 开发者里勾选 **把轨迹保存到磁盘**（配置项 `recordTraces`，默认关）。轨迹目录（`traceDir`）留空时写到 `$DSH_HOME/rwkv-traces`，也就是默认的 `~/.dsh/rwkv-traces`。只填目录、不勾选，不会写磁盘。

内存里最多保留最近 100 个会话、约 1 亿字符，超出时先丢最久没更新的会话。

- **「RWKV」标签页**和「对话」「轨迹」并列，排版和原生轨迹页一样：每行是一次生成，左边是彩色小标签，右边是一行预览；每次 DSH 请求后面跟一行，写明交给 DSH 的是什么。每行会标出：
  - 插件怎么处理的：执行、作答、重问、重复拦截、强制收尾、原样输出
  - 用了哪些修复
  - 每次 DSH 请求最后交了什么给 DSH

  原样可用的标签是紫色，用到兜底的是橙色，原样输出或被拒的是红色。点一行，右侧会打开详情面板，分「概述 / 原始输出 / 提示词」三页。DSH 自带的轨迹页不能插入这些内容，所以单独做了这个标签页。
- **设置页的开发者区**有兜底统计、会话列表（内存和磁盘里的都有，每个会话都能展开看），以及导出功能。
- **导出**是 JSONL 文件，每行一个任务，包含：
  - `records`：全部原始记录，按时间排序，包括重问、被拦下的生成和会话标题这类附带请求
  - `text`：最后一次生成的完整 RWKV 文本，历史步骤的思考是空的，和发给模型的一样
  - `textWithThinks`：把每个历史步骤当时真实写的思考填回去的版本。记录完整时才有；中途才开始记录、或者最后一条记录缺失时没有
  - `stats`：这个任务的兜底统计

  DSH 自带的会话导出（ZIP 或 Markdown）是 DSH 视角的记录：调用是修复后的，思维链是多次生成拼在一起的，没有 RWKV 的提示词原文。两者不重复。

每次生成记一条（保存到磁盘时写进 `<轨迹目录>/<会话 id>.jsonl`，一行一条），包含：
- 发给 RWKV 的提示词原文（`prompt`）和模型原始输出（`output`）
- 停止原因
- 解析结果（`action`，例如 `tool write`、`final`、`error decode`）
- 插件怎么处理的（`outcome`）和用了哪些修复（`repairs`）

每次 DSH 请求结束时，再追加一条 `stage: "step"` 的汇总记录，见 3.7 节。思维链里出现 `[harness: re-ask]` 这类标记时，可以在 RWKV 标签页里找到被重问的那次生成原本写了什么。
