// 与阅读视图（src/utils/markdown.js）使用同一个 hljs 精简集；着色直接复用
// 它注入的 .hljs-* 主题 CSS，两种模式因此天然一致
import hljs from 'highlight.js/lib/common'

// ---------------------------------------------------------------------------
// 代码块高亮：把 hljs 的输出翻译成文档区间上的 token 装饰
// ---------------------------------------------------------------------------

// 使用 LRU 而不是超限时 clear，避免正在编辑的长代码块瞬间失去全部高亮缓存
const HLJS_CACHE_LIMIT = 60
const hljsCache = new Map()

function decodeEntities (s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** hljs 的 HTML -> [{ text, cls }]，支持嵌套 span（如 string > subst） */
export function tokenizeHighlight (html) {
  const out = []
  const stack = []
  const re = /<span class="([^"]*)">|<\/span>/g
  let last = 0
  let m
  const flush = (end) => {
    if (end > last) {
      const raw = html.slice(last, end)
      if (raw) out.push({ text: decodeEntities(raw), cls: stack.length ? stack.join(' ') : null })
    }
  }
  while ((m = re.exec(html)) !== null) {
    flush(m.index)
    last = re.lastIndex
    if (m[1] !== undefined) stack.push(m[1])
    else if (stack.length) stack.pop()
  }
  flush(html.length)
  return out
}

export function highlightCode (text, lang) {
  const key = lang + '\u0000' + text
  if (hljsCache.has(key)) {
    const cachedTokens = hljsCache.get(key)
    hljsCache.delete(key)
    hljsCache.set(key, cachedTokens)
    return cachedTokens
  }
  let tokens = null
  try {
    const html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(text).value
    tokens = tokenizeHighlight(html)
  } catch {
    tokens = null
  }
  hljsCache.set(key, tokens)
  while (hljsCache.size > HLJS_CACHE_LIMIT) {
    const oldestKey = hljsCache.keys().next().value
    hljsCache.delete(oldestKey)
  }
  return tokens
}
