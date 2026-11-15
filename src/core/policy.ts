// Harness feedback text and per-turn state, ported from RWKV-Agent
// internal/agent (runner_policy.go, runner_config.go, protocol_g1.go,
// runner_turn.go, runner_answer_fallback.go). DSH executes the tools and keeps
// the history, so the turn state is rebuilt from that history on every request.

import { recordToolCall, toolResponse, type Entry, type ThinkingMode } from './prompt.ts'
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

export const WEB_RESEARCH_MAX_STEPS = 6

export function isWebTool(name: string): boolean {
  return name === 'web_search' || name === 'web_fetch'
}

export function extractSearchQueries(args: Args): string[] {
  if (Array.isArray(args.queries)) {
    return args.queries.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  }
  if (typeof args.query === 'string' && args.query.trim() !== '') {
    return [args.query]
  }
  return []
}

export function normalizeSearchQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ').split(' ').filter(Boolean).sort().join(' ')
}

function normalizeFetchUrl(raw: string): string {
  const trimmed = raw.trim()
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ''
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    return parsed.toString()
  } catch {
    const base = trimmed.split('#')[0] ?? trimmed
    return base.length > 1 ? base.replace(/\/+$/, '') : base
  }
}

export function normalizedCallKey(name: string, args: Args): string {
  if (name === 'web_fetch') {
    if (typeof args.url === 'string') return callKey(name, { ...args, url: normalizeFetchUrl(args.url) })
    if (Array.isArray(args.urls)) {
      return callKey(name, {
        ...args,
        urls: args.urls.map(item => typeof item === 'string' ? normalizeFetchUrl(item) : item),
      })
    }
  }
  return callKey(name, args)
}

export function wrapUpReminder(state: TurnState, effectiveMaxSteps: number, thinking: ThinkingMode): string | undefined {
  const last = state.results[state.results.length - 1]
  if (last === undefined || !last.ok) return undefined
  const payloadRule = thinking === 'full' ? 'Do not repeat the Tool payload.' : 'Do not open a <think> block or repeat the Tool payload.'
  const remaining = effectiveMaxSteps - state.steps
  if (remaining <= 1) {
    return `Use the Tool results above to answer the user directly now.\nFinal tool step budget reached (${state.steps}/${effectiveMaxSteps}). Do not call another tool; write your final answer now from the evidence already collected.\n${payloadRule}`
  }
  const webHeavy = state.mutatingCalls === 0 && state.webCalls >= 3
  const stepHeavy = state.steps >= 4 && state.steps >= Math.ceil(effectiveMaxSteps * 0.5)
  if (webHeavy || stepHeavy) {
    return `Use the Tool results above to answer the current task now (${state.steps} tool calls already used).\nStop searching and synthesize a clear answer with what you already have, unless one single specific fact is strictly missing.\nNever repeat a successful tool call. ${payloadRule}`
  }
  return undefined
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
  /** Tool calls DSH executed in the current turn. */
  readonly steps: number
  readonly results: readonly TurnResult[]
  readonly successfulCalls: number
  readonly webCalls: number
  readonly mutatingCalls: number
  /**
   * Successful calls since the latest successful mutating call (that call
   * included): rereading a file or rerunning a test after a change is not a
   * repeat, but repeating the change itself, or any call since, still is.
   */
  readonly successKeys: ReadonlySet<string>
  /** Web calls executed anywhere in the current turn (never cleared by relay cuts or local edits). */
  readonly webKeys: ReadonlySet<string>
  /** Normalized individual web_search queries already run in the current turn. */
  readonly seenSearchQueries: ReadonlySet<string>
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

export interface TurnOptions {
  /**
   * First history item whose calls take part in the duplicate and failure
   * gates. The relay mode resets them at each leg: a card keeps only paths, so
   * re-reading a file after a cut is not a repeated call. Steps still count
   * from the user turn's start, so maxSteps is unchanged.
   */
  readonly duplicateFrom?: number
}

export function analyzeTurn(history: readonly HistoryItem[], options: TurnOptions = {}): TurnState {
  const start = currentTurnStart(history)
  const gateStart = Math.max(start, options.duplicateFrom ?? start)
  const first = history[start]
  const calls = new Map<string, { name: string; args: Args; key: string; mutating: boolean; web: boolean }>()
  const successKeys = new Set<string>()
  const webKeys = new Set<string>()
  const seenSearchQueries = new Set<string>()
  const failedEpochs = new Map<string, number>()
  const results: TurnResult[] = []
  let successfulCalls = 0
  let webCalls = 0
  let mutatingCalls = 0
  let consecutiveFailedTool = ''
  let consecutiveFailures = 0
  for (let index = start; index < history.length; index++) {
    const item = history[index]!
    if (item.kind === 'call') {
      const web = isWebTool(item.name)
      const key = web ? normalizedCallKey(item.name, item.args) : callKey(item.name, item.args)
      calls.set(item.id, { name: item.name, args: item.args, key, mutating: isMutatingCall(item.name, item.args), web })
    }
    if (item.kind !== 'result') continue
    const call = calls.get(item.id)
    const web = call?.web ?? isWebTool(item.name)
    const key = call?.key ?? callKey(item.name, {})
    const mutating = call?.mutating ?? false
    results.push({ name: item.name, ok: item.ok })
    if (web) webCalls++
    if (item.ok && mutating) mutatingCalls++
    if (web && item.ok) {
      webKeys.add(key)
      if (item.name === 'web_search' && call !== undefined) {
        for (const query of extractSearchQueries(call.args)) {
          seenSearchQueries.add(normalizeSearchQuery(query))
        }
      }
    }
    if (!web && index < gateStart) continue
    if (item.ok) {
      if (index >= gateStart) {
        if (mutating) successKeys.clear()
        successKeys.add(key)
        failedEpochs.delete(key)
        successfulCalls++
        consecutiveFailedTool = ''
        consecutiveFailures = 0
      } else if (web) {
        failedEpochs.delete(key)
      }
    } else {
      failedEpochs.set(key, successfulCalls)
      if (index >= gateStart) {
        if (item.name === consecutiveFailedTool) consecutiveFailures++
        else {
          consecutiveFailedTool = item.name
          consecutiveFailures = 1
        }
      }
    }
  }
  return {
    task: first?.kind === 'user' ? first.text : '',
    steps: results.length,
    results,
    successfulCalls,
    webCalls,
    mutatingCalls,
    successKeys,
    webKeys,
    seenSearchQueries,
    failedEpochs,
    consecutiveFailedTool,
    consecutiveFailures,
  }
}

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
        entries.push({ role: 'assistant', text: item.text })
        break
      case 'call':
        entries.push({ role: 'assistant', text: recordToolCall(item.name, item.args) })
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
