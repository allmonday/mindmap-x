import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
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
import { api, chatApi, gateReasonText, type ChatGateStatus } from './api'
import { ChatPanel } from './ChatPanel'
import { useI18n, type I18nKey } from './i18n'
import { LangSwitch } from './LangSwitch'
import { layoutMap, type LNode, type LayoutMode } from './layout'
import { RevisionPanel } from './RevisionPanel'
import type { MapDetail, NodeDTO, OutlineMode } from './types'
import { useAnimatedLayout } from './useAnimatedLayout'

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
  addingDir: 'child' | 'sibling' // 输入框方位与提交语义（child=挂锚点下，sibling=挂锚点父）
  hasChildren: boolean
  onSelect: (id: number) => void
  onStartEdit: (id: number) => void
  onToggleCollapse: (lnode: LNode) => void
  onCommitEdit: (id: number, text: string) => void
  onCancelEdit: () => void
  onStartAdd: (parentId: number, dir?: 'child' | 'sibling') => void
  onCommitAdd: (parentId: number, text: string) => void
  onCancelAdd: () => void
  onDelete: (id: number) => void
  onFocus: (id: number) => void // 聚焦（下钻）到该节点
}

type MindNode = Node<MindNodeData, 'mind'>

function MindNodeView({ data, selected }: NodeProps<MindNode>) {
  const { lnode, isEditing, isAdding, addingDir, hasChildren } = data
  const n = lnode.node
  const isRoot = data.isLayoutRoot // 布局根 = 真根或聚焦节点；非聚焦时与真根判定完全一致
  // 文案经 context 直取（ReactFlow 的 memo 不拦截 context 更新）——
  // 切语言时本组件自渲染，rfNodes memo 不需要重建
  const { t } = useI18n()

  // 操作按钮行：点击选中才显示、点外部（画布/别的节点）即消失——
  // 选中态由编辑器 selectedId 驱动（onPaneClick / 点其他节点都会换选），
  // 组件里无需自管显隐。曾用 hover 停留 0.5s 亮起，扫画布时易误亮，弃用
  const [confirmDel, setConfirmDel] = useState(false)
  const delTimer = useRef<number | undefined>(undefined)
  // 删除两步确认（与 MapList 同款交互语言）：首点只亮起，3s 内再点才执行。
  // 删除按钮就在 Focus 旁边，误触代价是整个子树——不可无确认直删
  useEffect(() => {
    window.clearTimeout(delTimer.current)
    if (!selected) setConfirmDel(false) // 选中丢失即解除 armed 态，不留悬亮红
  }, [selected])
  useEffect(() => () => window.clearTimeout(delTimer.current), [])
  const showActions = !isEditing && selected

  const clickDelete = () => {
    if (confirmDel) {
      window.clearTimeout(delTimer.current)
      data.onDelete(n.display_id)
      return
    }
    setConfirmDel(true)
    window.clearTimeout(delTimer.current)
    delTimer.current = window.setTimeout(() => setConfirmDel(false), 3000)
  }

  return (
    <div
      className={`rf-node ${isRoot ? 'root' : ''} ${selected ? 'sel' : ''}`}
      // 编辑中放开高度（min-height 保底不缩）：节点随 textarea 内容向下生长，
      // commit 后由布局重排归位；期间 z-index 抬升盖住下方节点（见 App.css）
      style={{ width: lnode.w, height: isEditing ? 'auto' : lnode.h, minHeight: isEditing ? lnode.h : undefined }}
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
          rows={Math.max(1, n.content.split('\n').length)}
          onClick={(e) => e.stopPropagation()}
          onInput={(e) => {
            // 高度随内容行数自增（超过节点高后由 max-height + overflow 兜底）
            const ta = e.currentTarget
            ta.style.height = 'auto'
            ta.style.height = `${ta.scrollHeight}px`
          }}
          onBlur={(e) => data.onCommitEdit(n.display_id, e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation() // 编辑态按键不冒泡到 window 快捷键（防 Enter 提交后误触发"加同级"）
            // Enter 提交、Shift+Enter 换行；输入法组词中的 Enter（含 Shift）是选词不是提交
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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

      {/* 节点操作按钮：节点左下方，点击选中时显示（.show 由 selected 驱动，
          点画布/其他节点即消失）。加子模式 = 输入框 + 保存，确认后才创建节点 */}
      {!isEditing && (
        isAdding ? (
          <div className={`node-actions adding as-${addingDir}`}>
            <input
              className="add-input"
              autoFocus
              placeholder={t(addingDir === 'sibling' ? 'node.addSiblingPlaceholder' : 'node.addPlaceholder')}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation() // 输入态按键不冒泡（防 Enter 触发全局快捷键）
                if (e.key === 'Enter') {
                  e.preventDefault()
                  data.onCommitAdd(addingDir === 'sibling' && n.parent ? n.parent.display_id : n.display_id, (e.target as HTMLInputElement).value)
                }
                if (e.key === 'Escape') data.onCancelAdd()
              }}
              // 与节点编辑（rf-editor）同款语义：失焦即提交，空文本视为取消
              onBlur={(e) =>
                data.onCommitAdd(addingDir === 'sibling' && n.parent ? n.parent.display_id : n.display_id, e.target.value)
              }
            />
            <button
              className="btn sm primary save-add"
              title={t('node.saveTitle')}
              aria-label={t('node.saveAria')}
              // 阻止 mousedown 抢焦点 → 不触发 input blur（blur 也会提交，避免双写）
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                const input = e.currentTarget.previousElementSibling as HTMLInputElement
                data.onCommitAdd(addingDir === 'sibling' && n.parent ? n.parent.display_id : n.display_id, input.value)
              }}
            >
              <CheckIcon />
            </button>
          </div>
        ) : (
          <div className={`node-actions${showActions ? ' show' : ''}`}>
            <button
              className="btn sm"
              title={t('node.addTitle')}
              aria-label={t('node.addAria')}
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
                title={t('node.focusTitle')}
                aria-label={t('node.focusAria')}
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
                className={`btn sm danger${confirmDel ? ' confirm' : ''}`}
                title={confirmDel ? t('node.deleteConfirm') : t('node.deleteTitle')}
                aria-label={confirmDel ? t('node.deleteConfirm') : t('node.deleteAria')}
                onClick={(e) => {
                  e.stopPropagation()
                  clickDelete()
                }}
              >
                {/* armed 态换成文字按钮——红底图标不够显眼，用户感知不到首点已生效 */}
                {confirmDel ? t('node.deleteConfirmBtn') : <TrashIcon />}
              </button>
            )}
          </div>
        )
      )}

      {hasChildren && !isRoot && (
        <button
          className={`fold ${lnode.side === -1 ? 'left' : ''} ${n.collapsed ? 'folded' : ''}`}
          title={n.collapsed ? t('node.expand') : t('node.collapse')}
          onClick={(e) => {
            e.stopPropagation()
            // 折叠是视图操作，不算"要操作这个节点"的意图——不置选中
            data.onToggleCollapse(lnode)
          }}
        >
          {n.collapsed ? <FoldPlusIcon /> : <FoldMinusIcon />}
        </button>
      )}
    </div>
  )
}

const nodeTypes = { mind: MindNodeView }

// 面包屑同层导航菜单：兄弟列表（调用方已算好、排除自身），点选即聚焦过去。
// 独立组件而非内联 JSX：role=menu 语义块 + 空列表不渲染的收口
function CrumbMenu({ siblings, onPick }: { siblings: NodeDTO[]; onPick: (id: number) => void }) {
  const { t } = useI18n()
  if (siblings.length === 0) return null
  return (
    <div className="crumb-menu" role="menu" aria-label={t('crumb.siblingsAria')}>
      {siblings.map((s) => (
        <button key={s.display_id} role="menuitem" onClick={() => onPick(s.display_id)}>
          <span className="cm-name">{s.content}</span>
          <span className="cm-id">#{s.display_id}</span>
        </button>
      ))}
    </div>
  )
}

type OptimisticFold = (detail: MapDetail) => MapDetail

function patchCollapsed(detail: MapDetail, nodeId: number, collapsed: boolean): MapDetail {
  let changed = false
  const nodes = detail.nodes.map((node) => {
    if (node.display_id !== nodeId || node.collapsed === collapsed) return node
    changed = true
    return { ...node, collapsed }
  })
  return changed ? { ...detail, nodes } : detail
}

function expandAllOptimistically(detail: MapDetail): MapDetail {
  let changed = false
  const nodes = detail.nodes.map((node) => {
    if (!node.collapsed) return node
    changed = true
    return { ...node, collapsed: false }
  })
  return changed ? { ...detail, nodes } : detail
}

function foldToLevelOptimistically(detail: MapDetail, level: number): MapDetail {
  const children = new Map<number, number[]>()
  const roots: number[] = []
  for (const node of detail.nodes) {
    if (node.parent == null) roots.push(node.display_id)
    else {
      const parentId = node.parent.display_id
      children.set(parentId, [...(children.get(parentId) ?? []), node.display_id])
    }
  }

  const depth = new Map<number, number>()
  const stack: [number, number][] = roots.map((id) => [id, 1])
  while (stack.length > 0) {
    const [id, currentDepth] = stack.pop()!
    depth.set(id, currentDepth)
    for (const childId of children.get(id) ?? []) {
      stack.push([childId, currentDepth + 1])
    }
  }

  let changed = false
  const nodes = detail.nodes.map((node) => {
    const nodeDepth = depth.get(node.display_id)
    if (nodeDepth == null) return node
    const collapsed = children.has(node.display_id) && nodeDepth >= level
    if (node.collapsed === collapsed) return node
    changed = true
    return { ...node, collapsed }
  })
  return changed ? { ...detail, nodes } : detail
}

function newClientRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function foldEventUpdate(msg: unknown): OptimisticFold | null {
  if (!msg || typeof msg !== 'object' || !('action' in msg)) return null
  const event = msg as { action?: unknown; payload?: unknown }
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : null

  if (event.action === 'expanded_all' && payload) return expandAllOptimistically
  if (
    event.action === 'folded_to_level' &&
    payload &&
    typeof payload.level === 'number'
  ) {
    return (detail) => foldToLevelOptimistically(detail, payload.level as number)
  }
  if (
    event.action === 'node_collapsed' &&
    payload &&
    typeof payload.node_id === 'number' &&
    typeof payload.collapsed === 'boolean'
  ) {
    return (detail) =>
      patchCollapsed(detail, payload.node_id as number, payload.collapsed as boolean)
  }
  return null
}

// ── 节点操作按钮的小图标（stroke 用 currentColor，继承按钮配色） ──────

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

// 布局形态图标（lucide move-horizontal / arrow-right 同款）：箭头方向即
// 子树伸展方向——左右双箭头=对称布局、右单箭头=一律靠右；与 Expand 图标
// 的箭头语言一致
const LayoutBalancedIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m18 8 4 4-4 4" />
    <path d="m6 8-4 4 4 4" />
    <path d="M2 12h20" />
  </svg>
)

const LayoutRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
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

// 折叠圆点的 +/−：SVG 几何居中——文本字符的字形留白依平台字体而定
// （macOS 回退 PingFang/雅黑时加号偏左上），画线则与字体无关
const FoldPlusIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

const FoldMinusIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
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
  const { t } = useI18n()
  const [detail, setDetail] = useState<MapDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  // 加节点输入态：anchor = 输入框锚定的节点，dir = 方位与提交语义（见 startAdd）
  const [adding, setAdding] = useState<{ anchor: number; dir: 'child' | 'sibling' } | null>(null)
  const [wsState, setWsState] = useState<'connecting' | 'live' | 'dead'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [revOpen, setRevOpen] = useState(false)
  const [outlineText, setOutlineText] = useState('')
  const [outlineMode, setOutlineMode] = useState<OutlineMode>('merge')
  const [chatOpen, setChatOpen] = useState(false)
  // Agent 入口守门：模型网关未配置时按钮保留但置灰（aria-disabled，真 disabled
  // 收不到 click），点击弹窗说明缺什么配置；null = 检查中暂不渲染（防闪跳）。
  // 状态检查首步即 env 完整性，未配置时快速失败、无外呼
  const [agentStatus, setAgentStatus] = useState<ChatGateStatus | null>(null)
  const [chatGateOpen, setChatGateOpen] = useState(false)
  useEffect(() => {
    void chatApi
      .status()
      .then(setAgentStatus)
      .catch(() => setAgentStatus({ ok: false, reason_code: null, reason_detail: null }))
  }, [])
  const agentOk = agentStatus?.ok ?? false
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
  const foldQueueRef = useRef<Promise<void>>(Promise.resolve())
  const foldSequenceRef = useRef(0)
  const foldRefreshNeededRef = useRef(false)
  const ownFoldRequestsRef = useRef(new Map<string, number>())

  const forgetOwnFoldRequest = useCallback((requestId: string) => {
    const timer = ownFoldRequestsRef.current.get(requestId)
    if (timer != null) window.clearTimeout(timer)
    ownFoldRequestsRef.current.delete(requestId)
  }, [])

  const rememberOwnFoldRequest = useCallback((requestId: string) => {
    const timer = window.setTimeout(() => {
      ownFoldRequestsRef.current.delete(requestId)
    }, 10_000)
    ownFoldRequestsRef.current.set(requestId, timer)
  }, [])

  useEffect(
    () => () => {
      for (const timer of ownFoldRequestsRef.current.values()) window.clearTimeout(timer)
      ownFoldRequestsRef.current.clear()
    },
    [],
  )

  // 布局形态切换后节点坐标剧变，重排动画落定后瞬时 fitView。
  // 聚焦切换**不 fit**——保持用户当前视口（zoom/位置都不动），子树围绕
  // 聚焦点重排即可；跑出视口由方向键导航的出界平移与手动拖拽兜底
  useEffect(() => {
    const t = setTimeout(() => rfRef.current?.fitView({ padding: 0.25, maxZoom: 1 }), 320)
    return () => clearTimeout(t)
  }, [layoutMode])

  // 切换布局形态 / 聚焦：布局变化走动画，不再需要遮罩盖瞬移
  const toggleLayout = () => setLayoutMode((m) => (m === 'balanced' ? 'right' : 'balanced'))

  const switchFocus = useCallback(
    (id: number | null) => {
      if (id === focusId) return
      setFocusId(id)
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

  const queueFoldMutation = useCallback(
    (optimisticUpdate: OptimisticFold, request: (clientRequestId: string) => Promise<void>) => {
      const clientRequestId = newClientRequestId()
      const sequence = ++foldSequenceRef.current
      setDetail((current) => (current ? optimisticUpdate(current) : current))
      rememberOwnFoldRequest(clientRequestId)

      const persist = async () => {
        try {
          await request(clientRequestId)
        } catch (e) {
          forgetOwnFoldRequest(clientRequestId)
          foldRefreshNeededRef.current = true
          setError(e instanceof Error ? e.message : String(e))
          window.setTimeout(() => setError(null), 3500)
        } finally {
          if (sequence === foldSequenceRef.current && foldRefreshNeededRef.current) {
            foldRefreshNeededRef.current = false
            await refresh()
          }
        }
      }

      // UI 立即响应，但持久化严格按点击顺序执行，避免快速连点后服务端终态反序。
      foldQueueRef.current = foldQueueRef.current.then(persist, persist)
    },
    [forgetOwnFoldRequest, refresh, rememberOwnFoldRequest],
  )

  // 数据加载 + WebSocket 实时同步。收放事件携带最小增量，所有页签直接 patch；
  // 自己的乐观更新只确认事件，内容变更仍重拉整棵树。
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
        // 图被删除（列表页 / Agent）：退回列表，不再重拉（get_map 会 404）
        if (msg.action === 'map_deleted') {
          onBack()
          return
        }
        if (
          msg.type === 'changed' &&
          typeof msg.client_request_id === 'string' &&
          ownFoldRequestsRef.current.has(msg.client_request_id)
        ) {
          forgetOwnFoldRequest(msg.client_request_id)
          return
        }
        if (msg.type === 'changed') {
          const update = foldEventUpdate(msg)
          if (update) {
            setDetail((current) => (current ? update(current) : current))
            return
          }
        }
        if (msg.type === 'hello' || msg.type === 'changed') void refresh()
      }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(timer)
      ws?.close()
    }
  }, [mapId, refresh, forgetOwnFoldRequest])

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
      const value = text.trim() // 局部命名避开 i18n 的 t
      if (!value) return
      void guard(() => api.updateNode(mapId, id, value))
    },
    [mapId],
  )
  // 两段式加节点：先出输入框，确认内容后才真正创建（空文本 = 取消）。
  // dir 决定输入框方位与提交语义——child：锚点右侧，创建挂锚点下；
  // sibling：锚点正下方，创建挂锚点的父（MindNodeView 提交时自算父 id）
  const startAdd = useCallback(
    (anchor: number, dir: 'child' | 'sibling' = 'child') => setAdding({ anchor, dir }),
    [],
  )
  const commitAdd = useCallback(
    (parentId: number, text: string) => {
      setAdding(null)
      const value = text.trim() // 局部命名避开 i18n 的 t
      if (!value) return
      void guard(() => api.addNode(mapId, parentId, value))
    },
    [mapId],
  )
  const cancelAdd = useCallback(() => setAdding(null), [])
  const deleteNode = useCallback(
    (id: number) => void guard(() => api.deleteNode(mapId, id)),
    [mapId],
  )
  const toggleCollapse = useCallback(
    (lnode: LNode) => {
      const nodeId = lnode.node.display_id
      const collapsed = !lnode.node.collapsed
      queueFoldMutation(
        (current) => patchCollapsed(current, nodeId, collapsed),
        (clientRequestId) => api.setNodeCollapsed(mapId, nodeId, collapsed, clientRequestId),
      )
    },
    [mapId, queueFoldMutation],
  )

  const setFoldLevel = useCallback(
    (level: number) =>
      queueFoldMutation(
        (current) => foldToLevelOptimistically(current, level),
        (clientRequestId) => api.setFoldLevel(mapId, level, clientRequestId),
      ),
    [mapId, queueFoldMutation],
  )
  const expandAll = useCallback(
    () =>
      queueFoldMutation(
        expandAllOptimistically,
        (clientRequestId) => api.expandAll(mapId, clientRequestId),
      ),
    [mapId, queueFoldMutation],
  )


  // ── layout → React Flow nodes/edges ────────────────────────────────
  const layout = useMemo(
    () => (detail ? layoutMap(detail, layoutMode, focusId) : null),
    [detail, layoutMode, focusId],
  )

  // 方向键导航（层级语义，XMind 同款：→ 进子 / ← 回父 / ↑↓ 兄弟）。
  // 目标节点必在可见集内：当前可见 ⇒ 父链全展开 ⇒ 兄弟与父可见；
  // 唯一例外是 → 的子节点——折叠时先乐观展开（与选中同批 setState，
  // 子节点渲染出来即带选中态）。折叠节点的子数据一直躺在 detail.nodes
  // 里（折叠只是渲染裁剪），找目标不等展开
  const navigate = useCallback(
    (dir: 'child' | 'parent' | 'prev' | 'next') => {
      if (!detail || selectedId == null) return
      const cur = detail.nodes.find((n) => n.display_id === selectedId)
      if (!cur) return
      let target: number | null = null
      if (dir === 'child') {
        const kids = detail.nodes
          .filter((n) => n.parent != null && n.parent.display_id === cur.display_id)
          .sort((a, b) => a.position - b.position)
        if (kids.length === 0) return
        if (cur.collapsed) {
          queueFoldMutation(
            (current) => patchCollapsed(current, cur.display_id, false),
            (clientRequestId) => api.setNodeCollapsed(mapId, cur.display_id, false, clientRequestId),
          )
        }
        target = kids[0].display_id
      } else if (dir === 'parent') {
        // 聚焦根的真父在视野外，回父会选中一个看不见的节点
        if (cur.parent == null || cur.display_id === focusId) return
        target = cur.parent.display_id
      } else {
        if (cur.parent == null) return
        const siblings = detail.nodes
          .filter((n) => n.parent != null && n.parent.display_id === cur.parent!.display_id)
          .sort((a, b) => a.position - b.position)
        const idx = siblings.findIndex((n) => n.display_id === cur.display_id)
        const next = dir === 'prev' ? idx - 1 : idx + 1
        if (idx < 0 || next < 0 || next >= siblings.length) return // 首/末兄弟：停下
        target = siblings[next].display_id
      }
      setSelectedId(target)
      // 视口跟随：目标出界（留 60px 边距）才平移到中心，不出界不动画面。
      // 等 React 渲染出目标 DOM 再判（展开场景新节点要一轮 render 才出现）
      window.setTimeout(() => {
        const el = document.querySelector(`.react-flow__node[data-id="${target}"]`)
        const wrap = document.querySelector('.rf-wrap')
        if (!el || !wrap || !rfRef.current) return
        const er = el.getBoundingClientRect()
        const wr = wrap.getBoundingClientRect()
        const outside =
          er.left < wr.left + 60 || er.right > wr.right - 60 || er.top < wr.top + 60 || er.bottom > wr.bottom - 60
        if (!outside) return
        const ln = layout?.all.find((l) => l.node.display_id === target)
        if (!ln) return
        rfRef.current.setCenter(ln.x + ln.w / 2, ln.y, { duration: 300, zoom: rfRef.current.getZoom() })
      }, 60)
    },
    [detail, selectedId, focusId, mapId, layout, queueFoldMutation],
  )

  // ── 快捷键（F2 编辑 / Tab 加子 / Enter 加兄弟 / Delete 删除 / Esc 退聚焦 / 方向键导航）──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 逐层退出：先关弹层（outline/版本面板），再退聚焦；
      // 输入态（弹层内的编辑框等）让位给局部 Esc 处理
      if (e.key === 'Escape') {
        const el = document.activeElement
        const typing =
          el instanceof HTMLElement &&
          (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (!typing && outlineOpen) {
          setOutlineOpen(false)
          return
        }
        if (!typing && revOpen) {
          setRevOpen(false)
          return
        }
        if (!typing && chatGateOpen) {
          setChatGateOpen(false)
          return
        }
        if (focusId != null && !typing) switchFocus(null)
        return
      }
      if (editingId != null || outlineOpen || revOpen || chatGateOpen || selectedId == null || !detail) return
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
        // Tab/Enter 都是两段式：先出输入框（child=右侧 / sibling=下方），
        // Enter 确认才调 API 创建——不落默认名节点，取消零痕迹
        e.preventDefault()
        startAdd(node.display_id, 'child')
      } else if (e.key === 'Enter') {
        // 布局根无兄弟：聚焦根加兄弟会挂到视野外的真父上，成为不可见变更
        if (node.parent == null || node.display_id === focusId) return
        e.preventDefault()
        startAdd(node.display_id, 'sibling')
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (node.parent == null || node.display_id === focusId) return // 布局根不可删
        e.preventDefault()
        deleteNode(node.display_id)
      } else if (e.key === 'ArrowRight' && e.shiftKey) {
        // Shift+→ 展开当前节点的子树（停在原地），与 Shift+← 折叠对称。
        // 已展开/叶子无操作——不 toggle，收起语义专属 Shift+←
        const hasKids = detail.nodes.some((n) => n.parent?.display_id === node.display_id)
        if (node.collapsed && hasKids) {
          e.preventDefault()
          queueFoldMutation(
            (current) => patchCollapsed(current, node.display_id, false),
            (clientRequestId) => api.setNodeCollapsed(mapId, node.display_id, false, clientRequestId),
          )
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        navigate('child')
      } else if (e.key === 'ArrowLeft' && e.shiftKey) {
        // Shift+← 折叠当前节点的子树（停在原地）；展开也可 Shift+→（对称）
        // 或普通 →（先展开再进子）。已折叠/叶子无操作——不 toggle
        const hasKids = detail.nodes.some((n) => n.parent?.display_id === node.display_id)
        if (!node.collapsed && hasKids) {
          e.preventDefault()
          queueFoldMutation(
            (current) => patchCollapsed(current, node.display_id, true),
            (clientRequestId) => api.setNodeCollapsed(mapId, node.display_id, true, clientRequestId),
          )
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        navigate('parent')
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        navigate('prev')
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        navigate('next')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, editingId, outlineOpen, revOpen, chatGateOpen, detail, mapId, focusId, switchFocus, startAdd, deleteNode, navigate, queueFoldMutation])
  // 重排动画：动画期间逐帧给出节点位置（null = 静止，直接用布局终值）；
  // 边由 React Flow 按节点位置实时重算，滑行中始终与节点贴合
  const animPos = useAnimatedLayout(layout)

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

  // 全树最大深度 + 当前可见深度（无视折叠现算——layout.all 只含可见节点，折叠后会低估）。
  // DFS 单次遍历带 vis 标记：折叠节点自身可见，但其子树整支不可见（对 maxDepth 仍要下钻）
  const { maxDepth, visibleDepth } = useMemo(() => {
    if (!detail) return { maxDepth: 1, visibleDepth: 1 }
    const byParent = new Map<number, NodeDTO[]>()
    let root: NodeDTO | null = null
    for (const n of detail.nodes) {
      if (n.parent == null) root = n
      else byParent.set(n.parent.display_id, [...(byParent.get(n.parent.display_id) ?? []), n])
    }
    if (!root) return { maxDepth: 1, visibleDepth: 1 }
    let max = 1
    let visible = 1
    const stack: [NodeDTO, number, boolean][] = [[root, 1, true]]
    while (stack.length) {
      const [n, d, vis] = stack.pop()!
      max = Math.max(max, d)
      if (vis) visible = Math.max(visible, d)
      const childVis = vis && !n.collapsed
      for (const c of byParent.get(n.display_id) ?? []) stack.push([c, d + 1, childVis])
    }
    return { maxDepth: max, visibleDepth: visible }
  }, [detail])

  // 层级刻度条当前档：可见层已到树底 = 全展开；否则夹到 ≤ 可见深度的最大档
  // （手动展开个别节点后可见深度可能落在档位之间，就近取左档）
  const curLevel: number | 'all' =
    visibleDepth >= maxDepth ? 'all' : Math.min(Math.max(visibleDepth, 2), maxDepth - 1)

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

  // 面包屑同层导航：hover 中间 crumb 弹出其兄弟（同父、非自身、按 position 序）。
  // 打开走 150ms 延迟（沿面包屑扫过不连环弹），关闭即时；点兄弟即聚焦并收起
  const [crumbHoverId, setCrumbHoverId] = useState<number | null>(null)
  const crumbHoverTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(crumbHoverTimer.current), [])
  const siblingsOf = useCallback(
    (id: number): NodeDTO[] => {
      const self = detail?.nodes.find((n) => n.display_id === id)
      if (!detail || !self || self.parent == null) return []
      return detail.nodes
        .filter((n) => n.parent != null && n.parent.display_id === self.parent!.display_id && n.display_id !== id)
        .sort((a, b) => a.position - b.position)
    },
    [detail],
  )

  const callbacks = useMemo(
    () => ({
      onSelect: (id: number) => setSelectedId(id),
      onStartEdit: (id: number) => setEditingId(id),
      onToggleCollapse: toggleCollapse,
      onCommitEdit: commitEdit,
      onCancelEdit: () => setEditingId(null),
      onStartAdd: startAdd,
      onCommitAdd: commitAdd,
      onCancelAdd: cancelAdd,
      onDelete: deleteNode,
      onFocus: switchFocus,
    }),
    [toggleCollapse, commitEdit, startAdd, commitAdd, cancelAdd, deleteNode, switchFocus],
  )

  // ── 刷新门卫：内容签名 ────────────────────────────────────────────────
  // WS 每次推送都产生新 detail/layout 对象；若以其身份作 memo 依赖，即使内容
  // 完全未变，React Flow 也会收到新输入并触发内部锚点重测（ResizeObserver
  // 异步），重测窗口内连线滞后甚至消失——肉眼即「改个文字边也闪断一次」。
  // 签名不变 → 复用上一轮对象 → React Flow 拿到全等 props，完全不动作。
  // 字段与 MindNode 实际消费严格对齐（content/collapsed/side/尺寸/交互态），
  // 漏一项就是残留旧状态的 bug，改 MindNode 时记得同步这里。
  const nodesSig = useMemo(() => {
    if (!layout) return ''
    return layout.all
      .map((ln) => {
        const id = ln.node.display_id
        const flags =
          (id === selectedId ? 's' : '') +
          (id === editingId ? 'e' : '') +
          (id === adding?.anchor ? (adding.dir === 'sibling' ? 'S' : 'a') : '') +
          ((childCount.get(id) ?? 0) > 0 ? 'h' : '')
        return `${id}:${Math.round(ln.x)},${Math.round(ln.y)},${ln.w}x${ln.h}:${ln.side}${ln === layout.root ? 'R' : ''}${ln.node.collapsed ? 'C' : ''}:${flags}:${ln.node.content}`
      })
      .join('|')
  }, [layout, selectedId, editingId, adding, childCount])

  // 边签名只看结构（谁连谁 + 锚定侧）：文本 / 选中态变化不影响边
  const edgesSig = useMemo(() => {
    if (!layout) return ''
    const parts: string[] = []
    for (const ln of layout.all)
      for (const c of ln.children) parts.push(`${ln.node.display_id}-${c.node.display_id}-${c.side}`)
    return parts.join('|')
  }, [layout])

  // 依赖是签名而非 layout 身份（内容未变即复用）；animPos 在动画期间逐帧变化，
  // 照常驱动重建；callbacks 单列——语言切换时 t 变化需重建，
  // 普通刷新间其身份稳定，不破签名门卫
  const rfNodes: MindNode[] = useMemo(() => {
    if (!layout) return []
    return layout.all.map((lnode) => {
      const p = animPos?.get(lnode.node.display_id)
      return {
        id: String(lnode.node.display_id),
        type: 'mind' as const,
        position: { x: p?.x ?? lnode.x, y: (p?.y ?? lnode.y) - lnode.h / 2 },
        width: lnode.w, // 供 MiniMap 等在 DOM 测量前使用（nodeHasDimensions）
        height: lnode.h,
        style: { width: lnode.w, height: lnode.h, opacity: p ? p.op : 1 },
        selected: lnode.node.display_id === selectedId,
        data: {
          lnode,
          isLayoutRoot: lnode === layout.root, // 引用相等：all 里的根对象就是 layout.root
          isEditing: lnode.node.display_id === editingId,
          isAdding: lnode.node.display_id === adding?.anchor,
          addingDir: adding?.dir ?? 'child',
          hasChildren: (childCount.get(lnode.node.display_id) ?? 0) > 0,
          ...callbacks,
        },
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 门卫注释见上；layout 由 nodesSig 表达
  }, [nodesSig, animPos, callbacks])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 结构由 edgesSig 表达，身份不变即复用
  }, [edgesSig])

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
        {error ? <div className="toast">{error}</div> : t('common.loading')}
        <button className="btn" onClick={onBack}>← {t('common.back')}</button>
      </div>
    )
  }

  return (
    <div className="editor">
      <header className="toolbar">
        <button className="btn icon" onClick={onBack} title={t('common.backToList')} aria-label={t('common.backToList')}>☰</button>
        <span className={`ws-dot ${wsState}`} title={t('ws.sync', { state: t(`ws.${wsState}` as I18nKey) })} />
        <span className={`ws-label ${wsState}`}>
          {t(`ws.${wsState}` as I18nKey)}
        </span>
        <div className="spacer" />
        {agentStatus != null &&
          (agentOk ? (
            <button
              className={`btn icon ${chatOpen ? 'active' : ''}`}
              onClick={() => setChatOpen((v) => !v)}
              title={t('editor.agentChat')}
              aria-label={t('editor.agentChat')}
            >
              <ChatIcon />
            </button>
          ) : (
            <button
              className="btn icon gated"
              aria-disabled="true"
              onClick={() => setChatGateOpen(true)}
              title={t('chat.gatedTitle')}
              aria-label={t('chat.gatedTitle')}
            >
              <ChatIcon />
            </button>
          ))}
        <button className="btn icon" onClick={openOutline} title={t('editor.outlineEdit')} aria-label={t('editor.outlineEdit')}>
          <PencilIcon />
        </button>
        <LangSwitch />
      </header>

      {error && <div className="toast editor-toast">{error}</div>}

      {/* 横向主体：画布始终全宽；聊天面板 absolute 悬浮于右侧（overlay，不压缩画布） */}
      <div className="editor-main">
        <div className="rf-wrap">
          {/* 标题悬浮于画板左上角，独立于工具栏；pointer-events:none 不挡画布交互
              （面包屑在 .crumbs 上局部恢复 pointer-events:auto） */}
          <div className="map-title">
            <span className="name" title={detail.title}>{detail.title}</span>
            <button
              className="ver"
              title={t('rev.open')}
              aria-label={t('rev.open')}
              onClick={() => setRevOpen(true)}
            >
              v{detail.version}
            </button>
            {focusPath.length > 0 && (
              <span className="crumbs">
                {focusPath.map((n, i) => {
                  // 根(i=0)=返回全图、无兄弟不挂菜单；中间项与当前项都挂同层导航
                  // （当前项最常用：正在看第 4 部，hover 弹出第 5/6 部直接切）
                  const withMenu = i > 0
                  const isCurrent = i === focusPath.length - 1
                  return (
                    <Fragment key={n.display_id}>
                      <span className="crumb-sep">›</span>
                      {withMenu ? (
                        <span
                          className="crumb-wrap"
                          onMouseEnter={() => {
                            window.clearTimeout(crumbHoverTimer.current)
                            crumbHoverTimer.current = window.setTimeout(() => setCrumbHoverId(n.display_id), 150)
                          }}
                          onMouseLeave={() => {
                            window.clearTimeout(crumbHoverTimer.current)
                            setCrumbHoverId((cur) => (cur === n.display_id ? null : cur))
                          }}
                        >
                          {isCurrent ? (
                            <span className="crumb cur" title={n.content}>
                              {n.content}
                            </span>
                          ) : (
                            <button
                              className="crumb"
                              title={t('editor.focusTo', { content: n.content })}
                              onClick={() => switchFocus(n.display_id)}
                            >
                              {n.content}
                            </button>
                          )}
                          {crumbHoverId === n.display_id && (
                            <CrumbMenu
                              siblings={siblingsOf(n.display_id)}
                              onPick={(id) => {
                                setCrumbHoverId(null)
                                switchFocus(id)
                              }}
                            />
                          )}
                        </span>
                      ) : (
                        <button
                          className="crumb"
                          title={t('editor.backToFull')}
                          onClick={() => switchFocus(null)}
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
          {/* 画布左上角工具列：标题下方，布局切换 + 层级刻度条 */}
          <div className="canvas-tools">
            <button
              className="btn"
              onClick={toggleLayout}
              title={layoutMode === 'balanced' ? t('layout.balanced.title') : t('layout.right.title')}
              aria-label={layoutMode === 'balanced' ? t('layout.balanced.aria') : t('layout.right.aria')}
            >
              {layoutMode === 'balanced' ? <LayoutBalancedIcon /> : <LayoutRightIcon />}
            </button>
            {maxDepth >= 3 && (
              <div className="fold-steps" role="group" aria-label={t('fold.hint')}>
                {/* 档位 2..maxDepth-1（maxDepth 档与「全」重复，砍掉）；点档折叠到该层，最右「全」= 全部展开 */}
                {Array.from({ length: maxDepth - 2 }, (_, i) => i + 2).map((lv) => (
                  <button
                    key={lv}
                    className={`btn sm${curLevel === lv ? ' active' : ''}`}
                    aria-pressed={curLevel === lv}
                    title={t('fold.toLevel', { lv })}
                    onClick={() => {
                      if (curLevel !== lv) setFoldLevel(lv)
                    }}
                  >
                    {lv}
                  </button>
                ))}
                <button
                  className={`btn sm${curLevel === 'all' ? ' active' : ''}`}
                  aria-pressed={curLevel === 'all'}
                  title={t('editor.expandAll')}
                  onClick={() => {
                    if (curLevel !== 'all') expandAll()
                  }}
                >
                  {t('fold.allLabel')}
                </button>
              </div>
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
            setAdding(null)
          }}
            proOptions={{ hideAttribution: true }}
          >
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              className="rf-minimap"
              nodeColor="#ffffff" /* 全部白底（与画布节点一致），形状靠描边呈现 */
              nodeStrokeColor={(n) => {
                const d = n.data as MindNodeData
                return d.isLayoutRoot ? '#0f172a' : '#94a3b8' // 根用深描边保持可寻
              }}
            />
          </ReactFlow>
        </div>

        {chatOpen && agentOk && (
          <ChatPanel mapId={mapId} width={chatWidth} onResize={setChatWidth} onClose={() => setChatOpen(false)} />
        )}
      </div>

      {outlineOpen && (
        <div className="modal" onClick={() => setOutlineOpen(false)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h3>{t('outline.title')}</h3>
            <textarea
              className="outline-editor"
              value={outlineText}
              onChange={(e) => setOutlineText(e.target.value)}
              spellCheck={false}
            />
            <div className="modal-actions">
              <select value={outlineMode} onChange={(e) => setOutlineMode(e.target.value as OutlineMode)}>
                <option value="merge">{t('outline.merge')}</option>
                <option value="replace">{t('outline.replace')}</option>
              </select>
              <button className="btn" onClick={applyOutline}>{t('common.apply')}</button>
              <button className="btn" onClick={() => setOutlineOpen(false)}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 未配置模型网关：点置灰的对话按钮弹出配置指引（服务端 reason_code 本地化渲染） */}
      {chatGateOpen && (
        <div className="modal" onClick={() => setChatGateOpen(false)}>
          <div className="modal-body gate" onClick={(e) => e.stopPropagation()}>
            <h3>{t('chat.gatedTitle')}</h3>
            <div className="gate-body">
              <p>{t(agentStatus?.desktop ? 'chat.gatedBodyDesktop' : 'chat.gatedBody')}</p>
              {agentStatus?.reason_code && (
                <p className="gate-reason">
                  {gateReasonText(t, agentStatus.reason_code, agentStatus.reason_detail)}
                </p>
              )}
            </div>
            <div className="modal-actions">
              <div className="spacer" />
              <button className="btn" onClick={() => setChatGateOpen(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {revOpen && (
        <RevisionPanel
          mapId={mapId}
          current={detail}
          layoutMode={layoutMode}
          onClose={() => setRevOpen(false)}
        />
      )}
    </div>
  )
}
