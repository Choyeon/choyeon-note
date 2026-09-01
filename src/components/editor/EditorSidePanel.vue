<template>
  <aside
    class="editor-side-panel"
    :style="{ borderColor: 'var(--sidebar-border)' }"
  >
    <!-- Tabs -->
    <div class="editor-side-panel__tabs" :style="{ borderColor: 'var(--color-border)' }">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="editor-side-panel__tab"
        :class="{ 'is-active': modelValue === tab.key }"
        @click="emit('update:modelValue', tab.key)"
      >
        <component :is="tab.icon" class="w-3.5 h-3.5 shrink-0" />
        <span class="text-[12px] font-medium whitespace-nowrap">{{ tab.label }}</span>
        <span v-if="tab.badge > 0" class="editor-side-panel__badge">{{ tab.badge }}</span>
      </button>
    </div>

    <div class="editor-side-panel__body cho-scrollbar">
      <!-- ============ 大纲 ============ -->
      <div v-if="modelValue === 'outline'" class="flex flex-col gap-0.5">
        <button
          v-for="(item, index) in outline"
          :key="'o' + index"
          class="outline-item"
          :style="{ paddingLeft: `${8 + (item.level - 1) * 12}px` }"
          @click="emit('scroll-to-heading', item)"
        >
          <span
            class="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
            :style="{ fontWeight: item.level === 1 ? '600' : '500', color: 'var(--color-text-secondary)' }"
          >{{ item.text }}</span>
        </button>
        <div v-if="!outline.length" class="panel-empty">暂无大纲，用 # 标题生成</div>
      </div>

      <!-- ============ 反向链接 ============ -->
      <div v-else-if="modelValue === 'backlinks'" class="flex flex-col gap-2">
        <div v-if="!backlinks.length" class="panel-empty">暂无反向链接，用 [[笔记名]] 建立引用</div>
        <template v-else>
          <div
            v-for="group in groupedBacklinks"
            :key="group.id"
            class="panel-card"
            :style="{ border: '1px solid var(--color-border-light)' }"
          >
            <div class="panel-card__head" @click="emit('open-note', group.id)">
              <div class="flex items-center min-w-0">
                <FileText class="w-3.5 h-3.5 mr-2 shrink-0" :style="{ color: 'var(--color-text-secondary)' }" />
                <span class="text-[13px] font-medium truncate" :style="{ color: 'var(--color-text-primary)' }">{{ group.title }}</span>
              </div>
              <ChevronRight class="w-3.5 h-3.5 shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
            </div>
            <div
              v-for="(m, idx) in group.matches"
              :key="idx"
              class="panel-card__row"
              :style="{ borderColor: 'var(--color-border-light)', color: 'var(--color-text-secondary)' }"
              @click="emit('open-note', group.id)"
            >
              <span v-html="highlightWikiContext(m.context || '')"></span>
            </div>
          </div>
        </template>
      </div>

      <!-- ============ 出站链接 ============ -->
      <div v-else-if="modelValue === 'outgoing'" class="flex flex-col gap-2">
        <div v-if="!outgoing.length" class="panel-empty">暂无出站链接</div>
        <template v-else>
          <div class="panel-note" :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border-light)' }">
            已解析 {{ outgoing.length }} 个链接 · {{ unresolvedCount }} 个未找到
          </div>
          <div
            v-for="(link, idx) in outgoing"
            :key="'out' + idx"
            class="panel-link"
            :style="{ border: '1px solid var(--color-border-light)' }"
            @click="emit('open-link', link)"
          >
            <component
              :is="link.embed ? Image : ExternalLink"
              class="w-3.5 h-3.5 mr-2 shrink-0"
              :style="{ color: link.resolvedId ? 'var(--color-primary)' : 'var(--state-warning)' }"
            />
            <div class="min-w-0 flex-1">
              <div class="text-[13px] font-medium truncate" :style="{ color: 'var(--color-text-primary)' }">
                {{ link.alias || link.displayTitle || link.target }}
              </div>
              <div class="text-[11px] truncate" :style="{ color: 'var(--color-text-tertiary)' }">
                {{ link.resolvedId ? (link.targetFolder || '根目录') : '未创建 · 点击可新建' }}
              </div>
            </div>
            <span v-if="link.embed" class="panel-tag">嵌入</span>
          </div>
        </template>
      </div>

      <!-- ============ 属性 ============ -->
      <div v-else class="flex flex-col gap-1.5 px-0.5">
        <div class="flex items-center justify-between px-2 py-1.5">
          <span class="panel-label">属性 Frontmatter</span>
          <button class="panel-link-btn" @click="emit('ensure-frontmatter')">+ 添加</button>
        </div>

        <div v-if="!propertyKeys.length" class="panel-empty">还没有属性，点击右上「添加」或在文档顶部写 YAML。</div>

        <template v-else>
          <div
            v-for="key in propertyKeys"
            :key="key"
            class="panel-prop"
            :style="{ border: '1px solid var(--color-border-light)' }"
          >
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">{{ key }}</span>
              <button class="panel-danger-btn" @click="emit('remove-property', key)">删除</button>
            </div>

            <input
              v-if="!Array.isArray(frontmatter[key])"
              type="text"
              class="panel-input"
              :value="String(frontmatter[key] ?? '')"
              :style="{ color: 'var(--color-text-primary)' }"
              @change="emit('update-property', key, $event.target.value)"
            />

            <div v-else class="mt-0.5 flex flex-wrap gap-1.5">
              <span
                v-for="(tag, i) in frontmatter[key]"
                :key="i"
                class="panel-chip"
                :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
              >
                {{ tag }}
                <button class="opacity-60 hover:opacity-100" @click="emit('remove-array-item', key, i)">×</button>
              </span>
              <input
                type="text"
                placeholder="+ 新值"
                class="panel-input chip-input"
                :style="{ color: 'var(--color-text-secondary)' }"
                @keydown.enter.prevent="onAppend(key, $event.target)"
              />
            </div>
          </div>

          <div class="mt-2">
            <div class="text-[11px] px-2 mb-1" :style="{ color: 'var(--color-text-tertiary)' }">新建属性</div>
            <div class="flex items-center gap-1.5 px-2">
              <input
                v-model="newProp.key"
                type="text"
                placeholder="Key"
                class="panel-input boxed"
                :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
              />
              <input
                v-model="newProp.value"
                type="text"
                placeholder="Value"
                class="panel-input boxed"
                :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
                @keydown.enter.prevent="submitNewProperty"
              />
              <button class="panel-primary-btn" @click="submitNewProperty">+</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue'
import { FileText, ChevronRight, ExternalLink, Image, ListTree, Link2, Settings2 } from 'lucide-vue-next'

const props = defineProps({
  modelValue: { type: String, default: 'outline' },
  outline: { type: Array, default: () => [] },
  backlinks: { type: Array, default: () => [] },
  outgoing: { type: Array, default: () => [] },
  frontmatter: { type: Object, default: () => ({}) }
})

const emit = defineEmits([
  'update:modelValue', 'scroll-to-heading', 'open-note', 'open-link',
  'ensure-frontmatter', 'update-property', 'remove-property',
  'append-array-item', 'remove-array-item', 'add-property'
])

const newProp = ref({ key: '', value: '' })

const unresolvedCount = computed(() => props.outgoing.filter((l) => !l.resolvedId).length)

const propertyKeys = computed(() => Object.keys(props.frontmatter || {}))

const tabs = computed(() => [
  { key: 'outline', label: '大纲', icon: ListTree, badge: props.outline.length },
  { key: 'backlinks', label: '反向链接', icon: Link2, badge: props.backlinks.length },
  { key: 'outgoing', label: '出站链接', icon: ExternalLink, badge: props.outgoing.length },
  { key: 'properties', label: '属性', icon: Settings2, badge: 0 }
])

const groupedBacklinks = computed(() => {
  const map = new Map()
  for (const b of props.backlinks) {
    const key = b.fromId || b.raw || ''
    if (!map.has(key)) {
      map.set(key, { id: b.fromId, title: b.fromTitle || '(未知笔记)', matches: [] })
    }
    map.get(key).matches.push({ context: b.context || b.raw, alias: b.alias })
  }
  return Array.from(map.values())
})

function highlightWikiContext(text) {
  if (!text) return ''
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(
    /(!?\[\[[^[\]]*?\]\])/g,
    '<span style="color:var(--color-primary);font-weight:500;">$1</span>'
  )
}

function onAppend(key, inputEl) {
  const v = (inputEl.value || '').trim()
  if (!v) return
  emit('append-array-item', key, v)
  inputEl.value = ''
}

function submitNewProperty() {
  const k = newProp.value.key?.trim()
  if (!k) return
  let v = newProp.value.value
  if (['tags', 'tag', 'categories', 'category'].includes(k)) {
    v = v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []
  }
  emit('add-property', k, v)
  newProp.value = { key: '', value: '' }
}
</script>

<style scoped>
.editor-side-panel {
  width: 300px;
  min-width: 300px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid transparent;
  background: var(--sidebar-bg, transparent);
  backdrop-filter: var(--sidebar-blur, none);
}

.editor-side-panel__tabs {
  display: flex;
  align-items: stretch;
  height: 38px;
  min-height: 38px;
  border-bottom: 1px solid transparent;
  padding: 0 8px;
  gap: 2px;
  overflow-x: auto;
}

.editor-side-panel__tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
  color: var(--color-text-tertiary);
  transition: color 0.12s ease, border-color 0.12s ease;
}

.editor-side-panel__tab:hover {
  color: var(--color-text-secondary);
}

.editor-side-panel__tab.is-active {
  border-bottom-color: var(--color-primary);
  color: var(--color-primary);
}

.editor-side-panel__badge {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.editor-side-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.panel-empty {
  font-size: 13px;
  padding: 16px 8px;
  text-align: center;
  color: var(--color-text-tertiary);
}

.outline-item {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  background: none;
  border: none;
  width: 100%;
  transition: background 0.12s ease;
}

.outline-item:hover {
  background: var(--color-surface-hover);
}

.panel-card {
  border-radius: 8px;
  overflow: hidden;
}

.panel-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  height: 32px;
  cursor: pointer;
  background: var(--color-surface);
}

.panel-card__head:hover {
  background: var(--color-surface-hover);
}

.panel-card__row {
  padding: 8px 12px;
  font-size: 12px;
  border-top: 1px solid transparent;
  cursor: pointer;
}

.panel-card__row:hover {
  background: var(--color-surface-hover);
}

.panel-note {
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.panel-link {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.panel-link:hover {
  background: var(--color-surface-hover);
}

.panel-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  margin-left: 8px;
  flex-shrink: 0;
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.panel-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}

.panel-link-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-primary);
  background: none;
  border: none;
}

.panel-link-btn:hover {
  background: var(--color-surface-hover);
}

.panel-danger-btn {
  font-size: 11px;
  opacity: 0.6;
  cursor: pointer;
  color: var(--state-error);
  background: none;
  border: none;
}

.panel-danger-btn:hover {
  opacity: 1;
}

.panel-prop {
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  padding: 6px 10px;
}

.panel-input {
  margin-top: 2px;
  font-size: 13px;
  background: transparent;
  outline: none;
  border: none;
  width: 100%;
}

.panel-input.boxed {
  flex: 1;
  width: auto;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
}

.panel-input.chip-input {
  width: 64px;
  font-size: 12px;
}

.panel-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
}

.panel-primary-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  background: var(--color-primary);
  color: #fff;
  border: none;
}
</style>
