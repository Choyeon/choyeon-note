<template>
  <aside
    class="w-[300px] min-w-[300px] h-full acrylic-sidebar flex flex-col overflow-hidden border-l"
    :style="{ borderColor: 'var(--sidebar-border)' }"
  >
    <div
      class="flex items-stretch h-10 min-h-10 border-b px-2 gap-1 overflow-x-auto cho-scrollbar"
      :style="{ borderColor: 'var(--color-border)' }"
    >
      <template v-for="panelTab in rightPanelTabs" :key="panelTab.key">
        <div
          class="flex items-center px-2 cursor-pointer border-b-2 transition-colors whitespace-nowrap shrink-0"
          :style="tab === panelTab.key ? { borderColor: 'var(--color-primary)' } : { borderColor: 'transparent' }"
          @click="setTab(panelTab.key)"
        >
          <component :is="panelTab.icon" class="w-3.5 h-3.5 mr-1" :style="{ color: tab === panelTab.key ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" />
          <span class="text-[12px] font-medium" :style="{ color: tab === panelTab.key ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">{{ panelTab.label }}</span>
          <span
            v-if="panelTab.badge !== undefined && panelTab.badge > 0"
            class="ml-1 text-[10px] px-1.5 rounded-full"
            :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
          >{{ panelTab.badge }}</span>
        </div>
      </template>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar p-2" ref="rightPanelRef">
      <!-- ============= 大纲 ============= -->
      <div v-if="tab === 'outline'" class="flex flex-col gap-0.5">
        <div
          v-for="(item, index) in outlineItems"
          :key="'o'+index"
          class="outline-item flex items-center h-7 px-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          :class="{ 'outline-item-active': index === 0 }"
          :style="{ paddingLeft: `${8 + (item.level - 1) * 12}px` }"
          @click="scrollToHeading(item)"
        >
          <span
            class="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
            :style="{
              fontWeight: item.level === 1 ? '600' : '500',
              color: index === 0 ? 'var(--color-primary)' : 'var(--color-text-secondary)'
            }"
          >{{ item.text }}</span>
        </div>
        <div v-if="outlineItems.length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
          暂无大纲，使用 # 标题 生成
        </div>
      </div>

      <!-- ============= 反向链接 ============= -->
      <div v-else-if="tab === 'backlinks'" class="flex flex-col gap-2">
        <div v-if="backlinksList.length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
          暂无反向链接，使用 [[笔记名]] 来建立引用
        </div>
        <template v-else>
          <div v-for="group in groupedBacklinks" :key="group.id" class="rounded-lg overflow-hidden" :style="{ border: '1px solid var(--color-border-light)' }">
            <div
              class="flex items-center justify-between px-2.5 h-8 cursor-pointer transition-colors"
              :style="{ background: 'var(--color-surface)' }"
              @click="openNote(group.id)"
              @mouseenter="($event.currentTarget.style.background='var(--color-surface-hover)')"
              @mouseleave="($event.currentTarget.style.background='var(--color-surface)')"
            >
              <div class="flex items-center min-w-0">
                <FileText class="w-3.5 h-3.5 mr-2 shrink-0" :style="{ color: 'var(--color-text-secondary)' }" />
                <span class="text-[13px] font-medium truncate" :style="{ color: 'var(--color-text-primary)' }">{{ group.title }}</span>
              </div>
              <ChevronRight class="w-3.5 h-3.5 shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
            </div>
            <div
              v-for="(m, idx) in group.matches"
              :key="idx"
              class="px-3 py-2 text-[12px] border-t cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
              :style="{ borderColor: 'var(--color-border-light)', color: 'var(--color-text-secondary)' }"
              @click="openNote(group.id)"
            >
              <span v-html="highlightWikiContext(m.context || '')"></span>
            </div>
          </div>
        </template>
      </div>

      <!-- ============= 出站链接 ============= -->
      <div v-else-if="tab === 'outgoing'" class="flex flex-col gap-2">
        <div v-if="outgoingList.length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
          暂无出站链接
        </div>
        <template v-else>
          <div class="rounded-lg px-2.5 py-1.5 mb-1" :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border-light)' }">
            <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">已解析 {{ outgoingList.length }} 个链接 · {{ unresolvedOutgoing.length }} 个未找到</span>
          </div>
          <div
            v-for="(link, idx) in outgoingList"
            :key="'out'+idx"
            class="flex items-center justify-between px-2.5 h-9 rounded-lg cursor-pointer transition-colors"
            :class="{ 'opacity-70': !link.resolvedId }"
            :style="{ border: '1px solid var(--color-border-light)' }"
            @click="openOutgoingLink(link)"
            @mouseenter="($event.currentTarget.style.background='var(--color-surface-hover)')"
            @mouseleave="($event.currentTarget.style.background='transparent')"
          >
            <div class="flex items-center min-w-0 flex-1">
              <component
                :is="link.embed ? ImageIcon : ExternalLink"
                class="w-3.5 h-3.5 mr-2 shrink-0"
                :style="{ color: link.resolvedId ? 'var(--color-primary)' : 'var(--state-warning)' }"
              />
              <div class="min-w-0">
                <div class="text-[13px] font-medium truncate" :style="{ color: 'var(--color-text-primary)' }">
                  {{ link.alias || link.displayTitle || link.target }}
                </div>
                <div class="text-[11px] truncate" :style="{ color: 'var(--color-text-tertiary)' }">
                  {{ link.resolvedId ? (link.targetFolder || '根目录') : '未创建 · 点击可新建' }}
                </div>
              </div>
            </div>
            <span
              v-if="link.embed"
              class="text-[10px] px-1.5 rounded shrink-0 ml-2"
              :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
            >嵌入</span>
          </div>
        </template>
      </div>

      <!-- ============= 属性/Frontmatter ============= -->
      <div v-else-if="tab === 'properties'" class="flex flex-col gap-1.5 px-0.5">
        <div class="flex items-center justify-between px-2 py-1.5">
          <span class="text-[11px] font-medium tracking-wide uppercase" :style="{ color: 'var(--color-text-tertiary)' }">属性 Frontmatter</span>
          <button
            class="text-[11px] px-2 py-0.5 rounded-md transition-colors"
            :style="{ color: 'var(--color-primary)' }"
            @click="ensureFrontmatter"
          >+ 添加</button>
        </div>
        <div v-if="Object.keys(frontmatter).length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
          还没有设置属性，点击右上「添加」或直接在文档顶部写 YAML。
        </div>
        <template v-else>
          <div
            v-for="(value, key) in frontmatter"
            :key="key"
            class="flex flex-col rounded-lg px-2.5 py-1.5 transition-colors"
            :style="{ border: '1px solid var(--color-border-light)' }"
            @mouseenter="($event.currentTarget.style.background='var(--color-surface-hover)')"
            @mouseleave="($event.currentTarget.style.background='transparent')"
          >
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">{{ key }}</span>
              <button
                class="text-[11px] opacity-60 hover:opacity-100"
                :style="{ color: 'var(--state-error)' }"
                @click="removeProperty(key)"
              >删除</button>
            </div>
            <input
              v-if="!Array.isArray(value)"
              type="text"
              class="mt-0.5 text-[13px] bg-transparent outline-none"
              :value="String(value ?? '')"
              :style="{ color: 'var(--color-text-primary)' }"
              @change="updateProperty(key, $event.target.value)"
            />
            <div v-else class="mt-0.5 flex flex-wrap gap-1.5">
              <template v-for="(tag, i) in value" :key="i">
                <span
                  class="inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full"
                  :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
                >
                  {{ tag }}
                  <button
                    class="opacity-60 hover:opacity-100"
                    @click="removeArrayItem(key, i)"
                  >×</button>
                </span>
              </template>
              <input
                type="text"
                placeholder="+ 新值"
                class="text-[12px] bg-transparent outline-none w-16"
                :style="{ color: 'var(--color-text-secondary)' }"
                @keydown.enter.prevent="appendArrayItem(key, $event.target)"
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
                class="flex-1 text-[12px] px-2 py-1 rounded-md outline-none"
                :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
              />
              <input
                v-model="newProp.value"
                type="text"
                placeholder="Value"
                class="flex-1 text-[12px] px-2 py-1 rounded-md outline-none"
                :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
              />
              <button
                class="text-[12px] px-2 py-1 rounded-md"
                :style="{ background: 'var(--color-primary)', color: 'white' }"
                @click="addNewProperty"
              >+</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </aside>
</template>

<script setup>
/**
 * 编辑器右栏（大纲 / 反向链接 / 出站链接 / 属性）。
 *
 * 从 EditorView 整体搬过来：模板逐字保留，只把两处"改文档/打开笔记"的动作
 * 改成 emit，由父级决定怎么做（父级才知道当前是不是阅读模式、要不要落盘）。
 *
 * Tab 通过 v-model:tab 与父级双向绑定（父级接到 appStore 的持久化状态）。
 */
import { ref, computed, watch } from 'vue'
import { useNoteStore } from '@/stores/note'
import { parseFrontmatter } from '@/composables/useLinks.js'
import {
  FileText, ChevronRight, ExternalLink, ListTree, Link2, Settings2,
  Image as ImageIcon
} from 'lucide-vue-next'

const props = defineProps({
  /** 当前笔记正文：frontmatter / 出站链接都从它派生 */
  content: { type: String, default: '' },
  /** 当前笔记对象（提供 id / title / folder） */
  note: { type: Object, default: null },
  /** 当前笔记大纲：父级已经算好，这里直接用，避免同一份正文解析两次 */
  outline: { type: Array, default: () => [] },
  /** 当前激活的 Tab（v-model:tab） */
  tab: { type: String, default: 'outline' }
})

const emit = defineEmits(['update:tab', 'update:content', 'open-note', 'scroll-to-heading'])

const noteStore = useNoteStore()

const rightPanelRef = ref(null)
const newProp = ref({ key: '', value: '' })

/** 切换笔记时清掉「新建属性」输入框的残留（原 EditorView 的 resetTransientUiState 行为） */
watch(() => props.note?.id, () => {
  newProp.value = { key: '', value: '' }
})

// =========================== Tabs ===========================
const outlineItems = computed(() => props.outline || [])

const rightPanelTabs = computed(() => [
  { key: 'outline', label: '大纲', icon: ListTree, badge: outlineItems.value.length || undefined },
  { key: 'backlinks', label: '反向链接', icon: Link2, badge: backlinksList.value.length || undefined },
  { key: 'outgoing', label: '出站链接', icon: ExternalLink, badge: outgoingList.value.length || undefined },
  { key: 'properties', label: '属性', icon: Settings2 }
])

function setTab(key) {
  if (!key || key === props.tab) return
  emit('update:tab', key)
}

// =========================== Frontmatter ===========================
const parsedFrontmatter = computed(() => parseFrontmatter(props.content || ''))
const frontmatter = computed(() => parsedFrontmatter.value.frontmatter || {})

function setContent(next) {
  emit('update:content', next)
}

function ensureFrontmatter() {
  const { body, hasFrontmatter } = parsedFrontmatter.value
  if (hasFrontmatter) return
  const preamble = '---\ntitle: ' + JSON.stringify(props.note?.title || '无标题') + '\ntags: []\ndate: ' + new Date().toISOString().slice(0, 10) + '\n---\n\n'
  setContent(preamble + (body || props.content || ''))
}

function updateProperty(key, value) {
  noteStore.updateNoteFrontmatter?.(props.note?.id, { [key]: value })
}

function removeProperty(key) {
  noteStore.updateNoteFrontmatter?.(props.note?.id, { [key]: undefined })
}

function addNewProperty() {
  const k = newProp.value.key?.trim()
  if (!k) return
  let v = newProp.value.value
  if (k === 'tags' || k === 'tag' || k === 'categories' || k === 'category') {
    v = v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []
  }
  noteStore.updateNoteFrontmatter?.(props.note?.id, { [k]: v })
  newProp.value = { key: '', value: '' }
}

function appendArrayItem(key, inputEl) {
  const v = (inputEl.value || '').trim()
  if (!v) return
  const arr = Array.isArray(frontmatter.value[key]) ? [...frontmatter.value[key]] : []
  if (!arr.includes(v)) arr.push(v)
  noteStore.updateNoteFrontmatter?.(props.note?.id, { [key]: arr })
  inputEl.value = ''
}

function removeArrayItem(key, index) {
  const arr = Array.isArray(frontmatter.value[key]) ? [...frontmatter.value[key]] : []
  arr.splice(index, 1)
  noteStore.updateNoteFrontmatter?.(props.note?.id, { [key]: arr })
}

// =========================== 反向 / 出站链接 ===========================
const backlinksList = computed(() => {
  const id = props.note?.id
  if (!id) return []
  try { return noteStore.getBacklinks?.(id) || [] } catch { return [] }
})

const groupedBacklinks = computed(() => {
  const map = new Map()
  for (const b of backlinksList.value) {
    const key = b.fromId || b.raw || ''
    if (!map.has(key)) {
      map.set(key, { id: b.fromId, title: b.fromTitle || '(未知笔记)', matches: [] })
    }
    map.get(key).matches.push({ context: b.context || b.raw, alias: b.alias })
  }
  return Array.from(map.values())
})

const outgoingList = computed(() => {
  const id = props.note?.id
  if (!id) return []
  let raw = []
  try { raw = noteStore.getOutgoing?.(id) || [] } catch { raw = [] }
  const notesMap = new Map((noteStore.notes || []).map(n => [n.id, n]))
  return raw.map(link => {
    const resolvedNote = link.resolvedId ? notesMap.get(link.resolvedId) : null
    return {
      ...link,
      displayTitle: resolvedNote?.title || link.target,
      targetFolder: resolvedNote?.folder || ''
    }
  })
})

const unresolvedOutgoing = computed(() => outgoingList.value.filter(l => !l.resolvedId))

function highlightWikiContext(text) {
  if (!text) return ''
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/(!?\[\[[^\[\]]*?\]\])/g, '<span style="color:var(--color-primary);font-weight:500;">$1</span>')
}

/** 打开某篇笔记：交给父级统一处理路由 + 落盘 */
function openNote(id) {
  if (!id) return
  emit('open-note', id)
}

function openOutgoingLink(link) {
  if (!link) return
  if (link.resolvedId) {
    // hash 锚点由父级在笔记载入后定位（只有父级知道当前是不是阅读模式）
    emit('open-note', { id: link.resolvedId, hash: link.hash || '' })
    return
  }
  const folder = props.note?.folder || ''
  const created = noteStore.createNoteFromWikiTarget?.(link.target, folder) || noteStore.createNote(folder, link.target)
  if (created?.id) emit('open-note', { id: created.id })
}

/** 大纲跳转：preview 模式走 DOM 定位，edit/live 走编辑器，判定权在父级 */
function scrollToHeading(item) {
  if (!item?.text) return
  emit('scroll-to-heading', item)
}
</script>
