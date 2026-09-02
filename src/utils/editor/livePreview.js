import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'

/**
 * Obsidian 风格「实时预览」装饰层。
 *
 * 为什么不用 contenteditable 自己渲染（项目旧实现）：
 * 旧方案用 div[contenteditable] 承接渲染结果，再 htmlToMarkdown 反向序列化回源码，
 * 往返过程中必然丢失 / 变形（表格、嵌套列表、代码块缩进、callout），导致
 * 「实时编辑」和「预览」永远对不齐。
 *
 * 这里的做法与 Obsidian 官方一致：底层始终是 CodeMirror 的纯文本文档，
 * 仅在渲染层用 Decoration.replace 隐藏语法标记、用 Decoration.mark 给内容加类。
 * 于是：
 *  - 光标所在行/选区行保持源码原样，随时可以编辑语法本身；
 *  - 其余行渲染成富文本，视觉与 marked 的预览结果共用同一套 CSS 变量；
 *  - 撤销栈、搜索、补全、拼写检查全部照常工作，因为它们面对的都是纯文本。
 */

const HEADING_RE = /^(#{1,6})(\s+)(.*)$/
const QUOTE_RE = /^(\s*)(>"?)([ \t]?)/ // 逐个 > 处理，保留层级
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/
const TASK_RE = /^(\s*)([-*+])(\s+)\[([ xX])\](\s+)(.*)$/
const HR_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const FRONTMATTER_RE = /^---\s*$/
const WIKILINK_RE = /(!?)\[\[([^\]\n|]+)(\|([^\]\n]*))?\]\]/g
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g
const TAG_RE = /(^|[\s(（])#([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5/-]*)/g
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>()[\]]+)/g

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) {
    super()
    this.checked = checked
    this.pos = pos
  }

  eq(other) {
    return other.checked === this.checked && other.pos === this.pos
  }

  toDOM(view) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-checkbox-wrap'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'cm-md-checkbox'
    input.checked = this.checked
    // 点击不应把光标挪走，因此阻止 CodeMirror 接管这次 mousedown
    input.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    input.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const line = view.state.doc.lineAt(this.pos)
      const text = line.text
      const match = text.match(/^(\s*)([-*+])(\s+)\[([ xX])\]/)
      if (!match) return
      const bracketStart = line.from + match[1].length + match[2].length + match[3].length
      const next = this.checked ? ' ' : 'x'
      // 勾选是独立的一次编辑：Ctrl+Z 一次即可回退，且不会与后续输入合并
      view.dispatch({
        changes: { from: bracketStart + 1, to: bracketStart + 2, insert: next },
        userEvent: 'input.toggleTask'
      })
    })
    wrap.appendChild(input)
    return wrap
  }

  ignoreEvent() {
    return false
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-md-hr'
    return el
  }

  ignoreEvent() {
    return true
  }
}

class ListBulletWidget extends WidgetType {
  constructor(kind, order) {
    super()
    this.kind = kind
    this.order = order
  }

  eq(other) {
    return other.kind === this.kind && other.order === this.order
  }

  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-md-list-marker'
    el.textContent = this.kind === 'ordered' ? `${this.order}.` : '•'
    return el
  }

  ignoreEvent() {
    return true
  }
}

// ---------------------------------------------------------------------------
// 行内语法扫描
// ---------------------------------------------------------------------------

function overlaps(list, range) {
  return list.some(r => range.start < r.end && r.start < range.end)
}

/** 通用定界符扫描：处理 **bold** / ==mark== / ~~strike~~ / `code` */
function scanDelimited(text, delim, cls, occupied = []) {
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
function scanEmphasis(text, occupied) {
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

// ---------------------------------------------------------------------------
// 装饰构建
// ---------------------------------------------------------------------------

function buildForLine(state, line, decos, activeLines) {
  const text = line.text
  const from = line.from

  // 光标/选区所在行保持纯源码，保证语法可编辑
  if (activeLines.has(line.number)) return

  // --- 代码块围栏：整块保持源码（调用方已处理内部行），这里只加块级样式 ---
  if (FENCE_RE.test(text)) {
    decos.push(Decoration.line({ class: 'cm-md-code-fence' }).range(from))
    const info = text.match(FENCE_RE)
    if (info && info[2]) {
      decos.push(
        Decoration.mark({ class: 'cm-md-code-lang' }).range(from + info[0].length - info[2].length, line.to)
      )
    }
    return
  }

  // --- frontmatter 分隔线 ---
  if (FRONTMATTER_RE.test(text)) {
    if (line.number === 1 || state.sliceDoc(0, line.from).includes('\n---')) {
      decos.push(Decoration.line({ class: 'cm-md-frontmatter-fence' }).range(from))
    }
    return
  }

  // --- 分隔线 ---
  if (HR_RE.test(text) && !LIST_RE.test(text)) {
    decos.push(
      Decoration.replace({ widget: new HrWidget(), block: true }).range(from, line.to)
    )
    return
  }

  // --- 标题 ---
  const heading = text.match(HEADING_RE)
  if (heading) {
    const level = heading[1].length
    decos.push(Decoration.line({ class: `cm-md-heading cm-md-h${level}` }).range(from))
    decos.push(Decoration.replace({}).range(from, from + heading[1].length))
    // 标题尾部可选的闭合 # 序列也隐藏
    const closing = heading[3].match(/\s+#+\s*$/)
    if (closing) {
      decos.push(
        Decoration.replace({}).range(from + heading[0].length - closing[0].length, line.to)
      )
    }
    scanInline(text, from, decos)
    return
  }

  // --- 任务项：整体行样式 + 复选框 widget ---
  const task = text.match(TASK_RE)
  if (task) {
    decos.push(Decoration.line({ class: 'cm-md-task-line' }).range(from))
    const bulletFrom = from + task[1].length
    const bulletTo = bulletFrom + task[2].length + task[3].length
    decos.push(
      Decoration.replace({ widget: new ListBulletWidget('bullet', 0) }).range(bulletFrom, bulletTo)
    )
    const boxFrom = bulletTo
    const boxTo = boxFrom + 3 // "[ ]"
    decos.push(
      Decoration.replace({
        widget: new CheckboxWidget(task[4].toLowerCase() === 'x', boxFrom)
      }).range(boxFrom, boxTo)
    )
    scanInline(text, from, decos, boxTo)
    return
  }

  // --- 列表 ---
  const list = text.match(LIST_RE)
  if (list) {
    const isOrdered = /\d/.test(list[2])
    decos.push(Decoration.line({ class: 'cm-md-list-line' }).range(from))
    const markerFrom = from + list[1].length
    const markerTo = markerFrom + list[2].length + list[3].length
    const order = isOrdered ? parseInt(list[2], 10) : 0
    decos.push(
      Decoration.replace({
        widget: new ListBulletWidget(isOrdered ? 'ordered' : 'bullet', order)
      }).range(markerFrom, markerTo)
    )
    scanInline(text, from, decos, markerTo)
    return
  }

  // --- 引用 ---
  const quote = text.match(QUOTE_RE)
  if (quote) {
    decos.push(Decoration.line({ class: 'cm-md-quote-line', attributes: { 'data-quote-depth': '1' } }).range(from))
    const markerFrom = from + quote[1].length
    const markerTo = markerFrom + quote[2].length + quote[3].length
    decos.push(Decoration.replace({}).range(markerFrom, markerTo))
    // callout：[!note] 语法保留可见但弱化，标题部分加类
    const callout = text.match(/^>\s*\[!([a-z]+)\]([+-]?)\s*(.*)$/i)
    if (callout) {
      decos.push(Decoration.line({ class: `cm-md-callout cm-md-callout-${callout[1].toLowerCase()}` }).range(from))
      const titleStart = from + text.indexOf(callout[3], text.indexOf(']'))
      if (titleStart >= from && callout[3]) {
        decos.push(Decoration.mark({ class: 'cm-md-callout-title' }).range(titleStart, line.to))
      }
    } else {
      scanInline(text, from, decos, markerTo)
    }
    return
  }

  // --- 普通段落 ---
  scanInline(text, from, decos)
}

/** 行内：emoji/highlight/strong/em/strike/code/wikilink/link/tag/url */
function scanInline(text, from, decos, startAt = 0) {
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
    // 隐藏 "[["
    decos.push(Decoration.replace({}).range(from + start, from + start + (isEmbed ? 3 : 2)))
    // 隐藏 "]]"
    decos.push(Decoration.replace({}).range(from + end - 2, from + end))
    if (aliasPart !== undefined) {
      // 有别名：隐藏 "target|"，只展示别名
      const barIndex = text.indexOf('|', start)
      decos.push(Decoration.replace({}).range(from + start + 2, from + barIndex + 1))
      decos.push(
        Decoration.mark({ class: 'cm-md-wikilink' }).range(from + barIndex + 1, from + end - 2)
      )
    } else {
      decos.push(
        Decoration.mark({ class: 'cm-md-wikilink' }).range(from + start + 2, from + end - 2)
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

// ---------------------------------------------------------------------------
// ViewPlugin
// ---------------------------------------------------------------------------

/** 开关变化时派发此 effect，强制重建装饰（否则只在文档/选区变化时才重算） */
export const toggleLivePreview = StateEffect.define()

export function createLivePreviewPlugin(getEnabled) {
  return ViewPlugin.fromClass(
    class LivePreviewPlugin {
      constructor(view) {
        this.decorations = this.build(view)
      }

      update(update) {
        // 注意：ViewUpdate 没有 effects 属性（@codemirror/view 6.x），
        // update.effects 永远是 undefined —— 直接 .some() 会抛错且可选链后永远不触发，
        // 必须遍历 transactions 才能拿到事务携带的 effect（如 toggleLivePreview）
        const toggled = update.transactions.some(tr =>
          tr.effects.some(e => e.is(toggleLivePreview))
        )
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged ||
          toggled
        ) {
          this.decorations = this.build(update.view)
        }
      }

      build(view) {
        if (!getEnabled()) return Decoration.none
        const decos = []
        const { state } = view

        // 光标 / 选区影响到的行保持源码
        const activeLines = new Set()
        for (const range of state.selection.ranges) {
          const startLine = state.doc.lineAt(range.from).number
          const endLine = state.doc.lineAt(range.to).number
          for (let n = startLine; n <= endLine; n++) activeLines.add(n)
        }

        // 代码块内部保持源码，只给整体加类
        const codeBlockLines = new Set()
        let inFence = false
        let fenceMarker = ''
        for (let n = 1; n <= state.doc.lines; n++) {
          const line = state.doc.line(n)
          const fence = line.text.match(FENCE_RE)
          if (fence) {
            if (!inFence) {
              inFence = true
              fenceMarker = fence[1]
            } else if (fence[1].startsWith(fenceMarker[0]) && fence[2].trim() === '') {
              inFence = false
              fenceMarker = ''
            }
            codeBlockLines.add(n)
          } else if (inFence) {
            codeBlockLines.add(n)
          }
        }

        // frontmatter 区间保持源码
        const frontmatterLines = new Set()
        if (state.doc.lines > 0 && FRONTMATTER_RE.test(state.doc.line(1).text)) {
          for (let n = 2; n <= state.doc.lines; n++) {
            frontmatterLines.add(n)
            if (FRONTMATTER_RE.test(state.doc.line(n).text)) break
          }
          frontmatterLines.add(1)
        }

        // 只装饰可视区，长文档不会退化
        for (const { from, to } of view.visibleRanges) {
          let pos = from
          while (pos <= to) {
            const line = state.doc.lineAt(pos)
            if (codeBlockLines.has(line.number) || frontmatterLines.has(line.number)) {
              decos.push(Decoration.line({ class: 'cm-md-raw-block' }).range(line.from))
              // 围栏行额外标记语言区（themes 里 .cm-md-code-fence / .cm-md-code-lang 生效）
              const fence = line.text.match(FENCE_RE)
              if (fence) {
                decos.push(Decoration.line({ class: 'cm-md-code-fence' }).range(line.from))
                if (fence[2]) {
                  decos.push(
                    Decoration.mark({ class: 'cm-md-code-lang' })
                      .range(line.from + fence[0].length - fence[2].length, line.to)
                  )
                }
              }
            } else {
              buildForLine(state, line, decos, activeLines)
            }
            if (line.to >= to) break
            pos = line.to + 1
          }
        }

        return Decoration.set(decos, true)
      }
    },
    {
      decorations: (plugin) => plugin.decorations
    }
  )
}
