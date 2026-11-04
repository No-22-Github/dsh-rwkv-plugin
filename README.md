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

- DSH 的 runtime context（工作目录等 developer 消息）默认不发给 RWKV；额外约束写在 `taskContract`。
- 重复调用的「重试一次」按单次请求计，跨请求不记忆。
