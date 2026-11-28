// Main-chat inline event node for RWKV context folding (`plugin:rwkv-llm/context-fold`).
// Registered into DSH's `uiConversation.events` and `conversation.chat.node` slot so
// context folds appear directly in the main Chat stream alongside native compaction events.

import { foldKindLabel, formatTokens, type ContextFoldTrace } from './traces-api.ts'

export const CONTEXT_FOLD_RECORD = 'plugin:rwkv-llm/context-fold'
export const CONTEXT_FOLD_NODE_KEY = 'rwkv-fold'

export interface RwkvFoldNodeData extends ContextFoldTrace {
  readonly seq: number
  readonly time?: number
}

interface SessionEventLike {
  readonly type?: string
  readonly seq: number
  readonly time?: number
  readonly data?: unknown
}

interface NodeContextLike {
  readonly key: string
  readonly id: string
  readonly state?: RwkvFoldNodeData
  readonly start?: { readonly location?: unknown }
}

/** Projects `plugin:rwkv-llm/context-fold` session records into visible main-chat nodes. */
export const rwkvFoldDefinition = {
  kind: CONTEXT_FOLD_NODE_KEY,
  target: 'chat',
  match: (event: SessionEventLike) => {
    if (event?.type !== CONTEXT_FOLD_RECORD) return null
    return { id: `rwkv-fold-${event.seq}`, role: 'start' as const }
  },
  start: (_context: NodeContextLike, match: { readonly event: SessionEventLike }): RwkvFoldNodeData => {
    const raw = (match.event.data ?? {}) as Partial<ContextFoldTrace>
    return {
      seq: match.event.seq,
      ...(match.event.time === undefined ? {} : { time: match.event.time }),
      kind: typeof raw.kind === 'string' ? raw.kind : 'in-place',
      beforeTokens: typeof raw.beforeTokens === 'number' ? raw.beforeTokens : 0,
      afterTokens: typeof raw.afterTokens === 'number' ? raw.afterTokens : 0,
      foldedTools: typeof raw.foldedTools === 'number' ? raw.foldedTools : 0,
    }
  },
  update: (context: NodeContextLike) => context.state,
  buildViewNode: (context: NodeContextLike) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: CONTEXT_FOLD_NODE_KEY,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** Native-style left-aligned minimal row matching DSH's own `思考 · ...` / `上下文注入 · ...` rows. */
export function RwkvFoldNodeView(props: { node?: { readonly data?: RwkvFoldNodeData } }) {
  const data = props.node?.data
  if (data === undefined) return null
  const label = foldKindLabel(data.kind)
  const range = `${formatTokens(data.beforeTokens)} → ${formatTokens(data.afterTokens)}`
  const detail = data.foldedTools > 0 ? `${range}，已折叠 ${data.foldedTools} 条工具调用` : range
  const title = `RWKV ${label}：${data.beforeTokens.toLocaleString()} → ${data.afterTokens.toLocaleString()} RWKV token`
  return (
    <div className="rwkv-chat-fold" title={title}>
      <svg className="rwkv-chat-fold-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M4.5 2.5L7 5L9.5 2.5M4.5 11.5L7 9L9.5 11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="rwkv-chat-fold-label">{label}</span>
      <span className="rwkv-chat-fold-sep" aria-hidden="true">·</span>
      <span className="rwkv-chat-fold-detail">{detail}</span>
    </div>
  )
}
