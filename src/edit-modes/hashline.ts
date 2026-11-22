// Host DSH tool implementation for `editMode: 'hashline'`.
//
// Registers hash-anchored `edit_lines` (`{ file_path, start, end?, op?, new_text? }`)
// guarded by session read observations, file-version lock, visible-line window,
// folded-read guard, dual-boundary 2-hex hash check, and pre-write syntax check.

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  applyHashEdit,
  HASHLINE_CONTEXT_LINES,
  hashEditSummary,
  hashSyntaxRejection,
  type HashEditOp,
} from '../core/edit-modes/hashline.ts'
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

export interface HashEditToolArgs {
  file_path: string
  start: string
  end?: string
  op?: HashEditOp
  new_text?: string
}

export function createHashlineToolDefinition(
  host: LineEditHostContext,
  observations: Observations,
): unknown {
  return defineTool({
    name: EDIT_LINES_TOOL,
    description: 'Edit an existing UTF-8 text file using line:hash anchors shown by read (e.g. "12:a3"). Supports replace (default), insert_after, and delete.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend. Read the file first.' },
      start: { type: 'string', required: true, description: 'Start anchor "line:hash" (e.g. "12:a3") as shown by read.' },
      end: { type: 'string', description: 'Optional end anchor "line:hash" for multi-line replace/delete. Omit for single-line edits.' },
      op: { type: 'string', description: 'Operation: "replace" (default), "insert_after", or "delete".' },
      new_text: { type: 'string', description: 'Replacement or inserted lines without "line:hash|" prefixes. Required for replace/insert_after.' },
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
    async execute(args: HashEditToolArgs, exec: LineEditExecLike) {
      const { target, guard } = await resolveTargetWithGuards(host, observations, args.file_path, exec)
      try {
        const text = await host.fs.readText(target, exec.signal)
        const applied = applyHashEdit(text, target.displayPath, {
          start: args.start,
          ...(args.end !== undefined ? { end: args.end } : {}),
          ...(args.op !== undefined ? { op: args.op } : {}),
          ...(args.new_text !== undefined ? { newText: args.new_text } : {}),
        })
        if (typeof applied === 'string') throw new Error(applied)
        const lineEdit = { startLine: applied.startLine, endLine: applied.endLine, newText: args.new_text ?? '' }
        const missing = unseenLines(guard.lines, lineEdit, applied.result.before.length)
        if (missing.length > 0 && guard.lines !== 'all') {
          throw new Error(unseenRejection(target.displayPath, missing, guard.lines, applied.result.before.length, HASHLINE_CONTEXT_LINES))
        }
        const broken = await introducedSyntaxError(text, applied.result.content, target.displayPath)
        if (broken !== undefined) throw new Error(hashSyntaxRejection(target.displayPath, applied, broken))
        const expected = guard.version === undefined ? undefined : { kind: guard.kind, version: guard.version }
        const policy = sandboxPolicyFor(host.get('sandboxPolicy') as SandboxPolicyLike | undefined, exec.agent?.session)
        const outcome = await host.fs.writeText(target, applied.result.content, expected, exec.signal, policy)
        host.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        observations.setLines(exec, target, seenAfterEdit(guard.lines, lineEdit, applied.result, HASHLINE_CONTEXT_LINES))
        return { path: host.fs.processPath(target), summary: hashEditSummary(target.displayPath, applied) }
      } catch (error: unknown) {
        throw remediateStaleVersion(error)
      }
    },
  } as never)
}

export function applyHashlinePlugin(ctx: Context): void {
  const host = ctx as unknown as LineEditHostContext
  const observations = attachObservations(host)
  host.tools.register(createHashlineToolDefinition(host, observations))
}
