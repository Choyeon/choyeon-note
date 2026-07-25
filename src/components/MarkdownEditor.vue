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
  }
})

const emit = defineEmits(['update:modelValue', 'change', 'save', 'focus', 'blur'])

const appStore = useAppStore()

const containerStyle = computed(() => ({
  fontSize: `var(--font-size-body)`,
  '--font-size-body': appStore.fontSize === 'small' ? '13px' : appStore.fontSize === 'large' ? '16px' : '14px'
}))

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
  posAtCoords,
  selectAll
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

watch(() => props.modelValue, (val) => {
  if (val !== content.value) {
    setContent(val)
  }
})

watch(() => appStore.effectiveTheme, (theme) => {
  updateTheme(theme === 'dark')
})

watch(isFocused, (val) => {
  emit(val ? 'focus' : 'blur')
})

onMounted(() => {
  init()
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
  posAtCoords,
  selectAll,
  wordCount,
  charCount,
  lineCount
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
