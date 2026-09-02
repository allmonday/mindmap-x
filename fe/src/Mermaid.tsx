// Mermaid 图表渲染：react-markdown 的 code 覆盖组件 + 共享 components 配置。
// ChatPanel（agent 气泡）与 DetailPanel（备注预览）共用。
//
// mermaid 库很大（~1MB min）——动态 import 按需加载：markdown 里没有
// mermaid 块时零成本，有则加载一次（模块级单例缓存）。vite 自动 code-split，
// 主包不受影响。
import { useEffect, useId, useState, type ReactElement } from 'react'

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'neutral', // 浅灰线条，贴近 Notion 风
        securityLevel: 'strict', // label 转义，防 SVG 注入（默认值，显式声明）
      })
      return m.default
    })
  }
  return mermaidPromise
}

function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // useId 含冒号（:r1:）——mermaid 的 id 选择器不允许，替换掉
  const domId = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  useEffect(() => {
    let alive = true // 严格模式双执行 / 快速切内容时丢弃过期结果
    setFailed(false)
    loadMermaid()
      .then((mermaid) => mermaid.render(domId, chart))
      .then(({ svg }) => alive && setSvg(svg))
      .catch(() => alive && setFailed(true)) // 语法错误：降级显示原文，不炸整块 markdown
    return () => {
      alive = false
    }
  }, [chart, domId])

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
