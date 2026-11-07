// The RWKV settings page, laid out like the native Models section: one card
// per model with an inline editor, an add card, and one card for the run
// parameters. Each editor saves on its own through the shared config form;
// every field is volatile, so the next request already uses the saved value.

import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { AdapterPicker } from './AdapterPicker.tsx'
import { DEVELOPER_DEFAULTS, DeveloperCard, type DeveloperSettings } from './DeveloperPanel.tsx'

interface ConfigFormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: unknown
  revision: number | undefined
  writable: boolean
}

export interface ConfigFormLike {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

interface ModelDraft {
  id: string
  name?: string
  backend: 'lightning' | 'irwkv'
  baseURL: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
  contextWindow?: number
  stateId?: string
  adapter?: { id?: string; file?: string; serverPath?: string }
  thinking?: 'off' | 'full'
  historyEmptyThink?: boolean
}

interface Sampling {
  temperature: number
  topK: number
  topP: number
  presencePenalty: number
  frequencyPenalty: number
  penaltyDecay: number
}

interface RunSettings {
  thinking: 'off' | 'full'
  historyEmptyThink: boolean
  maxSteps: number
  maxConsecutiveFailures: number
  protocolRetries: number
  decisionMaxTokens: number
  answerMaxTokens: number
  maxResultChars: number
  sampling: Sampling
  loopGuard: boolean
  currentDate: boolean
}

type RwkvConfig = RunSettings & DeveloperSettings & { models: ModelDraft[] }

const AGENT_FAST: Sampling = { temperature: 0.3, topK: 65536, topP: 0.5, presencePenalty: 0.5, frequencyPenalty: 0.1, penaltyDecay: 0.996 }

const RUN_DEFAULTS: RunSettings = {
  thinking: 'full',
  historyEmptyThink: true,
  maxSteps: 12,
  maxConsecutiveFailures: 2,
  protocolRetries: 2,
  decisionMaxTokens: 4096,
  answerMaxTokens: 4096,
  maxResultChars: 12000,
  sampling: AGENT_FAST,
  loopGuard: true,
  currentDate: true,
}

const RUN_FIELDS = Object.keys(RUN_DEFAULTS) as (keyof RunSettings)[]

function normalize(value: unknown): RwkvConfig {
  const config = { ...RUN_DEFAULTS, ...DEVELOPER_DEFAULTS, models: [], ...(typeof value === 'object' && value !== null ? value as Partial<RwkvConfig> : {}) }
  return { ...config, sampling: { ...AGENT_FAST, ...config.sampling }, models: (config.models ?? []).map(model => ({ ...model })) }
}

/** Drops blank optional fields so the Host schema sees absent values, not empty strings. */
function cleanModel(model: ModelDraft): ModelDraft {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(model)) {
    if (value === '' || value === undefined) continue
    if (key === 'adapter') {
      const adapter = Object.fromEntries(Object.entries(value as object).filter(([, item]) => item !== '' && item !== undefined))
      if (typeof adapter.id === 'string' && adapter.id !== '') result.adapter = adapter
      continue
    }
    if (key === 'headers' && Object.keys(value as object).length === 0) continue
    result[key] = value
  }
  return result as unknown as ModelDraft
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// ── field primitives ──────────────────────────────────────────────────────

export function Field(props: { label: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className={props.wide ? 'rwkv-field rwkv-wide' : 'rwkv-field'}>
      <span className="rwkv-label">{props.label}</span>
      {props.children}
      {props.hint ? <p className="rwkv-hint">{props.hint}</p> : null}
    </label>
  )
}

export function TextInput(props: { value: string | undefined; onChange: (value: string) => void; placeholder?: string; type?: string; disabled?: boolean }) {
  return (
    <input
      className="rwkv-input" type={props.type ?? 'text'} value={props.value ?? ''} placeholder={props.placeholder}
      disabled={props.disabled} spellCheck={false} autoComplete="off"
      onChange={event => props.onChange(event.target.value)}
    />
  )
}

/** Numbers are edited as text so a half-typed "0." survives; the parsed value is reported when valid. */
function NumberInput(props: { value: number | undefined; onChange: (value: number | undefined) => void; placeholder?: string; disabled?: boolean }) {
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

function SelectInput<T extends string>(props: { value: T | ''; options: readonly (readonly [T | '', string])[]; onChange: (value: T | '') => void; disabled?: boolean }) {
  return (
    <select className="rwkv-input rwkv-select" value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.target.value as T | '')}>
      {props.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  )
}

function Segment<T extends string>(props: { value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className="rwkv-segment" role="group">
      {props.options.map(([value, label]) => (
        <button key={value} type="button" aria-pressed={props.value === value} disabled={props.disabled} onClick={() => props.onChange(value)}>{label}</button>
      ))}
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

function HeadersInput(props: { value: Record<string, string> | undefined; onChange: (value: Record<string, string> | undefined, error?: string) => void; disabled?: boolean }) {
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

function EditorActions(props: { error?: string | undefined; busy: boolean; canSave: boolean; onCancel: () => void; onSave: () => void }) {
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

// ── model card ────────────────────────────────────────────────────────────

const BACKEND_LABEL = { lightning: 'rwkv_lightning', irwkv: 'iRWKV' } as const

function modelFailure(model: ModelDraft, others: readonly ModelDraft[]): string | undefined {
  if (!model.id.trim()) return '请填写模型 ID'
  if (!/^[A-Za-z0-9][\w.-]*$/.test(model.id.trim())) return '模型 ID 只能包含字母、数字、点、下划线和连字符'
  if (others.some(other => other.id === model.id.trim())) return `已有一个模型叫 ${model.id}`
  if (!isHttpUrl(model.baseURL.trim())) return '服务地址需要是 http(s) 地址'
  if (!model.model.trim()) return '请填写上游模型 ID'
  return undefined
}

function ModelEditor(props: {
  initial: ModelDraft
  others: readonly ModelDraft[]
  disabled: boolean
  onCancel: () => void
  onSave: (model: ModelDraft) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<ModelDraft>(props.initial)
  // Model ID and display name follow the upstream model ID until edited by hand.
  const [idLinked, setIdLinked] = useState(props.initial.id === '' || props.initial.id === props.initial.model)
  const [nameLinked, setNameLinked] = useState(!props.initial.name || props.initial.name === props.initial.model)
  const [touched, setTouched] = useState(false)
  const [headersError, setHeadersError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const set = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
    setTouched(true)
    setFailure(undefined)
  }
  const setUpstream = (value: string) => {
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
  const disabled = props.disabled || busy
  const invalid = modelFailure(draft, props.others) ?? headersError
  const save = async () => {
    setBusy(true)
    const ok = await props.onSave(cleanModel({ ...draft, id: draft.id.trim(), baseURL: draft.baseURL.trim(), model: draft.model.trim() }))
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
        <Field label="上游模型 ID"><TextInput value={draft.model} disabled={disabled} placeholder="rwkv7-g1l-7.2b" onChange={setUpstream} /></Field>
        <Field label="服务地址"><TextInput value={draft.baseURL} disabled={disabled} placeholder="http://host:8000" onChange={value => set('baseURL', value)} /></Field>
        <Field label="模型 ID"><TextInput value={draft.id} disabled={disabled} placeholder="默认同上游模型 ID" onChange={value => { setIdLinked(value.trim() === ''); set('id', value) }} /></Field>
        <Field label="显示名"><TextInput value={draft.name} disabled={disabled} placeholder="默认同上游模型 ID" onChange={value => { setNameLinked(value.trim() === ''); set('name', value) }} /></Field>
      </div>
      {lightning ? (
        <AdapterPicker
          connection={{ baseURL: draft.baseURL, apiKey: draft.apiKey, headers: draft.headers }}
          value={draft.adapter?.id} disabled={disabled}
          onChange={id => set('adapter', id ? { id } : undefined)}
        />
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
            <Field label="历史步骤不带思考">
              <SelectInput
                value={draft.historyEmptyThink === undefined ? '' : draft.historyEmptyThink ? 'on' : 'off'} disabled={disabled}
                options={[['', '跟随运行参数'], ['on', '开'], ['off', '关']] as const}
                onChange={value => set('historyEmptyThink', value === '' ? undefined : value === 'on')}
              />
            </Field>
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

function ModelCard(props: {
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
  const adapterId = model.backend === 'lightning' ? model.adapter?.id : undefined
  return (
    <li className="rwkv-card">
      <div className="rwkv-head">
        <span className="rwkv-identity">
          <span className="rwkv-name">{model.name || model.id}</span>
          <span className="rwkv-tag">{BACKEND_LABEL[model.backend]}</span>
          {adapterId ? <span className="rwkv-dot" title={`adapter ${adapterId}`} /> : null}
        </span>
        <span className="rwkv-meta">{model.model}{adapterId ? ` · ${adapterId}` : ''}</span>
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

// ── run parameters ────────────────────────────────────────────────────────

function runSummary(run: RunSettings): string {
  const sampling = same(run.sampling, AGENT_FAST) ? '推荐采样' : `T ${run.sampling.temperature} · top_p ${run.sampling.topP}`
  return `思考${run.thinking === 'full' ? '开' : '关'} · 每轮 ${run.maxSteps} 步 · ${sampling}`
}

type NumericRunField = 'maxSteps' | 'maxConsecutiveFailures' | 'protocolRetries' | 'decisionMaxTokens' | 'answerMaxTokens' | 'maxResultChars'

function RunEditor(props: { initial: RunSettings; disabled: boolean; onCancel: () => void; onSave: (run: RunSettings) => Promise<boolean> }) {
  const [draft, setDraft] = useState<RunSettings>(props.initial)
  const [samplingKey, setSamplingKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const disabled = props.disabled || busy
  const update = (patch: Partial<RunSettings>) => {
    setDraft(current => ({ ...current, ...patch }))
    setFailure(undefined)
  }
  const num = (key: NumericRunField) =>
    <NumberInput value={draft[key]} disabled={disabled} onChange={value => update({ [key]: value ?? RUN_DEFAULTS[key] })} />
  const sampling = (key: keyof Sampling) =>
    <NumberInput key={`${key}-${samplingKey}`} value={draft.sampling[key]} disabled={disabled} onChange={value => update({ sampling: { ...draft.sampling, [key]: value ?? AGENT_FAST[key] } })} />
  const save = async () => {
    setBusy(true)
    const ok = await props.onSave(draft)
    setBusy(false)
    if (!ok) setFailure('Host 没有接受这份配置，草稿已保留')
  }
  return (
    <div className="rwkv-editor">
      <Field label="思考">
        <Segment
          value={draft.thinking} disabled={disabled}
          options={[['full', '开启'], ['off', '关闭']] as const}
          onChange={value => update({ thinking: value })}
        />
      </Field>
      <div className="rwkv-grid3">
        <Field label="每轮最多工具步数">{num('maxSteps')}</Field>
        <Field label="同一工具连续失败上限">{num('maxConsecutiveFailures')}</Field>
        <Field label="格式错误重问次数">{num('protocolRetries')}</Field>
        <Field label="决策步 max tokens">{num('decisionMaxTokens')}</Field>
        <Field label="作答 max tokens">{num('answerMaxTokens')}</Field>
        <Field label="工具结果最多字符">{num('maxResultChars')}</Field>
      </div>
      <div className="rwkv-checks">
        <Check label="历史步骤不带思考" checked={draft.historyEmptyThink} disabled={disabled} onChange={value => update({ historyEmptyThink: value })} />
        <Check label="复读时截断生成" checked={draft.loopGuard} disabled={disabled} onChange={value => update({ loopGuard: value })} />
        <Check label="系统提示词末尾写当前日期和时区" checked={draft.currentDate} disabled={disabled} onChange={value => update({ currentDate: value })} />
      </div>

      <div className="rwkv-block">
        <div className="rwkv-block-head">
          <span className="rwkv-block-title">采样</span>
          <button
            type="button" className="rwkv-link" disabled={disabled || same(draft.sampling, AGENT_FAST)}
            onClick={() => { update({ sampling: AGENT_FAST }); setSamplingKey(key => key + 1) }}
          >恢复推荐参数</button>
        </div>
        <div className="rwkv-grid3">
          <Field label="temperature">{sampling('temperature')}</Field>
          <Field label="top_p">{sampling('topP')}</Field>
          <Field label="top_k">{sampling('topK')}</Field>
          <Field label="presence penalty">{sampling('presencePenalty')}</Field>
          <Field label="frequency penalty">{sampling('frequencyPenalty')}</Field>
          <Field label="penalty decay">{sampling('penaltyDecay')}</Field>
        </div>
      </div>

      <EditorActions error={failure} busy={busy} canSave={!disabled} onCancel={props.onCancel} onSave={() => { void save() }} />
    </div>
  )
}

// ── page ──────────────────────────────────────────────────────────────────

const BLANK: ModelDraft = { id: '', backend: 'lightning', baseURL: '', model: '', contextWindow: 32768 }

export function RwkvSettings(props: { form: ConfigFormLike; explain?: (field: string, value: unknown) => Promise<string> }) {
  const { form } = props
  const [writeError, setWriteError] = useState('')
  /**
   * Writes one field; on refusal shows the Host's reason. After a refused
   * write the shared form re-reads Host state, and that re-read can stall,
   * so a write still pending after a few seconds is reported the same way.
   */
  const write = async (field: string, value: unknown): Promise<boolean> => {
    setWriteError('')
    const settled = await Promise.race([
      form.set(field, value),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 8000)),
    ])
    if (settled === true) return true
    const reason = await props.explain?.(field, value)
    if (settled === 'timeout' && !reason) return true
    setWriteError(`保存失败${reason ? `：${reason}` : ''}`)
    return false
  }
  const getSnapshot = () => form.getSnapshot()
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), getSnapshot, getSnapshot)
  const [editing, setEditing] = useState<number | 'new' | 'run' | undefined>()

  if (snapshot.status === 'loading') return <div className="rwkv-section"><p className="rwkv-intro">加载中…</p></div>
  if (snapshot.status === 'unavailable') return <div className="rwkv-section"><p className="rwkv-intro">rwkv-llm 插件当前没有加载，暂时无法配置。</p></div>

  const config = normalize(snapshot.value)
  const disabled = !snapshot.writable
  const saveModels = async (models: ModelDraft[]) => {
    const ok = await write('models', models.map(cleanModel))
    if (ok) setEditing(undefined)
    return ok
  }
  const saveRun = async (run: RunSettings) => {
    for (const field of RUN_FIELDS) {
      if (same(run[field], config[field])) continue
      if (!await write(field, run[field])) return false
    }
    setEditing(undefined)
    return true
  }

  return (
    <div className="rwkv-section">
      <h2 className="rwkv-title">RWKV Agent</h2>
      <p className="rwkv-intro">通过续写接口接入的 RWKV-7 G1 模型。每个模型都会出现在模型选择的「RWKV」下，也可以作为子 Agent 工具 rwkv_agent 的执行模型。</p>
      {disabled ? <p className="rwkv-hint">本部署的设置是只读的。</p> : null}
      {writeError ? <p className="rwkv-error">{writeError}</p> : null}

      <ul className="rwkv-rows">
        {config.models.map((model, index) => (
          <ModelCard
            key={`${model.id}-${index}`}
            model={model}
            editing={editing === index}
            others={config.models.filter((_, at) => at !== index)}
            disabled={disabled || (editing !== undefined && editing !== index)}
            onEdit={() => setEditing(index)}
            onClose={() => setEditing(undefined)}
            onSave={next => saveModels(config.models.map((item, at) => at === index ? next : item))}
            onRemove={() => saveModels(config.models.filter((_, at) => at !== index))}
          />
        ))}
        {editing === 'new' ? (
          <li className="rwkv-card">
            <ModelEditor
              initial={BLANK} others={config.models} disabled={disabled}
              onCancel={() => setEditing(undefined)}
              onSave={model => saveModels([...config.models, model])}
            />
          </li>
        ) : (
          <li>
            <button type="button" className="rwkv-add" disabled={disabled || editing !== undefined} onClick={() => setEditing('new')}>
              <span aria-hidden="true" className="rwkv-plus">+</span>添加模型
            </button>
          </li>
        )}
      </ul>

      <h3 className="rwkv-subtitle">运行参数</h3>
      <div className="rwkv-card">
        <div className="rwkv-head">
          <span className="rwkv-identity"><span className="rwkv-name">Agent 循环与采样</span></span>
          <span className="rwkv-meta">{runSummary(config)}</span>
          <span className="rwkv-actions">
            {editing === 'run' ? null : (
              <button type="button" className="rwkv-btn rwkv-secondary rwkv-small" disabled={disabled || editing !== undefined} onClick={() => setEditing('run')}>编辑</button>
            )}
          </span>
        </div>
        {editing === 'run' ? <RunEditor initial={config} disabled={disabled} onCancel={() => setEditing(undefined)} onSave={saveRun} /> : null}
      </div>

      <DeveloperCard settings={config} disabled={disabled} write={write} />
    </div>
  )
}
