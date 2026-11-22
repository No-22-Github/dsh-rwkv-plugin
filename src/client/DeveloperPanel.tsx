// Developer section of the RWKV settings page: raw trace recording, the two
// crutch switches, statistics over the recorded sessions, the session list
// with its frames, and the export of whole tasks.

import { useEffect, useState, type ReactNode } from 'react'
import { Segment } from './Segment.tsx'
import { TraceFrames } from './TraceFrames.tsx'
import {
  deleteSession, downloadExport, fetchSession, fetchSessions, OUTCOME_LABEL, percent, REPAIR_LABEL,
  type ModelStats, type SessionSummary, type TraceRecord,
} from './traces-api.ts'

export interface DeveloperSettings {
  recordTraces: boolean
  traceDir: string
  outputRepairs: boolean
  guards: boolean
  /** File editing mode; edits `editMode` in the Host schema. */
  editMode: 'tolerant' | 'line-edit' | 'hashline' | 'literal'
  /** Context management mode; edits `historyMode` in the Host schema. */
  historyMode: 'auto-fold' | 'full' | 'worklist'
  worklistMinFoldTokens: number
  worklistBudgetTokens: number
  worklistEpochTargetTokens: number
  worklistKeepRecentPairs: number
}

export const DEVELOPER_DEFAULTS: DeveloperSettings = {
  recordTraces: true,
  traceDir: '',
  outputRepairs: true,
  guards: true,
  editMode: 'tolerant',
  historyMode: 'auto-fold',
  worklistMinFoldTokens: 8000,
  worklistBudgetTokens: 13500,
  worklistEpochTargetTokens: 9000,
  worklistKeepRecentPairs: 3,
}

function Toggle(props: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="rwkv-check rwkv-toggle">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={event => props.onChange(event.target.checked)} />
      <span>
        {props.label}
        <span className="rwkv-hint rwkv-toggle-hint">{props.hint}</span>
      </span>
    </label>
  )
}

function Counts(props: { title: string; counts: Record<string, number>; total: number; labels: Record<string, string> }) {
  const entries = Object.entries(props.counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  return (
    <div className="rwkv-counts">
      <span className="rwkv-block-title">{props.title}</span>
      {entries.map(([key, count]) => (
        <span key={key} className="rwkv-count" title={key}>
          {props.labels[key] ?? key}<b>{count}</b><span className="rwkv-hint">{percent(count, props.total)}</span>
        </span>
      ))}
    </div>
  )
}

function StatsCard(props: { stats: readonly ModelStats[] }) {
  // Traces written before outcome / step records existed carry nothing to count.
  const counted = props.stats.filter(stats => stats.generations > 0 || stats.steps > 0)
  if (counted.length === 0) return <p className="rwkv-hint">还没有记录。</p>
  return (
    <>
      {counted.map(stats => (
        <div key={stats.model} className="rwkv-stats">
          <div className="rwkv-stats-head">
            <span className="rwkv-name">{stats.model}</span>
            <span className="rwkv-stat"><b>{percent(stats.clean, stats.generations)}</b> 生成原样可用（{stats.clean}/{stats.generations}）</span>
            <span className="rwkv-stat"><b>{percent(stats.cleanSteps, stats.steps)}</b> 请求一次定下且无修复（{stats.cleanSteps}/{stats.steps}）</span>
          </div>
          <Counts title="插件怎么处理的" counts={stats.outcomes} total={stats.generations} labels={OUTCOME_LABEL} />
          <Counts title="用到的修复（按生成计）" counts={stats.repairs} total={stats.generations} labels={REPAIR_LABEL} />
        </div>
      ))}
    </>
  )
}

function SessionRow(props: { item: SessionSummary; selected: boolean; onSelect: (value: boolean) => void; onDeleted: () => void }) {
  const { item } = props
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const remove = async () => {
    setDeleting(true)
    setError('')
    try {
      await deleteSession(item.session)
      props.onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setDeleting(false)
      setConfirming(false)
    }
  }
  const [records, setRecords] = useState<TraceRecord[] | undefined>()
  const [onlyTouched, setOnlyTouched] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || records !== undefined) return
    const abort = new AbortController()
    fetchSession(item.session, abort.signal)
      .then(body => setRecords(body.records))
      .catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => abort.abort()
  }, [open, records, item.session])
  return (
    <li className="rwkv-session">
      <div className="rwkv-session-head">
        <input type="checkbox" checked={props.selected} onChange={event => props.onSelect(event.target.checked)} aria-label="选中这个会话" />
        <button type="button" className="rwkv-session-title" onClick={() => setOpen(value => !value)} aria-expanded={open}>
          <span className="rwkv-session-task">{item.task || item.session}</span>
          <span className="rwkv-session-meta">
            {new Date(item.modified).toLocaleString()} · {item.models.join(', ')} · {item.steps} 次请求 · {item.generations} 次生成
            {item.touchedGenerations > 0 ? ` · ${item.touchedGenerations} 次用到兜底` : ''}
            {item.persisted ? '' : ' · 仅在内存'}
          </span>
        </button>
        <span className="rwkv-actions">
          {confirming ? (
            <>
              <button type="button" className="rwkv-link" disabled={deleting} onClick={() => setConfirming(false)}>取消</button>
              <button type="button" className="rwkv-btn rwkv-secondary rwkv-small rwkv-danger" disabled={deleting} onClick={() => { void remove() }}>确认删除</button>
            </>
          ) : (
            <button type="button" className="rwkv-link" title="只删 RWKV 轨迹，不动 DSH 的会话记录" onClick={() => setConfirming(true)}>删除</button>
          )}
        </span>
      </div>
      {!open && error ? <p className="rwkv-error">{error}</p> : null}
      {open ? (
        <div className="rwkv-session-body">
          <label className="rwkv-check"><input type="checkbox" checked={onlyTouched} onChange={event => setOnlyTouched(event.target.checked)} />只看用到兜底的生成</label>
          {error ? <p className="rwkv-error">{error}</p> : records === undefined ? <p className="rwkv-hint">加载中…</p> : (
            <TraceFrames session={item.session} records={records} onlyTouched={onlyTouched} showSide={false} />
          )}
        </div>
      ) : null}
    </li>
  )
}

function Traces(props: { recording: boolean }) {
  const [data, setData] = useState<{ dir: string; sessions: SessionSummary[]; stats: ModelStats[] } | undefined>()
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [listOpen, setListOpen] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    setError('')
    fetchSessions(abort.signal)
      .then(body => setData(body))
      .catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => abort.abort()
  }, [reload, props.recording])
  const exportSessions = async (sessions: readonly string[]) => {
    setBusy(true)
    setError('')
    try {
      await downloadExport(sessions)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setBusy(false)
  }
  const select = (session: string, value: boolean) => setSelected(current => {
    const next = new Set(current)
    if (value) next.add(session)
    else next.delete(session)
    return next
  })
  if (error && data === undefined) return <p className="rwkv-error">{error}</p>
  if (data === undefined) return <p className="rwkv-hint">加载中…</p>
  return (
    <>
      <div className="rwkv-block">
        <div className="rwkv-block-head">
          <span className="rwkv-block-title">兜底统计</span>
          <button type="button" className="rwkv-link" onClick={() => setReload(value => value + 1)}>刷新</button>
        </div>
        <StatsCard stats={data.stats} />
      </div>
      <div className="rwkv-block">
        <div className="rwkv-block-head">
          <span
            className="rwkv-block-title rwkv-session-toggle" title={data.dir}
            onClick={() => { if (data.sessions.length > 0) setListOpen(value => !value) }}
          >已记录的会话 · {data.sessions.length} 个</span>
          <span className="rwkv-actions">
            {listOpen || selected.size > 0 ? (
              <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || selected.size === 0} onClick={() => { void exportSessions([...selected]) }}>导出所选（{selected.size}）</button>
            ) : null}
            <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || data.sessions.length === 0} onClick={() => { void exportSessions([]) }}>导出全部</button>
            {data.sessions.length > 0 ? (
              <button
                type="button" className="rwkv-btn rwkv-secondary rwkv-small" aria-expanded={listOpen}
                onClick={() => setListOpen(value => !value)}
              >{listOpen ? '收起' : '展开'}</button>
            ) : null}
          </span>
        </div>
        {error ? <p className="rwkv-error">{error}</p> : null}
        {data.sessions.length === 0 ? <p className="rwkv-hint">还没有轨迹。</p> : listOpen ? (
          <>
            <p className="rwkv-hint">保存在 {data.dir}（删除仅删轨迹，不影响 DSH 会话）。</p>
            <ul className="rwkv-sessions">
              {data.sessions.map(item => (
                <SessionRow
                  key={item.session} item={item} selected={selected.has(item.session)} onSelect={value => select(item.session, value)}
                  onDeleted={() => { select(item.session, false); setReload(value => value + 1) }}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </>
  )
}

function DirInput(props: { value: string; disabled: boolean; onSave: (value: string) => void }) {
  const [text, setText] = useState(props.value)
  useEffect(() => setText(props.value), [props.value])
  return (
    <span className="rwkv-dir">
      <input
        className="rwkv-input" value={text} disabled={props.disabled} spellCheck={false} autoComplete="off"
        placeholder="留空：存在会话目录里"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') props.onSave(text.trim()) }}
      />
      <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={props.disabled || text.trim() === props.value} onClick={() => props.onSave(text.trim())}>保存</button>
    </span>
  )
}

/**
 * A number the Host validates, so it is edited as text and written on blur or
 * Enter: a half-typed value would otherwise be saved and refused.
 */
function NumberField(props: { value: number; onSave: (value: number) => void; disabled: boolean; placeholder?: string; min?: number }) {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const minVal = props.min ?? 1
  const commit = () => {
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isInteger(parsed) || parsed < minVal) {
      setText(String(props.value))
      return
    }
    if (parsed !== props.value) props.onSave(parsed)
  }
  return (
    <input
      className="rwkv-input" inputMode="numeric" value={text} disabled={props.disabled} placeholder={props.placeholder}
      onChange={event => setText(event.target.value)} onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') commit() }}
    />
  )
}

const EDIT_MODE_HINT: Record<DeveloperSettings['editMode'], string> = {
  tolerant: '自动对齐缩进空行并做语法检查。',
  hashline: '行号:短哈希锚点替换，免复述原文并防偏移。',
  'line-edit': '按行号区间替换，隐藏标准 edit。',
  literal: '原样精确匹配，不做容错与检查。',
}

const HISTORY_MODE_HINT: Record<DeveloperSettings['historyMode'], string> = {
  'auto-fold': '超水位自动压缩早期步骤输出，不挂 todo 工具。',
  full: '保留全部历史原文，不做压缩。',
  worklist: '启用 todo 工具由模型记工单，超限后折叠旧步骤。',
}

export function DeveloperCard(props: {
  settings: DeveloperSettings
  disabled: boolean
  write: (field: string, value: unknown) => Promise<boolean>
}): ReactNode {
  const { settings, disabled, write } = props
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = async (field: keyof DeveloperSettings, value: unknown) => {
    setBusy(true)
    await write(field, value)
    setBusy(false)
  }
  const off = disabled || busy
  const historyMode = settings.historyMode === 'worklist' ? 'worklist' : settings.historyMode === 'full' ? 'full' : 'auto-fold'
  return (
    <div className="rwkv-card">
      <button
        type="button" className="rwkv-head rwkv-developer-head" aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="rwkv-identity">
          <span className="rwkv-chevron" aria-hidden="true" />
          <span className="rwkv-name">开发者</span>
        </span>
        <span className="rwkv-meta">
          {settings.recordTraces ? '轨迹随会话保存' : '轨迹只在内存'}
          {settings.outputRepairs ? '' : ' · 修正已关'}
          {settings.guards ? '' : ' · 修复已关'}
          {settings.editMode === 'tolerant' ? ' · 容错 edit' : settings.editMode === 'literal' ? ' · 精确 edit' : settings.editMode === 'hashline' ? ' · 哈希 hashline' : ' · 行号 edit_lines'}
          {historyMode === 'auto-fold'
            ? ` · 自动折叠（${settings.worklistEpochTargetTokens} ← ${settings.worklistBudgetTokens}）`
            : historyMode === 'worklist'
              ? ` · 工单模式（${settings.worklistMinFoldTokens} / ${settings.worklistBudgetTokens}）`
              : ' · 完整对话'}
        </span>
      </button>
      {open ? (
        <div className="rwkv-developer-body">
          <div className="rwkv-field">
            <span className="rwkv-label">文件编辑模式</span>
            <Segment
              value={settings.editMode} disabled={off}
              options={[['tolerant', '容错 edit（默认）'], ['hashline', '哈希 hashline'], ['line-edit', '行号 edit_lines'], ['literal', '精确 edit']] as const}
              onChange={value => { void set('editMode', value) }}
            />
            <p className="rwkv-hint">{EDIT_MODE_HINT[settings.editMode]}</p>
          </div>
          <div className="rwkv-field">
            <span className="rwkv-label">上下文管理模式</span>
            <Segment
              value={historyMode} disabled={off}
              options={[['auto-fold', '自动折叠（默认）'], ['full', '完整对话'], ['worklist', '工单模式（实验）']] as const}
              onChange={value => { void set('historyMode', value) }}
            />
            <p className="rwkv-hint">{HISTORY_MODE_HINT[historyMode]}</p>
          </div>
          {historyMode === 'auto-fold' || historyMode === 'worklist' ? (
            <div className="rwkv-grid3">
              {historyMode === 'auto-fold' ? (
                <label className="rwkv-field">
                  <span className="rwkv-label">回落水位 (token)</span>
                  <NumberField
                    value={settings.worklistEpochTargetTokens} min={0} disabled={off} placeholder="9000"
                    onSave={value => { void set('worklistEpochTargetTokens', value) }}
                  />
                  <p className="rwkv-hint">批量原地遮蔽后的目标水位</p>
                </label>
              ) : (
                <label className="rwkv-field">
                  <span className="rwkv-label">开始折叠 (token)</span>
                  <NumberField
                    value={settings.worklistMinFoldTokens} min={0} disabled={off} placeholder="8000"
                    onSave={value => { void set('worklistMinFoldTokens', value) }}
                  />
                  <p className="rwkv-hint">超此值才允许折叠</p>
                </label>
              )}
              <label className="rwkv-field">
                <span className="rwkv-label">单轮上限 (token)</span>
                <NumberField
                  value={settings.worklistBudgetTokens} disabled={off} placeholder="13500"
                  onSave={value => { void set('worklistBudgetTokens', value) }}
                />
                <p className="rwkv-hint">{historyMode === 'auto-fold' ? '超此值触发批量原地遮蔽' : '超此值追加预算提醒'}</p>
              </label>
              <label className="rwkv-field">
                <span className="rwkv-label">保留最近步数</span>
                <NumberField
                  value={settings.worklistKeepRecentPairs} min={0} disabled={off} placeholder="3"
                  onSave={value => { void set('worklistKeepRecentPairs', value) }}
                />
                <p className="rwkv-hint">折叠时保留最近原文步数</p>
              </label>
            </div>
          ) : null}
          <Toggle
            label="原始运行轨迹落盘" checked={settings.recordTraces} disabled={off} onChange={value => { void set('recordTraces', value) }}
            hint="随会话保存在本地，关闭后仅留内存。"
          />
          <label className="rwkv-field">
            <span className="rwkv-label">自定义目录</span>
            <DirInput value={settings.traceDir} disabled={off} onSave={value => { void set('traceDir', value) }} />
          </label>
          <Toggle
            label="修正模型输出" checked={settings.outputRepairs} disabled={off} onChange={value => { void set('outputRepairs', value) }}
            hint="自动修格式、工具名与参数。"
          />
          <Toggle
            label="插件修复" checked={settings.guards} disabled={off} onChange={value => { void set('guards', value) }}
            hint="格式重问、防重复调用与强制收尾。"
          />
          <Traces recording={settings.recordTraces} />
        </div>
      ) : null}
    </div>
  )
}
