<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex-1 flex items-center justify-center p-10 acrylic-content">
      <div class="max-w-[600px] w-full welcome-enter">
        <!-- 顶部图标 -->
        <div class="flex justify-center mb-5">
          <div 
            class="w-14 h-14 rounded-[var(--radius-lg)] flex items-center justify-center"
            :style="{ background: 'var(--color-primary-surface)' }"
          >
            <PenLine class="w-7 h-7" :style="{ color: 'var(--color-primary)' }" />
          </div>
        </div>

        <!-- 主标题 -->
        <h1 class="text-[26px] font-semibold text-center tracking-tight" :style="{ color: 'var(--color-text-primary)' }">
          欢迎使用 Choyeon Notes
        </h1>

        <!-- 副标题 -->
        <p class="text-[14px] text-center mt-2 leading-relaxed" :style="{ color: 'var(--color-text-tertiary)' }">
          你的个人知识管理工作空间
        </p>

        <!-- 分隔线 -->
        <div class="w-8 h-1 mx-auto my-7 rounded-full" :style="{ background: 'var(--color-primary)', opacity: 0.7 }"></div>

        <div v-if="!selectedPath" class="space-y-3">
          <!-- 选择笔记文件夹卡片 -->
          <div 
            v-if="isElectron"
            class="acrylic-card p-5 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :style="{ boxShadow: 'var(--shadow-xs)', transition: 'background-color var(--transition-micro), box-shadow var(--transition-smooth)' }"
            @click="selectNotesFolder"
          >
            <div class="flex items-start gap-4">
              <div class="w-10 h-10 rounded-[var(--radius-md)] flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
                <FolderOpen class="w-5 h-5" :style="{ color: 'var(--color-primary)' }" />
              </div>
              <div class="min-w-0">
                <span class="text-[14px] font-medium block mb-1" :style="{ color: 'var(--color-text-primary)' }">选择笔记文件夹</span>
                <span class="text-[12px] leading-relaxed" :style="{ color: 'var(--color-text-tertiary)' }">选择一个存放 Markdown 笔记的文件夹，支持标准 .md 文件格式</span>
              </div>
            </div>
          </div>

          <!-- 新建笔记文件夹卡片 -->
          <div 
            v-if="isElectron"
            class="acrylic-card p-5 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :style="{ boxShadow: 'var(--shadow-xs)', transition: 'background-color var(--transition-micro), box-shadow var(--transition-smooth)' }"
            @click="createNewNotesFolder"
          >
            <div class="flex items-start gap-4">
              <div class="w-10 h-10 rounded-[var(--radius-md)] flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
                <FolderPlus class="w-5 h-5" :style="{ color: 'var(--color-primary)' }" />
              </div>
              <div class="min-w-0">
                <span class="text-[14px] font-medium block mb-1" :style="{ color: 'var(--color-text-primary)' }">新建笔记文件夹</span>
                <span class="text-[12px] leading-relaxed" :style="{ color: 'var(--color-text-tertiary)' }">创建一个新的文件夹来开始记录你的笔记</span>
              </div>
            </div>
          </div>

          <!-- 使用示例笔记卡片 -->
          <div 
            class="acrylic-card p-5 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :style="{ boxShadow: 'var(--shadow-xs)', transition: 'background-color var(--transition-micro), box-shadow var(--transition-smooth)' }"
            @click="useSampleNotes"
          >
            <div class="flex items-start gap-4">
              <div class="w-10 h-10 rounded-[var(--radius-md)] flex items-center justify-center" :style="{ background: isElectron ? 'var(--color-bg-tertiary)' : 'var(--color-primary-surface)' }">
                <FileText class="w-5 h-5" :style="{ color: isElectron ? 'var(--color-text-tertiary)' : 'var(--color-primary)' }" />
              </div>
              <div class="min-w-0">
                <span class="text-[14px] font-medium block mb-1" :style="{ color: 'var(--color-text-primary)' }">{{ isElectron ? '使用示例笔记' : '开始体验' }}</span>
                <span class="text-[12px] leading-relaxed" :style="{ color: 'var(--color-text-tertiary)' }">{{ isElectron ? '浏览示例笔记来体验应用功能（不保存到文件系统）' : '浏览示例笔记来体验应用的所有功能' }}</span>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="space-y-4">
          <!-- 已选择文件夹信息卡片 -->
          <div class="acrylic-card p-5" :style="{ boxShadow: 'var(--shadow-xs)' }">
            <div class="flex items-center gap-3 mb-3">
              <CheckCircle class="w-5 h-5" :style="{ color: 'var(--state-success)' }" />
              <span class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">已选择笔记文件夹</span>
            </div>
            <div class="text-[13px] font-mono break-all px-3 py-2 rounded-[var(--radius-sm)]" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
              {{ selectedPath }}
            </div>
            <!-- 次要按钮：文本样式 -->
            <button 
              class="mt-3 text-[12px] px-3 py-1.5 rounded-[var(--radius-sm)] cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
              :style="{ color: 'var(--color-text-tertiary)' }"
              @click="selectedPath = null"
            >重新选择</button>
          </div>

          <!-- 主按钮：填充样式 -->
          <button 
            class="w-full py-3 rounded-[var(--radius-md)] cursor-pointer transition-opacity hover:opacity-90 active:opacity-95 text-[14px] font-medium text-white"
            :style="{ background: 'var(--color-primary)', boxShadow: 'var(--shadow-xs)', transition: 'opacity var(--transition-micro)' }"
            :disabled="isLoading"
            @click="confirmPath"
          >
            <span v-if="isLoading" class="flex items-center justify-center gap-2">
              <Loader2 class="w-4 h-4 animate-spin" />
              加载笔记中...
            </span>
            <span v-else>开始使用</span>
          </button>
        </div>

        <div class="mt-8 text-center">
          <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">
            支持 .md 文件 · 本地文件存储 · 数据安全
          </span>
        </div>
      </div>
    </div>

    <!-- 底部状态栏：统一毛玻璃效果 -->
    <div class="cho-statusbar">
      <span class="cho-statusbar-meta">
        Choyeon Notes v1.0.0 · 欢迎页面
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { useAppStore } from '@/stores/app'
import { PenLine, FolderOpen, FolderPlus, FileText, CheckCircle, Loader2 } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()
const appStore = useAppStore()

const selectedPath = ref(null)
const isLoading = ref(false)
const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI)

async function selectNotesFolder() {
  if (!window.electronAPI) {
    alert('请在 Electron 环境中使用此功能')
    return
  }
  
  const path = await window.electronAPI.selectNotesPath()
  if (path) {
    selectedPath.value = path
  }
}

async function createNewNotesFolder() {
  if (!window.electronAPI) {
    alert('请在 Electron 环境中使用此功能')
    return
  }
  
  const path = await window.electronAPI.selectNotesPath()
  if (path) {
    await window.electronAPI.createDirectory(path)
    selectedPath.value = path
  }
}

function useSampleNotes() {
  localStorage.setItem('choyeon-mode', 'sample')
  router.push('/notes')
}

async function confirmPath() {
  if (!selectedPath.value) return
  
  isLoading.value = true
  
  try {
    await loadNotes(selectedPath.value)
  } catch (error) {
    console.error('Failed to load notes:', error)
    alert('加载笔记失败，请检查文件夹权限')
  } finally {
    isLoading.value = false
  }
}

async function loadNotes(path) {
  appStore.saveNotesLocation(path)
  await noteStore.loadNotesFromPath(path)
  router.push('/notes')
}
</script>

<style scoped>
/* 微妙的入场动画：淡入 + 轻微上移，避免分散注意力 */
.welcome-enter {
  animation: welcomeFadeUp 0.5s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) both;
}

@keyframes welcomeFadeUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 尊重用户的减少动画偏好 */
@media (prefers-reduced-motion: reduce) {
  .welcome-enter {
    animation: none;
  }
}
</style>
