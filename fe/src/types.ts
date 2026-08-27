// 与后端 dtos.py 对应的响应类型（Phase 4 生成 TS SDK 后由 SDK 类型替代）
//
// ID 语义：display_id 是 map 内编号（每图从 1 起）——角标显示、API 参数、
// outline [id:N] 都用它。parent_id 是全局内部键，仅用于组装树结构。

export interface MapSummary {
  id: number
  title: string
  version: number
  created_at: string
}

export interface NodeRef {
  display_id: number
}

export interface NodeDTO {
  display_id: number
  map_id: number
  parent_id: number | null // 内部结构键（全局），不作 API 参数
  parent: NodeRef | null // 父节点操作编号（display_id）
  content: string
  position: number
  collapsed: boolean
  updated_by: 'human' | 'agent'
  updated_at: string
}

export interface MapDetail {
  id: number
  title: string
  version: number
  created_at: string
  nodes: NodeDTO[]
}

export type OutlineMode = 'merge' | 'replace'
