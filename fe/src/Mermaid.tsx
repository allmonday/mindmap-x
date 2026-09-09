// Mermaid 图表渲染：react-markdown 的 code 覆盖组件 + 共享 components 配置。
// ChatPanel（agent 气泡）与 DetailPanel（备注预览）共用。
//
// mermaid 库很大（~1MB min）——动态 import 按需加载：markdown 里没有
// mermaid 块时零成本，有则加载一次（模块级单例缓存）。vite 自动 code-split，
// 主包不受影响。
import { useEffect, useId, useState, type ReactElement } from 'react'
import { useTheme } from './theme'

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
  const [failed, setFailed] = useState(false)
  // useId 含冒号（:r1:）——mermaid 的 id 选择器不允许，替换掉
  const domId = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const { resolved } = useTheme()

  useEffect(() => {
    let alive = true // 严格模式双执行 / 快速切内容时丢弃过期结果
    setFailed(false)
    ensureMermaid(resolved)
      .then((mermaid) => mermaid.render(domId, chart))
      .then(({ svg }) => alive && setSvg(svg))
      .catch(() => alive && setFailed(true)) // 语法错误：降级显示原文，不炸整块 markdown
    return () => {
      alive = false
    }
  }, [chart, domId, resolved]) // resolved 变化 → 已挂载的图全部按新主题重渲

  if (failed) {
    return <code className="language-mermaid mermaid-err">{chart}</code> // 原文兜底
  }
  if (svg == null) return <div className="mermaid-loading" aria-hidden="true" />
  // mermaid 自己生成的 SVG（strict 模式已转义 label）
  return <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
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
