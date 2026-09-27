// ============================================================================
// logBootstrap.js —— 渲染侧日志系统的「接线层」
//
// 位置：T08 交付的是内核（logger.js 只产出 LogEntry、只认 sink），T09 交付的是
// 落盘侧（electron/main.cjs 的 log:append 通道 + 文件轮转）。两侧都就绪，但**中间
// 那根线没人接**：内核默认 sink 是 consoleSink，只往控制台打，主进程的 log:append
// 因此没有任何真实调用方，日志根本落不了盘。本模块就是那根线。
//
// 为什么单独一个文件而不是写进 main.js：
//   1. 接线是有状态的（队列 / 定时器 / 熔断 / 订阅句柄），塞进 main.js 会让入口文件
//      变成一团可变状态，也没法在测试里重置；
//   2. 内核（logger.js）刻意「不知道 window / localStorage / IPC 的存在」，好让同一份
//      实现能跑在主进程里。环境判定必须发生在内核之外 —— 这里就是那个位置。
//
// 四条要接的线（对应交接单）：
//   ① sink → IPC：每条日志经 window.electronAPI.logAppend(entry) 发到主进程落盘；
//   ② LS_LOG_LEVEL 初始化：启动读 localStorage 喂 setLogLevel()，并同步给主进程闸门；
//   ③ onLogCleared → clearRingBuffer()：主进程删了文件，渲染侧缓冲也得清；
//   ④ 退出前 flush：把攒下的批次交出去后再让窗口关闭。
//
// 硬约束：**打日志绝不许让业务崩**（内核性质 1）。本文件里所有对 window /
// localStorage / IPC 的访问都必须能失败且被吞掉 —— 任何一处抛出去，故障就会从
// 「记一条日志」升级成「业务流程中断」，那就比没有日志更糟。
// ============================================================================

import { hasElectronAPI } from './env.js'
import {
  LOG_LEVELS,
  LS_LOG_LEVEL,
  LOG_MODULES
} from '../constants/logging.js'
import {
  consoleSink,
  configureLogger,
  clearRingBuffer,
  setLogLevel,
  getLogLevel,
  createLogger
} from './logger.js'

// ---------------------------------------------------------------------------
// 批量聚合参数
// ---------------------------------------------------------------------------

/**
 * 攒够多少条就立刻发。
 *
 * 为什么是 20 而不是 1：日志在渲染侧是**高频**的（编辑器输入、监听器回调、保存
 * 防抖都能在几十毫秒内打出十几条），逐条 invoke 会让 IPC 通道成为热点 —— 每条
 * 都要过一次结构化克隆 + 事件循环往返，极端时会把渲染线程拖出可感知的卡顿。
 * 而 20 条大约对应一次完整交互的上下文量，攒一批发既能省掉 19 次往返，又不会让
 * 日志在主进程侧「迟到」到人眼能察觉。
 */
const BATCH_SIZE = 20

/**
 * 没攒够时的兜底间隔（ms）。
 *
 * 取 400 而不是 1000：日志的价值高度依赖时效性 —— 崩了之后最后 1 秒发生了什么
 * 才是关键。400ms 足够把突发的一簇日志聚成一批，又保证「用户看到报错」和
 * 「文件里有记录」之间不会差出一次交互的时间。
 */
const FLUSH_INTERVAL_MS = 400

/**
 * 队列上限，超出丢最老的。
 *
 * 这是**安全阀**而不是常态：IPC 正常时队列几乎永远是空的。它防的是「主进程日志
 * 通道卡住（磁盘满 / 通道异常）→ 渲染侧无上限堆积 → 内存被日志吃光」这种把记录
 * 机制本身变成故障源的场面。丢**最老**的而不是最新的：排查时最新的几条才是有用的
 * （崩溃现场），而最老的通常已经在别处看过一遍了。
 */
const QUEUE_MAX = 200

/**
 * 连续失败多少次后熔断。
 *
 * 为什么必须熔断：不做的话，每条新日志都会再触发一次失败的 IPC，而失败本身又会
 * 打出一条 warn（warn 又要走一遍 IPC）—— 日志系统的故障会自我放大，把本来只是
 * 「落不了盘」的小病变成拖垮渲染线程的急病。熔断后彻底退回内存缓冲，只在第一次
 * 和熔断时各记一条，之后保持安静。
 */
const FAIL_LIMIT = 3

/** 本文件自身的诊断出口。用 ipc 模块名：它记的都是「日志通道」这一类问题 */
const selfLog = createLogger(LOG_MODULES.ipc)

// ---------------------------------------------------------------------------
// 模块级状态（initLogging 幂等：重复调用会先拆掉旧接线）
// ---------------------------------------------------------------------------

/** @type {object|null} 当前生效的接线状态；null 表示未初始化 */
let state = null

/**
 * 读取 Vite 的开发态标记。
 *
 * 走 `import.meta.env` 必须包在 try 里：本模块要能被**纯 Node**直接加载做自验，
 * 而 Node 下 `import.meta.env` 是 undefined（不是报错，但要能安全读）。
 * @returns {boolean}
 */
function isDevBuild () {
  try {
    const meta = typeof import.meta === 'undefined' ? null : import.meta
    return !!(meta && meta.env && meta.env.DEV)
  } catch {
    return false
  }
}

/**
 * 取 electronAPI。
 *
 * 优先级：显式注入（测试用）> 运行时探测（hasElectronAPI）。
 * 刻意用 `hasElectronAPI()` 而不是模块级常量 `IS_ELECTRON`：后者在 import 时求值
 * 一次，测试里注入 window 之后就再也改不动了；而本模块要在「有 / 无 electronAPI」
 * 两种环境下都被验证。
 * @param {object} opts
 * @returns {object|null}
 */
function resolveApi (opts) {
  if (opts && 'electronAPI' in opts) {
    const injected = opts.electronAPI
    return injected && typeof injected === 'object' ? injected : null
  }
  return hasElectronAPI() ? window.electronAPI : null
}

/**
 * 级别是否合法（含 silent 闸门）。
 * @param {string} level
 * @returns {boolean}
 */
function isKnownLevel (level) {
  return typeof level === 'string' &&
    Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)
}

// ---------------------------------------------------------------------------
// localStorage：级别的持久化
// ---------------------------------------------------------------------------

/**
 * 读持久化的级别。
 *
 * 三重防御：localStorage 不存在（主进程 / Node）、被禁用（隐私模式下 getItem 会
 * 直接抛 SecurityError）、值被手改成脏数据 —— 任何一种都退回空串，由调用方用默认
 * 级别，绝不让「读配置」变成启动路上的一颗雷。
 * @returns {string} 已 trim + 小写的原始值；无效时 ''
 */
function readStoredLevel () {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return ''
    const raw = localStorage.getItem(LS_LOG_LEVEL)
    if (typeof raw !== 'string') return ''
    return raw.trim().toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 写持久化的级别。
 * @param {string} level 必须已通过 isKnownLevel
 * @returns {boolean} 是否写入成功
 */
function writeStoredLevel (level) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false
    localStorage.setItem(LS_LOG_LEVEL, level)
    return true
  } catch {
    // 配额满 / 隐私模式：持久化失败不该影响本次会话的级别生效
    return false
  }
}

// ---------------------------------------------------------------------------
// 队列与批量发送
// ---------------------------------------------------------------------------

/** 把一条 entry 放进队列，并按阈值决定何时发车 @param {object} s @param {object} entry */
function enqueue (s, entry) {
  try {
    s.queue.push(entry)
    if (s.queue.length > QUEUE_MAX) {
      const overflow = s.queue.length - QUEUE_MAX
      s.queue.splice(0, overflow)
      s.dropped += overflow
    }
  } catch {
    return // 连数组都推不进去（极端内存场景）时，这条日志就当没发生
  }

  // 攒够就立刻发；没攒够也保证有个兜底定时器，避免「最后一条永远等不到下一批」
  scheduleFlush(s, s.queue.length >= BATCH_SIZE ? 0 : FLUSH_INTERVAL_MS)
}

/**
 * 安排一次 flush。
 *
 * `delay === 0` 表示「加速」：会把已有的慢定时器取消掉重排，让已经攒够的批次不必
 * 再等满 400ms。慢定时器已存在时不重复创建 —— 否则高频日志会造出一堆定时器。
 * @param {object} s
 * @param {number} delay
 * @returns {void}
 */
function scheduleFlush (s, delay) {
  if (delay <= 0) {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer)
      s.flushTimer = null
    }
  } else if (s.flushTimer) {
    return
  }

  if (typeof setTimeout !== 'function') {
    flushQueue(s)
    return
  }
  s.flushTimer = setTimeout(() => {
    s.flushTimer = null
    flushQueue(s)
  }, delay)
  // 定时器不该拖住进程退出（Node 自验脚本 / SSR 场景）
  if (s.flushTimer && typeof s.flushTimer.unref === 'function') s.flushTimer.unref()
}

/** 取消待发的定时器 @param {object} s */
function stopTimer (s) {
  if (s.flushTimer) {
    clearTimeout(s.flushTimer)
    s.flushTimer = null
  }
}

/**
 * 把当前队列整批交出去。
 *
 * **串行化**是这里的关键：发送走的是 `sendChain` 而不是裸 `Promise.resolve()`，
 * 后续批次会排在上一个批次之后。若并发发两个批次，IPC 的到达顺序就不保证了，
 * main.log 里会出现「后面的日志排在前面」，而日志一旦乱序就失去了按时间线排查的
 * 意义。
 * @param {object} s
 * @returns {Promise<void>}
 */
function flushQueue (s) {
  if (s.disabled || !s.api) return Promise.resolve()
  if (!s.queue.length) return Promise.resolve()

  const batch = s.queue.slice()
  s.queue.length = 0
  s.sendChain = s.sendChain
    .then(() => sendBatch(s, batch))
    .catch(() => {})
    .then(() => {
      // 发送期间新进来的条目（以及失败批次之后补进来的）不能没人管：不清这个尾巴，
      // 它们会一直躺在队列里，直到下一次凑够阈值或又有一条新日志进来才被带走 ——
      // 表现为「最后几条日志莫名其妙晚了好几秒才落到文件里」。
      if (!s.disabled && s.api && s.queue.length) {
        scheduleFlush(s, FLUSH_INTERVAL_MS)
      }
    })
  return s.sendChain
}

/**
 * 发一批。
 * @param {object} s
 * @param {Array<object>} batch
 * @returns {Promise<void>}
 */
async function sendBatch (s, batch) {
  if (!s.api || typeof s.api.logAppend !== 'function') {
    disableTransport(s, 'api-missing')
    return
  }
  try {
    // 始终传数组：主进程 `log:append` 对单条与数组都支持，统一成数组能少一个分支，
    // 也让「这一批有多少条」在通道两侧口径一致。
    const res = await s.api.logAppend(batch)
    if (res && res.ok === false) {
      noteFailure(s, 'ipc-returned-not-ok')
      return
    }
    s.failures = 0
  } catch (error) {
    noteFailure(s, (error && error.message) || 'ipc-threw')
  }
}

/**
 * 记一次失败，并在达到阈值时熔断。
 * @param {object} s
 * @param {string} reason
 * @returns {void}
 */
function noteFailure (s, reason) {
  s.failures += 1
  // 只在**第一次**失败时报：后续每次都报的话，一次通道故障会刷出成百上千条
  // 「日志写不进去」的日志，把真正有价值的证据淹没掉。
  if (s.failures === 1) {
    selfLog.warn('日志落盘失败，将重试', { reason })
  }
  if (s.failures >= FAIL_LIMIT) disableTransport(s, reason)
}

/**
 * 熔断：彻底退回内存缓冲。
 * @param {object} s
 * @param {string} reason
 * @returns {void}
 */
function disableTransport (s, reason) {
  if (s.disabled) return
  s.disabled = true
  s.queue.length = 0
  stopTimer(s)
  selfLog.warn('日志落盘通道不可用，已降级为仅内存缓冲', {
    reason,
    dropped: s.dropped
  })
}

// ---------------------------------------------------------------------------
// sink
// ---------------------------------------------------------------------------

/**
 * 造出真正挂到内核上的 sink。
 *
 * 控制台镜像的策略：
 *   · 无 electronAPI（纯浏览器 / 预览 / 单测）：**必须**打控制台 —— 此时环形缓冲
 *     是唯一留存，而缓冲只能被设置页看到，开发者在 devtools 里什么都看不见，
 *     等于日志系统整条链断了。所以降级形态就是「环形缓冲 + dev 控制台」。
 *   · Electron 生产：不打 —— 全量已经在 main.log 里，再往控制台灌一份纯属噪音。
 *   · Electron 开发：保留 —— 与迁移前的 console.* 观感一致，不剥夺开发者的习惯。
 * @param {object} s
 * @returns {(entry: object, line: string) => void}
 */
function makeSink (s) {
  return function bootstrapSink (entry, line) {
    if (s.mirrorConsole) consoleSink(entry, line)
    // 没有通道时连队列都不进：降级模式下队列永远发不出去，让它涨到 QUEUE_MAX 再
    // 开始丢条目，只是白白占内存并污染 dropped 计数。
    if (s.disabled || !s.api) return
    enqueue(s, entry)
  }
}

// ---------------------------------------------------------------------------
// 四条线
// ---------------------------------------------------------------------------

/**
 * 线②：级别初始化。
 *
 * 两件事缺一不可：
 *   1. 喂给渲染侧内核（setLogLevel）—— 否则重启后级别永远回默认 info；
 *   2. **同步给主进程闸门**（logSetLevel）—— 主进程的 normalizeIncomingEntry 也会
 *      按级别过滤。只做 1 不做 2 的后果很隐蔽：用户设了 debug，渲染侧照常发出，
 *      主进程却按自己默认的 info 全部丢弃，表现为「设置页显示 debug，文件里一条
 *      debug 都没有」。
 *
 * 顺序问题：logSetLevel 是异步 IPC，而日志会立刻开始产生。这里把它**排进
 * sendChain 队首**，利用已有的串行化保证「级别先到、日志后到」，消除了这个竞态。
 * @param {object} s
 * @returns {string} 生效的级别
 */
function initLevel (s) {
  const stored = readStoredLevel()
  if (isKnownLevel(stored)) setLogLevel(stored)
  const effective = getLogLevel()

  if (s.api && typeof s.api.logSetLevel === 'function') {
    s.sendChain = s.sendChain
      .then(async () => {
        const res = await s.api.logSetLevel(effective)
        s.mainLevelSynced = !!(res && res.ok !== false)
        if (!s.mainLevelSynced) {
          selfLog.warn('主进程日志级别未同步，主侧可能丢弃本进程记录', { level: effective })
        }
      })
      .catch(error => {
        s.mainLevelSynced = false
        selfLog.warn('同步主进程日志级别失败', { error: (error && error.message) || 'unknown' })
      })
  }
  return effective
}

/**
 * 线③：主进程清空文件 → 清渲染侧环形缓冲。
 *
 * 连待发队列一起清：队列里的条目尚未落盘，而用户刚点了「清空日志」，再补写进去
 * 就是「清完又冒出来几条」，属于那种用户一定会当成 bug 反馈的行为。
 * @param {object} s
 * @returns {Function|null} 退订函数
 */
function wireLogCleared (s) {
  if (!s.api || typeof s.api.onLogCleared !== 'function') return null
  try {
    return s.api.onLogCleared(() => {
      clearRingBuffer()
      s.queue.length = 0
    })
  } catch {
    return null
  }
}

/**
 * 线④：退出前 flush。
 *
 * **刻意不调用 notifyFlushComplete**：那是 App.vue 的 setupFlushHandshake 的职责。
 * ipcRenderer.on 支持多个监听者，这里追加一个即可，两边互不干扰；若这里也回报
 * 一次，主进程的 before-quit 会被提前放行（第一个回执就 resolve），App.vue 那边
 * 还没 flush 完窗口就被关掉 —— 正是「丢掉最后一段编辑」的那个老问题。
 *
 * 同理这里不 await：主进程最长等 3 秒，而 App.vue 的处理器还在 await 自己那串
 * 落盘操作，本批次的 invoke 早已在这段时间内发出。
 * @param {object} s
 * @returns {Function|null} 退订函数
 */
function wireFlushHandshake (s) {
  if (!s.api || typeof s.api.onAppFlush !== 'function') return null
  try {
    return s.api.onAppFlush(() => {
      flushQueue(s)
    })
  } catch {
    return null
  }
}

/**
 * 运行时改级别（供设置页调用，补齐「log:set-level 不持久化」的缺口）。
 *
 * 内核的 setLogLevel 只管内存，主进程的 log:set-level 也只管主进程 —— 持久化这一
 * 环谁都不管，重启就回到默认。这里把它合三为一：内存 + localStorage + 主进程。
 * @param {object} s
 * @param {string} level
 * @param {{ persist?: boolean }} [opts]
 * @returns {string} 实际生效的级别（非法入参时返回原值）
 */
function applyLevel (s, level, opts = {}) {
  const next = setLogLevel(level)
  // 内核对非法值返回当前值：此时既不该持久化也不该同步，直接原样返回
  if (next !== level) return next

  if (opts.persist !== false) writeStoredLevel(next)
  if (s.api && typeof s.api.logSetLevel === 'function') {
    Promise.resolve()
      .then(() => s.api.logSetLevel(next))
      .catch(() => {})
  }
  return next
}

/** 拆掉全部接线，恢复内核默认出口 @param {object} s */
function disposeState (s) {
  stopTimer(s)
  // 尽力把残余交出去（dispose 通常发生在页面卸载 / 测试收尾）
  try {
    flushQueue(s)
  } catch {
    /* 退出路径上不能再抛 */
  }
  if (typeof s.unsubscribeCleared === 'function') {
    try { s.unsubscribeCleared() } catch { /* 退订失败无需处理 */ }
  }
  if (typeof s.unsubscribeFlush === 'function') {
    try { s.unsubscribeFlush() } catch { /* 退订失败无需处理 */ }
  }
  s.unsubscribeCleared = null
  s.unsubscribeFlush = null
  try {
    configureLogger({ sink: consoleSink })
  } catch {
    /* 内核故障不影响拆卸完成 */
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 接通渲染侧日志系统。**应当在 createApp 之前调用**（见 src/main.js）。
 *
 * 幂等：重复调用会先拆掉上一次的接线再重新接，避免 HMR / 多次引导留下多个
 * IPC 监听者与多个互相打架的 sink。
 *
 * @param {object} [options]
 * @param {object|null} [options.electronAPI] 显式注入 API（测试用）；
 *        不传则走 hasElectronAPI() 探测。传 null 等价于强制降级。
 * @param {boolean} [options.mirrorConsole] 强制是否镜像到控制台；
 *        不传时按「无 API 必镜像 / Electron 仅 dev 镜像」的自动策略。
 * @returns {{
 *   mode: 'ipc'|'memory',
 *   level: string,
 *   flush: () => Promise<void>,
 *   setLevel: (level: string, opts?: {persist?: boolean}) => string,
 *   stats: () => {queued: number, dropped: number, failures: number, disabled: boolean},
 *   dispose: () => void
 * }}
 */
export function initLogging (options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  // 幂等：先拆旧的，保证不会同时存在两套 sink / 两组监听
  if (state) disposeState(state)

  const api = resolveApi(opts)
  const s = {
    api,
    mode: api ? 'ipc' : 'memory',
    queue: [],
    sendChain: Promise.resolve(),
    flushTimer: null,
    failures: 0,
    dropped: 0,
    disabled: false,
    mainLevelSynced: false,
    unsubscribeCleared: null,
    unsubscribeFlush: null,
    mirrorConsole: typeof opts.mirrorConsole === 'boolean'
      ? opts.mirrorConsole
      : (!api || isDevBuild())
  }
  state = s

  // 线①：把 sink 挂到内核上。这一句就是「日志终于能落盘」的开关。
  try {
    configureLogger({ sink: makeSink(s) })
  } catch {
    // 挂不上的话内核仍是 consoleSink —— 降级但不影响应用启动
  }

  const level = initLevel(s)
  s.unsubscribeCleared = wireLogCleared(s)
  s.unsubscribeFlush = wireFlushHandshake(s)

  return {
    mode: s.mode,
    level,
    /** 手动 flush（退出前 / 导出前 / 测试里断言前用它把队列逼出来） */
    flush: () => flushQueue(s),
    setLevel: (next, o) => applyLevel(s, next, o),
    stats: () => ({
      queued: s.queue.length,
      dropped: s.dropped,
      failures: s.failures,
      disabled: s.disabled
    }),
    dispose: () => {
      if (state === s) disposeState(s)
      if (state === s) state = null
    }
  }
}

/**
 * 取当前接线句柄的只读状态（未初始化时返回 null）。
 * 给设置页 / 测试用来判断「现在是落盘模式还是仅内存模式」。
 * @returns {object|null}
 */
export function getLogTransportState () {
  if (!state) return null
  return {
    mode: state.mode,
    disabled: state.disabled,
    queued: state.queue.length,
    dropped: state.dropped,
    failures: state.failures,
    mainLevelSynced: state.mainLevelSynced
  }
}

/**
 * 拆掉接线并恢复内核默认出口。测试收尾与 HMR 卸载用；
 * 应用正常退出时不必调用（窗口关闭即释放）。
 * @returns {void}
 */
export function resetLogBootstrap () {
  if (!state) return
  disposeState(state)
  state = null
}
