import { Decoration } from '@codemirror/view'
import {
  WIKILINK_RE,
  MD_LINK_RE,
  TAG_RE,
  URL_RE,
  IMAGE_SRC_RE
} from './constants.js'
import { EmbedWidget, ImageWidget } from './widgets.js'

// ---------------------------------------------------------------------------
// 行内语法扫描
// ---------------------------------------------------------------------------

/**
 * 双链目标是否存在由外部注入 —— 与阅读视图用的是同一个
 * `noteStore.resolveWikiForRender`，因此「未创建」的链接在两种模式下
 * 会一起变成灰色斜体 + 虚线框（对应 `a.wikilink.is-unresolved`）。
 * 没注入时一律按「已解析」处理，避免整篇笔记的链接全被标灰。
 */
let wikiResolver = null
export function setWikiResolver (fn) {
  wikiResolver = typeof fn === 'function' ? fn : null
}

function wikilinkClass (target) {
  if (!wikiResolver) return 'cm-md-wikilink'
  let ok = false
  try {
    ok = !!(wikiResolver(target) || {}).resolved
  } catch {
    ok = false
  }
  return ok ? 'cm-md-wikilink' : 'cm-md-wikilink cm-md-wikilink-missing'
}

function escapeHtml (s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 单元格内容的行内渲染。刻意只实现与阅读视图一致的那一小撮语法
 * （代码 / 双链 / 链接 / 粗体 / 斜体 / 删除线 / 高亮），
 * 不引入 marked —— 编辑器渲染路径必须保持轻量。
 */
export function renderInlineHtml (src) {
  if (!src) return ''
  const codes = []
  let s = String(src).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return '\u0000' + (codes.length - 1) + '\u0000'
  })
  s = escapeHtml(s)
  // 双链 [[target|alias]]
  s = s.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) =>
    `<span class="wikilink is-resolved">${alias || target}</span>`
  )
  // 链接 [text](url)
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, text, url) =>
    `<span class="md-external-link">${text}</span>`
  )
  // 强调
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
  // 行内代码（内容单独转义，避免 placeholder 之前已被转义导致双重转义）
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) =>
    `<code>${escapeHtml(codes[Number(i)] || '')}</code>`
  )
  return s
}

function overlaps(list, range) {
  return list.some(r => range.start < r.end && r.start < range.end)
}

/** 通用定界符扫描：处理 **bold** / ==mark== / ~~strike~~ / `code` */
export function scanDelimited(text, delim, cls, occupied = []) {
  const out = []
  const len = delim.length
  let i = 0
  while (i < text.length) {
    if (!text.startsWith(delim, i)) {
      i++
      continue
    }
    if (i > 0 && text[i - 1] === '\\') {
      i += len
      continue
    }
    const contentStart = i + len
    if (contentStart >= text.length) break
    if (/\s/.test(text[contentStart])) {
      i += len
      continue
    }
    let close = -1
    for (let j = contentStart; j < text.length; j++) {
      if (text.startsWith(delim, j)) {
        close = j
        break
      }
    }
    if (close === -1 || close === contentStart) break
    const inner = text.slice(contentStart, close)
    if (inner.includes('\n')) break
    // 结束定界符前必须是非空白，避免 "a ** b **" 被误判
    if (/\s/.test(inner[inner.length - 1])) {
      i = close + len
      continue
    }
    const range = { start: i, end: close + len, cls, markerLen: len }
    if (!overlaps(out, range) && !overlaps(occupied, range)) out.push(range)
    i = close + len
  }
  return out
}

/** 斜体：需要避开 ** 强调用掉的区间，否则 *a**b**c* 会被切错 */
export function scanEmphasis(text, occupied) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '*' && text[i] !== '_') continue
    const ch = text[i]
    if (text[i - 1] === ch || text[i + 1] === ch) continue
    // `_` 遵循 CommonMark 严格规则（左侧不能是字母/数字/汉字）；
    // `*` 只要求左侧非空白即可开启 —— 「和*斜体*和」这类中文相邻必须生效
    if (ch === '_' && i > 0 && /[\w\u4e00-\u9fa5]/.test(text[i - 1])) continue
    let close = -1
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\n') break
      if (text[j] === ch && text[j + 1] !== ch && text[j - 1] !== '\\') {
        close = j
        break
      }
    }
    if (close === -1 || close === i + 1) continue
    const inner = text.slice(i + 1, close)
    if (!inner.trim() || /\s/.test(inner[0])) continue
    const range = { start: i, end: close + 1, cls: 'em', markerLen: 1 }
    if (!overlaps(out, range) && !overlaps(occupied, range)) {
      out.push(range)
      i = close
    }
  }
  return out
}

const INLINE_CLASS = {
  strong: 'cm-md-strong',
  em: 'cm-md-em',
  highlight: 'cm-md-highlight',
  strike: 'cm-md-strike',
  code: 'cm-md-inline-code'
}

/** 行内：emoji/highlight/strong/em/strike/code/wikilink/link/tag/url */
export function scanInline(text, from, decos, startAt = 0) {
  const occupied = []

  const push = (ranges) => {
    for (const r of ranges) {
      if (!overlaps(occupied, r)) occupied.push(r)
    }
  }

  push(scanDelimited(text, '`', 'code'))
  push(scanDelimited(text, '**', 'strong', occupied))
  push(scanDelimited(text, '__', 'strong', occupied))
  push(scanDelimited(text, '==', 'highlight', occupied))
  push(scanDelimited(text, '~~', 'strike', occupied))
  push(scanEmphasis(text, occupied))

  // 位置保护：已经归为「代码 / 链接 / 标签」的区间不再做强调解析
  const protectedRanges = []

  const isProtected = (start, end) =>
    protectedRanges.some(r => start < r.end && r.start < end) ||
    [...occupied, ...protectedRanges].some(r => start < r.end && r.start < end)

  // --- 代码块 / 行内代码优先：内部的 * _ 不应被解析 ---
  for (const r of occupied) {
    if (r.cls === 'code') protectedRanges.push(r)
  }

  // --- Wikilink [[target|alias]] ---
  WIKILINK_RE.lastIndex = 0
  let match
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (start < startAt) continue
    if (isProtected(start, end)) continue
    protectedRanges.push({ start, end })
    const isEmbed = match[1] === '!'
    const aliasPart = match[4]
    if (isEmbed) {
      // ![[笔记]] 与阅读视图一致：渲染成嵌入卡片，而不是一个双链
      decos.push(
        Decoration.replace({ widget: new EmbedWidget(match[2].trim()) }).range(from + start, from + end)
      )
      continue
    }
    // 隐藏 "[["
    decos.push(Decoration.replace({}).range(from + start, from + start + (isEmbed ? 3 : 2)))
    // 隐藏 "]]"
    decos.push(Decoration.replace({}).range(from + end - 2, from + end))
    const linkCls = wikilinkClass(match[2].trim())
    if (aliasPart !== undefined) {
      // 有别名：隐藏 "target|"，只展示别名
      const barIndex = text.indexOf('|', start)
      decos.push(Decoration.replace({}).range(from + start + 2, from + barIndex + 1))
      decos.push(
        Decoration.mark({ class: linkCls }).range(from + barIndex + 1, from + end - 2)
      )
    } else {
      decos.push(
        Decoration.mark({ class: linkCls }).range(from + start + 2, from + end - 2)
      )
    }
  }

  // --- Markdown 链接 [text](url) ---
  MD_LINK_RE.lastIndex = 0
  while ((match = MD_LINK_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (start < startAt) continue
    if (isProtected(start, end)) continue
    protectedRanges.push({ start, end })
    const isImage = match[1] === '!'
    const label = match[2]
    const url = match[3]
    const labelStart = start + (isImage ? 2 : 1)
    const labelEnd = labelStart + label.length
    const urlStart = text.indexOf('(', labelEnd) + 1
    const urlEnd = urlStart + url.length

    if (isImage && IMAGE_SRC_RE.test(url)) {
      // 图片直接渲染，和阅读视图的 <img> 对齐；加载失败时退回 alt 文本
      decos.push(
        Decoration.replace({ widget: new ImageWidget(url, label) }).range(from + start, from + urlEnd + 1)
      )
      continue
    }

    decos.push(Decoration.replace({}).range(from + start, from + labelStart))
    decos.push(Decoration.replace({}).range(from + labelEnd, from + urlEnd + 1))
    decos.push(
      Decoration.mark({
        class: isImage ? 'cm-md-image' : 'cm-md-link',
        attributes: { 'data-md-href': url }
      }).range(from + labelStart, from + labelEnd)
    )
  }

  // --- 标签 #tag ---
  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(text)) !== null) {
    const leading = match[1] ? match[1].length : 0
    const start = match.index + leading
    const end = start + match[0].length - leading
    if (start < startAt) continue
    if (isProtected(start, end)) continue
    protectedRanges.push({ start, end })
    decos.push(
      Decoration.mark({ class: 'cm-md-tag' }).range(from + start, from + end)
    )
  }

  // --- 裸 URL ---
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (start < startAt) continue
    if (isProtected(start, end)) continue
    protectedRanges.push({ start, end })
    decos.push(
      Decoration.mark({
        class: 'cm-md-bare-url',
        attributes: { 'data-md-href': match[0] }
      }).range(from + start, from + end)
    )
  }

  // --- 强调类：隐藏定界符 + 内容加类 ---
  // 注意：这里只能检查 protectedRanges（code/wikilink/link/tag/url 的区间），
  // 且必须排除区间自身 —— 否则每个区间都会「与自己重叠」而被跳过：
  // 旧代码用 isProtected（额外匹配 occupied）导致粗体/斜体/高亮/删除线全部失效；
  // 若不自排除，行内代码（code 同样在 protectedRanges 中）会失效。
  for (const r of occupied) {
    if (protectedRanges.some(pr => pr !== r && r.start < pr.end && pr.start < r.end)) continue
    const cls = INLINE_CLASS[r.cls]
    if (!cls) continue
    decos.push(Decoration.replace({}).range(from + r.start, from + r.start + r.markerLen))
    decos.push(Decoration.replace({}).range(from + r.end - r.markerLen, from + r.end))
    decos.push(
      Decoration.mark({ class: cls }).range(from + r.start + r.markerLen, from + r.end - r.markerLen)
    )
  }
}
