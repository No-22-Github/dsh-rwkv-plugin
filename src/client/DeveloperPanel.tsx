// Developer section of the RWKV settings page: raw trace recording, the two
// crutch switches, statistics over the recorded sessions, the session list
// with its frames, and the export of whole tasks.

import { useEffect, useState, type ReactNode } from 'react'
import { TraceFrames } from './TraceFrames.tsx'
import {
  downloadExport, fetchSession, fetchSessions, OUTCOME_LABEL, percent, REPAIR_LABEL,
  type ModelStats, type SessionSummary, type TraceRecord,
} from './traces-api.ts'

export interface DeveloperSettings {
  recordTraces: boolean
  traceDir: string
  outputRepairs: boolean
  guards: boolean
}

export const DEVELOPER_DEFAULTS: DeveloperSettings = {
  recordTraces: false,
  traceDir: '',
  outputRepairs: true,
  guards: true,
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
  if (counted.length === 0) return <p className="rwkv-hint">还没有带判定的记录（旧版插件写的轨迹没有判定字段）。打开记录后跑几轮任务，这里会出现统计。</p>
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

function SessionRow(props: { item: SessionSummary; selected: boolean; onSelect: (value: boolean) => void }) {
  const { item } = props
  const [open, setOpen] = useState(false)
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
      </div>
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
          <span className="rwkv-block-title">兜底统计（内存和磁盘里的全部会话，不含会话标题这类附带请求）</span>
          <button type="button" className="rwkv-link" onClick={() => setReload(value => value + 1)}>刷新</button>
        </div>
        <StatsCard stats={data.stats} />
      </div>
      <div className="rwkv-block">
        <div className="rwkv-block-head">
          <span className="rwkv-block-title">已记录的会话 · {data.sessions.length} 个 · {data.dir}</span>
          <span className="rwkv-actions">
            <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || selected.size === 0} onClick={() => { void exportSessions([...selected]) }}>导出所选（{selected.size}）</button>
            <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || data.sessions.length === 0} onClick={() => { void exportSessions([]) }}>导出全部</button>
          </span>
        </div>
        <p className="rwkv-hint">
          导出为 JSONL，每行一个任务：全部原始记录（每次生成的提示词、原始输出、插件的处理和修复，包括重问和被拦的生成），
          最后一次生成的完整 RWKV 文本（text），以及把历史步骤的真实思考填回去的版本（textWithThinks，记录完整时才有）。
        </p>
        {error ? <p className="rwkv-error">{error}</p> : null}
        {data.sessions.length === 0 ? <p className="rwkv-hint">还没有轨迹。用 RWKV 模型跑一轮任务后这里会出现。</p> : (
          <ul className="rwkv-sessions">
            {data.sessions.map(item => (
              <SessionRow key={item.session} item={item} selected={selected.has(item.session)} onSelect={value => select(item.session, value)} />
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
        placeholder="留空 = $DSH_HOME/rwkv-traces（默认 ~/.dsh/rwkv-traces）"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') props.onSave(text.trim()) }}
      />
      <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={props.disabled || text.trim() === props.value} onClick={() => props.onSave(text.trim())}>保存</button>
    </span>
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
          {settings.recordTraces ? '轨迹保存到磁盘' : '轨迹只在内存'}
          {settings.outputRepairs ? '' : ' · 修正已关'}
          {settings.guards ? '' : ' · 干预已关'}
        </span>
      </summary>
      <div className="rwkv-developer-body">
        <Toggle
          label="把轨迹保存到磁盘" checked={settings.recordTraces} disabled={off} onChange={value => { void set('recordTraces', value) }}
          hint="轨迹（发给 RWKV 的提示词原文、原始输出、插件怎么处理的、用了哪些修复）一直记在内存里，对话视图的 RWKV 标签页和下面的统计、导出都能用，DSH 重启后清空。勾选后同时写进轨迹目录，每个会话一个文件。"
        />
        <label className="rwkv-field">
          <span className="rwkv-label">轨迹目录</span>
          <DirInput value={settings.traceDir} disabled={off} onSave={value => { void set('traceDir', value) }} />
        </label>
        <Toggle
          label="修正模型输出" checked={settings.outputRepairs} disabled={off} onChange={value => { void set('outputRepairs', value) }}
          hint="格式修复、工具名和参数名纠正、数值转换、DSH 参数值修复、路径修复。关掉后只认标准写法，参数原样交给 DSH，由 DSH 报错。"
        />
        <Toggle
          label="插件干预" checked={settings.guards} disabled={off} onChange={value => { void set('guards', value) }}
          hint="格式重问、重复调用拦截、连续失败封禁、思考写满时替它收住、收尾阶段的重问和兜底总结。关掉后模型输出什么就是什么，解析不了的原样作为回答。"
        />
        <p className="rwkv-hint">测模型本身时两个都关；复读截断由运行参数里的 loop-guard 单独控制。修复后的调用会进入 DSH 的记录，模型下一步看到的是修好的版本。</p>
        <Traces recording={settings.recordTraces} />
      </div>
    </details>
  )
}
