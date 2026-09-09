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
import { useTheme } from './theme'

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

/** 备注面板首开预热：预挂 vditor 运行时脚本（3.7MB 的 lute.min.js 下载+解析
 *  是首开 ~1s 的主因，实测 chunk 下载本身只占 5ms）。vditor 内部 addScript 以
 *  DOM id 去重（存在同 id 元素即 resolve 跳过），预挂同 id <script> 后，
 *  真正 init 时全部命中、近同步完成。URL 与下方构造参数 cdn/icon 同源，
 *  改配置记得同步。 */
export function prefetchVditorRuntime(locale: 'zh_CN' | 'en_US') {
  const cdn = '/vditor'
  const add = (id: string, src: string, onload?: () => void) => {
    if (document.getElementById(id)) return
    const s = document.createElement('script')
    s.id = id
    s.src = src
    s.onload = onload ?? null
    document.head.appendChild(s)
  }
  add('vditorLuteScript', `${cdn}/dist/js/lute/lute.min.js`, () => {
    // JIT 预热：用 IR init 的真实路径（Md2VditorDOM）渲染一次。lute（Go
    // 编译，3.7MB）首次执行后热点函数的优化编译还要后台跑数秒，此期间打开
    // 备注面板的渲染走半优化路径（实测多 ~500ms）；预热让优化尽早排队。
    // 注：实测本机冷窗口（进页 2s 内即开）改善有限——残留成本在 vditor
    // init 的等待链而非纯执行；进页数秒后打开稳定 ~90ms（无预热对照 ~1s）
    try {
      type LuteApi = { Md2HTML?: (md: string) => string; Md2VditorDOM?: (md: string) => string }
      const lute = (window as unknown as { Lute?: { New: () => LuteApi } }).Lute?.New()
      lute?.Md2VditorDOM?.('# warm up\n\n**bold** `code`\n\n- list\n\n> quote')
      lute?.Md2HTML?.('# warm up\n\n**bold** `code`')
    } catch {
      /* 预热失败无碍正常路径 */
    }
  })
  add(`vditorI18nScript${locale}`, `${cdn}/dist/js/i18n/${locale}.js`)
  add('vditorIconScript', `${cdn}/dist/js/icons/ant.js`)
}

export const VditorEditor = forwardRef<VditorHandle, Props>(function VditorEditor(
  { initialValue, locale, editable, onInput, onCtrlEnter, onEsc, uploadErrorText },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const vditorRef = useRef<Vditor | null>(null)
  // vditor 构造是异步两段的：new 完成时 this.vditor 仍是 undefined，i18n 脚本
  // 加载完 init() 跑完（after 回调）后实例才真正可用。ready 前任何实例方法
  // （destroy/setValue/...）要么抛 TypeError 要么静默丢失，因此：
  // - ready 前 setValue/focus 挂起到 pendingRef，after 里补放；
  // - ready 前 unmount 不调 destroy（半初始化实例会抛错），标记 disposed，
  //   after 迟到时由它补销毁（此时实例已完整，销毁安全，且先于下一个实例 init）
  const readyRef = useRef(false)
  const disposedRef = useRef(false)
  const pendingRef = useRef<{ value?: string; focus?: boolean }>({})
  // 事件回调经 ref 转发，避免回调身份变化触发编辑器重建
  const cbRef = useRef({ onInput, onCtrlEnter, onEsc, uploadErrorText })
  cbRef.current = { onInput, onCtrlEnter, onEsc, uploadErrorText }
  // editable 最新值给 after 回调用（实例 ready 时机晚于首个 effect）
  const editableRef = useRef(editable)
  editableRef.current = editable

  // 主题热切换：setTheme 只换 class + 重载 content-theme/hljs CSS（本地 /vditor），
  // 不重建实例——initialValue 是挂载快照，重建会把未保存草稿回滚（最大的坑）。
  // 构造 effect 的 deps 保持 [locale]：主题变化走这里的独立 effect 热切
  const { resolved } = useTheme()
  const themeRef = useRef(resolved)
  themeRef.current = resolved
  const applyTheme = (v: Vditor, dark: boolean) =>
    v.setTheme(dark ? 'dark' : 'classic', dark ? 'dark' : 'light', dark ? 'github-dark' : 'github')
  useEffect(() => {
    const v = vditorRef.current
    if (v && readyRef.current) applyTheme(v, resolved === 'dark')
    // else：实例未 ready——after 回调里读 themeRef.current 补放（pending 同款思路）
  }, [resolved])

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
    readyRef.current = false
    disposedRef.current = false
    pendingRef.current = {}
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
      theme: resolved === 'dark' ? 'dark' : 'classic', // 挂载时按当前主题（后续热切见 applyTheme）
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
        theme: { path: '/vditor/dist/css/content-theme', current: resolved === 'dark' ? 'dark' : 'light', list: {} },
        hljs: { enable: true, lineNumber: false, style: resolved === 'dark' ? 'github-dark' : 'github' },
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
        // unmount 已发生在 init 完成前（StrictMode 双挂载 / 快速开关面板）：
        // 此刻实例才完整、销毁才安全；顺手把宿主元素清回 init 前状态，
        // 不挡下一个实例在同一元素上重建
        if (disposedRef.current) {
          vditor.destroy()
          return
        }
        vditorRef.current = vditor
        readyRef.current = true
        applyEditable(vditor, editableRef.current)
        // 挂载期间切过主题（effect 被跳过）：按最新值补放
        applyTheme(vditor, themeRef.current === 'dark')
        // 补放 ready 前挂起的调用（首个 source 态挂载的 setValue / focus）
        const pending = pendingRef.current
        if (pending.value !== undefined) vditor.setValue(pending.value, true)
        if (pending.focus) vditor.focus()
      },
    })
    return () => {
      disposedRef.current = true
      vditorRef.current = null
      const wasReady = readyRef.current
      readyRef.current = false
      // ready 前不销毁（半初始化实例 destroy 会抛 TypeError）；disposedRef
      // 已标记，迟到的 after 会补销毁
      if (vditor && wasReady) vditor.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale 变化整体重建可接受（罕见）；value 类变化经 setValue 走 ref
  }, [locale])

  useImperativeHandle(ref, () => ({
    setValue: (markdown: string) => {
      const v = vditorRef.current
      if (v && readyRef.current) v.setValue(markdown, true)
      else pendingRef.current.value = markdown // init 未完成：挂起，after 里补放
    },
    focus: () => {
      const v = vditorRef.current
      if (v && readyRef.current) v.focus()
      else pendingRef.current.focus = true
    },
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
