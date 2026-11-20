// Streaming think splitter, tool-call gate, and argument repair pipeline
// invoked by `decideStep` (`agent.ts`).

import { cleanFinalText, type Action } from './parse.ts'
import {
  callKey,
  DUPLICATE_ANSWER_REMINDER,
  DUPLICATE_FAILED_REMINDER,
  DUPLICATE_FAILED_RETRY_REMINDER,
  duplicateRetryReminder,
  NOOP_EDIT_REMINDER,
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

/** Streams the reasoning of a withheld "<think" generation: drops the closing ">", stops at </think>. */
export class ThinkSplitter {
  private buffer = ''
  private started = false
  private done = false
  private readonly emit: (text: string) => void

  constructor(emit: (text: string) => void) {
    this.emit = emit
  }

  feed(delta: string): void {
    if (this.done) return
    this.buffer += delta
    if (!this.started) {
      if (this.buffer === '') return
      if (this.buffer.startsWith('>')) this.buffer = this.buffer.slice(1)
      this.started = true
    }
    const end = this.buffer.indexOf('</think>')
    if (end >= 0) {
      if (end > 0) this.emit(this.buffer.slice(0, end))
      this.buffer = ''
      this.done = true
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
    if (ready !== '') this.emit(ready)
    this.buffer = this.buffer.slice(this.buffer.length - hold)
  }
}

export interface GateOptions {
  readonly outputRepairs: boolean
  readonly guards: boolean
  readonly maxConsecutiveFailures: number
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
  if (tool.dshName === 'edit') {
    const oldText = typeof args.old_string === 'string' ? args.old_string : args.old_text
    const newText = typeof args.new_string === 'string' ? args.new_string : args.new_text
    if (typeof oldText === 'string' && typeof newText === 'string' && oldText === newText) {
      if (!duplicateRetryUsed) {
        return { type: 'duplicate-retry', receipt: [{ role: 'user', text: NOOP_EDIT_REMINDER }] }
      }
      return { type: 'closeout', reminder: NOOP_EDIT_REMINDER }
    }
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
  if (tool.name === state.consecutiveFailedTool && state.consecutiveFailures >= config.maxConsecutiveFailures) {
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
