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

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar px-2">
      <div class="mt-2 px-2">
        <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">视图</span>
      </div>

      <div 
        v-for="item in viewItems" 
        :key="item.id"
        class="nav-item flex items-center gap-2 h-9 px-2 mt-0.5 rounded-md cursor-pointer transition-colors"
        @click="$router.push(item.route)"
      >
        <component 
          :is="item.icon" 
          class="w-4 h-4 flex-shrink-0 transition-colors" 
          :style="{ color: isActiveRoute(item.route) ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" 
        />
        <span 
          class="text-[13px] font-medium flex-1 whitespace-nowrap transition-colors"
          :style="{ color: isActiveRoute(item.route) ? 'var(--color-primary)' : 'var(--color-text-secondary)' }"
        >{{ item.label }}</span>
      </div>

      <div class="mt-4 px-2 flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">文件</span>
        <button 
          v-if="treeFolders.length > 0 || rootNotes.length > 0"
          class="text-[10px] transition-colors hover:text-[var(--color-text-secondary)]"
          :style="{ color: 'var(--color-text-tertiary)' }"
          @click="toggleAllFolders"
          :title="allExpanded ? '全部折叠' : '全部展开'"
        >
          {{ allExpanded ? '折叠' : '展开' }}
        </button>
      </div>

      <div class="mt-1">
        <div 
          class="flex items-center gap-1.5 h-9 px-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]" 
          @click="selectRootFolder"
        >
          <FolderOpen 
            class="w-4 h-4 flex-shrink-0 transition-colors" 
            :style="{ color: !noteStore.selectedFolder ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" 
          />
          <span 
            class="text-[13px] flex-1 whitespace-nowrap transition-colors" 
            :style="{ 
              color: !noteStore.selectedFolder ? 'var(--color-primary)' : 'var(--color-text-primary)',
              fontWeight: !noteStore.selectedFolder ? '600' : '500'
            }"
          >全部笔记</span>
          <span 
            class="text-[11px] transition-colors" 
            :style="{ color: !noteStore.selectedFolder ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
          >{{ noteStore.notes.length }}</span>
        </div>

        <div class="tree-container mt-0.5">
          <div 
            v-for="note in rootNotes" 
            :key="note.id"
            class="tree-note flex items-center gap-1.5 h-8 pr-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] relative"
            :style="{ paddingLeft: '24px' }"
            @click="openNote(note.id)"
          >
            <div class="tree-indent-line" :style="{ left: '16px' }"></div>
            <FileText 
              class="w-3.5 h-3.5 flex-shrink-0 transition-colors" 
              :style="{ color: currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" 
            />
            <span 
              class="text-[13px] flex-1 whitespace-nowrap overflow-hidden text-ellipsis transition-colors"
              :style="{ 
                color: currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                fontWeight: currentNoteId === note.id ? '500' : '400'
              }"
            >{{ note.title }}</span>
          </div>

          <FolderNode
            v-for="folder in treeFolders"
            :key="folder.path"
            :folder="folder"
            :depth="0"
          />
        </div>
      </div>
    </div>

    <div class="p-2 border-t flex items-center gap-1" :style="{ borderColor: 'var(--color-border)' }">
      <button 
        class="w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        title="新建笔记"
        @click="createNewNote"
      >
        <Plus class="w-5 h-5" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <div class="flex-1"></div>
      <button 
        class="w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        :class="{ 'text-primary': isActiveRoute('/settings') }"
        title="设置"
        @click="$router.push('/settings')"
      >
        <Settings class="w-5 h-5" :style="{ color: isActiveRoute('/settings') ? 'var(--color-primary)' : 'var(--color-text-secondary)' }" />
      </button>
    </div>
  </aside>
</template>

<script setup>
import { computed, h, defineComponent, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { 
  PenLine, Search, CalendarDays, GitBranch, Tag, 
  ChevronDown, ChevronRight, Folder, FolderOpen, FileText, 
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

const currentNoteId = computed(() => noteStore.currentNoteId)

const rootNotes = computed(() => noteStore.notes.filter(n => !n.folder))

const treeFolders = computed(() => {
  const folderMap = {}
  
  noteStore.folders.forEach(folder => {
    const parts = folder.name.split('/')
    let currentPath = ''
    
    parts.forEach((part, index) => {
      if (currentPath) {
        currentPath += '/' + part
      } else {
        currentPath = part
      }
      
      if (!folderMap[currentPath]) {
        folderMap[currentPath] = {
          name: part,
          path: currentPath,
          depth: index,
          count: 0,
          children: [],
          hasChildren: false
        }
      }
      
      if (index > 0) {
        const parentPath = parts.slice(0, index).join('/')
        if (folderMap[parentPath]) {
          folderMap[parentPath].hasChildren = true
          if (!folderMap[parentPath].children.find(c => c.path === currentPath)) {
            folderMap[parentPath].children.push(folderMap[currentPath])
          }
        }
      }
    })
  })
  
  noteStore.notes.forEach(note => {
    if (note.folder && folderMap[note.folder]) {
      folderMap[note.folder].count++
    }
  })
  
  return Object.values(folderMap).filter(f => f.depth === 0)
})

const allFolderPaths = computed(() => {
  const paths = []
  function collect(nodes) {
    nodes.forEach(node => {
      paths.push(node.path)
      if (node.children && node.children.length > 0) {
        collect(node.children)
      }
    })
  }
  collect(treeFolders.value)
  return paths
})

const allExpanded = computed(() => {
  if (allFolderPaths.value.length === 0) return false
  return allFolderPaths.value.every(p => noteStore.expandedFolders.includes(p))
})

function toggleAllFolders() {
  if (allExpanded.value) {
    noteStore.expandedFolders = []
  } else {
    noteStore.expandedFolders = [...allFolderPaths.value]
  }
}

function isActiveRoute(routePath) {
  return route.path.startsWith(routePath)
}

function isFolderExpanded(folderName) {
  return noteStore.expandedFolders.includes(folderName)
}

function toggleFolder(folderName) {
  noteStore.toggleFolder(folderName)
  noteStore.selectedFolder = noteStore.selectedFolder === folderName ? '' : folderName
}

function selectRootFolder() {
  noteStore.selectedFolder = ''
}

function getFolderNotes(folderName) {
  return noteStore.notes.filter(n => n.folder === folderName)
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

function createNewNote() {
  const note = noteStore.createNote('', '新笔记')
  router.push(`/editor/${note.id}`)
}

const FolderNode = defineComponent({
  name: 'FolderNode',
  props: {
    folder: { type: Object, required: true },
    depth: { type: Number, default: 0 }
  },
  setup(props) {
    const expanded = computed(() => isFolderExpanded(props.folder.path))
    const selected = computed(() => noteStore.selectedFolder === props.folder.path)
    const notes = computed(() => getFolderNotes(props.folder.path))
    
    const handleClick = () => {
      toggleFolder(props.folder.path)
    }
    
    const openNoteHandler = (id) => {
      openNote(id)
    }
    
    return () => {
      const indent = props.depth * 16 + 8
      
      const folderRow = h('div', {
        class: 'tree-folder flex items-center gap-1.5 h-9 pr-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]',
        style: { paddingLeft: `${indent}px` },
        onClick: handleClick
      }, [
        // 渲染缩进线 - 数量等于文件夹深度，对齐父级图标中心
        ...Array.from({ length: props.depth }, (_, i) =>
          h('div', {
            class: 'tree-indent-line',
            style: { left: `${(i + 1) * 16}px` },
            key: `folder-indent-${i}`
          })
        ),
        h(ChevronDown, {
          class: 'w-3 h-3 flex-shrink-0 transition-transform duration-200',
          style: {
            color: 'var(--color-text-tertiary)',
            transform: expanded.value ? 'rotate(0deg)' : 'rotate(-90deg)'
          }
        }),
        h(Folder, {
          class: 'w-4 h-4 flex-shrink-0 transition-colors',
          style: { 
            color: selected.value ? 'var(--color-primary)' : 'var(--color-text-tertiary)'
          }
        }),
        h('span', {
          class: 'text-[13px] flex-1 whitespace-nowrap transition-colors',
          style: { 
            color: selected.value ? 'var(--color-primary)' : 'var(--color-text-primary)',
            fontWeight: selected.value ? '600' : '500'
          }
        }, props.folder.name),
        h('span', {
          class: 'text-[11px] transition-colors',
          style: { 
            color: selected.value ? 'var(--color-primary)' : 'var(--color-text-tertiary)' 
          }
        }, props.folder.count)
      ])
      
      const children = []
      
      if (expanded.value) {
        if (props.folder.children && props.folder.children.length > 0) {
          props.folder.children.forEach(child => {
            children.push(h(FolderNode, {
              folder: child,
              depth: props.depth + 1,
              key: child.path
            }))
          })
        }
        
        notes.value.forEach(note => {
          children.push(h('div', {
            class: 'tree-note flex items-center gap-1.5 h-8 pr-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] relative',
            style: { paddingLeft: `${(props.depth + 1) * 16 + 8}px` },
            onClick: () => openNoteHandler(note.id),
            key: note.id
          }, [
            // 渲染缩进线 - 数量等于文件夹深度 + 1，对齐各级父级图标中心
            ...Array.from({ length: props.depth + 1 }, (_, i) =>
              h('div', {
                class: 'tree-indent-line',
                style: { left: `${(i + 1) * 16}px` },
                key: `note-indent-${i}`
              })
            ),
            h(FileText, {
              class: 'w-3.5 h-3.5 flex-shrink-0 transition-colors',
              style: {
                color: currentNoteId.value === note.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)'
              }
            }),
            h('span', {
              class: 'text-[13px] flex-1 whitespace-nowrap overflow-hidden text-ellipsis transition-colors',
              style: { 
                color: currentNoteId.value === note.id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                fontWeight: currentNoteId.value === note.id ? '500' : '400'
              }
            }, note.title)
          ]))
        })
      }
      
      return h('div', { class: 'tree-node mt-0.5 relative' }, [folderRow, ...children])
    }
  }
})
</script>

<style scoped>
.nav-item:hover {
  background: var(--color-surface-hover);
}
</style>

<style>
.tree-container {
  position: relative;
}

.tree-folder {
  position: relative;
}

.tree-note {
  position: relative;
}

/* 树状缩进线 - 位置由内联 style 控制，对齐父级图标中心 */
.tree-indent-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
  pointer-events: none;
}

/* 暗色模式下进一步淡化缩进线，避免视觉干扰 */
.dark .tree-indent-line {
  background: rgba(255, 255, 255, 0.03);
}

.tree-node {
  position: relative;
}
</style>
