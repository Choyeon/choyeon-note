import { ref, shallowRef, onBeforeUnmount, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { getEditorTheme } from '../utils/editor/themes'
import { spellCheckExtension, forceSpellUpdate } from '../utils/editor/spellcheck'
import { useAppStore } from '../stores/app'

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
    
    const extensions = [
      lineNumbers(),
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
      autocompletion(),
      markdown({ base: markdownLanguage }),
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

    if (options.lineWrapping !== false) {
      extensions.push(EditorView.lineWrapping)
    }

    return extensions
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
  }

  function destroy() {
    if (spellWatchStop) {
      spellWatchStop()
      spellWatchStop = null
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
    getLineCount,
    posAtCoords,
    selectAll
  }
}
