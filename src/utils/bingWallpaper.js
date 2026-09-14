/**
 * Bing 每日壁纸。
 *
 * 之前渲染进程直接 fetch www.bing.com 的 HPImageArchive 接口：该接口不带
 * Access-Control-Allow-Origin，浏览器/Electron 渲染进程会被 CORS 拦掉，
 * 表现为"开关能打开但背景永远是默认图"。
 *
 * 所以 Electron 下一律走主进程（electron/main.cjs 的 bing:fetch-wallpaper，
 * 用 net.request 请求，还能自动走系统代理）；浏览器 dev 环境保留直连以便排查。
 */
const API = 'https://www.bing.com/HPImageArchive.aspx'

function toAbsolute(url) {
  if (!url) return ''
  return /^https?:/i.test(url) ? url : 'https://www.bing.com' + url
}

function normalize(image, market) {
  return {
    url: toAbsolute(image.url),
    title: image.title || '',
    copyright: image.copyright || '',
    date: image.startdate || '',
    market
  }
}

/** 今天的 Bing 日期格式（YYYYMMDD），用于判断缓存是否过期 */
export function todayStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/**
 * @param {string} market 地区，如 zh-CN / en-US
 * @returns {Promise<{url?:string, title?:string, copyright?:string, date?:string, market?:string, error?:string}>}
 */
export async function fetchBingWallpaper(market = 'zh-CN') {
  if (typeof window !== 'undefined' && window.electronAPI?.fetchBingWallpaper) {
    try {
      const res = await window.electronAPI.fetchBingWallpaper(market)
      if (res && res.error) return { error: res.error }
      if (res && res.url) return res
      return { error: '主进程未返回壁纸地址' }
    } catch (e) {
      // invoke 直接 reject（例如预加载脚本未更新）时也要有明确提示
      return { error: (e && e.message) || '调用主进程失败' }
    }
  }

  try {
    const response = await fetch(
      `${API}?format=js&idx=0&n=1&mkt=${encodeURIComponent(market)}`
    )
    if (!response.ok) return { error: 'HTTP ' + response.status }
    const data = await response.json()
    const image = data && data.images && data.images[0]
    if (!image || !image.url) return { error: '接口未返回图片地址' }
    return normalize(image, market)
  } catch (e) {
    return { error: (e && e.message) || '网络请求失败（浏览器环境可能被 CORS 拦截）' }
  }
}
