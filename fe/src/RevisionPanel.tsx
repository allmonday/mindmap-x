import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { fmtTime, useI18n, type I18nKey } from './i18n'
import { edgePath, layoutMap, type LayoutMode } from './layout'
import type {
  DiffKind,
  MapDetail,
  NodeDTO,
  RevisionChanges,
  RevisionDetail,
  RevisionSnapshot,
  RevisionSummary,
} from './types'

interface Props {
  mapId: number
  current: MapDetail // 父组件的 detail 引用：WS 刷新带入最新 version（"当前"标记 + 时间线重拉跟随）
  layoutMode: LayoutMode // 预览沿用用户当前选择的布局形态
  onClose: () => void
}

// 徽章语义 = 该版本当时发生的事（git log 风格，与旧"回滚预览"视角相反）：
// added 绿（本版新增）/ removed 红（本版删除）/ note 备注变更（琥珀）
const KIND_CLASS: Record<DiffKind, string> = {
  added: 'added',
  removed: 'removed',
  changed: 'chg',
  note: 'note',
  moved: 'mov',
  folded: 'fold',
}

/** 展示态：换行在单行 diff 行里不可见（nowrap 折叠成空格），用 ⏎ 标记 */
const vis = (s: string) => s.replaceAll('\n', '⏎')
const CUT = 16
/** 长前/后缀截断（保留靠近变更处的一段），差异段全量展示（超长才截） */
const cutPre = (s: string) => (s.length > CUT ? `…${vis(s.slice(-(CUT - 2)))}` : vis(s))
const cutSuf = (s: string) => (s.length > CUT ? `${vis(s.slice(0, CUT - 2))}…` : vis(s))

/** 剥离公共前后缀，得到新内容的 差异段 + 两侧语境（行内高亮"哪里变了"） */
function changedView(oldS: string, newS: string) {
  let i = 0
  while (i < oldS.length && i < newS.length && oldS[i] === newS[i]) i++
  let j = 0
  while (j < oldS.length - i && j < newS.length - i && oldS.at(-1 - j) === newS.at(-1 - j)) j++
  const mid = newS.slice(i, newS.length - j)
  return {
    pre: cutPre(newS.slice(0, i)),
    mid: mid.length > 60 ? `${vis(mid.slice(0, 57))}…` : vis(mid),
    suf: cutSuf(newS.slice(newS.length - j)),
  }
}

/** changed 行内容：高亮差异段，两侧公共前后缀截断为语境（"哪里变了"一眼可见） */
function ChangedContent({ oldS, newS }: { oldS: string; newS: string }) {
  const { pre, mid, suf } = changedView(oldS, newS)
  return (
    <span className="rev-node-content">
      <span className="ctx">{pre}</span>
      <mark className="chg-hl">{mid}</mark>
      <span className="ctx">{suf}</span>
    </span>
  )
}

/** 快照 → MapDetail 形状（layoutMap 的输入）：parent 由 display_id 数组还原成关系对象。 */
function snapshotToDetail(snap: RevisionSnapshot): MapDetail {
  const nodes: NodeDTO[] = snap.nodes.map((n) => ({
    display_id: n.display_id,
    map_id: 0,
    parent_id: null,
    parent: n.parent == null ? null : { display_id: n.parent },
    content: n.content,
    note: n.note,
    position: n.position,
    collapsed: n.collapsed,
    updated_by: n.updated_by,
    updated_at: n.updated_at,
  }))
  return { id: 0, title: snap.title, version: 0, created_at: '', nodes }
}

/** 只读快照预览：复用 layoutMap 的真实布局算法，缩放适配容器后静态渲染（无交互）。 */
function SnapshotPreview({ snap, layoutMode }: { snap: RevisionSnapshot; layoutMode: LayoutMode }) {
  const layout = useMemo(
    () => layoutMap(snapshotToDetail(snap), layoutMode),
    [snap, layoutMode],
  )
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = boxRef.current
    if (el) setBox({ w: el.clientWidth, h: el.clientHeight })
  }, [snap]) // 切换快照后内容重挂，重测一次容器

  const w = layout.bounds.maxX - layout.bounds.minX
  const h = layout.bounds.maxY - layout.bounds.minY
  const scale = box ? Math.min(box.w / w, box.h / h, 1) : 1
  // 居中偏移全在 JS 里算准（不依赖 flex 对溢出 item 的对齐行为——那是起始对齐）
  const offX = box ? (box.w - w * scale) / 2 : 0
  const offY = box ? (box.h - h * scale) / 2 : 0

  const edges: { d: string; key: string }[] = []
  for (const ln of layout.all) {
    for (const c of ln.children) edges.push({ d: edgePath(ln, c), key: `${ln.node.display_id}-${c.node.display_id}` })
  }

  return (
    <div className="rev-preview" ref={boxRef}>
      <div
        className="rev-preview-inner"
        style={{
          position: 'absolute',
          left: offX,
          top: offY,
          width: w,
          height: h,
          transform: `scale(${scale})`, // origin top left：右/下延展 w·s / h·s，恰与 offX/offY 构成居中
          transformOrigin: 'top left',
        }}
      >
        <svg width={w} height={h} className="rev-preview-edges">
          {/* edgePath 是根居中于原点的原始坐标（可为负），svg 裁剪溢出 →
              与节点 div 同步平移 -minX/-minY 才能落在可视区内 */}
          <g transform={`translate(${-layout.bounds.minX}, ${-layout.bounds.minY})`}>
            {edges.map((e) => (
              <path key={e.key} d={e.d} />
            ))}
          </g>
        </svg>
        {layout.all.map((ln) => (
          <div
            key={ln.node.display_id}
            className={`rf-node${ln === layout.root ? ' root' : ''}`}
            style={{
              position: 'absolute',
              left: ln.x - layout.bounds.minX,
              top: ln.y - ln.h / 2 - layout.bounds.minY,
              width: ln.w,
              height: ln.h,
            }}
          >
            <span className="rf-label">{ln.node.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function RevisionPanel({ mapId, current, layoutMode, onClose }: Props) {
  const { t, locale } = useI18n()
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null)
  const [selected, setSelected] = useState<RevisionDetail | null>(null)
  const [changes, setChanges] = useState<RevisionChanges | null>(null)
  const [tab, setTab] = useState<'diff' | 'preview'>('diff')
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    api.listRevisions(mapId).then(setRevisions).catch((e) => setError(String(e)))
    return () => window.clearTimeout(confirmTimer.current)
  }, [mapId, current.version]) // version 变化（WS 刷新）自动重拉，面板常开时保持与服务器一致

  const pick = (version: number) => {
    window.clearTimeout(confirmTimer.current)
    setConfirming(false)
    setChanges(null)
    // 完整内容（preview 用）与版本间变更（diff 用）并行拉取
    api
      .getRevision(mapId, version)
      .then(setSelected)
      .catch((e) => setError(String(e)))
    api
      .getRevisionChanges(mapId, version)
      .then(setChanges)
      .catch((e) => setError(String(e)))
  }

  const doRestore = async () => {
    if (!selected || selected.version === current.version) return
    setRestoring(true)
    try {
      await api.restoreRevision(mapId, selected.version)
      onClose() // WS changed 事件驱动画布全量重拉（单一数据流），无需手动更新
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRestoring(false)
    }
  }

  const askRestore = () => {
    if (confirming) {
      void doRestore()
      return
    }
    setConfirming(true)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirming(false), 3000)
  }

  const isCurrent = selected?.version === current.version
  const shownRows =
    changes && changes.rows.length > 200 ? changes.rows.slice(0, 200) : (changes?.rows ?? [])

  return (
    <div className="modal" onClick={onClose}>
      <div
        className={`modal-body rev${tab === 'preview' && selected ? ' wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t('rev.title')}</h3>
        {error && <div className="toast">{error}</div>}
        <div className="rev-cols">
          <div className="rev-list">
            {revisions == null && <div className="rev-empty">{t('rev.loading')}</div>}
            {revisions != null && revisions.length === 0 && (
              <div className="rev-empty">{t('rev.empty')}</div>
            )}
            {(revisions ?? []).map((r) => {
              const isSel = selected?.version === r.version
              const isCur = r.version === current.version
              return (
                <button
                  key={r.version}
                  className={`rev-row${isSel ? ' sel' : ''}${isCur ? ' cur' : ''}`}
                  onClick={() => pick(r.version)}
                >
                  <span className="rev-ver">v{r.version}</span>
                  <span className={`rev-actor ${r.actor}`} title={r.actor} />
                  <span className="rev-action">{t(`rev.action.${r.action}` as I18nKey)}</span>
                  {isCur && <span className="rev-cur-badge">{t('rev.current')}</span>}
                  <span className="rev-time">
                    {fmtTime(r.created_at, locale)}
                  </span>
                  {r.detail && (
                    <span className="rev-detail" title={r.detail}>
                      {r.detail}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <div className="rev-diff">
            {!selected && <div className="rev-empty">{t('rev.selectHint')}</div>}
            {selected && (
              <>
                <div className="rev-pane-head">
                  <div className="rev-tabs" role="tablist">
                    <button
                      className={`rev-tab${tab === 'diff' ? ' active' : ''}`}
                      role="tab"
                      aria-selected={tab === 'diff'}
                      onClick={() => setTab('diff')}
                    >
                      {t('rev.tabDiff')}
                    </button>
                    <button
                      className={`rev-tab${tab === 'preview' ? ' active' : ''}`}
                      role="tab"
                      aria-selected={tab === 'preview'}
                      onClick={() => setTab('preview')}
                    >
                      {t('rev.tabPreview')}
                    </button>
                  </div>
                </div>
                {tab === 'diff' && (
                  <div className="rev-diff-title">{t('rev.diffTitle', { version: selected.version })}</div>
                )}
                {tab === 'diff' && (
                  <>
                    {changes && changes.title_change && (
                      <div className="rev-row-line title">
                        {t('rev.titleChanged')}：{changes.old_title} → {selected.snapshot.title}
                      </div>
                    )}
                    {changes && changes.rows.length === 0 && !changes.title_change && (
                      <div className="rev-empty">{t('rev.diffEmpty')}</div>
                    )}
                    {!changes && <div className="rev-empty">{t('rev.loading')}</div>}
                    {shownRows.map((r) => (
                      <div key={r.display_id} className="rev-row-line">
                        <span className={`rev-badge ${KIND_CLASS[r.kind]}`}>
                          {t(`rev.${r.kind}` as I18nKey)}
                        </span>
                        <span className="rev-node">#{r.display_id}</span>
                        {r.kind === 'changed' && r.oldContent != null ? (
                          <ChangedContent oldS={r.oldContent} newS={r.content} />
                        ) : (
                          <span className="rev-node-content">{vis(r.content)}</span>
                        )}
                      </div>
                    ))}
                    {changes && changes.rows.length > 200 && (
                      <div className="rev-empty">+{changes.rows.length - 200} …</div>
                    )}
                  </>
                )}
                {tab === 'preview' && <SnapshotPreview snap={selected.snapshot} layoutMode={layoutMode} />}
              </>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className={`btn${confirming ? ' danger' : ''}`}
            disabled={restoring || !selected || isCurrent}
            onClick={askRestore}
          >
            {restoring
              ? t('rev.restoring')
              : confirming
                ? t('rev.restoreConfirm')
                : isCurrent
                  ? t('rev.cannotRestoreCurrent')
                  : t('rev.restore')}
          </button>
        </div>
      </div>
    </div>
  )
}
