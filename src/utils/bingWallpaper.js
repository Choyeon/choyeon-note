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
 *
 * ── 用户可调的两项（换源） ──────────────────────────────────
 * · market：地区（zh-CN / en-US / ja-JP / de-DE），两个源都接受 mkt 参数。
 * · pref   ：数据源偏好 auto（官方优先、失败退镜像）/ official（只用官方，
 *            浏览器等无官方通道的环境自动退化成镜像并留痕）/ biturl（只用镜像，
 *            官方接口不稳时用户可自己钉死镜像）。
 */

/** 成熟公开 API：响应带 ACAO:*，浏览器可直连；支持 resolution/format/index/mkt */
const BITURL_API = 'https://bing.biturl.top'
/** 单次请求超时（ms） */
const TIMEOUT_MS = 8000
/** 图片可达性探测超时（ms）。超时按「通过」处理，理由见 probeImage */
const PROBE_TIMEOUT_MS = 2000

/**
 * 可选地区。白名单而不是自由输入：mkt 是拼进 URL 的查询参数，
 * 放任意字符串进来等于让用户把 URL 改写权交出去。
 */
export const WALLPAPER_MARKETS = Object.freeze([
  { id: 'zh-CN', name: '中国' },
  { id: 'en-US', name: '国际（美国）' },
  { id: 'ja-JP', name: '日本' },
  { id: 'de-DE', name: '德国' }
])

/**
 * 数据源偏好。
 * official 只在 Electron（有主进程通道）下可满足，浏览器下会退化成 biturl
 * 并在 tried 里留一条说明 —— 比「直接报所有源不可用」有用得多。
 */
export const WALLPAPER_SOURCE_PREFS = Object.freeze([
  { id: 'auto', name: '自动（官方优先）' },
  { id: 'official', name: '仅官方接口' },
  { id: 'biturl', name: '仅公开镜像' }
])

/** 来源 → 展示名（设置页与状态栏共用一个出口，别再各抄一份） */
export const WALLPAPER_SOURCE_LABELS = Object.freeze({
  official: '官方接口',
  biturl: '公开镜像'
})

export const DEFAULT_WALLPAPER_MARKET = 'zh-CN'
export const DEFAULT_WALLPAPER_SOURCE_PREF = 'auto'

/** 脏值一律回落到默认值：白名单外的市场/pref 只会换来一次必然失败的请求 */
export function normalizeWallpaperMarket (raw) {
  const value = String(raw || '').trim()
  return WALLPAPER_MARKETS.some((m) => m.id === value) ? value : DEFAULT_WALLPAPER_MARKET
}

export function normalizeWallpaperSourcePref (raw) {
  const value = String(raw || '').trim()
  return WALLPAPER_SOURCE_PREFS.some((p) => p.id === value) ? value : DEFAULT_WALLPAPER_SOURCE_PREF
}

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

/**
 * 图片地址归一化：官方通道返回过 `//www.bing.com/th?id=...` 与 `/th?id=...`
 * 两种相对写法，直接塞进 CSS url() 会解析成应用自身域下的路径 → 背景 404。
 */
function absoluteUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('/')) return `https://www.bing.com${raw}`
  if (!/^https?:\/\//i.test(raw)) return ''
  return raw
}

/**
 * 图片可达性探测。
 *
 * 只有 **onerror**（确定的失败：404 / 非图片响应 / 被拦截）才判失败；
 * 「等到超时也没任何事件」一律按**通过**处理 —— 那通常发生在不支持图片加载的
 * 环境（jsdom / 无资源加载器的 webview）或只是慢，把它判成失败会让这些环境
 * 里永远拿不到壁纸。真正的「源坏了」由 onerror 捕获，正好是换源要处理的情形。
 *
 * @param {string} url 图片地址
 * @returns {Promise<boolean>} 是否可以当作背景使用
 */
function probeImage(url) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.Image !== 'function') {
      resolve(true)
      return
    }
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS)
    try {
      const img = new window.Image()
      img.onload = () => finish(true)
      img.onerror = () => finish(false)
      img.src = url
    } catch (e) {
      // 构造失败（极端 CSP）不应当让整条取源链挂掉
      finish(true)
    }
  })
}

/** ① Electron：主进程官方通道（无 CORS 概念） */
async function fetchViaElectron(market) {
  const res = await window.electronAPI.fetchBingWallpaper(market)
  if (res && res.error) throw new Error(res.error)
  const url = absoluteUrl(res && res.url)
  if (!url) throw new Error('主进程未返回壁纸地址')
  return { ...res, url, source: 'official' }
}

/** ② 公开 API：CORS 就绪，浏览器 / Electron 通用 */
async function fetchViaBiturl(market) {
  const url = `${BITURL_API}/?resolution=1920&format=json&index=0&mkt=${encodeURIComponent(market)}`
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const data = await response.json()
  const image = absoluteUrl(data && data.url)
  if (!image) throw new Error('镜像未返回图片地址')
  const { title, copyright } = splitCopyright(data.copyright)
  return {
    url: image,
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

/**
 * 可用通道与顺序。
 *
 * 官方通道只在 Electron 下存在；pref 决定「是否允许退到镜像」：
 *   auto     —— 官方在前、镜像兜底（默认，最稳）
 *   official —— 只用官方；**没有官方通道时退化为镜像**（否则浏览器下选它 = 永远没壁纸）
 *   biturl   —— 只用镜像（官方接口抽风时的手动避难所）
 *
 * @param {string} pref 已归一化的偏好
 * @param {string[]} tried 失败留痕数组，退化说明写进去
 * @returns {Array<{id:string, run:(mkt:string)=>Promise<object>}>}
 */
function providers(pref, tried) {
  const list = []
  const hasOfficial = typeof window !== 'undefined' && !!window.electronAPI?.fetchBingWallpaper
  if (pref !== 'biturl' && hasOfficial) list.push({ id: 'official', run: fetchViaElectron })
  if (pref !== 'official') {
    list.push({ id: 'biturl', run: fetchViaBiturl })
  } else if (!hasOfficial) {
    tried.push('official: 当前环境无官方通道（需 Electron 主进程），退化为公开镜像')
    list.push({ id: 'biturl', run: fetchViaBiturl })
  }
  if (!list.length) list.push({ id: 'biturl', run: fetchViaBiturl })
  return list
}

/** 同参数并发去重：App 启动与设置页手动刷新撞在一起时只打一轮网络 */
let inflight = null

/**
 * 拉取今日壁纸，多源回退。
 *
 * @param {string|object} [options] 兼容旧用法（直接传 market 字符串），
 *   推荐 `{ market, pref }` —— 两者都来自 appStore，用户可在设置页改。
 * @returns {Promise<{url?:string,title?:string,copyright?:string,date?:string,market?:string,pref?:string,source?:string,error?:string,tried?:string[]}>}
 */
export async function fetchBingWallpaper(options = {}) {
  const opts = typeof options === 'string' ? { market: options } : options
  const market = normalizeWallpaperMarket(opts.market || '')
  const pref = normalizeWallpaperSourcePref(opts.pref || '')
  const key = `${market}|${pref}`

  if (inflight && inflight.key === key) return inflight.promise

  const task = (async () => {
    const tried = []
    // 官方通道内部已做 mkt 回退，没必要重复请求
    const mkts = market === 'en-US' ? ['en-US'] : [market, 'en-US']

    for (const p of providers(pref, tried)) {
      const markets = p.id === 'official' ? [market] : mkts
      for (const mkt of markets) {
        let result
        try {
          result = await withTimeout(p.run(mkt), TIMEOUT_MS, p.id)
          if (result && result.url) {
            tried.push(`${p.id}/${mkt}: 拿到地址，校验图片…`)
            const ok = await probeImage(result.url)
            if (!ok) {
              tried.push(`${p.id}/${mkt}: 图片不可加载，换下一个源`)
              continue
            }
            return { ...result, market, pref, tried }
          }
          tried.push(`${p.id}/${mkt}: 未返回图片地址`)
        } catch (e) {
          tried.push(`${p.id}/${mkt}: ${(e && e.message) || e}`)
        }
      }
    }

    return { error: '所有壁纸源均不可用', market, pref, tried }
  })()

  inflight = { key, promise: task }
  try {
    return await task
  } finally {
    if (inflight && inflight.key === key) inflight = null
  }
}
