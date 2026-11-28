// Streaming think splitter, tool-call gate, and argument repair pipeline
// invoked by `decideStep` (`agent.ts`).

import { isNoopEditCall } from './edit-modes/index.ts'
import { cleanFinalText, type Action } from './parse.ts'
import {
  callKey,
  DUPLICATE_ANSWER_REMINDER,
  DUPLICATE_FAILED_REMINDER,
  DUPLICATE_FAILED_RETRY_REMINDER,
  duplicateRetryReminder,
  NOOP_EDIT_REMINDER,
  sameTargetFile,
  targetFileSuffix,
  toolFailureReminder,
  type TurnState,
} from './policy.ts'
import { recordToolCall, toolResponse, type Entry } from './prompt.ts'
import { isWorklistTool } from './todo-state.ts'
import {
  coerceArguments,
  normalizeArguments,
  repairNativeValues,
  resolveTool,
  type Args,
  type WireTool,
} from './tools.ts'

/** raw: guards off, output that did not parse is passed on as the answer text. */
export type FinalVia = 'model' | 'exit' | 'answer-stage' | 'salvage' | 'summary' | 'raw'

export type Decision =
  | {
    readonly type: 'tool'
    readonly tool: WireTool
    readonly args: Args
    /** The arguments as the model wrote them, before any repair. */
    readonly rawArgs: Args
    readonly repairs: readonly string[]
  }
  | { readonly type: 'final'; readonly text: string; readonly via: FinalVia }

/** Pass-through answer for output the harness does not fix (guards off). */
export function rawFinal(output: string): Decision {
  return { type: 'final', text: cleanFinalText(output) || output.trim(), via: 'raw' }
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case 'tool':
      return `tool ${action.name}${action.repairs.length > 0 ? ` (${action.repairs.join(',')})` : ''}`
    case 'exit':
      return 'no_tool'
    case 'final':
      return 'final'
    case 'error':
      return `error ${action.kind}`
  }
}

const TEXT_STOP_MARKERS = [
  '<tool_call',
  '</tool_call',
  '<tool_response',
  '<tool_result',
  '<answer',
  '<think',
  '</think',
  '\nUser:',
  '\nSystem:',
  '\nTool:',
  '\nAssistant:',
  '✿',
] as const

const MAX_TEXT_STOP_HOLD = Math.max(...TEXT_STOP_MARKERS.map(m => m.length - 1))

/**
 * Streams the reasoning of a withheld "<think" generation (dropping the
 * closing ">", stopping reasoning at </think>) and optionally streams the
 * subsequent prose text while stopping cleanly before any protocol tag
 * (<tool_call>, \nUser:, etc.) so tool calls never leak raw XML.
 */
export class ThinkSplitter {
  private buffer = ''
  private started = false
  private thinkDone = false
  private textBuffer = ''
  private textStarted = false
  private textStopped = false
  private readonly emitReasoning: ((text: string) => void) | undefined
  private readonly emitText: ((text: string) => void) | undefined

  constructor(emitReasoning?: (text: string) => void, emitText?: (text: string) => void, startInText = false) {
    this.emitReasoning = emitReasoning
    this.emitText = emitText
    this.thinkDone = startInText
  }

  feed(delta: string): void {
    if (!this.thinkDone) {
      this.buffer += delta
      if (!this.started) {
        if (this.buffer === '') return
        if (this.buffer.startsWith('>')) this.buffer = this.buffer.slice(1)
        this.started = true
      }
      const end = this.buffer.indexOf('</think>')
      if (end >= 0) {
        if (end > 0) this.emitReasoning?.(this.buffer.slice(0, end))
        const tail = this.buffer.slice(end + '</think>'.length)
        this.buffer = ''
        this.thinkDone = true
        if (tail !== '') this.feedText(tail)
        return
      }
      let hold = 0
      for (let length = Math.min(7, this.buffer.length); length > 0; length--) {
        if ('</think>'.startsWith(this.buffer.slice(-length))) {
          hold = length
          break
        }
      }
      const ready = this.buffer.slice(0, this.buffer.length - hold)
      if (ready !== '') this.emitReasoning?.(ready)
      this.buffer = this.buffer.slice(this.buffer.length - hold)
      return
    }
    this.feedText(delta)
  }

  private feedText(delta: string): void {
    if (!this.emitText || this.textStopped || delta === '') return
    this.textBuffer += delta
    if (!this.textStarted) {
      const trimmed = this.textBuffer.trimStart()
      if (trimmed === '') {
        this.textBuffer = ''
        return
      }
      this.textBuffer = trimmed
    }
    let stopAt = -1
    for (const marker of TEXT_STOP_MARKERS) {
      const idx = this.textBuffer.indexOf(marker)
      if (idx >= 0 && (stopAt < 0 || idx < stopAt)) stopAt = idx
    }
    if (stopAt >= 0) {
      const before = this.textBuffer.slice(0, stopAt).trimEnd()
      if (before !== '') {
        this.textStarted = true
        this.emitText(before)
      }
      this.textBuffer = ''
      this.textStopped = true
      return
    }
    let hold = 0
    for (let length = Math.min(MAX_TEXT_STOP_HOLD, this.textBuffer.length); length > 0; length--) {
      const tail = this.textBuffer.slice(-length)
      if (TEXT_STOP_MARKERS.some(marker => marker.startsWith(tail))) {
        hold = length
        break
      }
    }
    const ready = this.textBuffer.slice(0, this.textBuffer.length - hold)
    if (ready !== '') {
      this.textStarted = true
      this.emitText(ready)
    }
    this.textBuffer = this.textBuffer.slice(this.textBuffer.length - hold)
  }
}

export type DuplicateGateMode = 'epoch' | 'bounded' | 'adjacent' | 'off'

export interface GateOptions {
  readonly outputRepairs: boolean
  readonly guards: boolean
  readonly maxConsecutiveFailures: number
  readonly duplicateGateMode?: DuplicateGateMode
}

export type Gate =
  | { readonly type: 'run'; readonly tool: WireTool; readonly args: Args; readonly repairs: readonly string[] }
  | { readonly type: 'closeout'; readonly reminder: string }
  | { readonly type: 'duplicate-retry'; readonly receipt: Entry[] }
  | { readonly type: 'rejected'; readonly reason: 'unknown-tool' | 'blocked'; readonly receipt: Entry[] }

export function gateToolCall(
  action: Extract<Action, { type: 'tool' }>,
  state: TurnState,
  tools: readonly WireTool[],
  config: GateOptions,
  duplicateRetryUsed: boolean,
): Gate {
  const exact = tools.find(tool => tool.name === action.name)
  const resolved = config.outputRepairs ? resolveTool(tools, action.name) : exact && { tool: exact, aliased: false }
  if (resolved === undefined) {
    const error = `unknown tool "${action.name}"`
    return {
      type: 'rejected',
      reason: 'unknown-tool',
      receipt: [
        { role: 'assistant', text: recordToolCall(action.name, action.args) },
        { role: 'user', text: toolResponse(action.name, false, error) },
        { role: 'user', text: toolFailureReminder(action.name, error, false, tools) },
      ],
    }
  }
  const { tool } = resolved
  const { args, repairs } = config.outputRepairs ? repairArguments(tool, action.args, resolved.aliased) : { args: action.args, repairs: [] }
  if (!config.guards) return { type: 'run', tool, args, repairs }
  const mode: DuplicateGateMode = config.duplicateGateMode ?? 'epoch'
  if (mode === 'off') {
    // Allow repeated calls without epoch/adjacent blocking; failure and worklist caps below still apply.
  } else if (mode === 'adjacent') {
    if (isNoopEditCall(tool.dshName, args)) {
      return {
        type: 'rejected',
        reason: 'blocked',
        receipt: [
          { role: 'assistant', text: recordToolCall(tool.name, args) },
          { role: 'user', text: toolResponse(tool.name, false, NOOP_EDIT_REMINDER) },
          { role: 'user', text: NOOP_EDIT_REMINDER },
        ],
      }
    }
    const key = callKey(tool.name, args)
    if (key !== '' && key === state.lastCallKey) {
      const msg = state.lastCallOk ? duplicateRetryReminder(tools) : DUPLICATE_FAILED_RETRY_REMINDER
      return {
        type: 'rejected',
        reason: 'blocked',
        receipt: [
          { role: 'assistant', text: recordToolCall(tool.name, args) },
          { role: 'user', text: toolResponse(tool.name, false, msg) },
          { role: 'user', text: msg },
        ],
      }
    }
  } else if (mode === 'bounded') {
    if (isNoopEditCall(tool.dshName, args)) {
      const noopKey = callKey(tool.name, args)
      if ((state.epochKeyCounts.get(noopKey) ?? 0) >= 1 || duplicateRetryUsed) {
        return { type: 'closeout', reminder: NOOP_EDIT_REMINDER }
      }
      return {
        type: 'rejected',
        reason: 'blocked',
        receipt: [
          { role: 'assistant', text: recordToolCall(tool.name, args) },
          { role: 'user', text: toolResponse(tool.name, false, NOOP_EDIT_REMINDER) },
          { role: 'user', text: NOOP_EDIT_REMINDER },
        ],
      }
    }
    const key = callKey(tool.name, args)
    const seen = key === '' ? 0 : (state.epochKeyCounts.get(key) ?? 0)
    if (seen >= 2) {
      return { type: 'closeout', reminder: state.successfulCalls > 0 ? DUPLICATE_ANSWER_REMINDER : DUPLICATE_FAILED_REMINDER }
    }
    if (key !== '' && key === state.lastCallKey) {
      const msg = state.lastCallOk ? duplicateRetryReminder(tools) : DUPLICATE_FAILED_RETRY_REMINDER
      return {
        type: 'rejected',
        reason: 'blocked',
        receipt: [
          { role: 'assistant', text: recordToolCall(tool.name, args) },
          { role: 'user', text: toolResponse(tool.name, false, msg) },
          { role: 'user', text: msg },
        ],
      }
    }
    if (seen === 1) {
      const msg = state.successKeys.has(key) ? duplicateRetryReminder(tools) : DUPLICATE_FAILED_RETRY_REMINDER
      if (!duplicateRetryUsed) {
        return { type: 'duplicate-retry', receipt: [{ role: 'user', text: msg }] }
      }
      return {
        type: 'rejected',
        reason: 'blocked',
        receipt: [
          { role: 'assistant', text: recordToolCall(tool.name, args) },
          { role: 'user', text: toolResponse(tool.name, false, msg) },
          { role: 'user', text: msg },
        ],
      }
    }
    if (tool.dshName === 'edit' || tool.dshName === 'edit_lines') {
      const file = targetFileSuffix(tool.dshName, args)
      if (file !== '') {
        let failedEdits = 0
        for (const [tracked, count] of state.perFileFailedEdits) {
          if (sameTargetFile(tracked, file)) failedEdits += count
        }
        if (failedEdits >= 5) {
          return { type: 'closeout', reminder: state.successfulCalls > 0 ? DUPLICATE_ANSWER_REMINDER : DUPLICATE_FAILED_REMINDER }
        }
      }
    }
  } else {
    if (isNoopEditCall(tool.dshName, args)) {
      if (!duplicateRetryUsed) {
        return { type: 'duplicate-retry', receipt: [{ role: 'user', text: NOOP_EDIT_REMINDER }] }
      }
      return { type: 'closeout', reminder: NOOP_EDIT_REMINDER }
    }
    const key = callKey(tool.name, args)
    if (state.successKeys.has(key)) {
      // harness v26: the first repeat of a successful call gets one more decision.
      if (!duplicateRetryUsed) {
        return { type: 'duplicate-retry', receipt: [{ role: 'user', text: duplicateRetryReminder(tools) }] }
      }
      return { type: 'closeout', reminder: DUPLICATE_ANSWER_REMINDER }
    }
    if (state.failedEpochs.get(key) === state.successfulCalls) {
      if (!duplicateRetryUsed) {
        return { type: 'duplicate-retry', receipt: [{ role: 'user', text: DUPLICATE_FAILED_RETRY_REMINDER }] }
      }
      return { type: 'closeout', reminder: state.successfulCalls > 0 ? DUPLICATE_ANSWER_REMINDER : DUPLICATE_FAILED_REMINDER }
    }
  }
  const boundedEditCovered = mode === 'bounded' && (tool.dshName === 'edit' || tool.dshName === 'edit_lines')
  if (!boundedEditCovered && tool.name === state.consecutiveFailedTool && state.consecutiveFailures >= config.maxConsecutiveFailures) {
    const error = `tool "${tool.name}" blocked after ${state.consecutiveFailures} consecutive failures; choose a different tool or answer`
    return {
      type: 'rejected',
      reason: 'blocked',
      receipt: [
        { role: 'assistant', text: recordToolCall(tool.name, args) },
        { role: 'user', text: toolResponse(tool.name, false, error) },
        { role: 'user', text: toolFailureReminder(tool.name, error, true, tools) },
      ],
    }
  }
  if (isWorklistTool(tool.dshName) && state.consecutiveWorklistCalls >= 2) {
    const error = 'work list already updated twice in a row; execute a workspace tool call or answer directly'
    return {
      type: 'rejected',
      reason: 'blocked',
      receipt: [
        { role: 'assistant', text: recordToolCall(tool.name, args) },
        { role: 'user', text: toolResponse(tool.name, false, error) },
        { role: 'user', text: toolFailureReminder(tool.name, error, true, tools) },
      ],
    }
  }
  return { type: 'run', tool, args, repairs }
}

/** Argument aliases, scalar coercion and the DSH value repairs, with the names of those that applied. */
export function repairArguments(tool: WireTool, raw: Args, aliased: boolean): { args: Args; repairs: string[] } {
  const normalized = normalizeArguments(tool, raw)
  const coerced = coerceArguments(normalized, tool.schema)
  const repaired = repairNativeValues(tool, coerced)
  // DSH bash requires a description; a missing one is filled from the command.
  const filled = tool.dshName === 'bash' && raw.description === undefined && normalized.description !== undefined
  const renamed = normalized !== raw && (!filled || Object.keys(normalized).length !== Object.keys(raw).length + 1
    || Object.keys(raw).some(key => !(key in normalized)))
  return {
    args: repaired.args,
    repairs: [
      ...aliased ? ['tool_name_alias'] : [],
      ...renamed ? ['argument_alias'] : [],
      ...filled ? ['bash_description_filled'] : [],
      ...JSON.stringify(coerced) !== JSON.stringify(normalized) ? ['scalar_coerced'] : [],
      ...repaired.repairs,
    ],
  }
}
