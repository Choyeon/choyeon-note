<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-11 px-6 py-2 flex items-center gap-3 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <span class="text-xs whitespace-nowrap" :style="{ color: 'var(--color-text-tertiary)' }">
        {{ currentNote?.folder || '根目录' }} <span class="mx-1">&gt;</span> {{ currentNote?.title || '无标题' }}
      </span>
      <div class="flex-1"></div>
      <div class="flex items-center gap-0.5">
        <button 
          v-for="tool in formatTools" 
          :key="tool.id"
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          @click="applyFormat(tool.id)"
        >
          <component :is="tool.icon" class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex overflow-hidden">
      <div class="flex-1 min-w-0 overflow-y-auto no-scrollbar acrylic-content" ref="editorContainer">
        <div class="max-w-[780px] mx-auto py-8 px-8 pb-16">
          <div v-if="editMode" class="editor-wrapper">
            <textarea
              ref="editorRef"
              v-model="content"
              class="w-full h-full outline-none resize-none bg-transparent font-sans"
              :style="{ 
                color: 'var(--color-text-primary)',
                fontSize: '14px',
                lineHeight: '1.7',
                minHeight: '500px'
              }"
              @input="onContentChange"
              spellcheck="false"
            ></textarea>
          </div>
          <div v-else class="markdown-body" v-html="renderedContent"></div>
        </div>
      </div>

      <aside 
        class="w-[280px] min-w-[280px] h-full acrylic-sidebar flex flex-col overflow-hidden border-l"
        :style="{ borderColor: 'var(--sidebar-border)' }"
      >
        <div 
          class="flex items-stretch h-10 min-h-10 border-b px-3"
          :style="{ borderColor: 'var(--color-border)' }"
        >
          <div 
            class="flex items-center px-1 mr-1 cursor-pointer border-b-2 transition-colors"
            :style="rightPanelTab === 'outline' ? { borderColor: 'var(--color-primary)', color: 'var(--color-primary)' } : { borderColor: 'transparent' }"
            @click="rightPanelTab = 'outline'"
          >
            <span class="text-[13px] font-medium whitespace-nowrap" :style="{ color: rightPanelTab === 'outline' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">大纲</span>
          </div>
          <div 
            class="flex items-center px-1 cursor-pointer border-b-2 transition-colors"
            :style="rightPanelTab === 'backlinks' ? { borderColor: 'var(--color-primary)' } : { borderColor: 'transparent' }"
            @click="rightPanelTab = 'backlinks'"
          >
            <span class="text-[13px] font-medium whitespace-nowrap" :style="{ color: rightPanelTab === 'backlinks' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">反向链接</span>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar p-2">
          <div v-if="rightPanelTab === 'outline'" class="flex flex-col gap-0.5">
            <div 
              v-for="(item, index) in outlineItems" 
              :key="index"
              class="outline-item flex items-center h-7 px-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
              :class="{ 'outline-item-active': index === 0 }"
              :style="{ paddingLeft: `${8 + (item.level - 1) * 12}px` }"
              @click="scrollToHeading(item)"
            >
              <span 
                class="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
                :style="{ 
                  fontWeight: item.level === 1 ? '600' : '500',
                  color: index === 0 ? 'var(--color-primary)' : 'var(--color-text-secondary)'
                }"
              >{{ item.text }}</span>
            </div>
          </div>
          <div v-else class="flex flex-col gap-0.5">
            <div class="text-[13px] px-2 py-2" :style="{ color: 'var(--color-text-tertiary)' }">
              暂无反向链接
            </div>
          </div>
        </div>
      </aside>
    </div>

    <div 
      class="min-h-7 px-6 py-1 flex items-center border-t"
      :style="{ 
        borderColor: 'var(--color-border-light)', 
        background: 'rgba(240,242,245,0.65)' 
      }"
    >
      <span class="text-[11px] whitespace-nowrap" :style="{ color: 'var(--color-text-primary)' }">
        {{ currentNote?.wordCount || 0 }} 字 &middot; {{ currentNote?.charCount || 0 }} 字符 &middot; {{ currentNote?.lineCount || 0 }} 行 &middot; 最后编辑: {{ formatDate(currentNote?.updatedAt) }}
      </span>
      <div class="flex-1"></div>
      <button 
        class="text-[11px] px-2 py-0.5 rounded cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        :style="{ color: 'var(--color-text-secondary)' }"
        @click="toggleEditMode"
      >
        {{ editMode ? '预览' : '编辑' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { marked } from 'marked'
import { 
  Bold, Italic, Code, Link, List, CheckSquare 
} from 'lucide-vue-next'

const route = useRoute()
const noteStore = useNoteStore()

const editMode = ref(true)
const rightPanelTab = ref('outline')
const content = ref('')
const editorRef = ref(null)
const editorContainer = ref(null)

const formatTools = [
  { id: 'bold', icon: Bold },
  { id: 'italic', icon: Italic },
  { id: 'code', icon: Code },
  { id: 'link', icon: Link },
  { id: 'list', icon: List },
  { id: 'todo', icon: CheckSquare }
]

const currentNote = computed(() => noteStore.currentNote)

const renderedContent = computed(() => {
  return marked.parse(content.value || '')
})

const outlineItems = computed(() => {
  const items = []
  const lines = content.value.split('\n')
  lines.forEach(line => {
    const match = line.match(/^(#{1,3})\s+(.+)$/)
    if (match) {
      items.push({
        level: match[1].length,
        text: match[2]
      })
    }
  })
  return items
})

function onContentChange() {
  if (currentNote.value) {
    noteStore.updateNoteContent(currentNote.value.id, content.value)
  }
}

function applyFormat(format) {
  const textarea = editorRef.value
  if (!textarea) return

  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selectedText = content.value.substring(start, end)
  let newText = ''
  let cursorOffset = 0

  switch (format) {
    case 'bold':
      newText = `**${selectedText || '粗体文本'}**`
      cursorOffset = selectedText ? 0 : 2
      break
    case 'italic':
      newText = `*${selectedText || '斜体文本'}*`
      cursorOffset = selectedText ? 0 : 1
      break
    case 'code':
      newText = `\`${selectedText || '代码'}\``
      cursorOffset = selectedText ? 0 : 1
      break
    case 'link':
      newText = `[${selectedText || '链接文本'}](url)`
      cursorOffset = selectedText ? 0 : 1
      break
    case 'list':
      newText = `- ${selectedText || '列表项'}`
      cursorOffset = selectedText ? 0 : 2
      break
    case 'todo':
      newText = `- [ ] ${selectedText || '待办事项'}`
      cursorOffset = selectedText ? 0 : 6
      break
  }

  content.value = content.value.substring(0, start) + newText + content.value.substring(end)
  
  nextTick(() => {
    textarea.focus()
    const pos = start + (selectedText ? newText.length : cursorOffset)
    textarea.setSelectionRange(pos, pos)
  })
  
  onContentChange()
}

function scrollToHeading(item) {
  const container = editorContainer.value
  if (!container) return

  if (editMode.value) {
    const lines = content.value.split('\n')
    let charIndex = 0
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(item.text)) {
        editorRef.value.scrollTop = (charIndex / content.value.length) * editorRef.value.scrollHeight
        break
      }
      charIndex += lines[i].length + 1
    }
  } else {
    const headings = container.querySelectorAll('h1, h2, h3')
    for (const h of headings) {
      if (h.textContent.includes(item.text)) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' })
        break
      }
    }
  }
}

function toggleEditMode() {
  editMode.value = !editMode.value
}

function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

watch(() => route.params.id, (newId) => {
  if (newId) {
    noteStore.selectNote(newId)
  }
}, { immediate: true })

watch(currentNote, (note) => {
  if (note) {
    content.value = note.content
  }
}, { immediate: true, deep: true })

onMounted(() => {
  if (currentNote.value) {
    content.value = currentNote.value.content
  }
})
</script>

<style scoped>
.outline-item-active {
  background: var(--color-primary-lightest);
}

.editor-wrapper textarea {
  font-family: var(--font-body);
}

:deep(.dark) .status-bar {
  background: rgba(26, 26, 46, 0.65);
}
</style>
