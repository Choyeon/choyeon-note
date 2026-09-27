import { EditorSelection } from '@codemirror/state'
import { deleteLine as cmDeleteLine } from '@codemirror/commands'

/**
 * Markdown 感知的编辑命令集。
 *
 * 与通用文本命令的区别：这些命令理解 Markdown 结构 —— 加粗时不会在单词中间
 * 插一对 **，回车时会自动续列表，Tab 在列表里缩进而不是插入制表符。
 * 每个命令都返回 boolean（CodeMirror Command 约定），便于直接挂到 keymap。
 */

const LIST_MARKER_RE = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+)/
const HEADING_RE = /^(#{1,6})(\s+)/
const QUOTE_RE = /^(\s*)(>\s?)+/
const INDENT_UNIT = '  '

function lineRangeOf(state, range) {
  return {
    start: state.doc.lineAt(range.from),
    end: state.doc.lineAt(range.to)
  }
}

// ---------------------------------------------------------------------------
// 行内包裹（加粗 / 斜体 / 代码 / 删除线 / 高亮 / 下划线）
// ---------------------------------------------------------------------------

/**
 * 切换包裹。要点：
 * - 有选区就包裹选区；无选区则自动扩展到光标下的单词（省去手工选中）；
 * - 已被包裹（无论标记在选区内还是选区外）时执行"脱壳"，来回切换幂等；
 * - 多光标各自独立计算，用 delta 累计位移保证后续 range 坐标正确。
 */
export function toggleWrap(marker, placeholder = '文本') {
  return (view) => {
    const { state } = view
    const changes = []
    const ranges = []
    const len = marker.length
    let delta = 0

    for (const range of state.selection.ranges) {
      let from = range.from
      let to = range.to
      let text = state.sliceDoc(from, to)

      if (!text) {
        const word = state.wordAt(from)
        if (word && word.to > word.from) {
          from = word.from
          to = word.to
          text = state.sliceDoc(from, to)
        }
      }

      const adjFrom = from + delta
      const adjTo = to + delta

      if (text) {
        const before = state.sliceDoc(Math.max(0, from - len), from)
        const after = state.sliceDoc(to, Math.min(state.doc.length, to + len))

        if (text.length >= len * 2 && text.startsWith(marker) && text.endsWith(marker)) {
          const insert = text.slice(len, text.length - len)
          changes.push({ from: adjFrom, to: adjTo, insert })
          ranges.push(EditorSelection.range(adjFrom, adjFrom + insert.length))
          delta += insert.length - (adjTo - adjFrom)
          continue
        }
        if (before === marker && after === marker) {
          changes.push({ from: adjFrom - len, to: adjTo + len, insert: text })
          ranges.push(EditorSelection.range(adjFrom - len, adjFrom - len + text.length))
          delta += text.length - (adjTo + len - (adjFrom - len))
          continue
        }

        const insert = `${marker}${text}${marker}`
        changes.push({ from: adjFrom, to: adjTo, insert })
        ranges.push(EditorSelection.range(adjFrom + len, adjFrom + len + text.length))
        delta += insert.length - (adjTo - adjFrom)
      } else {
        // 空选区：插入一对标记并把光标放到中间
        const insert = `${marker}${placeholder}${marker}`
        changes.push({ from: adjFrom, to: adjTo, insert })
        ranges.push(EditorSelection.range(adjFrom + len, adjFrom + len + placeholder.length))
        delta += insert.length - (adjTo - adjFrom)
      }
    }

    if (!changes.length) return false
    view.dispatch({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      userEvent: 'input.format'
    })
    return true
  }
}

// ---------------------------------------------------------------------------
// 块级：标题 / 引用 / 列表
// ---------------------------------------------------------------------------

/** 设置标题级别；已是同级标题时去掉标记（再次执行即降级为普通段落） */
export function setHeading(level) {
  return (view) => {
    const { state } = view
    const changes = []
    const seen = new Set()
    let shouldRemove = true

    for (const range of state.selection.ranges) {
      const { start, end } = lineRangeOf(state, range)
      for (let n = start.number; n <= end.number; n++) {
        if (seen.has(n)) continue
        seen.add(n)
        const match = state.doc.line(n).text.match(HEADING_RE)
        if (!match || match[1].length !== level) shouldRemove = false
      }
    }

    const marker = '#'.repeat(level)
    for (const n of [...seen].sort((a, b) => a - b)) {
      const line = state.doc.line(n)
      const match = line.text.match(HEADING_RE)
      if (shouldRemove) {
        changes.push({ from: line.from, to: line.from + match[0].length, insert: '' })
      } else if (match) {
        changes.push({ from: line.from, to: line.from + match[1].length, insert: marker })
      } else {
        changes.push({ from: line.from, insert: `${marker} ` })
      }
    }

    if (!changes.length) return false
    view.dispatch({ changes, userEvent: 'input.heading' })
    return true
  }
}

/**
 * 切换块级前缀（引用 / 无序列表 / 有序列表 / 待办）。
 * @param {(lineText: string, index: number) => string} makePrefix 生成目标前缀
 * @param {(lineText: string) => boolean} matches 判断该行是否已具备该前缀
 */
export function toggleBlock(makePrefix, matches) {
  return (view) => {
    const { state } = view
    const lines = new Set()
    let allMatch = true

    for (const range of state.selection.ranges) {
      const { start, end } = lineRangeOf(state, range)
      for (let n = start.number; n <= end.number; n++) {
        if (lines.has(n)) continue
        lines.add(n)
        if (!matches(state.doc.line(n).text)) allMatch = false
      }
    }

    const changes = []
    let index = 0
    for (const n of [...lines].sort((a, b) => a - b)) {
      const line = state.doc.line(n)
      const text = line.text
      const existing = text.match(/^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+|(?:>\s?)+)/)
      let body = text
      let indent = ''
      let from = line.from
      let to = line.from

      if (existing) {
        indent = existing[1]
        body = text.slice(existing[0].length)
        to = line.from + existing[0].length
      } else {
        const indentMatch = text.match(/^\s*/)
        indent = indentMatch[0]
        body = text.slice(indent.length)
        from = line.from + indent.length
        to = from
      }

      if (allMatch) {
        changes.push({ from: line.from, to, insert: indent + body })
      } else {
        const prefix = makePrefix(body, index, existing ? existing[2] : null)
        changes.push({ from, to, insert: prefix + body })
      }
      index++
    }

    if (!changes.length) return false
    view.dispatch({ changes, userEvent: 'input.block' })
    return true
  }
}

export const toggleQuote = toggleBlock(
  () => '> ',
  (text) => QUOTE_RE.test(text)
)

export const toggleBulletList = toggleBlock(
  (_body, _i, existing) => (existing && /^\d/.test(existing) ? '- ' : '- '),
  (text) => /^\s*[-*+]\s+(?!\[[ xX]\])/.test(text)
)

export const toggleOrderedList = toggleBlock(
  (_body, i) => `${i + 1}. `,
  (text) => /^\s*\d{1,9}[.)]\s+/.test(text)
)

export const toggleTaskList = toggleBlock(
  () => '- [ ] ',
  (text) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(text)
)

// ---------------------------------------------------------------------------
// 任务勾选
// ---------------------------------------------------------------------------

export const toggleTaskDone = (view) => {
  const { state } = view
  const lines = new Set()
  for (const range of state.selection.ranges) {
    const { start, end } = lineRangeOf(state, range)
    for (let n = start.number; n <= end.number; n++) lines.add(n)
  }

  const changes = []
  for (const n of [...lines].sort((a, b) => a - b)) {
    const line = state.doc.line(n)
    const match = line.text.match(/^(\s*[-*+]\s+\[)([ xX])(\])/)
    if (!match) continue
    const next = match[2] === ' ' ? 'x' : ' '
    changes.push({
      from: line.from + match[1].length,
      to: line.from + match[1].length + 1,
      insert: next
    })
  }

  if (!changes.length) return false
  view.dispatch({ changes, userEvent: 'input.toggleTask' })
  return true
}

// ---------------------------------------------------------------------------
// 回车 / 退格 的列表智能行为
// ---------------------------------------------------------------------------

/**
 * 列表回车续行。空列表项上回车 = 退出列表（Obsidian / Notion 的行为），
 * 而不是继续堆一排空 bullet。
 */
export const insertNewlineContinueList = (view) => {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false

  const line = state.doc.lineAt(range.head)
  const atLineEnd = range.head === line.to
  const match = atLineEnd ? line.text.match(LIST_MARKER_RE) : null
  if (!match) return false

  const indent = match[1]
  const marker = match[2]
  const content = line.text.slice(match[0].length)

  if (!content.trim()) {
    // 空项：清掉标记，跳出列表
    view.dispatch({
      changes: { from: line.from + indent.length, to: line.to, insert: '' },
      selection: { anchor: line.from + indent.length },
      userEvent: 'input'
    })
    return true
  }

  let nextMarker = marker
  if (/^\d{1,9}[.)]/.test(marker)) {
    const n = parseInt(marker, 10)
    nextMarker = marker.replace(/^\d+/, String(n + 1))
  } else if (/\[[xX]\]/.test(marker)) {
    nextMarker = marker.replace(/\[[xX]\]/, '[ ]')
  }

  const insert = `\n${indent}${nextMarker}`
  view.dispatch({
    changes: { from: range.head, insert },
    selection: { anchor: range.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

/** 行首退格：优先吞掉列表 / 引用标记，而不是把上一行拼上来 */
export const smartBackspace = (view) => {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false

  const line = state.doc.lineAt(range.head)
  const prefixLength = range.head - line.from
  if (prefixLength === 0 || line.text.slice(0, prefixLength).trim() !== '') return false

  const match = line.text.match(LIST_MARKER_RE) || line.text.match(QUOTE_RE)
  if (!match) return false

  view.dispatch({
    changes: { from: line.from + match[1].length, to: line.from + match[0].length, insert: '' },
    selection: { anchor: Math.max(line.from, range.head - (match[0].length - match[1].length)) },
    userEvent: 'delete'
  })
  return true
}

// ---------------------------------------------------------------------------
// 缩进 / 行操作
// ---------------------------------------------------------------------------

function changeIndent(view, direction) {
  const { state } = view
  const lines = new Set()
  for (const range of state.selection.ranges) {
    const { start, end } = lineRangeOf(state, range)
    for (let n = start.number; n <= end.number; n++) lines.add(n)
  }

  const changes = []
  for (const n of [...lines].sort((a, b) => a - b)) {
    const line = state.doc.line(n)
    if (direction > 0) {
      changes.push({ from: line.from, insert: INDENT_UNIT })
    } else {
      const match = line.text.match(/^(\s{1,2})/)
      if (match) changes.push({ from: line.from, to: line.from + match[1].length, insert: '' })
    }
  }

  if (!changes.length) return false
  view.dispatch({ changes, userEvent: direction > 0 ? 'indent' : 'outdent' })
  return true
}

export const indentMoreList = (view) => changeIndent(view, 1)
export const indentLessList = (view) => changeIndent(view, -1)

export function moveLine(direction) {
  return (view) => {
    const { state } = view
    const range = state.selection.main
    const start = state.doc.lineAt(range.from)
    const end = state.doc.lineAt(range.to)

    if (direction === -1 && start.number === 1) return true
    if (direction === 1 && end.number === state.doc.lines) return true

    if (direction === -1) {
      const prev = state.doc.line(start.number - 1)
      const moved = state.sliceDoc(start.from, end.to)
      const insert = `${moved}\n${prev.text}`
      view.dispatch({
        changes: { from: prev.from, to: end.to, insert },
        selection: EditorSelection.range(
          prev.from + (range.from - start.from),
          prev.from + (range.to - start.from)
        ),
        userEvent: 'move.line'
      })
    } else {
      const next = state.doc.line(end.number + 1)
      const moved = state.sliceDoc(start.from, end.to)
      const insert = `${next.text}\n${moved}`
      const shift = next.text.length + 1
      view.dispatch({
        changes: { from: start.from, to: next.to, insert },
        selection: EditorSelection.range(range.from + shift, range.to + shift),
        userEvent: 'move.line'
      })
    }
    return true
  }
}

/** 在下方插入空行并把光标移过去（不打断当前行） */
export const insertLineBelow = (view) => {
  const { state } = view
  const changes = []
  const anchors = []
  let delta = 0
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.to)
    changes.push({ from: line.to, insert: '\n' })
    anchors.push(line.to + 1)
    delta += 1
  }
  view.dispatch({
    changes,
    selection: EditorSelection.create(anchors.map(a => EditorSelection.cursor(a))),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

export const duplicateLine = (view) => {
  const { state } = view
  const range = state.selection.main
  const start = state.doc.lineAt(range.from)
  const end = state.doc.lineAt(range.to)
  const text = state.sliceDoc(start.from, end.to)
  view.dispatch({
    changes: { from: end.to, insert: `\n${text}` },
    selection: EditorSelection.range(
      end.to + 1 + (range.from - start.from),
      end.to + 1 + (range.to - start.from)
    ),
    userEvent: 'input.duplicate'
  })
  return true
}

export { cmDeleteLine as deleteLine }

// ---------------------------------------------------------------------------
// 插入类
// ---------------------------------------------------------------------------

function insertAtCursor(view, text, selectOffset, selectLength = 0) {
  const { state } = view
  const changes = []
  const ranges = []
  let delta = 0
  for (const range of state.selection.ranges) {
    const from = range.from + delta
    const to = range.to + delta
    changes.push({ from, to, insert: text })
    if (selectLength > 0) {
      ranges.push(EditorSelection.range(from + selectOffset, from + selectOffset + selectLength))
    } else {
      ranges.push(EditorSelection.cursor(from + selectOffset))
    }
    delta += text.length - (to - from)
  }
  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: 'input.insert'
  })
  return true
}

/** 链接：有选区时作为链接文字，并把 URL 部分选中待替换 */
export const insertLink = (view) => {
  const { state } = view
  const range = state.selection.main
  const text = state.sliceDoc(range.from, range.to) || '链接文字'
  const insert = `[${text}](url)`
  const urlStart = range.from + text.length + 3
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + 3),
    userEvent: 'input.insert'
  })
  return true
}

/** 双链：有选区时作为链接目标（或别名，取决于是否已有目标） */
export const insertWikiLink = (view) => {
  const { state } = view
  const range = state.selection.main
  const text = state.sliceDoc(range.from, range.to)
  const insert = text ? `[[${text}]]` : '[[]]'
  const cursor = range.from + (text ? insert.length : 2)
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(cursor),
    userEvent: 'input.insert'
  })
  return true
}

export const insertCodeBlock = (view) => {
  const { state } = view
  const range = state.selection.main
  const selected = state.sliceDoc(range.from, range.to)
  const line = state.doc.lineAt(range.from)
  const needsLeadingBreak = range.from !== line.from
  const insert = `${needsLeadingBreak ? '\n' : ''}\`\`\`\n${selected}\n\`\`\`\n`
  const cursor = range.from + insert.length
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
    userEvent: 'input.insert'
  })
  return true
}

export const insertDivider = (view) => {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.to)
  const prefix = range.to === line.from ? '' : '\n\n'
  const insert = `${prefix}---\n\n`
  view.dispatch({
    changes: { from: range.to, insert },
    selection: EditorSelection.cursor(range.to + insert.length),
    scrollIntoView: true,
    userEvent: 'input.insert'
  })
  return true
}

export function insertTable(rows = 3, cols = 3) {
  return (view) => {
    const { state } = view
    const range = state.selection.main
    const line = state.doc.lineAt(range.to)
    const prefix = range.to === line.from ? '' : '\n\n'
    const header = `| ${Array.from({ length: cols }, (_, i) => `列 ${i + 1}`).join(' | ')} |`
    const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
    const body = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => ' ').join(' | ')} |`)
    const insert = `${prefix}${header}\n${sep}\n${body.join('\n')}\n`
    view.dispatch({
      changes: { from: range.to, insert },
      selection: EditorSelection.cursor(range.to + insert.length),
      scrollIntoView: true,
      userEvent: 'input.insert'
    })
    return true
  }
}

/**
 * 插入 Obsidian 风格 callout：头行 `> [!note] ` + 内容行 `> `。
 *
 * 格式必须与项目里三处既有解析同构，否则刚插进去的块在阅读视图 / 实时预览里不渲染：
 * - `useLinks.js` 的 `parseCallouts`（头行 CALLOUT_LINE，其后连续的 `>` 行算块内）
 * - `livePreview/constants.js` 的 `CALLOUT_RE`（`^>\s*\[!type]`）
 * - `livePreview/scan.js` 的 `collectCalloutBlocksRaw`（头行起直到非 `>` 行）
 *
 * 三种上下文必须分别处理，否则插完格式会碎：
 * - 行首且上一行为空（或就是首行）→ 原地插入，不额外留空行；
 * - 行中间 → 先补换行，把当前行剩余内容顶到下一行；
 * - 行首但上一行非空 → 补换行，保证块前有空行（Markdown 块级语法要求）。
 * 另外：当前行已有引用前缀（`> ` / `  > `）时复用该前缀（含缩进），
 * 避免叠出 `> > [!note]` 这种双层引用。
 */
export const insertCallout = (view) => {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const quote = line.text.match(QUOTE_RE)
  // `>x`（无空格）虽然也能被 CALLOUT_RE 认，但补齐一个空格才对齐 parseCallouts 的常规写法
  const prefix = quote ? (quote[0].endsWith(' ') ? quote[0] : `${quote[0]} `) : '> '
  const atLineStart = range.from === line.from
  const prevBlank = line.number === 1 || state.doc.line(line.number - 1).text.trim() === ''
  const lead = atLineStart && prevBlank ? '' : '\n'
  const insert = `${lead}${prefix}[!note] \n${prefix}\n`
  // 光标停在头行末尾，用户可以直接敲标题
  const titlePos = range.from + lead.length + prefix.length + '[!note] '.length
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(titlePos),
    scrollIntoView: true,
    userEvent: 'input.insert'
  })
  return true
}

export function insertText(text, selectOffset = text.length) {
  return (view) => insertAtCursor(view, text, selectOffset)
}

/** 插入标签起始符 `#`：后面接着敲文字即成标签，候选项由 obsidianAutocomplete 接管 */
export const insertTag = insertText('#')

export function insertTemplate(template) {
  return (view) => {
    const { state } = view
    const range = state.selection.main
    const line = state.doc.lineAt(range.from)
    const prefix = range.from === line.from ? '' : '\n'
    const insert = `${prefix}${template}\n`
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      scrollIntoView: true,
      userEvent: 'input.insert'
    })
    return true
  }
}

/** 折叠当前标题下的内容（配合 CM6 foldGutter 使用） */
export const foldCurrentHeading = (view) => {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  if (!HEADING_RE.test(line.text)) return false
  // 交由 CodeMirror 内置 foldCode 处理，这里只负责把光标挪到行首
  view.dispatch({ selection: EditorSelection.cursor(line.from) })
  return false
}
