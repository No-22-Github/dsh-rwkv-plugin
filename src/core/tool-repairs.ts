// Lenient tool-name resolution, argument key aliases, scalar coercion, and
// DSH native value shape repairs for 7B outputs.

import { editLinesAliasesFor } from './edit-modes/index.ts'
import { normalizeLineEditArgs } from './edit-modes/line-edit.ts'
import {
  normalizeWorklistStatus,
  parsePlanItems,
  TODO_PLAN_TOOL,
  TODO_UPDATE_TOOL,
} from './todo-state.ts'
import { BUILTIN_MAPPINGS, finiteInt, nonEmptyStr, type Args, type WireTool } from './tool-mappings.ts'

/**
 * Other names the model uses for the wire tools: DSH's own names, Claude Code
 * / OpenAI-agent habits, and capitalised forms ("Bash"). Matched after an
 * exact, then a case-insensitive, lookup fails.
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  read: 'read_file', view: 'read_file', cat: 'read_file', open_file: 'read_file',
  write: 'write_file', create_file: 'write_file', save_file: 'write_file',
  edit: 'edit_file', str_replace: 'edit_file', replace: 'edit_file', replace_in_file: 'edit_file',
  glob: 'list_files', ls: 'list_files', list_dir: 'list_files', list_directory: 'list_files',
  grep: 'search_text', search: 'search_text', search_files: 'search_text',
  shell: 'bash', run: 'bash', terminal: 'bash', execute_command: 'bash', run_command: 'bash',
  fetch: 'web_fetch', search_web: 'web_search',
  worklist_plan: TODO_PLAN_TOOL, plan_todo: TODO_PLAN_TOOL,
  worklist_update: TODO_UPDATE_TOOL, update_todo: TODO_UPDATE_TOOL,
}

/** The offered tool a model-written name refers to, and whether an alias was needed. */
export function resolveTool(tools: readonly WireTool[], name: string): { tool: WireTool; aliased: boolean } | undefined {
  const exact = tools.find(tool => tool.name === name)
  if (exact) return { tool: exact, aliased: false }
  const lower = name.trim().toLowerCase().replace(/^functions\./, '')
  const target = tools.find(tool => tool.name.toLowerCase() === lower)
    ?? tools.find(tool => tool.name === TOOL_NAME_ALIASES[lower])
    ?? tools.find(tool => tool.dshName.toLowerCase() === lower)
    // DSH-named catalog: the trained names (read_file, ...) and their aliases.
    ?? tools.find(tool => BUILTIN_MAPPINGS[tool.dshName]?.wireName === (TOOL_NAME_ALIASES[lower] ?? lower))
    // Cross-harness compatibility: when `edit_lines` replaces `edit`, route `edit`/`edit_file` calls to `edit_lines`.
    ?? ((lower === 'edit' || lower === 'edit_file' || TOOL_NAME_ALIASES[lower] === 'edit_file')
      ? tools.find(tool => tool.dshName === 'edit_lines')
      : undefined)
  return target ? { tool: target, aliased: true } : undefined
}

const PATH_ALIASES = ['file_path', 'filepath', 'file', 'filename', 'file_name']
const NATIVE_PATH_ALIASES = ['path', 'filepath', 'file', 'filename', 'file_name']

/** Canonical argument key -> other keys the model writes for it, per wire tool. */
const ARGUMENT_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  read_file: { path: PATH_ALIASES, start_line: ['line_start', 'from_line'], end_line: ['line_end', 'to_line'] },
  write_file: { path: PATH_ALIASES, content: ['text', 'file_text', 'contents', 'data', 'code'] },
  edit_file: {
    path: PATH_ALIASES,
    old_text: ['old_string', 'old_str', 'old', 'search', 'find', 'original'],
    new_text: ['new_string', 'new_str', 'new', 'replace', 'replacement', 'updated'],
  },
  edit_lines: {
    path: PATH_ALIASES,
    start_line: ['line_start', 'from_line', 'start', 'line'],
    end_line: ['line_end', 'to_line', 'end'],
    new_text: ['new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
  },
  list_files: { path: ['directory', 'dir', 'folder', 'dir_path'], pattern: ['glob'] },
  search_text: { query: ['pattern', 'text', 'search', 'keyword', 'regex'], path: ['file_path', 'directory', 'dir'] },
  bash: { command: ['cmd', 'script', 'code', 'shell'] },
  web_fetch: { url: ['link', 'href', 'page'] },
  web_search: { query: ['q', 'keywords', 'search', 'search_query'] },
  [TODO_PLAN_TOOL]: { items: ['todos', 'tasks', 'steps', 'plan'] },
  [TODO_UPDATE_TOOL]: {
    id: ['index', 'item_id', 'task_id', 'step'],
    note: ['notes', 'summary', 'finding', 'findings', 'conclusion', 'result'],
    content: ['title', 'task', 'text', 'description'],
  },
}

/** The same table for DSH-named tools: trained and Claude-style keys -> DSH keys. */
const NATIVE_ARGUMENT_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  read: { file_path: NATIVE_PATH_ALIASES, offset: ['start_line', 'line_start', 'from_line'] },
  write: { file_path: NATIVE_PATH_ALIASES, content: ['text', 'file_text', 'contents', 'data', 'code'] },
  edit: {
    file_path: NATIVE_PATH_ALIASES,
    old_string: ['old_text', 'old_str', 'old', 'search', 'find', 'original'],
    new_string: ['new_text', 'new_str', 'new', 'replace', 'replacement', 'updated'],
  },
  edit_lines: {
    file_path: NATIVE_PATH_ALIASES,
    start_line: ['line_start', 'from_line', 'start', 'line', 'offset'],
    end_line: ['line_end', 'to_line', 'end'],
    new_text: ['new_string', 'new_str', 'text', 'content', 'replacement', 'lines'],
  },
  glob: { pattern: ['glob'], path: ['directory', 'dir', 'folder', 'dir_path'] },
  grep: { pattern: ['query', 'text', 'search', 'keyword', 'regex'], path: ['file_path', 'directory', 'dir'] },
  bash: { command: ['cmd', 'script', 'code', 'shell'] },
  web_fetch: { url: ['link', 'href', 'page'] },
  web_search: { queries: ['query', 'q', 'keywords', 'search', 'search_query'] },
  [TODO_PLAN_TOOL]: ARGUMENT_ALIASES[TODO_PLAN_TOOL]!,
  [TODO_UPDATE_TOOL]: ARGUMENT_ALIASES[TODO_UPDATE_TOOL]!,
}

function renameAliases(args: Args, aliases: Readonly<Record<string, readonly string[]>>): Args | undefined {
  let out: Args | undefined
  for (const [canonical, others] of Object.entries(aliases)) {
    if (args[canonical] !== undefined && args[canonical] !== '') continue
    const found = others.find(key => args[key] !== undefined && args[key] !== '')
    if (found === undefined) continue
    out ??= { ...args }
    out[canonical] = args[found]
    delete out[found]
  }
  return out
}

const looseInt = (value: unknown) => finiteInt(typeof value === 'string' ? Number(value.trim()) : value)

/** DSH-named tools: alias keys, end_line -> limit, a lone query string -> queries, a bash description. */
function normalizeNativeArguments(tool: WireTool, args: Args): Args {
  const aliases = tool.dshName === 'edit_lines'
    ? editLinesAliasesFor({ native: true })
    : NATIVE_ARGUMENT_ALIASES[tool.dshName]
  if (aliases === undefined) return args
  let out = renameAliases(args, aliases)
  const current = out ?? args
  if (tool.dshName === 'edit_lines' && current.edits !== undefined) {
    out = normalizeLineEditArgs(current)
  }
  if (tool.dshName === 'read' && current.end_line !== undefined) {
    const start = looseInt(current.offset) ?? 1
    const end = looseInt(current.end_line)
    out ??= { ...args }
    delete out.end_line
    if (end !== undefined && current.limit === undefined) out.limit = Math.max(1, end - start + 1)
  }
  if (tool.dshName === 'web_search' && typeof current.queries === 'string') {
    out ??= { ...args }
    out.queries = [current.queries]
  }
  if (tool.dshName === 'bash' && nonEmptyStr(current.description) === undefined && nonEmptyStr(current.command) !== undefined) {
    const firstLine = String(current.command).split('\n')[0] ?? ''
    out ??= { ...args }
    out.description = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
  }
  return out ?? args
}

/**
 * Renames alias keys to the tool's own keys when the own key is absent
 * (edit_file with Claude's old_string/new_string, read_file with file_path,
 * ...). read_file's DSH-style offset/limit become start_line/end_line.
 * Returns the args unchanged (same object) when nothing applied.
 */
export function normalizeArguments(tool: WireTool, args: Args): Args {
  if (tool.native === true) return normalizeNativeArguments(tool, args)
  const aliases = tool.name === 'edit_lines'
    ? editLinesAliasesFor({ native: false })
    : ARGUMENT_ALIASES[tool.name]
  if (aliases === undefined) return args
  let out = renameAliases(args, aliases)
  if (tool.name === 'edit_lines' && (out ?? args).edits !== undefined) {
    out = normalizeLineEditArgs(out ?? args)
  }
  if (tool.name === 'read_file' && args.start_line === undefined && args.offset !== undefined) {
    const start = looseInt(args.offset)
    const limit = looseInt(args.limit)
    out ??= { ...args }
    delete out.offset
    delete out.limit
    if (start !== undefined) out.start_line = start
    if (start !== undefined && limit !== undefined) out.end_line = start + limit - 1
  }
  return out ?? args
}

/**
 * Lenient scalars: "10" for an integer, "true" for a boolean, "6,412" with
 * thousands separators. Structural mismatches are left for the tool to reject.
 */
export function coerceArguments(args: Args, schema: Record<string, unknown> | undefined): Args {
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
  const result: Args = {}
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type
    if (value === null) continue
    if ((type === 'integer' || type === 'number') && typeof value === 'string') {
      const parsed = Number(value.replace(/,/g, '').trim())
      result[key] = value.trim() !== '' && Number.isFinite(parsed) ? parsed : value
    } else if (type === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) {
      result[key] = value.trim().toLowerCase() === 'true'
    } else if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
      result[key] = String(value)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * DSH-named tools, after scalar coercion: value shapes 7B writes from other
 * harnesses' habits that DSH would reject. Keys outside the DSH schema
 * (Claude Code's grep output_mode, ...) are dropped; glob without a pattern
 * (list_files{path}) lists everything; read offset 0 (0-based habit) is line 1;
 * a pattern array becomes one pattern. The same object when nothing applied.
 */
export function repairNativeValues(tool: WireTool, args: Args): { args: Args; repairs: string[] } {
  if (tool.native !== true || tool.schema === undefined) return { args, repairs: [] }
  const properties = (tool.schema.properties ?? {}) as Record<string, unknown>
  const repairs: string[] = []
  let out: Args | undefined
  const edit = () => (out ??= { ...args })
  const unknown = Object.keys(args).filter(key => !(key in properties))
  if (unknown.length > 0) {
    for (const key of unknown) delete edit()[key]
    repairs.push('unknown_arguments_dropped')
  }
  const current = () => out ?? args
  if ((tool.dshName === 'grep' || tool.dshName === 'glob') && Array.isArray(current().pattern)) {
    const parts = (current().pattern as unknown[]).filter((part): part is string => typeof part === 'string' && part !== '')
    if (parts.length > 0) {
      edit().pattern = tool.dshName === 'grep' ? parts.join('|') : parts[0]
      repairs.push('pattern_array')
    }
  }
  if (tool.dshName === 'glob' && nonEmptyStr(current().pattern) === undefined) {
    edit().pattern = '*'
    repairs.push('glob_default_pattern')
  }
  if (tool.dshName === 'read') {
    for (const key of ['offset', 'limit']) {
      const value = current()[key]
      if (typeof value === 'number' && value < 1) {
        if (key === 'offset') edit().offset = 1
        else delete edit().limit
        repairs.push(`${key}_below_one`)
      }
    }
  }
  if (tool.dshName === TODO_PLAN_TOOL && current().items !== undefined) {
    const parsed = parsePlanItems(current().items)
    if (parsed !== undefined && JSON.stringify(parsed) !== JSON.stringify(current().items)) {
      edit().items = parsed
      repairs.push('plan_items_coerced')
    }
  }
  if (tool.dshName === TODO_UPDATE_TOOL && typeof current().status === 'string') {
    const normalized = normalizeWorklistStatus(current().status)
    if (normalized !== undefined && normalized !== current().status) {
      edit().status = normalized
      repairs.push('worklist_status_alias')
    }
  }
  return { args: out ?? args, repairs }
}
