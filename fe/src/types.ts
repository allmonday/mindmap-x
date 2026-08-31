// UI 领域类型从 OpenAPI SDK DTO 派生，只收紧后端运行时必定存在的字段。
//
// ID 语义：display_id 是 map 内编号（每图从 1 起）——角标显示、API 参数、
// outline [id:N] 都用它。parent_id 是全局内部键，仅用于组装树结构。

import type {
  MapDetail as GeneratedMapDetail,
  MapSummary as GeneratedMapSummary,
  NodeDto as GeneratedNodeDto,
  NodeRef as GeneratedNodeRef,
  RevisionDetail as GeneratedRevisionDetail,
  RevisionNodeDto as GeneratedRevisionNode,
  RevisionSnapshotDto as GeneratedRevisionSnapshot,
  RevisionSummary as GeneratedRevisionSummary,
} from './sdk'

export type MapSummary = GeneratedMapSummary & {
  id: number
  version: number
  created_at: string
}

export type NodeRef = GeneratedNodeRef

export type NodeDTO = Omit<
  GeneratedNodeDto,
  'parent_id' | 'parent' | 'position' | 'collapsed' | 'updated_by' | 'updated_at'
> & {
  parent_id: number | null // 内部结构键（全局），不作 API 参数
  parent: NodeRef | null // 父节点操作编号（display_id）
  position: number
  collapsed: boolean
  updated_by: 'human' | 'agent'
  updated_at: string
}

export type MapDetail = Omit<
  GeneratedMapDetail,
  'id' | 'version' | 'created_at' | 'nodes'
> & {
  id: number
  version: number
  created_at: string
  nodes: NodeDTO[]
}

export type OutlineMode = 'merge' | 'replace'

// ── 版本快照（map_revision）──
export type RevisionNode = Omit<GeneratedRevisionNode, 'updated_by'> & {
  updated_by: 'human' | 'agent'
}

export type RevisionSnapshot = Omit<GeneratedRevisionSnapshot, 'nodes'> & {
  nodes: RevisionNode[]
}

export type RevisionSummary = Omit<
  GeneratedRevisionSummary,
  'id' | 'actor' | 'detail' | 'created_at'
> & {
  id: number
  actor: 'human' | 'agent'
  detail: string | null
  created_at: string
}

export type RevisionDetail = Omit<
  GeneratedRevisionDetail,
  'id' | 'actor' | 'detail' | 'created_at' | 'snapshot'
> &
  RevisionSummary & {
  snapshot: RevisionSnapshot
}

// 前端本地 diff（选中版本 vs 当前树）
export type DiffKind = 'added' | 'removed' | 'changed' | 'moved' | 'folded'
export interface DiffRow {
  display_id: number
  kind: DiffKind
  content: string
  oldContent?: string // changed 行携带快照侧旧内容：渲染时高亮差异段
}
