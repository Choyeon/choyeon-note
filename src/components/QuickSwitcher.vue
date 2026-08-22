<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="appStore.quickSwitcherOpen"
        class="qs-backdrop"
        @mousedown.self="close"
      >
        <div class="qs-panel" role="dialog" aria-modal="true" aria-label="快速切换器">
          <div class="qs-header">
            <BookOpen class="qs-icon" />
            <input
              ref="inputRef"
              v-model="query"
              class="qs-input"
              type="text"
              placeholder="按标题 / 标签 / 文件夹搜索笔记…  Enter 打开"
              @keydown.esc.prevent="close"
              @keydown.down.prevent="moveDown"
              @keydown.up.prevent="moveUp"
              @keydown.enter.prevent="openSelected"
            />
            <span class="qs-kbd">⌘O</span>
          </div>

          <div class="qs-body cho-scrollbar" ref="listRef">
            <template v-if="rankedNotes.length === 0">
              <div class="qs-empty">
                <FileSearch class="qs-empty-icon" />
                <div class="qs-empty-title">没有找到笔记</div>
                <div class="qs-empty-desc">
                  <button class="qs-create-btn" @click="createAndOpen">
                    <FilePlus2 class="w-4 h-4" />
                    创建标题为 “{{ query }}” 的新笔记
                  </button>
                </div>
              </div>
            </template>
            <template v-else>
              <button
                v-for="(note, i) in rankedNotes"
                :key="note.id"
                class="qs-item"
                :class="{ 'qs-item-selected': i === selected }"
                @mouseenter="selected = i"
                @click="openNote(note)"
              >
                <FileText class="qs-item-icon" />
                <div class="qs-item-main">
                  <div class="qs-item-title">{{ note.title || '未命名笔记' }}</div>
                  <div class="qs-item-meta">
                    <span v-if="note.folder" class="qs-item-folder">
                      <Folder class="w-3 h-3 inline align-text-bottom mr-0.5" />
                      {{ note.folder }}
                    </span>
                    <span v-if="note.tags && note.tags.length" class="qs-item-tags">
                      <Tag class="w-3 h-3 inline align-text-bottom mr-0.5" />
                      {{ note.tags.slice(0, 4).join(' · ') }}
                    </span>
                    <span class="qs-item-date">
                      <Clock class="w-3 h-3 inline align-text-bottom mr-0.5" />
                      {{ formatDate(note.updatedAt) }}
                    </span>
                  </div>
                </div>
                <kbd class="qs-item-kbd">⏎</kbd>
              </button>
            </template>
          </div>

          <div class="qs-footer">
            <span class="qs-hint"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span class="qs-hint"><kbd>⏎</kbd> 打开</span>
            <span class="qs-hint"><kbd>⇧⏎</kbd> 新窗口</span>
            <span class="qs-hint"><kbd>Esc</kbd> 关闭</span>
            <span class="qs-hint ml-auto">按 <kbd>⌘⇧P</kbd> 切换为命令面板</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useNoteStore } from '@/stores/note'
import { rankNotes } from '@/composables/useCommands'
import {
  BookOpen,
  Clock,
  FilePlus2,
  FileSearch,
  FileText,
  Folder,
  Tag
} from 'lucide-vue-next'

const appStore = useAppStore()
const noteStore = useNoteStore()
const router = useRouter()

const query = ref('')
const selected = ref(0)
const inputRef = ref(null)
const listRef = ref(null)

const rankedNotes = computed(() => rankNotes(noteStore.notes || [], query.value))

watch(
  () => appStore.quickSwitcherOpen,
  async (open) => {
    if (open) {
      query.value = ''
      selected.value = 0
      await nextTick()
      inputRef.value?.focus?.()
    }
  }
)

watch(query, () => {
  selected.value = 0
  nextTick(() => scrollSelectedIntoView())
})

function moveUp() {
  const total = rankedNotes.value.length
  if (total === 0) return
  selected.value = (selected.value - 1 + total) % total
  scrollSelectedIntoView()
}
function moveDown() {
  const total = rankedNotes.value.length
  if (total === 0) return
  selected.value = (selected.value + 1) % total
  scrollSelectedIntoView()
}
function openSelected() {
  const note = rankedNotes.value[selected.value]
  if (note) {
    openNote(note)
  } else {
    createAndOpen()
  }
}
function openNote(note) {
  router.push(`/editor/${note.id}`)
  close()
}
function createAndOpen() {
  const title = query.value?.trim() || '新笔记'
  const note = noteStore.createNote('', title)
  router.push(`/editor/${note.id}`)
  close()
}
function close() {
  appStore.closeQuickSwitcher()
}
function scrollSelectedIntoView() {
  if (!listRef.value) return
  const el = listRef.value.querySelector('.qs-item-selected')
  el?.scrollIntoView?.({ block: 'nearest' })
}
function formatDate(ts) {
  if (!ts) return '未知时间'
  try {
    const d = new Date(ts)
    const now = Date.now()
    const diff = (now - ts) / 1000
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`
    return d.toLocaleDateString()
  } catch {
    return ''
  }
}

function onKeydown(e) {
  if (!appStore.quickSwitcherOpen) return
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault()
    appStore.closeQuickSwitcher()
    appStore.openCommandPalette()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.qs-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 1000);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(15, 17, 21, 0.45);
  backdrop-filter: blur(6px) saturate(140%);
  -webkit-backdrop-filter: blur(6px) saturate(140%);
}
.qs-panel {
  width: min(680px, 92vw);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--acrylic-bg, rgba(255, 255, 255, 0.88));
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(0, 0, 0, 0.12);
  animation: cp-pop-in 0.22s var(--ease-spring-soft) both;
}
:global([data-theme='dark']) .qs-panel {
  background: var(--acrylic-bg-dark, rgba(24, 25, 28, 0.9));
  border-color: rgba(255, 255, 255, 0.08);
}

.qs-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border-light);
}
.qs-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}
.qs-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font-size: 15px;
  color: var(--color-text-primary);
  padding: 6px 4px;
  caret-color: var(--color-primary);
}
.qs-kbd {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 3px 7px;
  border-radius: 6px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-light);
  user-select: none;
}

.qs-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.qs-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-radius: 8px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s ease;
}
.qs-item:hover,
.qs-item-selected {
  background: var(--color-primary-surface);
}
.qs-item-selected {
  outline: 1px solid var(--color-primary-ring);
}
.qs-item-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-primary);
}
.qs-item-main {
  flex: 1;
  min-width: 0;
}
.qs-item-title {
  font-size: 14px;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qs-item-meta {
  margin-top: 2px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.qs-item-folder,
.qs-item-tags,
.qs-item-date {
  display: inline-flex;
  align-items: center;
}
.qs-item-kbd {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-secondary);
}

.qs-empty {
  padding: 30px 20px 36px;
  text-align: center;
  color: var(--color-text-tertiary);
}
.qs-empty-icon {
  width: 26px;
  height: 26px;
  margin: 0 auto 10px;
  opacity: 0.7;
}
.qs-empty-title {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin-bottom: 10px;
}
.qs-empty-desc {
  margin-top: 4px;
}
.qs-create-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 8px;
  background: var(--color-primary);
  color: #fff;
  border: none;
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.15s ease, filter 0.15s ease;
}
.qs-create-btn:hover {
  filter: brightness(1.05);
}
.qs-create-btn:active {
  transform: translateY(1px);
}

.qs-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid var(--color-border-light);
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.qs-footer kbd {
  display: inline-block;
  min-width: 18px;
  text-align: center;
  font-family: var(--font-mono);
  padding: 1px 5px;
  margin: 0 2px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-light);
  color: var(--color-text-secondary);
}
.qs-hint {
  display: inline-flex;
  align-items: center;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s var(--ease-out-quart);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-active .qs-panel,
.modal-leave-active .qs-panel {
  transition: transform 0.2s var(--ease-spring-soft), opacity 0.18s var(--ease-out-quart);
}
.modal-enter-from .qs-panel,
.modal-leave-to .qs-panel {
  transform: translateY(-10px) scale(0.98);
  opacity: 0;
}

@keyframes cp-pop-in {
  from { opacity: 0; transform: translateY(-14px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
