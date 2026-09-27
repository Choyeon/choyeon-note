<template>
  <!-- 忽略词列表 -->
  <div class="px-5 py-4 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
    <div class="flex items-center gap-2 mb-3">
      <div class="w-7 h-7 rounded-lg flex items-center justify-center" :style="{ background: 'var(--state-error-lightest, rgba(239,68,68,0.1))' }">
        <EyeOff class="w-4 h-4" :style="{ color: 'var(--state-error)' }" />
      </div>
      <div>
        <div class="text-[14px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">忽略词列表</div>
        <div class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">对"忽略此单词"的单词进行管理</div>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <div class="relative">
          <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
          <input
            v-model="ignoredSearch"
            type="text"
            placeholder="搜索..."
            class="h-8 pl-8 pr-3 rounded-lg text-[13px] outline-none transition-all duration-200"
            :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', width: '150px', border: '1px solid var(--color-border-light)' }"
          />
        </div>
        <button
          class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95"
          :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
          @click="openAddIgnored"
        >
          <span class="inline-flex items-center gap-1"><Plus class="w-3.5 h-3.5"/>添加</span>
        </button>
        <button
          v-if="ignoredWordsArray.length > 0"
          class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
          :style="{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--state-error)' }"
          @click="appStore.clearIgnoredWords()"
        >清空</button>
      </div>
    </div>
    <div 
      class="dict-grid-wrap rounded-lg"
      :style="{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-light)', minHeight: '120px', padding: '8px' }"
    >
      <div v-if="filteredIgnoredWords.length === 0" class="flex flex-col items-center justify-center py-6 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
        <EyeOff class="w-6 h-6 opacity-40 mb-2" />
        <p class="text-[13px]">暂无忽略词</p>
      </div>
      <div v-else class="dict-grid">
        <div
          v-for="w in filteredIgnoredWords"
          :key="'ig-' + w"
          class="dict-chip"
        >
          <span class="font-mono text-[13px] flex-1 min-w-0 truncate">{{ w }}</span>
          <button
            class="dict-chip-remove"
            :title="`移除 ${w}`"
            @click="appStore.unignoreWord(w)"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 自定义词典 -->
  <div class="px-5 py-4 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
    <div class="flex items-center gap-2 mb-3">
      <div class="w-7 h-7 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
        <BookPlus class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
      </div>
      <div>
        <div class="text-[14px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">自定义词典</div>
        <div class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">添加到这里的单词会被判定为拼写正确</div>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <div class="relative">
          <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
          <input
            v-model="dictionarySearch"
            type="text"
            placeholder="搜索..."
            class="h-8 pl-8 pr-3 rounded-lg text-[13px] outline-none transition-all duration-200"
            :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', width: '150px', border: '1px solid var(--color-border-light)' }"
          />
        </div>
        <button
          class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95"
          :style="{ background: 'var(--color-primary)', color: '#fff' }"
          @click="openAddDictionary"
        >
          <span class="inline-flex items-center gap-1"><Plus class="w-3.5 h-3.5"/>添加</span>
        </button>
        <button
          v-if="dictionaryArray.length > 0"
          class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
          :style="{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--state-error)' }"
          @click="appStore.clearCustomDictionary()"
        >清空</button>
      </div>
    </div>
    <div
      class="dict-grid-wrap rounded-lg"
      :style="{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-light)', minHeight: '120px', padding: '8px' }"
    >
      <div v-if="filteredDictionaryWords.length === 0" class="flex flex-col items-center justify-center py-6 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
        <BookPlus class="w-6 h-6 opacity-40 mb-2" />
        <p class="text-[13px]">自定义词典为空</p>
      </div>
      <div v-else class="dict-grid">
        <div
          v-for="w in filteredDictionaryWords"
          :key="'dict-' + w"
          class="dict-chip"
          :style="{ background: 'var(--color-primary-surface, rgba(74,144,217,0.1))', borderColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)' }"
        >
          <span
            class="font-mono text-[13px] flex-1 min-w-0 truncate"
            :style="{ color: 'var(--color-primary)' }"
          >{{ w }}</span>
          <button
            class="dict-chip-remove"
            :title="`移除 ${w}`"
            :style="{ color: 'var(--color-primary)' }"
            @click="appStore.removeFromDictionary(w)"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 添加忽略词 模态框 -->
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="showAddIgnored"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="showAddIgnored = false"
      >
        <div
          class="w-[420px] rounded-2xl overflow-hidden shadow-2xl"
          :style="{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }"
        >
          <div class="px-5 py-4 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
            <h3 class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">添加忽略词</h3>
            <p class="text-[12px] mt-1" :style="{ color: 'var(--color-text-tertiary)' }">支持一次性添加多个，使用空格或逗号分隔</p>
          </div>
          <div class="px-5 py-4">
            <input
              ref="ignoredInputRef"
              v-model="ignoredInput"
              type="text"
              placeholder="例如：choyeon obsidian"
              class="w-full h-10 px-3 rounded-lg text-[14px] outline-none transition-all duration-200"
              :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
              @keydown.enter="submitAddIgnored"
            />
          </div>
          <div class="px-5 py-4 flex items-center justify-end gap-2 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
            <button
              class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:bg-[var(--color-surface-hover)]"
              :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }"
              @click="showAddIgnored = false"
            >取消</button>
            <button
              class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:opacity-90 active:scale-95"
              :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
              @click="submitAddIgnored"
            >确认添加</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 添加自定义词典 模态框 -->
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="showAddDictionary"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="showAddDictionary = false"
      >
        <div
          class="w-[420px] rounded-2xl overflow-hidden shadow-2xl"
          :style="{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }"
        >
          <div class="px-5 py-4 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
            <h3 class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">添加自定义词典</h3>
            <p class="text-[12px] mt-1" :style="{ color: 'var(--color-text-tertiary)' }">支持一次性添加多个，使用空格或逗号分隔</p>
          </div>
          <div class="px-5 py-4">
            <input
              ref="dictionaryInputRef"
              v-model="dictionaryInput"
              type="text"
              placeholder="例如：Choyeon Electron Vue"
              class="w-full h-10 px-3 rounded-lg text-[14px] outline-none transition-all duration-200"
              :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
              @keydown.enter="submitAddDictionary"
            />
          </div>
          <div class="px-5 py-4 flex items-center justify-end gap-2 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
            <button
              class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:bg-[var(--color-surface-hover)]"
              :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }"
              @click="showAddDictionary = false"
            >取消</button>
            <button
              class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:opacity-90 active:scale-95"
              :style="{ background: 'var(--color-primary)', color: '#fff' }"
              @click="submitAddDictionary"
            >确认添加</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 设置页 → 编辑器 → 「忽略词列表 + 自定义词典」。
 *
 * 从 SettingsView.vue 原样搬过来的：模板、样式、交互全部逐字保持一致，
 * 本组件不接 props / 不抛事件，读写都直接走 appStore（和搬出来之前一样）。
 */
import { ref, computed, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { Search, EyeOff, BookPlus, Plus, X } from 'lucide-vue-next'

const appStore = useAppStore()

const ignoredSearch = ref('')
const dictionarySearch = ref('')
const showAddIgnored = ref(false)
const showAddDictionary = ref(false)
const ignoredInput = ref('')
const dictionaryInput = ref('')
const ignoredInputRef = ref(null)
const dictionaryInputRef = ref(null)

/**
 * 弹窗里的输入框要等 Transition 把节点插进 DOM 才能 focus。
 * 句柄存下来是为了在卸载时清掉：否则离开设置页后定时器仍会去碰一个已经销毁的 ref。
 */
let focusTimer = null

function scheduleFocus (inputRef) {
  if (focusTimer) clearTimeout(focusTimer)
  focusTimer = setTimeout(() => inputRef.value?.focus(), 50)
}

const ignoredWordsArray = computed(() => {
  return [...(appStore.ignoredWords || [])].sort((a, b) => a.localeCompare(b))
})
const dictionaryArray = computed(() => {
  return [...(appStore.customDictionary || [])].sort((a, b) => a.localeCompare(b))
})
const filteredIgnoredWords = computed(() => {
  const q = ignoredSearch.value.trim().toLowerCase()
  if (!q) return ignoredWordsArray.value
  return ignoredWordsArray.value.filter(w => w.includes(q))
})
const filteredDictionaryWords = computed(() => {
  const q = dictionarySearch.value.trim().toLowerCase()
  if (!q) return dictionaryArray.value
  return dictionaryArray.value.filter(w => w.includes(q))
})

function openAddIgnored() {
  ignoredInput.value = ''
  showAddIgnored.value = true
  scheduleFocus(ignoredInputRef)
}
function openAddDictionary() {
  dictionaryInput.value = ''
  showAddDictionary.value = true
  scheduleFocus(dictionaryInputRef)
}
function parseWords(str) {
  return String(str || '')
    .split(/[\s,，、;；]+/g)
    .map(w => w.trim().toLowerCase())
    .filter(Boolean)
}
function submitAddIgnored() {
  const words = parseWords(ignoredInput.value)
  words.forEach(w => appStore.ignoreWord(w))
  showAddIgnored.value = false
  ignoredInput.value = ''
}
function submitAddDictionary() {
  const words = parseWords(dictionaryInput.value)
  words.forEach(w => appStore.addToDictionary(w))
  showAddDictionary.value = false
  dictionaryInput.value = ''
}

onUnmounted(() => {
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
})
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ===== 拼写字典管理：词条网格 / chip ===== */
.dict-grid-wrap {
  overflow-y: auto;
  max-height: 220px;
}
.dict-grid-wrap::-webkit-scrollbar { width: 6px; }
.dict-grid-wrap::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 3px;
}

.dict-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.dict-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--color-surface);
  border: 1px solid var(--color-border-light);
  transition: all 0.15s ease;
  min-width: 0;
}
.dict-chip:hover {
  border-color: var(--color-border);
  background: var(--color-surface-hover);
}

.dict-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.dict-chip-remove:hover {
  background: rgba(239, 68, 68, 0.15);
  color: var(--state-error);
  transform: scale(1.1);
}
</style>
