// 文档模式左侧树：紧凑导航 + 拖拽重排。数据是同一份 rows（docTree.buildDocRows），
// 折叠复用 node.collapsed（WS 全端同步免费——与画布双向一致）。
//
// 拖拽语义与画布对齐（VS Code 文件树三区 + dwell）：行内纵向三区
// ——上 30% = 插到它前面、下 30% = 插到它后面、中间 = 挂为子。树行紧贴
// 无画布那样的兄弟间隙，排序带只能取自行内边缘（画布是矩形外部扩 16px）。
// dwell 150ms 停稳确认（扫过不误触）；拖到自己子树 = 红拒（前端防环预检，
// 服务端兜底）；空白落点取消；无乐观更新，WS 驱动重排。
import { memo, useCallback, useRef, useState } from 'react'
import { useI18n } from './i18n'
import { collectDescendants, type DocRow } from './docTree'
import type { NodeDTO } from './types'

const DWELL_MS = 150 // 与画布同值（MindMapEditor 模块级常量）
const DRAG_START_PX = 6 // 位移阈值：纯点击不进拖拽
const EDGE_SCROLL_PX = 24 // 距树容器顶/底该距离内自动滚动

interface Props {
  rows: DocRow[]
  selectedId: number | null
  onSelect: (id: number) => void
  onToggleFold: (id: number) => void
  // 与画布 onDragStop 同款提交签名：child = (dragId, 目标id)；排序 = (dragId, 目标父, position)
  onMove: (dragId: number, parentId: number, position?: number) => void
}

type Zone = 'child' | 'before' | 'after'
interface DropHit {
  id: number
  zone: Zone
  ok: boolean
  parentId: number | null // before/after 用：目标的父（根无兄弟 → 禁）
  position: number // before/after 用：目标的当前序
}

// 折叠钮：与 DocView 的同款（树行版尺寸更小，随 .doc-row 上下文缩放）
function TreeFoldBtn({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    <button
      className={`doc-fold${open ? ' open' : ''}`}
      title={open ? t('doc.collapse') : t('doc.expand')}
      aria-label={open ? t('doc.collapse') : t('doc.expand')}
      aria-expanded={open}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {open ? <path d="m6 9 6 6 6-6" /> : <path d="m9 6 6 6-6 6" />}
      </svg>
    </button>
  )
}

interface RowProps {
  row: DocRow
  selected: boolean
  dragCls: string // '' | 'dragging' | 'drop-target' | 'drop-before' | 'drop-after' | 'drop-forbidden'
  onSelect: (id: number) => void
  onToggleFold: (id: number) => void
  onPointerDownRow: (e: React.PointerEvent, row: DocRow) => void
}

// 拖拽高亮只影响个别行：memo 让 setDropHint 只重渲染两行（旧高亮 + 新高亮）
const TreeRow = memo(
  function TreeRow({ row, selected, dragCls, onSelect, onToggleFold, onPointerDownRow }: RowProps) {
    const { node, depth, hasChildren } = row
    return (
      <div
        className={`doc-row${selected ? ' sel' : ''}${dragCls ? ` ${dragCls}` : ''}`}
        data-id={node.display_id}
        style={{ '--doc-depth': depth } as React.CSSProperties}
        onPointerDown={(e) => onPointerDownRow(e, row)}
        onClick={() => onSelect(node.display_id)}
      >
        {hasChildren ? (
          <TreeFoldBtn open={!node.collapsed} onToggle={() => onToggleFold(node.display_id)} />
        ) : (
          <span className="doc-fold dot" aria-hidden="true" />
        )}
        <span className="doc-row-text" title={node.content}>
          {node.content}
        </span>
        <span className="doc-id">#{node.display_id}</span>
      </div>
    )
  },
  (a, b) =>
    a.row.node.display_id === b.row.node.display_id &&
    a.row.node.content === b.row.node.content &&
    a.row.node.collapsed === b.row.node.collapsed &&
    a.row.depth === b.row.depth &&
    a.row.hasChildren === b.row.hasChildren &&
    a.selected === b.selected &&
    a.dragCls === b.dragCls &&
    a.onSelect === b.onSelect &&
    a.onToggleFold === b.onToggleFold &&
    a.onPointerDownRow === b.onPointerDownRow,
)

export function DocTree({ rows, selectedId, onSelect, onToggleFold, onMove }: Props) {
  const { t } = useI18n()
  const scrollerRef = useRef<HTMLDivElement>(null)
  // 最新树给拖拽闭包用（窗口监听器跨渲染存活，handler 每次重建但读 ref 拿最新值）
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const byIdRef = useRef(new Map<number, NodeDTO>())
  byIdRef.current = new Map(rows.map((r) => [r.node.display_id, r.node]))
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  const [dragId, setDragId] = useState<number | null>(null)
  const [dropHint, setDropHint] = useState<DropHit | null>(null)
  // onUpWin 闭包读 state 会冻结在拖起时的值——镜像 ref 保鲜（渲染期赋值惯例）
  const dropHintRef = useRef<DropHit | null>(null)
  dropHintRef.current = dropHint
  // 拖拽会话 refs（同画布 onDragStart 一组：起点/后代/确认命中/dwell 计时）
  const startRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const draggingRef = useRef(false)
  const descendantsRef = useRef<Set<number>>(new Set())
  const consumedRef = useRef(false) // 拖拽吞掉松手 click（lpConsumed 同款）
  const pendingZoneKey = useRef('none')
  const dwellTimer = useRef<number | undefined>(undefined)
  const confirmedZoneKey = useRef('none')
  const pendingHit = useRef<DropHit | null>(null)

  const applyHint = (hit: DropHit | null) => {
    setDropHint((prev) => {
      if (prev == null && hit == null) return prev
      if (prev && hit && prev.id === hit.id && prev.zone === hit.zone && prev.ok === hit.ok) return prev
      return hit
    })
  }

  /** 行内三区：指针命中的行按纵向分带（上/下 30% = 前插/后插，中间 = 挂子）。 */
  const hitTest = (cx: number, cy: number, drag: number): DropHit | null => {
    const els = [...document.querySelectorAll<HTMLElement>('.doc-row[data-id]')]
    for (const el of els) {
      if (Number(el.dataset.id) === drag) continue
      const r = el.getBoundingClientRect()
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue
      const id = Number(el.dataset.id)
      let zone: Zone
      if (cy < r.top + r.height * 0.3) zone = 'before'
      else if (cy > r.bottom - r.height * 0.3) zone = 'after'
      else zone = 'child'
      const target = byIdRef.current.get(id)
      const parentId = target?.parent?.display_id ?? null
      // 防环（后代红拒）+ 根无兄弟（before/after 禁，画布同语义）
      const ok = !descendantsRef.current.has(id) && (zone === 'child' || parentId != null)
      return { id, zone, ok, parentId, position: target?.position ?? 0 }
    }
    return null
  }

  const endDrag = () => {
    window.clearTimeout(dwellTimer.current)
    pendingZoneKey.current = 'none'
    confirmedZoneKey.current = 'none'
    pendingHit.current = null
    startRef.current = null
    draggingRef.current = false
    setDragId(null)
    setDropHint(null)
  }

  // 稳定引用（TreeRow memo 依赖）：内部全部经 ref/setState 读写，冻结首渲染
  // 闭包无害——与画布 onDrag useCallback([]) 同款论证
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onPointerDownRow = useCallback((e: React.PointerEvent, row: DocRow) => {
    if (e.button !== 0) return
    if (draggingRef.current) return
    startRef.current = { id: row.node.display_id, x: e.clientX, y: e.clientY }

    const onMoveWin = (ev: PointerEvent) => {
      const s = startRef.current
      if (!s) return
      if (!draggingRef.current) {
        if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) <= DRAG_START_PX) return
        // 启动：收集后代（防环预检；树在拖动中不变——画布同假设）
        draggingRef.current = true
        descendantsRef.current = collectDescendants([...byIdRef.current.values()], s.id)
        setDragId(s.id)
      }
      // dwell 状态机（画布 onDrag 同款）：停稳 150ms 才确认高亮，扫过不误触
      const hit = hitTest(ev.clientX, ev.clientY, s.id)
      pendingHit.current = hit
      const key = hit ? `${hit.id}:${hit.zone}` : 'none'
      if (key === 'none') {
        window.clearTimeout(dwellTimer.current)
        pendingZoneKey.current = 'none'
        confirmedZoneKey.current = 'none'
        applyHint(null)
      } else if (key === confirmedZoneKey.current) {
        applyHint(hit)
      } else if (pendingZoneKey.current !== key) {
        pendingZoneKey.current = key
        window.clearTimeout(dwellTimer.current)
        dwellTimer.current = window.setTimeout(() => {
          if (pendingZoneKey.current === key) {
            confirmedZoneKey.current = key
            applyHint(pendingHit.current)
          }
        }, DWELL_MS)
      }
      // 边缘自动滚动：指针贴近树容器顶/底时滚动长列表
      const box = scrollerRef.current?.getBoundingClientRect()
      if (box) {
        if (ev.clientY < box.top + EDGE_SCROLL_PX) scrollerRef.current!.scrollTop -= 8
        else if (ev.clientY > box.bottom - EDGE_SCROLL_PX) scrollerRef.current!.scrollTop += 8
      }
    }

    const onUpWin = () => {
      window.removeEventListener('pointermove', onMoveWin)
      window.removeEventListener('pointerup', onUpWin)
      window.removeEventListener('pointercancel', onCancelWin)
      const s = startRef.current
      if (!draggingRef.current || !s) {
        startRef.current = null // 未启动（点击/滚动）：让 click 自然走选中
        return
      }
      const drag = s.id
      consumedRef.current = true // 松手 click 是拖拽的尾巴，吞掉（不再触发选中）
      // 只认 dwell 已确认的命中（提交换算与画布 onDragStop 一致：
      // child = (dragId, 目标)；before = 占目标的序；after = 序+1）
      const hit = dropHintRef.current
      endDrag()
      if (hit?.ok) {
        if (hit.zone === 'child') onMoveRef.current(drag, hit.id)
        else if (hit.parentId != null) onMoveRef.current(drag, hit.parentId, hit.position + (hit.zone === 'after' ? 1 : 0))
      }
    }

    const onCancelWin = () => {
      window.removeEventListener('pointermove', onMoveWin)
      window.removeEventListener('pointerup', onUpWin)
      window.removeEventListener('pointercancel', onCancelWin)
      if (draggingRef.current) {
        endDrag()
        consumedRef.current = true
      }
      startRef.current = null
    }

    window.addEventListener('pointermove', onMoveWin)
    window.addEventListener('pointerup', onUpWin)
    window.addEventListener('pointercancel', onCancelWin)
  }, [])

  // 稳定引用（TreeRow memo 依赖）：吞掉拖拽尾巴 click，其余走选中
  const handleSelect = useCallback((id: number) => {
    if (consumedRef.current) {
      consumedRef.current = false
      return
    }
    onSelectRef.current(id)
  }, [])

  return (
    <div className="doc-tree" ref={scrollerRef} role="tree" aria-label={t('doc.treeAria')}>
      {rows.map((row) => {
        let dragCls = ''
        if (dragId === row.node.display_id) dragCls = 'dragging'
        else if (dropHint != null && dropHint.id === row.node.display_id) {
          dragCls = !dropHint.ok ? 'drop-forbidden' : dropHint.zone === 'child' ? 'drop-target' : dropHint.zone === 'before' ? 'drop-before' : 'drop-after'
        }
        return (
          <TreeRow
            key={row.node.display_id}
            row={row}
            selected={selectedId === row.node.display_id}
            dragCls={dragCls}
            onSelect={handleSelect}
            onToggleFold={onToggleFold}
            onPointerDownRow={onPointerDownRow}
          />
        )
      })}
    </div>
  )
}
