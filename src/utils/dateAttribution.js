// ============================================================================
// dateAttribution.js —— 笔记「日期归属」四级回落内核
//
// 背景（这是产品层面的真痛点，不是代码洁癖）：
//   现在日历与排序一律用 `note.updatedAt`（`src/utils/noteIndex.js:171`
//   `dateKey: dateKeyOf(note.updatedAt)`）。后果是：一篇 2022 年写的笔记，只要
//   今天被碰了一下（改个错别字、被外部同步器重写一次），它在日历上就从 2022 年
//   的格子跳到今天 —— 「最近修改」把「创建时间」的语义整个吃掉了。
//
//   那直接换成磁盘创建时间行不行？不行。`birthtime` 在 Linux 的不少文件系统上
//   拿不到准确值，而文件被复制 / 同步 / git 检出后会被重置成「复制那一刻」。
//   所以它只能当**次优证据**，不能当唯一证据。
//
// 用户已拍板的口径（本模块是它的唯一实现）：
//   日期归属基准 ＝ 四级回落
//     ① frontmatter 显式 `date:`   —— 用户或迁移脚本写死的，最可信
//     ② 文件 `birthtime`            —— 磁盘证据，但可能被复制/同步重置
//     ③ 标题里的日期串              —— 人写日记的习惯（2026-03-15 / 2026年3月15日 / 20260315）
//     ④ `updatedAt`                 —— 现状行为，只作最后兜底
//   再配一次性迁移（T18）把 ①~③ 定下来的值固化进 frontmatter，之后 ① 永久生效，
//   日历与排序统一走 `resolveNoteDate()`。
//
// 为什么「零 import」：
//   与 `fileNaming.js` / `noteIdentity.js` 同族 —— 本模块要同时被渲染进程
//   （store / CalendarView）、迁移脚本（T18）和单测复用，任何一个 import 都会把
//   它锁进某个运行时（比如 import `useLinks` 就要求运行时能解析 '@' 别名）。
//   因此 frontmatter **只认 date 这一行的极简解析**，三处正则与
//   `src/composables/useLinks.js:10/11/27` 逐字对齐（见下方 FM_* 常量处的说明），
//   不引入、也不自造 YAML 解析器。
//
// 纯内核约定：
//   不读时钟（唯一的「现在」是调用方通过 `opts.now` 注入的）、不碰磁盘（`birthtime`
//   是入参，本模块绝不 fs.stat）、不改入参、不持有模块级可变状态。
//   同样的入参永远得到同样的返回值。
//
// 不变量（由 tests/dateAttribution.test.js 逐条断言）：
//   1. 四级优先级严格为 frontmatter > birthtime > title > updatedAt；
//   2. 任何一级的「值存在但不可解析」都会**继续往下掉**，不会返回 NaN / 抛异常；
//   3. `source` 只取 DATE_SOURCE 里的四个字符串常量（T18 与 UI 按它分支）；
//   4. 返回的 `date` 一律是 number（毫秒时间戳），`new Date(date)` 恒有效；
//   5. 日期一律按**本地时区**的日界构造 —— 与 `dateKeyOf` 的 `toDateString()`
//      同源，否则跨时区会出现「日历差一天」。
// ============================================================================

// ---------------------------------------------------------------------------
// 对外常量
// ---------------------------------------------------------------------------

/**
 * 四级来源的取值（**字符串常量，永久稳定**）。
 *
 * T18 的迁移脚本与 UI 会按它分支，所以这四个字符串一旦发布就不能改拼写；
 * 要加来源只能新增键，不能改名。
 */
export const DATE_SOURCE = {
  FRONTMATTER: 'frontmatter',
  BIRTHTIME: 'birthtime',
  TITLE: 'title',
  UPDATED_AT: 'updatedAt'
}

/**
 * 回落顺序（下标越小越优先）。
 * 与 DATE_SOURCE 一一对应 —— 有测试断言两者一致，防止将来加来源时忘了同步。
 */
export const DATE_SOURCES = [
  DATE_SOURCE.FRONTMATTER,
  DATE_SOURCE.BIRTHTIME,
  DATE_SOURCE.TITLE,
  DATE_SOURCE.UPDATED_AT
]

/**
 * frontmatter 里认哪些键（按优先级排列）。
 *
 * `date` 排第一，是因为它就是 T18 迁移要写入的规范化键：迁移之后无论用户原本
 * 写的是 `created` 还是 `created_at`，`date:` 一定存在且一定赢，语义不会漂。
 * 另外两个是兼容键（Obsidian 模板、Jekyll 习惯、脚本导出）。
 *
 * 键名匹配**大小写不敏感**（`Date:` 与 `date:` 等价），这与 YAML 本身不同 ——
 * 但 frontmatter 是给人手写的，大小写敏感只会让人白写一次。
 */
export const DATE_KEYS = ['date', 'created', 'created_at', 'createdAt']

/** DATE_KEYS 的小写 → 优先级下标（0 最优先） */
const DATE_KEY_PRIORITY = new Map([
  ['date', 0],
  ['created', 1],
  ['created_at', 2],
  ['createdat', 3]
])

// ---------------------------------------------------------------------------
// frontmatter 围栏：与 src/composables/useLinks.js:10-11 / :27 逐字对齐
// ---------------------------------------------------------------------------

/**
 * 以下三个正则**逐字抄自 `src/composables/useLinks.js`**（`FM_START` / `FM_FENCE`
 * / 行首 header 正则）。
 *
 * 抄而不 import 的理由见文件头「为什么零 import」；对齐的理由更重要：项目里
 * 「什么算 frontmatter」只有一个口径，本模块若自创一套围栏（比如允许 `--- ` 后
 * 不带换行，或允许缩进的 `  ---`），就会出现「右侧属性面板看得到 date、日历却
 * 读不到」这种只在一侧生效的诡异行为。
 *
 * ⚠️ 唯一一处刻意差异（更强，不是更弱）：本模块在**行级**先剥掉行尾的 `\r`。
 * JS 正则里 `.` 不吃 `\r`、且无 `m` 标志的 `$` 也不会停在尾部 `\r` 之前，所以
 * 上面那个 header 正则遇到 CRLF 文件时**整行匹配失败** —— 也就是说
 * `useLinks.parseFrontmatter` 解析 CRLF frontmatter 会得到 `hasFrontmatter: true`
 * 但 `frontmatter: {}`（既有行为，属上游缺陷，不归本任务改）。
 * 本模块若照抄这个结果，Windows 用户的 CRLF 笔记就永远读不到日期，而那正是
 * 「四级回落」最该兜住的一批文件。围栏定义与键名规则仍然逐字一致，差异只在
 * 「行尾回车要不要剥」这一层，属于行级容错，不改变「什么算 frontmatter」。
 */
const FM_START = /^---\s*\n/
const FM_FENCE = /^---\s*\n([\s\S]*?)\n---\s*\n?/m
const FM_HEADER = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*:\s*(.*)$/

/**
 * frontmatter 值里允许的时间戳下界：低于它的整数不当时间戳。
 * 13 位（毫秒级）起步，10 位按秒级另判，其余一律拒绝 —— 宁可拒绝也不要把
 * `12345678` 这种噪声解释成 1970 年。
 */
const EPOCH_MS_FLOOR = 1e12

/** 秒级时间戳的合理区间：2001-09-09 ~ 2100-01-01 */
const EPOCH_SEC_MIN = 1e9
const EPOCH_SEC_MAX = 4102444800

/** 年份合法区间（四个数字能表达的常规笔记年份） */
const MIN_YEAR = 1000
const MAX_YEAR = 9999

/**
 * birthtime 允许比「现在」超前多少。
 *
 * 复制 / 同步 / 解压都会把 birthtime 重置成操作那一刻，跨机器时常常带着对方的
 * 错误时钟 —— 见过 birthtime 在 2086 年的例子。与其让这种值把笔记钉死在未来的
 * 格子里，不如判它不可信、往下掉一级。留一天宽容度是为了吃掉正常的时钟误差
 * （NTP 抖动、跨时区写入）。
 */
const BIRTHTIME_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 任意入参安全转字符串 */
function asString (value) {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 某位置是不是 ASCII 数字。
 * 刻意不用 /\d/.test(text[i])：空字符串与越界都要能安全返回 false，逐字符
 * 扫描里这种判断会跑很多次，直接比码点最省心。
 *
 * @param {string} text 文本
 * @param {number} index 下标（允许越界）
 * @returns {boolean}
 */
function isDigitAt (text, index) {
  if (index < 0 || index >= text.length) return false
  const code = text.charCodeAt(index)
  return code >= 48 && code <= 57
}

/**
 * 剥掉一对匹配的引号（与 `useLinks.unquote` 的去引号部分同口径）。
 * 只剥成对的首尾引号，不做布尔 / 数字的 YAML 推断 —— 日期这里要的就是字符串。
 *
 * @param {string} s 值
 * @returns {string}
 */
function stripQuotes (s) {
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) {
    return s.slice(1, -1)
  }
  return s
}

/** 转整数；非法输入返回 null（而不是 NaN，免得污染后续比较） */
function toInt (value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

/** 闰年判定（格里高利历） */
function isLeapYear (y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

/** 某年某月的天数 */
function daysInMonth (y, m) {
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}

/**
 * 由「年月日 + 可选时分秒」造时间戳，任一分量越界就返回 null。
 *
 * 默认按**本地时间**构造，这与 `dateKeyOf` 的 `new Date(v).toDateString()` 同源：
 * 日历关心的是「用户所在时区的那一天」。只有值里显式带 `Z` 才按 UTC 构造。
 *
 * 越界一律拒绝（而不是让 Date 自己进位）：`2026-02-30` 静默变成 3 月 2 日，
 * 用户永远不会发现自己的笔记被挪了一天。
 *
 * @param {string|number} year 年
 * @param {string|number} month 月（1-12）
 * @param {string|number} day 日（1-31）
 * @param {string|number} [hour=0] 时
 * @param {string|number} [minute=0] 分
 * @param {string|number} [second=0] 秒
 * @param {boolean} [utc=false] 是否按 UTC 解释
 * @returns {number|null} 毫秒时间戳
 */
function makeTs (year, month, day, hour, minute, second, utc = false) {
  const y = toInt(year)
  const mo = toInt(month)
  const d = toInt(day)
  if (y === null || mo === null || d === null) return null
  if (y < MIN_YEAR || y > MAX_YEAR) return null
  if (mo < 1 || mo > 12) return null
  if (d < 1 || d > daysInMonth(y, mo)) return null

  const h = hour === undefined || hour === null ? 0 : toInt(hour)
  const mi = minute === undefined || minute === null ? 0 : toInt(minute)
  const s = second === undefined || second === null ? 0 : toInt(second)
  if (h === null || mi === null || s === null) return null
  if (h > 23 || mi > 59 || s > 59) return null

  const ts = utc
    ? Date.UTC(y, mo - 1, d, h, mi, s)
    : new Date(y, mo - 1, d, h, mi, s).getTime()
  return Number.isFinite(ts) ? ts : null
}

/**
 * 把一个「日期值」解析成时间戳。
 *
 * 支持的写法（只认这些，其它一律 null —— 宁可往下掉一级，也不猜）：
 *   ① `2026-03-15` / `2026/03/15`（分隔符前后必须一致，`2026-03/15` 不算）
 *      可带时间：`2026-03-15 10:30`、`2026-03-15T10:30:00`、带 `Z` 按 UTC；
 *   ② `2026年3月15日`（也接受「号」）；
 *   ③ `20260315` —— **恰好 8 位数字且是合法年月日**；
 *   ④ 13 位以上整数 → 毫秒级时间戳；10 位整数落在 2001~2100 → 秒级时间戳。
 *
 * 关于 ③ 与 ④ 的顺序：`20260315` 既是合法日期也是合法数字，必须先按日期判。
 * 这正是 YAML 手写的经典坑 —— 不引号的 `date: 2026-03-15` 是字符串，但
 * `date: 20260315` 会被不少解析器当数字，再当毫秒就是 1970 年。
 *
 * 已知取舍：带 `±HH:MM` 偏移的串（`2026-03-15T10:30:00+08:00`）**不做时区换算**，
 * 直接把字面时分秒当本地时间。因为日期归属只取「年月日」，而年月日是逐字取自
 * 字符串的、不受时区影响；受影响的只有时分秒，它不改变日历归属的那一格。
 *
 * @param {string|number|Date|null} value 待解析的值
 * @returns {number|null} 毫秒时间戳；无法解析返回 null
 */
function parseDateValue (value) {
  if (value === null || value === undefined) return null

  // Date 实例按 getTime 取（跨 realm 时 instanceof 不可靠，故鸭子类型判定）
  if (typeof value === 'object' && typeof value.getTime === 'function') {
    const t = value.getTime()
    return Number.isFinite(t) ? t : null
  }
  // 数字统一走字符串通道：这样 `20260315`（number）与 `'20260315'`（string）
  // 得到同一个结果，不会出现「类型不同、日期不同」的鬼故事。
  const raw = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : asString(value).trim()
  if (!raw) return null

  const s = stripQuotes(raw)
  if (!s) return null

  // ① 分隔符日期（可带时间）
  const sep = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z)?/.exec(s)
  if (sep) {
    return makeTs(sep[1], sep[3], sep[4], sep[5], sep[6], sep[7], sep[8] === 'Z')
  }

  // ② 中文年月日（**必须带日** —— 只写「2026年3月」是月份总结，不是某一天）
  const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})[日号]/.exec(s)
  if (cn) return makeTs(cn[1], cn[2], cn[3], 0, 0, 0, false)

  // ③ 紧凑 8 位
  if (/^\d{8}$/.test(s)) {
    return makeTs(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8), 0, 0, 0, false)
  }

  // ④ 纯数字时间戳
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n >= EPOCH_MS_FLOOR) return n
    if (n >= EPOCH_SEC_MIN && n <= EPOCH_SEC_MAX) return Math.round(n * 1000)
    return null
  }
  return null
}

/**
 * 把「可能是 Date / 数字 / 数字串 / 日期串」的值统一成毫秒时间戳。
 *
 * store 里的 `updatedAt` 是 **Date 对象**（`note.js:940` `updatedAt: new Date()`），
 * 主进程 `fs.stat` 给的 `birthtime` 也是 Date，而从 JSON / localStorage 回来的
 * 又可能是数字或字符串 —— 这个模块四级里三级都要吃这些形态，所以统一在这里收口。
 *
 * @param {Date|number|string|null|undefined} value 入参
 * @returns {number|null} 毫秒时间戳；不可解析返回 null
 */
function toTimestamp (value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'object' && typeof value.getTime === 'function') {
    const t = value.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  const parsed = Date.parse(s)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 在带围栏的 frontmatter 里找日期键，返回**原始值字符串**（不含键名）。
 *
 * 为什么要返回原始串：调用方（UI / 迁移日志）要显示「这个日期来自
 * `date: 2026-03-15`」，光有时间戳看不出来它原本写的是 `20260315` 还是 ISO。
 *
 * 两个刻意的设计：
 *   · **必须带围栏**。没有 `---` 包裹的 `date: xxx` 一律不算 frontmatter ——
 *     与 `useLinks.parseFrontmatter` 的 `hasFrontmatter: false` 同口径，也避免
 *     把正文里某行恰好以 `date:` 开头的文本（代码块、摘录）当成元数据。
 *   · **按键名优先级、不按行序**。`created:` 写在 `date:` 前面时也要 `date:`
 *     赢，否则「迁移写入的规范值」会被用户当年的随手键压过去。
 *
 * @param {string} text 笔记全文
 * @returns {{ key: string, raw: string }|null} 命中返回键与原始值
 */
function readFrontmatterDateRaw (text) {
  if (!FM_START.test(text)) return null
  const m = text.match(FM_FENCE)
  if (!m) return null

  let best = null
  const lines = m[1].split(/\r?\n/)
  for (const rawLine of lines) {
    // CRLF：块末尾会残留一个 \r（\n 被围栏正则吃掉了），先剥掉再匹配
    const line = rawLine.replace(/\r+$/, '')
    const h = FM_HEADER.exec(line)
    if (!h) continue
    const priority = DATE_KEY_PRIORITY.get(String(h[1]).toLowerCase())
    if (priority === undefined) continue
    const raw = stripQuotes(String(h[2] || '').trim())
    if (!raw) continue
    // 同一优先级取靠前那一行（先写先赢），不同优先级取数字小的
    if (!best || priority < best.priority) best = { priority, key: String(h[1]), raw }
  }
  return best ? { key: best.key, raw: best.raw } : null
}

// ---------------------------------------------------------------------------
// 标题日期串扫描
// ---------------------------------------------------------------------------

/**
 * 扫「分隔符日期」：2026-03-15 / 2026/03/15。
 *
 * 每条命中都要做两个边界检查：
 *   · 前一个字符不能是数字 —— 否则 `12026-03-15` 会被从中间切开；
 *   · 后一个字符不能是数字 —— 否则 `2026-03-1512` 会命中一个不存在的日子。
 * 命中但年月日不合法（如 `2026-13-45`）时**继续往下找**，不直接放弃整条标题。
 *
 * @param {string} text 标题
 * @returns {{ date: number, raw: string }|null}
 */
function scanSeparatedDate (text) {
  const re = /(\d{4})([-/])(\d{1,2})\2(\d{1,2})/g
  let m
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (isDigitAt(text, start - 1) || isDigitAt(text, end)) continue
    const ts = makeTs(m[1], m[3], m[4], 0, 0, 0, false)
    if (ts !== null) return { date: ts, raw: m[0] }
  }
  return null
}

/**
 * 扫「中文年月日」：2026年3月15日。
 *
 * **必须带「日 / 号」**是刻意的边界：`2026年3月` 是月度总结、`2026年度总结`
 * 是年度总结，它们都不是「某一天」，把它们解析成 3 月 1 日等于凭空造了一个
 * 日期（用户点开日历会看到一篇并不属于那天的笔记）。所以这里宁可漏。
 *
 * 另外「2026 年度总结」天然不命中：年后面紧跟的是「度」不是数字，压根进不了
 * 月份分组。这是本条规则最想钉住的反例。
 *
 * @param {string} text 标题
 * @returns {{ date: number, raw: string }|null}
 */
function scanChineseDate (text) {
  const re = /(\d{4})年(\d{1,2})月(\d{1,2})[日号]/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (isDigitAt(text, m.index - 1)) continue
    const ts = makeTs(m[1], m[2], m[3], 0, 0, 0, false)
    if (ts !== null) return { date: ts, raw: m[0] }
  }
  return null
}

/**
 * 扫「紧凑 8 位」：20260315。
 *
 * 逐数字段扫描（而不是 /\d{8}/g）：必须保证这 8 位**两侧都不是数字**，也就是
 * 它得是一个完整的数字段。`订单20260315123456` 是一个 14 位的段 → 不命中；
 * `120260315` 是 9 位 → 不命中。否则订单号、手机号后半段、流水号都会变成日期。
 *
 * @param {string} text 标题
 * @returns {{ date: number, raw: string }|null}
 */
function scanCompactDate (text) {
  let start = -1
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && isDigitAt(text, i)) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0) {
      const len = i - start
      if (len === 8) {
        const raw = text.slice(start, i)
        const ts = makeTs(raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8), 0, 0, 0, false)
        if (ts !== null) return { date: ts, raw }
      }
      start = -1
    }
  }
  return null
}

/**
 * 标题日期串的总入口：三种写法按**格式优先级**依次尝试，每种内部从左到右取
 * 第一个合法命中。
 *
 * 为什么按格式优先级而不是「谁在标题里靠前」：靠前者依赖用户书写顺序，同一个
 * 标题改几个字结果就变了；按格式固定下来，同一篇笔记的归属是稳定的、可预期的。
 *
 * @param {string} title 标题
 * @returns {{ date: number, raw: string }|null}
 */
function scanTitleDate (title) {
  const text = asString(title)
  if (!text) return null
  return scanSeparatedDate(text) || scanChineseDate(text) || scanCompactDate(text)
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 时间戳 → `YYYY-MM-DD`（**本地日历日**，不是 `toISOString()` 的 UTC 日）。
 *
 * 这是 T18 迁移写 frontmatter 时要用的格式化器。必须按本地日期分量拼，不能用
 * `new Date(ts).toISOString().slice(0, 10)`：后者先转 UTC，在东八区会把
 * 「本地 00:30」显示成前一天，迁移后日历整体错一天 —— 而且错得非常隐蔽。
 *
 * @param {Date|number|string|null} value 时间
 * @returns {string} 'YYYY-MM-DD'；不可解析返回 ''
 */
export function toISODate (value) {
  const ts = toTimestamp(value)
  if (ts === null) return ''
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 解析 frontmatter 里的日期。
 *
 * 入参三种形态都吃：
 *   · **笔记全文**（最常用，本模块内部就是这么调的）—— 有围栏才认；
 *   · **单个日期值**（`'2026-03-15'`）—— 供 T18 做「写进去再读出来」的往返校验；
 *   · 无围栏的多行文本 —— 一律 null（不是 frontmatter，见 readFrontmatterDateRaw）。
 *
 * @param {string|null} raw 笔记全文或单个值
 * @returns {number|null} 毫秒时间戳；无日期或不可解析返回 null
 */
export function parseFrontmatterDate (raw) {
  const text = asString(raw)
  if (!text) return null

  const hit = readFrontmatterDateRaw(text)
  if (hit) return parseDateValue(hit.raw)

  // 没有 frontmatter 结构时，把入参当「单个日期值」再试一次 —— 只为支持
  // `parseFrontmatterDate('2026-03-15')` 这种已剥值的调用。限制成单行，
  // 避免把「正文开头恰好是日期」的整篇笔记误判成 frontmatter 的 date。
  if (!text.includes('\n')) return parseDateValue(text.trim())
  return null
}

/**
 * 从标题里提取日期串，返回毫秒时间戳（本地日界的 00:00:00）。
 *
 * 匹配边界（**刻意不命中的都列在这里**，测试里逐条钉死）：
 *   命中：`2026-03-15` / `2026/3/15` / `2026年3月15日` / `2026年3月15号` /
 *         `20260315`（两侧非数字）／出现在标题任意位置。
 *   不命中：`2026 年度总结`（年后面没有月）、`2026年3月`（没有日）、
 *         `第 3 章 第 15 节`（没有四位的年）、`2026031` / `202603151`（不是 8 位）、
 *         `12345678`（月份 34 非法）、`2026-13-01`（月份越界）、
 *         `订单20260315123456`（14 位数字段）、`2026-02-30`（该月没有 30 日）。
 *
 * @param {string|null} title 笔记标题
 * @returns {number|null} 毫秒时间戳；无日期串返回 null
 */
export function extractDateFromTitle (title) {
  const hit = scanTitleDate(title)
  return hit ? hit.date : null
}

/**
 * 四级回落主入口（R-D1 / R-C1 的唯一日期口径）。
 *
 * 四级按 `DATE_SOURCES` 的顺序依次尝试，**任何一级「有值但解析不出来」都会继续
 * 往下掉**（比如 `date: 待定`、`birthtime: 0`、标题里只有年份）—— 这是本函数
 * 最重要的容错：绝不让一个坏值把整篇笔记钉死在 1970 年或 NaN 上。
 *
 * @param {object|null} note 笔记对象，读 `content`（frontmatter）、`title`、`updatedAt`
 * @param {{ birthtime?: Date|number|string|null, now?: number }} [options]
 *        `birthtime` 由主进程 `fs.stat` 提供（浏览器环境传 null），**本模块绝不自己 stat**；
 *        `now` 是 ④ 级 `updatedAt` 不可用时的兜底值，注入它是为了让本函数保持可测
 * @returns {{ date: number, source: string, raw: string|null }}
 *          `date` 毫秒时间戳；`source` ∈ DATE_SOURCE 四值之一；
 *          `raw` 是该日期的**来源原文**：frontmatter 给出原始值串、title 给出命中的
 *          日期串、birthtime 与 updatedAt 为 null（它们本身就是时间戳，无需原文）
 */
export function resolveNoteDate (note, options = {}) {
  const opts = options || {}
  const birthtime = opts.birthtime === undefined ? null : opts.birthtime
  const nowRaw = opts.now === undefined ? Date.now() : opts.now

  const now = toTimestamp(nowRaw)
  const fallbackTs = now === null ? 0 : now

  const src = note && typeof note === 'object' ? note : {}

  // ① frontmatter 显式日期
  const fm = readFrontmatterDateRaw(asString(src.content))
  if (fm) {
    const ts = parseDateValue(fm.raw)
    if (ts !== null) return { date: ts, source: DATE_SOURCE.FRONTMATTER, raw: fm.raw }
  }

  // ② 文件 birthtime：0 / 负数 / 未来一律视为不可信（Linux 上拿不到值时就是 0）
  const bt = toTimestamp(birthtime)
  if (bt !== null && bt > 0 && bt <= fallbackTs + BIRTHTIME_FUTURE_TOLERANCE_MS) {
    return { date: bt, source: DATE_SOURCE.BIRTHTIME, raw: null }
  }

  // ③ 标题里的日期串
  const titleHit = scanTitleDate(src.title)
  if (titleHit) {
    return { date: titleHit.date, source: DATE_SOURCE.TITLE, raw: titleHit.raw }
  }

  // ④ updatedAt（现状行为）。它不可用时退回 opts.now：日历至少要有个格子能放
  // 这篇笔记，返回 null 会让上游到处判空。source 仍然是 'updatedAt' —— 这一级
  // 就是「现状等价物」，不代表我们真的读到了 updatedAt。
  const up = toTimestamp(src.updatedAt)
  return { date: up !== null && up > 0 ? up : fallbackTs, source: DATE_SOURCE.UPDATED_AT, raw: null }
}
