<template>
  <div class="markdown-editor w-full h-full flex flex-col" :class="{ 'markdown-editor--readonly': readOnly }">
    <div ref="container" class="flex-1 min-h-0 overflow-auto cm-editor-container"></div>
  </div>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue'
import { useEditor } from '@/composables/useEditor'
import { useAppStore } from '@/stores/app'

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
  placeholder: { type: String, default: '' },
  /** true = 实时预览（装饰层渲染）；false = 纯源码 */
  livePreview: { type: Boolean, default: true },
  /** 单词键：切换笔记时强制整篇重算拼写装饰 */
  docKey: { type: String, default: '' },
  completionContext: { type: Object, default: () => ({}) }
})

const emit = defineEmits([
  'update:modelValue', 'change', 'save', 'focus', 'blur',
  'open-note', 'create-note', 'spell-click', 'selection-change', 'context-menu', 'ready'
])

const appStore = useAppStore()

function handleOpenNote(id) {
  emit('open-note', id)
}

function handleCreateNote(target) {
  const ctx = props.completionContext || {}
  return ctx.onCreateNote?.(target) || null
}

const {
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
  spellRect,
  posAtCoords,
  coordsAtPos,
  extractHeadingsFromContent,
  setDataSources,
  setLivePreview,
  setSpellEnabled,
  forceRefreshSpell,
  getSelectionCoords,
  reconfigureTheme,
  reconfigureLayout,
  refreshKeymap
} = useEditor({
  initialValue: props.modelValue,
  readOnly: props.readOnly,
  livePreview: props.livePreview,
  spellCheck: appStore.spellCheck,

  // 所有「外部状态」都以函数形式传入，CodeMirror 每次构建扩展时读最新值，
  // 避免闭包捕获旧快照导致设置改了不生效。
  isDark: () => appStore.effectiveTheme === 'dark',
  wordWrap: () => appStore.wordWrap,
  showLineNumbers: () => appStore.showLineNumbers,
  placeholder: () => props.placeholder,
  getBinding: (id) => appStore.getBinding(id),
  getSpellErrors: (text) => appStore.getSpellErrors(text),
  getSpellVersion: () => appStore.spellVersion,

  onChange: (val) => {
    emit('update:modelValue', val)
    emit('change', val)
  },
  onSave: () => emit('save'),
  onFocus: () => emit('focus'),
  onBlur: () => emit('blur'),
  onSpellClick: (hit) => emit('spell-click', hit),
  onContextMenu: (event) => emit('context-menu', event),
  onSelectionChange: (info) => emit('selection-change', info)
})

function syncDataSources() {
  const ctx = props.completionContext || {}
  setDataSources({
    notes: ctx.notes || [],
    tags: ctx.tags || [],
    currentNoteId: ctx.currentNoteId || null,
    outline: ctx.outline || [],
    onOpenNote: handleOpenNote,
    onCreateNote: handleCreateNote
  })
}

watch(() => props.modelValue, (val) => {
  if (typeof val === 'string' && val !== content.value) setContent(val)
}, { flush: 'post' })

watch(() => props.completionContext, syncDataSources, { deep: true, immediate: true })

watch(() => props.livePreview, (v) => setLivePreview(v))

watch(() => appStore.spellCheck, (v) => setSpellEnabled(v))

// 主题 / 行号 / 换行走 Compartment 热切换，撤销栈与光标位置都保留
watch(() => appStore.effectiveTheme, (t) => reconfigureTheme(t === 'dark'))
watch([() => appStore.showLineNumbers, () => appStore.wordWrap], reconfigureLayout)

// 快捷键重建是不可避免的 setState，用 JSON 快照做去重，避免每次设置页输入都重建
let lastHotkeySnapshot = JSON.stringify(appStore.hotkeys)
watch(() => appStore.hotkeys, (v) => {
  const snapshot = JSON.stringify(v)
  if (snapshot === lastHotkeySnapshot) return
  lastHotkeySnapshot = snapshot
  refreshKeymap()
}, { deep: true })

// 切换笔记时整篇内容换掉，装饰必须重算
watch(() => props.docKey, () => forceRefreshSpell())

watch(isFocused, (v) => emit(v ? 'focus' : 'blur'))

onMounted(() => {
  init()
  syncDataSources()
  emit('ready', { view })
})

defineExpose({
  view,
  content,
  stats,
  canUndo,
  canRedo,
  cursorLine,
  cursorColumn,
  isFocused,
  wordCount,
  charCount,
  lineCount,
  focus,
  blur,
  destroy,
  setContent,
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
  spellRect,
  posAtCoords,
  coordsAtPos,
  extractHeadingsFromContent,
  forceRefreshSpell,
  getSelectionCoords
})
</script>

<style scoped>
.markdown-editor {
  position: relative;
  min-height: 0;
}

.cm-editor-container :deep(.cm-editor) {
  height: 100%;
  background: transparent !important;
}

.cm-editor-container :deep(.cm-scroller) {
  overflow: auto;
}

.cm-editor-container :deep(.cm-gutters) {
  user-select: none;
}

.markdown-editor--readonly :deep(.cm-cursor) {
  display: none;
}
</style>
