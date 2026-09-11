import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, chatApi, type ChatGateStatus } from './api'
import { ChatPanel } from './ChatPanel'
import { DetailPanel } from './DetailPanel'
import { useI18n, type I18nKey } from './i18n'
import { LangSwitch } from './LangSwitch'
import { layoutMap, type LNode, type LayoutMode } from './layout'
import { ProviderConfigModal } from './ProviderConfigModal'
import { RevisionPanel } from './RevisionPanel'
import { ThemeSwitch } from './ThemeSwitch'
import { HelpIcon, HelpPanel } from './HelpPanel'
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
  hasNote: boolean // 带 markdown 备注（角标 ✎ 的显隐源）
  onSelect: (id: number) => void // 静默选中：只高亮（方向键/快捷键的锚点），不弹任何 UI
  onActivate: (id: number, hasNote: boolean) => void // 长按：有备注开备注面板（无备注静默）
  onStartEdit: (id: number) => void
  onToggleCollapse: (lnode: LNode) => void
  onCommitEdit: (id: number, text: string) => void
  onCancelEdit: () => void
  onStartAdd: (parentId: number, dir?: 'child' | 'sibling') => void
  onCommitAdd: (parentId: number, text: string, position?: number) => void
  onCancelAdd: () => void
  onDelete: (id: number) => void
  onFocus: (id: number) => void // 聚焦（下钻）到该节点
  onOpenNote: (id: number) => void // 打开备注面板并选中该节点
}

type MindNode = Node<MindNodeData, 'mind'>

// 长按阈值（ms）：setTimeout 与进度环动画共用同一数值——环画满即触发
const HOLD_MS = 480
// 拖拽落点悬停确认（ms）：zone 需停稳此时长才生效（防拖动线扫过相邻节点
// 的中部时瞬间误触挂子——分区怎么调都躲不开"扫过即触发"）
const DWELL_MS = 150
// 环显示延迟（ms）：按住超过它环才出现（快速点击不闪环）；环动画以
// -REVEAL_MS 的 delay 起步，reveal 时进度 = 已真实按住的时长
const REVEAL_MS = 100

function MindNodeView({ data, selected }: NodeProps<MindNode>) {
  const { lnode, isEditing, isAdding, addingDir, hasChildren, hasNote } = data
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

  // ── 长按（480ms）：有备注开备注面板。三防 ───────────────────────────
  // 1) 拖拽取消：按住节点拖动 = 拖拽改挂载手势（nodesDraggable），移动超
  //    8px 即取消长按（改挂载手势与长按互斥）
  // 2) click 吞除：浏览器在松手才发 click，长按已触发后这个 click 会
  //    再跑一次静默选中——consumed 标记跳过并在下一次按下复位
  // 3) 编辑/加节点态豁免：textarea 覆盖节点，指针事件在输入上下文无意义
  // 进度环：lp 非 null = 按住中且已过 REVEAL_MS（驱动节点按压态 + 环渲染）。
  // 环动画时长 = HOLD_MS（模块级同源常量），CSS 动画画满的一刻正是 setTimeout
  // 触发的一刻；REVEAL_MS 内的快速点击不显示环（干扰感来源），reveal 时环以
  // 负 animation-delay 起步——出现即已画 REVEAL_MS/HOLD_MS（进度语义真实）。
  // dx/dy = 隐藏期内的微挪量（reveal 时环直接落在当前指针处，不回跳）
  const [lp, setLp] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null)
  const lpRingRef = useRef<HTMLDivElement>(null)
  const lpTimer = useRef<number | undefined>(undefined)
  const lpRevealTimer = useRef<number | undefined>(undefined)
  const lpMove = useRef<((ev: PointerEvent) => void) | null>(null)
  const lpStart = useRef<{ x: number; y: number } | null>(null)
  const lpNow = useRef<{ x: number; y: number } | null>(null) // 最新指针位置（隐藏期也要记）
  const lpConsumed = useRef(false)
  const lpClear = () => {
    window.clearTimeout(lpTimer.current)
    window.clearTimeout(lpRevealTimer.current)
    if (lpMove.current) window.removeEventListener('pointermove', lpMove.current)
    lpMove.current = null
    lpStart.current = null
    lpNow.current = null
    setLp(null) // 环随取消立即消失（CSS 动画随元素移除而中断，无需单独清理）
  }
  // 卸载兜底：只清定时器/监听器（不动 state）
  useEffect(
    () => () => {
      window.clearTimeout(lpTimer.current)
      window.clearTimeout(lpRevealTimer.current)
      if (lpMove.current) window.removeEventListener('pointermove', lpMove.current)
    },
    [],
  )

  return (
    <div
      className={`rf-node ${isRoot ? 'root' : ''} ${selected ? 'sel' : ''} ${lp ? 'holding' : ''}`}
      // 编辑中放开高度（min-height 保底不缩）：节点随 textarea 内容向下生长，
      // commit 后由布局重排归位；期间 z-index 抬升盖住下方节点（见 App.css）
      style={{ width: lnode.w, height: isEditing ? 'auto' : lnode.h, minHeight: isEditing ? lnode.h : undefined }}
      onPointerDown={(e) => {
        // 只认主键：右键按下也是 pointerdown，不筛会误启长按计时——
        // 右键菜单（操作入口）落地后"按住右键"会误开备注面板
        if (e.button !== 0) return
        if (isEditing || isAdding) return
        lpConsumed.current = false
        lpStart.current = { x: e.clientX, y: e.clientY }
        lpNow.current = { x: e.clientX, y: e.clientY }
        // 环延迟 REVEAL_MS 才出现（快速点击不打扰）；激活计时立即开始——
        // 环的动画负延迟与之配合，reveal 时进度直接对齐真实已按时长
        lpRevealTimer.current = window.setTimeout(() => {
          const s = lpStart.current
          if (!s) return
          const p = lpNow.current ?? s
          setLp({ x: s.x, y: s.y, dx: p.x - s.x, dy: p.y - s.y })
        }, REVEAL_MS)
        const onMove = (ev: PointerEvent) => {
          const s = lpStart.current
          if (!s) return
          lpNow.current = { x: ev.clientX, y: ev.clientY }
          if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 8) {
            lpClear()
            return
          }
          // 阈值内的微挪：环跟手。ref 直改 style 不走 setState，60fps 无重渲染
          if (lpRingRef.current) lpRingRef.current.style.translate = `${ev.clientX - s.x}px ${ev.clientY - s.y}px`
        }
        lpMove.current = onMove
        window.addEventListener('pointermove', onMove)
        lpTimer.current = window.setTimeout(() => {
          window.removeEventListener('pointermove', onMove)
          lpMove.current = null
          setLp(null)
          lpConsumed.current = true
          data.onActivate(n.display_id, data.hasNote)
        }, HOLD_MS)
      }}
      onPointerUp={lpClear}
      onPointerLeave={lpClear}
      onPointerCancel={lpClear}
      onClick={(e) => {
        e.stopPropagation()
        if (lpConsumed.current) {
          lpConsumed.current = false // 长按已激活：吞掉松手 click，不再静默选中
          return
        }
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

      {/* ID 角标：与 outline 协议 [id:N] 呼应，方便 Agent 精确锚定节点。
          有备注时变橙底白字（原右上角圆点方案，已并入此处）并接替其职责：
          点击直开备注面板；编辑态退回纯展示（textarea 盖满节点） */}
      {hasNote && !isEditing ? (
        <button
          className={`id-badge noted ${isRoot ? 'on-root' : ''}`}
          title={t('note.markTitle')}
          aria-label={t('note.markTitle')}
          onClick={(e) => {
            e.stopPropagation()
            data.onOpenNote(n.display_id)
          }}
        >
          #{n.display_id}
        </button>
      ) : (
        <span className={`id-badge ${isRoot ? 'on-root' : ''}`}>#{n.display_id}</span>
      )}

      {/* 加节点输入行：NodeToolbar 渲染在独立层、不随画布缩放（旧方案在节点
          DOM 内，zoom 缩小时跟着缩小到不可点）。方位语义：sibling 输入态 =
          节点下方左对齐（下一个兄弟的落位）；child 输入态 = 节点右侧（子树
          生长方向）。节点操作入口已迁右键菜单（NodeContextMenu），此处只剩
          加节点输入态 */}
      {isAdding && (
        <NodeToolbar
          isVisible
          position={addingDir === 'child' ? Position.Right : Position.Bottom}
          align={addingDir === 'child' ? 'center' : 'start'}
          offset={addingDir === 'child' ? 14 : 9}
        >
          <div className="node-actions adding">
            <input
              ref={addInputRef}
              className="add-input"
              placeholder={t(addingDir === 'sibling' ? 'node.addSiblingPlaceholder' : 'node.addPlaceholder')}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation() // 输入态按键不冒泡（防 Enter 触发全局快捷键）
                if (e.key === 'Enter') {
                  e.preventDefault()
                  data.onCommitAdd(addingDir === 'sibling' && n.parent ? n.parent.display_id : n.display_id, (e.target as HTMLInputElement).value, addingDir === 'sibling' ? n.position + 1 : undefined)
                }
                if (e.key === 'Escape') data.onCancelAdd()
              }}
              // 与节点编辑（rf-editor）同款语义：失焦即提交，空文本视为取消
              onBlur={(e) =>
                data.onCommitAdd(addingDir === 'sibling' && n.parent ? n.parent.display_id : n.display_id, e.target.value, addingDir === 'sibling' ? n.position + 1 : undefined)
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
                data.onCommitAdd(addingDir === 'sibling' && n.parent ? n.parent.display_id : n.display_id, input.value, addingDir === 'sibling' ? n.position + 1 : undefined)
              }}
            >
              <CheckIcon />
            </button>
          </div>
        </NodeToolbar>
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

      {/* 长按进度环：Portal 到 body——React Flow 节点位于 transform 容器内，
          position:fixed 在其内部会被 transform 祖先劫持成定位锚（fixed 失效），
          必须跳出节点树。环随指针（微挪经 ref 直改 translate），画满即触发；
          负 animation-delay = reveal 时已画到真实进度（见 REVEAL_MS 注释） */}
      {lp &&
        createPortal(
          <div
            ref={lpRingRef}
            className="lp-ring"
            style={{ left: lp.x, top: lp.y, translate: `${lp.dx}px ${lp.dy}px` }}
          >
            <svg viewBox="0 0 36 36" aria-hidden="true">
              <circle className="lp-ring-track" cx="18" cy="18" r="15" />
              <circle
                className="lp-ring-bar"
                cx="18"
                cy="18"
                r="15"
                pathLength={100}
                style={{ animationDuration: `${HOLD_MS}ms`, animationDelay: `-${REVEAL_MS}ms` }}
              />
            </svg>
          </div>,
          document.body,
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

// 面包屑菜单 hover 打开延迟：一级与级联子菜单共用（沿列表纵向扫过不连环弹）
const CRUMB_HOVER_OPEN_DELAY = 150
// 级联深度上限：脏数据父子成环时递归渲染不发散（防环精神同 focusPath 的 1000 步上溯）
const CRUMB_MENU_MAX_DEPTH = 20

// 级联/一级菜单共用的视口翻转测量：默认右开下展，越视口右缘翻左、越底边上收，
// 两侧都放不下退回默认方向（退化窄窗）。useLayoutEffect 在 paint 前定稿，无中间帧闪烁。
// 测的是锚点 rect（菜单 parentElement：一级=crumb-wrap、子级=cm-item）+ 菜单自身 offset
// 尺寸——与菜单当前摆位无关，items/方向变化时复测不会来回震荡
function useCrumbMenuFlip(
  menuRef: RefObject<HTMLDivElement | null>,
  defaultH: 'r' | 'l', // 一级恒 'r'；子级继承父菜单定稿方向（父翻左后子孙继续左开）
  anchorEdge: 'top' | 'bottom', // 子级从锚点顶边展开；一级从锚点底边下方展开
  items: NodeDTO[], // WS 重拉后菜单内容变高/变宽时复测
): { h: 'r' | 'l'; v: 'd' | 'u' } {
  const [dir, setDir] = useState<{ h: 'r' | 'l'; v: 'd' | 'u' }>({ h: defaultH, v: 'd' })
  useLayoutEffect(() => {
    const el = menuRef.current
    const anchor = el?.parentElement
    if (!el || !anchor) return
    const M = 8 // 视口安全边距
    const vw = window.innerWidth
    const vh = window.innerHeight
    const a = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    // 水平：默认方向放得下用默认，放不下试另一侧，两侧都放不下退回默认
    let hDir = defaultH
    if (defaultH === 'r' && a.right + w > vw - M) hDir = a.left - w >= M ? 'l' : 'r'
    else if (defaultH === 'l' && a.left - w < M) hDir = a.right + w <= vw - M ? 'r' : 'l'
    // 垂直：往下展开空间不足时试上收（一级上边=锚点顶-h-空隙、子级底边回到锚点底），
    // 仍放不下保持下展（单层高于视口的已知取舍）
    const startY = anchorEdge === 'top' ? a.top : a.bottom
    let vDir: 'd' | 'u' = 'd'
    if (startY + h > vh - M) {
      const upTop = (anchorEdge === 'top' ? a.bottom : a.top) - h
      if (upTop >= M) vDir = 'u'
    }
    setDir((cur) => (cur.h === hDir && cur.v === vDir ? cur : { h: hDir, v: vDir }))
  }, [items, defaultH, anchorEdge, menuRef])
  return dir
}

// 面包屑同层导航菜单（一级）：兄弟列表（调用方已算好、排除自身），点选即聚焦过去。
// 有子节点的项 hover 后在右侧级联展开子菜单（CrumbSubMenu 递归，深度封顶见常量）
function CrumbMenu({
  siblings,
  kidsOf,
  childCount,
  onPick,
}: {
  siblings: NodeDTO[]
  kidsOf: (pid: number) => NodeDTO[]
  childCount: Map<number, number>
  onPick: (id: number) => void
}) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  const { h, v } = useCrumbMenuFlip(menuRef, 'r', 'bottom', siblings)
  if (siblings.length === 0) return null
  const cls = ['crumb-menu', h === 'l' && 'flip-h', v === 'u' && 'flip-v'].filter(Boolean).join(' ')
  return (
    <div ref={menuRef} className={cls} role="menu" aria-label={t('crumb.siblingsAria')}>
      {siblings.map((s) => (
        <CrumbMenuItem
          key={s.display_id}
          node={s}
          depth={1}
          menuH={h}
          kidsOf={kidsOf}
          childCount={childCount}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

// 菜单项：有子节点时 hover 150ms 在右侧展开级联子菜单（局部 state，天然支持任意深度；
// 子菜单是本项 div 的后代——鼠标移进去不触发 leave，hover 链不断，同 wrap 包菜单原理）
function CrumbMenuItem({
  node,
  depth,
  menuH,
  kidsOf,
  childCount,
  onPick,
}: {
  node: NodeDTO
  depth: number // 本项所在列表的深度（一级=1）
  menuH: 'r' | 'l' // 所在菜单定稿的水平方向，传给子级作默认展开方向
  kidsOf: (pid: number) => NodeDTO[]
  childCount: Map<number, number>
  onPick: (id: number) => void
}) {
  // 深度封顶后不再展开也不显箭头（连 kidsOf 都不查）；childCount 无视 collapsed——
  // 折叠只是画布渲染裁剪，导航菜单要的是全量结构（同 siblingsOf 行为）
  const hasKids = depth < CRUMB_MENU_MAX_DEPTH && (childCount.get(node.display_id) ?? 0) > 0
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <div
      className="cm-item"
      onMouseEnter={() => {
        // React 的 onMouseEnter 会沿组件树冒泡（与原生不同）：进子菜单也会触发祖先项
        // 的 enter——已展开时直接返回，不重置计时器
        if (open) return
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setOpen(true), CRUMB_HOVER_OPEN_DELAY)
      }}
      onMouseLeave={() => {
        // 关闭即时（同级互斥：A 收起无延迟、B 打开有延迟）；整支随本项卸载 state 自清
        window.clearTimeout(timer.current)
        setOpen(false)
      }}
    >
      <button
        role="menuitem"
        aria-haspopup={hasKids ? 'menu' : undefined}
        aria-expanded={hasKids ? open : undefined}
        onClick={() => onPick(node.display_id)}
      >
        <span className="cm-name">{node.content}</span>
        <span className="cm-id">#{node.display_id}</span>
        {hasKids && (
          <span className="cm-arrow" aria-hidden="true">
            ›
          </span>
        )}
      </button>
      {open && hasKids && (
        <CrumbSubMenu
          items={kidsOf(node.display_id)}
          level={depth + 1}
          hDir={menuH}
          kidsOf={kidsOf}
          childCount={childCount}
          onPick={onPick}
        />
      )}
    </div>
  )
}

// 级联子菜单（二级及以下）：锚在父项右侧（父菜单翻左后默认继续左开），视觉复用 .crumb-menu
function CrumbSubMenu({
  items,
  level,
  hDir,
  kidsOf,
  childCount,
  onPick,
}: {
  items: NodeDTO[]
  level: number // 本列表深度（一级=1，子级从 2 起）
  hDir: 'r' | 'l'
  kidsOf: (pid: number) => NodeDTO[]
  childCount: Map<number, number>
  onPick: (id: number) => void
}) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  const { h, v } = useCrumbMenuFlip(menuRef, hDir, 'top', items)
  const cls = ['crumb-menu', 'cm-sub', h === 'l' && 'flip-h', v === 'u' && 'flip-v']
    .filter(Boolean)
    .join(' ')
  return (
    <div ref={menuRef} className={cls} role="menu" aria-label={t('crumb.childrenAria')}>
      {items.map((n) => (
        <CrumbMenuItem
          key={n.display_id}
          node={n}
          depth={level}
          menuH={h}
          kidsOf={kidsOf}
          childCount={childCount}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

// ── 节点右键操作菜单（编辑器层全局单例，fixed 锚定右键点）─────────────
// 视觉语言与 .crumb-menu 同源（canvas-panel/hairline/radius/bg-hover）。
// 不用 goto 式 backdrop：fixed inset-0 会盖画布，右键别处得两次点击——
// 关闭走 window capture（见下），菜单本身不铺任何透明层
function NodeContextMenu({
  x,
  y,
  canFocus,
  canDelete,
  onEdit,
  onAdd,
  onNote,
  onFocusNode,
  onDelete,
  onClose,
}: {
  x: number
  y: number
  canFocus: boolean
  canDelete: boolean
  onEdit: () => void
  onAdd: () => void
  onNote: () => void
  onFocusNode: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  // 删除两步确认（原按钮行 clickDelete 平移）：首点武装，3s 超时回落，
  // 再点执行。菜单随任何点外交互整体关闭，armed 态无残留场景
  const [armed, setArmed] = useState(false)
  const armTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(armTimer.current), [])
  const clickDelete = () => {
    if (armed) {
      window.clearTimeout(armTimer.current)
      onDelete()
      return
    }
    setArmed(true)
    window.clearTimeout(armTimer.current)
    armTimer.current = window.setTimeout(() => setArmed(false), 3000)
  }
  // 视口翻转：渲染后量实际尺寸，越右/底缘收回（clamp 到 8px 边距）。
  // useLayoutEffect 在 paint 前定稿无中间帧；armed 换文案变宽一并复测
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const M = 8
    setPos({
      x: Math.max(M, Math.min(x, window.innerWidth - el.offsetWidth - M)),
      y: Math.max(M, Math.min(y, window.innerHeight - el.offsetHeight - M)),
    })
  }, [x, y, armed])
  // 点外关闭（capture 阶段先于画布/节点自身的 React 合成事件）：
  // - pointerdown 在菜单内不关——交给菜单项 onClick 执行动作后关
  // - contextmenu 在菜单内：preventDefault 且不关（菜单项不是右键语义）
  // - 别处右键：只关旧菜单并放行事件——新目标的 onNodeContextMenu
  //   同一击直接开新菜单（React 批处理单次 commit，无开关闪烁）
  // - wheel 缩放/平移：fixed 菜单不跟画布，悬在原地即失真，关
  useEffect(() => {
    const inside = (e: Event) => e.target instanceof Node && !!ref.current?.contains(e.target)
    const onPD = (e: PointerEvent) => {
      if (!inside(e)) onClose()
    }
    const onCM = (e: MouseEvent) => {
      if (inside(e)) {
        e.preventDefault()
        return
      }
      onClose()
    }
    const onWheel = () => onClose()
    window.addEventListener('pointerdown', onPD, true)
    window.addEventListener('contextmenu', onCM, true)
    window.addEventListener('wheel', onWheel, true)
    return () => {
      window.removeEventListener('pointerdown', onPD, true)
      window.removeEventListener('contextmenu', onCM, true)
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [onClose])
  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu" aria-label={t('node.menuAria')}>
      <button className="ctx-item" role="menuitem" onClick={act(onEdit)}>
        <PencilIcon size={14} />
        <span className="ctx-label">{t('node.menuEdit')}</span>
        <span className="ctx-kbd">F2</span>
      </button>
      <button className="ctx-item" role="menuitem" onClick={act(onAdd)}>
        <PlusIcon />
        <span className="ctx-label">{t('node.addAria')}</span>
        <span className="ctx-kbd">Tab</span>
      </button>
      <button className="ctx-item" role="menuitem" onClick={act(onNote)}>
        <StickyNoteIcon size={13} />
        <span className="ctx-label">{t('node.menuNote')}</span>
      </button>
      {canFocus && (
        <button className="ctx-item" role="menuitem" title={t('node.focusTitle')} onClick={act(onFocusNode)}>
          <FocusIcon />
          <span className="ctx-label">{t('node.focusAria')}</span>
        </button>
      )}
      {canDelete && (
        <>
          {/* 破坏性操作与上面隔一条分隔线（规范菜单惯例） */}
          <div className="ctx-sep" />
          <button
            className={`ctx-item${armed ? ' armed' : ''}`}
            role="menuitem"
            aria-label={armed ? t('node.deleteConfirm') : t('node.deleteAria')}
            onClick={() => (armed ? act(onDelete)() : clickDelete())}
          >
            <TrashIcon />
            <span className="ctx-label">{armed ? t('node.deleteConfirmBtn') : t('node.deleteAria')}</span>
            {!armed && <span className="ctx-kbd">Delete</span>}
          </button>
        </>
      )}
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

// 折叠同步断开期间的 refresh 合并补丁：整树重拉会把服务端折叠态带回
//（内容重拉语义），但断开期的契约是"折叠以本地为准"——按 display_id 把
// 本地 collapsed 抄回新树。本地没有的节点（服务端新增）用服务端值；本地
// 有而 fresh 没有的（已删）不抄自然消失。逐字段幂等对账，不做快照
function preserveLocalFold(fresh: MapDetail, local: MapDetail): MapDetail {
  const localCollapsed = new Map<number, boolean>()
  for (const n of local.nodes) localCollapsed.set(n.display_id, n.collapsed)
  let changed = false
  const nodes = fresh.nodes.map((node) => {
    const collapsed = localCollapsed.get(node.display_id)
    if (collapsed === undefined || collapsed === node.collapsed) return node
    changed = true
    return { ...node, collapsed }
  })
  return changed ? { ...fresh, nodes } : fresh
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

// outline 编辑 / 右键菜单的编辑文字（lucide pencil：斜置铅笔）
const PencilIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

// 折叠同步开关（lucide link-2 / unlink 语言）：链环中间连通 = 折叠态多端
// 同步；中间断开加斜杠 = 折叠态各自为政。两态换图标与布局切换按钮同款惯例
const FoldSyncOnIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 17H7A5 5 0 0 1 7 7h2" />
    <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
    <path d="M8 12h8" />
  </svg>
)

const FoldSyncOffIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 17H7A5 5 0 0 1 7 7h2" />
    <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
    <path d="M8 12h2" />
    <path d="m12 9 3 6" />
    <path d="M14 12h2" />
  </svg>
)

// ── editor ────────────────────────────────────────────────────────────

export function MindMapEditor({ mapId, onBack }: Props) {
  const { t, lang } = useI18n()
  const [detail, setDetail] = useState<MapDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  // 加节点输入态：anchor = 输入框锚定的节点，dir = 方位与提交语义（见 startAdd）
  const [adding, setAdding] = useState<{ anchor: number; dir: 'child' | 'sibling' } | null>(null)
  // 右键操作菜单：fixed 锚定右键点（clientX/Y），id 为目标节点。全局单例
  // ——同时最多一个；关闭由 NodeContextMenu 的 window capture 负责
  const [ctxMenu, setCtxMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [wsState, setWsState] = useState<'connecting' | 'live' | 'dead'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [revOpen, setRevOpen] = useState(false)
  const [outlineText, setOutlineText] = useState('')
  const [outlineMode, setOutlineMode] = useState<OutlineMode>('merge')
  // Ctrl+P 编号跳转面板（gotoResults 派生值见 layout memo 后）
  const [gotoOpen, setGotoOpen] = useState(false)
  const [gotoText, setGotoText] = useState('')
  // 结果列表激活行（↑↓ 移动 / hover 跟随；渲染处对越界做钳制）
  const [gotoActiveRaw, setGotoActiveRaw] = useState(0)
  // 默认打开（2026-09-09 用户拍板）；localStorage 记忆手动开合——关过就不
  // 再自动弹（layoutMode/chatWidth 同款惯例）。渲染仍受 agentOk 门控
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem('chatOpen') !== 'false')
  useEffect(() => {
    localStorage.setItem('chatOpen', String(chatOpen))
  }, [chatOpen])
  // 折叠同步开关：断开 = 本地收放只做乐观更新（不写服务端、不广播），同时
  // 忽略别人的 fold 类 WS 事件；内容同步完全不动。localStorage 记忆（chatOpen
  // 同款），ref 镜像给 WS onmessage 闭包读最新值——建连 effect 依赖不变
  //（mapId/refresh 均稳定），翻转开关不重建连接，state 直接进闭包会读到冻结旧值
  const [foldSyncOn, setFoldSyncOn] = useState(() => localStorage.getItem('foldSyncOn') !== 'false')
  const foldSyncRef = useRef(foldSyncOn)
  foldSyncRef.current = foldSyncOn // detailRef/layoutRef 同款渲染期镜像惯例
  useEffect(() => {
    localStorage.setItem('foldSyncOn', String(foldSyncOn))
  }, [foldSyncOn])
  // Agent 入口守门：模型网关未配置时按钮保留但置灰（aria-disabled，真 disabled
  // 收不到 click），点击弹配置表单；null = 检查中暂不渲染（防闪跳）。
  // 状态检查首步即配置完整性，未配置时快速失败、无外呼
  const [agentStatus, setAgentStatus] = useState<ChatGateStatus | null>(null)
  const [chatGateOpen, setChatGateOpen] = useState(false)
  // 交互指南侧边栏（左侧滑出，Esc 关闭——链位见全局 Esc 处理）
  const [helpOpen, setHelpOpen] = useState(false)
  const refreshAgentStatus = useCallback(async (): Promise<ChatGateStatus> => {
    try {
      const s = await chatApi.status()
      setAgentStatus(s)
      return s
    } catch {
      const fallback: ChatGateStatus = { ok: false, reason_code: null, reason_detail: null }
      setAgentStatus(fallback)
      return fallback
    }
  }, [])
  useEffect(() => {
    void refreshAgentStatus()
  }, [refreshAgentStatus])
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
  const flowHostRef = useRef<HTMLDivElement | null>(null)

  // ctrl+滚轮/触摸板捏合的缩放速度：xyflow 内置系数写死 0.002（非 mac
  // 每档 ~18%），无 prop 可调 → capture 拦截自算（0.006 = 3 倍速，每档
  // ~65%）。围绕指针缩放，新 x = px-(px-x)·z2/z1（d3 scaleTo 同式）。
  // stopPropagation 阻止事件再落进 xyflow 的 panOnScroll handler（那里
  // ctrl 分支是内置慢速缩放，叠加会双重缩放）；普通 wheel 不拦，照常平移
  const onFlowWheelZoom = useCallback((e: WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault() // 浏览器默认 ctrl+滚轮 = 整页缩放，禁掉
    e.stopPropagation()
    const inst = rfRef.current
    const host = flowHostRef.current
    if (!inst || !host) return
    const vp = inst.getViewport()
    // clamp 与下方 minZoom/maxZoom props（0.1 / 2.5）保持一致
    const z2 = Math.min(2.5, Math.max(0.1, vp.zoom * 2 ** (-e.deltaY * 0.006)))
    const r = host.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    const ratio = z2 / vp.zoom
    inst.setViewport({ zoom: z2, x: px - (px - vp.x) * ratio, y: py - (py - vp.y) * ratio })
  }, [])

  // 挂靠 callback ref 而非 useEffect：编辑器主体是条件渲染（detail/layout
  // 就绪才出 <ReactFlow>，见下方 early return），mount 期 effect 跑时 ref
  // 还是 null，之后不会再补挂
  const setFlowHost = useCallback(
    (el: HTMLDivElement | null) => {
      const prev = flowHostRef.current
      if (prev) prev.removeEventListener('wheel', onFlowWheelZoom, { capture: true })
      flowHostRef.current = el
      if (el) el.addEventListener('wheel', onFlowWheelZoom, { capture: true, passive: false })
    },
    [onFlowWheelZoom],
  )

  // ── 拖拽改挂载 + 三区排序（drag-to-reparent / reorder）──────────────────
  // 拖节点悬停另一节点，按指针纵向位置分三区：上/下边缘 25% = 插到目标
  // 前/后（成为兄弟，position 换算——同父内即纯排序）；中间 50% = 挂为
  // 子（蓝环）。边缘区高亮为水平插入线（CSS 伪元素）。跟手走 animPos 同款
  // 路子（dragPos 每帧驱动 rfNodes 重建，优先级 drag > 动画 > 布局）；高亮
  // 直改目标 DOM class（不走 state）。提交走 WS 重拉惯例。防环前端预检
  // （后代目标标红），服务端 move_node 兜底；布局根无兄弟 → 边缘区禁。
  // 空白落点 = 取消。注意：开启后"拖节点=平移画布"被替换，平移只能拖空白
  const [dragPos, setDragPos] = useState<Map<number, { x: number; y: number }> | null>(null)
  const dragDescendants = useRef<Set<number>>(new Set())
  const dropHighlight = useRef<{ el: HTMLElement; cls: string } | null>(null)
  // 最新树给 hitTest 闭包用（目标父/序号的解析源），避免回调依赖 detail 身份
  const detailRef = useRef(detail)
  detailRef.current = detail
  type DropHit = {
    el: HTMLElement
    id: number
    zone: 'child' | 'before' | 'after'
    ok: boolean
    parentId: number | null // before/after 用：目标的父（布局根为 null → 禁）
    position: number // before/after 用：目标的当前序
  }
  const dropTarget = useRef<DropHit | null>(null)
  // dwell 悬停确认：zone 键起算 + 到期定时器 + 已确认键 + 最新命中。
  // onDrag 只在指针移动时发——停住不动没有事件推进时间，必须 timer 补位
  const pendingZoneKey = useRef('none')
  const dwellTimer = useRef<number | undefined>(undefined)
  const confirmedZoneKey = useRef('none')
  const pendingHit = useRef<DropHit | null>(null)

  const applyDropHit = (hit: DropHit | null) => {
    const cls = !hit
      ? ''
      : !hit.ok
        ? 'drop-forbidden'
        : hit.zone === 'child'
          ? 'drop-target'
          : hit.zone === 'before'
            ? 'drop-before'
            : 'drop-after'
    setDropHighlight(hit?.el ?? null, cls)
    dropTarget.current = hit
  }

  const setDropHighlight = (el: HTMLElement | null, cls: string) => {
    if (dropHighlight.current) dropHighlight.current.el.classList.remove(dropHighlight.current.cls)
    dropHighlight.current = el ? { el, cls } : null
    if (el) el.classList.add(cls)
  }

  /** 指针下的落点：节点本体（矩形内任意位置）= 挂为子；节点外部上下 EXT
   *  = 插到它前/后（排序）。经典树形 DnD 语义（VS Code 文件树同款）——
   *  曾用"内部边缘比例分区"，边缘区挤占挂子区致其只剩 25%，改纯外部后
   *  排序带 = 兄弟间隙 32px 全宽（EXT 16×2 恰好覆盖，含 dwell 防扫过
   *  误触），挂子区回到 100%。 */
  const hitTest = (cx: number, cy: number, dragId: number): DropHit | null => {
    const EXT = 16 // 矩形外扩：16×2 = 兄弟间隙 32px 全覆盖（14 时中间有 4px 死区）
    const els = [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    const build = (el: HTMLElement, zone: 'child' | 'before' | 'after'): DropHit => {
      const id = Number(el.dataset.id)
      const target = detailRef.current?.nodes.find((n) => n.display_id === id)
      const parentId = target?.parent?.display_id ?? null
      // before/after 需要目标有父（布局根无兄弟——与 Delete 键的布局根特判同语义）
      const ok = !dragDescendants.current.has(id) && (zone === 'child' || parentId != null)
      return { el, id, zone, ok, parentId, position: target?.position ?? 0 }
    }
    for (const el of els) {
      if (Number(el.dataset.id) === dragId) continue
      const r = el.getBoundingClientRect()
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        return build(el, 'child')
      }
    }
    for (const el of els) {
      if (Number(el.dataset.id) === dragId) continue
      const r = el.getBoundingClientRect()
      if (cx >= r.left && cx <= r.right) {
        if (cy >= r.top - EXT && cy < r.top) return build(el, 'before')
        if (cy > r.bottom && cy <= r.bottom + EXT) return build(el, 'after')
      }
    }
    return null
  }

  const onDragStart = useCallback(
    (_e: MouseEvent | TouchEvent, node: MindNode) => {
      // 拖起时收集后代集合（防环预检用；树在拖动中不变）
      const desc = new Set<number>()
      const kidsOf = new Map<number, number[]>()
      if (detail) {
        for (const n of detail.nodes) {
          if (n.parent != null) kidsOf.set(n.parent.display_id, [...(kidsOf.get(n.parent.display_id) ?? []), n.display_id])
        }
        const stack = [Number(node.id)]
        while (stack.length) {
          for (const k of kidsOf.get(stack.pop()!) ?? []) {
            desc.add(k)
            stack.push(k)
          }
        }
      }
      dragDescendants.current = desc
      // dwell 状态干净起步（上次拖拽的残留会误伤本次确认时序）
      window.clearTimeout(dwellTimer.current)
      pendingZoneKey.current = 'none'
      confirmedZoneKey.current = 'none'
      dropTarget.current = null
    },
    [detail],
  )

  const onDrag = useCallback((e: MouseEvent | TouchEvent, node: MindNode) => {
    // RF 已算好拖动中的 position（左上角，与 rfNodes 同语义）
    const dragId = Number(node.id)
    setDragPos(new Map([[dragId, { x: node.position.x, y: node.position.y }]]))
    const cx = e instanceof MouseEvent ? e.clientX : e.touches[0]?.clientX ?? 0
    const cy = e instanceof MouseEvent ? e.clientY : e.touches[0]?.clientY ?? 0
    const hit = hitTest(cx, cy, dragId)
    pendingHit.current = hit
    const key = hit ? `${hit.id}:${hit.zone}` : 'none'
    // 悬停确认（dwell 150ms）：扫过即触发是误挂子的主因——动线（如下移上拖）
    // 必然穿过相邻节点，指针滑过其中部的瞬间不该换目标。zone 变化起算、
    // timer 到期确认（停住后没有 onDrag 事件推进，必须定时器补位）；空白
    // 立即清除（无歧义）；已确认 zone 内的移动实时刷新
    if (key === 'none') {
      window.clearTimeout(dwellTimer.current)
      pendingZoneKey.current = 'none'
      confirmedZoneKey.current = 'none'
      applyDropHit(null)
      return
    }
    if (key === confirmedZoneKey.current) {
      applyDropHit(hit)
      return
    }
    if (pendingZoneKey.current !== key) {
      pendingZoneKey.current = key
      window.clearTimeout(dwellTimer.current)
      dwellTimer.current = window.setTimeout(() => {
        if (pendingZoneKey.current === key) {
          confirmedZoneKey.current = key
          applyDropHit(pendingHit.current)
        }
      }, DWELL_MS)
    }
  }, [])

  const onDragStop = useCallback(
    (_e: MouseEvent | TouchEvent, node: MindNode) => {
      window.clearTimeout(dwellTimer.current) // 未确认的 dwell 到期不再触发（拖拽已结束）
      const hit = dropTarget.current
      setDropHighlight(null, '')
      dropTarget.current = null
      setDragPos(null) // 取消/提交后清跟手位：提交场景 WS 推送动画滑正；取消场景瞬回布局位
      const dragId = Number(node.id)
      if (hit?.ok) {
        if (hit.zone === 'child') {
          void guard(() => api.moveNode(mapId, dragId, hit.id))
        } else if (hit.parentId != null) {
          // 插到目标前（占它的序）/后（序+1）；服务端归一化保证稠密，换算精确
          void guard(() =>
            api.moveNode(mapId, dragId, hit.parentId!, hit.position + (hit.zone === 'after' ? 1 : 0)),
          )
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- guard 无状态依赖（吞错+toast），旧闭包无害
    [mapId],
  )

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

  // 备注面板首开预热（idle）：VditorEditor 是 lazy chunk + vditor 运行时
  // （3.7MB lute 下载/解析）都要等面板打开才开始，首开内容要 ~1s——空闲时
  // 提前拉齐（chunk 走 import 缓存、脚本靠 addScript 的 DOM id 去重），
  // 首开近同步。成本：进编辑器页即预取（本地/桌面版带宽免费；远端部署
  // 多 ~4MB 首访流量，换交互值得）。语言切换重跑：i18n 脚本按 lang 预挂
  useEffect(() => {
    const ric: (cb: () => void) => number =
      typeof requestIdleCallback === 'function'
        ? (cb) => requestIdleCallback(cb, { timeout: 3000 })
        : (cb) => window.setTimeout(cb, 1500)
    const handle = ric(() => {
      void import('./VditorEditor').then((m) =>
        m.prefetchVditorRuntime(lang === 'zh' ? 'zh_CN' : 'en_US'),
      )
    })
    return () => {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle)
      else window.clearTimeout(handle)
    }
  }, [lang])

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

  // 右键节点 = 选中 + 弹操作菜单。编辑态节点不接管：textarea 里的原生
  // 右键（复制/粘贴）有真实用途；加节点输入态不弹（startAdd 的焦点仲裁
  // 会被打断）。preventDefault 抑制浏览器菜单（桌面 app 体验）
  const onNodeCtx = useCallback(
    (e: ReactMouseEvent, node: MindNode) => {
      const id = Number(node.id)
      if (editingId === id) return
      if (adding != null) return
      e.preventDefault()
      setSelectedId(id)
      setCtxMenu({ id, x: e.clientX, y: e.clientY })
    },
    [editingId, adding],
  )
  // 画布空白右键：抑制浏览器默认菜单，不弹自定义菜单。RF 的 Pane 经
  // wrapHandler 只在 target===pane 时调本回调——点阵 Background
  // pointer-events:none 不拦截；MiniMap/Controls/边上的右键不进这里
  const onPaneCtx = useCallback((e: ReactMouseEvent | MouseEvent) => e.preventDefault(), [])
  // 菜单目标已被删（Agent / 其他页签，WS 重拉后查无此 id）：浮菜单不能
  // 指向不存在的节点，自动关（同 focusId 失联回退精神）
  useEffect(() => {
    if (ctxMenu && !detail?.nodes.some((n) => n.display_id === ctxMenu.id)) setCtxMenu(null)
  }, [detail, ctxMenu])
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
      const fresh = await api.getMap(mapId)
      // 折叠同步断开期间：整树重拉仍要（内容照常同步），但折叠字段以本地为准
      //（preserveLocalFold 对账）。初载/换图时 cur 为 null，自然整体替换
      setDetail((cur) =>
        cur && !foldSyncRef.current && cur.id === fresh.id ? preserveLocalFold(fresh, cur) : fresh,
      )
    } catch (e) {
      setError(String(e))
    }
  }, [mapId])

  const queueFoldMutation = useCallback(
    (optimisticUpdate: OptimisticFold, request: (clientRequestId: string) => Promise<void>) => {
      // 折叠同步断开：只做本地乐观更新。不生成 rid、不登记回声、不进串行
      // 队列——队列存在的唯一意义是给 API 调用排序，没有请求就没有乱序与
      // 失败纠偏问题。断开瞬间队列里同步态发起的在途请求互不干扰（其回声
      // 走 client_request_id 确认分支，在折叠忽略分支之前）
      if (!foldSyncRef.current) {
        setDetail((current) => (current ? optimisticUpdate(current) : current))
        return
      }
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
            // 折叠同步断开：别人的收放不再影响本地视图。含 Agent 经 update_node
            // 纯折叠路径产生的 node_collapsed（无 client_request_id，同被忽略）；
            // 内容类事件不带 fold payload 不会进这里——内容协作完全不受影响
            if (!foldSyncRef.current) return
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
    (parentId: number, text: string, position?: number) => {
      setAdding(null)
      const value = text.trim() // 局部命名避开 i18n 的 t
      if (!value) return
      // position：sibling 传锚点序+1 = 插到锚点正下方（服务端归一化保证
      // 稠密，+1 是精确插入语义）；child 不传 = 追加末尾
      void guard(() => api.addNode(mapId, parentId, value, position))
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

  // 层级收放（刻度条/全部展开）后节点大批增删 + 布局重排，原视口常对空白（图
  // "消失"感）——动画落定后拉回全图。连点重置计时（以最后一次为准）；单节点
  // 收放（space）不触发——视口就在该节点上，无需打断
  const foldFitTimerRef = useRef<number | undefined>(undefined)
  const scheduleFoldFit = useCallback(() => {
    window.clearTimeout(foldFitTimerRef.current)
    foldFitTimerRef.current = window.setTimeout(
      () => rfRef.current?.fitView({ padding: 0.25, maxZoom: 1 }),
      320,
    )
  }, [])
  const setFoldLevel = useCallback(
    (level: number) => {
      queueFoldMutation(
        (current) => foldToLevelOptimistically(current, level),
        (clientRequestId) => api.setFoldLevel(mapId, level, clientRequestId),
      )
      scheduleFoldFit()
    },
    [mapId, queueFoldMutation, scheduleFoldFit],
  )
  const expandAll = useCallback(
    () => {
      queueFoldMutation(
        expandAllOptimistically,
        (clientRequestId) => api.expandAll(mapId, clientRequestId),
      )
      scheduleFoldFit()
    },
    [mapId, queueFoldMutation, scheduleFoldFit],
  )


  // ── layout → React Flow nodes/edges ────────────────────────────────
  const layout = useMemo(
    () => (detail ? layoutMap(detail, layoutMode, focusId) : null),
    [detail, layoutMode, focusId],
  )
  // 最新布局给 setTimeout 延迟回调用：闭包里的 layout 是发起时刻的旧值，
  // 展开祖先后的新节点在旧布局里查不到坐标，平移会静默失效
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // 落点动作（方向键导航 / Ctrl+P 跳转共用）：静默选中（不弹备注面板——
  // 弹出只认显式入口：长按/角标/d/pin）+ 视口出界（60px 边距）才平移到中心
  // （保持 zoom）。60ms 等 React 渲染出目标 DOM（展开场景新节点要一轮 render）
  const revealAndSelect = useCallback(
    (target: number) => {
      setSelectedId(target)
      window.setTimeout(() => {
        const el = document.querySelector(`.react-flow__node[data-id="${target}"]`)
        const wrap = document.querySelector('.rf-wrap')
        if (!el || !wrap || !rfRef.current) return
        const er = el.getBoundingClientRect()
        const wr = wrap.getBoundingClientRect()
        const outside =
          er.left < wr.left + 60 || er.right > wr.right - 60 || er.top < wr.top + 60 || er.bottom > wr.bottom - 60
        if (!outside) return
        const ln = layoutRef.current?.all.find((l) => l.node.display_id === target)
        if (!ln) return
        rfRef.current.setCenter(ln.x + ln.w / 2, ln.y, { duration: 300, zoom: rfRef.current.getZoom() })
      }, 60)
    },
    [detail],
  )

  // Ctrl+P 跳转：折叠目标先乐观展开祖链（数据在 detail.nodes，折叠只是渲染
  // 裁剪）；聚焦模式下目标可能在聚焦子树外——视野外祖先不渲染，展开也无效，
  // 先退回全图再落点
  const gotoNode = useCallback(
    (target: number) => {
      if (!detail) return
      const byId = new Map(detail.nodes.map((n) => [n.display_id, n]))
      let inFocus = focusId == null
      const toExpand: number[] = []
      let cur = byId.get(target)
      while (cur?.parent != null) {
        const p = byId.get(cur.parent.display_id)
        if (!p) break
        if (p.display_id === focusId) inFocus = true
        if (p.collapsed) toExpand.push(p.display_id)
        cur = p
      }
      if (!inFocus) setFocusId(null)
      for (const id of toExpand) {
        queueFoldMutation(
          (current) => patchCollapsed(current, id, false),
          (clientRequestId) => api.setNodeCollapsed(mapId, id, false, clientRequestId),
        )
      }
      revealAndSelect(target)
    },
    [detail, focusId, mapId, queueFoldMutation, revealAndSelect],
  )
  const gotoListRef = useRef<HTMLDivElement>(null)
  // 跳转面板结果列表：纯数字（容错 # 前缀）= 编号直达放首行，其余按标题
  // 子串匹配（不区分大小写，前缀命中优先、再按编号升序）；可见集来自 layout
  // （折叠隐藏的行带"将展开祖先"标记——搜索的常见目标正是看不见的节点）。
  // path = 祖先链文本（tooltip 里给同名节点消歧）
  const gotoVisibleIds = useMemo(() => new Set(layout?.all.map((l) => l.node.display_id)), [layout])
  const gotoResults = useMemo(() => {
    const q = gotoText.trim()
    if (!detail || !q) return [] as Array<{ node: NodeDTO; hidden: boolean; exact: boolean; path: string }>
    const byId = new Map(detail.nodes.map((n) => [n.display_id, n]))
    const pathOf = (n: NodeDTO) => {
      const segs: string[] = []
      let cur = n
      while (cur.parent != null) {
        const p = byId.get(cur.parent.display_id)
        if (!p) break
        segs.unshift(p.content)
        cur = p
      }
      return segs.join(' / ')
    }
    const out: Array<{ node: NodeDTO; hidden: boolean; exact: boolean; path: string }> = []
    const idHit = q.match(/^#?(\d+)$/)
    if (idHit) {
      const n = detail.nodes.find((x) => x.display_id === Number(idHit[1]))
      if (n) out.push({ node: n, hidden: !gotoVisibleIds.has(n.display_id), exact: true, path: pathOf(n) })
    }
    const lower = q.toLowerCase()
    const matches = detail.nodes
      .filter((n) => n !== out[0]?.node && n.content.toLowerCase().includes(lower))
      .map((n) => ({ n, prefix: n.content.toLowerCase().startsWith(lower) ? 0 : 1 }))
      .sort((a, b) => a.prefix - b.prefix || a.n.display_id - b.n.display_id)
      .slice(0, 9 - out.length)
    for (const m of matches)
      out.push({ node: m.n, hidden: !gotoVisibleIds.has(m.n.display_id), exact: false, path: pathOf(m.n) })
    return out
  }, [gotoText, detail, gotoVisibleIds])
  const gotoActive = Math.min(gotoActiveRaw, Math.max(0, gotoResults.length - 1))

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
      revealAndSelect(target)
    },
    [detail, selectedId, focusId, mapId, layout, queueFoldMutation, revealAndSelect],
  )

  // Ctrl/Cmd+P = 编号跳转面板开关。capture 阶段独立挂：先于各输入框自己的
  // keydown stopPropagation（聊天/备注/outline 输入态也能触发，VS Code 式全局
  // 命令键）——这是对"输入区隔离快捷键"惯例的唯一刻意例外。
  // preventDefault 压掉浏览器打印（打印是 Ctrl+P keydown 的默认动作，Docs/
  // vscode.dev 同款机制）；判定用 e.code（物理键位）：e.key 在非拉丁布局
  // （俄语等）下不是 'p'，漏判会让打印真弹出来
  useEffect(() => {
    const onGotoKey = (e: KeyboardEvent) => {
      if (e.repeat) return // 按住不放：不反复开合
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyP') {
        e.preventDefault()
        setCtxMenu(null) // 瞬时浮层互斥：菜单与跳转面板不同时存在
        setGotoText('')
        setGotoActiveRaw(0)
        setGotoOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onGotoKey, true)
    return () => window.removeEventListener('keydown', onGotoKey, true)
  }, [])

  // 跳转列表激活行滚动可见（↑↓ 越出滚动区时贴边；键盘操作才需要，hover 自带视点）
  useEffect(() => {
    if (gotoOpen) gotoListRef.current?.querySelector('.goto-result.active')?.scrollIntoView({ block: 'nearest' })
  }, [gotoActive, gotoOpen])

  // ── 快捷键（F2·Ctrl+Enter 编辑 / Tab 加子 / Enter 加兄弟 / Delete 删除 / Space 收放 / Esc 退聚焦 / 方向键导航）──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 逐层退出：先关跳转面板与弹层（goto/outline/版本面板），再退聚焦；
      // 输入态（弹层内的编辑框等）让位给局部 Esc 处理（goto 输入框自带局部 Esc，
      // 这里覆盖焦点不在输入框的窗口——如点了预览行之后）
      if (e.key === 'Escape') {
        const el = document.activeElement
        const typing =
          el instanceof HTMLElement &&
          (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        // 右键菜单是瞬时浮层，退出优先级最高（goto 之前）
        if (!typing && ctxMenu != null) {
          setCtxMenu(null)
          return
        }
        if (!typing && gotoOpen) {
          setGotoOpen(false)
          return
        }
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
        if (!typing && helpOpen) {
          setHelpOpen(false)
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
      // Enter/Tab 也不许再把已开的输入框切模式（防焦点被抢时的次生误操作）；
      // 右键菜单开着同理——瞬时浮层期间键盘只管 Esc 关菜单这一件事
      if (adding != null || ctxMenu != null) return
      // d = 备注面板开合：插在综合守卫之前——无选中时也允许"关"（开着面板
      // 但选区已被清空的场景）；面板内 textarea 聚焦时走下方输入元素守卫
      // ?（Shift+/）= 交互指南开关，与 d 键同款守卫（输入态不开）
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el0 = document.activeElement
        const typing0 =
          el0 instanceof HTMLElement &&
          (el0.tagName === 'INPUT' || el0.tagName === 'TEXTAREA' || el0.isContentEditable)
        if (!typing0 && editingId == null) {
          e.preventDefault()
          setHelpOpen((v) => !v)
          return
        }
      }
      if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = document.activeElement
        const typing =
          el instanceof HTMLElement &&
          (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (typing || editingId != null || outlineOpen || revOpen || chatGateOpen || gotoOpen) return
        if (selectedId == null && !noteOpen) return // 无选中且未开：无可展示的对象
        e.preventDefault()
        toggleNote()
        return
      }
      if (editingId != null || outlineOpen || revOpen || chatGateOpen || gotoOpen || selectedId == null || !detail)
        return
      // 聊天面板开着时：浏览类（方向键/空格收放）保留——边聊边看图是常态流；
      // 只禁"焦点在面板内"时的编辑类键（Enter/Tab 弹输入框、F2 进编辑、
      // Delete 删子树）。曾按"面板开着即全禁"（焦点推断不可靠），但面板改
      // 默认开启后用户进图快捷键全废（Tab 落进原生 focus 遍历）——收窄到
      // 焦点区域判定；Agent 处理中输入框 disabled 的焦点踢丢由 ChatPanel
      // 把焦点收进面板容器兜底，判定恢复可靠
      if (chatOpen && (e.key === 'F2' || e.key === 'Tab' || e.key === 'Enter' || e.key === 'Delete')) {
        if (document.activeElement?.closest?.('.chat-panel')) return
      }
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
  }, [selectedId, editingId, adding, ctxMenu, outlineOpen, revOpen, chatGateOpen, chatOpen, noteOpen, helpOpen, detail, mapId, focusId, switchFocus, startAdd, deleteNode, navigate, queueFoldMutation, toggleNote])
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
  // 取子节点（position 升序）：面包屑菜单级联用。filter 产新数组再 sort，不改原数组。
  // 每次 hover 只渲染一条菜单链、每层一次 O(n) 扫描，不值得为它加常驻 byParent memo
  //（那得随每次 WS 全量重拉重算，菜单没开也付费）
  const kidsOf = useCallback(
    (pid: number): NodeDTO[] =>
      (detail?.nodes ?? [])
        .filter((n) => n.parent != null && n.parent.display_id === pid)
        .sort((a, b) => a.position - b.position),
    [detail],
  )

  const callbacks = useMemo(
    () => ({
      // 单击 = 静默选中：只高亮（方向键/F2/Tab/Delete 的锚点），不弹任何 UI。
      // 弹出类（备注面板/右键菜单）只认显式入口：长按 / 角标 / 右键 / d 键
      onSelect: (id: number) => {
        setSelectedId(id)
      },
      // 长按 = 显式意图入口：选中 + 有备注开备注面板（无备注静默——创建走
      // 右键菜单 / d 键 / 角标）。pin 恒开不动
      onActivate: (id: number, hasNote: boolean) => {
        setSelectedId(id)
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
          (id === editingId ? 'e' : '') +
          (id === adding?.anchor ? (adding.dir === 'sibling' ? 'S' : 'a') : '') +
          ((childCount.get(id) ?? 0) > 0 ? 'h' : '') +
          (ln.node.note ? 'n' : '')
        return `${id}:${Math.round(ln.x)},${Math.round(ln.y)},${ln.w}x${ln.h}:${ln.side}${ln === layout.root ? 'R' : ''}${ln.node.collapsed ? 'C' : ''}:${flags}:${ln.node.content}`
      })
      .join('|')
  }, [layout, selectedId, editingId, adding, childCount])

  // 边签名只看结构（谁连谁）：文本 / 选中态 / 锚定侧变化不影响边——
  // 锚定侧由当前帧位置推导（见 rfEdges），不属结构性变化
  const edgesSig = useMemo(() => {
    if (!layout) return ''
    const parts: string[] = []
    for (const ln of layout.all)
      for (const c of ln.children) parts.push(`${ln.node.display_id}-${c.node.display_id}`)
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
      const dp = dragPos?.get(lnode.node.display_id) // 拖拽跟手位：优先于动画与布局
      const sel = lnode.node.display_id === selectedId
      const x = dp?.x ?? p?.x ?? lnode.x
      const y = (dp?.y ?? p?.y ?? lnode.y) - lnode.h / 2
      const op = p ? p.op : 1
      // 节点内容签名：RF 与 MindNodeView 消费的全部字段（nodesSig 同源维度
      // + 交互态 + 动画位置/透明度）。签名相同 → 复用旧对象。
      // 透明度取 1% 粒度（视觉阈值）：整数 round 会让中断帧 op≈0.5 撞上终态
      // key（半透明对象被永久复用——节点卡浅色）；千分位精确又使动画尾段
      // 每帧换对象（churn 回升）。1% 粒度两头兼顾：0.5 不撞 1，>0.995 等价 1
      const key = `${id}:${Math.round(x)},${Math.round(y)},${Math.round(op * 100)}:${sel ? 's' : ''}${
        lnode.node.display_id === editingId ? 'e' : ''
      }${lnode.node.display_id === adding?.anchor ? (adding!.dir === 'sibling' ? 'S' : 'a') : ''}${
        dp ? 'D' : ''
      }:${lnode === layout.root ? 'R' : ''}${(childCount.get(lnode.node.display_id) ?? 0) > 0 ? 'h' : ''}${
        lnode.node.note ? 'n' : ''
      }${lnode.node.collapsed ? 'C' : ''}:${lnode.node.content}`
      const old = prev.get(id)
      // callbacks 身份代表整个 data 回调组（其内部字段同批重建）
      if (old && old.key === key && old.node.data.onSelect === callbacks.onSelect) {
        next.set(id, old)
        return old.node
      }
      const fresh: MindNode = {
        id,
        type: 'mind' as const,
        // 先点击选中才能拖（防误拖）：未选中的节点按住拖动毫无反应。
        // sel 已在复用 key 里（'s' 标志），选中切换换新对象、此处自然生效
        draggable: sel,
        position: { x, y },
        width: lnode.w, // 供 MiniMap 等在 DOM 测量前使用（nodeHasDimensions）
        height: lnode.h,
        // measured 必须给：RF adoption 对无 measured 的新节点对象会清掉
        // handleBounds（parseHandles 的设计——期待重测），但重测只在节点 DOM
        // 尺寸变化（ResizeObserver）或 handle 方位变化时触发。动画期间节点
        // 逐帧新对象而宽高恒定 → bounds 恒为 undefined → getEdgePosition
        // null → 全部边渲染 null，整段动画"集体消失"（形状切换闪没的根因）
        measured: { width: lnode.w, height: lnode.h },
        // 拖拽中浮顶：盖过途经的所有节点（拖到目标上方时被拖节点应在最上层，
        // 否则大子树间穿行时被遮、看不到落点）。key 里的 D 标记保证拖动首帧
        // 换对象（zIndex 变化必须新对象才生效）。半透明 0.55：命中判定用指针
        // 点而用户对准的是节点视觉——不透开就看不见指针落在目标的哪个区，
        // 误触感的主要来源
        ...(dp ? { zIndex: 1000 } : {}),
        style: { width: lnode.w, height: lnode.h, opacity: dp ? 0.55 : op },
        selected: sel,
        data: {
          lnode,
          isLayoutRoot: lnode === layout.root, // 引用相等：all 里的根对象就是 layout.root
          isEditing: lnode.node.display_id === editingId,
          isAdding: lnode.node.display_id === adding?.anchor,
          addingDir: adding?.dir ?? 'child',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 门卫注释见上；layout 由 nodesSig 表达；dragPos 拖拽逐帧驱动
  }, [nodesSig, animPos, dragPos, callbacks])

  const rfEdges: Edge[] = useMemo(() => {
    if (!layout) return []
    const edges: Edge[] = []
    // 拖拽改挂载中：隐藏被拖节点与其父的连线（视觉"摘下"——不断开则整根
    // 边被拉伸跟着走，挂载语义模糊）。drop/取消后 dragPos 清空，边自然恢复
    const dragId = dragPos ? [...dragPos.keys()][0] : null
    for (const ln of layout.all) {
      for (const c of ln.children) {
        if (dragId != null && c.node.display_id === dragId) continue
        // 锚定侧按当前帧的实际位置推导，而非布局 side 终值：节点走动画插值时
        // （形态切换中左侧子树滑向右侧），side 终值会让锚点在第一帧就翻到对面，
        // 而节点还在原位——边整段动画期间横穿父节点（即"切形态闪一下乱线"的
        // 根因）。静止期位置 = 终值，推导结果与 side 恒一致（LEVEL_GAP 保证
        // 子在父外侧），视觉零变化
        const px = (animPos?.get(ln.node.display_id)?.x ?? ln.x) + ln.w / 2
        const cx = (animPos?.get(c.node.display_id)?.x ?? c.x) + c.w / 2
        const side = cx >= px ? 1 : -1
        edges.push({
          id: `e-${ln.node.display_id}-${c.node.display_id}`,
          source: String(ln.node.display_id),
          target: String(c.node.display_id),
          sourceHandle: side === 1 ? 'sr' : 'sl',
          targetHandle: side === 1 ? 'tl' : 'tr',
          type: 'mind',
        })
      }
    }
    return edges
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 结构由 edgesSig 表达；animPos 动画期间逐帧驱动锚定侧；dragPos 拖拽中隐藏父边
  }, [edgesSig, animPos, dragPos])

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

  // 右键菜单目标：渲染守卫（查无即不渲染，配合失联关闭 effect 双保险）；
  // 根判定与键盘 Delete 同源（布局根 = 真根或聚焦节点，聚焦/删除不挂根）
  const ctxNode = ctxMenu == null ? null : (detail.nodes.find((n) => n.display_id === ctxMenu.id) ?? null)
  const ctxIsRoot = ctxNode != null && ctxNode.display_id === layout.root.node.display_id

  return (
    <div className="editor">
      <header className="toolbar">
        <button className="btn icon" onClick={onBack} title={t('common.backToList')} aria-label={t('common.backToList')}>☰</button>
        <span className={`ws-dot ${wsState}`} title={t('ws.sync', { state: t(`ws.${wsState}` as I18nKey) })} />
        <span className={`ws-label ${wsState}`}>
          {t(`ws.${wsState}` as I18nKey)}
        </span>
        {/* 折叠同步开关：紧挨连接状态——WS 本身不断（内容照常同步），断的只是
            折叠这一类事件的收发。active = 已断开（特殊态要被看见） */}
        <button
          className={`btn icon${foldSyncOn ? '' : ' active'}`}
          onClick={() => setFoldSyncOn((v) => !v)}
          aria-pressed={!foldSyncOn}
          title={foldSyncOn ? t('fold.syncOnTitle') : t('fold.syncOffTitle')}
          aria-label={foldSyncOn ? t('fold.syncOnAria') : t('fold.syncOffAria')}
        >
          {foldSyncOn ? <FoldSyncOnIcon /> : <FoldSyncOffIcon />}
        </button>
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
        <ThemeSwitch />
        <button
          className="btn icon"
          onClick={() => setHelpOpen((v) => !v)}
          title={t('help.title')}
          aria-label={t('help.title')}
        >
          <HelpIcon />
        </button>
      </header>

      {error && <div className="toast editor-toast">{error}</div>}

      {/* 横向主体：画布始终全宽；聊天面板悬浮右侧、备注面板悬浮左侧（overlay，不压缩画布）。
          备注面板 top 让出左上组件区（标题/工具列原地不动，见 App.css .detail-panel） */}
      <div className="editor-main">
        <div className="rf-wrap">
          {/* 标题悬浮于画板左上角，独立于工具栏；pointer-events:none 不挡画布交互
              （面包屑在 .crumbs 上局部恢复 pointer-events:auto） */}
          <div className="map-title">
            <span className="map-id">#{detail.id}</span>
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
                            crumbHoverTimer.current = window.setTimeout(
                              () => setCrumbHoverId(n.display_id),
                              CRUMB_HOVER_OPEN_DELAY,
                            )
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
                              kidsOf={kidsOf}
                              childCount={childCount}
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
            /* 外层 div 的 callback ref：ctrl+滚轮缩放的 capture 拦截随元素
               挂/摘（setFlowHost 见上） */
            ref={setFlowHost}
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
            nodesDraggable /* 拖节点到另一节点上 = 改挂载（onNodeDragStop 提交
                move_node）；画布平移改为拖空白处。全局开关恒开，能否拖由节点级
                draggable 决定（rfNodes 里 = 选中态，先单击选中才可拖，防误拖）；
                长按/双击/单击不受影响（拖动超阈值才启动，移动 >8px 早已取消长按计时） */
            onNodeDragStart={onDragStart}
            onNodeDrag={onDrag}
            onNodeDragStop={onDragStop}
            onNodeContextMenu={onNodeCtx}
            onPaneContextMenu={onPaneCtx}
            nodesConnectable={false}
            zoomOnDoubleClick={false}
            /* wheel → 平移：触摸板两指滑动 = 拖空白处平移，1:1 跟手（speed
               默认 0.5 是半速，提到 1 才与拖拽一致）。浏览器层滚轮与触摸板双指
               同为 wheel 事件无法区分，滚轮缩放一并让出；缩放走 ctrl+滚轮
               （触摸板捏合，速度自算，见 flowHostRef 那个 effect）与
               Controls +/- */
            panOnScroll
            panOnScrollSpeed={1}
            zoomOnScroll={false}
            elementsSelectable
            onPaneClick={() => {
            setSelectedId(null)
            setAdding(null)
            // 点空白清选中 = 离开依附节点：未 pin 的备注面板收起
            if (noteOpen && !notePinned) setNoteOpen(false)
          }}
            proOptions={{ hideAttribution: true }}
          >
            {/* 点阵背景：init 期即有（ccd8154 Notion 重主题时误删，2026-09-09
                应用户反馈恢复）——纯白画布太亮易疲劳，浅灰底 + 点阵给空间参照。
                点色经 CSS 用 --canvas-dot token 化（fill attr 不解析 var()，
                prop 传值仅作 CSS 缺席时的兜底） */}
            <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#cbd5e1" />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              className="rf-minimap"
              /* 颜色传 CSS 变量：SVG presentation attribute 按 CSS 值解析，var()
                 随 html[data-theme] 翻转，TSX 不感知主题、颜色单一来源在 token */
              nodeColor="var(--canvas-panel)" /* 与画布节点同底，形状靠描边呈现 */
              nodeStrokeColor={(n) => {
                const d = n.data as MindNodeData
                return d.isLayoutRoot ? 'var(--canvas-ink)' : 'var(--canvas-line)' // 根用深描边保持可寻
              }}
            />
          </ReactFlow>
        </div>

        {chatOpen && agentOk && (
          <ChatPanel mapId={mapId} width={chatWidth} onResize={setChatWidth} onClose={() => setChatOpen(false)} />
        )}
        {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
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

      {/* 节点右键操作菜单：fixed 单例浮层；关闭走 window capture（见组件）。
          根判定与键盘 Delete 同源（布局根 = 真根或聚焦节点） */}
      {ctxMenu && ctxNode && (
        <NodeContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          canFocus={!ctxIsRoot && (childCount.get(ctxNode.display_id) ?? 0) > 0}
          canDelete={!ctxIsRoot}
          onEdit={() => setEditingId(ctxNode.display_id)}
          onAdd={() => startAdd(ctxNode.display_id, 'child')}
          // 与 onOpenNote 等价的最简式：选中（开菜单时已置，重复幂等防御
          // WS 期间漂移）+ 开面板。有备注=打开；无备注=空面板即创建入口；
          // pin 不动
          onNote={() => {
            setSelectedId(ctxNode.display_id)
            setNoteOpen(true)
          }}
          onFocusNode={() => switchFocus(ctxNode.display_id)}
          onDelete={() => deleteNode(ctxNode.display_id)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Ctrl+P 编号/标题跳转：透明点击层（不遮画布，点外关闭）+ 顶部悬浮小卡。
          纯数字 = 编号直达（首行），任意文本 = 标题搜索；↑↓ 选行、Enter/点击跳转 */}
      {gotoOpen && (
        <div className="goto-backdrop" onClick={() => setGotoOpen(false)}>
          <div
            className="goto-palette"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t('editor.gotoTitle')}
          >
            <div className="goto-input-row">
              <span className="goto-hash" aria-hidden="true">#</span>
              <input
                autoFocus
                className="goto-input"
                value={gotoText}
                placeholder={t('editor.gotoPlaceholder')}
                aria-label={t('editor.gotoTitle')}
                onChange={(e) => {
                  setGotoText(e.target.value)
                  setGotoActiveRaw(0)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation() // 与其他输入区同款：按键不冒泡到全局快捷键
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    if (!gotoResults.length) return
                    e.preventDefault() // 不动输入框光标
                    setGotoActiveRaw((i) =>
                      (i + (e.key === 'ArrowDown' ? 1 : gotoResults.length - 1)) % gotoResults.length,
                    )
                    return
                  }
                  if (e.key === 'Enter') {
                    const hit = gotoResults[gotoActive]
                    if (hit) {
                      setGotoOpen(false)
                      gotoNode(hit.node.display_id)
                    }
                  }
                  if (e.key === 'Escape') setGotoOpen(false)
                }}
              />
            </div>
            {gotoResults.length > 0 ? (
              <div className="goto-list" ref={gotoListRef}>
                {gotoResults.map((r, i) => (
                  <button
                    key={r.node.display_id}
                    className={`goto-result${i === gotoActive ? ' active' : ''}`}
                    onMouseEnter={() => setGotoActiveRaw(i)}
                    onClick={() => {
                      setGotoOpen(false)
                      gotoNode(r.node.display_id)
                    }}
                  >
                    <span className="goto-id">#{r.node.display_id}</span>
                    <span className="goto-content" title={r.path ? `${r.path} / ${r.node.content}` : r.node.content}>
                      {r.node.content}
                    </span>
                    {r.exact && <span className="goto-flag">{t('editor.gotoExact')}</span>}
                    {r.hidden && <span className="goto-flag">{t('editor.gotoCollapsed')}</span>}
                  </button>
                ))}
              </div>
            ) : gotoText.trim() ? (
              <div className="goto-result miss">
                {gotoText.trim().match(/^#?(\d+)$/)
                  ? t('editor.gotoNotFound', { n: Number(gotoText.trim().replace(/^#/, '')), count: detail?.nodes.length ?? 0 })
                  : t('editor.gotoNoResults')}
              </div>
            ) : null}
            <div className="goto-hint">{t('editor.gotoHint')}</div>
          </div>
        </div>
      )}

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

      {/* 未配置/需重配模型网关：点置灰的对话按钮弹配置表单（保存即探测校验）。
          reason_code 非配置类失败（如 MCP 挂了）也在此表单可见——表单错误区渲染。 */}
      {chatGateOpen && (
        <ProviderConfigModal
          reason={
            agentStatus?.reason_code
              ? { code: agentStatus.reason_code, detail: agentStatus.reason_detail }
              : null
          }
          onClose={() => setChatGateOpen(false)}
          onSaved={(s) => {
            setAgentStatus(s) // 弹窗内已 refetch，这里直接采用其结果
            if (s.ok) {
              setChatGateOpen(false)
              setChatOpen(true) // 首次配置成功：直接进入对话，省一次点击
            }
          }}
        />
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
