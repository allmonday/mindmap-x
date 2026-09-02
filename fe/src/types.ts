// UI 领域类型从 OpenAPI SDK DTO 派生，只收紧后端运行时必定存在的字段。
//
// ID 语义：display_id 是 map 内编号（每图从 1 起）——角标显示、API 参数、
// outline [id:N] 都用它。parent_id 是全局内部键，仅用于组装树结构。

import type {
  MapDetail as GeneratedMapDetail,
  MapSummary as GeneratedMapSummary,
  NodeDto as GeneratedNodeDto,
  NodeRef as GeneratedNodeRef,
  RevisionChangeRowDto as GeneratedRevisionChangeRowDto,
  RevisionChangesDto as GeneratedRevisionChangesDto,
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
  'parent_id' | 'parent' | 'note' | 'position' | 'collapsed' | 'updated_by' | 'updated_at'
> & {
  parent_id: number | null // 内部结构键（全局），不作 API 参数
  parent: NodeRef | null // 父节点操作编号（display_id）
  note: string | null // markdown 长文备注（后端序列化 None 字段必存在）；null = 无
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
export type RevisionNode = Omit<GeneratedRevisionNode, 'note' | 'updated_by'> & {
  note: string | null // 旧快照无此 key 时后端 .get 兜 null
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

// 版本间变更（后端 get_revision_changes 直供；kind 语义 = 该版本当时发生的事）
export type DiffKind = 'added' | 'removed' | 'changed' | 'note' | 'moved' | 'folded'
export type RevisionChanges = Omit<GeneratedRevisionChangesDto, 'rows'> & {
  rows: DiffRow[]
}
export type DiffRow = Omit<GeneratedRevisionChangeRowDto, 'kind' | 'old_content'> & {
  kind: DiffKind
  oldContent?: string | null // 改前内容（changed 行渲染高亮差异段用）
}
