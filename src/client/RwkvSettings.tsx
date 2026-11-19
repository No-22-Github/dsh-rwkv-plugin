// The RWKV settings page, laid out like the native Models section: one card
// per model with an inline editor (`ModelCard.tsx`), an add card, one card for
// the run parameters, and the developer/traces section (`DeveloperPanel.tsx`).

import { useState, useSyncExternalStore } from 'react'
import {
  AGENT_FAST_SAMPLING,
  DEFAULT_ANSWER_MAX_TOKENS,
  DEFAULT_DECISION_MAX_TOKENS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_STEPS,
  DEFAULT_PROTOCOL_RETRIES,
  type SamplingDefaults,
} from '../core/defaults.ts'
import { DEVELOPER_DEFAULTS, DeveloperCard, type DeveloperSettings } from './DeveloperPanel.tsx'
import { Check, EditorActions, Field, NumberInput, same, TextInput } from './fields.tsx'
import { BLANK_MODEL, cleanModel, ModelCard, ModelEditor, type ModelDraft } from './ModelCard.tsx'
import { Segment } from './Segment.tsx'

export { Check, Field, TextInput }

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

interface RunSettings {
  thinking: 'off' | 'full'
  historyEmptyThink: boolean
  maxSteps: number
  maxConsecutiveFailures: number
  protocolRetries: number
  decisionMaxTokens: number
  answerMaxTokens: number
  sampling: SamplingDefaults
  taskContract: string
  loopGuard: boolean
  currentDate: boolean
}

type RwkvConfig = RunSettings & DeveloperSettings & { models: ModelDraft[] }

const RUN_DEFAULTS: RunSettings = {
  thinking: 'full',
  historyEmptyThink: true,
  maxSteps: DEFAULT_MAX_STEPS,
  maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
  protocolRetries: DEFAULT_PROTOCOL_RETRIES,
  decisionMaxTokens: DEFAULT_DECISION_MAX_TOKENS,
  answerMaxTokens: DEFAULT_ANSWER_MAX_TOKENS,
  sampling: AGENT_FAST_SAMPLING,
  taskContract: '',
  loopGuard: true,
  currentDate: true,
}

const RUN_FIELDS = Object.keys(RUN_DEFAULTS) as (keyof RunSettings)[]

function normalize(value: unknown): RwkvConfig {
  const config = { ...RUN_DEFAULTS, ...DEVELOPER_DEFAULTS, models: [], ...(typeof value === 'object' && value !== null ? value as Partial<RwkvConfig> : {}) }
  return { ...config, sampling: { ...AGENT_FAST_SAMPLING, ...config.sampling }, models: (config.models ?? []).map(model => ({ ...model })) }
}

function runSummary(run: RunSettings): string {
  const sampling = same(run.sampling, AGENT_FAST_SAMPLING) ? '推荐采样' : `T ${run.sampling.temperature} · top_p ${run.sampling.topP}`
  const think = run.thinking === 'off' ? '思考关' : run.historyEmptyThink ? '思考开（历史空思考）' : '思考开（完整思考）'
  return `${think} · 每轮 ${run.maxSteps} 步 · ${sampling}`
}

type ThinkChoice = 'empty' | 'full' | 'off'
type NumericRunField = 'maxSteps' | 'maxConsecutiveFailures' | 'protocolRetries' | 'decisionMaxTokens' | 'answerMaxTokens'

const isRunDefault = (run: RunSettings) => RUN_FIELDS.every(field => same(run[field], RUN_DEFAULTS[field]))

function RunEditor(props: { initial: RunSettings; disabled: boolean; onCancel: () => void; onSave: (run: RunSettings) => Promise<boolean> }) {
  const [draft, setDraft] = useState<RunSettings>(props.initial)
  const [resetKey, setResetKey] = useState(0)
  const [samplingKey, setSamplingKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const disabled = props.disabled || busy
  const update = (patch: Partial<RunSettings>) => {
    setDraft(current => ({ ...current, ...patch }))
    setFailure(undefined)
  }
  const num = (key: NumericRunField) =>
    <NumberInput key={`${key}-${resetKey}`} value={draft[key]} disabled={disabled} onChange={value => update({ [key]: value ?? RUN_DEFAULTS[key] })} />
  const sampling = (key: keyof SamplingDefaults) =>
    <NumberInput key={`${key}-${resetKey}-${samplingKey}`} value={draft.sampling[key]} disabled={disabled} onChange={value => update({ sampling: { ...draft.sampling, [key]: value ?? AGENT_FAST_SAMPLING[key] } })} />
  const save = async () => {
    setBusy(true)
    const ok = await props.onSave(draft)
    setBusy(false)
    if (!ok) setFailure('Host 没有接受这份配置，草稿已保留')
  }
  const thinkChoice: ThinkChoice = draft.thinking === 'off' ? 'off' : draft.historyEmptyThink ? 'empty' : 'full'
  return (
    <div className="rwkv-editor">
      <div className="rwkv-field">
        <div className="rwkv-block-head">
          <span className="rwkv-label">思考</span>
          <button
            type="button" className="rwkv-link" disabled={disabled || isRunDefault(draft)}
            onClick={() => { update(RUN_DEFAULTS); setResetKey(key => key + 1) }}
          >恢复默认参数</button>
        </div>
        <Segment
          value={thinkChoice} disabled={disabled}
          options={[['empty', '开 · 历史空思考'], ['full', '开 · 完整思考'], ['off', '关闭']] as const}
          onChange={value => update(value === 'off' ? { thinking: 'off' } : { thinking: 'full', historyEmptyThink: value === 'empty' })}
        />
        <p className="rwkv-hint">推荐「开 · 历史空思考」：只保留当前步思考，避免长上下文复读。</p>
      </div>
      <div className="rwkv-grid3">
        <Field label="每轮最多工具步数">{num('maxSteps')}</Field>
        <Field label="同一工具连续失败上限">{num('maxConsecutiveFailures')}</Field>
        <Field label="格式错误重问次数">{num('protocolRetries')}</Field>
      </div>
      <div className="rwkv-grid">
        <Field label="单步最多输出 (token)" hint="每次思考、调工具或正常回答的上限">{num('decisionMaxTokens')}</Field>
        <Field label="强行收尾最多输出 (token)" hint="打满步数或被拦截后强制总结的上限">{num('answerMaxTokens')}</Field>
      </div>
      <div className="rwkv-checks">
        <Check label="复读时截断生成" checked={draft.loopGuard} disabled={disabled} onChange={value => update({ loopGuard: value })} />
        <Check label="系统提示词末尾写当前日期和时区" checked={draft.currentDate} disabled={disabled} onChange={value => update({ currentDate: value })} />
      </div>

      <Field label="任务专用补充规则（Task-specific contract）" wide hint="附加在系统提示词末尾。训练数据和评测都不带这段，填了就和训练分布不一致，只用于临时试验；正式评测请留空">
        <textarea
          className="rwkv-input"
          value={draft.taskContract ?? ''}
          disabled={disabled}
          placeholder="留空 = 不附加（默认）"
          style={{ minHeight: 64 }}
          onChange={event => update({ taskContract: event.target.value })}
        />
      </Field>

      <div className="rwkv-block">
        <div className="rwkv-block-head">
          <span className="rwkv-block-title">采样</span>
          <button
            type="button" className="rwkv-link" disabled={disabled || same(draft.sampling, AGENT_FAST_SAMPLING)}
            onClick={() => { update({ sampling: AGENT_FAST_SAMPLING }); setSamplingKey(key => key + 1) }}
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

export function RwkvSettings(props: { form: ConfigFormLike; explain?: (field: string, value: unknown) => Promise<string> }) {
  const { form } = props
  const [writeError, setWriteError] = useState('')
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
              initial={BLANK_MODEL} others={config.models} disabled={disabled}
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

      <h3 className="rwkv-subtitle">开发者与轨迹</h3>
      <DeveloperCard settings={config} disabled={disabled} write={write} />
    </div>
  )
}
