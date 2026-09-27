import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './app'
import { createNoteIndex } from '../utils/noteIndex'
// 稳定 id 的两块内核：结构操作（noteIdentity）+ 落盘时机（idMapStore）。
// store 只决定「什么时候动映射表」，不发明任何 id 语义。
import {
  createIdMap,
  pathHashId,
  resolveId,
  bindPath,
  rebindPath,
  unbindPath,
  compactIdMap,
  rebuildIdMap
} from '../utils/noteIdentity'
import { loadIdMap, scheduleSaveIdMap } from '../utils/idMapStore'
import { runDateMigration } from '../utils/dateMigration'
import {
  // buildLinkGraph 不再在这里直接调用：链接图由 noteIndex 增量维护并快照，
  // 等价性由 tests/noteIndex.test.js 断言 —— 见下方 linkGraph computed 注释
  extractOutline,
  extractTags,
  parseFrontmatter,
  stringifyFrontmatter,
  resolveLink,
  fuzzyMatch
} from '../composables/useLinks.js'
import { computeTextStats } from '../utils/textStats'
import { markNoteVisited } from '../composables/useCommands'
import { createSampleNotes } from '@/constants/sampleNotes'
import { NOTE_EXTENSIONS as KNOWN_EXTENSIONS, EXT_PATTERN } from '@/constants/noteFile'
// 落盘取名的全部规则（保留设备名 / 结尾空格与点 / 控制字符 / UTF-8 字节截断 /
// 同名消解）都收在这个纯函数模块里，store 只负责提供「已占用的名字」。
// 内核零 import、零磁盘 IO，改动它归 T01，这里只调用不修改。
import { sanitizeFileName, dedupeFileName } from '../utils/fileNaming'
import { createLogger } from '../utils/logger.js'
import { LOG_MODULES } from '../constants/logging.js'

/**
 * 本 store 的模块 logger。放在模块作用域而不是 store 内部：下面若干诊断点是
 * store 之外的纯函数（reportSaveError / safeWriteFile / safeMoveFile），
 * 它们同样需要记日志。
 *
 * 通过它出去的 message 与 data 已由内核统一脱敏（路径遮蔽 + 字符串截断），
 * 调用点**不要**再手工脱敏一次 —— 重复脱敏会把截断后的内容再截一刀。
 */
const noteLog = createLogger(LOG_MODULES.note)

// 原实现用已废弃的 String.prototype.substr 取 [2, 11) 区间；
// slice(2, 11) 结果逐字一致，ID 格式兼容
const generateId = () => Math.random().toString(36).slice(2, 11)

/**
 * ⚠️ 已退役为「活文档」，解析 id 一律走下面的 `resolveNoteId()`。
 *
 * 保留它有两个理由：① 它是兜底语义的出处（映射表缺失时算出来的就是这个值）；
 * ② 它是「存量 id 不许变」的可执行说明 —— 与 `noteIdentity.pathHashId` 逐字
 * 同构，tmp/t19-hash-parity.mjs 用 3015 个输入（含中文 / emoji / 超长路径）
 * 验证过零差异，所以换成 pathHashId 之后**老库里每个 id 都还是原来那个**。
 * 唯一差异是入参防御：老实现 `str.length` 见 null 就抛，内核放宽成空串。
 *
 * 一处口径记录：`(hash << 5) - hash` 是 `*31` 而非标准 djb2 的 `*33`，这里以
 * 代码为准 —— 目标是复刻老 id，不是复刻名字。
 */
const generateStableId = (str) => {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

const SAVE_DEBOUNCE_MS = 500
const saveTimers = new Map()
/** 待写盘但还没写出内容的笔记 id —— 退出/切笔记时用得着 */
const dirtyNotes = new Set()

/**
 * 写盘失败对用户必须可见。之前 writeFile 的 Promise 既不 await 也不 catch，
 * 磁盘只读 / 路径失效 / 权限不足时是静默 Unhandled Rejection，用户以为存了。
 */
function reportSaveError (filePath, error) {
  const message = (error && error.message) || String(error)
  // 诊断侧：写盘失败是本项目最该被留存的一类事件（用户要能把它贴进 issue），
  // 走统一内核才能进环形缓冲与主进程日志。path / reason 由内核统一脱敏。
  noteLog.error('写入失败', { path: filePath, reason: message })
  // ⚠️ 刻意保留的一行裸 console：tests/noteFileOps.test.js 的 expectExplicitError()
  // 是用 console.error 的 spy 断言「写盘失败必须有明确报错」的，而测试文件不在本次
  // owns 内、不能改。等日志断言改成读环形缓冲（getRingBuffer）后，删掉这一行即可，
  // 那时上面的 noteLog.error 是唯一出口。
  console.error('[note] 写入失败:', filePath, message)
  try {
    const app = appSettings()
    if (app && typeof app.pushToast === 'function') {
      app.pushToast({ type: 'error', message: `保存失败：${message}` })
    }
  } catch (e) { /* toast 不可用不影响主流程 */ }
}

/**
 * 把主进程的结构化失败对象还原成带 errno 的 Error。
 *
 * `reportSaveError` 只从 Error 上取 message（顺带给 looksLikePermissionError 认 code），
 * 所以 errno 必须显式写进这两个字段才会出现在日志与 toast 里 —— 否则 T03 要的
 * 「errno 真正传出来」只到渲染进程为止，用户看到的还是那句笼统的「主进程返回失败」。
 *
 * @param {{ok: boolean, error: string, errno: string, message: string}} failure ioFailure() 的返回形态
 * @returns {Error} message 形如 "EACCES permission permission denied"
 */
function describeIoFailure (failure) {
  const errno = typeof failure.errno === 'string' ? failure.errno : ''
  const code = typeof failure.error === 'string' ? failure.error : ''
  const detail = typeof failure.message === 'string' ? failure.message : ''
  const text = [errno, code, detail].filter(Boolean).join(' ') || 'write-failed'
  const error = new Error(text)
  // 挂回 code：IO_ERRNO_PERMISSION / looksLikePermissionError 认的就是它
  if (errno) error.code = errno
  return error
}

/**
 * 统一的安全写盘入口：始终返回 boolean，失败时上报。
 *
 * **返回值契约不能动**：四处调用方（rewriteBacklinks / renameNote / flushSave /
 * saveNoteToFile）都把它当 boolean 用，其中 flushSave 和 saveNoteToFile 还把结果
 * 原样 return 给 UI。所以这里只对外暴露 true/false，结构化 errno 一律在函数内部
 * 消化成报告，不外泄给调用方。
 */
async function safeWriteFile (filePath, content) {
  if (!window.electronAPI?.writeFile || !filePath) return false
  try {
    // 第三参必须传 detail:true：主进程默认是老的 `false` 形态，不开这个开关
    // 拿不到 errno（见 main.cjs 的 ioFailure —— 那是刻意做的 opt-in）。
    const result = await window.electronAPI.writeFile(filePath, content, { detail: true })

    // ① 新形态：{ ok:false, error, errno, message }
    //    判据必须是「显式 ok === false」，不能是 `!result` —— 对象恒为真，
    //    写成那样会把结构化失败判成成功，等于静默丢改动。
    if (result && typeof result === 'object' && result.ok === false) {
      reportSaveError(filePath, describeIoFailure(result))
      return false
    }
    // ② 旧形态：沿用改前的真值语义（true 成功；false / null / undefined 失败），
    //    逐个调用方的行为完全不变 —— noteFileOps.test.js 里注入的写盘失败返回
    //    的就是裸 false，走这一支。
    if (result) return true
    reportSaveError(filePath, new Error('主进程返回失败'))
    return false
  } catch (error) {
    reportSaveError(filePath, error)
    return false
  }
}

/**
 * 笔记文件扩展名白名单（KNOWN_EXTENSIONS）与后缀匹配（EXT_PATTERN）来自
 * @/constants/noteFile —— 渲染侧唯一来源，与 app.js 的 NOTE_EXTENSIONS 同源。
 * 载入时三种都认，切换默认扩展名不会让旧笔记"消失"；新建时才按设置项决定。
 * 主进程 electron/main.cjs 里的那份刻意保持独立：那是安全边界，不能由渲染
 * 进程的常量来约束文件读写。
 */

/** 权限类 errno 关键词：主进程吞掉 errno 之后，唯一还能看出「磁盘在拒绝写入」的线索 */
const IO_ERRNO_PERMISSION = ['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'ETXTBSY', 'EISDIR']

/**
 * 判断一个异常是不是「磁盘拒绝写入」。
 * @param {Error|null} error 异常对象
 * @returns {boolean} 属于权限类返回 true
 */
function looksLikePermissionError (error) {
  const text = `${(error && error.code) || ''} ${(error && error.message) || ''}`
  return IO_ERRNO_PERMISSION.some(name => text.indexOf(name) > -1)
}

/**
 * 真实存在性探测，区分「不在」与「探测失败」。
 *
 * `pathExistsOnDisk` 刻意把探测失败当成存在（保守：宁可多一个 ` 1` 后缀，也不能
 * 覆盖别人的笔记）。但失败之后的**定性**必须区分这二者，所以这里返回三态。
 *
 * @param {string} filePath 绝对路径
 * @returns {Promise<boolean|null>} true 存在 / false 不在 / null 探测不可用
 */
async function probeFileExists (filePath) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api || typeof api.fileExists !== 'function') return null
  try {
    return (await api.fileExists(filePath)) === true
  } catch (error) {
    return null
  }
}

/**
 * 移动失败之后，用只读 IPC 反推失败原因。
 *
 * 只在失败路径执行 —— 成功路径不增加任何 IPC。定性是**尽力而为**：主进程已经把
 * errno 吞掉了，这里只能把「大概率是权限」这一类还原出来，剩下的统一归属
 * `write-failed`，不假装知道。
 *
 * @param {string} oldPath 原路径
 * @param {string} newPath 目标路径
 * @returns {Promise<{code:string|null}>} null 表示「磁盘上其实已经挪过去了」
 */
async function diagnoseMoveFailure (oldPath, newPath) {
  const srcAlive = await probeFileExists(oldPath)
  const dstAlive = await probeFileExists(newPath)
  // 源和目标都在：主进程 copy+unlink 的 fallback 可能「复制成功、unlink 失败」，
  // 磁盘上已经出现两份。必须让用户知道，绝不能当成成功，也不能替他删掉一份。
  if (dstAlive === true && srcAlive === true) return { code: 'conflict' }
  // 目标就位、源已消失：mkdir + rename 其实都成了，是后面的步骤才抛的错
  if (dstAlive === true && srcAlive === false) return { code: null }
  // 源文件没了：多半被外部同步 / 别的进程挪走或删掉了
  if (srcAlive === false) return { code: 'not-found' }
  // 源在、目标不在 → 磁盘拒绝了这次 rename。最后一次定性：目标目录能不能建？
  // mkdir 本来就是 move 的前置动作，这里建它不算引入新副作用。
  const targetDir = dirNameOf(newPath)
  if (typeof window.electronAPI?.createDirectory === 'function') {
    try {
      if ((await window.electronAPI.createDirectory(targetDir)) !== true) {
        return { code: 'permission' }
      }
    } catch (error) {
      return { code: looksLikePermissionError(error) ? 'permission' : 'write-failed' }
    }
  }
  return { code: 'write-failed' }
}

/**
 * 统一的安全移动入口，并把失败**定性**成一个 kebab-case 错误码。
 *
 * 为什么要有结构化返回值：主进程 `fs:move-file` 把 errno 吞成了 `false`
 * （main.cjs:947-950），渲染侧拿不到 EACCES / EROFS，而 UI 必须能区分「目标已存在」
 * 与「磁盘只读」（PRD R-D3 ①）。这里用两条补丁路径还原原因：
 *   ① IPC 直接抛错（mock / 通道缺失 / 主进程崩溃）→ 从 message 里认 errno；
 *   ② 返回 `false` → 用只读 IPC 探测磁盘现状反推，见 diagnoseMoveFailure。
 *
 * @param {string} oldPath 原路径
 * @param {string} newPath 目标路径
 * @returns {Promise<{ok:boolean, code:string, movedTo:string|null}>}
 *   code ∈ 'ok' | 'target-exists' | 'not-found' | 'permission' | 'write-failed' | 'conflict'
 */
async function safeMoveFile (oldPath, newPath) {
  if (!window.electronAPI?.moveFile) return { ok: false, code: 'write-failed', movedTo: null }
  let result = null
  let thrown = null
  try {
    // 显式 overwrite:false：撞名必须整段失败，绝不能覆盖别人的笔记
    result = await window.electronAPI.moveFile(oldPath, newPath, { overwrite: false })
  } catch (error) {
    thrown = error
  }
  if (result === true) return { ok: true, code: 'ok', movedTo: newPath }
  if (result && result.error === 'target-exists') {
    return { ok: false, code: 'target-exists', movedTo: null }
  }
  if (thrown) {
    reportSaveError(newPath, thrown)
    return {
      ok: false,
      code: looksLikePermissionError(thrown) ? 'permission' : 'write-failed',
      movedTo: null
    }
  }

  const diag = await diagnoseMoveFailure(oldPath, newPath)
  // diag.code 为 null 表示磁盘上其实已经挪好了，只是主进程把结果报成了失败
  if (diag.code === null) return { ok: true, code: 'ok', movedTo: newPath }
  return { ok: false, code: diag.code, movedTo: null }
}

/** 懒取 app store：避免与 app.js 形成顶层循环依赖 */
function appSettings() {
  try {
    return useAppStore()
  } catch {
    return null
  }
}

/** 自动保存是否开启（默认开；读取失败时按"开"处理，避免静默丢改动） */
function isAutoSaveOn() {
  return appSettings()?.autoSave !== false
}

/** 新建笔记使用的扩展名 */
function newNoteExtension() {
  const ext = appSettings()?.noteExtension
  return KNOWN_EXTENSIONS.includes(ext) ? ext : 'md'
}

/**
 * 已落盘笔记沿用自己文件的真实后缀（用户可能手动改过，或建笔记时设置不同），
 * 只有还没落盘的新笔记才用设置项里的默认扩展名。
 * 否则「重命名 / 移动笔记」会把 .markdown 悄悄变成 .md，留下磁盘孤儿。
 */
function extensionOf(note) {
  const match = note?.filePath && String(note.filePath).match(EXT_PATTERN)
  return match ? match[1].toLowerCase() : newNoteExtension()
}

/**
 * 写盘前冲突探测的最大次数。取 50 而不是「直到不冲突」：同名笔记成百上千是病态
 * 输入，无界循环会把一次保存卡死；有界循环最差也只是第 50 个候选名仍冲突，
 * 此时 writeFile 的覆盖语义会接管（且内核 dedupeFileName 自己也有 1000 次上限）。
 */
const MAX_CONFLICT_TRIES = 50

/** 目录比对键：统一分隔符 + 去结尾斜杠 + 小写（Windows 路径大小写不敏感） */
function dirKeyOf (p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 取目录部分（不依赖 node:path，渲染进程里没有它） */
function dirNameOf (p) {
  const s = String(p || '').replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i < 0 ? '' : s.slice(0, i)
}

/** 取文件名部分（不依赖 node:path） */
function baseNameOf (p) {
  const s = String(p || '').replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

/**
 * 大小写不敏感的「已占用文件名」集合视图。
 *
 * 为什么需要它：`fileNaming` 内核按**严格字符串**比对做同名消解（它必须保持零
 * 平台分支的纯函数），但 Windows（NTFS）与 macOS（默认 APFS）的文件系统是大小写
 * 不敏感的 —— 磁盘上已有 `note.md` 时再写 `Note.md` 是覆盖，不是新建。
 * 内核的 `taken` 只要满足「有 `has()`、有数字 `size`」就照单全收，所以这里包一层
 * 把比对折叠到小写：内核里的 `used.has(name)` 自动变成大小写不敏感，**无需改内核**。
 */
class CaseInsensitiveNameSet {
  constructor (names = []) {
    this._lower = new Set()
    for (const name of names) this.add(name)
  }

  get size () {
    return this._lower.size
  }

  add (name) {
    const text = String(name === null || name === undefined ? '' : name)
    if (text) this._lower.add(text.toLowerCase())
    return this
  }

  has (name) {
    return this._lower.has(String(name === null || name === undefined ? '' : name).toLowerCase())
  }

  [Symbol.iterator] () {
    return this._lower[Symbol.iterator]()
  }
}

/**
 * 落盘取名被占用时告知用户（R-F3 验收 ②：用户要能看到实际使用的文件名）。
 * 只做展示，失败不影响保存主流程。
 * @param {string} message 提示文案
 * @returns {void}
 */
function notifyInfo (message) {
  try {
    const app = appSettings()
    if (app && typeof app.pushToast === 'function') {
      app.pushToast({ type: 'info', message })
    }
  } catch (e) { /* toast 不可用不影响主流程 */ }
}

/**
 * 探测磁盘上是否真的存在这个路径。
 *
 * 返回值的语义刻意不对称：
 *   · 明确不存在            → false（可以放心写）
 *   · 存在 **或探测失败**   → true（保守：让调用方消解出一个新名字）
 * 「探测失败当成存在」是丢稿代价倒逼出来的：判成不存在会直接覆盖别人的笔记
 * （不可逆），判成存在只是多一个 ` 1` 后缀（可忍受）。
 *
 * 没有 `fs:file-exists` 通道时（浏览器环境 / 未 mock 的测试）返回 false：
 * 此时我们确实无从探测，退化为「只信内存 + 目录列表」，不做无意义的空转。
 *
 * @param {string} filePath 绝对路径
 * @returns {Promise<boolean>} true 表示「别往这个名字写」
 */
async function pathExistsOnDisk (filePath) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api || typeof api.fileExists !== 'function') return false
  try {
    return (await api.fileExists(filePath)) === true
  } catch (error) {
    return true
  }
}

// =========================================================================
// 派生索引：单例、跨 store 实例共享（模块级），由 mutation 点增量维护。
// 纯 JS 结构，不参与 Vue 依赖收集 —— 失效信号由 store 内的 indexVersion ref 提供。
//
// ⚠️ 裁决 1：本轮**刻意不传 `birthtimeOf`**。
//   note.js 现在拿得到的时间是 `file.ctime`，Windows 下它确实等于创建时间，
//   但 Linux 下 ctime 是「状态变更时间」（chmod / 重命名 / 写内容都会刷新它）。
//   拿它当 birthtime 等于把四级回落里的 ② 级退化成 ④ 级，而且是**静默**的：
//   日历看起来有数据，实际上是错的。② 级本轮留空（自动落到 ③ 标题 / ④
//   updatedAt），等后续批次主进程真正提供 `fs.stat().birthtime` 再在这里接上
//   —— 索引侧（noteIndex.createNoteIndex({ birthtimeOf })）已经支持，届时
//   只需补这一个参数，本文件其余部分不用动。
// =========================================================================
const index = createNoteIndex()

// =========================================================================
// id ↔ path 映射表（T19 · R-F1 双轨稳定 id 的接入层）
//
// 模块级**非响应式**变量：映射表只在「解析 id」时被读、在「文件搬家 / 首次落盘
// / 删除」时被改，没有任何订阅者需要它的变更信号 —— 放进 ref / reactive 只是给
// 每次读写白套一层代理（全库载入时几百篇笔记逐条 bind，代理开销是白付的）。
//
// 三层分工，本文件只占第三层：
//   · 结构语义（绑定 / 搬家 / 解绑 / 裁剪 / 重建）→ utils/noteIdentity.js；
//   · 落盘时机（800ms 去抖 / 退出前 flush）      → utils/idMapStore.js；
//   · 什么时候该动映射表                         → 本文件。
//
// 读不出映射表（首次运行 / 文件损坏 / 存储不可用）时它是 null，`resolveNoteId()`
// 自动退回路径哈希 —— 与老版本逐字相同的 id，存量用户的书签 / 双链 / 图谱坐标
// 一个都不会断。
// =========================================================================
let idMap = null

/**
 * 取映射表；还没建（读盘失败 / 尚未初始化）时懒建一张空的。
 * @returns {object} 映射表
 */
function ensureIdMap () {
  if (!idMap) idMap = createIdMap()
  return idMap
}

/**
 * 路径是否已经登记在映射表里。
 *
 * 用**自有属性**判定：映射表是普通 `{}`，`byPath['toString']` 这类原型链上的键
 * 必须挡掉，否则一条叫 'toString' 的路径会被误判成命中。
 *
 * @param {string} path 路径
 * @returns {boolean} 已登记返回 true
 */
function isPathBound (path) {
  const p = typeof path === 'string' ? path : ''
  if (!p || !idMap || !idMap.byPath) return false
  return Object.prototype.hasOwnProperty.call(idMap.byPath, p)
}

/**
 * 解析一个路径的 id —— 全库唯一的 id 入口（替换掉原来的 `generateStableId(path)`）。
 *
 *   ① 映射表命中 → 用它。**移动 / 重命名之后 id 不变**，这就是 R-F1 的全部意义；
 *   ② 未命中 → `pathHashId(path)`（与老实现逐字同构，3015 例零差异），并顺手
 *      登记，让下一次查询不必再重算哈希。
 *
 * @param {string} filePath 笔记的绝对路径
 * @returns {string} id；路径为空时返回 ''
 */
function resolveNoteId (filePath) {
  const p = typeof filePath === 'string' ? filePath : ''
  if (!p) return ''
  const id = resolveId(idMap, p)
  if (!isPathBound(p)) bindPath(ensureIdMap(), id, p)
  return id
}

/**
 * 登记 / 更新一条绑定（新笔记首次落盘、外部文件入库时）。
 * @param {string} id 笔记 id
 * @param {string} filePath 路径
 * @returns {void}
 */
function rememberPath (id, filePath) {
  const p = typeof filePath === 'string' ? filePath : ''
  if (!p || !id) return
  bindPath(ensureIdMap(), id, p)
  persistIdMap()
}

/**
 * 笔记搬家 / 改名：**id 跟着路径走**（rebindPath）。
 *
 * 只在磁盘动作**成功之后**调用 —— 失败分支绝不能碰映射表，否则内存记着「已经
 * 搬到了 B」而磁盘上还在 A，下一次保存就在 A 上造孤儿。
 *
 * @param {string} oldPath 原路径
 * @param {string} newPath 新路径
 * @returns {void}
 */
function movePathBinding (oldPath, newPath) {
  const from = typeof oldPath === 'string' ? oldPath : ''
  const to = typeof newPath === 'string' ? newPath : ''
  if (!from || !to || from === to) return
  rebindPath(ensureIdMap(), from, to)
  persistIdMap()
}

/**
 * 解绑一条路径（笔记被删除 / 目录被移出时）。
 * @param {string} filePath 路径
 * @returns {void}
 */
function forgetPath (filePath) {
  const p = typeof filePath === 'string' ? filePath : ''
  if (!p) return
  unbindPath(ensureIdMap(), p)
  persistIdMap()
}

/**
 * 去抖落盘映射表。
 *
 * 一次「移动文件夹」会连着重绑几十条路径，每条都真写一次盘是把 SSD 花在几毫秒
 * 后就被覆盖掉的中间态上。真正的兜底是 main.js 里装的 `installIdMapFlush()`
 * （beforeunload / pagehide）+ 主进程的退出握手。
 *
 * @returns {void}
 */
function persistIdMap () {
  if (idMap) scheduleSaveIdMap(idMap)
}

export const useNoteStore = defineStore('note', () => {
  // 工厂函数而非共享常量：resetConfig 会 push 这些对象，共享引用会让多轮
  // reset 之间互相污染（编辑过的示例笔记变成"模板"）
  const notes = ref(createSampleNotes())
  const currentNoteId = ref('note1')
  const selectedFolder = ref('工作笔记')
  const expandedFolders = ref(['工作笔记', '项目文档'])
  const searchQuery = ref('')
  const sortBy = ref('updated')
  const viewMode = ref('list')
  const notesPath = ref(null)
  const isLoading = ref(false)

  // =======================================================================
  // 派生索引的失效信号
  // noteIndex 是纯 JS Map 结构，不参与 Vue 依赖收集；computed 通过读
  // indexVersion 建立依赖，所有改写索引的动作都必须走下面三个包装函数。
  // =======================================================================
  const indexVersion = ref(0)

  /** 读一次版本号：让调用它的 computed 把索引变更计入依赖 */
  function readIndexVersion () {
    return indexVersion.value
  }
  function touchIndex () {
    indexVersion.value += 1
  }
  /**
   * 单篇笔记进/更新索引。
   * @param {object} note 笔记对象
   * @param {number} position 0 = 插到最前（对应 notes.unshift）；-1 = 追加
   * @returns {void}
   */
  function reindexNote (note, position = -1) {
    index.upsert(note, position)
    touchIndex()
  }
  /**
   * 单篇笔记出索引。
   * @param {string} id 笔记 id
   * @returns {void}
   */
  function unindexNote (id) {
    index.remove(id)
    touchIndex()
  }
  /** 全量重建索引（切库 / resetConfig / 批量改写 folder 之后） */
  function reindexAll () {
    index.replaceAll(notes.value)
    touchIndex()
  }

  // 初始状态必须与 notes 对齐（store 实例可能被复用 / 重建）
  reindexAll()

  const folders = computed(() => {
    const folderMap = {}
    notes.value.forEach(note => {
      const folder = note.folder
      if (!folder) return
      if (!folderMap[folder]) {
        folderMap[folder] = { name: folder, count: 0 }
      }
      folderMap[folder].count++
    })
    return Object.values(folderMap).sort((a, b) => a.name.localeCompare(b.name))
  })

  const currentNote = computed(() => {
    return notes.value.find(n => n.id === currentNoteId.value) || null
  })

  // =======================================================================
  // 列表：拆成「搜索过滤」与「排序」两层 —— 改排序方式 / 改搜索词只需重跑一半，
  // 击键（改笔记内容）不再触发任何一层。
  // =======================================================================
  const searchFiltered = computed(() => {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return notes.value
    return notes.value.filter(n =>
      String(n.title || '').toLowerCase().includes(query) ||
      String(n.content || '').toLowerCase().includes(query)
    )
  })

  /**
   * 按时间字段倒序：预计算数字时间戳，避免 O(n log n) 次 new Date()。
   * @param {Array<object>} list 笔记数组
   * @param {string} field 时间字段名
   * @returns {Array<object>} 排好序的新数组
   */
  function sortByTimeDesc (list, field) {
    return list
      .map(n => {
        const t = new Date(n[field]).getTime()
        return { n, t: Number.isFinite(t) ? t : 0 }
      })
      .sort((a, b) => b.t - a.t)
      .map(item => item.n)
  }

  const sortedNotes = computed(() => {
    const list = [...searchFiltered.value]
    if (sortBy.value === 'updated') {
      // 裁决：列表排序**仍然按 updatedAt**，不换成新的归属日期 —— 换口径会让
      // 用户整个列表的顺序一次性全变，属于行为破坏（用户会以为笔记被重排/丢了）。
      // 新日期语义只改变**日历**（notesByDate / getNotesByDate 走索引 dateKey）。
      return sortByTimeDesc(list, 'updatedAt')
    } else if (sortBy.value === 'created') {
      return sortByTimeDesc(list, 'createdAt')
    } else if (sortBy.value === 'title') {
      return list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')))
    }
    return list
  })

  /** 对外保持同名同语义 */
  const filteredNotes = computed(() => sortedNotes.value)

  const notesByFolder = computed(() => {
    const map = {}
    notes.value.forEach(note => {
      const folder = note.folder || ''
      if (!map[folder]) map[folder] = []
      map[folder].push(note)
    })
    return map
  })

  // 走索引：每次改内容只重解析被改的那一篇，这里是 O(笔记数 × 标签数) 的归并
  const allTags = computed(() => {
    readIndexVersion()
    return index.allTags()
  })

  // =========================================================================
  // Obsidian 风格链接图
  // 走索引缓存：snapshots 与直接 buildLinkGraph(notes) 结果等价
  // （tests/noteIndex.test.js 逐方法断言），但每次编辑只重解析被改的那一篇。
  // =========================================================================
  const linkGraph = computed(() => {
    readIndexVersion()
    return index.snapshot()
  })

  function getBacklinks (noteId) {
    return linkGraph.value.getBacklinks(noteId)
  }
  function getOutgoing (noteId) {
    return linkGraph.value.getOutgoing(noteId)
  }
  function getUnresolved (noteId) {
    return linkGraph.value.getUnresolved(noteId)
  }
  function getNotesByTag (tag) {
    return linkGraph.value.getNotesByTag(tag)
  }
  function findByTitle (title) {
    if (!title) return []
    const ids = linkGraph.value.getByTitle(title)
    return ids.map(id => notes.value.find(n => n.id === id)).filter(Boolean)
  }
  function findNoteByWikiTarget (anchor, ctxNote) {
    return resolveLink(anchor, ctxNote, notes.value)
  }
  function resolveWikiForRender (target) {
    const found = resolveLink(target, null, notes.value)
    if (!found) return { resolved: false, id: null, title: target }
    return { resolved: true, id: found.id, title: found.title }
  }
  function searchNotesFuzzy (query, limit = 20) {
    const hits = fuzzyMatch(query, notes.value, { key: n => `${n.title} ${n.folder} ${getInlineTagsHint(n.content)}` })
    return hits.slice(0, limit).map(h => h.item)
  }
  function getInlineTagsHint (md) {
    try { return extractTags(md).join(' ') } catch { return '' }
  }
  function getNoteOutline (noteId) {
    const note = notes.value.find(n => n.id === noteId)
    return note ? extractOutline(note.content) : []
  }
  function getNoteFrontmatter (noteId) {
    const note = notes.value.find(n => n.id === noteId)
    if (!note) return parseFrontmatter('')
    return parseFrontmatter(note.content)
  }
  function updateNoteFrontmatter (noteId, patch) {
    const note = notes.value.find(n => n.id === noteId)
    if (!note) return false
    const { frontmatter, body } = parseFrontmatter(note.content)
    const next = { ...frontmatter, ...patch }
    Object.keys(next).forEach(k => {
      if (next[k] === undefined || next[k] === null) delete next[k]
    })
    const newContent = stringifyFrontmatter(next, body)
    updateNoteContent(noteId, newContent)
    return true
  }
  function createNoteFromWikiTarget (target, folder = '') {
    const title = String(target || '').replace(/^.*\//, '').replace(/\.md$/i, '') || '新笔记'
    return createNote(folder, title)
  }

  // =========================================================================
  // 文件夹 / 笔记移动 & 重命名（侧边栏 DnD & 右键菜单用）
  // =========================================================================
  /** 把磁盘路径拼装逻辑收敛到一处：notesPath + folder + fileName */
  function buildFilePath (folder, fileName) {
    const base = notesPath.value || ''
    return folder ? `${base}/${folder}/${fileName}` : `${base}/${fileName}`
  }

  /**
   * 文件名安全化：标题 → 可直接落盘的完整文件名（含扩展名）。
   *
   * 之前只有一行正则（`title.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext`），挡不住
   * Windows 保留设备名（CON / NUL.md / LPT1 → 写进设备句柄）、结尾空格与点
   * （磁盘静默裁尾 → 内存路径与磁盘名不一致）、控制字符、以及超长名按 UTF-16
   * 截断切坏汉字这四类。现在全部交给 `fileNaming.sanitizeFileName`（T01 内核）。
   *
   * 刻意保留的一处**不做**的事：不剥掉标题里自带的扩展名，所以 `# NUL.md`
   * 会得到 `_NUL.md.md`。理由是 `safeFileName` 有四个调用点，其中 `deleteNote`
   * 用它**反推磁盘路径去删除文件**；在那里剥扩展名会让推算出的路径指向另一篇
   * 真实存在的笔记，误删风险远大于「多一个 .md」的观感问题。
   * 真正需要剥的地方（`createNoteFromWikiTarget`）已经自己剥了。
   * 若后续要统一处理，请在只用于「取名」的调用点单独剥，不要改这里。
   *
   * @param {string} title 笔记标题
   * @param {string} ext 扩展名，'md' 与 '.md' 都接受
   * @param {Set<string>|Array<string>|object|null} [taken=null] 同目录已占用的
   *        文件名（含扩展名）；传了才会做同名消解
   * @returns {string} 完整文件名，形如 '笔记.md'
   */
  function safeFileName (title, ext, taken = null) {
    return sanitizeFileName(title, ext, { taken })
  }

  /**
   * 收集「目标目录里已经占用的文件名」，作为落盘取名的消解依据（R-F3）。
   *
   * 三个来源缺一不可，漏哪一个都会演变成覆盖别人的文件：
   *   ① **内存里已落盘的同目录笔记** —— 取 `filePath` 的真实 basename。不能拿
   *      标题反推：用户可能手动改过文件名，标题与文件名未必一致。
   *   ② **内存里还没落盘的同目录笔记** —— 它们马上也要占一个名字。不预先登记，
   *      「连续新建 3 篇同名笔记 + 一次性 flushAll / Ctrl+S」会三篇算到同一个
   *      名字上，最后磁盘只剩 1 个文件。
   *   ③ **磁盘上的真实目录** —— 这是本任务的核心风险点：外部新建的、索引还没
   *      建好的、其它设备同步过来的文件**在内存里根本不存在**，只靠 ①② 一定漏。
   *      走一次 `fs:read-directory`（主进程 `readdir` 会跳过点文件，点文件不会
   *      与笔记名撞车，见 sanitizeFileName 的取名规则，无影响）。
   *
   * ② 只登记**比自己更早创建**的未落盘笔记：`createNote` 用 `unshift`，数组下标
   * 越大说明创建越早，应当先拿干净名。这样最早建的那篇得到 `X.md`，符合直觉。
   *
   * @param {string} dirPath 目标目录的绝对路径
   * @param {string} folder 目标目录的相对 folder（与 note.folder 同语义）
   * @param {object} currentNote 正在取名的笔记（自身不计入占用）
   * @returns {Promise<CaseInsensitiveNameSet>} 已占用的文件名集合
   */
  async function collectTakenNames (dirPath, folder, currentNote) {
    const taken = new CaseInsensitiveNameSet()
    const targetDir = dirKeyOf(dirPath)
    // 必须按 id 比对，不能按引用：`notes.value[i]` 取到的是**响应式代理**，
    // 而 createNewNoteFile 传进来的是 createNote 返回的原始对象，二者 `===`
    // 为 false —— 曾因此把「自己」也算进占用集合，于是每篇新建笔记都凭空
    // 多出一个 ' 1' 后缀。
    const currentId = currentNote ? currentNote.id : null
    const currentIndex = currentId
      ? notes.value.findIndex(n => n.id === currentId)
      : -1

    // ① 已落盘的同目录笔记
    for (const n of notes.value) {
      if (!n.filePath) continue
      if (dirKeyOf(dirNameOf(n.filePath)) !== targetDir) continue
      taken.add(baseNameOf(n.filePath))
    }

    // ② 还没落盘的同目录笔记（下标更大 = 更早创建）
    for (let i = 0; i < notes.value.length; i += 1) {
      const n = notes.value[i]
      if (n.id === currentId || n.filePath) continue
      if ((n.folder || '') !== folder) continue
      if (currentIndex > -1 && i < currentIndex) continue
      taken.add(safeFileName(n.title, extensionOf(n)))
    }

    // ③ 磁盘真实目录
    if (typeof window.electronAPI?.readDirectory === 'function') {
      try {
        const entries = await window.electronAPI.readDirectory(dirPath)
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry && entry.name) taken.add(String(entry.name))
          }
        }
      } catch (error) {
        // 读不到目录（还没建 / 权限）不能让保存失败：退化为「只信内存」，
        // 下面 pickAvailableName 的 fs:file-exists 复核仍然兜得住。
        // 路径与原因分开传：message 里拼路径会绕过 data 的结构化渲染，
        // data 里的 path 由内核统一做家目录遮蔽。
        noteLog.warn('读取目录失败，同名消解退化为内存侧', {
          path: dirPath,
          reason: error?.message || error
        })
      }
    }

    return taken
  }

  /**
   * 写盘前的最后一道闸门：拿**磁盘真实状态**复核候选名，被占用就继续消解。
   *
   * 为什么 `collectTakenNames` 之后还要再探一次：目录列表与写盘之间存在时间窗
   * （并发保存、外部同步），而且目录读不到时只能退化为内存侧。内核是纯函数、
   * 不碰磁盘，这一跳只能由 store 来做。
   *
   * @param {string} dirPath 目标目录绝对路径
   * @param {string} baseName 期望文件名（含扩展名）
   * @param {CaseInsensitiveNameSet} taken 已占用文件名集合（会被就地补充）
   * @returns {Promise<string>} 复核通过的文件名
   */
  async function pickAvailableName (dirPath, baseName, taken) {
    let name = baseName
    for (let attempt = 0; attempt < MAX_CONFLICT_TRIES; attempt += 1) {
      if (!(await pathExistsOnDisk(`${dirPath}/${name}`))) return name
      // 磁盘上确实有（很可能是内存里没索引到的文件）→ 登记后再消解一次
      taken.add(name)
      const next = dedupeFileName(name, taken)
      if (next === name) return name
      name = next
    }
    return name
  }

  // =========================================================================
  // OpResult —— 移动 / 重命名的统一返回结构（设计文档 §4.5 错误码口径）
  //
  // 旧实现无论磁盘成没成都同步 return true，写盘失败被埋在 fire-and-forget 的
  // async 执行体里，UI 只能「先按成功刷新，失败后再把结构弹回去」—— 这就是
  // PRD R-D3 ① 要消灭的现象。现在的口径：
  //   磁盘全部成功 → 才更新内存 → ok:true；
  //   任何一步失败 → 内存保持原样 → ok:false + 可区分场景的 code。
  // UI 必须按 code 映射中文文案，不要把英文 code 直接显示给用户（message 是兜底文案）。
  // =========================================================================

  /**
   * code → 中文兜底文案。设计文档 §4.5 要求 UI 自己维护映射表，
   * 这里是给尚未做映射的调用方（以及旧调用方）兜底用的。
   */
  const OP_MESSAGE_TEXT = {
    ok: '操作已完成',
    noop: '无需变更',
    'not-found': '找不到对应的笔记或文件',
    'invalid-title': '标题不能为空',
    'target-exists': '目标位置已存在同名笔记，未做任何改动',
    permission: '磁盘拒绝写入（只读或没有权限），未做任何改动',
    'write-failed': '写入磁盘失败，未做任何改动',
    conflict: '源与目标同时存在，可能已经产生了重复文件，请手动确认',
    'rename-partial': '笔记已经改名，但有部分内容没能写入磁盘'
  }

  /**
   * 构造成功 OpResult。`failed` 恒为数组，调用方不必判空。
   * @param {string} code 成功码：'ok' / 'noop'
   * @param {object} [extra={}] 附加字段
   * @returns {{ok:boolean, code:string, message:string, failed:Array<object>}} OpResult
   */
  function opOk (code = 'ok', extra = {}) {
    return { ok: true, code, message: OP_MESSAGE_TEXT[code] || '操作已完成', failed: [], ...extra }
  }

  /**
   * 构造失败 OpResult。
   * @param {string} code kebab-case 错误码
   * @param {string} [message=''] 覆盖兜底文案（需要带上下文时用）
   * @param {object} [extra={}] 附加字段
   * @returns {{ok:boolean, code:string, message:string, failed:Array<object>}} OpResult
   */
  function opFail (code, message = '', extra = {}) {
    return {
      ok: false,
      code,
      message: message || OP_MESSAGE_TEXT[code] || '操作失败',
      failed: [],
      ...extra
    }
  }

  /**
   * 把正文首行 H1 换成新标题；原本就不是 H1 开头则原样返回。
   *
   * 抽成纯函数是为了让「改完之后长什么样」在动磁盘**之前**就算出来 ——
   * 原子化的前提是先算完结果再落地，不能一边改内存一边算。
   *
   * @param {string} content 原正文
   * @param {string} title 新标题
   * @returns {string} 新正文
   */
  function withFirstH1 (content, title) {
    const text = String(content || '')
    const lines = text.split('\n')
    if (!/^#\s+/.test(lines[0])) return content
    lines[0] = `# ${title}`
    return lines.join('\n')
  }

  /**
   * 移动笔记到目标文件夹（原子化）。
   *
   * 顺序：**先算目标路径 → 再动磁盘 → 全部成功才动内存**。
   * 之前是「先把 note.folder 改成新值并刷索引，再去慢慢搬文件，失败再改回去」，
   * 弹回这一步少改一个字段（folder / filePath / 索引三处）就永久错位 ——
   * 后续保存会写到已经不存在的旧路径上，制造孤儿文件。
   *
   * @param {string} noteId 笔记 id
   * @param {string} targetFolder 目标文件夹相对路径；'' 表示根目录
   * @returns {Promise<{ok:boolean, code:string, message:string, failed:Array<object>}>} OpResult
   *   code ∈ 'ok' | 'noop' | 'not-found' | 'target-exists' | 'permission' | 'write-failed' | 'conflict'
   */
  async function moveNote (noteId, targetFolder) {
    const note = notes.value.find(n => n.id === noteId)
    if (!note) return opFail('not-found', '笔记不存在')
    const target = String(targetFolder || '')
    if ((note.folder || '') === target) return opOk('noop')

    // 磁盘不可达（示例库 / 浏览器环境）时只改内存，保持旧行为
    const canTouchDisk = Boolean(note.filePath && window.electronAPI && notesPath.value)
    let newPath = note.filePath

    if (canTouchDisk) {
      // 刻意不传 taken 做同名消解：移动撞名就该明确失败（R-D3 ①），悄悄改成
      // 「笔记 1」会让用户在目标目录里找不到自己的笔记。消解只属于新建落盘。
      newPath = buildFilePath(target, safeFileName(note.title, extensionOf(note)))
      if (newPath === note.filePath) return opOk('noop')

      // ① 先把当前内容刷到旧路径：否则文件搬走之后，防抖定时器拿着旧 filePath
      //    把内容写回源目录，留下一份孤儿。这一步失败就整段中止，磁盘没被碰过。
      if (!(await flushSave(noteId))) {
        return opFail('write-failed', '保存失败，移动已中止（磁盘内容未被改动）')
      }
      // ② 目标占位预检：命中就退出，此刻磁盘与内存都还没动过
      if (await pathExistsOnDisk(newPath)) {
        // 提示交给调用方：T06 起 Sidebar 已 await OpResult 并按 code 出「移动失败：…」。
        // 这里不再自己弹 toast —— 否则「保存失败：…」与「移动失败：…」会同时冒出两条，
        // 用户只会以为发生了两件不同的故障。诊断信息照旧留在日志里。
        noteLog.warn('移动中止：目标位置已存在同名笔记', { path: newPath, code: 'target-exists' })
        return opFail('target-exists')
      }
      // ③ 真正搬动
      const moved = await safeMoveFile(note.filePath, newPath)
      if (!moved.ok) {
        // 同上：失败提示由 Sidebar 按 code 统一出，这里只留日志。
        // safeMoveFile 内部对「IPC 抛错」这一支已经自己记过一次（见下方 safeMoveFile），
        // 这里补的是定性之后的结果码，两者不重复。
        noteLog.warn('移动失败', { path: newPath, from: note.filePath, code: moved.code })
        return opFail(moved.code)
      }
      newPath = moved.movedTo || newPath
    }

    // 磁盘阶段全部通过 —— 到这儿才更新内存
    const oldPath = note.filePath        // 改之前先存：rebind 需要旧键
    note.folder = target
    note.updatedAt = new Date()
    if (canTouchDisk) {
      note.filePath = newPath
      // id 跟着路径走：映射表里把 id 从旧路径搬到新路径，**id 本身一个字都不变**
      // —— 书签 / 最近打开 / 图谱坐标 / 正在编辑的当前笔记因此全部保活
      movePathBinding(oldPath, newPath)
    }
    // folder / filePath 都是索引键，必须同批同步
    reindexNote(note)
    return opOk('ok', { changed: 1, succeeded: 1 })
  }

  /**
   * 重命名笔记时同步改写其它笔记里的 [[旧标题]]。
   *
   * 不做这一步，重命名之后所有指向它的内链瞬间变死链（Obsidian 的标准行为）。
   *
   * 为什么内部写盘必须 **await**：原来是 fire-and-forget，调用方拿到的 changed
   * 只是一个「打算改几篇」的数字，写没写成功无从知晓 —— 磁盘只读时用户以为改好了，
   * 重启后链接还是旧的（R-D2）。
   *
   * 每篇都走「**先写盘、成功才改内存**」：写失败就把这篇同时排除在内存变更之外，
   * 内存与磁盘保持一致，并如实记进 failed。这样用户修好权限后重做一次重命名就能
   * 补全（幂等）；反过来「先改内存再写」在写失败时只能回滚，而回滚本来就弹不干净。
   *
   * @param {string} oldTitle 旧标题
   * @param {string} newTitle 新标题
   * @returns {Promise<{total:number, succeeded:number, failed:Array<{id:string, path:string, error:string, reason:string}>, changedIds:Set<string>}>}
   *   total = 需要改写的笔记数；succeeded = 已确认写盘（或纯内存无需写盘）的篇数
   */
  async function rewriteBacklinks (oldTitle, newTitle) {
    const empty = { total: 0, succeeded: 0, failed: [], changedIds: new Set() }
    if (!oldTitle || !newTitle || oldTitle === newTitle) return empty
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 匹配 [[old]] / [[old|别名]] / [[old#标题]] ，保留后面的锚点与别名
    const re = new RegExp('\\[\\[\\s*' + escapeRe(oldTitle) + '\\s*((?:[#|][^\\]]*)?)\\]\\]', 'g')

    let total = 0
    let succeeded = 0
    const failed = []
    const changedIds = new Set()

    // 串行 await：这些写盘落在同一批文件上，并发发起只会让「谁先谁后」不可复现，
    // 事后难以定位到底是哪一篇失败；而改名本身也不是高频操作。
    for (const n of notes.value) {
      if (!n.content || !n.content.includes('[[')) continue
      const next = n.content.replace(re, (_m, tail) => `[[${newTitle}${tail || ''}]]`)
      if (next === n.content) continue
      total += 1

      // 纯内存的笔记（还没落过盘）：没有磁盘状态可错位，改完登记待写即可
      if (!n.filePath) {
        n.content = next
        n.updatedAt = new Date()
        changedIds.add(n.id)
        reindexNote(n)
        dirtyNotes.add(n.id)
        succeeded += 1
        continue
      }

      const writeOk = await safeWriteFile(n.filePath, next)
      if (!writeOk) {
        failed.push({
          id: n.id,
          path: n.filePath,
          error: '写入失败（磁盘只读、被占用或路径不可写）',
          reason: 'backlink'
        })
        continue
      }
      n.content = next
      n.updatedAt = new Date()
      changedIds.add(n.id)
      // 链接文本变了 → 图谱 / 反链必须跟着更新，否则停在旧状态
      reindexNote(n)
      succeeded += 1
    }
    return { total, succeeded, failed, changedIds }
  }

  /**
   * 重命名笔记（原子化）。
   *
   * 顺序同样是「先算完 → 再动磁盘 → 全成功才动内存」，并且串行化「flush 旧路径 →
   * 移动文件」，消掉原来「写旧路径」与「rename」并发导致的丢内容 / 孤儿。
   *
   * **做不到的那个角落**：一旦文件在磁盘上真的被改名了，内存就必须跟着改
   * （title / content / filePath），否则 filePath 会指向一个不存在的文件，
   * 下一次自动保存就在那个不存在的路径上造孤儿。所以此时若「自身正文落盘」
   * 这一步失败，只能如实报 `rename-partial`，不能回滚。
   *
   * @param {string} noteId 笔记 id
   * @param {string} newTitle 新标题
   * @returns {Promise<{ok:boolean, code:string, message:string, partial?:boolean, total?:number, succeeded?:number, failed:Array<object>}>} OpResult
   *   code ∈ 'ok' | 'noop' | 'not-found' | 'invalid-title' | 'target-exists' |
   *          'permission' | 'write-failed' | 'conflict' | 'rename-partial'
   */
  async function renameNote (noteId, newTitle) {
    const note = notes.value.find(n => n.id === noteId)
    if (!note) return opFail('not-found', '笔记不存在')
    const cleanTitle = String(newTitle || '').trim()
    if (!cleanTitle) return opFail('invalid-title')
    if (cleanTitle === note.title) return opOk('noop')

    const oldTitle = note.title
    const oldPath = note.filePath
    const nextContent = withFirstH1(note.content, cleanTitle)
    const canTouchDisk = Boolean(oldPath && window.electronAPI && notesPath.value)
    let newPath = oldPath

    if (canTouchDisk) {
      // 与 moveNote 同理：改名撞名同样是明确失败，不自动加后缀
      newPath = buildFilePath(note.folder, safeFileName(cleanTitle, extensionOf(note)))
      // 先把现有内容刷到旧路径并取消挂起的防抖写入，避免 old/new 两处竞争
      if (!(await flushSave(noteId))) {
        return opFail('write-failed', '保存失败，重命名已中止（磁盘内容未被改动）')
      }
      if (newPath !== oldPath) {
        if (await pathExistsOnDisk(newPath)) {
          // 与 moveNote 同一口径：提示由 Sidebar 按 code 出，这里只记日志
          noteLog.warn('重命名中止：目标位置已存在同名笔记', { path: newPath, code: 'target-exists' })
          return opFail('target-exists')
        }
        const moved = await safeMoveFile(oldPath, newPath)
        if (!moved.ok) {
          // 同上：不再自己弹 toast，避免「保存失败：…」与「重命名失败：…」重复两条
          noteLog.warn('重命名失败：文件搬动未成功', { path: newPath, from: oldPath, code: moved.code })
          return opFail(moved.code)
        }
        newPath = moved.movedTo || newPath
      }
    }

    // ---------- 磁盘阶段全部通过：提交到内存 ----------
    note.title = cleanTitle
    note.content = nextContent
    note.updatedAt = new Date()
    if (newPath !== oldPath) {
      note.filePath = newPath
      // 同上：改名也是搬家，id 必须跟着走
      movePathBinding(oldPath, newPath)
    }
    // 标题 / 内容 / filePath 都参与索引键与链接解析，必须一次性同步
    reindexNote(note)

    let total = 0
    let succeeded = 0
    const failed = []
    if (!canTouchDisk) dirtyNotes.add(noteId)

    // 反向链接改写必须排在自身 content 更新之后：否则自己体内的 [[旧标题]]
    // 会被当成「别处的链接」多处理一轮
    const backlinks = await rewriteBacklinks(oldTitle, cleanTitle)
    total += backlinks.total
    succeeded += backlinks.succeeded
    for (const item of backlinks.failed) failed.push(item)
    // rewriteBacklinks 有可能改到本篇自身（自链），再同步一次索引
    reindexNote(note)

    if (canTouchDisk) {
      // 自身正文：rewriteBacklinks 写过（自链场景）就不重复写；没写过就得补一次，
      // 否则磁盘上的文件名虽然改了，正文里的 H1 还是旧标题。
      const needsContentWrite = !backlinks.changedIds.has(noteId)
      if (needsContentWrite) total += 1
      if (needsContentWrite) {
        if (await safeWriteFile(newPath, note.content)) {
          succeeded += 1
          dirtyNotes.delete(noteId)
        } else {
          // 内存已经不可能回退（磁盘上的文件已经改名了），只能登记待写 + 上报
          dirtyNotes.add(noteId)
          failed.push({
            id: noteId,
            path: newPath,
            error: '写入失败（磁盘只读、被占用或路径不可写）',
            reason: 'content'
          })
        }
      }
    }

    if (failed.length > 0) {
      return opFail(
        'rename-partial',
        `笔记已改名为「${cleanTitle}」，但有 ${failed.length} 处内容没能写入磁盘`,
        { partial: true, total, succeeded, failed }
      )
    }
    return opOk('ok', { total, succeeded, failed: [] })
  }

  async function createFolder (folderPath) {
    if (!folderPath) return false
    if (expandedFolders.value.indexOf(folderPath) === -1) expandedFolders.value.push(folderPath)
    // 同步磁盘
    if (notesPath.value && window.electronAPI) {
      const dirPath = buildFilePath(folderPath, '').replace(/\/$/, '')
      try {
        await window.electronAPI.createDirectory(dirPath)
      } catch (error) {
        reportSaveError(dirPath, error)
      }
    }
    return true
  }

  /**
   * 删除文件夹：把目录真的从磁盘删掉（走回收站），而不只是把笔记甩到根目录。
   * 之前只改内存，重启后目录"复活"，UI 与磁盘长期不一致。
   */
  async function deleteFolder (folderPath) {
    if (!folderPath) return false
    const affected = notes.value.filter(
      n => n.folder === folderPath || n.folder.startsWith(folderPath + '/')
    )

    // 先把待写盘内容落定，避免删除后定时器又写回。
    // flushSave 是 async：原来的 forEach 不 await，等于刚发起写盘就把文件删了，
    // 最后一屏编辑会丢，或删除成功后又被写回成孤儿。这里必须等到所有写盘结束。
    await Promise.all(affected.filter(n => n.filePath).map(n => flushSave(n.id)))
    // 取消其余挂起写入：目录即将消失，写进去就是孤儿
    clearPendingSaves()

    // 只从库中移除笔记（文件随目录一起走回收站，不需要逐个 deleteFile）
    affected.forEach(n => {
      const pos = notes.value.findIndex(x => x.id === n.id)
      if (pos > -1) notes.value.splice(pos, 1)
      unindexNote(n.id)
      // 整棵子树的路径随目录一起没了，映射表同步解绑
      if (n.filePath) forgetPath(n.filePath)
    })

    const idx = expandedFolders.value.indexOf(folderPath)
    if (idx > -1) expandedFolders.value.splice(idx, 1)
    if (selectedFolder.value === folderPath) selectedFolder.value = ''
    if (currentNoteId.value && !notes.value.some(n => n.id === currentNoteId.value)) {
      currentNoteId.value = notes.value[0]?.id || null
    }

    if (!notesPath.value || !window.electronAPI) return true
    const dirPath = buildFilePath(folderPath, '').replace(/\/$/, '')
    let ok = false
    if (window.electronAPI.removeDir) {
      try {
        ok = await window.electronAPI.removeDir(dirPath)
      } catch (error) {
        ok = false
      }
    }
    if (!ok) {
      // 目录删除失败（例如目录不存在）→ 至少把笔记放回根，保持 UI 与磁盘一致
      affected.forEach((n, i) => {
        n.folder = ''
        notes.value.push(n)
        reindexNote(n)
        // 文件还在原处：把上面解掉的绑定补回去，别让这批笔记退化成哈希 id
        if (n.filePath) rememberPath(n.id, n.filePath)
      })
      selectedFolder.value = ''
    }
    return ok
  }

  /**
   * 收集某个文件夹及其全部子文件夹下的笔记。
   * @param {string} folderPath 文件夹路径
   * @returns {Array<object>} 命中的笔记（保持 notes 原顺序）
   */
  function collectFolderNotes (folderPath) {
    return notes.value.filter(
      n => n.folder === folderPath || n.folder.startsWith(folderPath + '/')
    )
  }

  /**
   * 文件夹改名 / 移动后，批量改写受影响笔记的 folder 与 filePath，并同步索引。
   * renameFolder 与 moveFolder 共用这一份实现，避免两处逻辑各自漂移。
   * @param {Array<object>} affected 受影响笔记（引用必须在改写之前取到）
   * @param {string} oldPath 原文件夹路径
   * @param {string} newPath 新文件夹路径
   * @returns {void}
   */
  function rewriteFolderPaths (affected, oldPath, newPath) {
    // 先把原始 folder 全部快照下来：改写过程中 note.folder 会被覆盖，
    // 边改边读会算错子目录的切片长度
    const oldFolders = affected.map(n => n.folder)
    affected.forEach((n, i) => {
      const oldFolder = oldFolders[i]
      n.folder = oldFolder === oldPath ? newPath : newPath + oldFolder.slice(oldPath.length)
      if (n.filePath && notesPath.value) {
        // filePath 同样替换为新路径，否则后续保存会写到旧目录
        const oldDir = buildFilePath(oldFolder, '').replace(/\/$/, '')
        const newDir = buildFilePath(n.folder, '').replace(/\/$/, '')
        if (n.filePath.startsWith(oldDir + '/')) {
          const previousPath = n.filePath
          n.filePath = newDir + n.filePath.slice(oldDir.length)
          // 文件夹改名 / 移动会改写整棵子树的路径，映射到 id 的关系必须一起搬
          // —— 否则「移动文件夹」等于给几十篇笔记集体换 id
          movePathBinding(previousPath, n.filePath)
        }
      }
      // folder / filePath 都参与链接图的 pathIndex 与候选标题
      reindexNote(n)
    })
  }

  /**
   * 磁盘目录搬移：renameFolder 与 moveFolder 的公共落盘动作。
   * @param {string} oldPath 原相对路径
   * @param {string} newPath 新相对路径
   * @returns {Promise<boolean>} 是否成功；无 notesPath / 无 IPC 时按成功处理
   */
  async function moveFolderOnDisk (oldPath, newPath) {
    if (!notesPath.value || !window.electronAPI) return true
    const oldDir = buildFilePath(oldPath, '').replace(/\/$/, '')
    const newDir = buildFilePath(newPath, '').replace(/\/$/, '')
    if (!window.electronAPI.moveFile) return false
    try {
      const result = await window.electronAPI.moveFile(oldDir, newDir)
      return result === true
    } catch (error) {
      return false
    }
  }

  /**
   * 把 oldPath 子树内的路径重映射到 newPath 子树。
   * @param {string} folderPath 待映射的路径
   * @param {string} oldPath 原父路径
   * @param {string} newPath 新父路径
   * @returns {string} 映射后的路径
   */
  function remapFolderPath (folderPath, oldPath, newPath) {
    if (!folderPath) return folderPath
    if (folderPath === oldPath) return newPath
    if (folderPath.startsWith(oldPath + '/')) return newPath + folderPath.slice(oldPath.length)
    return folderPath
  }

  /**
   * 重命名文件夹：同时移动磁盘目录并更新所有子笔记的 filePath。
   * 之前只改内存里的 folder 字符串，重启后名字回退、filePath 与实际路径脱节。
   * @param {string} oldPath 原文件夹路径
   * @param {string} newName 新的文件夹名（不含分隔符）
   * @returns {Promise<boolean>} 是否成功
   */
  async function renameFolder (oldPath, newName) {
    if (!oldPath || !newName) return false
    const cleanName = String(newName).trim().replace(/[\\/:*?"<>|]/g, '_')
    if (!cleanName) return false
    const parts = oldPath.split('/')
    parts[parts.length - 1] = cleanName
    const newPath = parts.join('/')
    if (newPath === oldPath) return true

    const affected = collectFolderNotes(oldPath)

    // 目录要移动，先取消挂起写入
    clearPendingSaves()

    const diskOk = await moveFolderOnDisk(oldPath, newPath)
    if (!diskOk && notesPath.value && window.electronAPI) {
      reportSaveError(newPath, new Error('文件夹重命名失败：目标已存在或目录不可移动'))
      return false
    }

    rewriteFolderPaths(affected, oldPath, newPath)

    const idx = expandedFolders.value.indexOf(oldPath)
    if (idx > -1) expandedFolders.value[idx] = newPath
    if (selectedFolder.value === oldPath) selectedFolder.value = newPath
    return true
  }

  /**
   * 把文件夹（含整棵子树）真正移动到目标父文件夹下 —— 侧边栏拖放用。
   * 与 renameFolder 只改路径最后一段不同：moveFolder 允许跨层跨父，
   * 而且是真的把磁盘上的目录搬走（不是只改内存里的 folder 字符串）。
   * @param {string} oldPath 原文件夹路径，例如 'a/b'
   * @param {string} newParentPath 目标父文件夹路径；'' / '/' 表示移到根目录
   * @returns {Promise<boolean>} 是否成功
   */
  async function moveFolder (oldPath, newParentPath) {
    if (!oldPath) return false
    const sanitized = String(oldPath).replace(/^\/+|\/+$/g, '')
    if (!sanitized) return false
    const parts = sanitized.split('/')
    const baseName = parts[parts.length - 1]
    const parent = String(newParentPath || '').replace(/^\/+|\/+$/g, '')
    const newPath = parent ? `${parent}/${baseName}` : baseName
    if (newPath === sanitized) return true

    // 不能搬进自己或自己的子树：fs.rename 会把整棵树嵌套到自己里面
    if (newPath.startsWith(sanitized + '/')) {
      reportSaveError(newPath, new Error('不能把文件夹移动到它自己的子目录里'))
      return false
    }

    const affected = collectFolderNotes(sanitized)

    // 目录即将整体搬走，先取消挂起写入
    clearPendingSaves()

    const diskOk = await moveFolderOnDisk(sanitized, newPath)
    if (!diskOk && notesPath.value && window.electronAPI) {
      reportSaveError(newPath, new Error('文件夹移动失败：目标已存在或目录不可移动'))
      return false
    }

    rewriteFolderPaths(affected, sanitized, newPath)

    // 展开态 / 选中态跟着路径一起迁移，并保证目标父目录是展开的
    const remapped = expandedFolders.value.map(p => remapFolderPath(p, sanitized, newPath))
    if (parent && !remapped.includes(parent)) remapped.push(parent)
    expandedFolders.value = remapped
    if (selectedFolder.value) {
      selectedFolder.value = remapFolderPath(selectedFolder.value, sanitized, newPath)
    }
    return true
  }

  /**
   * 切换笔记：先把上一篇落盘。否则自动保存关闭时（或防抖窗口内切走）
   * 上一篇的最后一段编辑会直接消失。
   */
  function selectNote(id) {
    const previousId = currentNoteId.value
    if (previousId && previousId !== id) flushSave(previousId)
    currentNoteId.value = id
    localStorage.setItem('choyeon-current-note-id', id)
    // 记录访问顺序，供快速切换器的 MRU 排序使用
    try { markNoteVisited(id) } catch (e) { /* ignore */ }
  }

  function createNote(folder = '', title = '无标题笔记') {
    const newNote = {
      id: generateId(),
      title,
      content: `# ${title}\n\n`,
      folder,
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      wordCount: 0,
      charCount: title.length,
      lineCount: 1,
      filePath: null
    }
    notes.value.unshift(newNote)
    currentNoteId.value = newNote.id
    localStorage.setItem('choyeon-current-note-id', newNote.id)

    // 索引与数组同序：unshift 到头部，索引也必须排在最前，否则 snapshot() 的
    // 遍历顺序与 buildLinkGraph 不一致，重名链接的解析结果会漂。
    // position=0 这一次是 O(n)，只在新建笔记时发生。
    reindexNote(newNote, 0)

    // 这里不再 fire-and-forget 落盘：createNewNoteFile 是 createNote + await
    // saveNoteToFile，其余调用点（侧边栏、右键菜单、命令面板）只吃同步返回值。
    // 同一篇笔记并发/重复写两次，第二次很可能覆盖用户刚输入的内容。
    // 标记为 dirty：Ctrl+S / 切换笔记 / 退出前的 flushAll 仍然会真正落到磁盘。
    if (notesPath.value && window.electronAPI) {
      dirtyNotes.add(newNote.id)
    }

    return newNote
  }

  function updateNoteContent(id, content) {
    const note = notes.value.find(n => n.id === id)
    if (note) {
      note.content = content
      note.updatedAt = new Date()
      const stats = computeTextStats(content)
      note.wordCount = stats.words
      note.charCount = stats.chars
      note.lineCount = stats.lines

      // 标题只认正文里的首个 H1：带 m 标志的正则会把 frontmatter 里的
      // YAML 注释（`# xxx`）也当成标题，导致笔记名被改成注释内容
      const body = parseFrontmatter(content).body
      const titleMatch = body.match(/^#\s+(.+)$/m)
      if (titleMatch && titleMatch[1].trim()) {
        const nextTitle = titleMatch[1].trim()
        if (nextTitle !== note.title) note.title = nextTitle
      }

      // 正文标签同步到 note.tags：否则依赖 note.tags 的标签视图 / 徽章 /
      // 快速切换器全部拿不到数据
      try {
        note.tags = extractTags(content)
      } catch (e) { /* extractTags 失败不影响保存 */ }

      // 内容变了 → 索引里这一条必须跟着重算（全库剩下的笔记保持缓存不动）
      reindexNote(note)

      // 自动保存关闭时只在显式保存（Ctrl+S / 切换笔记）时落盘。
      // 统一走 flushSave：它会按「有没有 filePath」分流 —— 没有的新笔记先建文件，
      // 有的写回当前路径。createNote 不再自己 fire-and-forget 写盘（否则与
      // createNewNoteFile 在同一路径上并发两个 writeFile），新建笔记的首次
      // 持久化就落在这条防抖链上，行为与旧版一致：建完笔记敲第一个字就落盘。
      if (isAutoSaveOn() && window.electronAPI && (note.filePath || notesPath.value)) {
        dirtyNotes.add(id)
        if (saveTimers.has(id)) {
          clearTimeout(saveTimers.get(id))
        }
        saveTimers.set(id, setTimeout(() => {
          saveTimers.delete(id)
          // 回调里重新取笔记：定时器排队期间可能发生重命名/移动/删除，
          // 闭包里捕获的旧 filePath 会把内容写到错误位置并留下孤儿文件
          const current = notes.value.find(n => n.id === id)
          if (!current) {
            dirtyNotes.delete(id)
            return
          }
          flushSave(id).then(ok => {
            if (ok) dirtyNotes.delete(id)
          })
        }, SAVE_DEBOUNCE_MS))
      }
    }
  }

  /**
   * 立即把笔记写回磁盘。与自动保存开关无关 —— 显式保存必须总是生效，
   * 所以这里不检查 isAutoSaveOn()，且没有排队定时器时也要写。
   * 返回 Promise<boolean>，调用方需要能 await（退出前刷盘依赖这一点）。
   */
  async function flushSave(id) {
    if (saveTimers.has(id)) {
      clearTimeout(saveTimers.get(id))
      saveTimers.delete(id)
    }
    const note = notes.value.find(n => n.id === id)
    if (!note) return false

    // 还没落过盘的新笔记：走完整建文件流程
    if (!note.filePath) {
      const ok = await saveNoteToFile(note, note.folder || '')
      if (ok) dirtyNotes.delete(id)
      return ok
    }
    if (!window.electronAPI) return false
    const ok = await safeWriteFile(note.filePath, note.content)
    if (ok) dirtyNotes.delete(id)
    return ok
  }

  /**
   * 把所有待写盘的笔记一次性落盘。退出应用、切换工作空间前必须调用，
   * 否则防抖窗口内的最后一次编辑会丢。
   */
  async function flushAll() {
    const ids = new Set([...dirtyNotes, ...saveTimers.keys()])
    for (const id of ids) {
      try {
        await flushSave(id)
      } catch (error) {
        // flushAll 是「退出前最后一道」，单篇失败不能中断其余笔记的落盘，
        // 但也不能悄悄丢：记进日志，用户还能靠「未保存」指示发现问题。
        noteLog.error('flushAll 单篇落盘失败', { id, err: error })
      }
    }
    dirtyNotes.clear()
    return true
  }

  /** 是否有未落盘的改动——供 UI 显示"未保存"指示 */
  function hasPendingSaves() {
    return dirtyNotes.size > 0 || saveTimers.size > 0
  }

  /** 取消所有挂起的写入（切换库 / 重置配置时用，防止旧内容写进新目录） */
  function clearPendingSaves() {
    for (const timer of saveTimers.values()) clearTimeout(timer)
    saveTimers.clear()
    dirtyNotes.clear()
  }

  async function deleteNote(id) {
    const pos = notes.value.findIndex(n => n.id === id)
    if (pos > -1) {
      const note = notes.value[pos]
      const removedPath = typeof note.filePath === 'string' ? note.filePath : ''
      // 先取消该笔记待执行的 debounce 写入，避免删除后定时器把文件写回
      if (saveTimers.has(id)) {
        clearTimeout(saveTimers.get(id))
        saveTimers.delete(id)
      }
      dirtyNotes.delete(id)
      if (window.electronAPI) {
        // 收集所有可能的磁盘路径，避免 filePath 滞后时删错文件留下孤儿
        const candidates = new Set()
        if (note.filePath) candidates.add(note.filePath)
        if (notesPath.value && note.title) {
          candidates.add(buildFilePath(note.folder, safeFileName(note.title, extensionOf(note))))
        }
        for (const p of candidates) {
          try {
            await window.electronAPI.deleteFile(p)
          } catch (error) {
            // 删除失败要留下痕迹：文件还在磁盘上、库里却已经没有它了，
            // 用户下次看到的是「同名笔记冲突」，而根因在这里。
            noteLog.error('删除文件失败', { path: p, err: error })
          }
        }
      }
      notes.value.splice(pos, 1)
      unindexNote(id)
      // 解绑这条路径：映射表里若还留着它，将来「同名文件被重新建出来」会接回
      // 已删笔记的 id（那条绑定指向的是一个已经不存在的笔记）。
      // 解绑之后该路径再出现时按兜底哈希解析 —— 与「已删的那篇」不再有任何关系。
      if (removedPath) forgetPath(removedPath)
      if (currentNoteId.value === id) {
        currentNoteId.value = notes.value[0]?.id || null
      }
    }
  }

  function toggleFolder(folderName) {
    const idx = expandedFolders.value.indexOf(folderName)
    if (idx > -1) {
      expandedFolders.value.splice(idx, 1)
    } else {
      expandedFolders.value.push(folderName)
    }
  }

  function toggleAllFolders(allFolderPaths) {
    const allExpanded = allFolderPaths.every(p => expandedFolders.value.includes(p))
    if (allExpanded) {
      expandedFolders.value = []
    } else {
      expandedFolders.value = [...allFolderPaths]
    }
  }

  function setExpandedFolders(folders) {
    expandedFolders.value = folders
  }

  function setSelectedFolder(folder) {
    selectedFolder.value = folder
  }

  function setSearchQuery(query) {
    searchQuery.value = query
  }

  function setSortBy(sort) {
    sortBy.value = sort
  }

  function setViewMode(mode) {
    viewMode.value = mode
  }

  // 日期分组由索引增量维护（insert/update/delete 都是 O(1)），这里取用即可
  const notesByDate = computed(() => {
    readIndexVersion()
    return index.dateIndex
  })

  function getNotesByDate(date) {
    const dateKey = new Date(date).toDateString()
    // index.dateIndex 不是响应式数据，必须显式读版本号才能在视图里触发重算
    readIndexVersion()
    return index.byDate(dateKey)
  }

  /**
   * 取批量读取结果里某个文件的内容：先精确匹配，再退化为「分隔符归一化 +
   * 大小写不敏感」匹配。主进程返回的是 validatePathAsync 归一化之后的路径，
   * Windows 下可能与请求串不是字面相同。
   * @param {Map<string, string>} contents path → content
   * @param {string} filePath 请求时的路径
   * @returns {string|null} 内容；读取失败则返回 null
   */
  function lookupContent (contents, filePath) {
    if (contents.has(filePath)) return contents.get(filePath)
    const relaxed = String(filePath).replace(/\\/g, '/').toLowerCase()
    return contents.has(relaxed) ? contents.get(relaxed) : null
  }

  /**
   * 批量读文件内容：优先走一次 IPC 'fs:read-files'，读不到的文件不进 Map。
   * @param {Array<string>} paths 绝对路径列表
   * @returns {Promise<Map<string, string>>} path → content
   */
  async function readFilesInBatch (paths) {
    const contents = new Map()
    const list = Array.isArray(paths) ? paths.filter(Boolean) : []
    if (list.length === 0) return contents

    if (typeof window.electronAPI?.readFiles === 'function') {
      try {
        const result = await window.electronAPI.readFiles({ paths: list })
        if (Array.isArray(result?.files)) {
          for (const item of result.files) {
            if (!item || typeof item.content !== 'string' || !item.path) continue
            contents.set(item.path, item.content)
            contents.set(String(item.path).replace(/\\/g, '/').toLowerCase(), item.content)
          }
          // 单个文件失败不影响其余：记 warn，与旧的逐个读取行为保持一致
          if (Array.isArray(result.errors)) {
            for (const err of result.errors) {
              noteLog.warn('批量读取：单个文件失败', { path: err?.path, reason: err?.error })
            }
          }
          return contents
        }
        noteLog.warn('fs:read-files 返回结构异常，退化为逐个读取')
      } catch (error) {
        noteLog.warn('批量读取失败，退化为逐个读取', { err: error })
      }
    }

      // 降级路径：没有批量通道时的旧行为
      for (const filePath of list) {
        try {
          const content = await window.electronAPI.readFile(filePath)
          if (content !== null && content !== undefined) contents.set(filePath, content)
        } catch (fileError) {
          noteLog.warn('逐个读取：单个文件失败', { path: filePath, reason: fileError?.message || fileError })
        }
      }
    return contents
  }

  /**
   * 载入序号：连续切目录（或外部同步回调与手动切换并发）时，先发的旧响应
   * 会覆盖新目录的结果。这里用单调递增的 token 丢弃过期响应。
   */
  let loadToken = 0
  const loadError = ref(null)

  /**
   * 一次性日期固化迁移（T18 内核，本任务是它的唯一接线点）。
   *
   * 时机：笔记载完 + 索引建好之后。写成功会同步 `note.content`（内核做的），
   * 但 `dateKey` 是在**索引里**算的，所以必须再重建一次索引，否则日历还停在
   * 迁移前的格子上（用户得重启才能看到变化）。
   *
   * `trustworthyOnly: true` 是主理人裁决 2：④ 级（updatedAt）不固化 —— 它本质是
   * 「最后一次修改时间」，写进 frontmatter 等于把「用户碰巧在哪天跑迁移」写成
   * 笔记的生日，而且一旦写死成 ① 级，后续批次接进 birthtime 之后 ② 级就再也
   * 没机会上位了。②③ 级（birthtime / 标题日期串）照常固化。
   *
   * 失败不阻塞启动：日期是增强信息，笔记库本身已经载好了。内核在单篇写失败时
   * 不落标记，下次启动自动重试。
   *
   * @returns {Promise<object|null>} 迁移结果；迁移被跳过 / 失败时为 null
   */
  async function migrateNoteDates () {
    try {
      const migration = await runDateMigration({
        notes: notes.value,
        // safeWriteFile 恒返回 boolean（已消化掉主进程的 errno 与两种返回形态），
        // 正好是内核期望的 Promise<boolean>
        writeFile: safeWriteFile
        // 裁决 2：只固化可信来源（frontmatter 已有的会被内核 skipped，
        // 真正被这条选项拦下的是 ④ 级 updatedAt）
        , trustworthyOnly: true
      })
      if (migration.failed > 0) {
        // 不落标记是内核的行为，这里只留一条「下次还会重试」的记录，
        // 免得用户看到「日历没变」时无从判断是没跑还是没成功
        noteLog.warn('日期迁移有笔记没写进去，下次启动会重试', {
          total: migration.total,
          migrated: migration.migrated,
          failed: migration.failed
        })
      }
      // dateKey 在索引里算 —— frontmatter 变了必须重建，否则日历还是旧格子
      if (migration.ran && migration.migrated > 0) reindexAll()
      return migration
    } catch (error) {
      // 迁移失败绝不能卡住启动流程（用户要的是先看到笔记）
      noteLog.warn('日期迁移失败，已跳过（不影响笔记载入）', { err: error })
      return null
    }
  }

  /**
   * id 映射表的体检数据（T20 验证脚本用）。
   *
   * `coverage` 就是「id 解析成功率」：库里有多少比例的路径已经在映射表里有
   * 显式绑定。剩下那些靠兜底哈希解析 —— 功能正常，但**移动一次就会变 id**，
   * 所以这个数字应该随使用逐步逼近 1。
   *
   * @returns {{ total: number, bound: number, unbound: Array<string>,
   *             coverage: number, entries: number, version: number }} 体检结果
   */
  function getIdMapStats () {
    const live = []
    for (const n of notes.value) {
      if (typeof n.filePath === 'string' && n.filePath) live.push(n.filePath)
    }
    const unbound = []
    let bound = 0
    for (const p of live) {
      if (isPathBound(p)) bound += 1
      else unbound.push(p)
    }
    return {
      total: live.length,
      bound,
      unbound,
      coverage: live.length === 0 ? 1 : bound / live.length,
      entries: idMap && idMap.byPath ? Object.keys(idMap.byPath).length : 0,
      version: idMap ? idMap.version : 0
    }
  }

  /**
   * 日期归属的分布数据（T20 验证脚本用）：四级来源直方图 + 日历格子数。
   *
   * 直方图直接读索引条目里的 `dateSource`（noteIndex 在 buildEntry 里算好并
   * 缓存的），不重新解析正文 —— 与日历真正使用的口径是同一份数据。
   *
   * @returns {{ total: number, bySource: Record<string, number>, days: number,
   *             frontmatterRate: number }} 分布结果
   */
  function getDateSourceStats () {
    const bySource = {}
    let total = 0
    for (const entry of index.byId.values()) {
      const source = entry.dateSource || 'unknown'
      bySource[source] = (bySource[source] || 0) + 1
      total += 1
    }
    const frontmatter = bySource.frontmatter || 0
    return {
      total,
      bySource,
      days: index.dateIndex.size,
      frontmatterRate: total === 0 ? 0 : frontmatter / total
    }
  }

  async function loadNotesFromPath(path) {
    const token = ++loadToken
    isLoading.value = true
    loadError.value = null
    // 切换库前必须取消旧笔记的挂起写入，否则 500ms 后会把已卸载笔记
    // 的内容写回磁盘，可能覆盖新库里的同名文件
    clearPendingSaves()
    notesPath.value = path

    // id 映射表必须在**算 id 之前**读出来：id 是「映射表优先 + 哈希兜底」。
    // 读不出来（首次运行 / 文件损坏 / 存储不可用）→ null，下面按磁盘路径重建。
    // loadIdMap 自己保证绝不抛，这里再包一层只是为了让「读表失败」单独留一条
    // 可查的记录 —— 否则它会被下面那个大 try/catch 误记成「载入笔记库失败」。
    let loadedIdMap = null
    try {
      loadedIdMap = await loadIdMap()
    } catch (error) {
      noteLog.warn('读取 id 映射表失败，按磁盘路径重建', { err: error })
    }

    if (window.electronAPI?.setNotesPath) {
      try {
        await window.electronAPI.setNotesPath(path)
      } catch (error) {
        // 主进程没记住库路径时后续所有读写都会失败，这条是唯一的线索
        noteLog.error('setNotesPath 失败', { path, err: error })
      }
    }

    try {
      const files = await window.electronAPI.readDirectoryRecursive(path)
      if (token !== loadToken) return { ok: false, stale: true }

      // 映射表读不出来 → 按磁盘路径全量重建。重建不是「重新发明 id」：每个路径
      // 的 id 就是它自己的 pathHashId，与「从未迁移过的老库」逐字相同，所以
      // 存量用户的书签 / 双链 / 图谱坐标一个都不会断。
      idMap = loadedIdMap || rebuildIdMap(files.map(f => f.path))

      const loadedNotes = []

      // 一次 IPC 读完整个目录，而不是 N 次串行 readFile：
      // 500 篇笔记原来是 500 次 invoke + await，冷启动慢一个数量级。
      // 读失败的文件主进程会放进 errors，这里跳过 + warn（与旧行为一致）。
      const contents = await readFilesInBatch(files.map(f => f.path))
      if (token !== loadToken) return { ok: false, stale: true }

      for (const file of files) {
        const content = lookupContent(contents, file.path)
        if (content === null || content === undefined) continue
        const body = parseFrontmatter(content).body
        const titleMatch = body.match(/^#\s+(.+)$/m)
        const title = titleMatch ? titleMatch[1].trim() : file.name.replace(EXT_PATTERN, '')

        const relativePathParts = file.relativePath.split('/')
        relativePathParts.pop()
        const folder = relativePathParts.join('/') || ''

        let tags = []
        try { tags = extractTags(content) } catch (e) { tags = [] }

        const stats = computeTextStats(content)
        loadedNotes.push({
          // 映射表优先 + 哈希兜底（未命中时顺手登记）。见 resolveNoteId 的注释
          id: resolveNoteId(file.path),
          title,
          content,
          folder,
          tags,
          createdAt: new Date(file.ctime),
          updatedAt: new Date(file.mtime),
          wordCount: stats.words,
          charCount: stats.chars,
          lineCount: stats.lines,
          filePath: file.path
        })
      }

      if (token !== loadToken) return { ok: false, stale: true }

      notes.value.length = 0
      // 空目录是正常状态，不再塞示例笔记：否则用户会以为自己的笔记丢了，
      // 更糟的是开启自动保存后这些示例数据会被真的写进用户目录
      notes.value.push(...loadedNotes)
      // 换库是一次整体替换 —— 索引必须全量重建，不能指望增量
      reindexAll()

      // 全量载入完成后裁剪失效路径：映射表只留磁盘上还活着的那批，否则
      // note-id-map.json 会随「建了又删」无限膨胀。（裁剪掉的语义不丢：
      // 那条路径复活时会按兜底哈希解析，见 noteIdentity.compactIdMap 的注释）
      idMap = compactIdMap(idMap, loadedNotes.map(n => n.filePath).filter(Boolean))
      persistIdMap()

      const savedCurrentId = localStorage.getItem('choyeon-current-note-id')
      if (savedCurrentId && notes.value.some(n => n.id === savedCurrentId)) {
        currentNoteId.value = savedCurrentId
      } else {
        currentNoteId.value = notes.value[0]?.id || null
      }

      // 一次性日期固化迁移：跑在「笔记载完 + 索引建好」之后，写成功会重建索引
      await migrateNoteDates()

      return { ok: true, count: loadedNotes.length }
    } catch (error) {
      // 载入失败时库会被清空（下面 notes.value.length = 0），没有这条记录
      // 用户根本说不清「笔记没了」是自己删的还是没读出来
      noteLog.error('载入笔记库失败', { path, err: error })
      if (token !== loadToken) return { ok: false, stale: true }
      loadError.value = (error && error.message) || String(error)
      notes.value.length = 0
      reindexAll()
      return { ok: false, error: loadError.value }
    } finally {
      if (token === loadToken) isLoading.value = false
    }
  }

  function resetConfig() {
    // 清掉当前笔记指针，否则重置回欢迎页后重新选目录时会恢复到一个已不存在的 id
    localStorage.removeItem('choyeon-current-note-id')
    clearPendingSaves()
    notes.value.length = 0
    notes.value.push(...createSampleNotes())
    currentNoteId.value = notes.value[0]?.id || null
    selectedFolder.value = '工作笔记'
    expandedFolders.value = ['工作笔记', '项目文档']
    searchQuery.value = ''
    sortBy.value = 'updated'
    viewMode.value = 'list'
    notesPath.value = null
    isLoading.value = false
    loadError.value = null
    // 回到示例库：索引同样整体重建（不准跨库残留）
    reindexAll()
  }

  async function saveNoteToFile(note, folder = '') {
    if (!notesPath.value || !window.electronAPI) return false

    let filePath = note.filePath
    if (!filePath) {
      const folderPath = folder ? `${notesPath.value}/${folder}` : notesPath.value
      try {
        await window.electronAPI.createDirectory(folderPath)
      } catch (error) {
        // 目录没建起来不中止：writeFile 自己会再报一次更明确的错，
        // 这里只留下「mkdir 就没成」这条线索，便于区分权限与路径问题
        noteLog.error('创建目录失败', { path: folderPath, err: error })
      }
      // 只有「新笔记首次落盘」才需要取名，因此也只有这条路要做冲突检测：
      // 已落盘笔记写回自己的 filePath，不存在撞别人的问题。
      //
      // writeFile 是**覆盖语义**，撞名就是丢稿，所以取名分三步：
      //   1) 收集同目录已占用的名字（内存已落盘 + 内存待落盘 + 磁盘真实目录）；
      //   2) 交给内核取名并在 taken 非空时自动 ` 1` / ` 2` 消解；
      //   3) 用 fs:file-exists 再复核一次，仍冲突就继续消解（见 pickAvailableName）。
      const taken = await collectTakenNames(folderPath, folder, note)
      const baseName = safeFileName(note.title, extensionOf(note), taken)
      const finalName = await pickAvailableName(folderPath, baseName, taken)
      filePath = buildFilePath(folder, finalName)
      if (finalName !== baseName) {
        notifyInfo(`已存在同名文件，保存为「${finalName}」`)
      }
    }

    const success = await safeWriteFile(filePath, note.content)
    // 写入期间若笔记已被删除，回滚刚写出的文件，避免磁盘孤儿
    if (success && !notes.value.some(n => n.id === note.id)) {
      try { await window.electronAPI.deleteFile(filePath) } catch (e) { /* ignore */ }
      return false
    }
    if (success) {
      note.filePath = filePath
      // 绑定 id ↔ path：新建笔记的 id 是随机串（generateId），一旦它落到某个
      // 路径上，这条绑定就是它今后「移动 / 重命名不换 id」的凭据
      rememberPath(note.id, filePath)
      // filePath 参与 candidateTitles（去掉 .md 的文件名也是一个可被链接的名字）
      reindexNote(note)
    }
    return success
  }

  async function createNewNoteFile(folder = '', title = '无标题笔记') {
    const newNote = createNote(folder, title)
    await saveNoteToFile(newNote, folder)
    return newNote
  }

  return {
    notes,
    currentNoteId,
    currentNote,
    selectedFolder,
    expandedFolders,
    folders,
    searchQuery,
    sortBy,
    viewMode,
    notesPath,
    isLoading,
    loadError,
    filteredNotes,
    notesByFolder,
    allTags,
    selectNote,
    createNote,
    updateNoteContent,
    flushSave,
    flushAll,
    hasPendingSaves,
    clearPendingSaves,
    deleteNote,
    toggleFolder,
    toggleAllFolders,
    setExpandedFolders,
    setSelectedFolder,
    setSearchQuery,
    setSortBy,
    setViewMode,
    getNotesByDate,
    loadNotesFromPath,
    saveNoteToFile,
    createNewNoteFile,
    resetConfig,
    // ===== Obsidian 功能方法（之前已实现但漏导出，导致调用方静默失败）=====
    getBacklinks,
    getOutgoing,
    getUnresolved,
    getNotesByTag,
    findByTitle,
    findNoteByWikiTarget,
    resolveWikiForRender,
    searchNotesFuzzy,
    getNoteOutline,
    getNoteFrontmatter,
    updateNoteFrontmatter,
    createNoteFromWikiTarget,
    moveNote,
    renameNote,
    rewriteBacklinks,
    createFolder,
    deleteFolder,
    renameFolder,
    moveFolder,
    // ===== T19 · 稳定 id / 日期迁移的对外接口 =====
    /**
     * 统一的安全写盘入口。导出是为了让日期迁移这类「外部内核」复用同一条落盘
     * 通道（含 errno 上报 + 用户可见 toast），不必再抄一份 IPC 容错。
     * 契约不变：恒返回 boolean，结构化 errno 在函数内部消化成报告。
     */
    safeWriteFile,
    /** id 映射表体检（含「id 解析成功率」coverage）—— T20 验证脚本读它 */
    getIdMapStats,
    /** 日期归属分布（四级来源直方图 + 日历格子数）—— T20 验证脚本读它 */
    getDateSourceStats
  }
})
