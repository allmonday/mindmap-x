// 布局动画：整树重排（WS 推送 / 形态切换 / 聚焦 / 回滚）时按 display_id 插值，
// 每帧同时下发节点位置 → React Flow 据此重算连线，节点滑行时连线始终贴合。
//
// 为什么不用 CSS transition on transform：边的 path 在状态更新瞬间就按终点重算，
// SVG path 的 d 属性没有跨浏览器的 CSS 过渡 → 节点滑、连线跳，中途连线悬空。
// 在 React 层逐帧插值则边和节点同源同步；树规模几十节点，每帧全量重算无压力。
import { useLayoutEffect, useRef, useState } from 'react'
import type { LayoutResult } from './layout'

export interface RenderPos {
  x: number
  y: number // 中心 y（与 LNode.y 同语义，消费方自行减 h/2）
  op: number // 新节点淡入进度 0→1（存量节点恒 1）
}

const DUR = 300
const easeOutCubic = (k: number) => 1 - (1 - k) ** 3

/**
 * 返回当前帧渲染位置（display_id → 坐标）；null = 静止期，消费方直接用布局终值。
 * 动画期间每帧一个新 Map 驱动重渲染；新布局中途到达时从当前帧位置平滑重定向。
 */
export function useAnimatedLayout(layout: LayoutResult | null): Map<number, RenderPos> | null {
  const [pos, setPos] = useState<Map<number, RenderPos> | null>(null)
  // 上一帧（或上一轮终态）：下一轮动画的起点，也是"哪些节点是新来的"的判定依据
  const lastRef = useRef<Map<number, RenderPos> | null>(null)

  // useLayoutEffect（不是 useEffect）：必须在本帧 paint 前把首帧动画位置下发，
  // 否则终值位置会先画一帧再跳回起点滑动（一帧闪跳，肉眼可见）
  useLayoutEffect(() => {
    if (!layout) {
      lastRef.current = null
      setPos(null)
      return
    }
    const target = new Map<number, RenderPos>()
    for (const ln of layout.all) target.set(ln.node.display_id, { x: ln.x, y: ln.y, op: 1 })
    const last = lastRef.current
    if (!last) {
      // 首个布局（进图首渲染）：直接对齐，不动画（初始视野交给 ReactFlow 的 fitView）
      lastRef.current = target
      return
    }
    // 起点：上一帧有位置 → 滑行；没有（新增节点 / 展开的折叠子树）→ 终点位 + 淡入。
    // 被删节点直接卸载，无退场动画（React 卸载即消失；其余节点滑行补位已足够顺）
    let moved = false
    const start = new Map<number, RenderPos | null>()
    for (const [id, tgt] of target) {
      const p = last.get(id)
      if (!p) {
        moved = true
        start.set(id, null)
      } else if (Math.abs(p.x - tgt.x) + Math.abs(p.y - tgt.y) > 0.5) {
        moved = true
        start.set(id, p)
      }
    }
    if (!moved || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // 无位移（如仅标题/内容变更不引起重排）或用户要求减少动画：瞬切
      lastRef.current = target
      setPos(null)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const sample = (k: number) => {
      const frame = new Map<number, RenderPos>()
      for (const [id, tgt] of target) {
        const s = start.get(id)
        frame.set(id, s ? { x: s.x + (tgt.x - s.x) * k, y: s.y + (tgt.y - s.y) * k, op: 1 } : { ...tgt, op: k })
      }
      lastRef.current = frame // 中途新布局到达时，从这里平滑重定向
      setPos(frame)
    }
    sample(0) // 首帧同步下发（layout effect 在 paint 前执行，终值永不上屏）
    const tick = (now: number) => {
      const k = easeOutCubic(Math.min(1, (now - t0) / DUR))
      sample(k)
      if (k < 1) raf = requestAnimationFrame(tick)
      else {
        lastRef.current = target
        setPos(null) // 收尾回到 null：消费方回落布局终值（数值与最后一帧一致）
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [layout])

  return pos
}
