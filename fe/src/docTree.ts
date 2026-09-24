// 文档模式（specs/008）的纯函数层：可见行序列 / 后代收集 / 标题层级映射。
// 行序 = 文档纵向顺序 = 左 Tree 行序，DocTree/DocView 两栏共用同一份。
// 与画布（layout.ts）一样走 display_id 体系组树，parent_id 不参与。

import type { MapDetail, NodeDTO } from './types'

export interface DocRow {
  node: NodeDTO
  depth: number // 0 = 根
  hasChildren: boolean // 全量孩子数 > 0（无视 collapsed：折叠钮在收起态也要能展开）
}

/** 可见行序列：DFS 按 position 升序（组装同 layoutMap），collapsed 节点的
 * 子树不入行（行自身保留）——树多深文档就多长由折叠态天然控制。 */
export function buildDocRows(detail: MapDetail): DocRow[] {
  const byParent = new Map<number, NodeDTO[]>()
  for (const n of detail.nodes) {
    if (n.parent == null) continue
    const key = n.parent.display_id
    const list = byParent.get(key)
    if (list) list.push(n)
    else byParent.set(key, [n])
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.display_id - b.display_id)
  }
  const rows: DocRow[] = []
  const walk = (node: NodeDTO, depth: number) => {
    const kids = byParent.get(node.display_id) ?? []
    rows.push({ node, depth, hasChildren: kids.length > 0 })
    if (node.collapsed) return
    for (const k of kids) walk(k, depth + 1)
  }
  const root = detail.nodes.find((n) => n.parent == null)
  if (root) walk(root, 0)
  return rows
}

/** id 的全部后代（防环预检：拖拽目标落在自己子树上 = 拒绝）。 */
export function collectDescendants(nodes: NodeDTO[], id: number): Set<number> {
  const kidsOf = new Map<number, number[]>()
  for (const n of nodes) {
    if (n.parent == null) continue
    const key = n.parent.display_id
    const list = kidsOf.get(key)
    if (list) list.push(n.display_id)
    else kidsOf.set(key, [n.display_id])
  }
  const desc = new Set<number>()
  const stack = [id]
  while (stack.length) {
    for (const k of kidsOf.get(stack.pop()!) ?? []) {
      desc.add(k)
      stack.push(k)
    }
  }
  return desc
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/** 深度 → Markdown 标题级：根（depth 0）由调用方渲染为文档大标题；
 * depth 1..6 → H1..H6；depth ≥7 返回 null（缩进退化普通块——markdown
 * heading 只有 6 级，更深层级靠 block 缩进表达）。 */
export function headingLevel(depth: number): HeadingLevel | null {
  if (depth < 1 || depth > 6) return null
  return depth as HeadingLevel
}
