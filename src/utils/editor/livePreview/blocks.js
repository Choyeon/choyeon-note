import { Decoration } from '@codemirror/view'
import {
  HEADING_RE,
  QUOTE_RE,
  LIST_RE,
  TASK_RE,
  HR_RE,
  FENCE_RE,
  CALLOUT_RE
} from './constants.js'
import { HrWidget, ListBulletWidget, CheckboxWidget, TableWidget } from './widgets.js'
import { scanInline } from './inline.js'
import { highlightCode } from './highlight.js'
import {
  collectTables,
  collectCodeBlocks,
  collectFrontmatterLines,
  collectActiveLines,
  activeLinesIntersect
} from './scan.js'

// ---------------------------------------------------------------------------
// 装饰构建
// ---------------------------------------------------------------------------

export const EMPTY_MAP = new Map()

export function buildForLine(state, line, decos, activeLines, calloutBlock) {
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

  // --- 分隔线 ---
  // 注意：frontmatter 的 `---` 由调用方（collectFrontmatterLines）拦下并加
  // .cm-md-raw-block，buildForLine 根本不会收到那些行。这里若再判一次 FRONTMATTER_RE，
  // 会把文档正中间的 `---` 误当成 frontmatter 围栏并 return，分隔线就永远渲染不出来。
  if (HR_RE.test(text) && !LIST_RE.test(text)) {
    // 不能带 block:true —— CodeMirror 禁止 plugin 提供 block decoration
    // （会抛 RangeError: Block decorations may not be specified via plugins）。
    // 整行被替换掉，widget 本身就是块级 <div>，视觉上等价。
    decos.push(
      Decoration.replace({ widget: new HrWidget() }).range(from, line.to)
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
    const callout = text.match(CALLOUT_RE)
    if (calloutBlock || callout) {
      // 首/末行要负责圆角 + 各自的背景，这里补上角色类（块信息由 collectCalloutBlocks 提供）
      const type = callout
        ? callout[1].toLowerCase()
        : (calloutBlock ? calloutBlock.type : '')
      let role = ''
      if (calloutBlock) {
        if (line.number === calloutBlock.start) role += ' cm-md-callout-first'
        if (line.number === calloutBlock.end) role += ' cm-md-callout-last'
      }
      decos.push(
        Decoration.line({ class: `cm-md-callout cm-md-callout-${type}${role}` }).range(from)
      )
      if (callout) {
        const titleStart = from + text.indexOf(callout[3], text.indexOf(']'))
        if (titleStart >= from && callout[3]) {
          decos.push(Decoration.mark({ class: 'cm-md-callout-title' }).range(titleStart, line.to))
        }
      } else {
        // 正文行：容器样式已由行装饰负责，行内语法照常渲染
        scanInline(text, from, decos, markerTo)
      }
      return
    }
    scanInline(text, from, decos, markerTo)
    return
  }

  // --- 普通段落 ---
  scanInline(text, from, decos)
}

/**
 * 代码块装饰：
 * 1. 逐行加容器类（首/中/末行负责圆角与上下边框），让整块看起来是一个盒子 ——
 *    与阅读视图 `pre.code-block` 的圆角 / 底色 / 边框一致；
 * 2. 光标不在块内时隐藏围栏行，改由 ::before 以角标显示语言（同 pre.code-block::before）；
 * 3. 内容行用 hljs 分词，token 直接带 .hljs-* 类 —— 复用阅读视图注入的同一份主题 CSS。
 */
export function appendCodeBlock (state, block, decos, cursorIn, tokenCache) {
  const first = state.doc.line(block.start)
  const last = state.doc.line(block.end)

  for (let n = block.start; n <= block.end; n++) {
    const line = state.doc.line(n)
    const role = n === block.start
      ? 'cm-md-code-first'
      : (n === block.end ? 'cm-md-code-last' : 'cm-md-code-mid')
    const attributes = n === block.start
      ? { 'data-code-lang': block.lang || 'text' }
      : undefined
    decos.push(Decoration.line({ class: `cm-md-code-line ${role}`, attributes }).range(line.from))
  }

  if (cursorIn) {
    // 源码态：保留 ```lang 文本，只弱化语言标记
    const fence = first.text.match(FENCE_RE)
    if (fence && fence[2]) {
      decos.push(
        Decoration.mark({ class: 'cm-md-code-lang' })
          .range(first.from + fence[0].length - fence[2].length, first.to)
      )
    }
  } else {
    decos.push(Decoration.replace({}).range(first.from, first.to))
    if (block.closed && block.end > block.start) {
      decos.push(Decoration.replace({}).range(last.from, last.to))
    }
  }

  // ---- 内容行高亮 ----
  const contentStart = block.start + 1
  const contentEnd = block.closed ? block.end - 1 : block.end
  if (contentEnd < contentStart) return

  const offsets = []
  let text = ''
  for (let n = contentStart; n <= contentEnd; n++) {
    const line = state.doc.line(n)
    offsets.push({ line: n, from: line.from, start: text.length, len: line.length })
    text += line.text
    if (n < contentEnd) text += '\n'
  }
  if (!text) return

  let tokens = tokenCache.get(block)
  if (tokens === undefined) {
    tokens = highlightCode(text, block.lang)
    tokenCache.set(block, tokens)
  }
  if (!tokens) return

  let cursor = 0
  for (const tk of tokens) {
    const tkStart = cursor
    const tkEnd = cursor + tk.text.length
    cursor = tkEnd
    if (!tk.cls || tkEnd <= tkStart) continue
    for (const o of offsets) {
      const s = Math.max(tkStart, o.start)
      const e = Math.min(tkEnd, o.start + o.len)
      if (e <= s) continue
      decos.push(
        Decoration.mark({ class: tk.cls }).range(
          o.from + (s - o.start),
          o.from + (e - o.start)
        )
      )
    }
  }
}

/**
 * 表格要整块渲染成真正的 <table>，必须借助 block widget。
 * 而 CodeMirror 明令禁止 plugin 提供 block decoration（会抛
 * `RangeError: Block decorations may not be specified via plugins`），
 * 所以表格单独放在 StateField 里；其余（inline / mark / line）装饰仍在
 * ViewPlugin 中，保留可视区裁剪。
 */
export function buildTableDecorations (state, getEnabled) {
  if (!getEnabled()) return { set: Decoration.none, byLine: EMPTY_MAP }
  const decos = []
  const activeLines = collectActiveLines(state)
  const { lines: codeBlockLines } = collectCodeBlocks(state)
  const frontmatterLines = collectFrontmatterLines(state)
  // 代码块 / frontmatter 里的 `|` 不参与表格判定（与 marked 一致）
  const skipLines = new Set()
  for (const n of codeBlockLines) skipLines.add(n)
  for (const n of frontmatterLines) skipLines.add(n)

  const byLine = new Map()
  for (const t of collectTables(state, skipLines)) {
    for (let n = t.start; n <= t.end; n++) byLine.set(n, t)
    // 光标在表内时退回源码，保证语法可编辑
    if (activeLinesIntersect(activeLines, t.start, t.end)) continue
    decos.push(
      Decoration.replace({ widget: new TableWidget(t), block: true }).range(
        state.doc.line(t.start).from,
        state.doc.line(t.end).to
      )
    )
  }
  return { set: Decoration.set(decos, true), byLine }
}
