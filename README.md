# dsh-rwkv-plugin

把 RWKV-7 G1 Agent 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：注册一个 `rwkv` 模型提供方，RWKV 可以当主 Agent，也可以作为子 Agent 给 DeepSeek 主 Agent 调用。

**安装见 [INSTALL.md](INSTALL.md)。**

## 特性

- **后端**：rwkv_lightning CUDA（支持 adapter / state）和 iRWKV 的续写接口。
- **Agent 循环**：从 RWKV-Agent 的 Go harness 移植，提示词逐字节一致（有单测对照）。工具调用用 XML 信封，默认开思考，采样默认 agent-fast。
- **兜底**：解析容错（先说话再调用、OpenAI 外壳、多余括号、字符串化参数）、重复调用拦截、强制收尾、作答阶段兜底、复读截断。
- **工具**：DSH 的工具（read / write / edit / glob / grep / bash / web）以模型训练时熟悉的名字和参数呈现，调用时再翻译回去。
- **设置页**：设置里的「RWKV」分区，可以管理模型、选用或上传 adapter、调整运行参数，保存后下一次请求就生效。

## 已知限制

- 经 Tailscale 直连上传大 adapter 会卡住，大文件请走 Cloudflare 前置的地址。
- DSH 的系统提示词不发给 RWKV，额外约束写在 `taskContract`。
- 重复调用的「重试一次」按单次请求计，跨请求不记忆。
