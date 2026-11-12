// Syntax check for edit_lines (SWE-agent lints each edit with flake8 and
// refuses edits that add errors). Only checkers every machine running DSH
// has, by file extension: Python's compile() through python3, node --check,
// bash -n, JSON.parse. No checker for the extension, or the checker cannot
// run: undefined (the edit is not blocked).

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

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
    // "<file>:<line>", the source line, a caret, then "SyntaxError: ..." and a stack.
    const line = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(output)?.[1]
    const message = output.split('\n').find(text => /^[A-Za-z]*Error: /.test(text)) ?? output.split('\n')[0]!
    return line === undefined ? message : `${message} (line ${line})`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The first syntax error in `text` as a file named `path`, '' when it parses, undefined when unchecked. */
export async function syntaxError(text: string, path: string): Promise<string | undefined> {
  const extension = extname(path).toLowerCase()
  switch (extension) {
    case '.py':
      return run('python3', ['-c', PYTHON_CHECK, path], text)
    case '.js':
    case '.mjs':
    case '.cjs':
      return nodeCheck(text, extension)
    case '.sh':
    case '.bash':
      return run('bash', ['-n'], text)
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
