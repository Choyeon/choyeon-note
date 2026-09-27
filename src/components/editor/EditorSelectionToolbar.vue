<template>
  <!-- ================= 浮动选区工具栏 =================
       位置由父级传入的选区屏幕坐标算出（原 EditorView.onSelectionChange 的定位
       逻辑原样搬来）；按钮只上报命令 id，真正执行仍在父级 —— 只有父级拿得到
       editorApi，也才知道当前是不是只读的阅读模式。 -->
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="pos"
        class="fixed z-50"
        :style="{
          left: pos.x + 'px',
          top: pos.y + 'px',
          transform: pos.placement === 'top'
            ? 'translate(-50%, -100%)'
            : 'translate(-50%, 0)'
        }"
        @mousedown.prevent
      >
        <div
          class="floating-toolbar flex items-center gap-0.5 rounded-lg overflow-hidden shadow-lg"
          :style="{
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            padding: '4px'
          }"
        >
          <button class="ft-btn" title="加粗" @mousedown.prevent="emit('command', 'format.bold')">
            <Bold class="w-3.5 h-3.5" />
          </button>
          <button class="ft-btn" title="斜体" @mousedown.prevent="emit('command', 'format.italic')">
            <Italic class="w-3.5 h-3.5" />
          </button>
          <button class="ft-btn" title="删除线" @mousedown.prevent="emit('command', 'format.strikethrough')">
            <Strikethrough class="w-3.5 h-3.5" />
          </button>
          <button class="ft-btn" title="行内代码" @mousedown.prevent="emit('command', 'format.code')">
            <Code class="w-3.5 h-3.5" />
          </button>
          <button class="ft-btn" title="高亮" @mousedown.prevent="emit('command', 'format.highlight')">
            <Highlighter class="w-3.5 h-3.5" />
          </button>
          <button class="ft-btn" title="链接" @mousedown.prevent="emit('command', 'format.link')">
            <Link class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'
import { Bold, Italic, Code, Link, Highlighter, Strikethrough } from 'lucide-vue-next'

const props = defineProps({
  /**
   * 当前选区的屏幕坐标 { left, right, top, bottom }。
   * 传 null（无选区 / 阅读模式 / 点开了右键菜单）即隐藏工具栏 —— 显隐判定留在父级，
   * 这里只负责把它换算成最终坐标。
   */
  coords: { type: Object, default: null }
})

const emit = defineEmits(['command'])

/** 工具栏实测尺寸：用于视口夹取与「顶部放不下就翻到下方」的判定 */
const TOOLBAR_WIDTH = 268
const TOOLBAR_HEIGHT = 40
const EDGE_MARGIN = 8

const pos = computed(() => {
  const coords = props.coords
  if (!coords) return null
  // 水平居中于选区，再夹进视口，避免贴边被裁掉
  let x = (coords.left + coords.right) / 2
  x = Math.max(
    EDGE_MARGIN + TOOLBAR_WIDTH / 2,
    Math.min(window.innerWidth - EDGE_MARGIN - TOOLBAR_WIDTH / 2, x)
  )
  // 选区离顶栏太近时改挂到选区下方，否则会盖住第一行
  const showBelow = coords.top < TOOLBAR_HEIGHT + 60
  return {
    x,
    y: showBelow ? coords.bottom + 10 : coords.top - 10,
    placement: showBelow ? 'bottom' : 'top'
  }
})
</script>

<style scoped>
/* ===== 浮动工具栏 ===== */
.ft-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  transition: background 0.15s ease;
}

.ft-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-primary);
}

/* Teleport 到 body 后不再受父级 scoped 样式覆盖，这里自带一份：
   与原先 EditorView 里的定义逐字一致（全局 .fade-* 用的是 CSS 变量，
   时长/曲线与这里不同，不能借全局那份）。 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.14s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
