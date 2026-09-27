// ============================================================================
// noteIdentity.js —— 笔记稳定标识（id ↔ path 映射表 + 路径哈希兜底）
//
// 背景：现在笔记的 id 是「文件路径的 djb2 哈希」（`src/stores/note.js:24` 的
// generateStableId，`note.js:1052` 处 `generateStableId(file.path)` 用它造 id）。
// 路径一变 id 就跟着变，会同时打断三件事：
//   · 双链：指向旧 id 的链接解析不到目标；
//   · 图谱布局持久化：节点坐标按 id 存，id 一变，坐标全部落空；
//   · 当前笔记：`EditorView.vue:769-773` 与 `note.js:521-522` 在 currentNote 变
//     null 时会「强制跳到 notes[0]」，用户正在编辑的那一篇被生生拽走。
// 也就是说「外部重命名 / 移动」这个场景的性能与体验，硬依赖这里的 id 稳定性。
//
// 用户已拍板的方案（**绝不写用户的 .md 文件**）：
//   ① 应用数据目录里维护一张 `id ↔ path` 映射表（userData/note-id-map.json，
//      落盘由 T16 用本模块导出的结构完成，本模块自己不碰磁盘）；
//   ② 路径哈希降级为**迁移期兜底**：映射表里查不到时才退化成老算法算出来的 id，
//      这样老用户库里已有的书签 / 双链 / 历史记录照样能解析；
//   ③ 映射表丢了也不怕：`rebuildIdMap(paths)` 能按「老算法」从磁盘路径全量重建，
//      重建出来的 id 与丢失前逐字相同 —— 重建不是「重新发明 id」，而是把兜底
//      哈希固化成显式映射。这是「绝不写 .md」能成立的前提：真相存在应用侧，
//      任何时刻都能从用户磁盘上现存的 .md 路径重新推出来。
//
// 为什么绝不把 id 写进 .md：
//   笔记是用户自己的资产，会被 Obsidian / git / 别的编辑器读写。往里塞应用私有
//   字段等于把应用实现细节泄漏进用户数据，同步时还会制造无意义 diff。因此本模块
//   **不提供任何读写笔记内容的接口**，连「笔记内容」这个概念都不出现 —— 它只是
//   一张纯「路径 → id」的字典。
//
// 已知限制（设计文档 §7.2 B-3，本轮刻意不处理）：
//   `pathHashId` 是 32 位 djb2，取值空间约 4.3e9，按生日估算约 7.7 万篇时碰撞
//   概率就到 50%。双轨方案下映射表是主键源、哈希只在「映射缺失」的极短窗口内
//   兜底，风险已被大幅稀释；且 `rebuildIdMap` 固化时会显式消歧（追加 `-2` / `-3`
//   后缀），**映射表内部不会留下碰撞**。本轮不换算法 —— 一换，老 id 就解析不出来
//   了，那才是真的事故。
//
// 迁移期兜底的生命周期（什么时候才允许摘掉）：
//   兜底存在的唯一目的，是让「迁移前以哈希 id 存过东西」的老数据继续可用。只要
//   还有 ①书签 / 历史记录 ②正文里的双链 ③图谱布局缓存 以老 id 为键，兜底就不能
//   摘。它的终点是「全量迁移完成（每个路径都进了映射表）+ 上述老键自然淘汰」，
//   而不是某个版本号。摘之前必须保证映射表覆盖率 100%，否则就是静默断链。
//
// 纯内核约定（验收标准 ④）：
//   零 import、不读时钟、不碰磁盘、不碰笔记内容、不持有任何模块级可变状态 ——
//   同样的入参永远得到同样的返回值。`updatedAt` 因此由落盘方（T16）在写盘时写入，
//   本模块永远让它保持 0，否则「重建两次得到同一张表」就没法断言了。
//
// 不变量（由 tests/noteIdentity.test.js 逐条断言）：
//   1. pathHashId 与 note.js:24 的 generateStableId 逐字一致（老 id 可解析）；
//   2. 移动 / 重命名后 resolveId 返回的 id 不变（rebindPath 搬家，id 跟着走）；
//   3. rebuildIdMap 可从磁盘路径全量重建，且与丢失前的 id 一致；
//   4. 零 import、不读时钟、不碰磁盘、不碰笔记内容。
// ============================================================================

/**
 * 映射表结构版本号。
 * T16 落盘时把它写进 JSON；将来结构变了（比如要存 `createdAt`），据此决定要不要
 * 走迁移分支，而不是靠「字段在不在」猜。
 */
export const ID_MAP_VERSION = 1

/**
 * 碰撞消歧后缀的分隔符。
 * 用 '-' 是因为它**不在 base36 字符集（0-9a-z）里**，所以真实哈希永远长不出这个
 * 形状，`abc-2` 不可能被误认成某条路径的哈希 —— 消歧后缀与真实 id 不会互相撞形。
 */
const COLLISION_SEPARATOR = '-'

/** 碰撞消歧的序号上限：病态输入（同一哈希上挂了几千条路径）时不死循环 */
const MAX_COLLISION_TRIES = 10000

// ---------------------------------------------------------------------------
// 内部工具（一律不导出：本模块的对外契约只有下面那几个函数）
// ---------------------------------------------------------------------------

/**
 * 任意入参安全转路径字符串。
 * 老算法 `generateStableId(str)` 里是直接 `str.length`，传 null 会抛。这里放宽成
 * 空串：id 解析处在启动路径上，抛异常会让整库打不开，不值得。
 *
 * @param {unknown} value 期望是字符串
 * @returns {string} 字符串；null / undefined → ''
 */
function asPath (value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 自有属性判定。
 * 映射表是普通 `{}`（要过 JSON.stringify / JSON.parse），所以 `byPath['toString']`
 * 这类原型链上的键必须挡掉 —— 否则一条叫 'toString' 的路径会「命中」一个函数。
 *
 * @param {object} obj 目标对象
 * @param {string} key 键
 * @returns {boolean} 是自有属性返回 true
 */
function hasOwn (obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * 判断入参是不是一张可用的映射表（至少两个方向都得是对象）。
 * 用「鸭子类型」而不是 instanceof：落盘方 JSON.parse 回来的是纯对象，
 * 没有任何构造函数的痕迹。
 *
 * @param {unknown} map 待判定对象
 * @returns {boolean} 可安全读写返回 true
 */
function isIdMap (map) {
  if (!map || typeof map !== 'object') return false
  return Boolean(map.byPath) && typeof map.byPath === 'object' &&
    Boolean(map.byId) && typeof map.byId === 'object'
}

/**
 * 取「自有属性」里的值，取不到给 ''。
 * @param {object} obj 目标对象
 * @param {string} key 键
 * @returns {string} 自有字符串属性值，否则 ''
 */
function ownString (obj, key) {
  if (!hasOwn(obj, key)) return ''
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

/**
 * 把入参规范成路径数组。
 *
 * 字符串是**可迭代对象**，直接 `new Set('a/b.md')` 会得到逐字符的集合 —— 这是
 * 路径集合最危险的误用，所以这里显式把字符串当成「单条路径」包起来。
 *
 * @param {Iterable<string>|string|null|undefined} paths 路径集合
 * @returns {Array<string>} 路径数组；无法迭代时返回 []
 */
function toPathList (paths) {
  if (paths === null || paths === undefined) return []
  if (typeof paths === 'string') return [paths]
  if (typeof paths[Symbol.iterator] !== 'function') return []
  const out = []
  for (const p of paths) {
    const s = asPath(p)
    if (s) out.push(s)
  }
  return out
}

/**
 * 去重 + 字典序稳定排序。
 *
 * 排序不是为了好看：`rebuildIdMap` / `compactIdMap` 的结果会被 T16 直接落盘，
 * 而磁盘扫描（Electron 的 readdir）**不保证每次返回同一顺序**。只有排序后，
 * 「同一份磁盘状态」才必然得到「同一张表」，否则每次重建都会撞上哈希碰撞的
 * 不同分支，同一条路径今天拿 base、明天拿 base-2。
 *
 * 比较器用码元比较（`<` / `>`）而不是 localeCompare：后者受运行时 locale 影响，
 * 跨机器会给出不同顺序，那等于没排。
 *
 * @param {Array<string>} list 路径数组
 * @returns {Array<string>} 去重并排序后的新数组
 */
function sortedUnique (list) {
  return Array.from(new Set(list)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 路径 → id 的兜底哈希（**迁移期专用**）。
 *
 * 与 `src/stores/note.js:24` 的 `generateStableId` 逐字同构：`hash = ((hash << 5)
 * - hash) + char`，每轮用 `hash & hash` 截断回 int32，最后 `Math.abs(hash)
 * .toString(36)`。**一个字符都不能改** —— 现有库里已经有一批用它生成的 id 躺在
 * 书签、双链和图谱布局缓存里，算法一变就是静默断链。
 *
 * ⚠️ 一处必须记下的口径差异：`(hash << 5) - hash` 等于 `hash * 31` 而**不是**
 * 标准 djb2 的 `hash * 33`。设计文档 §7.2 B-3 沿用了「32 位 djb2」这个俗称，
 * 但代码事实是 *31。这里以**代码**为准 —— 我们的目标是复刻老 id，不是复刻名字。
 * （*31 的取值空间与碰撞量级和 *33 同阶，B-3 的结论不受影响。）
 *
 * 两个刻意保留的细节：
 *   · 用 `charCodeAt` 而不是 `codePointAt`：老实现按 UTF-16 码元遍历，emoji 会
 *     被拆成两个代理项各自参与运算。改成码点会让所有含 emoji 路径的 id 漂移。
 *   · 不在这里做任何路径归一（不把 '\' 换成 '/'、不解析 '..'）：归一会让
 *     `C:\a\b.md` 与 `C:/a/b.md` 算出同一个 id，看似更稳，实则与老库里按原始
 *     路径算出的 id 对不上。归一的责任在调用方，且必须是「全库统一来源」。
 *
 * @param {string} path 笔记路径（原样，与 note.js 传给 generateStableId 的一致）
 * @returns {string} base36 形式的 id
 */
export function pathHashId (path) {
  const str = asPath(path)
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

/**
 * 造一张空映射表。
 *
 * `updatedAt` 恒为 0：本模块不读时钟（见文件头「纯内核约定」），时间戳由落盘方
 * 在写盘那一刻赋值。把时钟留在模块外面，重建才能是可复现的、可断言的。
 *
 * @returns {{ version: number, byPath: object, byId: object, updatedAt: number }}
 */
export function createIdMap () {
  return {
    version: ID_MAP_VERSION,
    byPath: {},
    byId: {},
    updatedAt: 0
  }
}

/**
 * 路径 → id。这是全库唯一的 id 解析入口（T19 的 `note.js:1052` 就换它）。
 *
 * 查到就返回映射表里的 id，查不到就退化成 `pathHashId(path)`。
 * 兜底分支是**向后兼容的硬要求**：老库里那些以哈希 id 存下的书签 / 双链 / 布局
 * 坐标，在映射表还没覆盖到这条路径时，必须还能解析出同一个 id。
 *
 * 刻意**不**在未命中时偷偷写回映射表：一是保持纯读语义（并发读不会互相污染），
 * 二是「什么时候固化」属于落盘方的策略，不该由一次查询决定。
 *
 * @param {object|null} map 映射表；传 null / 结构损坏也能安全退化
 * @param {string} path 笔记路径
 * @returns {string} id
 */
export function resolveId (map, path) {
  const p = asPath(path)
  if (isIdMap(map)) {
    const hit = ownString(map.byPath, p)
    if (hit) return hit
  }
  return pathHashId(p)
}

/**
 * 建立 / 覆盖一条绑定（双向：byPath[path] = id 且 byId[id] = path）。
 *
 * 约束是**严格一对一**：一条路径只挂一个 id，一个 id 只指向一条路径。所以绑定前
 * 会先把两边的旧关系摘掉 —— 否则「A 搬到 B 的位置」会在表里留下 `A → x` 这种
 * 悬空项，`compactIdMap` 之后再也没人清理得掉。
 *
 * 被挤掉的那个 id 不会丢数据：映射表里没它之后，`resolveId` 会退回 `pathHashId`，
 * 而兜底哈希与它原本的 id 本来就是同一个值（碰撞场景就是这样产生的）。
 *
 * 为方便链式书写，返回传入的同一个 map；按设计签名当 void 用也完全没问题。
 *
 * @param {object} map 映射表（原地修改）
 * @param {string} id 要绑定的 id
 * @param {string} path 要绑定的路径
 * @returns {object} 同一个 map
 */
export function bindPath (map, id, path) {
  if (!isIdMap(map)) return map

  const p = asPath(path)
  const newId = typeof id === 'string' ? id : ''
  if (!p || !newId) return map

  // 摘掉「这条路径原来挂的 id」的反向项
  const oldIdOnPath = ownString(map.byPath, p)
  if (oldIdOnPath && oldIdOnPath !== newId && hasOwn(map.byId, oldIdOnPath)) {
    delete map.byId[oldIdOnPath]
  }
  // 摘掉「这个 id 原来指向的路径」的正向项（那个路径之后靠兜底哈希解析）
  const oldPathOnId = ownString(map.byId, newId)
  if (oldPathOnId && oldPathOnId !== p && hasOwn(map.byPath, oldPathOnId)) {
    delete map.byPath[oldPathOnId]
  }

  map.byPath[p] = newId
  map.byId[newId] = p
  return map
}

/**
 * 路径搬家 / 改名：**id 跟着走**。这是 R-F1 的主场景。
 *
 * 旧路径没进过映射表时（典型的迁移期状态），id 取 `resolveId(map, oldPath)`，
 * 也就是**旧路径的兜底哈希**，然后永久绑到新路径上。这一步是整个方案的关键：
 * 哈希 id 本来会随路径漂移，但只要第一次移动时把它固化进映射表，之后无论再搬
 * 多少次都不变 —— 老书签、老双链因此全部保活。
 *
 * 目标位置上原本绑定过别的 id 时，以「搬过来的这个」为准（把原 id 摘掉），
 * 保证一对一。
 *
 * @param {object} map 映射表（原地修改）
 * @param {string} oldPath 移动/重命名前的路径
 * @param {string} newPath 移动/重命名后的路径
 * @returns {object} 同一个 map
 */
export function rebindPath (map, oldPath, newPath) {
  if (!isIdMap(map)) return map

  const from = asPath(oldPath)
  const to = asPath(newPath)
  if (!from || !to || from === to) return map

  // 先按「旧路径」解析 id：命中映射表就用表里的，没命中就用旧路径的兜底哈希。
  // 两者都保证了「移动前这条笔记对外叫什么 id，移动后还叫什么 id」。
  const id = resolveId(map, from)

  // 目标位置上原有的绑定让位给搬过来的这条
  const displacedId = ownString(map.byPath, to)
  if (displacedId && displacedId !== id && hasOwn(map.byId, displacedId)) {
    delete map.byId[displacedId]
  }
  // 旧路径那条正向项直接删掉（不是留着指向 id，那是悬空）
  if (hasOwn(map.byPath, from)) delete map.byPath[from]
  // id 原来指向的若是别的路径（"to" 以外的），反向解开
  const oldPathOnId = ownString(map.byId, id)
  if (oldPathOnId && oldPathOnId !== from && oldPathOnId !== to && hasOwn(map.byPath, oldPathOnId)) {
    delete map.byPath[oldPathOnId]
  }

  map.byPath[to] = id
  map.byId[id] = to
  return map
}

/**
 * 解绑一条路径（笔记被删除 / 移出库时调用）。
 *
 * 只删映射，不动磁盘 —— 文件该不该删由 store 决定，本模块不碰 fs。
 *
 * @param {object} map 映射表（原地修改）
 * @param {string} path 要解绑的路径
 * @returns {object} 同一个 map
 */
export function unbindPath (map, path) {
  if (!isIdMap(map)) return map

  const p = asPath(path)
  if (!p || !hasOwn(map.byPath, p)) return map

  const id = ownString(map.byPath, p)
  if (id && hasOwn(map.byId, id)) delete map.byId[id]
  delete map.byPath[p]
  return map
}

/**
 * 按「当前磁盘上真实存在的路径」裁剪映射表，返回一张**新表**。
 *
 * 纯函数：不改入参。删库里没了的路径，保留仍在的（含其 id）。顺序同样做了稳定
 * 排序，所以「同一份 live 集合」裁剪出来的表是字节级可复现的。
 *
 * 为什么要排空（而不是留着）：映射表无上限增长会让 `note-id-map.json` 越写越大，
 * 而一条失效路径留着只有一个作用 —— 让「曾经存在过的路径」复活时能接回老 id。
 * 但那正是 `rebindPath` 的兜底分支做的事（旧路径不在表里也能用哈希接回），所以
 * 裁掉不丢语义。
 *
 * @param {object|null} map 原映射表
 * @param {Iterable<string>} livePaths 仍然存在的路径集合
 * @returns {object} 新的映射表
 */
export function compactIdMap (map, livePaths) {
  const out = createIdMap()

  if (!isIdMap(map)) return out
  out.updatedAt = Number.isFinite(map.updatedAt) ? map.updatedAt : 0

  const live = new Set(toPathList(livePaths))
  for (const p of sortedUnique(Object.keys(map.byPath))) {
    if (!live.has(p)) continue
    const id = ownString(map.byPath, p)
    if (!id) continue
    bindPath(out, id, p)
  }
  return out
}

/**
 * 从磁盘路径全量重建映射表（映射表丢失 / 首次迁移时用）。
 *
 * id 不是重新发明的：每个路径的 id 就是它的 `pathHashId`，因此重建结果与「迁移
 * 前那张表」逐字一致 —— 老书签、老双链、老布局坐标全部继续可用。这正是
 * 「绝不写用户 .md」能成立的前提：真相永远能从用户磁盘上现存的 .md 推回来。
 *
 * 碰撞处理（B-3 的兜底）：两个不同路径算出同一个哈希时，后到者追加 `-2`、`-3`…
 * 后缀。因为先排序，谁拿 base、谁拿 `-2` 是确定的（字典序靠前的拿 base），
 * 不会随扫描顺序漂移。注意这会让「重建后该路径的 id」与它裸哈希不同 —— 只有
 * 真撞上了才会，且此时裸哈希本来就指不清两条路径中的哪一条，消歧是唯一正解。
 *
 * 纯函数：不读时钟、不改入参、不依赖模块级状态。
 *
 * @param {Iterable<string>|string|null} paths 磁盘上现存的全部笔记路径
 * @returns {object} 新的映射表
 */
export function rebuildIdMap (paths) {
  const out = createIdMap()
  const list = sortedUnique(toPathList(paths))

  for (const p of list) {
    const base = pathHashId(p)
    let id = base
    let n = 1
    // 同一个哈希上挂了第二条路径才需要消歧；'-' 不在 base36 里，不会与真实哈希撞形
    while (hasOwn(out.byId, id)) {
      n += 1
      if (n > MAX_COLLISION_TRIES) break
      id = `${base}${COLLISION_SEPARATOR}${n}`
    }
    out.byPath[p] = id
    out.byId[id] = p
  }
  return out
}

/**
 * 从落盘数据（JSON 字符串或已 parse 的对象）恢复映射表。
 *
 * 给 T16 用的额外接口（设计签名里没有，但落盘方必然需要一个「读回来还得能用」
 * 的入口，否则每个人都会各写一份容错逻辑）。
 *
 * 两条容错原则：
 *   · **byPath 是唯一真相源**，byId 一律由它反推。反过来不行 —— byId 丢了就只剩
 *     id，找不回路径；而 byPath 丢了 byId 重算一遍即可。半途断电 / 手写编辑造成
 *     两个方向不一致时，这个方向的选择决定了能不能自愈。
 *   · 版本比 `ID_MAP_VERSION` 更新的数据**不猜**：返回空表。将来的结构变化必须
 *     在这里补一条显式迁移，猜错比丢掉更危险（猜错会得到一张「看起来能用的」
 *     错表）。
 *
 * @param {string|object|null} raw 磁盘读回来的内容（JSON 字符串或对象）
 * @returns {object} 可用的映射表；解析失败时返回空表（绝不抛）
 */
export function parseIdMap (raw) {
  const empty = createIdMap()

  let data = raw
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (e) {
      return empty
    }
  }
  if (!data || typeof data !== 'object') return empty

  const version = Number.isFinite(data.version) ? data.version : ID_MAP_VERSION
  if (version > ID_MAP_VERSION) return empty
  if (!data.byPath || typeof data.byPath !== 'object') return empty

  const out = createIdMap()
  out.updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : 0
  for (const p of sortedUnique(Object.keys(data.byPath))) {
    const id = ownString(data.byPath, p)
    if (!id) continue
    bindPath(out, id, p)
  }
  return out
}
