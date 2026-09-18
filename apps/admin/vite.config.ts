import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 显式绑 IPv4 回环。Vite 默认 host='localhost'，而 Node 在 macOS 上会把 localhost
    // 优先解析成 ::1 ⇒ 只监听 [::1]:5173，此时 `http://127.0.0.1:5173` **连不上**
    // （curl / 预览面板 / 各类脚本默认打的都是 127.0.0.1）。写死 127.0.0.1 后两种写法都通。
    // 注意别改成 true / 0.0.0.0：那会把开发服务暴露到局域网。
    host: '127.0.0.1',
    proxy: {
      '/admin/api/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
