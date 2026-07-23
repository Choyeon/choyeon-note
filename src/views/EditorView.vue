<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-11 px-6 py-2 flex items-center gap-3 border-b acrylic-content min-w-[700px]"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <button 
        v-if="currentNote"
        class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        @click="$router.push('/notes')"
      >
        <ArrowLeft class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <span class="text-xs whitespace-nowrap" :style="{ color: 'var(--color-text-tertiary)' }">
        {{ currentNote?.folder || '根目录' }} <span class="mx-1">&gt;</span> {{ currentNote?.title || '无标题' }}
      </span>
      <div class="flex-1"></div>
      
      <div class="flex items-center gap-0.5 mr-2">
        <template v-for="tool in formatTools" :key="tool.id">
          <div 
            v-if="tool.type === 'divider'" 
            class="w-px h-4 mx-1"
            :style="{ background: 'var(--color-border)' }"
          ></div>
          <button 
            v-else
            class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :title="tool.title"
            @click="applyFormat(tool.id)"
          >
            <component :is="tool.icon" class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
        </template>
      </div>

      <div class="segmented-control">
        <button 
          class="segment-btn"
          :class="{ active: editorMode === 'edit' }"
          @click="setMode('edit')"
        >编辑</button>
        <button 
          class="segment-btn"
          :class="{ active: editorMode === 'live' }"
          @click="setMode('live')"
        >实时</button>
        <button 
          class="segment-btn"
          :class="{ active: editorMode === 'preview' }"
          @click="setMode('preview')"
        >预览</button>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex overflow-hidden">
      <div v-if="editorMode === 'edit'" class="flex-1 min-w-0 flex overflow-hidden">
        <div 
          v-if="showLineNumbers" 
          class="w-10 min-w-[40px] flex-shrink-0 py-8 px-0 overflow-hidden select-none"
          :style="{ background: 'var(--color-bg-tertiary)' }"
        >
          <div class="text-right pr-2">
            <div 
              v-for="n in lineCount" 
              :key="n"
              class="h-[23.8px] leading-[23.8px] text-[12px]"
              :style="{ color: 'var(--color-text-tertiary)' }"
            >{{ n }}</div>
          </div>
        </div>
        <div 
          class="flex-1 overflow-y-auto cho-scrollbar acrylic-content" 
          ref="editorScrollRef"
          @scroll="syncSpellOverlay"
        >
          <div class="max-w-[780px] mx-auto py-8 px-8 pb-16" :style="{ paddingLeft: showLineNumbers ? '8px' : '32px' }">
            <div class="relative">
              <div 
                ref="spellOverlayRef"
                class="absolute inset-0 pointer-events-none spell-overlay"
                :style="{ 
                  fontSize: fontSize,
                  lineHeight: '1.7',
                  fontFamily: 'var(--font-body)',
                  whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                  wordBreak: wordWrap ? 'break-word' : 'normal',
                  color: 'transparent',
                  overflow: 'hidden',
                  padding: '0',
                  margin: '0',
                  border: 'none'
                }"
              ></div>
              <textarea
                ref="editorRef"
                v-model="content"
                class="w-full outline-none resize-none bg-transparent font-sans relative z-10"
                :style="{ 
                  color: 'var(--color-text-primary)',
                  fontSize: fontSize,
                  lineHeight: '1.7',
                  minHeight: '500px',
                  fontFamily: 'var(--font-body)',
                  overflow: 'hidden',
                  height: 'auto',
                  display: 'block',
                  padding: '0',
                  margin: '0',
                  border: 'none'
                }"
                :spellcheck="spellCheckEnabled"
                :wrap="wordWrap ? 'soft' : 'off'"
                @input="onContentChange"
                @keydown="onEditorKeydown"
                @contextmenu="onContextMenu"
                @mousemove="onMouseMove"
                @mouseleave="hideSpellTooltip"
              ></textarea>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="editorMode === 'live'" class="flex-1 min-w-0 overflow-y-auto cho-scrollbar acrylic-content" ref="liveScrollRef">
        <div class="max-w-[780px] mx-auto py-10 px-8 pb-32">
          <div
            ref="liveEditorRef"
            class="live-editor outline-none min-h-[500px] focus:outline-none notion-editor"
            contenteditable="true"
            :spellcheck="spellCheckEnabled"
            :data-placeholder="editorPlaceholder"
            :style="{ 
              color: 'var(--color-text-primary)',
              fontSize: fontSize,
              lineHeight: '1.7',
              fontFamily: 'var(--font-body)'
            }"
            @input="onLiveInput"
            @keydown="onLiveKeydown"
            @keyup="onLiveKeyup"
            @paste="onLivePaste"
            @contextmenu="onContextMenu"
            @mouseup="onLiveMouseup"
            @mousemove="onLiveMousemove"
          ></div>
        </div>
      </div>

      <div v-else class="flex-1 min-w-0 overflow-y-auto cho-scrollbar acrylic-content">
        <div class="max-w-[780px] mx-auto py-10 px-8 pb-32">
          <div v-if="!content" class="text-center py-20" :style="{ color: 'var(--color-text-tertiary)' }">
            <FileText class="w-12 h-12 mx-auto mb-4 opacity-40" />
            <p class="text-sm">这篇笔记还是空的</p>
            <p class="text-xs mt-2">切换到编辑或实时模式开始创作</p>
          </div>
          <div v-else class="markdown-body notion-preview" v-html="renderedContent"></div>
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

        <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar p-2">
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
            <div v-if="outlineItems.length === 0" class="text-[13px] px-2 py-2" :style="{ color: 'var(--color-text-tertiary)' }">
              暂无大纲
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

    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        {{ currentNote?.wordCount || 0 }} 字 &middot; {{ currentNote?.charCount || 0 }} 字符 &middot; {{ currentNote?.lineCount || 0 }} 行 &middot; 最后编辑: {{ formatDate(currentNote?.updatedAt) }}
      </span>
      <span class="cho-statusbar-meta">
        {{ modeLabel }}
      </span>
    </div>

    <Teleport to="body">
      <Transition name="fade">
        <div 
          v-if="contextMenu.show" 
          class="fixed inset-0 z-50"
          @click="closeContextMenu"
          @contextmenu.prevent="closeContextMenu"
        >
          <div 
            class="context-menu absolute rounded-lg overflow-hidden shadow-lg"
            :style="{ 
              left: contextMenu.x + 'px', 
              top: contextMenu.y + 'px',
              background: 'var(--card-bg)',
              border: '1px solid var(--card-border)',
              minWidth: '200px',
              padding: '4px'
            }"
            @click.stop
          >
            <template v-if="contextMenu.hasSelection">
              <div class="context-menu-label">格式化</div>
              <button class="context-menu-item" @click="contextMenuAction('bold')">
                <Bold class="w-3.5 h-3.5" />
                <span>粗体</span>
                <span class="context-menu-shortcut">Ctrl+B</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('italic')">
                <Italic class="w-3.5 h-3.5" />
                <span>斜体</span>
                <span class="context-menu-shortcut">Ctrl+I</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('code')">
                <Code class="w-3.5 h-3.5" />
                <span>行内代码</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('link')">
                <Link class="w-3.5 h-3.5" />
                <span>链接</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('highlight')">
                <Highlighter class="w-3.5 h-3.5" />
                <span>高亮</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('strikethrough')">
                <Strikethrough class="w-3.5 h-3.5" />
                <span>删除线</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="contextMenuAction('h1')">
                <Heading1 class="w-3.5 h-3.5" />
                <span>一级标题</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('h2')">
                <Heading2 class="w-3.5 h-3.5" />
                <span>二级标题</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('h3')">
                <Heading3 class="w-3.5 h-3.5" />
                <span>三级标题</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="contextMenuAction('quote')">
                <Quote class="w-3.5 h-3.5" />
                <span>引用</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('list')">
                <List class="w-3.5 h-3.5" />
                <span>无序列表</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('todo')">
                <CheckSquare class="w-3.5 h-3.5" />
                <span>待办事项</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="contextMenuAction('copy')">
                <Copy class="w-3.5 h-3.5" />
                <span>复制</span>
                <span class="context-menu-shortcut">Ctrl+C</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('cut')">
                <Scissors class="w-3.5 h-3.5" />
                <span>剪切</span>
                <span class="context-menu-shortcut">Ctrl+X</span>
              </button>
            </template>
            <template v-else>
              <button class="context-menu-item" @click="contextMenuAction('paste')">
                <ClipboardPaste class="w-3.5 h-3.5" />
                <span>粘贴</span>
                <span class="context-menu-shortcut">Ctrl+V</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="contextMenuAction('selectAll')">
                <Check class="w-3.5 h-3.5" />
                <span>全选</span>
                <span class="context-menu-shortcut">Ctrl+A</span>
              </button>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="fade">
        <div 
          v-if="spellTooltip.show" 
          class="fixed z-50"
          :style="{ 
            left: spellTooltip.x + 'px', 
            top: spellTooltip.y + 'px',
            pointerEvents: 'auto'
          }"
          @click.stop
          @mouseenter="onSpellTooltipEnter"
          @mouseleave="onSpellTooltipLeave"
        >
          <div 
            class="spell-tooltip rounded-lg overflow-hidden shadow-lg"
            :style="{ 
              background: 'var(--card-bg)',
              border: '1px solid var(--card-border)',
              minWidth: '180px',
              padding: '4px'
            }"
          >
            <div class="spell-tooltip-header">
              <span class="text-[11px]" :style="{ color: 'var(--state-error)' }">拼写错误</span>
            </div>
            <div class="spell-tooltip-word">
              <span class="text-[13px] font-medium" :style="{ color: 'var(--color-text-primary)' }">{{ spellTooltip.word }}</span>
            </div>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" @click="handleIgnoreWord">
              <EyeOff class="w-3.5 h-3.5" />
              <span>忽略此单词</span>
            </button>
            <button class="context-menu-item" @click="handleAddToDictionary">
              <BookPlus class="w-3.5 h-3.5" />
              <span>添加到词典</span>
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="fade">
        <div 
          v-if="floatingToolbar.show" 
          class="fixed z-50"
          :style="{ 
            left: floatingToolbar.x + 'px', 
            top: floatingToolbar.y + 'px',
            transform: floatingToolbar.placement === 'top' 
              ? 'translate(-50%, -100%)' 
              : 'translate(-50%, 0)'
          }"
          @mousedown.prevent
        >
          <div 
            class="floating-toolbar flex items-center gap-0.5 rounded-lg overflow-hidden shadow-lg"
            :style="{ 
              background: 'var(--card-bg)',
              border: '1px solid var(--card-border)',
              padding: '4px'
            }"
          >
            <button class="ft-btn" title="粗体" @mousedown.prevent="applyFormat('bold')">
              <Bold class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="斜体" @mousedown.prevent="applyFormat('italic')">
              <Italic class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="下划线" @mousedown.prevent="applyFormat('underline')">
              <Underline class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="删除线" @mousedown.prevent="applyFormat('strikethrough')">
              <Strikethrough class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="行内代码" @mousedown.prevent="applyFormat('code')">
              <Code class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="高亮" @mousedown.prevent="applyFormat('highlight')">
              <Highlighter class="w-3.5 h-3.5" />
            </button>
            <div class="ft-divider"></div>
            <button class="ft-btn" title="一级标题" @mousedown.prevent="applyFormat('h1')">
              <Heading1 class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="二级标题" @mousedown.prevent="applyFormat('h2')">
              <Heading2 class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="三级标题" @mousedown.prevent="applyFormat('h3')">
              <Heading3 class="w-3.5 h-3.5" />
            </button>
            <div class="ft-divider"></div>
            <button class="ft-btn" title="链接" @mousedown.prevent="applyFormat('link')">
              <Link class="w-3.5 h-3.5" />
            </button>
          </div>
          <div class="floating-toolbar-arrow" :class="{ 'arrow-bottom': floatingToolbar.placement === 'bottom' }"></div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="fade">
        <div 
          v-if="slashMenu.show" 
          class="fixed z-50 slash-menu rounded-lg overflow-hidden shadow-lg"
          :style="{ 
            left: slashMenu.x + 'px', 
            top: slashMenu.y + 'px',
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            width: '280px',
            maxHeight: '320px'
          }"
          @click.stop
        >
          <div class="slash-menu-search">
            <Search class="w-3.5 h-3.5" />
            <input
              ref="slashSearchRef"
              v-model="slashMenu.query"
              type="text"
              class="slash-search-input"
              placeholder="筛选命令..."
              @keydown="onSlashKeydown"
            />
          </div>
          <div class="slash-menu-list cho-scrollbar">
            <div 
              v-for="(item, index) in filteredSlashCommands" 
              :key="item.id"
              class="slash-menu-item"
              :class="{ active: index === slashMenu.activeIndex }"
              @click="executeSlashCommand(item)"
              @mouseenter="slashMenu.activeIndex = index"
            >
              <div class="slash-menu-icon">
                <component :is="item.icon" class="w-4 h-4" />
              </div>
              <div class="slash-menu-text">
                <div class="slash-menu-title">{{ item.title }}</div>
                <div class="slash-menu-desc">{{ item.desc }}</div>
              </div>
            </div>
            <div v-if="filteredSlashCommands.length === 0" class="slash-menu-empty">
              没有匹配的命令
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { useAppStore } from '@/stores/app'
import { renderMarkdown, renderMermaidInContainer } from '@/utils/markdown'
import { 
  Bold, Italic, Code, Link, List, CheckSquare, ArrowLeft, 
  Heading1, Heading2, Heading3, Quote, Minus, Highlighter, 
  Strikethrough, Copy, Scissors, ClipboardPaste, Check,
  EyeOff, BookPlus, Underline, FileText, Search,
  Type, Pilcrow, ListOrdered, ListTodo, Table as TableIcon,
  Image as ImageIcon, Code2, Square, Heading, Hash,
  PieChart, GitBranch, Clock, BarChart3
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()
const appStore = useAppStore()

const editorMode = ref('live')
const rightPanelTab = ref('outline')
const content = ref('')
const editorRef = ref(null)
const liveEditorRef = ref(null)
const editorScrollRef = ref(null)
const liveScrollRef = ref(null)
const spellOverlayRef = ref(null)
const isLiveEditing = ref(false)
let liveInputTimeout = null
let spellUpdateTimeout = null
let spellTooltipHideTimeout = null
let canvasMeasureCtx = null

const contextMenu = ref({
  show: false,
  x: 0,
  y: 0,
  hasSelection: false
})

const spellTooltip = ref({
  show: false,
  x: 0,
  y: 0,
  word: '',
  placement: 'bottom'
})

let isMouseInSpellTooltip = false

const floatingToolbar = ref({
  show: false,
  x: 0,
  y: 0,
  placement: 'top'
})

const isMouseDown = ref(false)

const slashMenu = ref({
  show: false,
  x: 0,
  y: 0,
  query: '',
  activeIndex: 0,
  range: null
})

const slashSearchRef = ref(null)

const slashCommands = [
  { id: 'text', title: '文本', desc: '普通段落文本', icon: Pilcrow, format: 'text', keywords: ['text', 'paragraph', 'p', '文本', '段落'] },
  { id: 'h1', title: '一级标题', desc: '大标题', icon: Heading1, format: 'h1', keywords: ['h1', 'title', 'heading', '标题'] },
  { id: 'h2', title: '二级标题', desc: '中标题', icon: Heading2, format: 'h2', keywords: ['h2', 'subtitle', 'heading', '标题'] },
  { id: 'h3', title: '三级标题', desc: '小标题', icon: Heading3, format: 'h3', keywords: ['h3', 'heading', '标题'] },
  { id: 'bold', title: '粗体', desc: '强调文本', icon: Bold, format: 'bold', keywords: ['bold', 'strong', '粗体', '加粗'] },
  { id: 'italic', title: '斜体', desc: '斜体文本', icon: Italic, format: 'italic', keywords: ['italic', 'em', '斜体'] },
  { id: 'highlight', title: '高亮', desc: '高亮文本', icon: Highlighter, format: 'highlight', keywords: ['highlight', 'mark', '高亮'] },
  { id: 'code', title: '行内代码', desc: '行内代码片段', icon: Code, format: 'code', keywords: ['code', 'inline', '代码'] },
  { id: 'codeblock', title: '代码块', desc: '多行代码块', icon: Code2, format: 'codeblock', keywords: ['codeblock', 'pre', 'code', '代码块'] },
  { id: 'quote', title: '引用', desc: '引用文本', icon: Quote, format: 'quote', keywords: ['quote', 'blockquote', '引用'] },
  { id: 'list', title: '无序列表', desc: '项目列表', icon: List, format: 'list', keywords: ['list', 'ul', 'bullet', '列表'] },
  { id: 'ordered', title: '有序列表', desc: '编号列表', icon: ListOrdered, format: 'ordered', keywords: ['ordered', 'ol', 'number', '编号'] },
  { id: 'todo', title: '待办事项', desc: '可勾选任务', icon: ListTodo, format: 'todo', keywords: ['todo', 'task', 'check', '待办', '任务'] },
  { id: 'hr', title: '分隔线', desc: '水平分隔线', icon: Minus, format: 'hr', keywords: ['hr', 'divider', 'separator', '分隔线'] },
  { id: 'link', title: '链接', desc: '插入链接', icon: Link, format: 'link', keywords: ['link', 'url', 'a', '链接'] }
]

const filteredSlashCommands = computed(() => {
  const q = slashMenu.value.query.toLowerCase().trim()
  if (!q) return slashCommands
  return slashCommands.filter(cmd => 
    cmd.title.toLowerCase().includes(q) || 
    cmd.desc.toLowerCase().includes(q) ||
    cmd.keywords.some(k => k.toLowerCase().includes(q))
  )
})

const editorPlaceholder = computed(() => {
  return content.value ? '' : "按 / 输入命令，或直接开始书写你的想法..."
})

const modeLabel = computed(() => {
  const labels = {
    edit: '纯文本编辑模式',
    live: '实时渲染编辑模式',
    preview: '预览模式'
  }
  return labels[editorMode.value]
})

const fontSize = computed(() => {
  const sizes = {
    small: '13px',
    medium: '14px',
    large: '16px'
  }
  return sizes[appStore.fontSize]
})

const showLineNumbers = computed(() => appStore.showLineNumbers)
const wordWrap = computed(() => appStore.wordWrap)
const spellCheckEnabled = computed(() => appStore.spellCheck)

const lineCount = computed(() => {
  return content.value.split('\n').length
})

const formatTools = [
  { id: 'h1', icon: Heading1, title: '一级标题' },
  { id: 'h2', icon: Heading2, title: '二级标题' },
  { id: 'h3', icon: Heading3, title: '三级标题' },
  { type: 'divider' },
  { id: 'bold', icon: Bold, title: '粗体' },
  { id: 'italic', icon: Italic, title: '斜体' },
  { id: 'code', icon: Code, title: '代码' },
  { type: 'divider' },
  { id: 'quote', icon: Quote, title: '引用' },
  { id: 'list', icon: List, title: '列表' },
  { id: 'todo', icon: CheckSquare, title: '待办' },
  { id: 'link', icon: Link, title: '链接' },
  { id: 'hr', icon: Minus, title: '分隔线' },
  { type: 'divider' },
  { id: 'codeblock', icon: Code2, title: '代码块' },
  { id: 'mermaid-flow', icon: GitBranch, title: '流程图' },
  { id: 'mermaid-pie', icon: PieChart, title: '饼图' },
  { id: 'mermaid-gantt', icon: BarChart3, title: '甘特图' }
]

const currentNote = computed(() => noteStore.currentNote)

const renderedContent = computed(() => {
  return renderMarkdown(content.value || '')
})

const outlineItems = computed(() => {
  const items = []
  const lines = content.value.split('\n')
  lines.forEach(line => {
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      items.push({
        level: match[1].length,
        text: match[2]
      })
    }
  })
  return items
})

const spellErrors = computed(() => {
  if (!spellCheckEnabled.value || editorMode.value !== 'edit') return []
  return appStore.getSpellErrors(content.value)
})

function setMode(mode) {
  const previousMode = editorMode.value
  editorMode.value = mode
  if (mode === 'live' && previousMode !== 'live') {
    nextTick(() => {
      updateLiveEditor()
    })
  }
}

async function updateLiveEditor() {
  if (!liveEditorRef.value) return
  liveEditorRef.value.innerHTML = renderedContent.value
  await nextTick()
  renderMermaidInContainer(liveEditorRef.value)
}

function onContentChange() {
  if (currentNote.value) {
    noteStore.updateNoteContent(currentNote.value.id, content.value)
  }
  autoResizeTextarea()
  if (spellUpdateTimeout) clearTimeout(spellUpdateTimeout)
  spellUpdateTimeout = setTimeout(() => updateSpellOverlay(), 200)
}

function autoResizeTextarea() {
  const textarea = editorRef.value
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = (textarea.scrollHeight + 2) + 'px'
}

function onEditorKeydown(e) {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'b') {
      e.preventDefault()
      applyFormat('bold')
    } else if (e.key === 'i') {
      e.preventDefault()
      applyFormat('italic')
    } else if (e.key === 'k') {
      e.preventDefault()
      applyFormat('link')
    }
  }
  
  if (e.key === 'Tab') {
    e.preventDefault()
    const textarea = editorRef.value
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selectedText = content.value.substring(start, end)
    const indentedText = selectedText.split('\n').map(line => '  ' + line).join('\n')
    content.value = content.value.substring(0, start) + indentedText + content.value.substring(end)
    nextTick(() => {
      textarea.selectionStart = start + 2
      textarea.selectionEnd = end + selectedText.split('\n').length * 2
    })
    onContentChange()
  }
}

function onLiveInput(e) {
  isLiveEditing.value = true
  if (liveInputTimeout) {
    clearTimeout(liveInputTimeout)
  }
  liveInputTimeout = setTimeout(() => {
    const html = e.target.innerHTML
    const text = htmlToMarkdown(html)
    if (text !== content.value) {
      content.value = text
      onContentChange()
    }
    isLiveEditing.value = false
  }, 300)
}

function onLiveKeydown(e) {
  if (slashMenu.value.show) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSlashMenu()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashMenu.value.activeIndex = Math.min(
        slashMenu.value.activeIndex + 1,
        filteredSlashCommands.value.length - 1
      )
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashMenu.value.activeIndex = Math.max(slashMenu.value.activeIndex - 1, 0)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filteredSlashCommands.value[slashMenu.value.activeIndex]
      if (cmd) executeSlashCommand(cmd)
      return
    }
  }
  
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'b') {
      e.preventDefault()
      applyFormat('bold')
    } else if (e.key === 'i') {
      e.preventDefault()
      applyFormat('italic')
    } else if (e.key === 'k') {
      e.preventDefault()
      applyFormat('link')
    } else if (e.key === 'e') {
      e.preventDefault()
      applyFormat('highlight')
    }
  }
  
  if (e.key === 'Tab') {
    e.preventDefault()
    document.execCommand('insertText', false, '  ')
  }
  
  if (e.key === 'Escape' && floatingToolbar.value.show) {
    floatingToolbar.value.show = false
  }
}

function onLiveKeyup(e) {
  if (e.key === '/' && !slashMenu.value.show) {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && sel.toString() === '') {
      const range = sel.getRangeAt(0)
      const text = range.startContainer.textContent || ''
      const offset = range.startOffset
      if (offset > 0 && text[offset - 1] === '/') {
        const rect = range.getBoundingClientRect()
        slashMenu.value = {
          show: true,
          x: rect.left,
          y: rect.bottom + 6,
          query: '',
          activeIndex: 0,
          range: range.cloneRange()
        }
        nextTick(() => {
          if (slashSearchRef.value) slashSearchRef.value.focus()
        })
      }
    }
  }
}

function onLiveMouseup() {
  setTimeout(() => {
    updateFloatingToolbar()
  }, 10)
}

function onLiveMousemove(e) {
  if (!floatingToolbar.value.show) return
  updateFloatingToolbar()
}

function updateFloatingToolbar() {
  if (editorMode.value !== 'live') {
    floatingToolbar.value.show = false
    return
  }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    floatingToolbar.value.show = false
    return
  }
  const text = sel.toString()
  if (!text || text.trim().length === 0) {
    floatingToolbar.value.show = false
    return
  }
  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  
  // 如果选区在视口顶部，工具栏显示在下方；否则显示在上方
  const showBelow = rect.top < 60
  const toolbarHeight = 40
  
  floatingToolbar.value = {
    show: true,
    x: rect.left + rect.width / 2,
    y: showBelow ? rect.bottom + 10 : rect.top - 10,
    placement: showBelow ? 'bottom' : 'top'
  }
}

function closeSlashMenu() {
  slashMenu.value.show = false
  slashMenu.value.query = ''
  slashMenu.value.activeIndex = 0
  if (liveEditorRef.value) liveEditorRef.value.focus()
}

function onSlashKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSlashMenu()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    slashMenu.value.activeIndex = Math.min(
      slashMenu.value.activeIndex + 1,
      filteredSlashCommands.value.length - 1
    )
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    slashMenu.value.activeIndex = Math.max(slashMenu.value.activeIndex - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const cmd = filteredSlashCommands.value[slashMenu.value.activeIndex]
    if (cmd) executeSlashCommand(cmd)
  }
}

function executeSlashCommand(cmd) {
  if (slashMenu.value.range) {
    const range = slashMenu.value.range
    range.deleteContents()
    
    let html = ''
    switch (cmd.format) {
      case 'text':
        html = '<p><br></p>'
        break
      case 'h1':
        html = '<h1>标题</h1>'
        break
      case 'h2':
        html = '<h2>标题</h2>'
        break
      case 'h3':
        html = '<h3>标题</h3>'
        break
      case 'bold':
        html = '<p><strong>粗体文本</strong></p>'
        break
      case 'italic':
        html = '<p><em>斜体文本</em></p>'
        break
      case 'highlight':
        html = '<p><mark>高亮文本</mark></p>'
        break
      case 'code':
        html = '<p><code>代码</code></p>'
        break
      case 'codeblock':
        html = '<pre><code>代码块</code></pre>'
        break
      case 'quote':
        html = '<blockquote>引用文本</blockquote>'
        break
      case 'list':
        html = '<ul><li>列表项</li></ul>'
        break
      case 'ordered':
        html = '<ol><li>编号项</li></ol>'
        break
      case 'todo':
        html = '<ul><li><input type="checkbox" disabled> 待办事项</li></ul>'
        break
      case 'hr':
        html = '<hr>'
        break
      case 'link':
        html = '<p><a href="https://">链接文本</a></p>'
        break
    }
    
    const fragment = range.createContextualFragment(html)
    range.insertNode(fragment)
    
    closeSlashMenu()
    nextTick(() => {
      if (liveEditorRef.value) {
        liveEditorRef.value.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
  } else {
    closeSlashMenu()
  }
}

function onLivePaste(e) {
  e.preventDefault()
  const text = e.clipboardData.getData('text/html') || e.clipboardData.getData('text/plain')
  if (text) {
    document.execCommand('insertHTML', false, text)
  }
}

function onContextMenu(e) {
  e.preventDefault()
  
  const hasSelection = checkHasSelection()
  contextMenu.value = {
    show: true,
    x: e.clientX,
    y: e.clientY,
    hasSelection: hasSelection
  }
}

function checkHasSelection() {
  if (editorMode.value === 'edit' && editorRef.value) {
    return editorRef.value.selectionStart !== editorRef.value.selectionEnd
  } else if (editorMode.value === 'live') {
    const selection = window.getSelection()
    return selection && selection.toString().length > 0
  }
  return false
}

function closeContextMenu() {
  contextMenu.value.show = false
}

function contextMenuAction(action) {
  closeContextMenu()
  nextTick(() => {
    if (action === 'copy') {
      document.execCommand('copy')
    } else if (action === 'cut') {
      document.execCommand('cut')
    } else if (action === 'paste') {
      document.execCommand('paste')
    } else if (action === 'selectAll') {
      if (editorMode.value === 'edit' && editorRef.value) {
        editorRef.value.select()
      } else if (editorMode.value === 'live' && liveEditorRef.value) {
        const range = document.createRange()
        range.selectNodeContents(liveEditorRef.value)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
    } else {
      applyFormat(action)
    }
  })
}

function onMouseMove(e) {
  if (!spellCheckEnabled.value || (editorMode.value !== 'edit' && editorMode.value !== 'live')) {
    scheduleHideSpellTooltip()
    return
  }
  
  if (contextMenu.value.show) return
  
  if (isMouseInSpellTooltip) return
  
  const textarea = editorMode.value === 'edit' ? editorRef.value : liveEditorRef.value
  if (!textarea) return
  
  const rect = textarea.getBoundingClientRect()
  const style = window.getComputedStyle(textarea)
  
  const paddingLeft = parseFloat(style.paddingLeft) || 0
  const paddingTop = parseFloat(style.paddingTop) || 0
  const borderWidth = parseFloat(style.borderTopWidth) || 0
  
  const relX = e.clientX - rect.left - paddingLeft - (parseFloat(style.borderLeftWidth) || 0)
  const relY = e.clientY - rect.top - paddingTop - borderWidth
  
  if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) {
    scheduleHideSpellTooltip()
    return
  }
  
  const errors = appStore.getSpellErrors(content.value)
  if (errors.length === 0) {
    scheduleHideSpellTooltip()
    return
  }
  
  const offset = getOffsetFromPoint(textarea, relX, relY)
  if (offset < 0) {
    scheduleHideSpellTooltip()
    return
  }
  
  for (const error of errors) {
    if (offset >= error.start && offset <= error.end) {
      showSpellTooltip(error.word, e.clientX, e.clientY)
      return
    }
  }
  
  scheduleHideSpellTooltip()
}

function showSpellTooltip(word, clientX, clientY) {
  if (spellTooltipHideTimeout) {
    clearTimeout(spellTooltipHideTimeout)
    spellTooltipHideTimeout = null
  }
  
  const tooltipWidth = 200
  const tooltipHeight = 120
  const margin = 8
  
  let x = clientX - tooltipWidth / 2
  let y = clientY + 16
  let placement = 'bottom'
  
  if (x < margin) x = margin
  if (x + tooltipWidth > window.innerWidth - margin) {
    x = window.innerWidth - tooltipWidth - margin
  }
  
  if (y + tooltipHeight > window.innerHeight - margin) {
    y = clientY - tooltipHeight - 16
    placement = 'top'
  }
  
  if (y < margin) {
    y = margin
  }
  
  spellTooltip.value = {
    show: true,
    x,
    y,
    word,
    placement
  }
}

function scheduleHideSpellTooltip() {
  if (spellTooltipHideTimeout) return
  spellTooltipHideTimeout = setTimeout(() => {
    spellTooltip.value.show = false
    spellTooltipHideTimeout = null
  }, 500)
}

function onSpellTooltipEnter() {
  isMouseInSpellTooltip = true
  if (spellTooltipHideTimeout) {
    clearTimeout(spellTooltipHideTimeout)
    spellTooltipHideTimeout = null
  }
}

function onSpellTooltipLeave() {
  isMouseInSpellTooltip = false
  scheduleHideSpellTooltip()
}

function getOffsetFromPoint(textarea, x, y) {
  const style = window.getComputedStyle(textarea)
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.7)
  const fontSize = parseFloat(style.fontSize)
  const fontFamily = style.fontFamily
  
  const scrollTop = textarea.scrollTop
  const scrollLeft = textarea.scrollLeft
  
  const adjustedY = y + scrollTop
  const adjustedX = x + scrollLeft
  
  const lines = textarea.value.split('\n')
  const lineIndex = Math.floor(adjustedY / lineHeight)
  
  if (lineIndex < 0 || lineIndex >= lines.length) return -1
  
  const line = lines[lineIndex]
  
  if (!canvasMeasureCtx) {
    const canvas = document.createElement('canvas')
    canvasMeasureCtx = canvas.getContext('2d')
  }
  canvasMeasureCtx.font = `${fontSize}px ${fontFamily}`
  
  let colIndex = 0
  let width = 0
  for (let i = 0; i < line.length; i++) {
    const charWidth = canvasMeasureCtx.measureText(line[i]).width
    if (width + charWidth / 2 > adjustedX) {
      colIndex = i
      break
    }
    width += charWidth
    colIndex = i + 1
  }
  
  let offset = 0
  for (let i = 0; i < lineIndex; i++) {
    offset += lines[i].length + 1
  }
  offset += colIndex
  
  return offset
}

function hideSpellTooltip() {
  if (spellTooltip.value.show) spellTooltip.value.show = false
}

function updateSpellOverlay() {
  if (!spellOverlayRef.value) return
  if (editorMode.value !== 'edit' || !spellCheckEnabled.value) {
    spellOverlayRef.value.innerHTML = ''
    return
  }
  
  const text = content.value
  const errors = appStore.getSpellErrors(text)
  
  if (errors.length === 0) {
    spellOverlayRef.value.innerHTML = ''
    return
  }
  
  const escapeHtml = (str) => {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }
  
  let html = ''
  let lastEnd = 0
  
  const sortedErrors = [...errors].sort((a, b) => a.start - b.start)
  
  for (const error of sortedErrors) {
    if (error.start < lastEnd) continue
    html += escapeHtml(text.substring(lastEnd, error.start))
    html += `<span class="spell-error">${escapeHtml(error.word)}</span>`
    lastEnd = error.end
  }
  html += escapeHtml(text.substring(lastEnd))
  
  spellOverlayRef.value.innerHTML = html
}

function syncSpellOverlay() {
  if (spellOverlayRef.value && editorRef.value) {
    spellOverlayRef.value.scrollTop = editorRef.value.scrollTop
    spellOverlayRef.value.scrollLeft = editorRef.value.scrollLeft
  }
}

function ignoreWord(word) {
  appStore.ignoreWord(word)
  spellTooltip.value.show = false
  nextTick(() => updateSpellOverlay())
}

function addToDictionary(word) {
  appStore.addToDictionary(word)
  spellTooltip.value.show = false
  nextTick(() => updateSpellOverlay())
}

function handleIgnoreWord() {
  if (spellTooltipHideTimeout) {
    clearTimeout(spellTooltipHideTimeout)
    spellTooltipHideTimeout = null
  }
  ignoreWord(spellTooltip.value.word)
}

function handleAddToDictionary() {
  if (spellTooltipHideTimeout) {
    clearTimeout(spellTooltipHideTimeout)
    spellTooltipHideTimeout = null
  }
  addToDictionary(spellTooltip.value.word)
}

function htmlToMarkdown(html) {
  let text = html
    .replace(/<h1[^>]*>/gi, '# ')
    .replace(/<\/h1>/gi, '\n\n')
    .replace(/<h2[^>]*>/gi, '## ')
    .replace(/<\/h2>/gi, '\n\n')
    .replace(/<h3[^>]*>/gi, '### ')
    .replace(/<\/h3>/gi, '\n\n')
    .replace(/<h4[^>]*>/gi, '#### ')
    .replace(/<\/h4>/gi, '\n\n')
    .replace(/<h5[^>]*>/gi, '##### ')
    .replace(/<\/h5>/gi, '\n\n')
    .replace(/<h6[^>]*>/gi, '###### ')
    .replace(/<\/h6>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong[^>]*>/gi, '**')
    .replace(/<\/strong>/gi, '**')
    .replace(/<b[^>]*>/gi, '**')
    .replace(/<\/b>/gi, '**')
    .replace(/<em[^>]*>/gi, '*')
    .replace(/<\/em>/gi, '*')
    .replace(/<i[^>]*>/gi, '*')
    .replace(/<\/i>/gi, '*')
    .replace(/<mark[^>]*>/gi, '==')
    .replace(/<\/mark>/gi, '==')
    .replace(/<del[^>]*>/gi, '~~')
    .replace(/<\/del>/gi, '~~')
    .replace(/<s[^>]*>/gi, '~~')
    .replace(/<\/s>/gi, '~~')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<pre[^>]*>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<ul[^>]*>/gi, '\n')
    .replace(/<\/ul>/gi, '\n')
    .replace(/<ol[^>]*>/gi, '\n')
    .replace(/<\/ol>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<blockquote[^>]*>/gi, '> ')
    .replace(/<\/blockquote>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n---\n')
    .replace(/<input[^>]*checked[^>]*type="checkbox"[^>]*>/gi, '- [x] ')
    .replace(/<input[^>]*type="checkbox"[^>]*>/gi, '- [ ] ')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '[$2]($1)')
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, '![]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  
  return text
}

function applyFormat(format) {
  if (editorMode.value === 'edit') {
    applyFormatToTextarea(format)
  } else if (editorMode.value === 'live') {
    applyFormatToLive(format)
  }
}

function applyFormatToTextarea(format) {
  const textarea = editorRef.value
  if (!textarea) return
  
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selectedText = content.value.substring(start, end)
  let newText = ''
  let cursorOffset = 0
  
  switch (format) {
    case 'h1':
      newText = `# ${selectedText || '标题'}`
      cursorOffset = selectedText ? 0 : 3
      break
    case 'h2':
      newText = `## ${selectedText || '标题'}`
      cursorOffset = selectedText ? 0 : 4
      break
    case 'h3':
      newText = `### ${selectedText || '标题'}`
      cursorOffset = selectedText ? 0 : 5
      break
    case 'bold':
      newText = `**${selectedText || '粗体文本'}**`
      cursorOffset = selectedText ? 0 : 2
      break
    case 'italic':
      newText = `*${selectedText || '斜体文本'}*`
      cursorOffset = selectedText ? 0 : 1
      break
    case 'underline':
      newText = `<u>${selectedText || '下划线文本'}</u>`
      cursorOffset = selectedText ? 0 : 3
      break
    case 'code':
      newText = `\`${selectedText || '代码'}\``
      cursorOffset = selectedText ? 0 : 1
      break
    case 'quote':
      newText = `> ${selectedText || '引用文本'}`
      cursorOffset = selectedText ? 0 : 2
      break
    case 'link':
      newText = `[${selectedText || '链接文本'}](url)`
      cursorOffset = selectedText ? 0 : 1
      break
    case 'list':
      newText = `- ${selectedText || '列表项'}`
      cursorOffset = selectedText ? 0 : 2
      break
    case 'ordered':
      newText = `1. ${selectedText || '编号项'}`
      cursorOffset = selectedText ? 0 : 3
      break
    case 'todo':
      newText = `- [ ] ${selectedText || '待办事项'}`
      cursorOffset = selectedText ? 0 : 6
      break
    case 'highlight':
      newText = `==${selectedText || '高亮文本'}==`
      cursorOffset = selectedText ? 0 : 2
      break
    case 'strikethrough':
      newText = `~~${selectedText || '删除线文本'}~~`
      cursorOffset = selectedText ? 0 : 2
      break
    case 'codeblock':
      newText = `\n\`\`\`\n${selectedText || '代码块'}\n\`\`\`\n`
      cursorOffset = selectedText ? 0 : 5
      break
    case 'hr':
      newText = '\n---\n'
      cursorOffset = 4
      break
    case 'mermaid-flow':
      newText = `\n\`\`\`mermaid
flowchart TD
    A[开始] --> B{判断}
    B -->|是| C[处理]
    B -->|否| D[结束]
    C --> D
\`\`\`\n`
      cursorOffset = 5
      break
    case 'mermaid-pie':
      newText = `\n\`\`\`mermaid
pie title 项目分布
    "前端" : 40
    "后端" : 30
    "设计" : 20
    "测试" : 10
\`\`\`\n`
      cursorOffset = 5
      break
    case 'mermaid-gantt':
      newText = `\n\`\`\`mermaid
gantt
    title 项目计划
    dateFormat YYYY-MM-DD
    section 设计
    需求分析 :a1, 2024-01-01, 7d
    UI设计 :a2, after a1, 5d
    section 开发
    前端开发 :b1, after a2, 14d
    后端开发 :b2, after a2, 14d
\`\`\`\n`
      cursorOffset = 5
      break
  }
  
  const lineStart = content.value.lastIndexOf('\n', start - 1) + 1
  const lineEnd = content.value.indexOf('\n', end)
  
  if ((format === 'list' || format === 'ordered' || format === 'quote' || format === 'todo') && !selectedText) {
    content.value = content.value.substring(0, lineStart) + newText + content.value.substring(lineEnd === -1 ? content.value.length : lineEnd)
  } else {
    content.value = content.value.substring(0, start) + newText + content.value.substring(end)
  }
  
  nextTick(() => {
    textarea.focus()
    const pos = start + (selectedText ? newText.length : cursorOffset)
    textarea.setSelectionRange(pos, pos)
  })
  
  onContentChange()
}

function applyFormatToLive(format) {
  const editor = liveEditorRef.value
  if (!editor) return
  
  editor.focus()
  
  switch (format) {
    case 'h1':
      document.execCommand('formatBlock', false, 'h1')
      break
    case 'h2':
      document.execCommand('formatBlock', false, 'h2')
      break
    case 'h3':
      document.execCommand('formatBlock', false, 'h3')
      break
    case 'bold':
      document.execCommand('bold', false)
      break
    case 'italic':
      document.execCommand('italic', false)
      break
    case 'underline':
      document.execCommand('underline', false)
      break
    case 'code':
      document.execCommand('formatBlock', false, 'code')
      break
    case 'quote':
      document.execCommand('formatBlock', false, 'blockquote')
      break
    case 'link':
      const url = prompt('请输入链接地址:', 'https://')
      if (url) {
        document.execCommand('createLink', false, url)
      }
      break
    case 'list':
      document.execCommand('insertUnorderedList', false)
      break
    case 'ordered':
      document.execCommand('insertOrderedList', false)
      break
    case 'todo':
      document.execCommand('insertHTML', false, '<input type="checkbox" disabled> ')
      break
    case 'highlight':
      document.execCommand('hiliteColor', false, '#fff3cd')
      break
    case 'strikethrough':
      document.execCommand('strikeThrough', false)
      break
    case 'hr':
      document.execCommand('insertHTML', false, '<hr>')
      break
    case 'codeblock':
    case 'mermaid-flow':
    case 'mermaid-pie':
    case 'mermaid-gantt':
      applyFormatToTextarea(format)
      return
  }
  
  setTimeout(() => {
    if (floatingToolbar.value.show) {
      nextTick(() => updateFloatingToolbar())
    }
    onContentChange()
  }, 50)
}

function scrollToHeading(item) {
  if (editorMode.value === 'edit' && editorRef.value) {
    const lines = content.value.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(item.text)) {
        const textarea = editorRef.value
        const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight)
        textarea.scrollTop = i * lineHeight
        break
      }
    }
  } else if (editorMode.value === 'preview') {
    const headings = document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6')
    for (const h of headings) {
      if (h.textContent.includes(item.text)) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' })
        break
      }
    }
  }
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

function handleGlobalClick() {
  if (spellTooltip.value.show) spellTooltip.value.show = false
  if (floatingToolbar.value.show) floatingToolbar.value.show = false
  if (slashMenu.value.show) closeSlashMenu()
}

let toolbarTimeout = null

function handleGlobalSelectionChange() {
  if (slashMenu.value.show) return
  if (editorMode.value !== 'live') return
  if (isMouseDown.value) return
  
  if (toolbarTimeout) clearTimeout(toolbarTimeout)
  toolbarTimeout = setTimeout(() => updateFloatingToolbar(), 150)
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

watch(content, (newContent) => {
  if (editorMode.value === 'live' && liveEditorRef.value && !isLiveEditing.value) {
    updateLiveEditor()
  }
  if (editorMode.value === 'edit') {
    nextTick(() => {
      autoResizeTextarea()
      updateSpellOverlay()
    })
  }
  if (spellUpdateTimeout) clearTimeout(spellUpdateTimeout)
  spellUpdateTimeout = setTimeout(() => updateSpellOverlay(), 200)
})

watch(editorMode, (newMode) => {
  if (newMode === 'edit') {
    nextTick(() => {
      autoResizeTextarea()
      updateSpellOverlay()
    })
  } else if (spellOverlayRef.value) {
    spellOverlayRef.value.innerHTML = ''
  }
})

watch(spellCheckEnabled, () => {
  nextTick(() => updateSpellOverlay())
})

watch(() => appStore.fontSize, () => {
  if (editorMode.value === 'edit') {
    nextTick(() => autoResizeTextarea())
  }
})

watch(wordWrap, () => {
  if (editorMode.value === 'edit') {
    nextTick(() => autoResizeTextarea())
  }
})

onMounted(() => {
  if (currentNote.value) {
    content.value = currentNote.value.content
  }
  
  nextTick(() => {
    if (editorMode.value === 'live' && liveEditorRef.value) {
      updateLiveEditor()
    }
    if (editorMode.value === 'edit') {
      autoResizeTextarea()
    }
    updateSpellOverlay()
  })
  
  document.addEventListener('click', handleGlobalClick)
  document.addEventListener('selectionchange', handleGlobalSelectionChange)
  document.addEventListener('mousedown', handleMouseDown)
  document.addEventListener('mouseup', handleMouseUp)
})

onUnmounted(() => {
  document.removeEventListener('click', handleGlobalClick)
  document.removeEventListener('selectionchange', handleGlobalSelectionChange)
  document.removeEventListener('mousedown', handleMouseDown)
  document.removeEventListener('mouseup', handleMouseUp)
  if (spellUpdateTimeout) clearTimeout(spellUpdateTimeout)
  if (liveInputTimeout) clearTimeout(liveInputTimeout)
  if (toolbarTimeout) clearTimeout(toolbarTimeout)
})

function handleMouseDown(e) {
  isMouseDown.value = true
}

function handleMouseUp(e) {
  isMouseDown.value = false
  if (editorMode.value === 'live' && !slashMenu.value.show) {
    setTimeout(() => updateFloatingToolbar(), 100)
  }
}</script>

<style scoped>
.outline-item-active {
  background: var(--color-primary-lightest);
}

.live-editor {
  font-family: var(--font-body);
  outline: none;
}

.live-editor:focus {
  outline: none;
}

.live-editor :deep(h1) {
  font-size: 24px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 24px;
  line-height: 1.3;
}

.live-editor :deep(h2) {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 12px;
  line-height: 1.4;
}

.live-editor :deep(h3) {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 12px;
  line-height: 1.4;
}

.live-editor :deep(h4),
.live-editor :deep(h5),
.live-editor :deep(h6) {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 12px;
  line-height: 1.4;
}

.live-editor :deep(p) {
  margin: 0 0 16px;
  line-height: 1.7;
}

.live-editor :deep(strong) {
  font-weight: 600;
}

.live-editor :deep(em) {
  font-style: italic;
}

.live-editor :deep(code) {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--color-bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
}

.live-editor :deep(pre) {
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
  padding: 16px;
  margin-bottom: 16px;
  overflow-x: auto;
}

.live-editor :deep(pre code) {
  background: transparent;
  padding: 0;
}

.live-editor :deep(mark) {
  background: rgba(255, 235, 59, 0.4);
  padding: 1px 4px;
  border-radius: 2px;
}

.live-editor :deep(del),
.live-editor :deep(s) {
  text-decoration: line-through;
  color: var(--color-text-tertiary);
}

.live-editor :deep(ul) {
  margin: 0 0 16px;
  padding-left: 24px;
}

.live-editor :deep(ol) {
  margin: 0 0 16px;
  padding-left: 24px;
}

.live-editor :deep(li) {
  margin: 4px 0;
}

.live-editor :deep(blockquote) {
  padding: 12px 16px;
  border-left: 3px solid var(--color-primary);
  background: var(--color-primary-surface);
  margin: 0 0 16px;
}

.live-editor :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 24px 0;
}

.live-editor :deep(input[type="checkbox"]) {
  margin-right: 8px;
  cursor: pointer;
}

.live-editor :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s ease;
}

.live-editor :deep(a:hover) {
  border-bottom-color: var(--color-primary);
}

.live-editor :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-sm);
}

.live-editor :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  margin-bottom: 24px;
}

.live-editor :deep(th) {
  text-align: left;
  padding: 8px 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border-light);
}

.live-editor :deep(td) {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border-light);
  color: var(--color-text-primary);
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 6px;
  transition: background-color 0.15s ease;
}

.context-menu-item:hover {
  background: var(--color-surface-hover);
}

.context-menu-item svg {
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.context-menu-shortcut {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

.context-menu-label {
  padding: 6px 10px 4px;
  font-size: 10px;
  font-weight: 500;
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.context-menu-divider {
  height: 1px;
  background: var(--color-border-light);
  margin: 4px 6px;
}

.spell-tooltip-header {
  padding: 6px 10px 2px;
}

.spell-tooltip-word {
  padding: 0 10px 6px;
  border-bottom: 1px solid var(--color-border-light);
  margin-bottom: 4px;
}

.spell-overlay {
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  letter-spacing: normal;
  text-rendering: optimizeSpeed;
  tab-size: 4;
  -moz-tab-size: 4;
}

.spell-overlay .spell-error {
  background: transparent;
  cursor: pointer;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Notion 风格占位符 */
.notion-editor:empty::before {
  content: attr(data-placeholder);
  color: var(--color-text-tertiary);
  pointer-events: none;
  display: block;
  position: absolute;
  top: 0;
  left: 0;
}

/* 悬浮工具栏 */
.floating-toolbar {
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

.ft-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s ease;
}

.ft-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.ft-btn:active {
  transform: scale(0.92);
}

.ft-divider {
  width: 1px;
  height: 16px;
  background: var(--color-border);
  margin: 0 2px;
}

.floating-toolbar-arrow {
  position: absolute;
  bottom: -5px;
  left: 50%;
  transform: translateX(-50%) rotate(45deg);
  width: 10px;
  height: 10px;
  background: var(--card-bg);
  border-right: 1px solid var(--card-border);
  border-bottom: 1px solid var(--card-border);
}

.floating-toolbar-arrow.arrow-bottom {
  bottom: auto;
  top: -5px;
  border-right: none;
  border-bottom: none;
  border-left: 1px solid var(--card-border);
  border-top: 1px solid var(--card-border);
}

/* 斜杠命令菜单 */
.slash-menu {
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  display: flex;
  flex-direction: column;
}

.slash-menu-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-light);
  color: var(--color-text-tertiary);
}

.slash-search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--color-text-primary);
  font-family: var(--font-body);
}

.slash-search-input::placeholder {
  color: var(--color-text-tertiary);
}

.slash-menu-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
  max-height: 260px;
}

.slash-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.slash-menu-item.active {
  background: var(--color-surface-hover);
}

.slash-menu-icon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.slash-menu-item.active .slash-menu-icon {
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.slash-menu-text {
  flex: 1;
  min-width: 0;
}

.slash-menu-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  line-height: 1.3;
}

.slash-menu-desc {
  font-size: 11px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

.slash-menu-empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

/* Notion 风格 live editor 优化 */
.live-editor.notion-editor {
  caret-color: var(--color-primary);
}

.live-editor.notion-editor :deep(h1) {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text-primary);
  margin: 32px 0 12px;
  line-height: 1.3;
  letter-spacing: -0.01em;
}

.live-editor.notion-editor :deep(h2) {
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text-primary);
  margin: 24px 0 8px;
  line-height: 1.35;
  letter-spacing: -0.005em;
}

.live-editor.notion-editor :deep(h3) {
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 20px 0 6px;
  line-height: 1.4;
}

.live-editor.notion-editor :deep(p) {
  margin: 0 0 8px;
  line-height: 1.7;
}

.live-editor.notion-editor :deep(p:last-child) {
  margin-bottom: 0;
}

.live-editor.notion-editor :deep(blockquote) {
  border-left: 3px solid var(--color-text-tertiary);
  background: transparent;
  padding: 4px 14px;
  margin: 8px 0;
  color: var(--color-text-secondary);
  font-style: normal;
}

.live-editor.notion-editor :deep(blockquote p) {
  margin: 0;
}

.live-editor.notion-editor :deep(ul),
.live-editor.notion-editor :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 28px;
}

.live-editor.notion-editor :deep(li) {
  margin: 2px 0;
  padding-left: 2px;
}

.live-editor.notion-editor :deep(input[type="checkbox"]) {
  margin-right: 8px;
  width: 14px;
  height: 14px;
  vertical-align: middle;
  accent-color: var(--color-primary);
  cursor: pointer;
}

.live-editor.notion-editor :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--color-bg-tertiary);
  color: var(--state-error);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--color-border-light);
}

.live-editor.notion-editor :deep(pre) {
  background: rgba(247, 246, 243, 0.95);
  border: 1px solid var(--color-border-light);
  border-radius: 8px;
  padding: 14px 16px;
  margin: 8px 0;
  overflow-x: auto;
  font-size: 13px;
}

.live-editor.notion-editor :deep(pre code) {
  background: transparent;
  color: var(--color-text-primary);
  padding: 0;
  border: none;
  font-size: 13px;
}

.live-editor.notion-editor :deep(mark) {
  background: rgba(255, 213, 79, 0.4);
  color: inherit;
  padding: 1px 4px;
  border-radius: 3px;
}

.live-editor.notion-editor :deep(u) {
  text-decoration-color: var(--color-primary);
  text-decoration-thickness: 1.5px;
}

.live-editor.notion-editor :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 24px 0;
}

.live-editor.notion-editor :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s ease;
}

.live-editor.notion-editor :deep(a:hover) {
  border-bottom-color: var(--color-primary);
}

/* Notion 预览模式 */
.notion-preview h1 {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 36px 0 16px;
}

.notion-preview h2 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 28px 0 10px;
}

.notion-preview h3 {
  font-size: 18px;
  font-weight: 600;
  margin: 22px 0 8px;
}

.notion-preview p {
  margin: 0 0 12px;
}

.notion-preview blockquote {
  border-left: 3px solid var(--color-text-tertiary);
  background: transparent;
  padding: 4px 14px;
  margin: 12px 0;
  font-style: normal;
}

.notion-preview code {
  font-size: 0.85em;
  background: var(--color-bg-tertiary);
  color: var(--state-error);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--color-border-light);
}

.notion-preview pre {
  background: rgba(247, 246, 243, 0.95);
  border: 1px solid var(--color-border-light);
  border-radius: 8px;
  padding: 14px 16px;
  margin: 12px 0;
}

.notion-preview ul,
.notion-preview ol {
  margin: 8px 0 12px;
  padding-left: 28px;
}

.notion-preview li {
  margin: 4px 0;
}

/* 暗色模式调整 */
[data-theme='dark'] .live-editor.notion-editor pre {
  background: rgba(30, 30, 45, 0.6);
}

[data-theme='dark'] .notion-preview pre {
  background: rgba(30, 30, 45, 0.6);
}
</style>
