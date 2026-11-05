// "RWKV" tab in the conversation view ring: the current session's raw trace
// frame by frame, with the frames where a crutch acted marked. DSH's own
// Trajectory tab shows DSH's record (repaired calls, merged reasoning); this
// one shows what RWKV received and wrote per generation.

import { useEffect, useState } from 'react'
import { TraceFrames } from './TraceFrames.tsx'
import { fetchSession, isGeneration, touched, type TraceRecord } from './traces-api.ts'

const POLL_MS = 3000

export function RwkvTraceView(props: { session: string }) {
  const [records, setRecords] = useState<TraceRecord[] | undefined>()
  const [recording, setRecording] = useState(true)
  const [error, setError] = useState('')
  const [onlyTouched, setOnlyTouched] = useState(false)
  const [showSide, setShowSide] = useState(false)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const body = await fetchSession(props.session)
          if (stopped) return
          setRecording(body.recording)
          // Same length: nothing new was appended, keep the rendered rows.
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
  const hit = generations.filter(touched).length
  return (
    <div className="rwkv-section rwkv-view">
      <div className="rwkv-view-bar">
        <span className="rwkv-name">RWKV 原始轨迹</span>
        <span className="rwkv-meta">{generations.length} 次生成 · {hit} 次用到兜底</span>
        <label className="rwkv-check"><input type="checkbox" checked={onlyTouched} onChange={event => setOnlyTouched(event.target.checked)} />只看用到兜底的生成</label>
        <label className="rwkv-check"><input type="checkbox" checked={showSide} onChange={event => setShowSide(event.target.checked)} />显示会话标题等附带请求</label>
      </div>
      {recording ? null : <p className="rwkv-hint">轨迹记录已关闭，新的生成不会出现在这里。在设置 → RWKV → 开发者里打开。</p>}
      {error ? <p className="rwkv-error">{error}</p> : null}
      {records === undefined ? <p className="rwkv-hint">加载中…</p> : (
        <TraceFrames session={props.session} records={records} onlyTouched={onlyTouched} showSide={showSide} />
      )}
    </div>
  )
}
