// Action parser with the RWKV-Agent repairs, ported from internal/agent
// (protocol_g1.go Parse, protocol_g1_experiments.go recover-preamble and
// normalizeG1CallPayload, wire/framing.go).

import { EXIT_TOOL_NAME, type Args } from './tools.ts'

export type FinishReason = 'stop' | 'length' | 'cancelled' | 'unknown'

export type ParseErrorKind = 'unclosed-think' | 'length' | 'decode' | 'shape' | 'empty'

export type Action =
  | { readonly type: 'tool'; readonly name: string; readonly args: Args; readonly repairs: readonly string[] }
  | { readonly type: 'exit'; readonly answer: string; readonly repairs: readonly string[] }
  | { readonly type: 'final'; readonly text: string }
  | { readonly type: 'error'; readonly kind: ParseErrorKind; readonly message: string }

const LEADING_THINK = /^\s*(?:<think>[\s\S]*?<\/think>\s*)+/

/** Removes complete leading think blocks; an unterminated block stays for the caller to judge. */
export function stripLeadingThinkBlocks(text: string): string {
  const match = LEADING_THINK.exec(text)
  return match ? text.slice(match[0].length).trim() : text
}

/** Drops the lone ">" that closes a withheld think prefix when a tool envelope follows. */
export function trimWithheldOpening(text: string): string {
  if (!text.startsWith('>')) return text
  const rest = text.slice(1).trim()
  return rest.startsWith('<tool_call') ? rest : text
}

/** Reasoning text of a leading think block, open or closed. */
export function extractThinking(text: string): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('<think>')) return ''
  const end = trimmed.indexOf('</think>')
  return (end < 0 ? trimmed.slice(7) : trimmed.slice(7, end)).trim()
}

function envelopeContent(candidate: string, open: string, close: string): { content: string; closed: boolean } {
  const content = candidate.slice(open.length)
  if (content.trimEnd().endsWith(close)) {
    return { content: content.trimEnd().slice(0, -close.length).trim(), closed: true }
  }
  return { content: content.trim(), closed: false }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Deliberately narrow: extra closing braces after a complete object only. */
export function repairExtraBraces(value: string): string {
  let trimmed = value.trim()
  while (trimmed.endsWith('}')) {
    trimmed = trimmed.slice(0, -1).trim()
    if (tryParse(trimmed) !== undefined) return trimmed
  }
  return value
}

interface Call {
  name: string
  args: unknown
  repairs: string[]
}

/**
 * Decodes one call payload, accepting the near-misses G1 checkpoints emit:
 * stray closing braces, the OpenAI {"type":"function","function":{...}}
 * wrapper, stringified arguments, key aliases, arguments lifted to top level.
 */
export function decodeCallPayload(payload: string): Call | undefined {
  const repairs: string[] = []
  let parsed = tryParse(payload)
  if (parsed === undefined) {
    const fixed = repairExtraBraces(payload)
    if (fixed !== payload) {
      parsed = tryParse(fixed)
      if (parsed !== undefined) repairs.push('json_repaired')
    }
  }
  if (Array.isArray(parsed) && parsed.length === 1) {
    parsed = parsed[0]
    repairs.push('array_unwrapped')
  }
  if (!isObject(parsed)) return undefined
  let object = parsed
  if (object.name === undefined && isObject(object.function)) {
    object = object.function
    repairs.push('function_wrapper')
  }
  let name = object.name ?? object.tool ?? object.cmd ?? object.function
  if (object.name === undefined && name !== undefined) repairs.push('name_alias')
  let args: unknown = object.arguments ?? object.args ?? object.parameters ?? object.input
  if (object.arguments === undefined && args !== undefined) repairs.push('arguments_alias')
  if (args === undefined && typeof name === 'string') {
    const lifted = Object.fromEntries(Object.entries(object).filter(([key]) =>
      !['name', 'tool', 'cmd', 'function', 'type', 'id'].includes(key)))
    if (Object.keys(lifted).length > 0) {
      args = lifted
      repairs.push('arguments_lifted')
    } else {
      args = {}
    }
  }
  if (name === undefined && typeof object.path === 'string') {
    name = 'read_file'
    args = { path: object.path }
    repairs.push('path_argument')
  }
  if (typeof args === 'string') {
    const inner = tryParse(args)
    if (isObject(inner)) {
      args = inner
      repairs.push('stringified_arguments')
    }
  }
  if (typeof name !== 'string') return undefined
  let resolved = name.trim()
  if (resolved === 'reader' || resolved === 'file_reader') {
    resolved = 'read_file'
    repairs.push('tool_renamed')
  }
  return { name: resolved, args, repairs }
}

function exitAnswer(args: Record<string, unknown>): string {
  for (const key of ['reason', 'answer', 'response', 'text']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function callAction(call: Call, extra: string[] = []): Action {
  if (call.name === '' || !isObject(call.args)) {
    return { type: 'error', kind: 'shape', message: 'invalid G1 tool call' }
  }
  const repairs = [...call.repairs, ...extra]
  if (call.name === EXIT_TOOL_NAME) return { type: 'exit', answer: exitAnswer(call.args), repairs }
  return { type: 'tool', name: call.name, args: call.args, repairs }
}

/**
 * recover-preamble (harness default since v25): one sentence, a newline, then
 * one complete call. Only a single standalone call at the tail is accepted;
 * quoted examples, multiple calls, fenced text and truncated output are not.
 */
function recoverPreamble(value: string, finish: FinishReason): Action | undefined {
  if (finish === 'length') return undefined
  const candidate = trimWithheldOpening(stripLeadingThinkBlocks(value.trim()))
  if (candidate.startsWith('<think>')) return undefined
  const opens = candidate.split('<tool_call>').length - 1
  if (opens !== 1) return undefined
  const index = candidate.indexOf('<tool_call>')
  if (index === 0 || candidate[index - 1] !== '\n') return undefined
  if (candidate.slice(0, index).includes('```')) return undefined
  const { content } = envelopeContent(candidate.slice(index), '<tool_call>', '</tool_call>')
  const call = decodeCallPayload(content)
  if (call === undefined || call.name === '' || call.name === 'TOOL_NAME' || !isObject(call.args)) return undefined
  return callAction(call, ['preamble_stripped'])
}

/** Compact self-closing call some checkpoints emit: <read_file path="a.txt"/>. */
function parseLegacyXMLCall(value: string): Action | undefined {
  let candidate = value.trim()
  if (candidate.startsWith('>')) candidate = candidate.slice(1).trim()
  const match = /^<([A-Za-z_][\w-]*)((?:\s+[A-Za-z_][\w-]*="[^"]*")*)\s*\/>$/.exec(candidate)
  if (!match) return undefined
  const args: Record<string, string> = {}
  for (const attribute of match[2]!.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) {
    args[attribute[1]!] = attribute[2]!
  }
  const name = match[1]!
  if (name === 'read_file' && args.file_path !== undefined && args.path === undefined) {
    args.path = args.file_path
    delete args.file_path
  }
  return callAction({ name, args, repairs: ['legacy_xml_call'] })
}

export function parseAction(value: string, finish: FinishReason): Action {
  const recovered = recoverPreamble(value, finish)
  if (recovered !== undefined) return recovered
  let candidate = stripLeadingThinkBlocks(value.trim())
  if (finish === 'length') {
    return candidate.startsWith('<think>')
      ? { type: 'error', kind: 'unclosed-think', message: 'reasoning never closed' }
      : { type: 'error', kind: 'length', message: 'output token limit' }
  }
  if (candidate.startsWith('<think>')) {
    return { type: 'error', kind: 'unclosed-think', message: 'reasoning never closed' }
  }
  candidate = trimWithheldOpening(candidate)
  if (candidate.startsWith('<tool_call>')) {
    const { content, closed } = envelopeContent(candidate, '<tool_call>', '</tool_call>')
    if (!closed && finish !== 'stop') {
      return { type: 'error', kind: 'decode', message: 'incomplete tool call envelope' }
    }
    const call = decodeCallPayload(content)
    if (call === undefined) return { type: 'error', kind: 'decode', message: 'tool call JSON did not decode' }
    return callAction(call)
  }
  if (candidate.startsWith('<answer>')) {
    const { content } = envelopeContent(candidate, '<answer>', '</answer>')
    return content === ''
      ? { type: 'error', kind: 'empty', message: 'empty answer' }
      : { type: 'final', text: content }
  }
  if (candidate === '') return { type: 'error', kind: 'empty', message: 'empty model response' }
  if (candidate.startsWith('</tool_call>')) {
    return { type: 'error', kind: 'shape', message: 'unexpected tool call closing tag' }
  }
  // The model may echo the result envelope around its own action.
  for (const open of ['<tool_response>', '<tool_result>']) {
    if (candidate.startsWith(open)) {
      const { content } = envelopeContent(candidate, open, `</${open.slice(1)}`)
      if (content !== '') {
        const inner = parseAction(content, finish)
        if (inner.type === 'tool' || inner.type === 'exit') {
          return { ...inner, repairs: ['envelope_recovered', ...inner.repairs] }
        }
        return inner
      }
    }
  }
  if (candidate.includes('<tool_calls>')) {
    const { content } = envelopeContent(candidate.slice(candidate.indexOf('<tool_calls>')), '<tool_calls>', '</tool_calls>')
    const call = decodeCallPayload(content)
    if (call !== undefined) return callAction(call, ['envelope_recovered'])
  }
  const legacy = parseLegacyXMLCall(candidate)
  if (legacy !== undefined) return legacy
  // JSON outside a <tool_call> envelope is text: a user who asks for JSON gets it.
  return { type: 'final', text: candidate }
}

/** Whether text after the last <tool_call> is a real call rather than a quoted template. */
export function endsWithCompleteCall(text: string): boolean {
  const index = text.lastIndexOf('<tool_call>')
  if (index < 0) return false
  const call = decodeCallPayload(text.slice(index + '<tool_call>'.length).trim())
  return call !== undefined && call.name !== '' && call.name !== 'TOOL_NAME' && call.name !== '...' && isObject(call.args)
}

export function thinkOpen(text: string): boolean {
  return (text.match(/<think/g) ?? []).length > (text.match(/<\/think>/g) ?? []).length
}

/** Final-answer clean-up: leftover think block, trailing role labels the stop did not catch. */
export function cleanFinalText(text: string): string {
  let result = stripLeadingThinkBlocks(text.trim())
  const role = /\n\s*(?:User|System|Assistant|Tool)\s*[:：]/.exec(result)
  if (role) result = result.slice(0, role.index)
  return result.replace(/✿.*$/s, '').trim()
}
