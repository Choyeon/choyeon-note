const { app, BrowserWindow, Menu, ipcMain, dialog, net, shell, safeStorage } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fsp = require('fs/promises')
const fsSync = require('fs')
const os = require('os')

const { validatePath, validatePathAsync } = require('./path-safety.cjs')

const isDev = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5176'

let mainWindow = null
let notesPath = null

// 认作笔记文件的扩展名（与 src/stores/note.js 的 KNOWN_EXTENSIONS 保持一致）
const NOTE_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

// 打包后 asar 内必须包含图标（见 package.json 的 build.files），否则窗口/任务栏
// 会退回默认 Electron 图标。开发态与打包态路径不同，这里做一次兜底。
const ICON_PATH = (() => {
  const candidate = path.join(__dirname, '../build/icons/icon.png')
  try {
    return fsSync.existsSync(candidate) ? candidate : path.join(__dirname, '../public/icon.png')
  } catch (err) {
    return candidate
  }
})()

// ===== 笔记目录文件监听（设置页「自动同步」）=====
// 目录树变化很吵（一次保存可能触发 rename + change 多次），所以做两级降噪：
// 1) 本进程写入过的路径在 SELF_WRITE_TTL_MS 内忽略（自己写的不用重载）
// 2) 其余事件合并到 WATCH_DEBOUNCE_MS 窗口里只发一次
const watchers = []
let watchDebounceTimer = null
const WATCH_DEBOUNCE_MS = 600
// 首帧就绪后仍未显示窗口时的强制显示等待时间（见 createWindow 内的兜底逻辑）
const SHOW_FALLBACK_MS = 3000

function stopNotesWatcher() {
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  while (watchers.length) {
    const w = watchers.pop()
    try { w.close() } catch (e) { /* 已关闭 */ }
  }
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const spellDataFile = () => path.join(app.getPath('userData'), 'spell-data.json')
const workspacesFile = () => path.join(app.getPath('userData'), 'workspaces.json')
const vaultsDir = () => path.join(app.getPath('userData'), 'vaults')
// T16（R-F1 双轨稳定 id）：id ↔ path 映射表。
// 放 userData 而不是笔记目录，理由与上面的 vaults 一致 —— 这是应用私有数据，绝不能
// 污染用户的 Markdown 库（用户的库会被 Obsidian / git 读写）。
const ID_MAP_FILE_NAME = 'note-id-map.json'
const idMapFile = () => path.join(app.getPath('userData'), ID_MAP_FILE_NAME)

let activeWorkspaceId = null

// ===== 标识符白名单 =====
// 渲染进程传来的 id 会被拼进文件路径（vaults/<id>.json），必须挡住 `..` 与分隔符，
// 否则 `vault:save` 能覆写 userData 下任意 JSON（含笔记路径配置）。
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const isSafeId = (id) => typeof id === 'string' && SAFE_ID_RE.test(id)

// 自身写入静默窗：改用「路径集合 + TTL」而不是单一全局时间戳。
// 单一时间戳在并发写多个文件时会被相互续期，事件与写入仍可能交错。
const selfWriteUntil = new Map()
const SELF_WRITE_TTL_MS = 1500

function markSelfWrite (p) {
  if (!p) return
  selfWriteUntil.set(String(p), Date.now() + SELF_WRITE_TTL_MS)
  if (selfWriteUntil.size > 500) {
    const now = Date.now()
    for (const [k, v] of selfWriteUntil) {
      if (v <= now) selfWriteUntil.delete(k)
    }
  }
}

function isSelfWrite (p) {
  if (!p) return false
  const until = selfWriteUntil.get(String(p))
  if (until === undefined) return false
  if (Date.now() > until) {
    selfWriteUntil.delete(String(p))
    return false
  }
  return true
}

/** 判断目录是否真实存在且可访问 */
async function directoryExists (dirPath) {
  try {
    const stat = await fsp.stat(dirPath)
    return stat.isDirectory()
  } catch (err) {
    return false
  }
}

/**
 * 校验并设置笔记目录。
 * 必须由**主进程**把关：渲染进程只要能任意改这个基目录，后续所有
 * validatePath 白名单都会被整体架空（等同任意文件读写）。
 */
async function applyNotesPath (candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return false
  const resolved = path.resolve(candidate)
  // 拒绝文件系统根与用户主目录本身：范围过大，任何误操作都是灾难性的
  const root = path.parse(resolved).root
  if (!resolved || resolved === root) return false
  if (path.resolve(os.homedir()) === resolved) return false
  if (!(await directoryExists(resolved))) return false
  notesPath = resolved
  await saveSettings()
  return true
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch (error) {
    return fallback
  }
}

async function writeJson(file, data) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error(`Error writing ${file}:`, error.message)
    return false
  }
}

async function loadSettings() {
  try {
    const data = await fsp.readFile(settingsFile(), 'utf-8')
    const settings = JSON.parse(data)
    if (settings.notesPath) {
      // 目录被移动 / 外置盘未挂载时置空，让前端引导重新选择，
      // 而不是表现为「笔记全空」让用户以为数据丢了
      if (await directoryExists(settings.notesPath)) {
        notesPath = settings.notesPath
      } else {
        console.warn('Saved notes path no longer exists:', settings.notesPath)
        notesPath = null
      }
    }
    if (settings.activeWorkspaceId) {
      activeWorkspaceId = settings.activeWorkspaceId
    }
  } catch (error) {
    // Settings file doesn't exist yet
  }
}

async function saveSettings() {
  try {
    const settings = { notesPath, activeWorkspaceId }
    await fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch (error) {
    console.error('Error saving settings:', error.message)
  }
}

// ============================================================================
// 日志系统（T09）—— 主进程落盘侧
//
// 为什么这一段这么长、而且大量「重复」了 src/utils/logger.js 与 logSanitize.js：
//   package.json 是 "type": "module"，而 electron-builder 的 files 只打包 dist/**
//   与 electron/** —— src/ **不进安装包**。主进程一旦 `require('../src/utils/*.js')`，
//   dev 下能跑（Node ≥22.12 支持 require(ESM)），打包后必定 MODULE_NOT_FOUND。
//   所以「脱敏」与「行格式」这两份纯函数在主进程侧必须各留一份等价副本，与
//   utils/noteFile.js 的做法一致：主进程保留自己的那份安全边界实现。
//
// ⚠️ 双副本警告（DUAL-COPY）—— 这份逻辑有两处副本，改一处必须改两处：
//   · 行格式：与 src/utils/logger.js 的 formatLogLine 必须**逐字节一致**。
//     同一个 main.log 里若出现两种形态的行，R-L3「主/渲染两侧按时间戳串起来」
//     就废了，而这是日志系统存在的全部意义。
//   · 脱敏：与 src/utils/logSanitize.js 的 redactPath 及其关键正则 / 常量一致。
//     否则「家目录必须遮蔽」这条硬规则会在主进程侧漏掉 —— 而主进程记的恰恰是最
//     容易夹带绝对路径的那些：写盘失败、越界拒绝、errno 上下文。
//
// 两处都由 tests/mainLogParity.test.js（源码级正则 / 常量比对）与
// tmp/t09-recover-verify.mjs（运行时逐字节比对）双重守卫。
// ============================================================================

// ---------------------------------------------------------------------------
// 常量：镜像 src/constants/logging.js（数值必须逐一同值）
// ---------------------------------------------------------------------------

/** 级别 → 权重，数值越大越严重；silent 是闸门不是可输出级别 */
const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 })

/** 可输出级别（不含 silent） */
const LOG_LEVEL_ORDER = Object.freeze(['debug', 'info', 'warn', 'error'])

/** 默认级别：生产环境不该被 debug 刷屏 */
const DEFAULT_LOG_LEVEL = 'info'

/** 单文件上限，超过就把 main.log 轮转为 main.1.log */
const LOG_MAX_BYTES = 2 * 1024 * 1024

/** 轮转文件的保留天数 */
const LOG_KEEP_DAYS = 7

/** main.log + 轮转文件的总个数上限 → 轮转文件最多 LOG_MAX_FILES-1 = 6 个 */
const LOG_MAX_FILES = 7

/** 日志目录名（挂在 app.getPath('userData') 下） */
const LOG_DIR_NAME = 'logs'

/** 主日志文件基本名 */
const LOG_FILE_NAME = 'main.log'

/** 级别栏宽度：'INFO ' / 'ERROR'，让消息正文起始列固定 */
const LOG_LEVEL_WIDTH = 5

/** 字段分隔符（两个空格） */
const LOG_FIELD_SEP = '  '

/** 单条字符串进入日志前的截断上限 */
const LOG_CONTENT_MAX = 120

/** sanitizeValue 对单个字符串的上限 */
const LOG_MAX_STRING = 200

/** sanitizeValue 默认下潜层数 */
const LOG_MAX_DEPTH = 3

/** 单个对象最多保留多少个 key */
const LOG_MAX_KEYS = 40

/** 单个数组最多保留多少项 */
const LOG_MAX_ARRAY = 30

/** 一次 sanitize 最多处理多少个节点（总量闸门） */
const LOG_MAX_NODES = 500

/** log:read 的默认行数上限 */
const LOG_READ_DEFAULT_LIMIT = 200

/** log:read 的硬上限：显式传更大的值也不放行，防止把整个文件灌进 IPC */
const LOG_READ_HARD_LIMIT = 5000

/** 落盘分片大小：每写满这么多字节就检查一次轮转（见 appendLogLines） */
const LOG_FLUSH_CHUNK_BYTES = 256 * 1024

/** 级别的 localStorage key（渲染侧引导层持有，主进程不持久化，仅登记以备对照） */
const LS_LOG_LEVEL = 'choyeon-log-level'

/** 模块名约定（design §4.4） */
const LOG_MODULES = Object.freeze({
  note: 'note',
  app: 'app',
  vault: 'vault',
  workspace: 'workspace',
  watcher: 'watcher',
  ipc: 'ipc',
  graph: 'graph',
  calendar: 'calendar',
  editor: 'editor',
  sync: 'sync',
  actions: 'actions',
  commands: 'commands',
  main: 'main'
})

/** 完整替换标记：整体替换而非部分遮蔽 */
const REDACTED = '[REDACTED]'

/** 路径被遮蔽后用的省略符（U+2026） */
const ELLIPSIS = '\u2026'

/**
 * 敏感 key 判定模式。必须与 src/utils/logSanitize.js 的 SENSITIVE_KEY_PATTERN
 * **字面值完全相同**（tests/mainLogParity.test.js 逐字符比对）。
 * 结尾锚 `$` 的含义与「已知代价」见那份文件的文件头，这里不复述。
 */
const SENSITIVE_KEY_PATTERN = /(pass|passwd|password|secret|secretkey|token|credential|apikey|api_key|private|privatekey|accesskey|value|valueenc)$/i

// ---------------------------------------------------------------------------
// 路径形状识别：镜像 src/utils/logSanitize.js（四段正则必须字面对齐）
// ---------------------------------------------------------------------------

/** 绝对路径的起手式：POSIX 根 / Windows 盘符 / ~ */
const IS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|~)/

/** 「整串就是一个路径」的形状 */
const WHOLE_PATH_RE = /^(?:~|[A-Za-z]:)?[\\/](?:[^\\/\u0000-\u001F]+[\\/])*[^\\/\u0000-\u001F]*$/

/**
 * 自由文本里**内嵌**的绝对路径。
 * 两段式：① 边界锚（不含 `:` 与 `/`，故 URL 不会被误认成路径）；② 路径体。
 */
const EMBEDDED_PATH_RE = new RegExp(
  '(^|[\\s\'"(,;=|[`*+{<])((?:[A-Za-z]:[\\\\/]|[\\\\/])(?:' +
  '[^\\\\/\\u0000-\\u001F:*?"<>|\\u3000-\\u303F\\u2018-\\u201F\\u2026\\uFF01-\\uFF65\\uFFE0-\\uFFEF]+' +
  '[\\\\/])+[^\\\\/\\u0000-\\u001F:*?"<>|\\u3000-\\u303F\\u2018-\\u201F\\u2026\\uFF01-\\uFF65\\uFFE0-\\uFFEF]*)',
  'g'
)

/** 家目录根的常见写法（没有 os / process 可用时的形状兜底） */
const HOME_ROOT_PATTERNS = [
  /^(?:[A-Za-z]:)?[\\/]?Users[\\/][^\\/]+(?=[\\/]|$)/i, // macOS /Users/<name>，也覆盖 C:\Users\<name>
  /^[\\/]home[\\/][^\\/]+(?=[\\/]|$)/i, // Linux /home/<name>
  /^[\\/]root(?=[\\/]|$)/i, // root 家目录
  /^[\\/]Documents and Settings[\\/][^\\/]+(?=[\\/]|$)/i // Windows XP 遗留
]

// ---------------------------------------------------------------------------
// 路径遮蔽：镜像 src/utils/logSanitize.js 的 redactPath
// ---------------------------------------------------------------------------

/** 取一个正整数参数，非法值回落到 fallback */
function logPositiveInt (raw, fallback) {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** 统一分隔符成 POSIX 形态并折叠重复斜杠 */
function normalizeSeparators (raw) {
  return String(raw)
    .replace(/^\\\\\?\\/, '') // \\?\C:\... 长路径标记
    .replace(/^\\\\\.\\/, '') // \\.\ 设备命名空间
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
}

/** home 参数归一化：同一套分隔符，去掉结尾斜杠 */
function normalizeHome (home) {
  return normalizeSeparators(home).replace(/\/+$/, '')
}

/** 剥掉家目录前缀，返回剩余部分与「是否剥过」 */
function stripHome (normalized, home) {
  if (home) {
    const lowerAll = normalized.toLowerCase()
    const lowerHome = home.toLowerCase()
    if (lowerAll === lowerHome) return { rest: '', hadHome: true }
    if (lowerAll.startsWith(lowerHome + '/')) return { rest: normalized.slice(home.length + 1), hadHome: true }
  }
  for (const re of HOME_ROOT_PATTERNS) {
    const m = re.exec(normalized)
    if (m) return { rest: normalized.slice(m[0].length), hadHome: true }
  }
  return { rest: normalized, hadHome: false }
}

/**
 * 遮蔽路径：剥家目录 + 只保留文件名与其父目录名，更上层折叠成 `…/`。
 *   '/Users/alice/notes/a.md' → '…/notes/a.md'
 *   'C:\\Users\\alice\\AppData\\x.json' → '…/AppData/x.json'
 * 口径出处：design §3.4 规则 2 与 §4.4，与 src/utils/logSanitize.js 同。
 * @param {unknown} p
 * @param {{home?: string}} [opts]
 * @returns {string}
 */
function redactPath (p, opts = {}) {
  if (typeof p !== 'string' || p === '') return ''
  const home = typeof opts.home === 'string' ? normalizeHome(opts.home) : ''
  const raw = normalizeSeparators(p).trim()
  const isAbs = IS_ABSOLUTE_RE.test(raw)
  const { rest, hadHome } = stripHome(raw, home)
  const parts = rest.split('/').filter(seg => seg !== '' && seg !== '.' && seg !== '..')
  if (parts.length === 0) return hadHome || isAbs ? `${ELLIPSIS}/` : ''
  const base = parts[parts.length - 1]
  if (parts.length === 1) {
    if (hadHome || isAbs) return `${ELLIPSIS}/${base}`
    return base
  }
  return `${ELLIPSIS}/${parts[parts.length - 2]}/${base}`
}

// ---------------------------------------------------------------------------
// 内容截断：镜像 src/utils/logSanitize.js 的 foldControlChars / redactContent
// ---------------------------------------------------------------------------

/**
 * 控制字符折叠成转义文本：日志必须一行一条，且产物里禁止裸控制字节。
 * @param {string} s
 * @returns {string}
 */
function foldControlChars (s) {
  return String(s)
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001F\u007F]/g, ch => {
      const code = ch.charCodeAt(0).toString(16).padStart(4, '0')
      return `\\u${code}`
    })
}

/** 内容片段脱敏（截断 + 折叠换行）；按码点切，避免把汉字劈成两半 */
function redactContent (s, max) {
  let text
  try {
    text = typeof s === 'string' ? s : String(s)
  } catch {
    return REDACTED
  }
  const limit = logPositiveInt(max, LOG_CONTENT_MAX)
  const folded = foldControlChars(text)
  const chars = Array.from(folded)
  if (chars.length <= limit) return folded
  return chars.slice(0, limit).join('') + ELLIPSIS
}

// ---------------------------------------------------------------------------
// 通用值脱敏：镜像 src/utils/logSanitize.js 的 sanitizeValue
// ---------------------------------------------------------------------------

/** 是否为带类型的平台对象（形状判断，不 import 任何模块） */
function logIsDateLike (v) {
  return Object.prototype.toString.call(v) === '[object Date]'
}
function logIsRegExpLike (v) {
  return Object.prototype.toString.call(v) === '[object RegExp]'
}
function logIsErrorLike (v) {
  return v instanceof Error || Object.prototype.toString.call(v) === '[object Error]'
}
function logIsDomNode (v) {
  return !!v && typeof v === 'object' && typeof v.nodeType === 'number' && typeof v.nodeName === 'string'
}
function logIsBinaryLike (v) {
  return (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) ||
    (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(v))
}

/** 单串处理：整串是路径直接整体遮蔽；否则只替换内嵌的绝对路径片段 */
function logSanitizeString (raw, state) {
  let text
  try {
    text = typeof raw === 'string' ? raw : String(raw)
  } catch {
    return REDACTED
  }
  let masked
  if (WHOLE_PATH_RE.test(text)) {
    masked = redactPath(text, { home: state.home })
  } else {
    masked = text.replace(EMBEDDED_PATH_RE, (_, lead, token) => lead + redactPath(token, { home: state.home }))
  }
  return redactContent(masked, state.maxString)
}

/** Error 序列化：message / stack 是非枚举属性，直接展开对象是空的 */
function logErrorToObject (err, state, depth) {
  const out = {}
  for (const k of ['name', 'message', 'code', 'errno']) {
    const v = err[k]
    if (v === undefined || v === null) continue
    out[k] = typeof v === 'string' ? logSanitizeString(v, state) : logWalkValue(v, state, depth + 1)
  }
  if (typeof err.stack === 'string' && err.stack) {
    const frames = err.stack.split(/\r?\n/).slice(0, 3).join(' | ')
    out.stack = logSanitizeString(frames, state)
  }
  return out
}

function logSafeString (v) {
  try {
    return String(v)
  } catch {
    return REDACTED
  }
}

function logWalkValue (value, state, depth) {
  try {
    return logWalkInner(value, state, depth)
  } catch {
    return REDACTED
  }
}

function logWalkInner (value, state, depth) {
  if (value === null || value === undefined) return value
  if (state.nodes >= state.maxNodes) return '[BudgetExceeded]'
  state.nodes += 1

  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return logSafeString(value)
  if (typeof value === 'function') return '[Function]'
  if (typeof value === 'string') return logSanitizeString(value, state)

  if (logIsDomNode(value)) return '[DOMNode]'
  if (logIsBinaryLike(value)) return `[Binary:${typeof value.byteLength === 'number' ? value.byteLength : '?'}]`
  if (logIsDateLike(value)) return Number.isFinite(value.getTime()) ? logSanitizeString(value.toISOString(), state) : '[InvalidDate]'
  if (logIsRegExpLike(value)) return logSafeString(value)
  if (logIsErrorLike(value)) return logErrorToObject(value, state, depth)

  const tag = Object.prototype.toString.call(value)
  if (tag === '[object Map]' || tag === '[object Set]') {
    return logWalkArrayLike(Array.from(value), state, depth)
  }

  if (depth >= state.maxDepth) return value.constructor && typeof value.constructor.name === 'string'
    ? `[Object:${value.constructor.name}]`
    : '[Object]'

  if (state.chain.has(value)) return '[Circular]'
  state.chain.add(value)
  try {
    if (Array.isArray(value)) return logWalkArrayLike(value, state, depth)
    return logWalkObject(value, state, depth)
  } finally {
    state.chain.delete(value)
  }
}

function logWalkArrayLike (list, state, depth) {
  const out = []
  const cap = Math.min(list.length, state.maxArray)
  for (let i = 0; i < cap; i += 1) {
    out.push(logWalkValue(list[i], state, depth + 1))
  }
  if (list.length > cap) out.push(`${ELLIPSIS}(+${list.length - cap})`)
  return out
}

function logWalkObject (obj, state, depth) {
  const out = {}
  let keys
  try {
    keys = Object.keys(obj)
  } catch {
    return REDACTED
  }
  const cap = Math.min(keys.length, state.maxKeys)
  for (let i = 0; i < cap; i += 1) {
    const k = keys[i]
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = REDACTED
      continue
    }
    let v
    try {
      v = obj[k]
    } catch {
      out[k] = REDACTED
      continue
    }
    out[k] = logWalkValue(v, state, depth + 1)
  }
  if (keys.length > cap) out.__truncated = `${ELLIPSIS}(+${keys.length - cap} keys)`
  return out
}

/**
 * 通用值脱敏：把任意入参转成「可以安全出日志的结构」。
 * 与 src/utils/logSanitize.js 的 sanitizeValue 同构；主进程自产记录出门前必过这一道。
 * @param {unknown} value
 * @param {object} [opts]
 * @returns {any}
 */
function logSanitizeValue (value, opts = {}) {
  const state = {
    maxDepth: logPositiveInt(opts.maxDepth, LOG_MAX_DEPTH),
    maxString: logPositiveInt(opts.maxString, LOG_MAX_STRING),
    maxKeys: logPositiveInt(opts.maxKeys, LOG_MAX_KEYS),
    maxArray: logPositiveInt(opts.maxArray, LOG_MAX_ARRAY),
    maxNodes: logPositiveInt(opts.maxNodes, LOG_MAX_NODES),
    home: typeof opts.home === 'string' ? normalizeHome(opts.home) : '',
    chain: new Set(),
    nodes: 0
  }
  return logWalkValue(value, state, 0)
}

// ---------------------------------------------------------------------------
// 行格式：与 src/utils/logger.js 的 formatLogLine **逐字节一致**
//
// 三个兜底（ts / mod / msg）必须与 ESM 版等价，否则同一个文件里出现两种形态的行，
// 肉眼分不出是数据问题还是格式问题。差异只在「异常兜底」：ESM 版在属性 getter 抛
// 异常时会给出一行降级日志，主进程构造的都是字面量对象，碰不到这种情况。
// ---------------------------------------------------------------------------

/** 级别左对齐补空格到 LOG_LEVEL_WIDTH */
function padLevel (lvl) {
  const s = String(lvl).toUpperCase()
  return s.length >= LOG_LEVEL_WIDTH ? s : s + ' '.repeat(LOG_LEVEL_WIDTH - s.length)
}

/** 把 data 渲染成 `k=v k=v` 尾巴；值含空白或为空时用 JSON 引号包住，保证可解析 */
function renderTail (data) {
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

/** LogEntry → 一行文本：`2026-03-15T10:23:45.123Z  ERROR  [note]  消息  k=v` */
function formatLogLine (entry) {
  const src = entry && typeof entry === 'object' ? entry : {}
  const ts = typeof src.t === 'string' && src.t ? src.t : new Date().toISOString()
  const mod = typeof src.mod === 'string' ? src.mod.trim() : (src.mod == null ? '' : String(src.mod))
  const message = src.msg == null ? '' : String(src.msg)
  return `${ts}${LOG_FIELD_SEP}${padLevel(src.lvl || DEFAULT_LOG_LEVEL)}${LOG_FIELD_SEP}[${mod || LOG_MODULES.app}]${LOG_FIELD_SEP}${message}${renderTail(src.data)}`
}

// ---------------------------------------------------------------------------
// 落盘位置与轮转
// ---------------------------------------------------------------------------

/** userData 目录；拿不到时返回 ''（日志模块据此整体降级为空操作） */
function userDataDir () {
  try {
    return app.getPath('userData') || ''
  } catch {
    return ''
  }
}

function logDirPath () {
  const base = userDataDir()
  return base ? path.join(base, LOG_DIR_NAME) : ''
}

function logFilePath () {
  const dir = logDirPath()
  return dir ? path.join(dir, LOG_FILE_NAME) : ''
}

/** 第 index 代轮转文件：main.1.log 最新，数字越大越老 */
function rotatedFilePath (index) {
  const dir = logDirPath()
  return dir ? path.join(dir, `main.${index}.log`) : ''
}

/** 家目录（喂给 redactPath 提升遮蔽准确度）；取不到时退回 os.homedir() */
let homeDirCache = ''
let homeDirResolved = false
function homeDir () {
  if (homeDirResolved) return homeDirCache
  homeDirResolved = true
  try {
    homeDirCache = app.getPath('home') || ''
  } catch {
    homeDirCache = ''
  }
  if (!homeDirCache) {
    try {
      homeDirCache = os.homedir() || ''
    } catch {
      homeDirCache = ''
    }
  }
  return homeDirCache
}

/**
 * 轮转：main.log 超 LOG_MAX_BYTES 就整体后移一代。
 *
 * 顺序是「先牺牲最老的那一代，再从老到新依次后移」——反过来（先移再删）会在最老
 * 一代仍存在时把 main.5 覆盖成 main.6，等于静默丢掉一整代日志。
 * 后移用 rename 而不是 copy：同一卷内 rename 是原子的，轮转中途崩溃不会留下半截文件。
 */
async function rotateIfNeeded (file) {
  let size = 0
  try {
    size = (await fsp.stat(file)).size
  } catch {
    return
  }
  if (size <= LOG_MAX_BYTES) return

  const dir = path.dirname(file)
  // 最老一代（index = LOG_MAX_FILES-1）直接丢弃，保证轮转文件数不超过上限
  try {
    await fsp.rm(rotatedFilePath(LOG_MAX_FILES - 1), { force: true })
  } catch {
    /* 该代不存在，正常 */
  }
  for (let i = LOG_MAX_FILES - 2; i >= 1; i -= 1) {
    try {
      await fsp.rename(rotatedFilePath(i), rotatedFilePath(i + 1))
    } catch {
      /* 缺代则跳过，不影响其余 */
    }
  }
  try {
    await fsp.rename(file, rotatedFilePath(1))
  } catch {
    // 轮不动就保持现状：多写一个超限的文件，也强过把当前日志弄丢
  }
  await pruneRotatedByAge(dir)
}

/** 按 LOG_KEEP_DAYS 清理超期的轮转文件（7 天口径） */
async function pruneRotatedByAge (dir) {
  const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^main\.\d+\.log$/.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    let stat = null
    try {
      stat = await fsp.stat(full)
    } catch {
      continue
    }
    if (stat && stat.mtimeMs < cutoff) {
      try {
        await fsp.rm(full, { force: true })
      } catch {
        /* 删不掉就留着，不影响写入 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 写入：串行链
//
// **串行化是这个模块的要害**。若两次 append 并发写同一个文件，到达顺序与落盘顺序
// 就可能不一致，main.log 里会出现「后面的日志排在前面」——日志一旦乱序就失去了按
// 时间线排查的意义（R-L3）。所以所有写入都排进同一条 Promise 链：
// 入链动作本身是同步的（`chain.then(...)`），因此入链次序 = handler 被调用的次序。
// ---------------------------------------------------------------------------

let logWriteChain = Promise.resolve()
let logDirReady = false
let sessionMarkerWritten = false
let currentLogLevel = DEFAULT_LOG_LEVEL

const LOG_SESSION_MARK_MSG = '主进程日志会话开始'

function appVersionSafe () {
  try {
    return app.getVersion() || ''
  } catch {
    return ''
  }
}

/**
 * 真正写盘（已在链上，不会被并发调用）。
 * @param {string[]} lines 已格式化的行
 * @returns {Promise<number>} 本次写入的**条目**数（启动标记不计入）
 */
async function appendLogLines (lines) {
  const file = logFilePath()
  if (!file) return 0
  const dir = path.dirname(file)
  if (!logDirReady) {
    try {
      await fsp.mkdir(dir, { recursive: true })
      logDirReady = true
    } catch {
      return 0
    }
  }

  const payload = []
  if (!sessionMarkerWritten && isLevelEnabled('info')) {
    sessionMarkerWritten = true
    payload.push(formatLogLine({
      t: new Date().toISOString(),
      lvl: 'info',
      mod: LOG_MODULES.main,
      msg: LOG_SESSION_MARK_MSG,
      data: { v: appVersionSafe() }
    }))
  }
  for (const line of lines) payload.push(line)

  // 分片写 + 片间检查轮转。
  // 为什么不能「整批一次 appendFile 完事再转」：一次批量追加若是 10MB，文件会被写
  // 到 10MB 才轮一次，main.log 长期远超 2MB，轮出来的每一代也都是 10MB —— 轮转阈值
  // 形同虚设。按 LOG_FLUSH_CHUNK_BYTES 切片后，文件一旦越过阈值就在下一片之前被转走，
  // 于是「当前文件 < 2MB」与「每代 ≈ 2MB」两个性质对任意大小的批次都成立。
  // 小批次（日常日志）只会走一次 appendFile，开销与原来相同。
  let buffer = []
  let bufferedBytes = 0
  try {
    for (const line of payload) {
      buffer.push(line)
      bufferedBytes += Buffer.byteLength(line) + 1
      if (bufferedBytes >= LOG_FLUSH_CHUNK_BYTES) {
        await fsp.appendFile(file, buffer.join('\n') + '\n', 'utf-8')
        buffer = []
        bufferedBytes = 0
        await rotateIfNeeded(file)
      }
    }
    if (buffer.length) {
      await fsp.appendFile(file, buffer.join('\n') + '\n', 'utf-8')
      await rotateIfNeeded(file)
    }
  } catch {
    return 0
  }
  return lines.length
}

/**
 * 把一批行排进写入链。
 * @param {string[]} lines
 * @returns {Promise<number>}
 */
function enqueueLogLines (lines) {
  const run = logWriteChain.then(() => appendLogLines(lines))
  logWriteChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 写入会话启动标记（app.whenReady 时调一次；懒加载兜底在首次 append 时也会补上）。
 * 有了它，一份 main.log 能被切成「一次启动一段」，排查时不用靠猜时间戳断层。
 * @returns {Promise<number>}
 */
function markSessionStart () {
  if (sessionMarkerWritten) return Promise.resolve(0)
  return enqueueLogLines([])
}

// ---------------------------------------------------------------------------
// 级别闸门
// ---------------------------------------------------------------------------

/** 级别权重；未知级别按当前级别处理（不因此放行） */
function levelWeight (level) {
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)
    ? LOG_LEVELS[level]
    : LOG_LEVELS[DEFAULT_LOG_LEVEL]
}

/**
 * 该级别此刻是否落盘。
 *
 * `silent` 是闸门而不是级别：权重 100 高于一切，于是连 error 都被挡住 —— 这正是
 * 「silent 下连 error 都不落盘」的实现方式，不需要为 silent 单写分支。
 * @param {string} level
 * @returns {boolean}
 */
function isLevelEnabled (level) {
  return levelWeight(level) >= levelWeight(currentLogLevel)
}

/**
 * 规范化渲染进程送来的条目。
 *
 * 渲染侧已脱敏、已做 120 截断，这里**不再脱一次**（再脱会把内容又截一刀，也会让
 * 主/渲染两侧对同一条记录产生两份不完全相同的文本）。
 * @param {unknown} raw
 * @returns {{t: string, lvl: string, mod: string, msg: string, data?: unknown}|null}
 */
function normalizeIncomingEntry (raw) {
  if (!raw || typeof raw !== 'object') return null
  const lvl = typeof raw.lvl === 'string' ? raw.lvl.toLowerCase() : DEFAULT_LOG_LEVEL
  if (!Object.prototype.hasOwnProperty.call(LOG_LEVELS, lvl)) return null
  if (lvl === 'silent') return null // silent 永远不会出现在 LogEntry.lvl 上
  if (!isLevelEnabled(lvl)) return null
  const t = typeof raw.t === 'string' && raw.t ? raw.t : new Date().toISOString()
  const modRaw = typeof raw.mod === 'string' ? raw.mod.trim() : (raw.mod == null ? '' : String(raw.mod))
  let msg
  try {
    msg = typeof raw.msg === 'string' ? raw.msg : String(raw.msg ?? '')
  } catch {
    msg = REDACTED
  }
  return { t, lvl, mod: modRaw || LOG_MODULES.app, msg, data: raw.data }
}

// ---------------------------------------------------------------------------
// 主进程自产记录
// ---------------------------------------------------------------------------

/**
 * 写一条主进程自己的记录。
 *
 * 与渲染侧来的条目唯一的区别：**这里的数据要走一遍等价脱敏** —— 主进程记的恰恰是
 * 最容易夹带绝对路径的东西（写盘失败、越界拒绝、errno 上下文），不脱一次就会把
 * 家目录写进一份用户要拿去贴 GitHub Issue 的文件里。
 *
 * 硬约束：绝不抛。记日志这件事本身不能让业务流程崩。
 * @param {string} mod 模块名
 * @param {'debug'|'info'|'warn'|'error'} lvl
 * @param {unknown} msg
 * @param {unknown} [data]
 * @returns {void}
 */
function writeMainRecord (mod, lvl, msg, data) {
  try {
    if (!isLevelEnabled(lvl)) return
    const home = homeDir()
    const modName = typeof mod === 'string' && mod.trim() ? mod.trim().slice(0, 32) : LOG_MODULES.app
    const entry = {
      t: new Date().toISOString(),
      lvl,
      mod: modName,
      msg: logSanitizeString(msg, { home, maxString: LOG_CONTENT_MAX }),
      data: data === undefined || data === null
        ? undefined
        : logSanitizeValue(data, { home, maxString: LOG_CONTENT_MAX })
    }
    enqueueLogLines([formatLogLine(entry)])
  } catch {
    /* 日志故障绝不能外溢到业务 */
  }
}

/**
 * 造一个主进程 logger。
 *
 * 模块名必须取自 LOG_MODULES：主进程自己的记录一律用 `ipc`（它们记的都是「某次 IPC
 * 做了什么、失败原因是什么」），这样设置页按模块过滤时才有意义。
 * @param {string} moduleName
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function createMainLogger (moduleName) {
  const mod = LOG_MODULES[moduleName] ||
    (typeof moduleName === 'string' && moduleName.trim() ? moduleName.trim().slice(0, 32) : LOG_MODULES.app)
  return {
    debug: (msg, data) => writeMainRecord(mod, 'debug', msg, data),
    info: (msg, data) => writeMainRecord(mod, 'info', msg, data),
    warn: (msg, data) => writeMainRecord(mod, 'warn', msg, data),
    error: (msg, data) => writeMainRecord(mod, 'error', msg, data)
  }
}

/** IPC 通道自己的出口。模块名 [ipc] 是契约，设置页按它过滤「跨进程失败」 */
const ipcLog = createMainLogger(LOG_MODULES.ipc)

// ---------------------------------------------------------------------------
// IO 失败的统一形态
// ---------------------------------------------------------------------------

/**
 * 推断 errno。
 *
 * 真实的 fs 异常自带 `code`（EACCES / ENOSPC / ENOENT…），直接透传即可 —— 这正是
 * 「errno 真正传出来」的落点。但 `path-safety.cjs` 抛的是**不带 code 的普通 Error**
 * （越界 / 路径非法属于安全边界拒绝，不是 OS 错误），此时按语义补一个最接近的
 * POSIX errno，避免渲染侧拿回空 errno 又退回「猜关键词」的老路。
 * @param {unknown} error
 * @returns {string}
 */
function inferErrno (error) {
  const m = String((error && error.message) || '').toLowerCase()
  if (m.indexOf('outside') >= 0) return 'EPERM'
  if (m.indexOf('access denied') >= 0) return 'EACCES'
  if (m.indexOf('permission') >= 0) return 'EACCES'
  if (m.indexOf('not set') >= 0) return 'ENOENT'
  if (m.indexOf('invalid path') >= 0) return 'EINVAL'
  if (m.indexOf('not a directory') >= 0 || m.indexOf('enotdir') >= 0) return 'ENOTDIR'
  return 'EIO'
}

/**
 * IO 异常的上下文。渲染侧靠 errno 区分「没有权限」与「磁盘满了」。
 * @param {unknown} error
 * @returns {{errno: string, message: string}}
 */
function ioInfo (error) {
  const code = error && typeof error.code === 'string' && error.code ? error.code : inferErrno(error)
  return { errno: code, message: (error && error.message) || '' }
}

/** errno → kebab-case 错误码（design §4.5） */
function errnoToCode (errno) {
  if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS') return 'permission'
  if (errno === 'ENOENT' || errno === 'ENOTDIR') return 'not-found'
  if (errno === 'EEXIST') return 'target-exists'
  if (errno === 'EINVAL') return 'invalid-path'
  return 'write-failed'
}

/**
 * 结构化失败形态（fs:write-file 的 `detail:true` 与 fs:move-file 公用）。
 * 返回体的四个字段与 src/stores/note.js 的 describeIoFailure 一一对应。
 * @param {unknown} error
 * @param {string} [fallbackCode]
 * @returns {{ok: false, error: string, errno: string, message: string}}
 */
function ioFailure (error, fallbackCode) {
  const info = ioInfo(error)
  return {
    ok: false,
    error: fallbackCode || errnoToCode(info.errno),
    errno: info.errno,
    message: logSanitizeString(info.message, { home: homeDir(), maxString: LOG_CONTENT_MAX })
  }
}

// ---------------------------------------------------------------------------
// 广播：清空后通知渲染侧（设置页据此 clearRingBuffer()）
// ---------------------------------------------------------------------------

function broadcastToRenderers (channel, payload) {
  let windows = []
  try {
    windows = BrowserWindow.getAllWindows() || []
  } catch {
    windows = []
  }
  if ((!windows || windows.length === 0) && mainWindow) windows = [mainWindow]
  for (const win of windows) {
    try {
      if (win && win.webContents && typeof win.webContents.send === 'function') {
        win.webContents.send(channel, payload)
      }
    } catch {
      /* 单个窗口发送失败不影响其余 */
    }
  }
}

// ---------------------------------------------------------------------------
// 六个 log:* 通道
// ---------------------------------------------------------------------------

/**
 * log:append —— 渲染侧把（已脱敏的）条目送过来落盘。
 * 入参支持单条或数组：高频日志攒一批发能省掉大量 IPC 往返。
 */
ipcMain.handle('log:append', async (_, entry) => {
  const list = Array.isArray(entry) ? entry : [entry]
  const entries = []
  for (const raw of list) {
    const normalized = normalizeIncomingEntry(raw)
    if (normalized) entries.push(normalized)
  }
  if (entries.length === 0) return { ok: true, written: 0 }
  // 批内按 t 稳定排序：批与批之间已由写入链串行化保证到达次序，批内再排一次，
  // 于是「文件内时间戳单调不减」不再依赖 IPC 的到达次序（R-L3）。
  entries.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  const written = await enqueueLogLines(entries.map(item => formatLogLine(item)))
  return { ok: true, written }
})

/** log:read —— 最近 N 行，默认 LOG_READ_DEFAULT_LIMIT(200) 行 */
ipcMain.handle('log:read', async (_, limit) => {
  const file = logFilePath()
  if (!file) return { ok: false, path: null, lines: [], total: 0, truncated: false, error: 'no-user-data' }

  let want = LOG_READ_DEFAULT_LIMIT
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    want = Math.min(Math.floor(limit), LOG_READ_HARD_LIMIT)
  }

  let raw = ''
  try {
    raw = await fsp.readFile(file, 'utf-8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, path: file, lines: [], total: 0, truncated: false }
    return { ok: false, path: file, lines: [], total: 0, truncated: false, error: (error && error.message) || 'read-failed' }
  }

  const all = raw.split('\n').filter(line => line !== '')
  const total = all.length
  const lines = total > want ? all.slice(total - want) : all.slice()
  return { ok: true, path: file, lines, total, truncated: total > want }
})

/** log:path —— main.log 的绝对路径；无 userData 时返回 null */
ipcMain.handle('log:path', () => logFilePath() || null)

/**
 * log:export —— 弹保存对话框，导出**单个可分享文件**。
 * 合并口径：轮转文件从老到新，最后接 main.log，首尾相接后仍是一份按时间排的日志。
 * 目标位置由用户通过系统对话框给出，属于显式授权，不接受任意路径入参。
 */
ipcMain.handle('log:export', async () => {
  const file = logFilePath()
  if (!file) return { ok: false, error: 'no-user-data' }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let destination = ''
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出日志',
      defaultPath: path.join(os.homedir(), `choyeon-note-log-${stamp}.log`),
      filters: [{ name: '日志文件', extensions: ['log', 'txt'] }]
    })
    if (!result || result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
    destination = result.filePath
  } catch {
    // 对话框不可用（无 GUI / 被拦截）：按取消处理，不把异常抛给渲染侧
    return { ok: false, error: 'canceled' }
  }

  const chunks = []
  for (let i = LOG_MAX_FILES - 1; i >= 1; i -= 1) {
    try {
      chunks.push(await fsp.readFile(rotatedFilePath(i), 'utf-8'))
    } catch {
      /* 缺代则跳过 */
    }
  }
  try {
    chunks.push(await fsp.readFile(file, 'utf-8'))
  } catch {
    /* main.log 尚不存在时导出空文件也算成功 */
  }

  const merged = chunks
    .map(text => String(text).replace(/\s+$/, ''))
    .filter(text => text !== '')
    .join('\n') + '\n'

  try {
    await fsp.writeFile(destination, merged, 'utf-8')
  } catch (error) {
    return { ok: false, error: (error && error.message) || 'write-failed' }
  }
  return { ok: true, path: destination }
})

/**
 * log:clear —— 清空 main.log **与全部轮转文件**，并广播 log:cleared。
 * 渲染侧的环形缓冲由它自己清（收到 log:cleared 后 clearRingBuffer()）：
 * 不清的话列表里仍留着缓冲里的 500 条，用户会当成「清空没生效」。
 */
ipcMain.handle('log:clear', async () => {
  const dir = logDirPath()
  if (!dir) return { ok: false, error: 'no-user-data' }
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry || !entry.isFile()) continue
    if (entry.name !== LOG_FILE_NAME && !/^main\.\d+\.log$/.test(entry.name)) continue
    try {
      await fsp.rm(path.join(dir, entry.name), { force: true })
    } catch {
      /* 单个文件删不掉不影响其余 */
    }
  }
  // 清空 = 下一段会话重新开始，标记要重打
  sessionMarkerWritten = false
  broadcastToRenderers('log:cleared')
  return { ok: true }
})

/**
 * log:set-level —— 运行时切级别。
 * 非法级别**忽略**（返回 ok:false 且保持原级别），不抛、不回退到默认值：
 * 回退默认值会让「用户手改坏了 localStorage」变成「日志级别被悄悄改掉」。
 */
ipcMain.handle('log:set-level', async (_, level) => {
  if (typeof level !== 'string' || !Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
    return { ok: false, level: currentLogLevel, changed: false }
  }
  const changed = level !== currentLogLevel
  currentLogLevel = level
  return { ok: true, level: currentLogLevel, changed }
})

// ============================================================================
// 工作空间（Workspace）：多笔记库管理
// 为什么独立成文件：notesPath 只保存"当前"路径，无法支撑「最近工作空间列表 /
// 快速切换 / 失效路径标记」。工作空间元数据属于应用级配置，放 userData 而不是
// 笔记目录内，避免污染用户的 Markdown 库。
// ============================================================================
ipcMain.handle('workspace:list', async () => {
  return await readJson(workspacesFile(), [])
})

ipcMain.handle('workspace:save', async (_, workspaces) => {
  const list = Array.isArray(workspaces) ? workspaces : []
  return await writeJson(workspacesFile(), list)
})

ipcMain.handle('workspace:set-active', async (_, id) => {
  activeWorkspaceId = id || null
  await saveSettings()
  return true
})

ipcMain.handle('workspace:get-active', () => activeWorkspaceId)

ipcMain.handle('workspace:probe', async (_, dirPath) => {
  // 返回该路径下笔记文件数量与是否可读写，供 UI 显示元信息 / 标记失效。
  // 扩展名必须复用 NOTE_FILE_EXTENSIONS：硬编码 '.md' 会让用户选了 .markdown /
  // .txt 库之后这里显示「0 篇笔记」。
  try {
    const stats = await fsp.stat(dirPath)
    if (!stats.isDirectory()) return { exists: false, count: 0, writable: false }
    let count = 0
    let folders = 0
    const stack = [dirPath]
    while (stack.length) {
      const current = stack.pop()
      const entries = await fsp.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          folders++
          stack.push(path.join(current, entry.name))
        } else if (entry.isFile() && NOTE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          count++
        }
      }
    }
    let writable = true
    try {
      await fsp.access(dirPath, fsSync.constants.W_OK)
    } catch {
      writable = false
    }
    return { exists: true, count, folders, writable }
  } catch (error) {
    return { exists: false, count: 0, folders: 0, writable: false, error: error.message }
  }
})

// ============================================================================
// 键值备忘录（KV Vault）
// 存放位置：userData/vaults/<workspaceId>.json —— 刻意不放进 notesPath。
// 原因：1) 内容多为账号/密码/Token，不应与可能被同步到云盘的 Markdown 混在一起；
//      2) notesPath 的 fs IPC 全部走 validatePath 白名单，扩展新目录会放宽安全边界。
// 注意：这是本地明文存储，仅提供基础的「掩码显示 + 不进搜索索引」保护，
//      不等价于加密保险库。
// ============================================================================
const VAULT_DEFAULT_ID = 'default'
const vaultFileFor = (workspaceId) => {
  if (!isSafeId(workspaceId)) return path.join(vaultsDir(), `${VAULT_DEFAULT_ID}.json`)
  return path.join(vaultsDir(), `${workspaceId}.json`)
}

ipcMain.handle('vault:load', async (_, workspaceId) => {
  if (!isSafeId(workspaceId) && workspaceId !== undefined && workspaceId !== null) {
    console.warn('vault:load rejected unsafe workspaceId')
    return []
  }
  const data = await readJson(vaultFileFor(workspaceId), { entries: [] })
  return Array.isArray(data.entries) ? data.entries : []
})

ipcMain.handle('vault:save', async (_, workspaceId, entries) => {
  if (!isSafeId(workspaceId) && workspaceId !== undefined && workspaceId !== null) {
    console.warn('vault:save rejected unsafe workspaceId')
    return false
  }
  return await writeJson(vaultFileFor(workspaceId), {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: Array.isArray(entries) ? entries : []
  })
})

// ===== 密码本加密：把密文存储放到主进程的 safeStorage =====
// safeStorage 用操作系统级凭据库（Windows DPAPI / macOS Keychain / Linux libsecret）
// 加密，密钥不在应用数据里，因此比「自己拿 Hardcoded key 做 AES」强得多。
// 不可用时（Linux 无 keyring）降级为不加密，并把可用性回报给渲染侧，
// 由 UI 明确告知用户当前是明文存储。
ipcMain.handle('vault:encryption-available', () => safeStorage.isEncryptionAvailable())

ipcMain.handle('vault:encrypt', async (_, plainText) => {
  if (typeof plainText !== 'string') return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.encryptString(plainText).toString('base64')
  } catch (err) {
    console.error('vault:encrypt failed:', err.message)
    return null
  }
})

ipcMain.handle('vault:decrypt', async (_, cipherBase64) => {
  if (typeof cipherBase64 !== 'string' || !cipherBase64) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(cipherBase64, 'base64'))
  } catch (err) {
    console.error('vault:decrypt failed:', err.message)
    return null
  }
})

function createWindow() {
  // GPU 被禁用时（命令行带 --disable-gpu / --in-process-gpu，常见于远程桌面、
  // 虚拟机、老显卡或 CI），亚克力 / vibrancy / 透明窗口都依赖系统合成器，
  // 一旦不可用会让首帧永远绘制不出来 —— 表现是"窗口出来了但一片空白"。
  // 这时退化为不透明普通窗口：先保证能出画面，再谈观感。
  const gpuDisabled = process.argv.some((a) =>
    /^--(disable-gpu|in-process-gpu|disable-gpu-compositing|disable-software-rasterizer)$/.test(a)
  )

  const windowOptions = {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hiddenInset',
    hasShadow: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  }

  if (gpuDisabled) {
    windowOptions.backgroundColor = '#ffffff'
  } else if (process.platform === 'win32') {
    windowOptions.backgroundMaterial = 'acrylic'
    // 亚克力生效前若背景色未指定会闪一下白底
    windowOptions.backgroundColor = '#00000000'
  } else if (process.platform === 'darwin') {
    windowOptions.vibrancy = 'under-window'
    windowOptions.visualEffectState = 'active'
    windowOptions.backgroundColor = 'rgba(255, 255, 255, 0.001)'
  } else {
    windowOptions.transparent = true
    windowOptions.backgroundColor = '#00000000'
  }

  mainWindow = new BrowserWindow(windowOptions)

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // Markdown 预览里的 target="_blank" 外链：默认会开出无菜单栏的裸 BrowserWindow，
  // 这里统一交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'http:' || protocol === 'https:') {
        shell.openExternal(url)
      }
    } catch (err) {
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription)
    if (isDev) {
      setTimeout(() => {
        mainWindow?.loadURL(DEV_SERVER_URL)
      }, 2000)
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 兜底显示：ready-to-show 依赖渲染进程完成首帧合成，在「GPU 不可用 /
  // 合成器初始化失败」的机器上可能永远不触发 —— 那时进程在跑、窗口却始终不出现，
  // 用户看到的是"双击没反应"。这里无论如何超时强制 show。
  const showFallbackTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }, SHOW_FALLBACK_MS)

  mainWindow.once('show', () => {
    clearTimeout(showFallbackTimer)
  })

  mainWindow.on('closed', () => {
    clearTimeout(showFallbackTimer)
    mainWindow = null
  })
}

// ============================================================================
// 应用菜单（阶段 3 · T05 去重后的形态）
//
// 总监裁决 1（方案 A）：renderer 的快捷键注册表是**键位唯一来源**，菜单不再注册
// 与之重叠的 accelerator —— 否则用户改了键，菜单那份仍会抢先触发，表现为「改了没
// 生效」或「一次操作触发两次」。菜单项本身与 click 全部保留，鼠标照样可点。
//
// 具体去掉的五个：CmdOrCtrl+N / O / S / B / Shift+P（见
// docs/shortcuts-incremental-design.md §0 裁决 1 与 §D T05 验收）。
// `CmdOrCtrl+T`（切换主题）按 E-5 的建议一并去掉：它与注册表不重叠，但同族 ——
// 用户若把 view.toggleTheme 改成 Mod-t，菜单仍会抢。
// `CmdOrCtrl+P`（搜索）**保留**：Mod-p 未被注册表占用，去掉只会让菜单少一个提示。
//
// role 类（undo / redo / selectAll）与注册表 Mod-z / Mod-y / Mod-a 同样重叠（E-4）。
// role 的默认 accelerator 由 Electron 自己赋，删不掉，只能**显式压掉**：
// `accelerator: ''` 表示「不注册加速器」，`registerAccelerator: false` 双保险 ——
// 两者都写给的是「Electron 是否接受空串」这个实测不确定的点（见 tmp/t05-role-probe）。
// cut / copy / paste 不与注册表重叠，保持默认。
// ============================================================================
function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建笔记',
          click: () => {
            mainWindow?.webContents.send('menu:new-note')
          }
        },
        {
          label: '打开文件夹',
          click: () => {
            mainWindow?.webContents.send('menu:open')
          }
        },
        { type: 'separator' },
        {
          label: '保存',
          click: () => {
            mainWindow?.webContents.send('menu:save')
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', accelerator: '', registerAccelerator: false },
        { role: 'redo', accelerator: '', registerAccelerator: false },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll', accelerator: '', registerAccelerator: false }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '切换侧栏',
          click: () => {
            mainWindow?.webContents.send('menu:toggle-sidebar')
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' }
      ]
    },
    {
      label: '工具',
      submenu: [
        {
          label: '搜索',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            mainWindow?.webContents.send('menu:search')
          }
        },
        {
          label: '命令面板',
          click: () => {
            mainWindow?.webContents.send('menu:command-palette')
          }
        },
        { type: 'separator' },
        {
          label: '切换主题',
          click: () => {
            mainWindow?.webContents.send('menu:toggle-theme')
          }
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Choyeon Note',
          click: () => {
            app.showAboutPanel()
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('window:is-maximized', () => {
  return mainWindow?.isMaximized()
})

ipcMain.handle('app:get-version', () => {
  return app.getVersion()
})

ipcMain.handle('app:select-notes-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择笔记存储文件夹',
    defaultPath: path.join(os.homedir(), 'Documents')
  })
  
  if (!result.canceled && result.filePaths.length > 0) {
    const ok = await applyNotesPath(result.filePaths[0])
    return ok ? notesPath : null
  }
  return null
})

ipcMain.handle('app:get-notes-path', () => {
  return notesPath
})

ipcMain.handle('app:set-notes-path', async (_, candidate) => {
  // 这里的校验是整套 fs 白名单的信任根，绝不能放行任意路径。
  // 只接受「已存在的目录」，且拒绝盘符根 / 用户主目录本身。
  return await applyNotesPath(candidate)
})

ipcMain.handle('fs:read-directory', async (_, dirPath) => {
  try {
    const safePath = await validatePathAsync(notesPath, dirPath)
    const files = await fsp.readdir(safePath, { withFileTypes: true })
    const result = []

    for (const file of files) {
      if (file.name.startsWith('.')) continue

      const filePath = path.join(safePath, file.name)
      // 目录树里的符号链接可能指向库外，读取它会绕过边界 → 直接跳过
      if (file.isSymbolicLink()) continue

      // readdir(withFileTypes) 已能区分目录/文件，只有真正需要 size/mtime 时才 stat
      const stats = file.isDirectory()
        ? { size: 0, mtime: null, ctime: null }
        : await fsp.stat(filePath)

      result.push({
        name: file.name,
        path: filePath,
        isDirectory: file.isDirectory(),
        isFile: file.isFile(),
        extension: file.isFile() ? path.extname(file.name).toLowerCase() : '',
        size: stats.size,
        mtime: stats.mtime ? stats.mtime.getTime() : 0,
        ctime: stats.ctime ? stats.ctime.getTime() : 0
      })
    }

    return result
  } catch (error) {
    console.error('Error reading directory:', error.message)
    return []
  }
})

// 递归遍历的深度上限：防止遇到异常深的目录树时 IPC 长时间阻塞
const MAX_SCAN_DEPTH = 32

ipcMain.handle('fs:read-directory-recursive', async (_, dirPath) => {
  try {
    const safeBase = await validatePathAsync(notesPath, dirPath)
    const result = []

    async function readDir(currentPath, relativePath = '', depth = 0) {
      if (depth > MAX_SCAN_DEPTH) return
      const files = await fsp.readdir(currentPath, { withFileTypes: true })

      // 同一目录内的多个文件之间没有依赖，逐个 await stat 会让耗时变成 Σ 单次
      // 往返（大目录上直接线性放大）。这里先收集候选文件，再并发 stat；
      // 目录的递归下探仍保持串行，保证 result 的遍历顺序不变。
      const pending = []

      for (const file of files) {
        if (file.name.startsWith('.')) continue

        const filePath = path.join(currentPath, file.name)
        if (file.isSymbolicLink()) continue // 同上：跳过符号链接

        const fileRelativePath = relativePath ? `${relativePath}/${file.name}` : file.name

        if (file.isDirectory()) {
          await readDir(filePath, fileRelativePath, depth + 1)
        } else if (file.isFile() && NOTE_FILE_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
          pending.push({
            name: file.name,
            path: filePath,
            relativePath: fileRelativePath,
            extension: path.extname(file.name).toLowerCase()
          })
        }
      }

      if (pending.length === 0) return
      const statsList = await Promise.all(pending.map((entry) => fsp.stat(entry.path)))
      pending.forEach((entry, index) => {
        const stats = statsList[index]
        result.push({
          name: entry.name,
          path: entry.path,
          relativePath: entry.relativePath,
          isDirectory: false,
          isFile: true,
          extension: entry.extension,
          size: stats.size,
          mtime: stats.mtime.getTime(),
          ctime: stats.ctime.getTime()
        })
      })
    }

    await readDir(safeBase)
    return result
  } catch (error) {
    console.error('Error reading directory recursively:', error.message)
    return []
  }
})

// ===== 笔记目录监听：外部改动（其它设备同步 / 手动编辑）自动刷新 =====
// Node 的 fs.watch({ recursive: true }) 在 Linux 上不可用（会抛错或静默退化为单层），
// 所以 Linux 走「手动收集子目录 + 逐目录 watch」，其余平台用原生递归。
// 上面的 `const watchers` 已在文件顶部声明 —— 这里复用它，不要再声明一次
// （曾经重复声明导致 main.cjs 直接 SyntaxError，Electron 起不来；
//   vite build 不编译 electron/，所以只有真启动才暴露）。

function startWatcherOn (dir) {
  const w = fsSync.watch(
    dir,
    process.platform === 'linux' ? {} : { recursive: true },
    (_eventType, filename) => {
      if (!filename) return
      if (!NOTE_FILE_EXTENSIONS.has(path.extname(String(filename)).toLowerCase())) return
      const changedPath = path.join(dir, String(filename))
      if (isSelfWrite(changedPath)) return
      if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
      watchDebounceTimer = setTimeout(() => {
        watchDebounceTimer = null
        mainWindow?.webContents.send('notes:external-change', {
          root: dir,
          file: String(filename)
        })
      }, WATCH_DEBOUNCE_MS)
    }
  )
  watchers.push(w)
}

async function collectSubdirectories (root) {
  const dirs = [root]
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      dirs.push(full)
      stack.push(full)
    }
  }
  return dirs
}

ipcMain.handle('fs:watch-notes', async (_, dirPath) => {
  try {
    const safePath = await validatePathAsync(notesPath, dirPath || notesPath)
    stopNotesWatcher()

    if (process.platform === 'linux') {
      const dirs = await collectSubdirectories(safePath)
      for (const dir of dirs) {
        try { startWatcherOn(dir) } catch (err) { /* 单个目录失败不影响整体 */ }
      }
    } else {
      startWatcherOn(safePath)
    }
    return true
  } catch (error) {
    console.error('Error watching notes directory:', error.message)
    return false
  }
})

ipcMain.handle('fs:unwatch-notes', async () => {
  stopNotesWatcher()
  return true
})

ipcMain.handle('fs:read-file', async (_, filePath) => {
  try {
    const safePath = await validatePathAsync(notesPath, filePath)
    const content = await fsp.readFile(safePath, 'utf-8')
    return content
  } catch (error) {
    console.error('Error reading file:', error.message)
    return null
  }
})

// ===== fs:read-files：批量读取文件内容 =====
// 搜索 / 全文索引这类场景要一次读几十上百个文件，逐个 fs:read-file 会把 IPC
// 往返次数线性放大。这里仍然逐个走 validatePathAsync（安全边界不放宽），
// 但并发执行；单个文件失败只记进 errors，不影响其余。
// 并发上限是为了避免一次打开过多 fd 触发 EMFILE。
const MAX_READ_FILES_CONCURRENCY = 16

ipcMain.handle('fs:read-files', async (_, payload) => {
  const requestedPaths = Array.isArray(payload && payload.paths) ? payload.paths : []
  // 按入参下标回填，保证返回顺序与请求顺序一致（便于渲染侧对齐结果）
  const slots = new Array(requestedPaths.length)
  const errors = []
  let cursor = 0

  async function worker() {
    while (cursor < requestedPaths.length) {
      const index = cursor++
      const filePath = requestedPaths[index]
      try {
        const safePath = await validatePathAsync(notesPath, filePath)
        slots[index] = { path: safePath, content: await fsp.readFile(safePath, 'utf-8') }
      } catch (error) {
        console.error('Error reading file in batch:', filePath, error.message)
        errors.push({ path: String(filePath), error: error.message })
      }
    }
  }

  const workerCount = Math.min(MAX_READ_FILES_CONCURRENCY, requestedPaths.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return { ok: true, files: slots.filter((slot) => slot !== undefined), errors }
})

// ===== fs:write-file =====
// 返回值是**双形态**的，这是刻意的向后兼容：
//   · 不传 options（或 options.detail !== true）→ 沿用老的 `true / false`。
//     四处调用方把结果当 boolean 用，其中两处还原样 return 给 UI，改了就是破坏性变更。
//   · 显式 `{ detail: true }` → 返回 `{ ok:false, error, errno, message }`，errno 就此
//     传到渲染侧（见 src/stores/note.js 的 safeWriteFile / describeIoFailure）。
// 失败一律由主进程 logger 记一条 `[ipc]` 记录（带 errno），与渲染侧记录落在同一个
// main.log 里 —— 这正是 R-L3「一次跨 IPC 失败能在同一份日志里串起来」的落点。
ipcMain.handle('fs:write-file', async (_, filePath, content, options) => {
  // content 不是字符串时 fs.writeFile 会把它 String() 成 "[object Object]"
  // 并「成功」落盘 —— 一篇笔记就这么被静默毁掉且不可恢复。宁可直接失败。
  const detail = !!(options && options.detail === true)
  if (typeof content !== 'string') {
    const failure = ioFailure(new Error('content-not-string'), 'invalid-content')
    ipcLog.error('写入文件失败：内容不是字符串', { op: 'fs:write-file', path: filePath, errno: failure.errno })
    return detail ? failure : false
  }
  try {
    const safePath = await validatePathAsync(notesPath, filePath)
    const dir = path.dirname(safePath)
    await fsp.mkdir(dir, { recursive: true })
    // 标记"本进程写入"，让文件监听器忽略随后的 change 事件，避免自己写自己触发重载
    markSelfWrite(safePath)
    await fsp.writeFile(safePath, content, 'utf-8')
    return true
  } catch (error) {
    ipcLog.error('写入文件失败', Object.assign({ op: 'fs:write-file', path: filePath }, ioInfo(error)))
    return detail ? ioFailure(error, 'write-failed') : false
  }
})

ipcMain.handle('fs:create-directory', async (_, dirPath) => {
  try {
    const safePath = await validatePathAsync(notesPath, dirPath)
    markSelfWrite(safePath)
    await fsp.mkdir(safePath, { recursive: true })
    return true
  } catch (error) {
    console.error('Error creating directory:', error.message)
    return false
  }
})

// ===== fs:delete-file：走系统回收站，而不是物理删除 =====
// 笔记应用里误删 = 数据永久丢失。Obsidian 的默认行为也是进 .trash / 系统回收站。
// shell.trashItem 在部分 Linux 环境不可用，失败时退化为「移动到库内 .trash 目录」，
// 绝不静默 unlink。
const TRASH_DIR_NAME = '.trash'

async function moveToLibraryTrash (safePath) {
  const trashRoot = await validatePathAsync(notesPath, path.join(notesPath, TRASH_DIR_NAME))
  await fsp.mkdir(trashRoot, { recursive: true })
  const base = path.basename(safePath)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(trashRoot, `${stamp}__${base}`)
  markSelfWrite(target)
  await fsp.rename(safePath, target)
}

ipcMain.handle('fs:delete-file', async (_, filePath) => {
  try {
    const safePath = await validatePathAsync(notesPath, filePath)
    markSelfWrite(safePath)
    try {
      await shell.trashItem(safePath)
      return true
    } catch (trashErr) {
      // 回收站不可用（无 GUI / 部分 Linux）→ 退化为库内 .trash 目录
      try {
        await moveToLibraryTrash(safePath)
        return true
      } catch (fallbackErr) {
        console.error('Error deleting file:', fallbackErr.message)
        return false
      }
    }
  } catch (error) {
    console.error('Error deleting file:', error.message)
    return false
  }
})

// 递归删除目录（删除文件夹用）。同样优先系统回收站。
ipcMain.handle('fs:remove-dir', async (_, dirPath) => {
  try {
    const safePath = await validatePathAsync(notesPath, dirPath)
    // 不允许删除笔记库自身
    if (path.resolve(safePath) === path.resolve(notesPath)) return false
    markSelfWrite(safePath)
    try {
      await shell.trashItem(safePath)
      return true
    } catch (trashErr) {
      try {
        await moveToLibraryTrash(safePath)
        return true
      } catch (fallbackErr) {
        console.error('Error removing directory:', fallbackErr.message)
        return false
      }
    }
  } catch (error) {
    console.error('Error removing directory:', error.message)
    return false
  }
})

// ============= fs:move-file：重命名/拖放移动时的原子操作 =============
// 为什么需要独立 IPC：之前没有该 API，moveNote/renameNote 只能走 writeFile + deleteFile
// 的 fallback，会出现「写入成功但删除失败 → 重复文件」或「跨分区需要 copy+unlink」等
// 不一致问题。这里优先用 fs.rename（POSIX 原子性/Windows 同 NTFS 卷内原子），失败时退化为
// copy+unlink 并返回 true/false 标志，让渲染侧能正确更新 note.filePath。
//
// 默认**拒绝覆盖已存在的目标**：重命名成已有标题时静默吞掉另一篇笔记是最糟的一类
// 数据丢失。调用方必须显式传 overwrite=true（UI 侧需二次确认）。
//
// 与 fs:write-file 不同，这里失败时**无条件**返回结构化 errno（不需要 detail 开关）：
// move 的失败原因（target-exists / permission / not-found…）是渲染侧 safeMoveFile 判断
// 下一步的唯一依据，返回裸 false 会让 diagnoseMoveFailure 只能靠只读探测去反推。
// `error: 'target-exists'` 这个字符串是存量契约（design §4.5 明确保留），不动。
ipcMain.handle('fs:move-file', async (_, oldPath, newPath, options) => {
  try {
    const safeOld = await validatePathAsync(notesPath, oldPath)
    const safeNew = await validatePathAsync(notesPath, newPath)
    if (safeOld === safeNew) return true

    const overwrite = options && options.overwrite === true
    if (!overwrite) {
      try {
        await fsp.access(safeNew, fsSync.constants.F_OK)
        return { ok: false, error: 'target-exists', errno: 'EEXIST', message: '目标已存在' }
      } catch (err) {
        // 目标不存在，可以安全移动
      }
    }

    // 目标目录预先创建
    await fsp.mkdir(path.dirname(safeNew), { recursive: true })
    markSelfWrite(safeOld)
    markSelfWrite(safeNew)
    try {
      await fsp.rename(safeOld, safeNew)
      return true
    } catch (renameErr) {
      // 跨设备 / 目录级 rename 不支持时 fallback：copy + unlink
      const stat = await fsp.stat(safeOld)
      if (stat.isFile()) {
        await fsp.copyFile(safeOld, safeNew)
        await fsp.unlink(safeOld)
        return true
      }
      throw renameErr
    }
  } catch (error) {
    ipcLog.error('移动文件失败', Object.assign({ op: 'fs:move-file', from: oldPath, to: newPath }, ioInfo(error)))
    return ioFailure(error, 'write-failed')
  }
})

ipcMain.handle('fs:file-exists', async (_, filePath) => {
  try {
    const safePath = await validatePathAsync(notesPath, filePath)
    await fsp.access(safePath, fsSync.constants.F_OK)
    return true
  } catch (error) {
    return false
  }
})

// 拼写数据持久化（userData/spell-data.json：ignoredWords / customDictionary 数组）
ipcMain.handle('spell:load', async () => {
  try {
    const raw = await fsp.readFile(spellDataFile(), 'utf-8')
    const data = JSON.parse(raw || '{}')
    return {
      ignoredWords: Array.isArray(data.ignoredWords) ? data.ignoredWords : [],
      customDictionary: Array.isArray(data.customDictionary) ? data.customDictionary : []
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ignoredWords: [], customDictionary: [] }
    }
    console.error('spell:load error:', err?.message || String(err))
    return { ignoredWords: [], customDictionary: [] }
  }
})

ipcMain.handle('spell:save', async (_, payload) => {
  try {
    const data = {
      ignoredWords: Array.isArray(payload?.ignoredWords) ? payload.ignoredWords : [],
      customDictionary: Array.isArray(payload?.customDictionary) ? payload.customDictionary : []
    }
    await fsp.writeFile(spellDataFile(), JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('spell:save error:', err?.message || String(err))
    return false
  }
})

// ============================================================================
// id ↔ path 映射表（T16 · R-F1 双轨稳定 id）
//
// 为什么必须有它：笔记 id 原本是**路径的哈希**，文件一移动 / 改名 id 就跟着变，
// 书签、最近打开、图谱坐标、编辑器当前笔记全部连坐失效。映射表把「id 由谁说了算」
// 从「当前路径」里摘出来 —— id 一旦进表就跟着文件走，路径怎么搬都不影响。
//
// 三条边界（与主进程其余通道的约定一致）：
//   ① 绝不写用户的 .md —— 映射表住 userData，与笔记库物理隔离；
//   ② 读写失败**不抛** —— 渲染侧在启动路径上读它，抛异常会让整个库打不开；
//      读不出来返回 null，渲染侧据此走 rebuildIdMap(existingPaths) 重建即可，
//      而重建出来的 id 与丢失前逐字相同（见 utils/noteIdentity.js 文件头）；
//   ③ 只做形状校验，不做语义校验 —— id 的一对一关系由渲染侧的纯内核保证，
//      主进程不抄第二份规则（抄两份迟早漂移，且漂移发生在主进程最难修）。
//
// 记录出口：这里用上面恢复的主进程统一 logger（`ipcLog` = createMainLogger('ipc')），
// 不再有自包含的临时出口。T16 期间曾因主进程 logger 被误还原而临时用过局部的
// logIdMap / ioShape，那份止血代码已随日志系统恢复而删除 —— 替换面就是下面两处
// 调用：`ipcLog.warn/error` 与 `ioInfo(error)`。
// ============================================================================

/**
 * 原子写：**先写 .tmp，再 rename 覆盖目标**。
 *
 * 为什么不能直接 writeFile 目标文件：这份 JSON 是 id 稳定性的唯一真相源。写一半断电
 * 会留下截断的 JSON，`JSON.parse` 失败 → 整张表被当成损坏 → 全库退回路径哈希，
 * 用户眼里的表现是「书签和图谱坐标一夜之间全乱了」。而 rename 在同一卷内是原子的：
 * 目标文件要么全是旧内容，要么全是新内容，不存在中间态。
 *
 * rename 失败时尽力删掉 tmp：否则每次失败都给 userData 留一个垃圾文件，攒多了会
 * 让人误以为「落盘写出来了但其实没有」。
 *
 * @param {string} file 目标文件绝对路径
 * @param {unknown} data 要写的数据（JSON.stringify 之前）
 * @returns {Promise<void>} 成功 resolve；失败抛出原始异常交给调用方记账
 */
async function writeJsonAtomic (file, data) {
  const tmp = `${file}.tmp`
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  try {
    await fsp.rename(tmp, file)
  } catch (error) {
    try {
      await fsp.rm(tmp, { force: true })
    } catch {
      // 清理失败无妨：tmp 不是真相源，下次写入会覆盖它
    }
    throw error
  }
}

/**
 * 读映射表。
 *
 * 返回约定（与渲染侧 utils/idMapStore.js 一一对应）：
 *   · `{ ok: true, data }`  —— 有一张可读的表（data 已过 JSON.parse，形状合法）；
 *   · `{ ok: true, data: null }` —— 文件不存在（首次运行的正常状态，**不记 warn**：
 *     每个新用户第一次启动都会走到，记了等于给日志里塞一条假故障）；
 *   · `{ ok: false, data: null, error, errno }` —— 读失败 / JSON 损坏 / 形状不对，
 *     已记一条 warn（ENOENT 之外的 IO 错误同样如此）。
 *
 * 刻意**不**在这里做 normalize（byId 由 byPath 反推之类）：那是渲染侧纯内核
 * `parseIdMap` 的职责，主进程只负责把字节安全地搬到对岸。
 */
ipcMain.handle('idmap:load', async () => {
  try {
    const raw = await fsp.readFile(idMapFile(), 'utf-8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') throw new Error('id-map-shape-invalid')
    return { ok: true, data }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, data: null }
    ipcLog.warn('读取 id 映射表失败', ioInfo(error))
    return {
      ok: false,
      data: null,
      error: (error && error.message) || 'read-failed',
      errno: (error && error.code) || ''
    }
  }
})

/**
 * 写映射表。
 *
 * `updatedAt` 由这里在写盘那一刻盖上 —— 纯内核不读时钟（同一份入参必须得到同一份
 * 返回值，否则「重建两次得到同一张表」没法断言），时间戳归落盘方负责。
 *
 * @returns {Promise<{ok: boolean, error?: string, errno?: string}>}
 */
ipcMain.handle('idmap:save', async (_, payload) => {
  // 形状校验：至少得是个带 byPath 对象的东西。不校验会被写成 `null` / `[]` 之类的
  // 东西，下次 load 拿回来 parseIdMap 会静默给一张空表 —— 「写了一整轮却什么都没
  // 留下」是最难查的一类故障，所以在入口挡掉并留一行 warn。
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !payload.byPath || typeof payload.byPath !== 'object') {
    ipcLog.warn('拒绝写入非法的 id 映射表', { reason: 'shape-invalid' })
    return { ok: false, error: 'shape-invalid', errno: '' }
  }
  try {
    await writeJsonAtomic(idMapFile(), { ...payload, updatedAt: Date.now() })
    return { ok: true }
  } catch (error) {
    ipcLog.error('写入 id 映射表失败', ioInfo(error))
    return {
      ok: false,
      error: (error && error.message) || 'write-failed',
      errno: (error && error.code) || ''
    }
  }
})

function setupAutoUpdater() {
  // updateConfigPath 指向不存在的文件会让 dev 下每次检查都失败；
  // 生产态由 electron-builder 生成的 app-update.yml 自动生效，无需指定。
  if (isDev && fsSync.existsSync(path.join(__dirname, '..', 'dev-app-update.yml'))) {
    autoUpdater.updateConfigPath = path.join(__dirname, '..', 'dev-app-update.yml')
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('updater:checking')
  })

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('updater:update-available', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    mainWindow?.webContents.send('updater:update-not-available', info)
  })

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('updater:error', err.message)
  })

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow?.webContents.send('updater:download-progress', progressObj)
  })

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('updater:update-downloaded', info)
  })
}

ipcMain.handle('updater:check-for-updates', async () => {
  try {
    await autoUpdater.checkForUpdates()
    return true
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('updater:download-update', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('updater:quit-and-install', () => {
  autoUpdater.quitAndInstall(false, true)
})

// ============================================================
// Bing 每日壁纸
// ------------------------------------------------------------
// 必须放主进程：渲染进程直连 www.bing.com/HPImageArchive.aspx 会被 CORS 拦掉
// （该接口不返回 Access-Control-Allow-Origin），所以功能一直是"开关能开、图不来"。
// 用 net.request 还能自动走系统代理设置。
// ============================================================
const BING_MARKETS = ['zh-CN', 'en-US']

function netGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url })
    let body = ''
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    req.setHeader('Accept', 'application/json')

    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume() // 读完响应体，避免连接悬挂
        fail(new Error('HTTP ' + res.statusCode))
        return
      }
      res.on('data', (chunk) => { body += chunk.toString() })
      res.on('end', () => {
        if (settled) return
        settled = true
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error('响应不是合法 JSON'))
        }
      })
    })
    req.on('error', fail)
    req.on('timeout', () => { req.abort(); fail(new Error('请求超时')) })

    req.setTimeout ? req.setTimeout(15000) : null
    req.end()
  })
}

ipcMain.handle('bing:fetch-wallpaper', async (_, market = 'zh-CN') => {
  const markets = BING_MARKETS.includes(market) ? [market, ...BING_MARKETS.filter(m => m !== market)] : [market]
  let lastError = null

  for (const mkt of markets) {
    try {
      const data = await netGetJson(
        `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=${encodeURIComponent(mkt)}`
      )
      const image = data && data.images && data.images[0]
      if (!image || !image.url) {
        lastError = new Error('接口未返回图片地址')
        continue
      }
      return {
        url: /^https?:/.test(image.url) ? image.url : 'https://www.bing.com' + image.url,
        title: image.title || '',
        copyright: image.copyright || '',
        date: image.startdate || '',
        market: mkt
      }
    } catch (err) {
      lastError = err
    }
  }
  return { error: (lastError && lastError.message) || '获取 Bing 壁纸失败' }
})

// ============================================================
// 退出前刷盘
// ------------------------------------------------------------
// 渲染侧的自动保存是 500ms 防抖，用户敲完字立刻退出会丢掉最后一段编辑。
// 这里在 before-quit 时先问渲染进程要一次全量 flush，拿到回执（或超时）后再退出。
// ============================================================
const FLUSH_TIMEOUT_MS = 3000
let flushResolve = null

ipcMain.on('app:flush-complete', () => {
  if (flushResolve) {
    const resolve = flushResolve
    flushResolve = null
    resolve(true)
  }
})

function requestFlush () {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(false)
      return
    }
    let settled = false
    // timer 必须声明在 done 之前：done 内部 clearTimeout(timer)，若 timer 声明在
    // 其后会落入 TDZ —— 现在只是靠「先注册超时才会回调」的时序侥幸不报错。
    let timer = null
    const done = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (flushResolve === done) flushResolve = null
      resolve(value)
    }
    timer = setTimeout(() => {
      ipcLog.warn('退出前刷盘超时，强制退出', { timeoutMs: FLUSH_TIMEOUT_MS })
      done(false)
    }, FLUSH_TIMEOUT_MS)
    flushResolve = done
    mainWindow.webContents.send('app:flush-all')
  })
}

app.on('before-quit', (event) => {
  if (flushResolve) return // 已在 flush 中，避免重入
  event.preventDefault()
  requestFlush().then(() => {
    // app.exit(0) 不派发 window-all-closed，watcher 不会被停：
    // 句柄泄漏，且退出过程中 watcher 回调仍可能触发 Sub-frame 报错。必须显式停。
    stopNotesWatcher()
    app.exit(0)
  })
})

// 单实例：两个进程同时监听同一目录 + 各自防抖写盘会互相覆盖
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 日志先于窗口：启动阶段（loadSettings / createWindow）的任何失败都要能落到
    // main.log 里，否则「窗口没出来」这种最需要证据的故障恰恰什么都没留下。
    await markSessionStart()
    await loadSettings()
    createWindow()
    createMenu()
    setupAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  stopNotesWatcher()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
