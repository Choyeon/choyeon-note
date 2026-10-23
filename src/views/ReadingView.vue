<template>
  <div class="h-full flex flex-col overflow-hidden editor-page-wrapper">
    <!-- 顶部工具栏：圆角按钮，无黑边框 -->
    <div
      class="min-h-11 px-5 py-2 flex items-center gap-2 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <button
        class="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
        title="返回（Esc）"
        aria-label="返回"
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

      <!-- 字号：阅读视图改的是全局 editorZoom，与编辑器三模式同一基准，来回切换不跳字号 -->
      <div class="flex items-center gap-0.5 px-1">
        <button
          class="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          title="缩小字号"
          aria-label="缩小字号"
          :disabled="!canZoomOut"
          @click="zoomBy(-10)"
        >
          <ZoomOut class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <span class="text-[11px] tabular-nums w-9 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
          {{ appStore.editorZoom }}%
        </span>
        <button
          class="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          title="放大字号"
          aria-label="放大字号"
          :disabled="!canZoomIn"
          @click="zoomBy(10)"
        >
          <ZoomIn class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
      </div>

      <button
        v-if="outline.length"
        class="w-8 h-8 rounded-[10px] flex items-center justify-center cursor-pointer transition-colors duration-150"
        :class="outlineOpen ? 'bg-[var(--color-primary-surface)]' : 'hover:bg-[var(--color-surface-hover)]'"
        title="目录（T）"
        aria-label="目录"
        :aria-pressed="String(outlineOpen)"
        @click="outlineOpen = !outlineOpen"
      >
        <List class="w-4 h-4" :style="{ color: outlineOpen ? 'var(--color-primary)' : 'var(--color-text-secondary)' }" />
      </button>
      <button
        class="h-8 px-3 rounded-[10px] flex items-center gap-1.5 cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
        title="编辑"
        @click="goToEditor"
      >
        <Edit3 class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
        <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-secondary)' }">编辑</span>
      </button>

      <!-- 阅读进度条：贴着工具栏下沿，宽度 = 已读比例 -->
      <div class="reading-progress" :style="{ width: `${progress}%`, opacity: progress > 0 ? 1 : 0 }"></div>
    </div>

    <!-- 笔记不存在 / 已被删除 -->
    <div
      v-if="noteMissing"
      class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 acrylic-content"
    >
      <FileQuestion class="w-10 h-10" :style="{ color: 'var(--color-text-tertiary)' }" />
      <p class="text-[14px]" :style="{ color: 'var(--color-text-secondary)' }">
        这篇笔记不存在或已被删除
      </p>
      <button
        class="h-8 px-3 rounded-[10px] text-[12px] cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
        :style="{ color: 'var(--color-primary)', border: '1px solid var(--color-border)' }"
        @click="router.push('/notes')"
      >
        返回笔记列表
      </button>
    </div>

    <!-- 一篇笔记都没有：与「笔记不存在」是两件事，别混成同一句空话 -->
    <div
      v-else-if="!currentNote"
      class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 acrylic-content"
    >
      <FileText class="w-10 h-10" :style="{ color: 'var(--color-text-tertiary)' }" />
      <p class="text-[14px]" :style="{ color: 'var(--color-text-secondary)' }">还没有可阅读的笔记</p>
      <button
        class="h-8 px-3 rounded-[10px] text-[12px] cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
        :style="{ color: 'var(--color-primary)', border: '1px solid var(--color-border)' }"
        @click="router.push('/notes')"
      >
        去新建一篇
      </button>
    </div>

    <div v-else class="flex-1 min-h-0 flex">
      <div
        ref="scrollRef"
        class="flex-1 min-w-0 overflow-y-auto cho-scrollbar acrylic-content reading-content"
        @scroll.passive="onScroll"
      >
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
                <span>{{ formatDate(currentNote?.createdAt, 'date') }}</span>
                <span class="opacity-50">·</span>
                <span>{{ stats.words || 0 }} 字</span>
                <span class="opacity-50">·</span>
                <span>阅读约 {{ readingTime }} 分钟</span>
                <template v-if="currentNote?.tags?.length">
                  <span class="opacity-50">·</span>
                  <span class="truncate">#{{ currentNote.tags.join(' #') }}</span>
                </template>
              </div>
            </header>

            <div ref="contentRef" class="markdown-body" v-html="renderedContent"></div>

            <!-- 上一篇 / 下一篇：按列表当前排序走，顺序与用户在列表里看到的一致 -->
            <nav class="reading-nav">
              <button
                v-if="prevNote"
                class="reading-nav-item"
                @click="openNote(prevNote)"
              >
                <span class="reading-nav-label">
                  <ChevronLeft class="w-3.5 h-3.5" />
                  上一篇
                </span>
                <span class="reading-nav-title">{{ prevNote.title || '无标题' }}</span>
              </button>
              <span v-else class="reading-nav-placeholder"></span>
              <button
                v-if="nextNote"
                class="reading-nav-item reading-nav-next"
                @click="openNote(nextNote)"
              >
                <span class="reading-nav-label">
                  下一篇
                  <ChevronRight class="w-3.5 h-3.5" />
                </span>
                <span class="reading-nav-title">{{ nextNote.title || '无标题' }}</span>
              </button>
            </nav>
          </article>
        </div>
      </div>

      <!-- 目录：不是装饰，长文里是唯一能定位的入口 -->
      <aside v-if="outlineOpen && outline.length" class="reading-outline cho-scrollbar">
        <div class="reading-outline-title">目录</div>
        <button
          v-for="item in outline"
          :key="item.id"
          class="reading-outline-item"
          :class="[`reading-outline-level-${item.level}`, { 'is-active': item.id === activeHeadingId }]"
          :title="item.text"
          @click="scrollToHeading(item.id)"
        >
          {{ item.text }}
        </button>
      </aside>
    </div>

    <!-- 底部状态栏 -->
    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        {{ stats.words || 0 }} 字 · {{ stats.chars || 0 }} 字符 · {{ stats.lines || 0 }} 行
      </span>
      <span class="cho-statusbar-meta">
        阅读模式<template v-if="progress > 0"> · 已读 {{ progress }}%</template>
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { useAppStore } from '@/stores/app'
import { renderMarkdown, renderMermaidInContainer } from '@/utils/markdown'
import { computeTextStats, estimateReadingMinutes } from '@/utils/textStats'
import { formatDate } from '@/utils/format'
import {
  ArrowLeft, Edit3, FileQuestion, FileText,
  List, ZoomIn, ZoomOut, ChevronLeft, ChevronRight
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()
const appStore = useAppStore()

const scrollRef = ref(null)
const contentRef = ref(null)

const routeId = computed(() => String(route.params.id || ''))
/**
 * 直接用 noteStore.currentNote 会在 id 失效时静默显示上一篇笔记，
 * 用户以为在读 A，实际上在读 B。这里按路由 id 精确取，取不到就是「不存在」。
 */
const currentNote = computed(() =>
  noteStore.notes.find(n => n.id === routeId.value) || null
)
const noteMissing = computed(() => !!routeId.value && !currentNote.value)

const renderedContent = computed(() => {
  const content = currentNote.value?.content || ''
  // 必须传 resolveTarget：否则所有 [[双链]] 都被渲染成"未创建"的红色未解析态，
  // 点击 ![[嵌入]] 还会顺手新建一个空笔记
  return renderMarkdown(content, { resolveTarget: noteStore.resolveWikiForRender })
})

const stats = computed(() => computeTextStats(currentNote.value?.content || ''))
const readingTime = computed(() => estimateReadingMinutes(stats.value.words))

// ---------------------------------------------------------------------------
// 目录（TOC）：从渲染后的标题提取，点击滚动 + 滚动高亮
// ---------------------------------------------------------------------------

const outline = ref([])
const outlineOpen = ref(false)
const activeHeadingId = ref('')
const progress = ref(0)

/**
 * 目录的默认展开只做一次。
 * 用户手动收起后，切到下一篇不该又把它弹开 —— 那是「我的操作被覆盖了」。
 */
let wasAutoOpened = false

/** 只有 h2/h3 进目录：h1 就是标题本身，更深的层级在目录里只会变成噪音 */
function collectOutline() {
  if (!contentRef.value) {
    outline.value = []
    return
  }
  const nodes = [...contentRef.value.querySelectorAll('h2, h3')]
  const items = nodes.map((el, index) => {
    // id 必须打在真实 DOM 上：锚点跳转靠它，重渲染后重新编号也不会撞车
    const id = `reading-h-${index}`
    el.setAttribute('id', id)
    return {
      id,
      level: el.tagName.toLowerCase() === 'h2' ? 2 : 3,
      text: (el.textContent || '').trim() || `标题 ${index + 1}`
    }
  })
  outline.value = items
  // 有目录才默认展开：没有目录时留一个空面板比没有按钮更让人困惑
  if (items.length && outlineOpen.value === false && wasAutoOpened === false) {
    outlineOpen.value = true
    wasAutoOpened = true
  }
}

function scrollToHeading(id) {
  const el = contentRef.value?.querySelector(`#${id}`)
  if (!el || !scrollRef.value) return
  // 标题上方留一点呼吸位，否则滚过去正好被工具栏压住
  const offset = el.offsetTop - 16
  scrollRef.value.scrollTo({ top: offset, behavior: 'smooth' })
}

// 滚动是高频事件：只记录最新一次，真正计算放到 rAF 里，一帧最多算一次
let scrollFrame = 0
function onScroll() {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    updateScrollState()
  })
}

function updateScrollState() {
  const box = scrollRef.value
  if (!box) return
  const max = box.scrollHeight - box.clientHeight
  // 短文档（max<=0）不该显示 0% 之外的值，除零会得到 NaN
  progress.value = max > 0 ? Math.min(100, Math.round((box.scrollTop / max) * 100)) : 0

  const nodes = outline.value
  if (!nodes.length) {
    activeHeadingId.value = ''
    return
  }
  const line = box.scrollTop + 120
  let current = nodes[0].id
  for (const item of nodes) {
    const el = contentRef.value?.querySelector(`#${item.id}`)
    if (!el) continue
    if (el.offsetTop <= line) current = item.id
    else break
  }
  activeHeadingId.value = current
}

// ---------------------------------------------------------------------------
// 字号：走全局 editorZoom（与编辑器三模式同一基准）
// ---------------------------------------------------------------------------

const canZoomOut = computed(() => Number(appStore.editorZoom) > 50)
const canZoomIn = computed(() => Number(appStore.editorZoom) < 200)

function zoomBy(delta) {
  appStore.setEditorZoom(Number(appStore.editorZoom) + delta)
}

// ---------------------------------------------------------------------------
// 上一篇 / 下一篇
// ---------------------------------------------------------------------------

/**
 * 导航顺序取 filteredNotes（列表当前排序 + 搜索过滤），
 * 与用户在列表里看到的顺序一致；当前笔记被过滤掉时退回全量 notes，
 * 否则「从搜索结果点进来」会没有上一篇/下一篇。
 */
const orderedNotes = computed(() => {
  const filtered = noteStore.filteredNotes
  const list = Array.isArray(filtered) && filtered.length ? filtered : noteStore.notes
  return Array.isArray(list) ? list : []
})

const currentIndex = computed(() => orderedNotes.value.findIndex(n => n && n.id === routeId.value))
const prevNote = computed(() => (currentIndex.value > 0 ? orderedNotes.value[currentIndex.value - 1] : null))
const nextNote = computed(() => {
  const i = currentIndex.value
  return i >= 0 && i < orderedNotes.value.length - 1 ? orderedNotes.value[i + 1] : null
})

function openNote(note) {
  if (note && note.id) router.push(`/reading/${note.id}`)
}

// ---------------------------------------------------------------------------
// 渲染 / 路由
// ---------------------------------------------------------------------------

async function renderContent() {
  await nextTick()
  if (contentRef.value) {
    renderMermaidInContainer(contentRef.value)
  }
  collectOutline()
  updateScrollState()
}

/**
 * 路由 id → store 选中态的唯一入口。
 * onMounted 与 watch 以前各写一份同样的兜底逻辑，改动必然只落到其中一处；
 * 收成一个函数，两条路径行为一致。
 */
function syncRouteNote() {
  const id = route.params.id
  if (id) {
    noteStore.selectNote(id)
    return
  }
  const firstNote = noteStore.notes && noteStore.notes.length ? noteStore.notes[0] : null
  if (firstNote && firstNote.id) {
    noteStore.selectNote(firstNote.id)
    router.replace(`/reading/${firstNote.id}`)
  }
}

function goBack() {
  router.push('/notes')
}

function goToEditor() {
  if (currentNote.value) {
    router.push(`/editor/${currentNote.value.id}`)
  }
}

/**
 * 阅读视图自己的键位。
 * 只处理「焦点不在输入控件里且没有修饰键」的裸按键：带修饰键的组合全部让给
 * App.vue 的全局注册中心，否则 Ctrl+[ 这类会被这里抢走。
 */
function onReadingKeydown(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
  const target = e.target
  const tag = target && target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return

  if (e.key === 'Escape') {
    e.preventDefault()
    goBack()
    return
  }
  if (e.key === 't' || e.key === 'T') {
    if (!outline.value.length) return
    e.preventDefault()
    outlineOpen.value = !outlineOpen.value
    return
  }
  if (e.key === '[') {
    if (!prevNote.value) return
    e.preventDefault()
    openNote(prevNote.value)
    return
  }
  if (e.key === ']') {
    if (!nextNote.value) return
    e.preventDefault()
    openNote(nextNote.value)
  }
}

watch(() => route.params.id, () => {
  syncRouteNote()
  // 换笔记必须回到顶部：沿用上一篇的滚动位置 = 打开就像读了一半
  if (scrollRef.value) scrollRef.value.scrollTop = 0
  progress.value = 0
  renderContent()
})

watch(renderedContent, () => {
  renderContent()
})

onMounted(() => {
  syncRouteNote()
  renderContent()
  window.addEventListener('keydown', onReadingKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onReadingKeydown)
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame)
    scrollFrame = 0
  }
})
</script>

<style scoped>
.editor-page-wrapper {
  position: relative;
}

.editor-page-wrapper::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--content-bg);
  backdrop-filter: blur(var(--content-blur)) saturate(var(--content-saturate));
  -webkit-backdrop-filter: blur(var(--content-blur)) saturate(var(--content-saturate));
  z-index: 0;
  pointer-events: none;
}

/* 阅读区用实心底色：长文阅读时不受壁纸/毛玻璃干扰，对比度更稳。
   关键：必须去掉 backdrop-filter —— Electron 透明窗口（.electron-mode）下，
   半透明 + backdrop 的层会被系统亚克力"穿透采样"糊化，正文看起来像蒙了雾。
   实底 + 无模糊 + 提层（z-index 压过 ::before 雾化层）后文字直接画在纸面上。 */
.reading-content {
  position: relative;
  z-index: 1;
  background: var(--reading-bg) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  scroll-behavior: smooth;
}

.editor-page-wrapper::before {
  background: var(--reading-bg);
}

/* 阅读进度条：挂在工具栏底边，1px 高，不抢内容空间 */
.reading-progress {
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 0 2px 2px 0;
  transition: width 0.12s linear, opacity 0.2s ease;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .reading-content {
    scroll-behavior: auto;
  }
  .reading-progress {
    transition: none;
  }
}

/* ---- 目录 ---- */
.reading-outline {
  width: 232px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 14px 12px 24px;
  border-left: 1px solid var(--color-border-light);
  background: var(--color-bg-secondary);
  position: relative;
  z-index: 1;
}

.reading-outline-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-text-tertiary);
  padding: 0 8px 8px;
}

.reading-outline-item {
  display: block;
  width: 100%;
  text-align: left;
  font-size: 12px;
  line-height: 1.5;
  padding: 5px 8px;
  margin-bottom: 1px;
  border-radius: 6px;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  /* 目录项几乎都是超长标题：截断比撑破侧栏好 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background var(--transition-fast, 0.15s), color var(--transition-fast, 0.15s);
}

.reading-outline-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.reading-outline-item.is-active {
  background: var(--color-primary-surface);
  color: var(--color-primary);
  font-weight: 500;
}

.reading-outline-level-3 {
  padding-left: 20px;
  font-size: 11.5px;
}

/* ---- 上一篇 / 下一篇 ---- */
.reading-nav {
  display: flex;
  gap: 12px;
  margin-top: 56px;
  padding-top: 20px;
  border-top: 1px solid var(--color-border-light);
}

.reading-nav-item {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-md, 10px);
  border: 1px solid var(--color-border-light);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-fast, 0.15s), border-color var(--transition-fast, 0.15s);
}

.reading-nav-item:hover {
  background: var(--color-surface-hover);
  border-color: var(--color-border);
}

.reading-nav-next {
  align-items: flex-end;
  text-align: right;
}

.reading-nav-placeholder {
  flex: 1 1 0;
}

.reading-nav-label {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.reading-nav-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prose-custom {
  max-width: none;
  font-family: var(--font-body);
  /* 与编辑器三模式共用同一基准与缩放变量：切到阅读视图时字号不跳变 */
  font-size: calc(var(--font-size-body) * var(--editor-zoom, 1));
  color: var(--color-text-body);
  line-height: 1.8;
}

/* 标题改用 em：跟着 .prose-custom 的基准字号缩放 */
.prose-custom :deep(h2) {
  font-family: var(--font-title);
  font-size: 1.5em;
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
  font-size: 1.25em;
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
  font-size: 1.05em;
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
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
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
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-md);
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

@media (prefers-reduced-motion: reduce) {
  .reading-fade-in {
    animation: none;
  }
}

/* 窄窗口：目录从「并排侧栏」退化成更窄的一条，再窄就别挤正文了 */
@media (max-width: 900px) {
  .reading-outline {
    width: 180px;
  }
}

@media (max-width: 700px) {
  .reading-outline {
    display: none;
  }
  .reading-nav {
    flex-direction: column;
  }
}
</style>
