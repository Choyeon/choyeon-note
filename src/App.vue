<template>
  <div 
    class="app-container h-full w-full" 
    :data-theme="currentTheme"
    :data-glass="glassEffect ? 'true' : 'false'"
    :data-font-size="appStore.fontSize"
    :class="{ 'electron-mode': isElectron }"
    :style="{ '--editor-zoom': editorZoomScale }"
  >
    <div 
      class="window-frame h-full w-full flex flex-col overflow-hidden relative"
      :style="{
        background: appBgStyle,
        borderRadius: isElectron ? '0' : '12px',
        border: isElectron ? 'none' : '1px solid var(--color-border)'
      }"
    >
      <div 
        v-if="isElectron"
        class="titlebar-electron h-9 min-h-9 flex items-center justify-between px-3 z-50 select-none"
        :style="{ 
          background: 'var(--titlebar-bg)',
          backdropFilter: 'blur(var(--titlebar-blur)) saturate(var(--titlebar-saturate))',
          WebkitBackdropFilter: 'blur(var(--titlebar-blur)) saturate(var(--titlebar-saturate))',
          borderBottom: '1px solid var(--titlebar-border)'
        }"
      >
        <div class="flex items-center gap-2">
          <img
            src="/icon.png"
            alt=""
            class="titlebar-icon"
            draggable="false"
          />
          <span class="text-[12px] font-medium" :style="{ color: 'var(--color-text-secondary)' }">
            Choyeon Note
          </span>
        </div>
        <div class="flex items-center gap-1" style="-webkit-app-region: no-drag;">
          <button
            class="win-ctrl w-10 h-9 flex items-center justify-center cursor-pointer transition-colors"
            @click="minimizeWindow"
            title="最小化"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            class="win-ctrl w-10 h-9 flex items-center justify-center cursor-pointer transition-colors"
            @click="maximizeWindow"
            title="最大化"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect
                x="1.5" y="1.5" width="9" height="9"
                stroke="currentColor"
                stroke-width="1"
                fill="none"
              />
            </svg>
          </button>
          <button
            class="win-ctrl win-ctrl-close w-10 h-9 flex items-center justify-center cursor-pointer transition-colors"
            @click="closeWindow"
            title="关闭"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5"
                stroke="currentColor"
                stroke-width="1"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex overflow-hidden">
        <div 
          class="sidebar-wrapper h-full flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
          :class="{ 'sidebar-open': showSidebar && appStore.sidebar, 'sidebar-closed': !(showSidebar && appStore.sidebar) }"
        >
          <Sidebar @toggle-sidebar="appStore.toggleSidebar" />
        </div>
        
        <!-- 侧边栏收起后的占位栏。
             旧实现是 <main> 内部一个 absolute left-3 top-3 z-40 的浮动按钮，它压在
             编辑器 / 列表自己的顶部工具栏上面 —— 那就是「收起后和右边 main 内容遮挡」。
             现在改成 sidebar-wrapper 与 <main> 之间的**真实 flex 兄弟节点**：main 是
             flex-1 min-w-0，会自动让出这 44px，结构上不可能再遮挡任何 main 内容，
             比调 z-index / 位移都可靠（那两者只是把遮挡挪个位置）。 -->
        <div
          v-if="showSidebar && !appStore.sidebar"
          class="sidebar-rail w-11 shrink-0 h-full flex flex-col items-center pt-3 transition-all duration-200"
        >
          <button
            class="sidebar-rail-btn w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200"
            title="展开侧边栏"
            @click="appStore.toggleSidebar"
          >
            <PanelRight class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
        </div>

        <main class="flex-1 min-w-0 h-full flex flex-col overflow-hidden relative">
          <router-view v-slot="{ Component, route: viewRoute }">
            <div :key="viewRoute.fullPath" class="page-wrapper h-full flex flex-col">
              <component :is="Component" />
              <div 
                v-if="isLoading" 
                class="page-loading-overlay"
              >
                <div class="loading-spinner">
                  <div class="spinner-ring"></div>
                  <div class="spinner-ring spinner-ring-delay"></div>
                </div>
              </div>
            </div>
          </router-view>
        </main>
      </div>
    </div>
    <CommandPalette />
    <QuickSwitcher />
    <!-- 外部磁盘改写的冲突二选一（批次 4 · R-F6）。
         队列由 useExternalSync 维护，这里只把整队传进去：弹窗自己显示队首，
         解决一条后队列短一条、自动进下一条，App.vue 不持有索引。 -->
    <ConflictDialog :conflicts="conflicts" @resolve="onResolveConflict" />
    <!-- 快捷键速查表（T08）：只读 appStore.shortcutCheatsheetOpen，开关由
         app.shortcutCheatsheet（useAppActions 提供执行器，默认 Mod-/）驱动 -->
    <ShortcutCheatsheet />

    <!-- 全局通知：写盘失败 / 目录失效等必须让用户看见的错误 -->
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="toast in appStore.toasts"
          :key="toast.id"
          class="toast-item"
          :class="`toast-${toast.type}`"
        >
          <AlertTriangle v-if="toast.type === 'error'" class="w-4 h-4 flex-shrink-0" />
          <CheckCircle2 v-else-if="toast.type === 'success'" class="w-4 h-4 flex-shrink-0" />
          <Info v-else class="w-4 h-4 flex-shrink-0" />
          <span class="toast-text">{{ toast.message }}</span>
          <button class="toast-close" aria-label="关闭提示" @click="appStore.dismissToast(toast.id)">
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from './stores/app'
import { useNoteStore } from './stores/note'
import { useVaultStore } from './stores/vault'
import { PanelRight, AlertTriangle, CheckCircle2, Info, X } from 'lucide-vue-next'
import Sidebar from './components/Sidebar.vue'
import CommandPalette from './components/CommandPalette.vue'
import QuickSwitcher from './components/QuickSwitcher.vue'
import ConflictDialog from './components/ConflictDialog.vue'
import ShortcutCheatsheet from './components/ShortcutCheatsheet.vue'
// 外部磁盘变更的定向 reconcile（批次 4 · R-F5 / R-F6）。
// 替代了原先「任何文件一变就整库 loadNotesFromPath」的写法 —— 那条写法会把
// 用户正在编辑的那一屏冲掉。内核不 import 任何 store，这里负责把真实 store
// 拼成门面喂进去。
import { createNoteStoreFacade, useExternalSync } from './composables/useExternalSync'
import { EXT_PATTERN } from './constants/noteFile'
// LS_KEYS：localStorage key 的单一来源。笔记存储位置这个 key 之前在 App.vue /
// router/index.js / WelcomeView.vue 各抄了一遍字面量，三处必须永远相等却没有任何
// 东西保证 —— 改一处漏两处就是「路由守卫读不到库位置 → 进不去应用」。
import { LS_KEYS } from './constants/storage'
import { setCodeTheme as setHljsTheme } from './utils/markdown'
import { fetchBingWallpaper, todayStamp } from './utils/bingWallpaper'
// normalizeBinding：绑定串比较的唯一口径。注册表 default 与用户存的 hotkeys 可能
// 是两种写法（如 `Shift-Mod-d` vs `Mod-Shift-d`），两边都过一遍才能匹配上。
import { SHORTCUTS, eventToBinding, normalizeBinding } from './constants/shortcuts'
// app scope 执行器不再写在 App.vue 里：id 集合只有 useAppActions 一个来源，
// 「注册表有、执行器无」的死命令与「执行器有、注册表无」的野命令都无从漂移。
import {
  createAppActions,
  APP_ACTION_IDS,
  isAppActionNeedUnfocused
} from './composables/useAppActions'
// isElectron 是**模块加载时**求值一次的常量（electronAPI 由 preload 注入，加载后
// 不再变），给模板的 v-if 与样式分支用正合适；hasElectronAPI() 每次调用重新求值，
// 给「运行时再看一眼」的场景用 —— 启动检查就属于后者。
import { IS_ELECTRON as isElectron, hasElectronAPI } from './utils/env'
// 日志出口：模块名走 LOG_MODULES（唯一来源），按模块过滤才能写成 `mod === 'app'`
// 而不是 startsWith 兜补丁。渲染侧出去的 message / data 由 logger 统一脱敏 + 截 120，
// 这里不再自己加工一遍。
import { createLogger } from './utils/logger'
import { LOG_MODULES } from './constants/logging'

const appStore = useAppStore()
const noteStore = useNoteStore()
const vaultStore = useVaultStore()
const route = useRoute()
const router = useRouter()

/** 本文件的诊断出口（写盘失败 / 退出前 flush 失败 / dev 期快捷键审计） */
const log = createLogger(LOG_MODULES.app)
// 加载遮罩绑定笔记 store 的真实载入状态（读取笔记目录 / 载入笔记期间为 true），
// 不再用切换路由时闪 300ms 的假定时器。Pinia 会自动解包，这里不要写 .value。
const isLoading = computed(() => noteStore.isLoading)
let menuUnsubscribe = null
let notesWatchUnsubscribe = null
let flushUnsubscribe = null
let beforeUnloadHandler = null

const showSidebar = computed(() => route.meta?.showSidebar !== false)
const glassEffect = computed(() => appStore.glassEffect)

/**
 * 根容器的 data-theme。
 *
 * 必须读 **effectiveTheme** 而不是 theme：theme 的值域是 light / dark / system，
 * 而 CSS 里只有 `[data-theme='dark']` 与 `.electron-mode[data-theme='dark']`
 * 两套暗色变量，没有 `[data-theme='system']`。写 'system' 的结果就是主题模式选
 * 「系统」时，Electron 专属的暗色变量（标题栏 / ::selection 等）一个都不命中。
 * store 的 applyTheme 用的也是 effectiveTheme，这里必须同口径。
 */
const currentTheme = computed(() => appStore.effectiveTheme)

// 编辑器缩放：百分比 → 倍数，写到根变量上，编辑器三种模式与阅读视图都读它
const editorZoomScale = computed(() => (Number(appStore.editorZoom) || 100) / 100)

// Electron 与非 Electron 对 Bing 壁纸的处理完全相同，合并成一次判断，只有兜底不同。
const appBgStyle = computed(() => {
  if (appStore.bingWallpaper && appStore.bingWallpaperUrl) {
    return `url('${appStore.bingWallpaperUrl}') center/cover no-repeat`
  }
  // Electron：窗口自身（亚克力 / Vibrancy）负责底色，这里保持透明以透出系统材质。
  // 非 Electron：原先兜底是一张写死的 Unsplash 外链，离线 / 内网环境必然加载失败
  // 并打出网络错误，还把应用外观绑死在第三方服务上。改为纯本地 CSS 渐变兜底，
  // 不发起任何网络请求，颜色复用主题变量，明暗主题自动跟随。
  return isElectron
    ? 'transparent'
    : 'linear-gradient(145deg, var(--color-bg) 0%, var(--color-bg-secondary) 55%, var(--color-bg-tertiary) 100%)'
})

/**
 * 拉取 Bing 每日壁纸。
 * 同一天已有结果就直接用缓存，避免每次启动/每次开开关都打一次网络请求。
 * 失败时保留上一张图（setBingWallpaper 内部会这么处理），只记录错误。
 */
async function refreshBingWallpaper({ force = false } = {}) {
  if (!appStore.bingWallpaper) return
  if (!force && appStore.bingWallpaperUrl && appStore.bingWallpaperDate === todayStamp()) return

  const result = await fetchBingWallpaper()
  appStore.setBingWallpaper(result)
}

// ---------------------------------------------------------------------------
// 外部磁盘变更：定向 reconcile（R-F5 / R-F6）
// ---------------------------------------------------------------------------

/** 外部同步的诊断出口（与 App.vue 自身的 app 模块分开，便于按模块过滤） */
const syncLog = createLogger(LOG_MODULES.sync)

/**
 * 真实 store → reconcile 内核的门面。
 *
 * 两项注入都是 note.js 的模块内私有物，必须由这里显式喂进去：
 *   · isDirty —— 判定「有未保存修改」的笔记。缺了它，只有当前笔记受保护，
 *     切走但没落盘的那批会被覆盖；
 *   · readFile —— 内核只读盘，自己不碰 IPC。
 * reindex 不注入：store 已导出 reindexNote，门面会自己去调。
 */
const noteFacade = createNoteStoreFacade(noteStore, {
  readFile: (p) => window.electronAPI?.readFile?.(p),
  isDirty: (id) => noteStore.isNoteDirty(id)
})

/**
 * 接线对象。必须**解构**而不是整对象用：useExternalSync 返回的是普通对象，
 * `sync.conflicts` 在模板里是一个 Ref（Vue 不会替你脱这层），而解构出来的
 * `conflicts` 是顶层绑定，模板编译器会走 unref。
 *
 * apply / resolve 内部已经串行化，回调里 fire-and-forget 即可。
 */
const { conflicts, apply: applyExternalChanges, resolve: resolveConflict } = useExternalSync({
  noteStore: noteFacade,
  readFile: (p) => window.electronAPI?.readFile?.(p),
  log: syncLog,
  isNoteExtension: (p) => EXT_PATTERN.test(String(p || '')),
  onNotify: ({ type, message }) => appStore.pushToast({ type, message })
})

/**
 * 冲突弹窗的回执。
 *
 * @param {object} payload 弹窗 emit 的载荷
 * @param {string} payload.id 冲突 id（= 笔记 id）
 * @param {'disk'|'memory'} payload.choice 用户的选择
 * @returns {void}
 */
function onResolveConflict ({ id, choice } = {}) {
  if (!id) return
  // choice 不是 'disk' / 'memory' 时内核会保持冲突不变（不替用户做决定），
  // 这里只是把异步结果的异常收进日志，避免渲染进程冒出 Unhandled Rejection。
  resolveConflict(id, choice).catch((error) => {
    syncLog.error('冲突解决失败', error)
  })
}

/**
 * 自动同步：监听笔记目录。
 *
 * 收到的是**变更清单**（`changes`），不是「某处变了」的空信号 —— 只有列出的那几个
 * 路径会被处理，正在编辑的笔记一个字节都不动（R-F5）。
 * 本进程自己的写入由主进程的静默窗口过滤掉，不会造成回环。
 */
function stopNotesWatch() {
  if (notesWatchUnsubscribe) {
    notesWatchUnsubscribe()
    notesWatchUnsubscribe = null
  }
  if (window.electronAPI?.unwatchNotes) window.electronAPI.unwatchNotes()
}

async function syncNotesWatch() {
  if (!window.electronAPI?.watchNotes) return
  const path = noteStore.notesPath
  if (appStore.autoSync && path) {
    // 路径没变就只是重复调用，主进程内部会先停旧监听
    const ok = await window.electronAPI.watchNotes(path)
    if (!ok) return
    if (!notesWatchUnsubscribe) {
      notesWatchUnsubscribe = window.electronAPI.onNotesExternalChange((changes) => {
        // 定向同步：只动 changes 里列出的路径。内部串行化，这里不必 await。
        // catch 是为了让内核漏出的异常进日志，而不是变成渲染进程的
        // Unhandled Rejection（冒烟脚本会把它计成运行时错误）。
        applyExternalChanges(changes).catch((error) => {
          syncLog.error('外部变更同步失败', error)
        })
      })
    }
  } else {
    stopNotesWatch()
  }
}

function minimizeWindow() {
  if (window.electronAPI) {
    window.electronAPI.minimize()
  }
}

function maximizeWindow() {
  if (window.electronAPI) {
    window.electronAPI.maximize()
  }
}

/**
 * 关闭窗口前先把待写盘的笔记落盘。
 * 自动保存是 500ms 防抖，敲完字立刻点关闭会丢掉最后一段编辑。
 */
async function flushEverything() {
  await noteStore.flushAll()
  // 密码本只在 VaultView 卸载时落盘；若用户正在该页直接 Cmd+Q，卸载不会触发，
  // 这里补一次，避免最后一条编辑丢失。
  try {
    vaultStore.flush?.()
  } catch (error) {
    // error 走 data：logger 会把 Error 的 name/message/code + 栈顶三帧结构化出来，
    // 比 `String(error)` 只剩一句 'Error: xxx' 有用；用户侧另有 toast 提示。
    log.error('密码本保存失败', error)
  }
}

async function closeWindow() {
  if (!window.electronAPI) return
  try {
    await flushEverything()
  } catch (error) {
    log.error('关闭前保存失败', error)
  }
  window.electronAPI.close()
}

/**
 * 主进程 before-quit 会先发 flush 信号并等待回执（最多 3 秒）。
 * 没有这段，Cmd+Q / 点安装更新重启都会丢掉防抖窗口内的编辑。
 */
function setupFlushHandshake() {
  if (!window.electronAPI?.onAppFlush) return
  flushUnsubscribe = window.electronAPI.onAppFlush(async () => {
    try {
      await flushEverything()
    } catch (error) {
      log.error('退出前保存失败', error)
    }
    window.electronAPI?.notifyFlushComplete?.()
  })
}

/** 浏览器 / 非 Electron 环境：靠 beforeunload 兜底并提示未保存 */
function setupBeforeUnload() {
  beforeUnloadHandler = (event) => {
    if (!noteStore.hasPendingSaves()) return
    noteStore.flushAll()
    event.preventDefault()
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', beforeUnloadHandler)
}

function handleMenuAction(event) {
  switch (event) {
    case 'menu:new-note': {
      const note = noteStore.createNote('', '新笔记')
      router.push(`/editor/${note.id}`)
      break
    }
    case 'menu:open': {
      router.push('/notes')
      break
    }
    case 'menu:save': {
      if (noteStore.currentNote?.id) {
        noteStore.flushSave(noteStore.currentNote.id)
      }
      break
    }
    case 'menu:toggle-sidebar': {
      appStore.toggleSidebar()
      break
    }
    case 'menu:search': {
      appStore.openQuickSwitcher()
      break
    }
    case 'menu:command-palette': {
      appStore.openCommandPalette()
      break
    }
    case 'menu:toggle-theme': {
      appStore.toggleTheme()
      break
    }
  }
}

// app scope 命令执行器：id 集合的唯一来源是 useAppActions，
// App.vue 只负责「什么时候跑」，不再自带第二份动作表（否则死命令/野命令必然漂移）。
const appActions = createAppActions({ appStore, noteStore, router })

/**
 * dev 期「注册表 ↔ 执行器」漂移守卫。
 *
 * 为什么放在这里而不是 store 里：T03 落库时 editor 侧的 `EDITOR_COMMAND_IDS`
 * 还没导出，两个集合凑不齐，硬跑会把 37 条编辑器命令全判成 dead（假告警比不告警更糟）。
 * 现在 app 侧（APP_ACTION_IDS，22 条）与 editor 侧都齐了，由装配点跑一次最合适。
 *
 * 为什么用动态 import：
 * 1. `useEditor.js` 顶层 import 了整条 CodeMirror 依赖链，静态引入会把它拖进
 *    App.vue 所在的入口 chunk，主包体积明显变大；
 * 2. 守卫的调用点包在 `if (import.meta.env.DEV)` 里，生产构建下 DEV 被替换成 false，
 *    整个分支连本函数一起被摇掉，动态 import 的 chunk 也不进产物。
 *    因此这里**没有**再叠 `choyeon-debug-audit` 开关 —— 一旦条件变成
 *    `DEV || localStorage...`，Rollup 就无法静态判定，CodeMirror 会被重新拉回产物。
 * `APP_ACTION_IDS` 来自零 import 的纯模块（useAppActions 只额外引入零依赖、零副作用的
 * 日志模块，不引入任何运行时依赖），静态引入无副作用，因此留在顶层。
 */
async function runShortcutAuditOnce() {
  try {
    const [auditModule, editorModule] = await Promise.all([
      import('./utils/shortcutAudit.js'),
      import('./composables/useEditor.js')
    ])
    const result = auditModule.auditShortcuts({
      appActionIds: APP_ACTION_IDS,
      editorCommandIds: editorModule.EDITOR_COMMAND_IDS
    })
    if (result.ok) {
      // counts 进 data：既保留原来「dead=0 orphan=0 …」那串人读信息，又让它可以被过滤
      log.info('[shortcut-audit] 注册表 ↔ 执行器 校验通过', result.counts)
      return
    }
    // 多行人类报告（formatAuditReport）刻意**不**再拼进 msg：logger 会把 msg 截断到
    // 120 字符并把换行折叠成 \n，拼进去得到的只是一段半截文本，比没有更误导。
    // 改为把四类问题的**完整 id 数组**放进 data —— 报告本来就是这些字段的渲染结果，
    // 信息量不减，还额外获得「进环形缓冲 / 可按模块过滤」这两件事。
    const c = result.counts
    log.error(
      `[shortcut-audit] 注册表 ↔ 执行器 校验未通过：dead=${c.dead} orphan=${c.orphan} duplicateDefault=${c.duplicateDefault} invalidSyntax=${c.invalidSyntax}`,
      {
        dead: result.dead,
        orphan: result.orphan,
        duplicateDefault: result.duplicateDefault,
        invalidSyntax: result.invalidSyntax
      }
    )
  } catch (error) {
    log.error('[shortcut-audit] 守卫自身执行失败', error)
  }
}

/**
 * 全局快捷键：单一数据源来自 shortcuts 注册表（scope = 'app'）。
 * 用户在设置页改键后立即生效，无需改动这里任何代码。
 * 编辑器内部快捷键（scope = 'editor'）由 CodeMirror 的 keymap 处理。
 *
 * 事件顺序（务必保持）：本监听挂在 **捕获阶段**（onMounted 里第三个参数 true），
 * 且命中后 `preventDefault()` + `stopPropagation()`。
 * 原因：`view.readingMode` / `view.liveMode` 本轮从 editor scope 迁到了 app scope，
 * 编辑器聚焦时 CodeMirror 也在监听同一批按键（T04 的 hotkeyCompartment）。
 * 不 stopPropagation 的话，编辑器聚焦时按 Mod-Shift-e 会被 CM 的 keymap
 * 二次处理（甚至抢先处理），出现「切一次又切回来」的双触发。
 */
function onGlobalKeydown(e) {
  // 设置页正在录制快捷键：整段让路，交给录制逻辑处理
  if (appStore.shortcutRecordingId) return

  const target = e.target
  const inEditable =
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)

  // 未聚焦时的 Escape：关闭任意模态
  if (e.key === 'Escape' && !inEditable) {
    if (appStore.commandPaletteOpen) appStore.closeCommandPalette()
    if (appStore.quickSwitcherOpen) appStore.closeQuickSwitcher()
    return
  }

  const binding = eventToBinding(e)
  if (!binding) return

  // 按绑定串反查 app 作用域的命令（与设置页展示完全一致）。
  // 两侧都过 normalizeBinding：用户 localStorage 里可能存着 `Shift-Mod-d` 这类旧写法。
  const matched = SHORTCUTS.find(s =>
    s.scope === 'app' &&
    !s.hidden &&
    appActions[s.id] &&
    normalizeBinding(appStore.getBinding(s.id)) === normalizeBinding(binding)
  )
  if (!matched) return
  // 少数动作（新建笔记 / 侧边栏）在输入框内会误触发，沿用 useAppActions 的集合判定
  if (isAppActionNeedUnfocused(matched.id) && inEditable) return

  e.preventDefault()
  e.stopPropagation()
  appActions[matched.id]()
}

watch(() => appStore.codeTheme, (newTheme) => {
  setHljsTheme(newTheme)
})

watch(() => appStore.bingWallpaper, (enabled) => {
  if (enabled) {
    refreshBingWallpaper()
  }
})

// 自动同步开关 / 笔记目录变化时重建监听
watch([() => appStore.autoSync, () => noteStore.notesPath], () => {
  syncNotesWatch()
})

// ---------------------------------------------------------------------------
// 启动期自动检查更新（设置项「启动时自动检测新版本」）
// ---------------------------------------------------------------------------

/**
 * 启动检查的延迟。
 * 与设置页 onMounted 里那个 2s 定时器同刻：设置页在启动窗口内挂载过的话，
 * 它那次检查不晚于本定时器，App 侧即可安全让位（见 settingsVisited）。
 */
const STARTUP_UPDATE_CHECK_DELAY = 2000

/** 本次会话是否已经发起过自动检查（启动检查只允许一次，防重复请求） */
let startupUpdateChecked = false
let startupUpdateTimer = null
let updaterUnsubscribe = null

/**
 * 启动窗口内是否进过设置页。
 * 设置页挂载后会自己发一次 checkForUpdates，那一次已经覆盖了「启动检查」的语义，
 * App 侧再发一次就是同一次启动打两遍网络请求 —— 因此进过就让位。
 */
let settingsVisited = route.name === 'settings'
watch(() => route.name, (name) => {
  if (name === 'settings') settingsVisited = true
})

/**
 * 更新事件 → 用户可见。
 *
 * 为什么 App.vue 自己要听一遍：启动检查发生在设置页之外，那时没有组件在听
 * updater 事件，检查结果会静默丢弃 —— 「自动检测」就等于没检测。
 * 与设置页的监听互不冲突（preload 侧支持多订阅），两边各取所需：
 * 这里只推一条 toast，设置页照旧更新自己的进度 UI。
 */
function setupStartupUpdaterListener () {
  if (updaterUnsubscribe || !window.electronAPI?.onUpdaterEvent) return
  updaterUnsubscribe = window.electronAPI.onUpdaterEvent((event, data) => {
    switch (event) {
      case 'updater:update-available': {
        // 设置页自己有完整的「更新说明 + 按钮」UI，这里再弹一条就是同一件事说两遍；
        // 判断沿用 route.name 的顺序：进过设置页之后本条路径不再打扰。
        if (settingsVisited) break
        const version = data && data.version ? ` v${data.version}` : ''
        appStore.pushToast({ type: 'info', message: `发现新版本${version}，可在设置页更新` })
        break
      }
      case 'updater:update-downloaded': {
        if (settingsVisited) break
        appStore.pushToast({ type: 'success', message: '新版本已下载，可在设置页重启安装' })
        break
      }
      case 'updater:error': {
        // data 由主进程透传（结构化对象 { message, code, name }，旧版本可能是字符串），
        // 走 log 的 data 而不是拼进 msg：拼串既丢字段又会被 excerpt 截断。
        log.error('启动检查更新失败', { detail: data })
        // 用户视角：点了「自动检测」却永远安静 = 等于没检测。原始错误往往是一串
        // HTTP/ENOENT 技术文本，放进 toast 只会让人读不懂，所以只给结论。
        if (settingsVisited) break
        appStore.pushToast({ type: 'error', message: '检查更新失败' })
        break
      }
      default:
        break
    }
  })
}

/**
 * 启动时自动检测新版本（设置项文案如此，触发点因此必须在 App.vue 的 onMounted）。
 *
 * 照搬设置页的那段判断：`isElectron` + `appStore.autoCheckUpdates` 两道门。
 * 去重：本次会话只发一次；启动窗口内进过设置页则让位给设置页那一次。
 */
function scheduleStartupUpdateCheck () {
  if (!hasElectronAPI()) return
  if (!window.electronAPI?.checkForUpdates) return
  if (!appStore.autoCheckUpdates) return
  if (startupUpdateChecked || startupUpdateTimer) return

  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = null
    if (startupUpdateChecked || settingsVisited) return
    startupUpdateChecked = true
    window.electronAPI.checkForUpdates()
  }, STARTUP_UPDATE_CHECK_DELAY)
}

onMounted(() => {
  appStore.initTheme()
  detectPlatform()
  // html/body 的透明背景只能靠祖先类控制（style.css 里 .electron-mode 是挂在
  // .app-container 上的，选不中 html/body）
  document.documentElement.classList.toggle('electron-app', !!isElectron)
  setHljsTheme(appStore.codeTheme)
  
  refreshBingWallpaper()
  
  // key 来自 LS_KEYS（与 router 守卫、WelcomeView 同一个来源）：这里不写字面量，
  // 否则「改了 key 名但漏改这一处」= 启动时不加载用户的库。
  const savedLocation = localStorage.getItem(LS_KEYS.notesLocation)
  if (savedLocation && savedLocation !== 'sample' && window.electronAPI) {
    noteStore.loadNotesFromPath(savedLocation)
  }

  setupStartupUpdaterListener()
  scheduleStartupUpdateCheck()

  if (window.electronAPI?.onMenuAction) {
    menuUnsubscribe = window.electronAPI.onMenuAction(handleMenuAction)
  }

  setupFlushHandshake()
  setupBeforeUnload()

  window.addEventListener('keydown', onGlobalKeydown, true)

  // dev 期漂移守卫：不 await，不阻塞首屏；日志走 logger 的 app 模块，
  // dev 下默认级别是 info，通过/未通过两条都会出现在控制台（不再直接 console.*）。
  // 守卫放在调用点而不是函数内部，是为了让生产构建里 `if (false)` 连函数体一起摇掉。
  if (import.meta.env.DEV) runShortcutAuditOnce()
})

onUnmounted(() => {
  if (startupUpdateTimer) {
    clearTimeout(startupUpdateTimer)
    startupUpdateTimer = null
  }
  if (updaterUnsubscribe) {
    updaterUnsubscribe()
    updaterUnsubscribe = null
  }
  if (menuUnsubscribe) {
    menuUnsubscribe()
    menuUnsubscribe = null
  }
  if (flushUnsubscribe) {
    flushUnsubscribe()
    flushUnsubscribe = null
  }
  if (beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler)
    beforeUnloadHandler = null
  }
  stopNotesWatch()
  window.removeEventListener('keydown', onGlobalKeydown, true)
})

function detectPlatform() {
  const platform = navigator.platform.toLowerCase()
  const html = document.documentElement
  
  if (platform.includes('win')) {
    html.classList.add('platform-win32')
  } else if (platform.includes('mac')) {
    html.classList.add('platform-darwin')
  } else if (platform.includes('linux')) {
    html.classList.add('platform-linux')
  }
}
</script>

<style scoped>
.app-container {
  font-family: var(--font-body);
}

.sidebar-wrapper {
  width: 260px;
}

.sidebar-closed {
  width: 0;
  opacity: 0;
}

.sidebar-open {
  width: 260px;
  opacity: 1;
}

/* 收起后的占位栏：宽度由模板的 w-11 给，这里只管「它是 main 之外的独立一列」。
   底色保持透明 —— 它是布局分隔而不是一块面板，涂色会让收起态多出一条突兀的竖条。 */
.sidebar-rail {
  background: transparent;
}

/* 与 Sidebar.vue 里那个「收起侧边栏」按钮同一套视觉（w-9 h-9 rounded-lg +
   surface 底 + border），只有一个方向图标的差别。
   保留轻微 shadow 让它在内容上方有层次 —— 它是正常流里的元素，不靠 absolute 压内容。 */
.sidebar-rail-btn {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  /* 走项目已有的 shadow token：它在 style.css 里有明暗两套值，
     写死 rgba 会让暗色模式下的投影看不见。 */
  box-shadow: var(--shadow-sm);
}

.sidebar-rail-btn:hover {
  background: var(--color-surface-hover);
  box-shadow: var(--shadow-md);
}

.titlebar-icon {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  pointer-events: none;
  -webkit-app-region: no-drag;
  /* 防止非 Electron 环境下 404 出现 broken image 图标 */
}

.titlebar-electron {
  -webkit-app-region: drag;
  app-region: drag;
}

.win-ctrl {
  color: var(--color-text-secondary);
  border-radius: 6px;
}

.win-ctrl:hover {
  background: var(--color-bg-tertiary);
}

.win-ctrl-close:hover {
  background: #E53935;
  color: #ffffff;
}

.page-wrapper {
  position: relative;
}

.page-loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  opacity: 0.8;
  z-index: 100;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.loading-spinner {
  position: relative;
  width: 36px;
  height: 36px;
}

.spinner-ring {
  position: absolute;
  inset: 0;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner-ring-delay {
  animation-delay: 0.4s;
  border-top-color: var(--color-accent);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.toast-stack {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast-item {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 380px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.18));
}

.toast-error {
  border-color: #E53935;
}

.toast-success {
  border-color: #43A047;
}

.toast-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.toast-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
}

.toast-close:hover {
  background: var(--color-bg-tertiary);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.18s var(--ease-out-quart, ease),
    transform 0.18s var(--ease-out-quart, ease);
}

/* 多条 toast 堆叠时，其中一条消失后其余要平滑上移，否则会瞬间跳位 */
.toast-move {
  transition: transform 0.18s var(--ease-out-quart, ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
