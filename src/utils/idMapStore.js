// ============================================================================
// idMapStore.js —— id ↔ path 映射表的统一落盘入口（T16 · R-F1 双轨稳定 id）
//
// 背景：笔记 id 目前是「文件路径的哈希」（note.js 的 generateStableId），文件一移动
// / 重命名，id 就跟着变，于是书签、最近打开、图谱坐标、编辑器当前笔记全部失效。
// 双轨方案的第一轨是「映射表」：id 由表说了算，路径怎么搬都不影响 id。
//
// 本文件是第一轨**唯一**的持久化入口。它自己不发明任何 id 语义 —— 所有结构操作
// （绑定 / 搬家 / 裁剪 / 重建 / 解析）都来自 utils/noteIdentity.js，本文件只负责
// 「怎么存、存哪儿、什么时候存」。
//
// 三条硬边界（引入本模块就是为了把它们收在一处，别处都不要再开口子）：
//   ① **绝不写用户的 .md**。映射表住 app.getPath('userData')，与笔记库物理隔离。
//      用户的 Markdown 会被 Obsidian / git / 别的编辑器读写，往里塞应用私有字段
//      等于把实现细节泄漏进用户资产，同步时还会制造无意义 diff。
//   ② **真相源唯一**。Electron 下只有 userData/note-id-map.json 是真的；
//      localStorage 分支只在「没有 electronAPI」（浏览器预览 / 单测）时兜底，
//      不会与 IPC 并存 —— 两处同时写就等于两个真相。
//   ③ **失败不许静默**。读坏、写坏、通道缺失都要落一行 log（mod: 'ipc'），
//      但可以优雅降级：映射表坏掉的最坏后果是退回路径哈希（idMap = null 时
//      resolveId 的兜底行为），而不是让应用启动不起来。
//
// 为什么 choose 显式 installIdMapFlush() 而不是「模块加载即自注册」：
//   · 副作用型模块在单测里最难伺候：import 一次就往 window 上挂监听器，跨用例
//     泄漏，且顺序依赖无从排查（本项目没有 vitest setup 文件可统一清理）；
//   · HMR / 二次挂载会重复注册，beforeunload 也会被触发多次；
//   · 「什么时候开始关心退出」属于宿主决策 —— 与 utils/logBootstrap.js 的
//     startLogBootstrap 同构：由 src/main.js 这类单一引导点显式调用。
//   因此这里只导出函数，不产生任何 import 副作用（本文件顶层零语句执行 I/O）。
//
// ============================================================================

import { LS_KEYS } from '@/constants/storage'
import { LOG_MODULES } from '@/constants/logging'
import { createLogger } from '@/utils/logger'
import { hasElectronAPI } from '@/utils/env'
import { parseIdMap } from '@/utils/noteIdentity'

/** 模块日志出口。'ipc' 是既有模块名：映射表的存取出错一律穿过 IPC 边界 */
const log = createLogger(LOG_MODULES.ipc)

/**
 * 去抖窗口（毫秒）。
 *
 * 800ms 的来源：一次外部移动 / 批量重命名会让目录监听连着送来一串事件，每条最终
 * 都要「把映射表存一遍」。立即写盘会让磁盘 IO 全花在几分钟内就被覆盖掉的中间态上。
 * 取 800ms 既能合并连续的多次重绑定，又短于用户「移动完就切走窗口」的时间体感，
 * 配合下面的 beforeunload/pagehide 兜底，最坏情况也只是丢 800ms 的窗口。
 */
const SAVE_DEBOUNCE_MS = 800

/**
 * 模块级可变状态（仅此三处，均为去抖机制服务）。
 * `pendingMap` 存的是**引用**而不是快照：调用方通常是把同一个 map 交给
 * noteIdentity 原地修改后再 schedule 一次，引用语义保证 flush 时写出的一定是最新的
 * 那一版，不会因为「拿快照的时机」写回旧结构。
 */
let saveTimer = null
let pendingMap = null
// 卸载 flush 时必须拿得到**同一个** listener 引用才能 removeEventListener，所以把它
// 存在模块级；同时兼作「是否已安装」的开关（幂等安装靠它，不靠多挂一组监听器）。
let flushHandler = null

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 判断 m 是不是一张能落盘的映射表。
 *
 * 只查 `byPath` 是否成立对象：`parseIdMap` 定下的规矩是「byPath 是唯一真相源，
 * byId 可由它反推」，所以缺 byId 的表照样能存能恢复；反过来却不成立。
 *
 * @param {unknown} m 待判定对象
 * @returns {boolean} 可落盘返回 true
 */
function isPersistableMap (m) {
  if (!m || typeof m !== 'object') return false
  return Boolean(m.byPath) && typeof m.byPath === 'object'
}

/**
 * 当前是否应该走 Electron IPC。
 *
 * 判定条件包含「idmap 这组 API 真的存在」：老版本 preload（本次改动的上一版）没有
 * 注入这一组，如果只判 hasElectronAPI()，升级窗口期里会拿到
 * `window.electronAPI.idmap.load is not a function` 这种运行时炸 —— 与其让它炸，
 * 不如降级到 localStorage（浏览器预览就是这条路的常态）。
 *
 * @returns {boolean} 走 IPC 返回 true
 */
function hasIdMapIPC () {
  if (!hasElectronAPI()) return false
  const api = window.electronAPI
  return Boolean(api) && Boolean(api.idmap) &&
    typeof api.idmap.load === 'function' &&
    typeof api.idmap.save === 'function'
}

/**
 * 取降级用的 localStorage；不可用返回 null。
 *
 * 隐私模式 / 配额写满 / 跨源 iframe 都可能让取值本身抛异常，这里是启动路径，
 * 直接 try 掉比冒泡上去更合适（异常 nobis 会被记一笔 warn）。
 *
 * @returns {Storage|null} 可用的 Storage，否则 null
 */
function getLocalStorage () {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * localStorage 降级读取。
 *
 * @returns {object|null} 归一化后的映射表；没有存过、损坏、或存储不可用返回 null
 */
function loadIdMapFromLocal () {
  const store = getLocalStorage()
  if (!store) {
    log.warn('localStorage 不可用，无法读取 id 映射表', { key: LS_KEYS.idMap })
    return null
  }

  let raw = null
  try {
    raw = store.getItem(LS_KEYS.idMap)
  } catch (error) {
    log.warn('读取本地 id 映射表失败', { key: LS_KEYS.idMap, error: describeError(error) })
    return null
  }
  if (raw === null || raw === '') return null

  try {
    // 先自己 parse 一遍是为了「能区分损坏」：直接把字符串丢给 parseIdMap 的话，
    // 损坏与「存了一张空表」的返回完全一致，故障现场的 warn 就永远打不出来。
    return parseIdMap(JSON.parse(raw))
  } catch (error) {
    log.warn('本地 id 映射表损坏，已忽略', { key: LS_KEYS.idMap, error: describeError(error) })
    return null
  }
}

/**
 * localStorage 降级写入。
 *
 * @param {object} map 映射表
 * @returns {boolean} 成功返回 true
 */
function saveIdMapToLocal (map) {
  const store = getLocalStorage()
  if (!store) {
    log.error('localStorage 不可用，无法保存 id 映射表', { key: LS_KEYS.idMap })
    return false
  }
  try {
    store.setItem(LS_KEYS.idMap, JSON.stringify(map))
    return true
  } catch (error) {
    log.error('写入本地 id 映射表失败', { key: LS_KEYS.idMap, error: describeError(error) })
    return false
  }
}

/**
 * 异常取名与 Message，不取整个 Error 对象。
 *
 * 日志规则不允许把对象原样塞进 `data`（要能渲染成 k=v，且必须可脱敏），而 message
 * 里可能夹着用户路径 —— 由 logger 统一脱敏，这里不做裁剪。
 *
 * @param {unknown} error 异常
 * @returns {string} 可安全入日志的描述
 */
function describeError (error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  try {
    const name = typeof error.name === 'string' ? error.name : 'Error'
    const message = typeof error.message === 'string' ? error.message : ''
    return message ? `${name}: ${message}` : name
  } catch {
    return 'Error'
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 读映射表。全库唯一的读入口（T19 之后 note.js 的 hydrate 会调它）。
 *
 * 返回值的三种形态：
 *   · 对象 —— 磁盘上有一张可用的表（一定过 `parseIdMap` 归一化，两个方向一致）；
 *   · null —— 没存过（首次运行）/ 损坏 / 读不出；调用方应当据此走
 *             `rebuildIdMap(existingPaths)` 重建，而不是拿一张空表凑合用
 *             （空表会让所有路径都退回哈希 id，等同于没有迁移）。
 * 绝不抛：读取失败会降级并返回 null，由上层决定怎么重建。
 *
 * @returns {Promise<object|null>} 映射表或 null
 */
export async function loadIdMap () {
  if (hasIdMapIPC()) {
    try {
      const res = await window.electronAPI.idmap.load()
      if (res && res.ok === false) {
        // 主进程已经写过 warn；这里补一条是让「渲染侧视角」也能串上：
        // 主进程的记录里没有调用栈上下文，排查时要能看出是谁在读。
        log.warn('读取 id 映射表失败', { errno: res.errno || '', error: res.error || '' })
        return null
      }
      if (res && res.ok && res.data) return parseIdMap(res.data)
      return null
    } catch (error) {
      log.warn('idmap:load 通道异常，降级到 localStorage', { error: describeError(error) })
    }
  }
  return loadIdMapFromLocal()
}

/**
 * 立即写盘一次。
 *
 * @param {object} map 映射表
 * @returns {Promise<boolean>} 成功返回 true；结构非法 / IO 失败返回 false
 */
export async function saveIdMap (map) {
  if (!isPersistableMap(map)) {
    log.warn('拒绝保存非法的 id 映射表', { reason: 'shape-invalid' })
    return false
  }

  if (hasIdMapIPC()) {
    try {
      const res = await window.electronAPI.idmap.save(map)
      if (res && res.ok) return true
      log.error('保存 id 映射表失败', {
        errno: (res && res.errno) || '',
        error: (res && res.error) || 'unknown'
      })
      return false
    } catch (error) {
      log.error('idmap:save 通道异常', { error: describeError(error) })
      return false
    }
  }
  return saveIdMapToLocal(map)
}

/**
 * 去抖写盘：把高频的映射变更合并成一次真正的 IO。
 *
 * 为什么需要它：`rebindPath` 在移动笔记时会被连续调用（一次「移动」可能同时触发
 * 几十条路径重绑定），每次都 await 一次 IPC + 一次 tmp+rename，既拖慢界面又让
 * SSD 做无用功。合并之后，同一窗口内的 N 次调用只写最后一次的状态 —— 中间态本来
 * 也没人读（读全走内存里的同一个 map 引用）。
 *
 * 返回 true 只表示「已排入队列」而不是「已落盘」；要确认落盘请用 `flushIdMapSave()`。
 *
 * @param {object} map 映射表
 * @returns {boolean} 排入队列返回 true；结构非法返回 false
 */
export function scheduleSaveIdMap (map) {
  if (!isPersistableMap(map)) {
    log.warn('拒绝排入非法的 id 映射表', { reason: 'shape-invalid' })
    return false
  }

  pendingMap = map
  if (saveTimer) return true

  saveTimer = setTimeout(() => {
    saveTimer = null
    const target = pendingMap
    pendingMap = null
    if (!target) return
    // 去抖回调里不允许把 rejection 抛成未处理无知觉：落盘失败已经由 saveIdMap 记账
    Promise.resolve()
      .then(() => saveIdMap(target))
      .catch((error) => log.error('去抖写 id 映射表失败', { error: describeError(error) }))
  }, SAVE_DEBOUNCE_MS)

  // 定时器不该拖住进程退出（Node 自验脚本 / SSR 场景），logBootstrap 同口径
  if (typeof saveTimer.unref === 'function') saveTimer.unref()
  return true
}

/**
 * 取消尚未执行的去抖写（不落盘）。
 *
 * 给测试与「丢弃一次会话」用：前者需要干净地重来，后者例如用户在 flush 前清空了
 * 整个笔记库，继续写出 pending 的那张表反而会把已删路径写回去。
 *
 * @returns {boolean} 有内容被取消返回 true
 */
export function cancelPendingIdMapSave () {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const had = pendingMap !== null
  pendingMap = null
  return had
}

/**
 * 立刻把待写的映射表写掉。
 *
 * 没有待写内容时返回 true（语义是「此刻已是已落盘状态」，而不是「写失败了」）——
 * 退出流程里会有多处 flush 叠加调它，返回 false 会被上层误判成脏状态。
 *
 * @returns {Promise<boolean>} 落盘成功（或无需落盘）返回 true
 */
export function flushIdMapSave () {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const target = pendingMap
  pendingMap = null
  if (!target) return Promise.resolve(true)
  return Promise.resolve()
    .then(() => saveIdMap(target))
    .catch((error) => {
      log.error('flush 写 id 映射表失败', { error: describeError(error) })
      return false
    })
}

/**
 * 挂载「窗口即将关闭就没收最后一次写」的保险。
 *
 * 两个事件都监听是因为它们并不等价：
 *   · `beforeunload` 覆盖「正常关闭 / 刷新」，但**不保证**在移动端 Safari 或某些
 *     被系统回收的场景里触发；
 *   · `pagehide` 是页面被卸载/进入后台时更可靠的兜底，「前进后退缓存」场景下也会来。
 * 重复安装是幂等的（第二次调用直接返回既有卸载函数），不会叠第二个监听器。
 *
 * @returns {Function} 卸载函数；非浏览器环境返回一个空函数，便于无脑调用
 */
export function installIdMapFlush () {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {}
  }
  if (flushHandler) return uninstallIdMapFlush

  flushHandler = () => {
    // pagehide / beforeunload 里不能 await：这里只能「发起」flush，结果由
    // saveIdMap 内部记账（出错会落一条 error）。真正的写入由 IPC 完成，
    // 主进程的 before-quit 握手（app:flush-all）会再兜一次。
    void flushIdMapSave()
  }
  const remove = uninstallIdMapFlush
  window.addEventListener('beforeunload', flushHandler)
  window.addEventListener('pagehide', flushHandler)
  return remove
}

/**
 * 卸载 flush 监听器。幂等：没装过也不会报错。
 *
 * 返回原始 clearner 而不是包一层闭包是有意为之 —— `installIdMapFlush()` 第二次调用
 * 返回同一个引用，多退几次调用方手里的多个引用也不会互相打架（第二次 remove 是空操作）。
 *
 * @returns {void}
 */
function uninstallIdMapFlush () {
  if (flushHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('beforeunload', flushHandler)
    window.removeEventListener('pagehide', flushHandler)
  }
  flushHandler = null
}

/** 去抖窗口长度。导出给单测与文档，避免各处再抄一份 800 */
export const ID_MAP_SAVE_DEBOUNCE_MS = SAVE_DEBOUNCE_MS
