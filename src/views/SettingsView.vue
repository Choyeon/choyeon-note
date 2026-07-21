<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-14 px-8 py-3 flex items-center gap-2.5 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        @click="$router.back()"
      >
        <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <h1 class="text-2xl font-bold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">设置</h1>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar acrylic-content">
      <div class="max-w-[720px] mx-auto px-8 py-8 pb-20">
        <div class="mb-8">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <SunMoon class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">外观</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Palette class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">主题模式</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">选择您喜欢的界面主题</div>
                </div>
              </div>
              <div class="segmented-control">
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.theme === 'light' }"
                  @click="appStore.setTheme('light')"
                >浅色</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.theme === 'dark' }"
                  @click="appStore.setTheme('dark')"
                >深色</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.theme === 'system' }"
                  @click="appStore.setTheme('system')"
                >系统</button>
              </div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Palette class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">强调色</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">自定义界面的主色调</div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <div 
                  v-for="color in appStore.accentColors" 
                  :key="color"
                  class="accent-circle"
                  :class="{ selected: appStore.accentColor === color }"
                  :style="{ background: color }"
                  @click="appStore.setAccentColor(color)"
                >
                  <svg v-if="appStore.accentColor === color" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
              </div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Type class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">字体大小</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">调整编辑器文字大小</div>
                </div>
              </div>
              <div class="segmented-control">
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.fontSize === 'small' }"
                  @click="appStore.setFontSize('small')"
                >小</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.fontSize === 'medium' }"
                  @click="appStore.setFontSize('medium')"
                >中</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.fontSize === 'large' }"
                  @click="appStore.setFontSize('large')"
                >大</button>
              </div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Layers class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">毛玻璃效果</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">启用半透明背景模糊</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                :aria-checked="appStore.glassEffect"
                @click="appStore.toggleGlassEffect()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </div>
        </div>

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <FileCode class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">编辑器</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <FileText class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">默认扩展名</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">新建笔记时使用的文件格式</div>
                </div>
              </div>
              <div class="inline-flex items-center px-3 py-1.5 rounded-lg font-mono text-[13px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">.md</div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <SpellCheck class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">拼写检查</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">检测并标记英文拼写错误</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                :aria-checked="appStore.spellCheck"
                @click="appStore.toggleSpellCheck()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Save class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动保存</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">编辑时自动保存更改</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                :aria-checked="appStore.autoSave"
                @click="appStore.toggleAutoSave()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <ListOrdered class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">行号显示</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">在编辑模式显示行号</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                :aria-checked="appStore.showLineNumbers"
                @click="appStore.toggleLineNumbers()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <WrapText class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动换行</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">长文本自动换行显示</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                :aria-checked="appStore.wordWrap"
                @click="appStore.toggleWordWrap()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </div>
        </div>

        <div class="mb-8" v-if="isElectron">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <FolderOpen class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">文件与同步</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Folder class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">笔记存储位置</div>
                  <div class="text-[12px] mt-0.5 font-mono" :style="{ color: 'var(--color-text-tertiary)' }">{{ appStore.notesLocation || '未设置' }}</div>
                </div>
              </div>
              <button 
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95"
                :style="{ background: 'var(--color-primary)', color: 'white' }"
                @click="changeNotesLocation"
              >
                <FolderOpen class="w-3.5 h-3.5" />
                <span>更改</span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <RefreshCw class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动同步</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">检测文件变化并自动刷新</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                :aria-checked="appStore.autoSync"
                @click="appStore.toggleAutoSync()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Paperclip class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">附件文件夹</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">存放图片和附件的目录</div>
                </div>
              </div>
              <div class="inline-flex items-center px-3 py-1.5 rounded-lg font-mono text-[13px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">attachments</div>
            </div>
          </div>
        </div>

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <Keyboard class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">快捷键</h2>
          </div>
          
          <div class="mb-3">
            <div class="relative">
              <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
              <input 
                v-model="shortcutSearch"
                type="text"
                placeholder="搜索快捷键..."
                class="shortcut-search w-full h-10 pl-9 pr-4 rounded-lg text-[13px] outline-none transition-all duration-200"
                :style="{ 
                  background: 'var(--color-bg-secondary)', 
                  color: 'var(--color-text-primary)'
                }"
              />
            </div>
          </div>

          <div 
            v-for="category in filteredShortcutCategories" 
            :key="category.name"
            class="settings-card mb-3"
          >
            <div class="px-5 py-3 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
              <div class="flex items-center gap-2">
                <component :is="category.icon" class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
                <span class="text-[13px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">{{ category.name }}</span>
              </div>
            </div>
            <div class="divide-y" :style="{ borderColor: 'var(--color-border-light)' }">
              <div 
                v-for="shortcut in category.items" 
                :key="shortcut.command"
                class="flex items-center justify-between px-5 py-3 transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                <span class="text-[13px]" :style="{ color: 'var(--color-text-primary)' }">{{ shortcut.command }}</span>
                <div class="flex items-center gap-1">
                  <span 
                    v-for="(key, idx) in shortcut.keys" 
                    :key="key"
                    class="kbd-key"
                  >
                    {{ key }}
                    <span v-if="idx < shortcut.keys.length - 1" class="mx-1" :style="{ color: 'var(--color-text-tertiary)' }">+</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="filteredShortcutCategories.length === 0" class="settings-card py-10 text-center">
            <Search class="w-8 h-8 mx-auto mb-2" :style="{ color: 'var(--color-text-tertiary)' }" />
            <p class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">未找到匹配的快捷键</p>
          </div>
        </div>

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'rgba(255,112,67,0.1)' }">
              <RotateCcw class="w-4 h-4" :style="{ color: 'var(--state-warning)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">高级</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <AlertTriangle class="w-4 h-4" :style="{ color: 'var(--state-warning)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">重置应用</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">清除所有配置并返回欢迎页</div>
                </div>
              </div>
              <button 
                class="px-4 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
                :style="{ background: 'rgba(255,112,67,0.1)', color: 'var(--state-warning)' }"
                @click="resetApp"
              >
                重置
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">Choyeon Notes</span>
      <span class="cho-statusbar-meta">v1.0.0</span>
    </div>
  </div>

  <Teleport to="body">
    <Transition name="fade">
      <div 
        v-if="showResetConfirm" 
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="cancelReset"
      >
        <div 
          class="w-[440px] rounded-2xl overflow-hidden shadow-2xl"
          :style="{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }"
        >
          <div class="px-6 py-5 text-center">
            <div 
              class="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
              :style="{ background: 'rgba(255,112,67,0.1)' }"
            >
              <AlertTriangle class="w-7 h-7" :style="{ color: 'var(--state-warning)' }" />
            </div>
            <h3 class="text-[17px] font-semibold mb-2" :style="{ color: 'var(--color-text-primary)' }">确认重置应用？</h3>
            <p class="text-[13px] leading-relaxed" :style="{ color: 'var(--color-text-secondary)' }">
              重置将清除所有配置并返回欢迎页面。<br/>笔记文件不会被删除，但应用将不再管理它们。
            </p>
          </div>
          <div 
            class="px-5 py-4 flex items-center gap-3 border-t"
            :style="{ borderColor: 'var(--color-border)' }"
          >
            <button 
              class="flex-1 py-2.5 rounded-xl text-[13px] font-medium cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-[0.98]"
              :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }"
              @click="cancelReset"
            >
              取消
            </button>
            <button 
              class="flex-1 py-2.5 rounded-xl text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-[0.98]"
              :style="{ background: 'var(--state-warning)', color: '#fff' }"
              @click="confirmReset"
            >
              确认重置
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useNoteStore } from '@/stores/note'
import { 
  ArrowLeft, SunMoon, Palette, Type, Layers, 
  FileCode, SpellCheck, Save, ListOrdered, WrapText,
  FolderOpen, RefreshCw, Paperclip, Folder, AlertTriangle, RotateCcw,
  Keyboard, Search, FileText, Edit, Eye, Navigation, Zap
} from 'lucide-vue-next'

const router = useRouter()
const appStore = useAppStore()
const noteStore = useNoteStore()
const showResetConfirm = ref(false)
const shortcutSearch = ref('')
const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI)

const shortcutCategories = [
  {
    name: '通用',
    icon: Zap,
    items: [
      { command: '新建笔记', keys: ['Ctrl', 'N'] },
      { command: '搜索笔记', keys: ['Ctrl', 'P'] },
      { command: '保存', keys: ['Ctrl', 'S'] },
      { command: '命令面板', keys: ['Ctrl', 'Shift', 'P'] },
      { command: '切换主题', keys: ['Ctrl', 'T'] },
      { command: '撤销', keys: ['Ctrl', 'Z'] },
      { command: '重做', keys: ['Ctrl', 'Shift', 'Z'] }
    ]
  },
  {
    name: '编辑器',
    icon: Edit,
    items: [
      { command: '粗体', keys: ['Ctrl', 'B'] },
      { command: '斜体', keys: ['Ctrl', 'I'] },
      { command: '下划线', keys: ['Ctrl', 'U'] },
      { command: '删除线', keys: ['Ctrl', 'Shift', 'S'] },
      { command: '行内代码', keys: ['Ctrl', 'E'] },
      { command: '链接', keys: ['Ctrl', 'K'] },
      { command: '高亮', keys: ['Ctrl', 'Shift', 'H'] },
      { command: '一级标题', keys: ['Ctrl', '1'] },
      { command: '二级标题', keys: ['Ctrl', '2'] },
      { command: '三级标题', keys: ['Ctrl', '3'] },
      { command: '引用', keys: ['Ctrl', 'Q'] },
      { command: '无序列表', keys: ['Ctrl', 'L'] },
      { command: '任务列表', keys: ['Ctrl', 'Shift', 'L'] },
      { command: '代码块', keys: ['Ctrl', 'Shift', 'C'] }
    ]
  },
  {
    name: '视图切换',
    icon: Eye,
    items: [
      { command: '编辑模式', keys: ['Ctrl', 'Alt', '1'] },
      { command: '实时模式', keys: ['Ctrl', 'Alt', '2'] },
      { command: '预览模式', keys: ['Ctrl', 'Alt', '3'] },
      { command: '切换侧边栏', keys: ['Ctrl', '\\'] }
    ]
  },
  {
    name: '导航',
    icon: Navigation,
    items: [
      { command: '笔记列表', keys: ['Ctrl', 'Shift', 'N'] },
      { command: '日历视图', keys: ['Ctrl', 'Shift', 'D'] },
      { command: '知识图谱', keys: ['Ctrl', 'Shift', 'G'] },
      { command: '标签管理', keys: ['Ctrl', 'Shift', 'T'] },
      { command: '设置', keys: ['Ctrl', ','] },
      { command: '返回', keys: ['Alt', '←'] },
      { command: '前进', keys: ['Alt', '→'] }
    ]
  }
]

const filteredShortcutCategories = computed(() => {
  if (!shortcutSearch.value.trim()) return shortcutCategories
  
  const query = shortcutSearch.value.toLowerCase()
  return shortcutCategories.map(cat => ({
    ...cat,
    items: cat.items.filter(item => 
      item.command.toLowerCase().includes(query) ||
      item.keys.some(k => k.toLowerCase().includes(query))
    )
  })).filter(cat => cat.items.length > 0)
})

async function changeNotesLocation() {
  if (!window.electronAPI) {
    alert('请在 Electron 环境中使用此功能')
    return
  }
  
  const path = await window.electronAPI.selectNotesPath()
  if (path) {
    appStore.saveNotesLocation(path)
    await noteStore.loadNotesFromPath(path)
    router.push('/notes')
  }
}

function resetApp() {
  showResetConfirm.value = true
}

function confirmReset() {
  appStore.resetConfig()
  noteStore.notes = []
  noteStore.currentNoteId = null
  noteStore.notesPath = null
  showResetConfirm.value = false
  router.push('/')
}

function cancelReset() {
  showResetConfirm.value = false
}
</script>

<style scoped>
/* 设置卡片 - 在全局基础上添加过渡动画，统一使用全局圆角与阴影 */
.settings-card {
  transition: box-shadow var(--transition-smooth);
}

/* 设置行 - 添加悬停过渡 */
.settings-row {
  transition: background-color var(--transition-micro);
}

/* 搜索框 - 毛玻璃效果，聚焦时使用主色光环 */
.shortcut-search {
  border: 1px solid var(--color-border-light);
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
}
.shortcut-search:focus {
  background: var(--color-bg-tertiary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
  border-color: transparent;
}

/* 快捷键按键 - 毛玻璃表面效果，微妙层次感 */
.kbd-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  border: 1px solid var(--color-border-light);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
