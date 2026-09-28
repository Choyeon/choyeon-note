<template>
  <!--
    T31 · 多库（Vault）管理入口。

    为什么需要它：workspace store 早就支持多工作区，但用户看不见、加不了、
    切不了 —— 能力存在却没入口，等于不存在。这里是那个入口。

    五条硬规则（逐条对应 tests/workspaceManager.test.js）：
      1. 移除**只摘列表记录**，绝不删磁盘文件 —— 提示文案必须把这件事说出口；
      2. 目录在磁盘上不存在 → 显示「缺失」而不是崩，也不许悄悄当成空库；
      3. 切换到缺失的库 → 明确提示并拒绝切换（切过去看到「笔记没了」比切不过去严重得多）；
      4. 重名 / 空名 / 非法路径一律拦下并 toast 说清原因；
      5. 重命名只改显示名，目录不动（与 Obsidian 口径一致，理由见 renameWorkspace）。
  -->
  <Teleport to="body">
    <Transition name="wm" appear>
      <div
        v-if="shown"
        class="wm-backdrop"
        role="presentation"
        @mousedown.self="handleBackdrop"
      >
        <div
          ref="panelRef"
          class="wm-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wm-title"
          tabindex="-1"
        >
          <header class="wm-header">
            <Library class="wm-header-icon" />
            <h2 id="wm-title" class="wm-title">笔记库管理</h2>
            <span class="wm-count">共 {{ rows.length }} 个</span>
            <button
              type="button"
              class="wm-icon-btn"
              aria-label="关闭"
              title="关闭（Esc）"
              @click="close"
            >
              <X class="wm-icon-btn-glyph" />
            </button>
          </header>

          <p class="wm-sub">
            切换 / 新增 / 重命名 / 移除本地笔记库。移除只会从列表里去掉记录，<strong>磁盘文件不会删除</strong>。
          </p>

          <div class="wm-body cho-scrollbar">
            <p v-if="isLoading" class="wm-loading">
              <Loader2 class="wm-spin" />
              正在检查笔记库…
            </p>

            <div v-if="!isLoading && rows.length === 0 && !draft.path" class="wm-empty">
              <FolderOpen class="wm-empty-icon" />
              <p class="wm-empty-title">还没有登记任何笔记库</p>
              <p class="wm-empty-desc">点下方「新增笔记库」，选一个已有文件夹作为你的笔记库。</p>
            </div>

            <ul class="wm-list">
              <li
                v-for="ws in rows"
                :key="ws.id"
                class="wm-item"
                :class="{ 'wm-item--active': ws.id === workspaceStore.activeId, 'wm-item--missing': isMissing(ws.id) }"
                :data-ws-id="ws.id"
              >
                <div class="wm-item-head">
                  <Library class="wm-item-icon" />

                  <template v-if="renamingId === ws.id">
                    <input
                      ref="renameInputRef"
                      v-model="renameValue"
                      class="wm-rename-input"
                      type="text"
                      maxlength="80"
                      aria-label="笔记库名称"
                      @keydown.enter.prevent="confirmRename(ws)"
                      @keydown.esc.prevent="cancelRename"
                    />
                  </template>
                  <template v-else>
                    <span class="wm-item-name" :title="ws.name">{{ ws.name }}</span>
                  </template>

                  <span v-if="ws.id === workspaceStore.activeId" class="wm-badge wm-badge--active">
                    <Check class="wm-badge-glyph" />当前
                  </span>
                  <span v-if="isMissing(ws.id)" class="wm-badge wm-badge--missing">
                    <AlertTriangle class="wm-badge-glyph" />缺失
                  </span>
                  <span v-if="isReadOnly(ws.id)" class="wm-badge wm-badge--readonly">只读</span>

                  <div class="wm-item-actions">
                    <template v-if="renamingId === ws.id">
                      <button type="button" class="wm-btn wm-btn--mini wm-btn--primary" @click="confirmRename(ws)">
                        保存
                      </button>
                      <button type="button" class="wm-btn wm-btn--mini" @click="cancelRename">取消</button>
                    </template>
                    <template v-else>
                      <button
                        type="button"
                        class="wm-btn wm-btn--mini"
                        :title="ws.id === workspaceStore.activeId ? '已经是当前笔记库' : '切换到这个笔记库'"
                        @click="handleSwitch(ws)"
                      >
                        <ArrowRightLeft class="wm-btn-glyph" />切换
                      </button>
                      <button type="button" class="wm-btn wm-btn--mini" title="重命名（只改显示名，不动目录）" @click="startRename(ws)">
                        <Pencil class="wm-btn-glyph" />重命名
                      </button>
                      <button type="button" class="wm-btn wm-btn--mini wm-btn--danger" title="从列表移除（不会删除磁盘文件）" @click="startRemove(ws)">
                        <Trash2 class="wm-btn-glyph" />移除
                      </button>
                    </template>
                  </div>
                </div>

                <p class="wm-item-path" :title="ws.path">
                  <HardDrive class="wm-item-path-icon" />
                  <span class="wm-item-path-value">{{ ws.path }}</span>
                </p>

                <p class="wm-item-meta">
                  <span v-if="isMissing(ws.id)" class="wm-item-warn">
                    目录不存在（U 盘已拔出 / 目录被移动 / 网络盘断开），重新接入后可再次切换
                  </span>
                  <span v-else>{{ describeMeta(ws.id) }}</span>
                </p>

                <div v-if="confirmId === ws.id" class="wm-confirm">
                  <p class="wm-confirm-text">
                    <ShieldAlert class="wm-confirm-icon" />
                    确认从列表移除「{{ ws.name }}」？<strong>仅从列表移除，磁盘文件不会删除。</strong>
                  </p>
                  <div class="wm-confirm-actions">
                    <button type="button" class="wm-btn wm-btn--mini" @click="cancelRemove">取消</button>
                    <button type="button" class="wm-btn wm-btn--mini wm-btn--danger-solid" @click="confirmRemove(ws)">
                      确认移除
                    </button>
                  </div>
                </div>
              </li>
            </ul>

            <div v-if="draft.path" class="wm-draft">
              <p class="wm-draft-path" :title="draft.path">
                <FolderOpen class="wm-draft-path-icon" />
                <span class="wm-draft-path-value">{{ draft.path }}</span>
              </p>
              <div class="wm-draft-row">
                <input
                  ref="draftInputRef"
                  v-model="draft.name"
                  class="wm-draft-input"
                  type="text"
                  maxlength="80"
                  placeholder="给这个笔记库起个名字"
                  aria-label="新笔记库名称"
                  @keydown.enter.prevent="confirmAdd"
                  @keydown.esc.prevent="cancelAdd"
                />
                <button type="button" class="wm-btn wm-btn--mini wm-btn--primary" @click="confirmAdd">保存</button>
                <button type="button" class="wm-btn wm-btn--mini" @click="cancelAdd">取消</button>
              </div>
              <p class="wm-draft-hint">目录本身不会被改动或移动；名称只是列表里显示用的标签。</p>
            </div>
          </div>

          <footer class="wm-footer">
            <button type="button" class="wm-btn wm-btn--primary" :disabled="isLoading" @click="handleAdd">
              <Plus class="wm-btn-glyph" />新增笔记库
            </button>
            <button type="button" class="wm-btn" :disabled="isLoading" title="重新检查每个库的目录是否还在" @click="refresh">
              <RefreshCw class="wm-btn-glyph" />重新检查
            </button>
            <span class="wm-footer-spacer"></span>
            <button type="button" class="wm-btn" @click="close">关闭</button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Library,
  FolderOpen,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  AlertTriangle,
  RefreshCw,
  Loader2,
  ArrowRightLeft,
  HardDrive,
  ShieldAlert
} from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import { useNoteStore } from '@/stores/note'
import { useWorkspaceStore, basenameOf } from '@/stores/workspace'
import { hasElectronAPI } from '@/utils/env'

const props = defineProps({
  /** 是否显示。默认 true：组件也能独立挂载（不依赖调用方状态）自行展示 */
  visible: {
    type: Boolean,
    default: true
  },
  /** 点遮罩是否关闭；有未完成的输入时会忽略，避免误关丢失输入 */
  closeOnBackdrop: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits(['close', 'switched', 'update:visible'])

const appStore = useAppStore()
const noteStore = useNoteStore()
const workspaceStore = useWorkspaceStore()

const panelRef = ref(null)
const renameInputRef = ref(null)
const draftInputRef = ref(null)

const isLoading = ref(false)
/** 正在重命名的库 id */
const renamingId = ref(null)
const renameValue = ref('')
/** 正在确认移除的库 id */
const confirmId = ref(null)
/**
 * 非受控模式下的开关状态。
 *
 * 组件要能独立挂载（不传任何 props 也能自己显示 + 自己关）。父组件用
 * v-model:visible 时由 props 驱动，不用时靠这份内部状态 —— 只 emit 不改内部
 * 状态的话，独立挂载时点了「关闭」面板纹丝不动。
 */
const internalVisible = ref(props.visible)

/** 面板是否显示：唯一真值是内部状态，props 变化通过 watch 同步进来 */
const shown = computed(() => internalVisible.value === true)
/** 新增草稿：{ path, name } —— path 非空即表示草稿行展开 */
const draft = ref({ path: '', name: '' })

/**
 * 列表按登记顺序展示（不做「最近打开」排序）。
 *
 * 管理界面要的是稳定顺序：按 lastOpenedAt 排序的话，用户点一次「重新检查」
 * 或切换一次，行就跳位置，正在点的那一行会跑到鼠标底下另一条上。
 */
const rows = computed(() => workspaceStore.workspaces || [])

/** 存在未完成输入时不响应遮罩点击 */
const hasPendingInput = computed(
  () => !!draft.value.path || !!renamingId.value || !!confirmId.value
)

/**
 * 该库是否在磁盘上缺失。
 *
 * 只看探测结果，不把「还没探测」当成缺失（见 store 的 missingMap 注释）。
 *
 * @param {string} id 工作空间 id
 * @returns {boolean} 缺失为 true
 */
function isMissing (id) {
  return workspaceStore.isMissing(id) === true
}

/**
 * 目录是否只读（探测出 writable === false）。
 *
 * @param {string} id 工作空间 id
 * @returns {boolean} 只读为 true
 */
function isReadOnly (id) {
  const record = workspaceStore.metaFor(id)
  return !!record && record.exists !== false && record.writable === false
}

/**
 * 一行的磁盘摘要：笔记数 / 文件夹数 / 尚未探测。
 *
 * @param {string} id 工作空间 id
 * @returns {string} 摘要文案
 */
function describeMeta (id) {
  const record = workspaceStore.metaFor(id)
  if (!record) return '尚未探测'
  const count = Number(record.count) || 0
  const folders = Number(record.folders) || 0
  return `${count} 个文件 · ${folders} 个文件夹`
}

/** 统一出口：面向用户的提示一律走 toast（appStore.pushToast({ type, message })） */
function toast (type, message) {
  appStore.pushToast({ type, message })
}

/**
 * 聚焦（并全选）一个模板 ref 指向的输入框。
 *
 * 兼容两种形态：在 v-for 里的 ref 会被 Vue 收成数组，不在 v-for 里是单个元素。
 * 不做这层兼容的话，重命名输入框（在列表 v-for 里）永远拿不到焦点 ——
 * 用户点「重命名」后还得自己再点一下输入框。
 *
 * @param {object} refObj Vue 模板 ref
 * @returns {void}
 */
function focusInput (refObj) {
  const raw = refObj && refObj.value
  const target = Array.isArray(raw) ? raw[0] : raw
  if (!target) return
  target.focus?.()
  if (typeof target.select === 'function') target.select()
}

/**
 * 载入列表 + 逐个探测磁盘状态。
 *
 * hydrate 会重新读一次持久化层（Electron 下是 workspaces.json），所以新增 /
 * 移除之后调它是安全的：persist() 已经先写回去了。
 *
 * @returns {Promise<void>}
 */
async function refresh () {
  isLoading.value = true
  try {
    await workspaceStore.hydrate()
    await workspaceStore.probeAll()
  } catch (error) {
    // probeAll 内部逐个 try/catch，走到这里说明 hydrate 本身挂了 ——
    // 必须让用户知道「列表可能不是最新的」，而不是静默显示一个旧列表
    toast('error', `刷新笔记库列表失败：${error?.message || error}`)
  } finally {
    isLoading.value = false
  }
}

/**
 * 切换成功后把「当前库」这件事真正落地：写回 appStore.notesLocation +
 * 让 noteStore 从新目录重载笔记。只改 store 里的 activeId 而笔记不跟着换，
 * 那不叫切换 —— 用户看到的是列表里的高亮变了、内容还是旧库的。
 *
 * @param {object} workspace 目标工作空间
 * @returns {Promise<void>}
 */
async function applyActiveWorkspace (workspace) {
  if (!workspace) return
  try {
    if (typeof appStore.saveNotesLocation === 'function') {
      appStore.saveNotesLocation(workspace.path)
    }
    if (typeof noteStore.loadNotesFromPath === 'function') {
      const result = await noteStore.loadNotesFromPath(workspace.path)
      if (result && result.ok === false && !result.stale) {
        toast('error', `已切换库记录，但载入笔记失败：${result.error || '无法读取该目录'}`)
      }
    }
  } catch (error) {
    toast('error', `切换后载入笔记失败：${error?.message || error}`)
  }
}

/**
 * 切换到某个笔记库。
 *
 * 目标缺失时 store 会拒绝并保持原库，这里把原因原样说给用户 —— 不许静默切进空库。
 *
 * @param {object} workspace 目标工作空间
 * @returns {Promise<void>}
 */
async function handleSwitch (workspace) {
  if (!workspace) return
  if (workspace.id === workspaceStore.activeId) {
    toast('info', `「${workspace.name}」已经是当前笔记库`)
    return
  }
  const result = await workspaceStore.switchWorkspace(workspace.id)
  if (!result.ok) {
    toast('error', result.error || '切换笔记库失败')
    return
  }
  await applyActiveWorkspace(result.workspace)
  toast('success', `已切换到「${result.workspace.name}」`)
  emit('switched', result.workspace)
}

/**
 * 新增：先选目录，再让用户确认显示名。
 *
 * 分两步而不是「选完直接建」：名称会自动取目录名，目录名撞车（两个不同盘下
 * 都有 notes）时用户得有机会改，否则列表里两个同名项根本分不清。
 *
 * @returns {Promise<void>}
 */
async function handleAdd () {
  if (hasPendingInput.value) return
  if (!hasElectronAPI() || typeof window.electronAPI.selectNotesPath !== 'function') {
    toast('info', '当前环境不支持选择本地文件夹')
    return
  }
  const picked = await workspaceStore.pickDirectory()
  if (!picked) return // 用户在系统对话框里点了取消

  const existing = (workspaceStore.workspaces || []).find(w => w.path === picked)
  if (existing) {
    toast('info', `该目录已登记为「${existing.name}」，可直接切换`)
    return
  }

  draft.value = { path: picked, name: basenameOf(picked) || '笔记库' }
  await nextTick()
  focusInput(draftInputRef)
}

/** 保存新增草稿 */
async function confirmAdd () {
  if (!draft.value.path) return
  // 名称在这里先过一遍校验：store 的 addWorkspace 对「没给名字」会自动取目录名，
  // 但用户**主动清空**输入框是「我要自己起名却没写」，必须拦下而不是替他填回去
  const nameCheck = workspaceStore.checkName(draft.value.name, null)
  if (!nameCheck.ok) {
    toast('error', nameCheck.error)
    return
  }
  const result = await workspaceStore.addWorkspace(draft.value.path, nameCheck.name)
  if (!result.ok) {
    toast('error', result.error || '新增笔记库失败')
    return
  }
  const created = result.workspace
  draft.value = { path: '', name: '' }
  toast('success', `已新增笔记库「${created.name}」`)

  // 一个库都没有时（首次登记）直接切过去：否则用户会卡在一个列表里没有当前项的空界面
  if (!workspaceStore.activeId && created) {
    const switched = await workspaceStore.switchWorkspace(created.id)
    if (switched.ok) {
      await applyActiveWorkspace(switched.workspace)
      emit('switched', switched.workspace)
    }
  }
  await refresh()
}

/** 放弃新增草稿 */
function cancelAdd () {
  draft.value = { path: '', name: '' }
}

/**
 * 进入重命名态。
 *
 * @param {object} workspace 目标工作空间
 * @returns {Promise<void>}
 */
async function startRename (workspace) {
  confirmId.value = null
  renamingId.value = workspace.id
  renameValue.value = workspace.name || ''
  await nextTick()
  focusInput(renameInputRef)
}

/** 保存重命名（只改显示名） */
async function confirmRename (workspace) {
  const result = await workspaceStore.renameWorkspace(workspace.id, renameValue.value)
  if (!result.ok) {
    // 保持输入框打开：用户改一个字符就能重试，比重新点一次重命名省事
    toast('error', result.error || '重命名失败')
    return
  }
  renamingId.value = null
  renameValue.value = ''
  toast('success', `已重命名为「${result.workspace.name}」（目录未改动）`)
}

/** 放弃重命名 */
function cancelRename () {
  renamingId.value = null
  renameValue.value = ''
}

/**
 * 请求移除：进入二次确认态（不直接删）。
 *
 * @param {object} workspace 目标工作空间
 * @returns {void}
 */
function startRemove (workspace) {
  renamingId.value = null
  confirmId.value = workspace.id
}

/** 确认移除：只摘列表记录 */
async function confirmRemove (workspace) {
  const result = await workspaceStore.removeWorkspace(workspace.id)
  if (!result.ok) {
    toast('error', result.error || '移除失败')
    return
  }
  confirmId.value = null
  toast('success', `已从列表移除「${result.workspace.name}」，磁盘文件未删除`)
  await refresh()
}

/** 放弃移除 */
function cancelRemove () {
  confirmId.value = null
}

/** 关闭面板（同时支持 v-model:visible 与独立挂载两种用法） */
function close () {
  internalVisible.value = false
  emit('update:visible', false)
  emit('close')
}

/**
 * 点遮罩关闭。有未完成的输入（新增 / 重命名 / 确认移除）时不关 ——
 * 手抖点到外面就丢掉刚填的东西，是最招骂的一种交互。
 *
 * @returns {void}
 */
function handleBackdrop () {
  if (!props.closeOnBackdrop) return
  if (hasPendingInput.value) return
  close()
}

/**
 * Esc 分层处理：先取消当前这一层的输入，都没有才关面板。
 *
 * @returns {void}
 */
function handleEscape () {
  if (draft.value.path) {
    cancelAdd()
    return
  }
  if (renamingId.value) {
    cancelRename()
    return
  }
  if (confirmId.value) {
    cancelRemove()
    return
  }
  close()
}

/** 全局 keydown（与 ConflictDialog / QuickSwitcher 同规范：只处理 Esc） */
function handleWindowKeydown (e) {
  if (!shown.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    handleEscape()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown)
  refresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleWindowKeydown)
})

// 受控用法：父组件把 visible 拨回来时同步内部状态
watch(
  () => props.visible,
  (open) => {
    internalVisible.value = !!open
  }
)

// 每次打开都重新探测：库目录可能刚刚被拔掉 / 接上，缓存的探测结果会骗人
watch(shown, (open) => {
  if (open) refresh()
})
</script>

<style scoped>
.wm-backdrop {
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

.wm-panel {
  width: min(720px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  overflow: hidden;
  border-radius: var(--radius-lg, 12px);
  border: 1px solid var(--color-border);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-float);
  outline: none;
}

.wm-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wm-header-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--color-primary);
}

.wm-title {
  margin: 0;
  font-family: var(--font-title);
  font-size: var(--font-size-lg, 16px);
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.4;
}

.wm-count {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-full, 999px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-secondary);
}

.wm-icon-btn {
  margin-left: auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 8px);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: background var(--transition-micro), color var(--transition-micro);
}

.wm-icon-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.wm-icon-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.wm-icon-btn-glyph {
  width: 16px;
  height: 16px;
}

.wm-sub {
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  line-height: 1.6;
  color: var(--color-text-tertiary);
}

.wm-sub strong {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.wm-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wm-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 12px 0;
  font-size: var(--font-size-body, 14px);
  color: var(--color-text-secondary);
}

.wm-spin {
  width: 16px;
  height: 16px;
  animation: wm-rotate 900ms linear infinite;
}

@keyframes wm-rotate {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wm-spin {
    animation: none;
  }
}

.wm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 12px;
  text-align: center;
}

.wm-empty-icon {
  width: 28px;
  height: 28px;
  color: var(--color-text-tertiary);
}

.wm-empty-title {
  margin: 0;
  font-size: var(--font-size-body, 14px);
  font-weight: 600;
  color: var(--color-text-primary);
}

.wm-empty-desc {
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.wm-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wm-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.wm-item--active {
  border-color: var(--color-primary);
}

.wm-item--missing {
  border-color: var(--state-danger, #d9534f);
  background: var(--color-bg-tertiary);
}

.wm-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.wm-item-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}

.wm-item--active .wm-item-icon {
  color: var(--color-primary);
}

.wm-item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-body, 14px);
  font-weight: 600;
  color: var(--color-text-primary);
}

.wm-rename-input {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 260px;
  padding: 5px 8px;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--color-primary);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-family: var(--font-body);
  font-size: var(--font-size-body, 14px);
}

.wm-rename-input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.wm-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: var(--radius-full, 999px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-secondary);
}

.wm-badge-glyph {
  width: 11px;
  height: 11px;
}

.wm-badge--active {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.wm-badge--missing {
  border-color: var(--state-danger, #d9534f);
  color: var(--state-danger, #d9534f);
}

.wm-badge--readonly {
  color: var(--state-warning, #b8860b);
  border-color: var(--state-warning, #b8860b);
}

.wm-item-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.wm-item-path {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.wm-item-path-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.wm-item-path-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.wm-item-meta {
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.wm-item-warn {
  color: var(--state-danger, #d9534f);
}

.wm-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--state-warning, #b8860b);
  background: var(--color-surface);
}

.wm-confirm-text {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.wm-confirm-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--state-warning, #b8860b);
}

.wm-confirm-text strong {
  color: var(--color-text-primary);
  font-weight: 600;
}

.wm-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.wm-draft {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px dashed var(--color-primary);
  background: var(--color-surface);
}

.wm-draft-path {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.wm-draft-path-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.wm-draft-path-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.wm-draft-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wm-draft-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 8px;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-family: var(--font-body);
  font-size: var(--font-size-body, 14px);
}

.wm-draft-input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.wm-draft-hint {
  margin: 0;
  font-size: var(--font-size-3xs, 10px);
  color: var(--color-text-tertiary);
}

.wm-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wm-footer-spacer {
  flex: 1 1 auto;
}

.wm-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 14px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid transparent;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-family: var(--font-body);
  font-size: var(--font-size-body, 14px);
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--transition-micro),
    color var(--transition-micro),
    box-shadow var(--transition-smooth),
    transform var(--transition-micro);
}

.wm-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.wm-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.wm-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.wm-btn:hover:not(:disabled) {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.wm-btn-glyph {
  width: 14px;
  height: 14px;
}

.wm-btn--mini {
  padding: 4px 9px;
  font-size: var(--font-size-3xs, 10px);
}

.wm-btn--primary {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
}

.wm-btn--primary:hover:not(:disabled) {
  background: var(--color-primary-dark);
  color: var(--color-text-on-primary);
  box-shadow: var(--shadow-sm);
}

.wm-btn--danger {
  color: var(--state-danger, #d9534f);
}

.wm-btn--danger:hover:not(:disabled) {
  background: var(--color-surface-hover);
  color: var(--state-danger, #d9534f);
}

.wm-btn--danger-solid {
  background: var(--state-danger, #d9534f);
  color: #fff;
}

.wm-btn--danger-solid:hover:not(:disabled) {
  background: var(--state-danger, #d9534f);
  color: #fff;
  box-shadow: var(--shadow-sm);
}

/* 入场 / 退场动画（与 ConflictDialog 同一组时长曲线） */
.wm-enter-active {
  transition: opacity var(--duration-normal) var(--ease-out-quart);
}

.wm-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out-quart);
}

.wm-enter-active .wm-panel {
  transition:
    transform var(--duration-normal) var(--ease-spring-soft),
    opacity var(--duration-normal) var(--ease-out-quart);
}

.wm-leave-active .wm-panel {
  transition:
    transform var(--duration-fast) var(--ease-out-quart),
    opacity var(--duration-fast) var(--ease-out-quart);
}

.wm-enter-from,
.wm-leave-to {
  opacity: 0;
}

.wm-enter-from .wm-panel,
.wm-leave-to .wm-panel {
  transform: scale(0.96);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .wm-enter-from .wm-panel,
  .wm-leave-to .wm-panel {
    transform: none;
  }
}
</style>
