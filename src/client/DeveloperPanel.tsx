// Developer section of the RWKV settings page: raw trace recording, the two
// crutch switches, statistics over the recorded sessions, the session list
// with its frames, and the export of whole tasks.

import { useEffect, useState, type ReactNode } from 'react'
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
  /** Experimental relay context; the switch edits `historyMode` in the Host schema. */
  historyMode: 'full' | 'relay'
  relayBudgetTokens: number
  relayCardMaxTokens: number
}

export const DEVELOPER_DEFAULTS: DeveloperSettings = {
  recordTraces: true,
  traceDir: '',
  outputRepairs: true,
  guards: true,
  historyMode: 'full',
  relayBudgetTokens: 8000,
  relayCardMaxTokens: 768,
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
          <span className="rwkv-block-title" title={data.dir}>已记录的会话 · {data.sessions.length} 个</span>
          <span className="rwkv-actions">
            <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || selected.size === 0} onClick={() => { void exportSessions([...selected]) }}>导出所选（{selected.size}）</button>
            <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || data.sessions.length === 0} onClick={() => { void exportSessions([]) }}>导出全部</button>
          </span>
        </div>
        <p className="rwkv-hint">保存在 {data.dir}。删除不影响 DSH 的会话记录。</p>
        {error ? <p className="rwkv-error">{error}</p> : null}
        {data.sessions.length === 0 ? <p className="rwkv-hint">还没有轨迹。</p> : (
          <ul className="rwkv-sessions">
            {data.sessions.map(item => (
              <SessionRow
                key={item.session} item={item} selected={selected.has(item.session)} onSelect={value => select(item.session, value)}
                onDeleted={() => { select(item.session, false); setReload(value => value + 1) }}
              />
            ))}
          </ul>
        )}
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
function NumberField(props: { value: number; onSave: (value: number) => void; disabled: boolean; placeholder?: string }) {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const commit = () => {
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isInteger(parsed) || parsed <= 0) {
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

export function DeveloperCard(props: {
  settings: DeveloperSettings
  disabled: boolean
  write: (field: string, value: unknown) => Promise<boolean>
}): ReactNode {
  const { settings, disabled, write } = props
  const [busy, setBusy] = useState(false)
  const set = async (field: keyof DeveloperSettings, value: unknown) => {
    setBusy(true)
    await write(field, value)
    setBusy(false)
  }
  const off = disabled || busy
  return (
    <details className="rwkv-card rwkv-developer">
      <summary className="rwkv-head rwkv-developer-summary">
        <span className="rwkv-identity"><span className="rwkv-name">开发者</span></span>
        <span className="rwkv-meta">
          {settings.recordTraces ? '轨迹随会话保存' : '轨迹只在内存'}
          {settings.outputRepairs ? '' : ' · 修正已关'}
          {settings.guards ? '' : ' · 修复已关'}
          {settings.historyMode === 'relay' ? ' · 接力上下文' : ''}
        </span>
      </summary>
      <div className="rwkv-developer-body">
        <Toggle
          label="实验性上下文管理（接力）" checked={settings.historyMode === 'relay'} disabled={off}
          onChange={value => { void set('historyMode', value ? 'relay' : 'full') }}
          hint={settings.historyMode === 'relay'
            ? '已开启：早先的对话段被模型自己写的交接卡替换，只有最近一次工具调用和结果原样保留。每一轮用户消息开始处切断，卡片写在会话记录旁边，可随会话恢复。'
            : '关闭时模型读完整对话。开启后，超过预算的早期步骤被一段六段式交接卡替换，用来压缩上下文。这是实验特性，只影响模型能看到的历史，不改变工具与提示词。'}
        />
        {settings.historyMode === 'relay' ? (
          <div className="rwkv-grid">
            <label className="rwkv-field">
              <span className="rwkv-label">接力预算（token）</span>
              <NumberField
                value={settings.relayBudgetTokens} disabled={off} placeholder="8000"
                onSave={value => { void set('relayBudgetTokens', value) }}
              />
              <p className="rwkv-hint">一段对话超过这个估算预算就写卡。最近一次工具调用和它的结果始终原样保留，不参与估算。</p>
            </label>
            <label className="rwkv-field">
              <span className="rwkv-label">单张卡上限（token）</span>
              <NumberField
                value={settings.relayCardMaxTokens} disabled={off} placeholder="768"
                onSave={value => { void set('relayCardMaxTokens', value) }}
              />
              <p className="rwkv-hint">写卡请求的输出上限，思考也算在里面。太小会让卡写不完而退回自动生成的摘要。</p>
            </label>
          </div>
        ) : null}
        <Toggle
          label="原始运行轨迹落盘" checked={settings.recordTraces} disabled={off} onChange={value => { void set('recordTraces', value) }}
          hint="默认保存在 DSH 会话记录文件旁，会跟随原始会话一并删除。关闭后将不再落盘，仅保存在内存，DSH 运行时仍然可看。"
        />
        <label className="rwkv-field">
          <span className="rwkv-label">自定义目录</span>
          <DirInput value={settings.traceDir} disabled={off} onSave={value => { void set('traceDir', value) }} />
        </label>
        <Toggle
          label="修正模型输出" checked={settings.outputRepairs} disabled={off} onChange={value => { void set('outputRepairs', value) }}
          hint="自动纠正格式、工具名、参数和路径。关掉后参数原样交给 DSH。"
        />
        <Toggle
          label="插件修复" checked={settings.guards} disabled={off} onChange={value => { void set('guards', value) }}
          hint="重问、拦截重复调用、强制收尾等。关掉后模型输出什么就用什么。"
        />
        <p className="rwkv-hint">关闭以上两项，将忠于模型原始输出，不做任何修复。</p>
        <Traces recording={settings.recordTraces} />
      </div>
    </details>
  )
}
