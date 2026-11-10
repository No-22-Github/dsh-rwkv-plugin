// Live smoke test without DSH: runs the outer agent loop DSH would run, with
// tiny local implementations of the DSH read/glob/grep/write tools on a temp
// workspace, against a real endpoint.
//
//   node scripts/smoke.ts irwkv http://100.64.0.5:8103 rwkv7-g1l-7.2b
//   node scripts/smoke.ts lightning http://100.64.0.9:8000 rwkv7-g1l-7.2b-20261031-ctx34304 --state <state id> [--adapter <adapter id>]
//   add --task "..." to change the request, --off for agent-wire-v1.0 (no thinking)

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import type { Generator } from '../src/backend/generator.ts'
import { IRWKVClient } from '../src/backend/irwkv.ts'
import { LightningClient } from '../src/backend/lightning.ts'
import { decideStep, DEFAULT_HARNESS } from '../src/core/agent.ts'
import type { HistoryItem } from '../src/core/policy.ts'
import { buildCatalog, type Args } from '../src/core/tools.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    state: { type: 'string' },
    adapter: { type: 'string' },
    task: { type: 'string', default: '读一下 config/app.json，告诉我服务监听的端口是多少，以及日志级别。' },
    off: { type: 'boolean', default: false },
    'empty-think': { type: 'boolean', default: true },
  },
})
const [backend, baseURL, model] = positionals
if (!backend || !baseURL || !model) {
  console.error('usage: node scripts/smoke.ts <irwkv|lightning> <baseURL> <model> [--state id] [--adapter id] [--task text] [--off] [--no-empty-think]')
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'rwkv-smoke-'))
mkdirSync(join(root, 'config'))
mkdirSync(join(root, 'src'))
writeFileSync(join(root, 'config/app.json'), '{\n  "service": "tariff-calc",\n  "port": 8443,\n  "logLevel": "warn"\n}\n')
writeFileSync(join(root, 'src/main.ts'), 'import config from "../config/app.json"\nconsole.log(`listening on ${config.port}`)\n')
writeFileSync(join(root, 'README.md'), '# tariff-calc\nRuns the EU tariff calculator.\n')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [relative(root, path)]
  })
}

/** Minimal stand-ins for the DSH fs tools, returning text as DSH does. */
function runDshTool(name: string, args: Args): { ok: boolean; text: string } {
  try {
    switch (name) {
      case 'read': {
        const lines = readFileSync(join(root, String(args.file_path)), 'utf8').split('\n')
        const offset = Number(args.offset ?? 1)
        const limit = Number(args.limit ?? 2000)
        return { ok: true, text: lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}\t${line}`).join('\n') }
      }
      case 'glob':
        return { ok: true, text: walk(join(root, String(args.path ?? '.'))).join('\n') }
      case 'grep': {
        const pattern = new RegExp(String(args.pattern))
        const hits = walk(root).flatMap(file => readFileSync(join(root, file), 'utf8').split('\n')
          .flatMap((line, index) => pattern.test(line) ? [`${file}:${index + 1}:${line}`] : []))
        return { ok: true, text: hits.join('\n') || 'No matches found' }
      }
      case 'write':
        writeFileSync(join(root, String(args.file_path)), String(args.content))
        return { ok: true, text: `Wrote ${String(args.file_path)}` }
      default:
        return { ok: false, text: `tool ${name} is not available in the smoke test` }
    }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

const generator: Generator = backend === 'irwkv'
  ? new IRWKVClient({ baseURL, model })
  : new LightningClient({
      baseURL,
      model,
      ...values.state ? { stateId: values.state } : {},
      ...values.adapter ? { adapterId: values.adapter } : {},
    })
const tools = buildCatalog(['read', 'write', 'glob', 'grep'].map(name => ({ name, description: '', parameters: {} })), { mode: 'mapped' })
const config = { ...DEFAULT_HARNESS, thinking: values.off ? 'off' as const : 'full' as const, historyEmptyThink: values['empty-think'] }
const history: HistoryItem[] = [{ kind: 'user', text: values.task }]

console.log(`workspace ${root}\ntask: ${values.task}\n`)
const started = Date.now()
for (let step = 1; step <= config.maxSteps + 1; step++) {
  let reasoning = ''
  const result = await decideStep({
    history, tools, config, generator,
    sessionId: `smoke-${started}`,
    hooks: {
      reasoning: text => { reasoning += text },
      attempt: label => { if (label !== 'decide') console.log(`  [harness] ${label}`) },
    },
  })
  if (reasoning) console.log(`step ${step} thinking: ${reasoning.trim().replace(/\s+/g, ' ').slice(0, 240)}`)
  const { decision } = result
  if (decision.type === 'final') {
    console.log(`\nfinal (${decision.via}, ${result.generations} generations, ${((Date.now() - started) / 1000).toFixed(1)}s):\n${decision.text}`)
    break
  }
  const dshArgs = decision.tool.toDsh(decision.args)
  const outcome = runDshTool(decision.tool.dshName, dshArgs)
  console.log(`step ${step} call ${decision.tool.name} ${JSON.stringify(decision.args)}${decision.repairs.length ? ` repairs=${decision.repairs.join(',')}` : ''} → ${decision.tool.dshName} ${outcome.ok ? 'ok' : 'error'}`)
  const id = `call-${step}`
  history.push({ kind: 'call', id, name: decision.tool.name, args: decision.args })
  history.push({ kind: 'result', id, name: decision.tool.name, ok: outcome.ok, text: outcome.text })
}
