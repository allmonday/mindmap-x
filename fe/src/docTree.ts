// 文档模式（specs/008）的纯函数层：可见行序列 + 标题层级映射。
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

export type HeadingLevel = 1 | 2 | 3

/** 深度 → 标题级（Notion 本尊路线，2026-09-26 拍板）：heading 只保留 3 档
 * 大字号（depth 1/2/3 → H1/H2/H3），根（depth 0）由调用方渲染为文档大标题；
 * depth ≥4 返回 null——不再假装是 heading，转小字号段落（.doc-h-deep），
 * 层级感由块缩进（24px/级）+ 留白节拍承担。 */
export function headingLevel(depth: number): HeadingLevel | null {
  if (depth < 1 || depth > 3) return null
  return depth as HeadingLevel
}
