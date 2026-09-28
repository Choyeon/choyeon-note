// ============================================================================
// trashState.js ——「这次删除走了哪种回收站」的跨模块状态内核
//
// 背景：删除动作发生在 Sidebar / noteStore 里，而「最近删除」页（TrashView）要
// 告诉用户刚删的东西进了**系统回收站**（那类条目不进库内 .trash，本列表管不到，
// 必须明确提示）还是**库内 .trash**（会正常出现在列表里，无需额外提示）。
//
// 为什么必须抽成独立 util，而不是留在 TrashView.vue 里：
//   · `/trash` 是**懒加载路由**（router/index.js 用 `() => import(...)`）。
//     若 Sidebar.vue 为了拿一个 reportTrashMethod 就 `import ... from '@/views/TrashView.vue'`，
//     1089 行的 TrashView 会被整块拖进首屏主 chunk —— 为一个侧边栏导航项把首屏
//     搞大，是实打实的回归。
//   · 反过来让 TrashView import Sidebar/noteStore 会形成环，且「谁删的」这件事
//     本来也不该只有视图关心。
//   · 状态还必须**跨组件实例存活**：用户在 /notes 删完，过一会儿才切到 /trash，
//     挂在组件实例上的 ref 会随卸载归零。
//
// 因此：状态落在**模块作用域**，视图只是它的一个订阅者。
//
// ⚠️ 本文件与 noteIdentity.js / trashIndex.js / dateAttribution.js 同规格：
//    **零 import**（node 下可直接单测）。所有 window / document / CustomEvent
//    访问都必须发生在**函数被调用时**，绝不能在模块顶层执行。
// ============================================================================

/** 删除方式：主进程 fs:delete-file / fs:remove-dir 带 detail:true 时回的 method */
export const TRASH_METHOD_SYSTEM = 'system-trash'
export const TRASH_METHOD_LIBRARY = 'library-trash'

/**
 * 「某次删除走了系统回收站」的通知事件名。
 *
 * ⚠️ 字面量不可改：TrashView 已在 window 上监听这个名字，改名 = 静默断链。
 */
export const TRASH_METHOD_EVENT = 'choyeon:trash-method'

/** 未知 / 未记录的删除方式（空串，便于直接判真假） */
export const TRASH_METHOD_UNKNOWN = ''

// ---------------------------------------------------------------------------
// 模块级状态
// ---------------------------------------------------------------------------

/**
 * 状态源：{ seen, count } —— seen 只增不减，直到用户点「知道了」或显式 reset。
 * 刻意**原地修改**而不是整体替换，这样 getSystemTrashState().value 拿到的
 * 永远是同一个活对象，早先捕获的引用不会变成快照。
 */
const state = { seen: false, count: 0 }

/** 状态变更订阅者（TrashView 用它把状态同步进自己的 vue ref） */
const listeners = new Set()

/**
 * 最近一次**由本模块派发出去**的事件对象。
 *
 * 存在的理由：reportTrashMethod() 既改状态又派发事件，而 TrashView 自己也监听
 * 这个事件 —— 不认回来的话，一次上报会被记两遍（状态 +1，监听器再 +1）。拿事件
 * 对象做身份比对是最省事也最可靠的去重方式（多个挂载实例收到的是同一个对象）。
 */
let lastDispatchedEvent = null

/**
 * 对外暴露的「类 ref」句柄。
 *
 * 为什么不 import vue 的 ref：本文件零依赖是硬约束（node 单测要直接 import）。
 * 因此这里手写一个 duck-typed ref —— 有 `.value` 读写、读出来是活对象。
 * 视图侧若需要真正的响应式，用 subscribeTrashState() 把快照同步进自己的 ref。
 */
const trashStateRef = {
  get value () {
    return state
  },
  set value (next) {
    const src = next && typeof next === 'object' ? next : {}
    state.seen = src.seen === true
    state.count = Number.isFinite(src.count) ? src.count : 0
    emitChange()
  }
}

/**
 * 通知单个订阅者（订阅者是纯 UI 同步回调，它炸了不该连累「记录删除方式」这条
 * 主流程，也不能挡住其它订阅者）。注册时的首次回调同样走这里，口径一致。
 * @param {(snap: {seen: boolean, count: number}) => void} fn 订阅者
 * @returns {void}
 */
function notifyListener (fn) {
  try {
    fn(snapshot())
  } catch (error) {
    void error
  }
}

/** 把当前状态广播给所有订阅者 */
function emitChange () {
  for (const fn of Array.from(listeners)) notifyListener(fn)
}

/**
 * 取当前状态快照（不可变副本，给订阅者用）。
 * @returns {{seen: boolean, count: number}}
 */
function snapshot () {
  return { seen: state.seen, count: state.count }
}

/**
 * 拿到模块级系统回收站状态（给 <script setup> 用）。
 * 走函数而不是直接引用绑定，是为了不依赖「跨 script 块绑定解析」这条编译期行为。
 * @returns {{value: {seen: boolean, count: number}}} 类 ref 句柄
 */
export function getSystemTrashState () {
  return trashStateRef
}

/**
 * 订阅状态变更（TrashView 用它把内核状态同步进自己的响应式 ref）。
 * 注册时会**立刻回调一次**当前快照，调用方不必再手动初始化。
 * @param {(snap: {seen: boolean, count: number}) => void} fn 变更回调
 * @returns {() => void} 取消订阅函数
 */
export function subscribeTrashState (fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  notifyListener(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 单测 / 重挂载前把提示状态归零 */
export function resetSystemTrashState () {
  trashStateRef.value = { seen: false, count: 0 }
}

/** 这个事件是不是本模块自己派出去的（是则监听器应当忽略） */
export function isSelfDispatched (event) {
  return event != null && event === lastDispatchedEvent
}

/**
 * 从 IPC 返回值里**安全**地取出 method。
 *
 * 主进程的 fs:delete-file / fs:remove-dir 只有在传了 `{ detail: true }` 时才回
 * `{ ok, method, path }`，不传就只回 `true` / `false`。老版本主进程、测试 mock、
 * 未支持 detail 的通道都可能回布尔 —— 这时 method 视为**未知**，绝不能
 * `true.method` 解出 undefined 还照记。
 *
 * @param {unknown} result IPC 返回值
 * @returns {string} method 字面量；未知 / 失败 / 非对象一律回 ''
 */
export function extractTrashMethod (result) {
  if (result == null || typeof result !== 'object') return TRASH_METHOD_UNKNOWN
  if (result.ok !== true) return TRASH_METHOD_UNKNOWN
  const method = result.method
  return typeof method === 'string' && method ? method : TRASH_METHOD_UNKNOWN
}

/**
 * 记一次系统回收站删除（内部实现，不派发事件）。
 * @param {'system-trash'|string|null|undefined} method 主进程回的 method
 * @returns {boolean} 是否点亮了系统回收站提示
 */
function markSystemTrash (method) {
  if (method !== TRASH_METHOD_SYSTEM) return false
  trashStateRef.value = { seen: true, count: state.count + 1 }
  return true
}

/**
 * 上报一次删除所走的方式。
 *
 * 只有 `system-trash` 会点亮提示：那种删除不进库内 .trash，用户在本页面里
 * 永远翻不到它，必须明确告诉他去系统回收站找。`library-trash` 会出现在列表
 * 里，不需要额外提示。
 *
 * ⚠️ `notify` 这条分支是**必需**的，不是多余参数：TrashView 自己也在 window 上
 * 监听 TRASH_METHOD_EVENT，若监听器回调里再派发一次事件，就成
 * 「事件 → 上报 → 派发 → 事件」的无限递归（单测里直接表现为调用栈爆掉）。
 * 因此「事件来的」这一路只记状态、绝不回抛。
 *
 * @param {'system-trash'|'library-trash'|string|null|undefined} method 主进程回的 method
 * @param {{notify?: boolean}} [options] notify:false = 只记状态，不再派发事件
 * @returns {boolean} 是否点亮了系统回收站提示
 */
export function reportTrashMethod (method, options = {}) {
  const lit = markSystemTrash(method)
  if (!lit) return false
  if (options.notify !== false && typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    lastDispatchedEvent = new window.CustomEvent(TRASH_METHOD_EVENT, { detail: { method } })
    window.dispatchEvent(lastDispatchedEvent)
  }
  return true
}
