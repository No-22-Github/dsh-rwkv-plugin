// Reusable form field primitives for the RWKV settings page.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function ChevronIcon(props: { open?: boolean }) {
  return (
    <svg
      className={props.open ? 'rwkv-menu-chevron rwkv-menu-chevron-open' : 'rwkv-menu-chevron'}
      width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
    >
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="rwkv-menu-check" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7.25L5.75 10L11 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function useDismiss(open: boolean, ref: { current: HTMLElement | null }, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, ref, onClose])
}

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

export function ComboInput(props: {
  value: string | undefined
  options: readonly string[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  useDismiss(open, rootRef, () => setOpen(false))

  const value = props.value ?? ''
  const trimmed = value.trim()
  const exactMatch = props.options.includes(trimmed)
  const filtered = trimmed === '' || exactMatch
    ? props.options
    : props.options.filter(item => item.toLowerCase().includes(trimmed.toLowerCase()))
  const visibleOptions = filtered.length > 0 ? filtered : props.options
  const hasOptions = props.options.length > 0 && !props.disabled
  const showMenu = open && hasOptions

  const choose = (item: string) => {
    props.onChange(item)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!hasOptions) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        const currentIndex = visibleOptions.indexOf(trimmed)
        setActive(currentIndex >= 0 ? currentIndex : 0)
      } else {
        setActive(index => (index + 1) % visibleOptions.length)
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(visibleOptions.length - 1)
      } else {
        setActive(index => (index <= 0 ? visibleOptions.length - 1 : index - 1))
      }
    } else if (event.key === 'Enter' && open && active >= 0 && active < visibleOptions.length) {
      event.preventDefault()
      choose(visibleOptions[active]!)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="rwkv-combo">
      <input
        className={hasOptions ? 'rwkv-input rwkv-combo-input' : 'rwkv-input'}
        type="text"
        role="combobox"
        aria-expanded={showMenu}
        aria-controls={showMenu ? listId : undefined}
        aria-autocomplete="list"
        value={value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => { if (hasOptions) setOpen(true) }}
        onClick={() => { if (hasOptions) setOpen(true) }}
        onChange={event => {
          props.onChange(event.target.value)
          if (hasOptions) setOpen(true)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
      />
      {hasOptions ? (
        <button
          type="button"
          className="rwkv-combo-toggle"
          tabIndex={-1}
          aria-label="展开模型列表"
          onMouseDown={event => event.preventDefault()}
          onClick={() => setOpen(current => !current)}
        >
          <ChevronIcon open={showMenu} />
        </button>
      ) : null}
      {showMenu ? (
        <div
          id={listId}
          role="listbox"
          className={props.align === 'end' ? 'rwkv-menu rwkv-menu-end' : 'rwkv-menu'}
        >
          {visibleOptions.map((option, index) => {
            const selected = option === trimmed
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={selected}
                data-active={active === index ? 'true' : undefined}
                className="rwkv-menu-item"
                title={option}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="rwkv-menu-label">{option}</span>
                {selected ? <CheckIcon /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function SelectInput<T extends string>(props: {
  value: T | ''
  options: readonly (readonly [T | '', string])[]
  onChange: (value: T | '') => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  useDismiss(open, rootRef, () => setOpen(false))

  const selectedIndex = props.options.findIndex(([value]) => value === props.value)
  const currentLabel = selectedIndex >= 0 ? props.options[selectedIndex]![1] : ''
  const showMenu = open && !props.disabled

  const choose = (value: T | '') => {
    props.onChange(value)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (props.disabled) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(selectedIndex >= 0 ? selectedIndex : 0)
      } else {
        setActive(index => (index + 1) % props.options.length)
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(selectedIndex >= 0 ? selectedIndex : props.options.length - 1)
      } else {
        setActive(index => (index <= 0 ? props.options.length - 1 : index - 1))
      }
    } else if ((event.key === 'Enter' || event.key === ' ') && open && active >= 0 && active < props.options.length) {
      event.preventDefault()
      choose(props.options[active]![0])
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="rwkv-combo">
      <button
        type="button"
        role="combobox"
        aria-expanded={showMenu}
        aria-controls={showMenu ? listId : undefined}
        className="rwkv-input rwkv-select-trigger"
        disabled={props.disabled}
        onClick={() => {
          setOpen(current => !current)
          setActive(selectedIndex >= 0 ? selectedIndex : 0)
        }}
        onKeyDown={onKeyDown}
      >
        <span className="rwkv-select-value">{currentLabel}</span>
        <ChevronIcon open={showMenu} />
      </button>
      {showMenu ? (
        <div id={listId} role="listbox" className="rwkv-menu">
          {props.options.map(([value, label], index) => {
            const selected = value === props.value
            return (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={selected}
                data-active={active === index ? 'true' : undefined}
                className="rwkv-menu-item"
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(value)}
              >
                <span className="rwkv-menu-label">{label}</span>
                {selected ? <CheckIcon /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
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
