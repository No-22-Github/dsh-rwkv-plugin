// Browser half: a "RWKV" section in Settings that edits the rwkv-llm row's
// config (endpoints, models, adapters, harness, sampling). It registers while
// the Host serves that row, so a profile without the plugin shows nothing.
// Built by scripts/build-client.mjs into the lazy-CJS factory DSH loads;
// only `react` is shared from the module table.

import type { Context } from '@deepseek-ai/cordis'
import { RwkvSettings, type ConfigFormLike } from './RwkvSettings.tsx'
import { mountStyles } from './styles.ts'

/** Profile row id of the provider plugin, i.e. the settings namespace it is served under. */
export const NAMESPACE = 'rwkv-llm'

export const inject = ['slots', 'configForms']

interface ClientServices {
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
  ctx.effect(() => mountStyles(), 'rwkv-llm: settings styles')
  ctx.effect(() => services.configForms.whileServed([NAMESPACE], () => services.slots.inject('settings.section', () => services.slots.register({
    name: 'settings.section',
    id: 'rwkv',
    order: 15,
    label: () => 'RWKV',
    inject: () => ({ form }),
  }, RwkvSettings))), 'rwkv-llm: settings section')
}
