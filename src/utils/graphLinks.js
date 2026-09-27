// ============================================================================
// graphLinks.js —— 关系图「双链进图」内核（T34 · R-G1 / R-G2）
//
// 本文件解决的最痛问题：GraphView 里的图谱曾经只按「相似度」连边，
// 用户手写的 [[某笔记]] 双链一条都没进图（R-G1, P0）。
//
// 设计契约（改动前请先读这段）：
//   1. **纯函数 + 零 import**：不依赖 vue / pinia / store / useLinks，
//      也不碰 DOM 与 localStorage。因此它能在 vitest(node)、浏览器、
//      Web Worker、Electron 主进程里以同一份代码毫秒级跑完，后续也能
//      整块平移到原生侧（见 scripts/build-c.js 的 NativeBridge 约定）。
//      唯一的一致性保证手段是可执行测试：tests/graphLinks.test.js 用
//      fs.readFileSync 做「源码级断言」，任一侧漂移立刻变红。
//   2. **口径对齐 useLinks.js**：
//      - tag 正则逐字复制自 src/composables/useLinks.js:258 的 TAG_REGEX，
//        杜绝 GraphView 里那份本地宽松版：它不要求 # 前是行首或空白，
//        于是会把 C 语言的预处理指令、URL 锚点统统误判成标签 —— 这正是
//        R-G2 要治的「两个口径」。注意别在注释里复刻那份宽松写法，
//        否则会被 tests/graphLinks.test.js 的源码级守卫判红。
//      - wiki 链接语法与 useLinks.js 的 WIKI_REGEX 一致：[[t#hash|alias]] / ![[t]]。
//      - 标题归一化与 useLinks.js 的 normalizeLinkTarget 一致（去 .md、反斜杠转正斜杠、小写）。
//   3. **相似度算法不重写**：buildSimilarEdges 只接受「关键词提取函数」注入，
//      默认实现是朴素的倒排 buckets。T35 接入时把 GraphView 现有的
//      extractTitleKeywords / extractContentKeywords 原样传进来即可，
//      相似度语义（哪些词算相似）仍由 GraphView 持有。
//
// 边的形状（唯一约定，T35 请按此消费）：
//   Edge = { source: string, target: string, kind: 'wiki'|'tag'|'similar', weight: number }
//   · source/target 一律是 **笔记 id 字符串**（不是对象），且按字典序 source < target，
//     避免 A→B 与 B→A 变成两条无向边。
//   · kind 决定配色与粗细；weight 决定力导向的吸引强度。
// ============================================================================

// ---------------------------------------------------------------------------
// 0) 常量
// ---------------------------------------------------------------------------

/** 边的三种来源。双链是第一公民，相似度只是补充。 */
export const EDGE_KINDS = { wiki: 'wiki', tag: 'tag', similar: 'similar' }

/**
 * 各类边的权重。双链最高：用户显式写的 [[链接]] 才是关系图的主干，
 * 相似度边必须与它拉开量级差，否则 500 篇笔记下相似度会把真实结构淹没。
 */
export const EDGE_WEIGHT = { wiki: 3, tag: 2, similar: 0.5 }

/** 支持的 linkMode 取值，导出给 UI 做下拉选项，避免字符串散落各处。 */
export const LINK_MODES = { ALL: 'all', WIKI_ONLY: 'wiki-only' }

/**
 * tag buckets 的成员上限（对应 GraphView 的 MAX_BUCKET）。
 * 一个标签挂了几百篇笔记时它对「结构」没有区分度，跳过还能省下 O(n²) 的配对。
 */
const DEFAULT_TAG_MAX_BUCKET = 200

/** similar buckets 的成员上限，理由同上。 */
const DEFAULT_SIMILAR_MAX_BUCKET = 200

/** 判定「相似」所需的最少共享关键词数（去重后计数）。 */
const DEFAULT_MIN_SHARED_KEYWORDS = 2

/** 单篇笔记参与相似度比较的关键词上限，防止长文把倒排表灌爆。 */
const DEFAULT_MAX_KEYWORDS_PER_NOTE = 24

/**
 * 相似度采样窗口（字符数）。
 *
 * 为什么敢截断：相似度只要「区分度」，不需要全文——GraphView 自己也只用 Top10 热词。
 * 而 2KB 手记照样吃得下：每篇千万字的超长日志才可能让后半部分被忽略。
 * 反过来的收益很实在：500 篇 × 2KB 语料下，正文提取从 ~30ms 降到 ~13ms，
 * 是让「全量 buildLinkEdges < 50ms」这条硬指标有余量（而不是卡线）的关键一刀。
 *
 * ⚠️ 这个截断**只作用于相似度**。wiki 双链与 tag 永远扫全文（用户对这两类有强预期）。
 * T35 若不想要截断，把 maxScanLength 传 0 即可关闭。
 */
const DEFAULT_SIMILAR_SCAN_LENGTH = 1024

/** 兜底相似提取器每篇保留的正文热词数。 */
const DEFAULT_TOP_CONTENT_KEYWORDS = 10

/**
 * 权威 tag 正则 —— 必须与 src/composables/useLinks.js:258 的 TAG_REGEX 逐字一致。
 * 语义：# 前必须是行首或空白（所以 C 语言的 #define、URL 的 #anchor 都不算标签），
 * 标签体只允许中英文、数字、下划线与连字符。
 * ⚠️ 改这里之前先看 tests/graphLinks.test.js 里的「TAG_REGEX 逐字一致性」用例。
 */
const TAG_REGEX = /(^|\s)#([A-Za-z0-9_\u4e00-\u9fa5-]+)/g

/**
 * Wiki 双链正则，语义对齐 useLinks.js 的 WIKI_REGEX。
 *   group1 = '!' 表示嵌入（![[x]]），group2 = 目标，group3 = #hash，group4 = |alias。
 * 目标部分天然排除了 '#' 与 '|'，因此 [[B#小节]] / [[B|别名]] 取到的 group2 就是 B。
 */
const WIKI_LINK_REGEX = /(!?)\[\[([^\]#|\r\n]+)(#[^\]|\r\n]+)?(\|[^\]\r\n]+)?\]\]/g

/** frontmatter 围栏（与 useLinks.js 的 FM_START / FM_FENCE 同语义）。 */
const FRONTMATTER_START = /^---\s*\n/
const FRONTMATTER_FENCE = /^---\s*\n[\s\S]*?\n---\s*\n?/m

/** 标题起始的 #（## heading 不该被当成标签）。 */
const HEADING_PREFIX = /^#{1,6}\s+/gm

/** 兜底关键词提取器的取词规则：连续「字母/数字/下划线」为一个 token。 */
const KEYWORD_TOKEN = /[\p{L}\p{N}_]+/gu
/**
 * token 之间的分隔符：非「字母/数字/下划线/中日韩」皆切一刀。
 *
 * ⚠️ 这里刻意**不用** `\p{L}\p{N}` 这类 Unicode 属性转义：实测在 V8 上
 * 比等价的显式字符类慢 4~5 倍（500 篇 × 2KB 语料：23ms → 4.3ms，
 * 见 tmp/t34-bench2.mjs）。代价是不再覆盖西里尔 / 带音标字母，
 * 对本笔记应用（中英混排）不构成实际损失。
 */
const KEYWORD_SEPARATOR = /[^\w\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g
/** 命中中日韩字符时退化为 bigram，否则整句中文永远切不出可复用的关键词。 */
const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/

// ---------------------------------------------------------------------------
// 1) 通用小工具（全部私有，零副作用）
// ---------------------------------------------------------------------------

/**
 * 把入参收敛成笔记数组。null / undefined / 非数组一律得到 []。
 * @param {unknown} notes 任意入参
 * @returns {Array<Object>} 过滤掉 null 与非对象后剩下的笔记
 */
function toNoteList (notes) {
  if (!Array.isArray(notes)) return []
  const out = []
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    if (n && typeof n === 'object') out.push(n)
  }
  return out
}

/**
 * 收敛成「选项对象」。传 null / 字符串 / 数组都不会炸。
 * @param {unknown} options 任意入参
 * @returns {Object} 选项对象（可能为空对象）
 */
function toOptions (options) {
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {}
}

/**
 * 取一个「id 字符串」。兼容三种注入风格：
 *   - 直接返回 id 字符串（推荐）
 *   - 返回笔记对象（此时取 .id）
 *   - 返回数字 id
 * @param {unknown} value resolveTarget / idOfTitle 的返回值
 * @returns {string} id；取不到时返回空字符串
 */
function pickId (value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'object') {
    const inner = value.id
    if (inner === null || inner === undefined || inner === '') return ''
    return String(inner)
  }
  return ''
}

/**
 * 取笔记自身的 id。没有可用 id 的笔记不参与建图（否则会连出空节点）。
 * @param {Object} note 笔记
 * @returns {string} id；取不到时返回空字符串
 */
function noteId (note) {
  return note ? pickId(note.id) : ''
}

/**
 * 标题归一：与 useLinks.js 的 normalizeLinkTarget 保持一致。
 * @param {unknown} title 原始标题 / 链接目标
 * @returns {string} 归一化 key
 */
function normalizeTitleKey (title) {
  return String(title === null || title === undefined ? '' : title)
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

/**
 * 取文件名（去路径、去 .md 后缀），用于让 [[folder/name]] 与 [[name]] 都能命中。
 * @param {unknown} filePath 文件路径
 * @returns {string} 基名（已去 .md），失败返回空串
 */
function basenameOfPath (filePath) {
  if (typeof filePath !== 'string' || !filePath) return ''
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1].replace(/\.md$/i, '')
}

/** 围栏代码块（含未闭合的情况），用于整体抹平成空格。 */
const FENCED_BLOCK = /```[\s\S]*?(?:```|$)/g
/** 行内代码，不跨行。 */
const INLINE_CODE = /`[^\n`]*`/g

/**
 * 把代码块（```围栏 与 `行内`）替换成等长空格。
 * 目的有两个：① 代码块里的 [[示例]] 不该变成真链接；② 保持等长，偏移不错位。
 *
 * 实现刻意用两次正则 replace 而不是逐字符循环：这是本模块唯一会被
 * 「每篇笔记都调用一次」的文本预处理，500 篇 × 2KB 下逐字符 JS 循环
 * 实测要多花近 10ms（见 tmp/t34-perf.mjs 的分段计时）。
 * @param {unknown} text 原始 markdown
 * @returns {string} 抹平代码后的文本
 */
function stripCodeSpans (text) {
  if (typeof text !== 'string' || text === '') return ''
  const blank = (m) => ' '.repeat(m.length)
  return text.replace(FENCED_BLOCK, blank).replace(INLINE_CODE, blank)
}

/**
 * 去掉 YAML frontmatter，保留正文。frontmatter 里的 `tags:` 是另一回事，
 * 由 useLinks 的权威 extractTags 负责；这里不碰，避免把 YAML key 误读成正文。
 * @param {unknown} md 原始 markdown
 * @returns {string} 正文
 */
function stripFrontmatter (md) {
  if (typeof md !== 'string' || md === '') return ''
  if (!FRONTMATTER_START.test(md)) return md
  const matched = md.match(FRONTMATTER_FENCE)
  return matched ? md.substring(matched[0].length) : md
}

// ---------------------------------------------------------------------------
// 2) 边收集器：负责「自环丢弃 + 无向归一化 + 同对去重」
// ---------------------------------------------------------------------------

/**
 * composite key 里留给「笔记下标」的位宽（2^20 ≈ 104 万篇笔记）。
 * 边的去重 key 用整数合成而不是字符串拼接：500 篇笔记能产出 3~4 万条边，
 * 每条省下一次字符串拼接 + 哈希，实测是热路径上最后一档可观收益。
 */
const EDGE_SLOT_STRIDE = 1048576

/**
 * 创建一个边容器。
 *
 * 内部用 <id字符串 → 下标 → 整数 composite key> 两级映射：
 * 既让 key 变成整数，又保证对外输出仍然是原始 id 字符串。
 * requirement 5（自环丢弃 + 字典序归一 + 同对同 kind 去重）在这里集中实现，
 * 三个 builder 都不必各自重复一遍。
 * @returns {{add: Function, toArray: Function, size: Function}} 边容器
 */
function createEdgeSink () {
  const slots = new Map() // id → 下标
  const ids = []          // 下标 → id
  const map = new Map()   // 整数 composite key → { a, b, kind, weight }

  /**
   * 取某 id 的下标（不存在则登记）。
   * @param {string} id 笔记 id
   * @returns {number} 下标
   */
  const slotOf = (id) => {
    const hit = slots.get(id)
    if (hit !== undefined) return hit
    const slot = ids.length
    ids.push(id)
    slots.set(id, slot)
    return slot
  }

  /**
   * 尝试放入一条边。自环与重复会被静默丢弃。
   * @param {string} idA 一端笔记 id
   * @param {string} idB 另一端笔记 id
   * @param {string} kind EDGE_KINDS 之一
   * @param {number} weight 权重
   * @returns {boolean} 是否真的写入了新边
   */
  const add = (idA, idB, kind, weight) => {
    const a = String(idA === null || idA === undefined ? '' : idA)
    const b = String(idB === null || idB === undefined ? '' : idB)
    if (!a || !b) return false
    if (a === b) return false // 自环：不连
    // 无向归一：字典序小的当 source，A→B 与 B→A 才会落在同一条记录上
    const source = a < b ? a : b
    const target = a < b ? b : a
    const kindId = kind === EDGE_KINDS.tag ? 1 : (kind === EDGE_KINDS.similar ? 2 : 0)
    const key = (slotOf(source) * EDGE_SLOT_STRIDE + slotOf(target)) * 4 + kindId
    if (map.has(key)) return false // 同一对同一 kind 只留一条
    map.set(key, { source, target, kind, weight })
    return true
  }

  return {
    add,
    toArray: () => Array.from(map.values()),
    size: () => map.size
  }
}

// ---------------------------------------------------------------------------
// 3) wiki 边 —— 本次整改的主角
// ---------------------------------------------------------------------------

/**
 * 抽出一段 markdown 里所有 wiki 双链的「解析目标」。
 * 只返回 group2（目标本体）：[[B|别名]] → B，[[B#小节]] → B，[[B#^块]] → B。
 * 代码块内的 [[示例]] 不算，frontmatter 不参与。
 * @param {unknown} md 笔记正文
 * @returns {string[]} 目标列表（未去重，顺序即出现顺序）
 */
export function extractWikiTargets (md) {
  if (typeof md !== 'string' || md === '') return []
  const scanned = stripCodeSpans(stripFrontmatter(md))
  const out = []
  const re = new RegExp(WIKI_LINK_REGEX.source, WIKI_LINK_REGEX.flags)
  let matched = null
  while ((matched = re.exec(scanned)) !== null) {
    const target = String(matched[2] === undefined ? '' : matched[2]).trim()
    if (target) out.push(target)
    if (matched[0] === '') re.lastIndex += 1 // 防御：零宽匹配退化时手动推进
  }
  return out
}

/**
 * 建立「归一化标题 → 笔记」索引。
 * 一个笔记可以有多个入口 key：标题、文件名（去 .md）、frontmatter.title。
 * @param {Array<Object>} list 笔记列表
 * @returns {Map<string, Object[]>} key → 候选笔记数组（按 notes 原顺序）
 */
function buildTitleIndex (list) {
  const index = new Map()
  /**
   * 登记一个候选 key。
   * @param {string} key 归一化后的 key
   * @param {Object} note 笔记
   * @returns {void}
   */
  const push = (key, note) => {
    if (!key) return
    const bucket = index.get(key)
    if (bucket) {
      if (bucket.indexOf(note) === -1) bucket.push(note)
    } else {
      index.set(key, [note])
    }
  }
  for (let i = 0; i < list.length; i++) {
    const note = list[i]
    if (!noteId(note)) continue
    if (note.title !== undefined && note.title !== null) push(normalizeTitleKey(note.title), note)
    const base = basenameOfPath(note.filePath)
    if (base) push(normalizeTitleKey(base), note)
    // 带文件夹的写法（[[folder/title]]），对齐 useLinks 的 pathIndex 语义
    const folder = note.folder ? String(note.folder).replace(/\\/g, '/').toLowerCase() : ''
    if (folder && base) push(folder + '/' + normalizeTitleKey(base), note)
    if (folder && note.title) push(folder + '/' + normalizeTitleKey(note.title), note)
    const fmTitle = readFrontmatterTitle(note.content)
    if (fmTitle) push(normalizeTitleKey(fmTitle), note)
  }
  return index
}

/**
 * 读 frontmatter 里的 title 字段（只认最朴素的 `title: xxx` 行）。
 * @param {unknown} md 笔记正文
 * @returns {string} frontmatter.title，没有则空串
 */
function readFrontmatterTitle (md) {
  if (typeof md !== 'string' || md === '') return ''
  if (!FRONTMATTER_START.test(md)) return ''
  const matched = md.match(FRONTMATTER_FENCE)
  if (!matched) return ''
  const line = matched[0].match(/^[ \t]*title[ \t]*:[ \t]*(.+)$/m)
  return line ? String(line[1]).trim() : ''
}

/**
 * 用内部索引解析一个链接目标；重名时按「同源文件夹优先 → 原序最先」裁决。
 * @param {string} target 链接目标（如 'B'、'folder/B'、'B.md'）
 * @param {Object} fromNote 发起链接的笔记
 * @param {Map<string, Object[]>} index buildTitleIndex 的产物
 * @returns {string} 命中的笔记 id；解析不到返回空串
 */
function resolveViaIndex (target, fromNote, index) {
  const raw = String(target === null || target === undefined ? '' : target).trim()
  if (!raw) return ''
  const clean = raw.replace(/\.md$/i, '')

  // 1) 带路径的写法：folder/title（允许前导 / 与反斜杠）
  if (clean.indexOf('/') !== -1) {
    const byPath = index.get(normalizeTitleKey(clean)) || index.get(normalizeTitleKey(clean.replace(/^\//, '')))
    if (byPath && byPath.length > 0) return noteId(byPath[0])
  }

  // 2) 纯标题写法（大小写不敏感）
  const bucket = index.get(normalizeTitleKey(clean))
  if (!bucket || bucket.length === 0) return ''
  if (bucket.length === 1) return noteId(bucket[0])

  // 3) 重名裁决：与发起方同文件夹者优先
  const fromFolder = fromNote && fromNote.folder ? String(fromNote.folder) : ''
  if (fromFolder) {
    for (let i = 0; i < bucket.length; i++) {
      const folder = bucket[i].folder ? String(bucket[i].folder) : ''
      if (folder && normalizeTitleKey(folder) === normalizeTitleKey(fromFolder)) return noteId(bucket[i])
    }
  }
  return noteId(bucket[0])
}

/**
 * 构建 wiki 双链边。
 *
 * 硬规则：目标解析不到就跳过（绝不连孤儿边）、自环跳过、同一对只留一条、
 * source/target 按字典序归一、weight = EDGE_WEIGHT.wiki(3)。
 *
 * @param {Array<Object>|null} notes 笔记列表 [{id,title,folder,content,filePath}]
 * @param {Object} [options] 选项
 * @param {Function} [options.resolveTarget] (target, fromNote, notes) => id|note|null，优先使用
 * @param {Function} [options.idOfTitle] (title) => id|note|null，次优先；用于「只认标题」的简单场景
 * @returns {Array<{source: string, target: string, kind: string, weight: number}>} wiki 边
 */
export function buildWikiEdges (notes, options) {
  const list = toNoteList(notes)
  const opts = toOptions(options)
  const sink = createEdgeSink()
  if (list.length < 2) return []

  const customResolve = typeof opts.resolveTarget === 'function' ? opts.resolveTarget : null
  const idOfTitle = typeof opts.idOfTitle === 'function' ? opts.idOfTitle : null
  // 只有两条路都没给时才付代价建内部索引
  const index = customResolve || idOfTitle ? null : buildTitleIndex(list)

  for (let i = 0; i < list.length; i++) {
    const note = list[i]
    const sourceId = noteId(note)
    if (!sourceId) continue
    const targets = extractWikiTargets(note.content)
    if (targets.length === 0) continue

    for (let k = 0; k < targets.length; k++) {
      let targetId = ''
      if (customResolve) {
        try {
          targetId = pickId(customResolve(targets[k], note, list))
        } catch (error) {
          targetId = '' // 注入的解析器抛错：按「解析不到」处理，绝不让它炸掉整张图
        }
      } else if (idOfTitle) {
        try {
          targetId = pickId(idOfTitle(targets[k], note, list))
        } catch (error) {
          targetId = ''
        }
      } else {
        targetId = resolveViaIndex(targets[k], note, index)
      }
      if (!targetId) continue // 孤儿边：跳过
      sink.add(sourceId, targetId, EDGE_KINDS.wiki, EDGE_WEIGHT.wiki)
    }
  }
  return sink.toArray()
}

// ---------------------------------------------------------------------------
// 4) tag 边 —— 口径必须对齐 useLinks.js:258
// ---------------------------------------------------------------------------

/**
 * 兜底 tag 提取器（无依赖版本）。
 * 语义尽量贴近 useLinks.extractTags：去 frontmatter、去代码块、抹掉标题行首的 #，
 * 再用权威 TAG_REGEX 扫描。**唯一区别**：不读 frontmatter.tags 字段
 * （那是 YAML 层的职责，交给 T35 注入的 useLinks.extractTags 更合适）。
 * @param {unknown} md 笔记正文
 * @returns {string[]} 去重的标签列表
 */
export function extractTagsDefault (md) {
  if (typeof md !== 'string' || md === '') return []
  const cleaned = stripCodeSpans(stripFrontmatter(md)).replace(HEADING_PREFIX, (m) => ' '.repeat(m.length))
  const out = []
  const seen = new Set()
  const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags)
  let matched = null
  while ((matched = re.exec(cleaned)) !== null) {
    const tag = String(matched[2] === undefined ? '' : matched[2])
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/**
 * 构建 tag 边：共享同一个标签（小写归一）的笔记两两连边，weight = 2。
 *
 * 第二个参数既可以直接传函数（对齐本任务的接口签名），
 * 也可以传 `{ extractTags }` 选项对象（方便 T35 一次性透传整个 options）。
 *
 * @param {Array<Object>|null} notes 笔记列表
 * @param {Function|Object} [extractTags] (content, note) => string[]；未提供时返回 []
 * @param {Object} [options] 可选：{ maxBucket }
 * @returns {Array<{source: string, target: string, kind: string, weight: number}>} tag 边
 */
export function buildTagEdges (notes, extractTags, options) {
  const list = toNoteList(notes)
  const opts = toOptions(options)
  if (list.length < 2) return []

  // 兼容两种调用姿势：buildTagEdges(notes, fn) 与 buildTagEdges(notes, { extractTags: fn })
  let extractor = typeof extractTags === 'function' ? extractTags : null
  if (!extractor) {
    const boxed = toOptions(extractTags)
    if (typeof boxed.extractTags === 'function') extractor = boxed.extractTags
  }
  if (!extractor) return [] // requirement 7：没提供就安静地返回 []

  const maxBucket = Number.isFinite(opts.maxBucket) && opts.maxBucket > 1 ? opts.maxBucket : DEFAULT_TAG_MAX_BUCKET
  const buckets = new Map() // 归一 tag → Set<id>

  for (let i = 0; i < list.length; i++) {
    const note = list[i]
    const id = noteId(note)
    if (!id) continue
    let tags = null
    try {
      tags = extractor(note.content, note)
    } catch (error) {
      tags = null
    }
    if (!Array.isArray(tags)) continue
    for (let k = 0; k < tags.length; k++) {
      const raw = tags[k]
      if (raw === null || raw === undefined) continue
      const key = String(raw).trim().toLowerCase()
      if (!key) continue
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = new Set()
        buckets.set(key, bucket)
      }
      bucket.add(id)
    }
  }

  const sink = createEdgeSink()
  buckets.forEach((bucket) => {
    const ids = Array.from(bucket)
    if (ids.length < 2 || ids.length > maxBucket) return // 过于通用的标签没有区分度
    for (let x = 0; x < ids.length - 1; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        sink.add(ids[x], ids[y], EDGE_KINDS.tag, EDGE_WEIGHT.tag)
      }
    }
  })
  return sink.toArray()
}

// ---------------------------------------------------------------------------
// 5) similar 边 —— 算法不重写，只吃注入的关键词
// ---------------------------------------------------------------------------

/** 短 CJK token 的上限：超过这个长度视为「整句散文」，相似度信号弱、开销高。 */
const CJK_SHORT_TOKEN_MAX = 8
/** 长 CJK token 最多贡献的 bigram 数（配合步长，给长句留一点召回）。 */
const CJK_LONG_TOKEN_BIGRAMS = 8

/**
 * 把一个原始 token 展开成关键词数组。
 *  - ASCII / 数字词：整词保留（长度 ≥ 2），小写归一。
 *  - 中日韩短串（≤ 8 字）：整串 + 全部 bigram —— 这是中文笔记召回的主力。
 *  - 中日韩长串（> 8 字）：视为散文句，只按步长采样有限个 bigram。
 *    这一步是性能红线：一篇 2KB 的无标点中文笔记能切出上千 bigram，
 *    500 篇就是几十万次 Map 写入，实测占满整个时间预算（见 tmp/t34-perf.mjs）。
 * @param {string} token 原始 token
 * @param {Array<string>} out 输出数组（会被就地追加）
 * @returns {void}
 */
function pushTokenKeywords (token, out) {
  if (token.length < 2) return
  // 用首字符码点判断「是否 ASCII」而不是每次跑正则 test：
  // 一篇笔记有几百个 token，这一步是提取阶段里唯一与 token 数成正比的判断
  const word = token.toLowerCase()
  if (token.charCodeAt(0) < 128) {
    out.push(word)
    return
  }
  if (!CJK_CHAR.test(word)) {
    // 非 ASCII 但也不是中日韩（如带音标的欧洲字母）：整词保留
    out.push(word)
    return
  }
  if (word.length <= CJK_SHORT_TOKEN_MAX) {
    out.push(word)
    for (let i = 0; i + 2 <= word.length; i++) out.push(word.substring(i, i + 2))
    return
  }
  const stride = word.length > 32 ? 2 : 1
  let pushed = 0
  for (let i = 0; i + 2 <= word.length && pushed < CJK_LONG_TOKEN_BIGRAMS; i += stride) {
    out.push(word.substring(i, i + 2))
    pushed += 1
  }
}

/**
 * 通用分词：按非字母数字切开，交给 pushTokenKeywords 展开。
 * @param {unknown} text 任意文本
 * @param {number} maxScanLength 最多扫描的字符数（长文节流）
 * @returns {string[]} 关键词（含重复，调用方自行统计）
 */
function tokenize (text, maxScanLength) {
  const src = String(text === null || text === undefined ? '' : text)
  if (!src) return []
  const scoped = maxScanLength > 0 ? src.substring(0, maxScanLength) : src
  // split（一次 C++ 侧扫描）比 global exec 循环快得多，这里是主要热点之一
  const pieces = scoped.split(KEYWORD_SEPARATOR)
  const out = []
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i] === '') continue
    pushTokenKeywords(pieces[i], out)
  }
  return out
}

/**
 * 兜底的标题关键词提取器。
 * @param {unknown} title 标题
 * @returns {string[]} 去重后的关键词（最多 12 个）
 */
export function extractTitleKeywordsDefault (title) {
  const raw = tokenize(title, 0)
  if (raw.length === 0) return []
  const out = []
  const seen = new Set()
  for (let i = 0; i < raw.length; i++) {
    if (seen.has(raw[i]) || out.length >= 12) continue
    seen.add(raw[i])
    out.push(raw[i])
  }
  return out
}

/**
 * 兜底的正文关键词提取器：按词频取 TopN，模仿 GraphView 的形状（Top10）。
 * @param {unknown} content 正文
 * @param {Object} [note] 笔记（当前未使用，占位保持签名一致）
 * @param {Object} [options] { maxScanLength, topN }
 * @returns {string[]} 热词列表（按词频降序）
 */
export function extractContentKeywordsDefault (content, note, options) {
  const opts = toOptions(options)
  const maxScanLength = Number.isFinite(opts.maxScanLength) && opts.maxScanLength > 0
    ? opts.maxScanLength
    : DEFAULT_SIMILAR_SCAN_LENGTH
  const topN = Number.isFinite(opts.topN) && opts.topN > 0 ? opts.topN : DEFAULT_TOP_CONTENT_KEYWORDS
  const raw = tokenize(content, maxScanLength)
  if (raw.length === 0) return []

  const counter = new Map()
  for (let i = 0; i < raw.length; i++) {
    counter.set(raw[i], (counter.get(raw[i]) || 0) + 1)
  }
  const ranked = Array.from(counter.entries())
  ranked.sort((a, b) => b[1] - a[1])
  const out = []
  for (let i = 0; i < ranked.length && out.length < topN; i++) {
    if (ranked[i][1] < 2) break // 只出现一次的词不参与相似度
    out.push(ranked[i][0])
  }
  return out
}

/**
 * 构建相似度边：共享足够多关键词（默认 ≥2）的笔记两两连边，weight = 0.5。
 *
 * 相似度语义本身不在本文件里重写 —— 只接受外部注入的关键词提取函数，
 * 默认实现是「取 TopN 关键词 → 倒排 buckets → 桶内两两计数 ≥ minShared」。
 * T35 把 GraphView 现有的 extractTitleKeywords / extractContentKeywords 传进来，
 * 连边口径就与原实现一致；同时借 MAX_BUCKET 挡住过于通用的「万金油」词。
 *
 * @param {Array<Object>|null} notes 笔记列表
 * @param {Object} [options] 选项
 * @param {Function} [options.extractTitleKeywords] (title, note) => string[]
 * @param {Function} [options.extractContentKeywords] (content, note) => string[]
 * @param {number} [options.maxBucket] bucket 成员上限，默认 200
 * @param {number} [options.minShared] 判定相似所需共享关键词数，默认 2
 * @param {number} [options.maxKeywordsPerNote] 单篇参与比较的关键词上限，默认 24
 * @returns {Array<{source: string, target: string, kind: string, weight: number}>} similar 边
 */
export function buildSimilarEdges (notes, options) {
  const list = toNoteList(notes)
  const opts = toOptions(options)
  const sink = createEdgeSink()
  if (list.length < 2) return []

  const titleExtractor = typeof opts.extractTitleKeywords === 'function'
    ? opts.extractTitleKeywords
    : extractTitleKeywordsDefault
  const contentExtractor = typeof opts.extractContentKeywords === 'function'
    ? opts.extractContentKeywords
    : extractContentKeywordsDefault
  const maxBucket = Number.isFinite(opts.maxBucket) && opts.maxBucket > 1 ? opts.maxBucket : DEFAULT_SIMILAR_MAX_BUCKET
  const minShared = Number.isFinite(opts.minShared) && opts.minShared >= 1 ? opts.minShared : DEFAULT_MIN_SHARED_KEYWORDS
  const maxKeywordsPerNote = Number.isFinite(opts.maxKeywordsPerNote) && opts.maxKeywordsPerNote > 0
    ? opts.maxKeywordsPerNote
    : DEFAULT_MAX_KEYWORDS_PER_NOTE

  // 1) 每篇笔记撮一组关键词（去重 + 截断），并登记 id
  const ids = []
  const index = new Map() // keyword → number[]（笔记下标）
  for (let i = 0; i < list.length; i++) {
    const note = list[i]
    const id = noteId(note)
    if (!id) continue
    const keywords = new Set()
    /**
     * 把一个提取器产出的关键词灌入 Set，抛错则忽略该函数。
     * @param {Function} fn 提取器
     * @param {unknown} input 输入文本
     * @returns {void}
     */
    const harvest = (fn, input) => {
      let arr = null
      try {
        arr = fn(input, note)
      } catch (error) {
        arr = null
      }
      if (!Array.isArray(arr)) return
      for (let k = 0; k < arr.length; k++) {
        if (keywords.size >= maxKeywordsPerNote) return
        const word = String(arr[k] === null || arr[k] === undefined ? '' : arr[k]).trim().toLowerCase()
        if (word) keywords.add(word)
      }
    }
    harvest(titleExtractor, note.title)
    harvest(contentExtractor, note.content)

    const slot = ids.length
    ids.push(id)
    keywords.forEach((word) => {
      const bucket = index.get(word)
      if (bucket) bucket.push(slot)
      else index.set(word, [slot])
    })
  }
  if (ids.length < 2) return []

  // 2) 桶内两两计数（跳过太空泛的桶），累计共享关键词数。
  //    pairKey 用 **整数** slot 编码（不是字符串拼接）：这是本文件唯一的热点循环，
  //    500 篇笔记下字符串 key 的拼接 + 哈希会吃掉一半以上的预算。
  const total = ids.length
  const shared = new Map() // pairKey(ia * total + ib) → 共享关键词数
  index.forEach((bucket) => {
    const size = bucket.length
    if (size < 2 || size > maxBucket) return
    for (let x = 0; x < size - 1; x++) {
      const ia = bucket[x]
      for (let y = x + 1; y < size; y++) {
        const ib = bucket[y]
        const key = ia < ib ? ia * total + ib : ib * total + ia
        const count = shared.get(key)
        if (count === undefined) shared.set(key, 1)
        else shared.set(key, count + 1)
      }
    }
  })

  // 3) 达到阈值的成对——落成 similar 边
  shared.forEach((count, key) => {
    if (count < minShared) return
    const ia = Math.floor(key / total)
    const ib = key - ia * total
    sink.add(ids[ia], ids[ib], EDGE_KINDS.similar, EDGE_WEIGHT.similar)
  })
  return sink.toArray()
}

// ---------------------------------------------------------------------------
// 6) 统一入口
// ---------------------------------------------------------------------------

/**
 * 一次算出关系图的全部边。
 *
 * linkMode：
 *   - 'all'（默认）：wiki + tag + similar 三类边，按此顺序返回（插入序稳定）。
 *   - 'wiki-only'：只要 wiki 边，用于「只看双链」模式 —— 这是用户
 *     「关系图里看不到自己的双链」最直观的解法。
 *   未知取值一律按 'all' 处理，绝不因为 UI 传错字符串就整张图变空。
 *
 * @param {Object} options 选项
 * @param {Array<Object>} options.notes 笔记列表
 * @param {Function} [options.resolveTarget] wiki 解析器
 * @param {Function} [options.idOfTitle] 简化的标题→id 解析器
 * @param {Function} [options.extractTags] tag 提取器
 * @param {Function} [options.extractTitleKeywords] 标题关键词提取器
 * @param {Function} [options.extractContentKeywords] 正文关键词提取器
 * @param {string} [options.linkMode] 'all' | 'wiki-only'
 * @returns {Array<{source: string, target: string, kind: string, weight: number}>} 边列表
 */
export function buildLinkEdges (options) {
  const opts = toOptions(options)
  const notes = opts.notes
  const wiki = buildWikiEdges(notes, opts)
  if (opts.linkMode === LINK_MODES.WIKI_ONLY) return wiki
  const tags = buildTagEdges(notes, opts.extractTags, opts)
  const similar = buildSimilarEdges(notes, opts)
  const out = []
  for (let i = 0; i < wiki.length; i++) out.push(wiki[i])
  for (let i = 0; i < tags.length; i++) out.push(tags[i])
  for (let i = 0; i < similar.length; i++) out.push(similar[i])
  return out
}
