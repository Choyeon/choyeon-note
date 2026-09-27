import { describe, it, expect } from 'vitest'
import { computeTextStats, estimateReadingMinutes } from '../src/utils/textStats.js'

describe('computeTextStats', () => {
  it('空输入返回全 0', () => {
    expect(computeTextStats('')).toEqual({ words: 0, chars: 0, lines: 0 })
    expect(computeTextStats(undefined)).toEqual({ words: 0, chars: 0, lines: 0 })
  })

  it('CJK 按字计，拉丁按词计', () => {
    const stats = computeTextStats('你好世界 hello world')
    expect(stats.words).toBe(6) // 4 汉字 + 2 英文词
  })

  it('纯中文不会只算成 1 个词（回归：旧口径按空白切分）', () => {
    const stats = computeTextStats('这是一篇没有空格的中文笔记')
    expect(stats.words).toBe(13)
  })

  it('chars 含空白，lines 按 \\n 切分', () => {
    const stats = computeTextStats('ab\ncd')
    expect(stats.chars).toBe(5)
    expect(stats.lines).toBe(2)
  })

  it('编辑器与 store 口径一致：同一段文字结果稳定', () => {
    const text = '# 标题\n正文内容 with english words'
    const a = computeTextStats(text)
    const b = computeTextStats(text)
    expect(a).toEqual(b)
    expect(a.words).toBeGreaterThan(0)
  })
})

describe('estimateReadingMinutes', () => {
  it('最少 1 分钟', () => {
    expect(estimateReadingMinutes(0)).toBe(1)
    expect(estimateReadingMinutes(1)).toBe(1)
  })

  it('按 300 字/分钟向上取整', () => {
    expect(estimateReadingMinutes(300)).toBe(1)
    expect(estimateReadingMinutes(301)).toBe(2)
    expect(estimateReadingMinutes(900)).toBe(3)
  })

  it('非法输入不抛错', () => {
    expect(estimateReadingMinutes('abc')).toBe(1)
  })
})
