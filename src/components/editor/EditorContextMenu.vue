<template>
  <!-- ================= 右键菜单 =================
       纯展示层：坐标 / 是否有选区由父级算好传进来，菜单项只发事件，
       真正的执行（applyCommand / 剪贴板 / 只读模式拦截）留在父级。 -->
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="show"
        class="fixed inset-0 z-50"
        @click="emit('close')"
        @contextmenu.prevent="emit('close')"
      >
        <div
          class="context-menu absolute rounded-lg overflow-hidden shadow-lg"
          :style="{
            left: x + 'px',
            top: y + 'px',
            background: 'var(--color-surface-elevated)',
            border: '1px solid var(--color-border)',
            minWidth: '240px',
            padding: '6px',
            backdropFilter: 'none',
            zIndex: 9999
          }"
          @click.stop
        >
          <template v-if="hasSelection">
            <div class="context-menu-label">格式化</div>
            <button class="context-menu-item" @click="emit('action', 'format.bold')">
              <Bold class="w-3.5 h-3.5" />
              <span>粗体</span>
              <span class="context-menu-shortcut">{{ shortcutHint('format.bold') }}</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.italic')">
              <Italic class="w-3.5 h-3.5" />
              <span>斜体</span>
              <span class="context-menu-shortcut">{{ shortcutHint('format.italic') }}</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.code')">
              <Code class="w-3.5 h-3.5" />
              <span>行内代码</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.link')">
              <Link class="w-3.5 h-3.5" />
              <span>链接</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.highlight')">
              <Highlighter class="w-3.5 h-3.5" />
              <span>高亮</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.strikethrough')">
              <Strikethrough class="w-3.5 h-3.5" />
              <span>删除线</span>
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" @click="emit('action', 'format.h1')">
              <Heading1 class="w-3.5 h-3.5" />
              <span>一级标题</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.h2')">
              <Heading2 class="w-3.5 h-3.5" />
              <span>二级标题</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.h3')">
              <Heading3 class="w-3.5 h-3.5" />
              <span>三级标题</span>
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" @click="emit('action', 'format.quote')">
              <Quote class="w-3.5 h-3.5" />
              <span>引用</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.bulletList')">
              <List class="w-3.5 h-3.5" />
              <span>无序列表</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'format.taskList')">
              <CheckSquare class="w-3.5 h-3.5" />
              <span>待办事项</span>
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" @click="emit('copy')">
              <Copy class="w-3.5 h-3.5" />
              <span>复制</span>
              <span class="context-menu-shortcut">{{ nativeHint('C') }}</span>
            </button>
            <button class="context-menu-item" @click="emit('cut')">
              <Scissors class="w-3.5 h-3.5" />
              <span>剪切</span>
              <span class="context-menu-shortcut">{{ nativeHint('X') }}</span>
            </button>
          </template>
          <template v-else>
            <button class="context-menu-item" @click="emit('paste')">
              <ClipboardPaste class="w-3.5 h-3.5" />
              <span>粘贴</span>
              <span class="context-menu-shortcut">{{ nativeHint('V') }}</span>
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" @click="emit('action', 'edit.selectAll')">
              <Check class="w-3.5 h-3.5" />
              <span>全选</span>
              <span class="context-menu-shortcut">{{ shortcutHint('edit.selectAll') }}</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'edit.undo')">
              <Undo2 class="w-3.5 h-3.5" />
              <span>撤销</span>
              <span class="context-menu-shortcut">{{ shortcutHint('edit.undo') }}</span>
            </button>
            <button class="context-menu-item" @click="emit('action', 'edit.redo')">
              <Redo2 class="w-3.5 h-3.5" />
              <span>重做</span>
              <span class="context-menu-shortcut">{{ shortcutHint('edit.redo') }}</span>
            </button>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import {
  Bold, Italic, Code, Link, List, CheckSquare,
  Heading1, Heading2, Heading3, Quote, Highlighter,
  Strikethrough, Copy, Scissors, ClipboardPaste, Check,
  Undo2, Redo2
} from 'lucide-vue-next'

defineProps({
  /** 是否显示（父级持有显隐状态：切笔记、切模式都要能一键复位） */
  show: { type: Boolean, default: false },
  /** 视口坐标：父级已按菜单估算尺寸做过防溢出夹取 */
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  /** 有选区时给出格式化项，否则只给粘贴 / 全选 / 撤销 / 重做 */
  hasSelection: { type: Boolean, default: false },
  /** 快捷键文案（读 appStore 的按键绑定），由父级注入以保持单一来源 */
  shortcutHint: { type: Function, default: () => '' },
  /** 复制/剪切/粘贴这类系统键的文案（Ctrl / ⌘），由父级按平台注入 */
  nativeHint: { type: Function, default: () => '' }
})

const emit = defineEmits(['close', 'action', 'copy', 'cut', 'paste'])
</script>

<style scoped>
/* 菜单本体样式走全局 .context-menu*（style.css），与设置页等其它右键菜单共用一份。
   这里只补 Teleport 之后拿不到的那部分：父级 scoped 的 fade 过渡。
   与原先 EditorView 里的定义逐字一致（全局 .fade-* 用 CSS 变量，时长/曲线不同）。 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.14s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
