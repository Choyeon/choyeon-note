<template>
  <!--
    T32 · 日志系统的用户入口（查看 / 导出 / 级别 / 清空）。

    为什么非有它不可：内核（utils/logger.js）、引导层（utils/logBootstrap.js）与
    主进程六个 log:* 通道（T09）早已就位，日志确实在往 main.log 里写。但用户在设置
    页里**既看不到也导不出**，等于这套系统对用户不存在 —— 排障时能拿到日志的人只有
    开发者。这里是把它交给用户的那一层。

    四条自我要求：
      1. **导出不阻塞 UI**：磁盘 IO 全在主进程，渲染侧只 await 一次 IPC，且发起前先
         让「导出中」上屏（paintFrame）；期间界面继续能点。
      2. **清空后视图同步**：清空成功后**不本地抹数据**，等主进程的 `log:cleared`
         事件回来才清 —— 否则会出现「文件明天早了但列表还留着」的鬼影。
      3. **一次最多 200 行**：log:read 由主进程硬顶 200 行；这里再按 50 行一页切，
         DOM 恒定 ≤50 个节点，翻页即 O(page)（策略说明见 PAGE_SIZE 注释）。
      4. **浏览器环境只降级不崩**：没有 electronAPI 时明确告知「日志功能仅桌面版
         可用」，操作按钮全部禁用，且四个 handler 仍然各自再做一次运行时校验。
  -->
  <div class="mb-8" data-testid="settings-logs">
    <div class="flex items-center gap-3 mb-4 px-1">
      <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
        <ScrollText class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
      </div>
      <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">诊断与日志</h2>
    </div>

    <div class="settings-card">
      <!-- ① 日志级别 -->
      <div class="settings-row">
        <div class="flex items-center gap-3">
          <Bug class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
          <div>
            <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">日志级别</div>
            <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">
              级别越低记录越详细；切换后立刻生效，无需重启
            </div>
          </div>
        </div>
        <select
          class="px-3 py-1.5 rounded-lg text-[13px] cursor-pointer border outline-none transition-all duration-200 focus:ring-2 focus:ring-[var(--color-primary-ring)] disabled:opacity-50"
          data-testid="log-level-select"
          :style="{
            background: 'var(--color-bg-tertiary)',
            color: 'var(--color-text-primary)',
            borderColor: 'var(--color-border)'
          }"
          :value="level"
          :disabled="!supported"
          :title="supported ? '切换日志级别' : '日志功能仅桌面版可用'"
          @change="onLevelChange"
        >
          <option v-for="item in levelOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </div>

      <!-- ② 三个动作 -->
      <div class="settings-row">
        <div class="flex items-center gap-3">
          <FileText class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
          <div>
            <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">运行日志</div>
            <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">
              查看最近记录，或导出成一个可分享的日志文件
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="log-view-button"
            :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
            :disabled="loading"
            :title="supported ? '读取最近 200 行日志' : '日志功能仅桌面版可用'"
            @click="onViewLog"
          >
            <RefreshCw v-if="loading" class="w-3.5 h-3.5 spin" />
            <FileText v-else class="w-3.5 h-3.5" />
            <span>{{ loading ? '读取中' : '查看日志' }}</span>
          </button>
          <button
            class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="log-export-button"
            :style="{ background: 'var(--color-primary)', color: 'white' }"
            :disabled="exporting || !supported"
            :title="supported ? '把全部日志（含轮转文件）导出成单个文件' : '日志功能仅桌面版可用'"
            @click="onExportLog"
          >
            <Loader2 v-if="exporting" class="w-3.5 h-3.5 spin" />
            <Download v-else class="w-3.5 h-3.5" />
            <span>{{ exporting ? '导出中…' : '导出日志' }}</span>
          </button>
          <button
            class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="log-clear-button"
            :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--state-warning)' }"
            :disabled="clearing || !supported"
            :title="supported ? '清空 main.log 与全部轮转文件' : '日志功能仅桌面版可用'"
            @click="onClearLog"
          >
            <Trash2 class="w-3.5 h-3.5" />
            <span>{{ clearing ? '清空中…' : '清空日志' }}</span>
          </button>
        </div>
      </div>

      <!-- ③ 反馈行：常驻（切换级别 / 导出 / 清空的结果都在这里看得见），
           用 data-state 让它既能被读屏念出来也能被测到 -->
      <div class="settings-row">
        <p
          class="settings-hint"
          data-testid="log-status"
          :data-state="status.kind"
          :style="{ color: statusColor }"
        >{{ statusText }}</p>
      </div>

      <!-- ④ 浏览器降级：必须明确说出来，而不是留三个点不动的按钮让人以为坏了 -->
      <div v-if="!supported" class="settings-row">
        <p
          class="settings-hint"
          data-testid="log-desktop-only-hint"
          data-state="unsupported"
          :style="{ color: 'var(--state-warning)' }"
        >日志功能仅桌面版可用（查看 / 导出 / 清空 / 级别切换都需要桌面版）</p>
      </div>

      <!-- ⑤ 查看区 -->
      <div v-if="viewerOpen" class="px-5 py-4 border-t" data-testid="log-viewer" :style="{ borderColor: 'var(--color-border-light)' }">
        <div class="flex items-center gap-2 mb-3 flex-wrap">
          <div
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-mono text-[12px] min-w-0"
            :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }"
            :title="pathTitle"
          >
            <FolderOpen class="w-3.5 h-3.5 shrink-0" />
            <span class="truncate" data-testid="log-file-path">{{ pathText }}</span>
          </div>
          <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }" data-testid="log-summary">{{ summaryText }}</span>

          <span class="flex-1"></span>

          <Filter class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
          <select
            class="px-2.5 py-1 rounded-lg text-[12px] cursor-pointer border outline-none"
            data-testid="log-filter-select"
            :style="{
              background: 'var(--color-bg-tertiary)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)'
            }"
            :value="levelFilter"
            @change="onFilterChange"
          >
            <option v-for="item in filterOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </div>

        <div
          class="rounded-lg overflow-hidden cho-scrollbar"
          :style="{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-light)' }"
        >
          <div v-if="loading" class="px-3 py-8 text-center text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">
            正在读取日志…
          </div>
          <div v-else-if="pagedLines.length === 0" class="px-3 py-8 text-center text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }" data-testid="log-empty">
            {{ lines.length === 0 ? '暂无日志记录' : '当前过滤条件下没有匹配的日志行' }}
          </div>
          <ol v-else class="m-0 p-0 list-none" data-testid="log-lines">
            <li
              v-for="(line, index) in pagedLines"
              :key="startIndex + index"
              class="px-3 py-1 font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap break-words border-b last:border-b-0"
              :style="{ borderColor: 'var(--color-border-light)', color: lineColor(line) }"
            >{{ line }}</li>
          </ol>
        </div>

        <!-- 分页：50 行一页。默认停在最后一页（最新的那批），出错前的上下文靠往前翻 -->
        <div v-if="pageCount > 1" class="flex items-center justify-center gap-2 mt-3">
          <button
            class="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-150 hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="log-page-prev"
            title="上一页（更早）"
            :disabled="page <= 1"
            @click="goPrevPage"
          >
            <ChevronLeft class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
          <span class="text-[12px] tabular-nums" :style="{ color: 'var(--color-text-secondary)' }" data-testid="log-page-label">
            {{ pageLabel }}
          </span>
          <button
            class="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-150 hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="log-page-next"
            title="下一页（更新）"
            :disabled="page >= pageCount"
            @click="goNextPage"
          >
            <ChevronRight class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Filter,
  FolderOpen,
  Loader2,
  RefreshCw,
  ScrollText,
  Trash2
} from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import { LOG_FIELD_SEP, LOG_LEVELS, LOG_MODULES, LS_LOG_LEVEL } from '@/constants/logging'
import {
  clearRingBuffer,
  createLogger,
  getAvailableLevels,
  getLogLevel,
  setLogLevel
} from '@/utils/logger'
import { hasElectronAPI } from '@/utils/env'

// 这里没有专门的「设置」模块名：日志中心的失败是应用外壳级诊断，归 app 才能被
// 「按模块过滤」正常捞出来；自建 'settings' 会让 LOG_MODULES 的名单漂移出去。
const log = createLogger(LOG_MODULES.app)

const appStore = useAppStore()

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 一次 log:read 取多少行。
 *
 * 主进程侧有 LOG_READ_HARD_LIMIT（硬顶 200），这里取同一个数：拿满允许的上限，
 * 又不指望靠传更大的值去绕过 —— 那一侧一旦放行，「一次 IPC 灌进整个文件」的老问题
 * 就复活了。
 */
const READ_LIMIT = 200

/**
 * 每页渲染多少行。
 *
 * 选型理由（三选一：分页 / 只显示尾部 / 虚拟滚动）：
 *   · **虚拟滚动**：需要固定行高 + 容器测量才能算偏移。本项目日志行是
 *     `whitespace-pre-wrap` 的可换行文本，行高并不固定，测得不准就会出现
 *     空白跳动；且 jsdom 下没有布局测量，这个方案测试端根本验不了 ——
 *     为了 200 行引入一套测不了的机制是过度设计。
 *   · **只显示尾部 N 行**：实现最省事，但它把「出错之前发生了什么」直接扔了，
 *     而排障要的恰恰是前文。用户为了看一眼上下文还得自己去翻文件。
 *   · **分页（本实现）**：一次 IPC 的上限已被主进程钉死为 200 行，内存里的行数是
 *     有界的；真正的成本在 DOM 节点数与 diff 范围。切片后任一时刻页面上只有
 *     ≤50 个 <li>，翻页是 O(page) 而不是 O(total)，同时用户仍能往前翻回上下文。
 *     默认停在**最后一页**（最新的那批），因为看日志的人九成是刚出完事。
 */
const PAGE_SIZE = 50

/** 级别下拉的文案。
 *
 * 中文在前、英文代号保留原样：读的是人，而搜索日志文件 / 贴给开发者时要靠代号
 * 精确匹配 —— 只写「调试」会让对着 `grep ERROR` 的人对不上号。
 */
const LEVEL_LABELS = Object.freeze({
  debug: '调试 · debug',
  info: '常规 · info',
  warn: '警告 · warn',
  error: '错误 · error',
  silent: '静默 · silent'
})

/** 行内级别 → 颜色。与「级别左对齐补 5 字符」的格式约定配套。 */
const LEVEL_COLOR = Object.freeze({
  DEBUG: 'var(--color-text-tertiary)',
  INFO: 'var(--color-text-secondary)',
  WARN: 'var(--state-warning)',
  ERROR: 'var(--state-error)'
})

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** desktop-only 能力快照。放在 ref 里而不是 computed：computed 读非响应式对象不会重算 */
const supported = ref(false)

const viewerOpen = ref(false)
const loading = ref(false)
const exporting = ref(false)
const clearing = ref(false)

/**
 * 载入的行。用 shallowRef 而不是 ref：这 200 个字符串只会被整批替换，不需要
 * 每个元素都变成响应式代理 —— 深代理在这里纯属白付 per-item 开销。
 */
const lines = shallowRef([])
/** 主进程报告的文件总行数（可能大于实际载入行数） */
const totalLines = ref(0)
/** 是否因为超过上限而被主进程截断 */
const truncated = ref(false)
/** main.log 的绝对路径；拿不到时为 null（渲染成「路径不可用」而不是字符串 null） */
const logPath = ref(null)

const level = ref(getLogLevel())
const levelFilter = ref('all')
const page = ref(1)

/** 反馈行：{ kind, text }。kind ∈ idle | ok | error | info */
const status = ref({ kind: 'idle', text: '尚未读取日志' })

/**
 * log:cleared 事件到来的次数。
 *
 * 用来判定「清空这条链路走到哪了」：主进程先广播再 ack，onClearLog 醒来时如果计数
 * 变了，说明事件已经把视图同步完了，此时不该再用 ack 的文案覆盖它（详见该函数）。
 */
const clearedToken = ref(0)

// ---------------------------------------------------------------------------
// 计算属性
// ---------------------------------------------------------------------------

/** 级别下拉选项：数据源是内核的 getAvailableLevels()，UI 不抄名单 */
const levelOptions = computed(() =>
  getAvailableLevels().map(value => ({ value, label: LEVEL_LABELS[value] || value }))
)

/** 过滤下拉：比 ALL 多一项「全部」，且不含 silent（它只作为闸门，永不出现在行里） */
const filterOptions = computed(() => [
  { value: 'all', label: '全部级别' },
  ...['debug', 'info', 'warn', 'error']
    .filter(value => value in LOG_LEVELS)
    .map(value => ({ value, label: `仅 ${value}` }))
])

/**
 * 从一行文本里取出级别词。
 *
 * 格式（design §4.4，主/渲染共用）：`<ISO8601>  <LEVEL5>  [<module>]  <message>  <k=v…>`
 * 分隔符是两个空格。刻意不做正则全局匹配 —— 消息正文里完全可能出现同样的形态，
 * 从结构位置取才不会误判。
 * @param {string} line 日志行
 * @returns {string} 大写级别词；解析不出时为 ''
 */
function levelOfLine (line) {
  if (typeof line !== 'string') return ''
  const parts = line.split(LOG_FIELD_SEP)
  if (parts.length < 2) return ''
  return parts[1].trim().toUpperCase()
}

/** 过滤后的行（O(200)，翻页时才依赖它） */
const filteredLines = computed(() => {
  const source = lines.value || []
  if (levelFilter.value === 'all') return source
  const want = String(levelFilter.value).toUpperCase()
  return source.filter(line => levelOfLine(line) === want)
})

/** 总页数 */
const pageCount = computed(() => Math.max(1, Math.ceil(filteredLines.value.length / PAGE_SIZE)))

/** 当前页切片起点（全局行号） */
const startIndex = computed(() => (page.value - 1) * PAGE_SIZE)

/** 当前页要渲染的行 */
const pagedLines = computed(() => filteredLines.value.slice(startIndex.value, startIndex.value + PAGE_SIZE))

const pageLabel = computed(() => {
  const total = filteredLines.value.length
  if (total === 0) return '0 / 0'
  const from = startIndex.value + 1
  const to = Math.min(startIndex.value + PAGE_SIZE, total)
  return `${from}–${to} / 共 ${total} 行（第 ${page.value}/${pageCount.value} 页）`
})

const summaryText = computed(() => {
  const loaded = (lines.value || []).length
  if (loaded === 0) return '文件为空或读取失败'
  const parts = [`已载入 ${loaded} 行`]
  if (typeof totalLines.value === 'number' && totalLines.value > loaded) {
    parts.push(`文件共 ${totalLines.value} 行`)
  }
  if (truncated.value) parts.push('仅显示最近 200 行')
  return parts.join(' · ')
})

const pathText = computed(() => (typeof logPath.value === 'string' && logPath.value ? logPath.value : '路径不可用'))
const pathTitle = computed(() => pathText.value)

const statusText = computed(() => status.value.text || '')
const statusColor = computed(() => {
  switch (status.value.kind) {
    case 'error': return 'var(--state-error)'
    case 'ok': return 'var(--color-text-secondary)'
    case 'info': return 'var(--color-text-tertiary)'
    default: return 'var(--color-text-tertiary)'
  }
})

/** 单行颜色：按级别上色，长列表里能一眼扫出 ERROR */
function lineColor (line) {
  return LEVEL_COLOR[levelOfLine(line)] || 'var(--color-text-primary)'
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function toast (type, message) {
  appStore.pushToast({ type, message })
}

function setStatus (kind, text) {
  status.value = { kind, text }
}

/**
 * 让浏览器有机会把「导出中 / 读取中」画出去再继续。
 *
 * 只用 nextTick 不够：nextTick 只 flush Vue 的渲染队列（同步 until after microtask），
 * 不保证已经走到绘制。这里显式让出一个宏任务，按钮上的 spinner 才真的出现了 ——
 * 「点了没反应」和「点了在转」的差别，对大文件导出来说就是有没有卡死的观感差别。
 * @returns {Promise<void>}
 */
function paintFrame () {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function readStoredLevel () {
  try {
    return localStorage.getItem(LS_LOG_LEVEL)
  } catch {
    return null
  }
}

function writeStoredLevel (value) {
  try {
    localStorage.setItem(LS_LOG_LEVEL, value)
  } catch {
    /* 隐私模式下 localStorage 不可写：级别本次会话仍生效，不再为了它中断流程 */
  }
}

function isKnownLevel (value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVELS, value)
}

/**
 * 取 main.log 的绝对路径。
 *
 * 拿不到（无 userData / IPC 故障）时返回 null，由展示层渲染成「路径不可用」——
 * 宁可这么说，也不要把字面量 'null' / 'undefined' 印到界面上骗人。
 * @returns {Promise<string|null>}
 */
async function readLogPath () {
  if (!hasElectronAPI() || typeof window.electronAPI.logPath !== 'function') return null
  try {
    const value = await window.electronAPI.logPath()
    return typeof value === 'string' && value ? value : null
  } catch (error) {
    log.warn('读取日志文件路径失败', { error: (error && error.message) || 'unknown' })
    return null
  }
}

/**
 * 运行时再看一眼能力。
 *
 * 每个 handler 进去都重查一遍而不是只信 mounted 时的快照：API 的存在与否在这两个
 * 时刻之间可能变化（上下文失效 / 测试里临时摘掉），而 UI 的 disabled 只是一个提示，
 * 不该成为唯一防线 —— handler 自己也得是 null-safe 的。
 * @returns {boolean} 当前是否具备桌面端能力
 */
function ensureSupported () {
  const ok = hasElectronAPI() && typeof window.electronAPI.logRead === 'function'
  supported.value = ok
  return ok
}

// ---------------------------------------------------------------------------
// ① 查看日志
// ---------------------------------------------------------------------------

/**
 * 读取最近 200 行。
 *
 * 成功后默认跳到**最后一页**：日志是从旧到新排的，出事的人要看的是最后那几行。
 * 读完之后不做任何与行数成正比的同步处理 —— 200 行直接进 shallowRef，
 * 剩下的切片 / 上色都交给 computed 按页算。
 * @returns {Promise<void>}
 */
async function onViewLog () {
  if (!ensureSupported()) {
    toast('error', '日志功能仅桌面版可用')
    return
  }
  if (loading.value) return

  viewerOpen.value = true
  loading.value = true
  setStatus('info', '正在读取日志…')
  await paintFrame()

  try {
    const result = await window.electronAPI.logRead(READ_LIMIT)
    if (!result || result.ok === false) {
      const reason = (result && result.error) || '未知原因'
      lines.value = []
      totalLines.value = 0
      truncated.value = false
      page.value = 1
      setStatus('error', `读取日志失败：${reason}`)
      toast('error', `读取日志失败：${reason}`)
      log.error('读取运行日志失败', { error: reason })
      return
    }

    // 文件路径刻意走专用的 log:path 通道而不是顺手用 result.path：
    // 「文件在哪」的答案只有一个出处，用户在设置页看到的才能和他自己去资源管理器
    // 里找到的是同一个；顺手用 logRead 里的那份，一旦某条分支不同带 path，页面上
    // 就会出现「有内容却说不清路径」的怪状态。
    logPath.value = await readLogPath()
    totalLines.value = Number(result.total) || 0
    truncated.value = result.truncated === true
    lines.value = Array.isArray(result.lines) ? result.lines.slice() : []
    levelFilter.value = 'all'
    page.value = Math.max(1, Math.ceil(lines.value.length / PAGE_SIZE))

    const loaded = lines.value.length
    if (loaded === 0) {
      setStatus('ok', '日志文件为空')
    } else {
      setStatus('ok', truncated.value ? `已载入最近 ${loaded} 行（文件更长的部分已省略）` : `已载入 ${loaded} 行`)
    }
  } catch (error) {
    lines.value = []
    totalLines.value = 0
    page.value = 1
    const reason = (error && error.message) || String(error)
    setStatus('error', `读取日志失败：${reason}`)
    toast('error', `读取日志失败：${reason}`)
    // IPC 通道炸了必须留下证据：这条只有去看 devtools / 控制台的人才能捞到，
    // 而上面的 toast 是给用户的说法，两者都要。
    log.error('读取运行日志异常', { error: reason })
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// ② 导出日志
// ---------------------------------------------------------------------------

/**
 * 导出成单个可分享文件。
 *
 * **为什么不阻塞 UI**：
 *   1. 读日志、合并轮转文件、写目标路径，全在主进程完成 —— 渲染进程一次
 *      fs.readFileSync 都不做；
 *   2. 渲染侧只有一次 `await ipcRenderer.invoke`，它不占 JS 线程等待期间事件循环
 *      照常转（timer / 点击 / 渲染都能进来），配合事先让出的一帧把 spinner 画出去；
 *   3. 拿到结果后**不再做任何与数据量成正比的处理**（不拼串、不排序、不 JSON 化），
 *      只取 result.path 更新文案 —— 「IO 做完之后的同步尾巴」才是最常见的卡顿源。
 * @returns {Promise<void>}
 */
async function onExportLog () {
  if (!ensureSupported()) {
    toast('error', '日志功能仅桌面版可用')
    return
  }
  // 导出期间锁住按钮：系统保存对话框是模态的，重复点击只会堆第二次 IPC
  if (exporting.value) return

  exporting.value = true
  setStatus('info', '正在导出日志（在弹出的对话框里选择保存位置）…')
  await paintFrame()

  try {
    const result = await window.electronAPI.logExport()
    if (!result || result.ok === false) {
      const reason = (result && result.error) || '未知原因'
      // 用户主动取消不是失败：弹红色错误 toast 等于给人扣一分
      if (reason === 'canceled') {
        setStatus('info', '已取消导出')
        return
      }
      setStatus('error', `导出日志失败：${reason}`)
      toast('error', `导出日志失败：${reason}`)
      log.error('导出运行日志失败', { error: reason })
      return
    }
    const target = typeof result.path === 'string' ? result.path : ''
    setStatus('ok', target ? `已导出到 ${target}` : '已导出日志文件')
    toast('success', target ? `日志已导出到 ${target}` : '日志已导出')
  } catch (error) {
    const reason = (error && error.message) || String(error)
    setStatus('error', `导出日志失败：${reason}`)
    toast('error', `导出日志失败：${reason}`)
    log.error('导出运行日志异常', { error: reason })
  } finally {
    exporting.value = false
  }
}

// ---------------------------------------------------------------------------
// ③ 清空日志
// ---------------------------------------------------------------------------

/**
 * 清空 main.log 与全部轮转文件。
 *
 * 成功之后**刻意不本地抹 lines**：列表变空这件事必须由主进程的 `log:cleared`
 * 广播驱动（见 handleLogCleared）。这么做不是绕远路 —— 若在 ack 里就手清，
 * 一旦主进程实际没删干净（权限失败、文件被占用），
 * 用户看到的是「清掉了」而文件还在，比慢半拍更糟。
 * @returns {Promise<void>}
 */
async function onClearLog () {
  if (!ensureSupported()) {
    toast('error', '日志功能仅桌面版可用')
    return
  }
  if (clearing.value) return

  clearing.value = true
  setStatus('info', '正在清空日志…')
  await paintFrame()

  const tokenBefore = clearedToken.value
  try {
    const result = await window.electronAPI.logClear()
    if (!result || result.ok === false) {
      const reason = (result && result.error) || '未知原因'
      setStatus('error', `清空日志失败：${reason}`)
      toast('error', `清空日志失败：${reason}`)
      log.error('清空运行日志失败', { error: reason })
      return
    }
    // 主进程是「先广播 log:cleared、再 ack」。所以回来的时候，事件那一遍很可能已经
    // 跑过并写好了「视图已同步」。这时候绝不能再补一句 status 盖上去 —— 那会把结论
    // 从「已同步」打回「等待回执」，用户刚看到的结果被自己这句文案推翻。
    if (clearedToken.value === tokenBefore) {
      setStatus('info', '已提交清空请求，等待主进程回执刷新视图')
    }
    toast('success', '日志已清空')
  } catch (error) {
    const reason = (error && error.message) || String(error)
    setStatus('error', `清空日志失败：${reason}`)
    toast('error', `清空日志失败：${reason}`)
    log.error('清空运行日志异常', { error: reason })
  } finally {
    clearing.value = false
  }
}

/**
 * 主进程删完文件后的广播 → 同步视图。
 *
 * 连渲染侧的环形缓冲一起清：preload 的注释里明确要求了这件事，不清的话设置页
 * 「查看」还能翻出缓冲里的 500 条，用户会以为清空没生效。
 * @returns {void}
 */
function handleLogCleared () {
  try {
    clearRingBuffer()
  } catch {
    /* 内核出问题不影响视图收摊 */
  }
  clearedToken.value += 1
  lines.value = []
  totalLines.value = 0
  truncated.value = false
  page.value = 1
  setStatus('ok', '日志已清空，视图已同步')
}

// ---------------------------------------------------------------------------
// ④ 级别切换
// ---------------------------------------------------------------------------

/**
 * 切级别：渲染侧内核 + localStorage + 主进程闸门，三处一次性对齐。
 *
 * 只改一处是不够的（这也是 utils/logBootstrap.initLevel 的注释反复强调的点）：
 *   · 只改内核 → 重启回默认值；
 *   · 只改主进程 → 渲染侧照发、主侧照丢，表现为「设置页显示 debug，文件里一条都没有」。
 *
 * 主进程拒绝时**回滚**：log:set-level 对非法级别走「忽略」而不是回退默认值，
 * 渲染侧必须同样保持原样，否则两者会对同一份日志产生不一致的判断。
 * @returns {Promise<void>}
 */
async function onLevelChange (event) {
  const next = String((event && event.target && event.target.value) || '')
  if (!ensureSupported()) {
    level.value = getLogLevel()
    toast('error', '日志功能仅桌面版可用')
    return
  }
  if (!isKnownLevel(next)) {
    level.value = getLogLevel()
    toast('error', `不支持的日志级别：${next}`)
    return
  }

  const previous = getLogLevel()
  const applied = setLogLevel(next)
  // 内核对非法值返回当前值：此时既不该持久化也不该打扰主进程
  if (applied !== next) {
    level.value = applied
    toast('error', `不支持的日志级别：${next}`)
    return
  }
  level.value = applied

  try {
    const result = await window.electronAPI.logSetLevel(applied)
    if (!result || result.ok === false) {
      // 主进程没接受 → 内核回滚到它说的那个值，避免「界面显示 debug、实际按 info」。
      // 但**不写 localStorage**：本级被拒绝意味着这次根本没改成功，去持久化一个
      // 从来没生效过的值，等于下次启动带着错误认知跑。
      const backoff = (result && isKnownLevel(result.level) && result.level) || previous
      setLogLevel(backoff)
      level.value = backoff
      setStatus('error', `主进程未接受级别 ${applied}，已保持 ${backoff}`)
      toast('error', `日志级别切换未生效，已保持 ${backoff}`)
      log.warn('主进程拒绝日志级别，已回滚', { requested: applied, kept: backoff })
      return
    }
    // 只有主进程也接受了才落盘：存一个它不认的级别，等于每次启动都记一次 warn
    writeStoredLevel(applied)
    setStatus('ok', `日志级别已切换为 ${LEVEL_LABELS[applied] || applied}`)
    toast('success', `日志级别已切换为 ${LEVEL_LABELS[applied] || applied}`)
  } catch (error) {
    const reason = (error && error.message) || String(error)
    // IPC 炸了无法判断主侧是否生效：保守做法是保住内存 + 不落盘，说明状况
    level.value = applied
    setStatus('error', `同步主进程日志级别失败：${reason}`)
    toast('error', `同步主进程日志级别失败：${reason}`)
    log.error('同步主进程日志级别异常', { error: reason })
  }
}

// ---------------------------------------------------------------------------
// ⑤ 过滤 / 分页
// ---------------------------------------------------------------------------

function onFilterChange (event) {
  levelFilter.value = String((event && event.target && event.target.value) || 'all')
  page.value = 1
}

function goPrevPage () {
  if (page.value <= 1) return
  page.value -= 1
}

function goNextPage () {
  if (page.value >= pageCount.value) return
  page.value += 1
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/** 退订句柄。留着才能在卸载时摘掉，避免「设置页进出几次就叠几份监听」 */
let unsubscribeCleared = null

onMounted(() => {
  supported.value = ensureSupported()
  level.value = getLogLevel()
  // 启动时若 localStorage 里已有持久化级别，把它同步进本进程内核闸门：
  // logBootstrap 也做这件事，但它只在应用启动那一刻做；设置页是后开的，这里补一次
  // 能保证「打开页面时看到的级别」与「主进程实际用的级别」一致。
  const stored = readStoredLevel()
  if (isKnownLevel(stored) && stored !== getLogLevel()) setLogLevel(stored)

  if (supported.value && typeof window.electronAPI.onLogCleared === 'function') {
    try {
      unsubscribeCleared = window.electronAPI.onLogCleared(handleLogCleared)
    } catch {
      unsubscribeCleared = null
    }
  }
})

onBeforeUnmount(() => {
  if (typeof unsubscribeCleared === 'function') {
    try {
      unsubscribeCleared()
    } catch {
      /* 卸载路径上不允许再抛 */
    }
  }
  unsubscribeCleared = null
  // 刻意**不**在这里重置日志级别：级别是全局设置，用户在设置页把它调成 debug 后
  // 离开这一页，应用就该继续保持 debug。这里一恢复，等于「出了设置页就失效」。
})
</script>

<style scoped>
.spin {
  animation: settings-logs-spin 1s linear infinite;
}

@keyframes settings-logs-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}

.settings-hint {
  margin-top: 0;
  font-size: 12px;
  line-height: 1.5;
}
</style>
