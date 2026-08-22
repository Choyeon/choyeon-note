import { ref, shallowRef, onBeforeUnmount, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap, snippet, snippetCompletion as snip } from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { getEditorTheme } from '../utils/editor/themes'
import { spellCheckExtension, forceSpellUpdate } from '../utils/editor/spellcheck'
import { useAppStore } from '../stores/app'
import { extractOutline } from '../composables/useLinks.js'

export function useEditor(options = {}) {
  const appStore = useAppStore()
  const container = ref(null)
  const view = shallowRef(null)
  const content = ref(options.initialValue || '')
  const isFocused = ref(false)
  const wordCount = ref(0)
  const charCount = ref(0)
  const lineCount = ref(0)

  let internalUpdate = false
  let spellWatchStop = null
  let settingsWatchStops = []

  // wikilink / tag / frontmatter 自动补全数据源（可热更新）
  const dataSources = shallowRef({
    notes: [],          // [{id, title, folder}]
    tags: [],           // string[]
    currentNoteId: null,
    outline: [],        // extractOutline 产物，用于 #heading 锚点补全
    onOpenNote: null,   // (noteId | createTarget) => void
    onCreateNote: null  // (target) => noteId
  })

  function setDataSources(next) {
    dataSources.value = { ...dataSources.value, ...next }
  }

  // Wikilink [[target#heading|alias]] 解析：从光标处向前扫描
  function scanWikiPrefix(ctx) {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    const embedMatch = before.match(/(!?)\[\[([^\[\]\n]*)$/)
    if (!embedMatch) return null
    return {
      from: ctx.pos - (embedMatch[0].length),
      to: ctx.pos,
      embed: !!embedMatch[1],
      query: embedMatch[2]
    }
  }

  function scanTagPrefix(ctx) {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    const m = before.match(/(?:^|\s)#([\w\u4e00-\u9fa5./-]*)$/)
    if (!m) return null
    // 排除 frontmatter 的 key: value 场景，允许 body 内 #tag
    return {
      from: ctx.pos - m[1].length - 1,
      to: ctx.pos,
      query: m[1]
    }
  }

  function scanPropertyPrefix(ctx) {
    // 仅在 frontmatter 区域（首行 --- 与结束 --- 之间）开启
    const doc = ctx.state.doc.toString()
    if (!/^---\s*\n/.test(doc)) return null
    const endFm = doc.indexOf('\n---', 4)
    if (endFm < 0 || ctx.pos > endFm + 4) return null
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    const m = before.match(/^([A-Za-z0-9_\u4e00-\u9fa5.-]*)\s*:\s*([\w\u4e00-\u9fa5./_-]*)$/)
    if (m && (m[1] === 'tags' || m[1] === 'tag' || m[1] === 'categories' || m[1] === 'category')) {
      return { from: ctx.pos - m[2].length, to: ctx.pos, query: m[2], kind: 'tagValue' }
    }
    const km = before.match(/^([A-Za-z0-9_\u4e00-\u9fa5.-]*)$/)
    if (km) return { from: line.from, to: ctx.pos, query: km[1], kind: 'key' }
    return null
  }

  function noteCompletions(query) {
    const { notes, outline } = dataSources.value || {}
    const q = (query || '').toLowerCase()
    const qParts = q.split('#')
    const targetQ = qParts[0] || ''
    const hashQ = qParts[1] || ''
    const options = []
    for (const n of notes || []) {
      const key = `${n.title} ${n.folder || ''}`.toLowerCase()
      if (targetQ && !key.includes(targetQ)) continue
      options.push({
        type: 'reference',
        label: n.title,
        detail: n.folder || '根目录',
        info: n.id === dataSources.value.currentNoteId ? '当前笔记' : '笔记',
        apply: (view, completion, from, to) => {
          const suffix = hashQ
            ? `#${hashQ}]]`
            : (targetQ ? ']]' : `${n.title}]]`)
          const insert = `[[${n.title}${hashQ ? `#${hashQ}` : ''}`
          view.dispatch({
            changes: { from, to, insert: insert + (targetQ ? ']]' : `]]`) },
            selection: { anchor: from + insert.length + 2 }
          })
        },
        boost: n.id === dataSources.value.currentNoteId ? 0.5 : 1
      })
      // 该笔记内的 heading 也作为候选（若输入已包含 # 则优先展示 heading）
      if (hashQ) {
        try {
          const headings = n.id === dataSources.value.currentNoteId
            ? (outline || [])
            : extractOutline(n.content || '')
          for (const h of headings) {
            if (!h.text.toLowerCase().includes(hashQ)) continue
            options.push({
              type: 'reference',
              label: `${n.title}#${h.text}`,
              detail: n.folder || '根目录',
              info: `H${h.level}`,
              apply: (view, _c, from, to) => {
                const text = `[[${n.title}#${h.text}]]`
                view.dispatch({
                  changes: { from, to, insert: text },
                  selection: { anchor: from + text.length }
                })
              },
              boost: 1.5
            })
          }
        } catch (_) {}
      }
    }
    // 当前文档 heading（仅当 targetQ 为空 或 # 出现）
    if ((!targetQ || hashQ) && outline && outline.length) {
      for (const h of outline) {
        if (hashQ && !h.text.toLowerCase().includes(hashQ)) continue
        options.push({
          type: 'reference',
          label: `#${h.text}`,
          detail: '当前文档',
          info: `H${h.level}`,
          apply: (view, _c, from, to) => {
            const text = `[[#${h.text}]]`
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length }
            })
          },
          boost: 1.2
        })
      }
    }
    // 「创建新笔记」兜底
    if (targetQ) {
      const existing = (notes || []).some(n => n.title.toLowerCase() === targetQ.toLowerCase())
      if (!existing) {
        options.unshift({
          type: 'function',
          label: `+ 创建新笔记 "${targetQ}"`,
          detail: 'Ctrl/Cmd+Enter 可直接创建',
          apply: (view, _c, from, to) => {
            const created = dataSources.value.onCreateNote?.(targetQ)
            const title = (created && created.title) || targetQ
            const text = `[[${title}]]`
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length }
            })
            if (created && created.id) {
              dataSources.value.onOpenNote?.(created.id)
            }
          },
          boost: 2
        })
      }
    }
    return options.slice(0, 50)
  }

  function tagCompletions(query, prefix = '#') {
    const q = (query || '').toLowerCase()
    const tags = (dataSources.value.tags || [])
    const hits = tags
      .filter(t => !q || t.toLowerCase().includes(q))
      .slice(0, 30)
      .map(t => ({
        type: 'variable',
        label: `${prefix}${t}`,
        detail: '标签'
      }))
    if (q && !tags.some(t => t.toLowerCase() === q.toLowerCase())) {
      hits.unshift({
        type: 'variable',
        label: `${prefix}${q}`,
        detail: '新建标签'
      })
    }
    return hits
  }

  function propertyKeyCompletions(query) {
    const q = (query || '').toLowerCase()
    const keys = ['title', 'date', 'created', 'updated', 'tags', 'tag', 'categories', 'category', 'aliases', 'alias', 'description', 'author', 'status', 'publish', 'cover', 'cssclasses', 'icon', 'draft']
    return keys
      .filter(k => !q || k.toLowerCase().includes(q))
      .map(k => ({ type: 'keyword', label: k, detail: '属性' }))
  }

  function obsidianAutocomplete(ctx) {
    const prop = scanPropertyPrefix(ctx)
    if (prop) {
      if (prop.kind === 'key') return { from: prop.from, options: propertyKeyCompletions(prop.query), validFor: /^[A-Za-z0-9_\u4e00-\u9fa5.-]*$/ }
      if (prop.kind === 'tagValue') return { from: prop.from, options: tagCompletions(prop.query, ''), validFor: /^[\w\u4e00-\u9fa5./_-]*$/ }
    }
    const wiki = scanWikiPrefix(ctx)
    if (wiki) {
      return {
        from: wiki.from + (wiki.embed ? 3 : 2), // 只替换 [[ 后面的内容
        options: noteCompletions(wiki.query),
        validFor: /^!?\[\[[^\[\]\n]*$/
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

  const quickSnippets = [
    snip('**${1:text}**', { label: '**粗体**', type: 'text', detail: 'snippet' }),
    snip('*${1:text}*', { label: '*斜体*', type: 'text', detail: 'snippet' }),
    snip('==${1:text}==', { label: '==高亮==', type: 'text', detail: 'snippet' }),
    snip('`${1:code}`', { label: '`行内代码`', type: 'text', detail: 'snippet' }),
    snip('- [ ] ${1:task}', { label: '- [ ] 待办', type: 'text', detail: 'snippet' }),
    snip('```${1:js}\n${2:code}\n```', { label: '```代码块', type: 'text', detail: 'snippet' }),
    snip('> [!note] 标题\n> 内容', { label: '> [!note] 提示框', type: 'text', detail: 'callout' }),
    snip('> [!todo] 标题\n> - [ ] 任务1', { label: '> [!todo] 任务提示框', type: 'text', detail: 'callout' })
  ]

  function snippetAutocomplete(ctx) {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, ctx.pos)
    if (!before.trim()) return null
    // 任意行末触发 snippet 候选作为兜底（低频）
    return {
      from: ctx.pos,
      options: quickSnippets,
      validFor: /^.*$/
    }
  }

  // Mod+Click 打开 wikilink：扫描点击位置前后的 [[...]] 模式
  function wikilinkClickHandler(target) {
    // 只响应 Mod 键（Cmd/Ctrl）点击
    if (!target.event || !(target.event.metaKey || target.event.ctrlKey)) return false
    const pos = target.pos
    const line = view.value.state.doc.lineAt(pos)
    const text = line.text
    const relPos = pos - line.from
    // 向两侧找到最近的 [[ ... ]]
    let open = text.lastIndexOf('[[', relPos)
    let close = text.indexOf(']]', Math.max(0, relPos - 1))
    if (open < 0 || close < 0 || open >= close) return false
    const inner = text.slice(open + 2, close)
    // ![[embed]] 也支持
    const anchor = inner.replace(/^!/, '').split('|')[0].trim()
    if (!anchor) return false
    target.event.preventDefault()
    // 尝试解析 target#heading 或 #heading
    const hashIdx = anchor.indexOf('#')
    const targetPart = hashIdx >= 0 ? anchor.slice(0, hashIdx) : anchor
    const headingPart = hashIdx >= 0 ? anchor.slice(hashIdx + 1) : ''
    if (!targetPart && headingPart) {
      // 仅 heading：滚到当前文档的对应标题
      scrollToHeadingText(headingPart)
      return true
    }
    const notes = (dataSources.value.notes || [])
    // 优先按标题精确匹配，再按模糊
    const exact = notes.find(n => n.title === targetPart)
    if (exact) {
      dataSources.value.onOpenNote?.(exact.id)
      if (headingPart) setTimeout(() => scrollToHeadingText(headingPart), 80)
      return true
    }
    const fuzzy = notes.find(n => n.title.toLowerCase().includes(targetPart.toLowerCase()))
    if (fuzzy) {
      dataSources.value.onOpenNote?.(fuzzy.id)
      if (headingPart) setTimeout(() => scrollToHeadingText(headingPart), 80)
      return true
    }
    // 未找到 → 创建新笔记
    const created = dataSources.value.onCreateNote?.(targetPart)
    if (created && created.id) {
      dataSources.value.onOpenNote?.(created.id)
    }
    return true
  }

  function scrollToHeadingText(text) {
    if (!view.value) return
    const lines = view.value.state.doc.toString().split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
      if (m && m[1].trim() === text.trim()) {
        const pos = view.value.state.doc.line(i + 1).from
        view.value.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 50 })
        })
        return
      }
    }
  }

  function extractHeadingsFromContent() {
    try {
      return extractOutline(content.value || '')
    } catch { return [] }
  }

  function computeStats(text) {
    wordCount.value = text.trim() ? text.trim().split(/\s+/).length : 0
    charCount.value = text.length
    lineCount.value = text.split('\n').length
  }

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      internalUpdate = true
      content.value = update.state.doc.toString()
      computeStats(content.value)
      options.onChange?.(content.value)
      internalUpdate = false
    }
    if (update.focusChanged) {
      isFocused.value = update.view.hasFocus
    }
  })

  const editable = EditorView.editable.of(!options.readOnly)

  function createExtensions() {
    const isDark = options.isDark ?? document.documentElement.getAttribute('data-theme') === 'dark'

    const mouseHandlers = EditorView.domEventHandlers({
      click(event, viewArg) {
        try {
          const pos = viewArg.posAtDOM(event.target, event.offset ?? 0) ?? -1
          return wikilinkClickHandler({ event, pos })
        } catch (e) {
          return false
        }
      }
    })

    const extensions = [
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      autocompletion({
        override: [obsidianAutocomplete, snippetAutocomplete],
        activateOnTyping: true,
        maxRenderedOptions: 20,
        icons: false
      }),
      markdown({ base: markdownLanguage }),
      mouseHandlers,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
        {
          key: 'Mod-s',
          run: () => {
            options.onSave?.()
            return true
          }
        },
        {
          key: 'Mod-b',
          run: () => {
            applyFormat('bold')
            return true
          }
        },
        {
          key: 'Mod-i',
          run: () => {
            applyFormat('italic')
            return true
          }
        },
        {
          key: 'Mod-k',
          run: () => {
            applyFormat('link')
            return true
          }
        },
        {
          key: 'Mod-Alt-1',
          run: () => { applyFormat('h1'); return true }
        },
        {
          key: 'Mod-Alt-2',
          run: () => { applyFormat('h2'); return true }
        },
        {
          key: 'Mod-Alt-3',
          run: () => { applyFormat('h3'); return true }
        }
      ]),
      updateListener,
      editable,
      ...getEditorTheme(isDark),
      spellCheckExtension(
        (text) => appStore.spellCheck ? appStore.getSpellErrors(text) : [],
        () => appStore.spellCheck,
        () => appStore.spellVersion
      )
    ]

    if (appStore.showLineNumbers) {
      extensions.push(lineNumbers())
    }

    if (appStore.wordWrap) {
      extensions.push(EditorView.lineWrapping)
    }

    return extensions
  }

  function reconfigureExtensions() {
    if (!view.value) return
    view.value.dispatch({
      effects: view.value.state.facet(EditorView.view).reconfigure(
        createExtensions()
      )
    })
  }

  function init() {
    if (!container.value) return

    const state = EditorState.create({
      doc: content.value,
      extensions: createExtensions()
    })

    view.value = new EditorView({
      state,
      parent: container.value
    })

    computeStats(content.value)
    
    spellWatchStop = watch(() => appStore.spellVersion, () => {
      if (view.value) {
        forceSpellUpdate(view.value)
      }
    })

    settingsWatchStops.push(
      watch(() => appStore.showLineNumbers, () => reconfigureExtensions()),
      watch(() => appStore.wordWrap, () => reconfigureExtensions()),
      watch(() => appStore.spellCheck, () => {
        if (view.value) {
          forceSpellUpdate(view.value)
        }
      })
    )
  }

  function destroy() {
    if (spellWatchStop) {
      spellWatchStop()
      spellWatchStop = null
    }
    if (settingsWatchStops.length > 0) {
      settingsWatchStops.forEach(stop => stop?.())
      settingsWatchStops = []
    }
    if (view.value) {
      view.value.destroy()
      view.value = null
    }
  }

  function setContent(newContent) {
    if (!view.value || internalUpdate) return
    view.value.dispatch({
      changes: {
        from: 0,
        to: view.value.state.doc.length,
        insert: newContent
      }
    })
    computeStats(newContent)
  }

  function focus() {
    view.value?.focus()
  }

  function getSelection() {
    if (!view.value) return { text: '', from: 0, to: 0 }
    const { state } = view.value
    const from = state.selection.main.from
    const to = state.selection.main.to
    return {
      text: state.sliceDoc(from, to),
      from,
      to
    }
  }

  function replaceSelection(text, from, to) {
    if (!view.value) return
    const sel = getSelection()
    const f = from ?? sel.from
    const t = to ?? sel.to
    view.value.dispatch({
      changes: { from: f, to: t, insert: text },
      selection: { anchor: f + text.length }
    })
    focus()
  }

  function insertAtCursor(text) {
    if (!view.value) return
    const { state } = view.value
    const from = state.selection.main.from
    view.value.dispatch({
      changes: { from, insert: text },
      selection: { anchor: from + text.length }
    })
    focus()
  }

  function applyFormat(format) {
    if (!view.value) return
    const { state, dispatch } = view.value
    const sel = state.selection.main
    const selectedText = state.sliceDoc(sel.from, sel.to)
    let result = ''
    let cursorOffset = 0

    switch (format) {
      case 'bold':
        result = selectedText ? `**${selectedText}**` : '****'
        cursorOffset = selectedText ? result.length : 2
        break
      case 'italic':
        result = selectedText ? `*${selectedText}*` : '**'
        cursorOffset = selectedText ? result.length : 1
        break
      case 'code':
        result = selectedText ? `\`${selectedText}\`` : '``'
        cursorOffset = selectedText ? result.length : 1
        break
      case 'codeblock':
        result = selectedText ? `\n\`\`\`\n${selectedText}\n\`\`\`\n` : '\n```\n\n```\n'
        cursorOffset = selectedText ? result.length : 5
        break
      case 'link':
        result = selectedText ? `[${selectedText}](url)` : '[](url)'
        cursorOffset = selectedText ? result.length - 4 : 3
        break
      case 'strikethrough':
        result = selectedText ? `~~${selectedText}~~` : '~~~~'
        cursorOffset = selectedText ? result.length : 2
        break
      case 'highlight':
        result = selectedText ? `==${selectedText}==` : '===='
        cursorOffset = selectedText ? result.length : 2
        break
      case 'h1':
        result = `# ${selectedText || ''}`
        cursorOffset = result.length
        break
      case 'h2':
        result = `## ${selectedText || ''}`
        cursorOffset = result.length
        break
      case 'h3':
        result = `### ${selectedText || ''}`
        cursorOffset = result.length
        break
      case 'quote':
        result = `> ${selectedText || ''}`
        cursorOffset = result.length
        break
      case 'list':
        result = `- ${selectedText || ''}`
        cursorOffset = result.length
        break
      case 'ordered':
        result = `1. ${selectedText || ''}`
        cursorOffset = result.length
        break
      case 'todo':
        result = `- [ ] ${selectedText || ''}`
        cursorOffset = result.length
        break
      case 'underline':
        result = selectedText ? `<u>${selectedText}</u>` : '<u></u>'
        cursorOffset = selectedText ? result.length : 3
        break
      default:
        return
    }

    dispatch({
      changes: { from: sel.from, to: sel.to, insert: result },
      selection: { anchor: sel.from + cursorOffset }
    })
    focus()
  }

  function undo() {
    if (!view.value) return
    const { state, dispatch } = view.value
    defaultKeymap.find(k => k.key === 'Mod-z')?.run?.(view.value)
  }

  function redo() {
    if (!view.value) return
    defaultKeymap.find(k => k.key === 'Mod-y' || k.key === 'Shift-Mod-z')?.run?.(view.value)
  }

  function updateTheme(isDark) {
    if (!view.value) return
    view.value.dispatch({
      effects: view.value.state.facet(EditorView.theme).reconfigure(
        getEditorTheme(isDark)
      )
    })
  }

  function scrollToLine(line) {
    if (!view.value) return
    const pos = view.value.state.doc.line(line).from
    view.value.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 50 })
    })
  }

  function getLineCount() {
    return view.value?.state.doc.lines || 0
  }

  function posAtCoords(clientX, clientY) {
    if (!view.value) return -1
    const rect = view.value.dom.getBoundingClientRect()
    const pos = view.value.posAtCoords({
      x: clientX - rect.left,
      y: clientY - rect.top
    })
    return pos ?? -1
  }

  function selectAll() {
    if (!view.value) return
    const last = view.value.state.doc.length
    view.value.dispatch({
      selection: { anchor: 0, head: last }
    })
    focus()
  }

  watch(() => options.initialValue, (val) => {
    if (val !== content.value && !internalUpdate) {
      setContent(val)
    }
  })

  onBeforeUnmount(() => {
    destroy()
  })

  return {
    container,
    view,
    content,
    isFocused,
    wordCount,
    charCount,
    lineCount,
    init,
    destroy,
    setContent,
    focus,
    getSelection,
    replaceSelection,
    insertAtCursor,
    applyFormat,
    undo,
    redo,
    updateTheme,
    scrollToLine,
    scrollToHeadingText,
    getLineCount,
    posAtCoords,
    selectAll,
    setDataSources,
    extractHeadingsFromContent
  }
}
