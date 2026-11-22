# 上下文管理、结果截断与防盲改

> **TL;DR（分层速读）**
> - 插件不走 DSH 内置压缩，默认启用 `auto-fold v2`（历史轮立即压缩至 `≤2k`，当前轮 `13.5k → 9k` 原地遮蔽、`14.5k` 阶段归档），另可选 `worklist` / `relay` / `full`。
> - 所有工具结果在落盘/进历史前用 vendored `rwkv-tokenizer` WASM 精确截断至 `3000` token，并附溢出文件路径。
> - 一旦旧 `read`/`write` 被折叠出窗口，`folded-read-guard` 会拦截未重读的直接修改，防止模型凭记忆盲改。

---

## 1. 四种上下文管理模式

默认值定义于 [src/core/defaults.ts](../src/core/defaults.ts)（`DEFAULT_HISTORY_MODE = 'auto-fold'`），可在「设置 → RWKV Agent → 开发者 → 上下文管理模式」中切换：

| 模式 | 核心策略 | 适用场景 |
|---|---|---|
| **`auto-fold`**（v2，默认） | 历史轮立即压缩至 `≤2000` tok；当前轮触发 `13500` tok 时原地遮蔽旧结果回落到 `9000` tok；触顶 `14500` tok 做无 Git 阶段归档 | 默认通用长程任务，无需额外工单工具 |
| **`worklist`** | 主动工单模式，暴露 `todo_plan` / `todo_update` 检查点工具，按任务阶段做 epoch 折叠与提醒 | 显式多阶段复杂任务、工单训练语料 |
| **`relay`** | 轮级接力卡模式，历史轮摘要为接力卡（`relayBudgetTokens=8000`、`relayCardMaxTokens=768`），由 `src/core/relay.ts` 与 `src/relay-store.ts` 管理 | 极长多轮对话接力 |
| **`full`** | 完整保留对话历史，不做上下文折叠（仍受 `3000` tok 工具结果截断保护） | 短任务或无折叠对照基线 |

---

## 2. `auto-fold v2` 与 `worklist` 折叠机制

由 [src/core/worklist.ts](../src/core/worklist.ts)、[src/core/fold-pairs.ts](../src/core/fold-pairs.ts) 与 [src/core/fold-window.ts](../src/core/fold-window.ts) 协同完成（训练管线直接复用同一套实现）：

1. **历史用户轮结束立即压缩（`backboneMaxTokens=2000`）**：
   - 已完成的上一轮对话在进入新一轮时立即折叠为骨干摘要（`foldCompletedTurnCompact`），保留首轮 `runtime-context`、`cwd`、`note`，并附带 `[Modified files in this turn: ...]` 修改文件清单。
2. **当前轮原地遮蔽（`13500 → 9000`）**：
   - 当活动窗口达到 `DEFAULT_WORKLIST_BUDGET_TOKENS = 13500` 时，从较早的 `(call, result)` 对开始原地遮蔽工具结果，直到窗口回落到 `DEFAULT_WORKLIST_EPOCH_TARGET_TOKENS = 9000`。
   - **免遮与保底规则**：结果 `< 250` token（`DEFAULT_WORKLIST_EXEMPT_RESULT_TOKENS`）免于遮蔽；保底保留最近 `3` 对完整交互（`DEFAULT_AUTOFOLD_KEEP_RECENT_PAIRS = 3`）；另支持将最近一次未修改文件的 `read` 钉选保留（上限 `MAX_PINNED_UNEDITED_READ_TOKENS = 2400`）。
3. **硬上限安全阀（`hardCapTokens = 14500`）**：
   - 若原地遮蔽后仍逼近 `DEFAULT_AUTOFOLD_HARD_CAP_TOKENS = 14500`（`hardSlack = 1000`），触发无 Git 阶段归档，确保完整 prompt 始终落在 RWKV 的甜点窗口内。
4. **`worklist` 主动工单扩展**：
   - 开启 `worklist` 时追加 `todo_plan` / `todo_update`（[src/core/todo-state.ts](../src/core/todo-state.ts)），在 `8000`～`12000` token 区间按冷却步数发送 `init` / `checkpoint` 提醒，引导模型主动沉淀已验证路径与结论并触发 epoch 跳转折叠。

---

## 3. `3000` token 工具结果截断

在工具执行完的那一刻，由 [src/result-budget.ts](../src/result-budget.ts) 截断一次，使 DSH 记下的就是模型看到的（训练管线挂同一函数）：

- **精确计数**：使用 [src/tokenizer.ts](../src/tokenizer.ts) 内置的 vendored `rwkv-tokenizer` WASM（词表 `65,530`，与 `rwkv-tokenizer-go` 在 442 条真实工具结果上逐条一致，可用 `scripts/tokenizer-parity.ts` 复测）。
- **计数口径**：直接对模型实际读到的 `<工具结果开始>` JSON 转义文本计数，上限 **3000 个 RWKV token**，不留额外安全余量。
- **截断与落盘（spill）**：
  - 一般工具（`bash`、`grep`、`web_fetch` 等）：保留头尾各一半，中间替换为 `[...]`，完整内容落盘并把文件路径写在结果末尾，方便模型用 `read` 或 `grep` 续查。
  - `read` 工具例外：文件本就在磁盘上，在整行边界截断并保留 `Use offset=N to continue` 提示。

---

## 4. `folded-read-guard` 防盲改机制

长程任务中，早期 `read` 或 `write` 的输出被折叠成 `[Old ...]` 占位后，模型若凭模糊记忆继续修改该文件，极易出现行号错位或上下文幻觉。插件通过两处配合拦截盲改：

1. **折叠态路径追踪（`src/core/fold-pairs.ts`）**：`foldedUnreadPaths` 扫描当前活动窗口，收集所有「曾读过或写过，但其输出已被折叠且之后未重新 `read`」的文件路径。
2. **编辑前拦截（[src/edit-modes/folded-read-guard.ts](../src/edit-modes/folded-read-guard.ts)）**：维护每会话（最多 `512` 个会话）的未重读路径集合；在 `tolerant`、`hashline`、`line-edit` 执行修改前调用 `isFoldedUnreadPath` 检查，命中则拒绝修改并返回明确提示，要求先对目标文件重新调用 `read` 再编辑。
