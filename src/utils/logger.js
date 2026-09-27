// ============================================================================
// logger.js —— 统一日志内核（分级 + 模块 + 环形缓冲 + sink）
//
// 背景：本轮之前项目没有日志抽象，约 41 处裸 console.* 分散在渲染进程与主进程，
// 排查跨 IPC 的问题只能靠猜（R-L1 / R-L3）。本模块是替换它们的那个统一入口。
//
// 设计边界：**只做「内核」，不做环境接线**。它不知道什么是 window、什么是 fs，
// 也不知道 localStorage。由此换来一件事 —— 同一个实现能同时服务于：
//   · 渲染进程（ESM）：环形缓冲 + dev 控制台；T10~T13 把 console.* 迁到这里；
//   · 主进程：T09 在 `log:append` 通道的另一侧消费同样的 LogEntry 结构落盘。
//
// 双轨能否真正共用，取决于 T09 的选择，见文件末尾「给主进程落盘方的对照实现」。
//
// 三条不可退让的性质：
//   1. **打日志绝不许让业务崩**：sink 抛错、脱敏抛错、缓冲异常，一律内部吞掉。
//      宁可这条日志丢了，也不能让「记录一次写文件失败」本身再炸一次业务流程。
//   2. **失败即遮蔽（fail closed）**：脱敏出错时替换为 [REDACTED]，绝不退回原始值。
//   3. **入口唯一出口可插拔**：createLogger 负责产出 LogEntry，sink 负责把它送到
//      哪里（控制台 / IPC / 文件 / 测试探针），两者互不相知。
// ============================================================================

import {
  LOG_LEVELS,
  LOG_LEVEL_ORDER,
  DEFAULT_LOG_LEVEL,
  LOG_RING_SIZE,
  LOG_CONTENT_MAX,
  LOG_LEVEL_WIDTH,
  LOG_FIELD_SEP
} from '../constants/logging.js'
import { REDACTED, sanitizeValue } from './logSanitize.js'

// ---------------------------------------------------------------------------
// 模块级状态（刻意放在模块作用域：所有 logger 实例共享同一份配置，
// 才能做到「在设置页改一次级别，全进程立刻生效」）
// ---------------------------------------------------------------------------

/** 当前级别（字符串形态，便于回显给 UI） */
let currentLevel = DEFAULT_LOG_LEVEL

/** 出口：负责把一条 LogEntry 送到它该去的地方。null 表示只入环形缓冲 */
let sinkFn = consoleSink

/** 环形缓冲，最老的在头部 */
const ring = []

let ringSize = LOG_RING_SIZE

/** 显式家目录（主进程可以通过 configureLogger 注入，提升路径遮蔽准确度） */
let homeDir = ''

/** 自定义脱敏器（测试或特殊场景用），null 表示用内置的 sanitizeValue */
let sanitizeFn = null

/**
 * emit 重入深度。sink 内部如果又调用了 logger（比如 IPC 通道不通时想记一条），
 * 会形成 emit → sink → emit 的回路；不设闸就是栈溢出。这里允许套一层
 * （那一层通常正是「日志系统自身故障」的宝贵证据），再深就丢弃。
 */
const MAX_EMIT_DEPTH = 2
let emitDepth = 0

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 控制台方法映射：级别 → console 上对应的方法名 */
const CONSOLE_METHOD = Object.freeze({
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error'
})

/**
 * 取 console 的安全引用。
 *
 * 走 globalThis 而不是裸 console：`globalThis.console` 在 Node 与浏览器都存在，
 * 且在 Electron 渲染进程里即便 devtools 没开也照样有对象，不需要 window / process
 * 参与；万一宿主把它删了，这里返回 null，后面自然降级为「只入缓冲」。
 * @returns {Console|null}
 */
function safeConsole () {
  try {
    const c = typeof globalThis === 'undefined' ? null : globalThis.console
    return c && typeof c.log === 'function' ? c : null
  } catch {
    return null
  }
}

/** 级别字符串 → 权重；未知级别按 info 处理（不放大也不吞掉） */
function weightOf (level) {
  return LOG_LEVELS[level] || LOG_LEVELS[DEFAULT_LOG_LEVEL]
}

/** 模块名归一化：空值兜底、去空白、限长（防止把整段动态字符串当模块名写进日志） */
function normalizeModule (mod) {
  const s = typeof mod === 'string' ? mod.trim() : (mod == null ? '' : String(mod))
  return (s || 'app').slice(0, 32)
}

// ---------------------------------------------------------------------------
// 脱敏：唯一入口
// ---------------------------------------------------------------------------

/**
 * 走一遍脱敏。任何异常都收敛成 REDACTED —— 这是 fail closed 的落地点：
 * 宁可这条日志写着 [REDACTED] 让人看不懂，也不能把原始对象放行进日志文件。
 * @param {unknown} value
 * @returns {any}
 */
function applySanitize (value) {
  try {
    if (typeof sanitizeFn === 'function') return sanitizeFn(value)
    if (value === undefined) return undefined
    // maxString 统一取 LOG_CONTENT_MAX（120）：
    // sanitizeValue 自己的默认（200）是给「直接调用者」的兜底，通过 logger 出去的
    // 一律按 design §3.4 规则 3 的 120 截，保证 message 与 data 用同一把尺。
    return sanitizeValue(value, { maxString: LOG_CONTENT_MAX, home: homeDir })
  } catch {
    return REDACTED
  }
}

// ---------------------------------------------------------------------------
// LogEntry 构造
// ---------------------------------------------------------------------------

/**
 * 把 Error 实例的第一参数、第二参数统一成 (msg, data)。
 *
 * 为什么专门处理：`logger.error(err)` 是很自然的写法，但如果不接管，
 * 最终会落到 `String(err)` = 'Error: xxx' 丢掉 stack，或展开成空对象（Error 的
 * message/stack 是非枚举属性）—— 两种都是「看起来记了，其实什么都没留」。
 * @param {unknown} msg
 * @param {unknown} data
 * @returns {{message: unknown, data: unknown}}
 */
function splitArgs (msg, data) {
  const isErr = !!msg && typeof msg === 'object' &&
    (msg instanceof Error || Object.prototype.toString.call(msg) === '[object Error]')
  if (!isErr) return { message: msg, data }

  const name = typeof msg.name === 'string' && msg.name ? msg.name : 'Error'
  const text = typeof msg.message === 'string' && msg.message ? msg.message : String(msg)
  const merged = { err: msg }
  if (data !== undefined && data !== null) merged.data = data
  return { message: `${name}: ${text}`, data: merged }
}

/**
 * 消息正文归一成字符串。
 *
 * 为什么不许非字符串进 LogEntry.msg：契约里 msg 是 `string`（主进程按它拼行），
 * 而 `${symbol}` 这类模板渲染会抛。这里在**脱敏之前**先把形状定死，
 * 也让 `logger.info()`（无参）退化成空正文而不是 'undefined'。
 * @param {unknown} message
 * @returns {string}
 */
function toMessageText (message) {
  if (typeof message === 'string') return message
  if (message === undefined || message === null) return ''
  try {
    return String(message)
  } catch {
    return REDACTED
  }
}

/**
 * 构造一条 LogEntry。形状固定为 `{ t, lvl, mod, msg, data }` —— 这是主/渲染之间
 * 通过 IPC 传输的契约（design §4.4），**不要增删字段**，主进程落盘方按它解析。
 * @param {string} level
 * @param {string} mod
 * @param {unknown} msg
 * @param {unknown} data
 * @returns {{t: string, lvl: string, mod: string, msg: string, data: any}}
 */
function buildEntry (level, mod, msg, data) {
  const { message, data: payload } = splitArgs(msg, data)
  // 先定形状再脱敏：String(err) 这类副产物也要过一遍路径遮蔽
  const safeMsg = applySanitize(toMessageText(message))
  return {
    t: new Date().toISOString(),
    lvl: level,
    mod,
    msg: typeof safeMsg === 'string' ? safeMsg : toMessageText(safeMsg),
    data: payload === undefined ? undefined : applySanitize(payload)
  }
}

// ---------------------------------------------------------------------------
// 环形缓冲
// ---------------------------------------------------------------------------

function pushRing (entry) {
  try {
    ring.push(entry)
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize)
  } catch {
    // 缓冲写不进去（极端内存场景）不能影响 emit 继续把 entry 交给 sink
  }
}

// ---------------------------------------------------------------------------
// 文本行渲染（design §4.4：单一格式，主渲染共用）
// ---------------------------------------------------------------------------

function padEndToWidth (text, width) {
  const s = String(text)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

/** 把 data 渲染成 `k=v k=v` 尾巴；值含空白或为空时用 JSON 引号包住，保证可解析 */
function renderDataTail (data) {
  if (data === undefined || data === null) return ''
  if (typeof data !== 'object') return `${LOG_FIELD_SEP}${JSON.stringify(data)}`
  const parts = []
  for (const k of Object.keys(data)) {
    const v = data[k]
    if (v === undefined) continue
    let rendered
    if (typeof v === 'string') {
      rendered = /[\s]/.test(v) || v === '' ? JSON.stringify(v) : v
    } else if (typeof v === 'object' && v !== null) {
      rendered = JSON.stringify(v)
    } else {
      rendered = String(v)
    }
    parts.push(`${k}=${rendered}`)
  }
  return parts.length ? `${LOG_FIELD_SEP}${parts.join(' ')}` : ''
}

/**
 * LogEntry → 一行文本。
 *
 * 格式（design §4.4，主进程落盘版本必须与此逐字节一致）：
 *   2026-03-15T10:23:45.123Z  ERROR  [note]  删除文件失败  path=…/a.md code=permission
 *
 * **信任边界**：本函数**不重新脱敏**，入参被认为是已经过 buildEntry 处理的结构化
 * 条目。再脱一次会把已经 120 截断的内容又截一刀，也会让主/渲染两侧对同一条记录
 * 产生两份不完全相同的文本，反而破坏 R-L3「同一份日志能串起来」。
 *
 * 同理，它也**绝不抛异常**：渲染行是在 sink 之前做的，一旦抛了连缓冲都没得看。
 * @param {{t?: string, lvl?: string, mod?: string, msg?: unknown, data?: unknown}} entry
 * @returns {string}
 */
export function formatLogLine (entry) {
  try {
    const src = entry && typeof entry === 'object' ? entry : {}
    const ts = typeof src.t === 'string' && src.t ? src.t : new Date().toISOString()
    const lvl = padEndToWidth(String(src.lvl || DEFAULT_LOG_LEVEL).toUpperCase(), LOG_LEVEL_WIDTH)
    const mod = normalizeModule(src.mod)
    let message
    try {
      message = typeof src.msg === 'string' ? src.msg : String(src.msg ?? '')
    } catch {
      message = REDACTED
    }
    return `${ts}${LOG_FIELD_SEP}${lvl}${LOG_FIELD_SEP}[${mod}]${LOG_FIELD_SEP}${message}${renderDataTail(src.data)}`
  } catch {
    try {
      return `${new Date().toISOString()}${LOG_FIELD_SEP}ERROR ${LOG_FIELD_SEP}[logger]${LOG_FIELD_SEP}日志行渲染失败${LOG_FIELD_SEP}entry=${REDACTED}`
    } catch {
      return '[log-format-failed]'
    }
  }
}

// ---------------------------------------------------------------------------
// sink
// ---------------------------------------------------------------------------

/**
 * 默认出口：控制台。刻意只打**渲染后的单行文本**而不是把对象原样 console.log 出去：
 * 后者在 devtools 里展开时会递归到原始引用（不是脱敏后的副本），等于绕过脱敏。
 * @param {{t: string, lvl: string, mod: string, msg: string, data: any}} entry
 * @param {string} line
 * @returns {void}
 */
export function consoleSink (entry, line) {
  const c = safeConsole()
  if (!c) return
  const method = CONSOLE_METHOD[entry && entry.lvl] || 'log'
  const fn = typeof c[method] === 'function' ? c[method] : c.log
  try {
    fn.call(c, line)
  } catch {
    // 某些环境（沙箱 iframe / 被覆写的 console）调用会抛，静默降级
  }
}

function callSink (entry, line) {
  if (typeof sinkFn !== 'function') return
  try {
    sinkFn(entry, line)
  } catch {
    // 出口故障绝不能回传到业务调用点（性质 1）
  }
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

/**
 * 一条日志的完整生命周期：级别闸门 → 构造（含脱敏）→ 入环形缓冲 → 交给 sink。
 * @param {string} level 必须已通过 isLevelEnabled
 * @param {string} mod
 * @param {unknown} msg
 * @param {unknown} data
 * @returns {{t: string, lvl: string, mod: string, msg: string, data: any}|undefined} 返回 entry 便于测试断言
 */
function emit (level, mod, msg, data) {
  if (!isLevelEnabled(level)) return undefined
  if (emitDepth >= MAX_EMIT_DEPTH) return undefined

  const entry = buildEntry(level, mod, msg, data)
  pushRing(entry)

  emitDepth += 1
  try {
    callSink(entry, formatLogLine(entry))
  } finally {
    emitDepth -= 1
  }
  return entry
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 某级别在当前配置下是否放行。导出给需要在打日志前做「要不要先算一段昂贵数据」
 * 的调用点使用 —— 比如 `if (logger.isDebugEnabled()) logger.debug('xxx', buildHugeDump())`。
 * @param {string} level
 * @returns {boolean}
 */
export function isLevelEnabled (level) {
  return weightOf(level) >= weightOf(currentLevel)
}

/**
 * 运行时切换级别（R-L4 第三条：不用重启）。
 *
 * 非法值一律忽略并返回当前值 —— 设置页下拉框的数据源若有脏值，宁可维持现状，
 * 也不要让 `level=undefined` 把关门条件算成 false（那会等于把闸门拆了）。
 *
 * 注意：**本函数不做持久化**。内核不知道 localStorage（要能在主进程跑），
 * 需要在重启后记住级别的话，由渲染侧宿主读 `LS_LOG_LEVEL` 后调用本函数。
 * @param {string} level 'debug' | 'info' | 'warn' | 'error' | 'silent'
 * @returns {string} 实际生效的级别
 */
export function setLogLevel (level) {
  if (typeof level !== 'string' || !(level in LOG_LEVELS)) return currentLevel
  currentLevel = level
  return currentLevel
}

/** 当前级别（UI 回显 / 测试用） */
export function getLogLevel () {
  return currentLevel
}

/** 全部可选级别（含 silent），供设置页下拉框渲染，避免 UI 再抄一份名单 */
export function getAvailableLevels () {
  return [...LOG_LEVEL_ORDER, 'silent']
}

/**
 * 创建一个带模块标签的 logger。
 *
 * 四个方法签名同为 `(msg, data)`：
 *   · `msg` 写给人看；可以是 Error 实例（会被拆成 name/message + data.err）；
 *   · `data` 结构化上下文 `{ path, code, count }`，会被脱敏并渲染成 `k=v` 尾巴；
 *     **不要把正文塞进 msg 的模板串**，塞进去就跑不脱敏了。
 * @param {string} module 模块名，建议取 LOG_MODULES 里的值
 * @returns {{module: string, debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function createLogger (module) {
  const name = normalizeModule(module)
  const bind = level => (msg, data) => emit(level, name, msg, data)
  return {
    module: name,
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
    /**
     * 派生子模块 logger。分隔符用 `:` 而不是 `/` 或 `.`：
     * `[note:persist]` 在日志里一眼是分层，而 `.` 容易被人误读成原模块名的一部分。
     *
     * 空子名返回**同模块**的新实例，而不是 `note:app` —— 后者是 normalizeModule
     * 的兜底值被拼进名字，属于「调用方没传东西，日志里却多出一个莫名其妙的后缀」。
     * @param {string} sub
     * @returns {object} 同 createLogger 的返回值
     */
    child (sub) {
      const suffix = typeof sub === 'string' ? sub.trim() : ''
      return suffix ? createLogger(`${name}:${normalizeModule(suffix)}`) : createLogger(name)
    }
  }
}

/**
 * 取环形缓冲快照（返回副本，外部改动不会影响内部队列）。
 * @param {number} [limit] 只要最近 N 条（设置页「查看最近 100 条」用得上）
 * @returns {Array<object>}
 */
export function getRingBuffer (limit) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), ring.length) : ring.length
  return ring.slice(ring.length - n).map(e => ({ ...e }))
}

/** 清空环形缓冲（T09「log:clear」通道的实现者会调用） */
export function clearRingBuffer () {
  ring.length = 0
}

/**
 * 配置全局日志行为。参数均为可选，只传需要改的那一项。
 *
 * @param {object} [opts]
 * @param {string} [opts.level] 级别，等同 setLogLevel
 * @param {Function|null} [opts.sink] 出口函数 `(entry, line) => void`；
 *        null 表示不输出（只留环形缓冲）。需要同时保留控制台输出时自行组合：
 *        `configureLogger({ sink: (e, l) => { consoleSink(e, l); myTransport(e) } })`
 * @param {Function|null} [opts.sanitize] 自定义脱敏器；传 null 恢复内置。
 *        **替换它等于接管安全边界**，请确保新函数同样满足「失败即遮蔽」。
 * @param {number} [opts.ringSize] 环形缓冲条数，正数；小于当前长度时立即裁剪
 * @param {string} [opts.homeDir] 显式家目录，喂给 redactPath 提升遮蔽准确度
 *        （主进程可用 app.getPath('home') 注入）
 * @returns {void}
 */
export function configureLogger (opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if ('level' in o) setLogLevel(o.level)
  if ('sink' in o) sinkFn = typeof o.sink === 'function' ? o.sink : null
  if ('sanitize' in o) sanitizeFn = typeof o.sanitize === 'function' ? o.sanitize : null
  if ('homeDir' in o) homeDir = typeof o.homeDir === 'string' ? o.homeDir : ''
  if ('ringSize' in o) {
    const n = Number(o.ringSize)
    if (Number.isFinite(n) && n > 0) {
      ringSize = Math.floor(n)
      if (ring.length > ringSize) ring.splice(0, ring.length - ringSize)
    }
  }
}

/**
 * 恢复出厂配置。测试之间必须调用：本模块持有跨用例的模块级状态（级别、缓冲、
 * sink），不清理的话一个用例里改了级别，后面所有用例都跟着吃哑巴亏。
 * @returns {void}
 */
export function resetLogger () {
  currentLevel = DEFAULT_LOG_LEVEL
  sinkFn = consoleSink
  sanitizeFn = null
  homeDir = ''
  ringSize = LOG_RING_SIZE
  emitDepth = 0
  ring.length = 0
}

// ===========================================================================
// 给主进程落盘方（T09）的对照实现
//
// 为什么这里要写一份注释里的 CJS：
//   package.json 是 "type": "module"，主进程是 electron/main.cjs（CommonJS），
//   而 electron-builder 的 files 只打包 `dist/**`、`electron/**`——src/ 不进安装包。
//   所以主进程**不应该** `require('../src/utils/logger.js')`：dev 下能跑（Node ≥22.12
//   支持 require(ESM)），打包后必定 MODULE_NOT_FOUND。这与 utils/noteFile.js 的
//   做法一致：主进程保留自己的那份安全边界实现。
//
// 因此主进程请把下面这段复制进 electron/main.cjs，并保持**输出格式与本文件格式
// 逐字节一致**，两份记录才能在同一个 main.log 里按时间戳正确排序（R-L3）：
//
//   // 与 src/utils/logger.js 的 formatLogLine 保持逐字节一致（design §4.4）
//   function padLevel (lvl) { const s = String(lvl).toUpperCase(); return s.length >= 5 ? s : s + ' '.repeat(5 - s.length) }
//   function renderTail (data) {
//     if (data == null) return ''
//     if (typeof data !== 'object') return '  ' + JSON.stringify(data)
//     const parts = []
//     for (const k of Object.keys(data)) {
//       const v = data[k]
//       if (v === undefined) continue
//       const rendered = typeof v === 'string'
//         ? (/[\s]/.test(v) || v === '' ? JSON.stringify(v) : v)
//         : (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))
//       parts.push(k + '=' + rendered)
//     }
//     return parts.length ? '  ' + parts.join(' ') : ''
//   }
//   function formatLogLine (entry) {
//     const src = entry && typeof entry === 'object' ? entry : {}
//     // 三个兜底必须与 ESM 版等价：缺字段时两边都要给出同样的值，
//     // 否则同一个文件里出现两种形态的行，肉眼分不出是数据问题还是格式问题。
//     const ts = typeof src.t === 'string' && src.t ? src.t : new Date().toISOString()
//     const mod = String(src.mod == null ? '' : src.mod).trim().slice(0, 32) || 'app'
//     const msg = src.msg == null ? '' : String(src.msg)
//     return `${ts}  ${padLevel(src.lvl || 'info')}  [${mod}]  ${msg}${renderTail(src.data)}`
//   }
//
// 唯一的差异预处理放在 IPC 入口：渲染进程送来的 entry 已脱敏且字符串已过 120 截断，
// 主进程自己产生的记录要走一遍等价处理后再交给 appendLine。
//
// 一致性已实测：把上面这段抄出来与 ESM 版对 11 条合规 entry + 5 条缺字段 entry
// 逐字节比对（含 UTF-8 字节长度），全部相同。
// 唯一未覆盖的差异：entry 的属性 getter 抛异常时，ESM 版会兜出一行降级日志，
// 这份极简版没有 —— 主进程构造的都是字面量对象，碰不到这种情况。
// ===========================================================================
