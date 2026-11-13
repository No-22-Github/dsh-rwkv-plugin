// DSH plugin: registers RWKV-7 G1 continuation models as an LLM provider.
// Select it for the main agent (agent-default-model) or for a delegation tool
// (tool-subagent agentOptions); see README.md and cordis.patch.yml.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RwkvAdapter, type AdapterSettings, type ModelConfig } from './adapter.ts'
import { DEFAULT_HARNESS } from './core/agent.ts'
import type { ToolMode, ToolNames } from './core/tools.ts'
import { applyResultBudget } from './result-budget.ts'
import { handleServerRoute, handleTraceRoute } from './routes.ts'
import { TraceLocation } from './traces.ts'

export const name = 'rwkv-llm'
export const inject = ['llm']

/** Plain field values; the plugin receives each one as a live reference. */
export interface Settings {
  models: ModelConfig[]
  thinking: 'off' | 'full'
  historyEmptyThink: boolean
  maxSteps: number
  maxConsecutiveFailures: number
  protocolRetries: number
  decisionMaxTokens: number
  answerMaxTokens: number
  sampling: {
    temperature: number
    topK: number
    topP: number
    presencePenalty: number
    frequencyPenalty: number
    penaltyDecay: number
  }
  taskContract: string
  toolMode: ToolMode
  toolNames: ToolNames
  excludeTools: string[]
  toolOverrides: Record<string, { description?: string, arguments?: Record<string, string> }>
  includeDeveloper: boolean
  currentDate: boolean
  timeZone: string
  loopGuard: boolean
  outputRepairs: boolean
  guards: boolean
  historyMode: 'full' | 'relay'
  relayBudgetTokens: number
  relayCardMaxTokens: number
  recordTraces: boolean
  traceDir: string
}

/**
 * Every field but the provider routes is volatile: only volatile fields are
 * served to the Settings page (settings.describe skips plugins without any),
 * and the adapter reads them per request, so a save applies without a reload.
 */
export type Config = { providers: string[] } & { [K in keyof Settings]: Volatile<Settings[K]> }

const Model = z.object({
  id: z.string().required().description('Model id selected in DSH (provider/model route).'),
  name: z.string().description('Display name.'),
  backend: z.union(['lightning', 'irwkv']).required().description('lightning = rwkv_lightning CUDA /v1/batch/completions; irwkv = iRWKV /v1/completions.'),
  baseURL: z.string().required().description('Server root, e.g. http://100.64.0.5:8103 or https://api-7b.rwkvos.com.'),
  model: z.string().required().description('Upstream model id.'),
  apiKey: z.string().description('iRWKV bearer key or rwkv_lightning password.'),
  headers: z.dict(z.string()).description('Extra request headers (Cloudflare Access service token).'),
  contextWindow: z.natural().description('Context window advertised to DSH.'),
  stateId: z.string().description('rwkv_lightning: initial state id from /v1/state/upload; empty = zero state.'),
  adapterId: z.string().description('rwkv_lightning: adapter id for request-level adaptation; empty = no adapter.'),
  // Configs saved before 94b3734 carry `adapter: { id, file, serverPath }`;
  // schemastery passes unknown keys through, the adapter still reads
  // adapter.id, and the settings page rewrites it as adapterId on save.
  thinking: z.union(['off', 'full']).description('Overrides the global wire for this model.'),
  historyEmptyThink: z.boolean().description('Overrides historyEmptyThink for this model.'),
})

export const Config = z.object({
  providers: z.array(z.string()).default(['rwkv']).description('Provider routes this adapter serves.'),
  models: z.array(Model).default([]).volatile(),
  thinking: z.union(['off', 'full']).default(DEFAULT_HARNESS.thinking)
    .description('full = agent-wire-think-v1.0 (prompt ends with "Assistant: <think"); off = agent-wire-v1.0.').volatile(),
  historyEmptyThink: z.boolean().default(DEFAULT_HARNESS.historyEmptyThink)
    .description('agent-wire-think-v2.0 (think-sft): an empty think block before every past assistant step.').volatile(),
  maxSteps: z.natural().default(DEFAULT_HARNESS.maxSteps).description('Tool calls per user turn before the forced closeout.').volatile(),
  maxConsecutiveFailures: z.natural().default(DEFAULT_HARNESS.maxConsecutiveFailures).volatile(),
  protocolRetries: z.natural().default(DEFAULT_HARNESS.protocolRetries).volatile(),
  decisionMaxTokens: z.natural().default(DEFAULT_HARNESS.decisionMaxTokens).volatile(),
  answerMaxTokens: z.natural().default(DEFAULT_HARNESS.answerMaxTokens).volatile(),
  sampling: z.object({
    temperature: z.number().default(DEFAULT_HARNESS.sampling.temperature),
    topK: z.natural().default(DEFAULT_HARNESS.sampling.topK),
    topP: z.number().default(DEFAULT_HARNESS.sampling.topP),
    presencePenalty: z.number().default(DEFAULT_HARNESS.sampling.presencePenalty),
    frequencyPenalty: z.number().default(DEFAULT_HARNESS.sampling.frequencyPenalty),
    penaltyDecay: z.number().default(DEFAULT_HARNESS.sampling.penaltyDecay),
  }).default(DEFAULT_HARNESS.sampling).description('Defaults are the agent-fast preset.').volatile(),
  taskContract: z.string().default('').description('Appended to the RWKV system prompt as "Task-specific contract".').volatile(),
  toolMode: z.union(['mapped', 'passthrough']).default('mapped')
    .description('mapped: only DSH tools with an RWKV-trained counterpart (read/write/edit/glob/grep/bash/web); passthrough: all offered tools.').volatile(),
  toolNames: z.union(['dsh', 'trained']).default('dsh')
    .description('dsh: DSH tool names (read, glob, ...) and DSH\'s system prompt without the sections for tools the RWKV preset does not mount; trained: the agent-tool-v3 names (read_file, ...) and the Go-aligned prompt.').volatile(),
  excludeTools: z.array(z.string()).default([]).description('Tool names (DSH or RWKV) hidden from the model.').volatile(),
  toolOverrides: z.dict(z.object({ description: z.string(), arguments: z.dict(z.string()) })).default({})
    .description('Experiment only: replace tool descriptions / argument placeholders by tool name. Anything set here breaks parity with the training data.').volatile(),
  includeDeveloper: z.boolean().default(false).description('Show DSH developer/context messages to the model as user notes.').volatile(),
  currentDate: z.boolean().default(true)
    .description('End the system prompt with "Current date: YYYY-MM-DD (zone, UTC±hh:mm)." for this machine\'s time zone; DSH time-context readings are then left out of the history. Off: no date line; readings appear as "Current time: ..." notes.').volatile(),
  timeZone: z.string().default('')
    .description('IANA time zone for the date line (e.g. Asia/Shanghai). Empty: this machine\'s zone.').volatile(),
  loopGuard: z.boolean().default(true).description('Client-side repetition cut-off.').volatile(),
  outputRepairs: z.boolean().default(DEFAULT_HARNESS.outputRepairs)
    .description('Fix near-miss output: parser repairs, tool name / argument aliases, scalar coercion, DSH value repairs, path repair. Off: exact protocol form only, arguments reach DSH as written.').volatile(),
  guards: z.boolean().default(DEFAULT_HARNESS.guards)
    .description('Harness interventions: format re-asks, duplicate / failure gates, over-budget think close, answer-stage re-asks and fallbacks. Off: the model\'s output stands.').volatile(),
  historyMode: z.union(['full', 'relay']).default('full')
    .description('full: the model reads the whole conversation. relay: finished legs are replaced by model-written handoff cards; the most recent call/result pair stays verbatim and the duplicate-call gate restarts at each leg.').volatile(),
  relayBudgetTokens: z.natural().default(6000)
    .description('relay: estimated token budget for the part of the leg that gets carded; the latest call/result pair is always kept.').volatile(),
  relayCardMaxTokens: z.natural().default(768)
    .description('relay: output cap of one handoff recap.').volatile(),
  recordTraces: z.boolean().default(true)
    .description('Write RWKV traces (prompt bytes + raw output, outcome, repairs) to disk: rwkv-trace.jsonl next to each DSH session log, or traceDir. They are always kept in memory for the RWKV tab.').volatile(),
  traceDir: z.string().default('').description('Custom trace directory (<session>.jsonl per session); empty = next to the DSH session logs.').volatile(),
})

function traceLocationOf(config: Config): TraceLocation {
  return new TraceLocation(config.traceDir.get())
}

function settingsOf(config: Config): AdapterSettings {
  return {
    models: config.models.get(),
    harness: {
      thinking: config.thinking.get(),
      historyEmptyThink: config.historyEmptyThink.get(),
      maxSteps: config.maxSteps.get(),
      maxConsecutiveFailures: config.maxConsecutiveFailures.get(),
      protocolRetries: config.protocolRetries.get(),
      decisionMaxTokens: config.decisionMaxTokens.get(),
      answerMaxTokens: config.answerMaxTokens.get(),
      sampling: config.sampling.get(),
      outputRepairs: config.outputRepairs.get(),
      guards: config.guards.get(),
      ...config.taskContract.get() ? { taskContract: config.taskContract.get() } : {},
    },
    toolMode: config.toolMode.get(),
    toolNames: config.toolNames.get(),
    excludeTools: config.excludeTools.get(),
    ...Object.keys(config.toolOverrides.get()).length ? { toolOverrides: config.toolOverrides.get() } : {},
    includeDeveloper: config.includeDeveloper.get(),
    currentDate: config.currentDate.get(),
    ...config.timeZone.get() ? { timeZone: config.timeZone.get() } : {},
    loopGuard: config.loopGuard.get(),
    ...config.historyMode.get() === 'relay'
      ? { relay: { budgetTokens: config.relayBudgetTokens.get(), cardMaxTokens: config.relayCardMaxTokens.get() } }
      : {},
    ...config.recordTraces.get() ? { traces: traceLocationOf(config) } : {},
    log: message => console.log(`[rwkv-llm] ${message}`),
  }
}

export function apply(ctx: Context, config: Config): void {
  const adapter = new RwkvAdapter(() => settingsOf(config))
  ctx.llm.registerAdapter(config.providers, adapter)
  // Long tool results in RWKV sessions: cut once when the tool runs, the rest saved to a file.
  applyResultBudget(ctx, { providers: () => config.providers, log: message => console.log(`[rwkv-llm] ${message}`) })
  // Server model list and state list / upload / delete for the settings page, behind the /api
  // bridge's authentication (client-connection runs this waterfall only for
  // admitted requests). Absent in compositions without a Web connection.
  const on = ctx.on as unknown as (
    event: string,
    listener: (request: IncomingMessage, response: ServerResponse, next: () => Promise<void>) => Promise<void>,
  ) => () => void
  on.call(ctx, 'connection/request', async (request, response, next) => {
    if (handleTraceRoute(request, response, () => ({ location: traceLocationOf(config), recording: config.recordTraces.get() }))) return
    if (!await handleServerRoute(request, response)) await next()
  })
}
