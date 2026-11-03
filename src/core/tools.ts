// Tool catalog for the RWKV wire.
//
// DSH tools carry JSON Schema and DSH-specific names (read, write, grep, ...).
// RWKV copies schema objects and placeholder text verbatim into arguments, and
// picks tools by name, so the model sees the names and flat placeholder
// arguments it was trained on (agent-tool-v3), and each call is translated back
// to the DSH tool before DSH executes it.

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

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined

function stripUndefined(args: Args): Args {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}

/** Workspace-relative path; models trained on a sandbox emit /workspace/... and fabricated home paths. */
export function workspacePath(value: unknown): string | undefined {
  const path = str(value)
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
      const start = int(args.start_line)
      const end = int(args.end_line)
      return stripUndefined({
        file_path: workspacePath(args.path),
        offset: start,
        limit: end !== undefined ? Math.max(1, end - (start ?? 1) + 1) : undefined,
      })
    },
    fromDsh(args) {
      const offset = int(args.offset)
      const limit = int(args.limit)
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
  glob: {
    wireName: 'list_files',
    description: 'List files below a workspace-relative path.',
    arguments: '{"path":"optional relative directory","pattern":"optional glob such as *.ts"}',
    schema: { properties: { path: { type: 'string' }, pattern: { type: 'string' } } },
    toDsh: args => stripUndefined({ pattern: str(args.pattern) ?? '*', path: workspacePath(args.path) }),
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
      const url = str(args.url) ?? (Array.isArray(args.urls) ? str(args.urls[0]) : undefined)
      return { url: url ?? '' }
    },
    fromDsh: args => ({ url: args.url }),
  },
}

export const EXIT_TOOL_NAME = 'no_tool'

export const EXIT_TOOL_ENTRY = {
  name: EXIT_TOOL_NAME,
  description: 'Indicate that none of the offered tools is needed. Put a brief, complete user-facing response in reason; it becomes the final reply.',
  arguments: '{"reason":"brief complete user-facing response"}',
}

export type ToolMode = 'mapped' | 'passthrough'

export interface CatalogOptions {
  /** mapped: only DSH tools with a built-in RWKV mapping; passthrough: every offered tool, unmapped ones with a flat schema. */
  readonly mode: ToolMode
  /** Wire or DSH names to hide; applied after the mode filter. */
  readonly exclude?: readonly string[]
}

/** Flat placeholder object for an unmapped DSH tool's JSON Schema. */
export function flatPlaceholder(parameters: Record<string, unknown>): string {
  const properties = (parameters.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(parameters.required) ? parameters.required as string[] : [])
  const flat: Record<string, string> = {}
  for (const [key, schema] of Object.entries(properties)) {
    let shape: string
    if (Array.isArray(schema.enum)) shape = schema.enum.join('|')
    else if (schema.type === 'array') {
      const items = (schema.items ?? {}) as Record<string, unknown>
      shape = `array of ${String(items.type ?? 'value')}`
    } else if (typeof schema.description === 'string' && schema.type === 'string') {
      shape = firstSentence(schema.description)
    } else shape = String(Array.isArray(schema.type) ? schema.type.join('|') : schema.type ?? 'value')
    flat[key] = required.has(key) ? shape : `optional ${shape}`
  }
  return JSON.stringify(flat)
}

function firstSentence(text: string): string {
  const sentence = text.split(/(?<=\.)\s/)[0] ?? text
  return sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence.replace(/\.$/, '')
}

export function buildCatalog(offered: readonly DshToolSchema[], options: CatalogOptions): WireTool[] {
  const exclude = new Set(options.exclude ?? [])
  const tools: WireTool[] = []
  for (const tool of offered) {
    const mapping = BUILTIN_MAPPINGS[tool.name]
    if (mapping !== undefined) {
      if (exclude.has(tool.name) || exclude.has(mapping.wireName)) continue
      tools.push({
        name: mapping.wireName,
        description: mapping.description,
        arguments: mapping.arguments,
        dshName: tool.name,
        schema: mapping.schema,
        toDsh: mapping.toDsh,
        fromDsh: mapping.fromDsh,
      })
    } else if (options.mode === 'passthrough' && !exclude.has(tool.name) && tool.name !== EXIT_TOOL_NAME) {
      tools.push({
        name: tool.name,
        description: firstSentence(tool.description),
        arguments: flatPlaceholder(tool.parameters),
        dshName: tool.name,
        schema: tool.parameters,
        toDsh: args => args,
        fromDsh: args => args,
      })
    }
  }
  // Stable alphabetical order, as in the RWKV-Agent catalog.
  return tools.sort((a, b) => a.name.localeCompare(b.name))
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

export function toolAccessDescription(tools: readonly WireTool[]): string {
  const mutating = tools.some(tool => ['write_file', 'edit_file', 'bash'].includes(tool.name))
  return mutating ? 'isolated tools, including the explicitly listed mutation tools' : 'read-only tools'
}
