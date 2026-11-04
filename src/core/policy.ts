// Harness feedback text and per-turn state, ported from RWKV-Agent
// internal/agent (runner_policy.go, runner_config.go, protocol_g1.go,
// runner_turn.go, runner_answer_fallback.go). DSH executes the tools and keeps
// the history, so the turn state is rebuilt from that history on every request.

import { recordToolCall, toolResponse, type Entry } from './prompt.ts'
import type { ParseErrorKind } from './parse.ts'
import type { Args, WireTool } from './tools.ts'

export type HistoryItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'call'; readonly id: string; readonly name: string; readonly args: Args }
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

/** harness v26: the first repeat of a successful call gets one more decision with an edit hint. */
export function duplicateRetryReminder(tools: readonly WireTool[]): string {
  let prompt = 'That tool call was rejected because it repeats a successful call; its result is already above. Do not call it again.\n'
  const edits = ['edit', 'write'].flatMap(dsh => tools.filter(tool => tool.dshName === dsh).map(tool => tool.name))
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
  let prompt = `The tool call failed: ${oneLine(error)}. `
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

export interface TurnResult {
  readonly name: string
  readonly ok: boolean
}

export interface TurnState {
  /** The current turn's user request, for language choices. */
  readonly task: string
  /** Tool calls DSH executed in the current turn. */
  readonly steps: number
  readonly results: readonly TurnResult[]
  readonly successfulCalls: number
  readonly successKeys: ReadonlySet<string>
  /** Failed call key → successful-call count when it failed (no success since = same epoch). */
  readonly failedEpochs: ReadonlyMap<string, number>
  readonly consecutiveFailedTool: string
  readonly consecutiveFailures: number
}

export function currentTurnStart(history: readonly HistoryItem[]): number {
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.kind === 'user') return index
  }
  return 0
}

export function analyzeTurn(history: readonly HistoryItem[]): TurnState {
  const start = currentTurnStart(history)
  const first = history[start]
  const calls = new Map<string, string>()
  const successKeys = new Set<string>()
  const failedEpochs = new Map<string, number>()
  const results: TurnResult[] = []
  let successfulCalls = 0
  let consecutiveFailedTool = ''
  let consecutiveFailures = 0
  for (const item of history.slice(start)) {
    if (item.kind === 'call') calls.set(item.id, callKey(item.name, item.args))
    if (item.kind !== 'result') continue
    const key = calls.get(item.id) ?? callKey(item.name, {})
    results.push({ name: item.name, ok: item.ok })
    if (item.ok) {
      successKeys.add(key)
      failedEpochs.delete(key)
      successfulCalls++
      consecutiveFailedTool = ''
      consecutiveFailures = 0
    } else {
      failedEpochs.set(key, successfulCalls)
      if (item.name === consecutiveFailedTool) consecutiveFailures++
      else {
        consecutiveFailedTool = item.name
        consecutiveFailures = 1
      }
    }
  }
  return {
    task: first?.kind === 'user' ? first.text : '',
    steps: results.length,
    results,
    successfulCalls,
    successKeys,
    failedEpochs,
    consecutiveFailedTool,
    consecutiveFailures,
  }
}

export interface TranscriptOptions {
  readonly tools: readonly WireTool[]
  readonly postToolReminder: string
  readonly maxResultChars: number
}

/** Long tool output: keep the head and the tail; the middle is what RWKV loses first anyway. */
export function truncateResult(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
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
        entries.push({ role: 'assistant', text: item.text })
        break
      case 'call':
        entries.push({ role: 'assistant', text: recordToolCall(item.name, item.args) })
        break
      case 'result': {
        const body = truncateResult(item.text, options.maxResultChars)
        entries.push({ role: 'user', text: toolResponse(item.name, item.ok, body) })
        if (!current) break
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
