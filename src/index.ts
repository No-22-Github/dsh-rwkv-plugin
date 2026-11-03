// DSH plugin: registers RWKV-7 G1 continuation models as an LLM provider.
// Select it for the main agent (agent-default-model) or for a delegation tool
// (tool-subagent agentOptions); see README.md and cordis.patch.yml.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RwkvAdapter, type AdapterSettings, type ModelConfig } from './adapter.ts'
import { DEFAULT_HARNESS } from './core/agent.ts'
import type { ToolMode } from './core/tools.ts'
import { handleAdapterRoute } from './routes.ts'

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
  maxResultChars: number
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
  excludeTools: string[]
  includeDeveloper: boolean
  loopGuard: boolean
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
  stateId: z.string().description('rwkv_lightning: uploaded state id.'),
  // Inner fields stay optional: schemastery validates them even when the
  // whole adapter object is absent, so a required id fails every model
  // without an adapter. A model without adapter.id runs on the base weights.
  adapter: z.object({
    id: z.string().description('Adapter id on the server; empty = no adapter.'),
    file: z.string().description('Local adapter package uploaded when the server does not list the id.'),
    serverPath: z.string().description('Path on the inference server registered when the id is not listed.'),
  }).description('rwkv_lightning: MiSS / LoRA / NoRA adapter.'),
  thinking: z.union(['off', 'full']).description('Overrides the global wire for this model.'),
  historyEmptyThink: z.boolean().description('Overrides historyEmptyThink for this model (true for think-sft adapters).'),
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
  maxResultChars: z.natural().default(DEFAULT_HARNESS.maxResultChars).description('Tool output longer than this keeps its head and tail.').volatile(),
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
  excludeTools: z.array(z.string()).default([]).description('Tool names (DSH or RWKV) hidden from the model.').volatile(),
  includeDeveloper: z.boolean().default(false).description('Show DSH developer/context messages to the model as user notes.').volatile(),
  loopGuard: z.boolean().default(true).description('Client-side repetition cut-off.').volatile(),
  traceDir: z.string().default('').description('Write every generation (prompt bytes + raw output) as JSONL here.').volatile(),
})

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
      maxResultChars: config.maxResultChars.get(),
      sampling: config.sampling.get(),
      ...config.taskContract.get() ? { taskContract: config.taskContract.get() } : {},
    },
    toolMode: config.toolMode.get(),
    excludeTools: config.excludeTools.get(),
    includeDeveloper: config.includeDeveloper.get(),
    loopGuard: config.loopGuard.get(),
    ...config.traceDir.get() ? { traceDir: config.traceDir.get() } : {},
    log: message => console.log(`[rwkv-llm] ${message}`),
  }
}

export function apply(ctx: Context, config: Config): void {
  const adapter = new RwkvAdapter(() => settingsOf(config))
  ctx.llm.registerAdapter(config.providers, adapter)
  // Check configured adapters in the background, now and after each settings
  // save, so the first request does not wait for an upload.
  const prepare = () => {
    for (const model of config.models.get()) {
      adapter.ensureAdapter(model).catch((error: unknown) => {
        console.warn(`[rwkv-llm] adapter for model ${model.id} is not ready yet: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
  prepare()
  ctx.on('loader/volatile-update', prepare)
  // Adapter list / upload / delete for the settings page, behind the /api
  // bridge's authentication (client-connection runs this waterfall only for
  // admitted requests). Absent in compositions without a Web connection.
  const on = ctx.on as unknown as (
    event: string,
    listener: (request: IncomingMessage, response: ServerResponse, next: () => Promise<void>) => Promise<void>,
  ) => () => void
  on.call(ctx, 'connection/request', async (request, response, next) => {
    if (!await handleAdapterRoute(request, response)) await next()
  })
}
