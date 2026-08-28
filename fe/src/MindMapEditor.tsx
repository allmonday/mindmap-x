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
import { ChatPanel } from './ChatPanel'
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
  isAdding: boolean
  hasChildren: boolean
  onSelect: (id: number) => void
  onStartEdit: (id: number) => void
  onToggleCollapse: (lnode: LNode) => void
  onCommitEdit: (id: number, text: string) => void
  onCancelEdit: () => void
  onAddChild: (parentId: number) => void
  onStartAdd: (parentId: number) => void
  onCommitAdd: (parentId: number, text: string) => void
  onCancelAdd: () => void
  onDelete: (id: number) => void
}

type MindNode = Node<MindNodeData, 'mind'>

function MindNodeView({ data, selected }: NodeProps<MindNode>) {
  const { lnode, isEditing, isAdding, hasChildren } = data
  const n = lnode.node
  const isRoot = n.parent_id === null
  return (
    <div
      className={`rf-node ${isRoot ? 'root' : ''} ${selected ? 'sel' : ''}`}
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
            e.stopPropagation() // 编辑态按键不冒泡到 window 快捷键（防 Enter 提交后误触发"加同级"）
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

      {/* 选中节点的操作按钮：节点左下方。加子模式 = 输入框 + 保存，确认后才创建节点 */}
      {selected && !isEditing && (
        isAdding ? (
          <div className="node-actions adding">
            <input
              className="add-input"
              autoFocus
              placeholder="子节点内容…"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation() // 输入态按键不冒泡（防 Enter 触发全局"加同级"）
                if (e.key === 'Enter') {
                  e.preventDefault()
                  data.onCommitAdd(n.display_id, (e.target as HTMLInputElement).value)
                }
                if (e.key === 'Escape') data.onCancelAdd()
              }}
              // 与节点编辑（rf-editor）同款语义：失焦即提交，空文本视为取消
              onBlur={(e) => data.onCommitAdd(n.display_id, e.target.value)}
            />
            <button
              className="btn sm primary save-add"
              title="保存（Enter）"
              aria-label="保存"
              // 阻止 mousedown 抢焦点 → 不触发 input blur（blur 也会提交，避免双写）
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                const input = e.currentTarget.previousElementSibling as HTMLInputElement
                data.onCommitAdd(n.display_id, input.value)
              }}
            >
              <CheckIcon />
            </button>
          </div>
        ) : (
          <div className="node-actions">
            <button
              className="btn sm"
              title="加子级（Tab 用默认名快速加）"
              aria-label="加子级"
              onClick={(e) => {
                e.stopPropagation()
                data.onStartAdd(n.display_id)
              }}
            >
              <PlusIcon />
            </button>
            {!isRoot && (
              <button
                className="btn sm danger"
                title="删除（Delete）"
                aria-label="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  data.onDelete(n.display_id)
                }}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        )
      )}

      {hasChildren && !isRoot && (
        <button
          className={`fold ${lnode.side === -1 ? 'left' : ''} ${n.collapsed ? 'folded' : ''}`}
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

// ── 节点操作按钮的小图标（stroke 用 currentColor，继承按钮配色） ──────

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14M12 5v14" />
  </svg>
)

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
  </svg>
)

// ── editor ────────────────────────────────────────────────────────────

export function MindMapEditor({ mapId, onBack }: Props) {
  const [detail, setDetail] = useState<MapDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [addingId, setAddingId] = useState<number | null>(null)
  const [wsState, setWsState] = useState<'connecting' | 'live' | 'dead'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineText, setOutlineText] = useState('')
  const [outlineMode, setOutlineMode] = useState<OutlineMode>('merge')
  const [chatOpen, setChatOpen] = useState(false)

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
  const addChild = useCallback(
    (parentId: number) => void guard(() => api.addNode(mapId, parentId, '新节点')),
    [mapId],
  )
  // + 按钮的两段式加子：先转输入框，确认内容后才真正创建（空文本 = 取消）
  const startAdd = useCallback((parentId: number) => setAddingId(parentId), [])
  const commitAdd = useCallback(
    (parentId: number, text: string) => {
      setAddingId(null)
      const t = text.trim()
      if (!t) return
      void guard(() => api.addNode(mapId, parentId, t))
    },
    [mapId],
  )
  const cancelAdd = useCallback(() => setAddingId(null), [])
  const deleteNode = useCallback(
    (id: number) => void guard(() => api.deleteNode(mapId, id)),
    [mapId],
  )
  const toggleCollapse = useCallback(
    (lnode: LNode) =>
      void guard(() => api.updateNode(mapId, lnode.node.display_id, undefined, !lnode.node.collapsed)),
    [mapId],
  )

  // ── 快捷键（F2 编辑 / Tab 加子 / Enter 加兄弟 / Delete 删除） ────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId != null || outlineOpen || selectedId == null || !detail) return
      // 焦点在任何输入元素上时快捷键一律失效（编辑框/聊天面板/outline 弹层）
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      )
        return
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
      onAddChild: addChild,
      onStartAdd: startAdd,
      onCommitAdd: commitAdd,
      onCancelAdd: cancelAdd,
      onDelete: deleteNode,
    }),
    [toggleCollapse, commitEdit, addChild, startAdd, commitAdd, cancelAdd, deleteNode],
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
        isAdding: lnode.node.display_id === addingId,
        hasChildren: (childCount.get(lnode.node.display_id) ?? 0) > 0,
        ...callbacks,
      },
    }))
  }, [layout, selectedId, editingId, addingId, childCount, callbacks])

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
        <button
          className={`btn icon ${chatOpen ? 'active' : ''}`}
          onClick={() => setChatOpen((v) => !v)}
          title="Agent 对话"
          aria-label="Agent 对话"
        >
          💬
        </button>
        <button className="btn icon" onClick={openOutline} title="outline 编辑" aria-label="outline 编辑">✎</button>
      </header>

      {error && <div className="toast editor-toast">{error}</div>}

      {/* 横向主体：画布始终全宽；聊天面板 absolute 悬浮于右侧（overlay，不压缩画布） */}
      <div className="editor-main">
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
            onPaneClick={() => {
            setSelectedId(null)
            setAddingId(null)
          }}
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
                return '#cbd5e1'
              }}
            />
          </ReactFlow>
        </div>

        {chatOpen && <ChatPanel mapId={mapId} onClose={() => setChatOpen(false)} />}
      </div>

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
