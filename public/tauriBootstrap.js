// 模块脚本求值顺序在打包后不保证：env.js 可能在桥接模块之前读取
// window.electronAPI。这里在经典脚本阶段先放一个占位对象，让 IS_ELECTRON
// 在 Tauri 环境中恒为 true；完整 API 仍由 tauriBridge.js 在挂载前注入。
if (window.isTauri || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)) {
  window.electronAPI = window.electronAPI || {}
}
