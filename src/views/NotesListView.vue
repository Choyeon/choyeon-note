<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-[52px] px-6 py-2.5 flex items-center border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <span class="text-[20px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">全部笔记</span>
      <div class="flex-1"></div>
      
      <!-- 视图切换：列表/卡片 -->
      <div 
        class="flex items-center gap-0.5 rounded-[var(--cho-radius-md)] p-0.5 mr-3"
        :style="{ background: 'var(--color-bg-tertiary)' }"
      >
        <button 
          class="flex items-center gap-1 px-3 py-1 rounded-[var(--cho-radius-sm)] cursor-pointer transition-colors"
          :style="viewMode === 'list' ? { background: 'var(--color-surface)', boxShadow: 'var(--shadow-xs)' } : {}"
          @click="setViewMode('list')"
        >
          <List class="w-3.5 h-3.5" :style="{ color: viewMode === 'list' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" />
          <span class="text-[13px] font-medium" :style="{ color: viewMode === 'list' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">列表</span>
        </button>
        <button 
          class="flex items-center gap-1 px-3 py-1 rounded-[var(--cho-radius-sm)] cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          @click="setViewMode('card')"
        >
          <LayoutGrid class="w-3.5 h-3.5" :style="{ color: viewMode === 'card' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" />
          <span class="text-[13px] font-medium" :style="{ color: viewMode === 'card' ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">卡片</span>
        </button>
      </div>

      <!-- 排序选择器：移除深色边框，使用 border-light -->
      <div 
        class="flex items-center gap-1.5 h-8 px-3 rounded-[var(--cho-radius-md)] cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        :style="{ border: '1px solid var(--color-border-light)' }"
      >
        <span class="text-[13px] whitespace-nowrap" :style="{ color: 'var(--color-text-secondary)' }">
          {{ sortLabel }}
        </span>
        <ChevronDown class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar acrylic-content">
      <template v-if="viewMode === 'list'">
        <!-- 列表表头 -->
        <div 
          class="flex items-center h-10 px-6 border-b"
          :style="{ background: 'var(--color-bg-tertiary)', borderColor: 'var(--color-border-light)' }"
        >
          <div class="w-10 flex items-center justify-center">
            <div 
              class="w-5 h-5 rounded-full"
              :style="{ border: '2px solid var(--color-border)' }"
            ></div>
          </div>
          <div class="flex-1 flex items-center pl-3">
            <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">标题</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">标签</span>
          </div>
          <div class="w-[120px] flex items-center justify-center">
            <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">修改时间</span>
          </div>
          <div class="w-[100px] flex items-center justify-center">
            <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">文件夹</span>
          </div>
        </div>

        <!-- 笔记列表项：hover 仅改变背景色，无移动或缩放 -->
        <div 
          v-for="note in filteredNotes" 
          :key="note.id"
          class="flex items-center h-[52px] px-6 border-b cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          :style="{ borderColor: 'var(--color-border-light)', transitionProperty: 'background-color' }"
          @click="openNote(note.id)"
        >
          <div class="w-10 flex items-center justify-center">
            <div 
              class="w-5 h-5 rounded-full cursor-pointer"
              :style="{ border: '2px solid var(--color-border)' }"
            ></div>
          </div>
          <div class="flex-1 flex items-center pl-3 min-w-0">
            <span 
              class="text-[14px] font-medium whitespace-nowrap overflow-hidden text-ellipsis"
              :style="{ color: 'var(--color-text-primary)' }"
            >{{ note.title }}.md</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span 
              v-for="tag in note.tags.slice(0, 2)" 
              :key="tag"
              class="rounded-full px-2 py-px text-[11px]"
              :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
            >#{{ tag }}</span>
          </div>
          <div class="w-[120px] flex items-center justify-center">
            <span class="text-[12px] whitespace-nowrap" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ formatDate(note.updatedAt) }}
            </span>
          </div>
          <div class="w-[100px] flex items-center justify-center">
            <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ note.folder || '(root)' }}
            </span>
          </div>
        </div>
      </template>

      <template v-else>
        <!-- 卡片视图：使用统一栅格和间距 -->
        <div class="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <!-- 笔记卡片：hover 仅改变背景色，无位移或缩放 -->
          <div 
            v-for="note in filteredNotes" 
            :key="note.id"
            class="acrylic-card p-4 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :style="{ boxShadow: 'var(--shadow-xs)', transitionProperty: 'background-color' }"
            @click="openNote(note.id)"
          >
            <div class="flex items-start gap-3 mb-2">
              <FileText class="w-5 h-5 flex-shrink-0 mt-0.5" :style="{ color: 'var(--color-primary)' }" />
              <div class="flex-1 min-w-0">
                <h3 
                  class="text-[15px] font-semibold truncate"
                  :style="{ color: 'var(--color-text-primary)' }"
                >{{ note.title }}</h3>
                <p class="text-[12px] mt-1" :style="{ color: 'var(--color-text-tertiary)' }">
                  {{ note.folder || '根目录' }}
                </p>
              </div>
            </div>
            <p 
              class="text-[13px] line-clamp-2 mt-2 leading-relaxed"
              :style="{ color: 'var(--color-text-secondary)' }"
            >{{ getPreview(note.content) }}</p>
            <div class="flex items-center justify-between mt-3 pt-3 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
              <div class="flex items-center gap-1">
                <span 
                  v-for="tag in note.tags.slice(0, 2)" 
                  :key="tag"
                  class="rounded-full px-2 py-px text-[11px]"
                  :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
                >#{{ tag }}</span>
              </div>
              <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">
                {{ formatDate(note.updatedAt) }}
              </span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div 
      class="min-h-10 flex items-center justify-center border-t"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">
        显示 1-{{ filteredNotes.length }} / {{ filteredNotes.length }} 条
      </span>
    </div>

    <!-- 底部状态栏：统一毛玻璃效果 -->
    <div class="cho-statusbar">
      <span class="cho-statusbar-meta">
        {{ filteredNotes.length }} 篇笔记 · {{ folders.length }} 个文件夹
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { List, LayoutGrid, ChevronDown, FileText } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const filteredNotes = computed(() => noteStore.filteredNotes)
const viewMode = computed(() => noteStore.viewMode)
const folders = computed(() => noteStore.folders)

const sortLabel = computed(() => {
  const sortMap = {
    updated: '最近修改',
    created: '创建时间',
    title: '标题'
  }
  return sortMap[noteStore.sortBy] || '最近修改'
})

function setViewMode(mode) {
  noteStore.setViewMode(mode)
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
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

function getPreview(content) {
  const text = content.replace(/[#*`\[\]\-]/g, '').replace(/\n/g, ' ').trim()
  return text.length > 100 ? text.substring(0, 100) + '...' : text
}
</script>
