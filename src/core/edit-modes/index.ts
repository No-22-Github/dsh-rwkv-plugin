// Central registry for all supported edit modes (`tolerant`, `line-edit`,
// `hashline`, `literal`). Consolidates mode validation, tool exclusion rules,
// schema-aware `edit_lines` dispatch, and step-gate no-op checks so callers do
// not scatter `editMode === ...` branches across the codebase.

import { DEFAULT_EDIT_MODE, type EditMode } from '../defaults.ts'
import {
  HASHLINE_EDIT_MODE,
  HASHLINE_NATIVE_ALIASES,
  HASHLINE_TRAINED_ALIASES,
  HASHLINE_WIRE_SCHEMA,
} from './hashline.ts'
import {
  LINE_EDIT_MODE,
  LINE_EDIT_NATIVE_ALIASES,
  LINE_EDIT_TRAINED_ALIASES,
  LINE_EDIT_WIRE_SCHEMA,
} from './line-edit.ts'
import { LITERAL_EDIT_MODE, type EditModeSpec } from './literal.ts'
import { TOLERANT_EDIT_MODE } from './tolerant.ts'

export type { EditModeSpec } from './literal.ts'

export const EDIT_MODES: readonly EditMode[] = ['tolerant', 'line-edit', 'hashline', 'literal']

export const EDIT_MODE_SPECS: Readonly<Record<EditMode, EditModeSpec>> = {
  tolerant: TOLERANT_EDIT_MODE,
  'line-edit': LINE_EDIT_MODE,
  hashline: HASHLINE_EDIT_MODE,
  literal: LITERAL_EDIT_MODE,
}

export function isEditMode(value: unknown): value is EditMode {
  return typeof value === 'string' && Object.hasOwn(EDIT_MODE_SPECS, value)
}

export function editModeSpec(mode: EditMode | undefined): EditModeSpec {
  return EDIT_MODE_SPECS[mode ?? DEFAULT_EDIT_MODE]
}

export function excludedToolsForEditMode(mode: EditMode | undefined): readonly string[] {
  return mode === undefined ? [] : EDIT_MODE_SPECS[mode].excludedTools
}

export function mountsEditLinesPlugin(mode: EditMode): boolean {
  return EDIT_MODE_SPECS[mode].mountsEditLinesPlugin
}

export function usesHashReadFormat(mode: EditMode | undefined): boolean {
  return editModeSpec(mode).formatsHashRead
}

export function usesTolerantEditHook(mode: EditMode | undefined): boolean {
  return editModeSpec(mode).usesTolerantHook
}

/**
 * Distinguish the `hashline` variant of `edit_lines` (`{ file_path, start, end?, op?, new_text? }`)
 * from the coordinate `line-edit` variant (`{ file_path, start_line, end_line, new_text }`)
 * directly from the DSH tool schema.
 */
export function isHashlineToolSchema(schema: Record<string, unknown> | undefined): boolean {
  if (schema === undefined) return false
  const props = (schema.properties ?? schema) as Record<string, unknown>
  return typeof props === 'object' && props !== null && 'start' in props && !('start_line' in props)
}

/** Select the right argument-alias table for `edit_lines` without clobbering `start`/`end` in `hashline` mode. */
export function editLinesAliasesFor(options: {
  readonly native: boolean
  readonly schema?: Record<string, unknown>
}): Readonly<Record<string, readonly string[]>> {
  const hashline = isHashlineToolSchema(options.schema)
  if (options.native) return hashline ? HASHLINE_NATIVE_ALIASES : LINE_EDIT_NATIVE_ALIASES
  return hashline ? HASHLINE_TRAINED_ALIASES : LINE_EDIT_TRAINED_ALIASES
}

/** Select the trained-wire schema & converters for `edit_lines` based on the offered DSH schema. */
export function editLinesTrainedWireSpec(
  offeredSchema: Record<string, unknown> | undefined,
  workspacePath: (value: unknown) => string | undefined,
): {
  readonly wireName: string
  readonly description: string
  readonly arguments: string
  readonly schema: Record<string, unknown>
  toDsh(args: Record<string, unknown>): Record<string, unknown>
  fromDsh(args: Record<string, unknown>): Record<string, unknown>
} {
  if (isHashlineToolSchema(offeredSchema)) {
    return {
      wireName: 'edit_lines',
      description: 'Edit a workspace text file using line:hash anchors shown by read_file (e.g. "12:a3"). Supports replace (default), insert_after, and delete.',
      arguments: '{"path":"relative file path","start":"line:hash anchor","end":"optional line:hash end anchor","op":"optional replace|insert_after|delete","new_text":"optional replacement lines without line:hash| prefixes"}',
      schema: HASHLINE_WIRE_SCHEMA,
      toDsh: args => ({
        file_path: workspacePath(args.path),
        start: args.start,
        ...(args.end !== undefined ? { end: args.end } : {}),
        ...(args.op !== undefined ? { op: args.op } : {}),
        ...(args.new_text !== undefined ? { new_text: args.new_text } : {}),
      }),
      fromDsh: args => ({
        path: args.file_path,
        start: args.start,
        ...(args.end !== undefined ? { end: args.end } : {}),
        ...(args.op !== undefined ? { op: args.op } : {}),
        ...(args.new_text !== undefined ? { new_text: args.new_text } : {}),
      }),
    }
  }
  return {
    wireName: 'edit_lines',
    description: 'Replace a range of lines in a workspace text file, numbered as read_file shows them. end_line = start_line - 1 inserts before start_line.',
    arguments: '{"path":"relative file path","start_line":"first line to replace","end_line":"last line to replace","new_text":"replacement lines without line numbers"}',
    schema: LINE_EDIT_WIRE_SCHEMA,
    toDsh: args => ({ file_path: workspacePath(args.path), start_line: args.start_line, end_line: args.end_line, new_text: args.new_text ?? '' }),
    fromDsh: args => ({ path: args.file_path, start_line: args.start_line, end_line: args.end_line, new_text: args.new_text }),
  }
}

/** True when a model-emitted edit call is a guaranteed no-op before touching disk. */
export function isNoopEditCall(dshName: string, args: Record<string, unknown>): boolean {
  if (dshName === 'edit') {
    const oldText = typeof args.old_string === 'string' ? args.old_string : args.old_text
    const newText = typeof args.new_string === 'string' ? args.new_string : args.new_text
    return typeof oldText === 'string' && typeof newText === 'string' && oldText === newText
  }
  return false
}
