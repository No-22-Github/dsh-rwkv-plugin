// Browser side of the Host's trace routes (src/routes.ts handleTraceRoute).

export const TRACE_ROUTE = '/api/rwkv/traces'
export const TRACE_EXPORT_ROUTE = '/api/rwkv/trace-export'

export interface ContextFoldTrace {
  readonly kind: string
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly foldedTools: number
}

export interface TraceRecord {
  readonly at?: string
  readonly model?: string
  readonly purpose?: string
  readonly stage?: string
  readonly prompt?: string
  readonly promptChars?: number
  readonly promptTokens?: number
  readonly output?: string
  readonly finish?: string
  readonly stop?: string
  readonly action?: string
  readonly outcome?: string
  readonly repairs?: readonly string[]
  readonly decision?: string
  readonly attempts?: number
  readonly generations?: number
  readonly outputRepairs?: boolean
  readonly guards?: boolean
  /** Step records: the arguments DSH received (long strings cut) and how they differ from the model's. */
  readonly args?: Record<string, unknown>
  readonly changes?: readonly ArgumentChange[]
  /** Card records only: the history range this handoff card replaced. */
  readonly relay?: RelayCardTrace
  /** Decision records in worklist mode. */
  readonly worklist?: WorklistStepTrace
  /** Context fold event triggered right before this generation. */
  readonly fold?: ContextFoldTrace
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

export type CtxTier = 'green' | 'blue' | 'yellow' | 'red'

export function ctxTier(tokens: number): CtxTier {
  if (tokens <= 8000) return 'green'
  if (tokens <= 12000) return 'blue'
  if (tokens <= 16000) return 'yellow'
  return 'red'
}

export function foldKindLabel(kind: string): string {
  switch (kind) {
    case 'prior-turn': return '跨轮上下文压缩'
    case 'stage-archive': return '阶段归档折叠'
    case 'worklist': return '工单检查点折叠'
    case 'relay': return '交接卡压缩'
    default: return '上下文折叠'
  }
}

export function foldDetailText(fold: ContextFoldTrace): string {
  const range = `${formatTokens(fold.beforeTokens)} → ${formatTokens(fold.afterTokens)}`
  if (fold.foldedTools > 0) {
    return `${range}，已折叠 ${fold.foldedTools} 条工具调用`
  }
  return range
}

export interface WorklistStepTrace {
  readonly promptTokens: number
  readonly budgetTokens: number
  readonly checkpointAt?: number
  readonly nudged: boolean
}

/** Where the relay cut the conversation, and the card the model reads instead. */
export interface RelayCardTrace {
  readonly from: number
  readonly to: number
  readonly turn: number
  readonly fallback: boolean
  readonly card: string
}

export interface ArgumentChange {
  readonly key: string
  readonly kind: 'changed' | 'added' | 'removed' | 'renamed'
  readonly from?: string
  readonly before?: unknown
  readonly after?: unknown
}

export interface ModelStats {
  readonly model: string
  readonly generations: number
  readonly clean: number
  readonly steps: number
  readonly cleanSteps: number
  readonly outcomes: Record<string, number>
  readonly repairs: Record<string, number>
}

export interface SessionSummary {
  readonly session: string
  readonly modified: string
  readonly bytes: number
  readonly persisted: boolean
  readonly task: string
  readonly models: readonly string[]
  readonly generations: number
  readonly steps: number
  readonly touchedGenerations: number
  readonly touchedSteps: number
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...signal ? { signal } : {} })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      message = ((await response.json()) as { error?: string }).error ?? message
    } catch {
      // Not JSON: keep the status.
    }
    throw new Error(message)
  }
  return await response.json() as T
}

export function fetchSessions(signal?: AbortSignal) {
  return getJSON<{ dir: string; recording: boolean; sessions: SessionSummary[]; stats: ModelStats[] }>(TRACE_ROUTE, signal)
}

export function fetchSession(session: string, signal?: AbortSignal) {
  return getJSON<{ dir: string; recording: boolean; session: string; records: TraceRecord[] }>(`${TRACE_ROUTE}/${encodeURIComponent(session)}`, signal)
}

export function fetchRecord(session: string, index: number) {
  return getJSON<{ record: TraceRecord }>(`${TRACE_ROUTE}/${encodeURIComponent(session)}?index=${index}`)
}

/** Removes the session's RWKV trace (file and memory copy); DSH's own session log stays. */
export async function deleteSession(session: string): Promise<void> {
  const response = await fetch(`${TRACE_ROUTE}/${encodeURIComponent(session)}`, { method: 'DELETE', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`删除失败：HTTP ${response.status}`)
}

/** Downloads whole tasks as JSONL; every session when the list is empty. */
export async function downloadExport(sessions: readonly string[]): Promise<void> {
  const query = sessions.length > 0 ? `?sessions=${sessions.map(encodeURIComponent).join(',')}` : ''
  const response = await fetch(`${TRACE_EXPORT_ROUTE}${query}`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`)
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'rwkv-traces.jsonl'
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** What the harness did with one generation. */
export const OUTCOME_LABEL: Record<string, string> = {
  'run': '执行调用',
  'final': '作答',
  're-ask': '格式重问',
  'duplicate-retry': '重复调用，再给一次',
  'closeout': '强制收尾',
  'rejected unknown-tool': '未知工具',
  'rejected blocked': '调用被拦截（连续失败或连续更新工单）',
  'empty-exit': 'no_tool 没写回答',
  'raw': '原样输出（未修）',
}

/** Repair codes in plain words; unknown codes show as written. */
export const REPAIR_LABEL: Record<string, string> = {
  json_repaired: '去掉多余的 }',
  array_unwrapped: '拆开单元素数组',
  function_wrapper: '拆 OpenAI 外壳',
  name_alias: 'name 字段写错',
  arguments_alias: 'arguments 字段写错',
  arguments_lifted: '参数写在顶层',
  path_argument: '只写了路径',
  stringified_arguments: 'arguments 是字符串',
  tool_renamed: '工具名改写',
  preamble_stripped: '去掉调用前的话',
  envelope_recovered: '外面多套一层',
  legacy_xml_call: '自闭合标签调用',
  tool_name_alias: '工具名别名',
  argument_alias: '参数名别名',
  scalar_coerced: '数值/布尔转换',
  unknown_arguments_dropped: '删掉多余参数',
  pattern_array: 'pattern 是数组',
  glob_default_pattern: 'glob 补 pattern',
  offset_below_one: 'offset 改成 1',
  limit_below_one: '去掉 limit',
  path_repaired: '路径修复',
  bash_description_filled: 'bash 补 description',
  answer_stage_tool: '收尾阶段的调用',
}

export const isGeneration = (record: TraceRecord) => record.stage === 'decision' || record.stage === 'answer'
/** A relay handoff card: a generation like any other, but its own row in the ledger. */
export const isCard = (record: TraceRecord) => record.stage === 'card'

/** The plugin touched this generation: a repair, a re-ask, a gate, a closeout, a fallback card. */
export function touched(record: TraceRecord): boolean {
  // A card that had to fall back to the generated summary is a crutch too.
  if (isCard(record)) return record.relay?.fallback === true || record.outcome === 'card-empty' || record.outcome === 'card-failed'
  if (!isGeneration(record) || record.outcome === undefined) return false
  return !((record.outcome === 'run' || record.outcome === 'final') && (record.repairs ?? []).length === 0)
}

export const percent = (part: number, whole: number) => whole === 0 ? '–' : `${(100 * part / whole).toFixed(1)}%`
