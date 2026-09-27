/**
 * 日期格式化。
 *
 * 之前 4 个视图各写一份 formatDate，输出格式还不统一（列表要「时分」，阅读/标签
 * 页只要「日期」，快速切换器要相对时间）。收敛到一处后用 style 参数区分，
 * 每个调用点传自己原来的 style，输出保持逐字一致。
 *
 * style:
 *  - 'datetime' → YYYY-MM-DD HH:mm
 *  - 'date'     → YYYY-MM-DD
 *  - 'time'     → HH:mm
 *  - 'relative' → 刚刚 / N 分钟前 / N 小时前 / N 天前 / 本地日期
 */

const pad2 = (n) => String(n).padStart(2, '0')

/** 转成 Date；无法解析时返回 null */
function toDate (value) {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 相对时间。入参原样参与差值运算，与历史实现保持一致（Date / 时间戳都能算） */
function formatRelative (value) {
  if (!value) return '未知时间'
  try {
    const d = new Date(value)
    const now = Date.now()
    const diff = (now - value) / 1000
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`
    return d.toLocaleDateString()
  } catch {
    return ''
  }
}

/**
 * 格式化日期。
 * @param {Date|number|string|null|undefined} date 日期值
 * @param {'datetime'|'date'|'time'|'relative'} [style='datetime'] 输出风格
 * @returns {string} 空值或非法日期时返回原调用点的兜底值（'' 或 '未知时间'）
 */
export function formatDate (date, style = 'datetime') {
  if (style === 'relative') return formatRelative(date)
  if (!date) return ''
  const d = toDate(date)
  if (!d) return ''
  const year = d.getFullYear()
  const month = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  if (style === 'date') return `${year}-${month}-${day}`
  if (style === 'time') return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return `${year}-${month}-${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 按天分组用的日期键（YYYY-MM-DD，本地时区）。
 * 直接 new Date(...).toDateString() 会带上星期且受 locale 影响，不适合做 key。
 * @param {Date|number|string|null|undefined} date 日期值
 * @returns {string} 非法日期返回 ''
 */
export function formatDateKey (date) {
  if (!date) return ''
  const d = toDate(date)
  if (!d) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
