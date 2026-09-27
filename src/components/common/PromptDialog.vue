<template>
  <!--
    应用内对话框：替代浏览器的 window.prompt / alert / confirm。
    原生弹窗的三个硬伤：
      1) 不跟随应用主题 —— 深色模式下依然弹出系统白框；
      2) 阻塞 JS 主线程、脱离 Vue 响应式，无法做聚焦/无障碍/键盘处理；
      3) Electron + Chromium 某些配置下 window.prompt 直接被禁用返回 null，
         新建文件夹/重命名等功能会静默失效。
    这里用 Teleport 挂到 body（Sidebar 根节点 overflow:hidden，直接内联会被裁切），
    但组件的声明位置仍在 Sidebar 模板的根元素内。
  -->
  <Teleport to="body">
    <Transition name="pd" appear>
      <div
        class="pd-backdrop"
        role="presentation"
        @click.self="onCancel"
      >
        <div
          ref="panelRef"
          class="pd-panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <div class="pd-header">
            <component
              :is="iconComponent"
              v-if="iconComponent"
              class="pd-header-icon"
              :class="{ 'pd-header-icon--danger': props.danger }"
            />
            <h2 :id="titleId" class="pd-title">{{ props.title }}</h2>
          </div>

          <p v-if="props.message" class="pd-message">{{ props.message }}</p>

          <input
            v-if="isPrompt"
            ref="inputRef"
            v-model="inputValue"
            class="pd-input"
            type="text"
            :placeholder="props.placeholder"
            @keydown.enter.prevent="onConfirm"
            @keydown.esc.prevent="onCancel"
          />

          <div class="pd-actions">
            <button
              v-if="props.mode !== 'alert'"
              ref="cancelButtonRef"
              type="button"
              class="pd-btn pd-btn--ghost"
              @click="onCancel"
            >
              {{ props.cancelText }}
            </button>
            <button
              ref="confirmButtonRef"
              type="button"
              class="pd-btn"
              :class="props.danger ? 'pd-btn--danger' : 'pd-btn--primary'"
              @click="onConfirm"
            >
              {{ confirmLabel }}
            </button>
          </div>

          <p v-if="isPrompt" class="pd-hint">
            <span><kbd>Enter</kbd> 确定</span>
            <span><kbd>Esc</kbd> 取消</span>
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { AlertTriangle, HelpCircle, PencilLine } from 'lucide-vue-next'

const props = defineProps({
  /** 对话框模式：prompt 输入 / alert 提示 / confirm 确认 */
  mode: { type: String, default: 'confirm' },
  /** 标题（必填语义，缺省为空串，避免 undefined 渲染出 "undefined"） */
  title: { type: String, default: '' },
  /** 正文补充说明，可为空 */
  message: { type: String, default: '' },
  /** prompt 模式下的输入框占位符 */
  placeholder: { type: String, default: '' },
  /** prompt 模式下的默认值 */
  defaultValue: { type: String, default: '' },
  /** 确认按钮是否使用危险色（删除等破坏性操作） */
  danger: { type: Boolean, default: false },
  /** 确认按钮文案；缺省时按 mode / danger 自动推导 */
  confirmText: { type: String, default: '' },
  /** 取消按钮文案 */
  cancelText: { type: String, default: '取消' }
})

const emit = defineEmits(['confirm', 'cancel'])

// aria-labelledby 需要一个页面内唯一的 id
const uid = `pd-${Math.random().toString(36).slice(2, 10)}`
const titleId = `${uid}-title`

const inputRef = ref(null)
const cancelButtonRef = ref(null)
const confirmButtonRef = ref(null)

const inputValue = ref(String(props.defaultValue || ''))

const isPrompt = computed(() => props.mode === 'prompt')

const iconComponent = computed(() => {
  if (props.danger) return AlertTriangle
  if (props.mode === 'prompt') return PencilLine
  if (props.mode === 'alert') return HelpCircle
  return null
})

const confirmLabel = computed(() => {
  if (props.confirmText) return props.confirmText
  if (props.mode === 'alert') return '知道了'
  return props.danger ? '删除' : '确定'
})

// 一次性开关：确认/取消后事件不再二次触发（遮罩点击 + Escape 可能同时到达）
const settled = ref(false)

/**
 * keydown 监听统一在 window 上注册（和 QuickSwitcher.vue 的规范一致），
 * 组件销毁时必须移除，否则 Sidebar 卸载后会持续吃掉全局 Escape。
 */
function handleWindowKeydown (e) {
  if (settled.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    onCancel()
    return
  }
  if (e.key === 'Enter' && isPrompt.value) {
    // 输入框自身也有 @keydown.enter，这里兜住焦点不在输入框的情况
    const active = document.activeElement
    if (active === inputRef.value) return
    e.preventDefault()
    onConfirm()
  }
}

function removeKeydownListener () {
  window.removeEventListener('keydown', handleWindowKeydown)
}

function onConfirm () {
  if (settled.value) return
  settled.value = true
  removeKeydownListener()
  // prompt 返回输入内容（可能为 ''，由调用方判断是否放弃）；
  // alert / confirm 统一返回 true，调用方按 falsy 判断即可。
  emit('confirm', isPrompt.value ? inputValue.value : true)
}

function onCancel () {
  if (settled.value) return
  settled.value = true
  removeKeydownListener()
  emit('cancel')
}

onMounted(async () => {
  window.addEventListener('keydown', handleWindowKeydown)
  await nextTick()
  if (isPrompt.value) {
    // prompt：聚焦并全选默认值，用户可以直接覆写
    inputRef.value?.focus?.()
    inputRef.value?.select?.()
    return
  }
  // 非 prompt：把焦点落到按钮上，这样 Enter 走浏览器原生 click 就是"确认"，
  // 危险操作优先落取消键，避免手滑回车直接删掉数据。
  const target = props.danger ? cancelButtonRef.value : confirmButtonRef.value
  target?.focus?.()
})

onUnmounted(() => {
  removeKeydownListener()
})
</script>

<style scoped>
.pd-backdrop {
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

.pd-panel {
  width: min(420px, calc(100vw - 48px));
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-radius: var(--radius-lg, 12px);
  border: 1px solid var(--color-border);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-float);
  outline: none;
}

.pd-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pd-header-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--color-primary);
}

.pd-header-icon--danger {
  color: var(--state-error);
}

.pd-title {
  margin: 0;
  font-family: var(--font-title);
  font-size: var(--font-size-lg, 16px);
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.4;
}

.pd-message {
  margin: 0;
  font-size: var(--font-size-body, 14px);
  line-height: 1.6;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.pd-input {
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: var(--font-size-body, 14px);
  font-family: var(--font-body);
  outline: none;
  transition:
    border-color var(--transition-smooth),
    box-shadow var(--transition-spring-soft),
    background-color var(--transition-smooth);
}

.pd-input::placeholder {
  color: var(--color-text-tertiary);
}

.pd-input:focus {
  background: var(--color-surface);
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.pd-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.pd-btn {
  min-width: 76px;
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

.pd-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.pd-btn:active {
  transform: scale(0.97);
}

.pd-btn--ghost {
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
}

.pd-btn--ghost:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.pd-btn--primary {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
}

.pd-btn--primary:hover {
  background: var(--color-primary-dark);
  box-shadow: var(--shadow-sm);
}

.pd-btn--danger {
  background: var(--state-error);
  color: var(--color-text-on-primary);
}

.pd-btn--danger:hover {
  filter: brightness(0.95);
  box-shadow: var(--shadow-sm);
}

.pd-hint {
  display: flex;
  gap: 14px;
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.pd-hint kbd {
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

/* 入场 / 退场动画 */
.pd-enter-active {
  transition: opacity var(--duration-normal) var(--ease-out-quart);
}

.pd-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out-quart);
}

.pd-enter-active .pd-panel {
  transition:
    transform var(--duration-normal) var(--ease-spring-soft),
    opacity var(--duration-normal) var(--ease-out-quart);
}

.pd-leave-active .pd-panel {
  transition:
    transform var(--duration-fast) var(--ease-out-quart),
    opacity var(--duration-fast) var(--ease-out-quart);
}

.pd-enter-from,
.pd-leave-to {
  opacity: 0;
}

.pd-enter-from .pd-panel,
.pd-leave-to .pd-panel {
  transform: scale(0.96);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .pd-enter-from .pd-panel,
  .pd-leave-to .pd-panel {
    transform: none;
  }
}
</style>
