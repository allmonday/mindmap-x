// 树布局：根居中、根的孩子按「前缀分割」分左右（两侧高度差最小，顺序保持）、
// 子树内部继承方向（XMind 风格）；紧凑垂直堆叠。
//
// 三段式流程（保证根居中平移传导到所有后代——曾经的两段式 bug：
// 先算完全树坐标再平移根，导致左侧层间距 = LEVEL_GAP - 根宽/2，根越宽左侧越挤压）：
//   1. buildShape —— 递归算形状（w/h/subtreeH），不含坐标
//   2. splitSides —— 根的孩子前缀分割左右，side 向子树内部继承
//   3. place     —— 递归赋 x/y（根先居中，孩子坐标基于父真实边缘推导）
import type { MapDetail, NodeDTO } from './types'

export interface LNode {
  node: NodeDTO
  x: number // 节点左上角 x
  y: number // 节点中心 y
  w: number
  h: number
  truncated: boolean // 内容超出 4 行容量：组件据此挂原生 title 显示全文
  children: LNode[]
  side: 1 | -1 // 子树方向（根 = 1）
  childrenH: number // 孩子堆叠总高（含 gap）
  subtreeH: number
}

const NODE_H = 36
const GAP_Y = 16
const LEVEL_GAP = 86
const FONT = 14
const MAX_W = 320
const LINE_H = 20 // 多行行高（与 .rf-label 的 line-height:20px 严格一致，勿改回比例值）
const MAX_LINES = 4 // 最多展示行数，超出由 CSS clamp 省略 + hover title 兜底

export function measure(text: string): { w: number; h: number; truncated: boolean } {
  // 宽度估算：CJK 字符记 1 单位，ASCII 记 0.55 单位
  let units = 0
  for (const ch of text) units += ch.codePointAt(0)! > 0x2e7f ? 1 : 0.55
  const oneLine = Math.ceil(units * FONT) + 26 // 单行所需宽（含左右留白 26）
  if (oneLine <= MAX_W) return { w: Math.max(48, oneLine), h: NODE_H, truncated: false }
  // 放不进一行：定宽 MAX_W 换行。行数按每行容量估算、封顶 MAX_LINES——
  // 实际断行由 CSS（word-break:break-all + line-clamp）决定，此处只负责预留高度
  const unitsPerLine = Math.floor((MAX_W - 26) / FONT) // =21：纯中文每行 21 字
  const lines = Math.min(MAX_LINES, Math.ceil(units / unitsPerLine))
  // 单行沿用 NODE_H 不动存量视觉；每多一行 +LINE_H（2/3/4 行 = 56/76/96）
  return { w: MAX_W, h: NODE_H + (lines - 1) * LINE_H, truncated: units > unitsPerLine * MAX_LINES }
}

export interface LayoutResult {
  root: LNode | null
  all: LNode[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export type LayoutMode = 'balanced' | 'right' // 左右镜像对称 / 一律靠右

export function layoutMap(
  detail: MapDetail,
  mode: LayoutMode = 'balanced',
  focusId?: number | null, // 下钻：以该节点为布局根（只布局它的子树）；null/undefined = 全图
): LayoutResult {
  // 组树用 display_id 体系：byParent 键 = 父节点的 display_id（来自 parent 引用）
  const byParent = new Map<number, NodeDTO[]>()
  let root: NodeDTO | null = null
  for (const n of detail.nodes) {
    if (n.parent == null) root = n
    else {
      const key = n.parent.display_id
      const list = byParent.get(key)
      if (list) list.push(n)
      else byParent.set(key, [n])
    }
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.display_id - b.display_id)
  }
  // 下钻只是把递归起点从真根换成聚焦节点，组树照常全量（后代各自的 collapsed 正常生效）
  let focusNode: NodeDTO | null = null
  if (focusId != null) focusNode = detail.nodes.find((n) => n.display_id === focusId) ?? null
  if (!root && !focusNode) return { root: null, all: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }
  const layoutRoot = focusNode ?? root

  // ── 1. 形状 ─────────────────────────────────────────────────────
  const all: LNode[] = []
  function buildShape(node: NodeDTO): LNode {
    // 聚焦根在布局上视作展开（不动 node.collapsed，退出聚焦后恢复原折叠态）；
    // 真根行为不变（真根无 fold 钮、服务端不会置它 collapsed）
    const kids = node.collapsed && node !== focusNode ? [] : (byParent.get(node.display_id) ?? [])
    const { w, h, truncated } = measure(node.content)
    const children = kids.map(buildShape)
    const childrenH =
      children.length === 0
        ? 0
        : children.reduce((s, c) => s + c.subtreeH, 0) + GAP_Y * (children.length - 1)
    const ln: LNode = { node, x: 0, y: 0, w, h, truncated, children, side: 1, childrenH, subtreeH: Math.max(h, childrenH) }
    all.push(ln)
    return ln
  }
  const rootLn = buildShape(layoutRoot!)

  // ── 2. 左右分割（前缀分割：children[0..k) 左、[k..n) 右，k 取两侧高度差最小）──
  // 'right' 模式跳过分割：根的所有孩子一律 side=+1（全在右侧，单向逻辑图形态）
  const kids = rootLn.children
  if (mode === 'right') {
    kids.forEach((c) => {
      c.side = 1
    })
  } else if (kids.length > 0) {
    const prefix: number[] = [0]
    for (const c of kids) prefix.push(prefix[prefix.length - 1] + c.subtreeH + GAP_Y)
    const total = prefix[prefix.length - 1]
    let bestK = 0
    let bestDiff = Infinity
    for (let k = 0; k <= kids.length; k++) {
      const left = prefix[k] - (k > 0 ? GAP_Y * k : 0)
      const diff = Math.abs(2 * left - total)
      if (diff < bestDiff) {
        bestDiff = diff
        bestK = k
      }
    }
    kids.forEach((c, i) => {
      c.side = i < bestK ? -1 : 1
    })
  }
  // side 继承到子树内部
  function inheritSide(ln: LNode) {
    for (const c of ln.children) {
      if (ln !== rootLn) c.side = ln.side
      inheritSide(c)
    }
  }
  inheritSide(rootLn)

  // ── 3. 定位 ─────────────────────────────────────────────────────
  // y：孩子块垂直居中于父节点的子树块（子树内部递归）
  function placeY(ln: LNode, top: number) {
    ln.y = top + ln.subtreeH / 2
    let cy = top + (ln.subtreeH - ln.childrenH) / 2
    for (const c of ln.children) {
      placeY(c, cy)
      cy += c.subtreeH + GAP_Y
    }
  }

  // 根的孩子不走单链堆叠（那会导致"左组占上半、右组占下半"）——
  // 左右两组各自独立堆叠、整体垂直居中于根（XMind 镜像对称形态）
  rootLn.y = 0
  for (const group of [
    rootLn.children.filter((c) => c.side === -1),
    rootLn.children.filter((c) => c.side === 1),
  ]) {
    if (group.length === 0) continue
    const total =
      group.reduce((s, c) => s + c.subtreeH, 0) + GAP_Y * (group.length - 1)
    let top = -total / 2
    for (const c of group) {
      placeY(c, top)
      top += c.subtreeH + GAP_Y
    }
  }

  // x：根先居中，孩子基于父真实边缘推导（左右层间距都恒为 LEVEL_GAP）
  rootLn.x = -rootLn.w / 2
  function placeX(ln: LNode) {
    for (const c of ln.children) {
      c.x = c.side === 1 ? ln.x + ln.w + LEVEL_GAP : ln.x - LEVEL_GAP - c.w
      placeX(c)
    }
  }
  placeX(rootLn)

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ln of all) {
    minX = Math.min(minX, ln.x)
    minY = Math.min(minY, ln.y - ln.h / 2)
    maxX = Math.max(maxX, ln.x + ln.w)
    maxY = Math.max(maxY, ln.y + ln.h / 2)
  }
  return { root: rootLn, all, bounds: { minX, minY, maxX, maxY } }
}

// 贝塞尔连线：锚点方向由 child.side 决定（覆盖 根→左孩子 与 左子树内部 两种情形）
//   child.side=1  → 父右边缘 → 子左边缘
//   child.side=-1 → 父左边缘 → 子右边缘
export function edgePath(parent: LNode, child: LNode): string {
  const px = child.side === 1 ? parent.x + parent.w : parent.x
  const cx = child.side === 1 ? child.x : child.x + child.w
  const py = parent.y
  const cy = child.y
  const mid = (px + cx) / 2
  return `M ${px} ${py} C ${mid} ${py}, ${mid} ${cy}, ${cx} ${cy}`
}
