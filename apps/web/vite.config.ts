import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发与本地预览都走同一条 `/api/v1` 同源路径 —— 与线上 nginx 的反代方式一致，
// 这样「本地能跑」和「线上能跑」不会因为跨域/路径差异而分叉。
const proxy = {
  '/api/v1': {
    target: 'https://api.dspcz.top',
    changeOrigin: true,
    secure: true,
  },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
})
