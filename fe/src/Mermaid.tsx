// Mermaid 图表渲染：react-markdown 的 code 覆盖组件 + 共享 components 配置。
// ChatPanel（agent 气泡）与 DetailPanel（备注预览）共用。
//
// mermaid 库很大（~1MB min）——动态 import 按需加载：markdown 里没有
// mermaid 块时零成本，有则加载一次（模块级单例缓存）。vite 自动 code-split，
// 主包不受影响。
import { useEffect, useId, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from './theme'
import { useI18n } from './i18n'

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
// 已应用的 mermaid 主题（幂等守卫）：initialize 可重复调用合并配置，
// 但 StrictMode 双执行/多组件并发渲染时只在主题真变了才 re-initialize
let appliedMermaidTheme: string | null = null

function ensureMermaid(theme: 'light' | 'dark') {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise.then((mermaid) => {
    const t = theme === 'dark' ? 'dark' : 'neutral' // neutral = 浅灰线条贴近 Notion 风
    if (appliedMermaidTheme !== t) {
      mermaid.initialize({
        startOnLoad: false,
        theme: t,
        securityLevel: 'strict', // label 转义，防 SVG 注入（默认值，显式声明）
      })
      appliedMermaidTheme = t
    }
    return mermaid
  })
}

function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  // useId 含冒号（:r1:）——mermaid 的 id 选择器不允许，替换掉
  const domId = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const { resolved } = useTheme()
  const { t } = useI18n()

  // 大图查看的 Esc 关闭：capture 优先于编辑器全局 Esc 链（goto/面板等），
  // stopPropagation 防连锁退出——查看器开着时 Esc 只关查看器
  useEffect(() => {
    if (!zoomed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setZoomed(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoomed])

  useEffect(() => {
    let alive = true // 严格模式双执行 / 快速切内容时丢弃过期结果
    setError(null)
    ensureMermaid(resolved)
      .then((mermaid) => mermaid.render(domId, chart))
      .then(({ svg }) => alive && setSvg(svg))
      // 语法错误：降级为"错误信息 + 原文"（常见坑：[] 内引号/括号需转义、
      // gitGraph 分支名仅 ASCII——裸原文降级让用户无从排查，2026-10-03 改）
      .catch((e) => {
        if (!alive) return
        setSvg(null)
        setError(String((e as { message?: string })?.message ?? e).slice(0, 300))
      })
    return () => {
      alive = false
    }
  }, [chart, domId, resolved]) // resolved 变化 → 已挂载的图全部按新主题重渲

  if (error != null) {
    return (
      <div className="mermaid-failed">
        <div className="mermaid-failed-tip">{t('md.mermaidFailed')}</div>
        <div className="mermaid-failed-msg">{error}</div>
        <pre className="mermaid-failed-src">
          <code>{chart}</code>
        </pre>
      </div>
    )
  }
  if (svg == null) return <div className="mermaid-loading" aria-hidden="true" />
  // mermaid 自己生成的 SVG（strict 模式已转义 label）。
  // 点击查看大图（2026-10-04，Doc 模式块宽 820px 内大图看不清细节）：
  // portal 全屏遮罩，原生尺寸展示（超出 92vw/90vh 滚动），点遮罩/Esc 关闭
  return (
    <>
      <div
        className="mermaid-svg"
        title={t('md.mermaidZoom')}
        role="button"
        tabIndex={0}
        aria-label={t('md.mermaidZoom')}
        onClick={() => setZoomed(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setZoomed(true)
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {zoomed &&
        createPortal(
          <div className="mermaid-zoom" onClick={() => setZoomed(false)}>
            <div className="mermaid-zoom-body" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>,
          document.body,
        )}
    </>
  )
}

/** code 覆盖：language-mermaid 的 fenced block 走 Mermaid，其余保持默认行为 */
function CodeBlock(props: { className?: string; children?: React.ReactNode }) {
  const { className, children } = props
  if (className === 'language-mermaid') {
    return <Mermaid chart={String(children).replace(/\n$/, '')} />
  }
  return <code className={className}>{children}</code>
}

/** pre 覆盖：mermaid 块脱离 pre 的深色代码底（Mermaid 自带容器样式） */
function PreBlock(props: { children?: React.ReactNode }) {
  const child = Array.isArray(props.children) ? props.children[0] : props.children
  const el = child as ReactElement<{ className?: string }> | undefined
  const isMermaid = el != null && el.type === CodeBlock && el.props?.className === 'language-mermaid'
  if (isMermaid) return <>{props.children}</>
  return <pre>{props.children}</pre>
}

export const mdComponents = { code: CodeBlock, pre: PreBlock }
