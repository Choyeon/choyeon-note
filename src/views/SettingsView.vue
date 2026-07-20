<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-14 px-8 py-3 flex items-center gap-2.5 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        @click="$router.back()"
      >
        <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <h1 class="text-2xl font-bold" :style="{ color: 'var(--color-text-primary)' }">设置</h1>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar acrylic-content">
      <div class="max-w-[680px] mx-auto px-8 py-6 pb-16">
        <div class="section-header">外观</div>
        <div class="settings-card mb-6">
          <div class="settings-row">
            <div class="flex items-center gap-2">
              <SunMoon class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">主题模式</span>
            </div>
            <div class="cho-segmented">
              <div 
                class="seg-pill"
                :class="{ active: appStore.theme === 'light' }"
                @click="appStore.setTheme('light')"
              >浅色</div>
              <div 
                class="seg-pill"
                :class="{ active: appStore.theme === 'dark' }"
                @click="appStore.setTheme('dark')"
              >深色</div>
              <div 
                class="seg-pill"
                :class="{ active: appStore.theme === 'system' }"
                @click="appStore.setTheme('system')"
              >系统</div>
            </div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <Palette class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">强调色</span>
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
            <div class="flex items-center gap-2">
              <Type class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">字体大小</span>
            </div>
            <div class="cho-segmented">
              <div 
                class="seg-pill"
                :class="{ active: appStore.fontSize === 'small' }"
                @click="appStore.setFontSize('small')"
              >小</div>
              <div 
                class="seg-pill"
                :class="{ active: appStore.fontSize === 'medium' }"
                @click="appStore.setFontSize('medium')"
              >中</div>
              <div 
                class="seg-pill"
                :class="{ active: appStore.fontSize === 'large' }"
                @click="appStore.setFontSize('large')"
              >大</div>
            </div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <Layers class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">毛玻璃效果</span>
            </div>
            <div 
              class="cho-toggle"
              :class="{ active: appStore.glassEffect }"
              @click="appStore.toggleGlassEffect()"
            >
              <div class="knob"></div>
            </div>
          </div>
        </div>

        <div class="section-header">编辑器</div>
        <div class="settings-card mb-6">
          <div class="settings-row">
            <div class="flex items-center gap-2">
              <FileCode class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">默认扩展名</span>
            </div>
            <div class="inline-flex items-center px-3 py-1 rounded-lg font-mono text-[13px]" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">.md</div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <SpellCheck class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">拼写检查</span>
            </div>
            <div 
              class="cho-toggle"
              :class="{ active: appStore.spellCheck }"
              @click="appStore.toggleSpellCheck()"
            >
              <div class="knob"></div>
            </div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <Save class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">自动保存</span>
            </div>
            <div 
              class="cho-toggle"
              :class="{ active: appStore.autoSave }"
              @click="appStore.toggleAutoSave()"
            >
              <div class="knob"></div>
            </div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <ListOrdered class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">行号显示</span>
            </div>
            <div 
              class="cho-toggle"
              :class="{ active: appStore.showLineNumbers }"
              @click="appStore.toggleLineNumbers()"
            >
              <div class="knob"></div>
            </div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <WrapText class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">自动换行</span>
            </div>
            <div 
              class="cho-toggle"
              :class="{ active: appStore.wordWrap }"
              @click="appStore.toggleWordWrap()"
            >
              <div class="knob"></div>
            </div>
          </div>
        </div>

        <div class="section-header">文件与同步</div>
        <div class="settings-card mb-6">
          <div class="settings-row">
            <div class="flex items-center gap-2">
              <FolderOpen class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">默认笔记位置</span>
            </div>
            <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-mono text-[13px]" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
              <span>{{ appStore.notesLocation }}</span>
              <button class="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]">
                <Folder class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
              </button>
            </div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <RefreshCw class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">自动同步</span>
            </div>
            <div 
              class="cho-toggle"
              :class="{ active: appStore.autoSync }"
              @click="appStore.toggleAutoSync()"
            >
              <div class="knob"></div>
            </div>
          </div>

          <div class="settings-row">
            <div class="flex items-center gap-2">
              <Paperclip class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[14px]" :style="{ color: 'var(--color-text-primary)' }">附件文件夹</span>
            </div>
            <div class="inline-flex items-center px-3 py-1 rounded-lg font-mono text-[13px]" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">attachments</div>
          </div>
        </div>

        <div class="section-header">快捷键</div>
        <div class="settings-card mb-6">
          <table class="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th 
                  class="text-left px-5 py-2 font-medium text-[11px] uppercase tracking-wider"
                  :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)', borderBottom: '1px solid var(--color-border-light)', width: '50%' }"
                >命令</th>
                <th 
                  class="text-left px-5 py-2 font-medium text-[11px] uppercase tracking-wider"
                  :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)', borderBottom: '1px solid var(--color-border-light)', width: '50%' }"
                >快捷键</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="shortcut in shortcuts" :key="shortcut.command">
                <td class="px-5 py-2.5 border-b" :style="{ color: 'var(--color-text-primary)', borderColor: 'var(--color-border-light)' }">{{ shortcut.command }}</td>
                <td class="px-5 py-2.5 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
                  <span v-for="key in shortcut.keys" :key="key" class="kbd mr-1">{{ key }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div 
      class="min-h-7 px-8 py-1 flex items-center border-t"
      :style="{ 
        borderColor: 'var(--color-border-light)', 
        background: 'rgba(240,242,245,0.65)' 
      }"
    >
      <span class="text-[11px] whitespace-nowrap" :style="{ color: 'var(--color-text-primary)' }">Choyeon Notes v1.0.0</span>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from '@/stores/app'
import { 
  ArrowLeft, SunMoon, Palette, Type, Layers, 
  FileCode, SpellCheck, Save, ListOrdered, WrapText,
  FolderOpen, RefreshCw, Paperclip, Folder
} from 'lucide-vue-next'

const appStore = useAppStore()

const shortcuts = [
  { command: '新建笔记', keys: ['Ctrl', 'N'] },
  { command: '搜索', keys: ['Ctrl', 'P'] },
  { command: '保存', keys: ['Ctrl', 'S'] },
  { command: '命令面板', keys: ['Ctrl', 'Shift', 'P'] },
  { command: '切换主题', keys: ['Ctrl', 'T'] }
]
</script>
