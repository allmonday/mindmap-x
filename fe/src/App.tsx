import { useState } from 'react'
import { MapList } from './MapList'
import { MindMapEditor } from './MindMapEditor'

export default function App() {
  const [mapId, setMapId] = useState<number | null>(null)
  return mapId == null
    ? <MapList onOpen={setMapId} />
    : <MindMapEditor mapId={mapId} onBack={() => setMapId(null)} />
}
