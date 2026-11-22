// Host DSH tool implementation for `editMode: 'line-edit'`.
//
// Registers coordinate-based `edit_lines` (`{ file_path, start_line, end_line, new_text }`)
// guarded by session read observations, file-version lock, visible-line window,
// folded-read guard, and pre-write syntax check.

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  applyLineEdit,
  editSummary,
  LINE_EDIT_CONTEXT_LINES,
  syntaxRejection,
} from '../core/edit-modes/line-edit.ts'
import {
  sandboxPolicyFor,
  seenAfterEdit,
  unseenLines,
  unseenRejection,
} from '../core/edit-modes/shared.ts'
import type { SandboxPolicyLike } from '../dsh-host.ts'
import {
  attachObservations,
  EDIT_LINES_TOOL,
  remediateStaleVersion,
  resolveTargetWithGuards,
  type LineEditExecLike,
  type LineEditHostContext,
  type Observations,
} from './observations.ts'
import { introducedSyntaxError } from './syntax-check.ts'

export interface CoordinateEditArgs {
  file_path: string
  start_line: number
  end_line: number
  new_text: string
}

export function createLineEditToolDefinition(
  host: LineEditHostContext,
  observations: Observations,
): unknown {
  return defineTool({
    name: EDIT_LINES_TOOL,
    description: 'Edit an existing UTF-8 text file by replacing a range of lines, numbered as read shows them.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend. Read the file first.' },
      start_line: { type: 'number', required: true, description: 'First line to replace (1-based, as numbered by read).' },
      end_line: { type: 'number', required: true, description: 'Last line to replace. start_line - 1 inserts before start_line without replacing.' },
      new_text: { type: 'string', required: true, description: 'Lines that replace start_line..end_line, without line numbers. Empty deletes them.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { summary: string }) => [{ type: 'text', text: value.summary }],
    },
    async execute(args: CoordinateEditArgs, exec: LineEditExecLike) {
      const { target, guard } = await resolveTargetWithGuards(host, observations, args.file_path, exec)
      try {
        const text = await host.fs.readText(target, exec.signal)
        const edit = { startLine: args.start_line, endLine: args.end_line, newText: args.new_text }
        const edited = applyLineEdit(text, target.displayPath, edit)
        if (typeof edited === 'string') throw new Error(edited)
        const missing = unseenLines(guard.lines, edit, edited.before.length)
        if (missing.length > 0 && guard.lines !== 'all') {
          throw new Error(unseenRejection(target.displayPath, missing, guard.lines, edited.before.length, LINE_EDIT_CONTEXT_LINES))
        }
        const broken = await introducedSyntaxError(text, edited.content, target.displayPath)
        if (broken !== undefined) throw new Error(syntaxRejection(target.displayPath, edit, edited, broken))
        const expected = guard.version === undefined ? undefined : { kind: guard.kind, version: guard.version }
        const policy = sandboxPolicyFor(host.get('sandboxPolicy') as SandboxPolicyLike | undefined, exec.agent?.session)
        const outcome = await host.fs.writeText(target, edited.content, expected, exec.signal, policy)
        host.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        observations.setLines(exec, target, seenAfterEdit(guard.lines, edit, edited, LINE_EDIT_CONTEXT_LINES))
        return { path: host.fs.processPath(target), summary: editSummary(target.displayPath, edit, edited) }
      } catch (error: unknown) {
        throw remediateStaleVersion(error)
      }
    },
  } as never)
}

export function applyLineEditPlugin(ctx: Context): void {
  const host = ctx as unknown as LineEditHostContext
  const observations = attachObservations(host)
  host.tools.register(createLineEditToolDefinition(host, observations))
}
