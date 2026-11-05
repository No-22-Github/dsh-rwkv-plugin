// Host routes behind the authenticated /api bridge for the settings page's
// adapter list. The browser cannot reach the inference server (other origin,
// often a Tailscale address), so the Host lists, uploads and deletes for it.
// Handlers run on the `connection/request` waterfall, i.e. only after
// client-connection admitted the request with the same cookie and origin
// checks as every DSH API call.

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BackendError } from './backend/generator.ts'
import { LightningClient, MAX_ADAPTER_UPLOAD_BYTES } from './backend/lightning.ts'
import { exportTask, listSessions, readTrace, tracePath, traceStats } from './traces.ts'

export const ADAPTER_ROUTE = '/api/rwkv/adapters'

/** The draft model's connection, sent by the page so unsaved edits can be listed against. */
interface Connection {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

function connectionOf(request: IncomingMessage): Connection {
  const raw = request.headers['x-rwkv-connection']
  if (typeof raw !== 'string' || raw === '') throw new BackendError('missing x-rwkv-connection header', 'BAD_REQUEST', 400)
  const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Connection
  if (typeof parsed.baseURL !== 'string' || !/^https?:\/\//.test(parsed.baseURL)) {
    throw new BackendError('baseURL must be an http(s) URL', 'BAD_REQUEST', 400)
  }
  return parsed
}

function clientFor(connection: Connection): LightningClient {
  return new LightningClient({
    baseURL: connection.baseURL,
    model: '',
    ...connection.apiKey ? { password: connection.apiKey } : {},
    ...connection.headers ? { headers: connection.headers } : {},
  })
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_ADAPTER_UPLOAD_BYTES) throw new BackendError(`adapter file is over ${MAX_ADAPTER_UPLOAD_BYTES >> 20} MB`, 'PAYLOAD_TOO_LARGE', 413)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/**
 * Serves one request when it belongs to {@link ADAPTER_ROUTE}; returns false
 * for any other path so the waterfall continues.
 */
export async function handleAdapterRoute(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://host')
  if (url.pathname !== ADAPTER_ROUTE && !url.pathname.startsWith(`${ADAPTER_ROUTE}/`)) return false
  const id = decodeURIComponent(url.pathname.slice(ADAPTER_ROUTE.length + 1))
  try {
    const client = clientFor(connectionOf(request))
    if (request.method === 'GET' && id === '') {
      const adapters = await client.listAdapters()
      send(response, 200, {
        adapters: adapters.map(adapter => {
          const manifest = (adapter.manifest ?? {}) as Record<string, unknown>
          return {
            id: adapter.id,
            method: typeof manifest.method === 'string' ? manifest.method : '',
            rank: typeof manifest.rank === 'number' ? manifest.rank : undefined,
            version: String(manifest.content_version ?? adapter.version ?? ''),
          }
        }),
      })
    } else if (request.method === 'PUT' && id !== '') {
      const body = await readBody(request)
      const name = url.searchParams.get('name') || `${id}.pth`
      const version = await client.uploadAdapterBlob(id, new Blob([new Uint8Array(body)]), name)
      send(response, 200, { id, version })
    } else if (request.method === 'DELETE' && id !== '') {
      await client.deleteAdapter(id)
      send(response, 200, { id })
    } else {
      send(response, 405, { error: 'method not allowed' })
    }
  } catch (error) {
    const status = error instanceof BackendError
      ? error.code === 'ADAPTERS_UNSUPPORTED' ? 404 : error.status && error.status < 500 ? error.status : 502
      : 502
    const message = error instanceof BackendError && error.code === 'ADAPTERS_UNSUPPORTED'
      ? '这个服务不支持 adapter（没有 /v1/adapters）'
      : error instanceof Error ? error.message : String(error)
    if (!response.headersSent) send(response, status, { error: message })
  }
  return true
}

export const TRACE_ROUTE = '/api/rwkv/traces'
export const TRACE_EXPORT_ROUTE = '/api/rwkv/trace-export'

export interface TraceRouteSettings {
  /** Directory the traces are read from (the configured one or the default). */
  readonly dir: string
  readonly recording: boolean
}

/**
 * Developer tools over the trace directory, GET only:
 *   /api/rwkv/traces                       session list + statistics over all sessions
 *   /api/rwkv/traces/<session>             the session's records, prompts left out (promptChars instead)
 *   /api/rwkv/traces/<session>?index=N     one record with its prompt
 *   /api/rwkv/trace-export?sessions=a,b    whole tasks as JSONL (all sessions when the list is empty)
 */
export function handleTraceRoute(request: IncomingMessage, response: ServerResponse, settings: () => TraceRouteSettings): boolean {
  const url = new URL(request.url ?? '/', 'http://host')
  const isList = url.pathname === TRACE_ROUTE || url.pathname.startsWith(`${TRACE_ROUTE}/`)
  if (!isList && url.pathname !== TRACE_EXPORT_ROUTE) return false
  if (request.method !== 'GET') {
    send(response, 405, { error: 'method not allowed' })
    return true
  }
  const { dir, recording } = settings()
  try {
    if (url.pathname === TRACE_EXPORT_ROUTE) {
      const wanted = (url.searchParams.get('sessions') ?? '').split(',').map(item => item.trim()).filter(Boolean)
      const sessions = wanted.length > 0 ? wanted : listSessions(dir).map(item => item.session)
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="rwkv-traces-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.jsonl"`,
        'cache-control': 'no-store',
      })
      for (const session of sessions) {
        const path = tracePath(dir, session)
        if (path === undefined || !existsSync(path)) continue
        response.write(`${JSON.stringify(exportTask(session, readTrace(path)))}\n`)
      }
      response.end()
      return true
    }
    const session = decodeURIComponent(url.pathname.slice(TRACE_ROUTE.length + 1))
    if (session === '') {
      const sessions = listSessions(dir)
      const records = sessions.flatMap(item => readTrace(tracePath(dir, item.session)!))
      send(response, 200, { dir, recording, sessions, stats: traceStats(records) })
      return true
    }
    const path = tracePath(dir, session)
    if (path === undefined || !existsSync(path)) {
      send(response, 200, { dir, recording, session, records: [] })
      return true
    }
    const records = readTrace(path)
    const index = url.searchParams.get('index')
    if (index !== null) {
      const record = records[Number(index)]
      if (record === undefined) send(response, 404, { error: 'no such record' })
      else send(response, 200, { record })
      return true
    }
    send(response, 200, {
      dir, recording, session,
      records: records.map(({ prompt, ...rest }) => prompt === undefined ? rest : { ...rest, promptChars: prompt.length }),
    })
  } catch (error) {
    if (!response.headersSent) send(response, 500, { error: error instanceof Error ? error.message : String(error) })
    else response.end()
  }
  return true
}
