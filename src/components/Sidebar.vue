<template>
  <aside class="acrylic-sidebar w-[260px] min-w-[260px] h-full flex flex-col overflow-hidden">
    <div class="h-12 min-h-12 flex items-center gap-2 px-4 shrink-0">
      <PenLine class="w-5 h-5 flex-shrink-0" :style="{ color: 'var(--color-primary)' }" />
      <span class="font-semibold text-[15px]" :style="{ color: 'var(--color-text-primary)' }">Choyeon Notes</span>
      <div class="flex-1"></div>
      <button 
        class="w-8 h-8 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        title="收起侧边栏"
        @click="$emit('toggle-sidebar')"
      >
        <PanelLeft class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
    </div>

    <div class="px-3 pb-2 shrink-0">
      <button 
        class="w-full flex items-center gap-2 h-9 px-3 rounded-lg cursor-text transition-all text-left hover:bg-[var(--color-surface-hover)]"
        :style="{ background: 'var(--color-bg-tertiary)' }"
        @click="$router.push('/search')"
      >
        <Search class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
        <span class="text-[13px] flex-1" :style="{ color: 'var(--color-text-tertiary)' }">搜索笔记...</span>
        <kbd class="text-[10px] px-1.5 py-0.5 rounded" :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-light)' }">⌘K</kbd>
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar px-2 pb-2">
      <div class="mt-2 px-2">
        <span class="text-[11px] font-medium uppercase tracking-wider" :style="{ color: 'var(--color-text-tertiary)' }">视图</span>
      </div>

      <div 
        v-for="item in viewItems" 
        :key="item.id"
        class="nav-item flex items-center gap-2 h-9 px-2 mt-0.5 rounded-md cursor-pointer transition-colors"
        :class="{ 'is-active': isActiveRoute(item.route) }"
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
        <div class="flex items-center gap-1">
          <button
            class="text-[10px] px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--color-surface-hover)]"
            :style="{ color: 'var(--color-text-tertiary)' }"
            title="新建文件夹"
            @click="createFolderAtRoot"
          >
            <FolderPlus class="w-3.5 h-3.5" />
          </button>
          <button 
            v-if="(allFolderPaths.length + rootNotes.length) > 0"
            class="text-[10px] transition-colors hover:text-[var(--color-text-secondary)] px-1.5"
            :style="{ color: 'var(--color-text-tertiary)' }"
            @click="toggleAllFolders"
            :title="allExpanded ? '全部折叠' : '全部展开'"
          >
            {{ allExpanded ? '折叠' : '展开' }}
          </button>
        </div>
      </div>

      <div class="mt-1" @dragover.prevent="onRootDragOver" @dragleave="clearDropState" @drop.prevent="onRootDrop" @contextmenu.prevent.stop="openRootContextMenu">
        <div 
          class="flex items-center gap-1.5 h-9 px-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] relative" 
          :class="{ 'is-drop-target': rootDrop }"
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
            class="text-[11px] transition-colors tabular-nums" 
            :style="{ color: !noteStore.selectedFolder ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
          >{{ noteStore.notes.length }}</span>
        </div>

        <div class="tree-container mt-0.5">
          <div
            v-for="note in sortedRootNotes"
            :key="note.id"
            class="tree-note flex items-center gap-1.5 h-8 px-2 pr-2 rounded-md cursor-pointer transition-all duration-150 hover:bg-[var(--color-surface-hover)] relative"
            :class="{ 'is-selected': noteStore.currentNoteId === note.id }"
            :style="{ paddingLeft: '24px' }"
            draggable="true"
            @click="openNote(note.id)"
            @dblclick.stop="startRenameRootNote(note.id)"
            @contextmenu.prevent.stop="openContextMenuForItem($event, 'note', note.id)"
            @dragstart="(e) => onNoteDragStart(e, note)"
            @dragover.prevent="(e) => onSiblingDragOver(e, note.id, 'note', '')"
            @drop.prevent.stop="(e) => onSiblingDrop(e, note.id, 'note', '')"
          >
            <FileText
              class="w-3.5 h-3.5 flex-shrink-0"
              :style="{ color: noteStore.currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
            />
            <span
              v-if="!(renameState.active && renameState.target === note.id)"
              class="text-[13px] flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
              :style="{
                color: noteStore.currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                fontWeight: noteStore.currentNoteId === note.id ? '500' : '400'
              }"
            >{{ note.title }}</span>
            <input
              v-else
              v-model="renameState.value"
              type="text"
              class="text-[13px] flex-1 rounded px-1.5 py-0.5 outline-none bg-transparent"
              ref="rootRenameInputRef"
              :style="{
                border: '1px solid var(--color-primary)',
                boxShadow: '0 0 0 3px var(--color-primary-ring)',
                color: 'var(--color-text-primary)'
              }"
              @keydown.enter.prevent="commitRootRename"
              @keydown.escape.prevent="cancelRootRename"
              @blur="commitRootRename"
              @click.stop
            />
            <!-- before/after indicator -->
            <span v-if="siblingDrop.kind==='before' && siblingDrop.path===note.id && siblingDrop.folder===''" class="drop-indicator drop-indicator--before"></span>
            <span v-if="siblingDrop.kind==='after' && siblingDrop.path===note.id && siblingDrop.folder===''" class="drop-indicator drop-indicator--after"></span>
          </div>

          <FolderNode
            v-for="folder in sortedTreeFolders"
            :key="folder.path"
            :folder="folder"
            :depth="0"
            parent-path=""
            :expanded-folders="noteStore.expandedFolders"
            :selected-folder="noteStore.selectedFolder"
            :notes="noteStore.notes"
            :current-note-id="noteStore.currentNoteId"
            @open-note="openNote"
            @context-menu="receiveChildContextMenu"
            @dnd="receiveDnd"
            @rename="receiveRename"
            @create-note="receiveCreateNote"
            @create-folder="receiveCreateFolder"
            @delete-item="receiveDeleteItem"
            @toggle-folder="toggleFolder"
            @select-folder="selectFolderOnly"
          />
        </div>
      </div>
    </div>

    <div class="p-2 border-t flex items-center gap-1 shrink-0" :style="{ borderColor: 'var(--color-border)' }">
      <button 
        class="w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        title="新建笔记 (Ctrl+N)"
        @click="createNewNote"
      >
        <Plus class="w-5 h-5" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <button
        class="w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        title="新建文件夹"
        @click="createFolderAtRoot"
      >
        <FolderPlus class="w-5 h-5" :style="{ color: 'var(--color-text-secondary)' }" />
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

    <!-- =============== 全局上下文菜单 (Sidebar 内部) =============== -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="ctxMenu.show"
          class="fixed inset-0 z-[1000]"
          @click="closeContextMenu"
          @contextmenu.prevent="closeContextMenu"
        >
          <div
            class="context-menu absolute rounded-lg overflow-hidden shadow-xl"
            :style="{
              left: ctxMenu.x + 'px',
              top: ctxMenu.y + 'px',
              background: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              minWidth: '230px',
              padding: '6px',
              zIndex: 1001
            }"
            @click.stop
          >
            <div class="context-menu-label" v-if="ctxMenu.name">{{ ctxMenu.name }}</div>
            <button v-if="ctxMenu.kind === 'folder'" class="context-menu-item" @click="openFolderOnly">
              <FolderOpen class="w-3.5 h-3.5" />
              <span>打开/收起</span>
              <span class="context-menu-shortcut">点击</span>
            </button>
            <button v-if="ctxMenu.kind === 'note'" class="context-menu-item" @click="openContextNote">
              <FileText class="w-3.5 h-3.5" />
              <span>打开笔记</span>
              <span class="context-menu-shortcut">Enter</span>
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" @click="createNoteHere">
              <Plus class="w-3.5 h-3.5" />
              <span>新建笔记</span>
              <span class="context-menu-shortcut">Ctrl+N</span>
            </button>
            <button v-if="ctxMenu.kind === 'folder'" class="context-menu-item" @click="createSubfolderHere">
              <FolderPlus class="w-3.5 h-3.5" />
              <span>新建子文件夹</span>
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" @click="renameItemHere">
              <Pencil class="w-3.5 h-3.5" />
              <span>重命名</span>
              <span class="context-menu-shortcut">F2</span>
            </button>
            <button class="context-menu-item" @click="duplicateItem">
              <Copy class="w-3.5 h-3.5" />
              <span>复制</span>
              <span class="context-menu-shortcut">Ctrl+D</span>
            </button>
            <div class="context-menu-divider"></div>
            <button class="context-menu-item" style="color:var(--state-error);" @click="deleteItemHere">
              <Trash2 class="w-3.5 h-3.5" />
              <span style="color:inherit;">移到废纸篓</span>
              <span class="context-menu-shortcut">Del</span>
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </aside>
</template>

<script setup>
import { computed, reactive, ref, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { 
  PenLine, Search, CalendarDays, GitBranch, Tag, 
  Folder, FolderOpen, FileText, 
  Plus, Settings, PanelLeft, FolderPlus,
  Pencil, Copy, Trash2
} from 'lucide-vue-next'
import FolderNode from './FolderNode.vue'

defineEmits(['toggle-sidebar'])

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()

const rootDrop = ref(false)
const siblingDrop = reactive({ kind: '', path: '', folder: '' })

const ctxMenu = reactive({ show: false, x: 0, y: 0, kind: 'folder', target: '', name: '', sourceFolder: '' })
const renameState = reactive({ active: false, target: '', value: '' })
const rootRenameInputRef = ref(null)

const viewItems = [
  { id: 'notes', label: '所有笔记', icon: FolderOpen, route: '/notes' },
  { id: 'calendar', label: '日历', icon: CalendarDays, route: '/calendar' },
  { id: 'graph', label: '图谱', icon: GitBranch, route: '/graph' },
  { id: 'tags', label: '标签', icon: Tag, route: '/tags' }
]

const rootNotes = computed(() => noteStore.notes.filter(n => !n.folder))
const sortedRootNotes = computed(() =>
  [...rootNotes.value].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

const treeFolders = computed(() => {
  const folderMap = new Map()
  const roots = []
  const folderSet = new Set()

  noteStore.notes.forEach(n => {
    if (!n.folder) return
    folderSet.add(n.folder)
    const parts = n.folder.split('/')
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]
      if (!folderMap.has(acc)) {
        folderMap.set(acc, {
          name: parts[i],
          path: acc,
          children: [],
          count: 0,
          parentPath: i === 0 ? '' : parts.slice(0, i).join('/')
        })
      }
    }
  })
  // 计数：按 folder 全路径匹配
  noteStore.notes.forEach(n => {
    if (n.folder && folderMap.has(n.folder)) folderMap.get(n.folder).count++
  })
  // 挂载 parent-child 关系
  folderMap.forEach(node => {
    if (!node.parentPath) roots.push(node)
    else if (folderMap.has(node.parentPath)) folderMap.get(node.parentPath).children.push(node)
  })
  // 排序
  roots.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  folderMap.forEach(node => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  })
  return roots
})

const sortedTreeFolders = computed(() => treeFolders.value)

const allFolderPaths = computed(() => {
  const paths = []
  function walk(list) {
    for (const n of list) {
      paths.push(n.path)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(treeFolders.value)
  return paths
})

const allExpanded = computed(() => {
  if (allFolderPaths.value.length === 0) return false
  return allFolderPaths.value.every(p => noteStore.expandedFolders.includes(p))
})

function toggleAllFolders() { noteStore.toggleAllFolders(allFolderPaths.value) }
function isActiveRoute(rp) { return route.path.startsWith(rp) }
function toggleFolder(path) { noteStore.toggleFolder(path) }
function selectFolderOnly(path) { noteStore.setSelectedFolder(path) }
function selectRootFolder() { noteStore.setSelectedFolder('') }

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}
function createNewNote() {
  const folder = noteStore.selectedFolder || ''
  const note = noteStore.createNote(folder, '新笔记')
  router.push(`/editor/${note.id}`)
}
function createFolderAtRoot() {
  const name = window.prompt('新文件夹名称', '新文件夹')
  if (!name) return
  noteStore.createFolder(name.trim())
}

// ============= 根级重命名 =============
function startRenameRootNote(id) {
  const n = noteStore.notes.find(x => x.id === id)
  if (!n) return
  renameState.active = true
  renameState.target = id
  renameState.value = n.title
  nextTick(() => {
    rootRenameInputRef.value?.focus?.()
    rootRenameInputRef.value?.select?.()
  })
}
function commitRootRename() {
  if (!renameState.active) return
  const v = renameState.value.trim()
  if (v) noteStore.renameNote?.(renameState.target, v)
  cancelRootRename()
}
function cancelRootRename() {
  renameState.active = false
  renameState.target = ''
  renameState.value = ''
}

// ============= 上下文菜单分发点 =============
function openRootContextMenu(e) {
  openContextMenuForItem(e, 'root', '')
}
function openContextMenuForItem(e, kind, target) {
  let name = ''
  if (kind === 'folder') {
    const f = [...treeFolders.value].concat(...treeFolders.value.map(x => x.children || [])).find(f => f.path === target)
    name = f?.name || target
  } else if (kind === 'note') {
    name = noteStore.notes.find(n => n.id === target)?.title || ''
  } else {
    name = '全部笔记'
  }
  ctxMenu.show = true
  ctxMenu.x = Math.min(e.clientX, window.innerWidth - 250)
  ctxMenu.y = Math.min(e.clientY, window.innerHeight - 320)
  ctxMenu.kind = kind
  ctxMenu.target = target
  ctxMenu.name = name
  ctxMenu.sourceFolder = kind === 'folder' ? target : ''
}
function closeContextMenu() { ctxMenu.show = false }
function receiveChildContextMenu(p) {
  if (!p) return
  openContextMenuForItem({ clientX: p.clientX, clientY: p.clientY }, p.kind, p.target)
}
function folderOfNoteId(id) { return noteStore.notes.find(n => n.id === id)?.folder || '' }

function openFolderOnly() {
  closeContextMenu()
  if (ctxMenu.kind === 'folder') { toggleFolder(ctxMenu.target); selectFolderOnly(ctxMenu.target) }
}
function openContextNote() {
  closeContextMenu()
  if (ctxMenu.kind === 'note') openNote(ctxMenu.target)
}
function createNoteHere() {
  closeContextMenu()
  let folder = ''
  if (ctxMenu.kind === 'folder') folder = ctxMenu.target
  else if (ctxMenu.kind === 'note') folder = folderOfNoteId(ctxMenu.target)
  const note = noteStore.createNote(folder, '新笔记')
  if (folder) noteStore.setExpandedFolders([...noteStore.expandedFolders, folder])
  router.push(`/editor/${note.id}`)
}
function createSubfolderHere() {
  closeContextMenu()
  if (ctxMenu.kind !== 'folder') return
  const name = window.prompt('新子文件夹名称', '新文件夹')
  if (!name) return
  const path = `${ctxMenu.target}/${name.trim()}`
  noteStore.createFolder(path)
  noteStore.setExpandedFolders([...noteStore.expandedFolders, ctxMenu.target, path])
}
function renameItemHere() {
  closeContextMenu()
  if (ctxMenu.kind === 'folder') {
    const f = [...treeFolders.value, ...treeFolders.value.flatMap(x => x.children || [])].find(x => x.path === ctxMenu.target)
    if (!f) return
    const newName = window.prompt('文件夹新名称', f.name)
    if (newName && newName.trim() !== f.name) {
      noteStore.renameFolder?.(ctxMenu.target, newName.trim())
    }
  } else if (ctxMenu.kind === 'note') {
    const n = noteStore.notes.find(x => x.id === ctxMenu.target)
    if (!n) return
    const newName = window.prompt('笔记新标题', n.title)
    if (newName && newName.trim() !== n.title) {
      noteStore.renameNote?.(ctxMenu.target, newName.trim())
    }
  }
}
function duplicateItem() {
  closeContextMenu()
  if (ctxMenu.kind === 'note') {
    const n = noteStore.notes.find(x => x.id === ctxMenu.target)
    if (!n) return
    const created = noteStore.createNote(n.folder || '', `${n.title} 副本`)
    noteStore.updateNoteContent(created.id, n.content)
    router.push(`/editor/${created.id}`)
  } else if (ctxMenu.kind === 'folder') {
    // 简单实现：提示暂不支持文件夹批量复制
    alert('文件夹复制功能待实现，请复制其中的笔记。')
  }
}
function deleteItemHere() {
  closeContextMenu()
  if (ctxMenu.kind === 'note') {
    if (!confirm('确定删除这篇笔记吗？（不可恢复）')) return
    noteStore.deleteNote(ctxMenu.target)
  } else if (ctxMenu.kind === 'folder') {
    if (!confirm(`确定删除文件夹「${ctxMenu.name}」？该文件夹下的所有笔记会被移到根目录。`)) return
    noteStore.deleteFolder?.(ctxMenu.target)
  }
}

// ============= 递归组件事件接收器 =============
function receiveRename(p) {
  if (!p) return
  if (p.type === 'folder') {
    noteStore.renameFolder?.(p.target, p.value)
  } else if (p.type === 'note') {
    noteStore.renameNote?.(p.target, p.value)
  }
}
function receiveCreateNote(p) {
  const folder = p?.folder ?? (noteStore.selectedFolder || '')
  const note = noteStore.createNote(folder, '新笔记')
  if (folder) noteStore.setExpandedFolders([...noteStore.expandedFolders, folder])
  router.push(`/editor/${note.id}`)
}
function receiveCreateFolder(p) {
  if (p?.path) noteStore.createFolder(p.path)
}
function receiveDeleteItem(p) {
  if (!p) return
  if (p.kind === 'note') noteStore.deleteNote(p.id)
  else if (p.kind === 'folder') noteStore.deleteFolder?.(p.path)
}

// ============= DnD 接收器 =============
function clearDropState() { rootDrop.value = false; siblingDrop.kind = ''; siblingDrop.path = ''; siblingDrop.folder = '' }

function onRootDragOver(e) { rootDrop.value = true }

function onRootDrop(e) {
  clearDropState()
  const payload = readDndPayload(e)
  if (!payload) return
  if (payload.type === 'note') noteStore.moveNote?.(payload.id, '')
  else if (payload.type === 'folder') {
    if (!payload.parent) return
    // 根级：重新 renameFolder(old => name) 使其成为 top-level
    const name = payload.path.split('/').pop()
    noteStore.renameFolder?.(payload.path, name)
  }
}

function onNoteDragStart(e, note) {
  try {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-choyeon-note', JSON.stringify({
      type: 'note', id: note.id, folder: note.folder || ''
    }))
  } catch {}
}

function onSiblingDragOver(e, path, kind, folder) {
  const rect = e.currentTarget.getBoundingClientRect()
  const y = e.clientY - rect.top
  siblingDrop.kind = y < rect.height * 0.5 ? 'before' : 'after'
  siblingDrop.path = path
  siblingDrop.folder = folder
}

function onSiblingDrop(e, path, kind, folder) {
  const payload = readDndPayload(e)
  const zone = siblingDrop.kind || 'after'
  clearDropState()
  if (!payload) return
  applyDndTarget({ source: payload, targetKind: kind, targetPath: path, zone, parentPath: folder, targetFolderContainer: folder })
}

function receiveDnd(p) {
  if (!p) return
  applyDndTarget(p)
}

function readDndPayload(e) {
  let data = null
  try { data = JSON.parse(e.dataTransfer.getData('application/x-choyeon-note') || 'null') } catch {}
  if (!data) try { data = JSON.parse(e.dataTransfer.getData('application/x-choyeon-folder') || 'null') } catch {}
  return data
}

function applyDndTarget({ source, targetKind, targetPath, targetFolderContainer, zone, parentPath }) {
  // 处理笔记移动到文件夹（zone==='on' 且 kind==='folder' 或 kind==='note' 则把 zone==='on' 视作 进入那个 note 所在文件夹）
  if (source.type === 'note') {
    if (targetKind === 'folder' && zone === 'on') {
      noteStore.moveNote?.(source.id, targetPath)
      if (!noteStore.expandedFolders.includes(targetPath)) noteStore.setExpandedFolders([...noteStore.expandedFolders, targetPath])
      return
    }
    if (targetKind === 'note') {
      const targetNote = noteStore.notes.find(n => n.id === targetPath)
      const destFolder = targetNote?.folder || ''
      noteStore.moveNote?.(source.id, destFolder)
      // before/after 目前仅做排序占位（未来可实现真顺序）
      return
    }
    // folder 的 before/after：放进 parent folder (root or targetFolderContainer)
    noteStore.moveNote?.(source.id, parentPath || targetFolderContainer || '')
  } else if (source.type === 'folder') {
    // 禁止把文件夹拖到自己或后代里（简单检测）
    if (targetKind === 'folder' && (targetPath === source.path || targetPath.startsWith(source.path + '/'))) return
    if (targetKind === 'folder' && zone === 'on') {
      // 作为子文件夹：renameFolder(oldPath => newPath under target)
      const base = source.path.split('/').pop()
      const dest = `${targetPath}/${base}`
      noteStore.renameFolder?.(source.path, base)
      // renameFolder 支持 oldPath/newName 语义；这里若需要更复杂路径移动则用 renameFolder(parent + old)
      // 尝试用 renameFolder(old, target + name) 的方式需接口支持；若不支持则先进入目标子再 rename：
      if (dest !== source.path) {
        // 保证目标父目录存在
        noteStore.createFolder?.(targetPath)
        // 使用移动语义：复用 renameFolder(oldPath=source.path, newFolderPath=targetPath + '/' + base)
        // 若 store 只支持「同级 rename」，则我们仅能 move 到 parent；这种情况下退化为展开目标文件夹
        try { renameFolderCross(source.path, targetPath, base) } catch {}
      }
      return
    }
    // 其它情况：保持相同 parent 层级；暂不调整顺序
  }
}

// Cross-level folder move (emulated via renameFolder when it supports prefix change)
function renameFolderCross(oldPath, parentPath, baseName) {
  // 检查 renameFolder 的实现：如果 oldPath.startsWith(parentPath+'/') 则无变化；否则通过直接修改 store 中的 note.folder
  const newFull = parentPath ? `${parentPath}/${baseName}` : baseName
  if (newFull === oldPath) return
  const store = noteStore
  // Try: renameFolder(oldPath, newFull) 并不匹配语义。用 hack：直接改 notes 的 folder + 重建 state
  const notes = store.notes || []
  notes.forEach(n => {
    if (n.folder === oldPath) n.folder = newFull
    else if (n.folder && n.folder.startsWith(oldPath + '/')) {
      n.folder = newFull + n.folder.slice(oldPath.length)
    }
  })
  // updated expandedFolders
  store.setExpandedFolders(
    store.expandedFolders.map(p => {
      if (p === oldPath) return newFull
      if (p.startsWith(oldPath + '/')) return newFull + p.slice(oldPath.length)
      return p
    })
  )
  // re-assert selectedFolder
  if (store.selectedFolder === oldPath) store.setSelectedFolder(newFull)
}
</script>

<style scoped>
.nav-item:hover { background: var(--color-surface-hover); }
.nav-item.is-active { background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
.tree-note:hover { background: var(--color-surface-hover); }
.tree-note.is-selected { background: color-mix(in srgb, var(--color-primary) 10%, transparent); }

.tree-note {
  position: relative;
}

.tree-note .drop-indicator {
  position: absolute;
  left: 20px;
  right: 6px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 2px;
  pointer-events: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 20%, transparent);
}
.tree-note .drop-indicator--before { top: -1px; }
.tree-note .drop-indicator--after  { bottom: -1px; }

.is-drop-target {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  outline: 1px dashed var(--color-primary);
  outline-offset: -1px;
}
</style>
