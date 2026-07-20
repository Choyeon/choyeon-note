<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-[52px] px-6 py-2.5 flex items-center border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <span class="text-2xl font-bold" :style="{ color: 'var(--color-text-primary)' }">标签</span>
      <div class="flex-1"></div>
      <button 
        class="px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 text-[13px] font-medium text-white"
        :style="{ background: 'var(--color-primary)' }"
        @click="showCreateTag = true"
      >
        <Plus class="w-4 h-4 inline mr-1" />新建标签
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar acrylic-content p-6">
      <!-- 空状态提示 -->
      <div v-if="allTags.length === 0" class="flex flex-col items-center justify-center py-24">
        <div class="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" :style="{ background: 'var(--color-primary-lighter)' }">
          <Tag class="w-7 h-7" :style="{ color: 'var(--color-primary)' }" />
        </div>
        <p class="text-[14px] font-medium mb-1" :style="{ color: 'var(--color-text-secondary)' }">还没有标签</p>
        <p class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">在笔记中添加 #标签 即可在此查看</p>
      </div>

      <div v-else class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <div 
          v-for="tag in allTags" 
          :key="tag"
          class="tag-card acrylic-card p-4 cursor-pointer"
          @click="filterByTag(tag)"
        >
          <div class="flex items-center gap-2 mb-2">
            <Tag class="w-5 h-5" :style="{ color: 'var(--color-primary)' }" />
            <span class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">#{{ tag }}</span>
          </div>
          <div class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ getTagNoteCount(tag) }} 篇笔记
          </div>
        </div>
      </div>

      <div v-if="selectedTag" class="mt-8">
        <div class="flex items-center gap-2 mb-4">
          <button 
            class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] active:scale-95"
            @click="selectedTag = null"
          >
            <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
          <span class="text-xl font-semibold" :style="{ color: 'var(--color-text-primary)' }">
            #{{ selectedTag }}
          </span>
          <span class="text-[12px] ml-1" :style="{ color: 'var(--color-text-tertiary)' }">{{ filteredByTag.length }} 篇笔记</span>
        </div>

        <div class="acrylic-card overflow-hidden">
          <div 
            v-for="(note, idx) in filteredByTag" 
            :key="note.id"
            class="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :style="idx < filteredByTag.length - 1 ? { borderBottom: '1px solid var(--color-border-light)' } : {}"
            @click="openNote(note.id)"
          >
            <FileText class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
            <span class="text-[14px] font-medium flex-1" :style="{ color: 'var(--color-text-primary)' }">
              {{ note.title }}
            </span>
            <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ formatDate(note.updatedAt) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="cho-statusbar">
      <span class="cho-statusbar-meta">
        {{ allTags.length }} 个标签
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { Tag, Plus, ArrowLeft, FileText } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const selectedTag = ref(null)
const showCreateTag = ref(false)

const allTags = computed(() => noteStore.allTags)

const filteredByTag = computed(() => {
  if (!selectedTag.value) return []
  return noteStore.notes.filter(n => n.tags.includes(selectedTag.value))
})

function getTagNoteCount(tag) {
  return noteStore.notes.filter(n => n.tags.includes(tag)).length
}

function filterByTag(tag) {
  selectedTag.value = tag
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
</script>

<style scoped>
/* 标签卡片 - 统一阴影与微妙的悬停抬起动画 */
.tag-card {
  box-shadow: var(--shadow-xs);
  transition: transform var(--transition-smooth), box-shadow var(--transition-smooth);
}

.tag-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.tag-card:active {
  transform: translateY(0);
  box-shadow: var(--shadow-sm);
}
</style>
