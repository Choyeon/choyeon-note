<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex-1 flex items-center justify-center p-10 acrylic-content">
      <div class="max-w-[480px] w-full text-center not-found-enter">
        <div class="flex justify-center mb-6">
          <div 
            class="w-20 h-20 rounded-[var(--radius-xl)] flex items-center justify-center"
            :style="{ background: 'var(--color-primary-surface)' }"
          >
            <FileQuestion class="w-10 h-10" :style="{ color: 'var(--color-primary)' }" />
          </div>
        </div>

        <h1 class="text-[48px] font-bold tracking-tight mb-2" :style="{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-title)' }">
          404
        </h1>

        <h2 class="text-[18px] font-semibold mb-3" :style="{ color: 'var(--color-text-primary)' }">
          页面未找到
        </h2>

        <p class="text-[14px] leading-relaxed mb-8" :style="{ color: 'var(--color-text-tertiary)' }">
          抱歉，您访问的页面不存在或已被移动。<br/>
          请检查链接是否正确，或返回首页继续浏览。
        </p>

        <div class="flex items-center justify-center gap-3">
          <button 
            class="inline-flex items-center gap-2 px-5 py-2.5 rounded-[var(--radius-lg)] cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-[0.97] text-[14px] font-medium text-white"
            :style="{ background: 'var(--color-primary)' }"
            @click="goHome"
          >
            <Home class="w-4 h-4" />
            <span>返回首页</span>
          </button>
          <button 
            class="inline-flex items-center gap-2 px-5 py-2.5 rounded-[var(--radius-lg)] cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-[0.97] text-[14px] font-medium"
            :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
            @click="goBack"
          >
            <ArrowLeft class="w-4 h-4" />
            <span>返回上页</span>
          </button>
        </div>
      </div>
    </div>

    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">Choyeon Notes</span>
      <span class="cho-statusbar-meta">404 Not Found</span>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { FileQuestion, Home, ArrowLeft } from 'lucide-vue-next'

const router = useRouter()

function goHome() {
  router.push('/notes')
}

function goBack() {
  router.back()
}
</script>

<style scoped>
.not-found-enter {
  animation: notFoundFadeUp 0.5s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) both;
}

@keyframes notFoundFadeUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .not-found-enter {
    animation: none;
  }
}
</style>
