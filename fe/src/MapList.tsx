import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { fmtTime, useI18n } from './i18n'
import { LangSwitch } from './LangSwitch'
import type { MapSummary } from './types'

// 与 MindMapEditor 的 TrashIcon 同款（lucide trash）
const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
  </svg>
)

// 新建卡片的 ＋（lucide plus）
const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14M12 5v14" />
  </svg>
)

export function MapList({ onOpen }: { onOpen: (mapId: number) => void }) {
  const { t, locale } = useI18n()
  const [maps, setMaps] = useState<MapSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 新建卡片两态：静止（虚线 ＋ 卡）↔ 输入中（卡内 input，Enter 才创建）
  const [creatingCard, setCreatingCard] = useState(false)
  const [creatingTitle, setCreatingTitle] = useState('')
  const [creating, setCreating] = useState(false)
  // 两步确认：第一次点删除只亮起「确认删除」，3s 内再点才执行
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const confirmTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    api.listMaps().then(setMaps).catch((e) => setError(String(e)))
    return () => window.clearTimeout(confirmTimer.current)
  }, [])

  const create = async () => {
    const value = creatingTitle.trim()
    if (!value || creating) return
    setCreating(true)
    try {
      const d = await api.createMap(value)
      onOpen(d.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  // 退出输入态即复位；创建是重操作，不提交半截——必须显式 Enter
  const cancelCreate = () => {
    setCreatingCard(false)
    setCreatingTitle('')
  }

  const askDelete = (id: number) => {
    setConfirmId(id)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirmId(null), 3000)
  }

  const del = async (id: number) => {
    window.clearTimeout(confirmTimer.current)
    setConfirmId(null)
    try {
      await api.deleteMap(id)
      setMaps((ms) => ms?.filter((m) => m.id !== id) ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const kw = query.trim().toLowerCase()
  const shown = (maps ?? []).filter((m) => m.title.toLowerCase().includes(kw))

  return (
    <div className="map-list">
      <LangSwitch />
      <h1>MindMap X</h1>
      <div className="search-row">
        <input
          value={query}
          placeholder={t('map.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && <div className="toast">{error}</div>}
      <div className="cards">
        {/* 第一格恒为新建卡片（搜索中也保留，随时可建） */}
        {creatingCard ? (
          <div className="card new-card editing">
            <input
              autoFocus
              value={creatingTitle}
              placeholder={t('map.placeholder')}
              disabled={creating}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setCreatingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void create()
                }
                if (e.key === 'Escape') cancelCreate()
              }}
              onBlur={() => {
                if (!creatingTitle.trim()) cancelCreate()
              }}
            />
          </div>
        ) : (
          <button className="card new-card" onClick={() => setCreatingCard(true)}>
            <PlusIcon /> {t('map.newCard')}
          </button>
        )}
        {shown.map((m) => (
          <div key={m.id} className="card" onClick={() => confirmId === null && onOpen(m.id)}>
            <div className="card-title">{m.title}</div>
            <div className="card-meta">
              v{m.version} · {fmtTime(m.created_at, locale)}
            </div>
            {confirmId === m.id ? (
              <button className="card-del confirm" onClick={(e) => { e.stopPropagation(); void del(m.id) }}>
                {t('map.deleteConfirm')}
              </button>
            ) : (
              <button
                className="card-del"
                title={t('map.deleteThis')}
                aria-label={t('map.deleteAria', { title: m.title })}
                onClick={(e) => { e.stopPropagation(); askDelete(m.id) }}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        ))}
        {maps != null && maps.length === 0 && <p>{t('map.empty')}</p>}
      </div>
    </div>
  )
}
