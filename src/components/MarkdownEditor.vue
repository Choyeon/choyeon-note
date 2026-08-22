<template>
  <div 
    class="markdown-editor w-full h-full flex flex-col"
    :class="{ 'markdown-editor--readonly': readOnly }"
  >
    <div 
      ref="container"
      class="flex-1 overflow-auto cm-editor-container"
      :style="containerStyle"
    ></div>
  </div>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue'
import { useEditor } from '../composables/useEditor'
import { useAppStore } from '../stores/app'

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  readOnly: {
    type: Boolean,
    default: false
  },
  placeholder: {
    type: String,
    default: ''
  },
  // Obsidian 风格自动补全 & 点击跳转的数据源
  completionContext: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits(['update:modelValue', 'change', 'save', 'focus', 'blur', 'open-note', 'create-note'])

const appStore = useAppStore()

const containerStyle = computed(() => ({
  fontSize: `var(--font-size-body)`,
  '--font-size-body': appStore.fontSize === 'small' ? '13px' : appStore.fontSize === 'large' ? '16px' : '14px'
}))

function handleOpenNote(id) { emit('open-note', id) }
function handleCreateNote(target) {
  return new Promise((resolve) => {
    // 给父组件返回创建结果；父组件会同步 emit 回 payload
    emit('create-note', { target, resolve })
  })
}

const {
  container,
  content,
  isFocused,
  wordCount,
  charCount,
  lineCount,
  init,
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
  posAtCoords,
  selectAll,
  setDataSources,
  extractHeadingsFromContent
} = useEditor({
  initialValue: props.modelValue,
  readOnly: props.readOnly,
  isDark: appStore.effectiveTheme === 'dark',
  onChange: (val) => {
    emit('update:modelValue', val)
    emit('change', val)
  },
  onSave: () => {
    emit('save')
  }
})

function syncDataSources() {
  const ctx = props.completionContext || {}
  setDataSources({
    notes: ctx.notes || [],
    tags: ctx.tags || [],
    currentNoteId: ctx.currentNoteId || null,
    outline: ctx.outline || [],
    onOpenNote: handleOpenNote,
    onCreateNote: (target) => {
      return ctx.onCreateNote?.(target) || null
    }
  })
}

watch(() => props.modelValue, (val) => {
  if (val !== content.value) {
    setContent(val)
  }
}, { flush: 'post' })

watch(() => props.completionContext, () => {
  syncDataSources()
}, { deep: true, immediate: true })

watch(() => appStore.effectiveTheme, (theme) => {
  updateTheme(theme === 'dark')
})

watch(isFocused, (val) => {
  emit(val ? 'focus' : 'blur')
})

onMounted(() => {
  init()
  syncDataSources()
})

defineExpose({
  focus,
  getSelection,
  replaceSelection,
  insertAtCursor,
  applyFormat,
  undo,
  redo,
  scrollToLine,
  scrollToHeadingText,
  posAtCoords,
  selectAll,
  wordCount,
  charCount,
  lineCount,
  extractHeadingsFromContent
})
</script>

<style scoped>
.markdown-editor {
  position: relative;
}

.cm-editor-container {
  min-height: 0;
}

.cm-editor-container :deep(.cm-editor) {
  height: 100%;
  background: transparent !important;
}

.cm-editor-container :deep(.cm-scroller) {
  overflow: auto;
  font-family: var(--font-mono), 'Consolas', 'Monaco', 'Courier New', monospace;
}

.cm-editor-container :deep(.cm-gutters) {
  user-select: none;
}

.markdown-editor--readonly :deep(.cm-cursor) {
  display: none;
}
</style>
