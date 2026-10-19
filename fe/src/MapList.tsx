import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api } from './api'
import { fmtDate, useI18n } from './i18n'
import { LangSwitch } from './LangSwitch'
import { ThemeSwitch } from './ThemeSwitch'
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

// 视图模式：卡片（海报感）/ 表格（信息密度优先——扫读效率高）
type ViewMode = 'card' | 'table'

export function MapList({ onOpen }: { onOpen: (mapId: number) => void }) {
  const { t, locale } = useI18n()
  const [maps, setMaps] = useState<MapSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  // localStorage 记忆手动选择（chatOpen 同款惰性初始化），默认卡片
  const [view, setView] = useState<ViewMode>(() =>
    localStorage.getItem('mapListView') === 'table' ? 'table' : 'card',
  )
  useEffect(() => {
    localStorage.setItem('mapListView', view)
  }, [view])
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

  // 新建输入的键盘/失焦行为——卡片模式与表格模式的输入行共用同一状态机
  const onNewInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void create()
    }
    if (e.key === 'Escape') cancelCreate()
  }
  const onNewInputBlur = () => {
    if (!creatingTitle.trim()) cancelCreate()
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

  // MCP 端点按当前部署地址拼（本地/桌面版/远程自适应）；尾斜杠不能省——
  // 无斜杠的 POST /mcp 依赖服务端中间件重写到 /mcp/，部分 MCP 客户端
  // 不跟随该重写，配置时会报错（chat.py 的 SELF_MCP_URL 同款带斜杠）
  const mcpUrl = `${location.origin}/mcp/`
  const [copied, setCopied] = useState(false)
  const copyMcp = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用（非安全上下文等）——选中后手动复制 */
    }
  }

  return (
    <div className="map-list">
      <div className="list-actions">
        <LangSwitch />
        <ThemeSwitch />
      </div>
      <h1>MindMap X</h1>
      {/* 一句话定位 + MCP 端点（Agent 接入地址，点击复制） */}
      <p className="map-subtitle">
        {t('map.subtitle')}
        <br />
        <code
          className="mcp-endpoint"
          role="button"
          tabIndex={0}
          title={copied ? t('map.mcpCopied') : t('map.mcpCopy')}
          onClick={() => void copyMcp()}
          onKeyDown={(e) => e.key === 'Enter' && void copyMcp()}
        >
          {copied ? t('map.mcpCopied') : mcpUrl}
        </code>
      </p>
      <div className="search-row">
        <input
          value={query}
          placeholder={t('map.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* 卡片/表格视图切换：搜索旁（作用于同一份列表数据） */}
        <div className="view-switch" role="group" aria-label={t('map.viewAria')}>
          <button
            type="button"
            className={`btn sm${view === 'card' ? ' active' : ''}`}
            aria-pressed={view === 'card'}
            onClick={() => setView('card')}
          >
            {t('map.viewCard')}
          </button>
          <button
            type="button"
            className={`btn sm${view === 'table' ? ' active' : ''}`}
            aria-pressed={view === 'table'}
            onClick={() => setView('table')}
          >
            {t('map.viewTable')}
          </button>
        </div>
      </div>
      {error && <div className="toast">{error}</div>}
      {view === 'table' ? (
        <table className="maps-table">
          <colgroup>
            {/* fixed 布局：定宽列 + 标题列吃剩余宽（ellipsis 才可靠） */}
            <col style={{ width: 44 }} />
            <col />
            <col style={{ width: 52 }} />
            <col style={{ width: 116 }} />
            <col style={{ width: 116 }} />
            <col style={{ width: 108 }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('map.colTitle')}</th>
              <th>v</th>
              {/* ↓ 标示当前排序：最近更新从新到旧（服务端排序，暂不可点换向） */}
              <th>
                {t('map.colUpdated')} <span className="sort-mark">↓</span>
              </th>
              <th>{t('map.colCreated')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {/* 首行恒为新建（搜索中也保留，与卡片模式一致） */}
            <tr className="new-row">
              <td colSpan={6}>
                {creatingCard ? (
                  <input
                    autoFocus
                    className="new-map-input"
                    value={creatingTitle}
                    placeholder={t('map.placeholder')}
                    disabled={creating}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setCreatingTitle(e.target.value)}
                    onKeyDown={onNewInputKey}
                    onBlur={onNewInputBlur}
                  />
                ) : (
                  <button className="new-map-btn" onClick={() => setCreatingCard(true)}>
                    <PlusIcon /> {t('map.newCard')}
                  </button>
                )}
              </td>
            </tr>
            {shown.map((m) => {
              const updated = fmtDate(m.updated_at ?? m.created_at, locale)
              const created = fmtDate(m.created_at, locale)
              return (
                <tr key={m.id} onClick={() => confirmId === null && onOpen(m.id)}>
                  <td className="num">#{m.id}</td>
                  <td className="t-title" title={m.title}>
                    {m.title}
                  </td>
                  <td className="num">v{m.version}</td>
                  <td className="date updated" title={t('map.dateTip', { updated, created })}>
                    {updated}
                  </td>
                  <td className="date">{created}</td>
                  <td className="t-op">
                    {confirmId === m.id ? (
                      <button
                        className="row-del confirm"
                        onClick={(e) => { e.stopPropagation(); void del(m.id) }}
                      >
                        {t('map.deleteConfirm')}
                      </button>
                    ) : (
                      <button
                        className="row-del"
                        title={t('map.deleteThis')}
                        aria-label={t('map.deleteAria', { title: m.title })}
                        onClick={(e) => { e.stopPropagation(); askDelete(m.id) }}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
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
              onKeyDown={onNewInputKey}
              onBlur={onNewInputBlur}
            />
          </div>
        ) : (
          <button className="card new-card" onClick={() => setCreatingCard(true)}>
            <PlusIcon /> {t('map.newCard')}
          </button>
        )}
        {shown.map((m) => {
          // 右下角显示最近更新时间（与排序依据一致；无值兜底创建时间）
          const updated = fmtDate(m.updated_at ?? m.created_at, locale)
          return (
          <div key={m.id} className="card" onClick={() => confirmId === null && onOpen(m.id)}>
            {/* 左上角 ID（橙色 mono，无 #）；标题两行省略；右下角最近更新时间
                （tooltip 补创建时间）；version 只在 hover 时跟在标题后面 */}
            <span className="map-id">#{m.id}</span>
            <div className="card-title" title={m.title}>
              {m.title}
              <span className="card-ver">v{m.version}</span>
            </div>
            <span
              className="card-date"
              title={t('map.dateTip', { updated, created: fmtDate(m.created_at, locale) })}
            >
              {updated}
            </span>
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
          )
        })}
      </div>
      )}
      {/* 空态两种视图共用 */}
      {maps != null && maps.length === 0 && <p>{t('map.empty')}</p>}
    </div>
  )
}
