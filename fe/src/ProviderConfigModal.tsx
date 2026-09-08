import { useEffect, useState } from 'react'
import {
  chatApi,
  gateReasonText,
  ProviderConfigError,
  type ChatGateStatus,
  type ProviderConfig,
} from './api'
import { useI18n, type I18nKey } from './i18n'

/** 厂商预设（纯前端预填；DeepSeek/GLM/Kimi 等均为 OpenAI 兼容 API，后端零适配） */
const PRESETS: {
  key: string
  provider_type: 'openai' | 'anthropic'
  base_url: string
  model_hint: string
}[] = [
  { key: 'openai', provider_type: 'openai', base_url: 'https://api.openai.com/v1', model_hint: 'gpt-5.2' },
  { key: 'anthropic', provider_type: 'anthropic', base_url: 'https://api.anthropic.com', model_hint: 'claude-sonnet-4-5' },
  { key: 'deepseek', provider_type: 'openai', base_url: 'https://api.deepseek.com/v1', model_hint: 'deepseek-chat' },
  { key: 'glm', provider_type: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4', model_hint: 'glm-4.7' },
  { key: 'kimi', provider_type: 'openai', base_url: 'https://api.moonshot.cn/v1', model_hint: 'kimi-k2' },
  { key: 'ollama', provider_type: 'openai', base_url: 'http://127.0.0.1:11434/v1', model_hint: 'qwen3' },
]

interface Props {
  onClose: () => void
  /** 保存/清除成功后回调（组件内已 refetch status；父层据此关弹窗/开面板/重连） */
  onSaved: (status: ChatGateStatus) => void
}

export function ProviderConfigModal({ onClose, onSaved }: Props) {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<ProviderConfig | null>(null)
  const [presetKey, setPresetKey] = useState('custom')
  const [providerType, setProviderType] = useState<'openai' | 'anthropic'>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    chatApi
      .config()
      .then((c) => {
        setCfg(c)
        setProviderType(c.provider_type)
        setBaseUrl(c.base_url)
        setModel(c.model)
        const hit = PRESETS.find((p) => p.base_url === c.base_url)
        setPresetKey(hit ? hit.key : 'custom')
      })
      .catch((e) => setErr(e.message))
  }, [])

  const applyPreset = (key: string) => {
    setPresetKey(key)
    setNote(null)
    if (key === 'custom') return
    const p = PRESETS.find((x) => x.key === key)
    if (!p) return
    setProviderType(p.provider_type)
    setBaseUrl(p.base_url)
    if (!model) setModel(p.model_hint)
  }

  const save = async () => {
    setErr(null)
    setNote(null)
    if (!/^https?:\/\//.test(baseUrl.trim())) {
      setErr(t('chat.cfg.errBaseUrl'))
      return
    }
    if (!model.trim()) {
      setErr(t('chat.cfg.errModel'))
      return
    }
    if (!apiKey.trim() && !cfg?.api_key_masked) {
      setErr(t('chat.cfg.errKey'))
      return
    }
    setSaving(true)
    try {
      const saved = await chatApi.saveConfig({
        provider_type: providerType,
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(), // 空 = 保持旧值（服务端语义）
        model: model.trim(),
      })
      if (saved.model_unverified) setNote(t('chat.cfg.modelUnverified'))
      setApiKey('') // 不在表单里留明文
      const status = await chatApi.status()
      onSaved(status)
    } catch (e) {
      if (e instanceof ProviderConfigError && e.detail?.reason_code) {
        setErr(gateReasonText(t, e.detail.reason_code, e.detail.reason_detail ?? null))
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    if (!confirmClear) {
      setConfirmClear(true) // 二次点击确认（对齐 MapList 删除模式）
      return
    }
    setErr(null)
    setNote(null)
    try {
      await chatApi.clearConfig()
      const c = await chatApi.config()
      setCfg(c)
      setProviderType(c.provider_type)
      setBaseUrl(c.base_url)
      setModel(c.model)
      setPresetKey(PRESETS.find((p) => p.base_url === c.base_url)?.key ?? 'custom')
      setConfirmClear(false)
      const status = await chatApi.status()
      onSaved(status)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const keyPlaceholder = cfg?.api_key_masked
    ? t('chat.cfg.keyKeep', { masked: cfg.api_key_masked })
    : t('chat.cfg.keyPlaceholder')

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body cfg" onClick={(e) => e.stopPropagation()}>
        <h3>{t('chat.cfg.title')}</h3>
        <div className="cfg-form">
          <label>{t('chat.cfg.preset')}</label>
          <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {t(`chat.cfg.preset.${p.key}` as I18nKey)}
              </option>
            ))}
            <option value="custom">{t('chat.cfg.preset.custom')}</option>
          </select>

          <label>{t('chat.cfg.style')}</label>
          <select
            value={providerType}
            onChange={(e) => setProviderType(e.target.value as 'openai' | 'anthropic')}
          >
            <option value="openai">{t('chat.cfg.styleOpenai')}</option>
            <option value="anthropic">{t('chat.cfg.styleAnthropic')}</option>
          </select>

          <label>{t('chat.cfg.baseUrl')}</label>
          <input
            className="cfg-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
          />

          <label>{t('chat.cfg.apiKey')}</label>
          <input
            className="cfg-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={keyPlaceholder}
            spellCheck={false}
          />

          <label>{t('chat.cfg.model')}</label>
          <input
            className="cfg-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={presetKey !== 'custom' ? PRESETS.find((p) => p.key === presetKey)?.model_hint : 'model-id'}
            spellCheck={false}
          />
        </div>

        {err && <p className="cfg-error">{err}</p>}
        {note && <p className="cfg-note">{note}</p>}
        {cfg?.source === 'env' && <p className="cfg-hint">{t('chat.cfg.sourceEnv')}</p>}
        {cfg?.source === 'file' && cfg.updated_at && (
          <p className="cfg-hint">{t('chat.cfg.sourceFile', { time: cfg.updated_at })}</p>
        )}

        <div className="modal-actions">
          {cfg?.source === 'file' && (
            <button className="btn danger" onClick={clear} disabled={saving}>
              {confirmClear ? t('chat.cfg.clearConfirm') : t('chat.cfg.clear')}
            </button>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? t('chat.cfg.saving') : t('chat.cfg.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
