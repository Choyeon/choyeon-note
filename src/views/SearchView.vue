<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 顶部搜索框：胶囊式容器，聚焦时显示光环 -->
    <div
      class="px-6 pt-4 pb-3 acrylic-content border-b"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <div
        class="flex items-center gap-2.5 h-10 px-3.5 rounded-full transition-all duration-200"
        :style="{
          background: 'var(--color-bg-tertiary)',
          boxShadow: isFocused ? '0 0 0 3px var(--color-primary-ring)' : 'none'
        }"
      >
        <Search class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索笔记..."
          class="flex-1 bg-transparent outline-none text-[14px] min-w-0"
          :style="{ color: 'var(--color-text-primary)' }"
          @input="onSearch"
          @focus="isFocused = true"
          @blur="isFocused = false"
          autofocus
        />
        <button
          v-if="searchQuery"
          class="flex items-center justify-center w-5 h-5 rounded-full cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          :style="{ color: 'var(--color-text-tertiary)' }"
          title="清除搜索"
          @click="clearSearch"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar acrylic-content">
      <!-- 搜索结果列表 -->
      <div v-if="searchQuery && filteredNotes.length > 0" class="py-2 search-fade-in">
        <div class="px-6 py-2 flex items-center justify-between">
          <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">
            搜索结果
          </span>
          <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ filteredNotes.length }} 个
          </span>
        </div>
        <div
          v-for="note in filteredNotes"
          :key="note.id"
          class="flex items-center gap-3 mx-4 my-0.5 px-3 h-12 rounded-[10px] cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
          @click="openNote(note.id)"
        >
          <div
            class="w-7 h-7 rounded-[8px] flex items-center justify-center flex-shrink-0"
            :style="{ background: 'var(--color-primary-lightest)' }"
          >
            <FileText class="w-3.5 h-3.5" :style="{ color: 'var(--color-primary)' }" />
          </div>
          <div class="flex-1 min-w-0">
            <div
              class="text-[13.5px] font-medium truncate"
              :style="{ color: 'var(--color-text-primary)' }"
              v-html="highlightMatch(note.title)"
            ></div>
            <div
              class="text-[12px] truncate mt-0.5"
              :style="{ color: 'var(--color-text-tertiary)' }"
              v-html="highlightMatch(getPreview(note.content))"
            ></div>
          </div>
          <span
            class="text-[11px] flex-shrink-0 px-2 py-0.5 rounded-full"
            :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }"
          >
            {{ note.folder || '根目录' }}
          </span>
        </div>
      </div>

      <!-- 空状态：未找到结果 -->
      <div v-else-if="searchQuery" class="flex flex-col items-center justify-center h-full py-16 search-fade-in">
        <div
          class="w-14 h-14 rounded-full flex items-center justify-center mb-3"
          :style="{ background: 'var(--color-bg-tertiary)' }"
        >
          <SearchX class="w-6 h-6" :style="{ color: 'var(--color-text-tertiary)' }" />
        </div>
        <span class="text-[14px] font-medium" :style="{ color: 'var(--color-text-secondary)' }">未找到相关笔记</span>
        <span class="text-[12px] mt-1" :style="{ color: 'var(--color-text-tertiary)' }">尝试使用其他关键词</span>
      </div>

      <!-- 默认状态：最近搜索 + 快捷操作 -->
      <div v-else class="py-4 search-fade-in">
        <div class="px-6 py-2 flex items-center justify-between">
          <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">
            最近搜索
          </span>
          <span v-if="recentSearches.length" class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ recentSearches.length }}
          </span>
        </div>
        <div
          v-for="item in recentSearches"
          :key="item"
          class="flex items-center gap-3 mx-4 my-0.5 px-3 h-11 rounded-[10px] cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
          @click="searchQuery = item; onSearch()"
        >
          <Clock class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
          <span class="text-[13.5px] flex-1" :style="{ color: 'var(--color-text-secondary)' }">{{ item }}</span>
          <span class="text-[11px] font-mono" :style="{ color: 'var(--color-text-tertiary)' }">↵</span>
        </div>

        <div class="px-6 py-2 mt-3">
          <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">
            快捷操作
          </span>
        </div>
        <div
          v-for="action in quickActions"
          :key="action.label"
          class="flex items-center gap-3 mx-4 my-0.5 px-3 h-11 rounded-[10px] cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
          @click="action.action"
        >
          <div
            class="w-7 h-7 rounded-[8px] flex items-center justify-center flex-shrink-0"
            :style="{ background: 'var(--color-primary-lightest)' }"
          >
            <component :is="action.icon" class="w-3.5 h-3.5" :style="{ color: 'var(--color-primary)' }" />
          </div>
          <span class="text-[13.5px] flex-1" :style="{ color: 'var(--color-text-primary)' }">{{ action.label }}</span>
          <span
            class="text-[11px] font-mono px-2 py-0.5 rounded"
            :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }"
          >
            {{ action.shortcut }}
          </span>
        </div>
      </div>
    </div>

    <!-- 底部状态栏 -->
    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        {{ searchQuery ? `搜索: "${searchQuery}"` : '就绪' }}
      </span>
      <span class="cho-statusbar-meta">
        {{ searchQuery ? `${filteredNotes.length} 个结果` : 'Choyeon Note' }}
      </span>
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
const isFocused = ref(false)
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

// 转义 HTML，防止 XSS
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 高亮匹配的搜索关键词
function highlightMatch(text) {
  const safeText = escapeHtml(text || '')
  if (!searchQuery.value) return safeText
  // 转义正则特殊字符
  const safeQuery = escapeHtml(searchQuery.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!safeQuery) return safeText
  const regex = new RegExp(`(${safeQuery})`, 'gi')
  return safeText.replace(regex, '<mark class="search-mark">$1</mark>')
}
</script>

<style scoped>
/* 高亮匹配文字：使用主色调背景，避免突兀 */
:deep(.search-mark) {
  background: var(--color-primary-lighter);
  color: var(--color-primary-dark);
  border-radius: 3px;
  padding: 1px 2px;
  font-weight: 600;
}

.dark :deep(.search-mark) {
  color: var(--color-primary-light);
}

/* 内容切换时的微妙淡入动画 */
.search-fade-in {
  animation: searchFadeIn 0.22s var(--ease-out-quart);
}

@keyframes searchFadeIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
