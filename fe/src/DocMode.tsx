// 文档模式主体：左 Tree 导航 + 右分层文档（specs/008）。纯交互层——
// 数据（detail）与全部写操作 API 都由 MindMapEditor 持有并经 props 下发，
// 本组件只管视图组织、选中联动与就地编辑状态。
// 头部（#id/标题/v版本/模式工具组）在编辑器级统一渲染（.view-head，
// 两模式共用同一框架），本组件不含 chrome。
//
// 编辑状态机：同一时刻至多一个编辑态（content/note 二选一）；切换编辑
// 目标时旧 textarea 卸载触发兜底 flush（DocView DocEditor cleanup）。
// 快捷键：F2 编辑选中块标题 / Space 折叠展开 / ↑↓ 可见行序列移动选中。
// Esc 不切模式——模式是持久化视图偏好（防误触），由头部按钮切换。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from './i18n'
import { buildDocRows } from './docRows'
import { DocTree } from './DocTree'
import { DocView, type DocEditTarget } from './DocView'
import type { MapDetail } from './types'

// 手机判定（iPhone 基准，≤768px 涵盖主流手机横竖屏）：matchMedia + change
// 监听（theme.tsx 同款模式），横竖屏旋转 / 窗口缩放实时切换渲染分支
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => window.matchMedia('(max-width: 768px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const onChange = () => setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}

interface Props {
  detail: MapDetail
  selectedId: number | null // 复用编辑器选中态（Ctrl+P goto 等共用）
  treeOpen: boolean // 左侧导航树展开/收起（开关在统一头部，localStorage 记忆）；
  // PC = 内联侧栏；手机 = Modal 抽屉（覆盖式不挤压文档区）
  onTreeClose: () => void // 关闭侧栏（手机 Modal 的 backdrop/选中关闭路径）
  onSelect: (id: number | null) => void
  onToggleFold: (id: number) => void
  onUpdateNode: (id: number, content?: string, note?: string) => Promise<boolean>
}

export function DocMode({ detail, selectedId, treeOpen, onTreeClose, onSelect, onToggleFold, onUpdateNode }: Props) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  // 可见行序列：文档纵向顺序 = Tree 行序，两栏共用同一份（折叠态驱动裁剪）
  const rows = useMemo(() => buildDocRows(detail), [detail])
  const [editing, setEditing] = useState<DocEditTarget | null>(null) // 就地编辑目标（标题/正文二选一）
  const handleEdit = useCallback((target: DocEditTarget | null) => setEditing(target), [])

  // 双向联动：选中变化 → 两栏各自滚到可见（60ms 等 WS 展开祖先后新行渲染，
  // revealAndSelect 同款手法）。rows.length 进依赖：展开祖先后新行才存在
  useEffect(() => {
    if (selectedId == null) return
    const timer = window.setTimeout(() => {
      document
        .querySelector(`.doc-block[data-id="${selectedId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      document.querySelector(`.doc-row[data-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [selectedId, rows.length])

  // 失联守卫（渲染期派生，不 setState）：编辑目标被删（Agent 删子树等）→
  // 视图等价于无编辑态；state 留待下一次交互自然覆盖（ctxMenu 守卫同精神）
  const editingLive =
    editing != null && detail.nodes.some((n) => n.display_id === editing.id) ? editing : null

  // 文档模式快捷键：编辑选中块标题 / 可见行序列移动。输入态守卫与画布全局
  // effect 同款（tagName 判定）；编辑 textarea 的 keydown 已 stopPropagation。
  // 收拢（折叠）不在此提供——统一由左侧 Tree 交互承担（2026-09-24 用户拍板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing || selectedId == null) return
      const idx = rows.findIndex((r) => r.node.display_id === selectedId)
      if (e.key === 'F2') {
        e.preventDefault()
        setEditing({ id: selectedId, field: 'content' })
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = idx + (e.key === 'ArrowDown' ? 1 : -1)
        if (next >= 0 && next < rows.length) onSelect(rows[next].node.display_id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, selectedId, onSelect])

  return (
    <div className="doc-mode" aria-label={t('doc.treeAria')}>
      {/* 手机：侧栏以左侧抽屉 Modal 呈现（覆盖式——内联展开会把 390px 宽的
          文档区压到不可读）。treeOpen 是与 PC 共用的真相源：选中行或点
          backdrop 即关。 */}
      {isMobile ? (
        treeOpen && (
          <div className="doc-tree-modal" role="dialog" aria-label={t('doc.treeAria')}>
            <button
              className="backdrop"
              aria-label={t('doc.treeClose')}
              onClick={onTreeClose}
            />
            <DocTree
              rows={rows}
              selectedId={selectedId}
              onSelect={(id) => {
                onSelect(id)
                onTreeClose() // 选中即关：跳去读内容，抽屉不留场
              }}
              onToggleFold={onToggleFold}
              collapsed={false}
            />
          </div>
        )
      ) : (
        /* PC：收起 = 负 margin 滑出（内容保留，动画顺滑；.doc-mode
           overflow:hidden 防横向滚动条），开关在统一头部 */
        <DocTree
          rows={rows}
          selectedId={selectedId}
          onSelect={onSelect}
          onToggleFold={onToggleFold}
          collapsed={!treeOpen}
        />
      )}
      <DocView
        rows={rows}
        selectedId={selectedId}
        editing={editingLive}
        mapId={detail.id /* 块内嵌 vditor 的上传分目录 */}
        onSelect={onSelect}
        onToggleFold={onToggleFold}
        onEdit={handleEdit}
        onUpdateNode={onUpdateNode}
      />
    </div>
  )
}
