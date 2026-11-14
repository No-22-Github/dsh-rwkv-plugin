// One DSH model request = one RWKV agent step. DSH owns the outer loop (it
// executes the tool and calls again), so this decides one action from the
// history, running the RWKV-Agent harness inside the request: protocol
// re-asks, duplicate and failure gates, the forced closeout, and the answer
// stage fallbacks (runner_turn.go, runner_tool_step.go, think_stop.go).

import type { GenerateRequest, GenerateResult, Generator, Sampling } from '../backend/generator.ts'
import {
  cleanFinalText,
  endsWithCompleteCall,
  parseAction,
  thinkOpen,
  type Action,
} from './parse.ts'
import {
  analyzeTurn,
  ANSWER_STAGE_REASK,
  answerFallbackSummary,
  answerOpener,
  callKey,
  correction,
  DUPLICATE_ANSWER_REMINDER,
  DUPLICATE_FAILED_REMINDER,
  duplicateRetryReminder,
  EMPTY_EXIT_REASK,
  oneStageAnswerInstruction,
  POST_TOOL_REMINDER,
  POST_TOOL_REMINDER_THINK,
  salvageAnswerProse,
  toolFailureReminder,
  transcriptEntries,
  type HistoryItem,
  type TurnState,
} from './policy.ts'
import { reconstructOutput, recordToolCall, renderPrompt, systemPrompt, toolResponse, type Entry, type ThinkingMode } from './prompt.ts'
import { countTokens } from '../tokenizer.ts'
import {
  cleanCardText,
  fallbackCard,
  makeCard,
  planRelay,
  recapEntries,
  relayEntries,
  type RelayCard,
  type RelayNeed,
  type RelayOptions,
} from './relay.ts'
import { coerceArguments, normalizeArguments, repairNativeValues, resolveTool, type Args, type WireTool } from './tools.ts'

/** Pass-through answer for output the harness does not fix (guards off). */
function rawFinal(output: string): Decision {
  return { type: 'final', text: cleanFinalText(output) || output.trim(), via: 'raw' }
}

export const DECISION_STOPS = ['</tool_call>', '\nUser:', '\nSystem:', '\nTool:'] as const

export interface HarnessConfig {
  readonly thinking: ThinkingMode
  readonly historyEmptyThink: boolean
  /** Tool calls DSH may execute in one user turn before the forced closeout. */
  readonly maxSteps: number
  /** Consecutive failures of one tool before a further call of it is blocked. */
  readonly maxConsecutiveFailures: number
  /** Re-asks after unparseable output within one request. */
  readonly protocolRetries: number
  readonly decisionMaxTokens: number
  readonly answerMaxTokens: number
  readonly sampling: Sampling
  readonly taskContract?: string
  /** Appended as the system prompt's last line (currentDateLine); absent: no date. */
  readonly dateLine?: string
  /**
   * Fixes applied to the model's output: parser near-miss repairs, tool name
   * and argument aliases, scalar coercion, DSH value repairs, path repair.
   * Off: only the exact protocol form parses, the tool name must match the
   * catalog, and arguments reach DSH as written (DSH reports what is wrong).
   */
  readonly outputRepairs: boolean
  /**
   * Harness interventions: format re-asks, the duplicate and failure gates,
   * closing an over-budget think, answer-stage re-asks and the salvage /
   * summary fallbacks. Off: the model's output stands; output that does not
   * parse becomes the answer text as written. maxSteps and the unknown-tool
   * result stay (a budget and the environment's answer, not a fix).
   */
  readonly guards: boolean
  /**
   * Turn-relay context: finished legs are replaced by model-written handoff
   * cards. Absent (the default): the full history is rendered as before.
   */
  readonly relay?: RelayOptions
}

export const DEFAULT_HARNESS: HarnessConfig = {
  thinking: 'full',
  historyEmptyThink: true,
  maxSteps: 15,
  maxConsecutiveFailures: 2,
  protocolRetries: 2,
  decisionMaxTokens: 4096,
  answerMaxTokens: 4096,
  outputRepairs: true,
  guards: true,
  sampling: {
    temperature: 0.3,
    topK: 65536,
    topP: 0.5,
    presencePenalty: 0.5,
    frequencyPenalty: 0.1,
    penaltyDecay: 0.996,
  },
}

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

export interface GenerationTrace {
  readonly stage: 'decision' | 'answer' | 'card'
  readonly prompt: string
  readonly output: string
  readonly finish: string
  readonly stop?: string
  readonly action: string
  /** What the harness did with this output: run, final, re-ask, duplicate-retry, closeout, rejected, ... */
  readonly outcome: string
  /** Every repair the output needed before it ran (parser + tool gate); empty for a clean output. */
  readonly repairs: readonly string[]
  /**
   * Card stage only: the history range this card replaces. The ledger shows it
   * as the point where the leg was cut, so a reader can see what the model
   * stopped being able to re-read.
   */
  readonly relay?: RelayTrace
}

/** What the relay cut before this step: covered history range and its user turn. */
export interface RelayTrace {
  /** First history item the card covers. */
  readonly from: number
  /** One past the last covered item. */
  readonly to: number
  /** 1-based user turn of the covered items. */
  readonly turn: number
  /** True when the fallback card was used instead of the model's recap. */
  readonly fallback: boolean
  /** The card text the model will see from now on. */
  readonly card: string
}

export interface StepHooks {
  /** Live reasoning text of the current generation. */
  reasoning?(delta: string): void
  /** A new generation starts; label says why (first try, re-ask, ...). */
  attempt?(label: string): void
  trace?(trace: GenerationTrace): void
}

export interface StepInput {
  readonly history: readonly HistoryItem[]
  readonly tools: readonly WireTool[]
  readonly config: HarnessConfig
  readonly generator: Generator
  readonly signal?: AbortSignal
  readonly sessionId?: string
  readonly hooks?: StepHooks
  /** Head of the system block in place of the trained opener (DSH's filtered system prompt). */
  readonly systemHead?: string
  /** Relay mode: cards of earlier legs, and where a new one is kept. */
  readonly relay?: {
    readonly cards: readonly RelayCard[]
    readonly save?: (card: RelayCard) => void
  }
}

export interface StepResult {
  readonly decision: Decision
  readonly promptTokens: number
  readonly completionTokens: number
  readonly generations: number
}

/** Streams the reasoning of a withheld "<think" generation: drops the closing ">", stops at </think>. */
class ThinkSplitter {
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

const MAX_THINK_STOP_RESUMES = 4
/** Extra tokens after force-closing a think that ran out of budget. */
const THINK_CLOSE_TOKENS = 1024

function describe(action: Action): string {
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

export async function decideStep(input: StepInput): Promise<StepResult> {
  const { config, tools, hooks } = input
  const reminder = config.thinking === 'full' ? POST_TOOL_REMINDER_THINK : POST_TOOL_REMINDER
  const system = systemPrompt(tools, config.thinking, config.taskContract, input.systemHead, config.dateLine)
  let promptTokens = 0
  let completionTokens = 0
  let generations = 0

  const generate = async (
    entries: readonly Entry[],
    stage: 'decision' | 'answer' | 'card',
    label: string,
    prefill?: string,
  ): Promise<{ output: string; result: GenerateResult; prompt: string }> => {
    const prompt = renderPrompt(entries, {
      thinking: config.thinking,
      historyEmptyThink: config.historyEmptyThink,
      ...prefill === undefined ? {} : { prefill },
    })
    hooks?.attempt?.(label)
    const splitter = config.thinking === 'full' && hooks?.reasoning ? new ThinkSplitter(hooks.reasoning) : undefined
    const request: GenerateRequest = {
      prompt,
      maxTokens: stage === 'answer' ? config.answerMaxTokens
        : stage === 'card' ? config.relay?.cardMaxTokens ?? 768
        : config.decisionMaxTokens,
      stops: [...DECISION_STOPS],
      sampling: config.sampling,
      ...input.signal ? { signal: input.signal } : {},
      ...input.sessionId ? { sessionId: input.sessionId } : {},
    }
    const onDelta = splitter ? (text: string) => splitter.feed(text) : undefined
    let result = await input.generator.generate(request, onDelta)
    generations++
    let text = result.text
    let spent = result.completionTokens ?? countTokens(text)
    promptTokens += result.promptTokens ?? countTokens(prompt)
    // A quoted </tool_call> inside an open think block is not the end of the
    // step: put the stop back and continue the same generation.
    const opening = config.thinking === 'full' ? '<think' : ''
    for (let resume = 0; resume < MAX_THINK_STOP_RESUMES; resume++) {
      if (result.finish !== 'stop' || result.stop !== '</tool_call>' || !thinkOpen(opening + text) || endsWithCompleteCall(text)) break
      text += '</tool_call>'
      onDelta?.('</tool_call>')
      const remaining = request.maxTokens - spent
      if (remaining <= 0) {
        result = { ...result, finish: 'length' }
        break
      }
      const next = await input.generator.generate({ ...request, prompt: prompt + text, maxTokens: remaining }, onDelta)
      generations++
      text += next.text
      spent += next.completionTokens ?? countTokens(next.text)
      result = { ...next, text }
    }
    // The think used the whole budget (G1 loops re-checking the same facts):
    // close it where it stopped and let the model state its action, instead
    // of a re-ask that regenerates the same overlong think from scratch.
    if (config.guards && result.finish === 'length' && opening !== '' && thinkOpen(opening + text)) {
      const closed = `${text.trimEnd()}\n</think>\n`
      onDelta?.('\n</think>\n')
      const next = await input.generator.generate({ ...request, prompt: prompt + closed, maxTokens: THINK_CLOSE_TOKENS }, onDelta)
      generations++
      text = closed + next.text
      spent += next.completionTokens ?? countTokens(next.text)
      result = { ...next, text }
    }
    completionTokens += spent
    return { output: reconstructOutput(text, config.thinking), result: { ...result, text }, prompt }
  }

  const traced = (
    stage: 'decision' | 'answer' | 'card', prompt: string, output: string, result: GenerateResult, action: Action,
    outcome: string, gateRepairs: readonly string[] = [], relay?: RelayTrace,
  ) => {
    const parsed = action.type === 'tool' || action.type === 'exit' ? action.repairs : []
    hooks?.trace?.({
      stage, prompt, output, finish: result.finish, action: describe(action), outcome,
      repairs: [...parsed, ...gateRepairs],
      ...result.stop === undefined ? {} : { stop: result.stop },
      ...relay === undefined ? {} : { relay },
    })
  }
  const parseOptions = { strict: !config.outputRepairs }

  const done = (decision: Decision): StepResult => ({ decision, promptTokens, completionTokens, generations })

  /**
   * Ask the model for a handoff card. A recap that fails or writes protocol
   * garbage falls back to the deterministic card: the step still runs.
   */
  const writeCard = async (need: RelayNeed, cards: readonly RelayCard[]): Promise<RelayCard> => {
    let text = ''
    let pending: { output: string; result: GenerateResult; prompt: string } | undefined
    try {
      const entries: Entry[] = [
        { role: 'system', text: system },
        ...recapEntries(input.history, cards, need, { tools, postToolReminder: '' }),
      ]
      const { output, result, prompt } = await generate(entries, 'card', 'handoff recap')
      text = cleanCardText(output)
      pending = { output, result, prompt }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      // Network or protocol failure: keep going with the fallback card.
    }
    const budget = Math.min(500, config.relay?.cardMaxTokens ?? 768)
    const card = makeCard(input.history, need, text !== '' ? text : fallbackCard(input.history, need, budget))
    // The ledger records the cut itself, not just the generation: the card text
    // and covered range are what the next prompt was actually built from, and
    // the step prompt alone cannot show either.
    const relay: RelayTrace = { from: need.start, to: need.end, turn: need.turn, fallback: text === '', card: card.text }
    if (pending !== undefined) {
      traced('card', pending.prompt, pending.output, pending.result, { type: 'final', text }, text === '' ? 'card-empty' : 'card', [], relay)
    } else if (hooks?.trace !== undefined) {
      // No generation to show (network or protocol failure): still mark the cut.
      hooks.trace({
        stage: 'card', prompt: '', output: '', finish: 'error', action: 'card', outcome: 'card-failed', repairs: [], relay,
      })
    }
    input.relay?.save?.(card)
    return card
  }

  // Turn-relay: card the finished legs before deciding this step. The most
  // recent call/result pair always stays verbatim, so the model keeps the
  // observation it is about to act on.
  let state = analyzeTurn(input.history)
  let base: Entry[]
  if (config.relay === undefined) {
    base = [
      { role: 'system', text: system },
      ...transcriptEntries(input.history, { tools, postToolReminder: reminder }),
    ]
  } else {
    const plan = planRelay(input.history, input.relay?.cards ?? [], config.relay)
    let cards = plan.cards
    if (plan.need !== undefined) cards = [...cards, await writeCard(plan.need, cards)]
    const legStart = cards.length > 0 ? cards[cards.length - 1]!.at : 0
    state = analyzeTurn(input.history, { duplicateFrom: legStart })
    base = [
      { role: 'system', text: system },
      ...relayEntries(input.history, cards, { tools, postToolReminder: reminder }),
    ]
  }

  /**
   * The forced closeout: tools withdrawn, plain-text answer from the evidence
   * so far. allowTools: the closeout came from unparseable output, not from a
   * policy (step limit, repeated call), so a valid tool call the model still
   * makes is run instead of being thrown away.
   */
  const answerStage = async (entries: readonly Entry[], prelude: readonly string[], allowTools = false): Promise<StepResult> => {
    const staged: Entry[] = [
      ...entries,
      ...prelude.map(text => ({ role: 'user' as const, text })),
      { role: 'user', text: oneStageAnswerInstruction() },
    ]
    let lastOutput = ''
    let opener: string | undefined
    for (let attempt = 0; attempt < (config.guards ? 3 : 1); attempt++) {
      if (attempt === 2) {
        // The re-ask did not help: prefill a prose opening so the model
        // continues a sentence instead of opening another call. The thinking
        // wire withholds "<think" after "Assistant:", so it cannot take one.
        if (config.thinking === 'full') break
        opener = answerOpener(state.task)
      }
      const { output, result, prompt } = await generate(staged, 'answer', attempt === 0 ? 'answer' : 'answer re-ask', opener)
      const action = parseAction(opener ? `${opener}${output}` : output, result.finish, parseOptions)
      lastOutput = opener ? `${opener}${output}` : output
      if (allowTools && action.type === 'tool' && state.steps < config.maxSteps) {
        const gated = gateToolCall(action, state, tools, config, true)
        if (gated.type === 'run') {
          traced('answer', prompt, output, result, action, 'run', gated.repairs)
          return done({ type: 'tool', tool: gated.tool, args: gated.args, rawArgs: action.args, repairs: [...action.repairs, ...gated.repairs, 'answer_stage_tool'] })
        }
      }
      if (action.type === 'final' && !action.text.toLowerCase().includes('<tool_call')) {
        const text = cleanFinalText(action.text)
        if (text !== '') {
          traced('answer', prompt, output, result, action, 'final')
          return done({ type: 'final', text, via: 'answer-stage' })
        }
      }
      if (action.type === 'exit' && action.answer !== '') {
        traced('answer', prompt, output, result, action, 'final')
        return done({ type: 'final', text: action.answer, via: 'answer-stage' })
      }
      traced('answer', prompt, output, result, action, config.guards ? 're-ask' : 'raw')
      if (attempt === 0) staged.push({ role: 'user', text: ANSWER_STAGE_REASK })
    }
    if (!config.guards) return done(rawFinal(lastOutput))
    const salvaged = salvageAnswerProse(lastOutput, opener)
    if (salvaged !== '') return done({ type: 'final', text: cleanFinalText(salvaged), via: 'salvage' })
    return done({ type: 'final', text: answerFallbackSummary(state.task, state.results), via: 'summary' })
  }

  if (state.steps >= config.maxSteps) return answerStage(base, [])

  const extra: Entry[] = []
  let protocolRetries = 0
  let duplicateRetryUsed = false
  let blockedRetries = 0
  for (let attempt = 0; attempt < config.protocolRetries + 4; attempt++) {
    const label = attempt === 0 ? 'decide' : 're-ask'
    const { output, result, prompt } = await generate([...base, ...extra], 'decision', label)
    if (result.finish === 'cancelled') throw new DOMException('aborted', 'AbortError')
    const action = parseAction(output, result.finish, parseOptions)
    const note = (outcome: string, gateRepairs?: readonly string[]) => traced('decision', prompt, output, result, action, outcome, gateRepairs)
    switch (action.type) {
      case 'final': {
        const text = cleanFinalText(action.text)
        if (text !== '') {
          note('final')
          return done({ type: 'final', text, via: 'model' })
        }
        break
      }
      case 'exit':
        if (action.answer !== '') {
          note('final')
          return done({ type: 'final', text: action.answer, via: 'exit' })
        }
        note(config.guards ? 'empty-exit' : 'raw')
        if (!config.guards) return done(rawFinal(output))
        return answerStage([...base, ...extra], [EMPTY_EXIT_REASK], true)
      case 'tool': {
        const gated = gateToolCall(action, state, tools, config, duplicateRetryUsed)
        if (gated.type === 'run') {
          note('run', gated.repairs)
          return done({ type: 'tool', tool: gated.tool, args: gated.args, rawArgs: action.args, repairs: [...action.repairs, ...gated.repairs] })
        }
        note(gated.type === 'rejected' ? `rejected ${gated.reason}` : gated.type)
        if (gated.type === 'closeout') return answerStage([...base, ...extra], [gated.reminder])
        if (gated.type === 'duplicate-retry') duplicateRetryUsed = true
        // Rejected without execution. The rejected call is echoed only for
        // unknown/blocked tools, which get a failed tool result like the Go
        // runner records; a repeated call is never echoed (RWKV copies it).
        extra.push(...gated.receipt)
        if (++blockedRetries > 3) return config.guards ? answerStage([...base, ...extra], []) : done(rawFinal(output))
        continue
      }
      case 'error':
        break
    }
    note(config.guards ? 're-ask' : 'raw')
    if (!config.guards) return done(rawFinal(output))
    // Unparseable or empty output: one correction per retry, no echo of a
    // truncated think (it would be re-read and continued).
    if (++protocolRetries > config.protocolRetries) {
      return state.steps > 0 ? answerStage([...base, ...extra], [], true) : done({
        type: 'final',
        text: answerFallbackSummary(state.task, state.results),
        via: 'summary',
      })
    }
    const kind = action.type === 'error' ? action.kind : 'empty'
    extra.push({ role: 'user', text: correction(kind) })
  }
  return answerStage([...base, ...extra], [], true)
}

type Gate =
  | { readonly type: 'run'; readonly tool: WireTool; readonly args: Args; readonly repairs: readonly string[] }
  | { readonly type: 'closeout'; readonly reminder: string }
  | { readonly type: 'duplicate-retry'; readonly receipt: Entry[] }
  | { readonly type: 'rejected'; readonly reason: 'unknown-tool' | 'blocked'; readonly receipt: Entry[] }

function gateToolCall(
  action: Extract<Action, { type: 'tool' }>,
  state: TurnState,
  tools: readonly WireTool[],
  config: HarnessConfig,
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
  const key = callKey(tool.name, args)
  if (state.successKeys.has(key)) {
    // harness v26: the first repeat of a successful call gets one more decision.
    if (!duplicateRetryUsed) {
      return { type: 'duplicate-retry', receipt: [{ role: 'user', text: duplicateRetryReminder(tools) }] }
    }
    return { type: 'closeout', reminder: DUPLICATE_ANSWER_REMINDER }
  }
  if (state.failedEpochs.get(key) === state.successfulCalls) {
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
  return { type: 'run', tool, args, repairs }
}

/** Argument aliases, scalar coercion and the DSH value repairs, with the names of those that applied. */
function repairArguments(tool: WireTool, raw: Args, aliased: boolean): { args: Args; repairs: string[] } {
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
