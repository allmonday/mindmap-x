import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { MapSummary } from './types'

// 与 MindMapEditor 的 TrashIcon 同款（lucide trash）
const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
  </svg>
)

export function MapList({ onOpen }: { onOpen: (mapId: number) => void }) {
  const [maps, setMaps] = useState<MapSummary[] | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // 两步确认：第一次点删除只亮起「确认删除」，3s 内再点才执行
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const confirmTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    api.listMaps().then(setMaps).catch((e) => setError(String(e)))
    return () => window.clearTimeout(confirmTimer.current)
  }, [])

  const create = async () => {
    const t = title.trim()
    if (!t) return
    setCreating(true)
    try {
      const d = await api.createMap(t)
      onOpen(d.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
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

  return (
    <div className="map-list">
      <h1>MindMap X</h1>
      <div className="create-row">
        <input
          value={title}
          placeholder="新脑图标题…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <button className="btn primary" disabled={creating || !title.trim()} onClick={create}>
          创建
        </button>
      </div>
      {error && <div className="toast">{error}</div>}
      <div className="cards">
        {(maps ?? []).map((m) => (
          <div key={m.id} className="card" onClick={() => confirmId === null && onOpen(m.id)}>
            <div className="card-title">{m.title}</div>
            <div className="card-meta">
              v{m.version} · {new Date(m.created_at).toLocaleString()}
            </div>
            {confirmId === m.id ? (
              <button className="card-del confirm" onClick={(e) => { e.stopPropagation(); void del(m.id) }}>
                确认删除
              </button>
            ) : (
              <button
                className="card-del"
                title="删除此脑图"
                aria-label={`删除 ${m.title}`}
                onClick={(e) => { e.stopPropagation(); askDelete(m.id) }}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        ))}
        {maps != null && maps.length === 0 && <p>还没有脑图，先创建一张。</p>}
      </div>
    </div>
  )
}
