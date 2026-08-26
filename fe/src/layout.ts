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

export function measure(text: string): { w: number; h: number } {
  // 宽度估算：CJK 字符记 1 单位，ASCII 记 0.55 单位
  let units = 0
  for (const ch of text) units += ch.codePointAt(0)! > 0x2e7f ? 1 : 0.55
  const w = Math.min(MAX_W, Math.max(48, Math.ceil(units * FONT) + 26))
  return { w, h: NODE_H }
}

// 长文本截断显示（编辑态仍显示全文）；返回可放入宽度 w 的前缀
export function fitText(text: string, w: number): string {
  const maxUnits = (w - 24) / FONT
  let units = 0
  let out = ''
  for (const ch of text) {
    units += ch.codePointAt(0)! > 0x2e7f ? 1 : 0.55
    if (units > maxUnits) return out + '…'
    out += ch
  }
  return text
}

export interface LayoutResult {
  root: LNode | null
  all: LNode[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export function layoutMap(detail: MapDetail): LayoutResult {
  const byParent = new Map<number, NodeDTO[]>()
  let root: NodeDTO | null = null
  for (const n of detail.nodes) {
    if (n.parent_id === null) root = n
    else {
      const list = byParent.get(n.parent_id)
      if (list) list.push(n)
      else byParent.set(n.parent_id, [n])
    }
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.id - b.id)
  }
  if (!root) return { root: null, all: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }

  // ── 1. 形状 ─────────────────────────────────────────────────────
  const all: LNode[] = []
  function buildShape(node: NodeDTO): LNode {
    const kids = node.collapsed ? [] : (byParent.get(node.id) ?? [])
    const { w, h } = measure(node.content)
    const children = kids.map(buildShape)
    const childrenH =
      children.length === 0
        ? 0
        : children.reduce((s, c) => s + c.subtreeH, 0) + GAP_Y * (children.length - 1)
    const ln: LNode = { node, x: 0, y: 0, w, h, children, side: 1, childrenH, subtreeH: Math.max(h, childrenH) }
    all.push(ln)
    return ln
  }
  const rootLn = buildShape(root)

  // ── 2. 左右分割（前缀分割：children[0..k) 左、[k..n) 右，k 取两侧高度差最小）──
  const kids = rootLn.children
  if (kids.length > 0) {
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
  // y：孩子块垂直居中于父节点的子树块
  function placeY(ln: LNode, top: number) {
    ln.y = top + ln.subtreeH / 2
    let cy = top + (ln.subtreeH - ln.childrenH) / 2
    for (const c of ln.children) {
      placeY(c, cy)
      cy += c.subtreeH + GAP_Y
    }
  }
  placeY(rootLn, 0)

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
