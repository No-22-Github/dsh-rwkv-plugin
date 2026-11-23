// Tool catalog assembly for the RWKV wire (built-in mappings live in
// `tool-mappings.ts`; name/argument repairs live in `tool-repairs.ts`;
// stateful worklist schemas/helpers live in `todo-state.ts`).

import { editLinesTrainedWireSpec, LINE_EDIT_DSH_WIRE_ARGUMENTS } from './edit-modes/index.ts'
import { TODO_PLAN_TOOL } from './todo-state.ts'
import { BUILTIN_MAPPINGS, workspacePath, type DshToolSchema, type WireTool } from './tool-mappings.ts'

export {
  isWorklistTool,
  normalizeWorklistStatus,
  parsePlanItems,
  sanitizeWorklistField,
  TODO_PLAN_DESCRIPTION,
  TODO_PLAN_TOOL,
  TODO_UPDATE_DESCRIPTION,
  TODO_UPDATE_TOOL,
  WORKLIST_TOOLS,
  type WorklistStatus,
} from './todo-state.ts'

export {
  BUILTIN_MAPPINGS,
  workspacePath,
  type Args,
  type DshToolSchema,
  type ToolMapping,
  type WireTool,
} from './tool-mappings.ts'

export {
  coerceArguments,
  normalizeArguments,
  repairNativeValues,
  resolveTool,
} from './tool-repairs.ts'

export const EXIT_TOOL_NAME = 'no_tool'

export const EXIT_TOOL_ENTRY = {
  name: EXIT_TOOL_NAME,
  description: 'Indicate that none of the offered tools is needed. Put a brief, complete user-facing response in reason; it becomes the final reply.',
  arguments: '{"reason":"brief complete user-facing response"}',
}

export type ToolMode = 'mapped' | 'passthrough'

/** trained: the agent-tool-v3 names and arguments (read_file, ...); dsh: DSH's own names, descriptions and arguments. */
export type ToolNames = 'trained' | 'dsh'

export interface CatalogOptions {
  /** mapped: only DSH tools with a built-in RWKV mapping; passthrough: every offered tool, unmapped ones with a flat schema. */
  readonly mode: ToolMode
  /** Defaults to trained. */
  readonly names?: ToolNames
  /** Wire or DSH names to hide; applied after the mode filter. */
  readonly exclude?: readonly string[]
  /** Experiment-only: replace a tool's description and/or argument placeholders, keyed by wire or DSH name. */
  readonly overrides?: Readonly<Record<string, ToolOverride>>
}

/** Replacement text for one catalog entry; unset fields keep the default. */
export interface ToolOverride {
  readonly description?: string
  /** Argument placeholder text by argument key; keys the tool does not have are ignored. */
  readonly arguments?: Readonly<Record<string, string>>
}

function applyOverride(tool: WireTool, override: ToolOverride | undefined): WireTool {
  if (override === undefined) return tool
  let args = tool.arguments
  if (override.arguments !== undefined) {
    const parsed = JSON.parse(args) as Record<string, string>
    for (const [key, text] of Object.entries(override.arguments)) {
      if (key in parsed) parsed[key] = text
    }
    args = JSON.stringify(parsed)
  }
  return { ...tool, description: override.description ?? tool.description, arguments: args }
}

function firstSentence(text: string): string {
  const sentence = text.split(/(?<=\.)\s/)[0] ?? text
  return sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence.replace(/\.$/, '')
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

export function buildCatalog(offered: readonly DshToolSchema[], options: CatalogOptions): WireTool[] {
  const exclude = new Set(options.exclude ?? [])
  // The line-range edit replaces the literal one wherever it is mounted and active.
  if (offered.some(tool => tool.name === 'edit_lines') && !exclude.has('edit_lines')) exclude.add('edit')
  // Stateful worklist replaces DSH's whole-list `todo_write` when offered and active.
  if (offered.some(tool => tool.name === TODO_PLAN_TOOL) && !exclude.has(TODO_PLAN_TOOL)) exclude.add('todo_write')
  const tools: WireTool[] = []
  for (const tool of offered) {
    const mapping = BUILTIN_MAPPINGS[tool.name]
    if (mapping !== undefined && options.names === 'dsh') {
      if (exclude.has(tool.name)) continue
      tools.push({
        name: tool.name,
        description: tool.description,
        arguments: tool.name === 'edit_lines' ? LINE_EDIT_DSH_WIRE_ARGUMENTS : flatPlaceholder(tool.parameters),
        dshName: tool.name,
        schema: tool.parameters,
        native: true,
        toDsh: args => args,
        fromDsh: args => args,
      })
    } else if (mapping !== undefined) {
      const effective = tool.name === 'edit_lines'
        ? editLinesTrainedWireSpec(workspacePath)
        : mapping
      if (exclude.has(tool.name) || exclude.has(effective.wireName)) continue
      tools.push({
        name: effective.wireName,
        description: effective.description,
        arguments: effective.arguments,
        dshName: tool.name,
        schema: effective.schema,
        toDsh: effective.toDsh,
        fromDsh: effective.fromDsh,
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
  const overrides = options.overrides ?? {}
  const final = tools.map(tool => applyOverride(tool, overrides[tool.name] ?? overrides[tool.dshName]))
  // Stable alphabetical order, as in the RWKV-Agent catalog.
  return final.sort((a, b) => a.name.localeCompare(b.name))
}

export function toolAccessDescription(tools: readonly WireTool[]): string {
  const mutating = tools.some(tool => ['write', 'edit', 'edit_lines', 'bash'].includes(tool.dshName))
  return mutating ? 'isolated tools, including the explicitly listed mutation tools' : 'read-only tools'
}
