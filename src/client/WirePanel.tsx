// Right-sidebar panel: live character-level RWKV wire context viewer.
// Connects via SSE (`/api/rwkv/live/<session>`) to display either:
//   - "模型实时" (exact prompt the model currently sees, with empty historical
//     thinks and folded `[Old ...]` placeholders), or
//   - "全量历史" (full unfolded history with faded past thoughts).
// Every block is a clickable card (click to expand/collapse, drag-to-select
// safe), with a global toolbar toggle to pretty-print JSON in tool calls,
// tool responses, and System tool-format templates (raw by default).

import { useEffect, useMemo, useRef, useState } from 'react'
import { ctxTier, foldKindLabel, formatTokens, type ContextFoldTrace } from './traces-api.ts'

export const WIRE_TAB_ID = 'rwkv-wire'

const LONG_BLOCK_CHARS = 480
const LONG_BLOCK_LINES = 6

type ViewMode = 'model' | 'full'

interface LiveWireSnapshot {
  readonly sessionId: string
  readonly model: string
  readonly stage: 'decision' | 'answer' | 'card' | 'idle'
  readonly streaming: boolean
  readonly prompt: string
  readonly fullPrompt?: string
  readonly promptTokens: number
  readonly blockTokens?: readonly number[]
  readonly fullBlockTokens?: readonly number[]
  readonly pastThinks?: readonly string[]
  readonly output: string
  readonly outputTokens: number
  readonly fold?: ContextFoldTrace
  readonly updatedAt: string
}

type SpanKind = 'plain' | 'label' | 'think' | 'think-past' | 'think-empty' | 'tool-call' | 'tool-result' | 'tool-error' | 'folded'
type RoleKind = 'system' | 'user' | 'assistant' | 'tool' | 'other'
type CardKind = 'system' | 'user' | 'assistant' | 'tool' | 'error' | 'folded' | 'other'

interface InlineSpan {
  readonly kind: SpanKind
  readonly text: string
  readonly title?: string
}

interface WireBlock {
  readonly role: RoleKind
  readonly cardKind: CardKind
  readonly raw: string
  readonly spans: readonly InlineSpan[]
}

/** Splits a block's text into lossless inline spans with background color tags. */
function tokenizeBody(
  text: string,
  role: RoleKind,
  options: { readonly isPastAssistant: boolean; readonly pastThink?: string; readonly fillPastThink: boolean },
): InlineSpan[] {
  const spans: InlineSpan[] = []
  let i = 0
  let usedPastThink = false
  const push = (kind: SpanKind, slice: string, title?: string) => {
    if (slice === '') return
    const prev = spans[spans.length - 1]
    if (prev !== undefined && prev.kind === kind && prev.title === title) {
      spans[spans.length - 1] = { kind, text: prev.text + slice, ...(title === undefined ? {} : { title }) }
    } else {
      spans.push({ kind, text: slice, ...(title === undefined ? {} : { title }) })
    }
  }

  const prefixMatch = /^(System:|User:|Assistant:|Tool:)/.exec(text)
  if (prefixMatch !== null) {
    push('label', prefixMatch[0])
    i = prefixMatch[0].length
  }

  if (role === 'system') {
    push('plain', text.slice(i))
    return spans
  }

  const TAG_RE = /<think>|<tool_call>|<tool_response>/g
  while (i < text.length) {
    TAG_RE.lastIndex = i
    const match = TAG_RE.exec(text)
    if (match === null) {
      const rest = text.slice(i)
      const openThinkIdx = rest.indexOf('<think')
      if (openThinkIdx >= 0 && openThinkIdx === rest.length - '<think'.length) {
        push('plain', rest.slice(0, openThinkIdx))
        push('think', rest.slice(openThinkIdx))
      } else {
        push('plain', rest)
      }
      break
    }
    if (match.index > i) {
      push('plain', text.slice(i, match.index))
    }
    const openTag = match[0]
    const closeTag = openTag === '<think>' ? '</think>'
      : openTag === '<tool_call>' ? '</tool_call>'
      : '</tool_response>'
    const closeIdx = text.indexOf(closeTag, match.index + openTag.length)
    const endIdx = closeIdx >= 0 ? closeIdx + closeTag.length : text.length
    const chunk = text.slice(match.index, endIdx)

    if (openTag === '<think>') {
      const inner = closeIdx >= 0 ? text.slice(match.index + openTag.length, closeIdx).trim() : 'streaming'
      if (inner === '' && options.fillPastThink && !usedPastThink && options.pastThink) {
        usedPastThink = true
        push('think-past', `<think>${options.pastThink}</think>`, '历史思考（未回传给模型，仅全量历史展示）')
      } else if (inner === '') {
        push('think-empty', chunk)
      } else if (options.isPastAssistant) {
        push('think-past', chunk, '历史思考（模型实时视图中置空）')
      } else {
        push('think', chunk)
      }
    } else if (openTag === '<tool_call>') {
      push('tool-call', chunk)
    } else {
      const isFolded = chunk.includes('[Old ')
      const isError = /"ok"\s*:\s*false/.test(chunk)
      push(isFolded ? 'folded' : isError ? 'tool-error' : 'tool-result', chunk)
    }
    i = endIdx
  }
  return spans
}

/** Losslessly splits the raw RWKV wire string into role-tagged block cards. */
function parseWireBlocks(raw: string, mode: ViewMode, pastThinks?: readonly string[]): WireBlock[] {
  if (raw === '') return []
  const splitRe = /(?=\n\n(?:System:|User:|Assistant:|Tool:))/g
  const parts = raw.split(splitRe)
  const assistantCount = parts.filter(part => part.replace(/^\n+/, '').startsWith('Assistant:')).length
  const historyAssistants = Math.max(0, assistantCount - 1)
  const pastOffset = pastThinks && pastThinks.length > historyAssistants ? pastThinks.length - historyAssistants : 0
  let assistantSeen = 0
  return parts.map(part => {
    const trimmed = part.replace(/^\n+/, '')
    const role: RoleKind = trimmed.startsWith('System:') ? 'system'
      : trimmed.startsWith('User:') ? 'user'
      : trimmed.startsWith('Assistant:') ? 'assistant'
      : trimmed.startsWith('Tool:') ? 'tool'
      : 'other'
    let isPastAssistant = false
    let pastThink: string | undefined
    if (role === 'assistant') {
      isPastAssistant = assistantSeen < historyAssistants
      if (isPastAssistant && mode === 'full' && pastThinks !== undefined) {
        pastThink = pastThinks[pastOffset + assistantSeen]
      }
      assistantSeen++
    }
    const spans = tokenizeBody(trimmed, role, {
      isPastAssistant,
      ...(pastThink === undefined ? {} : { pastThink }),
      fillPastThink: mode === 'full',
    })
    const hasFolded = spans.some(s => s.kind === 'folded')
    const hasError = spans.some(s => s.kind === 'tool-error')
    const hasResult = spans.some(s => s.kind === 'tool-result')
    const cardKind: CardKind = role === 'system' ? 'system'
      : hasFolded ? 'folded'
      : hasError ? 'error'
      : hasResult || role === 'tool' ? 'tool'
      : role
    return {
      role,
      cardKind,
      raw: trimmed,
      spans,
    }
  })
}

/** Pretty-prints JSON inside `<tool_call>` / `<tool_response>` and System tool templates. */
function prettyJsonObject(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const multilineKey = typeof parsed.result === 'string' && parsed.result.includes('\n') ? 'result'
        : typeof parsed.error === 'string' && parsed.error.includes('\n') ? 'error'
        : undefined
      if (multilineKey !== undefined) {
        const textVal = parsed[multilineKey] as string
        const rest = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== multilineKey))
        const head = JSON.stringify(rest, null, 2)
        const indented = textVal.split('\n').map(line => `    ${line}`).join('\n')
        return head === '{}'
          ? `{\n  "${multilineKey}": """\n${indented}\n  """\n}`
          : `${head.slice(0, -1).trimEnd()},\n  "${multilineKey}": """\n${indented}\n  """\n}`
      }
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return rawJson
  }
}

function prettySystemText(text: string): string {
  // Format `<tool_call>{...}</tool_call>` and inline JSON templates like `{"name":"...","arguments":{...}}`.
  return text.replace(/<tool_call>(\{[^\n]*\})<\/tool_call>/g, (full, json: string) => {
    const formatted = prettyJsonObject(json)
    return formatted === json ? full : `<tool_call>\n${formatted}\n</tool_call>`
  }).replace(/(^|\n)([ \t]*)(\{"name":[^\n]+\})(?=\n|$)/g, (full, lead: string, indent: string, json: string) => {
    const formatted = prettyJsonObject(json)
    if (formatted === json) return full
    const indented = formatted.split('\n').map(line => `${indent}${line}`).join('\n')
    return `${lead}${indented}`
  })
}

function prettySpanText(span: InlineSpan, role: RoleKind): string {
  if (role === 'system' && span.kind === 'plain') return prettySystemText(span.text)
  if (span.kind !== 'tool-call' && span.kind !== 'tool-result' && span.kind !== 'tool-error' && span.kind !== 'folded') return span.text
  const tag = span.kind === 'tool-call' ? 'tool_call' : 'tool_response'
  const open = `<${tag}>`
  const close = `</${tag}>`
  if (!span.text.startsWith(open) || !span.text.endsWith(close)) return span.text
  const inner = span.text.slice(open.length, span.text.length - close.length).trim()
  const formatted = prettyJsonObject(inner)
  return formatted === inner ? span.text : `${open}\n${formatted}\n${close}`
}

function isLongBlock(raw: string): boolean {
  if (raw.length > LONG_BLOCK_CHARS) return true
  let lines = 1
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10 && ++lines > LONG_BLOCK_LINES) return true
  }
  return false
}

function TokChevron(props: { open: boolean }) {
  return (
    <svg
      className={props.open ? 'rw-tok-chevron rw-tok-chevron-open' : 'rw-tok-chevron'}
      width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"
    >
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CardTokBadge(props: {
  tokens: number | undefined
  collapsible: boolean
  expanded: boolean
  floating?: boolean
  onToggle?: () => void
}) {
  if (props.tokens === undefined && !props.collapsible) return null
  const text = props.tokens !== undefined ? `${formatTokens(props.tokens)} tok` : (props.expanded ? '收起' : '展开')
  const title = props.collapsible
    ? `${props.tokens !== undefined ? `${props.tokens.toLocaleString()} RWKV token · ` : ''}${props.expanded ? '点击收起' : '点击展开全部'}`
    : `${props.tokens?.toLocaleString()} RWKV token`
  if (!props.collapsible) {
    return (
      <span className={props.floating ? 'rw-card-tok rw-card-tok-float' : 'rw-card-tok'} title={title}>
        {text}
      </span>
    )
  }
  const cls = props.floating
    ? (props.expanded ? 'rw-card-tok rw-card-tok-btn rw-card-tok-sticky' : 'rw-card-tok rw-card-tok-btn rw-card-tok-float')
    : 'rw-card-tok rw-card-tok-btn'
  return (
    <button
      type="button"
      className={cls}
      aria-expanded={props.expanded}
      title={title}
      onClick={event => {
        event.stopPropagation()
        props.onToggle?.()
      }}
    >
      <span>{text}</span>
      <TokChevron open={props.expanded} />
    </button>
  )
}

const RWKV_LOGO_PIXELS: readonly (readonly [number, number])[] = [
  [133.4, 310.04], [192.28, 310.04], [251.16, 310.04], [310.04, 310.04],
  [133.4, 368.92], [368.92, 368.92], [486.68, 368.92],
  [133.4, 427.8], [368.92, 427.8], [545.56, 427.8],
  [133.4, 486.68], [192.28, 486.68], [251.16, 486.68], [310.04, 486.68], [604.44, 486.68],
  [133.4, 545.56], [251.16, 545.56], [545.56, 545.56],
  [133.4, 604.44], [310.04, 604.44], [486.68, 604.44],
  [133.4, 663.32], [368.92, 663.32], [722.2, 663.32], [781.08, 663.32], [839.96, 663.32],
]

export function RwkvWireIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
      <rect x="40.96" y="40.96" width="942.08" height="942.08" rx="188.42" fill="#18181B" />
      <g fill="#FFFFFF">
        {RWKV_LOGO_PIXELS.map(([x, y], index) => (
          <rect key={index} x={x} y={y} width="54" height="54" rx="11" />
        ))}
      </g>
    </svg>
  )
}

export function RwkvWirePanel(props: { session?: string; sessionId?: string }) {
  const session = props.session ?? props.sessionId ?? ''
  const [snapshot, setSnapshot] = useState<LiveWireSnapshot | undefined>()
  const [connected, setConnected] = useState(false)
  const [mode, setMode] = useState<ViewMode>('model')
  const [prettyAll, setPrettyAll] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({})
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSnapshot(undefined)
    setExpandAll(false)
    setExpanded({})
    if (!session) return
    const url = `/api/rwkv/live/${encodeURIComponent(session)}`
    const source = new EventSource(url)
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.addEventListener('snapshot', event => {
      try {
        const next = JSON.parse((event as MessageEvent).data as string) as LiveWireSnapshot
        setSnapshot(next)
      } catch {
        // Ignore malformed frame.
      }
    })
    source.addEventListener('delta', event => {
      try {
        const payload = JSON.parse((event as MessageEvent).data as string) as { text: string }
        setSnapshot(current => current === undefined ? current : { ...current, streaming: true, output: current.output + payload.text })
      } catch {
        // Ignore malformed frame.
      }
    })
    source.addEventListener('done', event => {
      try {
        const payload = JSON.parse((event as MessageEvent).data as string) as { output: string; outputTokens: number; updatedAt: string }
        setSnapshot(current => current === undefined ? current : {
          ...current,
          streaming: false,
          output: payload.output,
          outputTokens: payload.outputTokens,
          updatedAt: payload.updatedAt,
        })
      } catch {
        // Ignore malformed frame.
      }
    })
    return () => {
      source.close()
      setConnected(false)
    }
  }, [session])

  const activePrompt = snapshot
    ? (mode === 'full' && snapshot.fullPrompt ? snapshot.fullPrompt : snapshot.prompt)
    : ''
  const activeBlockTokens = snapshot
    ? (mode === 'full' && snapshot.fullBlockTokens ? snapshot.fullBlockTokens : snapshot.blockTokens)
    : undefined
  const fullWire = snapshot ? `${activePrompt}${snapshot.output}` : ''
  const blocks = useMemo(() => parseWireBlocks(fullWire, mode, snapshot?.pastThinks), [fullWire, mode, snapshot?.pastThinks])

  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [fullWire, autoScroll])

  const onScroll = () => {
    const el = scrollRef.current
    if (el === null) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36
    if (!nearBottom && autoScroll) setAutoScroll(false)
    else if (nearBottom && !autoScroll) setAutoScroll(true)
  }

  const copyRaw = () => {
    if (!fullWire) return
    void navigator.clipboard?.writeText(fullWire).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const toggleCard = (key: string) => {
    if (window.getSelection()?.toString()) return
    setExpanded(cur => ({ ...cur, [key]: !(cur[key] ?? expandAll) }))
  }

  const toggleExpandAll = () => {
    setExpandAll(v => !v)
    setExpanded({})
  }

  const tokens = snapshot?.promptTokens ?? 0
  const tier = ctxTier(tokens)

  return (
    <div className="rw-root">
      <div className="rw-toolbar">
        {tokens > 0 ? (
          <span
            className={`rl-ctx rl-ctx-${tier} rw-ctx-pill`}
            title={`${snapshot?.streaming ? '实时生成中' : '已同步'} · 模型实时上下文 ${tokens.toLocaleString()} RWKV token`}
          >
            <span className={snapshot?.streaming ? 'rw-dot rw-dot-live' : connected ? 'rw-dot rw-dot-idle' : 'rw-dot'} />
            <span>{formatTokens(tokens)}</span>
          </span>
        ) : (
          <span className="rw-status">
            <span className={connected ? 'rw-dot rw-dot-idle' : 'rw-dot'} />
            <span>等待请求</span>
          </span>
        )}
        {snapshot?.fold ? (
          <span
            className="rl-cut"
            title={`${foldKindLabel(snapshot.fold.kind)}：${snapshot.fold.beforeTokens.toLocaleString()} → ${snapshot.fold.afterTokens.toLocaleString()} tok`}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ marginRight: 3, verticalAlign: '-1.5px' }}>
              <path d="M4.5 2.5L7 5L9.5 2.5M4.5 11.5L7 9L9.5 11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {formatTokens(snapshot.fold.beforeTokens)}→{formatTokens(snapshot.fold.afterTokens)}
          </span>
        ) : null}
        <div className="rw-controls">
          <span className="rw-mode-seg" role="group" aria-label="上下文视图模式">
            <button type="button" className="rw-mode-btn" aria-pressed={mode === 'model'} onClick={() => setMode('model')} title="严格显示当前模型实际看得见的内容（含空思考与折叠占位）">
              模型实时
            </button>
            <button type="button" className="rw-mode-btn" aria-pressed={mode === 'full'} onClick={() => setMode('full')} title="完整回溯视角：显示全部历史思考与被折叠的工具结果">
              全量历史
            </button>
          </span>
          <button
            type="button"
            className="rl-toggle"
            aria-pressed={expandAll}
            title={expandAll ? '收起全部长卡片与 System' : '展开全部长卡片与 System'}
            onClick={toggleExpandAll}
          >
            {expandAll ? '收起' : '全展'}
          </button>
          <button
            type="button"
            className="rl-toggle"
            aria-pressed={prettyAll}
            title="全局美化 System 工具模板与工具调用/结果 JSON（默认显示原始紧凑文本）"
            onClick={() => setPrettyAll(v => !v)}
          >
            美化
          </button>
          <button type="button" className="rl-toggle" aria-pressed={autoScroll} onClick={() => setAutoScroll(v => !v)}>
            跟底
          </button>
          <button type="button" className="rl-toggle" disabled={!fullWire} onClick={copyRaw}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      <div className="rw-legend">
        <span className="rw-swatch rw-swatch-user">User</span>
        <span className="rw-swatch rw-swatch-assistant">Assistant</span>
        <span className="rw-swatch rw-swatch-think">Think</span>
        <span className="rw-swatch rw-swatch-call">Tool Call</span>
        <span className="rw-swatch rw-swatch-result">Tool Result</span>
        <span className="rw-swatch rw-swatch-error">Error</span>
        <span className="rw-swatch rw-swatch-folded">Folded</span>
      </div>

      {!snapshot ? (
        <div className="rw-empty">
          <p className="rl-empty">发一条 RWKV 消息后，这里会实时逐字展示发给模型的原始字符级上下文。</p>
        </div>
      ) : (
        <div ref={scrollRef} className="rw-scroll" onScroll={onScroll}>
          <div className="rw-blocks">
            {blocks.map((block, blockIdx) => {
              const key = `${mode}-${blockIdx}`
              const isLast = blockIdx === blocks.length - 1
              const isLiveTail = isLast && snapshot.streaming
              const baseBlockTok = activeBlockTokens?.[blockIdx]
              const cardTokens = baseBlockTok === undefined
                ? undefined
                : isLast ? baseBlockTok + snapshot.outputTokens : baseBlockTok

              if (block.role === 'system') {
                const open = expanded[key] ?? expandAll
                if (!open) {
                  const firstLine = block.raw.split('\n')[0]?.slice(0, 72) ?? 'System:'
                  return (
                    <div
                      key={key}
                      className="rw-card rw-card-system rw-system-collapsed"
                    >
                      <span className="rw-span-label">System:</span>
                      <span className="rw-system-preview">{firstLine.replace(/^System:\s*/, '')}…</span>
                      <CardTokBadge tokens={cardTokens} collapsible expanded={false} onToggle={() => toggleCard(key)} />
                    </div>
                  )
                }
                return (
                  <div key={key} className="rw-card rw-card-system">
                    <div className="rw-card-content">
                      <div className="rw-card-body">
                        <CardTokBadge tokens={cardTokens} collapsible expanded floating onToggle={() => toggleCard(key)} />
                        {block.spans.map((span, spanIdx) => (
                          <span key={spanIdx} className={`rw-span rw-span-${span.kind}`} title={span.title}>
                            {prettyAll ? prettySpanText(span, block.role) : span.text}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              }

              const renderedSpans = prettyAll
                ? block.spans.map(span => ({ ...span, text: prettySpanText(span, block.role) }))
                : block.spans
              const renderedText = prettyAll ? renderedSpans.map(s => s.text).join('') : block.raw
              const collapsible = !isLiveTail && isLongBlock(renderedText)
              const isCollapsed = collapsible && !(expanded[key] ?? expandAll)

              return (
                <div key={key} className={`rw-card rw-card-${block.cardKind}`}>
                  <div className="rw-card-content">
                    <div className={isCollapsed ? 'rw-card-body rw-card-hardcut' : 'rw-card-body'}>
                      <CardTokBadge
                        tokens={cardTokens}
                        collapsible={collapsible}
                        expanded={!isCollapsed}
                        floating
                        onToggle={() => toggleCard(key)}
                      />
                      {renderedSpans.map((span, spanIdx) => (
                        <span key={spanIdx} className={`rw-span rw-span-${span.kind}`} title={span.title}>{span.text}</span>
                      ))}
                      {isLiveTail ? <span className="rw-cursor" aria-hidden="true">▍</span> : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
