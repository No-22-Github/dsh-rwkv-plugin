# dsh-rwkv-plugin

把 RWKV-7 G1 Agent 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：注册一个 `rwkv` 模型提供方，RWKV 可以当主 Agent，也可以作为子 Agent 给 DeepSeek 主 Agent 调用。

**安装见 [INSTALL.md](INSTALL.md)。** 和原生接入相比的差距（裁剪的提示词、8 个工具、每种兜底）见 [docs/vs-native.md](docs/vs-native.md)。

## 特性

- **后端**：rwkv_lightning CUDA（支持 adapter / state）和 iRWKV 的续写接口。
- **Agent 循环**：从 RWKV-Agent 的 Go harness 移植（工具调用用 XML 信封、默认开思考、采样默认 agent-fast）。
- **兜底**：解析容错（先说话再调用、OpenAI 外壳、多余括号、字符串化参数）、重复调用拦截、强制收尾、作答阶段兜底、复读截断。
- **RWKV Agent 预设**：bash、read、write、edit、glob、grep、web_search、web_fetch，工具名和参数都用 DSH 原样。系统提示词用 DSH 的 Standard 提示词，删掉讲没挂工具和界面的 10 段（apply_patch、后台 job、goal、schedule、workflow、subagent 两段、present、DSH checkout 路径、Web GUI），保留 persona、@路径、exit code 和这 8 个工具相关的 11 段；后面接 RWKV 的动作协议和工具清单。模型若写训练时的名字（read_file、list_files…）或参数（path、old_text…）会自动认回来。旧的训练名 + Go 对齐提示词仍可在插件配置里设 `toolNames: trained` 用来对比。
- **设置页**：设置里的「RWKV」分区，可以管理模型、选用或上传 adapter、调整运行参数，保存后下一次请求就生效。

## 已知限制

- DSH 的运行时上下文只转给 RWKV 工作目录和文件沙箱策略两段，审批策略、DSH 源码路径、Web GUI 地址不发；额外约束写在 `taskContract`。
- 重复调用的「重试一次」按单次请求计，跨请求不记忆。
- **DSH 的问题：预设管不住全局注册的东西。** 在 DSH 里全局注册的工具（`working_directory`、`load_workspace_dependencies`、本插件的 `rwkv_agent`）、系统提示词段（DSH 源码 checkout 路径、Web GUI、`rwkv_agent` 委派说明）和运行时上下文，不管选哪个模式都会带上，RWKV Agent 预设没法把它们排除掉。插件只能在拼 RWKV 提示词时自己过滤：只留 8 个工具、删掉这些段、上下文只留两段。所以会话「轨迹」页看到的工具、系统提示词和上下文都比 RWKV 实际收到的多，要看实际内容请用轨迹目录（见 [docs/vs-native.md](docs/vs-native.md) 第 6 节）。
