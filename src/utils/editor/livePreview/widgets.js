import { WidgetType } from '@codemirror/view'
import { renderInlineHtml } from './inline.js'

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
// 表格：整块替换成真正的 <table>，样式与阅读视图共用同一套规则
// ---------------------------------------------------------------------------

class TableWidget extends WidgetType {
  constructor (table) {
    super()
    this.header = table.header
    this.aligns = table.aligns
    this.rows = table.rows.map(r => r.cells)
    this.key = table.key
  }

  eq (other) {
    return other instanceof TableWidget && other.key === this.key
  }

  toDOM () {
    const table = document.createElement('table')
    table.className = 'cm-md-table'

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.header.forEach((cell, i) => {
      const th = document.createElement('th')
      const align = this.aligns[i]
      if (align && align !== 'left') th.style.textAlign = align
      th.innerHTML = renderInlineHtml(cell)
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)

    if (this.rows.length) {
      const tbody = document.createElement('tbody')
      for (const cells of this.rows) {
        const tr = document.createElement('tr')
        cells.forEach((cell, i) => {
          const td = document.createElement('td')
          const align = this.aligns[i]
          if (align && align !== 'left') td.style.textAlign = align
          td.innerHTML = renderInlineHtml(cell)
          tr.appendChild(td)
        })
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
    }
    return table
  }

  ignoreEvent () {
    return false
  }
}

// ---------------------------------------------------------------------------
// 嵌入 / 图片：与阅读视图的 .obsidian-embed / img 对齐
// ---------------------------------------------------------------------------

class EmbedWidget extends WidgetType {
  constructor (target) {
    super()
    this.target = target
  }

  eq (other) {
    return other.target === this.target
  }

  toDOM () {
    const el = document.createElement('span')
    el.className = 'cm-md-embed'
    el.textContent = '\u{1F4CE} ' + this.target
    return el
  }

  ignoreEvent () {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor (src, alt) {
    super()
    this.src = src
    this.alt = alt
  }

  eq (other) {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM () {
    const el = document.createElement('span')
    el.className = 'cm-md-image-wrap'
    const img = document.createElement('img')
    img.className = 'cm-md-image'
    img.src = this.src
    img.alt = this.alt || ''
    img.loading = 'lazy'
    // 加载失败（外链失效 / 本地文件不存在）时退回成 alt 文本，不留破图
    img.addEventListener('error', () => {
      img.remove()
      const fallback = document.createElement('span')
      fallback.className = 'cm-md-image-fallback'
      fallback.textContent = this.alt || this.src
      el.appendChild(fallback)
    })
    el.appendChild(img)
    return el
  }

  ignoreEvent () {
    return false
  }
}

export {
  CheckboxWidget,
  HrWidget,
  ListBulletWidget,
  TableWidget,
  EmbedWidget,
  ImageWidget
}
