// One DSH model request = one RWKV agent step. DSH owns the outer loop (it
// executes the tool and calls again), so this decides one action from the
// history, running the RWKV-Agent harness inside the request: protocol
// re-asks, duplicate and failure gates, the forced closeout, and the answer
// stage fallbacks (runner_turn.go, runner_tool_step.go, think_stop.go).

import type { GenerateRequest, GenerateResult, Generator, Sampling } from '../backend/generator.ts'
import { countTokens } from '../tokenizer.ts'
import {
  AGENT_FAST_SAMPLING,
  DEFAULT_ANSWER_MAX_TOKENS,
  DEFAULT_DECISION_MAX_TOKENS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_STEPS,
  DEFAULT_PROTOCOL_RETRIES,
  DEFAULT_RELAY_CARD_MAX_TOKENS,
} from './defaults.ts'
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
  correction,
  EMPTY_EXIT_REASK,
  extractThinkInner,
  hasPlanningMarker,
  isChinese,
  oneStageAnswerInstruction,
  POST_TOOL_REMINDER,
  POST_TOOL_REMINDER_THINK,
  salvageAnswerProse,
  salvageLastResortAnswer,
  transcriptEntries,
  type HistoryItem,
} from './policy.ts'
import { reconstructOutput, renderPrompt, systemPrompt, type Entry, type ThinkingMode } from './prompt.ts'
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
import {
  describeAction,
  gateToolCall,
  rawFinal,
  ThinkSplitter,
  type Decision,
  type DuplicateGateMode,
  type FinalVia,
} from './step-gates.ts'
import type { WireTool } from './tools.ts'
import { worklistEntries, type ContextFoldEvent, type WorklistOptions } from './worklist.ts'

export type { ContextFoldEvent, Decision, FinalVia }

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
   */
  readonly outputRepairs: boolean
  /**
   * Harness interventions: format re-asks, the duplicate and failure gates,
   * closing an over-budget think, answer-stage re-asks and the salvage /
   * summary fallbacks.
   */
  readonly guards: boolean
  /** Duplicate gate mode when `guards` is true: 'epoch' (default), 'bounded', 'adjacent', or 'off'. */
  readonly duplicateGateMode?: DuplicateGateMode
  /** Attempt-2 answer prefill mode: 'default', 'zh-only' (avoids English opener collision), or 'none'. */
  readonly answerOpenerMode?: 'default' | 'zh-only' | 'none'
  /** Whether answer-stage failure replaces empty outputs with "I looked up..." summary (default true). */
  readonly fallbackSummary?: boolean
  /** Turn-relay context: finished legs are replaced by model-written handoff cards. */
  readonly relay?: RelayOptions
  /** Stateful work list or passive auto-fold context. */
  readonly worklist?: WorklistOptions
}

export const DEFAULT_HARNESS: HarnessConfig = {
  thinking: 'full',
  historyEmptyThink: true,
  maxSteps: DEFAULT_MAX_STEPS,
  maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
  protocolRetries: DEFAULT_PROTOCOL_RETRIES,
  decisionMaxTokens: DEFAULT_DECISION_MAX_TOKENS,
  answerMaxTokens: DEFAULT_ANSWER_MAX_TOKENS,
  outputRepairs: true,
  guards: true,
  sampling: AGENT_FAST_SAMPLING,
}

export interface GenerationTrace {
  readonly stage: 'decision' | 'answer' | 'card'
  readonly prompt: string
  readonly promptTokens?: number
  readonly output: string
  readonly finish: string
  readonly stop?: string
  readonly action: string
  readonly outcome: string
  readonly repairs: readonly string[]
  readonly relay?: RelayTrace
  readonly worklist?: WorklistTrace
  readonly fold?: ContextFoldEvent
}

export interface WorklistTrace {
  readonly promptTokens: number
  readonly budgetTokens: number
  readonly checkpointAt?: number
  readonly nudged: boolean
}

export interface RelayTrace {
  readonly from: number
  readonly to: number
  readonly turn: number
  readonly fallback: boolean
  readonly card: string
}

export interface StepHooks {
  reasoning?(delta: string): void
  text?(delta: string): void
  attempt?(label: string): void
  trace?(trace: GenerationTrace): void
  wireStart?(info: {
    readonly stage: 'decision' | 'answer' | 'card'
    readonly prompt: string
    readonly fullPrompt?: string
    readonly promptTokens: number
    readonly pastThinks?: readonly string[]
    readonly fold?: ContextFoldEvent
  }): void
  wireDelta?(delta: string): void
  wireEnd?(info: { readonly output: string; readonly outputTokens: number }): void
}

export interface StepInput {
  readonly history: readonly HistoryItem[]
  readonly tools: readonly WireTool[]
  readonly config: HarnessConfig
  readonly generator: Generator
  readonly signal?: AbortSignal
  readonly sessionId?: string
  readonly cwd?: string
  readonly hooks?: StepHooks
  readonly systemHead?: string
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
  readonly foldedUnread?: readonly string[]
  readonly foldEvent?: ContextFoldEvent
}

const MAX_THINK_STOP_RESUMES = 4
const THINK_CLOSE_TOKENS = 1024
const CARD_FINISH_TOKENS = 384

export async function decideStep(input: StepInput): Promise<StepResult> {
  const { config, tools, hooks } = input
  const reminder = config.thinking === 'full' ? POST_TOOL_REMINDER_THINK : POST_TOOL_REMINDER
  const worklistGuidance = config.worklist?.passive === true ? false : config.worklist?.systemGuidance
  const system = systemPrompt(
    tools,
    config.thinking,
    config.taskContract,
    input.systemHead,
    config.dateLine,
    worklistGuidance === undefined ? undefined : { worklistGuidance },
  )
  let promptTokens = 0
  let completionTokens = 0
  let generations = 0

  let worklistTrace: WorklistTrace | undefined
  let stepFoldEvent: ContextFoldEvent | undefined
  let foldTraced = false

  const generate = async (
    entries: readonly Entry[],
    stage: 'decision' | 'answer' | 'card',
    label: string,
    prefill?: string,
    options?: { readonly rawAssistantPrefix?: string; readonly extraStops?: readonly string[] },
  ): Promise<{ output: string; result: GenerateResult; prompt: string; promptTokens: number }> => {
    const rawPrefix = options?.rawAssistantPrefix
    const prompt = renderPrompt(entries, {
      thinking: config.thinking,
      historyEmptyThink: config.historyEmptyThink,
      ...prefill === undefined ? {} : { prefill },
      ...rawPrefix === undefined ? {} : { rawAssistantPrefix: rawPrefix },
    })
    hooks?.attempt?.(label)
    if (hooks?.wireStart !== undefined) {
      const pastThinks = config.thinking === 'full' && config.historyEmptyThink
        ? entries.filter(entry => entry.role === 'assistant').map(entry => entry.reasoning ?? '')
        : undefined
      const fullEntries: Entry[] = [
        { role: 'system', text: system },
        ...transcriptEntries(input.history, { tools, postToolReminder: reminder }),
      ]
      const fullPrompt = renderPrompt(fullEntries, {
        thinking: config.thinking,
        historyEmptyThink: false,
        ...prefill === undefined ? {} : { prefill },
        ...rawPrefix === undefined ? {} : { rawAssistantPrefix: rawPrefix },
      })
      hooks.wireStart({
        stage,
        prompt,
        fullPrompt,
        promptTokens: countTokens(prompt),
        ...(pastThinks !== undefined && pastThinks.some(t => t !== '') ? { pastThinks } : {}),
        ...(stage !== 'card' && stepFoldEvent !== undefined ? { fold: stepFoldEvent } : {}),
      })
    }
    const hasOpenThink = config.thinking === 'full' && prefill === undefined && rawPrefix === undefined
    const streamText = stage !== 'card' && prefill === undefined ? hooks?.text : undefined
    const splitter = hasOpenThink && (hooks?.reasoning || streamText)
      ? new ThinkSplitter(hooks?.reasoning, streamText, false)
      : !hasOpenThink && streamText
        ? new ThinkSplitter(undefined, streamText, true)
        : undefined
    const stops = options?.extraStops ? [...DECISION_STOPS, ...options.extraStops] : [...DECISION_STOPS]
    const request: GenerateRequest = {
      prompt,
      maxTokens: stage === 'answer' ? config.answerMaxTokens
        : stage === 'card' ? config.relay?.cardMaxTokens ?? DEFAULT_RELAY_CARD_MAX_TOKENS
        : config.decisionMaxTokens,
      stops,
      sampling: config.sampling,
      ...input.signal ? { signal: input.signal } : {},
      ...input.sessionId ? { sessionId: input.sessionId } : {},
    }
    const onDelta = splitter || hooks?.wireDelta
      ? (text: string) => {
        splitter?.feed(text)
        hooks?.wireDelta?.(text)
      }
      : undefined
    let result = await input.generator.generate(request, onDelta)
    generations++
    let text = result.text
    let spent = result.completionTokens ?? countTokens(text)
    const stepPromptTokens = result.promptTokens ?? countTokens(prompt)
    promptTokens += stepPromptTokens

    const opening = hasOpenThink ? '<think' : ''
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

    if (config.guards && result.finish === 'length' && opening !== '' && thinkOpen(opening + text)) {
      const closed = `${text.trimEnd()}\n</think>\n`
      onDelta?.('\n</think>\n')
      const next = await input.generator.generate({ ...request, prompt: prompt + closed, maxTokens: THINK_CLOSE_TOKENS }, onDelta)
      generations++
      text = closed + next.text
      spent += next.completionTokens ?? countTokens(next.text)
      result = { ...next, text }
    }

    if (stage === 'card' && config.guards && result.finish === 'length' && (!opening || !thinkOpen(opening + text))) {
      const next = await input.generator.generate({ ...request, prompt: prompt + text, maxTokens: CARD_FINISH_TOKENS }, onDelta)
      generations++
      text += next.text
      spent += next.completionTokens ?? countTokens(next.text)
      result = { ...next, text }
    }
    completionTokens += spent
    hooks?.wireEnd?.({ output: text, outputTokens: spent })
    const output = rawPrefix !== undefined
      ? `${rawPrefix.trimStart()}${text}`
      : hasOpenThink ? reconstructOutput(text, config.thinking) : text
    return { output, result: { ...result, text }, prompt, promptTokens: stepPromptTokens }
  }

  const traced = (
    stage: 'decision' | 'answer' | 'card', prompt: string, output: string, result: GenerateResult, action: Action,
    outcome: string, gateRepairs: readonly string[] = [], relay?: RelayTrace, stepPromptTokens?: number,
  ) => {
    const parsed = action.type === 'tool' || action.type === 'exit' ? action.repairs : []
    const attachFold = !foldTraced && stage !== 'card' && stepFoldEvent !== undefined ? stepFoldEvent : undefined
    if (attachFold !== undefined) foldTraced = true
    hooks?.trace?.({
      stage, prompt, output, finish: result.finish, action: describeAction(action), outcome,
      repairs: [...parsed, ...gateRepairs],
      ...stepPromptTokens === undefined ? {} : { promptTokens: stepPromptTokens },
      ...result.stop === undefined ? {} : { stop: result.stop },
      ...relay === undefined ? {} : { relay },
      ...stage === 'decision' && worklistTrace !== undefined ? { worklist: worklistTrace } : {},
      ...attachFold === undefined ? {} : { fold: attachFold },
    })
  }
  const parseOptions = { strict: !config.outputRepairs }

  let foldedUnread: readonly string[] | undefined
  const done = (decision: Decision): StepResult => ({
    decision,
    promptTokens,
    completionTokens,
    generations,
    ...(foldedUnread !== undefined ? { foldedUnread } : {}),
    ...(stepFoldEvent !== undefined ? { foldEvent: stepFoldEvent } : {}),
  })

  const writeCard = async (need: RelayNeed, cards: readonly RelayCard[]): Promise<RelayCard> => {
    let text = ''
    let pending: { output: string; result: GenerateResult; prompt: string; promptTokens: number } | undefined
    try {
      const entries: Entry[] = [
        { role: 'system', text: system },
        ...recapEntries(input.history, cards, need, { tools, postToolReminder: '' }),
      ]
      const { output, result, prompt, promptTokens: cardPromptTokens } = await generate(entries, 'card', 'handoff recap')
      text = cleanCardText(output)
      pending = { output, result, prompt, promptTokens: cardPromptTokens }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
    }
    const budget = Math.min(500, config.relay?.cardMaxTokens ?? DEFAULT_RELAY_CARD_MAX_TOKENS)
    const card = makeCard(input.history, need, text !== '' ? text : fallbackCard(input.history, need, budget))
    const relay: RelayTrace = { from: need.start, to: need.end, turn: need.turn, fallback: text === '', card: card.text }
    if (pending !== undefined) {
      traced('card', pending.prompt, pending.output, pending.result, { type: 'final', text }, text === '' ? 'card-empty' : 'card', [], relay, pending.promptTokens)
    } else if (hooks?.trace !== undefined) {
      hooks.trace({
        stage: 'card', prompt: '', output: '', finish: 'error', action: 'card', outcome: 'card-failed', repairs: [], relay,
      })
    }
    input.relay?.save?.(card)
    return card
  }

  let state = analyzeTurn(input.history)
  let base: Entry[]
  let liveWorklistNudge: string | undefined
  if (config.worklist !== undefined) {
    const { entries, fold } = worklistEntries(input.history, {
      tools,
      postToolReminder: reminder,
      systemTokens: countTokens(system),
      historyEmptyThink: config.historyEmptyThink,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...config.worklist,
    })
    foldedUnread = fold.foldedUnread
    stepFoldEvent = fold.foldEvent
    liveWorklistNudge = fold.nudge
    worklistTrace = {
      promptTokens: fold.promptTokens,
      budgetTokens: config.worklist.budgetTokens,
      ...(fold.checkpointAt === undefined ? {} : { checkpointAt: fold.checkpointAt }),
      nudged: fold.nudge !== undefined,
    }
    state = analyzeTurn(input.history, {
      duplicateFrom: fold.duplicateFrom,
      ...(fold.maskedCallIds !== undefined ? { maskedCallIds: fold.maskedCallIds } : {}),
    })
    base = [{ role: 'system', text: system }, ...entries]
  } else if (config.relay === undefined) {
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

  const answerStage = async (entries: readonly Entry[], prelude: readonly string[], allowTools = false): Promise<StepResult> => {
    const trimmedEntries = liveWorklistNudge !== undefined
      && entries.length > 0
      && entries[entries.length - 1]!.role === 'user'
      && entries[entries.length - 1]!.text === liveWorklistNudge
      ? entries.slice(0, -1)
      : entries
    const staged: Entry[] = [
      ...trimmedEntries.filter(entry => !(entry.role === 'user' && entry.text === reminder)),
      ...prelude.map(text => ({ role: 'user' as const, text })),
      { role: 'user', text: oneStageAnswerInstruction() },
    ]
    let lastOutput = ''
    let opener: string | undefined
    let priorThink = ''
    const outputs: string[] = []
    const openerMode = config.answerOpenerMode ?? 'default'
    for (let attempt = 0; attempt < (config.guards ? 3 : 1); attempt++) {
      let rawAssistantPrefix: string | undefined
      let extraStops: readonly string[] | undefined
      if (attempt === 2) {
        if (openerMode === 'default') {
          opener = answerOpener(state.task)
        } else if (openerMode === 'zh-only' && isChinese(state.task) && state.successfulCalls > 0) {
          opener = '根据上面的工具结果，'
        } else if (openerMode !== 'zh-only' || !isChinese(state.task)) {
          extraStops = ['<tool_call>', '<tool_call']
          rawAssistantPrefix = config.thinking === 'full' ? ` <think>${priorThink}</think>\n` : undefined
        }
      }
      const genOpts = rawAssistantPrefix !== undefined || extraStops !== undefined
        ? {
          ...rawAssistantPrefix === undefined ? {} : { rawAssistantPrefix },
          ...extraStops === undefined ? {} : { extraStops },
        }
        : undefined
      let { output, result, prompt, promptTokens: answerPromptTokens } = await generate(staged, 'answer', attempt === 0 ? 'answer' : 'answer re-ask', opener, genOpts)
      const closedThink = extractThinkInner(output)
      if (closedThink !== '') priorThink = closedThink
      lastOutput = opener ? `${opener}${output}` : output
      outputs.push(lastOutput)
      let action = parseAction(lastOutput, result.finish, parseOptions)
      const truncatedPlanningAtToolStop = action.type === 'final' && hasPlanningMarker(cleanFinalText(action.text))
      if (
        attempt === 2
        && openerMode === 'zh-only'
        && !isChinese(state.task)
        && ((action.type === 'error' && action.kind === 'empty') || truncatedPlanningAtToolStop)
        && (result.stop === '<tool_call>' || result.stop === '<tool_call')
      ) {
        const retryPrefix = config.thinking === 'full' ? ` <think>${priorThink}</think>Summary:\n` : 'Summary:\n'
        const retry = await generate(staged, 'answer', 'answer re-ask', undefined, {
          rawAssistantPrefix: retryPrefix,
          extraStops: ['<tool_call>', '<tool_call'],
        })
        output = retry.output
        result = retry.result
        prompt = retry.prompt
        answerPromptTokens = retry.promptTokens
        lastOutput = output
        outputs.push(lastOutput)
        action = parseAction(lastOutput, result.finish, parseOptions)
      }
      if (allowTools && action.type === 'tool' && state.steps < config.maxSteps) {
        const gated = gateToolCall(action, state, tools, config, true)
        if (gated.type === 'run') {
          traced('answer', prompt, output, result, action, 'run', gated.repairs, undefined, answerPromptTokens)
          return done({ type: 'tool', tool: gated.tool, args: gated.args, rawArgs: action.args, repairs: [...action.repairs, ...gated.repairs, 'answer_stage_tool'] })
        }
      }
      if (action.type === 'final' && !action.text.toLowerCase().includes('<tool_call')) {
        const text = cleanFinalText(action.text)
        if (text !== '') {
          traced('answer', prompt, output, result, action, 'final', [], undefined, answerPromptTokens)
          return done({ type: 'final', text, via: 'answer-stage' })
        }
      }
      if (action.type === 'exit' && action.answer !== '') {
        traced('answer', prompt, output, result, action, 'final', [], undefined, answerPromptTokens)
        return done({ type: 'final', text: action.answer, via: 'answer-stage' })
      }
      traced('answer', prompt, output, result, action, config.guards ? 're-ask' : 'raw', [], undefined, answerPromptTokens)
      if (attempt === 0) staged.push({ role: 'user', text: ANSWER_STAGE_REASK })
    }
    if (!config.guards) return done(rawFinal(lastOutput))
    const salvaged = config.fallbackSummary === false
      ? salvageLastResortAnswer(outputs, opener)
      : salvageAnswerProse(lastOutput, opener)
    if (salvaged !== '') return done({ type: 'final', text: cleanFinalText(salvaged), via: 'salvage' })
    return done({ type: 'final', text: answerFallbackSummary(state.task, state.results), via: 'summary' })
  }

  if (state.steps >= config.maxSteps) return answerStage(base, [])

  const extra: Entry[] = []
  const decisionOutputs: string[] = []
  let protocolRetries = 0
  let duplicateRetryUsed = false
  let blockedRetries = 0
  for (let attempt = 0; attempt < config.protocolRetries + 4; attempt++) {
    const label = attempt === 0 ? 'decide' : 're-ask'
    const { output, result, prompt, promptTokens: decisionPromptTokens } = await generate([...base, ...extra], 'decision', label)
    decisionOutputs.push(output)
    if (result.finish === 'cancelled') throw new DOMException('aborted', 'AbortError')
    const action = parseAction(output, result.finish, parseOptions)
    const note = (outcome: string, gateRepairs?: readonly string[]) => traced('decision', prompt, output, result, action, outcome, gateRepairs, undefined, decisionPromptTokens)
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
        extra.push(...gated.receipt)
        if (++blockedRetries > 3) return config.guards ? answerStage([...base, ...extra], []) : done(rawFinal(output))
        continue
      }
      case 'error':
        break
    }
    note(config.guards ? 're-ask' : 'raw')
    if (!config.guards) return done(rawFinal(output))
    if (++protocolRetries > config.protocolRetries) {
      if (state.steps > 0) return answerStage([...base, ...extra], [], true)
      if (config.fallbackSummary === false) {
        const salvaged = salvageLastResortAnswer(decisionOutputs)
        if (salvaged !== '') return done({ type: 'final', text: cleanFinalText(salvaged), via: 'salvage' })
      }
      return done({
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
