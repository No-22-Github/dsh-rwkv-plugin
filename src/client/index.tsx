// Browser half: a "RWKV" section in Settings that edits the rwkv-llm row's
// config (endpoints, models, adapters, harness, sampling). It registers while
// the Host serves that row, so a profile without the plugin shows nothing.
// Built by scripts/build.mjs into the lazy-CJS factory DSH loads;
// only `react` is shared from the module table.

import type { Context } from '@deepseek-ai/cordis'
import { CONTEXT_FOLD_NODE_KEY, rwkvFoldDefinition, RwkvFoldNodeView } from './FoldNode.tsx'
import { RwkvSettings, type ConfigFormLike } from './RwkvSettings.tsx'
import { RwkvTraceView } from './TraceView.tsx'
import { RwkvWireIcon, RwkvWirePanel, WIRE_TAB_ID } from './WirePanel.tsx'
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
  uiConversation?: {
    events?: {
      register(definition: unknown): (() => void) | void
    }
  }
  sidebarRightTabs?: {
    register(definition: unknown): (() => void) | void
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
    label: () => 'RWKV Agent',
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
  // Inline context-fold divider in the main Chat stream (`plugin:rwkv-llm/context-fold`).
  const injectFn = (ctx as unknown as { inject?: (deps: readonly string[], fn: (sub: Context) => void) => void }).inject
  injectFn?.call(ctx, ['uiConversation'], subCtx => {
    const uiConv = (subCtx as unknown as ClientServices).uiConversation
    const dispose = uiConv?.events?.register?.(rwkvFoldDefinition)
    if (typeof dispose === 'function') subCtx.effect(() => dispose, 'rwkv-llm: chat fold definition')
    subCtx.effect(() => services.slots.inject('conversation.chat.node', () => services.slots.register({
      name: 'conversation.chat.node',
      key: CONTEXT_FOLD_NODE_KEY,
    }, RwkvFoldNodeView)), 'rwkv-llm: chat fold node')
  })
  // Right-sidebar real-time character-level RWKV wire viewer.
  injectFn?.call(ctx, ['sidebarRightTabs'], subCtx => {
    const tabs = (subCtx as unknown as ClientServices).sidebarRightTabs
    const dispose = tabs?.register?.({
      id: WIRE_TAB_ID,
      kind: WIRE_TAB_ID,
      title: () => 'RWKV 实时上下文',
      guide: [{
        id: WIRE_TAB_ID,
        order: 45,
        title: () => 'RWKV 实时上下文',
        description: () => '查看模型原始上下文',
        icon: RwkvWireIcon,
      }],
    })
    if (typeof dispose === 'function') subCtx.effect(() => dispose, 'rwkv-llm: wire tab type')
    subCtx.effect(() => services.slots.inject('sidebar.right.pane.tab', () => services.slots.register({
      name: 'sidebar.right.pane.tab',
      key: WIRE_TAB_ID,
      inject: (sessionId: string) => ({ session: String(sessionId) }),
    }, RwkvWirePanel)), 'rwkv-llm: wire tab body')
  })
}
