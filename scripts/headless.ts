// One-shot headless run: RWKV as the root DSH agent, configured from flags
// instead of a hand-edited ~/.dsh profile. The entry eval harnesses call (the
// rwkv-agent-eval Harbor backend); stdout is DSH's `--json` event stream.
//
//   node scripts/headless.ts --backend irwkv --base-url http://host:8000 \
//     --model rwkv7-g1l-7.2b [--home DIR] [--max-steps 12] [--thinking full|off] \
//     [--state ID] [--adapter ID] [--no-empty-think] [--installed] [--trace-dir DIR] [--session-id ID] [--model-id ID] [--extra-patch FILE]
//     [--current-date [--time-zone ZONE]] "task text"   (or `-` / stdin)
//
// --installed: the plugin was added to --home's headless profile with
// `dsh plugin --profile headless add <dir>` (how a container runs it); only
// its config is patched. Otherwise the plugin is inserted by file path, which
// needs DSH to resolve its @deepseek-ai/* imports from a source checkout.
//
// DSH is located by, in order: --dsh "<command prefix>", $DSH_ROOT (a source
// checkout, run through tsx), then `dsh` on PATH (the npm @deepseek-ai/dsh).
// The task runs in the current directory.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    backend: { type: 'string', default: 'irwkv' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    state: { type: 'string' },
    adapter: { type: 'string' },
    'empty-think': { type: 'boolean', default: true },
    thinking: { type: 'string', default: 'full' },
    'max-steps': { type: 'string', default: '12' },
    'context-window': { type: 'string', default: '32768' },
    home: { type: 'string' },
    dsh: { type: 'string' },
    installed: { type: 'boolean', default: false },
    'trace-dir': { type: 'string' },
    // Continue an earlier run's session (multi-turn evals: one process per user turn).
    'session-id': { type: 'string' },
    // Model id shown to the model (the persona says "powered by the <id> model").
    'model-id': { type: 'string', default: 'rwkv' },
    // YAML rows appended to the generated cordis.patch.yml (eval overlays: extra
    // plugins, web provider selection). Top-level list items, same indentation.
    'extra-patch': { type: 'string' },
    // System prompt ends with the current date (off: eval prompts match the training rows).
    'current-date': { type: 'boolean', default: false },
    // IANA zone for the date line and for DSH itself (TZ, so bash's `date` agrees).
    'time-zone': { type: 'string' },
  },
})
if (!values['base-url'] || !values.model) {
  console.error('usage: node scripts/headless.ts --backend irwkv|lightning --base-url URL --model ID [options] "task" | -')
  process.exit(2)
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// DSH command prefix, and whether it runs from source (then load src/ via tsx).
let command: string[]
let fromSource = false
if (values.dsh) {
  command = values.dsh.split(' ').filter(Boolean)
  fromSource = command.some(part => part.includes('tsx'))
} else if (process.env.DSH_ROOT) {
  const root = resolve(process.env.DSH_ROOT)
  const pnpmDir = join(root, 'node_modules/.pnpm')
  const tsxDir = readdirSync(pnpmDir).find(name => name.startsWith('tsx@'))
  if (!tsxDir) throw new Error(`tsx not found under ${pnpmDir}`)
  const tsx = join(pnpmDir, tsxDir, 'node_modules/tsx/dist/esm/index.mjs')
  command = ['node', '--import', pathToFileURL(tsx).href, join(root, 'apps/cli/src/bin.ts')]
  process.env.TSX_TSCONFIG_PATH = join(root, 'tsconfig.json')
  fromSource = true
} else {
  command = ['dsh']
}
const [bin, ...binArgs] = command
if (!bin) throw new Error('empty --dsh command')
const entry = fromSource ? join(pluginRoot, 'src/index.ts') : join(pluginRoot, 'lib/index.js')
if (!values.installed && !existsSync(entry)) throw new Error(`plugin entry missing: ${entry} (run npm run build?)`)
if (values.installed && !values.home) throw new Error('--installed needs --home (the DSH_HOME the plugin was added to)')

const home = resolve(values.home ?? mkdtempSync(join(tmpdir(), 'dsh-rwkv-home-')))
const profileDir = join(home, 'profiles/headless')
mkdirSync(profileDir, { recursive: true })
const json = JSON.stringify // YAML is a superset of JSON, so quote every scalar this way.
// One model, id --model-id (default `rwkv`); rows are written relative to the `models:` key.
const modelRows = [
  `- id: ${json(values['model-id'])}`,
  `  name: ${json(`RWKV · ${values.model}`)}`,
  `  backend: ${json(values.backend)}`,
  `  baseURL: ${json(values['base-url'])}`,
  `  model: ${json(values.model)}`,
  `  contextWindow: ${Number(values['context-window'])}`,
]
modelRows.push(`  historyEmptyThink: ${values['empty-think']}`)
if (values.state) modelRows.push(`  stateId: ${json(values.state)}`)
if (values.adapter) modelRows.push(`  adapter:`, `    id: ${json(values.adapter)}`)
// Installed: patch the row the plugin's own bundle layer inserted (same id,
// whole config replaced). Not installed: insert the row ourselves.
const pluginRows = values.installed
  ? ['- id: rwkv-llm', '  config:']
  : ['- insert:', '    - id: rwkv-llm', `      name: ${json(pathToFileURL(entry).href)}`, '      config:']
const indent = values.installed ? '    ' : '        '
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '# Generated by dsh-rwkv-plugin scripts/headless.ts; rewritten on every run.',
  ...pluginRows,
  `${indent}providers: [ rwkv ]`,
  `${indent}thinking: ${json(values.thinking)}`,
  `${indent}maxSteps: ${Number(values['max-steps'])}`,
  `${indent}currentDate: ${values['current-date']}`,
  ...(values['time-zone'] ? [`${indent}timeZone: ${json(values['time-zone'])}`] : []),
  ...(values['trace-dir'] ? [`${indent}traceDir: ${json(resolve(values['trace-dir']))}`] : []),
  `${indent}models:`,
  ...modelRows.map(row => `${indent}  ${row}`),
  '- id: session-title-llm',
  '  disabled: true',
  // The headless profile has no agent-presets service, so the plugin's preset
  // and its rwkv_agent delegate tool cannot activate there; say so up front.
  ...(values.installed ? ['- id: preset-rwkv', '  disabled: true', '- id: tool-rwkv-agent', '  disabled: true'] : []),
  '- id: agent-default-model',
  "  name: '@deepseek-ai/dsh-agent-default-model'",
  '  config:',
  '    provider: rwkv',
  `    model: ${json(values['model-id'])}`,
  ...(values['extra-patch'] ? [readFileSync(resolve(values['extra-patch']), 'utf8').trimEnd()] : []),
  '',
].join('\n'))

// Older DSH releases (npm 0.2.1-rc.5) have no --approval-policy flag.
const help = spawnSync(bin, [...binArgs, '--profile', 'headless', '--help'], {
  encoding: 'utf8', env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
})
const approval = /--approval-policy/.test(help.stdout ?? '') ? ['--approval-policy', 'never'] : []

const task = positionals.join(' ')
const session = values['session-id'] ? ['--session-id', values['session-id']] : []
const args = [...binArgs, '--profile', 'headless', '--json', ...approval, ...session, task === '' ? '-' : task]
const child = spawn(bin, args, {
  stdio: 'inherit',
  // Eval runs never report session content upstream, even on a feedback path.
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...values['time-zone'] ? { TZ: values['time-zone'] } : {} },
})
child.on('exit', code => process.exit(code ?? 1))
