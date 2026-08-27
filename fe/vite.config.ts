import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// dev: /api、/mcp、/voyager、/ws 全部代理到 FastAPI（8740），前端同源访问
// build: 产物输出到 src/static 由 FastAPI 托管（生产同源，无需 proxy）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8740',
      '/voyager': 'http://localhost:8740',
      '/mcp': {
        target: 'http://localhost:8740',
        ws: true, // streamable-http 可能升级 SSE/WS 长连接
      },
      '/ws': { target: 'ws://localhost:8740', ws: true },
      '/chat': { target: 'ws://localhost:8740', ws: true },
    },
  },
  build: {
    outDir: '../src/static',
    emptyOutDir: true,
  },
})
