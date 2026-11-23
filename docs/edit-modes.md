# 三种编辑模式与模块结构

> **TL;DR（分层速读）**
> - 插件支持 `tolerant`（默认）、`line-edit`（Anchored Batch Line-Edit v2）、`literal` 三种编辑模式，共享增量语法闸门与防盲改校验。
> - 纯核心逻辑位于 `src/core/edit-modes/`，DSH 宿主工具包装与会话状态位于 `src/edit-modes/`。
> - 切换 `line-edit` 时，插件自动隐藏原生 `edit` 并暴露语义锚点批量工具 `edit_lines`（向下兼容单 hunk 传参，同时自动将跨 harness 的 `edit`/`edit_file` 调用路由至 `edit_lines`）。
> - 原先的 `hashline`（`N:hh|`）模式已移除：在原始 RWKV-7 7.2B 权重实测中，2 位随机十六进制行哈希的回忆命中率为 `0/64 (0.0%)` 且会破坏线性状态中的行号追踪（`±5` 行内命中率从 `95.7%` 跌至 `1.6%`），同时每 140 行增加约 `397` 个噪声 token；而语义首行锚点（`start_text`）在 60–320 行窗口 + 4,500 token 干扰下实测命中率为 `62/62 (100.0%)`。

---

## 1. 三种编辑模式对比

默认模式定义于 [src/core/defaults.ts](../src/core/defaults.ts)（`DEFAULT_EDIT_MODE = 'tolerant'`），可在「设置 → RWKV Agent」中热切换：

| 模式 | 工具名 | 核心机制 | 适用场景 |
|---|---|---|---|
| **`tolerant`**（默认） | `edit` | 保留原生 `edit`，逐级容错匹配（缩进漂移重排、省略空行/上下文、双锚点防滑窗误命中）+ 增量语法闸门 + 防盲改 | 通用默认，兼容原生 `edit` 语料与日常容错 |
| **`line-edit`** | `edit_lines` | Anchored Batch v2：原子多 hunk `edits[]` + 语义首行锚点 `start_text`（可选 `end_text`）三级自愈 + 自动重排缩进/去行号前缀/省略号与边界重复守卫 + `≤200` 行 `read` 上限 + 中性窗口头 `=== path ===` | 专为 RWKV-7 线性状态设计的防偏移批量行编辑 |
| **`literal`** | `edit` | 回退 DSH 原生精确字符串匹配 `edit` | A/B 对照基线 |

- `line-edit` 在 `package.json` 中提供独立子路径导出 `./line-edit`（`src/line-edit.ts`），供外部或独立插件入口按需加载。

---

## 2. 解耦结构：`src/core/edit-modes/` vs `src/edit-modes/`

为了保持「核心算法可单测、宿主状态可热切」，编辑系统拆分为两层：

- **纯核心层 `src/core/edit-modes/`**（无 DSH 运行时依赖）：
  - `tolerant.ts` / `line-edit.ts` / `literal.ts`：各模式的纯文本匹配、语义锚点三级自愈、原子多 hunk 补丁应用与冲突判定算法（另有兼容入口 `src/core/tolerant-edit.ts`、`src/core/line-edit.ts`）。
  - `shared.ts`：共用的行拆分、中性窗口渲染（`=== path (lines X-Y of Z) ===`）、已见行号追踪（含批量 `seenAfterBatchEdit`）与沙箱策略辅助函数。
- **宿主层 `src/edit-modes/`**（接通 DSH 工具注册、文件系统与会话态）：
  - `tolerant.ts` / `line-edit.ts` / `literal.ts`（汇总于 `index.ts`）：包装 `edit`/`edit_lines` 的宿主工具处理器。
  - `observations.ts`：记录每个会话对文件的读过状态、文件版本与已见行号范围。
  - `syntax-check.ts`：增量语法闸门，在写入落盘前拦截明显语法错误。
  - `folded-read-guard.ts`：联动上下文折叠状态，拦截未重读的盲改。

---

## 3. Anchored Batch `line-edit` 关键机制

- **语义锚点三级自愈（`start_text` / `end_text`）**：
  1. **L1 精确行校验**：目标 `start_line` 相似度 `>= 0.90` 直接命中。
  2. **L2 局部 `±15` 行唯一重定位**：精确匹配（`>= 0.98`）严格优先于模糊候选；若局部存在多个精确命中则拒绝写入并返回候选行号；唯一命中则整体平移区间并记录 `Auto-aligned` 提示。
  3. **L3 全文件唯一兜底**：对非平凡锚点（规范化长度 `>= 10`）执行全文件唯一匹配兜底；可选 `end_text` 同样支持 `±10` 行结束行自愈。
- **原子多 hunk `edits[]`（向下兼容单 hunk）**：所有 hunk 按改前坐标统一校验、检查重叠后自底向上原子应用，最后做一次增量语法检查再落盘；单 hunk 顶层参数 `{ file_path, start_line, end_line, start_text?, new_text }` 同样直接支持。
- **`≤200` 行 `read` 上限与中性窗口头**：`line-edit` 模式下 `result-budget.ts` 将单次 `read` 限制在 `≤200` 行（RWKV-7 实测 `≤200` 行内 `±5` 行定位召回 `95.7%`，320 行骤降至 `0%`）；窗口头采用中性格式 `=== path (lines X-Y of Z) ===`，避免旧 `[File: ...]` 头诱发 RWKV-7 输出 SWE-agent `str_replace_editor`。
- **已验证锚点免重读**：若已观测版本的文件因 `auto-fold` / `worklist` 折叠出活动窗口，且所有 hunk 都携带非平凡并校验通过的 `start_text`，允许直接应用而无需浪费一轮重读；未读文件或无锚点盲改仍严格拦截。
- **防御守卫**：自动缩进重排（`reindent`）、剥离误抄的 `N: ` 行号前缀、拦截 `// ... existing code ...` 省略占位符、拦截 no-op 与相邻边界行重复，并在失败时返回 `±8` 行上下文与候选行位置。

---

## 4. `tolerant` 逐级容错与增量语法闸门

- **`tolerant`**：当精确子串匹配失败时，依次尝试忽略首尾空白与缩进漂移重排、容忍省略空行或中间上下文、双锚点约束防止长文件滑窗误命中。
- **增量语法闸门（`syntax-check.ts`）**：覆盖 `.py`、`.js`、`.ts`、`.mts`、`.cts`、`.sh`、`.json`，写入前拦截新引入的语法错误。
- **沙箱写入校验**：所有模式的写入路径统一携带当前会话的 `sandboxPolicy` 校验。
