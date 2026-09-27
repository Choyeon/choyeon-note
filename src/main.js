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
// id ↔ path 映射表的「窗口关闭前最后写一次」保险。
//
// 为什么必须在这里显式装：T16 刻意做成「只导出函数、零 import 副作用」 ——
// 模块一加载就往 window 上挂监听器会在单测里跨用例泄漏、HMR 时重复注册。
// 代价是得有人来装它；不装的话，去抖窗口（800ms）内的最后一次 rebindPath
// 会随窗口关闭一起丢掉（表现为「刚移动过的笔记，重启后又按新路径换了 id」）。
import { installIdMapFlush } from './utils/idMapStore'

initLogging()
// 与 initLogging 同一层级：都是「进程级保险」，装一次即可，返回值（卸载函数）
// 在应用生命周期里用不到，刻意不接
installIdMapFlush()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.mount('#app')
