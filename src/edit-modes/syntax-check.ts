// Pre-write incremental syntax check shared across `tolerant` and `line-edit`
// edit modes. Uses checkers every DSH machine provides:
// Python's compile() via python3, Node's stripTypeScriptTypes / --check,
// bash -n, and JSON.parse. Unknown extensions or missing checkers pass through.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

const stripTsTypes = (nodeModule as { stripTypeScriptTypes?: (code: string, options?: { mode?: string }) => string }).stripTypeScriptTypes

const TIMEOUT_MS = 10_000

const PYTHON_CHECK = String.raw`
import sys
source = sys.stdin.read()
try:
    compile(source, sys.argv[1], "exec", dont_inherit=True)
except SyntaxError as error:
    print(f"{type(error).__name__}: {error.msg} (line {error.lineno})")
    sys.exit(1)
`

const TOML_CHECK = String.raw`
import sys, tomllib
try:
    tomllib.loads(sys.stdin.read())
except Exception as error:
    print(f"TOML: {error}")
    sys.exit(1)
`

const YAML_CHECK = String.raw`
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
try:
    list(yaml.safe_load_all(sys.stdin.read()))
except Exception as error:
    first = str(error).splitlines()[0] if str(error) else type(error).__name__
    print(f"YAML: {first}")
    sys.exit(1)
`

const JAVA_PARSE_ERROR_RE = /error:\s*(?:';' expected|reached end of file while parsing|class, interface, enum, or record expected|illegal start of (?:expression|type)|unclosed (?:string|character) literal|unclosed comment|<identifier> expected|'[^']+' expected|(?:unnamed class|compact source file|implicitly declared class) should not have package declaration)/i

/** stdout+stderr of a failed run; '' when it passed; undefined when it could not run. */
function run(command: string, args: readonly string[], input: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    const done = (value: string | undefined) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    let child
    try {
      // C locale: the same (English) message whatever the machine's language.
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })
    } catch {
      done(undefined)
      return
    }
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', () => done(undefined))
    child.on('close', (code, signal) => done(signal !== null ? undefined : code === 0 ? '' : output.trim() || `exit ${code}`))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

async function nodeCheck(text: string, extension: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'rwkv-edit-check-'))
  try {
    const file = join(dir, `check${extension}`)
    await writeFile(file, text)
    const output = await run(process.execPath, ['--check', file], '')
    if (!output) return output
    const line = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(output)?.[1]
    const message = output.split('\n').find(lineText => /^[A-Za-z]*Error: /.test(lineText)) ?? output.split('\n')[0]!
    return line === undefined ? message : `${message} (line ${line})`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function tsOrJsStripCheck(text: string): string | undefined {
  if (!stripTsTypes) return undefined
  try {
    stripTsTypes(text, { mode: 'strip' })
    return ''
  } catch (error) {
    // Non-erasable TS syntax (enum, namespace, parameter properties) is valid TS
    // but unsupported in strip mode; do not misreport it as a syntax error.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
      return undefined
    }
    const firstLine = (error instanceof Error ? error.message : String(error)).split('\n')[0]!
    return `SyntaxError: ${firstLine}`
  }
}

async function javaParseCheck(text: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'rwkv-java-check-'))
  try {
    const pubMatch = /\bpublic\s+(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(text)
    const fileName = `${pubMatch?.[1] ?? 'Check'}.java`
    const file = join(dir, fileName)
    await writeFile(file, text)
    const output = await run('javac', ['-J-Duser.language=en', '-J-Duser.country=US', '-encoding', 'UTF-8', '-XDcompilePolicy=simple', '-proc:none', '-d', dir, file], '')
    if (!output) return output
    const parseLine = output.split('\n').find(line => JAVA_PARSE_ERROR_RE.test(line))
    if (!parseLine) return '' // Only type/symbol resolution errors -> syntax & brace structure is valid.
    return parseLine.replace(file, fileName).trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function parseCsvRows(text: string): string[][] | string {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const s = text.replace(/\r\n/g, '\n')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      if (field === '') inQuotes = true
      else field += ch
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (inQuotes) return 'CSV: unclosed double-quoted field'
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
  }
  return rows
}

function csvStructureError(text: string): string {
  if (text.trim() === '') return ''
  const parsed = parseCsvRows(text)
  if (typeof parsed === 'string') return parsed
  if (parsed.length < 2) return ''
  const headerCols = parsed[0]!.length
  if (headerCols < 2) return ''
  for (let r = 1; r < parsed.length; r++) {
    if (parsed[r]!.length !== headerCols) {
      return `CSV column count mismatch at row ${r + 1}: expected ${headerCols} columns (matching header "${parsed[0]!.slice(0, 4).join(',')}"), got ${parsed[r]!.length}`
    }
  }
  return ''
}

/** The first syntax error in `text` as a file named `path`, '' when it parses, undefined when unchecked. */
export async function syntaxError(text: string, path: string): Promise<string | undefined> {
  const extension = extname(path).toLowerCase()
  switch (extension) {
    case '.py':
      return run('python3', ['-c', PYTHON_CHECK, path], text)
    case '.go':
      return run('gofmt', ['-e'], text)
    case '.java':
      return javaParseCheck(text)
    case '.ts':
    case '.mts':
    case '.cts':
      return tsOrJsStripCheck(text)
    case '.js':
    case '.mjs':
    case '.cjs':
      return nodeCheck(text, extension)
    case '.sh':
    case '.bash':
      return run('bash', ['-n'], text)
    case '.toml':
      return run('python3', ['-c', TOML_CHECK], text)
    case '.yaml':
    case '.yml':
      return run('python3', ['-c', YAML_CHECK], text)
    case '.csv':
      return csvStructureError(text)
    case '.json':
      if (text.trim() === '') return ''
      try {
        JSON.parse(text)
        return ''
      } catch (error) {
        return `JSON: ${(error as Error).message}`
      }
    default:
      return undefined
  }
}

/** The error an edit introduces: the new text fails while the old one parsed. */
export async function introducedSyntaxError(before: string, after: string, path: string): Promise<string | undefined> {
  const now = await syntaxError(after, path)
  if (!now) return undefined
  return await syntaxError(before, path) === '' ? now : undefined
}
