<template>
  <div class="app-container h-full w-full" :class="{ dark: isDark }">
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
        <Sidebar v-if="showSidebar" @toggle-sidebar="appStore.toggleSidebar" />
        
        <main class="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </main>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from './stores/app'
import Sidebar from './components/Sidebar.vue'

const appStore = useAppStore()
const route = useRoute()

const isDark = computed(() => appStore.theme === 'dark')
const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI)
const showSidebar = computed(() => route.meta?.showSidebar !== false)

const wallpaperUrl = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1920&q=80'

const appBgStyle = computed(() => {
  if (isElectron.value) {
    return 'var(--color-bg)'
  }
  return `url('${wallpaperUrl}') center/cover no-repeat`
})

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

onMounted(() => {
  appStore.initTheme()
})
</script>

<style scoped>
.app-container {
  font-family: var(--font-body);
}

.titlebar-electron {
  -webkit-app-region: drag;
  app-region: drag;
}

/* 窗口控制按钮 - 默认使用次要文字色，hover 时背景柔化 */
.win-ctrl {
  color: var(--color-text-secondary);
  border-radius: 6px;
}

.win-ctrl:hover {
  background: var(--color-bg-tertiary);
}

/* 关闭按钮 hover 使用标准红色，文字变白以保持对比 */
.win-ctrl-close:hover {
  background: #E53935;
  color: #ffffff;
}
</style>
