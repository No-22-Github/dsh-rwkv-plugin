// DSH request messages → the harness history. Kept free of DSH runtime
// imports (types only) so it can be tested without a DSH checkout.

import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { HistoryItem } from './core/policy.ts'
import type { Args, WireTool } from './core/tools.ts'
import { BUILTIN_MAPPINGS } from './core/tools.ts'

interface BlockLike {
  readonly type: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: string
}

function textOf(content: readonly BlockLike[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push('[file]')
  }
  return parts.join('\n').trim()
}

function parseArgs(raw: string | undefined): Args {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : {}
  } catch {
    return {}
  }
}

export interface HistoryOptions {
  /** Include developer messages (DSH context snapshots, instructions) as user notes. */
  readonly includeDeveloper: boolean
}

/**
 * Converts the provider-neutral DSH history. Tool calls made under DSH names
 * are shown to the model under their RWKV names (the catalog's reverse
 * mapping), so a session switched from another model reads naturally.
 */
export function historyFromMessages(
  messages: readonly RequestMessage[],
  catalog: readonly WireTool[],
  options: HistoryOptions,
): HistoryItem[] {
  const items: HistoryItem[] = []
  const callNames = new Map<string, string>()
  const byDsh = new Map(catalog.map(tool => [tool.dshName, tool]))
  for (const message of messages) {
    const content = message.content as readonly BlockLike[]
    switch (message.role) {
      case 'system':
        break
      case 'developer': {
        const text = textOf(content)
        if (options.includeDeveloper && text) items.push({ kind: 'note', text })
        break
      }
      case 'user': {
        const text = textOf(content)
        if (!text) break
        const source = 'source' in message ? message.source as { kind?: string; form?: string } | undefined : undefined
        items.push({ kind: source?.form === 'notice' ? 'note' : 'user', text })
        break
      }
      case 'assistant': {
        const calls = content.filter(block => block.type === 'tool-call')
        if (calls.length === 0) {
          const text = textOf(content)
          if (text) items.push({ kind: 'assistant', text })
          break
        }
        for (const call of calls) {
          const dshName = call.name ?? ''
          const args = parseArgs(call.arguments)
          const wire = byDsh.get(dshName)
          const mapping = BUILTIN_MAPPINGS[dshName]
          const name = wire?.name ?? mapping?.wireName ?? dshName
          const wireArgs = wire ? wire.fromDsh(args) : mapping ? mapping.fromDsh(args) : args
          const id = call.id ?? `call-${items.length}`
          callNames.set(id, name)
          items.push({ kind: 'call', id, name, args: wireArgs })
        }
        break
      }
      case 'tool': {
        const id = String(message.toolCallId)
        items.push({
          kind: 'result',
          id,
          name: callNames.get(id) ?? 'tool',
          ok: message.isError !== true,
          text: textOf(content),
        })
        break
      }
    }
  }
  return items
}
