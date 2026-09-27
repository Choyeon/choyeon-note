import { FENCE_RE, FRONTMATTER_RE, CALLOUT_RE, TABLE_DELIM_CELL_RE } from './constants.js'

// ---------------------------------------------------------------------------
// 块级扫描：表格 / 代码块 / frontmatter / callout / 光标行
// ---------------------------------------------------------------------------

/**
 * CodeMirror 的 Text 是不可变持久结构，同一引用即可作为文档版本号；文档变化时
 * 会产生新对象。使用 WeakMap 可让旧文档对象被回收时自动释放缓存，避免泄漏。
 * collectActiveLines 依赖 selection 而不只依赖 doc，因此明确不纳入这层缓存。
 */
const scanCache = new WeakMap()

function docCache (doc) {
  let cache = scanCache.get(doc)
  if (!cache) {
    cache = {}
    scanCache.set(doc, cache)
  }
  return cache
}

/** 按未转义的 `|` 切分单元格；去掉首尾因 `|a|b|` 写法产生的空单元格 */
export function splitTableRow (text) {
  const trimmed = String(text).trim()
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  return cells.map(c => c.trim())
}

export function isDelimiterRow (text) {
  const cells = splitTableRow(text)
  return cells.length > 0 && cells.every(c => TABLE_DELIM_CELL_RE.test(c))
}

/** `:---` 左 / `---:` 右 / `:---:` 中 */
export function alignsFromDelimiter (text) {
  return splitTableRow(text).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/** 全文扫描 GFM 表格块（表头行 + 分隔行 + 连续的表体行） */
function collectTablesRaw (state, skipLines) {
  const tables = []
  const total = state.doc.lines
  let n = 1
  while (n < total) {
    const head = state.doc.line(n)
    if (skipLines.has(n) || !head.text.includes('|')) {
      n++
      continue
    }
    const delim = state.doc.line(n + 1)
    if (skipLines.has(n + 1) || !isDelimiterRow(delim.text)) {
      n++
      continue
    }
    const header = splitTableRow(head.text)
    const aligns = alignsFromDelimiter(delim.text)
    if (!header.length || header.length !== aligns.length) {
      n++
      continue
    }
    const rows = []
    let end = n + 1
    for (let m = n + 2; m <= total; m++) {
      const line = state.doc.line(m)
      if (skipLines.has(m) || !line.text.trim() || !line.text.includes('|')) break
      rows.push({ line: m, cells: splitTableRow(line.text) })
      end = m
    }
    tables.push({
      start: n,
      end,
      header,
      aligns,
      rows,
      key: JSON.stringify([header, aligns, rows.map(r => r.cells)])
    })
    n = end + 1
  }
  return tables
}

// doc 引用就是版本号，WeakMap 会随旧文档回收；skipLines 引用变化时必须重算
export function collectTables (state, skipLines) {
  const cache = docCache(state.doc)
  const cached = cache.tables
  if (cached && cached.skipLines === skipLines) return cached.value

  const tables = collectTablesRaw(state, skipLines)
  cache.tables = { skipLines, value: tables }
  return tables
}

/**
 * 光标 / 选区覆盖到的行：这些行永远保持源码，保证语法本身可编辑。
 * 此结果依赖 selection，即使 doc 引用不变也可能变化，因此不能记忆化。
 */
export function collectActiveLines (state) {
  const lines = new Set()
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number
    const endLine = state.doc.lineAt(range.to).number
    for (let n = startLine; n <= endLine; n++) lines.add(n)
  }
  return lines
}

export function activeLinesIntersect (activeLines, start, end) {
  for (let n = start; n <= end; n++) if (activeLines.has(n)) return true
  return false
}

/**
 * 一次扫描同时得到：
 *  - lines：所有属于代码块的行（含围栏行）
 *  - blocks：按「开围栏 -> 闭围栏」成组，供整块高亮与容器外观使用
 */
function collectCodeBlocksRaw (state) {
  const lines = new Set()
  const blocks = []
  let inFence = false
  let fenceMarker = ''
  let open = null
  for (let n = 1; n <= state.doc.lines; n++) {
    const fence = state.doc.line(n).text.match(FENCE_RE)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
        open = {
          start: n,
          end: n,
          fenceChar: fence[1][0],
          lang: (fence[2] || '').trim().split(/\s+/)[0] || '',
          closed: false
        }
      } else if (fence[1].startsWith(fenceMarker[0]) && (fence[2] || '').trim() === '') {
        inFence = false
        fenceMarker = ''
        if (open) {
          open.end = n
          open.closed = true
          blocks.push(open)
          open = null
        }
      }
      lines.add(n)
    } else if (inFence) {
      lines.add(n)
      if (open) open.end = n
    }
  }
  if (open) blocks.push(open) // 未闭合的围栏
  return { lines, blocks }
}

// doc 引用就是版本号，WeakMap 会随旧文档回收，重复调用直接复用完整扫描结果
export function collectCodeBlocks (state) {
  const cache = docCache(state.doc)
  if (!cache.codeBlocks) cache.codeBlocks = collectCodeBlocksRaw(state)
  return cache.codeBlocks
}

/**
 * callout 块：头行 `> [!type] 标题` + 之后连续的 `>` 行，边界与
 * markdown.js 里 parseCallouts 的判定保持一致（头行起，直到非 `>` 行）。
 */
function collectCalloutBlocksRaw (state) {
  const blocks = []
  const total = state.doc.lines
  let n = 1
  while (n <= total) {
    const head = state.doc.line(n).text.match(CALLOUT_RE)
    if (!head) { n++; continue }
    let end = n
    while (end + 1 <= total && /^>/.test(state.doc.line(end + 1).text)) end++
    blocks.push({ start: n, end, type: head[1].toLowerCase() })
    n = end + 1
  }
  return blocks
}

// doc 引用就是版本号，WeakMap 会随旧文档回收，callout 块可安全按文档复用
export function collectCalloutBlocks (state) {
  const cache = docCache(state.doc)
  if (!cache.calloutBlocks) cache.calloutBlocks = collectCalloutBlocksRaw(state)
  return cache.calloutBlocks
}

function collectFrontmatterLinesRaw (state) {
  const lines = new Set()
  if (state.doc.lines > 0 && FRONTMATTER_RE.test(state.doc.line(1).text)) {
    for (let n = 2; n <= state.doc.lines; n++) {
      lines.add(n)
      if (FRONTMATTER_RE.test(state.doc.line(n).text)) break
    }
    lines.add(1)
  }
  return lines
}

// doc 引用就是版本号，WeakMap 会随旧文档回收，frontmatter 行集合可直接复用
export function collectFrontmatterLines (state) {
  const cache = docCache(state.doc)
  if (!cache.frontmatterLines) {
    cache.frontmatterLines = collectFrontmatterLinesRaw(state)
  }
  return cache.frontmatterLines
}
