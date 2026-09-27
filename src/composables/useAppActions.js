/**
 * App 作用域命令执行器（app scope 的唯一真身）
 *
 * ============ 为什么要有这个文件 ============
 * 1. 可测试：原来 APP_ACTIONS 是 App.vue `<script setup>` 里的一个普通对象，
 *    测试无法 import，`shortcutAudit` 的「注册表 ↔ 执行器覆盖校验」就无从下手。
 *    抽成独立模块后，测试可以零成本拿到 id 集合。
 * 2. 覆盖校验：`src/constants/shortcuts.js` 的注册表与这张表之间历史上**没有任何校验**，
 *    注册表里写了但这里没有的命令就是死命令（设置页能看能改键，按了没反应，
 *    典型受害者是 view.liveMode / view.readingMode）。现在 id 可被静态获取，
 *    `auditShortcuts({ appActionIds: APP_ACTION_IDS })` 才能跑起来。
 * 3. App.vue 瘦身：装配层只负责「什么时候跑」，「跑什么」收敛到这里。
 *
 * ============ 为什么 id 集合必须从对象派生 ============
 * APP_ACTION_IDS 由 `Object.keys(createAppActions({}))` 得出，不存在第二份手工清单。
 * 只要有人手工维护「另一份 id 数组」，两边就一定会在某次改动后漂移，
 * 而且漂移方向是静默的（清单里多一条 = 假绿，少一条 = 假红）。
 * 派生写法把「加命令」收敛成一个动作：往工厂返回的对象里加一个键即可。
 *
 * ============ 硬约束（勿破） ============
 * - **零 import**：本文件不 import vue / pinia / vue-router / CodeMirror / 任何 store。
 *   一旦 import，测试 import 本文件就会被拖进运行时依赖链（甚至副作用），
 *   T06 的 `tests/shortcuts.test.js` 会变脆甚至跑不起来。
 *   所有外部依赖一律通过 `ctx` 传入。
 *   唯一破例的是日志三件套（`constants/logging.js` → `utils/logSanitize.js` →
 *   `utils/logger.js`）：它们与 `utils/fileNaming.js` 同类 —— 零依赖、零副作用、
 *   不碰 window / DOM，import 它们不会把任何运行时依赖链拖进来，
 *   `createAppActions({})` 仍然能在纯 node 下安全跑出完整 key 集合。
 * - **构造期不得解引用 ctx**：`createAppActions({})` 必须能安全返回完整的 key 集合，
 *   这是 `APP_ACTION_IDS` 能被算出来的前提。所有 `ctx.xxx.yyy` 的访问
 *   都发生在闭包**被调用时**（也就是用户真的按下快捷键的时候）。
 */

/**
 * 编辑器正文字号缩放的步进值（百分比）。
 * 与 `SettingsView.vue` 里 `appStore.setEditorZoom(appStore.editorZoom ± 10)` 保持一致，
 * 否则「设置页点减号」和「按 Ctrl+-」会走出两套不同的刻度。
 * @type {number}
 */
import { createLogger } from '../utils/logger.js'
import { LOG_MODULES } from '../constants/logging.js'

/** 本模块的诊断出口（执行器兜底分支的告警）。模块名取 LOG_MODULES.actions */
const log = createLogger(LOG_MODULES.actions)

export const EDITOR_ZOOM_STEP = 10

/** 编辑器缩放默认值与合法区间（src/stores/app.js 的 setEditorZoom 内部会 clamp 到 50~200） */
const DEFAULT_EDITOR_ZOOM = 100

/**
 * 需要「焦点不在输入框内」才触发的命令。
 *
 * 从 App.vue 原样搬过来，**不要随意往里加 id**：
 * 尤其 `view.readingMode` / `view.liveMode` 绝不能进这个集合 ——
 * 它们本轮刚从 editor scope 迁到 app scope，目的就是「编辑器聚焦时也能用」，
 * 一旦进了这里，`inEditable === true` 会把它们拦掉，等于白改 scope。
 *
 * @type {Set<string>}
 */
export const APP_ACTIONS_NEED_UNFOCUSED = new Set([
  'app.newNote',
  'view.toggleSidebar'
])

/**
 * 判断某条 app 命令是否需要「焦点不在输入框」才执行。
 * @param {string} id 命令 id
 * @returns {boolean}
 */
export function isAppActionNeedUnfocused (id) {
  return APP_ACTIONS_NEED_UNFOCUSED.has(id)
}

/**
 * 调用目标对象上的方法；方法不存在时静默跳过（返回 false）。
 *
 * 存在的意义：本模块是零 import 纯模块，无法 import store 来静态核对 API 是否真实存在
 * —— `toggleReadingMode` / `toggleLiveMode` / `toggleShortcutCheatsheet` 都已在
 * src/stores/app.js 落地并导出，但本文件连 store 的类型定义都拿不到。
 * 探测式调用把「store 侧改名 / 漏导出 / 日后重构」退化成**单条命令静默跳过**，
 * 而不是整份执行表在 import 期就炸掉；返回 false 时由调用方决定是否走 fallback。
 *
 * @param {object|null|undefined} target 宿主对象（通常是 ctx.appStore / ctx.router）
 * @param {string} methodName 方法名
 * @param {...*} args 参数
 * @returns {boolean} 是否真的调用到了
 */
function invoke (target, methodName, ...args) {
  if (!target || typeof target[methodName] !== 'function') return false
  target[methodName](...args)
  return true
}

/**
 * fallback 用的「进入阅读模式前的可编辑模式」记忆。
 *
 * 这是**模块级**的（而不是每次 createAppActions 建一份），因为 App.vue 与
 * CommandPalette 会各调一次 createAppActions；如果各自持有一份，
 * 两个入口的记忆会不一致（这边记住 live，那边记住 edit，切回来结果不同）。
 *
 * 注意：这是 `toggleReadingModeFallback()` 的私有记忆，正常情况下**不会用到** ——
 * store 的 `toggleReadingMode()`（src/stores/app.js）已落地，`invoke()` 会优先命中它，
 * 而 store 自己用 `lastEditableMode` 记同一件事，语义以 store 为准。
 * 只有 store 侧方法缺失、被迫走 fallback 时本变量才起作用，属防御性保留。
 *
 * @type {{ mode: 'edit' | 'live' }}
 */
const editableModeMemory = { mode: 'edit' }

/**
 * 阅读模式切换的防御性兜底：正常路径下 `invoke()` 先命中 `appStore.toggleReadingMode()`，这里走不到。
 * 行为对齐 `appStore.toggleReadingMode()`（src/stores/app.js）：edit/live ↔ preview 往返。
 * （EditorView.vue 里那份本地 toggleReadingMode 已随模式切换上收到 app scope 而移除，不要再对齐它。）
 *
 * @param {object} appStore 应用 store（Pinia 实例，ref 已自动解包）
 * @returns {void}
 */
function toggleReadingModeFallback (appStore) {
  if (!appStore) return
  const current = appStore.editorMode
  if (current !== 'preview') {
    if (current === 'edit' || current === 'live') editableModeMemory.mode = current
    invoke(appStore, 'setEditorMode', 'preview')
    return
  }
  invoke(appStore, 'setEditorMode', editableModeMemory.mode || 'edit')
}

/**
 * 实时预览切换的防御性兜底：正常路径下 `invoke()` 先命中 `appStore.toggleLiveMode()`，这里走不到。
 *
 * 必须**双向**：`view.liveMode` 挂在 app scope 上、由全局快捷键直接调用，
 * 单向切到 live 会让这个键「只能进不能出」——再按一次毫无反应，用户只会认为快捷键坏了。
 * 判据读 `appStore.editorMode`（编辑器模式的唯一真源，值域 `edit | live | preview`）：
 * 已是 live 就回 edit，其余（含 preview）一律按「进 live」处理。
 *
 * 只传 `'edit'` / `'live'`：虽然 `setEditorMode` 会把 `'source'` 归一成 `'edit'`，
 * 但传 `'source'` 属于依赖内部兜底，语义上不该出现在这里。
 *
 * @param {object} appStore 应用 store（Pinia 实例，ref 已自动解包）
 * @returns {void}
 */
function toggleLiveModeFallback (appStore) {
  if (!appStore) return
  invoke(appStore, 'setEditorMode', appStore.editorMode === 'live' ? 'edit' : 'live')
}

/**
 * 快捷键速查表开关的防御性兜底：正常路径下 `invoke()` 先命中
 * `appStore.toggleShortcutCheatsheet()`（src/stores/app.js；同族还有
 * openShortcutCheatsheet / closeShortcutCheatsheet），这里走不到。
 * 只有它缺失时才退到这里直接切 `shortcutCheatsheetOpen` ref；ref 也没有就只告警返回 ——
 * 一条命令失效不该把整条 app 命令链炸掉（<ShortcutCheatsheet /> 已在 App.vue 挂载，
 * 这里纯粹是防御性分支）。
 *
 * @param {object} appStore 应用 store
 * @returns {void}
 */
function toggleCheatsheetFallback (appStore) {
  if (!appStore) return
  if (appStore.shortcutCheatsheetOpen === undefined) {
    // 原 `[useAppActions]` 前缀去掉：日志行本身已带 `[actions]` 模块名，
    // 前缀只会让过滤条件不得不写成 startsWith。命令 id 进 data，便于按 id 检索。
    log.warn('appStore 缺少 shortcutCheatsheetOpen / toggleShortcutCheatsheet()，app.shortcutCheatsheet 暂不可用', { id: 'app.shortcutCheatsheet' })
    return
  }
  appStore.shortcutCheatsheetOpen = !appStore.shortcutCheatsheetOpen
}

/**
 * 把编辑器正文缩放调整到某个相对当前值的档位。
 *
 * 注意 setEditorZoom 收的是**百分比**（src/stores/app.js 里 `Math.round(Number(value))`
 * 后 clamp 到 50~200），不是倍数 —— 这一点极易搞错，因为 App.vue 写 CSS 变量时
 * 用的是 `(Number(appStore.editorZoom) || 100) / 100` 的倍数形式。
 *
 * @param {object} appStore 应用 store
 * @param {number} delta 步进增量（正=放大，负=缩小）
 * @returns {void}
 */
function stepEditorZoom (appStore, delta) {
  if (!appStore) return
  const current = Number(appStore.editorZoom)
  const base = Number.isFinite(current) && current > 0 ? current : DEFAULT_EDITOR_ZOOM
  invoke(appStore, 'setEditorZoom', base + delta)
}

/**
 * 构造 App 作用域的命令执行表。
 *
 * 值一律是 `() => void`，与 App.vue 原来的 `APP_ACTIONS` 形态完全一致，
 * 调用方无需改动。所有依赖在闭包调用时才取，因此 `createAppActions({})`
 * 是合法的、只用于取 key 集合的用法。
 *
 * @param {object} [ctx={}] 依赖上下文
 * @param {object} [ctx.appStore] 应用 store（useAppStore() 的返回值）
 * @param {object} [ctx.noteStore] 笔记 store（useNoteStore() 的返回值）
 * @param {object} [ctx.router] vue-router 实例
 * @returns {Record<string, () => void>} 命令 id → 执行函数
 */
export function createAppActions (ctx = {}) {
  return {
    // ---------- 原有 11 条：从 App.vue 原样搬入，行为逐条等价 ----------
    'app.newNote': () => {
      const note = ctx.noteStore?.createNote('', '新笔记')
      if (note?.id) invoke(ctx.router, 'push', `/editor/${note.id}`)
    },
    'app.save': () => {
      const noteStore = ctx.noteStore
      if (noteStore?.currentNote?.id) invoke(noteStore, 'flushSave', noteStore.currentNote.id)
    },
    'app.quickSwitcher': () => invoke(ctx.appStore, 'openQuickSwitcher'),
    'app.commandPalette': () => invoke(ctx.appStore, 'toggleCommandPalette'),
    'app.vault': () => invoke(ctx.router, 'push', '/vault'),
    'app.settings': () => invoke(ctx.router, 'push', '/settings'),
    'view.toggleSidebar': () => invoke(ctx.appStore, 'toggleSidebar'),
    'view.graph': () => invoke(ctx.router, 'push', '/graph'),
    'view.calendar': () => invoke(ctx.router, 'push', '/calendar'),
    'view.search': () => invoke(ctx.router, 'push', '/search'),
    'view.toggleTheme': () => invoke(ctx.appStore, 'toggleTheme'),

    // ---------- 本轮新增 ----------
    'app.navigateBack': () => invoke(ctx.router, 'back'),
    'app.navigateForward': () => invoke(ctx.router, 'forward'),
    'app.shortcutCheatsheet': () => {
      if (invoke(ctx.appStore, 'toggleShortcutCheatsheet')) return
      toggleCheatsheetFallback(ctx.appStore)
    },
    'view.toggleRightPanel': () => invoke(ctx.appStore, 'toggleRightPanel'),

    // 这两条本轮从 editor scope 迁到 app scope，模式切换现在**只有一条链路**：
    // App.vue 在 window 的**捕获阶段**监听 keydown → `eventToBinding` 出绑定串 →
    // 在注册表里匹配 scope='app' 的命令 → 调本表的执行器 →
    // `appStore.toggleReadingMode()` / `appStore.toggleLiveMode()`（均已在 src/stores/app.js 落地）。
    // EditorView.vue 不再自己监听模式切换键（原先那套本地字符串比对兜底已删除），
    // 它只作为响应方 watch `appStore.editorMode` 收敛副作用，
    // 因此「顶部按钮 / 全局快捷键 / 命令面板」三个入口行为一致。
    // **不要**把它们的 id 加进 APP_ACTIONS_NEED_UNFOCUSED，否则编辑器内按不生效。
    'view.readingMode': () => {
      if (invoke(ctx.appStore, 'toggleReadingMode')) return
      toggleReadingModeFallback(ctx.appStore)
    },
    // 实时预览是**双向 toggle**（live ↔ edit），不能写成单向 setEditorMode('live')：
    // 本命令挂在 app scope 上、由全局快捷键直接调用，单向会让这个键只能进不能出，
    // 再按一次毫无反应，用户会以为快捷键坏了（与 view.readingMode 的往返语义保持一致）。
    // 优先走 store 的 toggleLiveMode()（src/stores/app.js，双向）；fallback 同样双向，
    // 但正常路径下 store 方法一定命中，那份 fallback 走不到。
    'view.liveMode': () => {
      if (invoke(ctx.appStore, 'toggleLiveMode')) return
      toggleLiveModeFallback(ctx.appStore)
    },

    'view.notes': () => invoke(ctx.router, 'push', '/notes'),
    'view.tags': () => invoke(ctx.router, 'push', '/tags'),

    // 缩放对象始终是**编辑器正文字号**（--editor-zoom），不是窗口缩放，
    // 与 Electron 菜单的 role: zoomIn/zoomOut/resetZoom 是两个互不干扰的通道。
    'view.zoomIn': () => stepEditorZoom(ctx.appStore, EDITOR_ZOOM_STEP),
    'view.zoomOut': () => stepEditorZoom(ctx.appStore, -EDITOR_ZOOM_STEP),
    'view.zoomReset': () => invoke(ctx.appStore, 'resetEditorZoom')
  }
}

/**
 * App 作用域命令的 id 全集，由工厂产出的对象派生。
 *
 * 唯一用途：喂给 `auditShortcuts({ appActionIds: APP_ACTION_IDS })` 做覆盖校验，
 * 以及 App.vue 在 dev 期检查自己拿到的 APP_ACTIONS 与本常量是否漂移。
 * **不要**手工编辑这个数组，改 `createAppActions` 的返回对象即可。
 *
 * @type {string[]}
 */
export const APP_ACTION_IDS = Object.keys(createAppActions({}))
