import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// vditor 的运行时按需资源（lute/i18n/icons）由它自己拼 `<script src>` 从
// options.cdn（/vditor → public/vditor）加载。vite 8 dev 对带
// Sec-Fetch-Dest: script 的请求强制走模块转换管线，public 目录里的 .js 按
// 源码模块解析失败 → 404 → 编辑器 init 永远走不完。生产构建不受影响
// （public 原样拷出、FastAPI 直出静态文件），所以只在 dev server 前置一个
// 中间件把 /vditor 直出为静态文件，绕开 transform 管线。
const serveVditorAssets = (): Plugin => ({
  name: 'serve-vditor-assets-dev',
  apply: 'serve',
  configureServer(server) {
    const root = path.resolve(import.meta.dirname, 'public/vditor')
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    }
    server.middlewares.use((req, res, next) => {
      const p = (req.url ?? '').split('?')[0]
      if (!p.startsWith('/vditor/')) return next()
      const file = path.join(root, path.normalize(p.slice('/vditor/'.length)))
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream')
      fs.createReadStream(file).pipe(res)
    })
  },
})

// dev: /api、/mcp、/voyager、/ws 全部代理到 FastAPI（8740），前端同源访问
// build: 产物输出到 src/static 由 FastAPI 托管（生产同源，无需 proxy）
export default defineConfig({
  plugins: [react(), serveVditorAssets()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8740',
      '/voyager': 'http://localhost:8740',
      '/uploads': 'http://localhost:8740', // 备注图片静态回显
      '/mcp': {
        target: 'http://localhost:8740',
        ws: true, // streamable-http 可能升级 SSE/WS 长连接
      },
      '/ws': { target: 'ws://localhost:8740', ws: true },
      '/chat': { target: 'ws://localhost:8740', ws: true },
      '/local-chat': { target: 'ws://localhost:8740', ws: true }, // 本地 Claude Code 对话通道
    },
  },
  build: {
    outDir: '../src/static',
    emptyOutDir: true,
  },
})
