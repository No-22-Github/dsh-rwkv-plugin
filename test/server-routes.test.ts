import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { test } from 'node:test'
import { Config } from '../src/index.ts'
import { handleServerRoute } from '../src/routes.ts'
import { normalizeBaseURL } from '../src/client/url.ts'

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** A stand-in for rwkv_lightning_cuda's /v1/models and /v1/state/* routes. */
function fakeLightning() {
  const seen: { method: string; path: string; auth?: string; body: string }[] = []
  const states: { state_id: string; original_filename: string }[] = []
  const server = createServer(async (request, response) => {
    const raw = await body(request)
    const path = new URL(request.url ?? '/', 'http://x').pathname
    seen.push({ method: request.method ?? '', path, ...request.headers.authorization ? { auth: request.headers.authorization } : {}, body: raw.toString('latin1') })
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (path === '/v1/models') return json(200, { object: 'list', loaded: 'b', data: [{ id: 'a' }, { id: 'b' }] })
    if (path === '/v1/state/list') return json(200, { object: 'list', data: states })
    if (path === '/v1/state/upload') {
      const name = /filename="([^"]+)"/.exec(raw.toString('latin1'))?.[1] ?? 'x.pth'
      const state = { state_id: `${name.replace(/\.pth$/, '')}-0193`, original_filename: name }
      states.push(state)
      return json(200, state)
    }
    if (path === '/v1/state/delete') {
      const id = (JSON.parse(raw.toString()) as { state_id: string }).state_id
      const index = states.findIndex(state => state.state_id === id)
      if (index < 0) return json(404, { state_id: id, deleted: false })
      states.splice(index, 1)
      return json(200, { state_id: id, deleted: true })
    }
    json(404, { error: 'no route' })
  })
  return { server, seen, states }
}

test('server routes relay model list and state list / upload / delete', async () => {
  const upstream = fakeLightning()
  const upstreamURL = await listen(upstream.server)
  const host = createServer(async (request, response) => {
    if (!await handleServerRoute(request, response)) { response.writeHead(418); response.end() }
  })
  const hostURL = await listen(host)
  const connection = Buffer.from(JSON.stringify({ baseURL: upstreamURL, apiKey: 'pw' })).toString('base64')
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${hostURL}${path}`, { ...init, headers: { 'x-rwkv-connection': connection, ...init.headers } })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  try {
    // The loaded model comes first: it is the one to prefill.
    assert.deepEqual(await call('/api/rwkv/models'), { status: 200, body: { models: ['b', 'a'] } })
    assert.deepEqual((await call('/api/rwkv/states')).body, { states: [] })
    const uploaded = await call('/api/rwkv/states?name=agent.pth', { method: 'PUT', body: new Uint8Array([1, 2, 3]) })
    assert.equal(uploaded.status, 200)
    assert.equal((uploaded.body.state as { state_id: string }).state_id, 'agent-0193')
    const upload = upstream.seen.find(item => item.path === '/v1/state/upload')
    assert.equal(upload?.auth, 'Bearer pw')
    assert.match(upload?.body ?? '', /filename="agent.pth"/)
    assert.equal(((await call('/api/rwkv/states')).body.states as unknown[]).length, 1)
    assert.equal((await call('/api/rwkv/states/agent-0193', { method: 'DELETE' })).status, 200)
    assert.equal((await call('/api/rwkv/states/agent-0193', { method: 'DELETE' })).status, 404)
    assert.equal(upstream.states.length, 0)
    assert.equal((await fetch(`${hostURL}/api/rwkv/other`)).status, 418)
  } finally {
    host.close()
    upstream.server.close()
  }
})

test('a bare host:port gets http://', () => {
  assert.equal(normalizeBaseURL(' 100.64.0.8:8060 '), 'http://100.64.0.8:8060')
  assert.equal(normalizeBaseURL('https://api-7b.rwkvos.com'), 'https://api-7b.rwkvos.com')
  assert.equal(normalizeBaseURL(''), '')
})

test('a saved model that still carries an adapter is still accepted', () => {
  // Configs saved before adapters were removed upstream; the plugin no longer
  // reads the field and the settings page drops it on the next save.
  assert.doesNotThrow(() => Config({ models: [{ id: 'm', backend: 'lightning', baseURL: 'http://h:1', model: 'x', adapter: { id: 'old' } }] }))
})
