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
// No DSH runtime imports: the pipeline's teacher plugin mounts the same hook.

/** Estimated tokens (DSH's density: 4 characters per token) a tool result may take inline. */
export const RESULT_TOKEN_BUDGET = 3000

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const GAP = '\n\n[...]\n\n'

/** DSH's estimate for one text block (dsh-token-meter estimateContent). */
export function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** Longest prefix/suffix length whose block estimate fits `tokens`. */
function charsFor(tokens: number): number {
  return Math.max(0, (tokens - BLOCK_OVERHEAD) * CHARS_PER_TOKEN)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function head(text: string, length: number): string {
  const cut = Math.min(length, text.length)
  return text.slice(0, cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1)) ? cut - 1 : cut)
}

function tail(text: string, length: number): string {
  let cut = text.length - Math.min(length, text.length)
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut += 1
  return text.slice(cut)
}

/** DSH spill-policy's notice (notice.ts formatSpillNotice), so DSH and its UI recognise it. */
export function spillNotice(omittedBytes: number, locator: string, retrievalHint: string): string {
  return `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${locator}. ${retrievalHint})`
}

/**
 * `text` bounded to `budget` the way DSH spill-policy does it: half the room
 * for the head, half for the tail, the notice for the saved full text last.
 * `notice(omittedBytes)` renders that notice.
 */
export function spillText(text: string, budget: number, notice: (omittedBytes: number) => string): string {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const reserved = textTokens(GAP) + textTokens(`\n\n${notice(totalBytes)}`)
  const room = Math.max(0, budget - reserved)
  const kept = head(text, charsFor(Math.ceil(room / 2)))
  const rest = text.slice(kept.length)
  const end = tail(rest, charsFor(Math.floor(room / 2)))
  const omitted = Buffer.byteLength(rest.slice(0, rest.length - end.length), 'utf8')
  return kept.length + end.length === 0 ? notice(omitted) : `${kept}${GAP}${end}\n\n${notice(omitted)}`
}

const READ_LINE = /^(\d+): /

/**
 * A DSH read result (`<content>` with "N: text" lines and a footer) shortened
 * to fit `budget`, with read's own byte-cap footer; undefined when it already
 * fits or is not in that shape. At least one line is kept.
 */
export function capReadResult(text: string, budget: number): string | undefined {
  if (textTokens(text) <= budget) return undefined
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
  const render = (count: number) => {
    const last = Number(READ_LINE.exec(lines[count - 1] ?? '')?.[1] ?? first[1])
    const footer = `(Output capped. Showing lines ${first[1]}-${last}. Use offset=${last + 1} to continue.)`
    return `${text.slice(0, start)}${lines.slice(0, count).join('\n')}\n\n${footer}${text.slice(close)}`
  }
  let low = 1
  let high = lines.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textTokens(render(middle)) <= budget) low = middle
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
    get(name: string): unknown
  }
  context.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || exec.parent !== undefined) return decision
    const provider = providerOf(exec)
    if (provider === undefined || !options.providers().includes(provider)) return decision
    const content = decision.content ?? result.content
    if (!content.every(block => block.type === 'text')) return decision
    const total = content.reduce((sum, block) => sum + textTokens(block.text ?? ''), 0)
    if (total <= budget) return decision
    const text = content.map(block => block.text ?? '').join('')
    let bounded: string | undefined
    if (exec.name === 'read') {
      bounded = capReadResult(text, budget)
    } else {
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
      bounded = spillText(text, budget, bytes => spillNotice(bytes, ref.locator, ref.retrievalHint))
    }
    return bounded === undefined ? decision : { ...decision, kind: 'accept', content: [{ type: 'text', text: bounded }] }
  })
}
