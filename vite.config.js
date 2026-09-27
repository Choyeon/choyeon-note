import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  base: './',
  server: {
    port: 5176,
    strictPort: true
  },
  test: {
    // store 依赖 localStorage / window.matchMedia，组件测试也需要 DOM。
    // 固定为 node 会让这些文件根本没法测。
    environment: 'jsdom',
    include: ['tests/**/*.test.js']
  }
})
