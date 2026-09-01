import { ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue'
import { EditorState, Prec, Transaction, Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo as undoCommand,
  redo as redoCommand,
  undoDepth,
  redoDepth
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  indentUnit
} from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search'
import { autocompletion, completionKeymap, snippetCompletion as snip } from '@codemirror/autocomplete'
import { getEditorTheme } from '../utils/editor/themes'
import { spellCheckExtension, forceSpellUpdate, spellRectOf } from '../utils/editor/spellcheck'
import { createLivePreviewPlugin, toggleLivePreview } from '../utils/editor/livePreview'
import * as md from '../utils/editor/markdownCommands'
import { extractOutline } from '../composables/useLinks.js'

/**
 * 编辑器核心。
 *
 * 相比旧实现的关键改变：
 * 1. 单一 CodeMirror 实例承载三种模式（源码 / 实时预览 / 阅读），
 *    实时预览由装饰层实现，不再用 contenteditable + HTML 反解析，
 *    因此三模式看到的是同一份文档、同一套渲染规则。
 * 2. 撤销 / 重做直接用 @codemirror/commands 的 undo/redo，
 *    旧代码用 defaultKeymap.find(...) 找绑定再 run，而 Mod-z 根本不在
 *    defaultKeymap 里（它在 historyKeymap），所以工具栏按钮一直是空操作。
 * 3. 外部 setContent（切换笔记 / 磁盘回写）打上 addToHistory=false，
 *    不会污染撤销栈。
 * 4. 快捷键统一从注册表读取，用户改了设置立即生效。
 */

// ---------------------------------------------------------------------------
// 命令表：id -> CodeMirror Command。工具栏、快捷键、命令面板共用一份。
// ---------------------------------------------------------------------------
export const EDITOR_COMMANDS = {
  'edit.undo': (view) => undoCommand(view),
  'edit.redo': (view) => redoCommand(view),
  'edit.redoAlt': (view) => redoCommand(view),
  'edit.selectAll': (view) => {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    return true
  },
  'edit.indent': md.indentMoreList,
  'edit.outdent': md.indentLessList,
  'edit.moveLineUp': md.moveLine(-1),
  'edit.moveLineDown': md.moveLine(1),
  'edit.duplicateLine': md.duplicateLine,
  'edit.deleteLine': md.deleteLine,
  'edit.insertLineBelow': md.insertLineBelow,
  'edit.toggleTask': md.toggleTaskDone,

  'format.bold': md.toggleWrap('**'),
  'format.italic': md.toggleWrap('*'),
  'format.underline': md.toggleWrap('<u>', '下划线'),
  'format.highlight': md.toggleWrap('==', '高亮'),
  'format.strikethrough': md.toggleWrap('~~', '删除线'),
  'format.code': md.toggleWrap('`', 'code'),
  'format.link': md.insertLink,
  'format.h1': md.setHeading(1),
  'format.h2': md.setHeading(2),
  'format.h3': md.setHeading(3),
  'format.h4': md.setHeading(4),
  'format.h5': md.setHeading(5),
  'format.h6': md.setHeading(6),
  'format.quote': md.toggleQuote,
  'format.bulletList': md.toggleBulletList,
  'format.orderedList': md.toggleOrderedList,
  'format.taskList': md.toggleTaskList,

  'insert.codeBlock': md.insertCodeBlock,
  'insert.divider': md.insertDivider,
  'insert.wikiLink': md.insertWikiLink,
  'insert.table': md.insertTable(3, 3),
  'insert.date': md.insertText(new Date().toLocaleDateString('zh-CN')),
  'insert.time': md.insertText(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
}

/** 编辑器内置、不参与用户自定义的行为键（列表续行 / 智能退格） */
const BEHAVIOR_KEYS = [
  { key: 'Enter', run: md.insertNewlineContinueList },
  { key: 'Backspace', run: md.smartBackspace }
]

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/^mod-/, 'mod-')
}

function withoutKeys(bindings, keys) {
  const blocked = new Set(keys.map(k => normalizeKey(k)))
  const out = []
  for (const binding of bindings || []) {
    if (Array.isArray(binding)) {
      out.push(withoutKeys(binding, keys))
      continue
    }
    if (binding && !blocked.has(normalizeKey(binding.key))) out.push(binding)
  }
  return out
}

export function useEditor(options = {}) {
  const container = ref(null)
  const view = shallowRef(null)
  const content = ref(options.initialValue || '')
  const isFocused = ref(false)
  const wordCount = ref(0)
  const charCount = ref(0)
  const lineCount = ref(0)
  const canUndo = ref(false)
  const canRedo = ref(false)
  const cursorLine = ref(1)
  const cursorColumn = ref(1)

  const livePreview = ref(options.livePreview ?? true)
  const spellEnabled = ref(options.spellCheck ?? true)

  let internalUpdate = false
  const settingsWatchStops = []

  // 可热切换的部分用 Compartment 隔离：重新配置时不会重建整个 State，
  // 因此撤销栈、折叠状态、搜索面板都能保留。
  const themeCompartment = new Compartment()
  const lineNumbersCompartment = new Compartment()
  const wrapCompartment = new Compartment()

  const dataSources = shallowRef({
    notes: [],
    tags: [],
    currentNoteId: null,
    outline: [],
    onOpenNote: null,
    onCreateNote: null
  })

  function setDataSources(next) {
    dataSources.value = { ...dataSources.value, ...next }
  }

  // -------------------------------------------------------------------------
  // 自动补全
  // -------------------------------------------------------------------------
  function scanWikiPrefix(ctx) {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    const m = before.match(/(!?)\[\[([^[[\]\n]*)$/)
    if (!m) return null
    return { from: ctx.pos - m[0].length, to: ctx.pos, embed: !!m[1], query: m[2] }
  }

  function scanTagPrefix(ctx) {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    const m = before.match(/(?:^|[\s(（，,、])#([\w\u4e00-\u9fa5./-]*)$/)
    if (!m) return null
    return { from: ctx.pos - m[1].length - 1, to: ctx.pos, query: m[1] }
  }

  function isInFrontmatter(state, pos) {
    if (state.doc.lines === 0) return false
    if (!/^---\s*$/.test(state.doc.line(1).text)) return false
    for (let n = 2; n <= state.doc.lines; n++) {
      const line = state.doc.line(n)
      if (/^---\s*$/.test(line.text)) return pos <= line.to
    }
    return true
  }

  function scanPropertyPrefix(ctx) {
    if (!isInFrontmatter(ctx.state, ctx.pos)) return null
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    const valueMatch = before.match(/^([A-Za-z0-9_\u4e00-\u9fa5.-]*)\s*:\s*([\w\u4e00-\u9fa5./_@-]*)$/)
    if (valueMatch && ['tags', 'tag', 'categories', 'category', 'aliases'].includes(valueMatch[1])) {
      return { from: ctx.pos - valueMatch[2].length, to: ctx.pos, query: valueMatch[2], kind: 'tagValue' }
    }
    const keyMatch = before.match(/^([A-Za-z0-9_\u4e00-\u9fa5.-]*)$/)
    if (keyMatch) return { from: line.from, to: ctx.pos, query: keyMatch[1], kind: 'key' }
    return null
  }

  function noteCompletions(query) {
    const { notes, outline } = dataSources.value || {}
    const q = (query || '').toLowerCase()
    const [targetQ = '', hashQ = ''] = q.split('#')
    const list = []

    for (const n of notes || []) {
      const hay = `${n.title} ${n.folder || ''}`.toLowerCase()
      if (targetQ && !hay.includes(targetQ)) continue
      list.push({
        type: 'reference',
        label: n.title,
        detail: n.folder || '根目录',
        info: n.id === dataSources.value.currentNoteId ? '当前笔记' : '笔记',
        boost: n.id === dataSources.value.currentNoteId ? 0.5 : 1,
        apply: (viewArg, _c, from, to) => {
          const insert = `[[${n.title}${hashQ ? `#${hashQ}` : ''}]]`
          viewArg.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length }
          })
        }
      })

      if (hashQ) {
        const headings = n.id === dataSources.value.currentNoteId
          ? (outline || [])
          : safeOutline(n.content)
        for (const h of headings) {
          if (!h.text.toLowerCase().includes(hashQ)) continue
          list.push({
            type: 'reference',
            label: `${n.title}#${h.text}`,
            detail: n.folder || '根目录',
            info: `H${h.level}`,
            boost: 1.5,
            apply: (viewArg, _c, from, to) => {
              const insert = `[[${n.title}#${h.text}]]`
              viewArg.dispatch({
                changes: { from, to, insert },
                selection: { anchor: from + insert.length }
              })
            }
          })
        }
      }
    }

    if ((!targetQ || hashQ) && outline && outline.length) {
      for (const h of outline) {
        if (hashQ && !h.text.toLowerCase().includes(hashQ)) continue
        list.push({
          type: 'reference',
          label: `#${h.text}`,
          detail: '当前文档',
          info: `H${h.level}`,
          boost: 1.2,
          apply: (viewArg, _c, from, to) => {
            const insert = `[[#${h.text}]]`
            viewArg.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length }
            })
          }
        })
      }
    }

    if (targetQ) {
      const exists = (notes || []).some(n => n.title.toLowerCase() === targetQ.toLowerCase())
      if (!exists) {
        list.unshift({
          type: 'function',
          label: `+ 创建新笔记「${targetQ}」`,
          detail: '回车即可创建并插入链接',
          boost: 2,
          apply: (viewArg, _c, from, to) => {
            const created = dataSources.value.onCreateNote?.(targetQ)
            const title = (created && created.title) || targetQ
            const insert = `[[${title}]]`
            viewArg.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length }
            })
            if (created?.id) dataSources.value.onOpenNote?.(created.id)
          }
        })
      }
    }

    return list.slice(0, 50)
  }

  function safeOutline(mdText) {
    try {
      return extractOutline(mdText || '')
    } catch {
      return []
    }
  }

  function tagCompletions(query, prefix = '#') {
    const q = (query || '').toLowerCase()
    const tags = dataSources.value.tags || []
    const hits = tags
      .filter(t => !q || t.toLowerCase().includes(q))
      .slice(0, 30)
      .map(t => ({ type: 'variable', label: `${prefix}${t}`, detail: '标签' }))
    if (q && !tags.some(t => t.toLowerCase() === q.toLowerCase())) {
      hits.unshift({ type: 'variable', label: `${prefix}${q}`, detail: '新建标签' })
    }
    return hits
  }

  const PROPERTY_KEYS = [
    'title', 'date', 'created', 'updated', 'tags', 'aliases', 'category',
    'author', 'status', 'description', 'cover', 'icon', 'draft', 'publish'
  ]

  function propertyKeyCompletions(query) {
    const q = (query || '').toLowerCase()
    return PROPERTY_KEYS
      .filter(k => !q || k.toLowerCase().includes(q))
      .map(k => ({ type: 'keyword', label: k, detail: '属性' }))
  }

  const quickSnippets = [
    snip('**${1:text}**', { label: '**粗体**', type: 'text', detail: 'snippet' }),
    snip('*${1:text}*', { label: '*斜体*', type: 'text', detail: 'snippet' }),
    snip('==${1:text}==', { label: '==高亮==', type: 'text', detail: 'snippet' }),
    snip('`${1:code}`', { label: '`行内代码`', type: 'text', detail: 'snippet' }),
    snip('- [ ] ${1:任务}', { label: '- [ ] 待办', type: 'text', detail: 'snippet' }),
    snip('```${1:js}\n${2:code}\n```', { label: '```代码块', type: 'text', detail: 'snippet' }),
    snip('> [!note] ${1:标题}\n> ${2:内容}', { label: '> [!note] 提示框', type: 'text', detail: 'callout' }),
    snip('> [!warning] ${1:标题}\n> ${2:内容}', { label: '> [!warning] 警告框', type: 'text', detail: 'callout' })
  ]

  function obsidianAutocomplete(ctx) {
    const prop = scanPropertyPrefix(ctx)
    if (prop) {
      return prop.kind === 'key'
        ? { from: prop.from, options: propertyKeyCompletions(prop.query), validFor: /^[A-Za-z0-9_\u4e00-\u9fa5.-]*$/ }
        : { from: prop.from, options: tagCompletions(prop.query, ''), validFor: /^[\w\u4e00-\u9fa5./_@-]*$/ }
    }
    const wiki = scanWikiPrefix(ctx)
    if (wiki) {
      return {
        from: wiki.from + (wiki.embed ? 3 : 2),
        options: noteCompletions(wiki.query),
        validFor: /^!?\[\[[^[\]\n]*$/
      }
    }
    const tag = scanTagPrefix(ctx)
    if (tag) {
      return {
        from: tag.from + 1,
        options: tagCompletions(tag.query, '#'),
        validFor: /^[\w\u4e00-\u9fa5./-]*$/
      }
    }
    return null
  }

  /** 行首 / 空行后输入 / 才触发，避免英文句子里的斜杠误唤命令面板 */
  function slashAutocomplete(ctx) {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    if (!before.endsWith('/')) return null
    const prev = before.slice(0, -1)
    if (prev.trim() !== '') return null
    return {
      from: ctx.pos - 1,
      options: quickSnippets,
      validFor: /^\/[\w\u4e00-\u9fa5]*$/
    }
  }

  // -------------------------------------------------------------------------
  // Mod+Click 打开双链；单击渲染态链接（[text](url) / 裸 URL）打开外部浏览器
  // -------------------------------------------------------------------------
  function wikilinkClickHandler(event, viewArg) {
    // 渲染态链接：Obsidian 行为 —— 单击即在系统浏览器打开
    const linkEl = event.target?.closest?.('.cm-md-link, .cm-md-bare-url')
    if (linkEl) {
      const href = linkEl.getAttribute('data-md-href')
      if (href && /^(https?:\/\/|www\.)/i.test(href)) {
        event.preventDefault()
        window.open(href.startsWith('www.') ? `https://${href}` : href, '_blank', 'noopener')
        return true
      }
      return false
    }

    if (!(event.metaKey || event.ctrlKey)) return false
    const pos = viewArg.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    if (pos < 0) return false
    const line = viewArg.state.doc.lineAt(pos)
    const rel = pos - line.from
    const open = line.text.lastIndexOf('[[', rel)
    const close = line.text.indexOf(']]', Math.max(0, rel - 1))
    if (open < 0 || close < 0 || open >= close) return false

    const inner = line.text.slice(open + 2, close).replace(/^!/, '').split('|')[0].trim()
    if (!inner) return false
    event.preventDefault()

    const hashIdx = inner.indexOf('#')
    const targetPart = hashIdx >= 0 ? inner.slice(0, hashIdx) : inner
    const headingPart = hashIdx >= 0 ? inner.slice(hashIdx + 1) : ''

    if (!targetPart && headingPart) {
      scrollToHeadingText(headingPart)
      return true
    }

    const notes = dataSources.value.notes || []
    const exact = notes.find(n => n.title === targetPart)
    const hit = exact || notes.find(n => n.title.toLowerCase().includes(targetPart.toLowerCase()))
    if (hit) {
      dataSources.value.onOpenNote?.(hit.id)
      if (headingPart) setTimeout(() => scrollToHeadingText(headingPart), 80)
      return true
    }
    const created = dataSources.value.onCreateNote?.(targetPart)
    if (created?.id) dataSources.value.onOpenNote?.(created.id)
    return true
  }

  // -------------------------------------------------------------------------
  // 统计
  // -------------------------------------------------------------------------
  function computeStats(text) {
    charCount.value = text.length
    lineCount.value = text.split('\n').length
    // 中英混排计数：CJK 按字计，拉丁文按词计，避免纯中文文档只算 1 个词
    const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length
    const latin = (text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9_'’\-]+/g) || []).length
    wordCount.value = cjk + latin
  }

  // -------------------------------------------------------------------------
  // 扩展装配
  // -------------------------------------------------------------------------
  function buildHotkeyBindings() {
    const bindings = []
    const getBinding = options.getBinding || (() => '')
    for (const [id, command] of Object.entries(EDITOR_COMMANDS)) {
      const key = getBinding(id)
      if (!key) continue
      bindings.push({ key, run: command, preventDefault: true })
    }
    return bindings
  }

  function createExtensions() {
    const isDark = options.isDark?.() ?? document.documentElement.getAttribute('data-theme') === 'dark'
    const hotkeyBindings = buildHotkeyBindings()
    const hotkeyKeys = hotkeyBindings.map(b => b.key)

    const extensions = [
      // ---- 高优先级：Markdown 行为键 + 用户自定义快捷键 + 保存 ----
      Prec.high(keymap.of([
        ...hotkeyBindings,
        ...BEHAVIOR_KEYS,
        { key: 'Mod-s', preventDefault: true, run: () => { options.onSave?.(); return true } }
      ])),
      // ---- 默认键位（剔除已被上面接管的键，避免重复触发）----
      keymap.of([
        ...withoutKeys(defaultKeymap, hotkeyKeys),
        ...withoutKeys(historyKeymap, hotkeyKeys),
        ...withoutKeys(foldKeymap, hotkeyKeys),
        ...withoutKeys(searchKeymap, hotkeyKeys),
        ...withoutKeys(completionKeymap, hotkeyKeys)
      ]),

      // ---- 基础视图 ----
      highlightSpecialChars(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      history(),
      foldGutter(),
      search(),
      indentOnInput(),
      bracketMatching(),
      indentUnit.of('  '),
      options.placeholder?.() ? cmPlaceholder(options.placeholder()) : [],

      // ---- Obsidian 能力 ----
      autocompletion({
        override: [obsidianAutocomplete, slashAutocomplete],
        activateOnTyping: true,
        maxRenderedOptions: 30,
        icons: false
      }),
      markdown({ base: markdownLanguage, codeLanguages: [] }),
      createLivePreviewPlugin(() => livePreview.value),
      spellCheckExtension({
        getErrors: (text) => options.getSpellErrors?.(text) || [],
        isEnabled: () => spellEnabled.value,
        getVersion: () => options.getSpellVersion?.() ?? 0,
        onSpellClick: (hit) => options.onSpellClick?.(hit)
      }),

      EditorView.domEventHandlers({
        mousedown(event, viewArg) {
          if (event.button !== 0) return false
          return wikilinkClickHandler(event, viewArg)
        },
        contextmenu(event) {
          options.onContextMenu?.(event)
          return false
        }
      }),

      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          internalUpdate = true
          content.value = update.state.doc.toString()
          computeStats(content.value)
          options.onChange?.(content.value)
          internalUpdate = false
        }
        if (update.selectionSet || update.docChanged) {
          const { state } = update.view
          const head = state.selection.main.head
          const line = state.doc.lineAt(head)
          cursorLine.value = line.number
          cursorColumn.value = head - line.from + 1
          options.onSelectionChange?.({
            hasSelection: state.selection.ranges.some(r => r.from !== r.to),
            coords: selectionCoords(update.view)
          })
        }
        if (update.focusChanged) {
          isFocused.value = update.view.hasFocus
          if (!isFocused.value) options.onBlur?.()
          else options.onFocus?.()
        }
        canUndo.value = undoDepth(update.state) > 0
        canRedo.value = redoDepth(update.state) > 0
      }),

      EditorView.editable.of(!options.readOnly),
      wrapCompartment.of(options.wordWrap?.() === false ? [] : EditorView.lineWrapping),
      lineNumbersCompartment.of(options.showLineNumbers?.() ? lineNumbers() : []),
      themeCompartment.of(getEditorTheme(isDark))
    ]

    return extensions
  }

  function selectionCoords(viewArg) {
    if (!viewArg) return null
    const { state } = viewArg
    const range = state.selection.main
    if (range.from === range.to) return null
    const start = viewArg.coordsAtPos(range.from)
    const end = viewArg.coordsAtPos(range.to)
    if (!start) return null
    return {
      left: Math.min(start.left, end ? end.left : start.left),
      right: Math.max(start.right, end ? end.right : start.right),
      top: Math.min(start.top, end ? end.top : start.top),
      bottom: Math.max(start.bottom, end ? end.bottom : start.bottom)
    }
  }

  /** 热切换主题 / 行号 / 自动换行：只重配置对应 compartment，保留撤销栈 */
  function reconfigureTheme(isDark) {
    if (!view.value) return
    view.value.dispatch({
      effects: themeCompartment.reconfigure(getEditorTheme(isDark))
    })
  }

  function reconfigureLayout() {
    if (!view.value) return
    view.value.dispatch({
      effects: [
        lineNumbersCompartment.reconfigure(options.showLineNumbers?.() ? lineNumbers() : []),
        wrapCompartment.reconfigure(options.wordWrap?.() === false ? [] : EditorView.lineWrapping)
      ]
    })
  }

  /** 快捷键改了要重建整个 keymap —— 这是唯一会重置 State 的情况，频率极低 */
  function refreshKeymap() {
    if (!view.value) return
    const prev = view.value.state
    view.value.setState(
      EditorState.create({
        doc: prev.doc,
        selection: prev.selection,
        extensions: createExtensions()
      })
    )
  }

  function init() {
    if (!container.value || view.value) return

    view.value = new EditorView({
      state: EditorState.create({
        doc: content.value,
        extensions: createExtensions()
      }),
      parent: container.value
    })
    computeStats(content.value)

    settingsWatchStops.push(
      watch(livePreview, () => {
        if (!view.value) return
        view.value.dispatch({ effects: toggleLivePreview.of(true) })
        view.value.requestMeasure()
      }),
      watch(spellEnabled, () => forceRefreshSpell())
    )
  }

  function destroy() {
    settingsWatchStops.forEach(stop => stop?.())
    settingsWatchStops.length = 0
    if (view.value) {
      view.value.destroy()
      view.value = null
    }
  }

  // -------------------------------------------------------------------------
  // 文档操作
  // -------------------------------------------------------------------------
  /**
   * 外部替换内容。
   * 只做首尾公共部分之外的最小改动，并标注 addToHistory=false ——
   * 切换笔记 / 磁盘回写不会污染撤销栈，用户按 Ctrl+Z 不会"撤销到上一篇笔记"。
   */
  function setContent(next) {
    if (!view.value || internalUpdate) return
    const text = String(next ?? '')
    const current = view.value.state.doc.toString()
    if (text === current) return

    let start = 0
    const minLen = Math.min(text.length, current.length)
    while (start < minLen && text[start] === current[start]) start++
    let endOld = current.length
    let endNew = text.length
    while (endOld > start && endNew > start && current[endOld - 1] === text[endNew - 1]) {
      endOld--
      endNew--
    }

    content.value = text
    computeStats(text)
    view.value.dispatch({
      changes: { from: start, to: endOld, insert: text.slice(start, endNew) },
      annotations: Transaction.addToHistory.of(false)
    })
  }

  function focus() {
    view.value?.focus()
  }

  function blur() {
    view.value?.contentDOM?.blur?.()
  }

  function getSelection() {
    if (!view.value) return { text: '', from: 0, to: 0 }
    const { state } = view.value
    const { from, to } = state.selection.main
    return { text: state.sliceDoc(from, to), from, to }
  }

  function replaceRange(from, to, text, selectEnd = true) {
    if (!view.value) return
    view.value.dispatch({
      changes: { from, to, insert: text },
      selection: selectEnd
        ? { anchor: from + text.length }
        : { anchor: from, head: from + text.length },
      userEvent: 'input'
    })
    focus()
  }

  function replaceSelection(text) {
    if (!view.value) return
    const { from, to } = view.value.state.selection.main
    replaceRange(from, to, text)
  }

  function insertAtCursor(text) {
    if (!view.value) return
    const { from, to } = view.value.state.selection.main
    replaceRange(from, to, text)
  }

  /** 按命令 id 执行（工具栏 / 命令面板统一入口） */
  function applyCommand(id) {
    if (!view.value) return false
    const command = EDITOR_COMMANDS[id]
    if (!command) return false
    const ok = command(view.value)
    if (ok) focus()
    return ok
  }

  function applyFormat(formatId) {
    return applyCommand(formatId)
  }

  function undo() {
    if (!view.value) return
    undoCommand(view.value)
    focus()
  }

  function redo() {
    if (!view.value) return
    redoCommand(view.value)
    focus()
  }

  function selectAll() {
    if (!view.value) return
    view.value.dispatch({ selection: { anchor: 0, head: view.value.state.doc.length } })
    focus()
  }

  // -------------------------------------------------------------------------
  // 滚动 / 定位
  // -------------------------------------------------------------------------
  function scrollToPos(pos, margin = 60) {
    if (!view.value) return
    view.value.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: margin })
    })
  }

  function scrollToLine(lineNumber, margin = 60) {
    if (!view.value) return
    const n = Math.max(1, Math.min(lineNumber, view.value.state.doc.lines))
    scrollToPos(view.value.state.doc.line(n).from, margin)
  }

  function scrollToHeadingText(text) {
    if (!view.value || !text) return
    const needle = String(text).trim().toLowerCase()
    for (let n = 1; n <= view.value.state.doc.lines; n++) {
      const match = view.value.state.doc.line(n).text.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
      if (match && match[1].trim().toLowerCase() === needle) {
        scrollToLine(n)
        return
      }
    }
  }

  function getScrollInfo() {
    if (!view.value) return { top: 0, height: 0, clientHeight: 0, max: 1 }
    const el = view.value.scrollDOM
    return {
      top: el.scrollTop,
      height: el.scrollHeight,
      clientHeight: el.clientHeight,
      max: Math.max(1, el.scrollHeight - el.clientHeight)
    }
  }

  function setScrollTop(top) {
    if (!view.value) return
    view.value.scrollDOM.scrollTop = top
  }

  function setScrollRatio(ratio) {
    const info = getScrollInfo()
    setScrollTop(Math.max(0, Math.min(1, ratio)) * info.max)
  }

  function getScrollRatio() {
    const info = getScrollInfo()
    return info.max > 0 ? info.top / info.max : 0
  }

  // -------------------------------------------------------------------------
  // 其它
  // -------------------------------------------------------------------------
  function coordsAtPos(pos) {
    if (!view.value) return null
    return view.value.coordsAtPos(pos) || null
  }

  function spellRect(range) {
    return spellRectOf(view.value, range)
  }

  function posAtCoords(x, y) {
    if (!view.value) return -1
    return view.value.posAtCoords({ x, y }, false)
  }

  function extractHeadingsFromContent() {
    return safeOutline(content.value)
  }

  function setLivePreview(enabled) {
    livePreview.value = !!enabled
  }

  function setSpellEnabled(enabled) {
    spellEnabled.value = !!enabled
    forceRefreshSpell()
  }

  function forceRefreshSpell() {
    view.value?.dispatch({ effects: forceSpellUpdate.of(true) })
  }

  function getSelectionCoords() {
    return selectionCoords(view.value)
  }

  onBeforeUnmount(() => {
    destroy()
  })

  const stats = computed(() => ({
    words: wordCount.value,
    chars: charCount.value,
    lines: lineCount.value
  }))

  return {
    container,
    view,
    content,
    isFocused,
    wordCount,
    charCount,
    lineCount,
    stats,
    canUndo,
    canRedo,
    cursorLine,
    cursorColumn,
    livePreview,
    spellEnabled,
    init,
    destroy,
    setContent,
    focus,
    blur,
    getSelection,
    replaceRange,
    replaceSelection,
    insertAtCursor,
    applyFormat,
    applyCommand,
    undo,
    redo,
    selectAll,
    scrollToPos,
    scrollToLine,
    scrollToHeadingText,
    getScrollInfo,
    setScrollTop,
    setScrollRatio,
    getScrollRatio,
    coordsAtPos,
    spellRect,
    posAtCoords,
    extractHeadingsFromContent,
    setDataSources,
    setLivePreview,
    setSpellEnabled,
    forceRefreshSpell,
    getSelectionCoords,
    reconfigureTheme,
    reconfigureLayout,
    refreshKeymap
  }
}
