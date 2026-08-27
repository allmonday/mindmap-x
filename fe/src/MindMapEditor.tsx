import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from './api'
import { fitText, layoutMap, type LNode } from './layout'
import type { MapDetail, OutlineMode } from './types'

interface Props {
  mapId: number
  onBack: () => void
}

// ── custom node ───────────────────────────────────────────────────────

type MindNodeData = {
  lnode: LNode
  isEditing: boolean
  hasChildren: boolean
  onSelect: (id: number) => void
  onStartEdit: (id: number) => void
  onToggleCollapse: (lnode: LNode) => void
  onCommitEdit: (id: number, text: string) => void
  onCancelEdit: () => void
}

type MindNode = Node<MindNodeData, 'mind'>

function MindNodeView({ data, selected }: NodeProps<MindNode>) {
  const { lnode, isEditing, hasChildren } = data
  const n = lnode.node
  const byAgent = n.updated_by === 'agent'
  const isRoot = n.parent_id === null
  return (
    <div
      className={`rf-node ${isRoot ? 'root' : ''} ${byAgent ? 'by-agent' : ''} ${selected ? 'sel' : ''}`}
      style={{ width: lnode.w, height: lnode.h }}
      onClick={(e) => {
        e.stopPropagation()
        data.onSelect(n.display_id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        data.onStartEdit(n.display_id)
      }}
    >
      {/* 四向 handle：供父子边按 child.side 选择正确一侧连接 */}
      <Handle type="source" position={Position.Right} id="sr" isConnectable={false} />
      <Handle type="source" position={Position.Left} id="sl" isConnectable={false} />
      <Handle type="target" position={Position.Right} id="tr" isConnectable={false} />
      <Handle type="target" position={Position.Left} id="tl" isConnectable={false} />

      {isEditing ? (
        <textarea
          className="rf-editor"
          autoFocus
          defaultValue={n.content}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => data.onCommitEdit(n.display_id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              data.onCommitEdit(n.display_id, (e.target as HTMLTextAreaElement).value)
            }
            if (e.key === 'Escape') data.onCancelEdit()
          }}
        />
      ) : (
        <span className="rf-label">{fitText(n.content, lnode.w)}</span>
      )}

      {/* ID 角标：与 outline 协议 [id:N] 呼应，方便 Agent 精确锚定节点 */}
      <span className={`id-badge ${isRoot ? 'on-root' : ''}`}>#{n.display_id}</span>

      {byAgent && !isEditing && <span className="agent-badge">AI</span>}

      {hasChildren && (
        <button
          className={`fold ${n.collapsed ? 'folded' : ''}`}
          title={n.collapsed ? '展开' : '折叠'}
          onClick={(e) => {
            e.stopPropagation()
            data.onToggleCollapse(lnode)
          }}
        >
          {n.collapsed ? '+' : '−'}
        </button>
      )}
    </div>
  )
}

const nodeTypes = { mind: MindNodeView }

// ── editor ────────────────────────────────────────────────────────────

export function MindMapEditor({ mapId, onBack }: Props) {
  const [detail, setDetail] = useState<MapDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [wsState, setWsState] = useState<'connecting' | 'live' | 'dead'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineText, setOutlineText] = useState('')
  const [outlineMode, setOutlineMode] = useState<OutlineMode>('merge')

  const refresh = useCallback(async () => {
    try {
      setDetail(await api.getMap(mapId))
    } catch (e) {
      setError(String(e))
    }
  }, [mapId])

  // 数据加载 + WebSocket 实时同步（hello/changed 都触发重拉）
  useEffect(() => {
    setDetail(null)
    setSelectedId(null)
    setEditingId(null)
    refresh()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/${mapId}`)
    ws.onopen = () => setWsState('live')
    ws.onclose = () => setWsState('dead')
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'hello' || msg.type === 'changed') void refresh()
    }
    return () => ws.close()
  }, [mapId, refresh])

  // ── 编辑操作（成功后由 WS 事件驱动重拉，保持单一数据流） ─────────────
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setTimeout(() => setError(null), 3500)
    }
  }

  const commitEdit = useCallback(
    (id: number, text: string) => {
      setEditingId(null)
      const t = text.trim()
      if (!t) return
      void guard(() => api.updateNode(mapId, id, t))
    },
    [mapId],
  )
  const addChild = (parentId: number) => void guard(() => api.addNode(mapId, parentId, '新节点'))
  const deleteNode = (id: number) => void guard(() => api.deleteNode(mapId, id))
  const toggleCollapse = useCallback(
    (lnode: LNode) =>
      void guard(() => api.updateNode(mapId, lnode.node.display_id, undefined, !lnode.node.collapsed)),
    [mapId],
  )

  // ── 快捷键（F2 编辑 / Tab 加子 / Enter 加兄弟 / Delete 删除） ────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId != null || outlineOpen || selectedId == null || !detail) return
      const node = detail.nodes.find((n) => n.display_id === selectedId)
      if (!node) return
      if (e.key === 'F2') {
        e.preventDefault()
        setEditingId(node.display_id)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        addChild(node.display_id)
      } else if (e.key === 'Enter') {
        if (node.parent == null) return // 根无兄弟
        e.preventDefault()
        addChild(node.parent.display_id)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (node.parent == null) return // 根不可删
        e.preventDefault()
        deleteNode(node.display_id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, editingId, outlineOpen, detail, mapId])

  // ── layout → React Flow nodes/edges ────────────────────────────────
  const layout = useMemo(() => (detail ? layoutMap(detail) : null), [detail])

  const childCount = useMemo(() => {
    // 键为父节点 display_id（parent_id 是全局内部键，不能与 display_id 混用）
    const m = new Map<number, number>()
    if (detail) {
      for (const n of detail.nodes) {
        if (n.parent != null) m.set(n.parent.display_id, (m.get(n.parent.display_id) ?? 0) + 1)
      }
    }
    return m
  }, [detail])

  const callbacks = useMemo(
    () => ({
      onSelect: (id: number) => setSelectedId(id),
      onStartEdit: (id: number) => setEditingId(id),
      onToggleCollapse: toggleCollapse,
      onCommitEdit: commitEdit,
      onCancelEdit: () => setEditingId(null),
    }),
    [toggleCollapse, commitEdit],
  )

  const rfNodes: MindNode[] = useMemo(() => {
    if (!layout) return []
    return layout.all.map((lnode) => ({
      id: String(lnode.node.display_id),
      type: 'mind' as const,
      position: { x: lnode.x, y: lnode.y - lnode.h / 2 },
      width: lnode.w, // 供 MiniMap 等在 DOM 测量前使用（nodeHasDimensions）
      height: lnode.h,
      style: { width: lnode.w, height: lnode.h },
      selected: lnode.node.display_id === selectedId,
      data: {
        lnode,
        isEditing: lnode.node.display_id === editingId,
        hasChildren: (childCount.get(lnode.node.display_id) ?? 0) > 0,
        ...callbacks,
      },
    }))
  }, [layout, selectedId, editingId, childCount, callbacks])

  const rfEdges: Edge[] = useMemo(() => {
    if (!layout) return []
    const edges: Edge[] = []
    for (const ln of layout.all) {
      for (const c of ln.children) {
        edges.push({
          id: `e-${ln.node.display_id}-${c.node.display_id}`,
          source: String(ln.node.display_id),
          target: String(c.node.display_id),
          // 锚定侧由 child 的方向决定（见 layout.ts edgePath 的同款规则）
          sourceHandle: c.side === 1 ? 'sr' : 'sl',
          targetHandle: c.side === 1 ? 'tl' : 'tr',
          type: 'default',
        })
      }
    }
    return edges
  }, [layout])

  // ── outline 编辑（Human 使用 Agent 同款协议的入口） ─────────────────
  const openOutline = async () => {
    try {
      setOutlineText(await api.getTree(mapId))
      setOutlineOpen(true)
    } catch (e) {
      setError(String(e))
    }
  }
  const applyOutline = () =>
    void guard(async () => {
      await api.applyOutline(mapId, outlineText, outlineMode)
      setOutlineOpen(false)
    })

  if (!detail || !layout || !layout.root) {
    return (
      <div className="editor-loading">
        {error ? <div className="toast">{error}</div> : '加载中…'}
        <button className="btn" onClick={onBack}>← 返回</button>
      </div>
    )
  }

  const selNode = selectedId != null ? detail.nodes.find((n) => n.display_id === selectedId) : null

  return (
    <div className="editor">
      <header className="toolbar">
        <button className="btn icon" onClick={onBack} title="返回列表" aria-label="返回列表">☰</button>
        <button
          className="btn icon"
          onClick={() => void guard(() => api.expandAll(mapId))}
          title="展开所有节点"
          aria-label="展开所有节点"
        >
          ⊞
        </button>
        <span className={`ws-dot ${wsState}`} title={`实时同步: ${wsState}`} />
        <span className={`ws-label ${wsState}`}>
          {wsState === 'live' ? '实时' : wsState === 'connecting' ? '连接中' : '已断开'}
        </span>
        <div className="spacer" />
        <button className="btn icon" onClick={openOutline} title="outline 编辑" aria-label="outline 编辑">✎</button>
      </header>

      {error && <div className="toast editor-toast">{error}</div>}

      <div className="rf-wrap">
        {/* 标题悬浮于画板左上角，独立于工具栏；pointer-events:none 不挡画布交互 */}
        <div className="map-title">
          <span className="name">{detail.title}</span>
          <span className="ver">v{detail.version}</span>
        </div>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.1}
          maxZoom={2.5}
          nodesDraggable={false}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          elementsSelectable
          onPaneClick={() => setSelectedId(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            className="rf-minimap"
            nodeStrokeColor="#94a3b8"
            nodeColor={(n) => {
              const d = n.data as MindNodeData
              if (d.lnode.node.parent_id == null) return '#1e293b' // 根
              if (d.lnode.node.updated_by === 'agent') return '#f59e0b' // Agent 修改
              return '#cbd5e1'
            }}
          />
        </ReactFlow>
      </div>

      {selNode && selNode.parent != null && (
        <div className="node-actions">
          <button className="btn sm" onClick={() => addChild(selNode.display_id)}>+ 子级</button>
          <button className="btn sm" onClick={() => deleteNode(selNode.display_id)}>删除</button>
        </div>
      )}

      {outlineOpen && (
        <div className="modal" onClick={() => setOutlineOpen(false)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h3>outline 编辑（与 Agent 同协议：`- [id:N] 内容`，2 空格缩进一级）</h3>
            <textarea
              className="outline-editor"
              value={outlineText}
              onChange={(e) => setOutlineText(e.target.value)}
              spellCheck={false}
            />
            <div className="modal-actions">
              <select value={outlineMode} onChange={(e) => setOutlineMode(e.target.value as OutlineMode)}>
                <option value="merge">merge（锚定更新 + 新建，未提及保留）</option>
                <option value="replace">replace（保留根，其余全删重建）</option>
              </select>
              <button className="btn primary" onClick={applyOutline}>应用</button>
              <button className="btn" onClick={() => setOutlineOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
