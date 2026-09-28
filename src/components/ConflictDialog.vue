<template>
  <!--
    冲突二选一对话框（批次 4 · R-F6）。

    出现的唯一时机：某篇笔记在磁盘上被外部改写，而它在应用里**正在编辑**或
    **有未保存修改**。这时两边都是「用户的东西」，谁覆盖谁必须由用户点头 ——
    改造前是整库重载直接覆盖，用户连自己被覆盖了都不知道。

    三条硬规则（逐条对应单测与人工验收）：
      1. 两侧内容都给全：磁盘版 / 内存版双预览 + 路径 + 冲突原因，不许只给标题；
      2. Esc 不是「取消」而是「保留我的修改」，且在界面上**写明** —— 静默按某一
         侧处理 = 替用户做一个可能丢稿的决定；
      3. 点遮罩**不解决**冲突（不做任何决定），只有两个按钮和 Esc 会推进队列。

    多冲突时按队列逐条处理：一次只显示队首，解决一条自动进下一条。
  -->
  <Teleport to="body">
    <Transition name="cd" appear>
      <div
        v-if="current"
        class="cd-backdrop"
        role="presentation"
      >
        <div
          ref="panelRef"
          class="cd-panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <div class="cd-header">
            <AlertTriangle class="cd-header-icon" />
            <h2 :id="titleId" class="cd-title">笔记冲突：磁盘版本 vs 你的修改</h2>
            <span v-if="remaining > 0" class="cd-queue">还有 {{ remaining }} 条</span>
          </div>

          <p class="cd-reason">{{ current.reason }}</p>

          <p class="cd-path" :title="current.path">
            <span class="cd-path-label">文件</span>
            <span class="cd-path-value">{{ current.path }}</span>
          </p>

          <div class="cd-previews">
            <section class="cd-preview">
              <header class="cd-preview-head">
                <HardDrive class="cd-preview-icon" />
                <span class="cd-preview-title">磁盘版本</span>
                <span class="cd-preview-hint">外部改动后的内容</span>
              </header>
              <pre class="cd-preview-body cho-scrollbar">{{ current.diskPreview }}</pre>
            </section>

            <section class="cd-preview cd-preview--mine">
              <header class="cd-preview-head">
                <PencilLine class="cd-preview-icon" />
                <span class="cd-preview-title">我的修改</span>
                <span class="cd-preview-hint">应用里未保存的内容</span>
              </header>
              <pre class="cd-preview-body cho-scrollbar">{{ current.memoryPreview }}</pre>
            </section>
          </div>

          <div class="cd-actions">
            <button
              ref="diskButtonRef"
              type="button"
              class="cd-btn cd-btn--ghost"
              @click="resolveWith('disk')"
            >
              保留磁盘版本
            </button>
            <button
              ref="memoryButtonRef"
              type="button"
              class="cd-btn cd-btn--primary"
              @click="resolveWith('memory')"
            >
              保留我的修改
            </button>
          </div>

          <p class="cd-hint">
            <span><kbd>Esc</kbd> 保留我的修改（不会丢掉你正在编辑的内容）</span>
            <span>选择「磁盘版本」会放弃应用里的未保存修改</span>
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle, HardDrive, PencilLine } from 'lucide-vue-next'

/**
 * @typedef {object} Conflict
 * @property {string} id 冲突 id（= 笔记 id）
 * @property {string} title 笔记标题
 * @property {string} path 文件绝对路径
 * @property {string} diskPreview 磁盘版预览
 * @property {string} memoryPreview 内存版预览
 * @property {string} reason 冲突原因
 */

const props = defineProps({
  /** 待处理冲突队列；队首即当前展示的这一条 */
  conflicts: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits(['resolve'])

const panelRef = ref(null)
const diskButtonRef = ref(null)
const memoryButtonRef = ref(null)

/** 当前展示的冲突（队首） */
const current = computed(() => {
  const list = Array.isArray(props.conflicts) ? props.conflicts : []
  return list.length > 0 ? list[0] : null
})

/** 队列里还剩几条（不含当前这条） */
const remaining = computed(() => {
  const list = Array.isArray(props.conflicts) ? props.conflicts : []
  return list.length > 1 ? list.length - 1 : 0
})

/**
 * 做出选择并出队。
 *
 * 只认 'disk' / 'memory' 两个值：认不出来就什么都不发 —— 内核那边对未知 choice
 * 同样保持冲突不变，两侧口径一致，宁可让用户再点一次也不猜。
 *
 * @param {'disk'|'memory'} choice 用户的选择
 * @returns {void}
 */
function resolveWith (choice) {
  const item = current.value
  if (!item) return
  if (choice !== 'disk' && choice !== 'memory') return
  emit('resolve', { id: item.id, choice })
}

/**
 * Esc = 保留内存版。
 *
 * 为什么不是「取消」：Esc 关掉弹窗后冲突还在队列里，用户会以为事情过去了，而
 * 磁盘版与内存版的分歧**没有任何一方落地** —— 下一次外部改动又来一次冲突，
 * 问题被无限期推迟。给 Esc 一个明确且最安全的一侧（保留用户自己的编辑），
 * 既不会丢稿，也不会把事情拖着。界面上那行 kbd 提示就是这个决定的出处。
 *
 * @returns {void}
 */
function handleEscape () {
  resolveWith('memory')
}

/**
 * 全局 keydown（与 PromptDialog.vue / QuickSwitcher.vue 同规范）。
 *
 * 只处理 Escape；Enter 刻意不处理 —— 焦点默认在「保留我的修改」上，浏览器原生
 * 的 Enter → click 已经是最安全的一侧，再补一个全局 Enter 会在焦点落在预览区时
 * 造成「没看清就回车」的误操作。
 *
 * @param {KeyboardEvent} e 键盘事件
 * @returns {void}
 */
function handleWindowKeydown (e) {
  if (!current.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    handleEscape()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleWindowKeydown)
})

// 队列推进：解决一条之后把焦点落回安全按钮，连续处理多条时不用重新找鼠标
watch(
  () => (current.value ? current.value.id : ''),
  async () => {
    if (!current.value) return
    await nextTick()
    memoryButtonRef.value?.focus?.()
  },
  { immediate: true }
)
</script>

<style scoped>
.cd-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 1000);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 17, 21, 0.42);
  backdrop-filter: blur(6px) saturate(140%);
  -webkit-backdrop-filter: blur(6px) saturate(140%);
}

.cd-panel {
  width: min(860px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  overflow: hidden;
  border-radius: var(--radius-lg, 12px);
  border: 1px solid var(--color-border);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-float);
  outline: none;
}

.cd-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cd-header-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--state-warning, var(--color-primary));
}

.cd-title {
  margin: 0;
  font-family: var(--font-title);
  font-size: var(--font-size-lg, 16px);
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.4;
}

.cd-queue {
  margin-left: auto;
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-full, 999px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-secondary);
}

.cd-reason {
  margin: 0;
  font-size: var(--font-size-body, 14px);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.cd-path {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.cd-path-label {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-sm, 4px);
  background: var(--color-bg-tertiary);
  font-family: var(--font-mono);
}

.cd-path-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.cd-previews {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  min-height: 0;
  flex: 1 1 auto;
}

@media (max-width: 720px) {
  .cd-previews {
    grid-template-columns: 1fr;
  }
}

.cd-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.cd-preview--mine {
  border-color: var(--color-primary);
}

.cd-preview-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cd-preview-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}

.cd-preview--mine .cd-preview-icon {
  color: var(--color-primary);
}

.cd-preview-title {
  font-size: var(--font-size-body, 14px);
  font-weight: 600;
  color: var(--color-text-primary);
}

.cd-preview-hint {
  margin-left: auto;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.cd-preview-body {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: 260px;
  margin: 0;
  overflow: auto;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 4px);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--font-size-3xs, 10px);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.cd-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.cd-btn {
  min-width: 120px;
  padding: 8px 16px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid transparent;
  font-size: var(--font-size-body, 14px);
  font-weight: 500;
  font-family: var(--font-body);
  cursor: pointer;
  transition:
    background var(--transition-micro),
    box-shadow var(--transition-smooth),
    transform var(--transition-micro);
}

.cd-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.cd-btn:active {
  transform: scale(0.97);
}

.cd-btn--ghost {
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
}

.cd-btn--ghost:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.cd-btn--primary {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
}

.cd-btn--primary:hover {
  background: var(--color-primary-dark);
  box-shadow: var(--shadow-sm);
}

.cd-hint {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.cd-hint kbd {
  display: inline-block;
  padding: 1px 5px;
  margin-right: 4px;
  border-radius: 4px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-tertiary);
  font-family: var(--font-mono);
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-secondary);
}

/* 入场 / 退场动画（与 PromptDialog 同一组时长曲线） */
.cd-enter-active {
  transition: opacity var(--duration-normal) var(--ease-out-quart);
}

.cd-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out-quart);
}

.cd-enter-active .cd-panel {
  transition:
    transform var(--duration-normal) var(--ease-spring-soft),
    opacity var(--duration-normal) var(--ease-out-quart);
}

.cd-leave-active .cd-panel {
  transition:
    transform var(--duration-fast) var(--ease-out-quart),
    opacity var(--duration-fast) var(--ease-out-quart);
}

.cd-enter-from,
.cd-leave-to {
  opacity: 0;
}

.cd-enter-from .cd-panel,
.cd-leave-to .cd-panel {
  transform: scale(0.96);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .cd-enter-from .cd-panel,
  .cd-leave-to .cd-panel {
    transform: none;
  }
}
</style>
