/**
 * Bing 每日壁纸。
 *
 * ── CORS 真相（实测结论，别再走回头路）──────────────────────────
 * 官方接口 https://www.bing.com/HPImageArchive.aspx 的响应里
 * **没有 Access-Control-Allow-Origin**，所以「渲染进程直接 fetch」在任何
 * web 环境下都必挂（表现为开关能打开、背景永远是默认图）。
 * 官方也不再支持 JSONP：加 `&cb=xxx` 会被忽略，仍然返回纯 JSON。
 *
 * ── 分层取源策略 ────────────────────────────────────────────
 * 1) Electron：主进程 net.request 直连官方（主进程不受同源策略约束，
 *    还能自动跟随系统代理）—— 权威数据源，首选。
 * 2) 任意环境（含浏览器 dev）：bing.biturl.top —— 网上成熟的公开 Bing 壁纸
 *    API，响应带 `Access-Control-Allow-Origin: *`，可直接 fetch。
 * 3) 任一源失败自动换下一个（含 mkt 回退 zh-CN → en-US）。
 * 全部失败才返回 error，调用方会保留上一张图，背景不会变黑。
 */

/** 成熟公开 API：响应带 ACAO:*，浏览器可直连；支持 resolution/format/index/mkt */
const BITURL_API = 'https://bing.biturl.top'
/** 单次请求超时（ms） */
const TIMEOUT_MS = 8000

/** 官方 copyright 形如「地肤田，中国 (© lingqi xie/Getty Images)」，拆出标题 */
function splitCopyright(text) {
  const raw = String(text || '').trim()
  if (!raw) return { title: '', copyright: '' }
  const m = raw.match(/^(.*?)\s*[（(]/)
  return { title: (m ? m[1] : raw).trim(), copyright: raw }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms)
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}

/** ① Electron：主进程官方通道（无 CORS 概念） */
async function fetchViaElectron(market) {
  const res = await window.electronAPI.fetchBingWallpaper(market)
  if (res && res.error) throw new Error(res.error)
  if (!res || !res.url) throw new Error('主进程未返回壁纸地址')
  return { ...res, source: 'official' }
}

/** ② 公开 API：CORS 就绪，浏览器 / Electron 通用 */
async function fetchViaBiturl(market) {
  const url = `${BITURL_API}/?resolution=1920&format=json&index=0&mkt=${encodeURIComponent(market)}`
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const data = await response.json()
  if (!data || !data.url) throw new Error('镜像未返回图片地址')
  const { title, copyright } = splitCopyright(data.copyright)
  return {
    url: data.url,
    title,
    copyright,
    date: data.start_date || '',
    market,
    source: 'biturl'
  }
}

/** 今天的 Bing 日期格式（YYYYMMDD），用于判断缓存是否过期 */
export function todayStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 可用通道：Electron 下官方在前，浏览器下只剩公开 API */
function providers() {
  const list = []
  if (typeof window !== 'undefined' && window.electronAPI?.fetchBingWallpaper) {
    list.push({ id: 'official', run: fetchViaElectron })
  }
  list.push({ id: 'biturl', run: fetchViaBiturl })
  return list
}

/**
 * 拉取今日壁纸，多源回退。
 * @param {string} market 地区，如 zh-CN / en-US
 * @returns {Promise<{url?:string,title?:string,copyright?:string,date?:string,market?:string,source?:string,error?:string,tried?:string[]}>}
 */
export async function fetchBingWallpaper(market = 'zh-CN') {
  const tried = []
  const mkts = market === 'en-US' ? ['en-US'] : [market, 'en-US']

  for (const p of providers()) {
    // 官方通道内部已做 mkt 回退，没必要重复请求
    const markets = p.id === 'official' ? [market] : mkts
    for (const mkt of markets) {
      try {
        const result = await withTimeout(p.run(mkt), TIMEOUT_MS, p.id)
        if (result && result.url) return { ...result, tried }
        tried.push(`${p.id}/${mkt}: 未返回图片地址`)
      } catch (e) {
        tried.push(`${p.id}/${mkt}: ${(e && e.message) || e}`)
      }
    }
  }

  return { error: '所有壁纸源均不可用', tried }
}
