// Vditor 包装：备注面板的编辑/预览统一视图（单实例双态）。
// 独立文件 + DetailPanel 里 lazy(import) —— vditor 及其 CSS 自成一个动态
// chunk，不用备注面板就不加载（主包不膨胀 ~800KB）。
//
// 预览态 = 同一实例 disabled + 工具栏隐藏（"Disable Edit"）：渲染效果与
// 编辑态 100% 同源（lute + content-theme + mermaid/highlight 全走同一管线），
// 切换零开销，也免掉维护第二套渲染（react-markdown）的分叉。
//
// 与 DetailPanel 的分工：编辑器只是"受控数据源 + 事件出口"——脏检测基线
// （savedRef）、保存状态机全在 DetailPanel；本组件暴露 setValue（node 切换 /
// 外部变更流入 / Esc 丢弃回基线时由父组件调用换值）。
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Vditor from 'vditor'
import 'vditor/dist/index.css'

export interface VditorHandle {
  setValue: (markdown: string) => void
  focus: () => void
}

interface Props {
  initialValue: string
  locale: 'zh_CN' | 'en_US'
  /** false = 预览态：disabled + 工具栏隐藏（只读渲染视图） */
  editable: boolean
  /** 用户输入（含工具栏/粘贴/上传插入）——DetailPanel 的 applyDraft 数据源 */
  onInput: (value: string) => void
  /** Ctrl/Cmd+Enter：保存（Vditor 原生钩子，替代原 textarea onKeyDown 判定） */
  onCtrlEnter: () => void
  /** Esc：丢弃编辑回基线（父组件 applyDraft(savedRef) 后调 setValue 同步编辑器） */
  onEsc: () => void
  /** 上传失败提示文案（Vditor tip 展示） */
  uploadErrorText: string
}

// 工具栏精简集：编辑区排版 + 插入类 + 撤销 + 视图（edit-mode 允许切 sv/wysiwyg，
// fullscreen 是窄面板长备注的刚需）。右端 pin 类（counter/outline）不开。
const TOOLBAR: Array<string | { hotkey?: string; name: string; tip?: string }> = [
  'emoji', 'headings', 'bold', 'italic', 'strike', '|',
  'list', 'ordered-list', 'check', 'quote', 'code', 'inline-code', '|',
  'link', 'table', 'upload', '|',
  'undo', 'redo', '|',
  'edit-mode', 'preview', 'fullscreen',
]

export const VditorEditor = forwardRef<VditorHandle, Props>(function VditorEditor(
  { initialValue, locale, editable, onInput, onCtrlEnter, onEsc, uploadErrorText },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const vditorRef = useRef<Vditor | null>(null)
  // 事件回调经 ref 转发，避免回调身份变化触发编辑器重建
  const cbRef = useRef({ onInput, onCtrlEnter, onEsc, uploadErrorText })
  cbRef.current = { onInput, onCtrlEnter, onEsc, uploadErrorText }
  // editable 最新值给 after 回调用（实例 ready 时机晚于首个 effect）
  const editableRef = useRef(editable)
  editableRef.current = editable

  /** 预览态 = disabled + 工具栏隐藏（双态切换的唯一开关） */
  const applyEditable = (v: Vditor, on: boolean) => {
    v.updateToolbarConfig({ hide: !on })
    if (on) v.enable()
    else v.disabled()
  }

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let vditor: Vditor | null = null
    // handler 模式：上传完全自定义（fetch 我们的 /api/uploads），不依赖
    // Vditor 的 url 模式响应格式；成功后 insertValue 插入相对 URL 的 md 图片，
    // 失败经 vditor.tip 提示（handler 返回类型要求 Promise<string>/Promise<null>
    // 分立，统一走 tip 后恒返 null 最简）
    const uploadHandler = async (files: File[]): Promise<null> => {
      const failed: string[] = []
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file, file.name)
        try {
          const resp = await fetch('/api/uploads', { method: 'POST', body: fd })
          const data = await resp.json().catch(() => null)
          if (!resp.ok || !data?.url) {
            failed.push(file.name)
            continue
          }
          vditor?.insertValue(`![${file.name.replace(/[\\[\]()]/g, '')}](${data.url})\n`)
        } catch {
          failed.push(file.name)
        }
      }
      if (failed.length) vditor?.tip(`${cbRef.current.uploadErrorText}: ${failed.join(', ')}`, 3000)
      return null
    }

    vditor = new Vditor(el, {
      mode: 'ir',
      theme: 'classic',
      icon: 'ant',
      lang: locale,
      // 本地化按需资源（mermaid/highlight/lute）：默认 unpkg 国内慢且桌面版离线不可用。
      // public/vditor/dist 由 scripts/copy-vditor.mjs 生成，build 时落 src/static/vditor
      cdn: '/vditor',
      cache: { enable: false }, // 必须关：localStorage 缓存会覆盖 node 切换时的 setValue
      value: initialValue,
      height: '100%',
      minHeight: 200,
      placeholder: '',
      toolbar: TOOLBAR,
      preview: {
        theme: { path: '/vditor/dist/css/content-theme', current: 'light', list: {} },
        hljs: { enable: true, lineNumber: false, style: 'github' },
      },
      input: (v) => cbRef.current.onInput(v),
      ctrlEnter: () => cbRef.current.onCtrlEnter(),
      esc: () => cbRef.current.onEsc(),
      // 编辑区按键不冒泡到 window 快捷键（与原 textarea 同款隔离；contenteditable
      // 本身也被 MindMapEditor 的 isContentEditable 守卫覆盖，此处双保险）
      keydown: (e) => e.stopPropagation(),
      upload: {
        handler: uploadHandler,
        // url 是"上传功能启用"开关（Vditor 按钮渲染/粘贴上传 gated on url 非空）；
        // handler 存在时实际处理全走 handler，不会向该 url 发请求
        url: '/api/uploads',
        accept: 'image/*',
        multiple: true,
        max: 10 * 1024 * 1024,
        // 文件名清洗（Vditor 默认会剔非单词字符，中文全剔；放宽为只剔危险字符）
        filename: (name) => name.replace(/[\\/:*?"<>|]/g, '_'),
      },
      after: () => {
        if (!vditor) return
        vditorRef.current = vditor
        applyEditable(vditor, editableRef.current)
      },
    })
    return () => {
      vditorRef.current = null
      vditor?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale 变化整体重建可接受（罕见）；value 类变化经 setValue 走 ref
  }, [locale])

  useImperativeHandle(ref, () => ({
    setValue: (markdown: string) => vditorRef.current?.setValue(markdown, true),
    focus: () => vditorRef.current?.focus(),
  }))

  // 预览/编辑切换（实例 ready 后走这里；ready 前由 after 回调按 editableRef 应用）
  useEffect(() => {
    const v = vditorRef.current
    if (v) applyEditable(v, editable)
  }, [editable])

  // 容器级按键隔离：覆盖工具栏下拉/浮层等非 contenteditable 区域的按键路径
  return <div className="note-editor-wrap" onKeyDown={(e) => e.stopPropagation()}>
    <div ref={hostRef} />
  </div>
})
