import { useEffect, useState } from 'react'
import { MapList } from './MapList'
import { MindMapEditor } from './MindMapEditor'

// hash 即路由：#/1 打开 map 1，空则为主列表。
// 用 hash 而非 path：hash 不发给服务器，FastAPI 的静态托管（Mount("/") 兜底）
// 无需 SPA fallback，刷新 / 分享链接 / 浏览器后退天然可用。
const mapIdFromHash = (): number | null => {
  const m = location.hash.match(/^#\/(\d+)/)
  return m ? Number(m[1]) : null
}

export default function App() {
  const [mapId, setMapId] = useState<number | null>(mapIdFromHash)

  // 后退/前进/手动改 hash 时同步视图
  useEffect(() => {
    const onHash = () => setMapId(mapIdFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 导航 = 改 hash，状态由 hashchange 事件回流（单一数据流，避免双写）
  const open = (id: number | null) => {
    location.hash = id == null ? '' : `/${id}`
  }

  return mapId == null
    ? <MapList onOpen={(id) => open(id)} />
    : <MindMapEditor mapId={mapId} onBack={() => open(null)} />
}
