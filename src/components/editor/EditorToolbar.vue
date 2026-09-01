<template>
  <div class="editor-toolbar">
    <template v-for="(item, index) in resolvedTools" :key="item.id || 'd' + index">
      <div v-if="item.type === 'divider'" class="editor-toolbar__divider"></div>

      <div v-else-if="item.type === 'spacer'" class="flex-1"></div>

      <button
        v-else
        class="editor-toolbar__btn"
        :class="{ 'is-active': item.active === true, 'is-disabled': item.disabled === true }"
        :title="tooltipOf(item)"
        :disabled="item.disabled === true"
        @click="onCommand(item)"
      >
        <component :is="item.icon" class="w-[17px] h-[17px]" />
      </button>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { formatBinding } from '@/constants/shortcuts'
import {
  Heading1, Heading2, Heading3, Heading4, Bold, Italic, Underline,
  Highlighter, Strikethrough, Code, Link2, Quote, List, ListOrdered,
  ListTodo, Minus, Table, Code2, Brackets, Undo2, Redo2,
  Indent, Outdent, Calendar, Clock
} from 'lucide-vue-next'

const props = defineProps({
  canUndo: { type: Boolean, default: false },
  canRedo: { type: Boolean, default: false },
  /** 当前光标所在块的类型，用于高亮工具栏按钮 */
  activeFormats: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['command'])

const appStore = useAppStore()

/**
 * 工具栏定义只保留「命令 id + 图标 + 文案」，
 * 键位由快捷键注册表实时渲染 —— 用户改了设置，tooltip 跟着变，
 * 不会出现「按钮写着 Ctrl+B 实际是别的键」的错位。
 */
const tools = [
  { id: 'edit.undo', icon: Undo2, label: '撤销', disabled: !props.canUndo },
  { id: 'edit.redo', icon: Redo2, label: '重做', disabled: !props.canRedo },
  { type: 'divider' },
  { id: 'format.h1', icon: Heading1, label: '一级标题' },
  { id: 'format.h2', icon: Heading2, label: '二级标题' },
  { id: 'format.h3', icon: Heading3, label: '三级标题' },
  { id: 'format.h4', icon: Heading4, label: '四级标题' },
  { type: 'divider' },
  { id: 'format.bold', icon: Bold, label: '加粗' },
  { id: 'format.italic', icon: Italic, label: '斜体' },
  { id: 'format.underline', icon: Underline, label: '下划线' },
  { id: 'format.highlight', icon: Highlighter, label: '高亮' },
  { id: 'format.strikethrough', icon: Strikethrough, label: '删除线' },
  { id: 'format.code', icon: Code, label: '行内代码' },
  { id: 'format.link', icon: Link2, label: '链接' },
  { type: 'divider' },
  { id: 'format.quote', icon: Quote, label: '引用' },
  { id: 'format.bulletList', icon: List, label: '无序列表' },
  { id: 'format.orderedList', icon: ListOrdered, label: '有序列表' },
  { id: 'format.taskList', icon: ListTodo, label: '待办列表' },
  { type: 'divider' },
  { id: 'edit.indent', icon: Indent, label: '增加缩进' },
  { id: 'edit.outdent', icon: Outdent, label: '减少缩进' },
  { type: 'divider' },
  { id: 'insert.table', icon: Table, label: '插入表格' },
  { id: 'insert.codeBlock', icon: Code2, label: '代码块' },
  { id: 'insert.wikiLink', icon: Brackets, label: '双链' },
  { id: 'insert.divider', icon: Minus, label: '分隔线' },
  { id: 'insert.date', icon: Calendar, label: '插入日期' },
  { id: 'insert.time', icon: Clock, label: '插入时间' }
]

const activeTools = computed(() =>
  tools.map((t) => {
    if (!t.id) return t
    const stateKey = t.id.replace(/^format\./, '')
    return { ...t, active: !!props.activeFormats[stateKey] }
  })
)

const resolvedTools = computed(() => {
  // undo/redo 的禁用状态随撤销栈实时变化
  return activeTools.value.map((t) => {
    if (t.id === 'edit.undo') return { ...t, disabled: !props.canUndo }
    if (t.id === 'edit.redo') return { ...t, disabled: !props.canRedo }
    return t
  })
})

function tooltipOf(item) {
  const binding = appStore.getBinding(item.id)
  const keys = binding ? formatBinding(binding) : ''
  return keys ? `${item.label}  ${keys}` : item.label
}

function onCommand(item) {
  if (item.disabled) return
  emit('command', item.id)
}
</script>

<script>
export default { name: 'EditorToolbar' }
</script>

<style scoped>
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-wrap: wrap;
}

.editor-toolbar__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  transition: background 0.12s ease, color 0.12s ease;
}

.editor-toolbar__btn:hover:not(.is-disabled) {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.editor-toolbar__btn.is-active {
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.editor-toolbar__btn.is-disabled {
  opacity: 0.35;
  cursor: default;
}

.editor-toolbar__divider {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--color-border);
  flex-shrink: 0;
}
</style>
