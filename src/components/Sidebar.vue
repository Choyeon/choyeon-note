<template>
  <aside class="acrylic-sidebar w-[260px] min-w-[260px] h-full flex flex-col overflow-hidden">
    <div class="h-12 min-h-12 flex items-center gap-2 px-4">
      <PenLine class="w-5 h-5 text-primary flex-shrink-0" />
      <span class="font-semibold text-[15px]" :style="{ color: 'var(--color-text-primary)' }">Choyeon Notes</span>
    </div>

    <div class="px-3 pb-2">
      <div 
        class="flex items-center gap-2 h-9 px-3 rounded-lg cursor-text"
        :style="{ background: 'var(--color-bg-tertiary)' }"
        @click="$router.push('/search')"
      >
        <Search class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
        <span class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">搜索笔记...</span>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2">
      <div class="mt-2 px-2">
        <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">视图</span>
      </div>

      <div 
        v-for="item in viewItems" 
        :key="item.id"
        class="nav-item flex items-center gap-2 h-9 px-2 mt-0.5 rounded-lg cursor-pointer transition-colors"
        :class="{ 'nav-item-active': isActiveRoute(item.route) }"
        @click="$router.push(item.route)"
      >
        <component :is="item.icon" class="w-4 h-4 flex-shrink-0" :class="isActiveRoute(item.route) ? 'text-primary' : ''" :style="!isActiveRoute(item.route) ? { color: 'var(--color-text-secondary)' } : {}" />
        <span 
          class="text-[14px] font-medium flex-1 whitespace-nowrap"
          :style="{ color: isActiveRoute(item.route) ? 'var(--color-primary)' : 'var(--color-text-secondary)' }"
        >{{ item.label }}</span>
      </div>

      <div class="mt-4 px-2">
        <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">文件</span>
      </div>

      <div class="mt-1">
        <div 
          v-for="folder in folders" 
          :key="folder.name"
          class="mt-0.5"
        >
          <div 
            class="flex items-center gap-1.5 h-9 px-2 rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            @click="toggleFolder(folder.name)"
          >
            <ChevronDown v-if="isFolderExpanded(folder.name)" class="w-3.5 h-3.5 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
            <ChevronRight v-else class="w-3.5 h-3.5 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
            <Folder class="w-4 h-4 flex-shrink-0" :style="{ color: isFolderExpanded(folder.name) ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" />
            <span class="text-[14px] font-medium flex-1 whitespace-nowrap" :style="{ color: 'var(--color-text-primary)' }">{{ folder.name }}</span>
            <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">{{ getFolderNoteCount(folder.name) }}</span>
          </div>
          <div v-if="isFolderExpanded(folder.name)" class="pl-5">
            <div 
              v-for="note in getFolderNotes(folder.name)" 
              :key="note.id"
              class="flex items-center gap-1.5 h-9 px-2 rounded-lg cursor-pointer transition-colors"
              :class="{ 'note-item-active': currentNoteId === note.id }"
              @click="openNote(note.id)"
            >
              <FileText class="w-4 h-4 flex-shrink-0" :class="currentNoteId === note.id ? 'text-primary' : ''" :style="currentNoteId !== note.id ? { color: 'var(--color-text-tertiary)' } : {}" />
              <span 
                class="text-[14px] font-medium flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
                :style="{ color: currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-secondary)' }"
              >{{ note.title }}.md</span>
            </div>
          </div>
        </div>

        <div 
          v-for="note in rootNotes" 
          :key="note.id"
          class="flex items-center gap-1.5 h-9 px-2 rounded-lg cursor-pointer transition-colors mt-0.5"
          :class="{ 'note-item-active': currentNoteId === note.id }"
          @click="openNote(note.id)"
        >
          <FileText class="w-4 h-4 flex-shrink-0" :class="currentNoteId === note.id ? 'text-primary' : ''" :style="currentNoteId !== note.id ? { color: 'var(--color-text-tertiary)' } : {}" />
          <span 
            class="text-[14px] font-medium flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
            :style="{ color: currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-secondary)' }"
          >{{ note.title }}.md</span>
        </div>
      </div>
    </div>

    <div class="p-2 border-t flex items-center gap-1" :style="{ borderColor: 'var(--color-border)' }">
      <button 
        class="w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        @click="createNewNote"
      >
        <Plus class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <div class="flex-1"></div>
      <button 
        class="w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        :class="{ 'text-primary': isActiveRoute('/settings') }"
        @click="$router.push('/settings')"
      >
        <Settings class="w-[18px] h-[18px]" :style="{ color: isActiveRoute('/settings') ? 'var(--color-primary)' : 'var(--color-text-secondary)' }" />
      </button>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { 
  PenLine, Search, CalendarDays, GitBranch, Tag, 
  ChevronDown, ChevronRight, Folder, FileText, 
  Plus, Settings 
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()

const viewItems = [
  { id: 'calendar', label: '日历', icon: CalendarDays, route: '/calendar' },
  { id: 'graph', label: '图谱', icon: GitBranch, route: '/graph' },
  { id: 'tags', label: '标签', icon: Tag, route: '/tags' }
]

const folders = computed(() => noteStore.folders)
const currentNoteId = computed(() => noteStore.currentNoteId)

function isActiveRoute(routePath) {
  return route.path.startsWith(routePath)
}

function isFolderExpanded(folderName) {
  return noteStore.expandedFolders.includes(folderName)
}

function toggleFolder(folderName) {
  noteStore.toggleFolder(folderName)
}

function getFolderNoteCount(folderName) {
  return noteStore.notes.filter(n => n.folder === folderName).length
}

function getFolderNotes(folderName) {
  return noteStore.notes.filter(n => n.folder === folderName)
}

const rootNotes = computed(() => noteStore.notes.filter(n => !n.folder))

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

function createNewNote() {
  const note = noteStore.createNote('', '新笔记')
  router.push(`/editor/${note.id}`)
}
</script>

<style scoped>
.nav-item-active {
  background: var(--color-primary-lighter);
  border-left: 3px solid var(--color-primary);
  padding-left: 6px;
}

.note-item-active {
  background: var(--color-primary-lighter);
  border-left: 3px solid var(--color-primary);
  padding-left: 6px;
}
</style>
