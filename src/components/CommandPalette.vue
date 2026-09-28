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
            <span class="cp-kbd">{{ paletteHint }}</span>
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
                <!-- 禁用项刻意**不**用原生 disabled 属性：原生 disabled 的 button 收不到
                     鼠标事件，cursor: not-allowed 与「点一下给提示」都会失效。
                     这里用 aria-disabled + 自己的拦截逻辑，语义与交互两头都保住。 -->
                <button
                  v-for="(cmd, idx) in group.items"
                  :key="cmd.id"
                  class="cp-item"
                  :class="{
                    'cp-item-selected': flatIndexOf(group.section, idx) === selected,
                    'cp-item-disabled': cmd.disabled
                  }"
                  :aria-disabled="cmd.disabled ? 'true' : 'false'"
                  :title="cmd.disabled ? (cmd.disabledHint || '该命令当前不可用') : ''"
                  @mouseenter="onItemHover(flatIndexOf(group.section, idx))"
                  @click="run(cmd)"
                >
                  <component :is="cmd.icon || Command" class="cp-item-icon" />
                  <div class="cp-item-label">{{ cmd.label }}</div>
                  <!-- 「不可用」标记：置灰不能只靠改透明度，浅色/深色下都要一眼认出 -->
                  <span v-if="cmd.disabled" class="cp-item-disabled-tag">不可用</span>
                  <!-- 角标由 useCommands 统一提供：只认快捷键注册表（getBinding → formatBinding），
                       注册表里没有这条命令（如「导出」「设置字号」）则为空串、不渲染 -->
                  <kbd v-if="cmd.hotkey" class="cp-item-kbd">{{ cmd.hotkey }}</kbd>
                </button>
              </template>
            </template>
          </div>

          <div class="cp-footer">
            <span class="cp-hint"><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
            <span class="cp-hint"><kbd>⏎</kbd> 执行</span>
            <span class="cp-hint"><kbd>Esc</kbd> 关闭</span>
            <span class="cp-hint ml-auto">按 <kbd>{{ switcherHint }}</kbd> 切换为快速切换器</span>
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
import {
  rankCommands,
  useCommands,
  isCommandDisabled,
  firstSelectableIndex,
  nextSelectableIndex,
  runCommand
} from '@/composables/useCommands'
import { formatBinding } from '@/constants/shortcuts'
import { createLogger } from '@/utils/logger'
import { LOG_MODULES } from '@/constants/logging'

const appStore = useAppStore()
const noteStore = useNoteStore()
const router = useRouter()

// 诊断出口。取 commands 的子模块 palette 而不是平级的新模块名：
// 这里是「命令面板」这个 UI 壳捕获的异常，与 useCommands 内部的执行命令属于同一条
// 命令链路，日志里要能一眼看出是同一族（[commands:palette]），而不是两个互不相干的
// 模块名；原先 '[command-palette] ' 这个前缀由模块标签接管，不再写进 msg。
const log = createLogger(LOG_MODULES.commands).child('palette')

const query = ref('')
const selected = ref(0)
const inputRef = ref(null)
const listRef = ref(null)

// 角标跟着真实绑定走：用户改了快捷键、或换到 macOS，这里都会同步
const paletteHint = formatBinding(appStore.getBinding('app.commandPalette'))
const switcherHint = formatBinding(appStore.getBinding('app.quickSwitcher'))

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

/**
 * 扁平列表 == 分组渲染顺序（grouped 是按 ranked 顺序切的段），
 * 所以键盘导航与命中检测统一打在 ranked 上，不必再维护第二份扁平数组。
 */
const flat = computed(() => ranked.value)

// 扁平化索引以便 selected 能跨 section 工作
function flatIndexOf(section, idx) {
  let acc = 0
  for (const g of grouped.value) {
    if (g.section === section) return acc + idx
    acc += g.items.length
  }
  return -1
}

watch(query, () => {
  // 置灰项仍会进列表（隐藏了用户会以为功能没了），但高亮必须落在**可用**项上，
  // 否则一进面板就是「回车没反应」
  selected.value = firstSelectableIndex(flat.value)
  nextTick(() => scrollSelectedIntoView())
})

// 可用性会在面板开着的时候变化（撤回栈被清空 / 新操作入栈 / 栈被撤空）。
// 当前高亮那条刚好变灰时，把高亮挪到第一条可用项 —— 不动的话就是「回车没反应」。
watch(flat, () => {
  if (selected.value < 0 || isCommandDisabled(flat.value[selected.value])) {
    selected.value = firstSelectableIndex(flat.value)
  }
})

watch(
  () => appStore.commandPaletteOpen,
  async (open) => {
    if (open) {
      query.value = ''
      selected.value = firstSelectableIndex(flat.value)
      await nextTick()
      inputRef.value?.focus?.()
    }
  }
)

/** ↑↓ 共用：step = +1 向下、-1 向上，跳过禁用项 */
function move(step) {
  const next = nextSelectableIndex(flat.value, selected.value, step)
  selected.value = next
  if (next >= 0) scrollSelectedIntoView()
}
function moveUp() {
  move(-1)
}
function moveDown() {
  move(1)
}
/** 悬停不接管禁用项：鼠标扫过时高亮不能停在点不动的那条上 */
function onItemHover(idx) {
  if (isCommandDisabled(flat.value[idx])) return
  selected.value = idx
}
function runSelected() {
  // selected 为 -1 = 整列都不可用（导航已跳过），此时回车什么都不做
  if (selected.value < 0) return
  run(flat.value[selected.value])
}
function run(cmd) {
  return runCommand(cmd, {
    onRun: (c) => {
      try {
        c.action?.()
      } catch (e) {
        // id 与异常分开放：id 是注册表常量，留在 msg 里会让同一类失败 msg 各不相同，
        // 只能堆 aaa/bbb 尾巴；放进 data 才能按字段过滤。e 交给 logger 拆 stack。
        log.error('命令执行失败（action 抛出异常）', { id: c.id, err: e })
      }
    },
    onBlocked: (c) => {
      // 不执行、也不关面板：关掉等于"点了没反应"，那正是本轮要消灭的体验噪音。
      // 给一句能看懂的原因（useCommands 的 disabledHint，缺省有兜底）。
      appStore?.pushToast?.({
        type: 'info',
        message: c.disabledHint || '该命令当前不可用'
      })
    }
  })
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

/* 禁用项：置灰而不是隐藏 —— 命令在但不让你点，比凭空消失更好发现。
   降 opacity 而不是改某个具体颜色：亮色/暗色主题下都成立，不用维护两套色值。
   图标同时褪成 tertiary：只降透明度时，主色图标在暗色下仍然很跳，
   用户会以为是「高亮的可用项」。 */
.cp-item-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.cp-item-disabled:hover {
  background: transparent;
}
.cp-item-disabled .cp-item-icon {
  color: var(--color-text-tertiary);
}
.cp-item-disabled-tag {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--color-text-tertiary);
  padding: 0 6px;
  border-radius: 5px;
  border: 1px dashed var(--color-border);
  user-select: none;
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

/* 遮罩与面板是一对：同时入场、同时退场，必须共用同一条时长/曲线才像一个整体。
   退场比入场快 ~20%（0.18s → 0.14s）：关闭是"清场"，用户已经决定，慢只会拖沓。 */
.modal-enter-active {
  transition: opacity 0.18s var(--ease-out-quart);
}
.modal-leave-active {
  transition: opacity 0.14s var(--ease-out-quart);
}
.modal-enter-active .command-palette-panel {
  transition: transform 0.18s var(--ease-spring-soft), opacity 0.18s var(--ease-out-quart);
}
.modal-leave-active .command-palette-panel {
  transition: transform 0.14s var(--ease-out-quart), opacity 0.14s var(--ease-out-quart);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .command-palette-panel,
.modal-leave-to .command-palette-panel {
  transform: translateY(-10px) scale(0.98);
  opacity: 0;
}

/* 降低动效偏好：保留淡入（opacity 帮助理解"出现了什么"），去掉位移与缩放 */
@media (prefers-reduced-motion: reduce) {
  .modal-enter-from .command-palette-panel,
  .modal-leave-to .command-palette-panel {
    transform: none;
  }
}
</style>
