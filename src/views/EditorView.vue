<template>
  <div class="h-full flex flex-col overflow-hidden editor-page-wrapper">
    <!-- ================= 顶栏：面包屑 + 模式切换 ================= -->
    <div
      class="flex flex-col border-b z-10 relative shrink-0"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <div class="min-h-11 px-6 py-2 flex items-center gap-3">
        <button
          v-if="currentNote"
          class="w-8 h-8 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          @click="$router.push('/notes')"
        >
          <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <span class="text-[13px] whitespace-nowrap" :style="{ color: 'var(--color-text-tertiary)' }">
          {{ currentNote?.folder || '根目录' }} <span class="mx-1">&gt;</span> {{ currentNote?.title || '无标题' }}
        </span>
        <div class="flex-1"></div>

        <div class="segmented-control">
          <button
            class="segment-btn"
            :class="{ active: editorMode === 'edit' }"
            title="源码编辑模式"
            @click="setMode('edit')"
          >
            <Pencil class="w-[18px] h-[18px]" />
          </button>
          <button
            class="segment-btn"
            :class="{ active: editorMode === 'live' }"
            title="实时预览模式（Obsidian 风格）"
            @click="setMode('live')"
          >
            <Zap class="w-[18px] h-[18px]" />
          </button>
          <button
            class="segment-btn"
            :class="{ active: editorMode === 'preview' }"
            title="阅读预览模式"
            @click="setMode('preview')"
          >
            <Eye class="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      <div class="px-6 pb-2 flex items-center gap-0.5 flex-wrap">
        <template v-for="tool in formatTools" :key="tool.id">
          <div
            v-if="tool.type === 'divider'"
            class="w-px h-5 mx-1"
            :style="{ background: 'var(--color-border)' }"
          ></div>
          <button
            v-else
            class="w-9 h-9 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-35 disabled:cursor-default"
            :title="isPreview ? `${tool.title}（阅读模式为只读）` : tool.title"
            :disabled="isPreview"
            @click="onToolbarAction(tool.id)"
          >
            <component :is="tool.icon" class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
        </template>

        <div class="w-px h-5 mx-1" :style="{ background: 'var(--color-border)' }"></div>
        <button
          class="w-9 h-9 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-35 disabled:cursor-default"
          :title="isPreview ? '撤销（阅读模式为只读）' : `撤销 (${shortcutHint('edit.undo')})`"
          :disabled="isPreview || !editorApi?.canUndo"
          @click="editorApi?.undo()"
        >
          <Undo2 class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <button
          class="w-9 h-9 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-35 disabled:cursor-default"
          :title="isPreview ? '重做（阅读模式为只读）' : `重做 (${shortcutHint('edit.redo')})`"
          :disabled="isPreview || !editorApi?.canRedo"
          @click="editorApi?.redo()"
        >
          <Redo2 class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
      </div>
    </div>

    <!-- ================= 主体：编辑 / 实时 / 预览 + 右栏 ================= -->
    <div class="flex-1 min-h-0 flex overflow-hidden">
      <!-- edit / live 共用同一个 CodeMirror 实例：
           live 只是把装饰层打开（Obsidian 方案），底层始终是同一份文档，
           因此「实时编辑」与「源码编辑」「预览」三模式看到的内容永远一致，
           撤销栈、光标位置、搜索、补全在模式切换间全部保留。 -->
      <div
        v-show="editorMode !== 'preview'"
        class="flex-1 min-w-0 flex flex-col overflow-hidden acrylic-content"
        @mousedown="onEditMouseDown"
      >
        <MarkdownEditor
          ref="mdEditorRef"
          v-model="content"
          class="flex-1 min-h-0"
          :read-only="false"
          :live-preview="editorMode === 'live'"
          :doc-key="currentNote?.id || ''"
          :placeholder="editorPlaceholder"
          :completion-context="completionContext"
          @change="onContentChange"
          @save="saveNote"
          @open-note="openNoteById"
          @spell-click="onSpellClick"
          @selection-change="onSelectionChange"
          @context-menu="onContextMenu"
        />
      </div>

      <!-- 预览模式：与 live 装饰层共用同一渲染规则（同一套 CSS 变量）
           reading-solid：实底纸面 + 去毛玻璃。半透明 acrylic 层在 Electron
           透明窗口下会被系统亚克力穿透采样糊化，导致阅读模式发虚 -->
      <div
        v-if="editorMode === 'preview'"
        class="flex-1 min-w-0 overflow-y-auto cho-scrollbar acrylic-content reading-solid"
        @click="onPreviewClick"
      >
        <div class="max-w-[780px] mx-auto py-10 px-8 pb-32">
          <div v-if="!content" class="text-center py-20" :style="{ color: 'var(--color-text-tertiary)' }">
            <FileText class="w-14 h-14 mx-auto mb-4 opacity-40" />
            <p class="text-base">这篇笔记还是空的</p>
            <p class="text-sm mt-2">切换到编辑或实时模式开始创作</p>
          </div>
          <div v-else ref="previewBodyRef" class="markdown-body notion-preview unified-editor" v-html="renderedContent"></div>
        </div>
      </div>

      <!-- ================= 右栏 ================= -->
      <!-- 四个 Tab（大纲 / 反向链接 / 出站链接 / 属性）连同派生数据与编辑动作
           整体内聚在 EditorRightPanel，这里只做接线：
           · tab 走 appStore（localStorage 持久化），用 v-model:tab 双向绑定
           · 显隐同样读 appStore.rightPanelVisible
           · open-note / scroll-to-heading / update:content 需要父级的模式判定与落盘上下文 -->
      <EditorRightPanel
        v-show="appStore.rightPanelVisible"
        v-model:tab="rightPanelTab"
        :content="content"
        :note="currentNote"
        :outline="outlineItems"
        @open-note="onPanelOpenNote"
        @scroll-to-heading="scrollToHeading"
        @update:content="onPanelContentChange"
      />
    </div>

    <!-- ================= 状态栏 ================= -->
    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        {{ editorApi?.stats?.words ?? 0 }} 字 &middot; {{ editorApi?.stats?.chars ?? 0 }} 字符 &middot; {{ editorApi?.stats?.lines ?? 0 }} 行
        <template v-if="!isPreview">
          &middot; Ln {{ editorApi?.cursorLine ?? 1 }}, Col {{ editorApi?.cursorColumn ?? 1 }}
        </template>
        &middot; 最后编辑: {{ formatDate(currentNote?.updatedAt) }}
      </span>
      <span class="cho-statusbar-meta">
        {{ modeLabel }}<template v-if="isPreview"> &middot; 只读</template>
      </span>
    </div>

    <!-- ================= 拼写检查菜单（点击红波浪线触发） ================= -->
    <SpellMenu
      :show="spellMenu.show"
      :rect="spellMenu.rect"
      :word="spellMenu.word"
      :suggestions="spellMenu.suggestions"
      :occurrences="spellMenu.occurrences"
      @close="spellMenu.show = false"
      @replace="(w) => replaceSpellWord(w)"
      @replace-all="(w) => replaceSpellWordAll(w)"
      @ignore="(w) => ignoreSpellWord(w)"
      @add-dictionary="(w) => addSpellWordToDictionary(w)"
      @copy="(w) => copyText(w)"
    />

    <!-- ================= 浮动选区工具栏 =================
         定位与按钮样式内聚在 EditorSelectionToolbar：父级只给选区坐标，
         命令执行仍走 editorApi（只有父级知道当前是不是只读的阅读模式） -->
    <EditorSelectionToolbar :coords="selectionCoords" @command="onFloatingCommand" />

    <!-- ================= 右键菜单 =================
         菜单项与快捷键文案内聚在 EditorContextMenu；父级仍持有显隐与坐标状态
         （切笔记 / 切模式要一键复位），并负责真正落到编辑器的那些动作 -->
    <EditorContextMenu
      :show="contextMenu.show"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :has-selection="contextMenu.hasSelection"
      :shortcut-hint="shortcutHint"
      :native-hint="nativeHint"
      @close="closeContextMenu"
      @action="contextMenuAction"
      @copy="copySelection"
      @cut="cutSelection"
      @paste="pasteFromClipboard"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { useAppStore } from '@/stores/app'
import { renderMarkdown, renderMermaidInContainer } from '@/utils/markdown'
import { suggestCorrections } from '@/utils/spellcheck'
import { formatBinding, isMac } from '@/constants/shortcuts'
import { formatDate } from '@/utils/format'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import SpellMenu from '@/components/editor/SpellMenu.vue'
import EditorRightPanel from '@/components/editor/EditorRightPanel.vue'
import EditorContextMenu from '@/components/editor/EditorContextMenu.vue'
import EditorSelectionToolbar from '@/components/editor/EditorSelectionToolbar.vue'
import {
  Bold, Italic, Code, Link, List, CheckSquare, ArrowLeft,
  Heading1, Heading2, Heading3, Quote, Minus,
  FileText, Eye, Pencil, Zap, Undo2, Redo2,
  Code2, GitBranch, PieChart, BarChart3
} from 'lucide-vue-next'
import { extractOutline } from '@/composables/useLinks.js'

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()
const appStore = useAppStore()

// =========================== 基础状态 ===========================
// 编辑器模式（edit / live / preview）统一托管到 store，并持久化到 localStorage：
// 切换笔记、重启应用后都沿用上次模式；三种模式共用同一份文档与撤销栈，
// 视图内不再单独维护一份模式状态，避免出现"store 与视图不一致"。
const editorMode = computed({
  get: () => {
    const m = appStore.editorMode
    return ['edit', 'live', 'preview'].includes(m) ? m : 'edit'
  },
  set: (mode) => appStore.setEditorMode(mode)
})
// 右栏 Tab：托管到 store 并持久化（localStorage: choyeon-right-panel-tab），
// 这样"切到反向链接"这类选择能跨笔记、跨重启保留——之前这里是本地 ref，
// store 里那份状态一直没人读，等于持久化了个寂寞。
const rightPanelTab = computed({
  get: () => {
    const t = appStore.rightPanelTab
    return ['outline', 'backlinks', 'outgoing', 'properties'].includes(t) ? t : 'outline'
  },
  set: (tab) => {
    // app.js 提供了 setter（顺带落 localStorage）；没有就直接写 Pinia state
    if (typeof appStore.setRightPanelTab === 'function') appStore.setRightPanelTab(tab)
    else appStore.rightPanelTab = tab
  }
})
const content = ref('')
const mdEditorRef = ref(null)
const previewBodyRef = ref(null)

/** 模板直接读取的编辑器响应式 API（stats / canUndo / cursor 等） */
const editorApi = shallowRef(null)

const contextMenu = ref({ show: false, x: 0, y: 0, hasSelection: false })

/**
 * 当前选区的屏幕坐标；null = 不显示浮动工具栏。
 * 这里只存原始坐标，居中 / 视口夹取 / 上下翻转都交给 EditorSelectionToolbar ——
 * 那是纯展示逻辑，留在父级只会多一份需要同步的状态副本。
 */
const selectionCoords = ref(null)

const spellMenu = ref({
  show: false,
  rect: null,
  word: '',
  from: 0,
  to: 0,
  suggestions: [],
  occurrences: 1
})

// =========================== 工具栏定义 ===========================
const formatTools = [
  { id: 'format.h1', icon: Heading1, title: '一级标题' },
  { id: 'format.h2', icon: Heading2, title: '二级标题' },
  { id: 'format.h3', icon: Heading3, title: '三级标题' },
  { type: 'divider' },
  { id: 'format.bold', icon: Bold, title: '粗体' },
  { id: 'format.italic', icon: Italic, title: '斜体' },
  { id: 'format.code', icon: Code, title: '行内代码' },
  { type: 'divider' },
  { id: 'format.quote', icon: Quote, title: '引用' },
  { id: 'format.bulletList', icon: List, title: '无序列表' },
  { id: 'format.taskList', icon: CheckSquare, title: '待办列表' },
  { id: 'format.link', icon: Link, title: '链接' },
  { id: 'insert.divider', icon: Minus, title: '分隔线' },
  { type: 'divider' },
  { id: 'insert.codeBlock', icon: Code2, title: '代码块' },
  { id: 'insert.mermaid-flow', icon: GitBranch, title: '流程图' },
  { id: 'insert.mermaid-pie', icon: PieChart, title: '饼图' },
  { id: 'insert.mermaid-gantt', icon: BarChart3, title: '甘特图' }
]

const MERMAID_TEMPLATES = {
  'insert.mermaid-flow': '```mermaid\nflowchart TD\n    A[开始] --> B{判断}\n    B -->|是| C[处理]\n    B -->|否| D[结束]\n    C --> D\n```',
  'insert.mermaid-pie': '```mermaid\npie title 项目分布\n    "前端" : 40\n    "后端" : 30\n    "设计" : 20\n    "测试" : 10\n```',
  'insert.mermaid-gantt': '```mermaid\ngantt\n    title 项目计划\n    dateFormat YYYY-MM-DD\n    section 设计\n    需求分析 :a1, 2026-01-01, 7d\n    UI设计 :a2, after a1, 5d\n    section 开发\n    前端开发 :b1, after a2, 14d\n```'
}

function onToolbarAction(id) {
  // 预览模式是只读视图：编辑器实例被 v-show 隐藏，此时改文档等于"改了看不见的东西"
  if (isPreview.value) return
  if (MERMAID_TEMPLATES[id]) {
    mdEditorRef.value?.insertAtCursor(`\n${MERMAID_TEMPLATES[id]}\n`)
    return
  }
  mdEditorRef.value?.applyCommand(id)
}

function shortcutHint(id) {
  return formatBinding(appStore.getBinding(id))
}

/** 复制/剪切/粘贴是系统原生键，不在快捷键注册表里，但要按平台显示 Ctrl / ⌘ */
function nativeHint(key) {
  return isMac ? `⌘${key}` : `Ctrl+${key}`
}

// =========================== 笔记载入 / 内容同步 ===========================
const currentNote = computed(() => noteStore.currentNote)

const renderedContent = computed(() => {
  // 必须传 resolveTarget，否则预览里所有 [[双链]] 都是"未创建"红色态，
  // 点击 ![[嵌入]] 还会顺手新建一个空笔记
  return renderMarkdown(content.value || '', { resolveTarget: noteStore.resolveWikiForRender })
})

const outlineItems = computed(() => {
  try { return extractOutline(content.value || '') } catch { return [] }
})

const editorPlaceholder = '开始书写你的想法...'

const modeLabel = computed(() => ({
  edit: '源码编辑模式',
  live: '实时预览模式',
  preview: '阅读模式'
}[editorMode.value] || ''))

/** 预览（阅读）模式为只读视图：编辑类操作一律禁用，避免改动被隐藏的编辑器 */
const isPreview = computed(() => editorMode.value === 'preview')

function onContentChange(newContent) {
  const val = typeof newContent === 'string' ? newContent : content.value
  // id 失效（笔记被删 / 库被切换后 id 重新生成）时静默丢弃编辑是最糟的一类
  // 数据丢失：编辑器照常显示、照常能输入，但内容既不进 store 也不落盘。
  if (!currentNote.value?.id) {
    appStore.pushToast({ type: 'error', message: '当前笔记已失效，改动未保存。请从列表重新打开一篇笔记。' })
    return
  }
  noteStore.updateNoteContent(currentNote.value.id, val)
}

/**
 * 显式保存：无论「自动保存」开关状态如何都必须落盘。
 * updateNoteContent 在关闭自动保存时只更新内存，这里再 flush 一次补上写盘。
 */
function saveNote() {
  if (!currentNote.value?.id) {
    appStore.pushToast({ type: 'error', message: '当前笔记已失效，无法保存。' })
    return
  }
  noteStore.updateNoteContent(currentNote.value.id, content.value)
  noteStore.flushSave(currentNote.value.id)
}

/**
 * 切换编辑器模式：只做「校验 + 委托」，副作用统一交给下面的 watch。
 *
 * 这里刻意只委托到 store，不做别的（`selectionCoords` 重置、聚焦编辑器都移走了）：
 * 模式切换现在有三条入口——顶部三个分段按钮、`Mod-Shift-E` 全局快捷键、命令面板——
 * 全局快捷键、命令面板——后两条走的是 app scope 分发到 `appStore.toggleReadingMode()`，
 * 那条链路拿不到 `mdEditorRef`。副作用写在 watch 里才能让三条入口行为一致。
 *
 * @param {'edit'|'live'|'preview'} mode 目标模式
 */
function setMode(mode) {
  if (!['edit', 'live', 'preview'].includes(mode)) return
  appStore.setEditorMode(mode)
}

// =========================== 编辑器 API 装配 ===========================
function onEditorReady() {
  const api = mdEditorRef.value
  if (!api) return
  // MarkdownEditor defineExpose 的响应式成员（stats/canUndo/cursorLine...）
  // 直接取 ref 对象本身，模板里即可实时读取
  editorApi.value = {
    get stats() { return api.stats },
    get canUndo() { return api.canUndo },
    get canRedo() { return api.canRedo },
    get cursorLine() { return api.cursorLine },
    get cursorColumn() { return api.cursorColumn },
    undo: () => api.undo(),
    redo: () => api.redo(),
    applyCommand: (id) => api.applyCommand(id)
  }
}

/**
 * 编辑器命令的统一执行入口 —— 注册给 appStore 的 `editorRunner`（T12）。
 *
 * 命令面板靠它执行 editor scope 命令（加粗 / 一级标题 / 插入表格…）：
 * 面板本身拿不到 CodeMirror 实例，只能经 `appStore.runEditorCommand(id)` 转发到这里。
 *
 * 两条守卫与现有交互保持一致，不多也不少：
 * 1. 编辑器实例还没就绪（首帧 / 组件销毁中）→ 返回 false，由面板侧决定是否提示；
 * 2. 阅读模式是只读视图：编辑器被 v-show 隐藏，改文档等于"改了看不见的东西"，
 *    因此只放行 `edit.selectAll` —— 与右键菜单 `contextMenuAction` 的口径完全一致。
 *
 * @param {string} id 编辑器命令 id（注册表里的 editor scope 命令）
 * @returns {boolean} 是否真的执行了
 */
function runEditorCommand (id) {
  const editor = mdEditorRef.value
  if (!editor) return false
  if (isPreview.value) {
    if (id !== 'edit.selectAll') return false
    editor.selectAll?.()
    return true
  }
  return editor.applyCommand?.(id) ?? false
}

// =========================== 补全上下文 ===========================
const completionContext = computed(() => {
  // 刻意不带 content：补全只在用户输入 `#` 时才需要目标笔记的大纲，
  // 带上全库正文会让每次按键都触发 computed 失效 + 全库字符串拷贝。
  const notes = (noteStore.notes || []).map(n => ({
    id: n.id,
    title: n.title,
    folder: n.folder,
    outlineOf: (id) => noteStore.getNoteOutline?.(id) || []
  }))
  return {
    notes,
    tags: noteStore.allTags || [],
    currentNoteId: currentNote.value?.id || null,
    outline: outlineItems.value,
    // 实时预览要靠它判断 [[双链]] 指向的笔记是否存在（不存在则标灰，与阅读视图一致）
    resolveWiki: (target) => noteStore.resolveWikiForRender?.(target),
    onCreateNote: (target) => {
      const folder = currentNote.value?.folder || ''
      return noteStore.createNoteFromWikiTarget?.(target, folder) || noteStore.createNote(folder, target)
    }
  }
})

// =========================== 右栏接线 ===========================
// 右栏四个 Tab 的模板 / 派生数据 / 编辑动作已整体搬到 EditorRightPanel，
// 父级只保留需要"全局上下文"的出口：改正文要落盘、打开笔记要动路由。
/** 右栏直接改正文（例如给没有 frontmatter 的笔记补 preamble）时同步进 store */
function onPanelContentChange(next) {
  content.value = typeof next === 'string' ? next : content.value
  onContentChange(content.value)
}

function openNoteById(id) {
  if (!id) return
  noteStore.selectNote(id)
  router.replace(`/editor/${id}`)
}

/**
 * 右栏（反向链接 / 出站链接）打开笔记。
 * payload 支持两种形态：纯 id 字符串，或 { id, hash }（带标题锚点）。
 */
function onPanelOpenNote(payload) {
  const id = typeof payload === 'string' ? payload : payload?.id
  if (!id) return
  openNoteById(id)
  const hash = typeof payload === 'string' ? '' : (payload?.hash || '')
  // 笔记刚切过去，DOM / 编辑器要等这一轮渲染完才能定位锚点
  if (hash) nextTick(() => scrollToHeadingAnyMode(hash))
}

// =========================== 预览区 wikilink 点击 ===========================
function onPreviewClick(e) {
  if (!e) return
  const a = e.target?.closest?.('a.wikilink, a[data-wiki-target]')
  if (!a) {
    const embedCard = e.target?.closest?.('.embed-card, .wikilink-embed')
    if (!embedCard) return
    const target = embedCard.getAttribute('data-wiki-target') || embedCard.getAttribute('data-note-id')
    if (!target) return
    handleGenericWikilinkClick({ target, id: embedCard.getAttribute('data-note-id') || null, hash: embedCard.getAttribute('data-wiki-hash') || '' })
    e.preventDefault()
    e.stopPropagation()
    return
  }
  e.preventDefault()
  e.stopPropagation()
  const id = a.getAttribute('data-note-id') || null
  const target = a.getAttribute('data-wiki-target') || ''
  const hash = a.getAttribute('data-wiki-hash') || ''
  handleGenericWikilinkClick({ target, id, hash })
}

function handleGenericWikilinkClick({ target, id, hash }) {
  if (!target && hash) {
    scrollToHeadingAnyMode(hash)
    return
  }
  if (id) {
    openNoteById(id)
    if (hash) setTimeout(() => scrollToHeadingAnyMode(hash), 80)
    return
  }
  if (target) {
    const exact = (noteStore.notes || []).find(n => n.title === target)
    if (exact) {
      openNoteById(exact.id)
      if (hash) setTimeout(() => scrollToHeadingAnyMode(hash), 80)
      return
    }
    const fuzzy = (noteStore.notes || []).find(n => n.title.toLowerCase().includes(target.toLowerCase()))
    if (fuzzy) {
      openNoteById(fuzzy.id)
      if (hash) setTimeout(() => scrollToHeadingAnyMode(hash), 80)
      return
    }
    const created = noteStore.createNoteFromWikiTarget?.(target, currentNote.value?.folder || '') || noteStore.createNote(currentNote.value?.folder || '', target)
    if (created?.id) openNoteById(created.id)
  }
}

// =========================== 滚动 / 定位 ===========================
function scrollToHeadingAnyMode(text) {
  if (editorMode.value === 'preview' && previewBodyRef.value) {
    const els = previewBodyRef.value.querySelectorAll('h1, h2, h3, h4, h5, h6')
    const needle = String(text).trim().toLowerCase()
    for (const el of els) {
      if (el.textContent.trim().toLowerCase() === needle) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
    for (const el of els) {
      if (el.textContent.includes(text)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
    return
  }
  mdEditorRef.value?.scrollToHeadingText(text)
}

function scrollToHeading(item) {
  if (!item?.text) return
  if (editorMode.value === 'preview') {
    scrollToHeadingAnyMode(item.text)
    return
  }
  // 大纲条目按标题文本定位（与 wikilink 锚点一致的匹配规则）
  mdEditorRef.value?.scrollToHeadingText(item.text)
}

// =========================== 拼写检查菜单 ===========================
function onSpellClick(hit) {
  if (!hit) return
  const rect = hit.rect || mdEditorRef.value?.spellRect(hit) || null
  const suggestions = suggestCorrections(hit.word, appStore.customDictionary instanceof Set ? appStore.customDictionary : new Set(), 5)
  spellMenu.value = {
    show: true,
    rect,
    word: hit.word,
    from: hit.from,
    to: hit.to,
    suggestions,
    occurrences: countOccurrences(content.value, hit.word)
  }
}

function countOccurrences(text, word) {
  if (!word) return 0
  let count = 0
  let idx = text.indexOf(word)
  while (idx !== -1) {
    count++
    idx = text.indexOf(word, idx + word.length)
  }
  return count
}

function closeSpellMenu() {
  spellMenu.value.show = false
}

function replaceSpellWord(word) {
  const { from, to } = spellMenu.value
  if (typeof from === 'number' && typeof to === 'number' && to > from) {
    mdEditorRef.value?.replaceRange(from, to, word)
  }
  closeSpellMenu()
}

function replaceSpellWordAll(word) {
  const target = spellMenu.value.word
  if (!target) return
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 必须带词边界，否则替换 teh 会把 tehre / steh 里的片段一起吃掉。
  // 这里不能用 \b：中文不属于 \w，\b 对中文前后完全失效，所以改用前后断言，
  // 要求命中片段的前后都不是「单词字符或汉字」。
  const pattern = new RegExp(`(?<![\\w\\u4e00-\\u9fa5])${escaped}(?![\\w\\u4e00-\\u9fa5])`, 'g')
  // 替换值用函数形式：word 里若含 $& / $1 会被当成替换模式展开
  content.value = content.value.replace(pattern, () => word)
  onContentChange(content.value)
  closeSpellMenu()
}

function ignoreSpellWord(word) {
  appStore.ignoreWord(word)
  closeSpellMenu()
}

function addSpellWordToDictionary(word) {
  appStore.addToDictionary(word)
  closeSpellMenu()
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''))
  } catch { /* 剪贴板不可用时静默失败 */ }
  closeSpellMenu()
}

// =========================== 浮动选区工具栏 ===========================
/** 显隐判定留在父级（要看当前模式与选区），坐标换算交给工具栏自己 */
function onSelectionChange(info) {
  const usable = editorMode.value !== 'preview' && info?.hasSelection && info?.coords
  selectionCoords.value = usable ? info.coords : null
}

function onFloatingCommand(commandId) {
  editorApi.value?.applyCommand(commandId)
}

// =========================== 右键菜单 ===========================
function onContextMenu(event) {
  if (!event) return
  event.preventDefault()
  const hasSelection = !!mdEditorRef.value?.getSelection?.() && mdEditorRef.value.getSelection().from !== mdEditorRef.value.getSelection().to
  const estimatedWidth = 260
  const estimatedHeight = hasSelection ? 480 : 160
  let x = event.clientX
  let y = event.clientY
  if (x + estimatedWidth > window.innerWidth - 8) x = window.innerWidth - estimatedWidth - 8
  if (y + estimatedHeight > window.innerHeight - 8) {
    y = event.clientY - estimatedHeight
    if (y < 8) y = 8
  }
  selectionCoords.value = null
  contextMenu.value = { show: true, x, y, hasSelection }
}

function closeContextMenu() {
  contextMenu.value.show = false
}

function contextMenuAction(commandId) {
  closeContextMenu()
  // 预览模式是只读视图：只放行「全选 / 复制」这类不改文档的命令
  if (isPreview.value && commandId !== 'edit.selectAll') return
  nextTick(() => {
    if (commandId === 'edit.selectAll') {
      mdEditorRef.value?.selectAll()
    } else {
      mdEditorRef.value?.applyCommand(commandId)
    }
  })
}

async function copySelection() {
  closeContextMenu()
  const sel = mdEditorRef.value?.getSelection?.()
  if (sel?.text) await copyText(sel.text)
}

async function cutSelection() {
  closeContextMenu()
  if (isPreview.value) return
  const sel = mdEditorRef.value?.getSelection?.()
  if (sel?.text) {
    await copyText(sel.text)
    mdEditorRef.value?.replaceRange(sel.from, sel.to, '')
  }
}

async function pasteFromClipboard() {
  closeContextMenu()
  if (isPreview.value) return
  try {
    const text = await navigator.clipboard.readText()
    if (text) mdEditorRef.value?.insertAtCursor(text)
  } catch { /* 剪贴板权限被拒时静默失败 */ }
}

// =========================== 编辑区鼠标 ===========================
function onEditMouseDown() {
  // 点击编辑区任意位置时收起浮动工具栏（spellMenu 自行管理关闭逻辑）
  if (selectionCoords.value) selectionCoords.value = null
}

// =========================== 生命周期 / 路由 ===========================
// 日期格式化统一走 @/utils/format：'datetime' → YYYY-MM-DD HH:mm，
// 与这里原来的本地实现逐字一致（空值同样返回 ''）。

/**
 * 从路由载入笔记。
 * 关键：selectNote 不校验 id 是否存在。若 id 失效（笔记已删 / 切换库后 id 由
 * 路径重新生成 / localStorage 残留旧 id），currentNote 会是 null，而编辑器仍
 * 显示上一篇笔记的正文——用户以为在编辑 A，实际写入的是 null，全部丢弃。
 * 这里显式校验并回退到列表首篇 + 纠正路由。
 */
function loadFromRoute() {
  const routeId = route.params.id
  if (routeId && noteStore.notes.some(n => n.id === routeId)) {
    noteStore.selectNote(routeId)
  } else if (noteStore.notes.length > 0) {
    const firstNote = noteStore.notes[0]
    noteStore.selectNote(firstNote.id)
    // 只在 id 无效 / 缺失时纠正路由，避免每次载入都多一次 replace
    if (!routeId || routeId !== firstNote.id) {
      router.replace(`/editor/${firstNote.id}`)
    }
  } else {
    noteStore.selectNote(null)
    content.value = ''
    return
  }
  // 切换笔记时清掉上一笔记残留的 UI 态（新增属性输入、右键菜单、浮动工具栏、拼写菜单）
  resetTransientUiState()
  content.value = currentNote.value?.content || ''
}

function resetTransientUiState() {
  // 右栏「新建属性」输入框的复位已随右栏一起搬到 EditorRightPanel（它 watch note.id）
  contextMenu.value = { show: false, x: 0, y: 0, hasSelection: false }
  selectionCoords.value = null
  spellMenu.value = { show: false, rect: null, word: '', from: 0, to: 0, suggestions: [], occurrences: 1 }
}

watch(() => route.params.id, () => {
  loadFromRoute()
})

// 只比对 content 字符串：deep watch 会遍历整个 note 对象（含正文），
// 每次输入都做一次全量深度遍历，长文下开销明显
watch(() => currentNote.value?.content, (next) => {
  if (typeof next === 'string' && next !== content.value) {
    content.value = next
  }
})

// 笔记被外部删除 / 库被切换导致当前指针失效时，纠正路由而不是静默继续
watch(() => noteStore.notes.length, () => {
  if (!currentNote.value && noteStore.notes.length > 0) {
    loadFromRoute()
  }
})

// 预览模式下内容变化时重渲染 mermaid
watch([content, editorMode], async () => {
  if (editorMode.value === 'preview') {
    await nextTick()
    if (previewBodyRef.value) renderMermaidInContainer(previewBodyRef.value)
  }
})

// 进入任意可编辑模式（edit / live）时收敛焦点：
// 原来这份副作用写在 setMode 里，只能覆盖顶部按钮；模式切换改由 app scope 分发后，
// 快捷键 / 命令面板走的是 appStore.toggleReadingMode()，拿不到编辑器实例。
// 收敛到 watcher 后三条入口行为一致，避免「按快捷键切回编辑模式后光标不进编辑器」。
// watch 只在值变化时触发（首次挂载不触发），所以不会出现"一进页面就抢焦点"。
watch(editorMode, (next) => {
  if (next === 'preview') return
  selectionCoords.value = null
  nextTick(() => mdEditorRef.value?.focus())
})

onMounted(async () => {
  loadFromRoute()
  nextTick(onEditorReady)
  // 模式现在会持久化：若上次退出时停留在阅读模式，进来后需要先渲染一次 mermaid
  await nextTick()
  if (editorMode.value === 'preview' && previewBodyRef.value) {
    renderMermaidInContainer(previewBodyRef.value)
  }
  // T12：把「跑编辑器命令」的能力注册进 store，命令面板据此显示 / 执行 editor scope 命令。
  // 与下面的 setEditorRunner(null) 必须成对，否则编辑器卸载后面板仍显示编辑器命令
  // （点了会作用在已销毁的 CodeMirror view 上）。
  appStore.setEditorRunner(runEditorCommand)
})

onUnmounted(() => {
  // 离开编辑器（切到列表/图谱/设置、或关闭应用）时必须落盘，
  // 否则自动保存关闭时整段会话的改动都不会写出去
  if (currentNote.value?.id) {
    noteStore.flushSave(currentNote.value.id)
  }
  // 离开编辑器必须注销 runner：留着就是「面板里还能点到编辑器命令、却什么都不会发生」
  appStore.setEditorRunner(null)
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

/* 预览（阅读）模式正文 = 实底纸面：
   半透明 acrylic + backdrop-filter 在 Electron 透明窗口下会被系统亚克力
   穿透采样糊化（阅读模式"发虚/蒙雾"的根因），阅读场景也不需要毛玻璃。
   实底 + 无模糊 + 提层压过上面的 ::before 雾化层。 */
.reading-solid {
  position: relative;
  z-index: 1;
  background: var(--reading-bg) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.outline-item-active {
  background: var(--color-primary-surface);
}

/* ===== 预览排版：与实时预览装饰层共用同一套变量（编辑/预览一致性） =====
   字号乘 --editor-zoom：edit / live / preview 三种模式与阅读视图同步缩放 */
.unified-editor,
.markdown-body {
  font-size: calc(var(--font-size-body) * var(--editor-zoom, 1)) !important;
  line-height: 1.72 !important;
  color: var(--color-text-body) !important;
  font-family: var(--font-body) !important;
  word-break: break-word;
}

/* 行内代码 / pre / mark / 链接 / 引用 / 分隔线 的样式一律交给 style.css 的
   `.markdown-body` 规范块：这里曾经有一份 :deep() 覆盖（行内代码红色、
   font-size .9em !important、引用无底色……），结果阅读视图和实时预览对不上，
   而实时预览的装饰层（themes.js）只能读全局 CSS 变量，无法跟着 scoped 规则走。
   现在两边共用同一份定义，改一处即同步。 */

.markdown-body :deep(input[type="checkbox"]) {
  margin-right: 8px;
  width: 16px;
  height: 16px;
  vertical-align: middle;
  accent-color: var(--color-primary);
}

/* 浮动工具栏按钮（.ft-btn）与 fade 过渡已随 EditorSelectionToolbar /
   EditorContextMenu 搬进各自的 scoped style：这两块都 Teleport 到 body，
   拿不到本组件的 scoped 规则，必须由各自组件自带一份（全局 .fade-* 用的是
   CSS 变量，时长与曲线不同，不能借全局那份）。 */
</style>
