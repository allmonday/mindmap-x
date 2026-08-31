// REST 封装：浏览器端所有操作显式声明 actor='human'（Agent 端默认 'agent'）
// 节点 ID 参数均为 map 内 display_id（每图从 1 起）
import type { I18nKey } from './i18n'
import type { MapDetail, MapSummary, NodeDTO, OutlineMode, RevisionDetail, RevisionSummary } from './types'

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
  listRevisions: (map_id: number) => call<RevisionSummary[]>('list_revisions', { map_id }),
  getRevision: (map_id: number, version: number) =>
    call<RevisionDetail>('get_revision', { map_id, version }),
  restoreRevision: (map_id: number, version: number) =>
    call<MapDetail>('restore_revision', { map_id, version, actor: 'human' }),
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

// Agent 可用性：env 完整性 → 网关探活 → MCP 握手（无配置时首步即快速失败，无外呼）。
// 失败原因结构化（code + 插值参数），文案由前端按 UI 语言渲染（弹窗 / 错误横幅共用）
export interface ChatGateStatus {
  ok: boolean
  reason_code: string | null
  reason_detail: Record<string, string | number> | null
  desktop?: boolean
}

const GATE_REASON_KEYS: Record<string, I18nKey> = {
  env_missing: 'chat.gate.envMissing',
  gateway_http: 'chat.gate.gatewayHttp',
  gateway_unreachable: 'chat.gate.gatewayUnreachable',
  mcp_http: 'chat.gate.mcpHttp',
  mcp_unreachable: 'chat.gate.mcpUnreachable',
}

// 未知 code（前后端版本错位等）兜底通用文案；detail 直接透传 t() 插值
export function gateReasonText(
  t: (key: I18nKey, params?: Record<string, string | number>) => string,
  code: string,
  detail: Record<string, string | number> | null,
): string {
  const key = GATE_REASON_KEYS[code]
  return key ? t(key, detail ?? undefined) : t('chat.unavailable')
}

export const chatApi = {
  archives: (mapId: number) => get<ArchiveMeta[]>(`/api/chat/archives?map_id=${mapId}`),
  archive: (mapId: number, id: string) => get<ArchiveDoc>(`/api/chat/archives/${id}?map_id=${mapId}`),
  status: () => get<ChatGateStatus>('/api/chat/status'),
}
