<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="appStore.commandPaletteOpen"
        class="command-palette-backdrop"
        @mousedown.self="onBackdropClick"
      >
        <div
          class="command-palette-panel"
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
          @click.stop
        >
          <div class="cp-header">
            <Command class="cp-icon" />
            <input
              ref="inputRef"
              v-model="query"
              class="cp-input"
              type="text"
              :placeholder="'输入命令…  （Esc 关闭 / ↑↓ 选择 / Enter 执行）'"
              @keydown.esc.prevent="close"
              @keydown.down.prevent="moveDown"
              @keydown.up.prevent="moveUp"
              @keydown.enter.prevent="runSelected"
              @keydown.tab.prevent
            />
            <span class="cp-kbd">⌘⇧P</span>
          </div>

          <div class="cp-body cho-scrollbar" ref="listRef">
            <template v-if="grouped.length === 0">
              <div class="cp-empty">
                <Search class="cp-empty-icon" />
                <div class="cp-empty-title">没有匹配的命令</div>
                <div class="cp-empty-desc">尝试更短的关键词，例如：新建、主题、搜索</div>
              </div>
            </template>
            <template v-else>
              <template v-for="group in grouped" :key="group.section">
                <div class="cp-section">{{ group.section }}</div>
                <button
                  v-for="(cmd, idx) in group.items"
                  :key="cmd.id"
                  class="cp-item"
                  :class="{ 'cp-item-selected': flatIndexOf(group.section, idx) === selected }"
                  @mouseenter="selected = flatIndexOf(group.section, idx)"
                  @click="run(cmd)"
                >
                  <component :is="cmd.icon || Command" class="cp-item-icon" />
                  <div class="cp-item-label">{{ cmd.label }}</div>
                  <kbd v-if="cmd.hotkey" class="cp-item-kbd">{{ cmd.hotkey }}</kbd>
                </button>
              </template>
            </template>
          </div>

          <div class="cp-footer">
            <span class="cp-hint"><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
            <span class="cp-hint"><kbd>⏎</kbd> 执行</span>
            <span class="cp-hint"><kbd>Esc</kbd> 关闭</span>
            <span class="cp-hint ml-auto">按 <kbd>⌘O</kbd> 切换为快速切换器</span>
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
import { Command, Search } from 'lucide-vue-next'
import { rankCommands, useCommands } from '@/composables/useCommands'

const appStore = useAppStore()
const noteStore = useNoteStore()
const router = useRouter()

const query = ref('')
const selected = ref(0)
const inputRef = ref(null)
const listRef = ref(null)

const { quickActions } = useCommands({
  appStore,
  noteStore,
  router,
  openQuickSwitcher: () => {
    appStore.closeCommandPalette()
    appStore.openQuickSwitcher()
  },
  closePalette: () => appStore.closeCommandPalette()
})

const ranked = computed(() => rankCommands(quickActions.value, query.value))

// 分组
const grouped = computed(() => {
  const map = new Map()
  for (const cmd of ranked.value) {
    const key = cmd.section || '其他'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(cmd)
  }
  return Array.from(map.entries()).map(([section, items]) => ({ section, items }))
})

// 扁平化索引以便 selected 能跨 section 工作
function flatIndexOf(section, idx) {
  let acc = 0
  for (const g of grouped.value) {
    if (g.section === section) return acc + idx
    acc += g.items.length
  }
  return -1
}

function findByFlatIndex(i) {
  let acc = 0
  for (const g of grouped.value) {
    if (i < acc + g.items.length) return g.items[i - acc]
    acc += g.items.length
  }
  return null
}

watch(query, () => {
  selected.value = 0
  nextTick(() => scrollSelectedIntoView())
})

watch(
  () => appStore.commandPaletteOpen,
  async (open) => {
    if (open) {
      query.value = ''
      selected.value = 0
      await nextTick()
      inputRef.value?.focus?.()
    }
  }
)

function moveUp() {
  const total = ranked.value.length
  if (total === 0) return
  selected.value = (selected.value - 1 + total) % total
  scrollSelectedIntoView()
}
function moveDown() {
  const total = ranked.value.length
  if (total === 0) return
  selected.value = (selected.value + 1) % total
  scrollSelectedIntoView()
}
function runSelected() {
  const cmd = findByFlatIndex(selected.value)
  if (cmd) run(cmd)
}
function run(cmd) {
  try {
    cmd.action?.()
  } catch (e) {
    console.error('[command-palette] action failed:', cmd.id, e)
  }
}
function close() {
  appStore.closeCommandPalette()
}
function onBackdropClick() {
  close()
}
function scrollSelectedIntoView() {
  if (!listRef.value) return
  const el = listRef.value.querySelector('.cp-item-selected')
  el?.scrollIntoView?.({ block: 'nearest' })
}

// 全局快捷键：Ctrl/Cmd+Shift+P → 这里会有 App.vue 监听，但模态打开时也拦截 Esc
function onKeydown(e) {
  if (!appStore.commandPaletteOpen) return
  // Ctrl/Cmd+O 跳转至快速切换器
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault()
    appStore.closeCommandPalette()
    appStore.openQuickSwitcher()
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
.command-palette-backdrop {
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
  animation: cp-fade-in 0.16s var(--ease-out-quart) both;
}

.command-palette-panel {
  width: min(720px, 92vw);
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
:global([data-theme='dark']) .command-palette-panel {
  background: var(--acrylic-bg-dark, rgba(24, 25, 28, 0.9));
  border-color: rgba(255, 255, 255, 0.08);
}

.cp-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border-light);
}
.cp-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}
.cp-input {
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
.cp-kbd {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 3px 7px;
  border-radius: 6px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-light);
  user-select: none;
}

.cp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.cp-section {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: 10px 10px 4px;
}

.cp-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.cp-item:hover,
.cp-item-selected {
  background: var(--color-primary-surface);
}
.cp-item-selected {
  outline: 1px solid var(--color-primary-ring);
}
.cp-item-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-primary);
}
.cp-item-label {
  flex: 1;
  font-size: 14px;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cp-item-kbd {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-secondary);
}

.cp-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--color-text-tertiary);
}
.cp-empty-icon {
  width: 28px;
  height: 28px;
  margin: 0 auto 10px;
  opacity: 0.7;
}
.cp-empty-title {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}
.cp-empty-desc {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.cp-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid var(--color-border-light);
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.cp-footer kbd {
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
.cp-hint {
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
.modal-enter-active .command-palette-panel,
.modal-leave-active .command-palette-panel {
  transition: transform 0.2s var(--ease-spring-soft), opacity 0.18s var(--ease-out-quart);
}
.modal-enter-from .command-palette-panel,
.modal-leave-to .command-palette-panel {
  transform: translateY(-10px) scale(0.98);
  opacity: 0;
}

@keyframes cp-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes cp-pop-in {
  from { opacity: 0; transform: translateY(-14px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
