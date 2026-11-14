// "RWKV" tab in the conversation view ring: the current session's raw trace
// as a ledger, laid out like DSH's Trajectory tab. DSH's own Trajectory shows
// DSH's record (repaired calls, merged reasoning); this one shows what RWKV
// received and wrote per generation and where the plugin stepped in.

import { useEffect, useState } from 'react'
import { TraceFrames } from './TraceFrames.tsx'
import { fetchSession, isCard, isGeneration, percent, touched, type TraceRecord } from './traces-api.ts'

const POLL_MS = 2500

export function RwkvTraceView(props: { session: string }) {
  const [records, setRecords] = useState<TraceRecord[] | undefined>()
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')
  const [onlyTouched, setOnlyTouched] = useState(false)
  const [showSide, setShowSide] = useState(false)
  useEffect(() => {
    setRecords(undefined)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let first = true
    const load = async () => {
      // The first load always runs; polling pauses while the page is hidden.
      if (first || document.visibilityState === 'visible') {
        first = false
        try {
          const body = await fetchSession(props.session)
          if (stopped) return
          setRecording(body.recording)
          // Same length: nothing new was appended, keep the rendered rows (and the selection).
          setRecords(current => current !== undefined && current.length === body.records.length ? current : body.records)
          setError('')
        } catch (cause) {
          if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
      if (!stopped) timer = setTimeout(() => { void load() }, POLL_MS)
    }
    void load()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.session])

  const generations = (records ?? []).filter(record => isGeneration(record) && record.purpose === undefined)
  // Handoff cards are generations too, but they are not decisions: they are
  // counted apart so "原样可用" keeps meaning "the model decided correctly".
  const cards = (records ?? []).filter(record => isCard(record) && record.purpose === undefined)
  const fallbackCards = cards.filter(record => record.relay?.fallback === true).length
  const judged = generations.filter(record => record.outcome !== undefined)
  const hit = judged.filter(touched).length
  return (
    <div className="rl-root">
      <div className="rl-toolbar">
        <div className="rl-toggles">
          <button type="button" className="rl-toggle" aria-pressed={onlyTouched} onClick={() => setOnlyTouched(value => !value)}>只看兜底</button>
          <button type="button" className="rl-toggle" aria-pressed={showSide} onClick={() => setShowSide(value => !value)}>附带请求</button>
        </div>
        <span className="rl-summary">
          {generations.length} 次生成 · {hit} 次用到兜底{judged.length > 0 ? ` · 原样可用 ${percent(judged.length - hit, judged.length)}` : ''}
          {cards.length > 0 ? ` · 接力卡 ${cards.length} 张${fallbackCards > 0 ? `（自动摘要 ${fallbackCards}）` : ''}` : ''}
        </span>
      </div>
      {error ? <p className="rl-notice rwkv-error">{error}</p> : null}
      {records !== undefined && records.length > 0 && !recording ? (
        <p className="rl-notice">轨迹只在内存里，DSH 重启后清空。要落盘，去设置 → RWKV Agent → 开发者打开「原始运行轨迹落盘」。</p>
      ) : null}
      {records === undefined ? <p className="rl-empty">加载中…</p> : records.length === 0 ? (
        <p className="rl-empty">这个会话没有 RWKV 记录：它没用 RWKV 模型，或者轨迹没有保存到磁盘、已被删除。</p>
      ) : (
        <TraceFrames session={props.session} records={records} onlyTouched={onlyTouched} showSide={showSide} />
      )}
    </div>
  )
}
