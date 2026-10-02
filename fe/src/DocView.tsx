// 文档模式右侧：每个可见节点一个 block（标题 + 正文），标题就地编辑。
//
// 渲染映射：content → 标题（根 = 文档大标题，depth 1..3 → H1..H3，
// ≥4 级小节段落——见 docTree.headingLevel）；note → 正文 markdown
// （与 ChatPanel 同管线：react-markdown + remark-gfm + mdComponents，mermaid 免费）。
//
// 编辑分工（2026-09-26 用户拍板，二修）：标题 = 块内就地 textarea（短文本）；
// 正文 = 块内嵌 vditor——与侧边栏备注面板同一编辑器效果（工具栏/粘贴上传/
// IR 即时渲染全套），但就地挂在文档块里，不弹侧边栏。
//
// 标题就地编辑：uncontrolled textarea；提交判脏（值 === 基线不发请求，不造
// 垃圾版本快照），保存成功才前移基线（失败重试不被判"无变化"）。
// 草稿保护：textarea uncontrolled + block 按 display_id memo（字段级比较），
// detail 全量重拉不打断打字。
import { Suspense, lazy, memo, useEffect, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from './i18n'
import { mdComponents } from './Mermaid'
import { headingLevel, type DocRow } from './docTree'

// vditor 独立 chunk（与 DetailPanel 共用同一个 lazy 模块）
const VditorEditor = lazy(() => import('./VditorEditor').then((m) => ({ default: m.VditorEditor })))

export interface DocEditTarget {
  id: number
  field: 'content' | 'note'
}

interface Props {
  rows: DocRow[]
  selectedId: number | null
  editing: DocEditTarget | null // 就地编辑目标（至多一个；null = 无）
  mapId: number // 块内嵌 vditor 的图片上传分目录（var/uploads/<map_id>/）
  onSelect: (id: number) => void
  // 开启就地编辑（target）/ 收起编辑态（null）
  onEdit: (target: DocEditTarget | null) => void
  // 就地编辑保存（content/note 单值；另一键 undefined 被 api 层丢弃 = 不动）
  onUpdateNode: (id: number, content?: string, note?: string) => Promise<boolean>
}

// ── 标题就地编辑器 ─────────────────────────────────────────────────────
// 卸载兜底 flush（DetailPanel 模式）：切编辑目标/切模式/删节点时 textarea
// 卸载不触发 blur，脏草稿由 cleanup 提交；Esc 置 discarded 标记让 cleanup
// 跳过（取消 = 丢弃），保存成功才前移基线（防双写 & 防失败吞重试）。
// 成功回调经 ref 转发：卸载 cleanup 置 null，迟到的 then 调不到（否则会把
// editing 已指向的新编辑目标误关）。不用"卸载置 alive=false"式标记——
// StrictMode 的 dev 双挂载（mount→cleanup→mount）会把它永久打成 false
interface EditorProps {
  initial: string
  onDone: () => void // 提交成功或取消后收起编辑态
  onSave: (value: string) => Promise<boolean>
}

function DocEditor({ initial, onDone, onSave }: EditorProps) {
  const valueRef = useRef(initial) // 最新输入值（卸载 flush 用，不依赖 DOM ref 的 detach 时序）
  const savedRef = useRef(initial) // 本会话已确认基线
  const discardedRef = useRef(false)
  const savingRef = useRef(false)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onSuccessRef = useRef<(() => void) | null>(null)

  // 发请求（内部判脏）：onSuccess 仅在本会话仍存活时经 ref 回调
  const send = (value: string, onSuccess?: () => void) => {
    if (value === savedRef.current || savingRef.current) return false
    if (!value.trim()) return false // 空标题不成立（树约束）；空正文=清空合法走 send 外判
    onSuccessRef.current = onSuccess ?? null
    savingRef.current = true
    void onSaveRef.current(value).then((ok) => {
      savingRef.current = false
      if (!ok) return // 失败：保持编辑态可重试（错误 toast 由编辑器统一展示）
      savedRef.current = value // 成功才前移：卸载 flush 不再重发
      onSuccessRef.current?.()
    })
    return true
  }

  // 交互提交（Enter / blur）：无变化或空标题时也退出编辑态
  // ——按 Enter 表达的是"我完成了"，只是不造垃圾版本快照
  const commit = (value: string) => {
    if (send(value, () => onDoneRef.current())) return
    if (savingRef.current) return // 保存中：完成时收尾（失败保持可重试）
    onDoneRef.current()
  }

  useEffect(
    () => () => {
      // 卸载兜底：blur 之外的所有离场路径（切编辑目标/切模式/删节点）——
      // 只发请求不动 editing state；Esc 已置 discarded 跳过（取消 = 丢弃）
      onSuccessRef.current = null
      if (discardedRef.current) return
      send(valueRef.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在卸载时跑一次
    [],
  )

  return (
    <textarea
      className="doc-head-editor"
      autoFocus
      defaultValue={initial}
      rows={1}
      spellCheck={false}
      onFocus={(e) => e.target.select()} // 标题短文本：全选便于整体重写
      onInput={(e) => {
        valueRef.current = e.currentTarget.value
      }}
      onBlur={(e) => commit(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()} // 编辑器内按下不触发块级手势
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation() // 不冒泡到全局快捷键（rf-editor 同款）
        // Enter 提交、Shift+Enter 换行；输入法组词中的 Enter 是选词不是提交
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          commit((e.target as HTMLTextAreaElement).value)
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          discardedRef.current = true // 卸载 cleanup 跳过：取消 = 丢弃草稿
          onDoneRef.current()
        }
      }}
    />
  )
}

// ── 正文就地编辑器（块内嵌 vditor，与侧边栏同一编辑效果）───────────────
// 状态机与 DocEditor 同款（判脏不发请求/成功才前移基线/卸载 flush/Esc 丢弃/
// onSuccessRef 防 StrictMode 双挂载与迟到回调）；值源是 vditor 的 onInput
//（异步链，Ctrl+Enter 时读 valueRef 镜像），Ctrl+Enter 提交、Esc 取消
interface NoteEditorProps {
  initial: string
  mapId: number
  uploadErrorText: string
  onDone: () => void
  onSave: (value: string) => Promise<boolean>
}

function DocNoteEditor({ initial, mapId, uploadErrorText, onDone, onSave }: NoteEditorProps) {
  const { lang } = useI18n()
  const valueRef = useRef(initial)
  const savedRef = useRef(initial)
  const discardedRef = useRef(false)
  const savingRef = useRef(false)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onSuccessRef = useRef<(() => void) | null>(null)

  const send = (value: string, onSuccess?: () => void) => {
    if (value === savedRef.current || savingRef.current) return false
    onSuccessRef.current = onSuccess ?? null
    savingRef.current = true
    void onSaveRef.current(value).then((ok) => {
      savingRef.current = false
      if (!ok) return
      savedRef.current = value
      onSuccessRef.current?.()
    })
    return true
  }

  const commit = (value: string) => {
    if (send(value, () => onDoneRef.current())) return
    if (savingRef.current) return
    onDoneRef.current() // 无变化也退出（与标题编辑一致）
  }
  const commitRef = useRef(commit)
  commitRef.current = commit

  // 点击外部 = 自动保存收起（2026-09-26 用户拍板——块内编辑没有"关闭按钮"，
  // 外部点击是最自然的退出手势）。click capture 在目标处理前到达：先保存旧
  // 编辑，随后的目标 click（选中/双击开新编辑）在新状态下正常进行。
  // 编辑器自身放行——含 vditor 挂到 body 的弹层/全屏层（closest .vditor 命中）；
  // 用 click 而非 pointerdown：拖动滚动条不产生 click，阅读长文不误触收起
  useEffect(() => {
    const onOuterClick = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.doc-note-vditor, .vditor')) return
      commitRef.current(valueRef.current)
    }
    document.addEventListener('click', onOuterClick, true)
    return () => document.removeEventListener('click', onOuterClick, true)
  }, [])

  useEffect(
    () => () => {
      onSuccessRef.current = null
      if (discardedRef.current) return
      send(valueRef.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在卸载时跑一次
    [],
  )

  return (
    <div className="doc-note-vditor">
      <Suspense fallback={<div className="doc-note-loading">…</div>}>
        <VditorEditor
          initialValue={initial}
          editable
          locale={lang === 'zh' ? 'zh_CN' : 'en_US'}
          onInput={(v) => {
            valueRef.current = v
          }}
          onCtrlEnter={() => commit(valueRef.current)}
          onEsc={() => {
            discardedRef.current = true // 取消 = 丢弃草稿
            onDoneRef.current()
          }}
          uploadErrorText={uploadErrorText}
          uploadMapId={mapId}
        />
      </Suspense>
    </div>
  )
}

// ── 单个文档块 ─────────────────────────────────────────────────────────
// 收拢（折叠）不在文档块上提供——由左侧 Tree 统一承担（2026-09-26 用户拍板）
interface BlockProps {
  row: DocRow
  selected: boolean
  editingField: 'content' | 'note' | null
  mapId: number
  uploadErrorText: string
  langLabel: { emptyNote: string }
  onSelect: (id: number) => void
  onEdit: (target: DocEditTarget | null) => void
  onUpdateNode: (id: number, content?: string, note?: string) => Promise<boolean>
}

// detail 每次全量重拉都换对象身份，必须字段级比较（nodesSig 同精神）；
// 回调由 DocMode 层 useCallback 稳定 + 本层透传，引用不等才视为变化
const DocBlock = memo(
  function DocBlock({ row, selected, editingField, mapId, uploadErrorText, langLabel, onSelect, onEdit, onUpdateNode }: BlockProps) {
    const { node, depth } = row
    const hl = headingLevel(depth)
    const isRoot = depth === 0
    const headClass = isRoot ? 'doc-title' : hl != null ? `doc-h${hl}` : 'doc-h-deep'
    const note = node.note ?? ''

    const head = editingField === 'content' ? (
      <DocEditor
        initial={node.content}
        onDone={() => onEdit(null)}
        onSave={(v) => onUpdateNode(node.display_id, v)}
      />
    ) : (
      <div
        className={`doc-head ${headClass}`}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onEdit({ id: node.display_id, field: 'content' })
        }}
      >
        <span className="doc-head-text">{node.content}</span>
      </div>
    )

    return (
      <section
        /* headClass 挂到块上供间距规则用（标题字号规则限定 .doc-head 前缀，
            不会泄到块本身）——层级越高上方留白越大；--doc-depth 驱动轻缩进
            （depth≥2 内收 24px/级，见 App.css） */
        className={`doc-block ${headClass}${isRoot ? ' root' : ''}${selected ? ' sel' : ''}`}
        data-id={node.display_id}
        style={{ '--doc-depth': depth } as React.CSSProperties}
        onClick={() => onSelect(node.display_id)}
      >
        {/* 左缘装订线（Notion gutter）：#N 锚点编号（Agent 协作的 [id:N]
            语义）常驻显示。拖拽把手（⋮⋮）已随文档模式拖拽能力一并移除
            （2026-09-26 用户拍板：docs 内拖拽体验差，重排回画布做） */}
        {!isRoot && (
          <span className="doc-gutter" aria-hidden="true">
            <span className="doc-id">#{node.display_id}</span>
          </span>
        )}
        {head}
        {editingField === 'note' ? (
          <DocNoteEditor
            initial={note}
            mapId={mapId}
            uploadErrorText={uploadErrorText}
            onDone={() => onEdit(null)}
            onSave={(v) => onUpdateNode(node.display_id, undefined, v)}
          />
        ) : note ? (
          <div
            className="doc-block-note md"
            onDoubleClick={(e) => {
              e.stopPropagation()
              onEdit({ id: node.display_id, field: 'note' })
            }}
          >
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {note}
            </Markdown>
          </div>
        ) : (
          <div
            className="doc-block-note empty"
            onDoubleClick={(e) => {
              e.stopPropagation()
              onEdit({ id: node.display_id, field: 'note' })
            }}
          >
            {langLabel.emptyNote}
          </div>
        )}
      </section>
    )
  },
  (a, b) =>
    a.row.node.display_id === b.row.node.display_id &&
    a.row.node.content === b.row.node.content &&
    a.row.node.note === b.row.node.note &&
    a.row.depth === b.row.depth &&
    a.selected === b.selected &&
    a.editingField === b.editingField &&
    a.langLabel === b.langLabel &&
    a.onSelect === b.onSelect &&
    a.onEdit === b.onEdit &&
    a.onUpdateNode === b.onUpdateNode,
)

// ── 滚动容器 ───────────────────────────────────────────────────────────
export function DocView({ rows, selectedId, editing, mapId, onSelect, onEdit, onUpdateNode }: Props) {
  const { t, lang } = useI18n()
  // 文案对象整包引用（memo 比较 langLabel === langLabel）：仅切语言换新对象
  const langLabel = useMemo(
    () => ({ emptyNote: t('doc.noteEmpty'), uploadErrorText: t('note.uploadFailed') }),
    [lang], // eslint-disable-line react-hooks/exhaustive-deps -- t 随 lang 变化
  )

  return (
    <div className="doc-view" role="document" aria-label={t('doc.viewAria')}>
      <div className="doc-col">
        {rows.map((row) => (
          <DocBlock
            key={row.node.display_id}
            row={row}
            selected={selectedId === row.node.display_id}
            editingField={editing != null && editing.id === row.node.display_id ? editing.field : null}
            mapId={mapId}
            uploadErrorText={langLabel.uploadErrorText}
            langLabel={langLabel}
            onSelect={onSelect}
            onEdit={onEdit}
            onUpdateNode={onUpdateNode}
          />
        ))}
      </div>
    </div>
  )
}
