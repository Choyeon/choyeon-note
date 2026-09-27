<template>
  <!--
    快捷键速查表（T08）—— app 级只读模态。

    为什么用 Teleport 挂到 body：App.vue 的根容器与多个视图都带 overflow: hidden，
    内联渲染会被裁切（PromptDialog.vue 里踩过同一个坑）。

    为什么组件里没有自己的 open/visible ref：开关状态一旦在组件里再存一份，
    store 里那份就会变成死代码（App.vue 的 Mod-/ 切的是 store，组件看不见）。
    本组件**只读** appStore.shortcutCheatsheetOpen，关闭一律走 closeShortcutCheatsheet()。
  -->
  <Teleport to="body">
    <Transition name="sc" appear>
      <div
        v-if="appStore.shortcutCheatsheetOpen"
        class="sc-backdrop"
        role="presentation"
        @click.self="close"
      >
        <div
          class="sc-panel"
          role="dialog"
          aria-modal="true"
          aria-label="快捷键速查表"
          tabindex="-1"
        >
          <header class="sc-head">
            <Keyboard class="sc-head-icon" />
            <h2 class="sc-title">快捷键速查表</h2>
            <span class="sc-count">{{ countLabel }}</span>
            <button
              class="sc-close"
              type="button"
              aria-label="关闭速查表"
              title="关闭（Esc）"
              @click="close"
            >
              <kbd>Esc</kbd>
            </button>
          </header>

          <div class="sc-search">
            <Search class="sc-search-icon" />
            <input
              ref="inputRef"
              v-model="query"
              class="sc-input"
              type="text"
              placeholder="搜索命令或按键…（如「加粗」「Ctrl」）"
              aria-label="搜索快捷键"
              @keydown.esc.prevent="close"
            />
            <button
              v-if="query"
              class="sc-clear"
              type="button"
              aria-label="清空搜索"
              @click="query = ''"
            >
              ×
            </button>
          </div>

          <div class="sc-body cho-scrollbar">
            <template v-if="groups.length > 0">
              <section v-for="group in groups" :key="group.id" class="sc-group">
                <h3 class="sc-group-title">
                  {{ group.label }}
                  <span class="sc-group-count">{{ group.items.length }}</span>
                </h3>
                <div class="sc-grid">
                  <div v-for="item in group.items" :key="item.id" class="sc-row">
                    <span class="sc-row-label">
                      <span
                        v-for="(seg, i) in highlight(item.label)"
                        :key="i"
                        :class="seg.hit ? 'sc-hit' : ''"
                      >{{ seg.text }}</span>
                      <!-- 已自定义标记：小圆点，主色浅底 + 主色描边，不额外占文字空间 -->
                      <span
                        v-if="item.customized"
                        class="sc-dot"
                        title="已自定义键位"
                        aria-label="已自定义键位"
                      />
                    </span>
                    <!-- 未绑定的命令不渲染胶囊：一排灰色「未设置」之外的空胶囊纯属视觉噪音（PRD §5.2） -->
                    <span v-if="item.parts.length > 0" class="sc-keys">
                      <kbd
                        v-for="(part, i) in item.parts"
                        :key="i"
                        class="sc-kbd"
                        :class="isKeyHit(part) ? 'sc-kbd-hit' : ''"
                      >{{ part }}</kbd>
                    </span>
                    <span v-else class="sc-unset">未设置</span>
                  </div>
                </div>
              </section>
            </template>

            <div v-else class="sc-empty">
              <SearchX class="sc-empty-icon" />
              <div class="sc-empty-title">没有匹配的快捷键</div>
              <div class="sc-empty-desc">
                试试搜索命令名（如「加粗」）或按键名（如「Ctrl」「Alt」）
              </div>
            </div>
          </div>

          <footer class="sc-foot">
            <span class="sc-hint"><kbd>Esc</kbd> 关闭</span>
            <span class="sc-hint">显示的是你当前的键位（含自定义改动）</span>
            <button class="sc-settings-btn" type="button" @click="openSettings">
              打开快捷键设置
              <span class="sc-settings-arrow" aria-hidden="true">→</span>
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import {
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  bindingParts,
  formatBinding,
  normalizeBinding
} from '@/constants/shortcuts'
import { Keyboard, Search, SearchX } from 'lucide-vue-next'

const appStore = useAppStore()
const router = useRouter()

/** 搜索词（唯一一份本地状态；面板的开关状态在 store 里，这里刻意不复制） */
const query = ref('')
const inputRef = ref(null)

/**
 * 关键词切分：空格分隔的多个词之间是「与」关系。
 * 这样搜「ctrl b」能收敛到少量结果，而不是退化成搜一段含空格的长串。
 */
const tokens = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean))

/**
 * 构造一条命令的检索文本（小写）。
 *
 * 为什么要塞这么多字段：速查表的搜索必须**同时**命中中文标签和按键名 ——
 * 用户想找「加粗」时打的是中文，想找「哪些命令用了 Ctrl」时打的是按键名。
 * 只匹配绑定串原文（'Mod-b'）会导致 Win 上搜「Ctrl」永远搜不到（设置页就有这个
 * 历史问题），所以这里额外并入 `bindingParts` 的展示名（Win: Ctrl / mac: ⌘）
 * 以及 `formatBinding` 的连写形式。
 *
 * 修饰键别名（`Mod` → ctrl/cmd/⌘ 等）是刻意加的：mac 上展示成 ⌘，
 * 但用户仍可能按肌肉记忆搜「ctrl」，不加别名就会漏。
 *
 * @param {{ id: string, label: string }} command 注册表条目
 * @param {string} binding 用户当前绑定串
 * @param {string[]} parts bindingParts 的展示标签
 * @returns {string} 小写检索文本
 */
function buildHaystack (command, binding, parts) {
  const raw = normalizeBinding(binding)
  const aliases = []
  if (raw.includes('Mod')) aliases.push('ctrl cmd ⌘')
  if (raw.includes('Shift')) aliases.push('⇧')
  if (raw.includes('Alt')) aliases.push('⌥ option')
  return [
    command.label,
    command.id,
    raw,
    formatBinding(binding),
    parts.join(' '),
    parts.join(''),
    aliases.join(' ')
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * 全量可见行（排除 hidden 命令）。
 *
 * 显示的必须是**用户改过之后的键位**：一律走 `appStore.getBinding(id)`，
 * 绝不直接读 `s.default` —— 否则用户在设置页改完键，速查表还显示旧键，
 * 就成了第二份「与实际生效不一致」的假数据。
 */
const rows = computed(() =>
  SHORTCUTS.filter(s => !s.hidden).map(s => {
    const binding = appStore.getBinding(s.id)
    const parts = bindingParts(binding)
    return {
      id: s.id,
      label: s.label,
      category: s.category,
      binding,
      parts,
      // 与默认值（规范化后）不同 → 用户自定义过。空串对空串视为未改动
      customized: normalizeBinding(binding) !== normalizeBinding(s.default),
      haystack: buildHaystack(s, binding, parts)
    }
  })
)

/** 按 SHORTCUT_CATEGORIES 的既定顺序分组；搜索命中为空的分类整组不渲染 */
const groups = computed(() => {
  const matched = tokens.value.length === 0
    ? rows.value
    : rows.value.filter(row => tokens.value.every(t => row.haystack.includes(t)))

  return SHORTCUT_CATEGORIES
    .map(cat => ({
      id: cat.id,
      label: cat.label,
      items: matched.filter(row => row.category === cat.id)
    }))
    .filter(group => group.items.length > 0)
})

/** 命中条数（搜索态）与总条数（未搜索） */
const matchedCount = computed(() => groups.value.reduce((sum, g) => sum + g.items.length, 0))
const countLabel = computed(() =>
  tokens.value.length === 0 ? `${rows.value.length} 条` : `${matchedCount.value} / ${rows.value.length} 条`
)

/**
 * 把标签按命中词切成高亮片段。
 *
 * 刻意**不用 v-html**：标签虽是常量中文，但拼接 HTML 一旦将来接入用户自定义命令名
 * 就是一个 XSS 缺口。切成片段数组再逐段渲染，视觉效果一样、风险为零。
 *
 * @param {string} text 命令标签
 * @returns {{ text: string, hit: boolean }[]} 片段数组（无命中时返回整段）
 */
function highlight (text) {
  const lower = String(text).toLowerCase()
  const hits = tokens.value.filter(t => t && lower.includes(t))
  if (hits.length === 0) return [{ text, hit: false }]

  // 标记每个字符是否被任一命中词覆盖，再合并成连续片段，避免多次命中时重复切
  const flags = new Array(text.length).fill(false)
  for (const token of hits) {
    let from = lower.indexOf(token)
    while (from !== -1) {
      for (let i = from; i < from + token.length; i += 1) flags[i] = true
      from = lower.indexOf(token, from + token.length)
    }
  }

  const segments = []
  for (let i = 0; i < text.length; i += 1) {
    const last = segments[segments.length - 1]
    if (last && last.hit === flags[i]) last.text += text[i]
    else segments.push({ text: text[i], hit: flags[i] })
  }
  return segments
}

/** 某个按键胶囊是否被搜索词命中（用于给搜「Ctrl」时的键位加高亮） */
function isKeyHit (part) {
  if (tokens.value.length === 0) return false
  const lower = String(part).toLowerCase()
  return tokens.value.some(t => lower.includes(t))
}

function close () {
  appStore.closeShortcutCheatsheet()
}

/** 底部入口：跳设置页（SettingsView 一屏列出全部区块，无需额外定位参数） */
function openSettings () {
  close()
  router.push('/settings')
}

/**
 * 全局 Escape 兜底：焦点可能不在输入框（例如点过行内元素之后），
 * 只在 window 上挂一处监听即可。与 QuickSwitcher.vue 的规范保持一致 ——
 * onMounted 注册、onUnmounted 摘除，绝不留下常驻监听。
 */
function onWindowKeydown (e) {
  if (!appStore.shortcutCheatsheetOpen) return
  // IME 组字中的 Escape 是取消候选词，不能拿去关面板
  if (e.isComposing === true || e.keyCode === 229) return
  if (e.key !== 'Escape') return
  e.preventDefault()
  close()
}

// 打开时重置搜索词并把焦点落到搜索框；v-if 让输入框在下一帧才存在，故用 nextTick
watch(
  () => appStore.shortcutCheatsheetOpen,
  async (open) => {
    if (!open) return
    query.value = ''
    await nextTick()
    inputRef.value?.focus?.()
  }
)

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<style scoped>
.sc-backdrop {
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

.sc-panel {
  width: min(880px, calc(100vw - 48px));
  max-height: min(78vh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius-lg, 12px);
  border: 1px solid var(--color-border);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-float);
  outline: none;
}

.sc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--color-border-light);
}

.sc-head-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--color-primary);
}

.sc-title {
  margin: 0;
  font-family: var(--font-title);
  font-size: var(--font-size-lg, 16px);
  font-weight: 600;
  color: var(--color-text-primary);
}

.sc-count {
  font-size: var(--font-size-xs, 12px);
  color: var(--color-text-tertiary);
  padding: 2px 8px;
  border-radius: var(--radius-full, 9999px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-light);
}

.sc-close {
  margin-left: auto;
  padding: 4px 8px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  cursor: pointer;
  transition: background var(--transition-micro);
}
.sc-close:hover {
  background: var(--color-surface-hover);
}
.sc-close kbd {
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs, 11px);
  color: var(--color-text-tertiary);
}

.sc-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 16px 4px;
  padding: 0 10px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  transition:
    border-color var(--transition-smooth),
    box-shadow var(--transition-smooth),
    background-color var(--transition-smooth);
}
.sc-search:focus-within {
  background: var(--color-surface);
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.sc-search-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

.sc-input {
  flex: 1;
  min-width: 0;
  padding: 9px 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--font-size-body, 14px);
  color: var(--color-text-primary);
  caret-color: var(--color-primary);
}
.sc-input::placeholder {
  color: var(--color-text-tertiary);
}

.sc-clear {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-full, 9999px);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.sc-clear:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.sc-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 16px 12px;
}

.sc-group + .sc-group {
  margin-top: 14px;
}

.sc-group-title {
  margin: 0 0 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  color: var(--color-text-tertiary);
}

.sc-group-count {
  font-size: var(--font-size-3xs, 10px);
  padding: 1px 6px;
  border-radius: var(--radius-full, 9999px);
  background: var(--color-bg-tertiary);
}

/* 两列网格；窄屏降为单列（PRD §5.2） */
.sc-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 14px;
}

.sc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 6px;
  border-radius: var(--radius-sm, 6px);
}

.sc-row-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 1;
  font-size: var(--font-size-sm, 13px);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sc-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full, 9999px);
  background: var(--color-primary-surface);
  border: 1px solid var(--color-primary);
}

.sc-hit {
  color: var(--color-primary);
  background: var(--color-primary-surface);
  border-radius: 3px;
}

.sc-keys {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.sc-kbd {
  min-width: 20px;
  padding: 2px 6px;
  text-align: center;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs, 11px);
  color: var(--color-text-secondary);
}

.sc-kbd-hit {
  border-color: var(--color-primary);
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.sc-unset {
  flex-shrink: 0;
  font-size: var(--font-size-2xs, 11px);
  color: var(--color-text-tertiary);
}

.sc-empty {
  padding: 34px 20px 40px;
  text-align: center;
  color: var(--color-text-tertiary);
}
.sc-empty-icon {
  width: 26px;
  height: 26px;
  margin: 0 auto 10px;
  opacity: 0.7;
}
.sc-empty-title {
  font-size: var(--font-size-body, 14px);
  color: var(--color-text-secondary);
  margin-bottom: 6px;
}
.sc-empty-desc {
  font-size: var(--font-size-xs, 12px);
}

.sc-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--color-border-light);
  font-size: var(--font-size-xs, 12px);
  color: var(--color-text-tertiary);
}

.sc-hint {
  display: inline-flex;
  align-items: center;
}

.sc-hint kbd {
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

.sc-settings-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-primary);
  background: var(--color-primary-surface);
  color: var(--color-primary);
  font-family: var(--font-body);
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  transition: background var(--transition-micro), transform var(--transition-micro);
}
.sc-settings-btn:hover {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
}
.sc-settings-btn:active {
  transform: translateY(1px);
}
.sc-settings-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.sc-settings-arrow {
  font-size: 13px;
  line-height: 1;
}

/* 入场 / 退场动画 */
.sc-enter-active {
  transition: opacity var(--duration-normal) var(--ease-out-quart);
}
.sc-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out-quart);
}
.sc-enter-active .sc-panel {
  transition:
    transform var(--duration-normal) var(--ease-spring-soft),
    opacity var(--duration-normal) var(--ease-out-quart);
}
.sc-leave-active .sc-panel {
  transition:
    transform var(--duration-fast) var(--ease-out-quart),
    opacity var(--duration-fast) var(--ease-out-quart);
}
.sc-enter-from,
.sc-leave-to {
  opacity: 0;
}
.sc-enter-from .sc-panel,
.sc-leave-to .sc-panel {
  transform: scale(0.97);
  opacity: 0;
}

/* 窄屏：单列 */
@media (max-width: 720px) {
  .sc-backdrop {
    padding: 12px;
  }
  .sc-panel {
    width: calc(100vw - 24px);
    max-height: 86vh;
  }
  .sc-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .sc-foot .sc-hint:nth-of-type(2) {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sc-enter-from .sc-panel,
  .sc-leave-to .sc-panel {
    transform: none;
  }
}
</style>
