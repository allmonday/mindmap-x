import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, chatApi, gateReasonText, type ChatGateStatus } from './api'
import { ChatPanel } from './ChatPanel'
import { DetailPanel } from './DetailPanel'
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
  selectedByPointer: boolean // 选中来源：点击亮按钮行，键盘导航只高亮
  hasChildren: boolean
  hasNote: boolean // 带 markdown 备注（角标 ✎ 的显隐源）
  onSelect: (id: number, hasNote?: boolean) => void // hasNote 驱动备注面板开合
  onStartEdit: (id: number) => void
  onToggleCollapse: (lnode: LNode) => void
  onCommitEdit: (id: number, text: string) => void
  onCancelEdit: () => void
  onStartAdd: (parentId: number, dir?: 'child' | 'sibling') => void
  onCommitAdd: (parentId: number, text: string) => void
  onCancelAdd: () => void
  onDelete: (id: number) => void
  onFocus: (id: number) => void // 聚焦（下钻）到该节点
  onOpenNote: (id: number) => void // 打开备注面板并选中该节点
}

type MindNode = Node<MindNodeData, 'mind'>

function MindNodeView({ data, selected }: NodeProps<MindNode>) {
  const { lnode, isEditing, isAdding, addingDir, selectedByPointer, hasChildren, hasNote } = data
  const n = lnode.node
  const isRoot = data.isLayoutRoot // 布局根 = 真根或聚焦节点；非聚焦时与真根判定完全一致
  // 文案经 context 直取（ReactFlow 的 memo 不拦截 context 更新）——
  // 切语言时本组件自渲染，rfNodes memo 不需要重建
  const { t } = useI18n()

  // 加节点输入框聚焦：effect 在 commit 后跑——autoFocus 只在 mount 一瞬生效，
  // 会被 React Flow 对 selected 节点的 focus 管理抢走（键盘选中后打开时必现）
  const addInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (isAdding) addInputRef.current?.focus()
  }, [isAdding])

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
  // 按钮行只认点击选中；键盘导航选中只做高亮定位（操作走快捷键）
  const showActions = !isEditing && selected && selectedByPointer

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
        data.onSelect(n.display_id, data.hasNote)
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

      {/* 备注角标（折角便签）：有 markdown 长文的节点一眼可辨（点击直开备注面板）。
          编辑态隐藏——textarea 盖满节点，角标叠上去无意义 */}
      {hasNote && !isEditing && (
        <button
          className="note-mark"
          title={t('note.markTitle')}
          aria-label={t('note.markTitle')}
          onClick={(e) => {
            e.stopPropagation()
            data.onOpenNote(n.display_id)
          }}
        >
          <StickyNoteIcon />
        </button>
      )}

      {/* ID 角标：与 outline 协议 [id:N] 呼应，方便 Agent 精确锚定节点 */}
      <span className={`id-badge ${isRoot ? 'on-root' : ''}`}>#{n.display_id}</span>

      {/* 节点操作按钮：节点左下方，点击选中时显示（.show 由 selected 驱动，
          点画布/其他节点即消失）。加子模式 = 输入框 + 保存，确认后才创建节点 */}
      {!isEditing && (
        isAdding ? (
          <div className={`node-actions adding as-${addingDir}`}>
            <input
              ref={addInputRef}
              className="add-input"
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
            {/* 添加备注：无备注节点的创建入口（有备注的节点点击即开面板，无需按钮） */}
            {!hasNote && (
              <button
                className="btn sm"
                title={t('node.addNoteTitle')}
                aria-label={t('node.addNoteTitle')}
                onClick={(e) => {
                  e.stopPropagation()
                  data.onOpenNote(n.display_id)
                }}
              >
                <StickyNoteIcon size={11} />
              </button>
            )}
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

// 自定义边（default 的同款视觉：bezier + BaseEdge）+ React.memo：
// RF 内部 EdgeWrapper 用 useStore 订阅节点位置，重渲染绕过外层 memo，
// 默认边因此每帧全量重挂（实测 19 边 × ~3 SVG 元素/渲染轮，d 属性从不
// 走更新路径）——memo 后 props（两端坐标）不变即跳过，动画期间坐标
// 逐帧变则走 d 属性更新，DOM 不再卸载重挂
const MindEdge = memo(function MindEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return <BaseEdge id={id} path={path} />
})

const edgeTypes = { mind: MindEdge }

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

// ↑/↓ 层内流（2026-09-01 拍板）：同父兄弟直接给；兄弟序列到头看父的
// 相邻兄弟 U——U 有可见子则落衔接端（down=U 首子 / up=U 末子），无则落
// U 本身（折叠块是一块砖，不主动展开）；父无相邻兄弟 = 停（不上溯更
// 上层找延续）。落点恒可见：cur 可见 ⇒ 父链全展开 ⇒ 兄弟、U、U 的
// 展开子都在可见集内——永不触发展开，也无需展开。布局根（真根/聚焦根）
// 无层流：cur 或父为布局根 → null（←→ 负责进出层级）
function verticalNeighbor(nodes: NodeDTO[], curId: number, rootId: number, down: boolean): number | null {
  const kidsOf = (pid: number): NodeDTO[] =>
    nodes
      .filter((n) => n.parent != null && n.parent.display_id === pid)
      .sort((a, b) => a.position - b.position)
  const cur = nodes.find((n) => n.display_id === curId)
  const parent = cur?.parent ?? null
  if (!cur || !parent || curId === rootId) return null
  // 1) 兄弟间直接移动
  const sibs = kidsOf(parent.display_id)
  const i = sibs.findIndex((n) => n.display_id === curId)
  if (i < 0) return null
  if (down ? i < sibs.length - 1 : i > 0) return (down ? sibs[i + 1] : sibs[i - 1]).display_id
  // 2) 兄弟序列到头：父的相邻兄弟 U（父是布局根则层流闭合于其子树）。
  //    parent 是 NodeRef（仅 display_id 引用）——查回完整节点才有祖父
  if (parent.display_id === rootId) return null
  const gref = nodes.find((n) => n.display_id === parent.display_id)?.parent ?? null
  if (gref == null) return null
  const psibs = kidsOf(gref.display_id)
  const pi = psibs.findIndex((n) => n.display_id === parent.display_id)
  if (pi < 0) return null
  const u = down ? psibs[pi + 1] : psibs[pi - 1]
  if (!u) return null // 父是末/首子：停
  // U 不可能是布局根（它有父，布局根无父或在聚焦场景中不与其孩子同父），
  // collapsed 判定即真实可见性
  const ukids = u.collapsed ? [] : kidsOf(u.display_id)
  if (ukids.length === 0) return u.display_id
  return (down ? ukids[0] : ukids[ukids.length - 1]).display_id
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

// 备注角标（lucide sticky-note：折角便签——"这里贴了张纸"）。
// 画线而非文本字符：字形留白随平台字体回退漂移（✎ 在部分系统偏左上），
// 与 FoldPlusIcon 同一教训。size 参数：节点角标 9（默认），按钮行 11
const StickyNoteIcon = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z" />
    <path d="M15 3v4a2 2 0 0 0 2 2h4" />
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

// 节点备注开关（lucide note-tabs-pen：页签 + 斜笔，"页面上的长文"）
const NoteIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M15 8v2H9V8z" />
    <path d="m13 15 5-5 1.5 1.5-5 5L13 17z" />
  </svg>
)

// ── editor ────────────────────────────────────────────────────────────

export function MindMapEditor({ mapId, onBack }: Props) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<MapDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // 选中来源：点击=要操作这个节点（亮按钮行）；键盘导航=移动浏览焦点
  //（不亮按钮，快捷键 F2/Tab/Enter/Delete 已覆盖操作入口）
  const [selectedByPointer, setSelectedByPointer] = useState(true)
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
  // 节点备注面板：左侧悬浮（与右侧聊天面板一左一右并存，互不遮挡）。
  // pinned：常驻模式——选中变到别处（点别的节点/空白/键盘导航）不收起，
  // 内容跟随选中（空态兜底）；未 pin 时面板依附于角标打开的节点，选中
  // 一变即收起。关闭（Esc/工具栏/d）一律同时解除 pin
  const [noteOpen, setNoteOpen] = useState(false)
  const [notePinned, setNotePinned] = useState(false)
  // 渲染挂载与逻辑开合分离：关闭时先播收回动画（closing class）再卸载——
  // 条件渲染直接卸载没有退出动画可播。展开动画由挂载自动播放（CSS animation）
  const [noteMounted, setNoteMounted] = useState(false)
  useEffect(() => {
    if (noteOpen) {
      setNoteMounted(true)
      return
    }
    // 关闭：等收回动画播完（0.26s，留余量）再卸载；期间 closing class 生效
    const t = window.setTimeout(() => setNoteMounted(false), 300)
    return () => window.clearTimeout(t)
  }, [noteOpen])
  const [noteWidth, setNoteWidth] = useState(() => {
    const saved = Number(localStorage.getItem('noteWidth'))
    return saved >= 280 && saved <= 760 ? saved : 480
  })
  useEffect(() => {
    localStorage.setItem('noteWidth', String(noteWidth))
  }, [noteWidth])
  const toggleNote = useCallback(() => {
    setNoteOpen((v) => {
      const nv = !v
      if (!nv) setNotePinned(false) // 整体关闭 = 解除 pin，下次开回到依附模式
      return nv
    })
  }, [])
  const noteNode = useMemo(
    () => detail?.nodes.find((n) => n.display_id === selectedId) ?? null,
    [detail, selectedId],
  )

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
  // 备注保存与 commitEdit 同款"无乐观更新"流：保存 → WS changed → refresh() 全量重拉。
  // note 走第四参（content undefined 被 JSON.stringify 丢弃 = 不动）。
  // 返回是否成功：内联 guard 逻辑（guard 吞错后调用方无从分辨成败——面板需要
  // 失败时保留脏态可重试，不能把失败当已保存前移基线）
  const saveNote = useCallback(
    async (nodeId: number, note: string): Promise<boolean> => {
      try {
        await api.updateNode(mapId, nodeId, undefined, note)
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        window.setTimeout(() => setError(null), 3500)
        return false
      }
    },
    [mapId],
  )
  // 两段式加节点：先出输入框，确认内容后才真正创建（空文本 = 取消）。
  // dir 决定输入框方位与提交语义——child：锚点右侧，创建挂锚点下；
  // sibling：锚点正下方，创建挂锚点的父（MindNodeView 提交时自算父 id）
  const startAdd = useCallback((anchor: number, dir: 'child' | 'sibling' = 'child') => {
    setAdding({ anchor, dir })
    // 焦点仲裁：React Flow 对 selected 节点（tabindex=0）的 focus 管理会盖掉
    // 输入框的 autoFocus / mount effect focus（键盘导航后打开时必现，字符全丢）。
    // setTimeout 宏任务在 React commit 与全部同步 effect 之后跑，最后拿到焦点
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>('.add-input')?.focus()
    }, 0)
  }, [])
  const commitAdd = useCallback(
    (parentId: number, text: string) => {
      setAdding(null)
      const value = text.trim() // 局部命名避开 i18n 的 t
      if (!value) return
      // 真创建才收起锚点的按钮行：点击选中打开的输入框提交后，按钮行
      // 不再回亮（选中高亮保留，操作入口交回快捷键）。空文本取消不动——
      // 点开的上下文不该被 Esc 顺手清掉
      setSelectedByPointer(false)
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

  // 方向键导航（物理方向语义：←→ 指哪打哪 / ↑↓ 层内流）。
  // ←→ 按屏幕方位路由：balanced 布局左半边的子节点在物理左侧——层级语义
  // （→ 永远进子）会反向跳，故按键一侧有子则进子（折叠先乐观展开），无子
  // 且自身在对面子树则回父（父物理上就在按键方向）；right-aligned 布局全
  // side=1，规则自动退化为 → 进子 / ← 回父。目标必在可见集内：当前可见 ⇒
  // 父链全展开；折叠节点的子数据躺在 detail.nodes（折叠只是渲染裁剪），
  // 找目标不等展开。↑↓ 见 verticalNeighbor：层内流，永不触发展开
  const navigate = useCallback(
    (dir: 'right' | 'left' | 'prev' | 'next') => {
      if (!detail || !layout || selectedId == null) return
      const lcur = layout.all.find((l) => l.node.display_id === selectedId)
      const cur = detail.nodes.find((n) => n.display_id === selectedId)
      if (!cur || !lcur) return
      let target: number | null = null
      if (dir === 'right' || dir === 'left') {
        const wantSide = dir === 'right' ? 1 : -1
        // 1) 按键一侧有子 → 进第一个（折叠则先乐观展开，与选中同批 setState）。
        //    折叠时 lcur.children 为空（layout 只建可见树）——从全量 detail.nodes
        //    找子，side 按"子树同侧继承"推断：非根节点的子与其同侧
        //    （布局根不涉及：真根不可折叠、聚焦根视作展开）
        let kidIds: number[] = []
        if (lcur.children.length > 0) {
          kidIds = lcur.children
            .filter((c) => c.side === wantSide)
            .sort((a, b) => a.node.position - b.node.position)
            .map((c) => c.node.display_id)
        } else if (cur.collapsed && lcur !== layout.root && lcur.side === wantSide) {
          kidIds = detail.nodes
            .filter((n) => n.parent != null && n.parent.display_id === cur.display_id)
            .sort((a, b) => a.position - b.position)
            .map((n) => n.display_id)
        }
        if (kidIds.length > 0) {
          if (cur.collapsed) {
            queueFoldMutation(
              (current) => patchCollapsed(current, cur.display_id, false),
              (clientRequestId) => api.setNodeCollapsed(mapId, cur.display_id, false, clientRequestId),
            )
          }
          target = kidIds[0]
        } else if (lcur.side === -wantSide) {
          // 2) 自身在对面子树 → 父物理上就在按键方向 → 回父。
          //    聚焦根的真父在视野外，回父会选中一个看不见的节点
          if (cur.parent != null && cur.display_id !== focusId) target = cur.parent.display_id
        }
        // 3) 都不满足（同侧叶子往同侧按 / 根往无子一侧按）→ 无操作
      } else {
        // ↑/↓ = 层内流（规则见 verticalNeighbor）：兄弟直接移动；兄弟序列
        // 到头看父的相邻兄弟——展开落衔接端子节点，折叠落其本身；无则停。
        // 落点恒可见：无展开副作用，旧先序流的"展开遮挡祖先"整段删除
        target = verticalNeighbor(detail.nodes, selectedId, layout.root!.node.display_id, dir === 'next')
      }
      // 物理方向无目标（同侧叶子往同侧按）＝无操作：不清选中、不动画
      if (target == null) return
      setSelectedId(target)
      setSelectedByPointer(false)
      // 键盘导航同款规则：面板开合跟随"目标节点有无备注"（pin 恒开）
      if (!notePinned) {
        const tnode = detail.nodes.find((n) => n.display_id === target)
        setNoteOpen(!!tnode?.note)
      }
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
    [detail, selectedId, focusId, mapId, layout, queueFoldMutation, notePinned],
  )

  // ── 快捷键（F2·Ctrl+Enter 编辑 / Tab 加子 / Enter 加兄弟 / Delete 删除 / Space 收放 / Esc 退聚焦 / 方向键导航）──
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
        if (!typing && noteOpen) {
          setNoteOpen(false)
          setNotePinned(false)
          return
        }
        if (focusId != null && !typing) switchFocus(null)
        return
      }
      // 加节点输入框开着时全局快捷键全禁：即使焦点异常不在 input 上，
      // Enter/Tab 也不许再把已开的输入框切模式（防焦点被抢时的次生误操作）
      if (adding != null) return
      // d = 备注面板开合：插在综合守卫之前——无选中时也允许"关"（开着面板
      // 但选区已被清空的场景）；面板内 textarea 聚焦时走下方输入元素守卫
      if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = document.activeElement
        const typing =
          el instanceof HTMLElement &&
          (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (typing || editingId != null || outlineOpen || revOpen || chatGateOpen) return
        if (selectedId == null && !noteOpen) return // 无选中且未开：无可展示的对象
        e.preventDefault()
        toggleNote()
        return
      }
      if (editingId != null || outlineOpen || revOpen || chatGateOpen || selectedId == null || !detail) return
      // 聊天面板开着时：浏览类（方向键/空格收放）保留——边聊边看图是常态流；
      // 只禁会产生编辑界面的键（Enter/Tab 弹输入框、F2 进编辑、Delete 删子树）：
      // 输入框 disabled（Agent 处理中）会把焦点踢到 body、点面板非输入区焦点
      // 也不在 textarea，activeElement 推断失效，用户按 Enter 想发消息却会
      // 触发画布"加兄弟"
      if (chatOpen && (e.key === 'F2' || e.key === 'Tab' || e.key === 'Enter' || e.key === 'Delete'))
        return
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
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+Enter 直接编辑当前节点（F2 的顺手版——单手可达）
        e.preventDefault()
        setEditingId(node.display_id)
      } else if (e.key === 'Enter') {
        // 布局根无兄弟：聚焦根加兄弟会挂到视野外的真父上，成为不可见变更
        if (node.parent == null || node.display_id === focusId) return
        e.preventDefault()
        startAdd(node.display_id, 'sibling')
      } else if (e.key === 'Delete') {
        // 删除只认 Delete 不认 Backspace：退格误触率高（打字肌肉记忆），
        // 而这里删的是整个子树，代价太大
        if (node.parent == null || node.display_id === focusId) return // 布局根不可删
        e.preventDefault()
        deleteNode(node.display_id)
      } else if (e.key === ' ' || e.code === 'Space') {
        // Space = 收放当前节点的子树（toggle，Freeplane 同款）。
        // 叶子/布局根无操作——真根不可折叠，聚焦根视作展开
        const lsel = layout?.all.find((l) => l.node.display_id === selectedId)
        const hasKids =
          (lsel?.children.length ?? 0) > 0 ||
          detail.nodes.some((n) => n.parent?.display_id === node.display_id)
        if (lsel && lsel !== layout?.root && hasKids) {
          e.preventDefault()
          const collapsed = !node.collapsed
          queueFoldMutation(
            (current) => patchCollapsed(current, node.display_id, collapsed),
            (clientRequestId) => api.setNodeCollapsed(mapId, node.display_id, collapsed, clientRequestId),
          )
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        navigate('right')
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        navigate('left')
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
  }, [selectedId, editingId, adding, outlineOpen, revOpen, chatGateOpen, chatOpen, noteOpen, detail, mapId, focusId, switchFocus, startAdd, deleteNode, navigate, queueFoldMutation, toggleNote])
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
      onSelect: (id: number, hasNote?: boolean) => {
        setSelectedId(id)
        setSelectedByPointer(true)
        // 点击节点 = 选中 + 备注面板按"有无备注"开合（无备注节点不弹空面板，
        // 创建入口走按钮行的添加备注按钮 / d 键 / 工具栏）。pin 时恒开不动
        if (!notePinned) setNoteOpen(!!hasNote)
      },
      onStartEdit: (id: number) => setEditingId(id),
      onToggleCollapse: toggleCollapse,
      onCommitEdit: commitEdit,
      onCancelEdit: () => setEditingId(null),
      onStartAdd: startAdd,
      onCommitAdd: commitAdd,
      onCancelAdd: cancelAdd,
      onDelete: deleteNode,
      onFocus: switchFocus,
      onOpenNote: (id: number) => {
        setSelectedId(id)
        setSelectedByPointer(true)
        setNoteOpen(true) // 角标是打开入口（不自动 pin；stopPropagation 不触发 onSelect）
      },
    }),
    [toggleCollapse, commitEdit, startAdd, commitAdd, cancelAdd, deleteNode, switchFocus, notePinned],
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
          (id === selectedId && selectedByPointer ? 'P' : '') +
          (id === editingId ? 'e' : '') +
          (id === adding?.anchor ? (adding.dir === 'sibling' ? 'S' : 'a') : '') +
          ((childCount.get(id) ?? 0) > 0 ? 'h' : '') +
          (ln.node.note ? 'n' : '')
        return `${id}:${Math.round(ln.x)},${Math.round(ln.y)},${ln.w}x${ln.h}:${ln.side}${ln === layout.root ? 'R' : ''}${ln.node.collapsed ? 'C' : ''}:${flags}:${ln.node.content}`
      })
      .join('|')
  }, [layout, selectedId, selectedByPointer, editingId, adding, childCount])

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
  //
  // 节点级引用复用：内容未变的节点返回上一轮的同对象。React Flow 对新
  // 节点对象会重置 internals（handleBounds 需重测），间隙里边查不到锚点
  // → EdgeWrapper 渲染 null → 全部边卸载重挂（实测 19 边 × 3 svg/轮，
  // 动画 300ms 内 400+ 次，即"边集体闪没再闪回"的根因）。复用对象 =
  // RF 视节点未变、internals 沿用，边保持挂载、path 走 d 属性更新。
  const prevNodesRef = useRef(new Map<string, { key: string; node: MindNode }>())
  const rfNodes: MindNode[] = useMemo(() => {
    if (!layout) return []
    const prev = prevNodesRef.current
    const next = new Map<string, { key: string; node: MindNode }>()
    const result = layout.all.map((lnode) => {
      const id = String(lnode.node.display_id)
      const p = animPos?.get(lnode.node.display_id)
      const sel = lnode.node.display_id === selectedId
      const x = p?.x ?? lnode.x
      const y = (p?.y ?? lnode.y) - lnode.h / 2
      const op = p ? p.op : 1
      // 节点内容签名：RF 与 MindNodeView 消费的全部字段（nodesSig 同源维度
      // + 交互态 + 动画位置/透明度）。签名相同 → 复用旧对象。
      // 透明度取 1% 粒度（视觉阈值）：整数 round 会让中断帧 op≈0.5 撞上终态
      // key（半透明对象被永久复用——节点卡浅色）；千分位精确又使动画尾段
      // 每帧换对象（churn 回升）。1% 粒度两头兼顾：0.5 不撞 1，>0.995 等价 1
      const key = `${id}:${Math.round(x)},${Math.round(y)},${Math.round(op * 100)}:${sel ? 's' : ''}${
        lnode.node.display_id === editingId ? 'e' : ''
      }${lnode.node.display_id === adding?.anchor ? (adding!.dir === 'sibling' ? 'S' : 'a') : ''}${
        sel && selectedByPointer ? 'P' : ''
      }:${lnode === layout.root ? 'R' : ''}${(childCount.get(lnode.node.display_id) ?? 0) > 0 ? 'h' : ''}${
        lnode.node.note ? 'n' : ''
      }`
      const old = prev.get(id)
      // callbacks 身份代表整个 data 回调组（其内部字段同批重建）
      if (old && old.key === key && old.node.data.onSelect === callbacks.onSelect) {
        next.set(id, old)
        return old.node
      }
      const fresh: MindNode = {
        id,
        type: 'mind' as const,
        position: { x, y },
        width: lnode.w, // 供 MiniMap 等在 DOM 测量前使用（nodeHasDimensions）
        height: lnode.h,
        style: { width: lnode.w, height: lnode.h, opacity: op },
        selected: sel,
        data: {
          lnode,
          isLayoutRoot: lnode === layout.root, // 引用相等：all 里的根对象就是 layout.root
          isEditing: lnode.node.display_id === editingId,
          isAdding: lnode.node.display_id === adding?.anchor,
          addingDir: adding?.dir ?? 'child',
          selectedByPointer: sel && selectedByPointer,
          hasChildren: (childCount.get(lnode.node.display_id) ?? 0) > 0,
          hasNote: !!lnode.node.note,
          ...callbacks,
        },
      }
      next.set(id, { key, node: fresh })
      return fresh
    })
    prevNodesRef.current = next
    return result
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
          type: 'mind',
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
        {/* 备注面板开关：人工 + Agent 共用，不走 agentStatus 门控 */}
        <button
          className={`btn icon ${noteOpen ? 'active' : ''}`}
          onClick={toggleNote}
          title={t('editor.nodeNote')}
          aria-label={t('editor.nodeNote')}
        >
          <NoteIcon />
        </button>
        <button className="btn icon" onClick={openOutline} title={t('editor.outlineEdit')} aria-label={t('editor.outlineEdit')}>
          <PencilIcon />
        </button>
        <LangSwitch />
      </header>

      {error && <div className="toast editor-toast">{error}</div>}

      {/* 横向主体：画布始终全宽；聊天面板悬浮右侧、备注面板悬浮左侧（overlay，不压缩画布）。
          备注面板 top 让出左上组件区（标题/工具列原地不动，见 App.css .detail-panel） */}
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
            edgeTypes={edgeTypes}
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
            // 点空白清选中 = 离开依附节点：未 pin 的备注面板收起
            if (noteOpen && !notePinned) setNoteOpen(false)
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
        {noteMounted && (
          <DetailPanel
            node={noteNode}
            width={noteWidth}
            onResize={setNoteWidth}
            pinned={notePinned}
            onTogglePin={() => setNotePinned((v) => !v)}
            closing={!noteOpen}
            onSaveNote={saveNote}
          />
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
