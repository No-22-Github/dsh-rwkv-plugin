// Harness feedback text and per-turn state, ported from RWKV-Agent
// internal/agent (runner_policy.go, runner_config.go, protocol_g1.go,
// runner_turn.go, runner_answer_fallback.go). DSH executes the tools and keeps
// the history, so the turn state is rebuilt from that history on every request.

import { FOLDED_OUTPUT_MARKER } from './defaults.ts'
import { cleanFinalText, type ParseErrorKind } from './parse.ts'
import { recordToolCall, toolResponse, type Entry } from './prompt.ts'
import type { Args, WireTool } from './tools.ts'

export type HistoryItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string; readonly reasoning?: string }
  | { readonly kind: 'call'; readonly id: string; readonly name: string; readonly args: Args; readonly reasoning?: string }
  | { readonly kind: 'result'; readonly id: string; readonly name: string; readonly ok: boolean; readonly text: string }

export const POST_TOOL_REMINDER = `Use the Tool results above to continue the current task.
If the evidence is sufficient, answer now. Call another tool only for a specific missing fact.
Never repeat a successful tool call. Do not open a <think> block or repeat the Tool payload.`

/** nudge=think (agent-wire-think-v1.0): the reminder that does not forbid thinking. */
export const POST_TOOL_REMINDER_THINK = POST_TOOL_REMINDER.replace(
  'Do not open a <think> block or repeat the Tool payload.',
  'Do not repeat the Tool payload.',
)

export const DUPLICATE_ANSWER_REMINDER = `That tool call was rejected because it repeats a successful call.
Answer the current task from the evidence already collected.`

export const DUPLICATE_FAILED_REMINDER = `That tool call was rejected because it repeats an earlier failed call.
Tools are now unavailable. Answer from the Tool results, and clearly state anything that could not be verified.`

export const NOOP_EDIT_REMINDER = 'That edit call was rejected because old_string and new_string are identical, so the file would not change. '
  + 'Provide the actual target text to change, or if the edits are already complete, answer the user directly.'

export const DUPLICATE_FAILED_RETRY_REMINDER = 'That tool call was rejected because it repeats an earlier failed call with the exact same arguments. '
  + 'Do not repeat the same call. Inspect the previous error and change the arguments, try a different tool, or answer directly.'

/** harness v26: the first repeat of a successful call gets one more decision with an edit hint. */
export function duplicateRetryReminder(tools: readonly WireTool[]): string {
  let prompt = 'That tool call was rejected because it repeats a successful call; its result is already above. Do not call it again.\n'
  const edits = ['edit', 'edit_lines', 'write'].flatMap(dsh => tools.filter(tool => tool.dshName === dsh).map(tool => tool.name))
  if (edits.length > 0) {
    prompt += `If the task asks to change a file you have already read, make the change now with ${edits.join(' or ')}, using the text already shown.\n`
  }
  return `${prompt}If one specific fact is still missing, call a tool with different arguments. Otherwise answer now.`
}

/** Keyed by DSH tool name; the hint names the tools as the catalog shows them. */
const FAILURE_HINTS: Record<string, { companions: string[]; hint: (names: Record<string, string>) => string }> = {
  read: {
    companions: ['read', 'glob', 'grep'],
    hint: n => `If the path is uncertain, use ${n.glob} or ${n.grep} before another ${n.read} call. `,
  },
  glob: {
    companions: ['grep'],
    hint: n => `Try an existing parent directory or workspace root, or use ${n.grep} for a known literal. `,
  },
}

export function toolFailureReminder(name: string, error: string, recoveryBlocked: boolean, tools: readonly WireTool[]): string {
  const summary = oneLine(error)
  if (/already applied|no edit needed/i.test(summary)) {
    return `${summary} Do not repeat this edit. Continue with any remaining changes, or answer the user directly if all work is done.`
  }
  let prompt = `The tool call failed: ${summary}. `
  prompt += recoveryBlocked ? 'Do not call the same tool again in this turn. ' : 'Do not repeat the same call. '
  const failed = tools.find(tool => tool.name === name)
  const entry = failed === undefined ? undefined : FAILURE_HINTS[failed.dshName]
  const names: Record<string, string> = Object.fromEntries(tools.map(tool => [tool.dshName, tool.name]))
  if (entry && entry.companions.every(companion => names[companion] !== undefined)) prompt += entry.hint(names)
  return `${prompt}Choose a different useful tool or answer with the limitation. Do not guess.`
}

export function oneStageAnswerInstruction(): string {
  return `Tool execution is complete and tools are now unavailable.
Answer the original current task directly in ordinary text using the Tool results above. Do not call another tool or repeat the Tool results. If they are insufficient, say what could not be verified.`
}

export const ANSWER_STAGE_REASK = 'Answer the original current task in ordinary Markdown NOW using the Function outputs above. This is your final answer; tool calls are forbidden.'

export const EMPTY_EXIT_REASK = 'The no_tool decision with empty arguments was accepted. No tool will be executed. '
  + 'No user-facing reason or answer was provided, and no tool evidence exists. '
  + 'Answer the original current task directly in ordinary Markdown now. '
  + 'Do not output another function call or repeat the no_tool action.'

export function correction(kind: ParseErrorKind): string {
  const action = 'Either answer directly in ordinary text, or output exactly one '
    + '<tool_call>{"name":"...","arguments":{...}}</tool_call> and nothing else.'
  switch (kind) {
    case 'unclosed-think':
      return 'Your previous reasoning never finished and was cut off. Do not restart it. '
        + `Close the thinking block with </think> immediately, then ${action} `
        + 'Decide with the evidence you already have instead of reasoning further.'
    case 'length':
      return `Your previous response was cut off by the output limit. Be far more concise. Skip preamble and restated reasoning, then ${action}`
    default:
      return `Your previous response was invalid. ${action}`
  }
}

export function isChinese(text: string): boolean {
  return /\p{Script=Han}/u.test(text)
}

/** Prose opening prefilled for the last answer generation; a continuation mid-sentence rarely becomes a call. */
export function answerOpener(task: string): string {
  return isChinese(task) ? '根据上面的工具结果，' : 'Based on the tool results above,'
}

const PLANNING_MARKERS = ['让我', '我需要', '我将', '我会再', '接下来', '再搜', '再查', 'let me', 'i need to', 'i will', 'i\'ll', 'next,']

/** Prose written before a tool frame, when it is a real answer and not a plan. */
export function salvageAnswerProse(output: string, opener = ''): string {
  let text = output
  const think = text.lastIndexOf('</think>')
  if (think >= 0) text = text.slice(think + '</think>'.length)
  const frame = text.toLowerCase().indexOf('<tool_call')
  if (frame >= 0) text = text.slice(0, frame)
  text = text.trim()
  const rest = text.startsWith(opener) ? text.slice(opener.length).trim() : text
  if ([...rest].length < 8) return ''
  const lower = rest.toLowerCase()
  return PLANNING_MARKERS.some(marker => lower.includes(marker)) ? '' : text
}

/** Extracts text inside the last closed <think>...</think> block, stripping any stray tool frames. */
export function extractThinkInner(output: string): string {
  const close = output.lastIndexOf('</think>')
  if (close < 0) return ''
  const open = output.lastIndexOf('<think>', close)
  if (open < 0) return ''
  let inner = output.slice(open + '<think>'.length, close)
  const frame = inner.toLowerCase().indexOf('<tool_call')
  if (frame >= 0) inner = inner.slice(0, frame)
  return inner.trim()
}

/**
 * Stronger last-resort extraction for `fallbackSummary: false`: tries `salvageAnswerProse`
 * first, then any post-think non-frame prose across attempts, and finally the clearest
 * inner reasoning so deduced facts survive instead of "I looked up...".
 */
export function salvageLastResortAnswer(outputs: readonly string[], opener = ''): string {
  for (let index = outputs.length - 1; index >= 0; index--) {
    const salvaged = salvageAnswerProse(outputs[index]!, opener)
    if (salvaged !== '') return salvaged
  }
  for (let index = outputs.length - 1; index >= 0; index--) {
    let text = outputs[index]!
    const think = text.lastIndexOf('</think>')
    if (think >= 0) text = text.slice(think + '</think>'.length)
    const frame = text.toLowerCase().indexOf('<tool_call')
    if (frame >= 0) text = text.slice(0, frame)
    text = cleanFinalText(text.replace(/<\/?think>/g, ''))
    if ([...text].length >= 4) return text
  }
  for (let index = outputs.length - 1; index >= 0; index--) {
    const inner = cleanFinalText(extractThinkInner(outputs[index]!))
    if ([...inner].length >= 4) return inner
  }
  return ''
}

/** Harness-written last resort: what was looked up and how it went; it never claims a fact. */
export function answerFallbackSummary(task: string, results: readonly TurnResult[]): string {
  const zh = isChinese(task)
  const lines = results.map(result => {
    const outcome = result.ok ? (zh ? '成功' : 'succeeded') : (zh ? '失败' : 'failed')
    return `- ${result.name}: ${outcome}`
  })
  const gotContent = results.some(result => result.ok)
  if (zh) {
    const head = lines.length > 0 ? `这次我做了这些查询：\n${lines.join('\n')}\n\n` : ''
    return head + (gotContent
      ? '工具返回了一些内容，但这次没能整理成答案。可以让我再试一次。'
      : '没有找到能回答这个问题的内容。可以换个说法，或者告诉我具体要查的文件或网址。')
  }
  const head = lines.length > 0 ? `I looked up:\n${lines.join('\n')}\n\n` : ''
  return head + (gotContent
    ? 'The tools returned some content, but I could not turn it into an answer this time. You can ask me to try again.'
    : 'Nothing I found answers the question. You can rephrase it, or give me a specific URL or file to check.')
}

function oneLine(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Args)[key])]))
  }
  return value
}

export function callKey(name: string, args: Args): string {
  return `${name}\u0000${JSON.stringify(canonical(args))}`
}

/** Tools that change workspace files, under their trained and DSH names. */
const FILE_WRITERS = new Set(['edit_file', 'write_file', 'edit', 'edit_lines', 'write'])

/**
 * Shell commands that look like they change files or the environment: an
 * output redirect (not to /dev/null, not an fd duplication such as 2>&1), an
 * in-place sed, tee, file operations, git operations that touch the tree, and
 * package installs. A false positive only lets one more repeat through.
 */
const SHELL_WRITE = new RegExp([
  String.raw`(?<![<>&=-])\d?>>?(?![>&=])\s*(?!/dev/null\b)[^\s&|;)]`,
  String.raw`\bsed\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i`,
  String.raw`\b(?:tee|mv|cp|rm|rmdir|touch|mkdir|chmod|ln|patch|truncate|unzip|tar)\b`,
  String.raw`\bgit\s+(?:apply|checkout|restore|reset|commit|merge|rebase|stash|am|cherry-pick|add|rm|mv)\b`,
  String.raw`\b(?:pip3?|npm|pnpm|yarn|uv|cargo|go)\s+(?:install|add|get)\b`,
].join('|'))

/**
 * A call that may change what a later read or test run sees: an edit or write
 * of a file, or a shell command matching {@link SHELL_WRITE}.
 */
export function isMutatingCall(name: string, args: Args): boolean {
  if (FILE_WRITERS.has(name)) return true
  return name === 'bash' && typeof args.command === 'string' && SHELL_WRITE.test(args.command)
}

export interface TurnResult {
  readonly name: string
  readonly ok: boolean
}

export interface TurnState {
  /** The current turn's user request, for language choices. */
  readonly task: string
  /** Workspace tool calls DSH executed in the current turn (excludes worklist bookkeeping). */
  readonly steps: number
  /** Consecutive worklist calls (`todo_plan`/`todo_update`) since the last workspace call. */
  readonly consecutiveWorklistCalls: number
  readonly results: readonly TurnResult[]
  readonly successfulCalls: number
  /**
   * Successful calls since the latest successful mutating call (that call
   * included): rereading a file or rerunning a test after a change is not a
   * repeat, but repeating the change itself, or any call since, still is.
   */
  readonly successKeys: ReadonlySet<string>
  /** Failed call key → successful-call count when it failed (no success since = same epoch). */
  readonly failedEpochs: ReadonlyMap<string, number>
  /** Canonical key of the immediately preceding non-bookkeeping workspace call in this gate window. */
  readonly lastCallKey: string
  /** Whether that immediately preceding workspace call succeeded. */
  readonly lastCallOk: boolean
  readonly consecutiveFailedTool: string
  readonly consecutiveFailures: number
}

const BOOKKEEPING_TOOLS = new Set(['todo_plan', 'todo_update'])

export function currentTurnStart(history: readonly HistoryItem[]): number {
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.kind === 'user') return index
  }
  return 0
}

export interface TurnOptions {
  /**
   * First history item whose calls take part in the duplicate and failure
   * gates. The relay and worklist modes reset them at each cut/checkpoint:
   * earlier raw file reads were folded out, so re-reading a file slice after a
   * cut is not a repeated call. Workspace steps still count from the user
   * turn's start, so maxSteps is unchanged.
   */
  readonly duplicateFrom?: number
  /**
   * Tool-call IDs whose corresponding result was masked in-place in the active
   * window (`auto-fold v2`). Re-reading an in-place-masked file is allowed,
   * while unmasked short results keep duplicate-call protection.
   */
  readonly maskedCallIds?: ReadonlySet<string>
}

export function analyzeTurn(history: readonly HistoryItem[], options: TurnOptions = {}): TurnState {
  const start = currentTurnStart(history)
  const gateStart = Math.max(start, options.duplicateFrom ?? start)
  const first = history[start]
  const calls = new Map<string, { name: string; key: string; mutating: boolean }>()
  const successKeys = new Set<string>()
  const failedEpochs = new Map<string, number>()
  const results: TurnResult[] = []
  let workspaceSteps = 0
  let consecutiveWorklistCalls = 0
  let successfulCalls = 0
  let lastCallKey = ''
  let lastCallOk = false
  let consecutiveFailedTool = ''
  let consecutiveFailures = 0
  for (let index = start; index < history.length; index++) {
    const item = history[index]!
    if (item.kind === 'call') {
      calls.set(item.id, { name: item.name, key: callKey(item.name, item.args), mutating: isMutatingCall(item.name, item.args) })
    }
    if (item.kind !== 'result') continue
    const { name: calledName, key, mutating } = calls.get(item.id) ?? { name: item.name, key: callKey(item.name, {}), mutating: false }
    results.push({ name: item.name, ok: item.ok })
    if (BOOKKEEPING_TOOLS.has(calledName) || BOOKKEEPING_TOOLS.has(item.name)) {
      consecutiveWorklistCalls++
    } else {
      workspaceSteps++
      consecutiveWorklistCalls = 0
    }
    if (index < gateStart) continue
    if (item.ok) {
      if (mutating) successKeys.clear()
      const maskedInPlace = item.text.startsWith(FOLDED_OUTPUT_MARKER) || (options.maskedCallIds?.has(item.id) ?? false)
      if (!maskedInPlace) successKeys.add(key)
      if (!BOOKKEEPING_TOOLS.has(calledName) && !BOOKKEEPING_TOOLS.has(item.name)) {
        lastCallKey = maskedInPlace ? '' : key
        lastCallOk = true
      }
      failedEpochs.delete(key)
      successfulCalls++
      consecutiveFailedTool = ''
      consecutiveFailures = 0
    } else {
      failedEpochs.set(key, successfulCalls)
      if (!BOOKKEEPING_TOOLS.has(calledName) && !BOOKKEEPING_TOOLS.has(item.name)) {
        lastCallKey = key
        lastCallOk = false
      }
      if (item.name === consecutiveFailedTool) consecutiveFailures++
      else {
        consecutiveFailedTool = item.name
        consecutiveFailures = 1
      }
    }
  }
  return {
    task: first?.kind === 'user' ? first.text : '',
    steps: workspaceSteps,
    consecutiveWorklistCalls,
    results,
    successfulCalls,
    successKeys,
    failedEpochs,
    lastCallKey,
    lastCallOk,
    consecutiveFailedTool,
    consecutiveFailures,
  }
}

export const analyseHistory = analyzeTurn

export interface TranscriptOptions {
  readonly tools: readonly WireTool[]
  readonly postToolReminder: string
  /**
   * Add the per-step reminders after results of the current turn. Off for a
   * recap request: it is not a step, and the model that writes the card must
   * see the same bytes the teacher and the export rebuild.
   */
  readonly reminders?: boolean
  /**
   * Legacy: cut results longer than this when rendering. Live sessions are cut
   * once, when the tool runs (src/result-budget.ts), so the plugin leaves this
   * unset; only the pipeline sets it, to render data recorded before that.
   */
  readonly maxResultChars?: number
}

/**
 * Legacy prompt-time cut (head 80%, tail 20%, no saved copy), for rendering
 * data recorded before the execution-time budget (src/result-budget.ts).
 */
export function truncateResult(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || maxChars <= 0 || text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.8)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n…(${text.length - maxChars} characters omitted)…\n${text.slice(text.length - tail)}`
}

/**
 * Transcript entries for the history. Earlier turns keep their calls, results
 * and answers; the per-step reminders exist only in the current turn, as the
 * Go runner commits a turn without them.
 */
export function transcriptEntries(history: readonly HistoryItem[], options: TranscriptOptions): Entry[] {
  const start = currentTurnStart(history)
  const entries: Entry[] = []
  history.forEach((item, index) => {
    const current = index >= start
    switch (item.kind) {
      case 'user':
      case 'note':
        entries.push({ role: 'user', text: item.text })
        break
      case 'assistant':
        entries.push({ role: 'assistant', text: item.text, ...(item.reasoning ? { reasoning: item.reasoning } : {}) })
        break
      case 'call':
        entries.push({ role: 'assistant', text: recordToolCall(item.name, item.args), ...(item.reasoning ? { reasoning: item.reasoning } : {}) })
        break
      case 'result': {
        const body = truncateResult(item.text, options.maxResultChars)
        entries.push({ role: 'user', text: toolResponse(item.name, item.ok, body) })
        if (!current || options.reminders === false) break
        if (item.ok) {
          if (options.postToolReminder) entries.push({ role: 'user', text: options.postToolReminder })
        } else {
          entries.push({ role: 'user', text: toolFailureReminder(item.name, item.text, false, options.tools) })
        }
        break
      }
    }
  })
  return entries
}
