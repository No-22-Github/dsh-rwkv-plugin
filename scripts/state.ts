// Initial-state management on an rwkv_lightning CUDA server (/v1/state/*).
//
//   node scripts/state.ts list   <baseURL>
//   node scripts/state.ts upload <baseURL> <local .pth>     prints the new state_id
//   node scripts/state.ts delete <baseURL> <state-id>
//
// Password: RWKV_PASSWORD. Extra headers (Cloudflare Access):
// RWKV_HEADERS='{"CF-Access-Client-Id":"…","CF-Access-Client-Secret":"…"}'

import { LightningClient } from '../src/backend/lightning.ts'

const [command, baseURL, target] = process.argv.slice(2)
if (!command || !baseURL) {
  console.error('usage: node scripts/state.ts <list|upload|delete> <baseURL> [file|state-id]')
  process.exit(2)
}
const headers = process.env.RWKV_HEADERS ? JSON.parse(process.env.RWKV_HEADERS) as Record<string, string> : undefined
const password = process.env.RWKV_PASSWORD
const client = new LightningClient({ baseURL, model: '', ...headers ? { headers } : {}, ...password ? { password } : {} })

switch (command) {
  case 'list':
    for (const state of await client.listStates()) {
      console.log(`${state.state_id}\t${state.original_filename ?? ''}\t${state.size_bytes ?? '?'} bytes\t${state.uploaded_at ?? ''}`)
    }
    break
  case 'upload': {
    if (!target) throw new Error('upload needs <local file>')
    console.log((await client.uploadState(target)).state_id)
    break
  }
  case 'delete':
    if (!target) throw new Error('delete needs <state-id>')
    await client.deleteState(target)
    console.log(`${target} deleted`)
    break
  default:
    throw new Error(`unknown command ${command}`)
}
