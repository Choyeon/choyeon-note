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
          @click="submitNow(item)"
        >
          <Clock class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
          <span class="text-[13.5px] flex-1" :style="{ color: 'var(--color-text-secondary)' }">{{ item }}</span>
          <button
            class="flex items-center justify-center w-5 h-5 rounded-full cursor-pointer hover:bg-[var(--color-surface-hover)]"
            :style="{ color: 'var(--color-text-tertiary)' }"
            title="移除这条记录"
            @click.stop="removeRecent(item)"
          >
            <X class="w-3 h-3" />
          </button>
        </div>
        <div
          v-if="!recentSearches.length"
          class="px-6 py-1 text-[12px]"
          :style="{ color: 'var(--color-text-tertiary)' }"
        >
          还没有搜索记录
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
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { useAppStore } from '@/stores/app'
import { formatBinding } from '@/constants/shortcuts'
import { Search, FileText, SearchX, Clock, X, FilePlus, Settings, CalendarDays } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()
const appStore = useAppStore()

const RECENT_KEY = 'choyeon-recent-searches'
const RECENT_MAX = 8

const searchQuery = ref('')
/** 真正参与过滤的词（防抖后的），避免每敲一个字就全库扫一遍 */
const committedQuery = ref('')
const isFocused = ref(false)
const recentSearches = ref(loadRecent())

/**
 * 搜索完全在本视图内完成，不再写 noteStore.searchQuery。
 * 之前 searchQuery 存在全局 store 里且离开页面不清空，之后打开「全部笔记」
 * 列表会被一个看不见的关键词过滤，表现为"笔记凭空少了一半"。
 */
const filteredNotes = computed(() => {
  const q = committedQuery.value.trim().toLowerCase()
  if (!q) return []
  const list = noteStore.notes
  const result = []
  for (const note of list) {
    const title = (note.title || '').toLowerCase()
    const content = (note.content || '').toLowerCase()
    // 标题命中的排前面，符合直觉
    if (title.includes(q)) result.push({ note, score: 0 })
    else if (content.includes(q)) result.push({ note, score: 1 })
  }
  result.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    return new Date(b.note.updatedAt) - new Date(a.note.updatedAt)
  })
  return result.map(r => r.note)
})

function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(raw) ? raw.slice(0, RECENT_MAX) : []
  } catch (e) {
    return []
  }
}

function persistRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))) } catch (e) { /* ignore */ }
}

function pushRecent(term) {
  const t = String(term || '').trim()
  if (!t) return
  const next = [t, ...recentSearches.value.filter(x => x !== t)].slice(0, RECENT_MAX)
  recentSearches.value = next
  persistRecent(next)
}

function removeRecent(term) {
  recentSearches.value = recentSearches.value.filter(x => x !== term)
  persistRecent(recentSearches.value)
}

let searchTimer = null
function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    committedQuery.value = searchQuery.value
    if (searchQuery.value.trim().length >= 2) pushRecent(searchQuery.value)
  }, 180)
}

function clearSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchQuery.value = ''
  committedQuery.value = ''
}

/** 结果数少于预期时的兜底：立即提交一次（例如点了最近搜索项） */
function submitNow(term) {
  searchQuery.value = term
  if (searchTimer) clearTimeout(searchTimer)
  committedQuery.value = term
  pushRecent(term)
}

const quickActions = computed(() => [
  { label: '新建笔记', icon: FilePlus, shortcut: formatBinding(appStore.getBinding('app.newNote')), action: () => createNote() },
  { label: '设置', icon: Settings, shortcut: formatBinding(appStore.getBinding('app.settings')), action: () => router.push('/settings') },
  { label: '日历视图', icon: CalendarDays, shortcut: formatBinding(appStore.getBinding('view.calendar')), action: () => router.push('/calendar') }
])

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

function highlightMatch(text) {
  const raw = String(text || '')
  const q = committedQuery.value.trim()
  if (!q) return escapeHtml(raw)
  // 先在**未转义**的原文上按关键词切分，再逐段转义后拼 <mark>。
  // 之前先 escapeHtml 再对转义后的串跑正则，一旦关键词里含 & < > 就会错配。
  const idx = []
  const lowerRaw = raw.toLowerCase()
  const lowerQ = q.toLowerCase()
  let from = 0
  while (from <= lowerRaw.length) {
    const hit = lowerRaw.indexOf(lowerQ, from)
    if (hit === -1) break
    idx.push([hit, hit + q.length])
    from = hit + q.length
  }
  if (!idx.length) return escapeHtml(raw)

  let out = ''
  let cursor = 0
  for (const [start, end] of idx) {
    out += escapeHtml(raw.slice(cursor, start))
    out += `<mark class="search-mark">${escapeHtml(raw.slice(start, end))}</mark>`
    cursor = end
  }
  out += escapeHtml(raw.slice(cursor))
  return out
}

onMounted(() => {
  // 清掉历史遗留的全局搜索词，避免"全部笔记"列表被隐形过滤
  if (noteStore.searchQuery) noteStore.setSearchQuery('')
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  if (noteStore.searchQuery) noteStore.setSearchQuery('')
})
</script>

<style scoped>
/* 高亮匹配文字：使用主色调背景，避免突兀 */
:deep(.search-mark) {
  background: var(--color-primary-surface);
  color: var(--color-primary-dark);
  border-radius: 3px;
  padding: 1px 2px;
  font-weight: 600;
}

[data-theme='dark'] :deep(.search-mark) {
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
