# dsh-rwkv-plugin 文档索引

> **L1/L2 渐进式阅读导航**：先看入口与总览（L1），遇到具体模块再按需点开对应专题（L2），避免一次性加载无关细节。

## L1：入口与架构总览

| 文档 | 大致大小 | 职责说明 |
|---|---|---|
| [README.md](../README.md) | ~3.2 KB | 插件定位、快速安装与开发测试命令、核心配置简表、文档入口 |
| [INSTALL.md](../INSTALL.md) | ~3.0 KB | 从源码构建、链接 `../deepseek-harness`、本地联调与安装步骤 |
| [docs/how-it-works.md](how-it-works.md) | ~5.2 KB | 架构总览：整体数据流、原生 vs RWKV 对比、`src/core/` 与 `src/` 分层、核心设计原则 |

## L2：专题设计文档

| 文档 | 大致大小 | 职责说明 |
|---|---|---|
| [docs/wire-and-prompt.md](wire-and-prompt.md) | ~11.2 KB | 字节级提示词拼装、`Assistant:` 无空格铁律、停止符、`agent-fast` 采样、`recover-preamble` 与容错解析、双开关与 `rwkv-trace.jsonl` 排查 |
| [docs/edit-modes.md](edit-modes.md) | ~4.9 KB | 4 种编辑模式（`tolerant` / `hashline` / `line-edit` / `literal`）、`src/core/edit-modes/` 与 `src/edit-modes/` 解耦、行哈希校验与增量语法闸门 |
| [docs/context-modes.md](context-modes.md) | ~5.1 KB | `auto-fold v2`（默认）、`worklist`、`relay`、`full` 上下文管理、`3000` tok 结果截断与 `folded-read-guard` 防盲改机制 |

## 样例参考（按需抽查）

| 文件 | 大致大小 | 说明 |
|---|---|---|
| [docs/examples/README.md](examples/README.md) | ~1.6 KB | 提示词样例目录说明 |
| [docs/examples/rwkv-agent-1-step-with-thinking.txt](examples/rwkv-agent-1-step-with-thinking.txt) | ~7.2 KB | 单步带思考的完整提示词样例 |
| [docs/examples/rwkv-agent-2-second-turn-final-answer.txt](examples/rwkv-agent-2-second-turn-final-answer.txt) | ~13.0 KB | 第二轮最终作答的完整提示词样例 |

## 按场景快速定位

- **想改提示词或排查输出解析 / 重复拦截**：先看 [how-it-works.md](how-it-works.md)，再读 [wire-and-prompt.md](wire-and-prompt.md)（注意改提示词需同步重采训练数据）。
- **想改 `edit` / `edit_lines` 行为或行哈希逻辑**：看 [edit-modes.md](edit-modes.md)。
- **想调上下文窗口、折叠阈值或防盲改**：看 [context-modes.md](context-modes.md)。
