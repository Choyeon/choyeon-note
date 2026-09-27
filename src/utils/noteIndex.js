// ============================================================================
// noteIndex.js —— 笔记派生数据（链接图 / 标签 / 日期分组）的增量索引
//
// 背景：note.js 里 allTags / linkGraph / notesByDate 三个 computed 各自对
// 全库每篇笔记跑一遍 parseFrontmatter + extractTags + parseWikiLinks（含逐字符
// maskCodes）。500 篇 ×5KB 的库，敲一个键就是 ~5MB 正则工作量 ×3 次。
//
// 方案：把「每篇笔记的解析结果」缓存进索引，只有真正被改动的那篇才重解析；
// 三个 computed 退化为 O(n) 的 Map 归并。
//
// 正确性不变量（由 tests/noteIndex.test.js 逐条断言）：
//   index.snapshot() 的结果必须与 useLinks.buildLinkGraph(notes) 完全一致
//   ——同样的五个方法、同样的签名、同样的返回结构。为此这里复刻了 buildLinkGraph
//   的构造顺序与字段（含 titleIndex / pathIndex / tagIndex 等内部结构），并使用
//   useLinks 导出的 normalizeLinkTarget 保证键归一化一致。
//   useLinks 未导出的三个内部纯函数（normalizePathPart / resolveLinkInternal /
//   extractContext）在这里按原实现逐行复刻，任何一侧变更都必须同步。
//
// T18（R-C1 / R-D1）改了 dateKey 的**来源，没改格式**：
//   · 旧：`dateKey: dateKeyOf(note.updatedAt)` —— 日历按「最近修改」归日期，
//     于是今天打开一篇三个月前的笔记，它就从三个月前跳到今天；
//   · 新：`dateKey: dateKeyOf(resolveNoteDate(...).date)` —— 走 dateAttribution
//     的四级回落（frontmatter date > 文件 birthtime > 标题日期串 > updatedAt），
//     Obsidian 的「创建日期」口径。
//   格式仍是 `new Date(ts).toDateString()`，因为它是 store 的 getNotesByDate
//   与 CalendarView 的对外契约（改成 'YYYY-MM-DD' 会让全库 dateKey 对不上）。
// ============================================================================

import {
  parseFrontmatter,
  parseWikiLinks,
  extractTags,
  normalizeLinkTarget
} from '../composables/useLinks.js'
import { resolveNoteDate } from './dateAttribution.js'

/**
 * 复刻 useLinks 内部 normalizePathPart —— 不可导出，只能同源复制。
 * @param {string} p 路径片段
 * @returns {string} 归一化后的小写路径
 */
function normalizePathPart (p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

/**
 * 复刻 useLinks 内部 resolveLinkInternal —— 与 buildLinkGraph 同一实现。
 * @param {string} anchor 链接目标
 * @param {object} ctxNote 发起链接的笔记（用于重名消歧）
 * @param {Map<string, Set<string>>} titleIndex 标题索引
 * @param {Map<string, string>} pathIndex 路径索引
 * @returns {{id: string}|null} 命中的笔记 id
 */
function resolveLinkInternal (anchor, ctxNote, titleIndex, pathIndex) {
  if (!anchor) return null
  const clean = anchor.replace(/\.md$/i, '')
  if (clean.includes('/')) {
    const id = pathIndex.get(normalizePathPart(clean)) ||
      pathIndex.get(normalizePathPart(clean.replace(/^\//, '')))
    if (id) return { id }
  }
  const key = normalizeLinkTarget(clean)
  const cands = titleIndex.get(key)
  if (!cands || cands.size === 0) return null
  if (cands.size === 1) return { id: Array.from(cands)[0] }
  if (ctxNote && ctxNote.folder) {
    const fk = `${normalizePathPart(ctxNote.folder)}/${normalizePathPart(anchor.replace(/\.md$/i, ''))}`
    const id = pathIndex.get(fk)
    if (id) return { id }
  }
  return { id: Array.from(cands)[0] }
}

/**
 * 复刻 useLinks 内部 extractContext —— 取链接左右各 80 字符做上下文。
 * @param {string} body 去掉 frontmatter 的正文
 * @param {number} start 链接在正文中的起始偏移
 * @returns {string} 上下文片段
 */
function extractContext (body, start) {
  const snippetSize = 80
  const startIdx = Math.max(0, start - snippetSize)
  const endIdx = Math.min(body.length, start + snippetSize)
  const s = body.slice(startIdx, endIdx).replace(/\s+/g, ' ').trim()
  return (startIdx > 0 ? '…' : '') + s + (endIdx < body.length ? '…' : '')
}

/**
 * 从「已解析」的 frontmatter / body 推导候选标题集合，语义对齐
 * useLinks 内部 candidateTitles（只是不再重复 parseFrontmatter）。
 * @param {object} note 笔记对象
 * @param {string} body 去掉 frontmatter 的正文
 * @param {object} frontmatter 已解析的 frontmatter
 * @returns {string[]} 候选标题
 */
function candidateTitlesFrom (note, body, frontmatter) {
  const arr = [note.title]
  if (note.filePath) {
    const p = String(note.filePath).split(/[/\\]/).pop()
    const base = p.replace(/\.md$/i, '')
    if (base) arr.push(base)
  }
  const firstH = body.match(/^#\s+(.+)$/m)
  if (firstH) arr.push(firstH[1].trim())
  if (frontmatter.aliases) {
    const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [frontmatter.aliases]
    aliases.forEach(a => arr.push(String(a)))
  }
  if (frontmatter.title) arr.push(String(frontmatter.title))
  return arr.filter(Boolean)
}

/**
 * 取去掉时区干扰的日期分组键，与 store 里 new Date(...).toDateString() 同源。
 *
 * ⚠️ 这个**字符串格式是对外契约**，`T18` 一个字符都没动它：
 *   · store 的 `getNotesByDate(date)`（note.js）是 `new Date(date).toDateString()`
 *     之后拿这个串去 `index.byDate()` 取桶；
 *   · CalendarView 也是同一个串。
 * T18 改的只是「喂给它的时间戳从哪来」：`note.updatedAt` → `resolveNoteDate()`
 * 四级回落的结果。改成 'YYYY-MM-DD' 会让全库 dateKey 与调用方集体对不上，
 * 表现就是日历整片空白 —— 所以这里保持 toDateString() 不动。
 *
 * @param {Date|string|number} value 时间
 * @returns {string} 形如 'Mon Jan 01 2024'
 */
export function dateKeyOf (value) {
  try {
    return new Date(value).toDateString()
  } catch {
    return new Date(0).toDateString()
  }
}

/**
 * 取一篇笔记的 birthtime（四级回落里的第 ② 级磁盘证据）。
 *
 * 索引是纯内存的，它拿不到文件 birthtime —— 那是主进程 `fs.stat` 的事（后续
 * 批次才接）。所以这里是**可选注入**，四级优先：
 *   ① 本次调用显式给的 `options.birthtime`（单篇 upsert 时用）；
 *   ② 本次调用给的 `options.birthtimeOf(note)`；
 *   ③ 建索引时给的 `birthtimeOf(note)`（T19 打通 stat 后最省事的接法）；
 *   ④ 笔记对象自己带的 `note.birthtime`（载入时顺手挂上即可，零接线）；
 *   ⑤ 都没有 → null，resolveNoteDate 自动落到 ③ 标题 / ④ updatedAt。
 *
 * 拿不到就返回 null，绝不自己 stat、也绝不猜 —— 猜出来的 birthtime 一旦写进
 * dateKey，就是「日历上一整片笔记跑到同一天」。
 *
 * @param {object} note 笔记对象
 * @param {object|null} callOpts 本次调用的选项
 * @param {Function|null} indexBirthtimeOf 索引级解析器
 * @returns {Date|number|string|null} birthtime
 */
function resolveBirthtime (note, callOpts, indexBirthtimeOf) {
  if (callOpts && typeof callOpts === 'object') {
    if (callOpts.birthtime !== undefined && callOpts.birthtime !== null) {
      return callOpts.birthtime
    }
    if (typeof callOpts.birthtimeOf === 'function') {
      const picked = callOpts.birthtimeOf(note)
      if (picked !== undefined && picked !== null) return picked
    }
  }
  if (typeof indexBirthtimeOf === 'function') {
    const picked = indexBirthtimeOf(note)
    if (picked !== undefined && picked !== null) return picked
  }
  if (note && note.birthtime !== undefined && note.birthtime !== null) {
    return note.birthtime
  }
  return null
}

/**
 * 安全提取正文标签：单个笔记内容异常时不能连累整张索引。
 * @param {string} content 笔记正文（含 frontmatter）
 * @returns {string[]} 标签数组
 */
function safeExtractTags (content) {
  try {
    return extractTags(content)
  } catch {
    return []
  }
}

/**
 * 创建笔记派生索引。
 * @param {object} [options={}] 选项
 * @param {(note: object) => (Date|number|string|null)} [options.birthtimeOf]
 *        birthtime 解析器（四级回落第 ② 级）。不传就是 null，那一级自动跳过 ——
 *        索引是纯内存的，绝不自己去 stat 文件
 * @param {number} [options.now] 注入时钟（毫秒）。不传则 resolveNoteDate 自己读
 *        Date.now()；单测里传它是为了「同一份库永远得到同一份 dateKey」
 * @returns {object} 索引实例
 */
export function createNoteIndex (options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const indexBirthtimeOf = typeof opts.birthtimeOf === 'function' ? opts.birthtimeOf : null
  const indexNow = opts.now === undefined ? null : opts.now

  /** @type {Map<string, object>} id → 缓存条目，插入顺序必须与 notes 数组一致 */
  const byId = new Map()
  /** @type {Map<string, Set<string>>} 标签 → 笔记 id 集合 */
  const tagIndex = new Map()
  /** @type {Map<string, Set<string>>} 日期键 → 笔记 id 集合 */
  const dateIndex = new Map()

  let snapshotCache = null
  let allTagsCache = null

  /** 任何结构变更后丢弃缓存 */
  function invalidate () {
    snapshotCache = null
    allTagsCache = null
  }

  /**
   * 用一篇笔记构建缓存条目（唯一会发生重解析的地方）。
   * @param {object} note 笔记对象
   * @param {object|null} [entryOpts=null] 本次构建的选项：
   *        `{ birthtime }` 直接给值；`{ birthtimeOf(note) }` 批量给解析器；
   *        `{ now }` 注入时钟（只影响第 ④ 级兜底与 birthtime 的未来判定）
   * @returns {object} 缓存条目
   */
  function buildEntry (note, entryOpts = null) {
    const content = typeof note.content === 'string' ? note.content : ''
    const { frontmatter, body } = parseFrontmatter(content)
    const tags = safeExtractTags(content)
    const links = parseWikiLinks(body)
    const titles = candidateTitlesFrom(note, body, frontmatter)

    // dateKey 的**格式**没变（还是 dateKeyOf 的 toDateString），变的是时间戳
    // 的来源：note.updatedAt → resolveNoteDate() 的四级回落。
    // 只把 resolveNoteDate 真正读的三个字段喂进去，避免 note 上其它字段
    // （比如未来加的 createdAt 字符串）悄悄影响归属。
    const nowOpt = entryOpts && entryOpts.now !== undefined ? entryOpts.now : indexNow
    const resolveOpts = { birthtime: resolveBirthtime(note, entryOpts, indexBirthtimeOf) }
    // now 只在显式注入时才传：传 null 会让 resolveNoteDate 的兜底变成 1970
    if (nowOpt !== undefined && nowOpt !== null) resolveOpts.now = nowOpt
    const resolved = resolveNoteDate(
      { content, title: note.title, updatedAt: note.updatedAt },
      resolveOpts
    )

    return {
      id: note.id,
      note,
      title: note.title,
      folder: note.folder || '',
      content,
      body,
      tags,
      links,
      titles,
      /** 归属时间戳（毫秒）—— 排查「这篇为什么在这一格」时用 */
      dateTs: resolved.date,
      /** 日期分组键：格式与旧实现逐字一致，见 dateKeyOf 的注释 */
      dateKey: dateKeyOf(resolved.date),
      /** 归属来源，DATE_SOURCE 四值之一 */
      dateSource: resolved.source,
      /** 来源原文（frontmatter 的原始值串 / 标题里命中的日期串） */
      dateRaw: resolved.raw
    }
  }

  /**
   * 从日期分组里摘掉一条记录。
   * @param {object} entry 缓存条目
   * @returns {void}
   */
  function dropFromDateIndex (entry) {
    const bucket = dateIndex.get(entry.dateKey)
    if (!bucket) return
    bucket.delete(entry.id)
    if (bucket.size === 0) dateIndex.delete(entry.dateKey)
  }

  /**
   * 把一条记录挂进日期分组。
   * @param {object} entry 缓存条目
   * @returns {void}
   */
  function addToDateIndex (entry) {
    if (!dateIndex.has(entry.dateKey)) dateIndex.set(entry.dateKey, new Set())
    dateIndex.get(entry.dateKey).add(entry.id)
  }

  /**
   * 增量维护标签倒排：先撤旧标签，再挂新标签。
   * @param {object|null} oldEntry 旧条目
   * @param {object|null} newEntry 新条目
   * @returns {void}
   */
  function syncTagIndex (oldEntry, newEntry) {
    if (oldEntry) {
      for (const tag of oldEntry.tags) {
        const bucket = tagIndex.get(tag)
        if (!bucket) continue
        bucket.delete(oldEntry.id)
        if (bucket.size === 0) tagIndex.delete(tag)
      }
    }
    if (newEntry) {
      for (const tag of newEntry.tags) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, new Set())
        tagIndex.get(tag).add(newEntry.id)
      }
    }
  }

  /**
   * 插入或更新一篇笔记。
   * @param {object} note 笔记对象
   * @param {number} position 新笔记的插入位置：0 表示插到最前（对应 notes.unshift），
   *                          -1 表示追加到末尾。已存在的笔记始终原地更新。
   * @param {object|null} [entryOpts=null] 本次构建的 birthtime / now 注入，见 buildEntry
   * @returns {boolean} 是否成功
   */
  function upsert (note, position = -1, entryOpts = null) {
    if (!note || note.id === undefined || note.id === null) return false
    const existing = byId.get(note.id)
    const entry = buildEntry(note, entryOpts)

    if (existing) {
      // Map.set 对已存在的 key 不改变插入位置 —— 与「数组原地修改」同序
      dropFromDateIndex(existing)
      byId.set(note.id, entry)
    } else if (position === 0) {
      // notes.unshift 的场景必须同步到最前：snapshot() 的遍历顺序决定
      // titleIndex 的首个成员，重名链接的解析结果依赖它。O(n) 但仅在新建时发生。
      const entries = [[note.id, entry], ...Array.from(byId.entries())]
      byId.clear()
      for (const [k, v] of entries) byId.set(k, v)
    } else {
      byId.set(note.id, entry)
    }

    addToDateIndex(entry)
    syncTagIndex(existing, entry)
    invalidate()
    return true
  }

  /**
   * 移除一篇笔记。
   * @param {string} id 笔记 id
   * @returns {boolean} 是否真的删掉了
   */
  function remove (id) {
    const entry = byId.get(id)
    if (!entry) return false
    byId.delete(id)
    dropFromDateIndex(entry)
    syncTagIndex(entry, null)
    invalidate()
    return true
  }

  /**
   * 整体重建：切换目录 / resetConfig / 批量改动后调用，按数组顺序重排。
   * @param {Array<object>} notes 笔记数组
   * @param {object|null} [entryOpts=null] 本次构建的 birthtime / now 注入，见 buildEntry
   * @returns {number} 载入条数
   */
  function replaceAll (notes, entryOpts = null) {
    byId.clear()
    dateIndex.clear()
    tagIndex.clear()
    for (const note of Array.isArray(notes) ? notes : []) {
      if (!note || note.id === undefined || note.id === null) continue
      const entry = buildEntry(note, entryOpts)
      byId.set(note.id, entry)
      addToDateIndex(entry)
      syncTagIndex(null, entry)
    }
    invalidate()
    return byId.size
  }

  /**
   * 全库标签并集：note.tags 与正文标签都要算，顺序与旧 allTags computed 一致。
   * @returns {string[]} 标签列表
   */
  function allTags () {
    if (allTagsCache) return allTagsCache
    const tagSet = new Set()
    for (const entry of byId.values()) {
      const declared = entry.note && Array.isArray(entry.note.tags) ? entry.note.tags : []
      for (const tag of declared) tagSet.add(tag)
      for (const tag of entry.tags) tagSet.add(tag)
    }
    allTagsCache = Array.from(tagSet)
    return allTagsCache
  }

  /**
   * 某一天的笔记（保持原数组顺序）。
   * @param {string} dateKey new Date(...).toDateString() 的结果
   * @returns {Array<object>} 笔记对象数组
   */
  function byDate (dateKey) {
    const ids = dateIndex.get(dateKey)
    if (!ids || ids.size === 0) return []
    const out = []
    for (const id of ids) {
      const entry = byId.get(id)
      if (entry && entry.note) out.push(entry.note)
    }
    return out
  }

  /**
   * 构造链接图快照，结构与 useLinks.buildLinkGraph 完全一致。
   * @returns {object} 链接图对象
   */
  function buildSnapshot () {
    const list = Array.from(byId.values())
    const titleIndex = new Map()
    const pathIndex = new Map()
    const outgoing = new Map()
    const backlinks = new Map()
    const unresolved = new Map()

    for (const entry of list) {
      for (const t of entry.titles) {
        const k = normalizeLinkTarget(t)
        if (!titleIndex.has(k)) titleIndex.set(k, new Set())
        titleIndex.get(k).add(entry.id)
      }
      const folderKey = entry.folder
        ? `${normalizePathPart(entry.folder)}/${normalizePathPart(entry.title)}`
        : normalizePathPart(entry.title)
      pathIndex.set(folderKey, entry.id)
    }

    for (const entry of list) {
      const out = []
      for (const l of entry.links) {
        const resolved = resolveLinkInternal(l.target, entry, titleIndex, pathIndex)
        const rec = {
          target: l.target,
          hash: l.hash,
          alias: l.alias,
          embed: l.embed,
          raw: l.raw,
          resolvedId: resolved ? resolved.id : null
        }
        out.push(rec)
        if (resolved) {
          if (!backlinks.has(resolved.id)) backlinks.set(resolved.id, [])
          backlinks.get(resolved.id).push({
            fromId: entry.id,
            fromTitle: entry.title,
            fromFolder: entry.folder || '',
            raw: l.raw,
            alias: l.alias,
            context: extractContext(entry.body, l.start)
          })
        } else {
          if (!unresolved.has(entry.id)) unresolved.set(entry.id, [])
          unresolved.get(entry.id).push({ target: l.target, reason: 'not-found' })
        }
      }
      outgoing.set(entry.id, out)
    }

    return {
      titleIndex,
      pathIndex,
      outgoing,
      backlinks,
      unresolved,
      tagIndex,
      getByTitle: (title) => {
        const k = normalizeLinkTarget(title)
        const s = titleIndex.get(k)
        return s ? Array.from(s) : []
      },
      getBacklinks: (id) => backlinks.get(id) || [],
      getOutgoing: (id) => outgoing.get(id) || [],
      getUnresolved: (id) => unresolved.get(id) || [],
      getNotesByTag: (tag) => Array.from(tagIndex.get(tag) || [])
    }
  }

  /**
   * 取链接图快照（带缓存，索引未变时复用同一对象）。
   * @returns {object} 链接图对象
   */
  function snapshot () {
    if (!snapshotCache) snapshotCache = buildSnapshot()
    return snapshotCache
  }

  return {
    byId,
    tagIndex,
    dateIndex,
    upsert,
    remove,
    replaceAll,
    allTags,
    byDate,
    snapshot
  }
}

export default createNoteIndex
