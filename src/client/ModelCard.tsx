// Model list cards and inline model editor for `RwkvSettings.tsx`.

import { useEffect, useState } from 'react'
import { AdapterPicker } from './AdapterPicker.tsx'
import { ComboInput, EditorActions, Field, HeadersInput, NumberInput, SelectInput, TextInput } from './fields.tsx'
import { Segment } from './Segment.tsx'
import { StatePicker, useServerModels } from './StatePicker.tsx'
import { isHttpUrl, normalizeBaseURL } from './url.ts'

export interface ModelDraft {
  id: string
  name?: string
  backend: 'lightning' | 'irwkv'
  baseURL: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
  contextWindow?: number
  stateId?: string
  adapterId?: string
  /** Legacy form of adapterId, rewritten on save. */
  adapter?: { id?: string }
  thinking?: 'off' | 'full'
  historyEmptyThink?: boolean
}

export const BLANK_MODEL: ModelDraft = { id: '', backend: 'lightning', baseURL: '', model: '', contextWindow: 32768 }

const BACKEND_LABEL = { lightning: 'rwkv_lightning', irwkv: 'iRWKV' } as const

/** Drops blank optional fields so the Host schema sees absent values, not empty strings. */
export function cleanModel(model: ModelDraft): ModelDraft {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(model)) {
    if (value === '' || value === undefined) continue
    if (key === 'adapter') {
      const id = (value as { id?: unknown }).id
      if (typeof id === 'string' && id !== '' && !model.adapterId) result.adapterId = id
      continue
    }
    if (key === 'headers' && Object.keys(value as object).length === 0) continue
    result[key] = value
  }
  return result as unknown as ModelDraft
}

function modelFailure(model: ModelDraft, others: readonly ModelDraft[]): string | undefined {
  if (!model.id.trim()) return '请填写模型 ID'
  if (!/^[A-Za-z0-9][\w.-]*$/.test(model.id.trim())) return '模型 ID 只能包含字母、数字、点、下划线和连字符'
  if (others.some(other => other.id === model.id.trim())) return `已有一个模型叫 ${model.id}`
  if (!isHttpUrl(normalizeBaseURL(model.baseURL))) return '服务地址需要是 IP:端口 或 http(s) 地址'
  if (!model.model.trim()) return '请填写上游模型 ID'
  return undefined
}

export function ModelEditor(props: {
  initial: ModelDraft
  others: readonly ModelDraft[]
  disabled: boolean
  onCancel: () => void
  onSave: (model: ModelDraft) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<ModelDraft>(props.initial)
  const [idLinked, setIdLinked] = useState(props.initial.id === '' || props.initial.id === props.initial.model)
  const [nameLinked, setNameLinked] = useState(!props.initial.name || props.initial.name === props.initial.model)
  const [modelLinked, setModelLinked] = useState(props.initial.model === '')
  const [touched, setTouched] = useState(false)
  const [headersError, setHeadersError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const set = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
    setTouched(true)
    setFailure(undefined)
  }
  const setUpstream = (value: string, byHand = true) => {
    if (byHand) setModelLinked(value.trim() === '')
    setDraft(current => ({
      ...current,
      model: value,
      ...idLinked ? { id: value.trim() } : {},
      ...nameLinked ? { name: value.trim() } : {},
    }))
    setTouched(true)
    setFailure(undefined)
  }
  const lightning = draft.backend === 'lightning'
  const connection = { baseURL: normalizeBaseURL(draft.baseURL), apiKey: draft.apiKey, headers: draft.headers }
  const server = useServerModels(connection)
  useEffect(() => {
    const first = server.models?.[0]
    if (modelLinked && first !== undefined && first !== draft.model) setUpstream(first, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.models, modelLinked])
  const modelHint = server.loading ? '正在向服务器查询模型…'
    : server.error ? `没能取到模型列表：${server.error}`
    : server.models === undefined ? '填好服务地址后会自动从服务器读取'
    : server.models.length === 0 ? '服务器没有列出模型'
    : server.models.includes(draft.model.trim()) ? undefined
    : `服务器上的模型：${server.models.join('、')}`
  const disabled = props.disabled || busy
  const invalid = modelFailure(draft, props.others) ?? headersError
  const save = async () => {
    setBusy(true)
    const ok = await props.onSave(cleanModel({ ...draft, id: draft.id.trim(), baseURL: normalizeBaseURL(draft.baseURL), model: draft.model.trim() }))
    setBusy(false)
    if (!ok) setFailure('Host 没有接受这份配置（校验失败，或配置已在别处修改），草稿已保留')
  }
  return (
    <div className="rwkv-editor">
      <div className="rwkv-editor-head">
        <span className="rwkv-editor-title">{draft.name || draft.id || '新模型'}</span>
        <span className="rwkv-editor-sub">rwkv/{draft.id || '…'}</span>
      </div>
      <Field label="后端">
        <Segment
          value={draft.backend} disabled={disabled}
          options={[['lightning', 'rwkv_lightning CUDA'], ['irwkv', 'iRWKV（vLLM）']] as const}
          onChange={value => set('backend', value)}
        />
      </Field>
      <div className="rwkv-grid">
        <Field label="服务地址"><TextInput value={draft.baseURL} disabled={disabled} placeholder="100.64.0.8:8060" onChange={value => set('baseURL', value)} /></Field>
        <Field label="上游模型 ID" hint={modelHint}>
          <ComboInput value={draft.model} options={server.models ?? []} disabled={disabled} placeholder="自动从服务器读取" align="end" onChange={value => setUpstream(value)} />
        </Field>
        <Field label="模型 ID"><TextInput value={draft.id} disabled={disabled} placeholder="默认同上游模型 ID" onChange={value => { setIdLinked(value.trim() === ''); set('id', value) }} /></Field>
        <Field label="显示名"><TextInput value={draft.name} disabled={disabled} placeholder="默认同上游模型 ID" onChange={value => { setNameLinked(value.trim() === ''); set('name', value) }} /></Field>
      </div>
      {lightning ? (
        <>
          <StatePicker
            connection={connection}
            value={draft.stateId} disabled={disabled}
            onChange={id => set('stateId', id)}
          />
          <AdapterPicker
            connection={connection}
            value={draft.adapterId ?? draft.adapter?.id} disabled={disabled}
            onChange={id => {
              set('adapterId', id)
              set('adapter', undefined)
            }}
          />
        </>
      ) : null}
      <details className="rwkv-details">
        <summary className="rwkv-summary">自定义设置</summary>
        <div className="rwkv-details-body">
          <div className="rwkv-grid">
            <Field label={lightning ? '密码' : 'API 密钥'}><TextInput type="password" value={draft.apiKey} disabled={disabled} placeholder="留空表示不需要" onChange={value => set('apiKey', value)} /></Field>
            <Field label="上下文窗口"><NumberInput value={draft.contextWindow} disabled={disabled} placeholder="32768" onChange={value => set('contextWindow', value)} /></Field>
            <Field label="思考">
              <SelectInput
                value={draft.thinking ?? ''} disabled={disabled}
                options={[['', '跟随运行参数'], ['full', '开启'], ['off', '关闭']] as const}
                onChange={value => set('thinking', value || undefined)}
              />
            </Field>
            {draft.thinking !== 'off' ? (
              <Field label="历史步骤思考">
                <SelectInput
                  value={draft.historyEmptyThink === undefined ? '' : draft.historyEmptyThink ? 'on' : 'off'} disabled={disabled}
                  options={[['', '跟随运行参数'], ['on', '历史空思考（推荐）'], ['off', '完整思考']] as const}
                  onChange={value => set('historyEmptyThink', value === '' ? undefined : value === 'on')}
                />
              </Field>
            ) : null}
            <Field label="额外请求头（JSON）" wide>
              <HeadersInput value={draft.headers} disabled={disabled} onChange={(value, error) => { setHeadersError(error); if (!error) set('headers', value) }} />
            </Field>
          </div>
        </div>
      </details>
      <EditorActions
        error={failure ?? (touched ? invalid : undefined)} busy={busy}
        canSave={!disabled && invalid === undefined}
        onCancel={props.onCancel} onSave={() => { void save() }}
      />
    </div>
  )
}

export function ModelCard(props: {
  model: ModelDraft
  editing: boolean
  others: readonly ModelDraft[]
  disabled: boolean
  onEdit: () => void
  onClose: () => void
  onSave: (model: ModelDraft) => Promise<boolean>
  onRemove: () => Promise<boolean>
}) {
  const { model } = props
  const [confirming, setConfirming] = useState(false)
  const stateId = model.backend === 'lightning' ? model.stateId : undefined
  const adapterId = model.backend === 'lightning' ? (model.adapterId ?? model.adapter?.id) : undefined
  return (
    <li className="rwkv-card">
      <div className="rwkv-head">
        <span className="rwkv-identity">
          <span className="rwkv-name">{model.name || model.id}</span>
          <span className="rwkv-tag">{BACKEND_LABEL[model.backend]}</span>
          {stateId ? <span className="rwkv-dot" title={`state ${stateId}`} /> : null}
          {adapterId ? <span className="rwkv-dot" title={`adapter ${adapterId}`} /> : null}
        </span>
        <span className="rwkv-meta">
          {model.model}
          {stateId ? ` · state ${stateId}` : ''}
          {adapterId ? ` · adapter ${adapterId}` : ''}
          {model.thinking === 'off' ? ' · 思考关' : model.historyEmptyThink === true ? ' · 历史空思考' : model.historyEmptyThink === false ? ' · 完整思考' : ''}
        </span>
        <span className="rwkv-actions">
          {props.editing ? null : confirming ? (
            <>
              <button type="button" className="rwkv-link" onClick={() => setConfirming(false)}>取消</button>
              <button type="button" className="rwkv-btn rwkv-secondary rwkv-small rwkv-danger" disabled={props.disabled} onClick={() => { void props.onRemove() }}>确认删除</button>
            </>
          ) : (
            <>
              <button type="button" className="rwkv-link" disabled={props.disabled} onClick={() => setConfirming(true)}>删除</button>
              <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={props.disabled} onClick={props.onEdit}>编辑</button>
            </>
          )}
        </span>
      </div>
      {props.editing ? <ModelEditor initial={model} others={props.others} disabled={props.disabled} onCancel={props.onClose} onSave={props.onSave} /> : null}
    </li>
  )
}
