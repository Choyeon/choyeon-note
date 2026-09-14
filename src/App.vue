<template>
  <div 
    class="app-container h-full w-full" 
    :data-theme="currentTheme"
    :data-glass="glassEffect ? 'true' : 'false'"
    :data-font-size="appStore.fontSize"
    :class="{ 'electron-mode': isElectron }"
    :style="{ '--editor-zoom': editorZoomScale }"
  >
    <div 
      class="window-frame h-full w-full flex flex-col overflow-hidden relative"
      :style="{
        background: appBgStyle,
        borderRadius: isElectron ? '0' : '12px',
        border: isElectron ? 'none' : '1px solid var(--color-border)'
      }"
    >
      <div 
        v-if="isElectron"
        class="titlebar-electron h-9 min-h-9 flex items-center justify-between px-3 z-50 select-none"
        :style="{ 
          background: 'var(--titlebar-bg)',
          backdropFilter: 'blur(var(--titlebar-blur)) saturate(var(--titlebar-saturate))',
          WebkitBackdropFilter: 'blur(var(--titlebar-blur)) saturate(var(--titlebar-saturate))',
          borderBottom: '1px solid var(--titlebar-border)'
        }"
      >
        <div class="flex items-center gap-2">
          <img
            src="/icon.png"
            alt=""
            class="titlebar-icon"
            draggable="false"
          />
          <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-secondary)' }">
            Choyeon Note
          </span>
        </div>
        <div class="flex items-center gap-1" style="-webkit-app-region: no-drag;">
          <button
            class="win-ctrl w-10 h-9 flex items-center justify-center cursor-pointer transition-colors"
            @click="minimizeWindow"
            title="最小化"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            class="win-ctrl w-10 h-9 flex items-center justify-center cursor-pointer transition-colors"
            @click="maximizeWindow"
            title="最大化"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect
                x="1.5" y="1.5" width="9" height="9"
                stroke="currentColor"
                stroke-width="1"
                fill="none"
              />
            </svg>
          </button>
          <button
            class="win-ctrl win-ctrl-close w-10 h-9 flex items-center justify-center cursor-pointer transition-colors"
            @click="closeWindow"
            title="关闭"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5"
                stroke="currentColor"
                stroke-width="1"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex overflow-hidden">
        <div 
          class="sidebar-wrapper h-full flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
          :class="{ 'sidebar-open': showSidebar && appStore.sidebar, 'sidebar-closed': !(showSidebar && appStore.sidebar) }"
        >
          <Sidebar @toggle-sidebar="appStore.toggleSidebar" />
        </div>
        
        <main class="flex-1 min-w-0 h-full flex flex-col overflow-hidden relative">
          <button
            v-if="showSidebar && !appStore.sidebar"
            class="absolute left-3 top-3 z-40 w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 shadow-md hover:shadow-lg"
            :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }"
            title="展开侧边栏"
            @click="appStore.toggleSidebar"
          >
            <PanelRight class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
          <router-view v-slot="{ Component, route: viewRoute }">
            <div :key="viewRoute.fullPath" class="page-wrapper h-full flex flex-col">
              <component :is="Component" />
              <div 
                v-if="isLoading" 
                class="page-loading-overlay"
              >
                <div class="loading-spinner">
                  <div class="spinner-ring"></div>
                  <div class="spinner-ring spinner-ring-delay"></div>
                </div>
              </div>
            </div>
          </router-view>
        </main>
      </div>
    </div>
    <CommandPalette />
    <QuickSwitcher />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, watch, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from './stores/app'
import { useNoteStore } from './stores/note'
import { PanelRight } from 'lucide-vue-next'
import Sidebar from './components/Sidebar.vue'
import CommandPalette from './components/CommandPalette.vue'
import QuickSwitcher from './components/QuickSwitcher.vue'
import { setCodeTheme as setHljsTheme } from './utils/markdown'
import { fetchBingWallpaper, todayStamp } from './utils/bingWallpaper'
import { SHORTCUTS, eventToBinding } from './constants/shortcuts'

const appStore = useAppStore()
const noteStore = useNoteStore()
const route = useRoute()
const router = useRouter()
const isLoading = ref(false)
let menuUnsubscribe = null

const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI)
const showSidebar = computed(() => route.meta?.showSidebar !== false)
const glassEffect = computed(() => appStore.glassEffect)

const currentTheme = computed(() => appStore.theme)

// 编辑器缩放：百分比 → 倍数，写到根变量上，编辑器三种模式与阅读视图都读它
const editorZoomScale = computed(() => (Number(appStore.editorZoom) || 100) / 100)

const wallpaperUrl = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1920&q=80'

const appBgStyle = computed(() => {
  if (isElectron.value) {
    if (appStore.bingWallpaper && appStore.bingWallpaperUrl) {
      return `url('${appStore.bingWallpaperUrl}') center/cover no-repeat`
    }
    return 'transparent'
  }
  if (appStore.bingWallpaper && appStore.bingWallpaperUrl) {
    return `url('${appStore.bingWallpaperUrl}') center/cover no-repeat`
  }
  return `url('${wallpaperUrl}') center/cover no-repeat`
})

/**
 * 拉取 Bing 每日壁纸。
 * 同一天已有结果就直接用缓存，避免每次启动/每次开开关都打一次网络请求。
 * 失败时保留上一张图（setBingWallpaper 内部会这么处理），只记录错误。
 */
async function refreshBingWallpaper({ force = false } = {}) {
  if (!appStore.bingWallpaper) return
  if (!force && appStore.bingWallpaperUrl && appStore.bingWallpaperDate === todayStamp()) return

  const result = await fetchBingWallpaper()
  appStore.setBingWallpaper(result)
}

function minimizeWindow() {
  if (window.electronAPI) {
    window.electronAPI.minimize()
  }
}

function maximizeWindow() {
  if (window.electronAPI) {
    window.electronAPI.maximize()
  }
}

function closeWindow() {
  if (window.electronAPI) {
    window.electronAPI.close()
  }
}

function handleMenuAction(event) {
  switch (event) {
    case 'menu:new-note': {
      const note = noteStore.createNote('', '新笔记')
      router.push(`/editor/${note.id}`)
      break
    }
    case 'menu:open': {
      router.push('/notes')
      break
    }
    case 'menu:save': {
      if (noteStore.currentNote?.id) {
        noteStore.flushSave(noteStore.currentNote.id)
      }
      break
    }
    case 'menu:toggle-sidebar': {
      appStore.toggleSidebar()
      break
    }
    case 'menu:search': {
      appStore.openQuickSwitcher()
      break
    }
    case 'menu:command-palette': {
      appStore.openCommandPalette()
      break
    }
    case 'menu:toggle-theme': {
      appStore.toggleTheme()
      break
    }
  }
}

/**
 * 全局快捷键：单一数据源来自 shortcuts 注册表（scope = 'app'）。
 * 用户在设置页改键后立即生效，无需改动这里任何代码。
 * 编辑器内部快捷键（scope = 'editor'）由 CodeMirror 的 keymap 处理。
 */
const APP_ACTIONS = {
  'app.newNote': () => {
    const note = noteStore.createNote('', '新笔记')
    router.push(`/editor/${note.id}`)
  },
  'app.save': () => {
    if (noteStore.currentNote?.id) noteStore.flushSave?.(noteStore.currentNote.id)
  },
  'app.quickSwitcher': () => appStore.openQuickSwitcher(),
  'app.commandPalette': () => appStore.toggleCommandPalette(),
  'app.vault': () => router.push('/vault'),
  'app.settings': () => router.push('/settings'),
  'view.toggleSidebar': () => appStore.toggleSidebar(),
  'view.graph': () => router.push('/graph'),
  'view.calendar': () => router.push('/calendar'),
  'view.search': () => router.push('/search'),
  'view.toggleTheme': () => appStore.toggleTheme()
}

/** 需要 focus 不在输入框内才触发的动作（避免输入时误触发） */
const APP_ACTIONS_NEED_UNFOCUSED = new Set(['app.newNote', 'view.toggleSidebar'])

function onGlobalKeydown(e) {
  const target = e.target
  const inEditable =
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)

  // 未聚焦时的 Escape：关闭任意模态
  if (e.key === 'Escape' && !inEditable) {
    if (appStore.commandPaletteOpen) appStore.closeCommandPalette()
    if (appStore.quickSwitcherOpen) appStore.closeQuickSwitcher()
    return
  }

  const binding = eventToBinding(e)
  if (!binding) return

  // 按绑定串反查 app 作用域的命令（与设置页展示完全一致）
  const matched = SHORTCUTS.find(s =>
    s.scope === 'app' &&
    !s.hidden &&
    APP_ACTIONS[s.id] &&
    String(appStore.getBinding(s.id) || '').trim().toLowerCase() === binding
  )
  if (!matched) return
  if (APP_ACTIONS_NEED_UNFOCUSED.has(matched.id) && inEditable) return

  e.preventDefault()
  APP_ACTIONS[matched.id]()
}

watch(() => route.name, () => {
  isLoading.value = true
  setTimeout(() => {
    isLoading.value = false
  }, 300)
}, { immediate: false })

watch(() => appStore.codeTheme, (newTheme) => {
  setHljsTheme(newTheme)
})

watch(() => appStore.bingWallpaper, (enabled) => {
  if (enabled) {
    refreshBingWallpaper()
  }
})

onMounted(() => {
  appStore.initTheme()
  detectPlatform()
  setHljsTheme(appStore.codeTheme)
  
  refreshBingWallpaper()
  
  const savedLocation = localStorage.getItem('choyeon-notes-location')
  if (savedLocation && savedLocation !== 'sample' && window.electronAPI) {
    noteStore.loadNotesFromPath(savedLocation)
  }

  if (window.electronAPI?.onMenuAction) {
    menuUnsubscribe = window.electronAPI.onMenuAction(handleMenuAction)
  }

  window.addEventListener('keydown', onGlobalKeydown, true)
})

onUnmounted(() => {
  if (menuUnsubscribe) {
    menuUnsubscribe()
    menuUnsubscribe = null
  }
  window.removeEventListener('keydown', onGlobalKeydown, true)
})

function detectPlatform() {
  const platform = navigator.platform.toLowerCase()
  const html = document.documentElement
  
  if (platform.includes('win')) {
    html.classList.add('platform-win32')
  } else if (platform.includes('mac')) {
    html.classList.add('platform-darwin')
  } else if (platform.includes('linux')) {
    html.classList.add('platform-linux')
  }
}
</script>

<style scoped>
.app-container {
  font-family: var(--font-body);
}

.sidebar-wrapper {
  width: 260px;
}

.sidebar-closed {
  width: 0;
  opacity: 0;
}

.sidebar-open {
  width: 260px;
  opacity: 1;
}

.titlebar-icon {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  pointer-events: none;
  -webkit-app-region: no-drag;
  /* 防止非 Electron 环境下 404 出现 broken image 图标 */
}

.titlebar-electron {
  -webkit-app-region: drag;
  app-region: drag;
}

.win-ctrl {
  color: var(--color-text-secondary);
  border-radius: 6px;
}

.win-ctrl:hover {
  background: var(--color-bg-tertiary);
}

.win-ctrl-close:hover {
  background: #E53935;
  color: #ffffff;
}

.page-wrapper {
  position: relative;
}

.page-loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  opacity: 0.8;
  z-index: 100;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.loading-spinner {
  position: relative;
  width: 36px;
  height: 36px;
}

.spinner-ring {
  position: absolute;
  inset: 0;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner-ring-delay {
  animation-delay: 0.4s;
  border-top-color: var(--color-accent);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.page-enter-active,
.page-leave-active {
  transition:
    opacity var(--duration-normal) var(--ease-out-quart),
    transform var(--duration-normal) var(--ease-out-quart);
}

.page-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.99);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.99);
}
</style>
