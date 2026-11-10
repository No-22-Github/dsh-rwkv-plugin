// Host routes behind the authenticated /api bridge for the settings page:
// the models a server lists (to prefill the upstream model id) and the
// rwkv_lightning initial states (list / upload / delete). The browser cannot
// reach the inference server (other origin, often a Tailscale address), so
// the Host relays for it. Handlers run on the `connection/request` waterfall,
// i.e. only after client-connection admitted the request with the same
// cookie and origin checks as every DSH API call.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BackendError, listModels } from './backend/generator.ts'
import { LightningClient, MAX_ADAPTER_UPLOAD_BYTES, MAX_STATE_UPLOAD_BYTES } from './backend/lightning.ts'
import { allSessions, deleteTrace, exportTask, sessionRecords, traceStats, type TraceLocation } from './traces.ts'

export const MODEL_ROUTE = '/api/rwkv/models'
export const STATE_ROUTE = '/api/rwkv/states'
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

/** Reads an upload, stopping at `limit` bytes (checked against content-length first, then while streaming). */
async function readBody(request: IncomingMessage, limit = MAX_STATE_UPLOAD_BYTES, what = 'state'): Promise<Buffer> {
  const tooLarge = () => new BackendError(`${what} file is over ${limit >> 20} MB`, 'PAYLOAD_TOO_LARGE', 413)
  if (Number(request.headers['content-length']) > limit) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw tooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function failure(response: ServerResponse, error: unknown): void {
  const status = error instanceof BackendError
    ? (error.code === 'STATES_UNSUPPORTED' || error.code === 'ADAPTERS_UNSUPPORTED') ? 404 : error.status && error.status < 500 ? error.status : 502
    : 502
  const message = error instanceof BackendError && error.code === 'STATES_UNSUPPORTED'
    ? '这个服务不支持上传 state（没有 /v1/state 接口）'
    : error instanceof BackendError && error.code === 'ADAPTERS_UNSUPPORTED'
    ? '这个服务不支持 adapter（没有 /v1/adapters 接口）'
    : error instanceof Error ? error.message : String(error)
  if (!response.headersSent) send(response, status, { error: message })
}

/**
 * Serves one request when it belongs to {@link MODEL_ROUTE}, {@link STATE_ROUTE}
 * or {@link ADAPTER_ROUTE}; returns false for any other path so the waterfall continues.
 *   GET    /api/rwkv/models              { models: string[] }
 *   GET    /api/rwkv/states              { states: StateInfo[] }
 *   PUT    /api/rwkv/states?name=FILE    body = file bytes → { state: StateInfo }
 *   DELETE /api/rwkv/states/<state id>
 *   GET    /api/rwkv/adapters            { adapters: ServerAdapter[] }
 *   PUT    /api/rwkv/adapters/<id>?name= body = file bytes → { id, version }
 *   DELETE /api/rwkv/adapters/<id>
 */
export async function handleServerRoute(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://host')
  const isModels = url.pathname === MODEL_ROUTE
  const isStates = url.pathname === STATE_ROUTE || url.pathname.startsWith(`${STATE_ROUTE}/`)
  const isAdapters = url.pathname === ADAPTER_ROUTE || url.pathname.startsWith(`${ADAPTER_ROUTE}/`)
  if (!isModels && !isStates && !isAdapters) return false
  try {
    const connection = connectionOf(request)
    if (isModels) {
      if (request.method !== 'GET') {
        send(response, 405, { error: 'method not allowed' })
        return true
      }
      const models = await listModels(connection.baseURL, {
        ...connection.apiKey ? { apiKey: connection.apiKey } : {},
        ...connection.headers ? { headers: connection.headers } : {},
      })
      send(response, 200, { models })
      return true
    }
    if (isAdapters) {
      const id = decodeURIComponent(url.pathname.slice(ADAPTER_ROUTE.length + 1))
      const client = clientFor(connection)
      if (request.method === 'GET' && id === '') {
        const adapters = await client.listAdapters()
        send(response, 200, {
          adapters: adapters.map(adapter => {
            const manifest = (adapter.manifest ?? {}) as Record<string, unknown>
            return {
              id: adapter.id,
              method: typeof manifest.method === 'string' ? manifest.method : '',
              rank: typeof manifest.rank === 'number' ? manifest.rank : undefined,
              version: String(adapter.version ?? manifest.content_version ?? ''),
            }
          }),
        })
      } else if (request.method === 'PUT' && id !== '') {
        const body = await readBody(request, MAX_ADAPTER_UPLOAD_BYTES, 'adapter')
        const name = url.searchParams.get('name') || `${id}.pth`
        const version = await client.uploadAdapterBlob(id, new Blob([new Uint8Array(body)]), name)
        send(response, 200, { id, version })
      } else if (request.method === 'DELETE' && id !== '') {
        await client.deleteAdapter(id)
        send(response, 200, { id })
      } else {
        send(response, 405, { error: 'method not allowed' })
      }
      return true
    }
    const id = decodeURIComponent(url.pathname.slice(STATE_ROUTE.length + 1))
    const client = clientFor(connection)
    if (request.method === 'GET' && id === '') {
      send(response, 200, { states: await client.listStates() })
    } else if (request.method === 'PUT' && id === '') {
      const body = await readBody(request)
      const name = url.searchParams.get('name') || 'state.pth'
      send(response, 200, { state: await client.uploadStateBlob(new Blob([new Uint8Array(body)]), name) })
    } else if (request.method === 'DELETE' && id !== '') {
      await client.deleteState(id)
      send(response, 200, { id })
    } else {
      send(response, 405, { error: 'method not allowed' })
    }
  } catch (error) {
    failure(response, error)
  }
  return true
}

export const TRACE_ROUTE = '/api/rwkv/traces'
export const TRACE_EXPORT_ROUTE = '/api/rwkv/trace-export'

export interface TraceRouteSettings {
  /** Where trace files are (next to DSH's session logs, or a custom directory). */
  readonly location: TraceLocation
  /** Whether new traces are also written to disk (they are always kept in memory). */
  readonly recording: boolean
}

/**
 * Developer tools over the traces (memory and disk):
 *   /api/rwkv/traces                       session list + statistics over all sessions
 *   /api/rwkv/traces/<session>             the session's records, prompts left out (promptChars instead)
 *   /api/rwkv/traces/<session>?index=N     one record with its prompt
 *   DELETE /api/rwkv/traces/<session>      remove the session's RWKV trace (never DSH's own session log)
 *   /api/rwkv/trace-export?sessions=a,b    whole tasks as JSONL (all sessions when the list is empty)
 */
export function handleTraceRoute(request: IncomingMessage, response: ServerResponse, settings: () => TraceRouteSettings): boolean {
  const url = new URL(request.url ?? '/', 'http://host')
  const isList = url.pathname === TRACE_ROUTE || url.pathname.startsWith(`${TRACE_ROUTE}/`)
  if (!isList && url.pathname !== TRACE_EXPORT_ROUTE) return false
  const { location, recording } = settings()
  const dir = location.describe()
  const deleting = request.method === 'DELETE' && isList && url.pathname.length > TRACE_ROUTE.length + 1
  if (request.method !== 'GET' && !deleting) {
    send(response, 405, { error: 'method not allowed' })
    return true
  }
  try {
    if (deleting) {
      const session = decodeURIComponent(url.pathname.slice(TRACE_ROUTE.length + 1))
      send(response, 200, { session, deleted: deleteTrace(location, session) })
      return true
    }
    if (url.pathname === TRACE_EXPORT_ROUTE) {
      const wanted = (url.searchParams.get('sessions') ?? '').split(',').map(item => item.trim()).filter(Boolean)
      const sessions = wanted.length > 0 ? wanted : allSessions(location).map(item => item.session)
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="rwkv-traces-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.jsonl"`,
        'cache-control': 'no-store',
      })
      for (const session of sessions) {
        const records = sessionRecords(location, session)
        if (records.length === 0) continue
        response.write(`${JSON.stringify(exportTask(session, records))}\n`)
      }
      response.end()
      return true
    }
    const session = decodeURIComponent(url.pathname.slice(TRACE_ROUTE.length + 1))
    if (session === '') {
      const sessions = allSessions(location)
      const records = sessions.flatMap(item => sessionRecords(location, item.session))
      send(response, 200, { dir, recording, sessions, stats: traceStats(records) })
      return true
    }
    const records = sessionRecords(location, session)
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
