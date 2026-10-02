// 文档模式左侧树：紧凑导航。数据是同一份 rows（docRows.buildDocRows），
// 折叠复用 node.collapsed（WS 全端同步免费——与画布双向一致）。
//
// 纯导航（2026-09-26 用户拍板）：只做点选定位 + 折叠收放——文档模式不
// 提供拖拽重排（窄行里拖拽体验差，重排回画布做），首版的三区拖拽
// （pointer events + dwell + 防环）已整体移除。
import { memo } from 'react'
import { useI18n } from './i18n'
import type { DocRow } from './docRows'

interface Props {
  rows: DocRow[]
  selectedId: number | null
  onSelect: (id: number) => void
  onToggleFold: (id: number) => void
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
  onSelect: (id: number) => void
  onToggleFold: (id: number) => void
}

const TreeRow = memo(
  function TreeRow({ row, selected, onSelect, onToggleFold }: RowProps) {
    const { node, depth, hasChildren } = row
    return (
      <div
        className={`doc-row${selected ? ' sel' : ''}`}
        data-id={node.display_id}
        style={{ '--doc-depth': depth } as React.CSSProperties}
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
    a.onSelect === b.onSelect &&
    a.onToggleFold === b.onToggleFold,
)

export function DocTree({ rows, selectedId, onSelect, onToggleFold }: Props) {
  const { t } = useI18n()
  return (
    <div className="doc-tree" role="tree" aria-label={t('doc.treeAria')}>
      {rows.map((row) => (
        <TreeRow
          key={row.node.display_id}
          row={row}
          selected={selectedId === row.node.display_id}
          onSelect={onSelect}
          onToggleFold={onToggleFold}
        />
      ))}
    </div>
  )
}
