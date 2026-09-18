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
    /**
     * ★ 生产默认**不产出**可公开访问的 source map。
     * 原来的 `sourcemap: true` 会把 ~4MB 的 index-*.js.map 一起发布到 Nginx 静态目录，
     * 任何未登录访客都能还原组件名、后台路由、错误文案与源码结构 —— 既是攻击面，
     * 也让静态体积翻好几倍。
     * 需要接错误监控平台时用 `SOURCEMAP=hidden npm run build`：
     * 仍生成 map，但不写 sourceMappingURL（浏览器不主动加载，只有拿到文件的人能用）。
     */
    sourcemap: process.env.SOURCEMAP === 'hidden' ? 'hidden' : false,
    rollupOptions: {
      output: {
        /**
         * 拆包：原来所有代码压成一个 841KB（gzip 261KB）的 chunk，
         * 首屏必须把整个后台（含所有页面）下载完才可交互。
         * 把体积大、更新频率低的依赖单独成 chunk，业务代码改动时它们仍命中浏览器缓存。
         */
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-tdesign': ['tdesign-react', 'tdesign-icons-react'],
        },
      },
    },
  },
})
