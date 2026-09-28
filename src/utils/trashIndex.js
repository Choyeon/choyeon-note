// ============================================================================
// trashIndex.js —— 库内回收站（.trash）索引与还原**纯内核**
//
// 为什么需要它（R-D5）：
//   `fs:delete-file` 早就优先走系统回收站了，但**应用内没有任何入口**能看到或还原
//   那些被删的东西。用户误删一个装了几十篇笔记的文件夹，只能自己去系统回收站里翻，
//   而系统回收站是按删除时间平铺的 —— 目录结构没了、原始路径没了，「哪篇原来在哪」
//   全靠猜。Obsidian 的答案是「最近删除」面板，本模块就是它的地基。
//
//   更糟的是第二半：系统回收站**并不总是可用**（无 GUI 的 Linux、某些网络盘、
//   权限受限的环境）。此时 fs:delete-file 会退化为「移动到库内 .trash」，一旦丢了
//   来源路径，这批文件就变成了孤儿 —— 看得到内容，回不到原来的文件夹。
//
// 设计取舍：
//   1. **纯函数 + 依赖注入**。内核不 import fs / path / electron，所有磁盘操作由外部
//      注入（listDir / stat / exists / makeDir / move / remove / readMeta / writeMeta /
//      now / path）。收益有三：单测可以喂内存 fs（毫秒级、时钟可控，30 天过期这种
//      用例能稳定复现）；将来跑浏览器 / worker 也不需要 polyfill；主进程可以喂真的
//      node fs（因打包原因它自己实现了一份等价的分身，见 main.cjs 的同名区块）。
//   2. **元数据用 sidecar（每个条目一个 `<name>.trashmeta.json`）**，理由见文件末尾
//      的「元数据为什么是 sidecar」小节；核心结论：不碰用户的 .md 一个字节，也不把
//      所有条目的命运系在一张会被覆盖写坏的 index.json 上。
//   3. **元数据丢了也要能救**。没有 sidecar 时按「文件名时间戳前缀 → 降级到库根
//      目录」的顺序兜底恢复 originPath，并在条目上打 `degraded` 标记，让 UI 能诚实
//      地标出「原位置未知」，而不是装作精确。
//
// 通道侧 wiring 在 electron/main.cjs（trash:list / trash:restore / trash:purge），
// UI 侧接线是 T28 的 TrashView.vue。
// ============================================================================

/** 库内回收站目录名（放在笔记库根下，且被文件监听器视为隐藏段忽略） */
export const TRASH_DIR_NAME = '.trash'

/** sidecar 元数据文件后缀：回收站里的可见文件名 + 它 = 元数据文件路径 */
export const TRASH_META_SUFFIX = '.trashmeta.json'

/** Meta 结构版本号。将来格式升级时用它区分；读取时宽容（老格式也尽力读）。 */
export const TRASH_META_VERSION = 1

/** 回收站条目名的「时间戳前缀」与「原始文件名」之间的分隔符 */
export const TRASH_NAME_SEP = '__'

/** 默认保留天数：超过这个时长的条目在 purgeExpired 时被清掉 */
export const DEFAULT_RETENTION_DAYS = 30

/** 一天的毫秒数（导出给 UI 侧做「还剩几天」的展示计算） */
export const DAY_MS = 24 * 60 * 60 * 1000

/** 递归统计目录体积时的深度上限：软链接环 / 异常深树不该拖垮一次列表操作 */
const SIZE_MAX_DEPTH = 12

/** 同名裁决时的重试上限（正常情况下几次就够，设兜底避免死循环） */
const COLLISION_MAX_TRIES = 1000

/**
 * 所有可能的 error 取值。渲染侧做文案映射时可以按这个清单穷举，
 * 出现清单外的值即视为内核 bug（应当记进日志而不是当成普通失败）。
 * @type {ReadonlyArray<string>}
 */
export const TRASH_ERROR_CODES = Object.freeze([
  'invalid-args',        // 入参缺失或类型不对
  'missing-root',        // 没有传库根目录
  'invalid-id',          // id 里夹了路径分隔符 / 是 '.' '..' —— 拦的就是路径穿越
  'not-found',           // 回收站里没有这个条目
  'outside-root',        // 目标落在笔记库之外 —— 一律拒绝，绝不跨出边界
  'meta-write-failed',   // 文件已经进回收站了，但来源元数据没写成
  'meta-cleanup-failed', // 还原成功但 sidecar 没删掉（条目可能重复出现在列表里）
  'target-exists',       // 原位置已有一个同名文件（默认拒绝，需 UI 确认后改 rename）
  'move-failed',         // 移动失败：把东西塞进回收站这一步
  'restore-failed',      // 移动失败：把东西搬回原处这一步
  'purge-failed'         // 彻底删除失败（权限 / 占用）
])

/** 时间戳前缀格式：2024-05-05T12-34-56-789Z（冒号与点换成 '-'，文件名安全） */
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/

// ---------------------------------------------------------------------------
// 纯工具：时间戳 ↔ 文件名（导出，保证 main.cjs 的分身与本内核产出同一种名字）
// ---------------------------------------------------------------------------

/**
 * 毫秒时间戳 → 文件名安全的时间戳前缀。
 * @param {number} ms 毫秒时间戳
 * @returns {string} 形如 `2024-05-05T12-34-56-789Z`
 */
export function formatTrashStamp (ms) {
  return new Date(Number(ms) || 0).toISOString().replace(/[:.]/g, '-')
}

/**
 * 时间戳前缀 → 毫秒时间戳。解析不了就返回 null（交给调用方降级）。
 * @param {string} stamp
 * @returns {number|null}
 */
export function parseTrashStamp (stamp) {
  if (typeof stamp !== 'string') return null
  const m = STAMP_RE.exec(stamp)
  if (!m) return null
  const ts = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])
  )
  return Number.isFinite(ts) ? ts : null
}

/**
 * 生成回收站条目名：`<时间戳前缀>__<原始文件名>`。
 * @param {string} base 原始文件名（不含目录）
 * @param {number} ms 毫秒时间戳
 * @returns {string}
 */
export function makeTrashName (base, ms) {
  return `${formatTrashStamp(ms)}${TRASH_NAME_SEP}${String(base)}`
}

/**
 * 反解条目名 → { trashedAt, base }；解不出来返回 null。
 * 兼容两件事：一是 T27 之前的旧写法（同一个时间戳前缀约定），二是文件名本身就含
 * `__` 的情况（取**第一个**分隔符，前提是前面确实是合法的时间戳前缀）。
 * @param {string} name
 * @returns {{trashedAt: number, base: string}|null}
 */
export function parseTrashName (name) {
  if (typeof name !== 'string' || name.startsWith('.')) return null
  const sep = name.indexOf(TRASH_NAME_SEP)
  if (sep <= 0) return null
  const trashedAt = parseTrashStamp(name.slice(0, sep))
  if (trashedAt === null) return null
  const base = name.slice(sep + TRASH_NAME_SEP.length)
  if (!base) return null
  return { trashedAt, base }
}

/**
 * 条目名 → 对应的 sidecar 元数据文件名（目录由调用方拼）。
 * @param {string} trashName
 * @returns {string}
 */
export function metaNameOf (trashName) {
  return `${trashName}${TRASH_META_SUFFIX}`
}

/**
 * 是不是 sidecar 元数据文件。
 * @param {string} name
 * @returns {boolean}
 */
export function isTrashMetaName (name) {
  return typeof name === 'string' && name.endsWith(TRASH_META_SUFFIX)
}

/**
 * 是不是回收站里应当被忽略的名字：元数据 sidecar、点文件（.DS_Store 之类）。
 * @param {string} name
 * @returns {boolean}
 */
export function isTrashNoiseName (name) {
  return typeof name !== 'string' || name === '' || name.startsWith('.') || isTrashMetaName(name)
}

/**
 * 把 `\` 与 `/` 混写的路径统一成 `/`，并去掉结尾多余的斜杠（用于边界判断）。
 * @param {string} p
 * @returns {string}
 */
function toSlashed (p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 是不是 Windows 盘符路径（形如 `c:/notes`）。仅当**两边都像** Windows 路径时才做
 * 大小写无关比较 —— Linux 的路径大小写是有语义的，不能一并抹平。
 * @param {string} p
 * @returns {boolean}
 */
function looksLikeWindowsPath (p) {
  return /^[A-Za-z]:/.test(p)
}

/**
 * target 是否严格位于 parent 之内（parent 自身不算）。
 *
 * 这是回收站的安全边界：**任何**被操作的路径都必须落在笔记库里。元数据是纯文本，
 * 理论上可以被手工改写成指向库外的绝对位置 —— 校验一次不够，还原时必须再校一次。
 *
 * @param {string} parentAbs 父目录绝对路径（笔记库根）
 * @param {string} targetAbs 待判定的绝对路径
 * @returns {boolean}
 */
export function isWithinRoot (parentAbs, targetAbs) {
  const parent = toSlashed(parentAbs)
  const target = toSlashed(targetAbs)
  if (!parent || !target) return false
  const ci = looksLikeWindowsPath(parent) && looksLikeWindowsPath(target)
  const p = ci ? parent.toLowerCase() : parent
  const t = ci ? target.toLowerCase() : target
  if (p === t) return false // 库根本身不允许被当作目标
  return t.startsWith(p + '/')
}

/**
 * 把文件名拆成 `主干` + `后缀`，用于冲突时生成 `笔记-1.md` 这种形态。
 * @param {string} base
 * @returns {{stem: string, ext: string}}
 */
function splitExt (base) {
  const text = String(base)
  const dot = text.lastIndexOf('.')
  if (dot > 0) return { stem: text.slice(0, dot), ext: text.slice(dot) }
  return { stem: text, ext: '' }
}

/**
 * 把 Error 归一化成 `{ errno, message }`：既省掉各处重复代码，也避免把整个 Error
 * 对象（含绝对路径）泄漏到 IPC 边界上 —— 路径属于隐私数据。
 * @param {unknown} err
 * @returns {{errno: string, message: string}}
 */
function errToInfo (err) {
  if (err && typeof err === 'object') {
    const errno = typeof err.code === 'string' && err.code ? err.code : ''
    const message = typeof err.message === 'string' ? err.message : String(err)
    return { errno, message }
  }
  return { errno: '', message: String(err == null ? '' : err) }
}

// ---------------------------------------------------------------------------
// 内核
// ---------------------------------------------------------------------------

/** 必须注入的依赖清单（缺一个就在构造时显式报错，而不是等到调用才崩） */
const REQUIRED_DEPS = [
  'listDir', 'stat', 'exists', 'makeDir', 'move', 'remove',
  'readMeta', 'writeMeta', 'now', 'path'
]

/** path 适配器必须提供的四个纯函数（浏览器里没有 node:path，所以靠注入） */
const REQUIRED_PATH_OPS = ['join', 'dirname', 'basename', 'resolve']

/**
 * 创建回收站内核实例。
 *
 * @param {Object} deps 依赖注入
 * @param {(dir: string) => Promise<Array<Object>>} deps.listDir
 *        列举目录条目。接受 node 的 Dirent（isDirectory 是函数），也接受普通对象。
 * @param {(p: string) => Promise<{size: number, mtimeMs: number, isDirectory: boolean}>} deps.stat
 * @param {(p: string) => Promise<boolean>} deps.exists
 * @param {(dir: string) => Promise<void>} deps.makeDir 语义等价于 mkdir -p
 * @param {(src: string, dst: string) => Promise<void>} deps.move 需支持目录整体移动
 * @param {(p: string) => Promise<void>} deps.remove 需递归删除文件与目录
 * @param {(p: string) => Promise<Object|null>} deps.readMeta 不存在返回 null，读不了就 throw
 * @param {(p: string, meta: Object) => Promise<void>} deps.writeMeta
 * @param {() => number} deps.now 毫秒时钟（注入是为了让「30 天过期」可测）
 * @param {Object} deps.path 需含 join / dirname / basename / resolve
 * @param {Object} [options]
 * @param {number} [options.retentionDays=DEFAULT_RETENTION_DAYS] 默认保留天数
 * @param {(level: string, msg: string, data?: Object) => void} [options.logger] 可选日志出口
 * @returns {Object} 内核 API：{ moveToTrash, list, restore, purge, purgeExpired, statEntry }
 */
export function createTrashIndex (deps, options = {}) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createTrashIndex(deps)：deps 必须是对象')
  }
  const missing = REQUIRED_DEPS.filter((key) => deps[key] == null)
  if (missing.length > 0) {
    throw new TypeError(`createTrashIndex：缺少依赖 ${missing.join(', ')}`)
  }
  const pathOps = deps.path
  const missingOps = REQUIRED_PATH_OPS.filter((op) => typeof pathOps[op] !== 'function')
  if (missingOps.length > 0) {
    throw new TypeError(`createTrashIndex：deps.path 缺少 ${missingOps.join(', ')}`)
  }

  const P = pathOps
  const retentionDays = Number.isFinite(options.retentionDays) && options.retentionDays >= 0
    ? options.retentionDays
    : DEFAULT_RETENTION_DAYS
  /** @type {(level: string, msg: string, data?: Object) => void} */
  const logger = typeof options.logger === 'function' ? options.logger : () => {}

  // 这些短别名只是为了把「注入进来的东西」和「本地逻辑」分开：读代码时一眼能看出
  // 哪一行会产生副作用。
  const callListDir = deps.listDir
  const callStat = deps.stat
  const callExists = deps.exists
  const callMakeDir = deps.makeDir
  const callMove = deps.move
  const callRemove = deps.remove
  const callReadMeta = deps.readMeta
  const callWriteMeta = deps.writeMeta
  const nowMs = () => Number(deps.now()) || Date.now()

  /**
   * 统一 Dirent / 普通对象两种形态，省得每个 adapter 都得挑一种实现。
   * @param {Object|string} raw
   * @returns {{name: string, isDirectory: boolean}|null}
   */
  function asEntry (raw) {
    if (!raw) return null
    const name = typeof raw === 'string' ? raw : raw.name
    if (typeof name !== 'string' || name === '') return null
    let isDirectory = false
    if (raw.isDirectory !== undefined) {
      isDirectory = typeof raw.isDirectory === 'function' ? !!raw.isDirectory() : !!raw.isDirectory
    }
    return { name, isDirectory }
  }

  /**
   * 安全列举：目录不存在 / 权限不足都按「空」处理，列表不该因为一个目录炸掉。
   * @param {string} dir
   * @returns {Promise<Array<{name: string, isDirectory: boolean}>>}
   */
  async function safeListDir (dir) {
    try {
      const raw = await callListDir(dir)
      return (Array.isArray(raw) ? raw : []).map(asEntry).filter(Boolean)
    } catch (error) {
      logger('warn', '列举回收站目录失败', Object.assign({ op: 'trash:list', dir }, errToInfo(error)))
      return []
    }
  }

  /**
   * 安全 stat：拿不到就返回 null（条目可能在列举与 stat 之间被别的进程清掉了）。
   * @param {string} p
   * @returns {Promise<{size: number, mtimeMs: number, isDirectory: boolean}|null>}
   */
  async function safeStat (p) {
    try {
      const st = await callStat(p)
      if (!st || typeof st !== 'object') return null
      return {
        size: Number(st.size) || 0,
        mtimeMs: Number(st.mtimeMs) || 0,
        isDirectory: !!st.isDirectory
      }
    } catch (error) {
      return null
    }
  }

  /**
   * 安全 exists：任何异常都保守地当成「存在」，宁可不写也不覆盖。
   * @param {string} p
   * @returns {Promise<boolean>}
   */
  async function safeExists (p) {
    try {
      return !!(await callExists(p))
    } catch (error) {
      return true
    }
  }

  /**
   * 删除 sidecar 元数据，**元数据本来就不存在时算成功**。
   *
   * 这一处「ENOENT 不算错」的宽容是有意的：降级条目（用户手工丢进 .trash、或旧版本
   * 写下的条目）压根没有 sidecar，如果把 ENOENT 当失败，还原这类文件就会永远带着
   * 一条虚假的「元数据清理失败」警告。
   *
   * @param {string} metaPath
   * @returns {Promise<boolean>} 是否清理干净
   */
  async function removeMetaQuietly (metaPath) {
    try {
      await callRemove(metaPath)
      return true
    } catch (error) {
      if (error && error.code === 'ENOENT') return true
      throw error
    }
  }

  /**
   * 递归统计体积（目录才需要递归，文件一次 stat 就够）。失败按 0 处理 —— 体积只是
   * 展示信息，不值得因为它让整个列表失败。
   * @param {string} p
   * @param {number} depth
   * @returns {Promise<number>}
   */
  async function sizeOfPath (p, depth = 0) {
    const st = await safeStat(p)
    if (!st) return 0
    if (!st.isDirectory) return st.size
    if (depth >= SIZE_MAX_DEPTH) return st.size
    const children = await safeListDir(p)
    let total = 0
    for (const child of children) {
      if (isTrashNoiseName(child.name)) continue
      total += await sizeOfPath(P.join(p, child.name), depth + 1)
    }
    return total
  }

  /**
   * 读取并校验 sidecar 元数据。任何异常形态都被降级处理，**绝不抛出** —— 元数据
   * 损坏应该让列表少一条信息，而不是让整个面板白屏。
   * @param {string} metaPath
   * @returns {Promise<{meta: Object|null, degradedReason: string|null}>}
   */
  async function readMetaSafely (metaPath) {
    let meta = null
    try {
      meta = await callReadMeta(metaPath)
    } catch (error) {
      return { meta: null, degradedReason: 'meta-unreadable' }
    }
    if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) {
      return { meta: null, degradedReason: 'meta-missing' }
    }
    if (typeof meta.originPath !== 'string' || meta.originPath.trim() === '') {
      return { meta: null, degradedReason: 'meta-incomplete' }
    }
    return { meta, degradedReason: null }
  }

  /**
   * id 合法性：只允许「单个文件名」，不允许任何路径语义。
   * 这是防止 id 被构造成 `../../evil.md` 从而读写库外文件的第一道闸。
   * @param {string} id
   * @returns {boolean}
   */
  function isValidId (id) {
    if (typeof id !== 'string' || id === '') return false
    if (id === '.' || id === '..') return false
    if (id.includes('/') || id.includes('\\')) return false
    if (id.startsWith('.')) return false
    if (id.includes('\0')) return false
    return true
  }

  /**
   * 构造一个条目的完整描述（列表 / 还原 / 清理共用）。
   * @param {string} root 笔记库根
   * @param {string} trashRoot .trash 目录
   * @param {string} name .trash 里的条目名
   * @param {{retentionDays?: number, nowMs?: number}} [opts]
   * @returns {Promise<Object|null>} 条目；条目在列举与 stat 之间消失时返回 null
   */
  async function buildEntry (root, trashRoot, name, opts = {}) {
    const trashPath = P.join(trashRoot, name)
    const st = await safeStat(trashPath)
    if (!st) return null

    const kind = st.isDirectory ? 'dir' : 'file'
    const parsed = parseTrashName(name)
    const metaPath = P.join(trashRoot, metaNameOf(name))
    const { meta, degradedReason } = await readMetaSafely(metaPath)

    // trashedAt 的三级取值：sidecar → 文件名时间戳前缀 → 文件 mtime。
    // 顺序很重要：sidecar 是权威来源；没有 sidecar 时文件名前缀已经足够精确；
    // 用户手工丢进 .trash 的文件连前缀都没有，mtime 是唯一线索。
    let trashedAt = 0
    let degraded = false
    let reason = degradedReason

    if (meta && Number.isFinite(Number(meta.trashedAt)) && Number(meta.trashedAt) > 0) {
      trashedAt = Math.floor(Number(meta.trashedAt))
    } else if (parsed) {
      trashedAt = parsed.trashedAt
      if (degradedReason) degraded = true
    } else {
      trashedAt = Math.floor(st.mtimeMs) || Math.floor(nowMs())
      degraded = true
      // 「连时间戳都没有」是比「没有 sidecar」更根本的诊断，优先报它 —— UI 据此
      // 展示的是「删除时间未知」，而不是半句正确的「位置未知」。
      reason = 'no-timestamp'
    }
    if (degradedReason) degraded = true

    // originPath 的降级链：sidecar → 文件名前缀推测 → 库根/<展示名>
    const displayName =
      (parsed && parsed.base) ||
      (meta && typeof meta.name === 'string' && meta.name) ||
      name
    let originPath = ''
    if (meta && typeof meta.originPath === 'string' && meta.originPath.trim() !== '') {
      originPath = meta.originPath
    } else {
      originPath = P.join(root, displayName)
      degraded = true
      if (!reason) reason = degradedReason || 'meta-missing'
    }

    const outsideRoot = !isWithinRoot(root, originPath)
    const size = await sizeOfPath(trashPath, 0)

    const retention = Number.isFinite(opts.retentionDays) ? opts.retentionDays : retentionDays
    const cutoff = (opts.nowMs != null ? opts.nowMs : nowMs()) - retention * DAY_MS

    return {
      id: name,
      name: displayName,
      trashName: name,
      trashPath,
      metaPath,
      originPath,
      trashedAt,
      trashedAtISO: new Date(trashedAt).toISOString(),
      purgeAt: trashedAt + retention * DAY_MS,
      size,
      kind,
      degraded,
      degradedReason: reason,
      hasMeta: !!meta,
      outsideRoot,
      expired: trashedAt > 0 ? trashedAt <= cutoff : false
    }
  }

  /**
   * 依据入参解析出 { root, trashRoot }。
   * @param {Object} opts
   * @returns {{root: string, trashRoot: string}}
   */
  function resolveRoots (opts = {}) {
    const root = typeof opts.root === 'string' ? opts.root : ''
    if (!root) {
      const err = new Error('缺少 root（笔记库根目录）')
      err.code = 'missing-root'
      throw err
    }
    const trashRoot = typeof opts.trashDir === 'string' && opts.trashDir
      ? opts.trashDir
      : P.join(root, TRASH_DIR_NAME)
    return { root, trashRoot }
  }

  /**
   * 列出回收站里的全部条目（新的在前）。
   *
   * @param {Object} opts
   * @param {string} opts.root 笔记库根（必填）
   * @param {string} [opts.trashDir] .trash 目录，默认 `<root>/.trash`
   * @param {number} [opts.retentionDays] 覆盖默认保留天数
   * @param {number} [opts.nowMs] 覆盖时钟（测试 / UI 预览用）
   * @returns {Promise<{ok: boolean, entries: Array<Object>, root: string, trashDir: string, retentionDays: number, nowMs: number}>}
   */
  async function list (opts = {}) {
    const { root, trashRoot } = resolveRoots(opts)
    const retention = Number.isFinite(opts.retentionDays) ? opts.retentionDays : retentionDays
    // 一次 list 里所有条目共用同一个「现在」，否则同一批数据的 expired 会自相矛盾
    const stampMs = Number.isFinite(opts.nowMs) ? opts.nowMs : nowMs()
    const children = await safeListDir(trashRoot)

    const entries = []
    for (const child of children) {
      if (isTrashNoiseName(child.name)) continue
      const entry = await buildEntry(root, trashRoot, child.name, {
        retentionDays: retention,
        nowMs: stampMs
      })
      if (entry) entries.push(entry)
    }
    entries.sort((a, b) => (b.trashedAt - a.trashedAt) || (a.trashName < b.trashName ? -1 : 1))
    return { ok: true, entries, root, trashDir: trashRoot, retentionDays: retention, nowMs: stampMs }
  }

  /**
   * 取单个条目（内部 + 对外排查用）。
   * @param {Object} opts { root, trashDir, id }
   * @returns {Promise<Object|null>}
   */
  async function statEntry (opts = {}) {
    const { root, trashRoot } = resolveRoots(opts)
    const id = typeof opts.id === 'string' ? opts.id : ''
    if (!id || !isValidId(id)) return null
    return await buildEntry(root, trashRoot, id, {
      retentionDays: Number.isFinite(opts.retentionDays) ? opts.retentionDays : retentionDays,
      nowMs: Number.isFinite(opts.nowMs) ? opts.nowMs : nowMs()
    })
  }

  /**
   * 找一个「不存在」的目标名：`<时间戳>__<base>`，冲突时退化为 `-1` / `-2`……
   * @param {string} trashRoot
   * @param {string} base 原始文件名
   * @param {number} ms
   * @returns {Promise<string>} .trash 内可用的目标名
   */
  async function pickTrashName (trashRoot, base, ms) {
    let candidate = makeTrashName(base, ms)
    if (!(await safeExists(P.join(trashRoot, candidate)))) return candidate
    const { stem, ext } = splitExt(base)
    for (let n = 1; n <= COLLISION_MAX_TRIES; n += 1) {
      candidate = makeTrashName(`${stem}-${n}${ext}`, ms)
      if (!(await safeExists(P.join(trashRoot, candidate)))) return candidate
    }
    // 走到这里说明同一毫秒内同名条目已经多到离谱：兜底再塞一点熵，仍然优先保证
    // 「绝不覆盖」而不是「名字好看」。
    return makeTrashName(`${stem}-${Math.floor(Math.random() * 100000)}${ext}`, ms)
  }

  /**
   * 删除动作的下半场：把文件或目录搬进库内 .trash，并留下来源元数据。
   *
   * 与 fs:delete-file 的分工：那一层负责「优先系统回收站」，失败后才调这里；而系统
   * 回收站里的内容**不归本内核管**（拿不到原路径也不该去猜），所以这一层只处理库内
   * .trash。
   *
   * @param {Object} opts
   * @param {string} opts.root 笔记库根
   * @param {string} [opts.trashDir]
   * @param {string} opts.targetPath 要删除的绝对路径（必须位于库内）
   * @param {number} [opts.nowMs]
   * @returns {Promise<Object>} { ok:true, entry, metaOk } | { ok:false, error, errno, message }
   */
  async function moveToTrash (opts = {}) {
    const { root, trashRoot } = resolveRoots(opts)
    const targetPath = typeof opts.targetPath === 'string' ? opts.targetPath : ''
    if (!targetPath) return { ok: false, error: 'invalid-args', message: '缺少 targetPath' }
    if (!isWithinRoot(root, targetPath)) {
      return { ok: false, error: 'outside-root', message: '目标不在笔记库内' }
    }

    const ms = Number.isFinite(opts.nowMs) ? Math.floor(opts.nowMs) : Math.floor(nowMs())
    const base = P.basename(targetPath)
    const size = await sizeOfPath(targetPath, 0)
    const st = await safeStat(targetPath)
    const kind = st && st.isDirectory ? 'dir' : 'file'

    try {
      await callMakeDir(trashRoot)
    } catch (error) {
      return Object.assign(
        { ok: false, error: 'move-failed', message: '创建回收站目录失败' },
        errToInfo(error)
      )
    }

    const trashName = await pickTrashName(trashRoot, base, ms)
    const trashPath = P.join(trashRoot, trashName)
    try {
      await callMove(targetPath, trashPath)
    } catch (error) {
      return Object.assign(
        { ok: false, error: 'move-failed', message: '移动到回收站失败' },
        errToInfo(error)
      )
    }

    // 元数据必须在**移动成功之后**写：先写后移会在移动失败时留下一条指向不存在文件
    // 的孤儿元数据，列表里会出现一个「看得见、还原不了」的幽灵条目。
    const meta = {
      v: TRASH_META_VERSION,
      originPath: targetPath,
      name: base,
      trashedAt: ms,
      kind,
      size
    }
    const metaPath = P.join(trashRoot, metaNameOf(trashName))
    let metaOk = true
    try {
      await callWriteMeta(metaPath, meta)
    } catch (error) {
      // 内容已经在回收站里了 —— 不回滚移动（内容还在手上，回滚反而更危险），但要如实
      // 返回 metaOk:false，让调用方能提示用户「位置信息没记下」。
      metaOk = false
      logger('error', '写入回收站元数据失败', Object.assign(
        { op: 'trash:move', trashPath },
        errToInfo(error)
      ))
    }

    const entry = await buildEntry(root, trashRoot, trashName, { nowMs: ms })
    return {
      ok: true,
      metaOk,
      error: metaOk ? null : 'meta-write-failed',
      trashPath,
      trashName,
      entry
    }
  }

  /**
   * 在原位置上找一个不冲突的名字（`笔记.md` → `笔记-1.md`）。
   * @param {string} targetPath
   * @returns {Promise<string>}
   */
  async function pickRestoreName (targetPath) {
    if (!(await safeExists(targetPath))) return targetPath
    const dir = P.dirname(targetPath)
    const { stem, ext } = splitExt(P.basename(targetPath))
    for (let n = 1; n <= COLLISION_MAX_TRIES; n += 1) {
      const candidate = P.join(dir, `${stem}-${n}${ext}`)
      if (!(await safeExists(candidate))) return candidate
    }
    return P.join(dir, `${stem}-${Date.now() % 100000}${ext}`)
  }

  /**
   * 把一个条目还原回它原来的文件夹。
   *
   * 关键行为：
   *   · 父目录不存在时**自动创建**（原文件夹被整个删掉过是常态）
   *   · 原位置已有同名文件时**默认拒绝**（静默覆盖是数据事故），返回
   *     `suggestedPath`，由 UI 二次确认后改用 strategy:'rename'
   *   · originPath 落在库外时拒绝 —— sidecar 是纯文本，可以被人为改写，不能信
   *
   * @param {Object} opts
   * @param {string} opts.root 笔记库根
   * @param {string} [opts.trashDir]
   * @param {string} opts.id 条目 id（.trash 里的文件名）
   * @param {'fail'|'rename'|'overwrite'} [opts.strategy='fail'] 遇到同名冲突怎么办
   * @param {number} [opts.nowMs]
   * @returns {Promise<Object>}
   *   { ok:true, path, requestedPath, renamed, metaCleaned, kind } |
   *   { ok:false, error, errno, message, requestedPath?, suggestedPath? }
   */
  async function restore (opts = {}) {
    const { root, trashRoot } = resolveRoots(opts)
    const id = typeof opts.id === 'string' ? opts.id : ''
    if (!id || !isValidId(id)) {
      return { ok: false, error: 'invalid-id', message: '非法的回收站条目 id' }
    }
    const strategy = opts.strategy === 'rename' || opts.strategy === 'overwrite'
      ? opts.strategy
      : 'fail'

    const ms = Number.isFinite(opts.nowMs) ? opts.nowMs : nowMs()
    const entry = await buildEntry(root, trashRoot, id, { nowMs: ms })
    if (!entry) {
      return { ok: false, error: 'not-found', message: '回收站里没有这个条目' }
    }
    if (entry.outsideRoot) {
      // 元数据被改坏到指向库外：宁可不还原，也不能把文件写到用户没授权的地方
      logger('warn', '拒绝还原到笔记库之外', { op: 'trash:restore', id, originPath: entry.originPath })
      return {
        ok: false,
        error: 'outside-root',
        message: '该条目记录的原始路径不在笔记库内',
        requestedPath: entry.originPath
      }
    }

    const requestedPath = entry.originPath
    let targetPath = requestedPath
    let renamed = false

    if (await safeExists(requestedPath)) {
      if (strategy === 'fail') {
        return {
          ok: false,
          error: 'target-exists',
          message: '原位置已经存在同名文件',
          requestedPath,
          suggestedPath: await pickRestoreName(requestedPath)
        }
      }
      if (strategy === 'rename') {
        targetPath = await pickRestoreName(requestedPath)
        renamed = targetPath !== requestedPath
      }
      // strategy === 'overwrite'：沿用 requestedPath，由 UI 承担确认责任
    }

    try {
      await callMakeDir(P.dirname(targetPath))
    } catch (error) {
      return Object.assign(
        { ok: false, error: 'restore-failed', message: '创建目标文件夹失败', requestedPath },
        errToInfo(error)
      )
    }

    try {
      await callMove(entry.trashPath, targetPath)
    } catch (error) {
      return Object.assign(
        { ok: false, error: 'restore-failed', message: '还原失败', requestedPath },
        errToInfo(error)
      )
    }

    // 清掉 sidecar：留着的话条目会「死而复生」—— 文件已经回到原位，列表里却还挂着
    // 一条指向空位置的记录。
    let metaCleaned = true
    try {
      metaCleaned = await removeMetaQuietly(entry.metaPath)
    } catch (error) {
      metaCleaned = false
      logger('warn', '清理回收站元数据失败', Object.assign(
        { op: 'trash:restore', id },
        errToInfo(error)
      ))
    }

    return {
      ok: true,
      path: targetPath,
      requestedPath,
      renamed,
      metaCleaned,
      error: metaCleaned ? null : 'meta-cleanup-failed',
      kind: entry.kind,
      size: entry.size
    }
  }

  /**
   * 真正抹掉条目：本体 + sidecar。任何一条失败都记进 failed，不中断其余条目 ——
   * 「清空回收站」这种批量操作中途炸掉一半是最难向用户解释的状态。
   *
   * @param {Object} opts
   * @param {string} [opts.root] 笔记库根（不给时用 trashDir 直连）
   * @param {string} [opts.trashDir] .trash 目录
   * @param {string[]|null} [opts.ids=null] 指定条目；null / 省略 = 全部删除
   * @returns {Promise<{ok: boolean, purged: Array<Object>, failed: Array<Object>}>}
   */
  async function purge (opts = {}) {
    if (!(typeof opts.trashDir === 'string' && opts.trashDir) && typeof opts.root !== 'string') {
      return {
        ok: false,
        purged: [],
        failed: [{ id: '', error: 'invalid-args', message: '缺少 trashDir 或 root' }]
      }
    }
    const trashRoot = typeof opts.trashDir === 'string' && opts.trashDir
      ? opts.trashDir
      : P.join(opts.root, TRASH_DIR_NAME)
    const requestedIds = Array.isArray(opts.ids) ? opts.ids : null

    let targets = []
    if (requestedIds) {
      targets = requestedIds.map((id) => ({ id, entry: null }))
    } else {
      const children = await safeListDir(trashRoot)
      targets = children.filter((c) => !isTrashNoiseName(c.name)).map((c) => ({ id: c.name, entry: null }))
    }

    const purged = []
    const failed = []
    for (const target of targets) {
      const id = typeof target.id === 'string' ? target.id : ''
      if (!id || !isValidId(id)) {
        failed.push({ id: String(target.id), error: 'invalid-id', message: '非法的回收站条目 id' })
        continue
      }
      const trashPath = P.join(trashRoot, id)
      const metaPath = P.join(trashRoot, metaNameOf(id))
      try {
        if (!(await safeExists(trashPath))) {
          failed.push({ id, error: 'not-found', message: '条目已不存在' })
          continue
        }
        const st = await safeStat(trashPath)
        await callRemove(trashPath)
        // 本体删成功才轮到 sidecar；本体删除失败时保留元数据，起码列表还能看到它
        let metaError = null
        try {
          await removeMetaQuietly(metaPath)
        } catch (error) {
          metaError = error
        }
        if (metaError) {
          failed.push(Object.assign(
            { id, error: 'meta-cleanup-failed', message: '本体已删除，元数据残留' },
            errToInfo(metaError)
          ))
          continue
        }
        purged.push({ id, trashPath, kind: st && st.isDirectory ? 'dir' : 'file' })
      } catch (error) {
        failed.push(Object.assign({ id, error: 'purge-failed', message: '彻底删除失败' }, errToInfo(error)))
      }
    }
    return { ok: failed.length === 0, purged, failed }
  }

  /**
   * 清理超过保留期的条目（默认 30 天）。
   *
   * 为什么必须设期限：库内 .trash 是**占用户笔记库空间**的，且会被同步盘一并同步；
   * 无限期保留等于让笔记库缓慢膨胀。30 天是 Obsidian 同类功能的常见取值，可通过
   * retentionDays 调（purge 指定的 ids 不受期限约束 —— 用户主动清空就是清空）。
   *
   * @param {Object} opts
   * @param {string} opts.root 笔记库根
   * @param {string} [opts.trashDir]
   * @param {number} [opts.retentionDays] 覆盖默认天数
   * @param {number} [opts.nowMs]
   * @param {boolean} [opts.dryRun=false] 只算不删
   * @returns {Promise<{ok: boolean, purged: Array<Object>, kept: string[], failed: Array<Object>, expired: Array<Object>, retentionDays: number, cutoffMs: number, retentionMs: number}>}
   */
  async function purgeExpired (opts = {}) {
    const { root, trashRoot } = resolveRoots(opts)
    const retention = Number.isFinite(opts.retentionDays) ? opts.retentionDays : retentionDays
    const stampMs = Number.isFinite(opts.nowMs) ? opts.nowMs : nowMs()
    const cutoffMs = stampMs - retention * DAY_MS

    const all = await list({ root, trashDir: trashRoot, retentionDays: retention, nowMs: stampMs })
    const expired = all.entries.filter((e) => e.trashedAt > 0 && e.trashedAt <= cutoffMs)
    const kept = all.entries.filter((e) => !(e.trashedAt > 0 && e.trashedAt <= cutoffMs)).map((e) => e.id)

    if (opts.dryRun) {
      return {
        ok: true,
        purged: [],
        kept,
        failed: [],
        expired: expired.map((e) => ({ id: e.id, trashedAt: e.trashedAt, originPath: e.originPath })),
        retentionDays: retention,
        retentionMs: retention * DAY_MS,
        cutoffMs
      }
    }

    const result = await purge({ root, trashDir: trashRoot, ids: expired.map((e) => e.id) })
    return {
      ok: result.failed.length === 0,
      purged: result.purged,
      kept,
      failed: result.failed,
      expired: expired.map((e) => ({ id: e.id, trashedAt: e.trashedAt, originPath: e.originPath })),
      retentionDays: retention,
      retentionMs: retention * DAY_MS,
      cutoffMs
    }
  }

  return {
    moveToTrash,
    list,
    restore,
    purge,
    purgeExpired,
    statEntry
  }
}

// ---------------------------------------------------------------------------
// 元数据为什么是 sidecar（评审最关心的问题，写在源码里免得后人重造一遍轮子）
// ---------------------------------------------------------------------------
//
// 候选方案与淘汰理由：
//
//   A. 写进 .md 正文 / frontmatter
//      直接出局 —— 任务要求「不污染用户的 .md 内容」。笔记是用户的资产，任何
//      「为了内部管理而改写用户文件」的设计都会在同步冲突时变成灾难。
//
//   B. 文件名编码（`2024-05-05__sub__note.md`）
//      originPath 里含分隔符与（Windows 上）盘符冒号，编码后的名字会迅速撞上
//      255 字符 / MAX_PATH 限制；而且它会污染用户在列表里看到的名字 —— 恰恰是
//      用来做「最近删除」面板排版的那个字段。
//
//   C. 单张 `<trashRoot>/index.json` 全量表
//      看着最整齐，问题是**写放大与并发**：每次删除都要读全表 + 改一条 + 写全表，
//      两次删除并发就会互相覆盖（丢失别人的 originPath），写一半崩了则可能整表
//      损坏 —— 而这一张表坏了，用户的**全部**可恢复性一起归零。把风险集中在一个
//      文件上，对一个「以防万一」的功能来说是本末倒置。
//
//   D. sidecar（采用）
//      · 每个条目自带元数据，删除 = 写一个小文件，**没有读-改-写**的竞态；
//      · 最坏情况只损失一个条目的位置信息，其余完好；
//      · 用户手工把 .trash 里的文件复制来复制去，元数据也能跟着走；
//      · 列表时按后缀名排除即可，不打扰任何业务文件。
//
//   sidecar 的代价是「多一个文件」，以及元数据丢了要靠文件名 / mtime 兜底 —— 后者
//   正是本模块 `degraded` 机制存在的理由。
// ---------------------------------------------------------------------------

export default { createTrashIndex }
