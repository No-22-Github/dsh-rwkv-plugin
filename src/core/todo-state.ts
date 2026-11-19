// Active stateful work list (`todo_plan` + `todo_update`): tool definitions,
// lenient field parsing, per-turn item state transitions, and Desktop
// `TodoPanel` projection. Kept separate from the passive/checkpoint folding
// engine (`fold-pairs.ts`, `fold-window.ts`, `worklist.ts`).

export const TODO_PLAN_TOOL = 'todo_plan'
export const TODO_UPDATE_TOOL = 'todo_update'

export const TODO_PLAN_DESCRIPTION =
  'Create or revise the ordered work list for multi-step tasks (touching multiple methods/files, code + docs/tests, or 3+ distinct subgoals). '
  + 'Skip this tool for casual chat, quick single-goal lookups (1-3 reads or searches), or a trivial one-spot edit. '
  + 'For multi-step changes, you may inspect 1-2 files first to understand the layout, then call todo_plan BEFORE making your first file edit — do not wait until after editing to plan. '
  + 'Calling todo_plan mid-turn keeps completed/dropped items and their notes intact and replaces only unfinished items.'

export const TODO_UPDATE_DESCRIPTION =
  'Update one item in the current work list by id. '
  + 'As soon as an item is finished, mark it completed with a concise factual note (<= 120 words: exact /app/... file paths, updated line ranges, signatures, and test exit codes — never mark unexecuted work completed). '
  + 'Older exploratory tool outputs before the recent workspace actions are folded once note is saved, while your initial todo_plan and the latest workspace results stay visible. '
  + 'The next pending item becomes in_progress automatically; you may also checkpoint an in_progress item with an interim note before context fills up.'

export const WORKLIST_TOOLS: ReadonlySet<string> = new Set([TODO_PLAN_TOOL, TODO_UPDATE_TOOL])

export function isWorklistTool(name: string): boolean {
  return WORKLIST_TOOLS.has(name)
}

export type WorklistStatus = 'pending' | 'in_progress' | 'completed' | 'dropped'

export interface WorklistItem {
  readonly id: number
  readonly content: string
  readonly status: WorklistStatus
  readonly note?: string
}

export interface TodoUpdateInput {
  readonly id?: unknown
  readonly status?: unknown
  readonly note?: unknown
  readonly content?: unknown
}

const WORKLIST_PROTOCOL_TAG = /<\/?(?:think|tool_call|tool_response)(?:\s[^>]*)?>/gi
const WORKLIST_LEADING_BULLET = /^\s*(?:\[\d+\]|\d+[.)]|[-*•])\s*/

export function sanitizeWorklistField(text: string): string {
  return text.replace(WORKLIST_PROTOCOL_TAG, '').replace(/\s*\n+\s*/g, ' | ').trim()
}

export function parsePlanItems(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (const entry of raw) {
      if (typeof entry === 'string') {
        const cleaned = sanitizeWorklistField(entry.replace(WORKLIST_LEADING_BULLET, ''))
        if (cleaned !== '') out.push(cleaned)
      } else if (typeof entry === 'object' && entry !== null) {
        const obj = entry as Record<string, unknown>
        const candidate = obj.content ?? obj.title ?? obj.text ?? obj.step
        if (typeof candidate === 'string') {
          const cleaned = sanitizeWorklistField(candidate.replace(WORKLIST_LEADING_BULLET, ''))
          if (cleaned !== '') out.push(cleaned)
        }
      } else {
        return undefined
      }
    }
    return out
  }
  if (typeof raw === 'string') {
    const lines = raw
      .split(/\r?\n/)
      .map(line => sanitizeWorklistField(line.replace(WORKLIST_LEADING_BULLET, '')))
      .filter(line => line !== '')
    return lines.length > 0 ? lines : undefined
  }
  return undefined
}

export function normalizeWorklistStatus(raw: unknown): WorklistStatus | undefined {
  if (typeof raw !== 'string') return undefined
  const lower = raw.trim().toLowerCase()
  if (lower === 'pending' || lower === 'todo' || lower === 'not_started') return 'pending'
  if (lower === 'in_progress' || lower === 'in-progress' || lower === 'doing' || lower === 'active') return 'in_progress'
  if (lower === 'completed' || lower === 'complete' || lower === 'done' || lower === 'finished') return 'completed'
  if (lower === 'dropped' || lower === 'cancelled' || lower === 'canceled' || lower === 'skipped') return 'dropped'
  return undefined
}

/** Whether `item` is a `todo_update` call that wrote a non-empty `note`. */
export function isNotedTodoUpdateCall(item: { readonly kind: string; readonly name?: string; readonly args?: Record<string, unknown> }): boolean {
  if (item.kind !== 'call' || item.name !== TODO_UPDATE_TOOL || item.args === undefined) return false
  const note = item.args.note ?? item.args.notes ?? item.args.summary ?? item.args.findings ?? item.args.conclusion
  return typeof note === 'string' && sanitizeWorklistField(note) !== ''
}

/**
 * Apply `todo_plan` to the current turn's list. Completed and dropped items
 * (and their notes) are locked and kept at the top; `rawItems` replaces only
 * the remaining unfinished queue, activating the first unfinished item.
 */
export function applyTodoPlan(current: readonly WorklistItem[], rawItems: unknown): WorklistItem[] | string {
  const parsed = parsePlanItems(rawItems)
  if (parsed === undefined || parsed.length === 0) {
    return 'items must be a non-empty array of step strings'
  }
  const locked = current
    .filter(item => item.status === 'completed' || item.status === 'dropped')
    .map((item, idx) => ({ ...item, id: idx + 1 }))
  const lockedTitles = new Set(locked.map(item => item.content))
  // If the model re-sent already completed titles at the top of `items`, skip
  // duplicating them because `locked` already preserves them with their notes.
  const remaining = parsed.filter(title => !lockedTitles.has(title))
  if (locked.length === 0 && remaining.length < 2) {
    return 'todo_plan requires at least 2 steps; execute single-step tasks directly without todo_plan'
  }
  if (remaining.length === 0) {
    return 'todo_plan requires at least 1 new unfinished step after completed items'
  }
  if (locked.length + remaining.length > 12) {
    return `todo_plan accepts at most 12 total items (got ${locked.length + remaining.length}); group micro-actions into coarser subgoals`
  }
  const seen = new Set<string>()
  for (const [idx, title] of remaining.entries()) {
    if (seen.has(title)) {
      return `items[${idx}] duplicates ${JSON.stringify(title)}`
    }
    seen.add(title)
  }
  const tail: WorklistItem[] = remaining.map((content, idx) => ({
    id: locked.length + idx + 1,
    content,
    status: idx === 0 ? 'in_progress' : 'pending',
  }))
  return [...locked, ...tail]
}

/**
 * Apply `todo_update` to one item by 1-based `id`. Requires a non-empty `note`
 * when closing an item (`completed` or `dropped`), keeps at most one item
 * `in_progress`, and automatically advances the next `pending` item when the
 * active item finishes.
 */
export function applyTodoUpdate(
  current: readonly WorklistItem[],
  input: TodoUpdateInput,
): { items: WorklistItem[]; noted: boolean } | string {
  if (current.length === 0) {
    return 'no active todo list in this turn; call todo_plan first if this task has multiple subgoals'
  }
  const rawId = typeof input.id === 'string' ? Number(input.id.trim()) : input.id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId < 1 || rawId > current.length) {
    return `id must be an integer between 1 and ${current.length} (got ${JSON.stringify(input.id)})`
  }
  const status = normalizeWorklistStatus(input.status)
  if (status === undefined || status === 'pending') {
    return 'status must be one of: in_progress, completed, dropped'
  }
  const target = current[rawId - 1]!
  const providedNote = typeof input.note === 'string' ? sanitizeWorklistField(input.note) : ''
  const effectiveNote = providedNote !== '' ? providedNote : target.note
  if ((status === 'completed' || status === 'dropped') && (!effectiveNote || effectiveNote === '')) {
    return 'note is required when status is completed or dropped: record concrete findings, exact file paths/lines, applied edits, or test results'
  }
  const updatedContent = typeof input.content === 'string' && sanitizeWorklistField(input.content) !== ''
    ? sanitizeWorklistField(input.content)
    : target.content

  const next = current.map((item, index): WorklistItem => {
    if (index === rawId - 1) {
      return {
        id: item.id,
        content: updatedContent,
        status,
        ...effectiveNote ? { note: effectiveNote } : {},
      }
    }
    // Single-active discipline: focusing a later item auto-completes an earlier
    // active item that already recorded a note, and demotes an unnoted/later one.
    if (status === 'in_progress' && item.status === 'in_progress') {
      const autoDone = index < rawId - 1 && Boolean(item.note && item.note.trim() !== '')
      return { ...item, status: autoDone ? 'completed' : 'pending' }
    }
    return item
  })

  // Auto-advance: when no item is active anymore, promote the next pending item.
  if (!next.some(item => item.status === 'in_progress')) {
    const afterIdx = next.findIndex((item, idx) => idx > rawId - 1 && item.status === 'pending')
    const promoteIdx = afterIdx >= 0 ? afterIdx : next.findIndex(item => item.status === 'pending')
    if (promoteIdx >= 0) {
      next[promoteIdx] = { ...next[promoteIdx]!, status: 'in_progress' }
    }
  }

  return { items: next, noted: providedNote !== '' }
}

/** Model-facing rendering returned as the tool output of `todo_plan` and `todo_update`. */
export function formatWorklist(items: readonly WorklistItem[]): string {
  const lines = ['Todo list:']
  for (const item of items) {
    lines.push(`[${item.id}] (${item.status}) ${item.content}`)
    if (item.note) lines.push(`  note: ${item.note}`)
  }
  return lines.join('\n')
}

/**
 * Clean single-line projection mirrored onto DSH's native `todo/write` event for
 * the Desktop `TodoPanel` dock (omits long technical notes, and settles lingering
 * `in_progress` spinners to `pending` once `turn/end` fires).
 */
export function projectNativeTodos(
  items: readonly WorklistItem[],
  options?: { readonly turnEnded?: boolean },
): { content: string; status: 'pending' | 'in_progress' | 'completed' }[] {
  const settleActive = options?.turnEnded === true
  return items.map(item => ({
    content: item.status === 'dropped'
      ? `[${item.id}] [已跳过] ${item.content}`
      : `[${item.id}] ${item.content}`,
    status: item.status === 'dropped'
      ? 'completed'
      : (settleActive && item.status === 'in_progress' ? 'pending' : item.status),
  }))
}
