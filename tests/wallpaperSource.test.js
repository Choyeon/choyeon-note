/**
 * 壁纸换源（T40 · tests/wallpaperSource.test.js）
 * ==========================================================================
 * 换源不是「多写几个 URL 依次试一遍」就完事 —— 真正容易坏的是**策略**：
 *   1. 用户选了「仅官方」但当前环境根本没有官方通道（浏览器 / dev）；
 *   2. 某个源返回了图片地址，但那个地址加载不出来（相对路径 / 404 / 非图片）；
 *   3. 同一个参数被两处同时请求（启动 + 设置页手动刷新）→ 打两轮网络；
 *   4. 地区 / 偏好是拼进 URL 的查询参数，脏值必须被挡在门外。
 * 这四条在浏览器里都表现为「背景没变但也不报错」，只能靠测试钉住。
 *
 * 环境：jsdom。Image 与 fetch 由本文件替换成可控替身 —— 取源模块探测图片
 * 用的是 `new window.Image()`，jsdom 默认不加载资源（既不 onload 也不 onerror），
 * 不换替身就只能等 2s 超时分支，测试既慢又测不到「图片真的坏了」这条路径。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchBingWallpaper,
  normalizeWallpaperMarket,
  normalizeWallpaperSourcePref,
  WALLPAPER_MARKETS,
  WALLPAPER_SOURCE_PREFS,
  WALLPAPER_SOURCE_LABELS,
  DEFAULT_WALLPAPER_MARKET,
  DEFAULT_WALLPAPER_SOURCE_PREF
} from '@/utils/bingWallpaper'

/** 公开镜像的成功响应样例（字段与 bing.biturl.top 一致） */
const BITURL_OK = {
  url: 'https://www.bing.com/th?id=OHR.Today_ZH-CN1234_1920x1080.jpg',
  copyright: '地肤田，中国 (© lingqi xie/Getty Images)',
  start_date: '20260101',
  title: ''
}

/** 装一个可控的 Image：默认「加载成功」，可被单条用例改成失败 */
function installImage ({ fail = false } = {}) {
  window.Image = class {
    set src (_value) {
      // 异步派发，贴近真实浏览器行为（同步派发会让 await 拿不到竞态）
      setTimeout(() => {
        if (fail) this.onerror && this.onerror()
        else this.onload && this.onload()
      }, 0)
    }
  }
}

beforeEach(() => {
  installImage()
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ...BITURL_OK }) }))
  delete window.electronAPI
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.electronAPI
  delete global.fetch
})

describe('换源 · 参数归一化', () => {
  it('N1 地区：白名单外一律回落默认（mkt 要拼进 URL，不能原样信任）', () => {
    expect(normalizeWallpaperMarket('zh-CN')).toBe('zh-CN')
    expect(normalizeWallpaperMarket('ja-JP')).toBe('ja-JP')
    expect(normalizeWallpaperMarket('../../etc/passwd')).toBe(DEFAULT_WALLPAPER_MARKET)
    expect(normalizeWallpaperMarket('')).toBe(DEFAULT_WALLPAPER_MARKET)
    expect(normalizeWallpaperMarket(null)).toBe(DEFAULT_WALLPAPER_MARKET)
  })

  it('N2 数据源偏好：白名单外一律回落 auto', () => {
    expect(normalizeWallpaperSourcePref('official')).toBe('official')
    expect(normalizeWallpaperSourcePref('biturl')).toBe('biturl')
    expect(normalizeWallpaperSourcePref('evil')).toBe(DEFAULT_WALLPAPER_SOURCE_PREF)
    expect(normalizeWallpaperSourcePref(undefined)).toBe(DEFAULT_WALLPAPER_SOURCE_PREF)
  })

  it('N3 下拉选项、归一化白名单、来源文案三处同源（下拉里有的一定被取源认）', () => {
    for (const m of WALLPAPER_MARKETS) {
      expect(normalizeWallpaperMarket(m.id)).toBe(m.id)
    }
    for (const p of WALLPAPER_SOURCE_PREFS) {
      expect(normalizeWallpaperSourcePref(p.id)).toBe(p.id)
    }
    // 文案出口与 source 字段对得上：设置页显示「未知来源」属于回归
    expect(WALLPAPER_SOURCE_LABELS.official).toBeTruthy()
    expect(WALLPAPER_SOURCE_LABELS.biturl).toBeTruthy()
  })
})

describe('换源 · 通道选择', () => {
  it('S1 浏览器下「仅官方」：自动退化为镜像并留痕，而不是报「所有源不可用」', async () => {
    const result = await fetchBingWallpaper({ pref: 'official' })
    expect(result.error).toBeUndefined()
    expect(result.source).toBe('biturl')
    expect(result.tried.join('\n')).toContain('无官方通道')
  })

  it('S2 「仅镜像」：即使官方通道可用也不碰它（用户钉死镜像就是要绕开官方）', async () => {
    const official = vi.fn(async () => ({ url: 'https://official.example.com/a.jpg' }))
    window.electronAPI = { fetchBingWallpaper: official }

    const result = await fetchBingWallpaper({ pref: 'biturl' })
    expect(official).not.toHaveBeenCalled()
    expect(result.source).toBe('biturl')
  })

  it('S3 有官方通道 + auto：官方优先，成功就不再打镜像', async () => {
    window.electronAPI = {
      fetchBingWallpaper: async () => ({
        url: 'https://www.bing.com/th?id=OHR.Official_ZH-CN.jpg',
        copyright: '官方图 (© a/b)',
        start_date: '20260101'
      })
    }
    const result = await fetchBingWallpaper({ pref: 'auto' })
    expect(result.source).toBe('official')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('S4 官方失败 → 自动退到镜像（换源的意义所在）', async () => {
    window.electronAPI = {
      fetchBingWallpaper: async () => ({ error: 'ENOTFOUND' })
    }
    const result = await fetchBingWallpaper({ pref: 'auto' })
    expect(result.source).toBe('biturl')
    expect(result.tried.some((line) => line.startsWith('official/'))).toBe(true)
  })

  it('S5 地区真的进了请求参数（mkt 不是摆设）', async () => {
    await fetchBingWallpaper({ market: 'ja-JP', pref: 'biturl' })
    const url = global.fetch.mock.calls[0][0]
    expect(url).toContain('mkt=ja-JP')
  })
})

describe('换源 · 图片校验与地址归一化', () => {
  it('V1 地址加载失败（onerror）→ 判定该源不可用并继续换源；全失败才报 error', async () => {
    installImage({ fail: true })
    const result = await fetchBingWallpaper({ pref: 'biturl' })
    expect(result.error).toBeTruthy()
    expect(result.tried.join('\n')).toContain('图片不可加载')
    // 防「空绿」：确实走到了探测这一步，而不是压根没请求
    expect(global.fetch).toHaveBeenCalled()
  })

  it('V2 官方返回站点相对路径 → 归一成绝对地址（否则 CSS url() 会 404）', async () => {
    window.electronAPI = {
      fetchBingWallpaper: async () => ({ url: '/th?id=OHR.Relative_ZH-CN.jpg' })
    }
    const result = await fetchBingWallpaper({ pref: 'official' })
    expect(result.url).toBe('https://www.bing.com/th?id=OHR.Relative_ZH-CN.jpg')
  })

  it('V3 协议相对写法 //host/path 也补成 https', async () => {
    window.electronAPI = {
      fetchBingWallpaper: async () => ({ url: '//www.bing.com/th?id=OHR.Proto.jpg' })
    }
    const result = await fetchBingWallpaper({ pref: 'official' })
    expect(result.url.startsWith('https://')).toBe(true)
  })

  it('V4 非 http(s) 的地址一律当失败（javascript: / data: 不能进 CSS url()）', async () => {
    window.electronAPI = {
      fetchBingWallpaper: async () => ({ url: 'javascript:alert(1)' })
    }
    const result = await fetchBingWallpaper({ pref: 'official' })
    // pref=official 且官方通道存在 → 严格只用官方（用户钉死官方），不偷退镜像：
    // 官方给的地址不合法就是这一轮失败，宁可保留上一张图
    expect(result.url).toBeUndefined()
    expect(result.error).toBeTruthy()
  })

  it('V5 官方给了非法地址、但偏好是 auto → 会自动退到镜像', async () => {
    window.electronAPI = {
      fetchBingWallpaper: async () => ({ url: 'javascript:alert(1)' })
    }
    const result = await fetchBingWallpaper({ pref: 'auto' })
    expect(result.source).toBe('biturl')
    expect(result.url.startsWith('http')).toBe(true)
  })
})

describe('换源 · 并发与兼容性', () => {
  it('C1 同参数并发只打一轮网络（启动 + 手动刷新撞车时）', async () => {
    const [a, b] = await Promise.all([
      fetchBingWallpaper({ market: 'zh-CN', pref: 'biturl' }),
      fetchBingWallpaper({ market: 'zh-CN', pref: 'biturl' })
    ])
    expect(a.url).toBe(b.url)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('C2 旧签名（直接传地区字符串）仍然可用', async () => {
    const result = await fetchBingWallpaper('ja-JP')
    expect(result.error).toBeUndefined()
    expect(global.fetch.mock.calls[0][0]).toContain('mkt=ja-JP')
  })

  it('C3 全源失败时返回 error 且保留逐源留痕（设置页 tooltip 靠它排障）', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }))
    const result = await fetchBingWallpaper({ pref: 'biturl' })
    expect(result.error).toBeTruthy()
    expect(Array.isArray(result.tried)).toBe(true)
    expect(result.tried.length).toBeGreaterThan(0)
  })
})
