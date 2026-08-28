import { useEffect, useState } from 'react'
import { api } from './api'
import type { MapSummary } from './types'

export function MapList({ onOpen }: { onOpen: (mapId: number) => void }) {
  const [maps, setMaps] = useState<MapSummary[] | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api.listMaps().then(setMaps).catch((e) => setError(String(e)))
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
          <button key={m.id} className="card" onClick={() => onOpen(m.id)}>
            <div className="card-title">{m.title}</div>
            <div className="card-meta">
              v{m.version} · {new Date(m.created_at).toLocaleString()}
            </div>
          </button>
        ))}
        {maps != null && maps.length === 0 && <p>还没有脑图，先创建一张。</p>}
      </div>
    </div>
  )
}
