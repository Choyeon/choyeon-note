// ============================================================================
// fileNaming.js —— 文件名合法化 / 同名消解 / 展示路径统一
//
// 背景：落盘取名这件事目前散在 store 里，只有一行正则是防线
// （`note.js:335` 的 `safeFileName`：`title.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext`）。
// 它挡不住四类在 Windows 上会「写不出来 / 写到系统设备上」的输入：
//   · 保留设备名：`CON` `NUL.md` `AUX` `LPT1` —— 在 Win32 里这些名字不指向普通
//     文件，而指向控制台 / 空设备 / 打印机，写它们等于往设备句柄里灌字节；
//   · 结尾空格与点：`note .md` / `note.md ` 在 Win32 会被静默裁掉尾部，于是
//     内存里的 filePath 与磁盘实际文件名不一致，后续所有按路径的读写全部落空；
//   · 控制字符：`\u0000-\u001F` 能进 NTFS，但会让 IPC / 日志 / shell 全线出错；
//   · 超长名：ext4 / APFS / NTFS 的上限都是「一个文件名」尺度上的限制，
//     按 JS 的 UTF-16 长度去截会把多字节汉字切一半，磁盘上留下乱码文件名。
//
// 方案：全部收进一个零 import 的纯函数模块。零 import 是硬要求 —— 这个模块要同时
// 被渲染进程（store / 视图）、主进程（electron/main.cjs）和单测复用，任何
// `import node:path` 之类的依赖都会让它没法在主进程侧直接 require。
//
// 不变量（由 tests/fileNaming.test.js 逐条断言）：
//   1. 返回值永远是「一个文件名」，不含目录分隔符；
//   2. 返回值的 UTF-8 字节数 ≤ maxBytes（扩展名也算在内）；
//   3. 返回值对 Windows 而言一定合法，且 isReservedDeviceName(返回值) === false；
//   4. 同样的入参永远得到同样的返回值（不读时钟、不读磁盘、不改入参）。
// ============================================================================

/**
 * 单个文件名的 UTF-8 字节上限。
 * ext4 / APFS 是 255 字节，NTFS 是 255 个 UTF-16 码元；取 255 字节能同时满足
 * 三者（字节上限比码元上限更严格，所以按字节算是安全的那一侧）。
 */
export const MAX_NAME_BYTES = 255

/** 合法化后变成空串时的兜底名（设计文档步骤 ⑥ 指定的字面量，勿改） */
export const FALLBACK_NAME = '无标题'

/** 同名消解的序号上限：防止病态输入（同目录上万个同名）把循环拖成死循环 */
const MAX_DEDUPE_TRIES = 1000

/**
 * 控制字符 \u0000-\u001F。
 * 注意：这里写的是 6 个字符的转义文本，源码里绝不能出现裸 NUL 字节
 * （历史事故：文件被 git 当成二进制）。
 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F]/g

/**
 * Windows 非法字符（含两个路径分隔符 `/` 与 `\`）。
 * 用 '_' 替换而不是删除：一是与改造前 `safeFileName` 的行为保持一致（用户可见
 * 的取名结果不跳变），二是 `a/b` 变成 `ab` 会把两个本来有分隔语义的词粘死，
 * 日志排查时很难认出来。
 */
const ILLEGAL_CHAR_PATTERN = /[\\/:*?"<>|]/g

/**
 * Windows 保留设备名（最后不带扩展名后缀的那一段）。
 * 只列设计文档点名的这批：CON / PRN / AUX / NUL / COM1-9 / LPT1-9。
 * 刻意不含 COM0 / LPT0 / CONIN$ / CONOUT$ —— 它们在 Win32 里是合法文件名，
 * 多列只会误伤用户。
 */
const RESERVED_DEVICE_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/

/** Windows 文件名结尾不允许的空格与点 */
const TRAILING_PATTERN = /[. ]+$/

/** 取「扩展名前那一段」时用的切分点：第一个点之后全部丢掉 */
const FIRST_DOT = /\..*$/

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 单个字符的 UTF-8 字节数（1~4）。
 * 按码点算而不是按 UTF-16 码元算，是「不把汉字切一半」的前提：一个 emoji 在
 * JS 里是两个码元，按码元截断会得到孤立代理项，落盘就是非法 UTF-8。
 * @param {number} codePoint 码点
 * @returns {number} 1 | 2 | 3 | 4
 */
function utf8SizeOfCodePoint (codePoint) {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * 字符串的 UTF-8 字节长度。
 * 不用 Buffer / TextEncoder：这个模块要能在没有 Node 全局的环境里跑。
 * @param {string} s 输入
 * @returns {number} 字节数
 */
function utf8ByteLength (s) {
  let bytes = 0
  for (const ch of s) {
    bytes += utf8SizeOfCodePoint(ch.codePointAt(0))
  }
  return bytes
}

/** 任意输入安全转字符串，null / undefined 一律当空串 */
function asString (value) {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 把 `taken`（已存在文件名集合）规范成一个 Set。
 * 接受 Set / 数组 / 任何可迭代对象，是为了让调用方（store 里通常拿着数组，
 * 主进程可能拿着 Set）不必先自己转换。
 * @param {Set<string>|Array<string>|Iterable<string>|null|undefined} taken
 * @returns {Set<string>|null} 传空时返回 null，表示「不做消解」
 */
function toTakenSet (taken) {
  if (!taken) return null
  if (typeof taken.has === 'function' && typeof taken.size === 'number') return taken
  if (typeof taken[Symbol.iterator] === 'function') return new Set(taken)
  return null
}

/** 剥掉结尾的空格与点（Windows 会静默裁掉它们，导致内存路径 ≠ 磁盘路径） */
function stripTrailing (s) {
  return s.replace(TRAILING_PATTERN, '')
}

/**
 * 把词干压进给定字节预算：截断 → 再剥尾巴 → 空则回退兜底名 → 保留名加前缀。
 *
 * 单独抽成函数是因为「截断」在本模块里要跑两次：同名消解的序号（' 1'）是在
 * 截断**之后**才追加的，不重新截一次的话，`84 个汉字.md`（255 字节）消解成
 * `84 个汉字 1.md` 就是 257 字节 —— 超了文件系统上限，写盘照样失败。
 * 每次截断后都要再剥一次尾巴，因为第 N 字节可能正好落在空格或点上。
 *
 * @param {string} stem 已合法化的词干
 * @param {number} budget 词干的字节预算（不含扩展名）
 * @returns {string} 装得进预算的词干
 */
function fitStem (stem, budget) {
  let s = stripTrailing(truncateBytes(stem, budget))
  if (!s) s = stripTrailing(truncateBytes(FALLBACK_NAME, budget))
  // 截断有可能把 'LPT1abc' 截成 'LPT1' 这种保留名，所以判定时机必须在截断之后
  if (isReservedDeviceName(s)) s = stripTrailing(truncateBytes(`_${s}`, budget))
  // 极端：预算连一个字符都装不下（maxBytes 比扩展名还短）→ 宁可超一点也要有名字
  if (!s) return FALLBACK_NAME
  return s
}

/** 合法化「扩展名之前的那一段」：① 控制字符 ② 非法字符 ③ 结尾空格与点 */
function sanitizeStem (title) {
  let s = asString(title)
  s = s.replace(CONTROL_CHAR_PATTERN, '')
  s = s.replace(ILLEGAL_CHAR_PATTERN, '_')
  return stripTrailing(s)
}

/**
 * 规范扩展名：去控制字符与非法字符、去前导点、去结尾空格与点。
 * 调用方可能传 'md' 也可能传 '.md'（node 的 path.extname 带点，而 note.js 的
 * `extensionOf` 不带点），这里两种都吃掉，避免拼出 'a..md'。
 * @param {string} ext 扩展名（带不带点都行）
 * @returns {string} 不带点的扩展名，空串表示无扩展名
 */
function normalizeExt (ext) {
  let s = asString(ext)
  s = s.replace(CONTROL_CHAR_PATTERN, '')
  s = s.replace(ILLEGAL_CHAR_PATTERN, '')
  s = s.replace(/^\.+/, '')
  return stripTrailing(s)
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 判断一个文件名（或扩展名之前的那一段）是否命中 Windows 保留设备名。
 *
 * 为什么只看第一个点之前的部分：Win32 判定设备名时忽略第一个点之后的所有内容，
 * 所以 `NUL.md`、`CON.foo.md`、`nul.txt.bak` 全部指向设备；而 `CONSOLE`、
 * `CON1`、`LPT10` 是普通文件，不能误伤。
 *
 * @param {string} name 文件名或词干，如 'NUL' / 'NUL.md' / 'con '
 * @returns {boolean} 命中保留名返回 true
 */
export function isReservedDeviceName (name) {
  const stem = stripTrailing(asString(name).replace(FIRST_DOT, '')).trim().toUpperCase()
  return RESERVED_DEVICE_PATTERN.test(stem)
}

/**
 * 按 UTF-8 字节安全截断，绝不把一个多字节字符切一半。
 *
 * 逐码点累加字节数，超过上限就停：这样既不会切出半个汉字（3 字节）也不会切出
 * 孤立代理项（emoji 是 4 字节、2 个 UTF-16 码元）。返回值的字节数一定 ≤ max。
 *
 * @param {string} name 待截断的字符串
 * @param {number} [max=MAX_NAME_BYTES] 字节上限
 * @returns {string} 截断后的字符串；max ≤ 0 或首字符就超限时返回 ''
 */
export function truncateBytes (name, max = MAX_NAME_BYTES) {
  const limit = Number.isFinite(max) ? Math.floor(max) : MAX_NAME_BYTES
  if (limit <= 0) return ''
  let out = ''
  let bytes = 0
  for (const ch of asString(name)) {
    const size = utf8SizeOfCodePoint(ch.codePointAt(0))
    if (bytes + size > limit) break
    out += ch
    bytes += size
  }
  return out
}

/**
 * 取路径的扩展名（含前导点），语义与 node 的 `path.extname` 对齐。
 * 点文件（`.gitignore`）不算有扩展名 —— 否则消解时会把 `.gitignore` 拆成
 * 词干 '' + 扩展名 '.gitignore'，产出 ' 1.gitignore' 这种怪名字。
 *
 * @param {string} p 路径或文件名
 * @returns {string} 如 '.md'；无扩展名返回 ''
 */
export function extOf (p) {
  const s = asString(p)
  const base = s.replace(/\\/g, '/').split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot)
}

/**
 * 同名消解：把 `name` 改成同目录里没被占用的名字，序号加在扩展名之前。
 *
 * 序号用「空格 + 数字」而不是括号或下划线，是为了与 Obsidian 的手感一致
 * （`a.md` → `a 1.md` → `a 2.md`），也让「这是自动加的」在 UI 上一眼可辨。
 * 纯函数：不读磁盘、不读时钟，`taken` 由调用方传入。
 *
 * @param {string} name 期望的文件名（含扩展名）
 * @param {Set<string>|Array<string>|null} [taken=null] 同目录已存在的文件名集合
 * @returns {string} 不冲突的文件名
 */
export function dedupeFileName (name, taken = null) {
  const full = asString(name)
  const used = toTakenSet(taken)
  if (!used || !used.has(full)) return full

  const ext = extOf(full)
  const stem = ext ? full.slice(0, full.length - ext.length) : full
  for (let n = 1; n <= MAX_DEDUPE_TRIES; n += 1) {
    const candidate = `${stem} ${n}${ext}`
    if (!used.has(candidate)) return candidate
  }
  // 病态兜底：同目录真的有 1000 个以上同名时，返回一个确定值而不是死循环。
  // 这里不再保证不冲突（做不到），但保证函数一定有返回、且可复现。
  return `${stem} ${MAX_DEDUPE_TRIES}${ext}`
}

/**
 * 文件名合法化：标题 → 可直接落盘的完整文件名（含扩展名）。
 *
 * 顺序严格按设计文档：
 *   ① 去控制字符 \u0000-\u001F  ② 去 <>:"/\|?*（替换成 '_'）
 *   ③ 去结尾空格与点            ④ 保留设备名 → 前缀 '_'
 *   ⑤ 按 UTF-8 字节截断（不切断多字节字符）
 *   ⑥ 空串回退 '无标题'
 * 最后再走一遍同名消解（taken 非空时）。
 *
 * 关于 ⑤ 的字节预算：`maxBytes` 是**整个文件名（含扩展名、含消解序号）**的上限，
 * 所以先给扩展名和点留出字节，剩下的才是词干的预算。否则 `词干(255字节) + '.md'`
 * 会超出文件系统上限，写盘照样失败 —— 那才是用户真正会撞到的错。
 * 因此 ④⑤⑥ 的顺序在实现上是「先定词干、再扣预算」，而不是死板地线性执行；
 * 截断后还要再剥一次结尾空格与点（第 255 字节可能正好落在一个空格上）。
 * 同名消解跑在最后，它追加的 ' 1' 会把长度顶出预算，所以命中消解时会按新的
 * 预算把词干再截一次（见 fitStem）。
 *
 * 已知无解边界：当 `maxBytes` 小到连「扩展名 + 兜底名」都装不下时（例如
 * maxBytes=2、ext='md'），本函数优先保证「名字非空且合法」，会返回一个略超
 * maxBytes 的结果。默认值 255 下不会发生。
 *
 * @param {string} title 笔记标题（用户输入，可含任意字符）
 * @param {string} [ext=''] 扩展名，'md' 与 '.md' 都接受
 * @param {{ taken?: Set<string>|Array<string>, maxBytes?: number }} [options]
 * @returns {string} 合法且不冲突的文件名，形如 '笔记.md'
 */
export function sanitizeFileName (title, ext = '', options = {}) {
  const { taken = null, maxBytes = MAX_NAME_BYTES } = options || {}

  const extText = normalizeExt(ext)
  const suffix = extText ? `.${extText}` : ''
  // 词干预算 = 总预算 - 扩展名（含点）占用的字节
  const budget = maxBytes - utf8ByteLength(suffix)

  const stem = fitStem(sanitizeStem(title) || FALLBACK_NAME, budget)
  const fileName = dedupeFileName(`${stem}${suffix}`, taken)

  // 消解序号是截断之后才追加的，可能把总长度顶出预算 → 按新预算把词干再截一次。
  // 序号本身保留不动，所以「第几号」这个语义不会被截掉。
  const overflow = utf8ByteLength(fileName) - maxBytes
  if (overflow <= 0) return fileName

  const dedupeSuffix = fileName.slice(stem.length, fileName.length - suffix.length)
  const tight = fitStem(stem, budget - utf8ByteLength(dedupeSuffix))
  return `${tight}${dedupeSuffix}${suffix}`
}

/**
 * 统一展示路径（R-F9）：把所有分隔符归一成 '/'，让 Windows / macOS / Linux
 * 上「用户看到的路径」与「日志里的路径」是同一种形态。
 *
 * 只做展示层的三件事：反斜杠转正斜杠、折叠重复斜杠、去掉结尾斜杠。
 * 刻意**不**解析 '.' / '..'、不改盘符大小写、不触碰 UNC 以外的语义 ——
 * 一旦解析相对段，日志里看到的就不再是真实磁盘路径，排查时反而会被误导。
 *
 * @param {string} p 任意形态的路径
 * @returns {string} 归一后的路径；空输入返回 ''
 */
export function normalizeDisplayPath (p) {
  const raw = asString(p)
  if (!raw) return ''

  let out = raw.replace(/\\/g, '/')
  // UNC（\\server\share\a.md）的前导双斜杠有语义，先记住再还原
  const isUnc = out.startsWith('//')
  out = out.replace(/\/{2,}/g, '/')
  if (isUnc && !out.startsWith('//')) out = `/${out}`

  // 去掉结尾斜杠，但保留根目录 '/' 与盘符根 'C:/'
  if (out.length > 1 && out.endsWith('/') && !/^[A-Za-z]:\/$/.test(out)) {
    out = out.slice(0, -1)
  }
  return out
}
