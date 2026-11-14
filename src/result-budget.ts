// Tool-result budget for RWKV sessions: the one place a long result is cut.
//
// RWKV reads a tool result once and cannot look back; past about 3000 tokens
// a long result (a web page, a log) hurts more than it helps. DSH already
// bounds results the same way for every model (spill-policy: head and tail
// inline, the full text saved to a file whose path ends the result), but at
// 12500 tokens. This hook does exactly that at RESULT_TOKEN_BUDGET, for
// sessions served by the given providers, before DSH's own pass (which then
// has nothing to do). So:
//   - every cut result names the file with the rest (the model can grep/read it);
//   - DSH records the result as the model saw it: no second cut when the
//     prompt is built, and training export reads the recorded text as is.
//
// read is not spilled (the file is on disk already): its window is shortened
// at a line boundary with read's own "Output capped ... Use offset=N" footer.
//
// Tokens are exact RWKV World tokens (src/tokenizer.ts, the vendored
// rwkv-tokenizer WASM). A result is measured as the <tool_response> the model
// reads, JSON escaping included; the prompt's "User: " label and whitespace
// cleanup are not counted (a few tokens, same as before). The budget is what
// it says: 3000 RWKV tokens, not 3000 of an estimate.
//
// No DSH runtime imports: the pipeline's teacher plugin mounts the same hook.

import { toolResponse } from './core/prompt.ts'
import { countTokens } from './tokenizer.ts'

/** RWKV tokens a tool result may take inline (as the model sees it, JSON-escaped). */
export const RESULT_TOKEN_BUDGET = 3000

/** `text` as the prompt will carry it: `<tool_response>` + JSON payload. */
export type Wrap = (body: string) => string

/** Exact RWKV tokens of one tool result as the model reads it. */
export function toolResultTokens(tool: string, body: string): number {
  return countTokens(toolResponse(tool, true, body))
}

const GAP = '\n\n[...]\n\n'

/**
 * Longest prefix (or suffix) of `text` whose wrapped token count stays within
 * `tokens`; whole code points. Token counts are not perfectly monotone in the
 * cut point (a cut can split a token), so this is a binary search that accepts
 * the largest tested prefix that fits.
 */
function fit(text: string, tokens: number, fromEnd: boolean, wrap: Wrap): string {
  const chars = Array.from(text)
  const piece = (count: number): string =>
    fromEnd ? chars.slice(chars.length - count).join('') : chars.slice(0, count).join('')
  let low = 0
  let high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (countTokens(wrap(piece(middle))) <= tokens) low = middle
    else high = middle - 1
  }
  return piece(low)
}

/** DSH spill-policy's notice (notice.ts formatSpillNotice), so DSH and its UI recognise it. */
export function spillNotice(omittedBytes: number, locator: string, retrievalHint: string): string {
  return `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${locator}. ${retrievalHint})`
}

/**
 * `text` bounded to `budget` the way DSH spill-policy does it: half the room
 * for the head, half for the tail, the notice for the saved full text last.
 * `notice(omittedBytes)` renders that notice; `wrap` renders the bytes the
 * model actually reads (default: the body as is).
 */
export function spillText(text: string, budget: number, notice: (omittedBytes: number) => string, wrap: Wrap = body => body): string {
  if (countTokens(wrap(text)) <= budget) return text
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const reserved = countTokens(wrap(`${GAP}\n\n${notice(totalBytes)}`))
  const room = Math.max(0, budget - reserved)
  const kept = fit(text, Math.ceil(room / 2), false, wrap)
  const rest = text.slice(kept.length)
  const end = fit(rest, Math.floor(room / 2), true, wrap)
  const omitted = Buffer.byteLength(rest.slice(0, rest.length - end.length), 'utf8')
  let bounded = kept.length + end.length === 0 ? notice(omitted) : `${kept}${GAP}${end}\n\n${notice(omitted)}`
  // Head and tail are fitted separately; the joined text can be a token or two
  // over. Drop whole lines from the tail until the real count fits.
  while (countTokens(wrap(bounded)) > budget && bounded.includes('\n')) {
    const at = bounded.lastIndexOf('\n')
    bounded = bounded.slice(0, at)
  }
  return bounded
}

const READ_LINE = /^(\d+): /
const READ_TOTAL = /^\n\n\((?:End of file - total (\d+) lines|Showing lines \d+-\d+ of (\d+)\.)/

/** The file and the line numbers a DSH read result shows (as the model gets it), if it is one. */
export function readWindow(text: string): { first: number; last: number } | undefined {
  const open = text.indexOf('<content>\n')
  const close = text.lastIndexOf('\n</content>')
  if (open < 0 || close < open) return undefined
  const body = text.slice(open + '<content>\n'.length, close)
  const footerAt = body.lastIndexOf('\n\n(')
  const lines = footerAt < 0 ? [] : body.slice(0, footerAt).split('\n')
  const first = READ_LINE.exec(lines[0] ?? '')?.[1]
  const last = READ_LINE.exec(lines.at(-1) ?? '')?.[1]
  // Every shown line starts "N: ", so the last "\n\n(" is the footer; none shown
  // (an empty file, an offset past the end) is the empty window 1-0.
  return first === undefined || last === undefined ? { first: 1, last: 0 } : { first: Number(first), last: Number(last) }
}

/**
 * Event carrying the lines a read showed the model, after this budget has cut
 * it: the line-edit plugin (src/line-edit.ts, a separate DSH plugin) keeps
 * which lines each session has seen and refuses edits outside them.
 */
export const READ_SHOWN_EVENT = 'rwkv/read-shown'

/**
 * A DSH read result (`<content>` with "N: text" lines and a footer) shortened
 * to fit `budget`, with read's own byte-cap footer; undefined when it already
 * fits or is not in that shape. At least one line is kept.
 */
export function capReadResult(text: string, budget: number, wrap: Wrap = body => body): string | undefined {
  if (countTokens(wrap(text)) <= budget) return undefined
  const open = text.indexOf('<content>\n')
  const close = text.lastIndexOf('\n</content>')
  if (open < 0 || close < open) return undefined
  const start = open + '<content>\n'.length
  const body = text.slice(start, close)
  const footerAt = body.lastIndexOf('\n\n(')
  if (footerAt < 0) return undefined
  const lines = body.slice(0, footerAt).split('\n')
  const first = READ_LINE.exec(lines[0] ?? '')
  if (!first) return undefined
  // DSH's own footer knows the file's length unless read itself hit its byte cap.
  const total = READ_TOTAL.exec(body.slice(footerAt))?.[1] ?? READ_TOTAL.exec(body.slice(footerAt))?.[2]
  const render = (count: number) => {
    const last = Number(READ_LINE.exec(lines[count - 1] ?? '')?.[1] ?? first[1])
    // With the total, DSH's line-limit wording; without it, its byte-cap wording.
    const footer = total === undefined
      ? `(Output capped. Showing lines ${first[1]}-${last}. Use offset=${last + 1} to continue.)`
      : `(Showing lines ${first[1]}-${last} of ${total}. Use offset=${last + 1} to continue.)`
    return `${text.slice(0, start)}${lines.slice(0, count).join('\n')}\n\n${footer}${text.slice(close)}`
  }
  let low = 1
  let high = lines.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (countTokens(wrap(render(middle))) <= budget) low = middle
    else high = middle - 1
  }
  return render(low)
}

// --- DSH wiring (structural types; see @deepseek-ai/dsh-tools, dsh-spill) ---

interface TextBlock { readonly type: string; readonly text?: string }
interface AgentLike {
  readonly session?: { readonly header?: { readonly id?: string }; requestHeader?(): { config?: { provider?: string } } | undefined }
  readonly options?: { readonly provider?: string }
}
interface ExecLike { readonly name: string; readonly callId: string; readonly parent?: unknown; readonly agent?: AgentLike }
interface Decision { readonly kind: string; readonly content?: readonly TextBlock[]; readonly [key: string]: unknown }
interface SpillStoreLike {
  saveText(request: {
    owner: { sessionId: string }
    source: { kind: 'tool'; toolName: string; callId: string; label: 'result' }
    suggestedName: string
    content: string
  }): Promise<{ locator: string; retrievalHint: string }>
}

export interface ResultBudgetOptions {
  /** Provider ids whose sessions get the budget (the RWKV plugin's routes, or the teacher's). */
  readonly providers: () => readonly string[]
  readonly budget?: number
  readonly log?: (message: string) => void
}

function providerOf(exec: ExecLike): string | undefined {
  return exec.agent?.session?.requestHeader?.()?.config?.provider ?? exec.agent?.options?.provider
}

/** Mounts the budget on `tools/post-execute` (inside DSH's spill-policy, which runs outermost). */
export function applyResultBudget(ctx: unknown, options: ResultBudgetOptions): void {
  const budget = options.budget ?? RESULT_TOKEN_BUDGET
  const context = ctx as {
    on(event: string, listener: (exec: ExecLike, result: { content: readonly TextBlock[] }, next: () => Promise<Decision>) => Promise<Decision>): unknown
    emit(event: string, ...args: unknown[]): void
    get(name: string): unknown
  }
  context.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || exec.parent !== undefined) return decision
    const provider = providerOf(exec)
    if (provider === undefined || !options.providers().includes(provider)) return decision
    const content = decision.content ?? result.content
    if (!content.every(block => block.type === 'text')) return decision
    const text = content.map(block => block.text ?? '').join('')
    // Successful-frame bytes: for a failed result the wire says "error" instead
    // of "result", a token or two either way.
    const wrap: Wrap = body => toolResponse(exec.name, true, body)
    if (exec.name === 'read') {
      const bounded = countTokens(wrap(text)) <= budget ? undefined : capReadResult(text, budget, wrap)
      const window = readWindow(bounded ?? text)
      if (window !== undefined) context.emit(READ_SHOWN_EVENT, exec, window)
      return bounded === undefined ? decision : { ...decision, kind: 'accept', content: [{ type: 'text', text: bounded }] }
    }
    if (countTokens(wrap(text)) <= budget) return decision
    let bounded: string | undefined
    {
      const store = context.get('spillStore') as SpillStoreLike | undefined
      const owner = exec.agent?.session?.header?.id
      if (store === undefined || owner === undefined) {
        options.log?.(`result budget: no spill store or session for ${exec.name}; keeping the inline content`)
        return decision
      }
      const ref = await store.saveText({
        owner: { sessionId: owner },
        source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
        suggestedName: `${exec.name}.txt`,
        content: text,
      })
      bounded = spillText(text, budget, bytes => spillNotice(bytes, ref.locator, ref.retrievalHint), wrap)
    }
    return bounded === undefined ? decision : { ...decision, kind: 'accept', content: [{ type: 'text', text: bounded }] }
  })
}
