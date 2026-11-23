// Host DSH tool implementation for `editMode: 'line-edit'`
// (Anchored Batch Line-Edit v2).
//
// Registers `edit_lines` supporting both canonical atomic multi-hunk batches
// (`{ file_path, edits: [{ start_line, end_line, start_text, end_text?, new_text }] }`)
// and backward-compatible single-hunk shorthand
// (`{ file_path, start_line, end_line, start_text?, end_text?, new_text }`),
// guarded by session read observations, file-version lock, visible-line window,
// folded-read guard (with verified-anchor bypass on observed file versions),
// and pre-write incremental syntax check.

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  applyAnchoredLineEdits,
  batchEditSummary,
  batchSyntaxRejection,
  isNonTrivialAnchor,
  LINE_EDIT_CONTEXT_LINES,
  parseLineEditHunks,
  type RawLineEditHunk,
} from '../core/edit-modes/line-edit.ts'
import {
  sandboxPolicyFor,
  seenAfterBatchEdit,
  unseenLines,
  unseenRejection,
} from '../core/edit-modes/shared.ts'
import type { SandboxPolicyLike } from '../dsh-host.ts'
import { foldedUnreadErrorMessage } from './folded-read-guard.ts'
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

export interface AnchoredLineEditArgs {
  file_path: string
  edits?: RawLineEditHunk[] | string
  start_line?: number
  end_line?: number
  start_text?: string
  end_text?: string
  new_text?: string
}

export function createLineEditToolDefinition(
  host: LineEditHostContext,
  observations: Observations,
): unknown {
  return defineTool({
    name: EDIT_LINES_TOOL,
    description:
      'Atomically apply one or more non-overlapping anchored line-range edits to an existing UTF-8 text file. '
      + 'Pass `edits: [{ start_line, end_line, start_text, end_text?, new_text }]` (pre-edit 1-based line numbers; `end_line = start_line - 1` inserts before `start_line`; empty `new_text` deletes). '
      + 'Always include `start_text` (the original text at `start_line` without line-number prefix) so minor line drift auto-aligns cleanly. Single-hunk top-level `start_line`/`end_line`/`new_text` shorthand is also accepted.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend. Read the file first.' },
      edits: {
        type: 'array',
        description: 'One or more non-overlapping anchored edits evaluated against pre-edit 1-based line numbers.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start_line: { type: 'number', required: true, description: '1-based first line to replace (from read output).' },
            end_line: { type: 'number', required: true, description: '1-based last line to replace (start_line - 1 inserts before start_line).' },
            start_text: { type: 'string', description: 'Original text of line start_line without line-number prefix (verifies and auto-aligns line drift).' },
            end_text: { type: 'string', description: 'Optional original text of line end_line for multi-line spans.' },
            new_text: { type: 'string', required: true, description: 'Replacement lines without line-number prefixes (empty string deletes).' },
          },
        },
      },
      start_line: { type: 'number', description: 'Single-hunk shorthand: 1-based first line to replace.' },
      end_line: { type: 'number', description: 'Single-hunk shorthand: 1-based last line to replace (start_line - 1 inserts).' },
      start_text: { type: 'string', description: 'Single-hunk shorthand: original text of line start_line without line-number prefix.' },
      end_text: { type: 'string', description: 'Single-hunk shorthand: optional original text of line end_line.' },
      new_text: { type: 'string', description: 'Single-hunk shorthand: replacement lines without line numbers.' },
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
    async execute(args: AnchoredLineEditArgs, exec: LineEditExecLike) {
      const hunks = parseLineEditHunks(args as unknown as Record<string, unknown>)
      if (typeof hunks === 'string') throw new Error(hunks)
      const allNonTrivialAnchored = hunks.every(h => isNonTrivialAnchor(h.startText, 8))
      const { target, guard, folded } = await resolveTargetWithGuards(
        host,
        observations,
        args.file_path,
        exec,
        { allowFolded: allNonTrivialAnchored },
      )
      try {
        const text = await host.fs.readText(target, exec.signal)
        const edited = applyAnchoredLineEdits(text, target.displayPath, hunks)
        if (typeof edited === 'string') throw new Error(edited)

        const allVerified = allNonTrivialAnchored && edited.hunks.every(h => h.anchorVerified)
        if (folded && !allVerified) {
          throw new Error(foldedUnreadErrorMessage(target.displayPath, EDIT_LINES_TOOL))
        }

        if (guard.lines !== 'all') {
          for (const h of edited.hunks) {
            if (h.anchorVerified && isNonTrivialAnchor(hunks[h.index]?.startText, 8)) continue
            const missing = unseenLines(guard.lines, h, edited.before.length)
            if (missing.length > 0) {
              throw new Error(unseenRejection(target.displayPath, missing, guard.lines, edited.before.length, LINE_EDIT_CONTEXT_LINES))
            }
          }
        }

        const broken = await introducedSyntaxError(text, edited.content, target.displayPath)
        if (broken !== undefined) throw new Error(batchSyntaxRejection(target.displayPath, edited, broken))

        const expected = guard.version === undefined ? undefined : { kind: guard.kind, version: guard.version }
        const policy = sandboxPolicyFor(host.get('sandboxPolicy') as SandboxPolicyLike | undefined, exec.agent?.session)
        const outcome = await host.fs.writeText(target, edited.content, expected, exec.signal, policy)
        host.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        observations.setLines(
          exec,
          target,
          seenAfterBatchEdit(guard.lines, edited.hunks, edited.after.length, LINE_EDIT_CONTEXT_LINES),
        )
        return { path: host.fs.processPath(target), summary: batchEditSummary(target.displayPath, edited) }
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
