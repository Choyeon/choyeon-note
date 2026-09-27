<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-[52px] px-6 py-2.5 flex items-center border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <span class="text-2xl font-bold" :style="{ color: 'var(--color-text-primary)' }">标签</span>
      <div class="flex-1"></div>
      <button 
        class="px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 text-[13px] font-medium text-white"
        :style="{ background: 'var(--color-primary)' }"
        @click="openCreateTag"
      >
        <Plus class="w-4 h-4 inline mr-1" />新建标签
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar acrylic-content p-6">
      <!-- 空状态提示 -->
      <div v-if="allTags.length === 0" class="flex flex-col items-center justify-center py-24">
        <div class="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" :style="{ background: 'var(--color-primary-surface)' }">
          <Tag class="w-7 h-7" :style="{ color: 'var(--color-primary)' }" />
        </div>
        <p class="text-[14px] font-medium mb-1" :style="{ color: 'var(--color-text-secondary)' }">还没有标签</p>
        <p class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">在笔记中添加 #标签 即可在此查看</p>
      </div>

      <div v-else class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <div 
          v-for="tag in allTags" 
          :key="tag"
          class="tag-card acrylic-card p-4 cursor-pointer"
          @click="filterByTag(tag)"
        >
          <div class="flex items-center gap-2 mb-2">
            <Tag class="w-5 h-5" :style="{ color: 'var(--color-primary)' }" />
            <span class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">#{{ tag }}</span>
          </div>
          <div class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ getTagNoteCount(tag) }} 篇笔记
          </div>
        </div>
      </div>

      <div v-if="selectedTag" class="mt-8">
        <div class="flex items-center gap-2 mb-4">
          <button 
            class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] active:scale-95"
            @click="selectedTag = null"
          >
            <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
          <span class="text-xl font-semibold" :style="{ color: 'var(--color-text-primary)' }">
            #{{ selectedTag }}
          </span>
          <span class="text-[12px] ml-1" :style="{ color: 'var(--color-text-tertiary)' }">{{ filteredByTag.length }} 篇笔记</span>
        </div>

        <div class="acrylic-card overflow-hidden">
          <div 
            v-for="(note, idx) in filteredByTag" 
            :key="note.id"
            class="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :style="idx < filteredByTag.length - 1 ? { borderBottom: '1px solid var(--color-border-light)' } : {}"
            @click="openNote(note.id)"
          >
            <FileText class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
            <span class="text-[14px] font-medium flex-1" :style="{ color: 'var(--color-text-primary)' }">
              {{ note.title }}
            </span>
            <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ formatDate(note.updatedAt, 'date') }}
            </span>
          </div>
        </div>
      </div>
    </div>

      <!-- 新建标签：之前按钮只把 showCreateTag 置 true，但模板里根本没有弹窗，纯死代码 -->
      <Teleport to="body">
        <div
          v-if="showCreateTag"
          class="fixed inset-0 z-[200] flex items-center justify-center"
          :style="{ background: 'rgba(0,0,0,0.35)' }"
          @click.self="closeCreateTag"
        >
          <div
            class="w-[380px] rounded-[14px] p-5"
            :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)' }"
            role="dialog"
            aria-modal="true"
            aria-label="新建标签"
            @keydown.esc="closeCreateTag"
          >
            <h3 class="text-[15px] font-semibold mb-1" :style="{ color: 'var(--color-text-primary)' }">新建标签</h3>
            <p class="text-[12px] mb-3" :style="{ color: 'var(--color-text-tertiary)' }">
              标签来自笔记正文里的 #标签。新建时会同时创建一篇同名笔记作为该标签的入口。
            </p>
            <input
              ref="tagInputRef"
              v-model="newTagName"
              type="text"
              placeholder="标签名，例如 读书"
              class="w-full h-9 px-3 rounded-[8px] text-[13px] outline-none"
              :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }"
              @keydown.enter="confirmCreateTag"
            />
            <p v-if="createTagError" class="text-[12px] mt-1.5" :style="{ color: 'var(--state-error)' }">
              {{ createTagError }}
            </p>
            <div class="flex justify-end gap-2 mt-4">
              <button
                class="h-8 px-3 rounded-[8px] text-[13px] cursor-pointer"
                :style="{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }"
                @click="closeCreateTag"
              >
                取消
              </button>
              <button
                class="h-8 px-3 rounded-[8px] text-[13px] font-medium text-white cursor-pointer"
                :style="{ background: 'var(--color-primary)' }"
                @click="confirmCreateTag"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      </Teleport>

    <div class="cho-statusbar">
      <span class="cho-statusbar-meta">
        {{ allTags.length }} 个标签
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { formatDate } from '@/utils/format'
import { Tag, Plus, ArrowLeft, FileText } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const selectedTag = ref(null)
const showCreateTag = ref(false)
const newTagName = ref('')
const createTagError = ref('')
const tagInputRef = ref(null)

const allTags = computed(() => noteStore.allTags)

const filteredByTag = computed(() => {
  if (!selectedTag.value) return []
  const tag = selectedTag.value
  // 兼容 note.tags 尚未同步的旧数据：正文里出现的标签同样算命中
  return noteStore.notes.filter(n =>
    (Array.isArray(n.tags) && n.tags.includes(tag))
  )
})

function getTagNoteCount(tag) {
  let count = 0
  for (const n of noteStore.notes) {
    if (Array.isArray(n.tags) && n.tags.includes(tag)) count++
  }
  return count
}

function filterByTag(tag) {
  selectedTag.value = tag
}

function openCreateTag() {
  newTagName.value = ''
  createTagError.value = ''
  showCreateTag.value = true
  nextTick(() => tagInputRef.value?.focus())
}

function closeCreateTag() {
  showCreateTag.value = false
  newTagName.value = ''
  createTagError.value = ''
}

function confirmCreateTag() {
  const raw = String(newTagName.value || '').trim()
  if (!raw) {
    createTagError.value = '请输入标签名'
    return
  }
  // 标签名不能含空白与 #，否则无法在正文中稳定匹配
  const name = raw.replace(/^#/, '').replace(/\s+/g, '-')
  if (!name) {
    createTagError.value = '标签名不合法'
    return
  }
  if (allTags.value.includes(name)) {
    createTagError.value = '该标签已存在'
    return
  }
  const note = noteStore.createNote('', name)
  noteStore.updateNoteContent(note.id, `# ${name}\n\n#${name}\n`)
  closeCreateTag()
  selectedTag.value = name
  router.push(`/editor/${note.id}`)
}

watch(showCreateTag, (open) => {
  if (open) nextTick(() => tagInputRef.value?.focus())
})

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

</script>

<style scoped>
/* 标签卡片 - 统一阴影与微妙的悬停抬起动画 */
.tag-card {
  box-shadow: var(--shadow-xs);
  transition: transform var(--transition-smooth), box-shadow var(--transition-smooth);
}

.tag-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.tag-card:active {
  transform: translateY(0);
  box-shadow: var(--shadow-sm);
}
</style>
