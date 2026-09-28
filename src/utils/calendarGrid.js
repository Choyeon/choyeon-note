// ============================================================================
// calendarGrid.js —— 日历网格 / 周视图 / 密度分级 纯内核
//
// 背景（本模块要修掉的三类真问题）：
//   ① **网格行数恒为 6**：旧实现先铺满 42 格再看，于是「平年 2 月且 1 号是周一」
//      这种正好 4 周的月份，下面硬生生多出两行下个月（3 月占了半个屏幕）。
//      正确做法是按 `ceil((前导 + 当月天数) / 7)` 取最小行数，下个月最多露一行。
//   ② **非本月与本月看不出区别**：只有 `opacity: 0.35`，笔记条目一起糊掉；
//      网格要给出 `inMonth` 让视图分别处理「底色」与「数字/条目」。
//   ③ **单日 ≥3 篇只有一个 +N**：Obsidian 用的是颜色深浅 + 圆点密度，一眼能看出
//      哪天是高产日。密度分级必须放在内核里，视图只负责把 level 翻译成样式。
//
// 为什么「零 import」：
//   与 `dateAttribution.js` / `fileNaming.js` 同族 —— 本模块要同时被渲染进程
//   （CalendarView）、验证脚本和单测复用，任何一个 import 都会把它锁进某个
//   运行时。日期一律自己按**本地时区**拼装（`getFullYear/getMonth/getDate`），
//   与 `noteIndex.js` 的 `dateKeyOf`（`new Date(v).toDateString()`）同源，
//   绝不使用 `toISOString()` —— 后者先转 UTC，东八区的「本地 00:30」会被算成
//   前一天，日历整体错一天且极其隐蔽。
//
// 纯内核约定：
//   不读时钟（没有 `Date.now()` 调用；「今天」由调用方传入或自行构造）、
//   不碰 DOM、不改入参、不持有模块级可变状态。同样的入参永远得到同样的返回值。
//
// ⚠️ 月份口径：**所有入参与出参的 `month` 一律是 1-12（人类月份）**。
//   需要喂给 `new Date(...)` 的地方由本模块内部做 `- 1`，对外绝不暴露 0-11，
//   避免「内核以为是 3 月、调用方以为是 4 月」这种差一天的祖传 bug。
//   单元格另外提供 `monthIndex`（0-11）与 `ts`（本地 00:00 的时间戳）两个
//   免换算字段，调用方不需要再自己 `new Date(y, m - 1, d)`。
//
// 不变量（由 tests/calendarGrid.test.js 逐条断言）：
//   1. `rows === ceil((leading + daysInMonth) / 7)`，且恒落在 4..6；
//   2. 平年 2 月首日周一时 `rows === 4` 且 `trailing === 0`（不出现下个月）；
//   3. 单元格按日期严格升序、无重复、无跳日，跨月跨年由 Date 自己进位；
//   4. `iso` 恒为本地时区的 `YYYY-MM-DD`，与 `storeKeyOf` 指向同一个日历日；
//   5. `densityOf` 只返回 0 / 1 / 2 三档，阈值 `DENSITY_HIGH_THRESHOLD = 3`；
//   6. 非法入参一律返回空结构 / 空串，**绝不抛异常**（视图不允许被日历崩掉）。
// ============================================================================

// ---------------------------------------------------------------------------
// 对外常量
// ---------------------------------------------------------------------------

/** 周首日：周一（ISO-8601，本项目默认） */
export const WEEK_START_MONDAY = 1
/** 周首日：周日（美式日历） */
export const WEEK_START_SUNDAY = 0

/** 密度档位：当天 0 篇 */
export const DENSITY_NONE = 0
/** 密度档位：当天 1-2 篇 */
export const DENSITY_LOW = 1
/** 密度档位：当天 ≥3 篇（要有明显的视觉信号，不能只给 +N） */
export const DENSITY_HIGH = 2

/** 进入「高产日」档位的篇数阈值 */
export const DENSITY_HIGH_THRESHOLD = 3

/** 一周的天数（不是可配置项，写出来是为了让 7 不再散落成魔数） */
export const DAYS_PER_WEEK = 7

/** 周一为首时的表头文案 */
export const WEEKDAY_LABELS_MONDAY_FIRST = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
/** 周日为首时的表头文案 */
export const WEEKDAY_LABELS_SUNDAY_FIRST = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** `dayRange()` 的硬上限：防御非法跨度把浏览器卡死（约 5 年） */
const DAY_RANGE_MAX = 2000

// ---------------------------------------------------------------------------
// 内部工具（全部零 import）
// ---------------------------------------------------------------------------

/**
 * 两位补零。非数字 / 负数一律按 0 处理，绝不返回 'NaN'。
 * @param {number} n 数值
 * @returns {string} 两位字符串
 */
function pad2 (n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '00'
  return String(Math.floor(v)).padStart(2, '0')
}

/** 安全转整数；非法返回 null（而不是 NaN，免得污染后续比较） */
function toInt (value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

/** 闰年判定（格里高利历） */
export function isLeapYear (year) {
  const y = toInt(year)
  if (y === null) return false
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

/**
 * 某年某月的天数。
 * @param {number} year 年
 * @param {number} month 月（**1-12**）
 * @returns {number} 天数；非法月份返回 0
 */
export function daysInMonth (year, month) {
  const y = toInt(year)
  const m = toInt(month)
  if (y === null || m === null || m < 1 || m > 12) return 0
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}

/**
 * 年月日是否构成合法日期（`2026-02-30` 必须判否，不能让 Date 自己进位）。
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @returns {boolean}
 */
export function isValidYmd (year, month, date) {
  const y = toInt(year)
  const m = toInt(month)
  const d = toInt(date)
  if (y === null || m === null || d === null) return false
  if (m < 1 || m > 12) return false
  if (d < 1 || d > daysInMonth(y, m)) return false
  return true
}

// ---------------------------------------------------------------------------
// 日期键：本地时区的 YYYY-MM-DD
// ---------------------------------------------------------------------------

/**
 * 年月日 → `YYYY-MM-DD`（**本地日历日**，不是 `toISOString()` 的 UTC 日）。
 *
 * 非法入参返回空串而不是抛异常：视图层拿到空串会渲染成「无日期」，
 * 抛异常会让整个日历白屏。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @returns {string} 'YYYY-MM-DD'；非法返回 ''
 */
export function isoOf (year, month, date) {
  if (!isValidYmd(year, month, date)) return ''
  return `${String(toInt(year)).padStart(4, '0')}-${pad2(month)}-${pad2(date)}`
}

/**
 * `YYYY-MM-DD` → 年月日。
 *
 * 只认**严格格式**（两位月日、`-` 分隔）：`2026-3-5` 判否，因为一旦允许它，
 * 之后就一定会有人传 `2026-3-5T00:00:00Z`，那串按本地时区解释会差一天。
 *
 * @param {string} iso 日期串
 * @returns {{ year: number, month: number, date: number }|null} month 为 1-12
 */
export function parseIso (iso) {
  if (typeof iso !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const date = Number(m[3])
  if (!isValidYmd(year, month, date)) return null
  return { year, month, date }
}

/**
 * 任意「时间」→ 本地日历日的年月日。
 *
 * ISO 日期串（`'2026-03-15'`）走**逐分量解析**，不交给 `new Date(str)`：
 * 后者把纯日期串按 **UTC 午夜**解释，在美洲时区会落到前一天（著名的
 * `new Date('2026-03-15').getDate() === 14`）。
 *
 * @param {Date|number|string|null} value 时间
 * @returns {{ year: number, month: number, date: number }|null} month 为 1-12
 */
export function toYmd (value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const hit = parseIso(value.trim())
    return hit
  }
  const ts = typeof value === 'number'
    ? value
    : (typeof value === 'object' && typeof value.getTime === 'function' ? value.getTime() : NaN)
  if (!Number.isFinite(ts)) return null
  const d = new Date(ts)
  return { year: d.getFullYear(), month: d.getMonth() + 1, date: d.getDate() }
}

/**
 * 任意「时间」→ 本地日历日的 `YYYY-MM-DD`。
 *
 * 这是日历格子的唯一日期口径：格子、周视图、议程分组全部走它，
 * 与 store 侧 `dateKeyOf`（`new Date(v).toDateString()`）指向同一天。
 *
 * @param {Date|number|string|null} value 时间
 * @returns {string} 'YYYY-MM-DD'；不可解析返回 ''
 */
export function isoOfTs (value) {
  const ymd = toYmd(value)
  if (!ymd) return ''
  return isoOf(ymd.year, ymd.month, ymd.date)
}

/**
 * 与 `noteIndex.js` 的 `dateKeyOf` 逐字同口径的旧键（`new Date(v).toDateString()`）。
 *
 * 为什么内核里要留一个「旧格式」：store 的 `getNotesByDate(date)` 内部就是
 * `new Date(date).toDateString()` 之后去索引里取桶。日历格子必须能拿到与之
 * **完全同构**的键，否则「东八区 3 月 15 日」会去查「3 月 14 日」的桶。
 * 本模块自己用的是 `iso`（YYYY-MM-DD），这个函数只用于跨模块对齐与测试断言。
 *
 * @param {Date|number|string|null} value 时间
 * @returns {string} 形如 'Sun Mar 15 2026'；不可解析返回 'Invalid Date'
 */
export function storeKeyOf (value) {
  return new Date(value === null || value === undefined ? NaN : value).toDateString()
}

/**
 * 本地 00:00:00 的时间戳。
 *
 * 用它当格子的「身份」可以绕开所有时区换算：`new Date(cell.ts)` 恒为那一天的
 * 本地零点，喂给 store 的 `getNotesByDate` 也一定落在同一个日历日。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @returns {number|null} 毫秒时间戳；非法返回 null
 */
export function startOfDayTs (year, month, date) {
  if (!isValidYmd(year, month, date)) return null
  return new Date(toInt(year), toInt(month) - 1, toInt(date), 0, 0, 0, 0).getTime()
}

// ---------------------------------------------------------------------------
// 星期 / 加减天数
// ---------------------------------------------------------------------------

/**
 * JS 星期：0=周日 … 6=周六。
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @returns {number} 0-6；非法返回 -1
 */
export function weekdayOf (year, month, date) {
  if (!isValidYmd(year, month, date)) return -1
  return new Date(toInt(year), toInt(month) - 1, toInt(date)).getDay()
}

/**
 * 距周首日的偏移：0 = 正好是周首日。
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @param {number} [weekStartsOn=1] 周首日（1=周一 / 0=周日）
 * @returns {number} 0-6；非法返回 -1
 */
export function weekdayFromStart (year, month, date, weekStartsOn = WEEK_START_MONDAY) {
  const wd = weekdayOf(year, month, date)
  if (wd < 0) return -1
  const start = weekStartsOn === WEEK_START_SUNDAY ? 0 : 1
  return (wd - start + 7) % 7
}

/**
 * 加减天数：跨月 / 跨年 / 闰年 / 夏令时全部交给 Date 自己进位。
 *
 * 刻意用 `new Date(y, m - 1, d + delta)` 再读回本地分量，而不是手算月份天数
 * 表 —— 手算在 2 月和闰年上翻车过太多次。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @param {number} [delta=0] 天数（可为负）
 * @returns {{ year: number, month: number, date: number }|null}
 */
export function addDays (year, month, date, delta = 0) {
  if (!isValidYmd(year, month, date)) return null
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  const d = new Date(toInt(year), toInt(month) - 1, toInt(date) + step)
  return { year: d.getFullYear(), month: d.getMonth() + 1, date: d.getDate() }
}

/**
 * 加减月份（只算到年月，不夹日 —— 翻页场景不需要日）。
 *
 * 「日」不在这里夹，是因为调用方（日历翻页）只关心「翻到哪个月」；真要算
 * 「1 月 31 日 + 1 个月是哪天」，应该先 `addMonths` 再用 `daysInMonth` 夹住，
 * 把两件事合成一个函数只会让其中一半的调用方拿到意外的结果。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} [delta=0] 月数（可为负）
 * @returns {{ year: number, month: number }|null} month 仍为 1-12
 */
export function addMonths (year, month, delta = 0) {
  const y = toInt(year)
  const m = toInt(month)
  if (y === null || m === null || m < 1 || m > 12) return null
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  const total = y * 12 + (m - 1) + step
  return {
    year: Math.floor(total / 12),
    month: (total % 12 + 12) % 12 + 1
  }
}

/**
 * 两个 `YYYY-MM-DD` 的字典序比较（ISO 格式的字典序 === 时间序）。
 * @param {string} a 日期串
 * @param {string} b 日期串
 * @returns {number} -1 / 0 / 1；任一侧非法返回 0
 */
export function compareIso (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 表头文案。
 * @param {number} [weekStartsOn=1] 周首日（1=周一 / 0=周日）
 * @returns {string[]} 7 个文案
 */
export function weekdayLabels (weekStartsOn = WEEK_START_MONDAY) {
  return weekStartsOn === WEEK_START_SUNDAY
    ? WEEKDAY_LABELS_SUNDAY_FIRST.slice()
    : WEEKDAY_LABELS_MONDAY_FIRST.slice()
}

// ---------------------------------------------------------------------------
// 单元格
// ---------------------------------------------------------------------------

/**
 * 造一个日历单元格。
 *
 * 字段里 `iso`（给人看 / 做 Map 键）、`ts`（喂给 store，免换算）、
 * `key`（与 store 的 `toDateString()` 同口径）三者**恒指向同一个日历日**，
 * 这是「日历不差一天」的关键 —— 三选一用错就会出现「点 15 号打开 14 号的笔记」。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @param {object} [options={}] 选项
 * @param {number} [options.weekStartsOn=1] 周首日
 * @param {boolean} [options.inMonth=true] 是否属于当前渲染的那个月
 * @param {number} [options.offset=0] 相对月首日的天偏移（负数 = 上个月）
 * @returns {object} 单元格；非法入参返回 `valid: false` 的空壳
 */
export function makeDayCell (year, month, date, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const weekStartsOn = opts.weekStartsOn === WEEK_START_SUNDAY ? WEEK_START_SUNDAY : WEEK_START_MONDAY
  const inMonth = opts.inMonth === undefined ? true : Boolean(opts.inMonth)
  const offset = Number.isFinite(opts.offset) ? Math.trunc(opts.offset) : 0

  if (!isValidYmd(year, month, date)) {
    return {
      valid: false,
      year: 0, month: 0, date: 0, monthIndex: 0,
      iso: '', key: '', ts: NaN,
      inMonth: false, isWeekend: false, weekday: 0, offset: 0, weekStartsOn
    }
  }

  const y = toInt(year)
  const m = toInt(month)
  const d = toInt(date)
  const ts = startOfDayTs(y, m, d)
  const wd = new Date(ts).getDay()

  return {
    valid: true,
    year: y,
    month: m,
    date: d,
    /** 0-11，喂给 `new Date(y, monthIndex, d)` 用 */
    monthIndex: m - 1,
    /** 本地日历日 `YYYY-MM-DD`（视图的 Map 键） */
    iso: isoOf(y, m, d),
    /** 与 `noteIndex.dateKeyOf` 同口径的旧键 */
    key: new Date(ts).toDateString(),
    /** 本地 00:00 时间戳（喂给 store.getNotesByDate） */
    ts,
    inMonth,
    isWeekend: wd === 0 || wd === 6,
    /** 0 = 周首日 … 6 = 周末日 */
    weekday: weekdayFromStart(y, m, d, weekStartsOn),
    offset,
    weekStartsOn
  }
}

// ---------------------------------------------------------------------------
// 月网格
// ---------------------------------------------------------------------------

/** 非法入参时的空网格（视图拿到它渲染出「无日期」而不是崩掉） */
function emptyGrid (year, month, weekStartsOn) {
  return {
    valid: false,
    year: Number(year) || 0,
    month: Number(month) || 0,
    weekStartsOn,
    weeks: [],
    cells: [],
    rows: 0,
    daysInMonth: 0,
    leading: 0,
    trailing: 0,
    monthStartIso: '',
    monthEndIso: '',
    gridStartIso: '',
    gridEndIso: ''
  }
}

/**
 * 算某年某月需要几行（纯函数，便于测试直接断言行数）。
 *
 * 公式：`ceil((leading + daysInMonth) / 7)`，`leading` 是月首日距周首日的偏移。
 * 这就是修掉「恒 6 行」bug 的全部内容 —— 旧实现无条件铺 42 格。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {object} [options={}] 选项
 * @param {number} [options.weekStartsOn=1] 周首日
 * @param {number} [options.minRows=0] 最小行数（想要固定高度可传 6）
 * @returns {number} 行数；非法入参返回 0
 */
export function rowsFor (year, month, options = {}) {
  const dim = daysInMonth(year, month)
  if (dim === 0) return 0
  const opts = options && typeof options === 'object' ? options : {}
  const weekStartsOn = opts.weekStartsOn === WEEK_START_SUNDAY ? WEEK_START_SUNDAY : WEEK_START_MONDAY
  const minRows = Number.isFinite(opts.minRows) && opts.minRows > 0 ? Math.floor(opts.minRows) : 0
  const leading = weekdayFromStart(year, month, 1, weekStartsOn)
  return Math.max(minRows, Math.ceil((leading + dim) / DAYS_PER_WEEK))
}

/**
 * 生成月视图网格。
 *
 * 三个刻意的行为：
 *   · **行数取最小**（见 `rowsFor`）—— 平年 2 月首日周一正好 4 行，下面一个月
 *     都不会露出来；需要固定高度的调用方自己传 `minRows: 6`；
 *   · **首尾都补齐整周** —— 最后一行的下个月最多 6 天（一行），不会像旧实现
 *     那样一次铺 14 天；
 *   · `inMonth` 由「年月日是否等于被渲染的月」决定，不靠下标推算 ——
 *     前者在跨年（12 月网格里出现明年 1 月）时永远正确。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {object} [options={}] 选项
 * @param {number} [options.weekStartsOn=1] 周首日
 * @param {number} [options.minRows=0] 最小行数
 * @returns {object} 网格对象：`{ valid, year, month, weeks, cells, rows,
 *          daysInMonth, leading, trailing, monthStartIso, monthEndIso,
 *          gridStartIso, gridEndIso, weekStartsOn }`
 */
export function monthGrid (year, month, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const weekStartsOn = opts.weekStartsOn === WEEK_START_SUNDAY ? WEEK_START_SUNDAY : WEEK_START_MONDAY
  const dim = daysInMonth(year, month)
  if (dim === 0) return emptyGrid(year, month, weekStartsOn)

  const rows = rowsFor(year, month, opts)
  const leading = weekdayFromStart(year, month, 1, weekStartsOn)
  const total = rows * DAYS_PER_WEEK
  const trailing = total - leading - dim

  // 从「月首日往前推 leading 天」开始铺，跨到上个月由 addDays 自己处理
  const cursor = addDays(year, month, 1, -leading)
  const cells = []
  for (let i = 0; i < total; i += 1) {
    const cur = addDays(cursor.year, cursor.month, cursor.date, i)
    cells.push(makeDayCell(cur.year, cur.month, cur.date, {
      weekStartsOn,
      inMonth: cur.year === toInt(year) && cur.month === toInt(month),
      offset: i - leading
    }))
  }

  const weeks = []
  for (let i = 0; i < cells.length; i += DAYS_PER_WEEK) {
    weeks.push(cells.slice(i, i + DAYS_PER_WEEK))
  }

  return {
    valid: true,
    year: toInt(year),
    month: toInt(month),
    weekStartsOn,
    weeks,
    cells,
    rows,
    daysInMonth: dim,
    leading,
    trailing,
    monthStartIso: isoOf(year, month, 1),
    monthEndIso: isoOf(year, month, dim),
    gridStartIso: cells.length > 0 ? cells[0].iso : '',
    gridEndIso: cells.length > 0 ? cells[cells.length - 1].iso : ''
  }
}

// ---------------------------------------------------------------------------
// 周视图
// ---------------------------------------------------------------------------

/**
 * 给定一天，算出它所在的那一周（连续 7 天）。
 *
 * 跨月 / 跨年由 `addDays` 自己进位；周首日按 `weekStartsOn` 计算，所以
 * 「2025-01-01」会正确落在「2024-12-30 ~ 2025-01-05」这一周里。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {number} date 日
 * @param {object} [options={}] 选项
 * @param {number} [options.weekStartsOn=1] 周首日
 * @returns {object} `{ valid, days, startIso, endIso, weekKey, year, month, weekStartsOn }`
 *          `weekKey` 取周首日的 iso（天然跨年唯一，比自定义周序号稳）
 */
export function weekGrid (year, month, date, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const weekStartsOn = opts.weekStartsOn === WEEK_START_SUNDAY ? WEEK_START_SUNDAY : WEEK_START_MONDAY

  if (!isValidYmd(year, month, date)) {
    return { valid: false, days: [], startIso: '', endIso: '', weekKey: '', year: 0, month: 0, weekStartsOn }
  }

  const back = weekdayFromStart(year, month, date, weekStartsOn)
  const start = addDays(year, month, date, -back)
  const days = []
  for (let i = 0; i < DAYS_PER_WEEK; i += 1) {
    const cur = addDays(start.year, start.month, start.date, i)
    days.push(makeDayCell(cur.year, cur.month, cur.date, {
      weekStartsOn,
      // 周视图里的「本月」= 被锚定的那个月，用来给非本月那一两格降饱和
      inMonth: cur.year === toInt(year) && cur.month === toInt(month),
      offset: i - back
    }))
  }

  return {
    valid: true,
    days,
    startIso: days[0].iso,
    endIso: days[DAYS_PER_WEEK - 1].iso,
    weekKey: days[0].iso,
    year: toInt(year),
    month: toInt(month),
    weekStartsOn
  }
}

/**
 * `weekGrid` 的 iso 串入口（视图手里通常只有 `YYYY-MM-DD`）。
 * @param {string} iso 日期串
 * @param {object} [options={}] 选项，见 `weekGrid`
 * @returns {object} 同 `weekGrid`
 */
export function weekOfIso (iso, options = {}) {
  const ymd = parseIso(iso)
  if (!ymd) {
    const opts = options && typeof options === 'object' ? options : {}
    return {
      valid: false, days: [], startIso: '', endIso: '', weekKey: '', year: 0, month: 0,
      weekStartsOn: opts.weekStartsOn === WEEK_START_SUNDAY ? WEEK_START_SUNDAY : WEEK_START_MONDAY
    }
  }
  return weekGrid(ymd.year, ymd.month, ymd.date, options)
}

/**
 * 一段连续日期（含首尾），议程视图 / 批量统计用。
 *
 * 跨越夏令时的日子由 `addDays` 按本地日历日推进，不会出现「重复一天」或
 * 「跳过一天」—— 用 `ts + 86400000` 手算就会在 3 月的第二个周日翻车。
 *
 * @param {string} startIso 起始日（含）
 * @param {string} endIso 结束日（含）
 * @param {object} [options={}] 选项
 * @param {number} [options.weekStartsOn=1] 周首日
 * @param {boolean} [options.inMonth=false] 单元格的 inMonth 标记
 * @returns {Array<object>} 单元格数组；区间非法（含 start > end）返回 []
 */
export function dayRange (startIso, endIso, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const weekStartsOn = opts.weekStartsOn === WEEK_START_SUNDAY ? WEEK_START_SUNDAY : WEEK_START_MONDAY
  const inMonth = opts.inMonth === undefined ? false : Boolean(opts.inMonth)

  const start = parseIso(startIso)
  const end = parseIso(endIso)
  if (!start || !end) return []
  if (compareIso(startIso, endIso) > 0) return []

  const out = []
  let cur = start
  let guard = 0
  while (guard < DAY_RANGE_MAX) {
    out.push(makeDayCell(cur.year, cur.month, cur.date, {
      weekStartsOn,
      inMonth,
      offset: out.length
    }))
    if (cur.year === end.year && cur.month === end.month && cur.date === end.date) break
    const next = addDays(cur.year, cur.month, cur.date, 1)
    if (!next) break
    cur = next
    guard += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 密度分级
// ---------------------------------------------------------------------------

/** 把任意入参压成非负整数（NaN / 负数 / 字符串都按 0 处理） */
function normalizeCount (count) {
  const n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/**
 * 单日笔记数的密度档位：0（0 篇）/ 1（1-2 篇）/ 2（≥3 篇）。
 *
 * 只返回 `DENSITY_*` 三个常量之一，视图按档位出样式，不再自己写 `>= 3`
 * —— 阈值写在视图里，改一次就要改三处（网格 / 周视图 / 议程）。
 *
 * @param {number} count 当天笔记数
 * @param {object} [options={}] 选项
 * @param {number} [options.highThreshold=3] 高产日阈值
 * @returns {number} DENSITY_NONE / DENSITY_LOW / DENSITY_HIGH
 */
export function densityLevelOf (count, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const threshold = Number.isFinite(opts.highThreshold) && opts.highThreshold > 0
    ? Math.floor(opts.highThreshold)
    : DENSITY_HIGH_THRESHOLD
  const n = normalizeCount(count)
  if (n === 0) return DENSITY_NONE
  return n >= threshold ? DENSITY_HIGH : DENSITY_LOW
}

/**
 * 密度的完整描述（档位 + 文案 + 热度），视图直接绑样式。
 *
 * `heat` 是 0..1 的连续值，供需要连续渐变的场景（比如热力图透明度）使用；
 * `level` 是离散档位，供 class 切换使用。两者都由同一个阈值算出来，
 * 不会出现「class 说高产、透明度却很低」的分裂。
 *
 * @param {number} count 当天笔记数
 * @param {object} [options={}] 选项，见 `densityLevelOf`
 * @returns {{ count: number, level: number, label: string, heat: number, strong: boolean }}
 *          label ∈ 'none' | 'low' | 'high'
 */
export function densityOf (count, options = {}) {
  const n = normalizeCount(count)
  const level = densityLevelOf(n, options)
  const heat = level === DENSITY_NONE ? 0 : (level === DENSITY_LOW ? 0.45 : 1)
  return {
    count: n,
    level,
    label: level === DENSITY_NONE ? 'none' : (level === DENSITY_LOW ? 'low' : 'high'),
    heat,
    strong: level === DENSITY_HIGH
  }
}

/** 默认导出：把常用 API 聚成对象，方便一次性 import 后解构 */
export default {
  WEEK_START_MONDAY,
  WEEK_START_SUNDAY,
  DENSITY_NONE,
  DENSITY_LOW,
  DENSITY_HIGH,
  DENSITY_HIGH_THRESHOLD,
  DAYS_PER_WEEK,
  isLeapYear,
  daysInMonth,
  isValidYmd,
  isoOf,
  parseIso,
  toYmd,
  isoOfTs,
  storeKeyOf,
  startOfDayTs,
  weekdayOf,
  weekdayFromStart,
  addDays,
  addMonths,
  compareIso,
  weekdayLabels,
  makeDayCell,
  rowsFor,
  monthGrid,
  weekGrid,
  weekOfIso,
  dayRange,
  densityLevelOf,
  densityOf
}
