// ===========================================================================
// T18 · 日期固化迁移 + 索引日期键口径
//
// 本文件是「迁移能不能合入」的唯一判据，回答四个问题：
//   1. 迁移是不是**只写 frontmatter**（正文逐字节不动）；
//   2. 迁移前后同一篇笔记的 dateKey 是不是**逐条相等**（日历不漂移）；
//   3. 写失败时是不是**不落标记**（下次还能重试）；
//   4. noteIndex 的 dateKey 格式是不是还是原来那个（store / CalendarView 的契约）。
//
// 纯内核约束：**不 import vue / pinia / store**。用到的三个模块
// （dateAttribution / noteIndex / dateMigration）都是纯函数层。
// ===========================================================================

import { describe, it, expect } from 'vitest'
import {
  runDateMigration,
  hasFrontmatterDateKey,
  withFrontmatterDate
} from '../src/utils/dateMigration.js'
import {
  DATE_SOURCE,
  DATE_SOURCES,
  resolveNoteDate,
  toISODate
} from '../src/utils/dateAttribution.js'
import { createNoteIndex, dateKeyOf } from '../src/utils/noteIndex.js'

// ---------------------------------------------------------------------------
// 固定时钟：所有与「现在」有关的判断都用它，保证同一次运行可复现
// ---------------------------------------------------------------------------
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/**
 * 构造一篇笔记。
 * @param {object} opts 字段
 * @returns {object} 笔记对象
 */
function note ({
  id = 'x',
  title = '没有日期的标题',
  content = '# 正文\n\n一段话。\n',
  updatedAt = '2024-01-02T03:04:05.000Z',
  filePath = null,
  birthtime = undefined
}) {
  const n = {
    id,
    title,
    folder: 'vault',
    content,
    tags: [],
    updatedAt: new Date(updatedAt),
    filePath: filePath === null ? `D:/vault/${id}.md` : filePath
  }
  if (birthtime !== undefined) n.birthtime = birthtime
  return n
}

/**
 * 写盘记录器：记录每一次 (path, content)，可按 path 注入失败。
 * @param {object} [opts] 选项
 * @returns {{ writeFile: Function, calls: Array<object> }} 记录器
 */
function makeWriter (opts = {}) {
  const failOn = Array.isArray(opts.failOn) ? opts.failOn : []
  const throwOn = Array.isArray(opts.throwOn) ? opts.throwOn : []
  const calls = []
  async function writeFile (path, content) {
    calls.push({ path, content })
    if (throwOn.includes(path)) throw new Error('EACCES: permission denied')
    if (failOn.includes(path)) return false
    return true
  }
  return { writeFile, calls }
}

/**
 * 防重跑标记的内存实现。
 * @param {string|null} initial 初始值
 * @returns {{ readFlag: Function, writeFlag: Function, writes: Array<number> }} 标记
 */
function makeFlag (initial = null) {
  let value = initial
  const writes = []
  return {
    readFlag: () => value,
    writeFlag: (v) => {
      writes.push(v)
      value = String(v)
      return true
    },
    writes
  }
}

/**
 * 跑一次迁移（自动接好 writer / flag / now）。
 * @param {Array<object>} notes 笔记数组
 * @param {object} [overrides] 覆盖项
 * @returns {Promise<{result: object, writer: object, flag: object}>} 结果三件套
 */
async function migrate (notes, overrides = {}) {
  const writer = overrides.writer || makeWriter()
  const flag = overrides.flag || makeFlag(null)
  const result = await runDateMigration({
    notes,
    writeFile: writer.writeFile,
    readFlag: flag.readFlag,
    writeFlag: flag.writeFlag,
    now: overrides.now === undefined ? NOW : overrides.now,
    // 裁决 2 的开关。不传 = T18 的原始行为（全量固化）；传 true = 只固化可信来源
    trustworthyOnly: overrides.trustworthyOnly
  })
  return { result, writer, flag }
}

/**
 * 取正文（去掉 frontmatter 围栏之后的部分），用于「正文零改动」的字节级断言。
 * 与 useLinks / dateAttribution 的 FM_FENCE 同口径。
 * @param {string} content 笔记全文
 * @returns {string} 正文
 */
function bodyOf (content) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/m.exec(content)
  return m ? content.slice(m[0].length) : content
}

/**
 * 按当前口径解析一篇笔记的归属。
 * @param {object} n 笔记
 * @returns {{ date: number, source: string, raw: string|null }} 归属
 */
function resolveOf (n) {
  return resolveNoteDate(
    { content: n.content, title: n.title, updatedAt: n.updatedAt },
    { birthtime: n.birthtime === undefined ? null : n.birthtime, now: NOW }
  )
}

/**
 * 50 篇语料：四级来源各占一定比例（10 已有 date / 10 birthtime / 10 标题 / 20 纯 updatedAt）。
 * @returns {Array<object>} 笔记数组
 */
function buildCorpus () {
  const notes = []
  for (let i = 0; i < 50; i += 1) {
    const id = `c${String(i).padStart(2, '0')}`
    const day = String((i % 28) + 1).padStart(2, '0')
    const base = {
      id,
      title: `无日期标题 ${i}`,
      folder: 'vault',
      content: `# 标题 ${i}\n\n正文第 ${i} 段，含 \`代码\` 与中文标点。\n\n\`\`\`js\nconst a = ${i};\n\`\`\`\n`,
      tags: [],
      updatedAt: new Date(Date.UTC(2022, 5, (i % 28) + 1, 8, 30, 0)),
      filePath: `D:/vault/${id}.md`
    }
    const kind = i % 5
    if (kind === 0) {
      // ① frontmatter 已有 date → 应被跳过
      notes.push({ ...base, content: `---\ndate: 2018-01-${day}\n---\n\n${base.content}` })
    } else if (kind === 1) {
      // ② 文件 birthtime（磁盘证据）
      notes.push({ ...base, birthtime: new Date(Date.UTC(2019, 2, (i % 28) + 1, 0, 0, 0)) })
    } else if (kind === 2) {
      // ③ 标题日期串（人写日记的习惯）
      notes.push({ ...base, title: `日记 2017-04-${day} 摘录` })
    } else {
      // ④ 只剩 updatedAt（现状行为）
      notes.push({ ...base })
    }
  }
  return notes
}

// ===========================================================================
// A · 前置闸门：防重跑标记
// ===========================================================================
describe('A · 防重跑标记（flag）', () => {
  it('A1 flag 已存在 → 不重跑：ran=false、skipped=total、其余归零', async () => {
    const notes = [note({ id: 'a1' }), note({ id: 'a2' })]
    const { result } = await migrate(notes, { flag: makeFlag('1710000000000') })
    expect(result.ran).toBe(false)
    expect(result.total).toBe(2)
    expect(result.migrated).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.unwritable).toBe(0)
    expect(result.bySource).toEqual({ frontmatter: 0, birthtime: 0, title: 0, updatedAt: 0 })
  })

  it('A2 flag 已存在 → 一次 writeFile 都不发（绝不动用户的文件）', async () => {
    const notes = [note({ id: 'a1' }), note({ id: 'a2' })]
    const { writer } = await migrate(notes, { flag: makeFlag('1710000000000') })
    expect(writer.calls).toHaveLength(0)
  })

  it('A3 flag 已存在 → writeFlag 不再被调用', async () => {
    const flag = makeFlag('1710000000000')
    await migrate([note({ id: 'a1' })], { flag })
    expect(flag.writes).toHaveLength(0)
  })

  it('A4 首次跑通 → writeFlag 被调用一次，值是注入的 now', async () => {
    const flag = makeFlag(null)
    await migrate([note({ id: 'a1' })], { flag })
    expect(flag.writes).toEqual([NOW])
  })

  it('A5 空库 → total=0、什么都不写，且**不写 flag**（避免把标记打死）', async () => {
    const flag = makeFlag(null)
    const { result, writer } = await migrate([], { flag })
    expect(result.total).toBe(0)
    expect(result.ran).toBe(true)
    expect(writer.calls).toHaveLength(0)
    expect(flag.writes).toHaveLength(0)
  })

  it('A6 notes 传 undefined / 非数组 → 当空库处理，不抛异常', async () => {
    const { result } = await migrate(undefined)
    expect(result.total).toBe(0)
    const r2 = (await migrate('not-an-array')).result
    expect(r2.total).toBe(0)
  })

  it('A7 flag 值是字符串 "0" 也算跑过（不能因为假值判断而重跑）', async () => {
    const { result, writer } = await migrate([note({ id: 'a1' })], { flag: makeFlag('0') })
    expect(result.ran).toBe(false)
    expect(writer.calls).toHaveLength(0)
  })
})

// ===========================================================================
// B · 已有日期键的笔记必须跳过
// ===========================================================================
describe('B · 已有日期键 → 跳过', () => {
  it('B1 hasFrontmatterDateKey 认得 DATE_KEYS 的四个键', () => {
    expect(hasFrontmatterDateKey('---\ndate: 2024-01-01\n---\n')).toBe(true)
    expect(hasFrontmatterDateKey('---\ncreated: 2024-01-01\n---\n')).toBe(true)
    expect(hasFrontmatterDateKey('---\ncreated_at: 2024-01-01\n---\n')).toBe(true)
    expect(hasFrontmatterDateKey('---\ncreatedAt: 2024-01-01\n---\n')).toBe(true)
  })

  it('B2 键名大小写不敏感（Date: 也算）', () => {
    expect(hasFrontmatterDateKey('---\nDate: 2024-01-01\n---\n')).toBe(true)
    expect(hasFrontmatterDateKey('---\nCREATED: 2024-01-01\n---\n')).toBe(true)
  })

  it('B3 没有围栏的裸 date: 行不算 frontmatter（正文里的不算）', () => {
    expect(hasFrontmatterDateKey('# 标题\n\ndate: 2024-01-01\n')).toBe(false)
    expect(hasFrontmatterDateKey('')).toBe(false)
    expect(hasFrontmatterDateKey(null)).toBe(false)
  })

  it('B4 不可解析的 date（date: 待定）也算有键 → 跳过，绝不写第二个 date', async () => {
    const n = note({ id: 'b4', content: '---\ndate: 待定\n---\n\n正文。\n' })
    const before = n.content
    const { result, writer } = await migrate([n])
    expect(result.skipped).toBe(1)
    expect(result.migrated).toBe(0)
    expect(writer.calls).toHaveLength(0)
    expect(n.content).toBe(before)
  })

  it('B5 已有 date: → skipped，内容逐字节不变', async () => {
    const n = note({ id: 'b5', content: '---\ndate: 2018-01-05\ntags: [x]\n---\n\n# 正文\n' })
    const before = n.content
    const { result, writer } = await migrate([n])
    expect(result.skipped).toBe(1)
    expect(result.migrated).toBe(0)
    expect(writer.calls).toHaveLength(0)
    expect(n.content).toBe(before)
  })

  it('B6 兼容键 created / created_at / createdAt 同样跳过', async () => {
    const notes = [
      note({ id: 'b6a', content: '---\ncreated: 2018-01-05\n---\n\nA\n' }),
      note({ id: 'b6b', content: '---\ncreated_at: 2018-01-05\n---\n\nB\n' }),
      note({ id: 'b6c', content: '---\ncreatedAt: 2018-01-05\n---\n\nC\n' })
    ]
    const { result } = await migrate(notes)
    expect(result.skipped).toBe(3)
    expect(result.migrated).toBe(0)
  })
})

// ===========================================================================
// C · 只写 frontmatter，正文零改动（字节级）
// ===========================================================================
describe('C · 正文零改动（字节级）', () => {
  it('C1 有围栏：date 插在围栏内第一行，删掉这一行 == 原文', async () => {
    const original = '---\ntags: [a]\n---\n# 正文\n'
    const n = note({ id: 'c1', content: original })
    const { result, writer } = await migrate([n])
    expect(result.migrated).toBe(1)
    const written = writer.calls[0].content
    const line = `date: ${toISODate(resolveOf(note({ id: 'c1', content: original })).date)}\n`
    expect(written).toBe('---\n' + line + 'tags: [a]\n---\n# 正文\n')
    expect(written.slice(0, 4) + written.slice(4 + line.length)).toBe(original)
  })

  it('C2 无围栏：新内容 == 前置块 + 原文（原文一个字节不多不少）', async () => {
    const original = '# 标题\n\n正文，含中文与标点。\n'
    const n = note({ id: 'c2', content: original })
    const { writer } = await migrate([n])
    const written = writer.calls[0].content
    expect(written.slice(written.length - original.length)).toBe(original)
    expect(written).toBe(written.slice(0, written.length - original.length) + original)
  })

  it('C3 bodyOf（去围栏后的正文）前后逐字节相等', async () => {
    const n = note({ id: 'c3', content: '# 标题\n\n```js\nconst a = 1; // #not-a-tag\n```\n\n中文 emoji 🎉\n' })
    const before = bodyOf(n.content)
    await migrate([n])
    expect(bodyOf(n.content)).toBe(before)
  })

  it('C4 CRLF 笔记：插入的行也用 CRLF，不混用换行', async () => {
    const original = '---\r\ntags: [a]\r\n---\r\n# 正文\r\n'
    const n = note({ id: 'c4', content: original })
    const { writer } = await migrate([n])
    const written = writer.calls[0].content
    expect(written.startsWith('---\r\ndate: ')).toBe(true)
    expect(written).toContain('\r\ndate: ')
    expect(written.split('\n').every((l, i, arr) => i === arr.length - 1 || l.endsWith('\r'))).toBe(true)
    expect(bodyOf(written).replace(/\r\n/g, '\n')).toBe(bodyOf(original).replace(/\r\n/g, '\n'))
  })

  it('C5 content 为空字符串 → 结果就是一个规范的 frontmatter 块', async () => {
    const n = note({ id: 'c5', content: '' })
    const { result, writer } = await migrate([n])
    expect(result.migrated).toBe(1)
    expect(writer.calls[0].content).toMatch(/^---\ndate: \d{4}-\d{2}-\d{2}\n---\n$/)
  })

  it('C6 note 没有 content 字段 → 按空串处理，照样能落盘且 date 可读', async () => {
    const n = note({ id: 'c6' })
    delete n.content
    const { result, writer } = await migrate([n])
    expect(result.migrated).toBe(1)
    expect(resolveOf(n).source).toBe(DATE_SOURCE.FRONTMATTER)
    expect(writer.calls[0].content).toContain('date: ')
  })

  it('C7 畸形 frontmatter（围栏没闭合）→ 前置一个新块，date 变得可读', async () => {
    const original = '---\nfoo: bar\n正文还没闭合\n'
    const n = note({ id: 'c7', content: original })
    const { writer } = await migrate([n])
    const written = writer.calls[0].content
    expect(written.endsWith(original)).toBe(true)
    expect(resolveNoteDate({ content: written, title: n.title, updatedAt: n.updatedAt }, { now: NOW }).source)
      .toBe(DATE_SOURCE.FRONTMATTER)
  })

  it('C8 围栏在文件中间（不在开头）→ 整块前置，正文不动', async () => {
    const original = '# 标题\n\n---\nfoo: bar\n---\n\n尾巴\n'
    const n = note({ id: 'c8', content: original })
    const { writer } = await migrate([n])
    expect(writer.calls[0].content.slice(-original.length)).toBe(original)
  })

  it('C9 withFrontmatterDate 在 isoDate 为空时原样返回（绝不写坏数据）', () => {
    const original = '# 正文\n'
    expect(withFrontmatterDate(original, '')).toBe(original)
    expect(withFrontmatterDate(original, null)).toBe(original)
  })
})

// ===========================================================================
// D · 四级来源与 bySource 直方图
// ===========================================================================
describe('D · 四级来源 bySource', () => {
  it('D1 只有 updatedAt → updatedAt 计数 +1，写进去的是 updatedAt 那一天（时间归零）', async () => {
    const up = new Date('2023-07-09T22:10:00.000Z')
    const n = note({ id: 'd1', updatedAt: up.toISOString() })
    const { result } = await migrate([n])
    expect(result.bySource[DATE_SOURCE.UPDATED_AT]).toBe(1)
    expect(result.migrated).toBe(1)
    expect(hasFrontmatterDateKey(n.content)).toBe(true)
    expect(n.content).toContain(`date: ${toISODate(up)}`)
    // 固化后时间戳变成那一天的本地零点，但**日期格不变** —— 这才是重点
    expect(dateKeyOf(resolveOf(n).date)).toBe(dateKeyOf(up))
    expect(toISODate(resolveOf(n).date)).toBe(toISODate(up))
    expect(new Date(resolveOf(n).date).getHours()).toBe(0)
    // 注意：不能用 new Date('2023-07-09') 当期望值 —— 纯日期串在 JS 里按 UTC 解析，
    // 而 dateAttribution 一律按本地日界构造（与 dateKeyOf 同源）
  })

  it('D2 有效 birthtime → birthtime 计数 +1，日期就是 birthtime 那天', async () => {
    const bt = new Date(Date.UTC(2020, 8, 17, 1, 2, 3))
    const n = note({ id: 'd2', birthtime: bt })
    const { result } = await migrate([n])
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(1)
    expect(n.content).toContain(`date: ${toISODate(bt)}`)
  })

  it('D3 标题日期串 → title 计数 +1', async () => {
    const n = note({ id: 'd3', title: '游记 2016年12月25日 上海', updatedAt: '2025-01-01T00:00:00.000Z' })
    const { result } = await migrate([n])
    expect(result.bySource[DATE_SOURCE.TITLE]).toBe(1)
    expect(n.content).toContain('date: 2016-12-25')
  })

  it('D4 bySource 不含 frontmatter：有 date 的那批走的是 skipped', async () => {
    const notes = [
      note({ id: 'd4a', content: '---\ndate: 2015-01-01\n---\n\nA\n' }),
      note({ id: 'd4b', updatedAt: '2024-02-02T00:00:00.000Z' })
    ]
    const { result } = await migrate(notes)
    expect(result.bySource[DATE_SOURCE.FRONTMATTER]).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.migrated).toBe(1)
  })

  it('D5 bySource 的键正好是 DATE_SOURCES 四级，一个不多一个不少', async () => {
    const { result } = await migrate([note({ id: 'd5' })])
    expect(Object.keys(result.bySource).sort()).toEqual([...DATE_SOURCES].sort())
  })

  it('D6 20 篇混合 → bySource 分布正确，且求和 == migrated', async () => {
    const notes = []
    for (let i = 0; i < 20; i += 1) {
      const kind = i % 3
      if (kind === 0) {
        notes.push(note({ id: `d6-${i}`, birthtime: new Date(Date.UTC(2020, 0, (i % 28) + 1)) }))
      } else if (kind === 1) {
        notes.push(note({ id: `d6-${i}`, title: `日志 2021-02-${String((i % 28) + 1).padStart(2, '0')}` }))
      } else {
        notes.push(note({ id: `d6-${i}`, updatedAt: new Date(Date.UTC(2024, 3, (i % 28) + 1)).toISOString() }))
      }
    }
    const { result } = await migrate(notes)
    const sum = DATE_SOURCES.reduce((acc, s) => acc + result.bySource[s], 0)
    expect(sum).toBe(result.migrated)
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(7)
    expect(result.bySource[DATE_SOURCE.TITLE]).toBe(7)
    expect(result.bySource[DATE_SOURCE.UPDATED_AT]).toBe(6)
  })

  it('D7 birthtime = 0 → 判为不可信，不固化它（落到下一级）', async () => {
    const n = note({ id: 'd7', birthtime: 0, title: '标题 2014-08-09' })
    const { result } = await migrate([n])
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(0)
    expect(result.bySource[DATE_SOURCE.TITLE]).toBe(1)
    expect(n.content).toContain('date: 2014-08-09')
  })

  it('D8 birthtime 为负数 → 判为不可信', async () => {
    const n = note({ id: 'd8', birthtime: -1000, updatedAt: '2022-05-05T00:00:00.000Z' })
    const { result } = await migrate([n])
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(0)
    expect(result.bySource[DATE_SOURCE.UPDATED_AT]).toBe(1)
    expect(n.content).toContain('date: ')
    expect(n.content).not.toContain('1969-')
    expect(n.content).not.toContain('1970-01-01')
  })

  it('D9 birthtime 在未来（超出 1 天宽容）→ 判为不可信', async () => {
    const up = new Date('2022-05-05T12:00:00.000Z')
    const n = note({ id: 'd9', birthtime: NOW + 10 * 86400000, updatedAt: up.toISOString() })
    const { result } = await migrate([n])
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(0)
    expect(result.bySource[DATE_SOURCE.UPDATED_AT]).toBe(1)
    // 期望值按同一口径算，避免用例本身被时区带偏
    expect(n.content).toContain(`date: ${toISODate(up)}`)
  })

  it('D10 birthtime 在未来但在 1 天宽容内（时钟抖动）→ 仍然采信', async () => {
    const n = note({ id: 'd10', birthtime: NOW + 3600000, updatedAt: '2022-05-05T00:00:00.000Z' })
    const { result } = await migrate([n])
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(1)
  })
})

// ===========================================================================
// E · 写失败：计数 + 不落标记 + 可重试
// ===========================================================================
describe('E · 写失败与重试', () => {
  // E1 / E2 都放两篇（一成一败）是有意的：只放一篇失败的话，migrated+skipped 恒
  // 为 0，光靠「不写 flag」这条断言区分不出「因为失败才不写」还是「因为没得写才
  // 不写」—— 故障注入 ③ 就是靠这两条才变红的。
  it('E1 writeFile 抛异常 → failed=1，且不写 flag', async () => {
    const notes = [note({ id: 'e1-ok' }), note({ id: 'e1' })]
    const writer = makeWriter({ throwOn: ['D:/vault/e1.md'] })
    const flag = makeFlag(null)
    const { result } = await migrate(notes, { writer, flag })
    expect(result.failed).toBe(1)
    expect(result.migrated).toBe(1)
    expect(flag.writes).toHaveLength(0)
  })

  it('E2 writeFile 返回 false → failed=1，且不写 flag', async () => {
    const notes = [note({ id: 'e2-ok' }), note({ id: 'e2' })]
    const writer = makeWriter({ failOn: ['D:/vault/e2.md'] })
    const flag = makeFlag(null)
    const { result } = await migrate(notes, { writer, flag })
    expect(result.failed).toBe(1)
    expect(result.migrated).toBe(1)
    expect(flag.writes).toHaveLength(0)
  })

  it('E3 写入失败的笔记：content 保持原样（没被改坏）', async () => {
    const original = '# 正文\n'
    const n = note({ id: 'e3', content: original })
    const writer = makeWriter({ failOn: ['D:/vault/e3.md'] })
    await migrate([n], { writer })
    expect(n.content).toBe(original)
  })

  it('E4 失败之后重试：第二次全成功 → migrated=1 且写 flag', async () => {
    const n = note({ id: 'e4' })
    const bad = makeWriter({ failOn: ['D:/vault/e4.md'] })
    const flag = makeFlag(null)
    const first = await migrate([n], { writer: bad, flag })
    expect(first.result.failed).toBe(1)

    const good = makeWriter()
    const second = await migrate([n], { writer: good, flag })
    expect(second.result.migrated).toBe(1)
    expect(second.result.failed).toBe(0)
    expect(flag.writes).toHaveLength(1)
  })

  it('E5 部分失败（3 篇里挂 1 篇）→ failed=1、migrated=2、不写 flag', async () => {
    const notes = [note({ id: 'e5a' }), note({ id: 'e5b' }), note({ id: 'e5c' })]
    const writer = makeWriter({ failOn: ['D:/vault/e5b.md'] })
    const flag = makeFlag(null)
    const { result } = await migrate(notes, { writer, flag })
    expect(result.migrated).toBe(2)
    expect(result.failed).toBe(1)
    expect(flag.writes).toHaveLength(0)
  })

  it('E6 重试时已固化那批会被 skipped，不会重复写', async () => {
    const notes = [note({ id: 'e6a' }), note({ id: 'e6b' })]
    const writer = makeWriter({ failOn: ['D:/vault/e6b.md'] })
    const flag = makeFlag(null)
    await migrate(notes, { writer, flag })
    const writer2 = makeWriter()
    const { result } = await migrate(notes, { writer: writer2, flag })
    expect(result.skipped).toBe(1)
    expect(result.migrated).toBe(1)
    expect(writer2.calls).toHaveLength(1)
    expect(writer2.calls[0].path).toBe('D:/vault/e6b.md')
  })

  it('E7 恒等式：total === migrated + skipped + failed + unwritable', async () => {
    const notes = [
      note({ id: 'e7a' }),
      note({ id: 'e7b', content: '---\ndate: 2011-01-01\n---\n\nA\n' }),
      note({ id: 'e7c', filePath: '' }),
      null
    ]
    const writer = makeWriter({ failOn: ['D:/vault/e7a.md'] })
    const { result } = await migrate(notes, { writer })
    expect(result.total).toBe(4)
    expect(result.total).toBe(result.migrated + result.skipped + result.failed + result.unwritable)
    expect(result.failed).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.unwritable).toBe(2)
  })
})

// ===========================================================================
// F · 无法落盘的笔记（unwritable）
// ===========================================================================
describe('F · 无法落盘（unwritable）', () => {
  it('F1 没有 filePath → unwritable，不尝试写盘', async () => {
    const n = note({ id: 'f1', filePath: '' })
    const { result, writer } = await migrate([n])
    expect(result.unwritable).toBe(1)
    expect(writer.calls).toHaveLength(0)
  })

  it('F2 note 是 null / 字符串 → unwritable，不炸', async () => {
    const { result } = await migrate([null, undefined, 'oops'])
    expect(result.unwritable).toBe(3)
    expect(result.total).toBe(3)
  })

  it('F3 没传 writeFile → 全部 unwritable，且不写 flag', async () => {
    const flag = makeFlag(null)
    const result = await runDateMigration({
      notes: [note({ id: 'f3' })],
      readFlag: flag.readFlag,
      writeFlag: flag.writeFlag,
      now: NOW
    })
    expect(result.unwritable).toBe(1)
    expect(result.migrated).toBe(0)
    expect(flag.writes).toHaveLength(0)
  })

  it('F4 unwritable 不阻塞 flag（能落盘的那批已经固化完成）', async () => {
    const flag = makeFlag(null)
    const notes = [note({ id: 'f4a' }), note({ id: 'f4b', filePath: '' })]
    const { result } = await migrate(notes, { flag })
    expect(result.migrated).toBe(1)
    expect(result.unwritable).toBe(1)
    expect(flag.writes).toEqual([NOW])
  })
})

// ===========================================================================
// G · 迁移前后日期分布不漂移（硬口径 · 50 篇）
// ===========================================================================
describe('G · 迁移前后日期分布不漂移（50 篇）', () => {
  it('G1 逐条断言：迁移前 dateKey == 迁移后 dateKey', async () => {
    const notes = buildCorpus()
    const before = new Map(notes.map(n => [n.id, dateKeyOf(resolveOf(n).date)]))
    expect(before.size).toBe(50)

    const { result } = await migrate(notes)
    expect(result.migrated).toBe(40)
    expect(result.skipped).toBe(10)

    for (const n of notes) {
      expect(dateKeyOf(resolveOf(n).date), `${n.id} 迁移后 dateKey 漂移了`).toBe(before.get(n.id))
    }
  })

  it('G2 迁移后每一篇的归属来源都变成 frontmatter（日期成了笔记自带的事实）', async () => {
    const notes = buildCorpus()
    await migrate(notes)
    for (const n of notes) {
      expect(resolveOf(n).source, `${n.id} 迁移后仍不是 frontmatter 级`).toBe(DATE_SOURCE.FRONTMATTER)
    }
  })

  it('G3 50 篇的正文前后逐字节相等', async () => {
    const notes = buildCorpus()
    const bodies = new Map(notes.map(n => [n.id, bodyOf(n.content)]))
    await migrate(notes)
    for (const n of notes) {
      expect(bodyOf(n.content), `${n.id} 正文被动过`).toBe(bodies.get(n.id))
    }
  })

  it('G4 索引视角：迁移前后 createNoteIndex 的 dateKey 逐条一致', async () => {
    const notes = buildCorpus()

    const idxBefore = createNoteIndex({ now: NOW })
    idxBefore.replaceAll(notes)
    const keysBefore = new Map()
    for (const [id, entry] of idxBefore.byId) keysBefore.set(id, entry.dateKey)

    await migrate(notes)

    const idxAfter = createNoteIndex({ now: NOW })
    idxAfter.replaceAll(notes)
    for (const [id, entry] of idxAfter.byId) {
      expect(entry.dateKey, `${id} 索引 dateKey 漂移`).toBe(keysBefore.get(id))
    }
  })

  it('G5 索引视角：dateIndex 分桶迁移前后完全一致（同一批 id 落在同一批格子）', async () => {
    const notes = buildCorpus()
    const plain = (m) => Array.from(m.entries())
      .map(([k, v]) => [k, Array.from(v).sort()])
      .sort((a, b) => a[0].localeCompare(b[0]))

    const idxBefore = createNoteIndex({ now: NOW })
    idxBefore.replaceAll(notes)
    const bucketsBefore = plain(idxBefore.dateIndex)

    await migrate(notes)

    const idxAfter = createNoteIndex({ now: NOW })
    idxAfter.replaceAll(notes)
    expect(plain(idxAfter.dateIndex)).toEqual(bucketsBefore)
  })

  it('G6 bySource 四级里 ② ③ ④ 都有计数，且总和 == migrated', async () => {
    const notes = buildCorpus()
    const { result } = await migrate(notes)
    const sum = DATE_SOURCES.reduce((acc, s) => acc + result.bySource[s], 0)
    expect(sum).toBe(result.migrated)
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(10)
    expect(result.bySource[DATE_SOURCE.TITLE]).toBe(10)
    expect(result.bySource[DATE_SOURCE.UPDATED_AT]).toBe(20)
    expect(result.bySource[DATE_SOURCE.FRONTMATTER]).toBe(0)
  })

  it('G7 迁移是幂等的：再跑一次（flag 已写）不再写任何文件', async () => {
    const notes = buildCorpus()
    const { writer, flag } = await migrate(notes)
    expect(writer.calls).toHaveLength(40)

    const writer2 = makeWriter()
    const result2 = await runDateMigration({
      notes,
      writeFile: writer2.writeFile,
      readFlag: () => String(flag.writes[0]),
      writeFlag: flag.writeFlag,
      now: NOW
    })
    expect(result2.ran).toBe(false)
    expect(writer2.calls).toHaveLength(0)
  })
})

// ===========================================================================
// I · 裁决 2：trustworthyOnly —— ④ 级（updatedAt）不许固化
//
// 这组的判据来自主理人裁决，不是设计文档：把「最后一次修改时间」写进
// frontmatter 等于把「用户碰巧在哪天跑迁移」写成笔记的生日，而且一旦写死成
// ① 级，后续批次接进 birthtime 之后 ② 级就再也没机会上位。所以 ④ 级必须
// 原样留在「每次启动实时解析」的状态 —— 一个字节都不许写。
// ===========================================================================
describe('I · 裁决 2：trustworthyOnly 只固化可信来源', () => {
  it('I1 ④ 级笔记 → untrusted=1，writeFile 一次都没被调用（frontmatter 零写入）', async () => {
    const n = note({ id: 'i1', updatedAt: '2023-07-09T22:10:00.000Z' })
    const { result, writer } = await migrate([n], { trustworthyOnly: true })
    expect(result.untrusted).toBe(1)
    expect(result.migrated).toBe(0)
    expect(result.skipped).toBe(0)
    expect(writer.calls).toHaveLength(0)
  })

  it('I2 ④ 级笔记：迁移前后全文**逐字节相等**（frontmatter 没有被加一行）', async () => {
    const original = '# 标题\n\n正文，含 `代码` 与中文标点。\n'
    const n = note({ id: 'i2', content: original, updatedAt: '2023-07-09T22:10:00.000Z' })
    await migrate([n], { trustworthyOnly: true })
    expect(n.content).toBe(original)
    expect(hasFrontmatterDateKey(n.content)).toBe(false)
    expect(n.content.includes('date:')).toBe(false)
    // 日期来源仍然是 ④ 级，没有被悄悄升级
    expect(resolveOf(n).source).toBe(DATE_SOURCE.UPDATED_AT)
  })

  it('I3 ② ③ 级照常固化（开关只挡 ④，不是一刀切全不写）', async () => {
    const notes = [
      note({ id: 'i3a', birthtime: new Date(Date.UTC(2020, 8, 17, 1, 2, 3)) }),
      note({ id: 'i3b', title: '游记 2016年12月25日 上海', updatedAt: '2025-01-01T00:00:00.000Z' })
    ]
    const { result, writer } = await migrate(notes, { trustworthyOnly: true })
    expect(result.migrated).toBe(2)
    expect(result.untrusted).toBe(0)
    expect(result.bySource[DATE_SOURCE.BIRTHTIME]).toBe(1)
    expect(result.bySource[DATE_SOURCE.TITLE]).toBe(1)
    expect(writer.calls).toHaveLength(2)
  })

  it('I4 ① 级（已有 date）仍然走 skipped，不受开关影响', async () => {
    const n = note({ id: 'i4', content: '---\ndate: 2018-01-05\n---\n\n# 正文\n' })
    const { result, writer } = await migrate([n], { trustworthyOnly: true })
    expect(result.skipped).toBe(1)
    expect(result.untrusted).toBe(0)
    expect(writer.calls).toHaveLength(0)
  })

  it('I5 恒等式：total === migrated + skipped + failed + unwritable + untrusted', async () => {
    const notes = [
      note({ id: 'i5a' }),                                              // ④ untrusted
      note({ id: 'i5b', title: '日志 2015-05-06' }),                      // ③ migrated
      note({ id: 'i5c', content: '---\ndate: 2011-01-01\n---\n\nA\n' }),  // ① skipped
      note({ id: 'i5d', filePath: '' }),                                 // unwritable
      null                                                               // unwritable
    ]
    const writer = makeWriter({ failOn: ['D:/vault/i5b.md'] })
    const { result } = await migrate(notes, { writer, trustworthyOnly: true })
    expect(result.total).toBe(5)
    expect(result.total).toBe(
      result.migrated + result.skipped + result.failed + result.unwritable + result.untrusted
    )
    expect(result.untrusted).toBe(1)
    expect(result.unwritable).toBe(2)
    expect(result.failed).toBe(1)
  })

  it('I6 还有 ④ 级笔记时不落标记（给后续批次的 birthtime 留机会）', async () => {
    const notes = [note({ id: 'i6a', title: '日志 2015-05-06' }), note({ id: 'i6b' })]
    const flag = makeFlag(null)
    const { result } = await migrate(notes, { flag, trustworthyOnly: true })
    expect(result.migrated).toBe(1)
    expect(result.untrusted).toBe(1)
    expect(flag.writes).toHaveLength(0)

    // 再来一次：已固化的那篇变 skipped，④ 级那篇仍然 untrusted
    const writer2 = makeWriter()
    const second = await migrate(notes, { writer: writer2, flag, trustworthyOnly: true })
    expect(second.result.skipped).toBe(1)
    expect(second.result.untrusted).toBe(1)
    expect(writer2.calls).toHaveLength(0)
  })

  it('I7 全是可信来源时照常落标记（开关不会让迁移永远停在"未完成"）', async () => {
    const notes = [
      note({ id: 'i7a', birthtime: new Date(Date.UTC(2020, 8, 17)) }),
      note({ id: 'i7b', title: '日志 2015-05-06' })
    ]
    const flag = makeFlag(null)
    const { result } = await migrate(notes, { flag, trustworthyOnly: true })
    expect(result.untrusted).toBe(0)
    expect(result.migrated).toBe(2)
    expect(flag.writes).toEqual([NOW])
  })

  it('I8 不传 trustworthyOnly 时行为与 T18 完全一致（④ 级照旧固化，向后兼容）', async () => {
    const up = new Date('2023-07-09T22:10:00.000Z')
    const n = note({ id: 'i8', updatedAt: up.toISOString() })
    const { result } = await migrate([n])
    expect(result.untrusted).toBe(0)
    expect(result.migrated).toBe(1)
    expect(result.bySource[DATE_SOURCE.UPDATED_AT]).toBe(1)
    expect(n.content).toContain(`date: ${toISODate(up)}`)
  })

  it('I9 trustworthyOnly 传非布尔值（undefined / 字符串 / 数字）→ 按 false 处理', async () => {
    for (const dirty of [undefined, 'true', 1, null]) {
      const n = note({ id: 'i9', updatedAt: '2023-07-09T22:10:00.000Z' })
      const { result } = await migrate([n], { trustworthyOnly: dirty })
      expect(result.migrated, `trustworthyOnly=${String(dirty)} 时被误当成 true`).toBe(1)
      expect(result.untrusted).toBe(0)
    }
  })

  it('I10 50 篇语料：开启开关后 migrated 从 40 降到 20，被拦下的正好是 ④ 级那 20 篇', async () => {
    const notes = buildCorpus()
    const { result, writer } = await migrate(notes, { trustworthyOnly: true })
    expect(result.migrated).toBe(20)
    expect(result.skipped).toBe(10)      // ① 级
    expect(result.untrusted).toBe(20)    // ④ 级
    expect(result.bySource[DATE_SOURCE.UPDATED_AT]).toBe(0)
    expect(writer.calls).toHaveLength(20)
    // 被拦下的那批内容一个字节没变
    for (const n of notes) {
      if (n.id.startsWith('c') && !hasFrontmatterDateKey(n.content)) {
        expect(resolveOf(n).source).toBe(DATE_SOURCE.UPDATED_AT)
      }
    }
  })

  it('I11 开关不影响 dateKey：开启前后同一篇的日期分组键完全相同（日历不漂移）', async () => {
    const a = buildCorpus()
    const b = buildCorpus()
    const before = new Map(a.map(n => [n.id, dateKeyOf(resolveOf(n).date)]))
    await migrate(a, { trustworthyOnly: true })
    await migrate(b, { trustworthyOnly: false })
    for (const n of a) {
      expect(dateKeyOf(resolveOf(n).date), `${n.id} 开启开关后日期漂移`).toBe(before.get(n.id))
    }
    for (const n of b) {
      expect(dateKeyOf(resolveOf(n).date), `${n.id} 全量固化后日期漂移`).toBe(before.get(n.id))
    }
  })
})

// ===========================================================================
// H · noteIndex 的 dateKey 口径（必须与旧 dateKeyOf 完全一致）
// ===========================================================================
describe('H · noteIndex 日期键口径', () => {
  it('H1 dateKey 格式仍是 new Date(v).toDateString()（store / CalendarView 的契约）', () => {
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll([note({ id: 'h1', updatedAt: '2024-01-02T03:04:05.000Z' })])
    const entry = idx.byId.get('h1')
    expect(entry.dateKey).toBe(new Date('2024-01-02T03:04:05.000Z').toDateString())
    expect(entry.dateKey).toMatch(/^\w{3} \w{3} \d{2} \d{4}$/)
  })

  it('H2 没有 birthtime / 标题日期时，与旧实现 dateKeyOf(note.updatedAt) 逐条相等', () => {
    const notes = [
      note({ id: 'h2a', updatedAt: '2024-01-02T03:04:05.000Z' }),
      note({ id: 'h2b', updatedAt: '2023-11-30T23:59:59.000Z' }),
      note({ id: 'h2c', updatedAt: '2025-06-01T00:00:00.000Z' })
    ]
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll(notes)
    for (const n of notes) {
      expect(idx.byId.get(n.id).dateKey).toBe(dateKeyOf(n.updatedAt))
    }
  })

  it('H3 frontmatter 有 date → 按它归日期（不再跟着 updatedAt 跑）', () => {
    const n = note({
      id: 'h3',
      content: '---\ndate: 2019-09-09\n---\n\n# 正文\n',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll([n])
    const entry = idx.byId.get('h3')
    expect(entry.dateSource).toBe(DATE_SOURCE.FRONTMATTER)
    expect(entry.dateKey).toBe(new Date(2019, 8, 9).toDateString())
    expect(entry.dateKey).not.toBe(dateKeyOf(n.updatedAt))
  })

  it('H4 标题日期串生效（无 frontmatter、无 birthtime 时）', () => {
    const n = note({ id: 'h4', title: '周报 2021-03-08', updatedAt: '2026-01-01T00:00:00.000Z' })
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll([n])
    expect(idx.byId.get('h4').dateSource).toBe(DATE_SOURCE.TITLE)
    expect(idx.byId.get('h4').dateKey).toBe(new Date(2021, 2, 8).toDateString())
  })

  it('H5 birthtime 通过 birthtimeOf 注入生效', () => {
    const bt = new Date(Date.UTC(2020, 4, 20, 6, 0, 0))
    const n = note({ id: 'h5', updatedAt: '2026-01-01T00:00:00.000Z' })
    const idx = createNoteIndex({ now: NOW, birthtimeOf: () => bt })
    idx.replaceAll([n])
    const entry = idx.byId.get('h5')
    expect(entry.dateSource).toBe(DATE_SOURCE.BIRTHTIME)
    expect(entry.dateKey).toBe(dateKeyOf(bt))
  })

  it('H6 birthtime 挂在 note.birthtime 上也能生效（零接线路径）', () => {
    const bt = new Date(Date.UTC(2018, 10, 11, 6, 0, 0))
    const n = note({ id: 'h6', birthtime: bt, updatedAt: '2026-01-01T00:00:00.000Z' })
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll([n])
    expect(idx.byId.get('h6').dateSource).toBe(DATE_SOURCE.BIRTHTIME)
    expect(idx.byId.get('h6').dateKey).toBe(dateKeyOf(bt))
  })

  it('H7 单次 upsert 也能带 birthtime（第三参）', () => {
    const bt = new Date(Date.UTC(2017, 6, 7, 6, 0, 0))
    const n = note({ id: 'h7', updatedAt: '2026-01-01T00:00:00.000Z' })
    const idx = createNoteIndex({ now: NOW })
    idx.upsert(n, -1, { birthtime: bt })
    expect(idx.byId.get('h7').dateSource).toBe(DATE_SOURCE.BIRTHTIME)
  })

  it('H8 改了 dateKey 之后，旧的日期桶会被摘掉（dropFromDateIndex 仍正确）', () => {
    const n = note({ id: 'h8', updatedAt: '2024-01-02T03:04:05.000Z' })
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll([n])
    const oldKey = idx.byId.get('h8').dateKey
    expect(idx.byDate(oldKey).map(x => x.id)).toEqual(['h8'])

    // 补上 frontmatter date → dateKey 换成 2019-09-09 那一格
    idx.upsert({ ...n, content: '---\ndate: 2019-09-09\n---\n\n# 正文\n' })
    expect(idx.byDate(oldKey)).toEqual([])
    expect(idx.dateIndex.has(oldKey)).toBe(false)
    const newKey = new Date(2019, 8, 9).toDateString()
    expect(idx.byDate(newKey).map(x => x.id)).toEqual(['h8'])
  })

  it('H9 remove 之后该笔记从日期桶里消失（空桶被删）', () => {
    const notes = [note({ id: 'h9a', updatedAt: '2024-01-02T03:04:05.000Z' })]
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll(notes)
    const key = idx.byId.get('h9a').dateKey
    expect(idx.remove('h9a')).toBe(true)
    expect(idx.byDate(key)).toEqual([])
    expect(idx.dateIndex.has(key)).toBe(false)
  })

  it('H10 byDate 仍然按插入顺序返回，且空库不炸', () => {
    const day = '2024-01-02T03:04:05.000Z'
    const notes = [
      note({ id: 'ha', updatedAt: day }),
      note({ id: 'hb', updatedAt: day }),
      note({ id: 'hc', updatedAt: '2024-05-06T00:00:00.000Z' })
    ]
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll(notes)
    expect(idx.byDate(new Date(day).toDateString()).map(n => n.id)).toEqual(['ha', 'hb'])
    expect(createNoteIndex({ now: NOW }).byDate('Mon Jan 01 1990')).toEqual([])
  })

  it('H11 注入的 now 参与兜底：updatedAt 缺失时不会掉到 1970 之外的地方', () => {
    const n = { id: 'h11', title: 'T', content: '', folder: '', tags: [] }
    const idx = createNoteIndex({ now: NOW })
    idx.replaceAll([n])
    expect(idx.byId.get('h11').dateKey).toBe(new Date(NOW).toDateString())
  })
})
