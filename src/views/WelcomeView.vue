<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex-1 flex items-center justify-center p-10 acrylic-content">
      <div class="max-w-[560px] w-full">
        <div class="flex justify-center mb-4">
          <PenLine class="w-12 h-12 text-primary" />
        </div>

        <h1 class="text-2xl font-bold text-center" :style="{ color: 'var(--color-text-primary)' }">
          欢迎使用 Choyeon Notes
        </h1>

        <p class="text-[14px] text-center mt-2" :style="{ color: 'var(--color-text-tertiary)' }">
          你的个人知识管理工作空间
        </p>

        <div class="w-10 h-0.5 mx-auto my-7 rounded-full" :style="{ background: 'var(--color-primary)' }"></div>

        <div class="grid grid-cols-2 gap-4 mt-2">
          <div 
            class="acrylic-card p-5 cursor-pointer transition-all hover:shadow-sm hover:-translate-y-px"
            @click="createNote"
          >
            <FilePlus class="w-6 h-6 text-primary mb-2.5" />
            <span class="text-[14px] font-medium block mb-1" :style="{ color: 'var(--color-text-primary)' }">新建笔记</span>
            <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">创建你的第一篇笔记</span>
          </div>

          <div 
            class="acrylic-card p-5 cursor-pointer transition-all hover:shadow-sm hover:-translate-y-px"
            @click="openNotes"
          >
            <FolderOpen class="w-6 h-6 mb-2.5" :style="{ color: 'var(--color-text-tertiary)' }" />
            <span class="text-[14px] font-medium block mb-1" :style="{ color: 'var(--color-text-primary)' }">打开文件夹</span>
            <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">选择笔记库存储位置</span>
          </div>

          <div 
            class="acrylic-card p-5 cursor-pointer transition-all hover:shadow-sm hover:-translate-y-px"
            @click="openNotes"
          >
            <Download class="w-6 h-6 mb-2.5" :style="{ color: 'var(--color-text-tertiary)' }" />
            <span class="text-[14px] font-medium block mb-1" :style="{ color: 'var(--color-text-primary)' }">导入笔记</span>
            <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">从其他应用导入 Markdown 文件</span>
          </div>

          <div 
            class="acrylic-card p-5 cursor-pointer transition-all hover:shadow-sm hover:-translate-y-px"
            @click="$router.push('/settings')"
          >
            <Palette class="w-6 h-6 mb-2.5" :style="{ color: 'var(--color-text-tertiary)' }" />
            <span class="text-[14px] font-medium block mb-1" :style="{ color: 'var(--color-text-primary)' }">外观设置</span>
            <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">切换主题和自定义样式</span>
          </div>
        </div>

        <div class="flex flex-col items-center gap-2 mt-8">
          <button 
            class="px-9 py-2.5 rounded-full cursor-pointer transition-opacity hover:opacity-90 text-[14px] font-medium text-white"
            :style="{ background: 'var(--color-primary)' }"
            @click="startUsing"
          >开始使用</button>
          <span 
            class="text-[13px] cursor-pointer transition-opacity hover:opacity-80"
            :style="{ color: 'var(--color-primary)' }"
            @click="openNotes"
          >或浏览现有笔记库</span>
        </div>
      </div>
    </div>

    <div 
      class="min-h-7 px-6 py-1 flex items-center border-t"
      :style="{ 
        borderColor: 'var(--color-border-light)', 
        background: 'rgba(240,242,245,0.65)' 
      }"
    >
      <span class="text-[11px] whitespace-nowrap" :style="{ color: 'var(--color-text-primary)' }">
        Choyeon Notes v1.0.0 · 欢迎页面
      </span>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { PenLine, FilePlus, FolderOpen, Download, Palette } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

function createNote() {
  const note = noteStore.createNote('', '新笔记')
  router.push(`/editor/${note.id}`)
}

function openNotes() {
  router.push('/notes')
}

function startUsing() {
  router.push('/notes')
}
</script>
