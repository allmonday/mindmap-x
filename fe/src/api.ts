// OpenAPI SDK 的业务适配层：显式声明 actor='human'，并把生成函数的长名称
// 收敛为 UI 需要的领域方法。节点 ID 均为 map 内 display_id（每图从 1 起）。
import type { I18nKey } from './i18n'
import {
  handlerApiMindmapServiceAddNodePost,
  handlerApiMindmapServiceApplyOutlinePost,
  handlerApiMindmapServiceCreateMapPost,
  handlerApiMindmapServiceDeleteMapPost,
  handlerApiMindmapServiceDeleteNodePost,
  handlerApiMindmapServiceExpandAllPost,
  handlerApiMindmapServiceGetMapPost,
  handlerApiMindmapServiceGetRevisionPost,
  handlerApiMindmapServiceGetTreePost,
  handlerApiMindmapServiceListMapsPost,
  handlerApiMindmapServiceListRevisionsPost,
  handlerApiMindmapServiceMoveNodePost,
  handlerApiMindmapServiceRestoreRevisionPost,
  handlerApiMindmapServiceSetFoldLevelPost,
  handlerApiMindmapServiceSetNodeCollapsedPost,
  handlerApiMindmapServiceUpdateNodePost,
} from './sdk'
import type { MapDetail, MapSummary, NodeDTO, OutlineMode, RevisionDetail, RevisionSummary } from './types'

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: Response
}

function sdkError(method: string, result: SdkResult<unknown>): Error {
  if (result.error instanceof Error) return result.error
  const detail =
    result.error && typeof result.error === 'object' && 'detail' in result.error
      ? result.error.detail
      : result.error
  const message =
    typeof detail === 'string'
      ? detail
      : detail
        ? JSON.stringify(detail)
        : `${method} failed${result.response ? `: HTTP ${result.response.status}` : ''}`
  return new Error(message)
}

function sdkData<T>(method: string, result: SdkResult<unknown>, expectedStatus = 200): T {
  if (result.response?.status !== expectedStatus || result.data === undefined) {
    throw sdkError(method, result)
  }
  return result.data as T
}

function sdkNoContent(method: string, result: SdkResult<unknown>): void {
  if (result.response?.status !== 204) throw sdkError(method, result)
}

export const api = {
  listMaps: async () =>
    sdkData<MapSummary[]>('list_maps', await handlerApiMindmapServiceListMapsPost()),
  getMap: async (map_id: number) =>
    sdkData<MapDetail>(
      'get_map',
      await handlerApiMindmapServiceGetMapPost({ body: { map_id } }),
    ),
  getTree: async (map_id: number) =>
    sdkData<string>(
      'get_tree',
      await handlerApiMindmapServiceGetTreePost({ body: { map_id } }),
    ),
  createMap: async (title: string) =>
    sdkData<MapDetail>(
      'create_map',
      await handlerApiMindmapServiceCreateMapPost({ body: { title, actor: 'human' } }),
    ),
  addNode: async (
    map_id: number,
    parent_id: number,
    content: string,
    position?: number,
  ) =>
    sdkData<NodeDTO>(
      'add_node',
      await handlerApiMindmapServiceAddNodePost({
        body: { map_id, parent_id, content, position, actor: 'human' },
      }),
    ),
  updateNode: async (map_id: number, node_id: number, content: string) =>
    sdkData<NodeDTO>(
      'update_node',
      await handlerApiMindmapServiceUpdateNodePost({
        body: { map_id, node_id, content, actor: 'human' },
      }),
    ),
  setNodeCollapsed: async (
    map_id: number,
    node_id: number,
    collapsed: boolean,
    client_request_id: string,
  ) => {
    sdkNoContent(
      'set_node_collapsed',
      await handlerApiMindmapServiceSetNodeCollapsedPost({
        body: { map_id, node_id, collapsed, client_request_id, actor: 'human' },
      }),
    )
  },
  moveNode: async (
    map_id: number,
    node_id: number,
    new_parent_id: number,
    position?: number,
  ) =>
    sdkData<NodeDTO>(
      'move_node',
      await handlerApiMindmapServiceMoveNodePost({
        body: { map_id, node_id, new_parent_id, position, actor: 'human' },
      }),
    ),
  deleteNode: async (map_id: number, node_id: number) =>
    sdkData<boolean>(
      'delete_node',
      await handlerApiMindmapServiceDeleteNodePost({
        body: { map_id, node_id, actor: 'human' },
      }),
    ),
  deleteMap: async (map_id: number) =>
    sdkData<boolean>(
      'delete_map',
      await handlerApiMindmapServiceDeleteMapPost({ body: { map_id, actor: 'human' } }),
    ),
  expandAll: async (map_id: number, client_request_id: string) => {
    sdkNoContent(
      'expand_all',
      await handlerApiMindmapServiceExpandAllPost({
        body: { map_id, client_request_id, actor: 'human' },
      }),
    )
  },
  setFoldLevel: async (map_id: number, level: number, client_request_id: string) => {
    sdkNoContent(
      'set_fold_level',
      await handlerApiMindmapServiceSetFoldLevelPost({
        body: { map_id, level, client_request_id, actor: 'human' },
      }),
    )
  },
  applyOutline: async (map_id: number, outline: string, mode: OutlineMode) =>
    sdkData<MapDetail>(
      'apply_outline',
      await handlerApiMindmapServiceApplyOutlinePost({
        body: { map_id, outline, mode, actor: 'human' },
      }),
    ),
  listRevisions: async (map_id: number) =>
    sdkData<RevisionSummary[]>(
      'list_revisions',
      await handlerApiMindmapServiceListRevisionsPost({ body: { map_id } }),
    ),
  getRevision: async (map_id: number, version: number) =>
    sdkData<RevisionDetail>(
      'get_revision',
      await handlerApiMindmapServiceGetRevisionPost({ body: { map_id, version } }),
    ),
  restoreRevision: async (map_id: number, version: number) =>
    sdkData<MapDetail>(
      'restore_revision',
      await handlerApiMindmapServiceRestoreRevisionPost({
        body: { map_id, version, actor: 'human' },
      }),
    ),
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
