// Server-side helpers for one model's editor, relayed by the Host (see
// src/routes.ts): the model ids the server lists, used to prefill the
// upstream model id, and the rwkv_lightning initial states — the ones the
// server already has, "use" one or the zero state, upload a local .pth,
// delete with a confirmation.

import { useEffect, useRef, useState } from 'react'
import { isHttpUrl } from './url.ts'

export { normalizeBaseURL } from './url.ts'

const MODEL_ROUTE = '/api/rwkv/models'
const STATE_ROUTE = '/api/rwkv/states'

export interface ServerConnection {
  baseURL: string
  apiKey?: string | undefined
  headers?: Record<string, string> | undefined
}

interface ServerState {
  state_id: string
  original_filename?: string
  size_bytes?: number
  layers?: number
  heads?: number
  head_size?: number
  uploaded_at?: string
}

function connectionHeader(connection: ServerConnection): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    baseURL: connection.baseURL.trim(),
    ...connection.apiKey ? { apiKey: connection.apiKey } : {},
    ...connection.headers ? { headers: connection.headers } : {},
  }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function failureOf(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string }
    return body.error || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

/**
 * Model ids the server lists, fetched (debounced) whenever the connection
 * changes. `error` is set when the server could not be asked.
 */
export function useServerModels(connection: ServerConnection): { models: string[] | undefined; loading: boolean; error: string } {
  const ready = isHttpUrl(connection.baseURL)
  const key = JSON.stringify(connection)
  const [models, setModels] = useState<string[] | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setModels(undefined)
    setError('')
    if (!ready) return
    let live = true
    const timer = setTimeout(() => {
      setLoading(true)
      void (async () => {
        try {
          const response = await fetch(MODEL_ROUTE, { headers: { 'x-rwkv-connection': connectionHeader(connection) }, credentials: 'same-origin' })
          if (!response.ok) throw new Error(await failureOf(response))
          const body = await response.json() as { models: string[] }
          if (live) setModels(body.models)
        } catch (cause) {
          if (live) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (live) setLoading(false)
        }
      })()
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])
  return { models, loading, error }
}

function stateMeta(state: ServerState): string {
  return [
    state.original_filename,
    state.size_bytes === undefined ? '' : `${(state.size_bytes / 1048576).toFixed(1)} MB`,
    state.layers ? `${state.layers} 层` : '',
    state.uploaded_at ? state.uploaded_at.slice(0, 16).replace('T', ' ') : '',
  ].filter(Boolean).join(' · ')
}

export function StatePicker(props: {
  connection: ServerConnection
  value: string | undefined
  disabled: boolean
  onChange: (id: string | undefined) => void
}) {
  const { connection } = props
  const ready = isHttpUrl(connection.baseURL)
  const key = JSON.stringify(connection)
  const [states, setStates] = useState<ServerState[] | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<number | undefined>()
  const [deleting, setDeleting] = useState<string | undefined>()
  const fileInput = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  const refresh = async () => {
    if (!ready) return
    const current = ++request.current
    setLoading(true)
    setError('')
    try {
      const response = await fetch(STATE_ROUTE, { headers: { 'x-rwkv-connection': connectionHeader(connection) }, credentials: 'same-origin' })
      if (!response.ok) throw new Error(await failureOf(response))
      const body = await response.json() as { states: ServerState[] }
      if (current === request.current) setStates(body.states)
    } catch (cause) {
      if (current === request.current) {
        setStates(undefined)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    setStates(undefined)
    if (!ready) return
    const timer = setTimeout(() => { void refresh() }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  // The server names the state (file stem + UUID); the new id is selected right away.
  const upload = (file: File) => {
    setError('')
    setProgress(0)
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${STATE_ROUTE}?name=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('x-rwkv-connection', connectionHeader(connection))
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded * 100) / event.total))
    }
    xhr.onload = () => {
      setProgress(undefined)
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { state: ServerState }
          props.onChange(body.state.state_id)
        } catch { /* the list below still shows it */ }
        void refresh()
      } else {
        let message = `HTTP ${xhr.status}`
        try { message = (JSON.parse(xhr.responseText) as { error?: string }).error || message } catch { /* keep the status */ }
        setError(message)
      }
    }
    xhr.onerror = () => {
      setProgress(undefined)
      setError('上传中断：连接被断开')
    }
    xhr.send(file)
  }

  const remove = async (id: string) => {
    setDeleting(undefined)
    setError('')
    try {
      const response = await fetch(`${STATE_ROUTE}/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { 'x-rwkv-connection': connectionHeader(connection) }, credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(await failureOf(response))
      if (props.value === id) props.onChange(undefined)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const current = props.value?.trim() || ''
  const busy = props.disabled || loading || progress !== undefined
  const missing = states !== undefined && current !== '' && !states.some(state => state.state_id === current)

  return (
    <div className="rwkv-field">
      <div className="rwkv-block-head">
        <span className="rwkv-label">State</span>
        <span className="rwkv-actions">
          <button type="button" className="rwkv-link" disabled={busy || !ready} onClick={() => { void refresh() }}>{loading ? '刷新中…' : '刷新'}</button>
          <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || !ready} onClick={() => fileInput.current?.click()}>
            {progress === undefined ? '上传' : `${progress}%`}
          </button>
        </span>
        <input
          ref={fileInput} type="file" accept=".pth" hidden
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) upload(file)
          }}
        />
      </div>
      <div className="rwkv-list">
        <button type="button" className="rwkv-option" aria-pressed={current === ''} disabled={props.disabled} onClick={() => props.onChange(undefined)}>
          <span className="rwkv-option-name">不用 state</span>
          {current === '' ? <span className="rwkv-option-state">使用中</span> : null}
        </button>
        {(states ?? []).map(state => (
          <div key={state.state_id} className="rwkv-option" aria-pressed={current === state.state_id}>
            <button type="button" className="rwkv-option-main" disabled={props.disabled} onClick={() => props.onChange(state.state_id)}>
              <span className="rwkv-option-name" title={state.state_id}>{state.state_id}</span>
              <span className="rwkv-option-meta">{stateMeta(state)}</span>
              {current === state.state_id ? <span className="rwkv-option-state">使用中</span> : null}
            </button>
            {deleting === state.state_id ? (
              <span className="rwkv-actions">
                <button type="button" className="rwkv-link" onClick={() => setDeleting(undefined)}>取消</button>
                <button type="button" className="rwkv-btn rwkv-secondary rwkv-small rwkv-danger" onClick={() => { void remove(state.state_id) }}>从服务器删除</button>
              </span>
            ) : (
              <button type="button" className="rwkv-link" disabled={busy} onClick={() => setDeleting(state.state_id)}>删除</button>
            )}
          </div>
        ))}
        {missing ? (
          <div className="rwkv-option" aria-pressed>
            <span className="rwkv-option-main">
              <span className="rwkv-option-name">{current}</span>
              <span className="rwkv-error">不在服务器上（服务重启会清掉上传的 state，需要重新上传）</span>
            </span>
          </div>
        ) : null}
      </div>
      {error ? <p className="rwkv-error">{error}</p> : null}
    </div>
  )
}
