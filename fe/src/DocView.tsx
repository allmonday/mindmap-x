// 文档模式右侧：每个可见节点一个 block（标题 + 正文），就地编辑。
//
// 渲染映射：content → 标题（根 = 文档大标题，depth 1..6 → H1..H6，
// ≥7 级缩进退化普通块——见 docTree.headingLevel）；note → 正文 markdown
// （与 ChatPanel 同管线：react-markdown + remark-gfm + mdComponents，mermaid 免费）。
//
// 就地编辑（双击标题/正文）：uncontrolled textarea，键位与画布 rf-editor
// 一致（Enter 提交 / Shift+Enter 换行 / Esc 取消 / 输入法组词守卫 /
// blur 提交；正文另支持 Ctrl+Enter）。提交判脏：值 === 基线不发请求
// （不造垃圾版本快照），保存成功才前移基线（失败重试不被判“无变化”）。
// 草稿保护：textarea uncontrolled + block 按 display_id memo（字段级比较），
// detail 全量重拉不打断打字；外部改同节点最后写入者赢（DetailPanel 哲学）。
import { memo, useEffect, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from './i18n'
import { mdComponents } from './Mermaid'
import { headingLevel, type DocRow } from './docTree'

export interface DocEditTarget {
  id: number
  field: 'content' | 'note'
}

interface Props {
  rows: DocRow[]
  selectedId: number | null
  editing: DocEditTarget | null
  onSelect: (id: number) => void
  // 开启编辑（target）/ 收起编辑态（null）
  onEdit: (target: DocEditTarget | null) => void
  // content/note 二选一传值（undefined 键在 api 层被丢弃 = 不动）；
  // 返回是否成功（失败保留编辑态可重试）
  onUpdateNode: (id: number, content?: string, note?: string) => Promise<boolean>
}

// ── 编辑态 textarea（标题/正文共用骨架）────────────────────────────────
// 卸载兜底 flush（DetailPanel 模式）：切编辑目标/切模式/删节点时 textarea
// 卸载不触发 blur，脏草稿由 cleanup 提交；Esc 置 discarded 标记让 cleanup
// 跳过（取消 = 丢弃），保存成功才前移基线（防双写 & 防失败吞重试）。
interface EditorProps {
  className: string
  initial: string
  field: 'content' | 'note'
  onDone: () => void // 提交成功或取消后收起编辑态
  onSave: (value: string) => Promise<boolean>
}

function DocEditor({ className, initial, field, onDone, onSave }: EditorProps) {
  const valueRef = useRef(initial) // 最新输入值（卸载 flush 用，不依赖 DOM ref 的 detach 时序）
  const savedRef = useRef(initial) // 本会话已确认基线
  const discardedRef = useRef(false)
  const savingRef = useRef(false)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  // 成功回调经 ref 转发：卸载 cleanup 置 null，迟到的 then 调不到（否则会把
  // editing 已指向的新编辑目标误关）。不用"卸载置 alive=false"式标记——
  // StrictMode 的 dev 双挂载（mount→cleanup→mount）会把它永久打成 false
  const onSuccessRef = useRef<(() => void) | null>(null)

  // 发请求（内部判脏）：onSuccess 仅在本会话仍存活时经 ref 回调
  const send = (value: string, onSuccess?: () => void) => {
    if (value === savedRef.current || savingRef.current) return false
    if (field === 'content' && !value.trim()) return false // 空标题不成立（树约束）
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

  // 交互提交（Enter / Ctrl+Enter / blur）：无变化或空标题时也退出编辑态
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
      className={className}
      data-field={field}
      autoFocus
      defaultValue={initial}
      rows={field === 'note' ? 3 : 1}
      spellCheck={false}
      onFocus={(e) => {
        if (field === 'content') e.target.select() // 标题短文本：全选便于整体重写
        else {
          // 正文：等宽源码态自增高（rf-editor 同款手法）
          const ta = e.target
          ta.style.height = 'auto'
          ta.style.height = `${ta.scrollHeight}px`
        }
      }}
      onInput={(e) => {
        valueRef.current = e.currentTarget.value
        if (field !== 'note') return
        const ta = e.currentTarget
        ta.style.height = 'auto'
        ta.style.height = `${ta.scrollHeight}px`
      }}
      onBlur={(e) => commit(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()} // 编辑器内按下不触发块级手势
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation() // 不冒泡到全局快捷键（rf-editor 同款）
        // Enter 提交、Shift+Enter 换行；输入法组词中的 Enter 是选词不是提交。
        // 正文另支持 Ctrl/Cmd+Enter（正文可含空行，单 Enter 不够用）
        const submit = e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing &&
          (field === 'content' ? !(e.ctrlKey || e.metaKey) : true)
        if (submit) {
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

// ── 单个文档块 ─────────────────────────────────────────────────────────
// 收拢（折叠）不在文档块上提供——由左侧 Tree 统一承担（2026-09-24 用户拍板）
interface BlockProps {
  row: DocRow
  selected: boolean
  editingField: 'content' | 'note' | null
  langLabel: { emptyNote: string }
  onSelect: (id: number) => void
  onEdit: (target: DocEditTarget | null) => void
  onUpdateNode: (id: number, content?: string, note?: string) => Promise<boolean>
}

// detail 每次全量重拉都换对象身份，必须字段级比较（nodesSig 同精神）；
// 回调由 DocMode 层 useCallback 稳定 + 本层透传，引用不等才视为变化
const DocBlock = memo(
  function DocBlock({ row, selected, editingField, langLabel, onSelect, onEdit, onUpdateNode }: BlockProps) {
    const { node, depth } = row
    const hl = headingLevel(depth)
    const isRoot = depth === 0
    const headClass = isRoot ? 'doc-title' : hl != null ? `doc-h${hl}` : 'doc-h-deep'
    const note = node.note ?? ''

    const head =
      editingField === 'content' ? (
        <DocEditor
          className="doc-head-editor"
          initial={node.content}
          field="content"
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
          <span className="doc-id">#{node.display_id}</span>
        </div>
      )

    return (
      <section
        /* headClass 挂到块上供间距规则用（标题字号规则限定 .doc-head 前缀，
            不会泄到块本身）——层级越高上方留白越大，见 App.css */
        className={`doc-block ${headClass}${isRoot ? ' root' : ''}${selected ? ' sel' : ''}`}
        data-id={node.display_id}
        onClick={() => onSelect(node.display_id)}
      >
        {head}
        {editingField === 'note' ? (
          <DocEditor
            className="doc-note-editor"
            initial={note}
            field="note"
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
export function DocView({ rows, selectedId, editing, onSelect, onEdit, onUpdateNode }: Props) {
  const { t, lang } = useI18n()
  // 文案对象整包引用（memo 比较 langLabel === langLabel）：仅切语言换新对象
  const langLabel = useMemo(() => ({ emptyNote: t('doc.noteEmpty') }), [lang]) // eslint-disable-line react-hooks/exhaustive-deps -- t 随 lang 变化

  return (
    <div className="doc-view" role="document" aria-label={t('doc.viewAria')}>
      <div className="doc-col">
        {rows.map((row) => (
          <DocBlock
            key={row.node.display_id}
            row={row}
            selected={selectedId === row.node.display_id}
            editingField={editing != null && editing.id === row.node.display_id ? editing.field : null}
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
