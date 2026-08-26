// 与后端 dtos.py 对应的响应类型（Phase 4 生成 TS SDK 后由 SDK 类型替代）

export interface MapSummary {
  id: number
  title: string
  version: number
  created_at: string
}

export interface NodeDTO {
  id: number
  map_id: number
  parent_id: number | null
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
