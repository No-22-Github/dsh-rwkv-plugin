// Central registry for all supported edit modes (`tolerant`, `line-edit`,
// `literal`). Consolidates mode validation, tool exclusion rules,
// `edit_lines` wire mapping, read-line caps, and step-gate no-op checks.

import { DEFAULT_EDIT_MODE, type EditMode } from '../defaults.ts'
import {
  LINE_EDIT_DSH_WIRE_ARGUMENTS,
  LINE_EDIT_MODE,
  LINE_EDIT_NATIVE_ALIASES,
  LINE_EDIT_TRAINED_ALIASES,
  LINE_EDIT_WIRE_SCHEMA,
  normalizeLineEditArgs,
} from './line-edit.ts'
import { LITERAL_EDIT_MODE, type EditModeSpec } from './literal.ts'
import { TOLERANT_EDIT_MODE } from './tolerant.ts'

export { LINE_EDIT_DSH_WIRE_ARGUMENTS }
export type { EditModeSpec } from './literal.ts'

export const EDIT_MODES: readonly EditMode[] = ['tolerant', 'line-edit', 'literal']

export const EDIT_MODE_SPECS: Readonly<Record<EditMode, EditModeSpec>> = {
  tolerant: TOLERANT_EDIT_MODE,
  'line-edit': LINE_EDIT_MODE,
  literal: LITERAL_EDIT_MODE,
}

export function isEditMode(value: unknown): value is EditMode {
  return typeof value === 'string' && Object.hasOwn(EDIT_MODE_SPECS, value)
}

export function editModeSpec(mode: EditMode | undefined): EditModeSpec {
  const specs = EDIT_MODE_SPECS as Record<string, EditModeSpec | undefined>
  return specs[mode ?? DEFAULT_EDIT_MODE] ?? EDIT_MODE_SPECS[DEFAULT_EDIT_MODE]
}

export function excludedToolsForEditMode(mode: EditMode | undefined): readonly string[] {
  return mode === undefined ? [] : editModeSpec(mode).excludedTools
}

export function mountsEditLinesPlugin(mode: EditMode): boolean {
  return EDIT_MODE_SPECS[mode].mountsEditLinesPlugin
}

export function maxReadLinesForEditMode(mode: EditMode | undefined): number | undefined {
  return editModeSpec(mode).maxReadLines
}

export function usesTolerantEditHook(mode: EditMode | undefined): boolean {
  return editModeSpec(mode).usesTolerantHook
}

/** Select the argument-alias table for `edit_lines`. */
export function editLinesAliasesFor(options: {
  readonly native: boolean
}): Readonly<Record<string, readonly string[]>> {
  return options.native ? LINE_EDIT_NATIVE_ALIASES : LINE_EDIT_TRAINED_ALIASES
}

/** Trained-wire schema & converters for Anchored Batch `edit_lines`. */
export function editLinesTrainedWireSpec(
  workspacePath: (value: unknown) => string | undefined,
): {
  readonly wireName: string
  readonly description: string
  readonly arguments: string
  readonly schema: Record<string, unknown>
  toDsh(args: Record<string, unknown>): Record<string, unknown>
  fromDsh(args: Record<string, unknown>): Record<string, unknown>
} {
  return {
    wireName: 'edit_lines',
    description: 'Atomically apply one or more non-overlapping anchored line-range edits in a workspace text file. Include start_text (original text at start_line without line number) so minor line drift auto-aligns; end_line = start_line - 1 inserts before start_line.',
    arguments: '{"path":"relative file path","edits":[{"start_line":"1-based first line","end_line":"1-based last line","start_text":"original text at start_line","new_text":"replacement lines without line numbers"}]}',
    schema: LINE_EDIT_WIRE_SCHEMA,
    toDsh: raw => {
      const args = normalizeLineEditArgs(raw)
      return {
        file_path: workspacePath(args.path),
        ...(args.edits !== undefined ? { edits: args.edits } : {}),
        ...(args.start_line !== undefined ? { start_line: args.start_line } : {}),
        ...(args.end_line !== undefined ? { end_line: args.end_line } : {}),
        ...(args.start_text !== undefined ? { start_text: args.start_text } : {}),
        ...(args.end_text !== undefined ? { end_text: args.end_text } : {}),
        ...(args.new_text !== undefined ? { new_text: args.new_text } : {}),
      }
    },
    fromDsh: args => ({
      path: args.file_path,
      ...(args.edits !== undefined ? { edits: args.edits } : {}),
      ...(args.start_line !== undefined ? { start_line: args.start_line } : {}),
      ...(args.end_line !== undefined ? { end_line: args.end_line } : {}),
      ...(args.start_text !== undefined ? { start_text: args.start_text } : {}),
      ...(args.end_text !== undefined ? { end_text: args.end_text } : {}),
      ...(args.new_text !== undefined ? { new_text: args.new_text } : {}),
    }),
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
