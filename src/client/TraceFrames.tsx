// One session's generations as frames: what the model wrote, what the
// harness did with it (outcome) and which repairs it needed. Shared by the
// RWKV conversation tab and the developer section of the settings page.

import { useState } from 'react'
import { fetchRecord, isGeneration, OUTCOME_LABEL, REPAIR_LABEL, touched, type TraceRecord } from './traces-api.ts'

function time(at: string | undefined): string {
  if (at === undefined) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString()
}

function Frame(props: { session: string; index: number; record: TraceRecord; number: number }) {
  const { record } = props
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState<string | undefined>()
  const [error, setError] = useState('')
  const outcome = record.outcome
  const kind = outcome === undefined ? 'old' : touched(record) ? (outcome === 'raw' ? 'raw' : 'touched') : 'clean'
  const loadPrompt = async () => {
    setError('')
    try {
      setPrompt((await fetchRecord(props.session, props.index)).record.prompt ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <li className={`rwkv-frame rwkv-frame-${kind}`}>
      <button type="button" className="rwkv-frame-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="rwkv-frame-no">#{props.number}</span>
        <span className="rwkv-frame-stage">{record.stage === 'answer' ? '收尾' : '决策'}</span>
        <span className={`rwkv-badge rwkv-badge-${kind}`}>{outcome === undefined ? record.action ?? '旧记录' : OUTCOME_LABEL[outcome] ?? outcome}</span>
        {(record.repairs ?? []).map(repair => (
          <span key={repair} className="rwkv-chip" title={repair}>{REPAIR_LABEL[repair] ?? repair}</span>
        ))}
        {record.purpose ? <span className="rwkv-chip">{record.purpose}</span> : null}
        <span className="rwkv-frame-meta">{record.finish === 'length' ? '写满上限 · ' : ''}{record.model} · {time(record.at)}</span>
      </button>
      {open ? (
        <div className="rwkv-frame-body">
          <div className="rwkv-frame-label">模型原始输出{record.action ? ` · 解析为 ${record.action}` : ''}</div>
          <pre className="rwkv-pre">{record.output ?? ''}</pre>
          {prompt === undefined ? (
            <button type="button" className="rwkv-link" onClick={() => { void loadPrompt() }}>
              看发给模型的提示词{record.promptChars ? `（${record.promptChars.toLocaleString()} 字符）` : ''}
            </button>
          ) : (
            <>
              <div className="rwkv-frame-label">发给模型的提示词</div>
              <pre className="rwkv-pre rwkv-pre-prompt">{prompt}</pre>
            </>
          )}
          {error ? <p className="rwkv-error">{error}</p> : null}
        </div>
      ) : null}
    </li>
  )
}

/** Request summaries (stage step) separate the frames of one DSH request from the next. */
function StepLine(props: { record: TraceRecord }) {
  const { record } = props
  const repairs = record.repairs ?? []
  return (
    <li className="rwkv-step">
      <span>↳ 交给 DSH：{record.decision}</span>
      {record.attempts !== undefined && record.attempts > 1 ? <span>· 生成 {record.attempts} 次</span> : null}
      {repairs.length > 0 ? <span>· 修复 {repairs.map(repair => REPAIR_LABEL[repair] ?? repair).join('、')}</span> : null}
      {record.outputRepairs === false ? <span className="rwkv-chip">修正关</span> : null}
      {record.guards === false ? <span className="rwkv-chip">干预关</span> : null}
    </li>
  )
}

export function TraceFrames(props: { session: string; records: readonly TraceRecord[]; onlyTouched: boolean; showSide: boolean }) {
  let number = 0
  const rows = props.records.flatMap((record, index) => {
    if (!props.showSide && record.purpose !== undefined) return []
    if (record.stage === 'step') return props.onlyTouched ? [] : [<StepLine key={index} record={record} />]
    if (!isGeneration(record)) return []
    number++
    if (props.onlyTouched && !touched(record)) return []
    return [<Frame key={index} session={props.session} index={index} record={record} number={number} />]
  })
  if (rows.length === 0) return <p className="rwkv-hint">{props.onlyTouched ? '这个会话里没有用到兜底的生成。' : '这个会话还没有记录。'}</p>
  return <ol className="rwkv-frames">{rows}</ol>
}
