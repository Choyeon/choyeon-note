<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-11 px-6 py-2 flex items-center gap-3 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        @click="$router.back()"
      >
        <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <span class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">
        阅读模式 · {{ currentNote?.title || '无标题' }}
      </span>
      <div class="flex-1"></div>
      <button 
        class="text-[13px] px-3 py-1 rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        :style="{ color: 'var(--color-primary)' }"
        @click="goToEditor"
      >
        编辑
      </button>
    </div>

    <div class="flex-1 min-w-0 overflow-y-auto no-scrollbar acrylic-content">
      <div class="max-w-[720px] mx-auto py-12 px-8 pb-20">
        <h1 
          class="text-3xl font-bold mb-8"
          :style="{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-title)' }"
        >
          {{ currentNote?.title || '无标题' }}
        </h1>
        <div class="markdown-body" v-html="renderedContent"></div>
      </div>
    </div>

    <div 
      class="min-h-7 px-6 py-1 flex items-center border-t"
      :style="{ 
        borderColor: 'var(--color-border-light)', 
        background: 'rgba(240,242,245,0.65)' 
      }"
    >
      <span class="text-[11px] whitespace-nowrap" :style="{ color: 'var(--color-text-primary)' }">
        {{ currentNote?.wordCount || 0 }} 字 · 阅读时间约 {{ readingTime }} 分钟
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { marked } from 'marked'
import { ArrowLeft } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()

const currentNote = computed(() => noteStore.currentNote)

const renderedContent = computed(() => {
  return marked.parse(currentNote.value?.content || '')
})

const readingTime = computed(() => {
  const words = currentNote.value?.wordCount || 0
  return Math.max(1, Math.ceil(words / 300))
})

function goToEditor() {
  if (currentNote.value) {
    router.push(`/editor/${currentNote.value.id}`)
  }
}

watch(() => route.params.id, (newId) => {
  if (newId) {
    noteStore.selectNote(newId)
  }
}, { immediate: true })

onMounted(() => {
  if (route.params.id) {
    noteStore.selectNote(route.params.id)
  }
})
</script>
