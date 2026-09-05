// 把 vditor dist 的按需资源拷到 public/vditor（编辑器 options.cdn = '/vditor'）。
// Vditor 的 mermaid/highlight/lute 等不在 bundle 里，运行时从 cdn 路径按需加载；
// 默认 cdn 是 unpkg（国内慢 + 桌面版离线不可用），必须本地化。
//
// 裁剪：只拷本项目用到的子集（≈9.5MB）。mathjax/katex/graphviz/echarts/markmap/
// abcjs/smiles-drawer/flowchart.js/wavedrom 对应功能未开启，不拷（toolbar 无入口，
// 粘贴对应语法块会静默降级为纯文本，可接受）。
import { cpSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // fe/
const src = path.join(root, 'node_modules', 'vditor', 'dist')
// vditor 内部资源拼接是 `${cdn}/dist/js/...`（带 dist 层级），故 public 下要同名结构：
// options.cdn = '/vditor' → 浏览器请求 /vditor/dist/js/... → public/vditor/dist/js/...
const dest = path.join(root, 'public', 'vditor', 'dist')

const subset = ['css', 'images', 'js/lute', 'js/mermaid', 'js/highlight.js', 'js/i18n', 'js/icons']
rmSync(dest, { recursive: true, force: true })
for (const item of subset) {
  cpSync(path.join(src, item), path.join(dest, item), { recursive: true })
}
console.log(`copied vditor assets -> public/vditor/dist (${subset.join(', ')})`)
