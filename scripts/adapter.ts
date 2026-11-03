// Adapter management on an rwkv_lightning CUDA server.
//
//   node scripts/adapter.ts list     <baseURL>
//   node scripts/adapter.ts upload   <baseURL> <adapter-id> <local .pth>
//   node scripts/adapter.ts register <baseURL> <adapter-id> <path on the server>
//   node scripts/adapter.ts delete   <baseURL> <adapter-id> [version]
//
// Extra headers (Cloudflare Access): RWKV_HEADERS='{"CF-Access-Client-Id":"…","CF-Access-Client-Secret":"…"}'

import { LightningClient } from '../src/backend/lightning.ts'

const [command, baseURL, id, target] = process.argv.slice(2)
if (!command || !baseURL) {
  console.error('usage: node scripts/adapter.ts <list|upload|register|delete> <baseURL> [adapter-id] [file|server path|version]')
  process.exit(2)
}
const headers = process.env.RWKV_HEADERS ? JSON.parse(process.env.RWKV_HEADERS) as Record<string, string> : undefined
const client = new LightningClient({ baseURL, model: '', ...headers ? { headers } : {} })

switch (command) {
  case 'list':
    for (const adapter of await client.listAdapters()) {
      const manifest = adapter.manifest ?? {}
      console.log(`${adapter.id}\t${String(manifest.method ?? '?')}\trank ${String(manifest.rank ?? '?')}\t${String(manifest.content_version ?? adapter.version ?? '').slice(0, 12)}`)
    }
    break
  case 'upload': {
    if (!id || !target) throw new Error('upload needs <adapter-id> <local file>')
    const started = Date.now()
    const version = await client.uploadAdapter(id, target)
    console.log(`${id} registered as version ${version} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    break
  }
  case 'register': {
    if (!id || !target) throw new Error('register needs <adapter-id> <server path>')
    console.log(`${id} registered as version ${await client.registerAdapterPath(id, target)}`)
    break
  }
  case 'delete':
    if (!id) throw new Error('delete needs <adapter-id>')
    await client.deleteAdapter(id, target)
    console.log(`${id} deleted`)
    break
  default:
    throw new Error(`unknown command ${command}`)
}
