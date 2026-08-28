import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from './api'
import { ChatPanel } from './ChatPanel'
import { layoutMap, type LNode, type LayoutMode } from './layout'
import type { MapDetail, NodeDTO, OutlineMode } from './types'

interface Props {
  mapId: number
  onBack: () => void
}

// ── custom node ───────────────────────────────────────────────────────

type MindNodeData = {
  lnode: LNode
  isLayoutRoot: boolean // 当前布局根 = 真根（非聚焦时）或聚焦节点
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
  onFocus: (id: number) => void // 聚焦（下钻）到该节点
}

type MindNode = Node<MindNodeData, 'mind'>

function MindNodeView({ data, selected }: NodeProps<MindNode>) {
  const { lnode, isEditing, isAdding, hasChildren } = data
  const n = lnode.node
  const isRoot = data.isLayoutRoot // 布局根 = 真根或聚焦节点；非聚焦时与真根判定完全一致
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
        <span className="rf-label" title={lnode.truncated ? n.content : undefined}>
          {n.content}
        </span>
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
            {!isRoot && hasChildren && (
              <button
                className="btn sm"
                title="聚焦：只看此节点的子树（Esc / 点面包屑根节点退出）"
                aria-label="聚焦"
                onClick={(e) => {
                  e.stopPropagation()
                  data.onFocus(n.display_id)
                }}
              >
                <FocusIcon />
              </button>
            )}
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

// 布局形态图标（lucide columns-2 / panel-right 同形对比）：外框相同、
// 分隔线位置不同——居中=左右对称、靠右=一律靠右，一眼可辨
const LayoutBalancedIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M12 3v18" />
  </svg>
)

const LayoutRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M15 3v18" />
  </svg>
)

// 全部展开（lucide expand：四角外扩箭头）
const ExpandIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
)

// Agent 对话开关（lucide message-circle：带尾气泡）
const ChatIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
  </svg>
)

// outline 编辑（lucide pencil：斜置铅笔）
const PencilIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
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

// 聚焦/下钻（lucide crosshair：圆 + 四向准星线）
const FocusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" />
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
  // 聚焦（下钻）：作为画布布局根的节点 display_id；null = 全图。
  // 会话级视图态——不进 localStorage，换图即清空
  const [focusId, setFocusId] = useState<number | null>(null)
  // 布局形态：左右镜像 / 一律靠右；localStorage 记忆
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(
    () => (localStorage.getItem('layoutMode') as LayoutMode) || 'balanced',
  )
  useEffect(() => {
    localStorage.setItem('layoutMode', layoutMode)
  }, [layoutMode])
  const rfRef = useRef<ReactFlowInstance<MindNode, Edge> | null>(null)

  // 切换布局形态 / 聚焦切换后节点坐标剧变，重新 fitView 才不会跑出视口
  useEffect(() => {
    const t = setTimeout(() => rfRef.current?.fitView({ padding: 0.25, maxZoom: 1 }), 60)
    return () => clearTimeout(t)
  }, [layoutMode, focusId])

  // 切换是同步重排，节点瞬移会很突兀——用短暂遮罩盖住重排与 fitView 的过程
  const [switching, setSwitching] = useState(false)
  const toggleLayout = () => {
    setSwitching(true)
    setLayoutMode((m) => (m === 'balanced' ? 'right' : 'balanced'))
    window.setTimeout(() => setSwitching(false), 300)
  }

  // 聚焦/切换/退出：与布局形态切换同款处理——遮罩盖住同步重排 + fitView
  const switchFocus = useCallback(
    (id: number | null) => {
      if (id === focusId) return
      setSwitching(true)
      setFocusId(id)
      window.setTimeout(() => setSwitching(false), 300)
    },
    [focusId],
  )

  // WS 全量重拉后，聚焦节点可能已被 Agent 删除 / replace 重建（display_id 变了）——
  // 不存在即静默退回全图（不走遮罩：WS 刷新本身就有画面变化）
  useEffect(() => {
    if (focusId != null && detail && !detail.nodes.some((n) => n.display_id === focusId)) {
      setFocusId(null)
    }
  }, [detail, focusId])
  // 侧边栏宽度：拖拽调整，localStorage 跨会话记忆
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem('chatWidth'))
    return saved >= 280 && saved <= 760 ? saved : 360
  })
  useEffect(() => {
    localStorage.setItem('chatWidth', String(chatWidth))
  }, [chatWidth])

  const refresh = useCallback(async () => {
    try {
      setDetail(await api.getMap(mapId))
    } catch (e) {
      setError(String(e))
    }
  }, [mapId])

  // 数据加载 + WebSocket 实时同步（hello/changed 都触发重拉）。
  // 断线自动重连（指数退避 1s→8s 封顶）——hello 到达即重拉，恢复后状态自然同步。
  useEffect(() => {
    setDetail(null)
    setSelectedId(null)
    setEditingId(null)
    setFocusId(null)
    refresh()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let closed = false // 组件卸载/换图：停止重连
    let timer: number | undefined
    let attempt = 0
    let ws: WebSocket | null = null
    const connect = () => {
      if (closed) return
      ws = new WebSocket(`${proto}://${location.host}/ws/${mapId}`)
      ws.onopen = () => {
        attempt = 0
        setWsState('live')
      }
      ws.onclose = () => {
        setWsState('dead')
        if (closed) return
        const delay = Math.min(1000 * 2 ** attempt, 8000)
        attempt += 1
        timer = window.setTimeout(connect, delay)
      }
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'hello' || msg.type === 'changed') void refresh()
      }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(timer)
      ws?.close()
    }
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

  // ── 快捷键（F2 编辑 / Tab 加子 / Enter 加兄弟 / Delete 删除 / Esc 退聚焦）──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 退出聚焦：不依赖节点选中（在通用守卫之外先行处理），但输入态/弹层打开时让位
      if (e.key === 'Escape') {
        const el = document.activeElement
        const typing =
          el instanceof HTMLElement &&
          (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (focusId != null && !typing && !outlineOpen) switchFocus(null)
        return
      }
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
        // 布局根无兄弟：聚焦根加兄弟会挂到视野外的真父上，成为不可见变更
        if (node.parent == null || node.display_id === focusId) return
        e.preventDefault()
        addChild(node.parent.display_id)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (node.parent == null || node.display_id === focusId) return // 布局根不可删
        e.preventDefault()
        deleteNode(node.display_id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, editingId, outlineOpen, detail, mapId, focusId, switchFocus])

  // ── layout → React Flow nodes/edges ────────────────────────────────
  const layout = useMemo(
    () => (detail ? layoutMap(detail, layoutMode, focusId) : null),
    [detail, layoutMode, focusId],
  )

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

  // 全树最大深度（无视折叠现算——layout.all 只含可见节点，折叠后会低估）
  const maxDepth = useMemo(() => {
    if (!detail) return 1
    const byParent = new Map<number, NodeDTO[]>()
    let root: NodeDTO | null = null
    for (const n of detail.nodes) {
      if (n.parent == null) root = n
      else byParent.set(n.parent.display_id, [...(byParent.get(n.parent.display_id) ?? []), n])
    }
    if (!root) return 1
    let max = 1
    const stack: [NodeDTO, number][] = [[root, 1]]
    while (stack.length) {
      const [n, d] = stack.pop()!
      max = Math.max(max, d)
      for (const c of byParent.get(n.display_id) ?? []) stack.push([c, d + 1])
    }
    return max
  }, [detail])

  // 聚焦路径（真根 → 各级祖先 → 聚焦节点）：每次从 detail 现算，
  // Agent 移动节点（move_node 改父）后路径自动跟随；1000 步上限防断链/成环死循环
  const focusPath = useMemo(() => {
    if (focusId == null || !detail) return [] as NodeDTO[]
    const byId = new Map(detail.nodes.map((n) => [n.display_id, n]))
    const path: NodeDTO[] = []
    let cur = byId.get(focusId) ?? null
    let steps = 0
    while (cur && steps++ < 1000) {
      path.push(cur)
      cur = cur.parent != null ? (byId.get(cur.parent.display_id) ?? null) : null
    }
    return path.reverse()
  }, [detail, focusId])

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
      onFocus: switchFocus,
    }),
    [toggleCollapse, commitEdit, addChild, startAdd, commitAdd, cancelAdd, deleteNode, switchFocus],
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
        isLayoutRoot: lnode === layout.root, // 引用相等：all 里的根对象就是 layout.root
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
          <ChatIcon />
        </button>
        <button className="btn icon" onClick={openOutline} title="outline 编辑" aria-label="outline 编辑">
          <PencilIcon />
        </button>
      </header>

      {error && <div className="toast editor-toast">{error}</div>}

      {/* 横向主体：画布始终全宽；聊天面板 absolute 悬浮于右侧（overlay，不压缩画布） */}
      <div className="editor-main">
        <div className="rf-wrap">
          {/* 标题悬浮于画板左上角，独立于工具栏；pointer-events:none 不挡画布交互
              （面包屑在 .crumbs 上局部恢复 pointer-events:auto） */}
          <div className="map-title">
            <span className="name" title={detail.title}>{detail.title}</span>
            <span className="ver">v{detail.version}</span>
            {focusPath.length > 0 && (
              <span className="crumbs">
                {focusPath.map((n, i) => {
                  const isCurrent = i === focusPath.length - 1
                  return (
                    <Fragment key={n.display_id}>
                      <span className="crumb-sep">›</span>
                      {isCurrent ? (
                        <span className="crumb cur" title={n.content}>
                          {n.content}
                        </span>
                      ) : (
                        <button
                          className="crumb"
                          title={i === 0 ? '返回全图' : `聚焦到「${n.content}」`}
                          onClick={() => (i === 0 ? switchFocus(null) : switchFocus(n.display_id))}
                        >
                          {n.content}
                        </button>
                      )}
                    </Fragment>
                  )
                })}
              </span>
            )}
          </div>
          {/* 画布左上角工具列：标题下方，布局切换 + 全部展开 */}
          <div className="canvas-tools">
            <button
              className="btn"
              disabled={switching}
              onClick={toggleLayout}
              title={layoutMode === 'balanced' ? '当前：左右对称，点击切换为一律靠右' : '当前：一律靠右，点击切换为左右对称'}
              aria-label={layoutMode === 'balanced' ? '布局：左右对称' : '布局：一律靠右'}
            >
              {layoutMode === 'balanced' ? <LayoutBalancedIcon /> : <LayoutRightIcon />}
            </button>
            <button
              className="btn"
              onClick={() => void guard(() => api.expandAll(mapId))}
              title="展开所有节点"
              aria-label="展开所有节点"
            >
              <ExpandIcon />
            </button>
            {maxDepth >= 3 && (
              <select
                className="btn fold-select"
                value=""
                title="折叠到指定层级：保留前 N 层可见，更深层收起"
                aria-label="折叠至第 N 层"
                onChange={(e) => {
                  const lv = Number(e.target.value)
                  // 受控 value="" 恒为占位符：命令型控件，执行后不驻留所选值
                  if (lv >= 2) void guard(() => api.setFoldLevel(mapId, lv))
                }}
              >
                <option value="" disabled>
                  折叠至…
                </option>
                {/* level=maxDepth 是纯展开，与相邻「全部展开」按钮重复，砍掉 */}
                {Array.from({ length: maxDepth - 2 }, (_, i) => i + 2).map((lv) => (
                  <option key={lv} value={lv}>
                    折叠至 {lv} 层
                  </option>
                ))}
              </select>
            )}
          </div>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onInit={(inst) => {
              rfRef.current = inst
            }}
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
                if (d.isLayoutRoot) return '#1e293b' // 布局根（真根或聚焦节点）
                return '#cbd5e1'
              }}
            />
          </ReactFlow>

          {/* 视图切换遮罩（布局形态/聚焦）：盖住同步重排 + fitView，揭开后已是新布局 */}
          {switching && (
            <div className="rf-loading">
              <span className="rf-loading-spinner" />
              <span>视图切换中…</span>
            </div>
          )}
        </div>

        {chatOpen && (
          <ChatPanel mapId={mapId} width={chatWidth} onResize={setChatWidth} onClose={() => setChatOpen(false)} />
        )}
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
