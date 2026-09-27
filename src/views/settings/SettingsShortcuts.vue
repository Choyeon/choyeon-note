<template>
  <div class="mb-8">
    <div class="flex items-center gap-3 mb-4 px-1">
      <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
        <Keyboard class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
      </div>
      <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">快捷键</h2>
      <span
        class="text-[11px] px-1.5 py-0.5 rounded"
        :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }"
      >{{ headerCountLabel }}</span>

      <div class="ml-auto flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 px-3 h-7 rounded-lg text-[12px] font-medium cursor-pointer border transition-all duration-150 hover:opacity-80"
          :style="onlyModified
            ? { background: 'var(--color-primary-surface)', color: 'var(--color-primary)', borderColor: 'var(--color-primary)' }
            : { background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)', borderColor: 'transparent' }"
          :title="onlyModified ? '显示全部命令' : '只显示已自定义的快捷键'"
          @click="onlyModified = !onlyModified"
        >
          <Filter class="w-3.5 h-3.5" />
          仅看已修改
          <span v-if="modifiedCount" class="text-[11px] font-semibold">{{ modifiedCount }}</span>
        </button>
        <button
          v-if="hasCustomHotkeys"
          class="px-3 h-7 rounded-lg text-[12px] font-medium cursor-pointer transition-all duration-150 hover:opacity-80 active:scale-95"
          :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
          @click="resetAllShortcuts"
        >全部重置</button>
      </div>
    </div>

    <div class="mb-3">
      <div class="relative">
        <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
        <input
          v-model="shortcutSearch"
          type="text"
          placeholder="搜索快捷键（支持按键名，如 Ctrl）..."
          class="shortcut-search w-full h-10 pl-9 pr-4 rounded-lg text-[13px] outline-none transition-all duration-200"
          :style="{
            background: 'var(--color-bg-secondary)',
            color: 'var(--color-text-primary)'
          }"
        />
      </div>

      <!-- 录制期冲突：给「强行覆盖」一个明确的落点（不写盘前先让用户确认） -->
      <p
        v-if="pendingOverride"
        class="mt-2 px-3 py-2 rounded-lg text-[12px] flex items-center gap-2 flex-wrap"
        :style="{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--state-error)' }"
      >
        <span>与「{{ pendingOverride.label }}」冲突</span>
        <button class="override-btn" @click="applyPendingOverride">强行覆盖</button>
        <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">覆盖后「{{ pendingOverride.label }}」的键位会被清空</span>
      </p>

      <p
        v-if="recordError"
        class="mt-2 px-3 py-2 rounded-lg text-[12px]"
        :style="{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--state-error)' }"
      >{{ recordError }}</p>

      <p
        v-if="notice"
        class="mt-2 px-3 py-2 rounded-lg text-[12px]"
        :style="noticeLevel === 'warn'
          ? { background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }
          : { background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
      >{{ notice }}</p>
    </div>

    <div
      v-for="category in filteredShortcutCategories"
      :key="category.id"
      class="settings-card mb-3"
    >
      <div class="px-5 py-3 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
        <div class="flex items-center gap-2">
          <component :is="category.icon" class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
          <span class="text-[13px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">{{ category.label }}</span>
          <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">{{ category.items.length }}</span>
        </div>
      </div>
      <div class="divide-y" :style="{ borderColor: 'var(--color-border-light)' }">
        <div
          v-for="item in category.items"
          :key="item.id"
          :data-shortcut-row="item.id"
          class="flex items-center justify-between gap-3 px-5 py-2.5 transition-colors"
          :class="appStore.shortcutRecordingId === item.id ? 'is-recording' : 'hover:bg-[var(--color-surface-hover)]'"
        >
          <div class="min-w-0 flex flex-col gap-0.5">
            <div class="min-w-0 flex items-center gap-2">
              <span class="text-[13px] truncate" :style="{ color: 'var(--color-text-primary)' }">{{ item.label }}</span>
              <span
                v-if="isCustomized(item)"
                class="text-[11px] px-1.5 py-0.5 rounded shrink-0"
                :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
              >已自定义</span>
            </div>

            <!-- 冲突 / 保留键说明：block 级给红色 + 强行覆盖，其余只提示不阻断 -->
            <div v-if="rowState(item).note" class="flex items-center gap-1.5 flex-wrap">
              <AlertTriangle
                v-if="rowState(item).severity !== 'block'"
                class="w-3.5 h-3.5 shrink-0"
                :style="{ color: 'var(--state-warning)' }"
              />
              <span
                class="shortcut-note"
                :style="{ color: rowState(item).severity === 'block' ? 'var(--state-error)' : 'var(--color-text-tertiary)' }"
              >{{ rowState(item).note }}</span>
              <button
                v-if="rowState(item).canOverride"
                class="override-btn"
                :title="`清空「${rowState(item).label}」的键位并保留当前键`"
                @click="forceOverrideRow(item)"
              >强行覆盖</button>
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <template v-if="appStore.shortcutRecordingId === item.id">
              <!-- 实时预览：只按下修饰键时先渲染修饰键，主键捕获后补上完整组合 -->
              <span
                v-for="(key, idx) in recordingPreview"
                :key="key + idx"
                class="kbd-key kbd-key--preview"
              >{{ key }}</span>
              <span class="text-[12px] recording-hint" :style="{ color: 'var(--color-primary)' }">
                按下新的组合键… Esc 取消 · Backspace 清除
              </span>
            </template>
            <template v-else>
              <span v-if="!currentBinding(item.id)" class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">未设置</span>
              <span
                v-for="(key, idx) in bindingPartsOf(item.id)"
                :key="key + idx"
                class="kbd-key"
                :class="{ 'is-error': rowState(item).severity === 'block' || rowState(item).severity === 'hard' }"
              >{{ key }}</span>
              <AlertTriangle
                v-if="rowState(item).severity === 'warn'"
                class="w-3.5 h-3.5"
                :style="{ color: 'var(--state-warning)' }"
                :title="rowState(item).warnReason"
              />
              <button class="kbd-edit" :title="`修改「${item.label}」的快捷键`" @click="startRecording(item.id)">
                <Pencil class="w-3.5 h-3.5" />
              </button>
              <button
                v-if="isCustomized(item)"
                class="kbd-edit"
                :title="`恢复默认（${formatBinding(item.default)}）`"
                @click="resetShortcut(item.id)"
              >
                <RotateCcw class="w-3.5 h-3.5" />
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div v-if="filteredShortcutCategories.length === 0" class="settings-card py-10 text-center">
      <component
        :is="onlyModified ? Filter : Search"
        class="w-8 h-8 mx-auto mb-2"
        :style="{ color: 'var(--color-text-tertiary)' }"
      />
      <p class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">
        {{ onlyModified ? '还没有自定义任何快捷键' : '未找到匹配的快捷键' }}
      </p>
    </div>
  </div>
</template>

<script setup>
/**
 * 设置页 → 快捷键。
 *
 * 真实来源仍然只有 constants/shortcuts.js 的 SHORTCUTS 注册表（这里读什么、
 * 编辑器就绑什么、App.vue 也匹配什么）。录制期间写的是 appStore.shortcutRecordingId，
 * 全局监听因此照旧会让路。
 *
 * ============ T11 改版要点（对照 PRD §4 P1-1） ============
 * 1. 「仅看已修改」：过滤掉未自定义的命令，分类卡只保留仍有项的分类。
 * 2. 冲突可视化：block 级胶囊 --state-error 描边 + 行内「与「X」冲突 · [强行覆盖]」。
 * 3. 保留键提示：warn 级在胶囊旁挂警告图标 + tooltip（不阻断保存）。
 * 4. 录制兜底：点其它命令行 / 点页面任意空白 / 路由离开 → 自动 stopRecording()。
 *    监听一律在 onMounted 挂到 document、onUnmounted 成对移除（项目规范要求）。
 * 5. 录制实时预览：已捕获的修饰键 / 组合实时渲染成胶囊。
 * 6. setHotkey 契约迁移：改读 `status` + `canOverride`（旧的 `reason` 只是兼容字段）。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useAppStore } from '@/stores/app'
import {
  SHORTCUTS,
  SHORTCUT_MAP,
  SHORTCUT_CATEGORIES,
  bindingParts,
  formatBinding,
  eventToBinding,
  describeReserved
} from '@/constants/shortcuts'
import {
  Keyboard, Search, Pencil, RotateCcw, Filter, AlertTriangle,
  FolderOpen, PenLine, Type, LayoutDashboard, Plus
} from 'lucide-vue-next'

/** SHORTCUT_CATEGORIES 里的 icon 是字符串，这里映射成真实组件 */
const CATEGORY_ICONS = {
  FolderOpen,
  PenLine,
  Type,
  LayoutDashboard,
  Plus
}

const appStore = useAppStore()
const shortcutSearch = ref('')
const recordError = ref('')
/** 成功 / 警告级提示文案（覆盖成功、已清空、保留键警告都走这里） */
const notice = ref('')
/** 'ok' 用主色底，'warn' 用中性底 —— 不新增色值，只切换现有变量 */
const noticeLevel = ref('ok')
/** 仅看已修改（对标 Obsidian 的漏斗过滤） */
const onlyModified = ref(false)
/** 录制期实时预览：已捕获按键的标签数组 */
const recordingPreview = ref([])
/** 录制期撞上 block 级冲突时的待处理项 `{ id, binding, label }`，供「强行覆盖」重试 */
const pendingOverride = ref(null)

// 真实来源只有一份：constants/shortcuts.js 的 SHORTCUTS 注册表
function currentBinding(id) {
  return appStore.getBinding(id) || ''
}
function bindingPartsOf(id) {
  return bindingParts(currentBinding(id))
}
function isCustomized(item) {
  return currentBinding(item.id) !== item.default
}

const hasCustomHotkeys = computed(() =>
  SHORTCUTS.some(s => !s.hidden && currentBinding(s.id) !== s.default)
)

/** 可见命令（hidden 的不进设置页）里已自定义的条数 */
const modifiedCount = computed(() =>
  SHORTCUTS.filter(s => !s.hidden && currentBinding(s.id) !== s.default).length
)

const totalCount = computed(() => SHORTCUTS.filter(s => !s.hidden).length)

/** 顶部计数：开启过滤后改为已修改条数（PRD §5.1） */
const headerCountLabel = computed(() =>
  onlyModified.value ? `已修改 ${modifiedCount.value}` : `共 ${totalCount.value}`
)

/**
 * 逐条命令的冲突索引：`命令 id -> { severity, kind, label, reason, canOverride }`。
 *
 * 直接复用 store 的 `findConflict`（同一套判定口径，UI 不再自己比字符串），
 * 它内部已跳过命令自身，所以「我占了别人正在用的键」会被如实检出。
 * 依赖 `hotkeys`，改键后自动重算。
 */
const conflictIndex = computed(() => {
  const map = new Map()
  for (const s of SHORTCUTS) {
    const binding = currentBinding(s.id)
    if (!binding) continue
    const conflict = appStore.findConflict(s.id, binding)
    if (!conflict) continue
    map.set(s.id, {
      severity: conflict.severity,
      kind: conflict.kind || '',
      label: conflict.label || '',
      reason: conflict.reason || '',
      // 只有 block（同 scope 实占）才允许「强行覆盖」：
      // hard 级是系统保留键，override 也写不进去；warn 级本来就没被拦，无需清空谁
      canOverride: conflict.severity === 'block'
    })
  }
  return map
})

/**
 * 单行的展示态。返回 `{ severity, note, label, warnReason, canOverride }`，
 * severity 为 '' 表示没有冲突也没有保留键提示。
 *
 * @param {object} item 注册表里的命令项
 * @returns {{severity: string, note: string, label: string, warnReason: string, canOverride: boolean}}
 */
function rowState(item) {
  const empty = { severity: '', note: '', label: '', warnReason: '', canOverride: false }
  const conflict = conflictIndex.value.get(item.id)
  if (!conflict) return empty
  const binding = currentBinding(item.id)
  // 保留键的说明统一取自 describeReserved（与 store 判保留键用的是同一个出口）
  const reservedReason = conflict.kind.startsWith('reserved')
    ? (describeReserved(binding).reason || conflict.reason)
    : conflict.reason

  if (conflict.severity === 'block') {
    return {
      severity: 'block',
      note: `与「${conflict.label}」冲突`,
      label: conflict.label,
      warnReason: conflict.reason,
      canOverride: true
    }
  }
  if (conflict.severity === 'hard') {
    return { severity: 'hard', note: reservedReason, label: conflict.label, warnReason: reservedReason, canOverride: false }
  }
  return { severity: 'warn', note: reservedReason, label: conflict.label, warnReason: reservedReason, canOverride: false }
}

function setNotice(message, level = 'ok') {
  notice.value = message
  noticeLevel.value = level
}

function startRecording(id) {
  // 先收掉上一轮：否则连点两行会重复挂监听，一次按键被处理两遍
  stopRecording()
  recordError.value = ''
  notice.value = ''
  pendingOverride.value = null
  recordingPreview.value = []
  appStore.shortcutRecordingId = id
}

function stopRecording() {
  appStore.shortcutRecordingId = null
  recordingPreview.value = []
}

/** 从键盘事件里取当前按下的修饰键（顺序与 eventToBinding 保持一致） */
function modsFromEvent(e) {
  const mods = []
  if (e.ctrlKey || e.metaKey) mods.push('Mod')
  if (e.shiftKey) mods.push('Shift')
  if (e.altKey) mods.push('Alt')
  return mods
}

/**
 * 修饰键标签：借 `bindingParts` 的渲染逻辑（拼一个占位主键再去掉），
 * 不另写一份 Mod/Shift/Alt 的标签映射，避免展示与实际生效漂移。
 */
function modLabels(mods) {
  if (!mods.length) return []
  return bindingParts([...mods, 'Space'].join('-')).slice(0, -1)
}

function onRecordKeydown(e) {
  const id = appStore.shortcutRecordingId
  // 没在录制就完全不干预：这个监听是常驻的，绝不能吞掉全局快捷键
  if (!id) return
  // 录制期间吞掉所有按键：既不让浏览器/编辑器响应，也不让全局快捷键抢先执行
  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape') {
    stopRecording()
    return
  }
  // Backspace / Delete 表示"清空这个快捷键"，等价于禁用该命令
  if (e.key === 'Backspace' || e.key === 'Delete') {
    appStore.setHotkey(id, '')
    recordError.value = ''
    setNotice('已清除该命令的键位')
    stopRecording()
    return
  }

  const binding = eventToBinding(e)
  if (!binding) {
    // 只按到修饰键（或 IME 组字 / 长按）：还没构成组合键，只更新预览
    recordingPreview.value = modLabels(modsFromEvent(e))
    return
  }
  recordingPreview.value = bindingParts(binding)
  applySetResult(id, binding, appStore.setHotkey(id, binding))
}

/** 松键时回退预览：修饰键全放掉就清空，避免残留一个"假的"已捕获状态 */
function onRecordKeyup(e) {
  if (!appStore.shortcutRecordingId) return
  recordingPreview.value = modLabels(modsFromEvent(e))
}

/**
 * 统一处理 setHotkey 的三态回执（T03 契约：读 `status` / `canOverride`，
 * 不再读兼容字段 `reason`）。
 *
 * @param {string} id 命令 id
 * @param {string} binding 本次提交的绑定串
 * @param {object} result appStore.setHotkey 的回执
 * @returns {void}
 */
function applySetResult(id, binding, result) {
  if (result.ok) {
    recordError.value = ''
    pendingOverride.value = null
    const victims = (result.overridden || []).map(v => SHORTCUT_MAP[v]?.label || v)
    if (victims.length > 0) {
      setNotice(`已清空「${victims.join('、')}」的键位`)
    } else if (result.warnings && result.warnings.length > 0) {
      // warn 级已写入，只是提示（保留键 / 跨 scope 抢键），不阻断
      setNotice(result.warnings[0].reason || result.message || '', 'warn')
    }
    stopRecording()
    return
  }

  // 失败分支：block 级给「强行覆盖」入口，其余只把原因摆出来
  if (result.status === 'conflict' && result.canOverride && result.conflict) {
    pendingOverride.value = { id, binding, label: result.conflict.label }
    recordError.value = ''
    return
  }
  recordError.value = result.message || '设置失败，请重试'
  // 保留录制态，用户可以立刻换一个组合键重试
}

/**
 * 强行覆盖：以 `{ override: true }` 重新提交，把占用者的键位清空。
 * 无论入口是「录制期冲突提示」还是「已存在冲突的行」，走的都是这一条路径。
 *
 * @param {string} id 命令 id
 * @param {string} binding 要写入的绑定串
 * @returns {void}
 */
function forceOverride(id, binding) {
  const result = appStore.setHotkey(id, binding, { override: true })
  if (!result.ok) {
    pendingOverride.value = null
    recordError.value = result.message || `覆盖失败（${result.status}）`
    return
  }
  applySetResult(id, binding, result)
}

/** 顶部冲突提示条上的「强行覆盖」：提交录制时那次被拒的组合 */
function applyPendingOverride() {
  const pending = pendingOverride.value
  if (!pending) return
  forceOverride(pending.id, pending.binding)
}

/** 行内「强行覆盖」：提交该行当前已保存的键位 */
function forceOverrideRow(item) {
  forceOverride(item.id, currentBinding(item.id))
}

function resetShortcut(id) {
  appStore.resetHotkey(id)
  recordError.value = ''
  pendingOverride.value = null
  setNotice('已恢复默认键位')
}

function resetAllShortcuts() {
  appStore.resetAllHotkeys()
  recordError.value = ''
  pendingOverride.value = null
  setNotice('已全部恢复默认键位')
}

const filteredShortcutCategories = computed(() => {
  const q = shortcutSearch.value.trim().toLowerCase()

  return SHORTCUT_CATEGORIES.map(cat => ({
    id: cat.id,
    label: cat.label,
    icon: CATEGORY_ICONS[cat.icon] || Keyboard,
    items: SHORTCUTS.filter(s => s.category === cat.id && !s.hidden)
      // 「仅看已修改」：只留下用户改过的（与 defaultValue 不同即视为改过）
      .filter(s => !onlyModified.value || isCustomized(s))
      .filter(s => !q || (
        s.label.toLowerCase().includes(q) ||
        bindingPartsOf(s.id).join(' ').toLowerCase().includes(q)
      ))
  })).filter(cat => cat.items.length > 0)
})

/**
 * 录制兜底：点到页面其它地方就收工。
 *
 * 用捕获阶段挂在 document 上 —— 某些组件会在自己的 click 里 stopPropagation，
 * 冒泡阶段根本收不到。落点属于「当前录制行」时不处理（用户只是在这一行里点按钮）。
 */
function onDocumentClick(e) {
  if (!appStore.shortcutRecordingId) return
  const row = e.target?.closest?.('[data-shortcut-row]')
  if (row && row.getAttribute('data-shortcut-row') === appStore.shortcutRecordingId) return
  stopRecording()
}

onMounted(() => {
  // keydown / keyup 常驻但只在录制时吞键（handler 首行判断 recordingId），
  // 这样监听只有一份、onUnmounted 必定能成对摘掉
  document.addEventListener('keydown', onRecordKeydown, true)
  document.addEventListener('keyup', onRecordKeyup, true)
  document.addEventListener('click', onDocumentClick, true)
})

// 路由离开：先收录制再走，避免把 keydown 监听带过下一个视图
onBeforeRouteLeave(() => {
  stopRecording()
})

onUnmounted(() => {
  // 三个 document 级监听逐个成对移除 + 兜底收录制（切走页面 / 组件被 v-if 摘掉）
  document.removeEventListener('keydown', onRecordKeydown, true)
  document.removeEventListener('keyup', onRecordKeyup, true)
  document.removeEventListener('click', onDocumentClick, true)
  stopRecording()
})
</script>

<style scoped>
/* 搜索框 - 毛玻璃效果，聚焦时使用主色光环 */
.shortcut-search {
  border: 1px solid var(--color-border-light);
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
}
.shortcut-search:focus {
  background: var(--color-bg-tertiary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
  border-color: transparent;
}

/* 快捷键按键 - 毛玻璃表面效果，微妙层次感 */
.kbd-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  border: 1px solid var(--color-border-light);
}

/* 冲突态：描边与文字同时转 --state-error，让"这行有问题"一眼可见 */
.kbd-key.is-error {
  border-color: var(--state-error);
  color: var(--state-error);
}

/* 录制实时预览：虚线胶囊，区别于已保存的键位 */
.kbd-key--preview {
  border-style: dashed;
  background: transparent;
  color: var(--color-primary);
  border-color: var(--color-primary);
}

/* 行内说明小字（冲突 / 保留键原因） */
.shortcut-note {
  font-size: 11px;
  line-height: 1.5;
}

/* 强行覆盖：描边按钮，hover 只换底色，不新增色值 */
.override-btn {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 5px;
  border: 1px solid var(--state-error);
  background: transparent;
  color: var(--state-error);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.override-btn:hover {
  background: var(--color-surface-hover);
}

/* 快捷键：修改 / 恢复默认 的小图标按钮 */
.kbd-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
}
.kbd-edit:hover {
  background: var(--color-surface-hover);
  color: var(--color-primary);
}

/* 录制中：整行高亮 + 提示文字呼吸，避免用户不知道在等什么 */
.is-recording {
  background: var(--color-primary-surface);
}
.recording-hint {
  animation: record-pulse 1.4s ease-in-out infinite;
}
@keyframes record-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
</style>
