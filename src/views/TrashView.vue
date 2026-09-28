<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- ===================== 顶栏 ===================== -->
    <div
      class="min-h-[52px] px-6 py-2.5 flex items-center gap-2 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <Trash2 class="w-5 h-5" :style="{ color: 'var(--color-primary)' }" />
      <span class="text-2xl font-bold" :style="{ color: 'var(--color-text-primary)' }">最近删除</span>
      <span
        v-if="!loading && entries.length > 0"
        class="text-[12px] px-2 py-0.5 rounded-full"
        :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
        data-testid="trash-count"
      >{{ entries.length }} 条</span>
      <div class="flex-1"></div>

      <button
        class="px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 text-[13px] font-medium flex items-center gap-1"
        :style="{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }"
        data-testid="btn-refresh"
        :disabled="loading"
        @click="loadTrash"
      >
        <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />刷新
      </button>

      <button
        class="px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 text-[13px] font-medium flex items-center gap-1"
        :style="{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }"
        data-testid="btn-purge-expired"
        :disabled="loading || expiredCount === 0"
        @click="askPurgeExpired"
      >
        <History class="w-4 h-4" />清理过期
      </button>

      <button
        class="px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 text-[13px] font-medium text-white flex items-center gap-1"
        :style="{ background: 'var(--state-error)' }"
        data-testid="btn-purge-all"
        :disabled="loading || entries.length === 0"
        @click="askPurgeAll"
      >
        <Trash2 class="w-4 h-4" />清空回收站
      </button>
    </div>

    <!-- ===================== 系统回收站提示 ===================== -->
    <div
      v-if="systemTrashState.seen"
      class="px-6 py-2.5 flex items-start gap-2 border-b text-[12px] leading-5"
      :style="{ borderColor: 'var(--color-border-light)', background: 'var(--color-primary-surface)', color: 'var(--color-text-secondary)' }"
      data-testid="system-trash-banner"
    >
      <Info class="w-4 h-4 flex-shrink-0 mt-0.5" :style="{ color: 'var(--color-primary)' }" />
      <div class="flex-1">
        最近有 <b>{{ systemTrashState.count }}</b> 次删除走了<b>系统回收站</b>（<code>system-trash</code>）。
        这类条目不进库内 <code>.trash</code>，本列表管不到它们 —— 请到<b>系统回收站</b>里找回。
      </div>
      <button
        class="text-[12px] underline cursor-pointer flex-shrink-0"
        data-testid="btn-dismiss-system-trash"
        @click="dismissSystemTrashNotice"
      >知道了</button>
    </div>

    <div
      v-else
      class="px-6 py-2 text-[12px] border-b"
      :style="{ borderColor: 'var(--color-border-light)', color: 'var(--color-text-tertiary)' }"
      data-testid="system-trash-hint"
    >
      删除时若系统回收站可用，条目会直接进入<b>系统回收站</b>，不会出现在下面这个列表里 —— 那种情况请到系统回收站找回。
    </div>

    <!-- ===================== 错误态 ===================== -->
    <div
      v-if="errorMessage"
      class="px-6 py-3 flex items-start gap-2 border-b"
      :style="{ borderColor: 'var(--color-border-light)', background: 'var(--state-error-surface, transparent)' }"
      data-testid="trash-error"
    >
      <AlertTriangle class="w-4 h-4 flex-shrink-0 mt-0.5" :style="{ color: 'var(--state-error)' }" />
      <div class="flex-1 text-[13px]" :style="{ color: 'var(--state-error)' }">
        {{ errorMessage }}
      </div>
      <button
        class="px-2.5 py-1 rounded-lg text-[12px] cursor-pointer flex-shrink-0"
        :style="{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }"
        data-testid="btn-retry"
        @click="loadTrash"
      >重试</button>
    </div>

    <!-- ===================== 主体 ===================== -->
    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar acrylic-content p-6">
      <!-- 载入中 -->
      <div v-if="loading" class="flex items-center justify-center py-24" data-testid="trash-loading">
        <Loader2 class="w-6 h-6 animate-spin" :style="{ color: 'var(--color-primary)' }" />
        <span class="ml-2 text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">正在读取回收站…</span>
      </div>

      <!-- 空态 -->
      <div
        v-else-if="!errorMessage && entries.length === 0"
        class="flex flex-col items-center justify-center py-24"
        data-testid="trash-empty"
      >
        <div
          class="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
          :style="{ background: 'var(--color-primary-surface)' }"
        >
          <Trash2 class="w-7 h-7" :style="{ color: 'var(--color-primary)' }" />
        </div>
        <p class="text-[14px] font-medium mb-1" :style="{ color: 'var(--color-text-secondary)' }">回收站是空的</p>
        <p class="text-[12px] text-center max-w-[420px] leading-5" :style="{ color: 'var(--color-text-tertiary)' }">
          在应用内删除的笔记 / 文件夹会先落到库内 <code>.trash</code>，可以在这里还原。
          走系统回收站的删除不在此列。
        </p>
      </div>

      <!-- 列表 -->
      <div v-else class="acrylic-card overflow-hidden">
        <!-- 全选行 -->
        <div
          class="flex items-center gap-3 px-4 py-2.5 border-b"
          :style="{ borderColor: 'var(--color-border-light)' }"
        >
          <input
            type="checkbox"
            class="cursor-pointer"
            data-testid="checkbox-select-all"
            :checked="allSelected"
            @change="toggleSelectAll"
          />
          <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">
            已选 {{ selectedIds.length }} / {{ entries.length }}
          </span>
          <div class="flex-1"></div>
          <button
            class="px-2.5 py-1 rounded-lg text-[12px] cursor-pointer"
            :style="{
              color: selectedIds.length ? 'var(--state-error)' : 'var(--color-text-tertiary)',
              border: '1px solid var(--color-border)',
              opacity: selectedIds.length ? 1 : 0.5
            }"
            data-testid="btn-purge-selected"
            :disabled="selectedIds.length === 0"
            @click="askPurgeSelected"
          >彻底删除所选</button>
        </div>

        <!-- 条目行 -->
        <div
          v-for="(entry, idx) in entries"
          :key="entry.id"
          class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)]"
          :style="idx < entries.length - 1 ? { borderBottom: '1px solid var(--color-border-light)' } : {}"
          :data-testid="'trash-row-' + entry.id"
        >
          <input
            type="checkbox"
            class="cursor-pointer flex-shrink-0"
            :data-testid="'checkbox-' + entry.id"
            :checked="selectedIds.includes(entry.id)"
            @change="toggleSelect(entry.id)"
          />

          <component
            :is="entry.kind === 'dir' ? Folder : FileText"
            class="w-4 h-4 flex-shrink-0"
            :style="{ color: 'var(--color-text-tertiary)' }"
          />

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span
                class="text-[14px] font-medium truncate"
                :style="{ color: 'var(--color-text-primary)' }"
                data-testid="entry-name"
              >{{ entry.name }}</span>

              <span
                v-if="entry.degraded"
                class="text-[11px] px-1.5 py-0.5 rounded flex-shrink-0"
                :style="{ background: 'var(--state-warning-surface, rgba(234,179,8,0.14))', color: 'var(--state-warning, #B45309)' }"
                data-testid="badge-degraded"
                :title="entry.degradedReason || '元数据缺失'"
              >原位置未知，将还原到库根</span>

              <span
                v-if="entry.outsideRoot"
                class="text-[11px] px-1.5 py-0.5 rounded flex-shrink-0"
                :style="{ background: 'var(--state-error-surface, rgba(239,68,68,0.14))', color: 'var(--state-error)' }"
                data-testid="badge-outside-root"
              >不在笔记库内</span>

              <span
                v-if="entry.expired"
                class="text-[11px] px-1.5 py-0.5 rounded flex-shrink-0"
                :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
                data-testid="badge-expired"
                :title="'预计清理时间：' + formatDateTime(entry.purgeAt)"
              >即将被清理</span>
            </div>

            <div
              class="text-[12px] truncate mt-0.5"
              :style="{ color: 'var(--color-text-tertiary)' }"
              data-testid="origin-path"
              :title="entry.originPath"
            >{{ displayOrigin(entry) }}</div>
          </div>

          <span
            class="text-[12px] flex-shrink-0"
            :style="{ color: 'var(--color-text-tertiary)' }"
            :title="formatDateTime(entry.trashedAt)"
            data-testid="entry-time"
          >{{ formatDateTime(entry.trashedAt) }}</span>

          <span
            class="text-[12px] flex-shrink-0 w-[68px] text-right"
            :style="{ color: 'var(--color-text-tertiary)' }"
            data-testid="entry-size"
          >{{ formatSize(entry.size) }}</span>

          <button
            class="px-2.5 py-1 rounded-lg text-[12px] font-medium flex items-center gap-1 flex-shrink-0"
            :style="restoreDisabled(entry)
              ? { color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border)', opacity: 0.5, cursor: 'not-allowed' }
              : { color: 'var(--color-primary)', border: '1px solid var(--color-primary)' }"
            :data-testid="'btn-restore-' + entry.id"
            :disabled="restoreDisabled(entry)"
            :title="entry.outsideRoot ? '该条目不在当前笔记库内，已禁止还原' : '还原到原位置'"
            @click="restoreEntry(entry)"
          >
            <RotateCcw class="w-3.5 h-3.5" />{{ busyId === entry.id ? '还原中…' : '还原' }}
          </button>

          <button
            class="px-2.5 py-1 rounded-lg text-[12px] font-medium flex items-center gap-1 flex-shrink-0"
            :style="{ color: 'var(--state-error)', border: '1px solid var(--state-error)' }"
            :data-testid="'btn-purge-' + entry.id"
            @click="askPurge(entry)"
          >
            <Trash2 class="w-3.5 h-3.5" />彻底删除
          </button>
        </div>
      </div>

      <!-- 底部说明 -->
      <p
        v-if="entries.length > 0"
        class="mt-4 text-[12px]"
        :style="{ color: 'var(--color-text-tertiary)' }"
        data-testid="trash-footer"
      >
        条目保留 {{ retentionDays }} 天（{{ retentionDays }} 天后会被「清理过期」清掉）。
        <span v-if="trashDir">回收站目录：<code>{{ trashDir }}</code></span>
        <span v-if="!trashExists">（目录尚未创建）</span>
      </p>
    </div>

    <!-- ===================== 彻底删除二次确认 ===================== -->
    <Teleport to="body">
      <div
        v-if="purgeDialog"
        class="fixed inset-0 z-[200] flex items-center justify-center"
        :style="{ background: 'rgba(0,0,0,0.35)' }"
        data-testid="purge-dialog"
        @click.self="cancelPurge"
      >
        <div
          class="w-[460px] max-h-[80vh] rounded-[14px] p-5 flex flex-col"
          :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)' }"
          role="dialog"
          aria-modal="true"
          aria-label="彻底删除"
          @keydown.esc="cancelPurge"
        >
          <div class="flex items-center gap-2 mb-2">
            <AlertTriangle class="w-5 h-5" :style="{ color: 'var(--state-error)' }" />
            <h3 class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">
              {{ purgeDialog.title }}
            </h3>
          </div>
          <p class="text-[13px] leading-5 mb-3" :style="{ color: 'var(--color-text-secondary)' }">
            此操作<b>不可撤销</b>，条目会被从磁盘上永久删除。
          </p>

          <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar rounded-[8px] p-2 mb-3"
               :style="{ background: 'var(--color-bg-tertiary)' }">
            <div
              v-for="item in purgeDialog.items"
              :key="item.id"
              class="flex items-center gap-2 py-1 text-[12px]"
              data-testid="purge-dialog-item"
            >
              <component
                :is="item.kind === 'dir' ? Folder : FileText"
                class="w-3.5 h-3.5 flex-shrink-0"
                :style="{ color: 'var(--color-text-tertiary)' }"
              />
              <span class="font-medium flex-1 truncate" :style="{ color: 'var(--color-text-primary)' }">{{ item.name }}</span>
              <span :style="{ color: 'var(--color-text-tertiary)' }">{{ formatDateTime(item.trashedAt) }}</span>
              <span :style="{ color: 'var(--color-text-tertiary)' }">{{ formatSize(item.size) }}</span>
            </div>
          </div>

          <!-- 清空整个回收站的额外二次勾选 -->
          <label
            v-if="purgeDialog.mode === 'all'"
            class="flex items-start gap-2 mb-3 cursor-pointer"
            data-testid="purge-all-confirm"
          >
            <input
              type="checkbox"
              class="mt-0.5 cursor-pointer"
              data-testid="checkbox-purge-all"
              v-model="purgeAllConfirmed"
            />
            <span class="text-[12px] leading-5" :style="{ color: 'var(--color-text-secondary)' }">
              我确认要清空全部 <b>{{ entries.length }}</b> 条，且知道这不可撤销。
            </span>
          </label>

          <div class="flex justify-end gap-2">
            <button
              class="h-8 px-3 rounded-[8px] text-[13px] cursor-pointer"
              :style="{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }"
              data-testid="btn-purge-cancel"
              @click="cancelPurge"
            >取消</button>
            <button
              class="h-8 px-3 rounded-[8px] text-[13px] font-medium text-white cursor-pointer"
              :style="{
                background: 'var(--state-error)',
                opacity: canPurge ? 1 : 0.45,
                cursor: canPurge ? 'pointer' : 'not-allowed'
              }"
              data-testid="btn-purge-confirm"
              :disabled="!canPurge"
              @click="doPurge"
            >{{ purging ? '删除中…' : '彻底删除' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===================== 同名冲突 ===================== -->
    <Teleport to="body">
      <div
        v-if="conflict"
        class="fixed inset-0 z-[200] flex items-center justify-center"
        :style="{ background: 'rgba(0,0,0,0.35)' }"
        data-testid="conflict-dialog"
        @click.self="closeConflict"
      >
        <div
          class="w-[480px] rounded-[14px] p-5"
          :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)' }"
          role="dialog"
          aria-modal="true"
          aria-label="还原位置冲突"
          @keydown.esc="closeConflict"
        >
          <div class="flex items-center gap-2 mb-2">
            <ShieldAlert class="w-5 h-5" :style="{ color: 'var(--state-warning, #B45309)' }" />
            <h3 class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">原位置已存在同名文件</h3>
          </div>
          <p class="text-[13px] leading-5 mb-2" :style="{ color: 'var(--color-text-secondary)' }">
            是否另存为
            <code
              class="px-1 py-0.5 rounded break-all"
              :style="{ background: 'var(--color-bg-tertiary)' }"
              data-testid="conflict-suggested"
            >{{ conflict.suggestedPath }}</code>
            ？
          </p>
          <p class="text-[12px] mb-1" :style="{ color: 'var(--color-text-tertiary)' }">
            目标位置：{{ conflict.requestedPath }}
          </p>
          <p class="text-[12px] mb-4" :style="{ color: 'var(--state-error)' }">
            选择「覆盖」会用回收站里的版本替换原位置的文件，且不可撤销。
          </p>
          <div class="flex justify-end gap-2">
            <button
              class="h-8 px-3 rounded-[8px] text-[13px] cursor-pointer"
              :style="{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }"
              data-testid="btn-conflict-cancel"
              @click="closeConflict"
            >取消</button>
            <button
              class="h-8 px-3 rounded-[8px] text-[13px] cursor-pointer"
              :style="{ color: 'var(--state-error)', border: '1px solid var(--state-error)' }"
              data-testid="btn-conflict-overwrite"
              @click="confirmOverwrite"
            >覆盖</button>
            <button
              class="h-8 px-3 rounded-[8px] text-[13px] font-medium text-white cursor-pointer"
              :style="{ background: 'var(--color-primary)' }"
              data-testid="btn-conflict-rename"
              @click="confirmRename"
            >另存为</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script>
/**
 * T28 ·「最近删除」视图 —— 模块级（只随模块求值一次）的部分。
 *
 * 为什么要有这段普通 <script>：**系统回收站提示必须跨实例存活**。
 * 用户是在别处（侧边栏删笔记 / 删文件夹）触发删除的，那时 TrashView 还没挂载；
 * 等他过一会儿点开「最近删除」，得还能看见「刚才那次删除进了系统回收站」。
 * 挂在组件实例上的 ref 会随卸载归零，所以状态必须落在模块作用域。
 *
 * 通知通道刻意做成**窗口事件**而不是 import 依赖：删除动作发生在
 * Sidebar / noteStore 里，让它们反过来 import 一个视图会形成环，而
 * 「谁删的」这件事本来也不该只有视图关心。
 *
 * 【W3 改动】上面的内核（状态 + 常量 + reportTrashMethod）已抽到
 * `src/utils/trashState.js`（零依赖）。抽出去的理由是硬性的：
 * `/trash` 是懒加载路由，若 Sidebar.vue 为了一个 reportTrashMethod 就
 * `import ... from '@/views/TrashView.vue'`，本文件的 1000+ 行会被整块拖进首屏
 * 主 chunk。放在 util 里，Sidebar 只引入一个几百行的纯内核（且随主 chunk 分摊
 * 极小），TrashView 仍走懒加载。
 *
 * 因此本块现在只剩一件事：**从 util 引入并原样再导出**，保证既有
 * `import { ... } from '@/views/TrashView.vue'`（含 tests/trashView.test.js）
 * 一处不断。行为与原来逐字等价。
 */
import {
  TRASH_METHOD_SYSTEM,
  TRASH_METHOD_LIBRARY,
  TRASH_METHOD_EVENT,
  getSystemTrashState,
  resetSystemTrashState,
  isSelfDispatched,
  reportTrashMethod
} from '@/utils/trashState.js'

export {
  TRASH_METHOD_SYSTEM,
  TRASH_METHOD_LIBRARY,
  TRASH_METHOD_EVENT,
  getSystemTrashState,
  resetSystemTrashState,
  isSelfDispatched,
  reportTrashMethod
}
</script>

<script setup>
/**
 * T28 ·「最近删除」视图（src/views/TrashView.vue）
 *
 * 这一层要解决的就一句话：**用户误删了文件夹，得能在应用里自己找回来**，
 * 而不是去系统回收站里翻。
 *
 * 数据全部来自 T27 的三个 IPC（trashList / trashRestore / trashPurge）。
 * 三条容易踩空的口径，本文件逐条落实：
 *
 *  1. originPath 是**绝对路径**，直接显示又臭又长 → 对笔记库根做 relative，
 *     悬停（title）再给全路径。
 *  2. degraded === true 时 originPath 是**推测值**（sidecar 元数据丢了）
 *     → 必须打「原位置未知，将还原到库根」，不能让用户以为它真会回到那个位置。
 *  3. 还原成功后**必须自己刷一次索引**：主进程对还原目标做了 markSelfWrite，
 *     文件监听不会回灌这次变更，不主动刷的话侧边栏要等到下次全量载入才看得到。
 *
 * 安全性（对应 PRD 的「不可撤销操作」口径）：
 *   · 彻底删除一律二次确认，文案带 条目名 + 删除时间 + size；
 *   · 清空回收站额外加一道勾选，且**必须显式传 all:true**（主进程侧默认最保守）；
 *   · overwrite 只在用户明确点「覆盖」时才用，默认走 fail → rename。
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import {
  Trash2,
  RefreshCw,
  History,
  Info,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  RotateCcw,
  FileText,
  Folder
} from 'lucide-vue-next'
import { useNoteStore } from '@/stores/note'
import { useAppStore } from '@/stores/app'
import { LS_KEYS } from '@/constants/storage'
// 【W3】系统回收站提示的内核已搬到零依赖 util：src/utils/trashState.js。
// 常量 / reportTrashMethod / getSystemTrashState 等在上方普通 <script> 块里从
// 那里引入并再导出（同一个模块作用域，<script setup> 可直接用，不要再 import
// 本文件自己 —— 那会形成自引用环）。这里只额外取订阅函数，用来把内核状态同步
// 进本组件的响应式 ref。
import { subscribeTrashState } from '@/utils/trashState.js'

// ---------------------------------------------------------------------------
// 还原失败错误码 → 中文文案
// ---------------------------------------------------------------------------

/**
 * 主进程 trash:restore 的错误码文案表。
 * 直接把英文 code 显示给用户是上一代代码的毛病 —— 这里必须映射成中文。
 * message 是主进程给的兜底英文/系统文案，只在没有映射时补在后面。
 */
const RESTORE_ERROR_TEXT = Object.freeze({
  'invalid-id': '条目标识无效，无法还原',
  'not-found': '回收站里已经没有这个条目了，可能已被清理',
  'outside-root': '该条目不在当前笔记库内，已禁止还原',
  'target-exists': '原位置已存在同名文件',
  'restore-failed': '还原失败',
  'no-notes-path': '还没有设置笔记库位置，无法还原'
})

const PURGE_ERROR_TEXT = Object.freeze({
  'no-notes-path': '还没有设置笔记库位置，无法清理回收站',
  'invalid-ids': '要删除的条目标识无效',
  'purge-failed': '彻底删除失败'
})

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const noteStore = useNoteStore()
const appStore = useAppStore()

const entries = ref([])
const trashDir = ref('')
const trashExists = ref(true)
const retentionDays = ref(30)
const loading = ref(false)
const errorMessage = ref('')
const selectedIds = ref([])
const busyId = ref('')
const purging = ref(false)

/** 彻底删除确认弹窗：{ mode: 'one'|'selected'|'all'|'expired', title, items } */
const purgeDialog = ref(null)
const purgeAllConfirmed = ref(false)

/** 同名冲突弹窗：{ entry, requestedPath, suggestedPath } */
const conflict = ref(null)

/**
 * 「系统回收站」提示状态（跨实例存活）。
 *
 * 【W3 改动】真源现在在 `src/utils/trashState.js`（零依赖内核，Sidebar 也写它）。
 * 那边刻意不用 vue 的 ref（要能在 node 下单测），所以这里把它同步进一个真正的
 * vue ref 供模板渲染 —— 单向：内核改 → 通知 → 本 ref 更新。
 * 「知道了」按钮走 resetSystemTrashState()，同样经内核回流到本 ref。
 */
const systemTrashState = ref(getSystemTrashState().value)
const unsubscribeTrashState = subscribeTrashState((snap) => {
  systemTrashState.value = snap
})

/** 笔记库根：优先 store，回落到 localStorage（与路由守卫同一个 key） */
const notesRoot = computed(() => {
  const fromStore = noteStore?.notesPath || appStore?.notesLocation || ''
  if (fromStore) return String(fromStore)
  try {
    return localStorage.getItem(LS_KEYS.notesLocation) || ''
  } catch {
    return ''
  }
})

const allSelected = computed(
  () => entries.value.length > 0 && selectedIds.value.length === entries.value.length
)

const expiredCount = computed(
  () => entries.value.filter((entry) => entry && entry.expired === true).length
)

/** 「清空回收站」必须再勾一次；其它模式只要弹了窗就可删 */
const canPurge = computed(() => {
  if (!purgeDialog.value) return false
  if (purging.value) return false
  if (purgeDialog.value.mode === 'all') return purgeAllConfirmed.value === true
  return true
})

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/**
 * 时间格式化。
 * 不用 utils/format.js 的 formatDate 是因为它按本地时区，而回收站条目的
 * trashedAt 来自文件名时间戳（UTC 时间戳），两者一致；但这里还需要
 * 「未知时间」的兜底与秒级可读性，独立实现更可控。
 * @param {number|string|null|undefined} value 毫秒时间戳
 * @returns {string}
 */
function formatDateTime (value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '未知时间'
  try {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return '未知时间'
  }
}

/**
 * 体积格式化。
 * @param {number|null|undefined} bytes 字节数
 * @returns {string}
 */
function formatSize (bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 把路径统一成正斜杠、去掉末尾斜杠，用于前缀比较。
 * Windows 下主进程回的是反斜杠，笔记库根可能是正斜杠，两边不归一化就永远比不上。
 * @param {string} p 路径
 * @returns {string}
 */
function normalizeSeparators (p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * originPath → 相对笔记库根的路径。
 *
 * 绝对路径在 UI 里既长又没信息量（用户只关心「在库的哪个子目录」），所以默认
 * 显示相对路径；**完整绝对路径保留在 title 里悬停可见**，不丢信息。
 * 不在库内（或没有库根）时无法相对化，原样返回绝对路径。
 *
 * @param {object} entry 回收站条目
 * @returns {string} 相对路径（或无法相对化时的绝对路径）
 */
function relativeOrigin (entry) {
  const abs = entry?.originPath
  if (!abs) return ''
  const root = normalizeSeparators(notesRoot.value)
  if (!root) return String(abs)
  const target = normalizeSeparators(abs)
  // Windows 文件系统大小写不敏感，比较时必须都降下去，否则 D:\Notes 与
  // d:\notes 会被判成「不在库内」
  const lowerTarget = target.toLowerCase()
  const lowerRoot = root.toLowerCase()
  if (lowerTarget === lowerRoot) return '/'
  if (lowerTarget.startsWith(lowerRoot + '/')) return target.slice(root.length + 1)
  return String(abs)
}

/**
 * 行内展示的来源路径：相对路径优先，并给 degraded 条目补一句说明。
 * @param {object} entry 回收站条目
 * @returns {string}
 */
function displayOrigin (entry) {
  const rel = relativeOrigin(entry)
  if (!rel) return '原位置未知'
  if (entry?.degraded === true) return `${rel}（推测）`
  return rel
}

/**
 * 还原按钮是否置灰。
 * outsideRoot 的条目元数据被改坏，还原出去可能写到库外 —— 主进程也会拒，这里
 * 干脆不给他点。
 * @param {object} entry 回收站条目
 * @returns {boolean}
 */
function restoreDisabled (entry) {
  if (!entry) return true
  if (entry.outsideRoot === true) return true
  return busyId.value !== ''
}

/** 轻量 toast：store 不在时静默降级，绝不因为提示把操作打断 */
function toast (type, message) {
  if (appStore && typeof appStore.pushToast === 'function') {
    appStore.pushToast({ type, message })
  }
}

// ---------------------------------------------------------------------------
// 载入
// ---------------------------------------------------------------------------

/**
 * 读取回收站列表。
 *
 * IPC 失败 / 没有 electronAPI 时**绝不抛**：把错误落到 errorMessage，让页面
 * 走错误态 + 重试按钮，而不是整页白屏。
 * @returns {Promise<void>}
 */
async function loadTrash () {
  loading.value = true
  errorMessage.value = ''
  try {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api || typeof api.trashList !== 'function') {
      entries.value = []
      trashDir.value = ''
      retentionDays.value = 30
      errorMessage.value = '当前环境没有回收站通道（需要 Electron 主进程）'
      return
    }
    const res = await api.trashList()
    if (!res || res.ok === false) {
      entries.value = []
      errorMessage.value = (res && res.message) || (res && res.error) || '读取回收站失败'
      return
    }
    entries.value = Array.isArray(res.entries) ? res.entries : []
    trashDir.value = res.trashDir || ''
    trashExists.value = res.exists !== false
    if (Number.isFinite(Number(res.retentionDays))) retentionDays.value = Number(res.retentionDays)
    // 已经不存在的条目不能再被勾上：选中态要跟着列表一起收敛
    const alive = new Set(entries.value.map((e) => e.id))
    selectedIds.value = selectedIds.value.filter((id) => alive.has(id))
  } catch (error) {
    entries.value = []
    errorMessage.value = (error && error.message) || String(error)
  } finally {
    loading.value = false
  }
}

/**
 * 还原 / 删除成功后主动刷一次索引与侧边栏。
 *
 * 为什么必须手动刷：主进程在还原目标路径上打了 markSelfWrite，文件监听器的
 * 1.5s 自写过滤会把这次变更吃掉，不会回灌 onNotesExternalChange。不刷的话
 * 用户会看到「提示已还原，但侧边栏里还是没有」。
 * @returns {Promise<void>}
 */
async function refreshIndex () {
  const root = notesRoot.value
  if (!root) return
  try {
    if (noteStore && typeof noteStore.loadNotesFromPath === 'function') {
      await noteStore.loadNotesFromPath(root)
    }
  } catch (error) {
    // 索引刷新失败不该掩盖「还原已经成功」这个事实，只记不弹
    errorMessage.value = ''
  }
}

// ---------------------------------------------------------------------------
// 还原
// ---------------------------------------------------------------------------

/**
 * 一键还原。
 *
 * 默认策略是主进程的 'fail'（同名直接报错、绝不覆盖）→ 只有撞上
 * target-exists 才弹冲突框，让用户自己选「另存为（rename）」或「覆盖（overwrite）」。
 * overwrite 永远只可能来自用户显式点击。
 *
 * @param {object} entry 回收站条目
 * @returns {Promise<void>}
 */
async function restoreEntry (entry) {
  if (!entry || restoreDisabled(entry)) return
  busyId.value = entry.id
  errorMessage.value = ''
  try {
    const api = window.electronAPI
    if (!api || typeof api.trashRestore !== 'function') {
      errorMessage.value = '当前环境没有回收站通道（需要 Electron 主进程）'
      return
    }
    const res = await api.trashRestore({ id: entry.id })
    if (res && res.ok === true) {
      await refreshIndex()
      await loadTrash()
      const shown = relativeOrigin(entry) || entry.name
      toast('success', res.renamed ? `已还原为：${shown}` : `已还原到：${shown}`)
      return
    }
    const code = (res && res.error) || ''
    if (code === 'target-exists') {
      // 同名冲突：把主进程给的候选名摆给用户，等他点头再动
      conflict.value = {
        entry,
        requestedPath: res.requestedPath || entry.originPath || '',
        suggestedPath: res.suggestedPath || ''
      }
      return
    }
    const base = RESTORE_ERROR_TEXT[code] || '还原失败'
    errorMessage.value = res && res.message ? `${base}（${res.message}）` : base
    toast('error', errorMessage.value)
  } catch (error) {
    errorMessage.value = (error && error.message) || String(error)
    toast('error', errorMessage.value)
  } finally {
    busyId.value = ''
  }
}

/** 冲突框 → 另存为（strategy: 'rename'） */
async function confirmRename () {
  const current = conflict.value
  if (!current) return
  await restoreWithStrategy(current, 'rename')
}

/** 冲突框 → 覆盖（strategy: 'overwrite'，只在用户明确点「覆盖」时才可能出现） */
async function confirmOverwrite () {
  const current = conflict.value
  if (!current) return
  await restoreWithStrategy(current, 'overwrite')
}

/**
 * 带策略的还原（冲突框的两个出口共用）。
 * @param {{entry: object, requestedPath: string, suggestedPath: string}} current 冲突上下文
 * @param {'rename'|'overwrite'} strategy 策略
 * @returns {Promise<void>}
 */
async function restoreWithStrategy (current, strategy) {
  const entry = current.entry
  busyId.value = entry.id
  try {
    const res = await window.electronAPI.trashRestore({ id: entry.id, strategy })
    if (res && res.ok === true) {
      conflict.value = null
      await refreshIndex()
      await loadTrash()
      const shown = relativeOrigin(entry) || entry.name
      toast('success', res.renamed ? `已另存为：${shown}` : `已还原到：${shown}`)
      return
    }
    const code = (res && res.error) || ''
    const base = RESTORE_ERROR_TEXT[code] || '还原失败'
    errorMessage.value = res && res.message ? `${base}（${res.message}）` : base
    toast('error', errorMessage.value)
    conflict.value = null
  } catch (error) {
    errorMessage.value = (error && error.message) || String(error)
    conflict.value = null
  } finally {
    busyId.value = ''
  }
}

/** 关闭冲突框（不改变磁盘上的任何东西） */
function closeConflict () {
  conflict.value = null
}

// ---------------------------------------------------------------------------
// 彻底删除
// ---------------------------------------------------------------------------

/**
 * 打开彻底删除确认框。
 * one / selected 模式带具体条目（弹窗文案要有 条目名 + 删除时间 + size）；
 * all / expired 模式先去主进程 dryRun 拿清单，再摆给用户看。
 *
 * @param {object|null} entry 单条删除时传入
 * @param {'one'|'selected'|'all'|'expired'} mode 模式
 * @returns {Promise<void>}
 */
async function openPurgeDialog (entry, mode) {
  purgeAllConfirmed.value = false
  if (mode === 'one') {
    purgeDialog.value = { mode, title: '彻底删除这条？', items: [entry] }
    return
  }
  if (mode === 'selected') {
    const items = entries.value.filter((e) => selectedIds.value.includes(e.id))
    if (items.length === 0) return
    purgeDialog.value = { mode, title: `彻底删除选中的 ${items.length} 条？`, items }
    return
  }

  // all / expired：先 dryRun 拿真实清单，不让用户对着一个数字做决定
  const api = window.electronAPI
  if (!api || typeof api.trashPurge !== 'function') {
    errorMessage.value = '当前环境没有回收站通道（需要 Electron 主进程）'
    return
  }
  try {
    const payload = mode === 'all' ? { all: true, dryRun: true } : { dryRun: true }
    const res = await api.trashPurge(payload)
    const list = (res && (Array.isArray(res.targets) ? res.targets : res.expired)) || []
    if (mode === 'expired' && list.length === 0) {
      toast('info', '还没有过期的条目')
      return
    }
    if (mode === 'all' && list.length === 0) {
      toast('info', '回收站已经是空的')
      return
    }
    purgeDialog.value = {
      mode,
      title: mode === 'all' ? `清空回收站（${list.length} 条）？` : `清理 ${list.length} 条过期条目？`,
      items: list
    }
  } catch (error) {
    errorMessage.value = (error && error.message) || String(error)
  }
}

/** 单条彻底删除 */
function askPurge (entry) {
  openPurgeDialog(entry, 'one')
}

/** 勾选批量彻底删除 */
function askPurgeSelected () {
  openPurgeDialog(null, 'selected')
}

/** 清空整个回收站 */
function askPurgeAll () {
  openPurgeDialog(null, 'all')
}

/** 只清过期 */
function askPurgeExpired () {
  openPurgeDialog(null, 'expired')
}

/** 取消（不删） */
function cancelPurge () {
  purgeDialog.value = null
  purgeAllConfirmed.value = false
}

/**
 * 执行彻底删除。
 *
 * payload 的形状是安全性的一部分：
 *   · all 模式必须**显式** all:true（主进程侧默认最保守，什么都不传 = 只清过期）；
 *   · expired 模式什么都不传，让主进程按 retentionDays 自己裁；
 *   · 其余一律走 ids，绝不因为「UI 上没勾中」就退化成清全部。
 * @returns {Promise<void>}
 */
async function doPurge () {
  const dialog = purgeDialog.value
  if (!dialog || !canPurge.value) return
  purging.value = true
  try {
    const api = window.electronAPI
    if (!api || typeof api.trashPurge !== 'function') {
      errorMessage.value = '当前环境没有回收站通道（需要 Electron 主进程）'
      return
    }
    let payload = null
    if (dialog.mode === 'all') payload = { all: true }
    else if (dialog.mode === 'expired') payload = {}
    else payload = { ids: dialog.items.map((item) => item.id) }

    const res = await api.trashPurge(payload)
    if (res && res.ok === false) {
      const base = PURGE_ERROR_TEXT[(res && res.error) || ''] || '彻底删除失败'
      errorMessage.value = res && res.message ? `${base}（${res.message}）` : base
      toast('error', errorMessage.value)
      return
    }
    const done = Array.isArray(res?.purged) ? res.purged.length : dialog.items.length
    toast('success', `已彻底删除 ${done} 条`)
    purgeDialog.value = null
    purgeAllConfirmed.value = false
    selectedIds.value = []
    await refreshIndex()
    await loadTrash()
  } catch (error) {
    errorMessage.value = (error && error.message) || String(error)
  } finally {
    purging.value = false
  }
}

// ---------------------------------------------------------------------------
// 选择
// ---------------------------------------------------------------------------

/**
 * 勾选 / 取消勾选一条。
 * @param {string} id 条目 id
 * @returns {void}
 */
function toggleSelect (id) {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  } else {
    selectedIds.value = [...selectedIds.value, id]
  }
}

/** 全选 / 全不选 */
function toggleSelectAll () {
  selectedIds.value = allSelected.value ? [] : entries.value.map((entry) => entry.id)
}

// ---------------------------------------------------------------------------
// 系统回收站提示
// ---------------------------------------------------------------------------

/**
 * 收到「某次删除走了系统回收站」的通知。
 * @param {Event} event window 上的 CustomEvent
 * @returns {void}
 */
function onTrashMethodEvent (event) {
  // ① 自己派出去的（直接调 reportTrashMethod 的那一路）不再记一遍，否则计数翻倍
  if (isSelfDispatched(event)) return
  const method = event && event.detail ? event.detail.method : null
  // ② 事件来的这一路绝不能再派发，否则「事件 → 上报 → 派发 → 事件」无限递归
  reportTrashMethod(method, { notify: false })
}

/** 用户点「知道了」（走内核，好让跨实例状态一起归零） */
function dismissSystemTrashNotice () {
  resetSystemTrashState()
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener(TRASH_METHOD_EVENT, onTrashMethodEvent)
  }
  loadTrash()
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener(TRASH_METHOD_EVENT, onTrashMethodEvent)
  }
  if (typeof unsubscribeTrashState === 'function') unsubscribeTrashState()
})

// 给外部（命令面板 / 侧边栏 / 单测）复用：删除动作拿到 method 后直接调它上报
defineExpose({
  loadTrash,
  restoreEntry,
  refreshIndex,
  reportTrashMethod,
  TRASH_METHOD_SYSTEM
})
</script>
