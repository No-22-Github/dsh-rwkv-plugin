// Reusable form field primitives for the RWKV settings page.

import { useState, type ReactNode } from 'react'

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function Field(props: { label: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className={props.wide ? 'rwkv-field rwkv-wide' : 'rwkv-field'}>
      <span className="rwkv-label">{props.label}</span>
      {props.children}
      {props.hint ? <p className="rwkv-hint">{props.hint}</p> : null}
    </label>
  )
}

export function TextInput(props: {
  value: string | undefined
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  list?: string
}) {
  return (
    <input
      className="rwkv-input" type={props.type ?? 'text'} value={props.value ?? ''} placeholder={props.placeholder} list={props.list}
      disabled={props.disabled} spellCheck={false} autoComplete="off"
      onChange={event => props.onChange(event.target.value)}
    />
  )
}

/** Numbers are edited as text so a half-typed "0." survives; the parsed value is reported when valid. */
export function NumberInput(props: {
  value: number | undefined
  onChange: (value: number | undefined) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value))
  return (
    <input
      className="rwkv-input" inputMode="decimal" value={text} placeholder={props.placeholder} disabled={props.disabled}
      onChange={event => {
        const next = event.target.value
        setText(next)
        const parsed = Number(next)
        if (next.trim() === '') props.onChange(undefined)
        else if (Number.isFinite(parsed)) props.onChange(parsed)
      }}
    />
  )
}

export function SelectInput<T extends string>(props: {
  value: T | ''
  options: readonly (readonly [T | '', string])[]
  onChange: (value: T | '') => void
  disabled?: boolean
}) {
  return (
    <select className="rwkv-input rwkv-select" value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.target.value as T | '')}>
      {props.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  )
}

export function Check(props: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="rwkv-check">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={event => props.onChange(event.target.checked)} />
      {props.label}
    </label>
  )
}

export function HeadersInput(props: {
  value: Record<string, string> | undefined
  onChange: (value: Record<string, string> | undefined, error?: string) => void
  disabled?: boolean
}) {
  const [text, setText] = useState(() => props.value && Object.keys(props.value).length > 0 ? JSON.stringify(props.value, null, 2) : '')
  return (
    <textarea
      className="rwkv-input" value={text} disabled={props.disabled} spellCheck={false}
      placeholder={'{"CF-Access-Client-Id": "…", "CF-Access-Client-Secret": "…"}'}
      onChange={event => {
        setText(event.target.value)
        if (event.target.value.trim() === '') return props.onChange(undefined)
        try {
          const parsed: unknown = JSON.parse(event.target.value)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('需要一个 JSON 对象')
          props.onChange(Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])))
        } catch (cause) {
          props.onChange(undefined, `请求头不是有效的 JSON：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }}
    />
  )
}

export function EditorActions(props: {
  error?: string | undefined
  busy: boolean
  canSave: boolean
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <div className="rwkv-editor-actions">
      {props.error ? <p className="rwkv-error">{props.error}</p> : null}
      <button type="button" className="rwkv-btn rwkv-secondary" disabled={props.busy} onClick={props.onCancel}>取消</button>
      <button type="button" className="rwkv-btn rwkv-primary" disabled={props.busy || !props.canSave} onClick={props.onSave}>
        {props.busy ? '保存中…' : '保存'}
      </button>
    </div>
  )
}
