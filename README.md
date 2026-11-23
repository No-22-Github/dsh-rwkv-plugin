# dsh-rwkv-plugin

把 RWKV-7 G1 续写模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），注册 `rwkv` 模型提供方（主 Agent 或 `rwkv_agent` 子 Agent）。会话、工具、沙箱与审批仍由 DSH 管理，插件只负责「对话消息 ↔ 整段文本」的翻译、格式解析与兜底策略，不持久化业务状态。

## 快速安装与开发命令

> 需要 DSH **0.2.2-alpha.3+**（源码编译与联调细节见 [INSTALL.md](INSTALL.md)）。

- **DSH 桌面端安装**：侧栏**插件 → 添加插件**，填入 `github:No-22-Github/dsh-rwkv-plugin`，安装后启用；在**设置 → RWKV Agent** 添加后端地址与模型即可。
- **本地开发与验证**：

```bash
npm run typecheck   # 类型检查（tsc --noEmit）
npm run build       # 构建 bundle 到 lib/
npm test            # 运行全部单元测试（node --test test/*.test.ts）
npm run headless    # headless 评测入口
npm run smoke       # 冒烟检查
```

## 核心配置简表

配置可在「设置 → RWKV Agent」中调整，保存即生效（默认值定义于 `src/core/defaults.ts`）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| **后端与权重** | `rwkv_lightning` / `iRWKV` | 支持可选请求级 `adapterId` 与上传初始 `stateId`（服务重启需重传）。 |
| **采样预设** | `agent-fast` | `temperature=0.5`、`topP=0.7`、`topK=65536`、适度惩罚；DSH 仅覆盖温度。 |
| **编辑模式** | `tolerant` | 可选 `tolerant`（容错 `edit`）、`line-edit`（语义锚点批量 `edit_lines`）、`literal`。 |
| **上下文管理** | `auto-fold`（v2） | 历史轮立即压缩至 `≤2k`，当前轮 `13.5k→9k` 原地遮蔽；可选 `worklist` / `relay` / `full`。 |
| **单轮步数 / 重试** | `maxSteps=15` | 连续失败封禁 `2` 次、格式重问 `2` 次；超限后撤工具强制收尾。 |
| **兜底开关** | `outputRepairs` / `guards` 全开 | 开发者区可关闭两者以测模型原样能力，并查看 `rwkv-trace.jsonl` 统计。 |

## 已知边界

- 单步仅调一个工具，不支持并行工具调用。
- 不走 DSH 内置压缩；图片与附件转为 `[image]` / `[file]` 占位符。
- **改任何会影响模型所见提示词的代码，必须同步重新生成训练数据**（训练管线直接 import 本插件源码）。

## 文档导航

完整设计与排查文档已按 L1/L2 分层整理，请从 **[docs/INDEX.md](docs/INDEX.md)** 按需查阅：

- 架构总览与数据流：[docs/how-it-works.md](docs/how-it-works.md)
- 提示词格式与解析兜底：[docs/wire-and-prompt.md](docs/wire-and-prompt.md)
- 三种编辑模式与语法闸门：[docs/edit-modes.md](docs/edit-modes.md)
- 上下文管理与防盲改：[docs/context-modes.md](docs/context-modes.md)
- 完整提示词样例：[docs/examples/README.md](docs/examples/README.md)

## 致谢与许可

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）、[RWKV](https://github.com/BlinkDL/RWKV-LM)（Apache-2.0）、[rwkv-tokenizer](https://github.com/cahya-wirawan/rwkv-tokenizer)（MIT OR Apache-2.0）与 [rwkv-tokenizer-go](https://github.com/No-22-Github/rwkv-tokenizer-go)（Apache-2.0）。本项目以 [MIT](LICENSE) 发布。
