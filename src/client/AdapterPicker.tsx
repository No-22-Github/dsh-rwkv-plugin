// Adapter choice for an rwkv_lightning model, as in the RWKV-Agent App
// (cmd/rwkv-app/frontend/src/components/settings/AdapterSection.tsx): the
// adapters the server already has, "use" one or the base model, upload a
// local file with its id suggested from the file name, delete with a
// confirmation. The Host relays every call (see src/routes.ts).

import { useEffect, useRef, useState } from 'react'

const ROUTE = '/api/rwkv/adapters'

export interface AdapterConnection {
  baseURL: string
  apiKey?: string | undefined
  headers?: Record<string, string> | undefined
}

interface ServerAdapter {
  id: string
  method: string
  rank?: number
  version: string
}

function connectionHeader(connection: AdapterConnection): string {
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

/** MiSS / NoRA from the server manifest; anything else upper-cased. */
function methodLabel(method: string): string {
  const value = method.trim().toLowerCase()
  if (value === 'miss') return 'MiSS'
  if (value === 'nora') return 'NoRA'
  return value.toUpperCase()
}

/**
 * Training outputs share fixed file names (adapter-final.pth,
 * checkpoint-N/training.pth); the directory tells them apart. A browser file
 * carries only its name, so that is all this sees in practice.
 */
export function suggestID(path: string): string {
  const parts = path.trim().split(/[\\/]+/).filter(Boolean)
  const stem = (parts.at(-1) || '').replace(/\.pth$/i, '')
  if (stem === 'adapter-final' || stem === 'training') {
    const parent = parts.at(-2) || ''
    if (/^checkpoint-\d+$/.test(parent) && parts.length >= 3) return `${parts.at(-3)}-${parent}`
    return parent || stem
  }
  return stem
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value.trim()).protocol)
  } catch {
    return false
  }
}

export function AdapterPicker(props: {
  connection: AdapterConnection
  value: string | undefined
  disabled: boolean
  onChange: (id: string | undefined) => void
}) {
  const { connection } = props
  const ready = isHttpUrl(connection.baseURL)
  const key = JSON.stringify(connection)
  const [adapters, setAdapters] = useState<ServerAdapter[] | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ file: File; id: string } | undefined>()
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
      const response = await fetch(ROUTE, { headers: { 'x-rwkv-connection': connectionHeader(connection) }, credentials: 'same-origin' })
      if (!response.ok) throw new Error(await failureOf(response))
      const body = await response.json() as { adapters: ServerAdapter[] }
      if (current === request.current) setAdapters(body.adapters)
    } catch (cause) {
      if (current === request.current) {
        setAdapters(undefined)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    setAdapters(undefined)
    if (!ready) return
    const timer = setTimeout(() => { void refresh() }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  const upload = (file: File, id: string) => {
    setError('')
    setProgress(0)
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${ROUTE}/${encodeURIComponent(id)}?name=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('x-rwkv-connection', connectionHeader(connection))
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded * 100) / event.total))
    }
    xhr.onload = () => {
      setProgress(undefined)
      if (xhr.status >= 200 && xhr.status < 300) {
        setPending(undefined)
        props.onChange(id)
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
      const response = await fetch(`${ROUTE}/${encodeURIComponent(id)}`, {
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
  const missing = adapters !== undefined && current !== '' && !adapters.some(adapter => adapter.id === current)

  return (
    <div className="rwkv-field">
      <div className="rwkv-block-head">
        <span className="rwkv-label">Adapter</span>
        <span className="rwkv-actions">
          <button type="button" className="rwkv-link" disabled={busy || !ready} onClick={() => { void refresh() }}>{loading ? '刷新中…' : '刷新'}</button>
          <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={busy || !ready} onClick={() => fileInput.current?.click()}>上传</button>
        </span>
        <input
          ref={fileInput} type="file" accept=".pth" hidden
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) setPending({ file, id: suggestID(file.name) })
          }}
        />
      </div>
      <div className="rwkv-list">
        <button type="button" className="rwkv-option" aria-pressed={current === ''} disabled={props.disabled} onClick={() => props.onChange(undefined)}>
          <span className="rwkv-option-name">基模</span>
          {current === '' ? <span className="rwkv-option-state">使用中</span> : null}
        </button>
        {(adapters ?? []).map(adapter => (
          <div key={adapter.id} className="rwkv-option" aria-pressed={current === adapter.id}>
            <button type="button" className="rwkv-option-main" disabled={props.disabled} onClick={() => props.onChange(adapter.id)}>
              <span className="rwkv-option-name">{adapter.id}</span>
              <span className="rwkv-option-meta">
                {[methodLabel(adapter.method), adapter.rank ? `rank ${adapter.rank}` : '', adapter.version.slice(0, 8)].filter(Boolean).join(' · ')}
              </span>
              {current === adapter.id ? <span className="rwkv-option-state">使用中</span> : null}
            </button>
            {deleting === adapter.id ? (
              <span className="rwkv-actions">
                <button type="button" className="rwkv-link" onClick={() => setDeleting(undefined)}>取消</button>
                <button type="button" className="rwkv-btn rwkv-secondary rwkv-small rwkv-danger" onClick={() => { void remove(adapter.id) }}>从服务器删除</button>
              </span>
            ) : (
              <button type="button" className="rwkv-link" disabled={busy} onClick={() => setDeleting(adapter.id)}>删除</button>
            )}
          </div>
        ))}
        {missing ? (
          <div className="rwkv-option" aria-pressed>
            <span className="rwkv-option-main">
              <span className="rwkv-option-name">{current}</span>
              <span className="rwkv-error">不在服务器上</span>
            </span>
          </div>
        ) : null}
      </div>
      {pending ? (
        <div className="rwkv-upload">
          <span className="rwkv-option-meta" title={pending.file.name}>{pending.file.name} · {(pending.file.size / 1048576).toFixed(1)} MB</span>
          <div className="rwkv-upload-row">
            <input className="rwkv-input" value={pending.id} spellCheck={false} placeholder="adapter id" disabled={progress !== undefined} onChange={event => setPending({ ...pending, id: event.target.value })} />
            <button type="button" className="rwkv-btn rwkv-primary rwkv-small" disabled={!pending.id.trim() || progress !== undefined} onClick={() => upload(pending.file, pending.id.trim())}>
              {progress === undefined ? '上传' : `${progress}%`}
            </button>
            <button type="button" className="rwkv-link" disabled={progress !== undefined} onClick={() => setPending(undefined)}>取消</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="rwkv-error">{error}</p> : null}
    </div>
  )
}
