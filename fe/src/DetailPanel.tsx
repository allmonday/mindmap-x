// 节点备注面板：content 短标题留在画布，note markdown 长文在这里渲染/编辑。
// 骨架复刻 ChatPanel（右侧 absolute 悬浮 + 左缘拖宽 + chat-head）。
//
// 脏编辑自动保存：切节点 / 选区清空 / 面板关闭（卸载）时统一 flush——
// 判脏基线是 savedRef 而非 node.note（WS 全量重拉会换对象身份，且外部
// 变更与本地未保存编辑并存时本地优先）；显式保存（Ctrl+Enter / 按钮）
// 只前移基线，卸载 flush 发现无脏即不再发第二次（避免多造一个版本快照）。
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useI18n } from './i18n'
import type { NodeDTO } from './types'
import type { VditorHandle } from './VditorEditor'

// vditor（+其 CSS）独立 chunk：不开源码编辑就不加载
const VditorEditor = lazy(() => import('./VditorEditor').then((m) => ({ default: m.VditorEditor })))

// 保存按钮的勾（与节点操作行 CheckIcon 同款）
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

interface Props {
  node: NodeDTO | null // 当前选中节点；null = 无选中占位
  width: number
  onResize: (w: number) => void
  pinned: boolean // pin 住：选中变到别处不收起（内容跟随 / 空态兜底）
  onTogglePin: () => void
  closing: boolean // 播收回动画（父组件延迟卸载期间为 true）
  // note 为 '' 即清空；返回是否成功（失败时面板保留脏态可重试）
  onSaveNote: (nodeId: number, note: string) => Promise<boolean>
}

// 图钉（lucide pin）：pin 住 = 面板常驻
const PinIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
)

export function DetailPanel({ node, width, onResize, pinned, onTogglePin, closing, onSaveNote }: Props) {
  const { t, lang } = useI18n()
  // 源码/预览偏好跨会话记忆（面板常驻：开着不随选节点重挂，切换即持久化）
  const [mode, setMode] = useState<'preview' | 'source'>(
    () => (localStorage.getItem('noteMode') as 'preview' | 'source') || 'preview',
  )
  useEffect(() => {
    localStorage.setItem('noteMode', mode)
  }, [mode])
  // 源码态编辑器句柄：node 切换 / 外部变更流入 / Esc 丢弃时经 setValue 同步内容
  const vditorRef = useRef<VditorHandle | null>(null)

  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const savedRef = useRef('') // 判脏基线（不取 node.note，理由见文件头）
  const lastNodeRef = useRef<NodeDTO | null>(null) // 选区清空（node→null）后仍能 flush
  const onSaveRef = useRef(onSaveNote)
  onSaveRef.current = onSaveNote
  // 保存按钮状态机：禁用(干净) → Save(脏) → Saving(请求中) → Saved(短暂) → 禁用。
  // dirtyState 是 dirty() 的渲染镜像（ref 比较不触发重渲染），在每次
  // applyDraft / 基线变化处同步
  const [dirtyState, setDirtyState] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const savedTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(savedTimer.current), [])

  const dirty = () => draftRef.current !== savedRef.current
  const syncDirty = () => setDirtyState(dirty())
  const applyDraft = (text: string) => {
    draftRef.current = text
    setDraft(text)
    syncDirty()
  }

  const flush = () => {
    const last = lastNodeRef.current
    if (last && dirty()) onSaveRef.current(last.display_id, draftRef.current)
    savedRef.current = draftRef.current // 基线前移：已发出/已放弃的编辑不再重发
    setDirtyState(false)
  }

  // 切节点 / 选区清空：先 flush 上一个节点的脏编辑，再换基线载入新节点
  useEffect(() => {
    flush()
    const note = node?.note ?? ''
    lastNodeRef.current = node
    savedRef.current = note
    draftRef.current = note
    setDraft(note)
    setDirtyState(false)
    vditorRef.current?.setValue(note) // 编辑器活着的窗口内（source 态）同步换内容
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按节点切换走此 effect；外部 note 变更由下方 effect 处理
  }, [node?.display_id])

  // 外部变更（Agent 写入 / 其他页签编辑经 WS 回流）：无本地编辑时自动流入；
  // 有脏编辑本地优先（外部内容会被下一次显式保存覆盖——最后写入者赢）
  useEffect(() => {
    if (!node || dirty()) return
    const note = node.note ?? ''
    if (note !== savedRef.current) {
      savedRef.current = note
      applyDraft(note)
      vditorRef.current?.setValue(note)
    }
  }, [node])

  // 卸载（关闭按钮 / 与聊天面板互斥 / 换图）：脏编辑统一在此兜底 flush
  useEffect(() => () => flush(), [])

  const save = async () => {
    if (!node || !dirty() || saveState === 'saving') return
    setSaveState('saving')
    const ok = await onSaveRef.current(node.display_id, draftRef.current)
    if (!ok) {
      setSaveState('idle') // 失败：保留脏编辑，按钮回到 Save 可重试（错误 toast 由编辑器统一展示）
      return
    }
    savedRef.current = draftRef.current // 基线前移（防卸载二次保存，见文件头）
    setDirtyState(false)
    setSaveState('saved')
    window.clearTimeout(savedTimer.current)
    savedTimer.current = window.setTimeout(() => setSaveState('idle'), 1800)
  }

  return (
    <div className={`detail-panel${closing ? ' closing' : ''}`} style={{ width }} aria-label={t('note.title')}>
      {/* 右缘拖拽调宽（面板贴左缘，鼠标右移宽度增大；280px ~ min(90vw, 760px)） */}
      <div
        className="detail-resize"
        onMouseDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startW = width
          const onMove = (ev: MouseEvent) =>
            onResize(Math.min(Math.max(startW + ev.clientX - startX, 280), Math.min(window.innerWidth * 0.9, 760)))
          const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.classList.remove('chat-resizing')
          }
          document.body.classList.add('chat-resizing')
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
      />
      <div className="chat-head">
        {node && (
          <span className="note-title" title={node.content}>
            #{node.display_id} {node.content}
          </span>
        )}
        <div className="spacer" />
        <div className="seg" role="group" aria-label={t('note.viewMode')}>
          <button
            className={`btn sm${mode === 'preview' ? ' active' : ''}`}
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            {t('note.preview')}
          </button>
          <button
            className={`btn sm${mode === 'source' ? ' active' : ''}`}
            aria-pressed={mode === 'source'}
            onClick={() => setMode('source')}
          >
            {t('note.source')}
          </button>
        </div>
        {/* 图标保存按钮（头部空间让给节点标题）：dirty=可点，saving=禁用，
            saved=勾短暂变绿后回落。文字语义走 aria-label + hover title */}
        {node && mode === 'source' && (
          <button
            className={`btn sm icon note-save${saveState === 'saved' && !dirtyState ? ' ok' : ''}`}
            disabled={!dirtyState || saveState === 'saving'}
            title={t('note.saveHint')}
            aria-label={
              saveState === 'saving'
                ? t('note.saving')
                : saveState === 'saved' && !dirtyState
                  ? t('note.saved')
                  : t('note.save')
            }
            onClick={() => void save()}
          >
            <CheckIcon />
          </button>
        )}
        {/* pin：固定面板（选中变到别处不收起）。原收起按钮的职责移交
            Esc / 工具栏按钮 / d 键 */}
        <button
          className={`btn icon note-pin${pinned ? ' active' : ''}`}
          aria-pressed={pinned}
          title={pinned ? t('note.unpin') : t('note.pin')}
          aria-label={pinned ? t('note.unpin') : t('note.pin')}
          onClick={onTogglePin}
        >
          <PinIcon />
        </button>
      </div>

      {node == null ? (
        <div className="chat-empty">{t('note.noneSelected')}</div>
      ) : mode === 'preview' && !draft ? (
        <div className="chat-empty">
          {t('note.empty')}
          <span className="note-hint">{t('note.emptyHint')}</span>
          <button className="btn sm note-add" onClick={() => setMode('source')}>
            {t('note.add')}
          </button>
        </div>
      ) : (
        // 编辑/预览统一 Vditor 单实例双态：预览 = disabled + 工具栏隐藏，
        // 编辑 = enabled + 工具栏。渲染效果两态同源（lute/content-theme/
        // mermaid 同管线），mode 切换不卸载实例（React 分支不变即复用）。
        // 预览显示 draft：有脏（编辑后未保存切回）时立即看到最新渲染效果
        <Suspense
          fallback={
            <div className="chat-empty">{t('note.editorLoading')}</div>
          }
        >
          <VditorEditor
            ref={vditorRef}
            initialValue={draftRef.current}
            editable={mode === 'source'}
            locale={lang === 'zh' ? 'zh_CN' : 'en_US'}
            onInput={(v) => applyDraft(v)}
            onCtrlEnter={() => void save()}
            onEsc={() => {
              applyDraft(savedRef.current)
              vditorRef.current?.setValue(savedRef.current)
            }}
            uploadErrorText={t('note.uploadFailed')}
          />
        </Suspense>
      )}
    </div>
  )
}
