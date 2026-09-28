// ============================================================================
// useExternalSync.js —— 外部磁盘变更的「定向 reconcile」内核（批次 4 · R-F5 / R-F6）
//
// 这个文件只为一件事存在：**外部改了磁盘上的文件，不能把用户正在编辑的那一屏
// 冲掉**。
//
// 改造前的实现是 `App.vue` 里的一行：
//
//     window.electronAPI.onNotesExternalChange(() => noteStore.loadNotesFromPath(path))
//
// 也就是「只要监听到任何一个文件变了，就把整库重新读一遍」。它有三个致命后果：
//   ① 正在 A 里打字，别人改了 B → A 的 content 被整库重载覆盖，光标跳走（R-F5）；
//   ② A 在磁盘上被改了、在应用里也改了 → 直接覆盖，用户无从选择（R-F6）；
//   ③ 一个大库几百篇笔记，改一个字就全量 IPC 重读 + 重建索引（性能）。
//
// 本模块把这三件事分别解决：
//   · 定向：只处理 `changes` 里列出的那几个路径，一条都不多碰；
//   · 判定矩阵：`dirty` / `currentNote` 的笔记遇到外部 change 一律**入冲突队列**，
//     content **一个字节都不动**；
//   · 绝不做全量重载：本文件**不 import 任何 store**，`loadNotesFromPath` 连名字
//     都不会出现在调用链里（tests/reconcile.test.js 用一个会 throw 的替身钉死它）。
//
// 判定矩阵（设计文档 §4，逐个 case 由单测断言，不得偏离）：
//
//   变更类型 \ 内存状态        非 dirty                dirty 或 是 currentNote
//   add（新文件）              直接入库                直接入库
//   change（内容变化）         读盘 → 定向更新         入冲突队列，不改 content
//   unlink（删除）             从库移除                从库移除 + toast 告知
//
// 两处「规格没写死、由本模块裁决」的分支，理由写在各自的函数注释里：
//   · 库里没有的路径收到 change → 按 add 入库（不崩、不静默丢笔记）；
//   · 已存在的路径收到 add     → 走 change 的判定（尊重 dirty），不当成新文件覆盖。
//
// 纯内核约定（与上几批的 utils/noteIdentity.js 同口径）：
//   本文件只做「读 + 定向写」，不发明 id 语义（路径 → id 一律走 noteIdentity 的
//   resolveId 兜底，或调用方注入的 resolveNoteId），不持有模块级可变状态。
// ============================================================================

import { ref } from 'vue'
import { EXT_PATTERN } from '../constants/noteFile'
import { LOG_MODULES } from '../constants/logging'
import { createLogger } from '../utils/logger.js'
import { resolveId } from '../utils/noteIdentity'
import { computeTextStats } from '../utils/textStats'
import { parseFrontmatter, extractTags } from './useLinks'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 冲突预览的截断长度。
 *
 * 预览是给「二选一」用的，不是给阅读用的：两边各 400 字符足够判断哪边是自己的
 * 稿子，同时保证一次来十几条冲突时弹窗不会被一篇 50KB 的笔记撑爆。
 */
export const CONFLICT_PREVIEW_LIMIT = 400

/** 合法的变更类型（与主进程 preload 回调契约逐字一致） */
export const SYNC_KINDS = Object.freeze(['add', 'change', 'unlink'])

/**
 * 冲突原因（用户可见文案，直接进 ConflictDialog 的 reason）。
 *
 * 三种状态分开写而不是拼一句长句：用户在弹窗里要能一眼分清「我改过」和
 * 「我只是打开了它」—— 前者意味着选错会丢稿，后者选错只是少拿一份外部更新。
 */
export const CONFLICT_REASONS = Object.freeze({
  /** 应用里有未保存修改（dirty） */
  dirty: '这篇笔记有未保存的修改，同时磁盘上的文件被外部改写了',
  /** 是当前打开的笔记，但内容已落盘（非 dirty） */
  current: '这篇笔记正在编辑中，同时磁盘上的文件被外部改写了',
  /** 既正在编辑、又有未保存修改 */
  dirtyCurrent: '这篇笔记正在编辑且有未保存的修改，同时磁盘上的文件被外部改写了'
})

/** 空数组常量：没有 noteStore 时复用同一个，避免每次调用都新建 */
const NO_NOTES = []

// ---------------------------------------------------------------------------
// 纯工具（全部导出，供单测直接断言；无副作用、不读时钟、不碰磁盘）
// ---------------------------------------------------------------------------

/**
 * 路径归一：只把 Windows 的反斜杠换成正斜杠。
 *
 * 刻意不做其它归一（不解析 `..`、不改大小写）：note.js 里 `buildFilePath` 是正
 * 斜杠硬拼，而主进程 watcher 给回来的是真实磁盘分隔符（Windows 上是 `\`），
 * 两侧只有在分隔符这一件事上会不一致。多归一一点就会与库里已存的 filePath
 * 对不上，反而匹配失败。
 *
 * @param {unknown} path 路径
 * @returns {string} 归一后的路径；非字符串 → ''
 */
export function normalizePath (path) {
  return typeof path === 'string' ? path.replace(/\\/g, '/') : ''
}

/**
 * 取文件名（归一后的最后一段）。
 * @param {unknown} path 路径
 * @returns {string} 文件名；非字符串 → ''
 */
export function fileNameOf (path) {
  const p = normalizePath(path)
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

/**
 * 把正文压成预览：去掉控制字符 + 统一换行 + 超限截断。
 *
 * 去控制字符不是为了好看：笔记正文可能来自任何外部编辑器，带着 `\u0000` 之类的
 * 字节进到 Vue 模板里会在某些 Chromium 版本上渲染出空白或截断。截断时补一句
 * 「共 N 字符」，否则用户会以为「磁盘版的稿子就只有这么点」。
 *
 * @param {unknown} text 正文
 * @param {number} [limit=CONFLICT_PREVIEW_LIMIT] 截断长度
 * @returns {string} 预览文本
 */
export function buildPreview (text, limit = CONFLICT_PREVIEW_LIMIT) {
  const raw = typeof text === 'string' ? text : ''
  // \r\n → \n；控制字符（不含 \n \t）→ 空格。全部用转义写法，源码里不出现裸控制字节
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
  const size = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : CONFLICT_PREVIEW_LIMIT
  if (cleaned.length <= size) return cleaned
  return `${cleaned.slice(0, size)}\n…（已截断，共 ${cleaned.length} 字符）`
}

/**
 * 从正文推导标题 —— 与 `note.js:1893-1895`（全量载入）和 `updateNoteContent`
 * **逐字同口径**：先取 frontmatter 之后的正文里首个 H1，没有就用文件名去扩展名。
 *
 * 同口径很重要：如果这里多认了一种标题来源，外部同步一次就会把用户手动改过的
 * 标题悄悄改回去，而全量载入时又不变 —— 同一篇笔记两种行为，没法向用户解释。
 *
 * @param {string} content 笔记正文（含 frontmatter 的原始内容）
 * @param {string} path 文件路径
 * @returns {string} 标题
 */
export function deriveTitle (content, path) {
  const body = parseFrontmatter(content).body
  const match = /^#\s+(.+)$/m.exec(String(body || ''))
  if (match && match[1].trim()) return match[1].trim()
  return fileNameOf(path).replace(EXT_PATTERN, '')
}

/**
 * 从「库根 + 绝对路径」推导 folder 字段 —— 同样对齐 `note.js:1897-1899`。
 *
 * 拿不到库根（notesPath 未设置）时返回 ''：宁可归到根目录，也不要凭路径猜一个
 * 不存在的层级出来。
 *
 * @param {string} path 笔记绝对路径
 * @param {string} root 库根目录绝对路径
 * @returns {string} 相对目录，根目录本身返回 ''
 */
export function deriveFolder (path, root) {
  const p = normalizePath(path)
  const r = normalizePath(root).replace(/\/+$/, '')
  if (!p || !r) return ''
  if (!p.startsWith(r + '/')) return ''
  const rel = p.slice(r.length + 1)
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/**
 * 把 SyncResult 渲染成一句给用户看的话（toast 用）。
 *
 * @param {object} result apply() 的返回值
 * @returns {string} 形如「更新 2 篇 / 1 篇冲突待处理」；无事发生时返回 ''
 */
export function describeSyncResult (result) {
  const r = result || {}
  const parts = []
  if (r.added > 0) parts.push(`新增 ${r.added} 篇`)
  if (r.updated > 0) parts.push(`更新 ${r.updated} 篇`)
  if (r.removed > 0) parts.push(`移除 ${r.removed} 篇`)
  if (r.conflicted > 0) parts.push(`${r.conflicted} 篇冲突待处理`)
  return parts.join(' / ')
}

/**
 * 被删笔记的 toast 文案 —— 「你的修改没写进磁盘」这句必须说出口。
 *
 * @param {{ title?: string, path?: string }} entry removedDirty 里的一项
 * @returns {string} toast 文案
 */
export function describeRemovedDirty (entry) {
  const title = (entry && entry.title) || fileNameOf(entry && entry.path) || '未命名笔记'
  return `「${title}」已在磁盘上被删除，应用内的未保存修改未写入`
}

// ---------------------------------------------------------------------------
// 内核
// ---------------------------------------------------------------------------

/**
 * 默认「是不是笔记文件」判定：读 `constants/noteFile.js` 的白名单。
 *
 * 渲染侧唯一来源就在那儿；`.canvas` 这类 Obsidian 附件在这里被挡掉，计入 ignored，
 * 一次库变更都不会触发。
 *
 * @param {unknown} path 路径
 * @returns {boolean} 是笔记文件返回 true
 */
function defaultIsNoteExtension (path) {
  return EXT_PATTERN.test(typeof path === 'string' ? path : '')
}

/**
 * 从 noteStore 上取「笔记数组」。
 *
 * 兼容两种形态：Pinia setup store 解包后的真数组，以及原始 ref。用 `??` 而不是
 * `||` 是为了让「空数组」保持空数组而不是被换成常量。
 *
 * @param {object} noteStore 调用方注入的 store 门面
 * @returns {Array<object>} 笔记数组（可能是共享的空数组，只读场景用）
 */
function liveNotes (noteStore) {
  const raw = noteStore && noteStore.notes
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.value)) return raw.value
  return NO_NOTES
}

/**
 * 取当前笔记 id（兼容 ref 与裸值）。
 * @param {object} noteStore store 门面
 * @returns {string|null} 当前笔记 id；没有返回 null
 */
function currentIdOf (noteStore) {
  const raw = noteStore && noteStore.currentNoteId
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object' && 'value' in raw) {
    const v = raw.value
    return typeof v === 'string' && v ? v : null
  }
  return typeof raw === 'string' && raw ? raw : null
}

/**
 * 取库根路径（兼容 ref 与裸值）。
 * @param {object} noteStore store 门面
 * @returns {string} 库根；没有返回 ''
 */
function rootPathOf (noteStore) {
  const raw = noteStore && noteStore.notesPath
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'object' && 'value' in raw) return typeof raw.value === 'string' ? raw.value : ''
  return typeof raw === 'string' ? raw : ''
}

/**
 * 这条笔记是不是「受保护」的（= 不允许被外部内容覆盖）。
 *
 * 两个来源：① 注入的 dirtyNotes（Set）里有它；② 它就是当前笔记。当前笔记即便
 * 内容已落盘也受保护 —— 光标在里面，直接换掉正文等于把用户从椅子上一脚踹开，
 * 这正是 R-F5 要杜绝的。
 *
 * @param {object} noteStore store 门面
 * @param {string} id 笔记 id
 * @returns {boolean} 受保护返回 true
 */
function isProtected (noteStore, id) {
  if (!id) return false
  const set = noteStore && noteStore.dirtyNotes
  if (set && typeof set.has === 'function' && set.has(id)) return true
  if (typeof noteStore.isDirty === 'function' && noteStore.isDirty(id)) return true
  return currentIdOf(noteStore) === id
}

/**
 * 建一个 reconcile 器。
 *
 * 契约（批次 4 已钉死，T22 / T24 两侧必须逐字一致）：
 *
 *   createReconciler({ noteStore, readFile, log, isNoteExtension })
 *     → { apply(changes), pendingConflicts(), resolveConflict(id, choice) }
 *
 *   changes: Array<{ path: string, kind: 'add' | 'change' | 'unlink' }>
 *   SyncResult: { added, updated, removed, conflicted, ignored }
 *   Conflict:   { id, title, path, diskPreview, memoryPreview, reason }
 *   choice:     'disk' | 'memory'
 *
 * @param {object} options 选项
 * @param {object} options.noteStore 笔记库门面（notes / dirtyNotes / currentNoteId /
 *   upsert / remove / readFile / persist / reindex / clearDirty / resolveNoteId）
 * @param {Function} [options.readFile] (path) => Promise<string|null>；noteStore.readFile 优先
 * @param {object} [options.log] logger 实例；缺省用 sync 模块 logger
 * @param {Function} [options.isNoteExtension] (path) => boolean；缺省走 noteFile 白名单
 * @returns {{ apply: Function, pendingConflicts: Function, resolveConflict: Function }} Reconciler
 */
export function createReconciler (options = {}) {
  const noteStore = options.noteStore || {}
  const log = options.log || createLogger(LOG_MODULES.sync)
  const isNoteExtension = typeof options.isNoteExtension === 'function'
    ? options.isNoteExtension
    : defaultIsNoteExtension
  const readFile = typeof noteStore.readFile === 'function'
    ? noteStore.readFile
    : (typeof options.readFile === 'function' ? options.readFile : null)

  /** id → { conflict, diskContent, memoryContent, path }。只认 string 键 */
  const pending = new Map()

  // -- 库读写的小工具（全部走 noteStore 的门面，缺一个就降级，绝不抛） ----------

  /**
   * 读一个文件；读不到 / 抛异常都返回 null。
   * @param {string} path 路径
   * @returns {Promise<string|null>} 内容
   */
  async function safeRead (path) {
    if (typeof readFile !== 'function') return null
    try {
      const content = await readFile(path)
      return typeof content === 'string' ? content : null
    } catch (error) {
      // 单个文件读不出来不该让整批变更失败：记一条，其余照常处理
      log.warn('外部变更：读取文件失败', { path, err: error })
      return null
    }
  }

  /**
   * 按路径找笔记：先精确，再「反斜杠归一」，最后大小写不敏感。
   *
   * 三级匹配是因为两侧路径来源不同（库里的是我们拼的，watcher 给的是磁盘真实
   * 分隔符）。Windows 上大小写不敏感，macOS 上精确匹配就能命中，第三级只是兜底。
   *
   * @param {string} path 路径
   * @returns {object|null} 笔记对象
   */
  function findNoteByPath (path) {
    const list = liveNotes(noteStore)
    const p = normalizePath(path)
    if (!p) return null
    for (const note of list) {
      if (typeof note.filePath === 'string' && note.filePath === path) return note
    }
    for (const note of list) {
      if (typeof note.filePath === 'string' && normalizePath(note.filePath) === p) return note
    }
    const lower = p.toLowerCase()
    for (const note of list) {
      if (typeof note.filePath === 'string' && normalizePath(note.filePath).toLowerCase() === lower) return note
    }
    return null
  }

  /**
   * 按 id 找笔记。
   * @param {string} id 笔记 id
   * @returns {object|null} 笔记对象
   */
  function findNoteById (id) {
    if (!id) return null
    for (const note of liveNotes(noteStore)) {
      if (note.id === id) return note
    }
    return null
  }

  /**
   * 路径 → id。
   *
   * 优先用 store 自己的 `resolveNoteId`（T19 之后它是全库唯一入口，映射表命中时
   * id 与老库一致）；没有就退化成 `noteIdentity.resolveId(null, path)`，也就是
   * 路径哈希 —— 对「还没进映射表的新路径」来说，两者算出来的值本来就相同。
   *
   * @param {string} path 路径
   * @returns {string} id
   */
  function resolveIdForPath (path) {
    if (typeof noteStore.resolveNoteId === 'function') {
      const id = noteStore.resolveNoteId(path)
      if (typeof id === 'string' && id) return id
    }
    return resolveId(null, path)
  }

  /**
   * 把磁盘内容**定向**写进一篇已存在的笔记（原地改字段，不换对象）。
   *
   * 原地改而不是替换对象：Vue 的响应式与 CodeMirror 的外部文档同步都挂在原来
   * 那个对象上，换对象等于让编辑器重新挂载一次，光标必跳。
   *
   * 字段口径与 `updateNoteContent` 一致（content / updatedAt / 三统计 / 标题 /
   * 标签），但**两个动作刻意不做**：不加 dirty、不排自动保存 —— 内容本来就来自
   * 磁盘，再写回去只是制造一次无意义的写盘和一次 watcher 回声。
   *
   * @param {object} note 笔记对象
   * @param {string} content 磁盘读回来的正文
   * @returns {void}
   */
  function applyDiskContent (note, content) {
    note.content = content
    note.updatedAt = new Date()
    const stats = computeTextStats(content)
    note.wordCount = stats.words
    note.charCount = stats.chars
    note.lineCount = stats.lines
    const nextTitle = deriveTitle(content, note.filePath || '')
    if (nextTitle) note.title = nextTitle
    try {
      note.tags = extractTags(content)
    } catch (error) {
      // 标签解析失败只影响标签视图，不该连内容一起回滚
      log.warn('外部变更：标签解析失败', { path: note.filePath, err: error })
    }
    if (typeof noteStore.reindex === 'function') {
      try {
        noteStore.reindex(note)
      } catch (error) {
        log.warn('外部变更：索引重建失败', { path: note.filePath, err: error })
      }
    }
  }

  /**
   * 造一篇新笔记对象（字段与 `loadNotesFromPath` 的 loadedNotes 对齐）。
   * @param {string} id 笔记 id
   * @param {string} path 路径
   * @param {string} content 正文
   * @returns {object} 笔记对象
   */
  function buildNote (id, path, content) {
    const stats = computeTextStats(content)
    let tags = []
    try {
      tags = extractTags(content)
    } catch (error) {
      log.warn('外部变更：新笔记标签解析失败', { path, err: error })
    }
    return {
      id,
      title: deriveTitle(content, path),
      content,
      folder: deriveFolder(path, rootPathOf(noteStore)),
      tags,
      createdAt: new Date(),
      updatedAt: new Date(),
      wordCount: stats.words,
      charCount: stats.chars,
      lineCount: stats.lines,
      filePath: path
    }
  }

  /**
   * 入库一篇新笔记（定向：只 push 这一个对象）。
   * @param {object} note 笔记对象
   * @returns {boolean} 成功返回 true
   */
  function insertNote (note) {
    if (typeof noteStore.upsert === 'function') {
      const ok = noteStore.upsert(note)
      return ok !== false
    }
    liveNotes(noteStore).unshift(note)
    if (typeof noteStore.reindex === 'function') {
      try {
        noteStore.reindex(note)
      } catch (error) {
        log.warn('外部变更：新笔记索引登记失败', { path: note.filePath, err: error })
      }
    }
    return true
  }

  /**
   * 出库一篇笔记（定向：只 splice 这一个元素）。
   * @param {object} note 笔记对象
   * @returns {boolean} 成功返回 true
   */
  function dropNote (note) {
    if (typeof noteStore.remove === 'function') {
      const ok = noteStore.remove(note)
      return ok !== false
    }
    const list = liveNotes(noteStore)
    const idx = list.indexOf(note)
    if (idx < 0) return false
    list.splice(idx, 1)
    return true
  }

  /**
   * 清掉一条笔记的 dirty 标记（选了磁盘版之后，内存与磁盘已经一致）。
   * @param {string} id 笔记 id
   * @returns {void}
   */
  function clearDirty (id) {
    const set = noteStore && noteStore.dirtyNotes
    if (set && typeof set.delete === 'function') set.delete(id)
    if (typeof noteStore.clearDirty === 'function') {
      try {
        noteStore.clearDirty(id)
      } catch (error) {
        log.warn('外部变更：清除未保存标记失败', { id, err: error })
      }
    }
  }

  /**
   * 把内存版写回磁盘（用户选了「保留我的修改」）。
   * @param {object} note 笔记对象
   * @returns {Promise<boolean>} 写成功返回 true
   */
  async function persistNote (note) {
    try {
      if (typeof noteStore.persist === 'function') return await noteStore.persist(note)
      if (typeof noteStore.writeFile === 'function') {
        return await noteStore.writeFile(note.filePath, note.content)
      }
    } catch (error) {
      log.error('冲突解决：写回磁盘失败', { path: note.filePath, err: error })
      return false
    }
    log.warn('冲突解决：门面未提供写盘能力，内存版只留在内存里', { path: note.filePath })
    return false
  }

  // -- 三条分支 --------------------------------------------------------------

  /**
   * add / 未知路径的 change：读盘 → 造对象 → 入库。
   *
   * 两条防御：
   *   · 读不出内容（文件已被删 / 权限）→ 计 ignored，绝不拿空串造一篇空笔记把
   *     用户真正在编辑的东西覆盖掉；
   *   · id 撞上另一条路径（noteIdentity §7.2 B-3 的 djb2 碰撞）→ 不入库，记
   *     error。碰撞时强行入库会把**另一篇**笔记顶掉，那比丢一篇新笔记严重得多。
   *
   * @param {string} path 路径
   * @param {object} result 结果累加器
   * @returns {Promise<void>}
   */
  async function handleAdd (path, result) {
    const content = await safeRead(path)
    if (content === null) {
      result.ignored += 1
      return
    }
    const id = resolveIdForPath(path)
    const clash = findNoteById(id)
    if (clash && normalizePath(clash.filePath) !== normalizePath(path)) {
      result.ignored += 1
      log.error('外部新增：id 与另一条路径相撞，已跳过（避免顶掉现存笔记）', {
        path,
        id,
        clashPath: clash.filePath
      })
      return
    }
    const note = buildNote(id, path, content)
    if (insertNote(note)) result.added += 1
    else result.ignored += 1
  }

  /**
   * change：受保护 → 入冲突队列；否则读盘 → 定向更新。
   *
   * @param {object} note 已存在的笔记对象
   * @param {string} path 路径
   * @param {object} result 结果累加器
   * @returns {Promise<void>}
   */
  async function handleChange (note, path, result) {
    const id = typeof note.id === 'string' && note.id ? note.id : resolveIdForPath(path)
    const dirty = hasDirtyMark(noteStore, id)
    const isCurrent = currentIdOf(noteStore) === id

    if (dirty || isCurrent) {
      const diskContent = await safeRead(path)
      if (diskContent === null) {
        // 读不出来就无从比较，宁可什么都不做，也不能凭空改 content
        result.ignored += 1
        return
      }
      const reason = dirty
        ? (isCurrent ? CONFLICT_REASONS.dirtyCurrent : CONFLICT_REASONS.dirty)
        : CONFLICT_REASONS.current
      const entry = {
        conflict: {
          id,
          title: typeof note.title === 'string' && note.title ? note.title : fileNameOf(path),
          path: typeof note.filePath === 'string' && note.filePath ? note.filePath : path,
          diskPreview: buildPreview(diskContent),
          memoryPreview: buildPreview(note.content),
          reason
        },
        diskContent,
        memoryContent: typeof note.content === 'string' ? note.content : '',
        path: typeof note.filePath === 'string' && note.filePath ? note.filePath : path
      }
      const existed = pending.has(id)
      pending.set(id, entry)
      // 只在「第一次入队」时计数：同一篇被反复改只是一条待处理冲突，
      // 计多了会让 toast 文案（"N 篇冲突"）虚高
      if (!existed) result.conflicted += 1
      log.info('外部变更：笔记受保护，已入冲突队列', {
        id,
        path: entry.path,
        reason: dirty ? 'dirty' : 'current'
      })
      return
    }

    const content = await safeRead(path)
    if (content === null) {
      result.ignored += 1
      return
    }
    applyDiskContent(note, content)
    result.updated += 1
  }

  /**
   * unlink：定向出库。
   *
   * 无论 dirty 与否都移除 —— 文件在磁盘上已经没了，留着一条指向虚无的笔记只会
   * 让下一次自动保存在不存在的路径上造孤儿。但**移除不等于沉默**：受保护的那批
   * 会进 `removedDirty`，由 UI 弹 toast 告诉用户「你的修改没写进磁盘」。
   *
   * @param {string} path 路径
   * @param {object} result 结果累加器
   * @returns {Promise<void>}
   */
  async function handleUnlink (path, result) {
    const note = findNoteByPath(path)
    if (!note) {
      result.ignored += 1
      return
    }
    const id = typeof note.id === 'string' && note.id ? note.id : resolveIdForPath(path)
    const protectedNote = isProtected(noteStore, id)
    if (dropNote(note)) {
      result.removed += 1
      if (protectedNote) {
        result.removedDirty.push({
          id,
          title: typeof note.title === 'string' && note.title ? note.title : fileNameOf(path),
          path: typeof note.filePath === 'string' && note.filePath ? note.filePath : path,
          content: typeof note.content === 'string' ? note.content : ''
        })
        log.warn('外部删除：该笔记有未保存修改 / 正在编辑', { id, path: note.filePath })
      }
      // 文件都没了，挂在它上面的冲突也失去意义
      if (pending.has(id)) pending.delete(id)
      clearDirty(id)
      if (typeof noteStore.onRemoved === 'function') {
        try {
          noteStore.onRemoved(note)
        } catch (error) {
          log.warn('外部删除：上游回调失败', { path: note.filePath, err: error })
        }
      }
      return
    }
    result.ignored += 1
  }

  // -- 主入口 ----------------------------------------------------------------

  /**
   * 处理一批变更（串行，绝不并发）。
   *
   * 串行是刻意的：同一路径的 `change` + `unlink` 同时到达时，并发会让「读到的内
   * 容」与「库里的状态」错位；串行至少保证后一条看到的是前一条落地后的状态。
   *
   * @param {Array<{path: string, kind: string}>} changes 变更清单
   * @returns {Promise<object>} SyncResult
   */
  async function applyChanges (changes) {
    const result = {
      added: 0,
      updated: 0,
      removed: 0,
      conflicted: 0,
      ignored: 0,
      // 契约外的附加字段：被删且「有未保存修改 / 正在编辑」的笔记清单，
      // 供 UI toast（矩阵里 unlink × dirty 那一格要求「告知」，计数表达不了）
      removedDirty: []
    }
    const list = Array.isArray(changes) ? changes : []

    for (const change of list) {
      const path = change && typeof change.path === 'string' ? change.path : ''
      const kind = change && typeof change.kind === 'string' ? change.kind : ''

      if (!path) {
        result.ignored += 1
        log.warn('外部变更：缺少 path，已忽略', { change })
        continue
      }
      if (SYNC_KINDS.indexOf(kind) < 0) {
        result.ignored += 1
        log.warn('外部变更：未知类型，已忽略', { path, kind })
        continue
      }
      if (!isNoteExtension(path)) {
        // 非笔记文件（.canvas / 图片 / 目录占位）：一次库变更都不触发
        result.ignored += 1
        continue
      }

      try {
        if (kind === 'unlink') {
          await handleUnlink(path, result)
          continue
        }
        const note = findNoteByPath(path)
        if (!note) {
          // 库里没有的路径收到 add / change：一律按新增入库。
          // 理由见文件头「两处裁决」—— 不崩、不静默丢用户的笔记。
          await handleAdd(path, result)
          continue
        }
        await handleChange(note, path, result)
      } catch (error) {
        // 单条炸掉不能让整批失效：后面的路径还是要处理
        result.ignored += 1
        log.error('外部变更：处理单条失败', { path, kind, err: error })
      }
    }

    if (result.added || result.updated || result.removed || result.conflicted) {
      log.info('外部变更已定向同步', {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        conflicted: result.conflicted,
        ignored: result.ignored
      })
    }
    return result
  }

  /** 串行化：上一次 apply 没跑完时，后到的排在后面，而不是交错执行 */
  let chain = Promise.resolve()

  /**
   * 处理一批外部变更。
   * @param {Array<object>} changes 变更清单
   * @returns {Promise<object>} SyncResult
   */
  function apply (changes) {
    const next = chain.then(() => applyChanges(changes), () => applyChanges(changes))
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * 取当前待处理的冲突清单（公开形状，字段严格 = 契约里那 6 个）。
   * @returns {Array<object>} Conflict 数组（副本）
   */
  function pendingConflicts () {
    const out = []
    for (const entry of pending.values()) {
      out.push({
        id: entry.conflict.id,
        title: entry.conflict.title,
        path: entry.conflict.path,
        diskPreview: entry.conflict.diskPreview,
        memoryPreview: entry.conflict.memoryPreview,
        reason: entry.conflict.reason
      })
    }
    return out
  }

  /**
   * 解决一条冲突。
   *
   * `disk`   → 用磁盘版覆盖内存（用户的未保存修改被放弃，dirty 随之清除）；
   * `memory` → 内存版不动，并**写回磁盘**覆盖外部改动（这正是 R-F6 里用户应该有
   *            的那个选择权）。
   *
   * 认不出 choice 时**什么都不做**：静默按某一侧处理等于替用户做一个可能丢稿的
   * 决定，冲突留在队列里由用户再点一次，代价小得多。
   *
   * @param {string} id 冲突 id（= 笔记 id）
   * @param {'disk'|'memory'} choice 选择
   * @returns {Promise<void>}
   */
  async function resolveConflict (id, choice) {
    const key = typeof id === 'string' ? id : String(id)
    const entry = pending.get(key)
    if (!entry) {
      log.warn('冲突解决：队列里没有这条冲突', { id: key })
      return
    }
    if (choice !== 'disk' && choice !== 'memory') {
      log.warn('冲突解决：未知的 choice，保持冲突不变', { id: key, choice })
      return
    }

    const note = findNoteById(key) || findNoteByPath(entry.path)
    if (!note) {
      // 笔记在等待期间被删了：没有可写的对象，直接出队
      log.warn('冲突解决：笔记已不在库中，冲突已丢弃', { id: key, path: entry.path })
      pending.delete(key)
      return
    }

    if (choice === 'disk') {
      // 优先再读一次磁盘：等用户做决定的这几秒里文件可能又被改了一次，
      // 「保留磁盘版本」指的是**现在**的磁盘，不是弹窗那一刻的快照
      const fresh = await safeRead(entry.path)
      const content = fresh === null ? entry.diskContent : fresh
      applyDiskContent(note, content)
      clearDirty(key)
      log.info('冲突解决：已采用磁盘版本', { id: key, path: entry.path })
    } else {
      const ok = await persistNote(note)
      if (!ok) {
        // 写盘失败也照常出队：反复弹同一个框比「下一次保存再试一次」更烦人；
        // 内容仍在内存里，下一次自动保存会重试。
        log.error('冲突解决：保留内存版但写回磁盘失败', { id: key, path: entry.path })
      } else {
        clearDirty(key)
        log.info('冲突解决：已保留内存版本并覆盖磁盘', { id: key, path: entry.path })
      }
    }
    pending.delete(key)
  }

  return { apply, pendingConflicts, resolveConflict }
}

/**
 * 只查「dirty 标记」本身（不含「是不是当前笔记」）。
 *
 * 与 `isProtected` 分开是为了让 handleChange 能区分 dirty 与 current 两种原因，
 * 给用户的理由文案才不会张冠李戴。
 *
 * @param {object} noteStore store 门面
 * @param {string} id 笔记 id
 * @returns {boolean} 有未保存标记返回 true
 */
function hasDirtyMark (noteStore, id) {
  if (!id) return false
  const set = noteStore && noteStore.dirtyNotes
  if (set && typeof set.has === 'function' && set.has(id)) return true
  if (typeof noteStore.isDirty === 'function') {
    try {
      return Boolean(noteStore.isDirty(id))
    } catch (error) {
      return false
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 门面：把真实的 useNoteStore() 接进内核
// ---------------------------------------------------------------------------

/**
 * 由真实 Pinia store 造一个满足内核契约的门面。
 *
 * 为什么要有这一层：`useNoteStore()` 目前**没有**导出 `upsert` / `remove` /
 * `dirtyNotes` / `reindexNote` / `resolveNoteId`（它们是 note.js 的模块内私有函数，
 * T19 之后也没对外暴露）。内核又必须保持「不 import store」—— 一旦 import 就有
 * 人（包括未来的自己）顺手调一次 `loadNotesFromPath`，R-F5 立刻回归。所以这一层
 * 存在的意义就是：**让调用方用真实 store 拼出门面，而不是手搓一个假 store**。
 *
 * 五项能力按「能不能从真实 store 推断」分两类：
 *   · 能推断：notes / currentNoteId / notesPath（store 已导出）、upsert / remove
 *     （直接改 store 已导出的响应式数组）、persist（= saveNoteToFile）；
 *   · 推断不了、必须由调用方注入：dirtyNotes（或 isDirty）、reindex（索引增量）。
 *     这两项缺了不会崩，只会在下面注释里写明的地方退化 —— 详见交付说明 §4。
 *
 * @param {object} noteStore 真实的 useNoteStore() 实例
 * @param {object} [options] 注入项
 * @param {Set<string>} [options.dirtyNotes] 未保存集合；缺省取 noteStore.dirtyNotes
 * @param {Function} [options.isDirty] (id) => boolean
 * @param {Function} [options.reindex] (note) => void
 * @param {Function} [options.readFile] (path) => Promise<string>
 * @param {Function} [options.persist] (note) => Promise<boolean>
 * @returns {object} 门面
 */
export function createNoteStoreFacade (noteStore, options = {}) {
  const store = noteStore || {}

  /**
   * 取笔记数组（Pinia setup store 解包后就是真数组）。
   * @returns {Array<object>} 笔记数组
   */
  function notesArray () {
    const raw = store.notes
    if (Array.isArray(raw)) return raw
    if (raw && Array.isArray(raw.value)) return raw.value
    return NO_NOTES
  }

  const facade = {
    /** 内核读写的就是 store 自己的响应式数组（不是副本） */
    get notes () {
      return notesArray()
    },
    get currentNoteId () {
      return store.currentNoteId
    },
    get notesPath () {
      return store.notesPath
    },
    get dirtyNotes () {
      return options.dirtyNotes || store.dirtyNotes || null
    },
    get isDirty () {
      if (typeof options.isDirty === 'function') return options.isDirty
      if (typeof store.isNoteDirty === 'function') return store.isNoteDirty
      return undefined
    },
    get resolveNoteId () {
      return typeof store.resolveNoteId === 'function' ? store.resolveNoteId : undefined
    },
    get readFile () {
      return typeof options.readFile === 'function' ? options.readFile : undefined
    },
    /**
     * 定向入库一篇新笔记。
     * @param {object} note 笔记对象
     * @returns {boolean} 恒为 true
     */
    upsert (note) {
      notesArray().unshift(note)
      // 走门面自己的 reindex（store 没导出该能力时它会静默跳过），
      // 而不是直接调 store.reindexNote —— 那个函数目前并不存在
      facade.reindex(note, 0)
      return true
    },
    /**
     * 定向出库一篇笔记（**只动内存，绝不动磁盘**：文件本来已经被外部删了）。
     * @param {object} note 笔记对象
     * @returns {boolean} 移除成功返回 true
     */
    remove (note) {
      const list = notesArray()
      const id = note && note.id
      const idx = list.findIndex(n => n.id === id)
      if (idx < 0) return false
      list.splice(idx, 1)
      // 当前指针指向被删的那篇时，按 store 自己的惯例挪到第一篇，
      // 否则编辑器会停在一条已经不存在的笔记上
      if (store.currentNoteId && store.currentNoteId === id) {
        store.currentNoteId = list.length > 0 ? list[0].id : null
      }
      if (typeof store.unindexNote === 'function') store.unindexNote(id)
      return true
    },
    /**
     * 索引增量登记（note.js 未导出该能力时静默跳过）。
     * @param {object} note 笔记对象
     * @param {number} [position] 传给索引的位置提示
     * @returns {void}
     */
    reindex (note, position = -1) {
      if (typeof options.reindex === 'function') {
        options.reindex(note, position)
        return
      }
      if (typeof store.reindexNote === 'function') {
        try {
          store.reindexNote(note, position)
        } catch (error) {
          // 索引失败不影响主流程：内容已经更新，索引在下一次全量载入时会补回来
        }
      }
    },
    /**
     * 把内存版写回磁盘（用户选了「保留我的修改」）。
     * @param {object} note 笔记对象
     * @returns {Promise<boolean>} 写成功返回 true
     */
    persist (note) {
      if (typeof options.persist === 'function') return options.persist(note)
      if (typeof store.saveNoteToFile === 'function') return store.saveNoteToFile(note)
      return Promise.resolve(false)
    },
    /**
     * 清除未保存标记。
     * @param {string} id 笔记 id
     * @returns {void}
     */
    clearDirty (id) {
      const set = options.dirtyNotes || store.dirtyNotes
      if (set && typeof set.delete === 'function') set.delete(id)
      if (typeof store.clearNoteDirty === 'function') store.clearNoteDirty(id)
    }
  }

  return facade
}

// ---------------------------------------------------------------------------
// Vue 接线层（给 App.vue / T24 用）
// ---------------------------------------------------------------------------

/**
 * 把 reconcile 内核接成一组响应式状态，供 ConflictDialog 直接消费。
 *
 * 内核是纯 JS（Map + 普通对象），这里负责两件事：把队列同步进 `ref`（让弹窗能
 * 响应）、把「被删且 dirty」的清单转成 toast 回调。
 *
 * @param {object} options 同 createReconciler，另加：
 * @param {Function} [options.onNotify] ({ type, message }) => void，用来弹 toast
 * @param {Function} [options.onConflicts] (conflicts) => void，队列变化时的回调
 * @returns {{ conflicts: import('vue').Ref<Array<object>>, apply: Function,
 *             resolve: Function, pendingConflicts: Function,
 *             reconciler: object }} 接线对象
 */
export function useExternalSync (options = {}) {
  const reconciler = createReconciler(options)
  const conflicts = ref([])
  const onNotify = typeof options.onNotify === 'function' ? options.onNotify : null
  const onConflicts = typeof options.onConflicts === 'function' ? options.onConflicts : null

  /**
   * 同步队列并回调上游。
   * @returns {Array<object>} 当前冲突清单
   */
  function sync () {
    conflicts.value = reconciler.pendingConflicts()
    if (onConflicts) onConflicts(conflicts.value)
    return conflicts.value
  }

  /**
   * 处理一批变更 + 出 toast。
   * @param {Array<object>} changes 变更清单
   * @returns {Promise<object>} SyncResult
   */
  async function apply (changes) {
    const result = await reconciler.apply(changes)
    sync()
    if (onNotify) {
      for (const entry of result.removedDirty) {
        onNotify({ type: 'warning', message: describeRemovedDirty(entry) })
      }
      const summary = describeSyncResult(result)
      if (summary) onNotify({ type: result.conflicted > 0 ? 'warning' : 'info', message: summary })
    }
    return result
  }

  /**
   * 解决一条冲突。
   * @param {string} id 冲突 id
   * @param {'disk'|'memory'} choice 选择
   * @returns {Promise<void>}
   */
  async function resolve (id, choice) {
    await reconciler.resolveConflict(id, choice)
    sync()
  }

  return {
    reconciler,
    conflicts,
    apply,
    resolve,
    pendingConflicts: () => reconciler.pendingConflicts()
  }
}
