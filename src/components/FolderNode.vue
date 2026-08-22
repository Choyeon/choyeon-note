<template>
  <div
    class="folder-node group relative"
    :data-folder-path="folder.path"
    :data-depth="depth"
  >
    <!-- =============== Folder Row =============== -->
    <div
      class="folder-row flex items-center gap-1.5 h-9 pr-1 rounded-md cursor-pointer transition-all duration-150 ease-out relative"
      :class="{
        'is-selected': isSelected,
        'is-drop-target': dropState.kind === 'folder' && dropState.path === folder.path
      }"
      :style="{ paddingLeft: `${indentPx}px` }"
      draggable="true"
      @click.stop="onFolderClick"
      @dblclick.stop="startRename(folder.path, 'folder')"
      @contextmenu.prevent.stop="openContextMenu($event, 'folder', folder.path)"
      @dragstart="onFolderDragStart($event)"
      @dragover.prevent="onDragOver($event, 'folder')"
      @dragleave="onDragLeave"
      @drop.prevent.stop="onDrop($event, 'folder', folder.path)"
      @dragend="onDragEnd"
    >
      <!-- 垂直缩进线 -->
      <template v-for="i in depth" :key="'vl'+i">
        <span
          class="indent-line"
          :style="{ left: `${i * 16 + 4}px` }"
        ></span>
      </template>

      <span
        class="chevron flex items-center justify-center rounded transition-all duration-200 shrink-0"
        :class="{ 'is-open': isExpanded }"
        @click.stop="toggleOnly"
      >
        <ChevronRight class="w-3 h-3" :style="{ color: 'var(--color-text-tertiary)' }" />
      </span>

      <component
        :is="isExpanded ? FolderOpen : Folder"
        class="w-4 h-4 shrink-0 transition-colors"
        :style="{ color: isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
      />

      <span
        v-if="!editing.active || editing.target !== folder.path"
        class="text-[13px] flex-1 whitespace-nowrap overflow-hidden text-ellipsis transition-colors select-none"
        :style="{
          color: isSelected ? 'var(--color-primary)' : 'var(--color-text-primary)',
          fontWeight: isSelected ? '600' : '500'
        }"
      >{{ folder.name }}</span>
      <input
        v-else
        ref="renameInputRef"
        v-model="editing.value"
        type="text"
        class="text-[13px] flex-1 rounded px-1.5 py-0.5 outline-none bg-transparent"
        :style="{
          color: 'var(--color-text-primary)',
          border: '1px solid var(--color-primary)',
          boxShadow: '0 0 0 3px var(--color-primary-ring)'
        }"
        @keydown.enter.prevent="commitRename"
        @keydown.escape.prevent="cancelRename"
        @blur="commitRename"
        @click.stop
        @mousedown.stop
      />

      <span
        class="text-[11px] tabular-nums shrink-0"
        :style="{ color: isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
      >{{ folderNotes.length }}</span>

      <!-- Hover Actions -->
      <span class="row-actions flex items-center gap-0.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          class="w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--color-surface-hover)]"
          title="在文件夹内新建笔记"
          @click.stop="createNoteInFolder(folder.path)"
        >
          <Plus class="w-3 h-3" :style="{ color: 'var(--color-text-tertiary)' }" />
        </button>
        <button
          class="w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--color-surface-hover)]"
          title="新建子文件夹"
          @click.stop="createSubfolder(folder.path)"
        >
          <FolderPlus class="w-3 h-3" :style="{ color: 'var(--color-text-tertiary)' }" />
        </button>
      </span>

      <!-- DnD 插入指示器 -->
      <span
        v-if="dropState.kind === 'before' && dropState.path === folder.path && dropState.parentPath === parentPath"
        class="drop-indicator drop-indicator--before"
      ></span>
      <span
        v-if="dropState.kind === 'after' && dropState.path === folder.path && dropState.parentPath === parentPath"
        class="drop-indicator drop-indicator--after"
      ></span>
    </div>

    <!-- =============== Children (expand/collapse with height animation) =============== -->
    <Transition name="folder-expand">
      <div v-show="isExpanded" class="folder-children overflow-hidden">
        <!-- Child notes -->
        <template v-for="note in folderNotes" :key="note.id">
          <div
            class="note-row flex items-center gap-1.5 h-8 pr-1 rounded-md cursor-pointer transition-all duration-150 relative"
            :class="{
              'is-selected': currentNoteId === note.id,
              'is-drop-target': dropState.kind === 'note' && dropState.path === note.id
            }"
            :style="{ paddingLeft: `${indentPx + 16}px` }"
            draggable="true"
            @click.stop="$emit('open-note', note.id)"
            @dblclick.stop="startRename(note.id, 'note')"
            @contextmenu.prevent.stop="openContextMenu($event, 'note', note.id)"
            @dragstart="onNoteDragStart($event, note)"
            @dragover.prevent="onDragOver($event, 'note', note.id)"
            @dragleave="onDragLeave"
            @drop.prevent.stop="onDrop($event, 'note', note.id)"
            @dragend="onDragEnd"
          >
            <template v-for="i in (depth + 1)" :key="'vnl'+i">
              <span
                class="indent-line"
                :style="{ left: `${i * 16 + 4}px` }"
              ></span>
            </template>

            <FileText
              class="w-3.5 h-3.5 shrink-0 transition-colors ml-4"
              :style="{ color: currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
            />
            <span
              v-if="!(editing.active && editing.target === note.id)"
              class="text-[13px] flex-1 whitespace-nowrap overflow-hidden text-ellipsis transition-colors select-none"
              :style="{
                color: currentNoteId === note.id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                fontWeight: currentNoteId === note.id ? '500' : '400'
              }"
            >{{ note.title }}</span>
            <input
              v-else
              ref="renameInputRef"
              v-model="editing.value"
              type="text"
              class="text-[13px] flex-1 rounded px-1.5 py-0.5 outline-none bg-transparent ml-4"
              :style="{
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-primary)',
                boxShadow: '0 0 0 3px var(--color-primary-ring)'
              }"
              @keydown.enter.prevent="commitRename"
              @keydown.escape.prevent="cancelRename"
              @blur="commitRename"
              @click.stop
              @mousedown.stop
            />

            <span
              v-if="dropState.kind === 'before' && dropState.path === note.id"
              class="drop-indicator drop-indicator--before"
            ></span>
            <span
              v-if="dropState.kind === 'after' && dropState.path === note.id"
              class="drop-indicator drop-indicator--after"
            ></span>
          </div>
        </template>

        <!-- Child folders -->
        <FolderNode
          v-for="child in sortedChildren"
          :key="child.path"
          :folder="child"
          :depth="depth + 1"
          :parent-path="folder.path"
          :expanded-folders="expandedFolders"
          :selected-folder="selectedFolder"
          :notes="notes"
          :current-note-id="currentNoteId"
          @open-note="(id) => $emit('open-note', id)"
          @context-menu="(payload) => $emit('context-menu', payload)"
          @dnd="(payload) => $emit('dnd', payload)"
          @rename="(payload) => $emit('rename', payload)"
          @create-note="(payload) => $emit('create-note', payload)"
          @create-folder="(payload) => $emit('create-folder', payload)"
          @delete-item="(payload) => $emit('delete-item', payload)"
          @toggle-folder="(p) => $emit('toggle-folder', p)"
          @select-folder="(p) => $emit('select-folder', p)"
        />
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, reactive, ref, nextTick, provide, inject, h, watch } from 'vue'
import {
  ChevronRight, Folder, FolderOpen, FileText, Plus, FolderPlus
} from 'lucide-vue-next'
import { useNoteStore } from '@/stores/note'
import { dndCtxKey, createDndCtx } from '@/composables/folderDnd.js'

const props = defineProps({
  folder: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  parentPath: { type: String, default: '' },
  expandedFolders: { type: Array, default: () => [] },
  selectedFolder: { type: String, default: '' },
  notes: { type: Array, default: () => [] },
  currentNoteId: { type: [String, null], default: null }
})

const emit = defineEmits([
  'open-note',
  'context-menu',
  'dnd',
  'rename',
  'create-note',
  'create-folder',
  'delete-item',
  'toggle-folder',
  'select-folder'
])

// FolderNode 会在 script 动作点主动 emit（除模板里嵌套转发外），所以需要 emit 句柄。

// 注：dndCtxKey / createDndCtx 统一从 folderDnd 共享模块导入
//   这样 Sidebar 能用同一 key provide 真实回调，否则 FolderNode 顶层将退回 stub，
//   导致 ctx.request.move / createNote / onRenameComplete 全部空转。

// 顶层是 Sidebar 注入的 ctx；递归子节点复用
let ctx = inject(dndCtxKey, null)
if (!ctx) {
  ctx = createDndCtx()
  provide(dndCtxKey, ctx)
}

const dropState = ctx.dropState
const editing = ctx.editing
const renameInputRef = ctx.renameInputRef

const indentPx = computed(() => props.depth * 16 + 8)
const isExpanded = computed(() => props.expandedFolders.includes(props.folder.path))
const isSelected = computed(() => props.selectedFolder === props.folder.path)
const folderNotes = computed(() => {
  const list = props.notes.filter(n => n.folder === props.folder.path)
  return [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
})
const sortedChildren = computed(() => {
  const list = [...(props.folder.children || [])]
  return list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
})

function toggleOnly() {
  ctx.request.toggleFolder(props.folder.path)
  emit('toggle-folder', props.folder.path)
}
function onFolderClick() {
  // 选中文件夹 + 切换展开
  if (props.selectedFolder !== props.folder.path) {
    ctx.request.selectFolder(props.folder.path)
    emit('select-folder', props.folder.path)
  } else {
    ctx.request.toggleFolder(props.folder.path)
    emit('toggle-folder', props.folder.path)
  }
}

// ====== 右键菜单（冒泡给 Sidebar 统一渲染）======
function openContextMenu(e, kind, target) {
  const rect = e.currentTarget.getBoundingClientRect()
  const payload = {
    clientX: e.clientX,
    clientY: e.clientY,
    kind, // 'folder' | 'note'
    target, // folder.path | note.id
    name: kind === 'folder' ? props.folder.name : (props.notes.find(n => n.id === target)?.title || ''),
    sourceFolder: props.folder.path
  }
  ctx.request.contextMenu(payload)
  emit('context-menu', payload)
}

// ====== 重命名 ======
function startRename(target, type) {
  editing.active = true
  editing.type = type
  editing.target = target
  if (type === 'folder') editing.value = props.folder.name
  else {
    const n = props.notes.find(x => x.id === target)
    editing.value = n ? n.title : ''
  }
  nextTick(() => {
    const el = renameInputRef && (Array.isArray(renameInputRef) ? renameInputRef[0] || renameInputRef.value : renameInputRef.value)
    const input = el || document.querySelector('.folder-node input:focus') || (typeof renameInputRef === 'object' && renameInputRef.value?.$el ? renameInputRef.value.$el : null)
    // Fallback: find nearest input
    const fallback = document.querySelector(`.folder-node[data-depth="${props.depth}"] input`)
    ;(fallback || input)?.focus?.()
    ;(fallback || input)?.select?.()
  })
}
function commitRename() {
  if (!editing.active) return
  const v = (editing.value || '').trim()
  if (v && v !== (editing.type === 'folder' ? props.folder.name : (props.notes.find(n => n.id === editing.target)?.title || ''))) {
    const payload = { type: editing.type, target: editing.target, value: v }
    ctx.onRenameComplete(payload)
    emit('rename', payload)
  }
  cancelRename()
}
function cancelRename() {
  editing.active = false
  editing.type = ''
  editing.target = ''
  editing.value = ''
}

// ====== 动作 ======
function createNoteInFolder(folderPath) {
  const payload = { folder: folderPath }
  ctx.request.createNote(payload)
  emit('create-note', payload)
}
function createSubfolder(folderPath) {
  const name = window.prompt('新建子文件夹名称', '新文件夹')
  if (!name) return
  const path = folderPath ? `${folderPath}/${name.trim()}` : name.trim()
  const payload = { path }
  ctx.request.createFolder(payload)
  emit('create-folder', payload)
}

// ====== HTML5 DnD ======
function clearDropState() {
  dropState.kind = ''
  dropState.path = ''
  dropState.parentPath = ''
}
function onFolderDragStart(e) {
  try {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-choyeon-folder', JSON.stringify({
      type: 'folder',
      path: props.folder.path,
      parent: props.parentPath
    }))
  } catch {}
}
function onNoteDragStart(e, note) {
  try {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-choyeon-note', JSON.stringify({
      type: 'note',
      id: note.id,
      folder: note.folder || ''
    }))
  } catch {}
}
function onDragOver(e, kind, pathOrId) {
  // 根据 y 位置在当前 row 内判断是 before / on / after
  const rect = e.currentTarget.getBoundingClientRect()
  const y = e.clientY - rect.top
  const h = rect.height
  let zone = 'on'
  if (y < h * 0.25) zone = 'before'
  else if (y > h * 0.75) zone = 'after'
  if (kind === 'folder') {
    if (zone === 'on') { dropState.kind = 'folder'; dropState.path = props.folder.path; dropState.parentPath = props.parentPath }
    else { dropState.kind = zone; dropState.path = props.folder.path; dropState.parentPath = props.parentPath }
  } else {
    dropState.kind = zone === 'on' ? 'note' : zone
    dropState.path = pathOrId
    dropState.parentPath = props.folder.path
  }
}
function onDragLeave() { /* leave 太频繁，交给 drop/end 清理 */ }
function onDragEnd() { clearDropState() }

function onDrop(e, kind, pathOrId) {
  let data = null
  try { data = JSON.parse(e.dataTransfer.getData('application/x-choyeon-note') || 'null') } catch {}
  if (!data) try { data = JSON.parse(e.dataTransfer.getData('application/x-choyeon-folder') || 'null') } catch {}
  if (!data) { clearDropState(); return }

  const rect = e.currentTarget.getBoundingClientRect()
  const y = e.clientY - rect.top
  const h = rect.height
  const zone = y < h * 0.25 ? 'before' : (y > h * 0.75 ? 'after' : 'on')

  const payload = {
    source: data,
    targetKind: kind, // 'folder' | 'note'
    targetPath: pathOrId, // folder.path | note.id
    targetFolderContainer: props.folder.path,
    zone, // 'before' | 'on' | 'after'
    parentPath: props.parentPath
  }
  ctx.request.move(payload)
  emit('dnd', payload)
  clearDropState()
}
</script>

<style scoped>
.folder-node {
  position: relative;
}

.folder-row:hover,
.note-row:hover {
  background: var(--color-surface-hover);
}

.folder-row.is-selected,
.note-row.is-selected {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.indent-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
  opacity: 0.9;
  pointer-events: none;
}
[data-theme='dark'] .indent-line { opacity: 0.25; }

.chevron {
  width: 18px;
  height: 18px;
}
.chevron.is-open svg { transform: rotate(90deg); }
.chevron svg { transition: transform 0.2s ease; }

.row-actions { transition: opacity 0.15s ease; }

.folder-row.is-drop-target,
.note-row.is-drop-target {
  background: color-mix(in srgb, var(--color-primary) 15%, transparent);
  border: 1px dashed var(--color-primary);
}

.drop-indicator {
  position: absolute;
  left: 8px;
  right: 6px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 2px;
  pointer-events: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 20%, transparent);
  z-index: 2;
}
.drop-indicator--before { top: -1px; }
.drop-indicator--after  { bottom: -1px; }

/* =============== expand/collapse =============== */
.folder-expand-enter-active,
.folder-expand-leave-active {
  transition: all 0.22s cubic-bezier(.4,0,.2,1);
  overflow: hidden;
}
.folder-expand-enter-from,
.folder-expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
  max-height: 0;
}
.folder-expand-enter-to,
.folder-expand-leave-from {
  opacity: 1;
  transform: translateY(0);
  /* 用一个足够大的值来兼容不同深度；max-height 的过渡在差值足够时足够流畅 */
  max-height: 5000px;
}
</style>
