/**
 * T37 · 日历网格 / 周视图 / 密度分级 内核测试
 * ============================================================================
 * 本文件**刻意不 import vue / pinia**（也不 import 任何组件）—— 被测对象
 * `src/utils/calendarGrid.js` 是零 import 纯函数，测试也必须是纯的。
 * 「日历真的消费了归属日期」那类集成断言放在 tests/calendarView.test.js。
 *
 * 覆盖的六组不变量：
 *   A 网格行数（含「平年 2 月首日周一」这个硬用例：4 行，不出现下个月）
 *   B 单元格字段与跨月 / 跨年边界
 *   C 周视图（含跨月、跨年、两种周首日）
 *   D 密度分级（0 / 1-2 / ≥3）
 *   E 时区与夏令时（日期键必须与 noteIndex.dateKeyOf 同口径：本地日历日）
 *   F dayRange 与加减月份等杂项
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WEEK_START_MONDAY,
  WEEK_START_SUNDAY,
  DENSITY_NONE,
  DENSITY_LOW,
  DENSITY_HIGH,
  DENSITY_HIGH_THRESHOLD,
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
} from '@/utils/calendarGrid'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const NOTE_INDEX_SRC = fs.readFileSync(path.resolve(SCRIPT_DIR, '../src/utils/noteIndex.js'), 'utf8')

/** 取网格里属于某个月 / 不属于某个月的格子 */
const inMonthCells = (grid) => grid.cells.filter(c => c.inMonth)
const otherMonthCells = (grid) => grid.cells.filter(c => !c.inMonth)

// ===========================================================================
// A · 网格行数
// ===========================================================================

describe('A · 网格行数（修「恒 6 行」bug）', () => {
  it('A1 硬用例：平年 2 月首日周一 → 4 行，且完全不出现下个月', () => {
    // 2021-02-01 是周一，2021 不是闰年，2 月正好 28 天 = 4 整周
    expect(weekdayOf(2021, 2, 1)).toBe(1)
    expect(isLeapYear(2021)).toBe(false)

    const grid = monthGrid(2021, 2)
    expect(grid.valid).toBe(true)
    expect(grid.daysInMonth).toBe(28)
    expect(grid.leading).toBe(0)
    expect(grid.rows).toBe(4)
    expect(grid.trailing).toBe(0)
    expect(grid.cells.length).toBe(28)
    // 「不出现超过一行的下个月」更强的说法：这里一行都没有
    expect(otherMonthCells(grid).length).toBe(0)
    expect(grid.gridStartIso).toBe('2021-02-01')
    expect(grid.gridEndIso).toBe('2021-02-28')
  })

  it('A1b 换成 2027（同样是平年 2 月首日周一）结论一致', () => {
    expect(weekdayOf(2027, 2, 1)).toBe(1)
    const grid = monthGrid(2027, 2)
    expect(grid.rows).toBe(4)
    expect(grid.trailing).toBe(0)
  })

  it('A2 同一个月按「周日为首」排 → 5 行（前导 1 天）', () => {
    const grid = monthGrid(2021, 2, { weekStartsOn: WEEK_START_SUNDAY })
    expect(grid.leading).toBe(1)
    expect(grid.rows).toBe(5) // ceil((1 + 28) / 7)
    expect(grid.trailing).toBe(6)
    // 旧的 42 格实现在这里是 6 行 —— 多出来的一整行全是 3 月
    expect(grid.cells.length).toBe(35)
  })

  it('A3 闰年 2 月首日周一（2016-02）→ 5 行，下个月只露一行', () => {
    expect(isLeapYear(2016)).toBe(true)
    expect(weekdayOf(2016, 2, 1)).toBe(1)
    const grid = monthGrid(2016, 2)
    expect(grid.daysInMonth).toBe(29)
    expect(grid.leading).toBe(0)
    expect(grid.rows).toBe(5)
    expect(grid.trailing).toBe(6)
    expect(grid.trailing).toBeLessThan(7)
  })

  it('A4 首日周日（2026-03）→ 周一为首时前导 6 天，6 行', () => {
    expect(weekdayOf(2026, 3, 1)).toBe(0)
    const grid = monthGrid(2026, 3)
    expect(grid.leading).toBe(6)
    expect(grid.daysInMonth).toBe(31)
    expect(grid.rows).toBe(6)
    // 6 行 42 格 - 前导 6 - 31 天 = 5 天下个月（不到一行）
    expect(grid.trailing).toBe(5)
  })

  it('A5 首日周六（2026-08）→ 前导 5 天，6 行，下个月不足一行', () => {
    expect(weekdayOf(2026, 8, 1)).toBe(6)
    const grid = monthGrid(2026, 8)
    expect(grid.leading).toBe(5)
    expect(grid.rows).toBe(6)
    expect(grid.trailing).toBe(6)
    expect(grid.trailing).toBeLessThan(7)
  })

  it('A6 扫 1900-2100 全部月份：行数恒在 4..6，且等于最小所需行数', () => {
    for (let y = 1900; y <= 2100; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const grid = monthGrid(y, m)
        expect(grid.rows).toBeGreaterThanOrEqual(4)
        expect(grid.rows).toBeLessThanOrEqual(6)
        expect(grid.rows).toBe(Math.ceil((grid.leading + grid.daysInMonth) / 7))
        expect(grid.cells.length).toBe(grid.rows * 7)
        expect(grid.trailing).toBeLessThan(7)
        expect(inMonthCells(grid).length).toBe(grid.daysInMonth)
      }
    }
  })

  it('A7 rowsFor 与 monthGrid.rows 永远一致（含两种周首日）', () => {
    for (let y = 2020; y <= 2030; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        for (const ws of [WEEK_START_MONDAY, WEEK_START_SUNDAY]) {
          expect(rowsFor(y, m, { weekStartsOn: ws })).toBe(monthGrid(y, m, { weekStartsOn: ws }).rows)
        }
      }
    }
  })

  it('A8 minRows: 6 可以把网格固定成 6 行（调用方要稳定高度时用）', () => {
    const grid = monthGrid(2021, 2, { minRows: 6 })
    expect(grid.rows).toBe(6)
    expect(grid.cells.length).toBe(42)
    expect(grid.trailing).toBe(14)
  })

  it('A9 非法月份不抛异常，返回空网格', () => {
    for (const bad of [[2026, 0], [2026, 13], [NaN, 5], [2026, 'x']]) {
      const grid = monthGrid(bad[0], bad[1])
      expect(grid.valid).toBe(false)
      expect(grid.rows).toBe(0)
      expect(grid.cells.length).toBe(0)
    }
    expect(rowsFor(2026, 0)).toBe(0)
  })
})

// ===========================================================================
// B · 单元格与跨月 / 跨年边界
// ===========================================================================

describe('B · 单元格与跨月边界', () => {
  it('B1 上个月尾巴：2026-03 的前 6 格是 2 月 23-28 日且 inMonth=false', () => {
    const grid = monthGrid(2026, 3)
    const head = grid.cells.slice(0, 6).map(c => c.iso)
    expect(head).toEqual([
      '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28'
    ])
    expect(grid.cells.slice(0, 6).every(c => c.inMonth === false)).toBe(true)
  })

  it('B2 下个月开头：2026-02（首日周日）的下月格只有 3 月 1-6 日以内', () => {
    const grid = monthGrid(2026, 2)
    expect(grid.rows).toBe(5)
    const tail = otherMonthCells(grid)
    // 前导 6 天（1 月）+ 28 天 = 34，第 35 格是 3 月 1 日
    expect(tail.length).toBe(6 + 1)
    expect(tail[tail.length - 1].iso).toBe('2026-03-01')
    expect(tail[tail.length - 1].inMonth).toBe(false)
  })

  it('B3 跨年：2025-12 的网格尾部出现 2026-01，且标记为非本月', () => {
    const grid = monthGrid(2025, 12)
    const tail = otherMonthCells(grid)
    expect(tail.some(c => c.year === 2026 && c.month === 1)).toBe(true)
    expect(tail.every(c => c.inMonth === false)).toBe(true)
    expect(inMonthCells(grid).every(c => c.year === 2025 && c.month === 12)).toBe(true)
  })

  it('B4 跨年：2026-01 的网格头部出现 2025-12', () => {
    const grid = monthGrid(2026, 1)
    const head = otherMonthCells(grid)
    expect(head.some(c => c.year === 2025 && c.month === 12)).toBe(true)
  })

  it('B5 单元格严格升序、逐日 +1、无重复（扫 2019-2027 + 三个世纪闰年边界）', () => {
    const months = []
    for (let y = 2019; y <= 2027; y += 1) {
      for (let m = 1; m <= 12; m += 1) months.push([y, m])
    }
    months.push([1900, 2], [2000, 2], [2100, 2])
    for (const [y, m] of months) {
      const grid = monthGrid(y, m)
      const seen = new Set()
      for (let i = 0; i < grid.cells.length; i += 1) {
        const cell = grid.cells[i]
        expect(seen.has(cell.iso)).toBe(false)
        seen.add(cell.iso)
        if (i === 0) continue
        const prev = grid.cells[i - 1]
        // 用「本地 +1 天」推进来比对，不比 ts 差值（夏令时那天是 23h/25h）
        const next = addDays(prev.year, prev.month, prev.date, 1)
        expect(cell.iso).toBe(isoOf(next.year, next.month, next.date))
      }
    }
  })

  it('B6 iso / key / ts 三者恒指向同一个日历日', () => {
    const grid = monthGrid(2026, 3)
    for (const cell of grid.cells) {
      expect(isoOfTs(cell.ts)).toBe(cell.iso)
      expect(storeKeyOf(cell.ts)).toBe(cell.key)
      // 反解：把 toDateString() 的串喂回 Date，必须得到同一个本地零点
      expect(new Date(cell.key).getTime()).toBe(cell.ts)
      expect(cell.monthIndex).toBe(cell.month - 1)
    }
  })

  it('B7 周末标记与周首日偏移正确', () => {
    const grid = monthGrid(2026, 3) // 3 月 1 日是周日
    for (const cell of grid.cells) {
      expect(cell.isWeekend).toBe(weekdayOf(cell.year, cell.month, cell.date) % 6 === 0)
      expect(cell.weekday).toBe(weekdayFromStart(cell.year, cell.month, cell.date, WEEK_START_MONDAY))
    }
    // 周一为首时，周日的偏移是 6
    expect(weekdayFromStart(2026, 3, 1, WEEK_START_MONDAY)).toBe(6)
    expect(weekdayFromStart(2026, 3, 1, WEEK_START_SUNDAY)).toBe(0)
  })

  it('B8 makeDayCell 非法入参返回 valid:false 的空壳，不抛异常', () => {
    const bad = makeDayCell(2026, 2, 30)
    expect(bad.valid).toBe(false)
    expect(bad.iso).toBe('')
    expect(makeDayCell(2026, 13, 1).valid).toBe(false)
    expect(makeDayCell('x', 1, 1).valid).toBe(false)
  })

  it('B9 offset：月首日为 0，之前为负，之后为正', () => {
    const grid = monthGrid(2026, 3) // leading = 6
    expect(grid.cells[0].offset).toBe(-6)
    expect(grid.cells[6].offset).toBe(0)
    expect(grid.cells[7].offset).toBe(1)
  })
})

// ===========================================================================
// C · 周视图
// ===========================================================================

describe('C · 周视图（连续 7 天）', () => {
  it('C1 2026-03-15（周日）所在的周：周一为首 → 03-09 ~ 03-15', () => {
    const week = weekGrid(2026, 3, 15)
    expect(week.valid).toBe(true)
    expect(week.startIso).toBe('2026-03-09')
    expect(week.endIso).toBe('2026-03-15')
    expect(week.days.map(d => d.iso)).toEqual([
      '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15'
    ])
  })

  it('C2 跨月：2026-04-01（周三）所在的周跨 3 月 / 4 月', () => {
    const week = weekGrid(2026, 4, 1)
    expect(week.startIso).toBe('2026-03-30')
    expect(week.endIso).toBe('2026-04-05')
    expect(week.days.filter(d => d.month === 3).length).toBe(2)
    expect(week.days.filter(d => d.month === 4).length).toBe(5)
  })

  it('C3 跨年：2025-01-01（周三）所在的周是 2024-12-30 ~ 2025-01-05', () => {
    const week = weekGrid(2025, 1, 1)
    expect(week.startIso).toBe('2024-12-30')
    expect(week.endIso).toBe('2025-01-05')
    expect(week.days[0].year).toBe(2024)
    expect(week.days[6].year).toBe(2025)
  })

  it('C4 2024-12-31 与 2025-01-01 落在同一周', () => {
    expect(weekGrid(2024, 12, 31).weekKey).toBe(weekGrid(2025, 1, 1).weekKey)
    expect(weekGrid(2024, 12, 31).startIso).toBe('2024-12-30')
  })

  it('C5 周日为首：2026-03-15 所在的周是 03-15 ~ 03-21', () => {
    const week = weekGrid(2026, 3, 15, { weekStartsOn: WEEK_START_SUNDAY })
    expect(week.startIso).toBe('2026-03-15')
    expect(week.endIso).toBe('2026-03-21')
  })

  it('C6 恒 7 天、含入参那天、首格偏移为 0', () => {
    for (const [y, m, d] of [[2026, 3, 15], [2026, 1, 1], [2024, 2, 29], [2026, 12, 31]]) {
      const week = weekGrid(y, m, d)
      expect(week.days.length).toBe(7)
      expect(week.days.some(c => c.iso === isoOf(y, m, d))).toBe(true)
      expect(week.days[0].weekday).toBe(0)
    }
  })

  it('C7 weekOfIso 与 weekGrid 完全一致；非法入参返回空壳', () => {
    expect(weekOfIso('2026-03-15').startIso).toBe(weekGrid(2026, 3, 15).startIso)
    expect(weekOfIso('2024-12-31').endIso).toBe('2025-01-05')
    const bad = weekOfIso('2026-02-30')
    expect(bad.valid).toBe(false)
    expect(bad.days.length).toBe(0)
    expect(weekOfIso(null).valid).toBe(false)
  })

  it('C8 扫 2026 全年：每周 7 天、周内连续、weekKey 单调不减', () => {
    let cur = { year: 2026, month: 1, date: 1 }
    let lastKey = ''
    for (let i = 0; i < 365; i += 1) {
      const week = weekGrid(cur.year, cur.month, cur.date)
      expect(week.days.length).toBe(7)
      expect(compareIso(week.weekKey, lastKey)).toBeGreaterThanOrEqual(0)
      lastKey = week.weekKey
      for (let k = 1; k < 7; k += 1) {
        const prev = week.days[k - 1]
        const expectNext = addDays(prev.year, prev.month, prev.date, 1)
        expect(week.days[k].iso).toBe(isoOf(expectNext.year, expectNext.month, expectNext.date))
      }
      cur = addDays(cur.year, cur.month, cur.date, 1)
    }
  })

  it('C9 周内的「非本月」标记只按年月判定（不靠下标）', () => {
    const week = weekGrid(2026, 4, 1)
    // 锚定月是 4 月，所以 3 月 30/31 两格是非本月
    expect(week.days[0].inMonth).toBe(false)
    expect(week.days[1].inMonth).toBe(false)
    expect(week.days[2].inMonth).toBe(true)
  })
})

// ===========================================================================
// D · 密度分级
// ===========================================================================

describe('D · 密度分级（0 / 1-2 / ≥3）', () => {
  it('D1 0 篇 → none', () => {
    expect(densityLevelOf(0)).toBe(DENSITY_NONE)
    expect(densityOf(0).label).toBe('none')
    expect(densityOf(0).heat).toBe(0)
  })

  it('D2 1 篇 → low', () => {
    expect(densityLevelOf(1)).toBe(DENSITY_LOW)
    expect(densityOf(1).label).toBe('low')
  })

  it('D3 2 篇 → low（阈值是 3，不是 2）', () => {
    expect(densityLevelOf(2)).toBe(DENSITY_LOW)
    expect(densityOf(2).label).toBe('low')
  })

  it('D4 3 篇 → high', () => {
    expect(densityLevelOf(3)).toBe(DENSITY_HIGH)
    expect(densityOf(3).label).toBe('high')
    expect(densityOf(3).strong).toBe(true)
    expect(densityOf(3).heat).toBe(1)
  })

  it('D5 10 篇仍然是 high（不新增档位）', () => {
    expect(densityLevelOf(10)).toBe(DENSITY_HIGH)
    expect(densityOf(10).count).toBe(10)
  })

  it('D6 阈值可配：highThreshold=4 时 3 篇算 low', () => {
    expect(densityLevelOf(3, { highThreshold: 4 })).toBe(DENSITY_LOW)
    expect(densityLevelOf(4, { highThreshold: 4 })).toBe(DENSITY_HIGH)
  })

  it('D7 负数 / NaN / 字符串 / 小数一律按 0 或向下取整处理，不抛异常', () => {
    expect(densityLevelOf(-1)).toBe(DENSITY_NONE)
    expect(densityLevelOf(NaN)).toBe(DENSITY_NONE)
    expect(densityLevelOf(undefined)).toBe(DENSITY_NONE)
    expect(densityLevelOf(null)).toBe(DENSITY_NONE)
    expect(densityOf('3').level).toBe(DENSITY_HIGH)
    expect(densityOf(2.9).count).toBe(2)
  })

  it('D8 0..50 篇的档位只可能是 0/1/2，且随篇数单调不减', () => {
    let prev = 0
    for (let n = 0; n <= 50; n += 1) {
      const level = densityLevelOf(n)
      expect([DENSITY_NONE, DENSITY_LOW, DENSITY_HIGH]).toContain(level)
      expect(level).toBeGreaterThanOrEqual(prev)
      prev = level
    }
  })

  it('D9 默认阈值常量就是 3，且与档位常量自洽', () => {
    expect(DENSITY_HIGH_THRESHOLD).toBe(3)
    expect(densityLevelOf(DENSITY_HIGH_THRESHOLD)).toBe(DENSITY_HIGH)
    expect(densityLevelOf(DENSITY_HIGH_THRESHOLD - 1)).toBe(DENSITY_LOW)
  })
})

// ===========================================================================
// E · 时区 / 夏令时
// ===========================================================================

describe('E · 时区与夏令时（日期键 = 本地日历日）', () => {
  it('E1 跨夏令时的那一刻仍归当天（美国 2026-03-08 / 2026-11-01，欧洲 2026-03-29）', () => {
    expect(isoOfTs(new Date(2026, 2, 8, 0, 30, 0))).toBe('2026-03-08')
    expect(isoOfTs(new Date(2026, 2, 8, 12, 0, 0))).toBe('2026-03-08')
    expect(isoOfTs(new Date(2026, 10, 1, 1, 30, 0))).toBe('2026-11-01')
    expect(isoOfTs(new Date(2026, 2, 29, 12, 0, 0))).toBe('2026-03-29')
  })

  it('E2 扫 2026 全年：当天 00:00 与 23:59 得到同一个 iso，且等于 isoOf(y,m,d)', () => {
    let cur = { year: 2026, month: 1, date: 1 }
    for (let i = 0; i < 365; i += 1) {
      const iso = isoOf(cur.year, cur.month, cur.date)
      const midnight = startOfDayTs(cur.year, cur.month, cur.date)
      const late = new Date(cur.year, cur.month - 1, cur.date, 23, 59, 59, 999).getTime()
      expect(isoOfTs(midnight)).toBe(iso)
      expect(isoOfTs(late)).toBe(iso)
      cur = addDays(cur.year, cur.month, cur.date, 1)
    }
  })

  it('E3 全年 365 天得到 365 个互不相同的 iso（无重复 / 无跳日）', () => {
    const seen = new Set()
    let cur = { year: 2026, month: 1, date: 1 }
    for (let i = 0; i < 365; i += 1) {
      seen.add(isoOfTs(startOfDayTs(cur.year, cur.month, cur.date)))
      cur = addDays(cur.year, cur.month, cur.date, 1)
    }
    expect(seen.size).toBe(365)
  })

  it('E4 绝不使用 UTC 口径：本地 00:30 在东时区里 UTC 日期是前一天', () => {
    const early = new Date(2026, 6, 1, 0, 30, 0)
    expect(isoOfTs(early)).toBe('2026-07-01')
    const offsetMinutes = -early.getTimezoneOffset()
    if (offsetMinutes > 0) {
      // toISOString() 会给出前一天 —— 内核必须不是这么算的
      expect(early.toISOString().slice(0, 10)).toBe('2026-06-30')
      expect(new Date(early).getUTCDate()).toBe(30)
    } else {
      // UTC / 西时区下两者相同，这里只记录事实，不改变结论
      expect(early.toISOString().slice(0, 10)).toBe('2026-07-01')
    }
  })

  it('E5 ISO 串按「逐分量」解析，不走 new Date(str) 的 UTC 解释', () => {
    expect(isoOfTs('2026-03-15')).toBe('2026-03-15')
    expect(toYmd('2026-03-15')).toEqual({ year: 2026, month: 3, date: 15 })
    // 严格格式：一位月日不认（否则 '2026-3-5T00:00:00Z' 会差一天）
    expect(parseIso('2026-3-5')).toBeNull()
    expect(parseIso('2026-02-30')).toBeNull()
    expect(parseIso('2026-13-01')).toBeNull()
    expect(parseIso('')).toBeNull()
    expect(parseIso(null)).toBeNull()
  })

  it('E6 storeKeyOf 与 noteIndex.dateKeyOf 同口径（源码契约 + 行为对齐）', () => {
    // 源码层：dateKeyOf 的实现就是 new Date(value).toDateString()
    expect(NOTE_INDEX_SRC).toMatch(/function dateKeyOf[\s\S]{0,200}new Date\(value\)\.toDateString\(\)/)
    // 行为层：两者对同一时间戳必须落在同一个日历日
    const samples = [
      new Date(2026, 2, 15, 0, 0, 0),
      new Date(2026, 2, 8, 23, 59, 59),
      new Date(2025, 11, 31, 12, 0, 0),
      new Date(2024, 1, 29, 6, 0, 0)
    ]
    for (const d of samples) {
      const key = storeKeyOf(d.getTime())
      expect(key).toBe(new Date(d.getTime()).toDateString())
      expect(isoOfTs(new Date(key).getTime())).toBe(isoOfTs(d.getTime()))
    }
  })

  it('E7 startOfDayTs 恒为本地 00:00:00.000', () => {
    const ts = startOfDayTs(2026, 3, 15)
    const d = new Date(ts)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(d.getMilliseconds()).toBe(0)
    expect(d.getDate()).toBe(15)
    expect(startOfDayTs(2026, 2, 30)).toBeNull()
  })

  it('E8 夏令时那天的 +1 天推进不会重复 / 跳过（用 iso 序列断言）', () => {
    // 覆盖美国（3 月第 2 个周日）与欧洲（3 月最后一个周日）两个切换点
    for (const [y, m, d] of [[2026, 3, 7], [2026, 3, 28], [2026, 10, 31]]) {
      const seq = []
      let cur = { year: y, month: m, date: d }
      for (let i = 0; i < 4; i += 1) {
        seq.push(isoOf(cur.year, cur.month, cur.date))
        cur = addDays(cur.year, cur.month, cur.date, 1)
      }
      expect(new Set(seq).size).toBe(4)
      expect(seq[0]).toBe(isoOf(y, m, d))
      // 连续两天之间必须只差 1 天：用 Date 的本地分量反推验证
      for (let i = 1; i < seq.length; i += 1) {
        const a = parseIso(seq[i - 1])
        const b = parseIso(seq[i])
        const diff = Math.round(
          (startOfDayTs(b.year, b.month, b.date) - startOfDayTs(a.year, a.month, a.date)) / 3600000
        )
        expect(diff === 23 || diff === 24 || diff === 25).toBe(true)
      }
    }
  })
})

// ===========================================================================
// F · dayRange 与杂项
// ===========================================================================

describe('F · dayRange / 加减月份 / 表头', () => {
  it('F1 单日区间返回 1 格', () => {
    const range = dayRange('2026-03-15', '2026-03-15')
    expect(range.length).toBe(1)
    expect(range[0].iso).toBe('2026-03-15')
  })

  it('F2 跨月区间（议程视图整月）', () => {
    const range = dayRange('2026-03-01', '2026-03-31', { inMonth: true })
    expect(range.length).toBe(31)
    expect(range[0].iso).toBe('2026-03-01')
    expect(range[30].iso).toBe('2026-03-31')
    expect(range.every(c => c.inMonth === true)).toBe(true)
    // 默认不带选项时 inMonth 为 false（议程之外的使用方自己决定怎么标）
    expect(dayRange('2026-03-01', '2026-03-02')[0].inMonth).toBe(false)
  })

  it('F3 跨年区间', () => {
    const range = dayRange('2025-12-28', '2026-01-03')
    expect(range.length).toBe(7)
    expect(range[0].year).toBe(2025)
    expect(range[6].year).toBe(2026)
  })

  it('F4 起始晚于结束 / 非法入参 → 空数组，不抛异常', () => {
    expect(dayRange('2026-03-15', '2026-03-01')).toEqual([])
    expect(dayRange('bad', '2026-03-01')).toEqual([])
    expect(dayRange(null, null)).toEqual([])
  })

  it('F5 addDays 跨月跨年与闰年', () => {
    expect(addDays(2026, 1, 1, -1)).toEqual({ year: 2025, month: 12, date: 31 })
    expect(addDays(2026, 12, 31, 1)).toEqual({ year: 2027, month: 1, date: 1 })
    expect(addDays(2024, 2, 28, 1)).toEqual({ year: 2024, month: 2, date: 29 })
    expect(addDays(2025, 2, 28, 1)).toEqual({ year: 2025, month: 3, date: 1 })
    expect(addDays(2026, 2, 30, 1)).toBeNull()
  })

  it('F6 addMonths 跨年与归一化', () => {
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
    expect(addMonths(2026, 3, -14)).toEqual({ year: 2025, month: 1 })
    expect(addMonths(2026, 0, 1)).toBeNull()
  })

  it('F7 compareIso 与 ISO 字典序一致', () => {
    expect(compareIso('2026-03-15', '2026-03-16')).toBe(-1)
    expect(compareIso('2026-03-15', '2026-03-15')).toBe(0)
    expect(compareIso('2027-01-01', '2026-12-31')).toBe(1)
  })

  it('F8 daysInMonth / isLeapYear / isValidYmd 的世纪闰年边界', () => {
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(2100)).toBe(false)
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(isValidYmd(2026, 2, 29)).toBe(false)
    expect(isValidYmd(2024, 2, 29)).toBe(true)
  })

  it('F9 表头文案支持两种周首日，且返回副本（改它不影响常量）', () => {
    expect(weekdayLabels(WEEK_START_MONDAY)[0]).toBe('周一')
    expect(weekdayLabels(WEEK_START_SUNDAY)[0]).toBe('周日')
    const copy = weekdayLabels()
    copy[0] = '被改坏了'
    expect(weekdayLabels()[0]).toBe('周一')
  })

  it('F10 monthGrid 的 weeks 是 7 的倍数且等于 cells 切片', () => {
    const grid = monthGrid(2026, 3)
    expect(grid.weeks.length).toBe(grid.rows)
    expect(grid.weeks.every(w => w.length === 7)).toBe(true)
    expect(grid.weeks[0][0].iso).toBe(grid.cells[0].iso)
    expect(grid.weeks[grid.rows - 1][6].iso).toBe(grid.cells[grid.cells.length - 1].iso)
  })
})
