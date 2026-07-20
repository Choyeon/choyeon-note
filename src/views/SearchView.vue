<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-[52px] px-6 py-2.5 flex items-center gap-3 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <Search class="w-5 h-5" :style="{ color: 'var(--color-text-tertiary)' }" />
      <input
        v-model="searchQuery"
        type="text"
        placeholder="搜索笔记..."
        class="flex-1 bg-transparent outline-none text-[15px]"
        :style="{ color: 'var(--color-text-primary)' }"
        @input="onSearch"
        autofocus
      />
      <button 
        v-if="searchQuery"
        class="text-[12px] px-2 py-1 rounded cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        :style="{ color: 'var(--color-text-tertiary)' }"
        @click="clearSearch"
      >清除</button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar acrylic-content">
      <div v-if="searchQuery && filteredNotes.length > 0" class="py-2">
        <div class="px-6 py-2">
          <span class="text-[12px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">
            找到 {{ filteredNotes.length }} 个结果
          </span>
        </div>
        <div 
          v-for="note in filteredNotes" 
          :key="note.id"
          class="flex items-center gap-3 h-12 px-6 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          @click="openNote(note.id)"
        >
          <FileText class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
          <div class="flex-1 min-w-0">
            <div class="text-[14px] font-medium truncate" :style="{ color: 'var(--color-text-primary)' }">
              {{ note.title }}
            </div>
            <div class="text-[12px] truncate" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ getPreview(note.content) }}
            </div>
          </div>
          <span class="text-[11px] flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ note.folder || '根目录' }}
          </span>
        </div>
      </div>

      <div v-else-if="searchQuery" class="flex flex-col items-center justify-center h-full py-16">
        <SearchX class="w-12 h-12 mb-4" :style="{ color: 'var(--color-text-tertiary)' }" />
        <span class="text-[14px]" :style="{ color: 'var(--color-text-tertiary)' }">未找到相关笔记</span>
      </div>

      <div v-else class="py-4">
        <div class="px-6 py-2">
          <span class="text-[12px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">
            最近搜索
          </span>
        </div>
        <div 
          v-for="item in recentSearches" 
          :key="item"
          class="flex items-center gap-3 h-11 px-6 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          @click="searchQuery = item; onSearch()"
        >
          <Clock class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
          <span class="text-[14px] flex-1" :style="{ color: 'var(--color-text-secondary)' }">{{ item }}</span>
          <X class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
        </div>

        <div class="px-6 py-2 mt-4">
          <span class="text-[12px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">
            快捷操作
          </span>
        </div>
        <div 
          v-for="action in quickActions" 
          :key="action.label"
          class="flex items-center gap-3 h-11 px-6 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          @click="action.action"
        >
          <component :is="action.icon" class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-primary)' }" />
          <span class="text-[14px] flex-1" :style="{ color: 'var(--color-text-primary)' }">{{ action.label }}</span>
          <span class="text-[11px] font-mono px-2 py-0.5 rounded" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }">
            {{ action.shortcut }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { Search, FileText, SearchX, Clock, X, FilePlus, Settings, CalendarDays } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const searchQuery = ref('')
const recentSearches = ['周报', 'API', 'Vue学习']

const filteredNotes = computed(() => {
  if (!searchQuery.value) return []
  return noteStore.filteredNotes
})

const quickActions = [
  { label: '新建笔记', icon: FilePlus, shortcut: 'Ctrl+N', action: () => createNote() },
  { label: '设置', icon: Settings, shortcut: 'Ctrl+,', action: () => router.push('/settings') },
  { label: '日历视图', icon: CalendarDays, shortcut: 'Ctrl+K', action: () => router.push('/calendar') }
]

function onSearch() {
  noteStore.setSearchQuery(searchQuery.value)
}

function clearSearch() {
  searchQuery.value = ''
  noteStore.setSearchQuery('')
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

function getPreview(content) {
  const text = content.replace(/[#*`\[\]\-]/g, '').replace(/\n/g, ' ').trim()
  return text.length > 60 ? text.substring(0, 60) + '...' : text
}

function createNote() {
  const note = noteStore.createNote('', '新笔记')
  router.push(`/editor/${note.id}`)
}
</script>
