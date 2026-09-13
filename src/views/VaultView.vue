<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- ================= 顶栏 ================= -->
    <div
      class="min-h-[52px] px-6 py-2.5 flex items-center gap-3 border-b acrylic-content shrink-0 flex-wrap"
      :style="{ borderColor: 'var(--color-border)' }"
    >
      <div class="flex items-center gap-2">
        <Archive class="w-5 h-5" :style="{ color: 'var(--color-primary)' }" />
        <span class="text-lg font-bold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">密码本</span>
        <span
          v-if="secretCount > 0"
          class="text-[10px] px-1.5 py-0.5 rounded-full"
          :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }"
          title="本地明文存储，仅掩码显示，请勿同步到不可信位置"
        >{{ secretCount }} 条敏感</span>
      </div>
      <div class="flex-1"></div>

      <div class="relative">
        <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
        <input
          ref="searchInputRef"
          v-model="vault.query"
          type="text"
          placeholder="搜索键名、备注、分组..."
          class="w-56 h-8 pl-9 pr-3 rounded-lg text-[12px] outline-none transition-all duration-200"
          :style="{
            background: 'var(--color-bg-secondary)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border-light)'
          }"
        />
      </div>

      <button
        class="h-8 px-3 rounded-lg flex items-center gap-1.5 cursor-pointer transition-all active:scale-95"
        :style="{ background: 'var(--color-primary)', color: '#fff' }"
        @click="openCreate"
      >
        <Plus class="w-4 h-4" />
        <span class="text-[12px] font-medium">新增</span>
      </button>

      <div class="flex items-center gap-1 px-1.5 py-1 rounded-lg" :style="{ background: 'var(--color-bg-secondary)' }">
        <button
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all active:scale-95"
          :style="{ color: showMasked ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
          :title="showMasked ? '全部隐藏（推荐）' : '全部显示（敏感内容将明文可见）'"
          @click="toggleRevealAll"
        >
          <Eye v-if="showMasked" class="w-4 h-4" />
          <EyeOff v-else class="w-4 h-4" />
        </button>
        <button
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all active:scale-95 hover:bg-[var(--color-surface-hover)]"
          title="导出 CSV"
          @click="exportCsv"
        >
          <Download class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <button
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all active:scale-95 hover:bg-[var(--color-surface-hover)]"
          title="导入 CSV"
          @click="triggerImport"
        >
          <Upload class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <input ref="fileInputRef" type="file" accept=".csv,text/csv" class="hidden" @change="importCsv" />
      </div>
    </div>

    <!-- ================= 筛选行 ================= -->
    <div class="px-6 py-2 flex items-center gap-1.5 flex-wrap shrink-0 acrylic-content">
      <button
        v-for="f in filterChips"
        :key="f.id"
        class="h-7 px-3 rounded-full text-[12px] font-medium cursor-pointer transition-all"
        :style="vault.activeGroup === f.id
          ? { background: 'var(--color-primary)', color: '#fff' }
          : { background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
        @click="vault.activeGroup = f.id"
      >
        {{ f.label }}
        <span class="ml-1 opacity-70">{{ f.count }}</span>
      </button>
      <template v-if="vault.groups.length">
        <div class="w-px h-4 mx-1" :style="{ background: 'var(--color-border)' }"></div>
        <button
          v-for="g in vault.groups"
          :key="g"
          class="h-7 px-3 rounded-full text-[12px] font-medium cursor-pointer transition-all"
          :style="vault.activeGroup === g
            ? { background: 'var(--color-primary)', color: '#fff' }
            : { background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
          @click="vault.activeGroup = g"
        ># {{ g }}</button>
      </template>
    </div>

    <!-- ================= 条目列表 ================= -->
    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar px-6 pb-8 acrylic-content">
      <div v-if="vault.isLoading" class="py-16 text-center text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">
        加载中...
      </div>

      <div
        v-else-if="vault.filteredEntries.length === 0"
        class="flex flex-col items-center justify-center py-20 gap-3"
        :style="{ color: 'var(--color-text-tertiary)' }"
      >
        <Archive class="w-14 h-14 opacity-30" />
        <p class="text-base">{{ vault.query ? '没有匹配的记录' : '还没有任何记录' }}</p>
        <p class="text-sm">保存服务器 IP、账号密码、Token 等常用信息，随时查找</p>
        <button
          class="mt-2 h-8 px-4 rounded-lg text-[12px] font-medium cursor-pointer"
          :style="{ background: 'var(--color-primary)', color: '#fff' }"
          @click="openCreate"
        >新增第一条记录</button>
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 pt-1">
        <div
          v-for="entry in vault.filteredEntries"
          :key="entry.id"
          class="vault-card rounded-xl p-3.5 flex flex-col gap-2 transition-all duration-200 group"
          :style="{ border: '1px solid var(--color-border-light)' }"
        >
          <!-- 卡片头：类型 + 键名 + 收藏 -->
          <div class="flex items-center gap-2">
            <span
              class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              :style="{ background: kindOf(entry.kind).accent + '1A' }"
              :title="kindOf(entry.kind).label"
            >
              <component :is="kindIcon(entry.kind)" class="w-4 h-4" :style="{ color: kindOf(entry.kind).accent }" />
            </span>
            <span
              class="text-[13px] font-semibold flex-1 truncate"
              :style="{ color: 'var(--color-text-primary)' }"
              :title="entry.key"
            >{{ entry.key || '（未命名）' }}</span>
            <button
              class="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
              :title="entry.favorite ? '取消收藏' : '收藏'"
              @click="vault.toggleFavorite(entry.id)"
            >
              <Star
                class="w-3.5 h-3.5"
                :style="{ color: entry.favorite ? '#f59e0b' : 'var(--color-text-tertiary)' }"
                :fill="entry.favorite ? '#f59e0b' : 'none'"
              />
            </button>
          </div>

          <!-- 值 -->
          <div class="flex items-center gap-1 min-w-0">
            <code
              class="flex-1 text-[13px] font-mono truncate px-2 py-1 rounded-md"
              :style="{
                background: 'var(--color-bg-tertiary)',
                color: entry.secret && !vault.isRevealed(entry.id) ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
                letterSpacing: entry.secret && !vault.isRevealed(entry.id) ? '0.05em' : 'normal'
              }"
              :title="vault.displayValue(entry)"
            >{{ vault.displayValue(entry) || '—' }}</code>
            <button
              v-if="entry.secret"
              class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] shrink-0"
              :title="vault.isRevealed(entry.id) ? '隐藏' : '显示'"
              @click="vault.toggleReveal(entry.id)"
            >
              <Eye v-if="!vault.isRevealed(entry.id)" class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
              <EyeOff v-else class="w-3.5 h-3.5" :style="{ color: 'var(--color-primary)' }" />
            </button>
            <button
              class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] shrink-0"
              title="复制值"
              @click="copyValue(entry)"
            >
              <Copy v-if="copiedId !== entry.id" class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
              <Check v-else class="w-3.5 h-3.5" :style="{ color: 'var(--state-success, #22c55e)' }" />
            </button>
          </div>

          <!-- 备注 -->
          <p
            v-if="entry.note"
            class="text-[12px] leading-snug line-clamp-2"
            :style="{ color: 'var(--color-text-tertiary)' }"
            :title="entry.note"
          >{{ entry.note }}</p>

          <!-- 标签 + 操作 -->
          <div class="flex items-center gap-1.5 flex-wrap">
            <span
              v-if="entry.group"
              class="text-[10px] px-1.5 py-0.5 rounded-full"
              :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
            ># {{ entry.group }}</span>
            <span
              v-for="t in entry.tags"
              :key="t"
              class="text-[10px] px-1.5 py-0.5 rounded-full"
              :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)' }"
            >{{ t }}</span>
            <div class="flex-1"></div>
            <button
              class="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--color-surface-hover)]"
              title="编辑"
              @click="openEdit(entry)"
            >
              <Pencil class="w-3 h-3" :style="{ color: 'var(--color-text-secondary)' }" />
            </button>
            <button
              class="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--color-surface-hover)]"
              title="删除"
              @click="removeEntry(entry)"
            >
              <Trash2 class="w-3 h-3" :style="{ color: 'var(--state-error)' }" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 新增 / 编辑弹窗 ================= -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="dialog.show"
          class="fixed inset-0 z-[1000] flex items-center justify-center"
          style="background: rgba(0,0,0,0.4);"
          @click.self="closeDialog"
        >
          <div
            class="w-[440px] max-w-[92vw] max-h-[86vh] overflow-y-auto cho-scrollbar rounded-2xl p-5 shadow-2xl"
            :style="{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }"
            @click.stop
          >
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">
                {{ dialog.id ? '编辑记录' : '新增记录' }}
              </h3>
              <button
                class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer hover:bg-[var(--color-surface-hover)]"
                @click="closeDialog"
              >
                <X class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
              </button>
            </div>

            <!-- 类型选择 -->
            <div class="mb-3">
              <label class="text-[11px] font-medium mb-1.5 block" :style="{ color: 'var(--color-text-tertiary)' }">类型</label>
              <div class="flex items-center gap-1.5 flex-wrap">
                <button
                  v-for="k in VAULT_KINDS"
                  :key="k.id"
                  class="h-7 px-2.5 rounded-full text-[12px] font-medium cursor-pointer transition-all flex items-center gap-1"
                  :style="dialog.kind === k.id
                    ? { background: k.accent + '22', color: k.accent, border: `1px solid ${k.accent}55` }
                    : { background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)', border: '1px solid transparent' }"
                  @click="applyKind(k.id)"
                >
                  <component :is="kindIcon(k.id)" class="w-3 h-3" />
                  {{ k.label }}
                </button>
              </div>
            </div>

            <!-- 键 / 值 -->
            <div class="flex flex-col gap-3 mb-3">
              <div>
                <label class="text-[11px] font-medium mb-1.5 block" :style="{ color: 'var(--color-text-tertiary)' }">键（名称）</label>
                <input
                  ref="keyInputRef"
                  v-model="dialog.key"
                  type="text"
                  :placeholder="kindOf(dialog.kind).template.key || '例如：生产服务器 IP'"
                  class="w-full h-9 px-3 rounded-lg text-[13px] outline-none"
                  :style="inputStyle"
                  @keydown.enter="focusValue"
                />
              </div>
              <div>
                <label class="text-[11px] font-medium mb-1.5 block" :style="{ color: 'var(--color-text-tertiary)' }">值</label>
                <div class="relative">
                  <input
                    ref="valueInputRef"
                    v-model="dialog.value"
                    :type="dialog.secret && !dialog.revealValue ? 'password' : 'text'"
                    placeholder="例如：200.200.200.200"
                    class="w-full h-9 pl-3 pr-9 rounded-lg text-[13px] font-mono outline-none"
                    :style="inputStyle"
                    @keydown.enter="saveDialog"
                  />
                  <button
                    v-if="dialog.secret"
                    class="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded flex items-center justify-center cursor-pointer hover:bg-[var(--color-surface-hover)]"
                    type="button"
                    @click="dialog.revealValue = !dialog.revealValue"
                  >
                    <Eye v-if="!dialog.revealValue" class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
                    <EyeOff v-else class="w-3.5 h-3.5" :style="{ color: 'var(--color-primary)' }" />
                  </button>
                </div>
              </div>
              <div>
                <label class="text-[11px] font-medium mb-1.5 block" :style="{ color: 'var(--color-text-tertiary)' }">备注</label>
                <textarea
                  v-model="dialog.note"
                  rows="2"
                  :placeholder="kindOf(dialog.kind).template.note || '用途、归属、过期时间等'"
                  class="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
                  :style="inputStyle"
                ></textarea>
              </div>
              <div class="flex gap-3">
                <div class="flex-1">
                  <label class="text-[11px] font-medium mb-1.5 block" :style="{ color: 'var(--color-text-tertiary)' }">分组</label>
                  <input
                    v-model="dialog.group"
                    type="text"
                    list="vault-group-suggestions"
                    placeholder="例如：公司 / 测试环境"
                    class="w-full h-9 px-3 rounded-lg text-[13px] outline-none"
                    :style="inputStyle"
                  />
                  <datalist id="vault-group-suggestions">
                    <option v-for="g in vault.groups" :key="g" :value="g" />
                  </datalist>
                </div>
                <div class="flex-1">
                  <label class="text-[11px] font-medium mb-1.5 block" :style="{ color: 'var(--color-text-tertiary)' }">标签（逗号分隔）</label>
                  <input
                    v-model="dialog.tagsRaw"
                    type="text"
                    placeholder="生产, 核心系统"
                    class="w-full h-9 px-3 rounded-lg text-[13px] outline-none"
                    :style="inputStyle"
                  />
                </div>
              </div>
            </div>

            <label class="flex items-center gap-2 mb-4 cursor-pointer select-none w-fit">
              <input v-model="dialog.secret" type="checkbox" class="w-4 h-4 accent-[var(--color-primary)]" />
              <span class="text-[12px]" :style="{ color: 'var(--color-text-secondary)' }">敏感值（列表中默认掩码显示）</span>
            </label>

            <div class="flex justify-end gap-2">
              <button
                class="h-9 px-4 rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[var(--color-surface-hover)]"
                :style="{ color: 'var(--color-text-secondary)' }"
                @click="closeDialog"
              >取消</button>
              <button
                class="h-9 px-4 rounded-lg text-[13px] font-medium cursor-pointer"
                :style="{ background: 'var(--color-primary)', color: '#fff' }"
                @click="saveDialog"
              >{{ dialog.id ? '保存' : '添加' }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import {
  Archive, Search, Plus, Eye, EyeOff, Download, Upload,
  Copy, Check, Star, Pencil, Trash2, X,
  KeyRound, Server, KeySquare, Database, Contact, StickyNote
} from 'lucide-vue-next'
import { useVaultStore, VAULT_KINDS, kindOf } from '@/stores/vault'
import { useWorkspaceStore } from '@/stores/workspace'

const vault = useVaultStore()
const workspaceStore = useWorkspaceStore()

const searchInputRef = ref(null)
const fileInputRef = ref(null)
const keyInputRef = ref(null)
const valueInputRef = ref(null)
const copiedId = ref(null)
let copiedTimer = null

const KIND_ICONS = {
  KeyRound,
  Server,
  KeySquare,
  Database,
  Contact,
  StickyNote
}

const kindIcon = (id) => KIND_ICONS[kindOf(id).icon] || StickyNote

const inputStyle = {
  background: 'var(--color-bg-tertiary)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-light)'
}

const dialog = reactive({
  show: false,
  id: null,
  kind: 'other',
  key: '',
  value: '',
  note: '',
  group: '',
  tagsRaw: '',
  secret: false,
  revealValue: false
})

const showMasked = computed(() => vault.revealed.size === 0)
const secretCount = computed(() => vault.secretCount)

const filterChips = computed(() => [
  { id: 'all', label: '全部', count: vault.entries.length },
  { id: '__favorite', label: '收藏', count: vault.favoriteCount }
])

// ---------------------------------------------------------------- 生命周期
onMounted(async () => {
  if (!workspaceStore.activeWorkspace) {
    await workspaceStore.hydrate()
  }
  await vault.hydrate(workspaceStore.activeWorkspace?.id || 'default')
  nextTick(() => searchInputRef.value?.focus?.())
})

onUnmounted(() => {
  // 关页前把未落盘的改动立即写盘
  vault.flush()
  if (copiedTimer) clearTimeout(copiedTimer)
})

// ---------------------------------------------------------------- 弹窗
function openCreate() {
  Object.assign(dialog, {
    show: true,
    id: null,
    kind: 'server',
    key: kindOf('server').template.key || '',
    value: '',
    note: kindOf('server').template.note || '',
    group: vault.activeGroup !== 'all' && vault.activeGroup !== '__favorite' ? vault.activeGroup : '',
    tagsRaw: '',
    secret: kindOf('server').secret,
    revealValue: false
  })
  nextTick(() => keyInputRef.value?.focus?.())
}

function openEdit(entry) {
  Object.assign(dialog, {
    show: true,
    id: entry.id,
    kind: entry.kind,
    key: entry.key,
    value: entry.value,
    note: entry.note,
    group: entry.group,
    tagsRaw: (entry.tags || []).join(', '),
    secret: entry.secret,
    revealValue: false
  })
  nextTick(() => keyInputRef.value?.focus?.())
}

function applyKind(kindId) {
  dialog.kind = kindId
  const k = kindOf(kindId)
  // 新建时应用模板；编辑时只切换敏感默认值，不覆盖已填内容
  if (!dialog.id && !dialog.key.trim()) dialog.key = k.template.key || ''
  if (!dialog.id && !dialog.note.trim()) dialog.note = k.template.note || ''
  dialog.secret = k.secret
}

function closeDialog() {
  dialog.show = false
  dialog.revealValue = false
}

function saveDialog() {
  const key = dialog.key.trim()
  const value = dialog.value
  if (!key && !value.trim()) return
  const payload = {
    kind: dialog.kind,
    key,
    value,
    note: dialog.note,
    group: dialog.group.trim(),
    tags: dialog.tagsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    secret: dialog.secret
  }
  if (dialog.id) {
    vault.updateEntry(dialog.id, payload)
  } else {
    vault.addEntry(payload)
  }
  closeDialog()
}

function removeEntry(entry) {
  if (!confirm(`确定删除「${entry.key || '未命名'}」？该操作不可恢复。`)) return
  vault.removeEntry(entry.id)
}

// ---------------------------------------------------------------- 卡片操作
async function copyValue(entry) {
  try {
    await navigator.clipboard.writeText(entry.value || '')
    copiedId.value = entry.id
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedId.value = null }, 1500)
  } catch { /* 剪贴板不可用时静默失败 */ }
}

function toggleRevealAll() {
  if (showMasked.value) vault.revealAll()
  else vault.hideAll()
}

// ---------------------------------------------------------------- 导入 / 导出
function exportCsv() {
  const secretCountExported = vault.entries.filter(e => e.secret).length
  const tip = secretCountExported > 0
    ? `\n注意：包含 ${secretCountExported} 条敏感记录，导出文件为明文，请妥善保管。`
    : ''
  if (!confirm(`导出全部 ${vault.entries.length} 条记录为 CSV？${tip}`)) return
  const csv = vault.exportEntries()
  // 加 BOM 保证 Excel 打开中文不乱码
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `choyeon-vault-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function triggerImport() {
  fileInputRef.value?.click()
}

async function importCsv(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const rows = vault.parseCsv(text)
    if (!rows.length) {
      alert('未解析到有效数据（第一行需为表头：键,值,备注,分组,类型,标签）')
      return
    }
    const added = vault.importEntries(rows)
    alert(`导入完成：新增 ${added} 条，跳过重复 ${rows.length - added} 条`)
  } catch {
    alert('文件读取失败，请确认是 UTF-8 编码的 CSV')
  }
}
</script>

<style scoped>
.vault-card {
  background: var(--color-surface);
}

.vault-card:hover {
  border-color: var(--color-border) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  transform: translateY(-1px);
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.hidden {
  display: none;
}
</style>
