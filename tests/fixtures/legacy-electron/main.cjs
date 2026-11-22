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
// 2) 其余事件合并到 WATCH_DEBOUNCE_MS 窗口里，按路径去重后**整批**发出一次
//
// T21（批次 4 · R-F4 / R-F7）两处契约级改动：
//   · **取消扩展名白名单**。以前 fs:watch-notes 只放行 .md/.markdown/.txt，用户在
//     Obsidian 里改了 .canvas 或其它文件，本应用毫无反应（R-F7）。现在主进程把目录
//     里发生的一切都报上来（含 .canvas / 子目录 / 无扩展名文件），「哪些算笔记」下沉
//     给渲染侧 reconcile 内核的 isNoteExtension 判断 —— 主进程不再替业务做取舍。
//   · **payload 从「无参」升级为变更清单**：
//       Array<{ path: string, kind: 'add' | 'change' | 'unlink' }>   // path 一律绝对路径
//     渲染侧据此做增量 reconcile，不再无条件整库 loadNotesFromPath() —— 后者会在用户
//     打字时把编辑器内容冲掉（R-F5）。这是与 T22 的固定契约，改一个字母都会错位。
const watchers = []
let watchDebounceTimer = null
const WATCH_DEBOUNCE_MS = 600
// 首帧就绪后仍未显示窗口时的强制显示等待时间（见 createWindow 内的兜底逻辑）
const SHOW_FALLBACK_MS = 3000

// 单次去抖窗口内累积的变更表：绝对路径 -> kind
const pendingWatchChanges = new Map()
// 一次窗口最多攒多少条就强制 flush。持续的大批量变更（首次同步 dropbox 全库）如果
// 不设上限，清单会无限膨胀，渲染侧一次收到几万条也处理不动。
const WATCH_MAX_BATCH = 2000
// kind 的信息量权重：add 说明「渲染侧索引里没有它」，比 change 更值钱，不能被后面的
// change 覆盖掉（否则新增文件会被降级成内容刷新，丢掉「要分配新 id」这件事）。
const WATCH_KIND_PRIORITY = Object.freeze({ unlink: 1, change: 2, add: 3 })
// 启监听那一刻的全量基线快照，只用来区分 add 与 change：见过的路径算 change，
// 没见过的算 add。**快照本身不产出任何变更事件**，纯粹是判定基线（详见 fs:watch-notes）。
const knownWatchPaths = new Set()
const WATCH_MAX_KNOWN = 50000
// 当前监听根 + 是否已挂过去重表（重复 fs:watch-notes 不能叠加监听器）
const watchedDirPaths = new Set()
let watchRootPath = ''
// Linux 上 fs.watch({recursive:true}) 不可用（要么抛错要么静默退化成单层），必须给
// 每个子目录各挂一个 watcher；其余平台用原生递归。此标记让非递归模式下的「新子目录
// 动态补挂」只在需要时生效。
let watchIsSubscribedPerDir = false
// 隐藏目录（.git / .trash / .obsidian 之类）既不监听也不上报。这不是扩展名过滤，而是
// 沿袭既有实现里 collectSubdirectories 的约定（`entry.name.startsWith('.')` 直接跳过）：
// 那些目录的 churn 量级和笔记根本不在一个数量级，且它们永远不可能是用户的笔记。
// 注意只作用于路径中间的段落与末段同为隐藏的情况，普通的 `.hidden.md` 见下方实现。
const WATCH_HIDDEN_SEGMENT_RE = /(^|[\\/])\.[^\\/]*/

/**
 * watcher 模块专用 logger。
 * 必须**惰性**构造：LOG_MODULES 是本文件里靠后的 const（TDZ），在模块顶层直接
 * createMainLogger(LOG_MODULES.watcher) 会抛 ReferenceError —— 而这里的常量块在文件
 * 最前面。第一次真正写日志时（IPC 调用之后）LOG_MODULES 早已初始化完毕。
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
let watcherLogRef = null
function watcherLog () {
  if (!watcherLogRef) watcherLogRef = createMainLogger(LOG_MODULES.watcher)
  return watcherLogRef
}

/** 路径是否落在当前监听根之内（越界事件一律丢弃，兜住安全边界） */
function isUnderWatchRoot (targetPath) {
  if (!watchRootPath) return true
  const rel = path.relative(watchRootPath, String(targetPath))
  if (rel === '') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 隐藏段过滤：root 之下的任一段以 `.` 开头就忽略（含隐藏目录里的所有文件） */
function isHiddenWatchPath (targetPath) {
  if (!watchRootPath) return false
  const rel = path.relative(watchRootPath, String(targetPath))
  return WATCH_HIDDEN_SEGMENT_RE.test(rel)
}

/**
 * 判定单个路径的变更种类。
 * 以磁盘现状 + 基线快照为准：盘上没有 = unlink；第一次见到 = add；其余 = change。
 * 判定的同时维护 knownWatchPaths，保证同一窗口内的第二条事件拿到的是最新认知
 * （例如 add 之后紧跟着的 change 会被认成 change，而不是再报一次 add）。
 * @param {string} targetPath
 * @returns {'add'|'change'|'unlink'}
 */
function classifyWatchPath (targetPath) {
  let exists = false
  try {
    exists = fsSync.existsSync(targetPath)
  } catch (err) {
    // stat 失败（权限抖动 / 路径过长）按「不在了」处理，宁可让渲染侧摘掉一条索引，
    // 也好过把一条幽灵笔记留在列表里。
    exists = false
  }
  if (!exists) {
    knownWatchPaths.delete(targetPath)
    return 'unlink'
  }
  if (knownWatchPaths.has(targetPath)) return 'change'
  knownWatchPaths.add(targetPath)
  return 'add'
}

/**
 * 把一条变更合并进当前窗口。同一路径多条事件按下列裁决：
 *   add + unlink  → 删条目（建了就删，盘上不留痕迹，渲染侧索引里本来也没有它）
 *   unlink + 复现 → change（删了又回来，当作内容刷新，渲染侧 upsert 即可）
 *   其余          → 取信息量更高的那个（见 WATCH_KIND_PRIORITY）
 * @param {string} targetPath
 * @param {'add'|'change'|'unlink'} kind
 * @returns {void}
 */
function mergeWatchChange (targetPath, kind) {
  const prev = pendingWatchChanges.get(targetPath)
  if (prev === undefined) {
    pendingWatchChanges.set(targetPath, kind)
    return
  }
  if (prev === kind) return
  if (prev === 'add' && kind === 'unlink') {
    pendingWatchChanges.delete(targetPath)
    return
  }
  if (prev === 'unlink' && (kind === 'add' || kind === 'change')) {
    pendingWatchChanges.set(targetPath, 'change')
    return
  }
  if (WATCH_KIND_PRIORITY[kind] > WATCH_KIND_PRIORITY[prev]) {
    pendingWatchChanges.set(targetPath, kind)
  }
}

/** 非递归模式下给新出现的子目录补挂 watcher，否则它里面的新文件永远没人监听 */
function ensureSubdirectoryWatched (targetPath) {
  if (!watchIsSubscribedPerDir) return
  try {
    const stat = fsSync.statSync(targetPath)
    if (!stat.isDirectory()) return
  } catch (err) {
    return
  }
  startWatcherOn(targetPath)
}

/**
 * 单个 fs.watch 事件入口。这里绝不能抛 —— fs.FSWatcher 回调里的异常会直接炸到
 * libuv，整个主进程跟着崩，所以每个分支都收了口。
 * @param {string} dir 触发事件的目录（绝对路径）
 * @param {string} filename 文件名；Linux 非递归模式下无目录前缀，递归模式下带相对路径
 * @returns {void}
 */
function onWatchEvent (dir, filename) {
  // 没有监听根 = 已经 unwatch（或还没 watch）。此时到达的事件一律丢弃：监听器已被
  // close，正常情况下不会再有回调，但慢一拍的回调、或某次 delete 之后仍被强引用着的
  // watcher 都可能把事件递到这儿 —— 继续处理会让「已经停止监听」变成一句空话。
  if (!watchRootPath) return
  if (!filename) return
  const targetPath = path.resolve(dir, String(filename))
  if (!isUnderWatchRoot(targetPath)) return
  if (isHiddenWatchPath(targetPath)) return
  // 自己刚写过的路径不回灌：否则每次自动保存都会触发一轮"外部变更"
  if (isSelfWrite(targetPath)) return

  const kind = classifyWatchPath(targetPath)
  if (kind !== 'unlink') ensureSubdirectoryWatched(targetPath)
  mergeWatchChange(targetPath, kind)

  if (pendingWatchChanges.size >= WATCH_MAX_BATCH) {
    flushWatchChanges()
    return
  }
  // 去抖：窗口从「窗口内第一个事件」起算，之后到达的事件**只入队不续期**。
  // 旧实现是每条事件都 clearTimeout 重新计时，一旦遇到持续变更流（同步盘在灌、
  // 用户批量粘贴图片）会被无限续期、永远发不出去。改成首个事件起算后，最迟 600ms
  // 必定 flush 一次，后续事件进入下一个窗口。
  if (watchDebounceTimer) return
  watchDebounceTimer = setTimeout(() => flushWatchChanges(), WATCH_DEBOUNCE_MS)
}

/** 汇总当前窗口的变更清单，一次发出。path 为绝对路径，kind ∈ add/change/unlink */
function flushWatchChanges () {
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  if (pendingWatchChanges.size === 0) return

  const changes = []
  const kinds = { add: 0, change: 0, unlink: 0 }
  for (const [changePath, kind] of pendingWatchChanges) {
    changes.push({ path: changePath, kind })
    kinds[kind] += 1
  }
  pendingWatchChanges.clear()

  // 日志只放计数与 basename：绝对路径属于用户隐私，`root`/`sample` 这类键不在
  // SENSITIVE_KEY_PATTERN 里，会被原样落盘，所以干脆一个完整路径都不写出去。
  watcherLog().info('外部变更批次已发出', {
    root: path.basename(watchRootPath) || '(未设置)',
    count: changes.length,
    add: kinds.add,
    change: kinds.change,
    unlink: kinds.unlink
  })

  const winRef = mainWindow
  if (winRef && winRef.webContents && typeof winRef.webContents.send === 'function') {
    if (typeof winRef.isDestroyed === 'function' && winRef.isDestroyed()) return
    winRef.webContents.send('notes:external-change', changes)
  } else {
    watcherLog().warn('尚无可用窗口，本批变更丢弃', { count: changes.length })
  }
}

function stopNotesWatcher() {
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  pendingWatchChanges.clear()
  knownWatchPaths.clear()
  watchedDirPaths.clear()
  watchRootPath = ''
  watchIsSubscribedPerDir = false
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

/**
 * 给单个目录挂 watcher。幂等：同一个目录重复调用不会叠加监听器
 * （fs:watch-notes 可能被渲染侧多次调用，叠加会让每条变更被上报 N 次）。
 * @param {string} dir 绝对路径
 * @returns {boolean} 是否真的新挂了一个监听
 */
function startWatcherOn (dir) {
  if (watchedDirPaths.has(dir)) return false
  watchedDirPaths.add(dir)
  try {
    const w = fsSync.watch(
      dir,
      watchIsSubscribedPerDir ? {} : { recursive: true },
      (_eventType, filename) => {
        try {
          onWatchEvent(dir, filename)
        } catch (err) {
          // 回调里抛异常会一路炸到 libuv，这里必须收住，
          // 但也要留下痕迹：静默吞掉会让「监听突然失灵」变成无头案。
          watcherLog().error('处理监听事件失败', {
            error: String((err && err.message) || err)
          })
        }
      }
    )
    // fs.FSWatcher 会在底层出问题时 emit 'error'，没有监听者会变成未捕获异常
    if (w && typeof w.on === 'function') {
      w.on('error', (err) => {
        watcherLog().error('监听器内部出错，已忽略', {
          error: String((err && err.message) || err)
        })
      })
    }
    watchers.push(w)
    return true
  } catch (err) {
    watchedDirPaths.delete(dir)
    watcherLog().error('挂载监听器失败', {
      error: String((err && err.message) || err),
      errno: inferErrno(err)
    })
    return false
  }
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

/**
 * 采集启监听那一刻的全量快照，作为 add / change 的判定基线。
 *
 * 这份基线**不发出任何事件** —— 它的唯一作用是让「存量文件的第一次改动」被认成
 * change 而不是 add（否则用户改一个旧笔记，渲染侧会以为来了个新笔记）。
 * 数量有上限：超大型仓库只记前 WATCH_MAX_KNOWN 条，多余的会在首次改动时被认成 add，
 * 由渲染侧 upsert 兜住，不会误判成删除。
 * @param {string} root 监听根（绝对路径）
 * @returns {Promise<number>} 记入基线的条目数
 */
async function seedKnownWatchPaths (root) {
  knownWatchPaths.clear()
  const stack = [root]
  let counted = 0
  while (stack.length && counted < WATCH_MAX_KNOWN) {
    const current = stack.pop()
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      knownWatchPaths.add(full)
      counted += 1
      if (counted >= WATCH_MAX_KNOWN) break
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')) {
        stack.push(full)
      }
    }
  }
  return counted
}

ipcMain.handle('fs:watch-notes', async (_, dirPath) => {
  try {
    const safePath = await validatePathAsync(notesPath, dirPath || notesPath)
    // 先停干净再重挂：这是约定好的启停语义 —— 重复调用是**替换**而非叠加
    stopNotesWatcher()

    watchRootPath = safePath
    watchIsSubscribedPerDir = process.platform === 'linux'

    if (watchIsSubscribedPerDir) {
      const dirs = await collectSubdirectories(safePath)
      await seedKnownWatchPaths(safePath)
      let mounted = 0
      for (const dir of dirs) {
        if (startWatcherOn(dir)) mounted += 1
      }
      if (mounted === 0) {
        // 一个都没挂上却回 true，渲染侧会以为"自动同步"是开着的 —— 这是假信号
        watcherLog().error('笔记目录监听未启动：没有任何子目录挂载成功', {
          error: 'no-watcher-mounted',
          errno: 'EACCES'
        })
        return false
      }
      watcherLog().info('已启动笔记目录监听（Linux 逐子目录模式）', {
        root: path.basename(safePath),
        dirs: mounted,
        baseline: knownWatchPaths.size
      })
    } else {
      await seedKnownWatchPaths(safePath)
      const ok = startWatcherOn(safePath)
      if (!ok) {
        watcherLog().error('笔记目录监听未启动：挂载失败', {
          error: 'watch-failed',
          errno: 'EIO'
        })
        return false
      }
      watcherLog().info('已启动笔记目录监听（原生递归模式）', {
        root: path.basename(safePath),
        ok,
        baseline: knownWatchPaths.size
      })
    }
    return true
  } catch (error) {
    // 监听失败（目录不在了 / 没权限 / 路径越界）一律降级：记 error + 返回 false，
    // 绝不重抛 —— 渲染侧拿假的布尔值也比主进程崩掉强。
    watcherLog().error('启动笔记目录监听失败', {
      error: String((error && error.message) || error),
      errno: inferErrno(error)
    })
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

// ===== 回收站：优先系统回收站，不可用时退化为库内 .trash（R-D5 / T27）=====
// 笔记应用里误删 = 数据永久丢失。Obsidian 的默认行为也是进 .trash / 系统回收站。
// shell.trashItem 在部分 Linux 环境不可用，失败时退化为「移动到库内 .trash 目录」，
// 绝不静默 unlink。
//
// T27 的职责升级：退化为库内 .trash 时必须**留下原始路径**，否则那批文件虽然活着，
// 却永远回不到原来的文件夹 —— 那是比看不见更难受的一种丢。元数据写在 sidecar
// （`<条目名>.trashmeta.json`）里，**一个字节都不碰用户的 .md**。
//
// ⚠️ 这里的实现与 src/utils/trashIndex.js 是**两份等价代码**。不是偷懒：electron-builder
// 只打包 dist/** 与 electron/**，主进程 require('src/...') 在生产包里必然
// MODULE_NOT_FOUND（理由详见 tests/mainLogParity.test.js 头部）。副本会漂移，所以
// tests/trashIndex.test.js 的最后一组用例做源码级比对（常量、字段名、关键行为标记），
// 改一侧忘了另一侧会立刻变红。
const TRASH_DIR_NAME = '.trash'
const TRASH_META_SUFFIX = '.trashmeta.json'
const TRASH_META_VERSION = 1
const TRASH_NAME_SEP = '__'
const TRASH_RETENTION_DAYS = 30
const TRASH_DAY_MS = 24 * 60 * 60 * 1000

/** 时间戳 → 文件名安全的戳（冒号与点换 '-'） */
function trashStampOf (ms) {
  return new Date(Number(ms) || 0).toISOString().replace(/[:.]/g, '-')
}

/** `<戳>__<原始文件名>` —— 与 src/utils/trashIndex.js 的 makeTrashName 同构 */
function trashNameOf (base, ms) {
  return `${trashStampOf(ms)}${TRASH_NAME_SEP}${base}`
}

/** 条目路径 → sidecar 元数据路径 */
function metaPathOf (trashPath) {
  return `${trashPath}${TRASH_META_SUFFIX}`
}

/** .trash 里该忽略的名字：元数据 sidecar、点文件 */
function isTrashNoise (name) {
  return !name || name.startsWith('.') || name.endsWith(TRASH_META_SUFFIX)
}

/** 从 `<戳>__<base>` 里反解删除时间；解不出来返回 0 */
function trashStampParse (name) {
  const sep = typeof name === 'string' ? name.indexOf(TRASH_NAME_SEP) : -1
  if (sep <= 0) return 0
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name.slice(0, sep))
  if (!m) return 0
  const ts = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])
  )
  return Number.isFinite(ts) ? ts : 0
}

/** 失败原因要过一遍脱敏再交给 UI —— 这类 message 最爱夹绝对路径 */
function trashFailureReason (error) {
  const raw = (error && error.message) ? String(error.message) : String(error || '')
  return logSanitizeString(raw, { home: homeDir(), maxString: LOG_CONTENT_MAX })
}

/**
 * 读 sidecar。不存在 / 坏 JSON / 字段缺失一律降级为 null：元数据损坏应该让列表
 * 少一条信息，而不是让整个面板打不开。
 * @param {string} metaPath
 * @returns {Promise<Object|null>}
 */
async function readTrashMeta (metaPath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.originPath !== 'string' || parsed.originPath === '') return null
    return parsed
  } catch (error) {
    return null
  }
}

/**
 * 写 sidecar。
 * @param {string} trashPath .trash 里的条目路径
 * @param {Object} meta 元数据体
 * @returns {Promise<void>}
 */
async function writeTrashMeta (trashPath, meta) {
  await fsp.writeFile(metaPathOf(trashPath), JSON.stringify(meta, null, 2), 'utf-8')
}

/**
 * 递归统计体积（目录才递归，文件一次 stat 完事）。失败按 0 处理 —— 体积只是展示
 * 信息，不该因为它让整个列表失败。
 * @param {string} p
 * @param {number} depth
 * @returns {Promise<number>}
 */
async function trashSizeOf (p, depth = 0) {
  try {
    const st = await fsp.stat(p)
    if (!st.isDirectory()) return st.size
    if (depth >= 12) return st.size
    const children = await fsp.readdir(p, { withFileTypes: true })
    let total = 0
    for (const child of children) {
      if (isTrashNoise(child.name)) continue
      total += await trashSizeOf(path.join(p, child.name), depth + 1)
    }
    return total
  } catch (error) {
    return 0
  }
}

/**
 * .trash 目录的绝对路径（顺带做一次边界校验：它必须落在笔记库里）。
 * @returns {Promise<string>}
 */
async function trashRootPath () {
  return await validatePathAsync(notesPath, path.join(notesPath, TRASH_DIR_NAME))
}

/**
 * 构造列表里的一条记录。
 *
 * @param {string} trashRoot
 * @param {string} name .trash 里的条目名
 * @param {number} nowMs
 * @param {number} retentionDays
 * @returns {Promise<Object|null>} 条目；stat 不到（竞态已被清理）返回 null
 */
async function buildTrashEntry (trashRoot, name, nowMs, retentionDays) {
  const trashPath = path.join(trashRoot, name)
  let st = null
  try {
    st = await fsp.stat(trashPath)
  } catch (error) {
    return null
  }
  const kind = st.isDirectory() ? 'dir' : 'file'
  const meta = await readTrashMeta(metaPathOf(trashPath))
  const nameStamp = trashStampParse(name)

  // trashedAt 三级取值：sidecar → 文件名戳 → mtime
  let trashedAt = 0
  let degraded = false
  let degradedReason = null
  if (meta && Number.isFinite(Number(meta.trashedAt)) && Number(meta.trashedAt) > 0) {
    trashedAt = Math.floor(Number(meta.trashedAt))
  } else if (nameStamp > 0) {
    trashedAt = nameStamp
    degraded = true
    degradedReason = 'meta-missing'
  } else {
    trashedAt = Math.floor(st.mtimeMs) || nowMs
    degraded = true
    degradedReason = 'no-timestamp'
  }

  // originPath 降级链：sidecar → <戳>__ 之后的 base → 整个名字，都放在**库根**下
  const parsedBase = nameStamp > 0 ? name.slice(name.indexOf(TRASH_NAME_SEP) + TRASH_NAME_SEP.length) : name
  const displayName = (meta && typeof meta.name === 'string' && meta.name) || parsedBase || name
  const originPath = (meta && meta.originPath) ? meta.originPath : path.join(notesPath, displayName)
  if (!meta) {
    degraded = true
    if (!degradedReason) degradedReason = 'meta-missing'
  }

  const size = await trashSizeOf(trashPath, 0)
  return {
    id: name,
    name: displayName,
    trashName: name,
    trashPath,
    metaPath: metaPathOf(trashPath),
    originPath,
    trashedAt,
    trashedAtISO: new Date(trashedAt).toISOString(),
    purgeAt: trashedAt + retentionDays * TRASH_DAY_MS,
    size,
    kind,
    degraded,
    degradedReason,
    hasMeta: !!meta,
    outsideRoot: !isSafeNotesPath(originPath),
    expired: trashedAt > 0 && trashedAt <= nowMs - retentionDays * TRASH_DAY_MS
  }
}

/**
 * originPath 是否还在笔记库边界内。sidecar 是纯文本，可以被人为改写 —— 还原前
 * 必须重新校验一次，绝不能凭一条元数据就把文件写出去。
 * @param {string} candidate
 * @returns {boolean}
 */
function isSafeNotesPath (candidate) {
  if (typeof candidate !== 'string' || candidate === '' || !notesPath) return false
  // validatePath 是整套 fs 白名单的信任根：越界会抛错
  try {
    validatePath(notesPath, candidate)
    return true
  } catch (error) {
    return false
  }
}

/**
 * 删除动作的下半场：搬进 <notesPath>/.trash，并留下来源元数据。
 *
 * @param {string} safePath 已经过边界校验的绝对路径
 * @returns {Promise<{ok: boolean, trashPath?: string, metaOk?: boolean, error?: string, errno?: string, message?: string}>}
 */
async function moveToLibraryTrash (safePath) {
  const trashRoot = await trashRootPath()
  await fsp.mkdir(trashRoot, { recursive: true })

  const base = path.basename(safePath)
  const ms = Date.now()
  const size = await trashSizeOf(safePath, 0)
  let st = null
  try {
    st = await fsp.stat(safePath)
  } catch (error) {
    st = null
  }
  const kind = st && st.isDirectory() ? 'dir' : 'file'

  // 同名裁决：同一毫秒删两个同名文件（不同目录）时不能互相覆盖
  let trashPath = path.join(trashRoot, trashNameOf(base, ms))
  try {
    let dup = 1
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    while (true) {
      try {
        await fsp.access(trashPath, fsSync.constants.F_OK)
      } catch (error) {
        break // 不存在 → 这个坑位可用
      }
      trashPath = path.join(trashRoot, trashNameOf(`${stem}-${dup}${ext}`, ms))
      dup += 1
      if (dup > 1000) break
    }
  } catch (error) {
    /* 探测失败不影响后续：rename 会自己报出来 */
  }

  markSelfWrite(safePath)
  markSelfWrite(trashPath)
  try {
    await fsp.rename(safePath, trashPath)
  } catch (renameErr) {
    // 跨设备 / 被占用：退化为「复制 + 删除」，宁可慢也不要失败
    await fsp.cp(safePath, trashPath, { recursive: true, force: true })
    await fsp.rm(safePath, { recursive: true, force: true })
  }

  // 元数据在**移动成功之后**写：先写后移会在移动失败时留下指向不存在文件的幽灵记录
  let metaOk = true
  let metaErr = null
  try {
    await writeTrashMeta(trashPath, {
      v: TRASH_META_VERSION,
      originPath: safePath,
      name: base,
      trashedAt: ms,
      kind,
      size
    })
  } catch (error) {
    metaOk = false
    metaErr = error
    ipcLog.warn('写入回收站来源元数据失败（内容已在回收站里，位置信息缺失）', {
      op: 'fs:delete-file',
      trashPath,
      errno: (error && error.code) || ''
    })
  }
  if (!metaOk) {
    return {
      ok: true,
      metaOk: false,
      trashPath,
      error: 'meta-write-failed',
      errno: (metaErr && metaErr.code) || '',
      message: trashFailureReason(metaErr)
    }
  }
  return { ok: true, metaOk: true, trashPath }
}

ipcMain.handle('fs:delete-file', async (_, filePath, options) => {
  const detail = !!(options && options.detail === true)
  try {
    const safePath = await validatePathAsync(notesPath, filePath)
    markSelfWrite(safePath)
    try {
      await shell.trashItem(safePath)
      // 默认维持老的 `true`：既有调用方（note.js / Sidebar.vue）只看真假
      return detail ? { ok: true, method: 'system-trash', path: safePath } : true
    } catch (trashErr) {
      // 回收站不可用（无 GUI / 部分 Linux / 网络盘）→ 退化为库内 .trash
      try {
        const moved = await moveToLibraryTrash(safePath)
        return detail
          ? {
            ok: true,
            method: 'library-trash',
            path: safePath,
            trashPath: moved.trashPath,
            metaOk: moved.metaOk !== false,
            // UI 要原样展示这句：用户有权知道「东西没进系统回收站，而是留在了库里」
            fallbackReason: trashFailureReason(trashErr),
            note: '系统回收站不可用，文件已移入库内 .trash，可在「最近删除」中还原'
          }
          : true
      } catch (fallbackErr) {
        ipcLog.error('删除失败：系统回收站与库内 .trash 均不可用', Object.assign(
          { op: 'fs:delete-file', path: filePath, why: trashFailureReason(trashErr) },
          ioInfo(fallbackErr)
        ))
        return detail
          ? Object.assign(ioFailure(fallbackErr, 'delete-failed'), { fallbackReason: trashFailureReason(trashErr) })
          : false
      }
    }
  } catch (error) {
    ipcLog.error('删除失败：路径校验未通过', Object.assign({ op: 'fs:delete-file', path: filePath }, ioInfo(error)))
    return detail ? ioFailure(error, 'invalid-path') : false
  }
})

// 递归删除目录（删除文件夹用）。同样优先系统回收站。
ipcMain.handle('fs:remove-dir', async (_, dirPath, options) => {
  const detail = !!(options && options.detail === true)
  try {
    const safePath = await validatePathAsync(notesPath, dirPath)
    // 不允许删除笔记库自身
    if (path.resolve(safePath) === path.resolve(notesPath)) return false
    markSelfWrite(safePath)
    try {
      await shell.trashItem(safePath)
      return detail ? { ok: true, method: 'system-trash', path: safePath } : true
    } catch (trashErr) {
      try {
        const moved = await moveToLibraryTrash(safePath)
        return detail
          ? {
            ok: true,
            method: 'library-trash',
            path: safePath,
            trashPath: moved.trashPath,
            metaOk: moved.metaOk !== false,
            fallbackReason: trashFailureReason(trashErr),
            note: '系统回收站不可用，目录已移入库内 .trash，可在「最近删除」中还原'
          }
          : true
      } catch (fallbackErr) {
        ipcLog.error('删除目录失败：系统回收站与库内 .trash 均不可用', Object.assign(
          { op: 'fs:remove-dir', path: dirPath, why: trashFailureReason(trashErr) },
          ioInfo(fallbackErr)
        ))
        return detail
          ? Object.assign(ioFailure(fallbackErr, 'delete-failed'), { fallbackReason: trashFailureReason(trashErr) })
          : false
      }
    }
  } catch (error) {
    ipcLog.error('删除目录失败：路径校验未通过', Object.assign({ op: 'fs:remove-dir', path: dirPath }, ioInfo(error)))
    return detail ? ioFailure(error, 'invalid-path') : false
  }
})

// ============= trash:list —— 库内回收站清单（T28「最近删除」面板的数据源）=============
//
// 入参（可选）：{ trashDir?, retentionDays?, nowMs? }
// 返回：{ ok, entries[], trashDir, retentionDays, nowMs, exists }
//        entries 按删除时间倒序（最新的在最前），每条的形状见 buildTrashEntry；
//        entries 里**不含** sidecar 与点文件。
//
// 注意：这里只列**库内 .trash**。系统回收站里的内容拿不到任何原路径信息，不在本
// 接口的职责范围内 —— 这也是为什么 fs:delete-file 在回收站可用时仍建议 UI 提示
// 「已从系统回收站恢复」由用户自行处理。
ipcMain.handle('trash:list', async (_, payload) => {
  const opts = payload && typeof payload === 'object' ? payload : {}
  if (!notesPath) return { ok: false, error: 'no-notes-path', entries: [], message: '尚未设置笔记目录' }
  try {
    const trashRoot = await trashRootPath()
    const retentionDays = Number.isFinite(opts.retentionDays) && opts.retentionDays >= 0
      ? opts.retentionDays
      : TRASH_RETENTION_DAYS
    // 一批数据共用同一个「现在」，否则 expired 会自相矛盾
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()

    let children = []
    try {
      children = await fsp.readdir(trashRoot, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { ok: true, entries: [], trashDir: trashRoot, exists: false, retentionDays, nowMs }
      }
      throw error
    }

    const entries = []
    for (const child of children) {
      if (isTrashNoise(child.name)) continue
      const entry = await buildTrashEntry(trashRoot, child.name, nowMs, retentionDays)
      if (entry) entries.push(entry)
    }
    entries.sort((a, b) => (b.trashedAt - a.trashedAt) || (a.trashName < b.trashName ? -1 : 1))
    return { ok: true, entries, trashDir: trashRoot, exists: true, retentionDays, nowMs }
  } catch (error) {
    ipcLog.error('读取回收站清单失败', Object.assign({ op: 'trash:list' }, ioInfo(error)))
    return Object.assign(ioFailure(error, 'read-failed'), { entries: [] })
  }
})

// ============= trash:restore —— 还原回原文件夹 =============
//
// 入参：{ id, strategy? }，strategy ∈ 'fail' | 'rename' | 'overwrite'（默认 fail）
// 返回：{ ok, path, requestedPath, renamed, metaCleaned } 或
//       { ok:false, error, errno, message, requestedPath?, suggestedPath? }
//
// error 取值：invalid-id / not-found / outside-root / target-exists /
//            restore-failed / no-notes-path
ipcMain.handle('trash:restore', async (_, payload) => {
  const opts = payload && typeof payload === 'object' ? payload : {}
  if (!notesPath) return { ok: false, error: 'no-notes-path', message: '尚未设置笔记目录' }
  const id = typeof opts.id === 'string' ? opts.id : ''
  // id 必须是「一个纯文件名」：带任何路径语义（../ /（''） / a/b.md）都直接拒，
  // 这是防路径穿越的第一道闸。
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.startsWith('.')) {
    return { ok: false, error: 'invalid-id', message: '非法的回收站条目 id' }
  }
  const strategy = opts.strategy === 'rename' || opts.strategy === 'overwrite' ? opts.strategy : 'fail'
  try {
    const trashRoot = await trashRootPath()
    const nowMs = Date.now()
    const entry = await buildTrashEntry(trashRoot, id, nowMs, TRASH_RETENTION_DAYS)
    if (!entry) return { ok: false, error: 'not-found', message: '回收站里没有这个条目' }

    // 二次校验：sidecar 可以被人为改写成库外路径，不能凭它就把文件搬出去
    let targetPath = null
    try {
      targetPath = validatePath(notesPath, entry.originPath)
    } catch (error) {
      ipcLog.warn('拒绝还原到笔记库之外', { op: 'trash:restore', id, originPath: entry.originPath })
      return {
        ok: false,
        error: 'outside-root',
        message: '该条目记录的原始路径不在笔记库内',
        requestedPath: entry.originPath
      }
    }
    const requestedPath = targetPath
    let renamed = false

    let occupied = false
    try {
      await fsp.access(targetPath, fsSync.constants.F_OK)
      occupied = true
    } catch (error) {
      occupied = false
    }
    if (occupied) {
      if (strategy === 'fail') {
        // 给出可直接采用的候选名，UI 做二次确认后改 strategy:'rename' 再调一次
        const dot = requestedPath.lastIndexOf('.')
        const stem = dot > -1 ? requestedPath.slice(0, dot) : requestedPath
        const ext = dot > -1 ? requestedPath.slice(dot) : ''
        let suggestedPath = `${stem}-1${ext}`
        for (let n = 2; n <= 1000; n += 1) {
          let taken = false
          try {
            await fsp.access(suggestedPath, fsSync.constants.F_OK)
            taken = true
          } catch (error) {
            taken = false
          }
          if (!taken) break
          suggestedPath = `${stem}-${n}${ext}`
        }
        return {
          ok: false,
          error: 'target-exists',
          message: '原位置已经存在同名文件',
          requestedPath,
          suggestedPath
        }
      }
      if (strategy === 'rename') {
        const dot = requestedPath.lastIndexOf('.')
        const stem = dot > -1 ? requestedPath.slice(0, dot) : requestedPath
        const ext = dot > -1 ? requestedPath.slice(dot) : ''
        for (let n = 1; n <= 1000; n += 1) {
          const candidate = `${stem}-${n}${ext}`
          let taken = false
          try {
            await fsp.access(candidate, fsSync.constants.F_OK)
            taken = true
          } catch (error) {
            taken = false
          }
          if (!taken) {
            targetPath = candidate
            renamed = true
            break
          }
        }
      }
      // strategy === 'overwrite'：沿用原路径，由 UI 承担确认责任
    }

    // 原文件夹可能连目录一起被删过：没有这行，「还原回到一个不存在的文件夹」
    // 会在最该成功的时候失败
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })

    markSelfWrite(entry.trashPath)
    markSelfWrite(targetPath)
    try {
      await fsp.rename(entry.trashPath, targetPath)
    } catch (renameErr) {
      try {
        await fsp.cp(entry.trashPath, targetPath, { recursive: true, force: true })
        await fsp.rm(entry.trashPath, { recursive: true, force: true })
      } catch (copyErr) {
        ipcLog.error('还原失败', Object.assign(
          { op: 'trash:restore', id, to: requestedPath },
          ioInfo(copyErr)
        ))
        return Object.assign(ioFailure(copyErr, 'restore-failed'), { requestedPath })
      }
    }

    // 清掉 sidecar：不清的话条目会「死而复生」—— 文件已回原位，列表里却还挂着一条
    let metaCleaned = true
    try {
      await fsp.rm(entry.metaPath, { force: true })
    } catch (error) {
      metaCleaned = false
      ipcLog.warn('清理回收站元数据失败', Object.assign(
        { op: 'trash:restore', id },
        ioInfo(error)
      ))
    }

    return { ok: true, path: targetPath, requestedPath, renamed, metaCleaned, kind: entry.kind, size: entry.size }
  } catch (error) {
    ipcLog.error('还原失败：回收站目录不可读', Object.assign({ op: 'trash:restore', id }, ioInfo(error)))
    return ioFailure(error, 'restore-failed')
  }
})

// ============= trash:purge —— 彻底删除 =============
//
// 入参（可选）：{ ids?, expiredOnly?, all?, retentionDays?, dryRun? }
//   · ids: string[]          只删这几条（用户勾选后点「彻底删除」）
//   · all: true              清空整个回收站（**必须显式**传，防止误调把库清空）
//   · retentionDays          过期周期调参（默认 30 天）
//   · dryRun: true           只算不删，返回 expired 清单（给 UI 做「即将清理」预告）
//   · 三都不传时 → 按 expiredOnly 语义只清过期条目（默认最保守）
// 返回：{ ok, purged[], failed[], kept[], expired[], retentionDays, retentionMs, cutoffMs, dryRun }
ipcMain.handle('trash:purge', async (_, payload) => {
  const opts = payload && typeof payload === 'object' ? payload : {}
  if (!notesPath) return { ok: false, error: 'no-notes-path', purged: [], failed: [], message: '尚未设置笔记目录' }
  const dryRun = opts.dryRun === true
  const retentionDays = Number.isFinite(opts.retentionDays) && opts.retentionDays >= 0
    ? opts.retentionDays
    : TRASH_RETENTION_DAYS
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()
  const cutoffMs = nowMs - retentionDays * TRASH_DAY_MS

  try {
    const trashRoot = await trashRootPath()
    let children = []
    try {
      children = await fsp.readdir(trashRoot, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { ok: true, purged: [], failed: [], kept: [], expired: [], retentionDays, retentionMs: retentionDays * TRASH_DAY_MS, cutoffMs, dryRun }
      }
      throw error
    }

    const listed = []
    for (const child of children) {
      if (isTrashNoise(child.name)) continue
      const entry = await buildTrashEntry(trashRoot, child.name, nowMs, retentionDays)
      if (entry) listed.push(entry)
    }

    const hasIds = Array.isArray(opts.ids)
    const purgeAll = opts.all === true
    const targets = hasIds
      ? opts.ids
      : listed.filter((e) => (purgeAll ? true : e.trashedAt > 0 && e.trashedAt <= cutoffMs)).map((e) => e.id)
    const expired = listed.filter((e) => e.trashedAt > 0 && e.trashedAt <= cutoffMs)
      .map((e) => ({ id: e.id, trashedAt: e.trashedAt, originPath: e.originPath }))
    const kept = listed.filter((e) => !targets.includes(e.id)).map((e) => e.id)

    if (dryRun) {
      return {
        ok: true,
        purged: [],
        failed: [],
        kept,
        expired,
        targets,
        retentionDays,
        retentionMs: retentionDays * TRASH_DAY_MS,
        cutoffMs,
        dryRun: true
      }
    }

    const purged = []
    const failed = []
    for (const rawId of targets) {
      const id = typeof rawId === 'string' ? rawId : ''
      if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.startsWith('.')) {
        failed.push({ id: String(rawId), error: 'invalid-id', message: '非法的回收站条目 id' })
        continue
      }
      const trashPath = path.join(trashRoot, id)
      const metaFile = metaPathOf(trashPath)
      try {
        try {
          await fsp.access(trashPath, fsSync.constants.F_OK)
        } catch (error) {
          failed.push({ id, error: 'not-found', message: '条目已不存在' })
          continue
        }
        let st = null
        try {
          st = await fsp.stat(trashPath)
        } catch (error) {
          st = null
        }
        markSelfWrite(trashPath)
        markSelfWrite(metaFile)
        await fsp.rm(trashPath, { recursive: true, force: true })
        // 本体删成功才轮到 sidecar；本体失败时保留元数据，起码列表里还能看见它
        try {
          await fsp.rm(metaFile, { force: true })
        } catch (metaErr) {
          failed.push(Object.assign({ id, error: 'meta-cleanup-failed', message: '本体已删除，元数据残留' }, ioInfo(metaErr)))
          continue
        }
        purged.push({ id, trashPath, kind: st && st.isDirectory() ? 'dir' : 'file' })
      } catch (error) {
        failed.push(Object.assign({ id, error: 'purge-failed', message: '彻底删除失败' }, ioInfo(error)))
      }
    }

    if (purged.length > 0 || failed.length > 0) {
      ipcLog.info('回收站清理完成', { op: 'trash:purge', purged: purged.length, failed: failed.length, dryRun })
    }
    return {
      ok: failed.length === 0,
      purged,
      failed,
      kept,
      expired,
      retentionDays,
      retentionMs: retentionDays * TRASH_DAY_MS,
      cutoffMs,
      dryRun: false
    }
  } catch (error) {
    ipcLog.error('回收站清理失败', Object.assign({ op: 'trash:purge' }, ioInfo(error)))
    return Object.assign(ioFailure(error, 'purge-failed'), { purged: [], failed: [] })
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

// ============================================================
// 自动更新（electron-updater）
// ------------------------------------------------------------
// 契约（渲染进程按这个形状判定）：
//   成功 → { ok: true }（被并发检查合并时额外带 skipped: true）
//   失败 → { ok: false, error: string, code: string }
//   事件 updater:error 的载荷 → { message, code, name }
// 关键节点一律进主进程日志：用户报「更新不可用」时，UI 只有一条 toast，
// 只有日志能区分「没联网 / latest.yml 404 / 签名校验失败 / 磁盘写不下」。
// ============================================================

/**
 * 把 electron-updater 抛出的东西规整成固定形状。
 *
 * 它抛得很杂：Error、带 code 的 HTTPError、甚至字符串。统一形状之后，
 * IPC 回执与 updater:error 事件才是同一份数据，UI 不用猜字段在哪。
 *
 * @param {unknown} err 原始错误
 * @returns {{message: string, code: string, name: string}}
 */
function describeUpdaterError (err) {
  let message = ''
  if (err && typeof err.message === 'string' && err.message) message = err.message
  else if (typeof err === 'string' && err) message = err
  else if (err && typeof err === 'object') message = String(err.error || err.code || '')
  if (!message) message = '未知错误'
  return {
    message,
    code: err && typeof err.code === 'string' ? err.code : '',
    name: err && typeof err.name === 'string' ? err.name : ''
  }
}

/**
 * 检查更新的重入闸门。
 *
 * App.vue 的启动定时器与设置页挂载后的 2s 定时器是两条独立的时间线，「设置页在
 * 启动窗口内被打开」这条路径上会同时到达 —— 结果是同一秒发两遍网络请求，
 * 而且两次 update-available 会让 UI 状态闪两下。这里合并成一次。
 */
let updateCheckInFlight = false

function setupAutoUpdater () {
  // updateConfigPath 指向不存在的文件会让 dev 下每次检查都失败；
  // 生产态由 electron-builder 生成的 app-update.yml 自动生效，无需指定。
  if (isDev && fsSync.existsSync(path.join(__dirname, '..', 'dev-app-update.yml'))) {
    autoUpdater.updateConfigPath = path.join(__dirname, '..', 'dev-app-update.yml')
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    ipcLog.info('开始检查更新', { op: 'updater:checking' })
    mainWindow?.webContents.send('updater:checking')
  })

  autoUpdater.on('update-available', (info) => {
    ipcLog.info('发现新版本', { op: 'updater:update-available', version: info && info.version })
    mainWindow?.webContents.send('updater:update-available', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    ipcLog.info('当前已是最新版本', { op: 'updater:update-not-available', version: info && info.version })
    mainWindow?.webContents.send('updater:update-not-available', info)
  })

  autoUpdater.on('error', (err) => {
    // 结构化对象而不是裸字符串：渲染进程要让 code 进日志、message 进 UI，
    // 裸字符串一旦换行或超长，UI 上就只剩半截看不懂的话。
    const detail = describeUpdaterError(err)
    ipcLog.error('自动更新失败', Object.assign({ op: 'updater:error' }, detail))
    mainWindow?.webContents.send('updater:error', detail)
  })

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow?.webContents.send('updater:download-progress', progressObj)
  })

  autoUpdater.on('update-downloaded', (info) => {
    ipcLog.info('新版本下载完成', { op: 'updater:update-downloaded', version: info && info.version })
    mainWindow?.webContents.send('updater:update-downloaded', info)
  })
}

ipcMain.handle('updater:check-for-updates', async () => {
  // 并发合并：已经在检查中就不再打第二次网络，直接返回「被合并」。
  // 返回值必须是 ok:true —— 合并不是失败，UI 不需要报错。
  if (updateCheckInFlight) {
    ipcLog.info('并发检查更新已合并', { op: 'updater:check-for-updates', skipped: true })
    return { ok: true, skipped: true }
  }
  updateCheckInFlight = true
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (err) {
    const detail = describeUpdaterError(err)
    ipcLog.error('检查更新失败', Object.assign({ op: 'updater:check-for-updates' }, detail))
    return { ok: false, error: detail.message, code: detail.code }
  } finally {
    updateCheckInFlight = false
  }
})

ipcMain.handle('updater:download-update', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (err) {
    const detail = describeUpdaterError(err)
    ipcLog.error('下载更新失败', Object.assign({ op: 'updater:download-update' }, detail))
    return { ok: false, error: detail.message, code: detail.code }
  }
})

ipcMain.handle('updater:quit-and-install', () => {
  // quitAndInstall 在「还没下载完」时会抛错。裸调用会让 Promise reject 到渲染
  // 进程，表现为 UI 上毫无反应的失败 —— 必须吞掉并返回结构化回执。
  try {
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  } catch (err) {
    const detail = describeUpdaterError(err)
    ipcLog.error('重启安装失败', Object.assign({ op: 'updater:quit-and-install' }, detail))
    return { ok: false, error: detail.message, code: detail.code }
  }
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
