<template>
  <div class="app-container h-full w-full" :class="{ dark: isDark }">
    <div 
      class="window-frame h-full w-full flex overflow-hidden relative"
      :style="{
        background: `url('${wallpaperUrl}') center/cover no-repeat`,
        borderRadius: isElectron ? '0' : '12px',
        border: isElectron ? 'none' : '1px solid var(--color-border)'
      }"
    >
      <div 
        v-if="!isElectron"
        class="absolute top-2 right-3 z-50 flex items-center gap-2"
      >
        <div class="w-3 h-3 rounded-full cursor-pointer transition-opacity"
             :style="{ background: 'var(--color-text-tertiary)', opacity: 0.5 }"></div>
        <div class="w-3 h-3 rounded-full cursor-pointer transition-opacity"
             :style="{ background: 'var(--color-text-tertiary)', opacity: 0.5 }"></div>
        <div class="w-3 h-3 rounded-full cursor-pointer transition-opacity"
             :style="{ background: 'var(--state-error)', opacity: 0.5 }"></div>
      </div>

      <Sidebar v-if="showSidebar" @toggle-sidebar="appStore.toggleSidebar" />
      
      <main class="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
        <div 
          v-if="!isElectron && showSidebar"
          class="titlebar h-9 min-h-9 flex items-center justify-end px-3 acrylic-sidebar z-50"
          :style="{ borderBottom: '1px solid var(--color-border-light)' }"
        >
          <div class="flex items-center gap-2">
            <div class="w-3 h-3 rounded-full" :style="{ background: 'var(--color-text-tertiary)', opacity: 0.6 }"></div>
            <div class="w-3 h-3 rounded-full" :style="{ background: 'var(--color-text-tertiary)', opacity: 0.6 }"></div>
            <div class="w-3 h-3 rounded-full" :style="{ background: 'var(--state-error)', opacity: 0.8 }"></div>
          </div>
        </div>
        
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
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
const isElectron = computed(() => !!window.electronAPI)
const showSidebar = computed(() => route.meta?.showSidebar !== false)

const wallpaperUrl = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1920&q=80'

onMounted(() => {
  appStore.initTheme()
})
</script>

<style scoped>
.app-container {
  font-family: var(--font-body);
}
</style>
