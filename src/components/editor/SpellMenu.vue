<template>
  <Teleport to="body">
    <Transition name="spell-pop">
      <div
        v-if="show"
        ref="menuRef"
        class="spell-menu"
        :style="menuStyle"
        @mousedown.stop.prevent
        @contextmenu.stop.prevent
      >
        <div class="spell-menu__head">
          <span class="spell-menu__word">{{ word }}</span>
          <button class="spell-menu__close" title="关闭 (Esc)" @click="emit('close')">
            <X class="w-3 h-3" />
          </button>
        </div>

        <div v-if="suggestions.length" class="spell-menu__section">
          <div class="spell-menu__label">建议</div>
          <button
            v-for="s in suggestions"
            :key="'s-' + s"
            class="spell-menu__item"
            @click="emit('replace', s)"
          >
            <CornerDownLeft class="w-3 h-3 opacity-50" />
            <span class="font-medium">{{ s }}</span>
          </button>
        </div>
        <div v-else class="spell-menu__empty">没有找到拼写建议</div>

        <div class="spell-menu__section">
          <button
            v-if="suggestions.length && occurrences > 1"
            class="spell-menu__item"
            @click="emit('replace-all', suggestions[0])"
          >
            <ReplaceAll class="w-3.5 h-3.5" />
            <span>全部替换为「{{ suggestions[0] }}」</span>
            <span class="spell-menu__hint">{{ occurrences }} 处</span>
          </button>
          <button class="spell-menu__item" @click="emit('add-dictionary', word)">
            <BookPlus class="w-3.5 h-3.5" />
            <span>加入词典</span>
            <span class="spell-menu__hint">永久视为正确</span>
          </button>
          <button class="spell-menu__item" @click="emit('ignore', word)">
            <EyeOff class="w-3.5 h-3.5" />
            <span>忽略</span>
            <span class="spell-menu__hint">全局不再提示</span>
          </button>
          <button class="spell-menu__item" @click="emit('copy', word)">
            <Copy class="w-3.5 h-3.5" />
            <span>复制单词</span>
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { X, BookPlus, EyeOff, Copy, CornerDownLeft } from 'lucide-vue-next'

const props = defineProps({
  show: { type: Boolean, default: false },
  /** 波浪线自身的屏幕矩形，由编辑器 spellRect() 提供 */
  rect: { type: Object, default: null },
  word: { type: String, default: '' },
  suggestions: { type: Array, default: () => [] },
  hasSelection: { type: Boolean, default: false },
  /** 该单词在文档中的出现次数，>1 时展示「全部替换」 */
  occurrences: { type: Number, default: 1 }
})

const emit = defineEmits(['close', 'replace', 'ignore', 'ignore-all', 'add-dictionary', 'copy'])

const menuRef = ref(null)
const size = ref({ w: 232, h: 260 })

/**
 * 菜单定位：锚点是波浪线矩形本身，因此无论文章滚动到哪里、字号多大、
 * 单词在不在折行处，菜单都紧贴单词下方；空间不够时翻到上方。
 * 视口边界做二次夹紧，保证菜单永远完整可见。
 */
const menuStyle = computed(() => {
  const r = props.rect
  if (!r) return { left: '-9999px', top: '-9999px', visibility: 'hidden' }

  const margin = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  const { w, h } = size.value

  let left = r.left
  if (left + w > vw - margin) left = vw - w - margin
  if (left < margin) left = margin

  let top = r.bottom + 6
  let placement = 'bottom'
  if (top + h > vh - margin) {
    const above = r.top - h - 6
    if (above > margin) {
      top = above
      placement = 'top'
    } else {
      top = Math.max(margin, vh - h - margin)
    }
  }

  return {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${w}px`,
    '--placement': placement
  }
})

function measure() {
  const el = menuRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width) size.value = { w: rect.width, h: rect.height }
}

watch(() => props.show, (v) => {
  if (!v) return
  // 先按上一帧尺寸定位，渲染后再按真实尺寸校正一次，避免首次弹出抖动
  requestAnimationFrame(() => requestAnimationFrame(measure))
})

function onKeyDown(e) {
  if (e.key === 'Escape') emit('close')
}

// 关闭逻辑只认「点到菜单外」：不再使用定时器 + pinned 状态机，
// 因此连续点击不同波浪线时菜单始终能正常重新打开。
function onDocMouseDown(e) {
  if (!props.show) return
  if (menuRef.value && menuRef.value.contains(e.target)) return
  emit('close')
}

function onScrollOrResize() {
  if (props.show) emit('close')
}

watch(() => props.show, (v) => {
  if (v) {
    window.addEventListener('keydown', onKeyDown, true)
    // capture 阶段监听，确保比编辑器内部的 mousedown 先拿到事件
    document.addEventListener('mousedown', onDocMouseDown, true)
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
  } else {
    teardown()
  }
})

function teardown() {
  window.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('resize', onScrollOrResize)
  window.removeEventListener('scroll', onScrollOrResize, true)
}

onBeforeUnmount(teardown)

defineExpose({ menuRef })
</script>

<style scoped>
.spell-menu {
  position: fixed;
  z-index: 10000;
  background: var(--color-bg-primary, #fff);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08);
  padding: 6px;
  overflow: hidden;
  font-size: 13px;
  color: var(--color-text-primary, #1f2328);
  user-select: none;
}

.spell-menu__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px 6px;
  border-bottom: 1px solid var(--color-border-light, rgba(0, 0, 0, 0.06));
  margin-bottom: 4px;
}

.spell-menu__word {
  font-family: var(--font-mono), Consolas, monospace;
  font-weight: 600;
  font-size: 13px;
  word-break: break-all;
  color: var(--state-error, #d1242f);
}

.spell-menu__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.spell-menu__close:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.spell-menu__label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: 4px 8px 2px;
}

.spell-menu__section {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.spell-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  color: var(--color-text-primary);
  background: transparent;
  border: none;
  font-size: 13px;
}

.spell-menu__item:hover {
  background: var(--color-surface-hover);
}

.spell-menu__item .spell-menu__hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.spell-menu__empty {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.spell-pop-enter-active,
.spell-pop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.spell-pop-enter-from,
.spell-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
