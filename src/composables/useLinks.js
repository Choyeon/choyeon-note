// ============================================================================
// useLinks.js —— 纯函数的 Obsidian 风格链接 / frontmatter / tag 解析层
// 契约：所有导出函数均 (input, ctx?) => output，可单测、可复用。
// ============================================================================

// ---------------------------------------------------------------------------
// 1) Frontmatter 解析 & 字符串化 (轻量 YAML 子集： key: scalar | [a, b])
//    支持注释 (#..)、key: value、key: [a,b]、key:\n- a\n- b 三种常见形式
// ---------------------------------------------------------------------------
const FM_START = /^---\s*\n/
const FM_FENCE = /^---\s*\n([\s\S]*?)\n---\s*\n?/m

export function parseFrontmatter (md) {
  if (typeof md !== 'string') return { frontmatter: {}, body: md || '', hasFrontmatter: false }
  if (!FM_START.test(md)) return { frontmatter: {}, body: md, hasFrontmatter: false }
  const m = md.match(FM_FENCE)
  if (!m) return { frontmatter: {}, body: md, hasFrontmatter: false }
  const raw = m[1]
  const frontmatter = {}
  // 先按行拆分，处理 block sequence（- item）
  const lines = raw.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 空行 / 注释
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue }
    const header = line.match(/^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*:\s*(.*)$/)
    if (!header) { i++; continue }
    const key = header[1]
    const inline = header[2].trim()
    if (inline) {
      // 行内：值 / [a, b, "c d"]
      if (inline.startsWith('[')) {
        frontmatter[key] = parseInlineArray(inline)
      } else {
        frontmatter[key] = unquote(inline)
      }
      i++
    } else {
      // block sequence
      const items = []
      i++
      while (i < lines.length) {
        const seq = lines[i].match(/^\s*-\s+(.*)$/)
        if (!seq) break
        items.push(unquote(seq[1].trim()))
        i++
      }
      frontmatter[key] = items
    }
  }
  const body = md.substring(m[0].length)
  return { frontmatter, body, hasFrontmatter: true, rawFrontmatter: m[1] }
}

function parseInlineArray (s) {
  const inner = s.replace(/^\[(.*)\]$/, '$1').trim()
  if (!inner) return []
  const out = []
  let buf = ''
  let inStr = null
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k]
    if (inStr) {
      if (ch === inStr) inStr = null
      else buf += ch
    } else if (ch === '"' || ch === "'") {
      inStr = ch
    } else if (ch === ',') {
      const v = buf.trim()
      if (v) out.push(unquote(v))
      buf = ''
    } else {
      buf += ch
    }
  }
  const tail = buf.trim()
  if (tail) out.push(unquote(tail))
  return out
}

function unquote (s) {
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) {
    return s.slice(1, -1)
  }
  // 布尔 & 数字 简单推断（Obsidian Properties 偏好）
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

export function stringifyFrontmatter (frontmatter, body = '') {
  const keys = Object.keys(frontmatter || {})
  if (keys.length === 0) return body.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/m, '')
  const lines = ['---']
  for (const k of keys) {
    const v = frontmatter[k]
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`)
      } else if (v.length <= 3 && v.every(x => typeof x === 'string' && x.length < 24 && !/[",]/.test(x))) {
        lines.push(`${k}: [${v.map(x => `"${String(x).replace(/"/g, '\\"')}"`).join(', ')}]`)
      } else {
        lines.push(`${k}:`)
        for (const item of v) lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`)
      }
    } else if (v === null || v === undefined) {
      lines.push(`${k}: `)
    } else if (typeof v === 'boolean') {
      lines.push(`${k}: ${v ? 'true' : 'false'}`)
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`)
    } else {
      const s = String(v)
      const needQuote = /[:#\[\]{}|&*!>'"`]/.test(s) || s.trim() !== s
      lines.push(needQuote ? `${k}: "${s.replace(/"/g, '\\"')}"` : `${k}: ${s}`)
    }
  }
  lines.push('---')
  const tail = body ? (body.startsWith('\n') ? body : '\n' + body) : ''
  return lines.join('\n') + tail
}

// ---------------------------------------------------------------------------
// 2) 工具：剥离 fenced code 与 inline code，防止正则"[[ ]]"误匹配
//    用零宽占位符 U+FFFF 区间内下标替换，结束后再还原
// ---------------------------------------------------------------------------
const PLACEHOLDER = '\u0000'
function maskCodes (text) {
  const codes = []
  let out = ''
  let i = 0
  while (i < text.length) {
    // fence ``` ... ```
    if (text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
      let j = i + 3
      while (j < text.length) {
        if (text[j] === '`' && text[j + 1] === '`' && text[j + 2] === '`') {
          j += 3
          break
        }
        j++
      }
      codes.push(text.slice(i, j))
      out += PLACEHOLDER + (codes.length - 1) + PLACEHOLDER
      i = j
      continue
    }
    // inline `...`
    if (text[i] === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== '`' && text[j] !== '\n') j++
      if (text[j] === '`') {
        j++
        codes.push(text.slice(i, j))
        out += PLACEHOLDER + (codes.length - 1) + PLACEHOLDER
        i = j
        continue
      }
    }
    out += text[i]
    i++
  }
  return { masked: out, codes }
}
function unmaskCodes (masked, codes) {
  return masked.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_, idx) => codes[+idx] || '')
}

// ---------------------------------------------------------------------------
// 3) Wiki 链接解析 [[target#hash|alias]] 与 ![[target]]
// ---------------------------------------------------------------------------
const WIKI_REGEX = /(!?)\[\[([^\]#|\r\n]+)(#[^\]|\r\n]+)?(\|[^\]\r\n]+)?\]\]/g

export function parseWikiLinks (md) {
  if (!md) return []
  const { masked, codes } = maskCodes(md)
  const results = []
  const re = new RegExp(WIKI_REGEX.source, WIKI_REGEX.flags)
  let m
  while ((m = re.exec(masked)) !== null) {
    // 占位符不会命中真实字符，但要还原 start/end 在原字符串的位置：
    // 因占位符长度和原代码块长度不同，本函数 start/end 采用 masked 偏移，
    // 仅用于"匹配计数/内容"，若需要 source-map，在 unmask 后重扫。
    const embed = m[1] === '!'
    const target = m[2].trim()
    const hash = (m[3] || '').replace(/^#/, '') || ''
    const alias = (m[4] || '').replace(/^\|/, '') || ''
    results.push({
      raw: unmaskCodes(m[0], codes),
      embed,
      target,
      hash,
      alias,
      start: m.index,
      end: m.index + m[0].length
    })
  }
  return results
}

// 与 parseWikiLinks 相同，但 start/end 是基于原始字符串的偏移（性能略低，用于 hover 定位）
export function parseWikiLinksWithSourceMap (md) {
  if (!md) return []
  const results = []
  const tokens = scanCodes(md)
  let idx = 0
  const re = new RegExp(WIKI_REGEX.source, WIKI_REGEX.flags)
  let m
  while ((m = re.exec(md)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (inCode(tokens, start, end)) continue
    const embed = m[1] === '!'
    const target = m[2].trim()
    const hash = (m[3] || '').replace(/^#/, '') || ''
    const alias = (m[4] || '').replace(/^\|/, '') || ''
    results.push({ raw: m[0], embed, target, hash, alias, start, end })
    idx = end
  }
  return results
}
function scanCodes (text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
      let j = i + 3
      while (j < text.length) {
        if (text[j] === '`' && text[j + 1] === '`' && text[j + 2] === '`') { j += 3; break }
        j++
      }
      tokens.push([i, j])
      i = j
      continue
    }
    if (text[i] === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== '`' && text[j] !== '\n') j++
      if (text[j] === '`') {
        tokens.push([i, j + 1])
        i = j + 1
        continue
      }
    }
    i++
  }
  return tokens
}
function inCode (tokens, start, end) {
  return tokens.some(([a, b]) => start >= a && end <= b)
}

// ---------------------------------------------------------------------------
// 4) Tags 提取：frontmatter.tags + 正文 #tag (非链接锚 / 非代码块)
// ---------------------------------------------------------------------------
const TAG_REGEX = /(^|\s)#([A-Za-z0-9_\u4e00-\u9fa5-]+)/g

export function extractTags (md) {
  const set = new Set()
  const { frontmatter, body } = parseFrontmatter(md)
  const fmt = frontmatter.tags
  if (Array.isArray(fmt)) fmt.forEach(t => set.add(String(t)))
  else if (fmt) String(fmt).split(',').forEach(t => set.add(t.trim()))

  if (body) {
    const { masked } = maskCodes(body)
    // 剔掉 md 标题 `### heading` 中的头 #
    const cleaned = masked.replace(/^#{1,6}\s+/gm, (m) => ' '.repeat(m.length))
    const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags)
    let mm
    while ((mm = re.exec(cleaned)) !== null) set.add(mm[2])
  }
  return Array.from(set)
}

// ---------------------------------------------------------------------------
// 5) Callouts 提取：> [!type] title
// ---------------------------------------------------------------------------
const CALLOUT_LINE = /^>\s*\[!(note|tip|info|todo|important|warning|caution|failure|danger|bug|example|quote|success|question|abstract|summary|tldr|hint|attention|fail|error|missing)\]\s*(.*)$/i

export function parseCallouts (md) {
  if (!md) return []
  const list = []
  const lines = md.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const header = line.match(CALLOUT_LINE)
    if (header) {
      const start = i
      const type = header[1].toLowerCase()
      const title = header[2].trim()
      const blockLines = [line]
      i++
      while (i < lines.length && /^>/.test(lines[i])) {
        blockLines.push(lines[i])
        i++
      }
      list.push({ type, title: title || defaultCalloutTitle(type), start, end: i - 1, raw: blockLines.join('\n') })
    } else i++
  }
  return list
}
function defaultCalloutTitle (t) {
  const map = {
    note: '备注', tip: '提示', info: '信息', todo: '待办', important: '重要',
    warning: '警告', caution: '注意', failure: '失败', danger: '危险', bug: 'Bug',
    example: '示例', quote: '引用', success: '成功', question: '疑问', abstract: '摘要',
    summary: '摘要', tldr: 'TL;DR', hint: '提示', attention: '注意', fail: '失败',
    error: '错误', missing: '缺失'
  }
  return map[t] || t.charAt(0).toUpperCase() + t.slice(1)
}

// ---------------------------------------------------------------------------
// 6) 大纲提取（剔除 frontmatter + callout 里的标题不会污染）
// ---------------------------------------------------------------------------
export function extractOutline (md) {
  const { body } = parseFrontmatter(md || '')
  const out = []
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!m) continue
    // 在 callout 中的标题跳过
    if (/^>\s*#/.test(lines[i])) continue
    // 在 fenced code 中的标题跳过
    if (isInsideFence(lines, i)) continue
    out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 })
  }
  return out
}
function isInsideFence (lines, idx) {
  let open = false
  for (let i = 0; i < idx; i++) {
    if (/^```/.test(lines[i])) open = !open
  }
  return open
}

// ---------------------------------------------------------------------------
// 7) 链接图 buildLinkGraph(notes)
//    notes 形如 [{id,title,folder,content,filePath}]
// ---------------------------------------------------------------------------
export function buildLinkGraph (notes) {
  const list = Array.isArray(notes) ? notes : []
  const titleIndex = new Map() // normalizedTitle → Set<noteId>
  const pathIndex = new Map()  // folder/title → noteId
  const outgoing = new Map()   // noteId → [{target, alias, embed, hash, resolvedId, raw}]
  const backlinks = new Map()  // noteId → [{fromId, fromTitle, raw, alias, context}]
  const unresolved = new Map() // noteId → [{target, reason}]
  const tagIndex = new Map()   // tag → Set<noteId>

  for (const n of list) {
    // 建立 title 索引
    const titles = candidateTitles(n)
    for (const t of titles) {
      const k = normalizeLinkTarget(t)
      if (!titleIndex.has(k)) titleIndex.set(k, new Set())
      titleIndex.get(k).add(n.id)
    }
    const folderKey = n.folder ? `${normalizePathPart(n.folder)}/${normalizePathPart(n.title)}` : normalizePathPart(n.title)
    pathIndex.set(folderKey, n.id)

    // tags
    const tags = extractTags(n.content)
    for (const t of tags) {
      if (!tagIndex.has(t)) tagIndex.set(t, new Set())
      tagIndex.get(t).add(n.id)
    }
  }

  for (const n of list) {
    const body = parseFrontmatter(n.content).body
    const links = parseWikiLinks(body)
    const out = []
    for (const l of links) {
      const resolved = resolveLinkInternal(l.target, n, titleIndex, pathIndex)
      const rec = {
        target: l.target,
        hash: l.hash,
        alias: l.alias,
        embed: l.embed,
        raw: l.raw,
        resolvedId: resolved ? resolved.id : null
      }
      out.push(rec)
      if (resolved) {
        if (!backlinks.has(resolved.id)) backlinks.set(resolved.id, [])
        const context = extractContext(body, l.start)
        backlinks.get(resolved.id).push({
          fromId: n.id,
          fromTitle: n.title,
          fromFolder: n.folder || '',
          raw: l.raw,
          alias: l.alias,
          context
        })
      } else {
        if (!unresolved.has(n.id)) unresolved.set(n.id, [])
        unresolved.get(n.id).push({ target: l.target, reason: 'not-found' })
      }
    }
    outgoing.set(n.id, out)
  }

  return {
    titleIndex,
    pathIndex,
    outgoing,
    backlinks,
    unresolved,
    tagIndex,
    getByTitle: (title) => {
      const k = normalizeLinkTarget(title)
      const s = titleIndex.get(k)
      return s ? Array.from(s) : []
    },
    getBacklinks: (id) => backlinks.get(id) || [],
    getOutgoing: (id) => outgoing.get(id) || [],
    getUnresolved: (id) => unresolved.get(id) || [],
    getNotesByTag: (tag) => Array.from(tagIndex.get(tag) || [])
  }
}

function candidateTitles (n) {
  const arr = [n.title]
  // file name without .md
  if (n.filePath) {
    const p = n.filePath.split(/[/\\]/).pop()
    const base = p.replace(/\.md$/i, '')
    if (base) arr.push(base)
  }
  // H1 第一行标题
  const { body } = parseFrontmatter(n.content)
  const firstH = body.match(/^#\s+(.+)$/m)
  if (firstH) arr.push(firstH[1].trim())
  // frontmatter alias
  const { frontmatter } = parseFrontmatter(n.content)
  if (frontmatter.aliases) {
    const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [frontmatter.aliases]
    aliases.forEach(a => arr.push(String(a)))
  }
  if (frontmatter.title) arr.push(String(frontmatter.title))
  return arr.filter(Boolean)
}

export function normalizeLinkTarget (t) {
  return String(t || '').trim()
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}
function normalizePathPart (p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

export function resolveLink (anchor, ctxNote, notes) {
  if (!notes) return null
  const titleIndex = new Map()
  const pathIndex = new Map()
  for (const n of notes) {
    const titles = candidateTitles(n)
    for (const t of titles) {
      const k = normalizeLinkTarget(t)
      if (!titleIndex.has(k)) titleIndex.set(k, new Set())
      titleIndex.get(k).add(n.id)
    }
    const folderKey = n.folder ? `${normalizePathPart(n.folder)}/${normalizePathPart(n.title)}` : normalizePathPart(n.title)
    pathIndex.set(folderKey, n.id)
  }
  const res = resolveLinkInternal(anchor, ctxNote, titleIndex, pathIndex)
  if (!res) return null
  return notes.find(n => n.id === res.id) || null
}

function resolveLinkInternal (anchor, ctxNote, titleIndex, pathIndex) {
  if (!anchor) return null
  // 1) 绝对路径 /folder/title
  const clean = anchor.replace(/\.md$/i, '')
  if (clean.includes('/')) {
    const id = pathIndex.get(normalizePathPart(clean)) || pathIndex.get(normalizePathPart(clean.replace(/^\//, '')))
    if (id) return { id }
  }
  const key = normalizeLinkTarget(clean)
  const cands = titleIndex.get(key)
  if (!cands || cands.size === 0) return null
  if (cands.size === 1) return { id: Array.from(cands)[0] }
  // 重名：ctxNote 同文件夹优先
  if (ctxNote && ctxNote.folder) {
    // 模拟：通过 anchor = folder/title 匹配
    const fk = `${normalizePathPart(ctxNote.folder)}/${normalizePathPart(anchor.replace(/\.md$/i, ''))}`
    const id = pathIndex.get(fk)
    if (id) return { id }
  }
  return { id: Array.from(cands)[0] } // fallback 第一个；UI 可进一步给出歧义提示
}

function extractContext (body, start) {
  const snippetSize = 80
  const startIdx = Math.max(0, start - snippetSize)
  const endIdx = Math.min(body.length, start + snippetSize)
  const s = body.slice(startIdx, endIdx).replace(/\s+/g, ' ').trim()
  return (startIdx > 0 ? '…' : '') + s + (endIdx < body.length ? '…' : '')
}

// ---------------------------------------------------------------------------
// 8) Fuzzy match (快速切换器 & 自动补通用)
// ---------------------------------------------------------------------------
export function fuzzyMatch (query, items, { key = 'title' } = {}) {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return items.map((item, idx) => ({ item, score: 1, idx }))
  const results = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const text = String((typeof key === 'function' ? key(item) : item?.[key]) || '').toLowerCase()
    let score = 0
    // 前缀
    if (text.startsWith(q)) score += 10
    // 包含
    const idx = text.indexOf(q)
    if (idx >= 0) score += 5 + Math.max(0, 3 - idx / 8)
    // subsequence 命中
    let qi = 0
    let hit = 0
    for (let k = 0; k < text.length && qi < q.length; k++) {
      if (text[k] === q[qi]) { qi++; hit++ }
    }
    if (hit === q.length) score += 2 + (hit / Math.max(q.length, text.length)) * 3
    if (score > 0) results.push({ item, score, idx: i })
  }
  results.sort((a, b) => b.score - a.score || a.idx - b.idx)
  return results
}
