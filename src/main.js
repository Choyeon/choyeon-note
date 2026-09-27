// ============================================================================
// main.js —— 应用入口
// ============================================================================

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'

// 日志接线必须在 createApp 之前完成。
//
// 顺序为什么重要：T08 的内核（logger.js）只产出 LogEntry、默认 sink 是 consoleSink，
// 它**不知道** IPC 的存在，所以单有内核时日志只打控制台、落不了盘；T09 的主进程
// log:append 通道也就一直没有真实调用方。initLogging() 就是那根线 —— 它把 sink
// 换成「批量聚合 → window.electronAPI.logAppend」，并顺带做级别初始化、清空回调
// 订阅与退出前 flush。放在这里调用，能保证组件 setup 里打的第一条日志也在覆盖范围内。
//
// 纯浏览器 / 预览环境下 window.electronAPI 不存在，initLogging() 会自动降级为
// 「环形缓冲 + 控制台」，绝不抛错
import { initLogging } from './utils/logBootstrap'

initLogging()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.mount('#app')
