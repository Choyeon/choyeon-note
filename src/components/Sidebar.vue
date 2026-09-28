<template>
  <aside class="acrylic-sidebar w-[260px] min-w-[260px] h-full flex flex-col overflow-hidden">
    <!-- 品牌区（图标 + 「Choyeon Notes」）已移除：品牌统一由 Electron 标题栏承载
         （App.vue 的 .titlebar-electron，只在 isElectron 下渲染）。原先两者上下只差
         9px，图标一个是 /icon.png 一个是 PenLine，文案还不一致（Note / Notes），
         属于同一件事说两遍。

         取舍说明（不是 bug，别改回去）：isElectron === false 时标题栏整块不渲染，
         因此浏览器（dev 调试）模式下侧边栏顶部没有品牌标识。这是刻意接受的 ——
         浏览器模式只用于开发调试，不是发布形态，而重复品牌区是用户明确要去掉的。 -->
    <div class="px-3 pt-3 pb-2 shrink-0 flex items-center gap-2">
      <button 
        class="flex-1 min-w-0 flex items-center gap-2 h-9 px-3 rounded-lg cursor-text transition-all text-left hover:bg-[var(--color-surface-hover)]"
        :style="{ background: 'var(--color-bg-tertiary)' }"
        @click="$router.push('/search')"
      >
        <Search class="w-4 h-4 flex-shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
        <span class="text-[13px] flex-1 truncate" :style="{ color: 'var(--color-text-tertiary)' }">搜索笔记...</span>
        <kbd class="text-[10px] px-1.5 py-0.5 rounded shrink-0" :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-light)' }">{{ quickSwitcherHint }}</kbd>
      </button>
      <!-- 收起按钮是搜索框的**同级兄弟**，不嵌进上面那个 button 里：
           button 套 button 是非法 HTML，浏览器会把外层拆开。 -->
      <button 
        class="sidebar-collapse-btn w-9 h-9 shrink-0 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200"
        title="收起侧边栏"
        @click="$emit('toggle-sidebar')"
      >
        <PanelLeft class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
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
        :title="`新建笔记 (${newNoteHint})`"
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
              <span class="context-menu-shortcut">{{ newNoteHint }}</span>
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
    <!-- =============== 应用内弹窗（替代 window.prompt / alert / confirm） =============== -->
    <!-- 原生弹窗不跟随主题（深色模式下是系统白框）、阻塞主线程、在 Electron 下
         window.prompt 可能被禁用直接返回 null 导致功能静默失效，这里统一换成
         主题化的 PromptDialog，由 askDialog() 以 Promise 形式串起原有流程。 -->
    <PromptDialog
      v-if="dialog"
      :mode="dialog.mode"
      :title="dialog.title"
      :message="dialog.message"
      :placeholder="dialog.placeholder"
      :default-value="dialog.defaultValue"
      :danger="dialog.danger"
      :confirm-text="dialog.confirmText"
      @confirm="onDialogConfirm"
      @cancel="onDialogCancel"
    />
  </aside>
</template>

<script setup>
import { computed, reactive, ref, nextTick, provide } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
// PenLine 原先只用在侧边栏品牌行的图标上；品牌行去重后已随其删除，
// 这里同步摘掉 —— 留着会让 lucide 在构建期报 MISSING_EXPORT。
// Folder 同样是死 import（viewItems 用的是 FolderOpen / FolderPlus），顺手一并摘掉。
import {
  Search, CalendarDays, GitBranch, Tag, KeyRound,
  FolderOpen, FileText,
  Plus, Settings, PanelLeft, FolderPlus,
  Pencil, Copy, Trash2
} from 'lucide-vue-next'
import FolderNode from './FolderNode.vue'
import PromptDialog from './common/PromptDialog.vue'
import { dndCtxKey, createDndCtx } from '@/composables/folderDnd.js'
import { formatBinding } from '@/constants/shortcuts'
import { useAppStore } from '@/stores/app'
// ⚠️ 上报内核必须从零依赖 util 引入，**不能**从 '@/views/TrashView.vue' 引入：
// /trash 是懒加载路由，那样会把 1000+ 行的 TrashView 整块拖进首屏主 chunk。
import { reportTrashMethod } from '@/utils/trashState.js'

defineEmits(['toggle-sidebar'])

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()
const appStore = useAppStore()

/**
 * 快捷键提示必须是 computed：setup 期求值一次的话，用户在设置页改完快捷键，
 * 侧边栏这里的提示会永远是旧值。
 * （<script setup> 里模板访问 ref/computed 会自动解包，无需写 .value）
 */
const quickSwitcherHint = computed(() => formatBinding(appStore.getBinding('app.quickSwitcher')))
const newNoteHint = computed(() => formatBinding(appStore.getBinding('app.newNote')))

// =====================================================================
// 给 FolderNode 递归树注入真实 DnD/Rename 上下文。
// 之前：dndCtxKey 在 FolderNode 内部声明，Sidebar 无法 provide 对应 key，
// 导致 ctx.request.move/createNote/onRenameComplete 全是空 stub，
// 表现为：拖放 / 新建 / 重命名 静默失败。
// 现在：从共享模块 dndCtxKey 取相同 Symbol，Sidebar 先 provide 真实实现。
// =====================================================================
const folderDndCtx = createDndCtx()
folderDndCtx.onRenameComplete = (payload) => receiveRename(payload)
folderDndCtx.request.move = (p) => receiveDnd(p)
folderDndCtx.request.contextMenu = (p) => receiveChildContextMenu(p)
folderDndCtx.request.createNote = (p) => receiveCreateNote(p)
folderDndCtx.request.createFolder = (p) => receiveCreateFolder(p)
folderDndCtx.request.deleteItem = (p) => receiveDeleteItem(p)
folderDndCtx.request.toggleFolder = (p) => toggleFolder(p)
folderDndCtx.request.selectFolder = (p) => selectFolderOnly(p)
provide(dndCtxKey, folderDndCtx)

const rootDrop = ref(false)
const siblingDrop = reactive({ kind: '', path: '', folder: '' })

const ctxMenu = reactive({ show: false, x: 0, y: 0, kind: 'folder', target: '', name: '', sourceFolder: '' })
const renameState = reactive({ active: false, target: '', value: '' })
const rootRenameInputRef = ref(null)

// =====================================================================
// 应用内弹窗（替代 window.prompt / alert / confirm）
// 为什么不用原生弹窗：
//   1. 不跟随主题 —— 深色模式下弹的是系统白框，视觉直接割裂；
//   2. 阻塞 JS 主线程，且拿不到焦点/无障碍/键盘控制；
//   3. 部分 Chromium/Electron 配置会禁用 window.prompt，直接返回 null，
//      新建文件夹/重命名会变成"点了没反应"。
// 用法：const v = await askDialog({ mode: 'prompt', title: '...' })
//      prompt 返回字符串或 null；alert/confirm 返回 true 或 null（falsy 即放弃）。
// =====================================================================
const dialog = ref(null) // { mode, title, message, placeholder, defaultValue, danger, confirmText, resolve }

/**
 * 打开一个弹窗并返回 Promise。
 * @param {{ mode?: string, title?: string, message?: string, placeholder?: string,
 *           defaultValue?: string, danger?: boolean, confirmText?: string }} options
 * @returns {Promise<string|boolean|null>} confirm 的结果，或 null（取消）
 */
function askDialog (options = {}) {
  return new Promise((resolve) => {
    dialog.value = { mode: 'confirm', danger: false, ...options, resolve }
  })
}

/** 弹窗确认：prompt 回传输入框内容，alert/confirm 回传 true */
function onDialogConfirm (value) {
  dialog.value?.resolve?.(value)
  dialog.value = null
}

/** 弹窗取消 / 遮罩点击 / Escape：统一回传 null，调用方 `if (!v) return` 即可放弃 */
function onDialogCancel () {
  dialog.value?.resolve?.(null)
  dialog.value = null
}

// =====================================================================
// OpResult → 用户可见提示（移动 / 重命名）
//
// T03 之后 moveNote / renameNote 都改成了 async，返回 { ok, code, message, failed }。
// 这里必须遵守两条口径：
//   1. **按 code 分支，不要按 ok 分支** —— `rename-partial` 的 ok 是 false，
//      但磁盘上的文件确实已经改名成功了。提示必须是「已改名为 X，但有 N 处没写入」，
//      说成「操作失败」会让用户再改一次，反而可能制造重复文件。
//   2. **不把英文 code 直接抛给用户** —— 由 UI 侧维护这张中文映射表，
//      表里没有的码退回 result.message（T03 已经把它写成中文兜底文案）。
// =====================================================================
const OP_NOTICE_TEXT = {
  'target-exists': '目标位置已存在同名笔记，未做任何改动',
  permission: '磁盘只读或没有权限，未做任何改动',
  'write-failed': '写入磁盘失败，未做任何改动',
  'not-found': '找不到这篇笔记或它的文件',
  'invalid-title': '标题不能为空',
  conflict: '源文件和目标文件同时存在，可能已产生重复文件，请手动确认'
}

/** 成功与「无需变更」都不该打扰用户 */
const OP_SILENT_CODES = ['ok', 'noop']

/**
 * id → 笔记标题；查不到就退回 id，保证提示里不会出现 undefined。
 * @param {string} id 笔记 id
 * @returns {string} 标题或 id
 */
function titleOfNoteId (id) {
  return noteStore.notes.find(n => n.id === id)?.title || id
}

/**
 * 把 OpResult 翻译成一条用户能看懂的提示。
 *
 * @param {object|boolean|undefined} result moveNote / renameNote 的返回值
 * @param {{ verb?: string, title?: string }} [ctx={}] verb 动作名；title 新标题（rename-partial 用）
 * @returns {boolean} 是否成功（ok / noop 都算成功，供调用方决定后续动作，例如展开目标目录）
 */
function reportOpResult (result, ctx = {}) {
  // store 未实现或仍是旧版布尔返回时没有契约可依，保持静默（store 自己会上报）
  if (!result || typeof result !== 'object') return Boolean(result)
  const code = String(result.code || (result.ok ? 'ok' : ''))
  if (OP_SILENT_CODES.indexOf(code) > -1) return true
  const verb = ctx.verb || '操作'

  // rename-partial：文件已经在磁盘上改名了，不能说「失败」，只能说「部分没写进去」
  if (code === 'rename-partial') {
    const failed = Array.isArray(result.failed) ? result.failed : []
    const names = failed.map(f => titleOfNoteId(f.id)).join('、')
    const label = ctx.title ? `「${ctx.title}」` : ''
    appStore.pushToast({
      type: 'error',
      message: `笔记已改名为${label}，但有 ${failed.length} 处内容没能写入磁盘${names ? `：${names}` : ''}。请检查磁盘是否只读后手动保存这几篇。`,
      duration: 8000
    })
    return false
  }

  const text = OP_NOTICE_TEXT[code] || result.message || '操作失败'
  appStore.pushToast({ type: 'error', message: `${verb}失败：${text}`, duration: 6000 })
  return false
}

/**
 * 统计某个文件夹（含全部子文件夹）下的笔记数。
 *
 * 命中范围刻意与 note.js deleteFolder 保持一致（folder 全等，或以「路径 + /」开头）。
 * 为什么在这里再数一遍：store 没有导出 collectFolderNotes，而确认弹窗必须在动手
 * **之前**告诉用户「这一下会带走几篇」，这个数字只能由调用方自己算。
 *
 * @param {string} folderPath 文件夹路径
 * @returns {number} 笔记数
 */
function countNotesUnder (folderPath) {
  if (!folderPath) return 0
  return noteStore.notes.filter(n => {
    const f = n.folder || ''
    return f === folderPath || f.startsWith(folderPath + '/')
  }).length
}

/**
 * 删除文件夹并如实告知结果。
 *
 * 为什么必须看返回值：deleteFolder 在目录删不掉时会走降级分支 —— 笔记被重新挂回
 * **根目录**（folder 置空）。用户点的是「删除文件夹」，看到的却是笔记摊平到根目录，
 * 不说明白就会被当成「数据丢了」或「笔记位置错了」（PRD R-D4）。
 *
 * @param {string} folderPath 文件夹路径
 * @param {string} folderName 用于文案展示的文件夹名
 * @returns {Promise<void>}
 */
/**
 * 删除成功后，把「这次删除实际走了哪种回收站」上报给「最近删除」页。
 *
 * 判成功只能靠 store 的 lastTrashMethod：deleteNote 的契约是 Promise<void>，
 * deleteFolder 的契约是 Promise<boolean>（且布尔是「目录删掉没」，不是「方式」）。
 * lastTrashMethod 在每次删除**开始前**清空、只在成功且主进程回了 detail 时写入，
 * 所以「非空」⇔「本次删除成功且方式已知」，不存在拿上一次旧值误报的可能。
 *
 * 未知（浏览器模式 / 老主进程 / 删除失败）时**不上报** —— 宁可指示条不动，
 * 也不编一个值凑数。
 *
 * @param {string} method noteStore.lastTrashMethod 的当前值
 * @returns {void}
 */
function reportTrashMethodIfKnown (method) {
  if (!method) return
  // notify:false —— 只记状态、不回抛事件。TrashView 自己也监听这个事件，
  // 回抛会形成「事件 → 上报 → 派发 → 事件」的无限递归。
  reportTrashMethod(method, { notify: false })
}

/**
 * 删一篇笔记 + 成功后上报方式（deleteNote 返回 void，只能这样判成功）。
 *
 * 失败时为什么不静默：文件没能从磁盘删掉，但库里若把它摘了，用户以为删掉了 ——
 * 下次启动它「复活」，再建同名笔记还可能把真文件覆盖掉。与 deleteFolderWithNotice
 * 同一规格：删不掉就明说，并且**不**上报 success 态。
 *
 * @param {string} id 笔记 id
 * @returns {Promise<void>}
 */
async function deleteNoteAndReport (id) {
  const target = noteStore.notes.find(n => n.id === id)
  const title = target?.title || '未命名'
  await noteStore.deleteNote?.(id)

  // 判失败靠 lastDeleteError：它在每次删除**开始前**清空，读到非空必然是本次失败。
  const reason = String(noteStore.lastDeleteError || '').trim()
  if (reason) {
    await askDialog({
      mode: 'alert',
      title: `没能删除笔记「${title}」`,
      message: `这篇笔记没能从磁盘删除，它已经留在了笔记列表里，磁盘上的文件也还在原处。\n\n原因：${reason}\n\n请检查后重试。`
    })
    // 失败路径上报 success 就是撒谎，直接返回
    return
  }
  reportTrashMethodIfKnown(noteStore.lastTrashMethod)
}

async function deleteFolderWithNotice (folderPath, folderName) {
  const count = countNotesUnder(folderPath)
  // 只认显式 false：store 未实现时返回 undefined，不该弹出「删除失败」
  const removed = await noteStore.deleteFolder?.(folderPath)
  if (removed === false) {
    await askDialog({
      mode: 'alert',
      title: `没能删除文件夹「${folderName}」`,
      message: count > 0
        ? `目录没能从磁盘删除（可能已不存在、被其它程序占用，或回收站不可用）。\n\n${count} 篇笔记已放回根目录，磁盘上的文件仍在原来的目录里。请检查后重试。`
        : '目录没能从磁盘删除（可能已不存在、被其它程序占用，或回收站不可用）。请检查后重试。'
    })
    // 降级分支：目录根本没删掉，**不要**上报成功态
    return
  }
  reportTrashMethodIfKnown(noteStore.lastTrashMethod)
}

const viewItems = [
  { id: 'notes', label: '所有笔记', icon: FolderOpen, route: '/notes' },
  { id: 'calendar', label: '日历', icon: CalendarDays, route: '/calendar' },
  { id: 'graph', label: '图谱', icon: GitBranch, route: '/graph' },
  { id: 'tags', label: '标签', icon: Tag, route: '/tags' },
  { id: 'vault', label: '密码本', icon: KeyRound, route: '/vault' },
  { id: 'trash', label: '最近删除', icon: Trash2, route: '/trash' }
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

/**
 * path → folder 节点的扁平索引（递归建好，任意深度都能 O(1) 查到名字）。
 * 之前只在两层 concat/flatMap 里找，三级以上嵌套的文件夹显示不出名字。
 */
const folderIndex = computed(() => {
  const map = new Map()
  function walk (list) {
    for (const node of list) {
      map.set(node.path, node)
      if (node.children?.length) walk(node.children)
    }
  }
  walk(treeFolders.value)
  return map
})

const allFolderPaths = computed(() => Array.from(folderIndex.value.keys()))

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
async function createFolderAtRoot() {
  const name = await askDialog({ mode: 'prompt', title: '新文件夹名称', defaultValue: '新文件夹' })
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
async function commitRootRename() {
  if (!renameState.active) return
  const targetId = renameState.target
  const v = renameState.value.trim()
  // 先把输入框复位再 await：等 IPC 的这几十毫秒里 UI 不该停在编辑态，
  // 否则用户看到的是「名字改了但树没动」。复位后 blur 再次触发本函数会被
  // renameState.active 挡住，不会重复提交。
  cancelRootRename()
  // 空标题直接还原即可 —— 输入框弹回原标题本身就是反馈，不必再弹提示
  if (!v) return
  const result = await noteStore.renameNote?.(targetId, v)
  reportOpResult(result, { verb: '重命名', title: v })
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
    const node = folderIndex.value.get(target)
    name = node?.name || String(target || '').split('/').pop() || target
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
async function createSubfolderHere() {
  closeContextMenu()
  if (ctxMenu.kind !== 'folder') return
  const name = await askDialog({ mode: 'prompt', title: '新子文件夹名称', defaultValue: '新文件夹' })
  if (!name) return
  const path = `${ctxMenu.target}/${name.trim()}`
  noteStore.createFolder(path)
  noteStore.setExpandedFolders([...noteStore.expandedFolders, ctxMenu.target, path])
}
async function renameItemHere() {
  closeContextMenu()
  if (ctxMenu.kind === 'folder') {
    const node = folderIndex.value.get(ctxMenu.target)
    if (!node) return
    const newName = await askDialog({ mode: 'prompt', title: '文件夹新名称', defaultValue: node.name })
    // 原实现里这里误写成 `f.name`（f 未定义，一按确认就抛 ReferenceError），
    // 换弹窗载体时顺手修正为比较该文件夹自己的名字 node.name。
    if (newName && newName.trim() !== node.name) {
      noteStore.renameFolder?.(ctxMenu.target, newName.trim())
    }
  } else if (ctxMenu.kind === 'note') {
    const n = noteStore.notes.find(x => x.id === ctxMenu.target)
    if (!n) return
    const newName = await askDialog({ mode: 'prompt', title: '笔记新标题', defaultValue: n.title })
    if (!newName) return
    const clean = newName.trim()
    if (!clean || clean === n.title) return
    const result = await noteStore.renameNote?.(ctxMenu.target, clean)
    reportOpResult(result, { verb: '重命名', title: clean })
  }
}
async function duplicateItem() {
  closeContextMenu()
  if (ctxMenu.kind === 'note') {
    const n = noteStore.notes.find(x => x.id === ctxMenu.target)
    if (!n) return
    const created = noteStore.createNote(n.folder || '', `${n.title} 副本`)
    noteStore.updateNoteContent(created.id, n.content)
    router.push(`/editor/${created.id}`)
  } else if (ctxMenu.kind === 'folder') {
    // 简单实现：提示暂不支持文件夹批量复制
    await askDialog({ mode: 'alert', title: '无法复制文件夹', message: '文件夹复制功能待实现，请复制其中的笔记。' })
  }
}
async function deleteItemHere() {
  closeContextMenu()
  if (ctxMenu.kind === 'note') {
    const ok = await askDialog({
      mode: 'confirm',
      title: '删除笔记',
      // deleteNote → electronAPI.deleteFile → 主进程 shell.trashItem（失败退化为库内 .trash），
      // 是「进回收站」而不是物理删除，旧文案写「不可恢复」与真实行为相反。
      message: '确定删除这篇笔记吗？文件会被移入回收站，可以在回收站里找回。',
      danger: true
    })
    if (!ok) return
    await deleteNoteAndReport(ctxMenu.target)
  } else if (ctxMenu.kind === 'folder') {
    const count = countNotesUnder(ctxMenu.target)
    const ok = await askDialog({
      mode: 'confirm',
      title: `删除文件夹「${ctxMenu.name}」`,
      // 与 deleteFolder 的真实行为逐条对应：它先把目录内（含子目录）所有笔记
      // 从库中移除，再把整个目录交给 removeDir 进系统回收站（不可用时退化为库内
      // .trash）。笔记**不会**被移到根目录 —— 旧文案正好说反了。
      message: count > 0
        ? `该文件夹及其子文件夹下的 ${count} 篇笔记会随目录一起被删除，文件进入回收站，可以找回。\n\n注意：笔记不会被移到根目录，而是和目录一起被移走。`
        : '该文件夹会被删除，目录内容进入回收站，可以找回。',
      danger: true
    })
    if (!ok) return
    await deleteFolderWithNotice(ctxMenu.target, ctxMenu.name)
  }
}

// ============= 递归组件事件接收器 =============
async function receiveRename(p) {
  if (!p) return
  if (p.type === 'folder') {
    noteStore.renameFolder?.(p.target, p.value)
  } else if (p.type === 'note') {
    // 来自 FolderNode 内联重命名：原来是同步调用，返回值（含失败原因）被丢掉
    const result = await noteStore.renameNote?.(p.target, p.value)
    reportOpResult(result, { verb: '重命名', title: String(p.value || '').trim() })
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
async function receiveDeleteItem(p) {
  if (!p) return
  if (p.kind === 'note') {
    await deleteNoteAndReport(p.id)
    return
  }
  if (p.kind === 'folder') {
    // 与右键菜单走同一套删除 + 降级告知，两条入口的文案不会各自漂移
    const node = folderIndex.value.get(p.path)
    const name = node?.name || String(p.path || '').split('/').pop() || p.path
    await deleteFolderWithNotice(p.path, name)
  }
}

// ============= DnD 接收器 =============
function clearDropState() { rootDrop.value = false; siblingDrop.kind = ''; siblingDrop.path = ''; siblingDrop.folder = '' }

function onRootDragOver(e) { rootDrop.value = true }

async function onRootDrop(e) {
  clearDropState()
  const payload = readDndPayload(e)
  if (!payload) return
  if (payload.type === 'note') {
    const result = await noteStore.moveNote?.(payload.id, '')
    reportOpResult(result, { verb: '移动' })
  } else if (payload.type === 'folder') {
    // 拖到根：renameFolder 只能改路径最后一段，跨层移动必须走 moveFolder
    if (!payload.parent) return
    await noteStore.moveFolder?.(payload.path, '')
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

async function onSiblingDrop(e, path, kind, folder) {
  const payload = readDndPayload(e)
  const zone = siblingDrop.kind || 'after'
  clearDropState()
  if (!payload) return
  await applyDndTarget({ source: payload, targetKind: kind, targetPath: path, zone, parentPath: folder, targetFolderContainer: folder })
}

async function receiveDnd(p) {
  if (!p) return
  await applyDndTarget(p)
}

function readDndPayload(e) {
  let data = null
  try { data = JSON.parse(e.dataTransfer.getData('application/x-choyeon-note') || 'null') } catch {}
  if (!data) try { data = JSON.parse(e.dataTransfer.getData('application/x-choyeon-folder') || 'null') } catch {}
  return data
}

/**
 * 拖放落地。T03 之后 moveNote 是 async 且会返回 OpResult，所以这里必须 async：
 * 树结构要等磁盘搬完才刷新（一次 IPC 往返），换来的是不再出现
 * 「先变过去、失败再弹回」（PRD R-D3）。
 *
 * @param {object} p 拖放描述 { source, targetKind, targetPath, targetFolderContainer, zone, parentPath }
 * @returns {Promise<void>}
 */
async function applyDndTarget({ source, targetKind, targetPath, targetFolderContainer, zone, parentPath }) {
  // 处理笔记移动到文件夹（zone==='on' 且 kind==='folder' 或 kind==='note' 则把 zone==='on' 视作 进入那个 note 所在文件夹）
  if (source.type === 'note') {
    if (targetKind === 'folder' && zone === 'on') {
      const result = await noteStore.moveNote?.(source.id, targetPath)
      // 只在真的落进去之后才展开目标目录：失败时展开会让人以为已经进去了
      if (reportOpResult(result, { verb: '移动' }) && !noteStore.expandedFolders.includes(targetPath)) {
        noteStore.setExpandedFolders([...noteStore.expandedFolders, targetPath])
      }
      return
    }
    if (targetKind === 'note') {
      const targetNote = noteStore.notes.find(n => n.id === targetPath)
      const destFolder = targetNote?.folder || ''
      const result = await noteStore.moveNote?.(source.id, destFolder)
      reportOpResult(result, { verb: '移动' })
      // before/after 目前仅做排序占位（未来可实现真顺序）
      return
    }
    // folder 的 before/after：放进 parent folder (root or targetFolderContainer)
    const result = await noteStore.moveNote?.(source.id, parentPath || targetFolderContainer || '')
    reportOpResult(result, { verb: '移动' })
  } else if (source.type === 'folder') {
    // 禁止把文件夹拖到自己或后代里（简单检测）
    if (targetKind === 'folder' && (targetPath === source.path || targetPath.startsWith(source.path + '/'))) return
    if (targetKind === 'folder' && zone === 'on') {
      // 真正把整棵树搬过去：磁盘目录 + 内存 folder/filePath + 派生索引都一起改。
      // 之前这里连调两次 renameFolder 再补一个只改内存的 hack，跨层移动完全不通，
      // 拖完看着对，重启目录树就"复活"，后续写盘还会留下孤儿文件。
      // moveFolder 返回的是 boolean（不是 OpResult），失败原因由 store 自己上报，
      // 这里只保证「没成功就别展开目标目录」，避免看起来像搬进去了。
      const moved = await noteStore.moveFolder?.(source.path, targetPath)
      if (moved === false) return
      if (!noteStore.expandedFolders.includes(targetPath)) {
        noteStore.setExpandedFolders([...noteStore.expandedFolders, targetPath])
      }
      return
    }
    // 其它情况：保持相同 parent 层级；暂不调整顺序
  }
}
</script>

<style scoped>
/* 「收起侧边栏」按钮：与 App.vue 里 .sidebar-rail-btn（展开）同一套视觉，
   只有方向图标不同。背景/边框写在这里而不是写内联 style —— 内联 style 的优先级
   高于任何选择器，写成 :style 会让 hover 态永远打不过它（hover 等于没有）。 */
.sidebar-collapse-btn {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
}

.sidebar-collapse-btn:hover {
  background: var(--color-surface-hover);
}

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
