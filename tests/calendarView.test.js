/**
 * T33 + T37 + T38 · CalendarView 接入测试
 * ============================================================================
 * 内核（tests/calendarGrid.test.js）绿了不代表日历真的用上了它。本文件从两层
 * 把「接入」钉死：
 *
 *   A. 源码契约层：CalendarView.vue 必须真的 import 内核、真的走 store 的
 *      getNotesByDate（归属日期口径）、不再有「铺满 42 格」的写法。
 *
 *   B. 真实挂载层：用 vue + pinia + vue-router 把 CalendarView.vue 挂到 jsdom，
 *      注入不同日期来源的笔记，然后断言：
 *        · 有 frontmatter / 标题日期的笔记落在**归属日**而不是 updatedAt 那天；
 *        · 整张网格每格只取一次数（旧实现每渲染一次就 42 次全库扫描）；
 *        · 每分钟校准「今天」不再牵动任何取数（跨零点也只挪高亮）；
 *        · 月 / 周 / 议程互切不丢选中日期；
 *        · ④ 级（updatedAt）日期有可见信号。
 *
 * 为什么 B 层必须用假定时器（`vi.useFakeTimers`）：
 *   「每分钟刷新到底重算了什么」只有能手动拨表才测得出来。真实定时器下一次
 *   tick 要等 60 秒，没人会等；不拨表就只能写「应该没有副作用」这种谁都能过的
 *   空断言。拨表之后，跨零点那一次 tick 必须同时满足「取数次数 +0」与
 *   「今日高亮真的挪到了 16 号」—— 后者防止「因为 tick 根本没跑所以 +0」的假绿。
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import CalendarView from '@/views/CalendarView.vue'
import { useNoteStore } from '@/stores/note'
import { monthGrid } from '@/utils/calendarGrid'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const CALENDAR_SRC = fs.readFileSync(path.resolve(SCRIPT_DIR, '../src/views/CalendarView.vue'), 'utf8')

/** 测试用的「现在」：2020-05-15 10:00（本地时间） */
const NOW = new Date(2020, 4, 15, 10, 0, 0)
/** 第二天凌晨（跨零点用） */
const TOMORROW = new Date(2020, 4, 16, 0, 0, 5)
/** 2020-05 的网格格数（5 行 ×7） */
const MAY_2020_CELLS = monthGrid(2020, 5).cells.length

let app = null
let host = null

/** 造一篇笔记：只给索引真正会读的字段 */
function makeNote (id, title, content, updatedAt, folder = '') {
  return {
    id,
    title,
    content,
    updatedAt,
    createdAt: updatedAt,
    folder,
    tags: [],
    filePath: null
  }
}

/**
 * 六种日期来源的笔记，全部故意把 `updatedAt` 设成「今天/20 号」：
 *   n1 frontmatter date → 05-05      n2 标题日期串 → 05-05
 *   n3 什么都没有 → ④ 级 → 05-20     n4/n5/n6 frontmatter → 05-08（密度 high）
 * 若日历退回「按 updatedAt 归格」，05-05 会变成 0 篇、05-15 会变成 5 篇 ——
 * 这就是 B1 那条断言能变红的原因。
 */
function fixtureNotes () {
  const fr = (d) => `---\ndate: ${d}\n---\n\n正文内容`
  return [
    makeNote('n1', '甲：frontmatter 日期', fr('2020-05-05'), new Date(2020, 4, 15, 9, 0, 0)),
    makeNote('n2', '2020年5月5日 随笔', '正文', new Date(2020, 4, 15, 10, 0, 0)),
    makeNote('n3', '随手记', '正文', new Date(2020, 4, 20, 11, 0, 0)),
    makeNote('n4', '高产一', fr('2020-05-08'), new Date(2020, 4, 15, 12, 0, 0)),
    makeNote('n5', '高产二', fr('2020-05-08'), new Date(2020, 4, 15, 13, 0, 0)),
    makeNote('n6', '高产三', fr('2020-05-08'), new Date(2020, 4, 15, 14, 0, 0))
  ]
}

/**
 * 挂载日历。
 * 顺序很关键：先装假定时器（组件 onMounted 里的 setInterval 才会被接管），
 * 再把笔记塞进 store 并逐条进索引，最后才 mount —— 这样首屏渲染就是最终状态，
 * 探针数到的取数次数才等于「一格一次」而不是「两轮渲染」。
 *
 * @param {Array<object>} notes 笔记
 * @returns {Promise<{ store: object, spy: object }>}
 */
async function mountCalendar (notes) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useNoteStore()
  store.notes = notes
  for (const note of notes) store.reindexNote(note)

  const spy = vi.spyOn(store, 'getNotesByDate')

  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(CalendarView)
  app.use(pinia)
  app.use(createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }]
  }))
  app.mount(host)
  await nextTick()
  await nextTick()
  return { store, spy }
}

/** 取某一天的格子（月视图 / 周视图都带 data-iso） */
function cellOf (iso) {
  return host ? host.querySelector(`[data-iso="${iso}"]`) : null
}

/** 某一天格子里渲染出来的笔记条目数 */
function chipCount (iso) {
  const cell = cellOf(iso)
  if (!cell) return -1
  return cell.querySelectorAll('.day-note').length
}

/** 点某一天的格子（真实 DOM 事件，不走内部方法） */
function clickIso (iso) {
  const cell = cellOf(iso)
  if (!cell) return false
  cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}

/** 点视图切换按钮 */
function clickMode (mode) {
  const btn = host ? host.querySelector(`[data-mode="${mode}"]`) : null
  if (!btn) return false
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}

/** 底部面板里「选中日期」那一行 */
function footerTitle () {
  const box = host ? host.querySelector('[data-view] > div:nth-last-child(2)') : null
  return box ? box.textContent.replace(/\s+/g, ' ').trim() : ''
}

/** 今日高亮的数字（.day-number-today 只可能有一个） */
function todayNumber () {
  const el = host ? host.querySelector('.day-number-today') : null
  return el ? el.textContent.trim() : ''
}

beforeAll(() => {
  // jsdom 里所有盒子都是 0×0；日历不测量，但保持与 T35 一致的基线环境
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 1000, height: 800, top: 0, left: 0,
      right: 1000, bottom: 800, x: 0, y: 0, toJSON () {}
    }
  }
})

afterEach(() => {
  if (app) {
    app.unmount()
    app = null
  }
  if (host && host.parentNode) host.parentNode.removeChild(host)
  host = null
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// A · 源码契约层
// ---------------------------------------------------------------------------

describe('A · CalendarView.vue 源码契约（防倒退）', () => {
  it('A1 已接入 T37 内核与 T17 日期归属模块', () => {
    expect(CALENDAR_SRC).toContain("from '@/utils/calendarGrid.js'")
    expect(CALENDAR_SRC).toContain('monthGrid')
    expect(CALENDAR_SRC).toContain('densityOf')
    expect(CALENDAR_SRC).toContain("from '@/utils/dateAttribution.js'")
    expect(CALENDAR_SRC).toContain('resolveNoteDate')
  })

  it('A2 归格走 store 的 getNotesByDate（索引里按四级归属算好的 dateKey）', () => {
    expect(CALENDAR_SRC).toContain('getNotesByDate')
    // 旧实现那套「逐篇 new Date(updatedAt) 再比年月」的月统计必须消失
    expect(CALENDAR_SRC).not.toContain('d.getMonth() === currentMonth')
    expect(CALENDAR_SRC).not.toContain('new Date(note.updatedAt)')
  })

  it('A3 不再有「铺满 42 格」的写法（网格行数由内核算）', () => {
    expect(CALENDAR_SRC).not.toMatch(/42\s*-\s*days\.length/)
    expect(CALENDAR_SRC).not.toMatch(/remainingDays/)
  })

  it('A4 日期身份用 YYYY-MM-DD 字符串，不再是每格 new Date 的 today 对象', () => {
    expect(CALENDAR_SRC).toContain('todayIso')
    expect(CALENDAR_SRC).toContain('selectedIso')
    expect(CALENDAR_SRC).toContain('anchorIso')
  })

  it('A5 格子带 data-iso（本文件的断言依赖它，也是给 CDP 探针留的钩子）', () => {
    expect(CALENDAR_SRC).toContain(':data-iso="cell.iso"')
  })
})

// ---------------------------------------------------------------------------
// B · 真实挂载层
// ---------------------------------------------------------------------------

describe('B · 真实挂载：日历消费归属日期', () => {
  it('B1 frontmatter / 标题日期的笔记落在归属日，不是 updatedAt 那天', async () => {
    await mountCalendar(fixtureNotes())
    // n1（frontmatter）+ n2（标题）→ 05-05，虽然它们的 updatedAt 都是 05-15
    expect(chipCount('2020-05-05')).toBe(2)
    // n3 没有任何日期证据 → ④ 级 → 它就是自己的 updatedAt 那天 05-20
    expect(chipCount('2020-05-20')).toBe(1)
    // 关键反例：05-15 是 n1/n2/n4/n5/n6 的 updatedAt，但一篇都不该出现在那里
    expect(chipCount('2020-05-15')).toBe(0)
  })

  it('B1b 状态栏的本月统计与归属结果一致（6 篇 / 3 天）', async () => {
    await mountCalendar(fixtureNotes())
    const text = host.textContent.replace(/\s+/g, ' ')
    expect(text).toContain('本月共 6 篇笔记')
    expect(text).toContain('3 / 31 天')
  })

  it('B2 每格只取一次数：取数次数 === 网格格数（不是 2 倍、不是 42 次/轮渲染）', async () => {
    const { spy } = await mountCalendar(fixtureNotes())
    expect(MAY_2020_CELLS).toBe(35)
    expect(spy.mock.calls.length).toBe(MAY_2020_CELLS)
  })

  it('B3 每分钟校准 + 改选中日（两次都会让整张网格重渲染）：取数次数 +0', async () => {
    const { spy } = await mountCalendar(fixtureNotes())
    const before = spy.mock.calls.length
    vi.advanceTimersByTime(3 * 60 * 1000)
    await nextTick()
    // 换选中日 = 42 个格子全部重新渲染一遍。旧实现在模板里逐格 getDayNotes()，
    // 于是「点一下日历」就是 42 次全库扫描；现在必须一次都不取。
    expect(clickIso('2020-05-12')).toBe(true)
    await nextTick()
    await nextTick()
    expect(footerTitle()).toContain('5月12日') // 防止「压根没重渲染所以 +0」的假绿
    expect(spy.mock.calls.length - before).toBe(0)
  })

  it('B4 跨零点那次校准：取数次数 +0，但「今天」高亮真的挪到了新的一天', async () => {
    const { spy } = await mountCalendar(fixtureNotes())
    expect(todayNumber()).toBe('15')

    const before = spy.mock.calls.length
    vi.setSystemTime(TOMORROW)
    vi.advanceTimersByTime(60 * 1000) // 触发 onMounted 里那个每分钟的 interval
    await nextTick()
    await nextTick()

    // ① 取数一次都不重跑（网格那条 computed 不读 todayIso）
    expect(spy.mock.calls.length - before).toBe(0)
    // ② 但今天确实变了 —— 否则上面那条 +0 可能只是「tick 压根没跑」
    expect(todayNumber()).toBe('16')
  })

  it('B5 切换视图不丢选中日期（月 → 周 → 月）', async () => {
    await mountCalendar(fixtureNotes())
    expect(clickIso('2020-05-20')).toBe(true)
    await nextTick()
    expect(footerTitle()).toContain('5月20日')

    expect(clickMode('week')).toBe(true)
    await nextTick()
    expect(host.firstElementChild.getAttribute('data-view')).toBe('week')
    // 选中的那天必须在周视图里（2020-05-20 是周三 → 周一 05-18 ~ 周日 05-24）
    expect(cellOf('2020-05-20')).not.toBeNull()
    expect(footerTitle()).toContain('5月20日')

    expect(clickMode('month')).toBe(true)
    await nextTick()
    expect(host.firstElementChild.getAttribute('data-view')).toBe('month')
    expect(cellOf('2020-05-20').className).toContain('day-selected')
    expect(footerTitle()).toContain('5月20日')
  })

  it('B6 周视图给出连续 7 天，且切过去不再重新取数', async () => {
    const { spy } = await mountCalendar(fixtureNotes())
    const before = spy.mock.calls.length
    expect(clickMode('week')).toBe(true)
    await nextTick()
    const columns = host.querySelectorAll('[data-region="week-grid"] [data-iso]')
    expect(columns.length).toBe(7)
    expect(columns[0].getAttribute('data-iso')).toBe('2020-05-11')
    expect(columns[6].getAttribute('data-iso')).toBe('2020-05-17')
    // 周视图的天一定落在月网格覆盖的整周里 → 复用同一份桶，零额外取数
    expect(spy.mock.calls.length - before).toBe(0)
  })

  it('B6b 议程视图按日分组，只列有笔记的日子', async () => {
    await mountCalendar(fixtureNotes())
    expect(clickMode('agenda')).toBe(true)
    await nextTick()
    const days = host.querySelectorAll('[data-region="agenda"] [data-iso]')
    expect(Array.from(days).map(d => d.getAttribute('data-iso'))).toEqual([
      '2020-05-05', '2020-05-08', '2020-05-20'
    ])
    expect(host.textContent).toContain('高产 3 篇')
  })

  it('B7 ④ 级日期有可见信号：选中那篇时卡片上出现推测标记', async () => {
    await mountCalendar(fixtureNotes())
    expect(clickIso('2020-05-20')).toBe(true)
    await nextTick()
    // n3 没有 frontmatter / birthtime / 标题日期 → 来源是 updatedAt
    const badge = host.querySelector('[data-inferred]')
    expect(badge).not.toBeNull()
    expect(badge.getAttribute('data-inferred')).toBe('n3')
    expect(footerTitle()).toContain('1 篇日期为推测')
  })

  it('B7b 有确凿日期的笔记不带推测标记', async () => {
    await mountCalendar(fixtureNotes())
    expect(clickIso('2020-05-05')).toBe(true)
    await nextTick()
    expect(host.querySelector('[data-inferred]')).toBeNull()
    expect(footerTitle()).toContain('2 篇笔记')
    expect(footerTitle()).not.toContain('日期为推测')
  })

  it('B8 密度分级：≥3 篇的那天有 high 档样式，1-2 篇是 low 档', async () => {
    await mountCalendar(fixtureNotes())
    expect(cellOf('2020-05-08').className).toContain('day-density-high')
    expect(cellOf('2020-05-05').className).toContain('day-density-low')
    expect(cellOf('2020-05-20').className).toContain('day-density-low')
    // 没有笔记的那天不加任何密度类
    expect(cellOf('2020-05-01').className).not.toContain('day-density-')
  })

  it('B9 非本月格子与本月的格子类名可区分', async () => {
    await mountCalendar(fixtureNotes())
    // 2020-05-01 是周五 → 前导 4 天，04-27 ~ 04-30 是非本月
    expect(cellOf('2020-04-27').className).toContain('day-other-month')
    expect(cellOf('2020-05-01').className).not.toContain('day-other-month')
  })

  it('B10 翻到平年 2 月首日周一的月份：不再多出下个月的一整行', async () => {
    await mountCalendar(fixtureNotes())
    // 2021-02 是硬用例：4 行 28 格，3 月一天都不露。这里从界面层复核一次：
    // 连点 9 次「下一段」= 2021-02，网格里不应出现任何 3 月的格子
    for (let i = 0; i < 9; i += 1) {
      const btn = host.querySelector('button[title="下一段"]')
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    }
    await nextTick()
    expect(host.textContent).toContain('2021年2月')
    const cells = Array.from(host.querySelectorAll('[data-region="month-grid"] [data-iso]'))
    expect(cells.length).toBe(28)
    expect(cells.some(c => c.getAttribute('data-iso').startsWith('2021-03'))).toBe(false)
    expect(cells.some(c => c.getAttribute('data-iso').startsWith('2021-01'))).toBe(false)
  })
})
