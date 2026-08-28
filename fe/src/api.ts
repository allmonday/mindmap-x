// REST 封装：浏览器端所有操作显式声明 actor='human'（Agent 端默认 'agent'）
// 节点 ID 参数均为 map 内 display_id（每图从 1 起）
import type { MapDetail, MapSummary, NodeDTO, OutlineMode } from './types'

const BASE = '/api/mindmap_service'

async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null
    throw new Error(body?.detail ?? `${method} failed: HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listMaps: () => call<MapSummary[]>('list_maps', {}),
  getMap: (map_id: number) => call<MapDetail>('get_map', { map_id }),
  getTree: (map_id: number) => call<string>('get_tree', { map_id }),
  createMap: (title: string) => call<MapDetail>('create_map', { title, actor: 'human' }),
  addNode: (map_id: number, parent_id: number, content: string, position?: number) =>
    call<NodeDTO>('add_node', { map_id, parent_id, content, position, actor: 'human' }),
  updateNode: (map_id: number, node_id: number, content?: string, collapsed?: boolean) =>
    call<NodeDTO>('update_node', { map_id, node_id, content, collapsed, actor: 'human' }),
  moveNode: (map_id: number, node_id: number, new_parent_id: number, position?: number) =>
    call<NodeDTO>('move_node', { map_id, node_id, new_parent_id, position, actor: 'human' }),
  deleteNode: (map_id: number, node_id: number) =>
    call<boolean>('delete_node', { map_id, node_id, actor: 'human' }),
  deleteMap: (map_id: number) => call<boolean>('delete_map', { map_id, actor: 'human' }),
  expandAll: (map_id: number) => call<MapDetail>('expand_all', { map_id, actor: 'human' }),
  setFoldLevel: (map_id: number, level: number) =>
    call<MapDetail>('set_fold_level', { map_id, level, actor: 'human' }),
  applyOutline: (map_id: number, outline: string, mode: OutlineMode) =>
    call<MapDetail>('apply_outline', { map_id, outline, mode, actor: 'human' }),
}

// 聊天归档（清除 context 后可点击回看的只读历史；GET REST，非 RPC）
export interface ArchiveMeta {
  id: string
  created_at: string
  count: number
  preview: string
}
export interface ArchiveDoc {
  id: string
  created_at: string
  messages: { role: 'user' | 'agent'; text: string; thinking?: string }[]
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export const chatApi = {
  archives: (mapId: number) => get<ArchiveMeta[]>(`/api/chat/archives?map_id=${mapId}`),
  archive: (mapId: number, id: string) => get<ArchiveDoc>(`/api/chat/archives/${id}?map_id=${mapId}`),
}
