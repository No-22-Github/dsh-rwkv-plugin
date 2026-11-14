// One session's raw trace as a ledger in the style of DSH's Trajectory view:
// a row per generation (kind tag, one-line preview, repair chips), a thin row
// per DSH request saying what was handed to DSH, a rail with request labels,
// and an inspector panel for the selected generation. Shared by the RWKV
// conversation tab and the developer section of the settings page.

import { useEffect, useState } from 'react'
import { fetchRecord, isCard, isGeneration, OUTCOME_LABEL, REPAIR_LABEL, touched, type ArgumentChange, type TraceRecord } from './traces-api.ts'

const SHORT_VALUE = 16
const MAX_CHANGES = 3

function valueText(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value)
}

/** One change in a few characters: offset 0→1, −include, +description, old_text→old_string, file_path 已改. */
function changeText(change: ArgumentChange): string {
  switch (change.kind) {
    case 'removed': return `−${change.key}`
    case 'added': return `+${change.key}`
    case 'renamed': return `${change.from}→${change.key}`
    case 'changed': {
      const before = valueText(change.before)
      const after = valueText(change.after)
      return before.length + after.length > SHORT_VALUE * 2 ? `${change.key} 已改` : `${change.key} ${before}→${after}`
    }
  }
}

function changeTitle(change: ArgumentChange): string {
  switch (change.kind) {
    case 'removed': return `删掉 ${change.key}=${valueText(change.before)}`
    case 'added': return `补上 ${change.key}=${valueText(change.after)}`
    case 'renamed': return `参数名 ${change.from} 改成 ${change.key}`
    case 'changed': return `${change.key}：${valueText(change.before)} → ${valueText(change.after)}`
  }
}

/** The DSH request line: what DSH got, and only the fields the plugin changed. */
function HandedLine(props: { record: TraceRecord }) {
  const { record } = props
  const changes = record.changes ?? []
  const decision = (record.decision ?? '').replace(/^tool /, '')
  return (
    <span className="rl-step">
      → 交给 DSH <code>{decision}</code>
      {changes.slice(0, MAX_CHANGES).map((change, index) => (
        <span key={index} className="rl-change" title={changeTitle(change)}>{changeText(change)}</span>
      ))}
      {record.changes === undefined ? (record.repairs ?? []).map(repair => (
        // Records written before the changes field: name the repairs instead.
        <span key={repair} className="rl-change" title={repair}>{REPAIR_LABEL[repair] ?? repair}</span>
      )) : null}
      {changes.length > MAX_CHANGES ? <span className="rl-change" title={changes.slice(MAX_CHANGES).map(changeTitle).join('\n')}>+{changes.length - MAX_CHANGES}</span> : null}
      {record.attempts && record.attempts > 1 ? <span className="rl-step-note">生成 {record.attempts} 次</span> : null}
    </span>
  )
}

/** Short tag per outcome, like the native role tags. */
const OUTCOME_TAG: Record<string, string> = {
  'card': '写卡',
  'card-empty': '空卡',
  'card-failed': '卡失败',
  'run': '调用',
  'final': '作答',
  're-ask': '重问',
  'duplicate-retry': '重复',
  'closeout': '收尾',
  'rejected unknown-tool': '拒绝',
  'rejected blocked': '拒绝',
  'empty-exit': '空答',
  'raw': '原样',
}

type Tone = 'clean' | 'touched' | 'error' | 'neutral'

function toneOf(record: TraceRecord): Tone {
  if (record.outcome === undefined) return 'neutral'
  if (record.outcome === 'raw' || record.outcome.startsWith('rejected')) return 'error'
  return touched(record) ? 'touched' : 'clean'
}

/** The part after a leading think block. */
function afterThink(output: string): string {
  const text = output.trimStart()
  if (!text.startsWith('<think')) return text
  const end = text.indexOf('</think>')
  return end < 0 ? '' : text.slice(end + '</think>'.length).trim()
}

function thinkOf(output: string): string {
  const text = output.trimStart()
  if (!text.startsWith('<think')) return ''
  const end = text.indexOf('</think>')
  return text.slice(text.indexOf('>') + 1, end < 0 ? undefined : end).trim()
}

/** The cut a handoff card makes: which part of the conversation stops being readable. */
function CutNote(props: { record: TraceRecord }) {
  const relay = props.record.relay
  if (relay === undefined) return null
  const count = relay.to - relay.from
  return (
    <span className="rl-cut" title={`第 ${relay.from}–${relay.to - 1} 条历史（用户第 ${relay.turn} 轮，共 ${count} 条）被这张卡替换；此前的调用与结果不再逐条可见`}>
      ✂ 压缩 {count} 条历史 · 第 {relay.turn} 轮
    </span>
  )
}

/** One-line preview: the call as name + arguments, else the answer text. */
function Preview(props: { record: TraceRecord }) {
  if (props.record.stage === 'card') {
    // Records written before the relay field existed carry only the raw output.
    const card = props.record.relay?.card ?? afterThink(props.record.output ?? '')
    const fallback = props.record.relay?.fallback === true || props.record.outcome === 'card-empty'
    return (
      <span className="rl-text">
        {fallback ? <span className="rl-chip rl-chip-warn">自动摘要</span> : null}
        {card.replace(/\s+/g, ' ').slice(0, 220) || '（空卡）'}
      </span>
    )
  }
  const output = props.record.output ?? ''
  const action = afterThink(output)
  const call = /<tool_calls?>\s*([\s\S]*)/.exec(action)
  if (call !== null) {
    let name = ''
    let payload = call[1]!.replace(/<\/tool_calls?>\s*$/, '').trim()
    try {
      const parsed = JSON.parse(payload) as { name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const inner = parsed.function ?? parsed
      if (typeof inner.name === 'string') {
        name = inner.name
        payload = JSON.stringify(inner.arguments ?? {})
      }
    } catch {
      // Unparseable call: show it as written.
    }
    return (
      <span className="rl-text">
        {name ? <span className="rl-call-name">{name}</span> : null}
        <span className="rl-call-payload">{payload}</span>
      </span>
    )
  }
  const text = action || thinkOf(output)
  return <span className={`rl-text${action ? '' : ' rl-dim'}`}>{text.replace(/\s+/g, ' ') || '（空输出）'}</span>
}

interface Row {
  readonly index: number
  readonly record: TraceRecord
  readonly request: number
  readonly generation: number
  readonly first: boolean
}

function time(at: string | undefined): string {
  if (at === undefined) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
}

function KeyValue(props: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="rl-kv-key">{props.label}</span>
      <span className="rl-kv-value">{props.children}</span>
    </>
  )
}

function Inspector(props: { session: string; row: Row; step: TraceRecord | undefined; onClose: () => void }) {
  const { row, step } = props
  const { record } = row
  const [tab, setTab] = useState<'overview' | 'output' | 'prompt'>('overview')
  const [prompt, setPrompt] = useState<string | undefined>()
  const [error, setError] = useState('')
  useEffect(() => {
    setPrompt(undefined)
    setError('')
  }, [row.index])
  useEffect(() => {
    if (tab !== 'prompt' || prompt !== undefined) return
    let stopped = false
    fetchRecord(props.session, row.index)
      .then(body => { if (!stopped) setPrompt(body.record.prompt ?? '') })
      .catch((cause: unknown) => { if (!stopped) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { stopped = true }
  }, [tab, prompt, props.session, row.index])
  const tone = toneOf(record)
  const repairs = record.repairs ?? []
  const think = thinkOf(record.output ?? '')
  return (
    <aside className="rl-inspector" aria-label="生成详情">
      <div className="rl-inspector-head">
        <span className={`rl-tag rl-tone-${tone}`}>{OUTCOME_TAG[record.outcome ?? ''] ?? '生成'}</span>
        <span className="rl-inspector-title">请求 {row.request} · 第 {row.generation} 次生成{record.stage === 'answer' ? ' · 收尾阶段' : record.stage === 'card' ? ' · 写交接卡' : ''}</span>
        <button type="button" className="rl-icon" aria-label="关闭" onClick={props.onClose}>×</button>
      </div>
      <div className="rl-tabs" role="tablist">
        {([['overview', '概述'], ['output', '原始输出'], ['prompt', '提示词']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="rl-inspector-body">
        {tab === 'overview' ? (
          <>
            <div className="rl-kv">
              <KeyValue label="插件处理">{record.outcome === undefined ? `${record.action ?? '—'}（旧记录，没有判定）` : OUTCOME_LABEL[record.outcome] ?? record.outcome}</KeyValue>
              <KeyValue label="用到的修复">
                {repairs.length === 0 ? '无' : (
                  <span className="rl-chips">{repairs.map(repair => <span key={repair} className="rl-chip" title={repair}>{REPAIR_LABEL[repair] ?? repair}</span>)}</span>
                )}
              </KeyValue>
              <KeyValue label="解析为"><code>{record.action ?? '—'}</code></KeyValue>
              <KeyValue label="停止原因">{record.finish === 'length' ? '写满 token 上限' : record.finish ?? '—'}{record.stop ? `（${record.stop}）` : ''}</KeyValue>
              {step ? <KeyValue label="交给 DSH"><code>{step.decision}</code>{step.attempts && step.attempts > 1 ? ` · 这次请求生成了 ${step.attempts} 次` : ''}</KeyValue> : null}
              {step?.changes && step.changes.length > 0 ? (
                <KeyValue label="插件改的参数">
                  <span className="rl-change-list">{step.changes.map((change, index) => <span key={index}>{changeTitle(change)}</span>)}</span>
                </KeyValue>
              ) : null}
              {step && (step.outputRepairs === false || step.guards === false) ? (
                <KeyValue label="开关">{step.outputRepairs === false ? '修正模型输出：关 ' : ''}{step.guards === false ? '插件修复：关' : ''}</KeyValue>
              ) : null}
              <KeyValue label="模型">{record.model ?? '—'}</KeyValue>
              {record.purpose ? <KeyValue label="用途">{record.purpose}</KeyValue> : null}
              <KeyValue label="时间">{time(record.at)}</KeyValue>
            </div>
            {think ? (
              <>
                <div className="rl-section-title">思考</div>
                <div className="rl-prose">{think}</div>
              </>
            ) : null}
            {record.stage === 'card' && record.relay !== undefined ? (
              <>
                <div className="rl-section-title">这一步切掉了什么</div>
                <div className="rl-kv">
                  <KeyValue label="覆盖范围">第 {record.relay.from}–{record.relay.to - 1} 条历史（共 {record.relay.to - record.relay.from} 条）</KeyValue>
                  <KeyValue label="所属轮次">用户第 {record.relay.turn} 轮</KeyValue>
                  <KeyValue label="卡片来源">{record.relay.fallback ? '自动摘要（模型没写出可用的卡）' : '模型自己写的'}</KeyValue>
                </div>
                <div className="rl-section-title">写进上下文的卡片</div>
                <pre className="rl-pre">{record.relay.card || '（空卡）'}</pre>
                <p className="rwkv-hint">这张卡会替换上面那些历史；此后的请求只能看到卡片，看不到被压缩的调用与结果原文。</p>
              </>
            ) : null}
            <div className="rl-section-title">模型写的动作</div>
            <pre className="rl-pre">{afterThink(record.output ?? '') || '（无）'}</pre>
            {step?.args && (record.outcome === 'run') ? (
              <>
                <div className="rl-section-title">DSH 收到的参数</div>
                <pre className="rl-pre">{JSON.stringify(step.args, null, 2)}</pre>
              </>
            ) : null}
          </>
        ) : tab === 'output' ? (
          <pre className="rl-pre rl-pre-full">{record.output ?? ''}</pre>
        ) : error ? <p className="rwkv-error">{error}</p> : prompt === undefined ? <p className="rwkv-hint">加载中…</p> : (
          <pre className="rl-pre rl-pre-full">{prompt}</pre>
        )}
      </div>
    </aside>
  )
}

export function TraceFrames(props: { session: string; records: readonly TraceRecord[]; onlyTouched: boolean; showSide: boolean }) {
  const [selected, setSelected] = useState<number | undefined>()
  const rows: Row[] = []
  const steps = new Map<number, TraceRecord>()
  let request = 1
  let generation = 0
  props.records.forEach((record, index) => {
    if (!props.showSide && record.purpose !== undefined) return
    if (record.stage === 'step') {
      steps.set(request, record)
      rows.push({ index, record, request, generation, first: false })
      request++
      generation = 0
      return
    }
    // A handoff card is its own generation: it runs before the decision of the
    // same request and is the reason that decision sees less history.
    if (!isGeneration(record) && !isCard(record)) return
    generation++
    rows.push({ index, record, request, generation, first: generation === 1 })
  })
  const visible = props.onlyTouched ? rows.filter(row => row.record.stage !== 'step' && touched(row.record)) : rows
  const current = rows.find(row => row.index === selected)
  if (visible.length === 0) {
    return <p className="rl-empty">{props.onlyTouched ? '这个会话里没有用到兜底的生成。' : '这个会话还没有 RWKV 记录。'}</p>
  }
  return (
    <div className="rl-ledger">
      <div className="rl-scroll">
      <table className="rl-table">
        <colgroup><col className="rl-event-col" /><col /></colgroup>
        <tbody>
          {visible.map(row => {
            if (row.record.stage === 'step') {
              return (
                <tr key={row.index} className="rl-step-row">
                  <td className="rl-event"><span className="rl-rail" /></td>
                  <td className="rl-content"><HandedLine record={row.record} /></td>
                </tr>
              )
            }
            const tone = toneOf(row.record)
            const repairs = row.record.repairs ?? []
            return (
              <tr
                key={row.index} tabIndex={0} data-selected={row.index === selected} data-turn-start={row.first && !props.onlyTouched}
                onClick={() => setSelected(current => current === row.index ? undefined : row.index)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(row.index) } }}
              >
                <td className="rl-event">
                  <span className={`rl-rail rl-rail-${tone}`} />
                  {row.first || props.onlyTouched ? <span className="rl-turn-label">请求 {row.request}</span> : null}
                  <span className={`rl-tag rl-tone-${tone}`} title={row.record.outcome === undefined ? '旧记录' : OUTCOME_LABEL[row.record.outcome] ?? row.record.outcome}>
                    {row.record.outcome === undefined ? '生成' : OUTCOME_TAG[row.record.outcome] ?? row.record.outcome}
                  </span>
                </td>
                <td className="rl-content">
                  <span className="rl-content-inner">
                    {row.record.stage === 'answer' ? <span className="rl-chip rl-chip-muted">收尾阶段</span> : null}
                    <CutNote record={row.record} />
                    {row.record.finish === 'length' ? <span className="rl-chip rl-chip-warn">写满上限</span> : null}
                    <Preview record={row.record} />
                    {repairs.map(repair => <span key={repair} className="rl-chip rl-chip-warn" title={repair}>{REPAIR_LABEL[repair] ?? repair}</span>)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      {current ? <Inspector session={props.session} row={current} step={steps.get(current.request)} onClose={() => setSelected(undefined)} /> : null}
    </div>
  )
}
