<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 顶部工具栏：圆角按钮，无黑边框 -->
    <div
      class="min-h-11 px-5 py-2 flex items-center gap-2 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <button
        class="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
        title="返回"
        @click="goBack"
      >
        <ArrowLeft class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <div class="flex items-center gap-1.5 min-w-0 px-1">
        <span class="text-[12px] whitespace-nowrap truncate" :style="{ color: 'var(--color-text-tertiary)' }">
          {{ currentNote?.folder || '根目录' }}
        </span>
        <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">/</span>
        <span class="text-[12px] whitespace-nowrap truncate font-medium" :style="{ color: 'var(--color-text-secondary)' }">
          {{ currentNote?.title || '无标题' }}
        </span>
      </div>
      <div class="flex-1"></div>
      <button
        class="h-8 px-3 rounded-[10px] flex items-center gap-1.5 cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
        title="编辑"
        @click="goToEditor"
      >
        <Edit3 class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
        <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-secondary)' }">编辑</span>
      </button>
    </div>

    <!-- 阅读内容区 -->
    <div class="flex-1 min-w-0 overflow-y-auto cho-scrollbar acrylic-content">
      <div class="max-w-[720px] mx-auto py-14 px-8 pb-24">
        <article class="prose prose-custom reading-fade-in">
          <header class="mb-10">
            <h1
              class="text-[28px] font-bold mb-3 leading-tight"
              :style="{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-title)', letterSpacing: '-0.01em' }"
            >
              {{ currentNote?.title || '无标题' }}
            </h1>
            <div class="flex items-center gap-2.5 text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">
              <span>{{ formatDate(currentNote?.createdAt) }}</span>
              <span class="opacity-50">·</span>
              <span>{{ currentNote?.wordCount || 0 }} 字</span>
              <span class="opacity-50">·</span>
              <span>阅读约 {{ readingTime }} 分钟</span>
            </div>
          </header>

          <div class="markdown-body" v-html="renderedContent"></div>
        </article>
      </div>
    </div>

    <!-- 底部状态栏 -->
    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        {{ currentNote?.wordCount || 0 }} 字 · {{ currentNote?.charCount || 0 }} 字符 · {{ currentNote?.lineCount || 0 }} 行
      </span>
      <span class="cho-statusbar-meta">
        阅读模式
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { marked } from 'marked'
import { ArrowLeft, Edit3 } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()

marked.setOptions({
  breaks: true,
  gfm: true
})

const currentNote = computed(() => noteStore.currentNote)

const renderedContent = computed(() => {
  return marked.parse(currentNote.value?.content || '')
})

const readingTime = computed(() => {
  const words = currentNote.value?.wordCount || 0
  return Math.max(1, Math.ceil(words / 300))
})

function goBack() {
  router.push('/notes')
}

function goToEditor() {
  if (currentNote.value) {
    router.push(`/editor/${currentNote.value.id}`)
  }
}

function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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

<style scoped>
.prose-custom {
  max-width: none;
  font-family: var(--font-body);
  font-size: 15px;
  color: var(--color-text-primary);
  line-height: 1.8;
}

/* 标题：层级清晰，间距统一 */
.prose-custom :deep(h2) {
  font-family: var(--font-title);
  font-size: 1.5rem;
  font-weight: 600;
  margin-top: 2.5rem;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--color-border-light);
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.prose-custom :deep(h3) {
  font-family: var(--font-title);
  font-size: 1.25rem;
  font-weight: 600;
  margin-top: 1.75rem;
  margin-bottom: 0.75rem;
  color: var(--color-text-primary);
  letter-spacing: -0.005em;
}

.prose-custom :deep(h4),
.prose-custom :deep(h5),
.prose-custom :deep(h6) {
  font-family: var(--font-title);
  font-size: 1.05rem;
  font-weight: 600;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  color: var(--color-text-primary);
}

/* 正文段落：舒适的行高与字色 */
.prose-custom :deep(p) {
  margin-bottom: 1.25rem;
  line-height: 1.85;
  color: var(--color-text-primary);
}

.prose-custom :deep(ul),
.prose-custom :deep(ol) {
  margin-bottom: 1.25rem;
  padding-left: 1.5rem;
}

.prose-custom :deep(li) {
  margin-bottom: 0.5rem;
  line-height: 1.75;
  color: var(--color-text-primary);
}

.prose-custom :deep(li > p) {
  margin-bottom: 0.5rem;
}

/* 引用块：柔和主色调背景 */
.prose-custom :deep(blockquote) {
  margin: 1.5rem 0;
  padding: 1rem 1.25rem;
  border-left: 3px solid var(--color-primary);
  background: var(--color-primary-surface);
  border-radius: 0 var(--cho-radius-sm) var(--cho-radius-sm) 0;
}

.prose-custom :deep(blockquote p) {
  margin-bottom: 0;
  color: var(--color-text-secondary);
  font-style: italic;
}

/* 行内代码：圆角小标签 */
.prose-custom :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  background: var(--color-bg-tertiary);
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
  color: var(--color-text-primary);
}

/* 代码块：圆角容器 */
.prose-custom :deep(pre) {
  margin: 1.5rem 0;
  padding: 1rem 1.25rem;
  background: var(--color-bg-tertiary);
  border-radius: var(--cho-radius-md);
  overflow-x: auto;
}

.prose-custom :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.85rem;
  line-height: 1.65;
  color: var(--color-text-primary);
}

/* 链接：主色调，悬停下划线 */
.prose-custom :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color var(--transition-smooth);
}

.prose-custom :deep(a:hover) {
  border-bottom-color: var(--color-primary);
}

/* 图片：圆角 */
.prose-custom :deep(img) {
  max-width: 100%;
  border-radius: var(--cho-radius-md);
  margin: 1.5rem 0;
}

/* 分隔线 */
.prose-custom :deep(hr) {
  margin: 2.5rem 0;
  border: none;
  border-top: 1px solid var(--color-border-light);
}

/* 表格：简洁分隔线 */
.prose-custom :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1.5rem 0;
  font-size: 0.9rem;
}

.prose-custom :deep(th) {
  text-align: left;
  padding: 0.6rem 0.875rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
}

.prose-custom :deep(td) {
  padding: 0.6rem 0.875rem;
  border-bottom: 1px solid var(--color-border-light);
  color: var(--color-text-primary);
}

.prose-custom :deep(tr:hover td) {
  background: var(--color-surface-hover);
}

.prose-custom :deep(strong) {
  font-weight: 600;
  color: var(--color-text-primary);
}

.prose-custom :deep(em) {
  font-style: italic;
}

/* 阅读内容淡入动画 */
.reading-fade-in {
  animation: readingFadeIn 0.28s var(--ease-out-quart);
}

@keyframes readingFadeIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
