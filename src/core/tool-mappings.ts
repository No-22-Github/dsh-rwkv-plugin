// Built-in RWKV <-> DSH tool mappings (`agent-tool-v3` wire shapes and
// bidirectional argument converters).

import {
  normalizeWorklistStatus,
  parsePlanItems,
  TODO_PLAN_DESCRIPTION,
  TODO_PLAN_TOOL,
  TODO_UPDATE_DESCRIPTION,
  TODO_UPDATE_TOOL,
} from './todo-state.ts'

export interface DshToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export type Args = Record<string, unknown>

export interface WireTool {
  /** Name the model sees and calls. */
  readonly name: string
  readonly description: string
  /** Flat placeholder JSON object (or JSON string) shown in the catalog. */
  readonly arguments: string
  /** DSH tool that executes the call. */
  readonly dshName: string
  /** JSON Schema used for lenient scalar coercion of model arguments. */
  readonly schema?: Record<string, unknown>
  /** Shown under its DSH name with DSH arguments (names: 'dsh'). */
  readonly native?: boolean
  toDsh(args: Args): Args
  fromDsh(args: Args): Args
}

export interface ToolMapping {
  readonly wireName: string
  readonly description: string
  readonly arguments: string
  readonly schema: Record<string, unknown>
  toDsh(args: Args): Args
  fromDsh(args: Args): Args
}

export const nonEmptyStr = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

export const finiteInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined

function stripUndefined(args: Args): Args {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}

/** Workspace-relative path; models trained on a sandbox emit /workspace/... and fabricated home paths. */
export function workspacePath(value: unknown): string | undefined {
  const path = nonEmptyStr(value)
  if (path === undefined) return undefined
  const index = path.lastIndexOf('workspace/')
  if (path.startsWith('/') && index >= 0) return path.slice(index + 'workspace/'.length) || '.'
  if (path === '/workspace') return '.'
  return path
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function unescapeRegex(text: string): string {
  return text.replace(/\\([.*+?^${}()|[\]\\])/g, '$1')
}

/**
 * Built-in mappings keyed by DSH tool name. Descriptions and placeholders are
 * the agent-tool-v3 strings the RWKV-Agent corpora were rendered with.
 */
export const BUILTIN_MAPPINGS: Readonly<Record<string, ToolMapping>> = {
  read: {
    wireName: 'read_file',
    description: 'Read a UTF-8 text file in the workspace. Lines come numbered. Without start_line/end_line it returns the start of the file.',
    arguments: '{"path":"relative file path","start_line":"optional integer >= 1","end_line":"optional integer >= start_line"}',
    schema: { properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } } },
    toDsh(args) {
      const start = finiteInt(args.start_line)
      const end = finiteInt(args.end_line)
      return stripUndefined({
        file_path: workspacePath(args.path),
        offset: start,
        limit: end !== undefined ? Math.max(1, end - (start ?? 1) + 1) : undefined,
      })
    },
    fromDsh(args) {
      const offset = finiteInt(args.offset)
      const limit = finiteInt(args.limit)
      return stripUndefined({
        path: args.file_path,
        start_line: offset,
        end_line: limit !== undefined ? (offset ?? 1) + limit - 1 : undefined,
      })
    },
  },
  write: {
    wireName: 'write_file',
    description: 'Create or overwrite a workspace text file with the given content. The content becomes the whole file.',
    arguments: '{"path":"relative file path","content":"full file content"}',
    schema: { properties: { path: { type: 'string' }, content: { type: 'string' } } },
    toDsh: args => ({ file_path: workspacePath(args.path), content: args.content ?? '' }),
    fromDsh: args => ({ path: args.file_path, content: args.content }),
  },
  edit: {
    wireName: 'edit_file',
    description: 'Replace one exact piece of text in a workspace text file. old_text must appear exactly once; copy it from read_file without the line numbers.',
    arguments: '{"path":"relative file path","old_text":"exact text to replace","new_text":"replacement text"}',
    schema: { properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } } },
    toDsh: args => ({ file_path: workspacePath(args.path), old_string: args.old_text ?? '', new_string: args.new_text ?? '' }),
    fromDsh: args => ({ path: args.file_path, old_text: args.old_string, new_text: args.new_string }),
  },
  // Line-range edit (src/line-edit.ts); offered only where that plugin is mounted.
  edit_lines: {
    wireName: 'edit_lines',
    description: 'Replace a range of lines in a workspace text file, numbered as read_file shows them. end_line = start_line - 1 inserts before start_line.',
    arguments: '{"path":"relative file path","start_line":"first line to replace","end_line":"last line to replace","new_text":"replacement lines without line numbers"}',
    schema: { properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_text: { type: 'string' } } },
    toDsh: args => ({ file_path: workspacePath(args.path), start_line: args.start_line, end_line: args.end_line, new_text: args.new_text ?? '' }),
    fromDsh: args => ({ path: args.file_path, start_line: args.start_line, end_line: args.end_line, new_text: args.new_text }),
  },
  glob: {
    wireName: 'list_files',
    description: 'List files below a workspace-relative path.',
    arguments: '{"path":"optional relative directory","pattern":"optional glob such as *.ts"}',
    schema: { properties: { path: { type: 'string' }, pattern: { type: 'string' } } },
    toDsh: args => stripUndefined({ pattern: nonEmptyStr(args.pattern) ?? '*', path: workspacePath(args.path) }),
    fromDsh: args => stripUndefined({ path: args.path, pattern: args.pattern === '*' ? undefined : args.pattern }),
  },
  grep: {
    wireName: 'search_text',
    description: 'Search literal text in workspace files. Returns matching lines with line numbers.',
    arguments: '{"query":"literal text","path":"optional relative path"}',
    schema: { properties: { query: { type: 'string' }, path: { type: 'string' } } },
    toDsh: args => stripUndefined({ pattern: escapeRegex(String(args.query ?? '')), path: workspacePath(args.path) }),
    fromDsh: args => stripUndefined({ query: unescapeRegex(String(args.pattern ?? '')), path: args.path }),
  },
  bash: {
    wireName: 'bash',
    description: 'Run a bash command in the workspace and return stdout and stderr. Each call starts in the workspace and does not keep cd or variables from earlier calls.',
    arguments: '{"command":"bash command line"}',
    schema: { properties: { command: { type: 'string' } } },
    toDsh(args) {
      const command = String(args.command ?? '')
      const firstLine = command.split('\n')[0] ?? ''
      return { description: firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || 'Run command', command }
    },
    fromDsh: args => ({ command: args.command }),
  },
  web_search: {
    wireName: 'web_search',
    description: 'Search the public web and return titles, URLs, snippets, and source IDs.',
    arguments: '{"query":"search query"}',
    schema: { properties: { query: { type: 'string' } } },
    toDsh: args => ({ queries: [String(args.query ?? '')] }),
    fromDsh: args => ({ query: Array.isArray(args.queries) ? args.queries.join(' ') : args.queries }),
  },
  web_fetch: {
    wireName: 'web_fetch',
    description: 'Fetch the readable content of one public web page.',
    arguments: '{"url":"https://example.com/page"}',
    schema: { properties: { url: { type: 'string' } } },
    toDsh(args) {
      const url = nonEmptyStr(args.url) ?? (Array.isArray(args.urls) ? nonEmptyStr(args.urls[0]) : undefined)
      return { url: url ?? '' }
    },
    fromDsh: args => ({ url: args.url }),
  },
  // Stateful work list (src/todo.ts); offered when historyMode === 'worklist'.
  [TODO_PLAN_TOOL]: {
    wireName: TODO_PLAN_TOOL,
    description: TODO_PLAN_DESCRIPTION,
    arguments: '{"items":"array of string"}',
    schema: { properties: { items: { type: 'array', items: { type: 'string' } } } },
    toDsh: args => ({ items: parsePlanItems(args.items) ?? args.items }),
    fromDsh: args => ({ items: args.items }),
  },
  [TODO_UPDATE_TOOL]: {
    wireName: TODO_UPDATE_TOOL,
    description: TODO_UPDATE_DESCRIPTION,
    arguments: '{"id":"integer","status":"in_progress|completed|dropped","note":"optional Concrete findings, exact file paths/lines, applied edits, or test outcomes","content":"optional Refined title for this item if the initial wording was inaccurate"}',
    schema: {
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['in_progress', 'completed', 'dropped'] },
        note: { type: 'string' },
        content: { type: 'string' },
      },
    },
    toDsh: args => stripUndefined({
      id: finiteInt(typeof args.id === 'string' ? Number(args.id.trim()) : args.id) ?? args.id,
      status: normalizeWorklistStatus(args.status) ?? args.status,
      note: nonEmptyStr(args.note),
      content: nonEmptyStr(args.content),
    }),
    fromDsh: args => stripUndefined({
      id: args.id,
      status: args.status,
      note: args.note,
      content: args.content,
    }),
  },
}
