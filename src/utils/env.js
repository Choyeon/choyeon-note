/**
 * 运行环境探测。
 *
 * 之前 4 处各自写一遍 `typeof window !== 'undefined' && !!window.electronAPI`，
 * 语义一致却分散在 App.vue / app.js / vault.js / workspace.js，改一处漏三处。
 * 这里统一导出：
 * - IS_ELECTRON：模块级布尔常量（与原 app.js / vault.js / workspace.js 的语义一致，
 *   在加载时求值一次；electronAPI 由 preload 注入，加载后不会再变）。
 * - hasElectronAPI()：每次调用重新求值，给需要"运行时再看一眼"的场景。
 */
export const IS_ELECTRON = typeof window !== 'undefined' && !!window.electronAPI

/** 运行时探测 window.electronAPI 是否可用（SSR / 纯浏览器预览下为 false） */
export function hasElectronAPI () {
  return typeof window !== 'undefined' && !!window.electronAPI
}
