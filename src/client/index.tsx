// Browser half: a "RWKV" section in Settings that edits the rwkv-llm row's
// config (endpoints, models, adapters, harness, sampling). It registers while
// the Host serves that row, so a profile without the plugin shows nothing.
// Built by scripts/build.mjs into the lazy-CJS factory DSH loads;
// only `react` is shared from the module table.

import type { Context } from '@deepseek-ai/cordis'
import { RwkvSettings, type ConfigFormLike } from './RwkvSettings.tsx'
import { RwkvTraceView } from './TraceView.tsx'
import { mountStyles } from './styles.ts'

/** Profile row id of the provider plugin, i.e. the settings namespace it is served under. */
export const NAMESPACE = 'rwkv-llm'

export const inject = ['slots', 'configForms', 'remote']

interface ClientServices {
  remote?: {
    settings?: {
      mutate(ns: string, ops: unknown[], revision: number | undefined): Promise<{ ok: boolean; error?: { message?: string; code?: string } }>
    }
  }
  configForms: {
    get(entryId: string): ConfigFormLike
    whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
  }
  slots: {
    inject(name: string, register: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

export function apply(ctx: Context): void {
  const services = ctx as unknown as ClientServices
  const form = services.configForms.get(NAMESPACE)
  // configForms.set reports only true/false. After a refused write, repeat it
  // through the settings remote to read the Host's reason; a refused write
  // changed nothing, so the repeat is refused the same way.
  const explain = async (field: string, value: unknown): Promise<string> => {
    const mutate = services.remote?.settings?.mutate
    if (mutate === undefined) return ''
    try {
      const result = await mutate.call(services.remote!.settings, NAMESPACE, [{ op: 'set', path: [field], value }], form.getSnapshot().revision)
      return result.ok ? '' : result.error?.message ?? result.error?.code ?? ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  ctx.effect(() => mountStyles(), 'rwkv-llm: settings styles')
  ctx.effect(() => services.configForms.whileServed([NAMESPACE], () => services.slots.inject('settings.section', () => services.slots.register({
    name: 'settings.section',
    id: 'rwkv',
    order: 15,
    label: () => 'RWKV',
    inject: () => ({ form, explain }),
  }, RwkvSettings))), 'rwkv-llm: settings section')
  // The RWKV tab beside Chat / Trajectory: the Host keeps traces in memory
  // whether or not they are written to disk, so it is always there.
  ctx.effect(() => services.configForms.whileServed([NAMESPACE], () => services.slots.inject('conversation.view', () => services.slots.register({
    name: 'conversation.view',
    id: 'rwkv-trace',
    order: 45,
    label: () => 'RWKV',
    inject: (sessionId: string) => ({ session: String(sessionId) }),
  }, RwkvTraceView))), 'rwkv-llm: trace view')
}
