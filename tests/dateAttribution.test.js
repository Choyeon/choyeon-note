import { describe, it, expect } from 'vitest'
import {
  DATE_SOURCE,
  DATE_SOURCES,
  DATE_KEYS,
  toISODate,
  parseFrontmatterDate,
  extractDateFromTitle,
  resolveNoteDate
} from '../src/utils/dateAttribution.js'

// ---------------------------------------------------------------------------
// 测试基线
// ---------------------------------------------------------------------------

/**
 * 期望值一律用「本地时间构造函数」造，绝不用 `Date.UTC` / ISO 串：
 * 本模块的语义就是「本地日历日」，若期望值按 UTC 造，换台机器（或换个 TZ）
 * 测试就会假红 —— 那测的就不是模块，是时区。
 *
 * @param {number} y 年
 * @param {number} m 月（1-12）
 * @param {number} d 日
 * @returns {number} 本地 00:00:00 的毫秒时间戳
 */
const localTs = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0, 0).getTime()

/** 一个固定的「现在」，注入给被测函数，保证用例与真实时钟无关 */
const NOW = localTs(2026, 6, 1)

/** 造一篇带 frontmatter 的笔记全文 */
const doc = (block, body = '# 正文\n') => `---\n${block}\n---\n${body}`

// ---------------------------------------------------------------------------
// 1. 常量契约（T18 与 UI 会按 source 分支，取值必须稳定）
// ---------------------------------------------------------------------------

describe('dateAttribution · 常量契约', () => {
  it('DATE_SOURCES 就是四级回落的顺序', () => {
    expect(DATE_SOURCES).toEqual(['frontmatter', 'birthtime', 'title', 'updatedAt'])
  })

  it('DATE_SOURCE 的四个取值与 DATE_SOURCES 一一对应', () => {
    expect(DATE_SOURCE.FRONTMATTER).toBe('frontmatter')
    expect(DATE_SOURCE.BIRTHTIME).toBe('birthtime')
    expect(DATE_SOURCE.TITLE).toBe('title')
    expect(DATE_SOURCE.UPDATED_AT).toBe('updatedAt')
    expect(Object.values(DATE_SOURCE)).toEqual(DATE_SOURCES)
  })

  it('DATE_KEYS 以 date 打头（迁移写入的规范化键必须最优先）', () => {
    expect(DATE_KEYS[0]).toBe('date')
    expect(DATE_KEYS).toEqual(['date', 'created', 'created_at', 'createdAt'])
  })
})

// ---------------------------------------------------------------------------
// 2. frontmatter 解析
// ---------------------------------------------------------------------------

describe('dateAttribution · parseFrontmatterDate', () => {
  it('认 date: 2026-03-15', () => {
    expect(parseFrontmatterDate(doc('date: 2026-03-15'))).toBe(localTs(2026, 3, 15))
  })

  it('兼容 created: / created_at: / createdAt:', () => {
    expect(parseFrontmatterDate(doc('created: 2026-03-15'))).toBe(localTs(2026, 3, 15))
    expect(parseFrontmatterDate(doc('created_at: 2026-03-15'))).toBe(localTs(2026, 3, 15))
    expect(parseFrontmatterDate(doc('createdAt: 2026-03-15'))).toBe(localTs(2026, 3, 15))
  })

  it('键名大小写不敏感（手写 frontmatter 不该因为 Date: 就失效）', () => {
    expect(parseFrontmatterDate(doc('Date: 2026-03-15'))).toBe(localTs(2026, 3, 15))
  })

  it('date: 永远赢 created:（按键名优先级，不按行序）', () => {
    const block = 'created: 2020-01-01\ndate: 2026-03-15'
    expect(parseFrontmatterDate(doc(block))).toBe(localTs(2026, 3, 15))
  })

  it('同一个键出现两次时先写先赢', () => {
    const block = 'date: 2026-03-15\ndate: 2020-01-01'
    expect(parseFrontmatterDate(doc(block))).toBe(localTs(2026, 3, 15))
  })

  it('剥掉成对引号', () => {
    expect(parseFrontmatterDate(doc('date: "2026-03-15"'))).toBe(localTs(2026, 3, 15))
    expect(parseFrontmatterDate(doc("date: '2026-03-15'"))).toBe(localTs(2026, 3, 15))
  })

  it('可带时间：日期部分仍落在同一天', () => {
    const ts = parseFrontmatterDate(doc('date: 2026-03-15 10:30'))
    expect(ts).toBe(new Date(2026, 2, 15, 10, 30, 0, 0).getTime())
  })

  it('带 Z 的按 UTC 解释', () => {
    const ts = parseFrontmatterDate(doc('date: 2026-03-15T10:30:00Z'))
    expect(ts).toBe(Date.UTC(2026, 2, 15, 10, 30, 0))
  })

  it('20260315 按日期解释，而不是被当毫秒时间戳（YAML 经典坑）', () => {
    expect(parseFrontmatterDate(doc('date: 20260315'))).toBe(localTs(2026, 3, 15))
    // 反证：若被当成毫秒，它会落在 1970 年
    expect(parseFrontmatterDate(doc('date: 20260315'))).not.toBe(20260315)
  })

  it('13 位整数按毫秒级时间戳解释', () => {
    const ms = new Date(2026, 0, 1, 12, 30).getTime()
    expect(parseFrontmatterDate(doc(`date: ${ms}`))).toBe(ms)
  })

  it('10 位整数（落在 2001~2100）按秒级时间戳解释', () => {
    const ms = new Date(2026, 0, 1, 12, 30).getTime()
    const sec = Math.floor(ms / 1000)
    expect(parseFrontmatterDate(doc(`date: ${sec}`))).toBe(sec * 1000)
  })

  it('无围栏的 date: 一律不算 frontmatter（与 useLinks 的 hasFrontmatter 同口径）', () => {
    expect(parseFrontmatterDate('date: 2026-03-15\n\n# 正文')).toBe(null)
  })

  it('有围栏但没有日期键 → null', () => {
    expect(parseFrontmatterDate(doc('tags: [a, b]\ntitle: 无日期'))).toBe(null)
  })

  it('值存在但不可解析 → null（由调用方往下掉一级，绝不返回 NaN）', () => {
    expect(parseFrontmatterDate(doc('date: 待定'))).toBe(null)
    expect(parseFrontmatterDate(doc('date: 2026-13-45'))).toBe(null)
  })

  // 这一条是本模块与 useLinks.parseFrontmatter 的**唯一一处刻意差异**：
  // useLinks 的 header 正则遇到 CRLF 会整行匹配失败（`.` 不吃 \r），于是 CRLF
  // 文件的 frontmatter 被解析成空对象。本模块在行级剥掉 \r，读得到日期。
  // 围栏定义 / 键名规则仍然与 useLinks 逐字一致。
  it('CRLF 行尾也能解析（行级剥 \\r，比 useLinks 多一层容错）', () => {
    expect(parseFrontmatterDate('---\r\ndate: 2026-03-15\r\n---\r\n')).toBe(localTs(2026, 3, 15))
  })

  it('单值入参直接当日期标量解析（T18 做写入/读出往返校验时用）', () => {
    expect(parseFrontmatterDate('2026-03-15')).toBe(localTs(2026, 3, 15))
    expect(parseFrontmatterDate('2026年3月15日')).toBe(localTs(2026, 3, 15))
    expect(parseFrontmatterDate('')).toBe(null)
    expect(parseFrontmatterDate(null)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 3. 标题日期串
// ---------------------------------------------------------------------------

describe('dateAttribution · extractDateFromTitle（命中）', () => {
  it('2026-03-15', () => {
    expect(extractDateFromTitle('2026-03-15')).toBe(localTs(2026, 3, 15))
  })

  it('2026年3月15日', () => {
    expect(extractDateFromTitle('2026年3月15日')).toBe(localTs(2026, 3, 15))
  })

  it('20260315', () => {
    expect(extractDateFromTitle('20260315')).toBe(localTs(2026, 3, 15))
  })

  it('斜杠分隔符与「号」也认', () => {
    expect(extractDateFromTitle('2026/03/15')).toBe(localTs(2026, 3, 15))
    expect(extractDateFromTitle('2026年3月15号')).toBe(localTs(2026, 3, 15))
  })

  it('日期串出现在标题任意位置都能命中', () => {
    expect(extractDateFromTitle('会议 2026年3月15日')).toBe(localTs(2026, 3, 15))
    expect(extractDateFromTitle('2026-03-15 周报')).toBe(localTs(2026, 3, 15))
  })

  it('多个日期时取第一个合法命中', () => {
    expect(extractDateFromTitle('2026-03-15 至 2026-03-20 汇总')).toBe(localTs(2026, 3, 15))
  })

  it('命中但年月日非法时继续往后找', () => {
    expect(extractDateFromTitle('2026-13-45 与 2026-03-15')).toBe(localTs(2026, 3, 15))
  })
})

describe('dateAttribution · extractDateFromTitle（反例：刻意不命中）', () => {
  it('「2026 年度总结」不是某一天', () => {
    expect(extractDateFromTitle('2026 年度总结')).toBe(null)
    expect(extractDateFromTitle('2026年度总结')).toBe(null)
  })

  it('「第 3 章 第 15 节」没有四位年份', () => {
    expect(extractDateFromTitle('第 3 章 第 15 节')).toBe(null)
  })

  it('只有年月（2026年3月）不算一天', () => {
    expect(extractDateFromTitle('2026年3月')).toBe(null)
    expect(extractDateFromTitle('2026-03')).toBe(null)
  })

  it('数字段不是恰好 8 位', () => {
    expect(extractDateFromTitle('2026031')).toBe(null)
    expect(extractDateFromTitle('202603151')).toBe(null)
    expect(extractDateFromTitle('订单20260315123456')).toBe(null)
  })

  it('8 位但不是合法年月日', () => {
    expect(extractDateFromTitle('12345678')).toBe(null)
    expect(extractDateFromTitle('20261332')).toBe(null)
  })

  it('年月日越界', () => {
    expect(extractDateFromTitle('2026-13-01')).toBe(null)
    expect(extractDateFromTitle('2026-02-30')).toBe(null)
  })

  it('前一位是数字（长数字串被切开）不算', () => {
    expect(extractDateFromTitle('12026-03-15')).toBe(null)
  })

  it('空标题 / 非字符串', () => {
    expect(extractDateFromTitle('')).toBe(null)
    expect(extractDateFromTitle(null)).toBe(null)
    expect(extractDateFromTitle(undefined)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 4. 四级回落
// ---------------------------------------------------------------------------

describe('dateAttribution · resolveNoteDate 四级回落', () => {
  const birthtime = localTs(2022, 5, 20)
  const updatedAt = new Date(2026, 5, 1, 9, 0, 0)

  const full = {
    title: '2024年1月8日 日记',
    content: doc('date: 2019-04-05'),
    updatedAt
  }

  it('① frontmatter 优先于后面三级', () => {
    const r = resolveNoteDate(full, { birthtime, now: NOW })
    expect(r.date).toBe(localTs(2019, 4, 5))
    expect(r.source).toBe('frontmatter')
    expect(r.raw).toBe('2019-04-05')
  })

  it('② 去掉 frontmatter 后轮到 birthtime', () => {
    const r = resolveNoteDate({ ...full, content: '# 正文\n' }, { birthtime, now: NOW })
    expect(r.date).toBe(birthtime)
    expect(r.source).toBe('birthtime')
    expect(r.raw).toBe(null)
  })

  it('③ 再去掉 birthtime 后轮到标题日期串', () => {
    const r = resolveNoteDate({ ...full, content: '# 正文\n' }, { birthtime: null, now: NOW })
    expect(r.date).toBe(localTs(2024, 1, 8))
    expect(r.source).toBe('title')
    expect(r.raw).toBe('2024年1月8日')
  })

  it('④ 三级都没有时回到 updatedAt（现状行为）', () => {
    const r = resolveNoteDate(
      { title: '无日期的笔记', content: '# 正文\n', updatedAt },
      { birthtime: null, now: NOW }
    )
    expect(r.date).toBe(updatedAt.getTime())
    expect(r.source).toBe('updatedAt')
    expect(r.raw).toBe(null)
  })

  it('birthtime 传 Date 对象也能吃（主进程 fs.stat 的形态）', () => {
    const r = resolveNoteDate({ ...full, content: '# 正文\n' }, { birthtime: new Date(birthtime), now: NOW })
    expect(r.source).toBe('birthtime')
    expect(r.date).toBe(birthtime)
  })

  it('birthtime = 0（Linux 拿不到值）→ 视为不可信，往下掉', () => {
    const r = resolveNoteDate({ ...full, content: '# 正文\n' }, { birthtime: 0, now: NOW })
    expect(r.source).toBe('title')
  })

  it('birthtime 为负数或 NaN → 往下掉', () => {
    expect(resolveNoteDate({ ...full, content: '# x\n' }, { birthtime: -1, now: NOW }).source).toBe('title')
    expect(resolveNoteDate({ ...full, content: '# x\n' }, { birthtime: NaN, now: NOW }).source).toBe('title')
  })

  it('birthtime 远在未来（时钟错乱 / 同步重置）→ 往下掉', () => {
    const future = NOW + 10 * 24 * 60 * 60 * 1000
    expect(resolveNoteDate({ ...full, content: '# x\n' }, { birthtime: future, now: NOW }).source).toBe('title')
  })

  it('birthtime 只超前一天以内 → 仍然采信（宽容时钟抖动）', () => {
    const skew = NOW + 60 * 60 * 1000
    expect(resolveNoteDate({ ...full, content: '# x\n' }, { birthtime: skew, now: NOW }).source).toBe('birthtime')
  })

  it('frontmatter 有日期键但值不可解析 → 往下掉，不返回 NaN', () => {
    const r = resolveNoteDate({ ...full, content: doc('date: 待定') }, { birthtime, now: NOW })
    expect(r.source).toBe('birthtime')
    expect(Number.isFinite(r.date)).toBe(true)
  })

  it('updatedAt 缺失时退回注入的 now，source 仍为 updatedAt', () => {
    const r = resolveNoteDate({ title: '空笔记', content: '' }, { birthtime: null, now: NOW })
    expect(r.date).toBe(NOW)
    expect(r.source).toBe('updatedAt')
  })

  it('note 为 null / undefined 也不抛，返回兜底', () => {
    expect(resolveNoteDate(null, { now: NOW })).toEqual({ date: NOW, source: 'updatedAt', raw: null })
    expect(resolveNoteDate(undefined, { now: NOW }).source).toBe('updatedAt')
  })

  it('source 永远落在四个常量之内', () => {
    const cases = [
      resolveNoteDate(full, { birthtime, now: NOW }),
      resolveNoteDate({ ...full, content: '# x\n' }, { birthtime, now: NOW }),
      resolveNoteDate({ ...full, content: '# x\n' }, { birthtime: null, now: NOW }),
      resolveNoteDate({ title: 'x', content: '' }, { birthtime: null, now: NOW })
    ]
    for (const r of cases) {
      expect(DATE_SOURCES).toContain(r.source)
      expect(typeof r.date).toBe('number')
      expect(Number.isFinite(r.date)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. 纯函数性质
// ---------------------------------------------------------------------------

describe('dateAttribution · 纯函数性质', () => {
  it('同样的入参永远得到同样的返回值（now 注入后与真实时钟无关）', () => {
    const note = { title: '2026年3月15日 日记', content: doc('date: 2026-03-15'), updatedAt: new Date(2026, 5, 1) }
    const a = resolveNoteDate(note, { birthtime: localTs(2020, 1, 1), now: NOW })
    const b = resolveNoteDate(note, { birthtime: localTs(2020, 1, 1), now: NOW })
    expect(a).toEqual(b)
  })

  it('不修改入参对象', () => {
    const note = { title: '2026年3月15日 日记', content: doc('date: 2026-03-15'), updatedAt: new Date(2026, 5, 1) }
    const snapshot = JSON.stringify(note)
    resolveNoteDate(note, { birthtime: 0, now: NOW })
    expect(JSON.stringify(note)).toBe(snapshot)
  })

  it('不读时钟：不传 now 时也能跑（只是兜底值取真实当前时刻）', () => {
    const r = resolveNoteDate({ title: '2026年3月15日 日记', content: '' })
    expect(r.source).toBe('title')
    expect(r.date).toBe(localTs(2026, 3, 15))
  })
})

// ---------------------------------------------------------------------------
// 6. toISODate（T18 迁移写 frontmatter 用）
// ---------------------------------------------------------------------------

describe('dateAttribution · toISODate', () => {
  it('按本地日历日输出，不是 UTC 日', () => {
    expect(toISODate(new Date(2026, 2, 15, 0, 30))).toBe('2026-03-15')
    expect(toISODate(new Date(2026, 2, 15, 23, 59))).toBe('2026-03-15')
    expect(toISODate(localTs(2026, 12, 1))).toBe('2026-12-01')
  })

  it('写入 → 读出 往返无损（迁移后 frontmatter 日期不漂）', () => {
    const ts = new Date(2026, 2, 15, 10, 30).getTime()
    const iso = toISODate(ts)
    expect(parseFrontmatterDate(doc(`date: ${iso}`))).toBe(localTs(2026, 3, 15))
    expect(parseFrontmatterDate(iso)).toBe(localTs(2026, 3, 15))
  })

  it('补零与不可解析输入', () => {
    expect(toISODate(localTs(2026, 1, 5))).toBe('2026-01-05')
    expect(toISODate(null)).toBe('')
    expect(toISODate(undefined)).toBe('')
    expect(toISODate('不是时间')).toBe('')
  })

  it('吃字符串时间戳', () => {
    const ts = new Date(2026, 2, 15, 10, 30).getTime()
    expect(toISODate(String(ts))).toBe('2026-03-15')
  })
})
