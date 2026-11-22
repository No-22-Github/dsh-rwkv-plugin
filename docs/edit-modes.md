# 四种编辑模式与模块结构

> **TL;DR（分层速读）**
> - 插件支持 `tolerant`（默认）、`hashline`、`line-edit`、`literal` 四种编辑模式，全部共享增量语法闸门与防盲改校验。
> - 纯核心逻辑位于 `src/core/edit-modes/`，DSH 宿主工具包装与会话状态位于 `src/edit-modes/`，并通过 `mode-state.ts` 支持跨 bundle 热切换。
> - 切换 `hashline` 或 `line-edit` 时，插件自动隐藏原生 `edit` 并暴露 `edit_lines` 工具；同时提供 `./hashline` 与 `./line-edit` 独立导出入口。

---

## 1. 四种编辑模式对比

默认模式定义于 [src/core/defaults.ts](../src/core/defaults.ts)（`DEFAULT_EDIT_MODE = 'tolerant'`），可在「设置 → RWKV Agent」中热切换，切换时同步刷新底层工具 schema：

| 模式 | 工具名 | 核心机制 | 适用场景 |
|---|---|---|---|
| **`tolerant`**（默认） | `edit` | 保留原生 `edit`，逐级容错匹配（缩进漂移重排、省略空行/上下文、双锚点防滑窗误命中）+ 增量语法闸门 + 防盲改 | 通用默认，兼容原生 `edit` 语料与日常容错 |
| **`hashline`** | `edit_lines` | `read` 输出自动附 `N:hh\|`（2 位十六进制 FNV-1a 行哈希）；`edit_lines` 校验双端哈希并在失败时局部热刷新 | 需要严格行锚点、减少行号偏移误改的长文件编辑 |
| **`line-edit`** | `edit_lines` | 按 `read` 显示行号执行 `replace` / `insert_after` / `delete`；校验已读状态、文件版本、见过行号与语法闸门 | 纯行号编辑语料与对比实验 |
| **`literal`** | `edit` | 回退 DSH 原生精确字符串匹配 `edit` | A/B 对照基线 |

- `hashline` 与 `line-edit` 同时在 `package.json` 中提供独立子路径导出 `./hashline`（`src/hashline.ts`）和 `./line-edit`（`src/line-edit.ts`），供外部或独立插件入口按需加载。

---

## 2. 解耦结构：`src/core/edit-modes/` vs `src/edit-modes/`

为了保持「核心算法可单测、宿主状态可热切」，编辑系统拆分为两层：

- **纯核心层 `src/core/edit-modes/`**（无 DSH 运行时依赖）：
  - `tolerant.ts` / `hashline.ts` / `line-edit.ts` / `literal.ts`：各模式的纯文本匹配、行哈希计算、补丁应用与冲突判定算法（另有兼容入口 `src/core/tolerant-edit.ts`、`src/core/hashline.ts`、`src/core/line-edit.ts`）。
  - `shared.ts`：四模式共用的参数归一化、行号范围校验与错误格式化辅助函数。
- **宿主层 `src/edit-modes/`**（接通 DSH 工具注册、文件系统与会话态）：
  - `tolerant.ts` / `hashline.ts` / `line-edit.ts` / `literal.ts`（汇总于 `index.ts`）：包装 `read` 与 `edit`/`edit_lines` 的宿主工具处理器。
  - `mode-state.ts`：管理当前激活模式，支持跨 bundle 热切换，并在切换时同步更新工具可见性与 schema。
  - `observations.ts`：记录每个会话对文件的读过状态、文件版本与已见行号范围。
  - `syntax-check.ts`：增量语法闸门，在写入落盘前拦截明显语法错误。
  - `folded-read-guard.ts`：联动上下文折叠状态，拦截未重读的盲改。

---

## 3. 行哈希校验、局部热刷新与语法闸门

### `hashline` 行哈希与 `edit_lines` 操作

- **行哈希标注**：在 `hashline` 模式下，`read` 返回的每一行自动附带 `N:hh|` 前缀（行号 `N` + 基于该行内容的 2 位十六进制 FNV-1a 哈希 `hh`）。
- **三种编辑原语**：`edit_lines` 支持 `replace`（替换起止行）、`insert_after`（在指定行后插入）和 `delete`（删除起止行）。
- **双端哈希校验与局部热刷新**：提交修改时同时校验起始行与结束行的 `N:hh` 锚点；一旦哈希不匹配或被语法闸门拦下，错误响应会直接附带 `target_line ± 5` 的最新带锚点窗口，让模型无需额外再调一次 `read` 即可局部热刷新重试。

### `tolerant` 逐级容错

- 当精确子串匹配失败时，依次尝试：忽略首尾空白与缩进漂移重排、容忍省略空行或中间上下文、双锚点约束防止长文件滑窗误命中。

### 增量语法闸门（`syntax-check.ts`）

- 覆盖扩展名：`.py`、`.js`、`.ts`、`.mts`、`.cts`、`.sh`、`.json`。
- 在写入前对修改后内容做快速语法检查，若引入新语法错误则拒绝写入并给出错误行位置，避免坏代码污染后续轮次。

### 沙箱策略与防盲改联动

- **沙箱写入校验**：四种模式的写入路径统一携带当前会话的 `sandboxPolicy` 校验，遵循只读 / 工作区可写 / 完全放开策略。
- **防盲改（`folded-read-guard.ts`）**：`tolerant`、`hashline`、`line-edit` 均已接通防盲改校验——若某文件的早期 `read`/`write` 输出已被 `auto-fold v2` 或 `worklist` 折叠出活动窗口，直接编辑会被拦截并提示先重读（详见[上下文管理](context-modes.md#4-folded-read-guard-防盲改机制)）。
