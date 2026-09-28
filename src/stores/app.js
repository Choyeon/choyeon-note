import { defineStore } from 'pinia'
import { ref, shallowRef, computed } from 'vue'
import { isCommonEnglishWord, getSpellErrors as getSpellErrorsPure } from '@/utils/spellcheck'
import {
  createDefaultBindings,
  SHORTCUT_MAP,
  SHORTCUTS,
  normalizeBinding,
  describeReserved,
  RESERVED_BINDINGS
} from '@/constants/shortcuts'
import { NOTE_EXTENSIONS } from '@/constants/noteFile'
import { LS_KEYS, CONFIG_SCHEMA, SKIP, normalizeNoteExtension } from '@/constants/storage'
// IS_ELECTRON 同时以两个名字引入：`isElectron` 是文件内历史用法（拼写存盘判断等），
// `IS_ELECTRON` 用于快捷键保留键分级的默认入参（与 @/constants/shortcuts 里的语义同名，便于对照阅读）。
import { IS_ELECTRON as isElectron, IS_ELECTRON } from '@/utils/env'
import { createLogger } from '../utils/logger.js'
import { LOG_MODULES } from '../constants/logging.js'

/**
 * 全局设置的模块 logger。
 *
 * 只用于**诊断**（配置读不回来、schema 与 ref 对不上这类开发者可见的问题）；
 * 面向用户的提示一律走 pushToast，不要把 toast 文案降级成日志，也不要反过来。
 */
const appLog = createLogger(LOG_MODULES.app)

// 渲染侧扩展名白名单的唯一来源是 @/constants/noteFile。这里 re-export 是为了
// 保住 appStore.NOTE_EXTENSIONS 这个既有对外接口（SettingsView 在用）。
export { NOTE_EXTENSIONS }

/**
 * 保留键冲突的占位 id。
 *
 * 保留键不是某条命令，但 `findConflict` 与 UI 需要一个统一的冲突对象形状
 * （都要读 `.label` / `.reason`），所以给它一个不可能与真实命令 id 撞车的哨兵值。
 * 真实命令 id 一律是 `<域>.<动作>`，不含连续双下划线。
 * @type {string}
 */
export const RESERVED_CONFLICT_ID = '__reserved__'

/**
 * severity 三档的枚举（对外只读，方便调用方不写魔法字符串）。
 * - block：同 scope 实占 → 默认拒绝写入，可 override
 * - warn：跨 scope 抢键 / 保留键警告级 → 允许写入，仅提示
 * - hard：保留键硬拒绝 → 任何情况都不写
 * @type {Readonly<{BLOCK: string, WARN: string, HARD: string}>}
 */
export const CONFLICT_SEVERITY = Object.freeze({ BLOCK: 'block', WARN: 'warn', HARD: 'hard' })

export const useAppStore = defineStore('app', () => {
  const theme = ref('system')
  const systemTheme = ref('light')
  const accentColor = ref('#4A90D9')
  const fontSize = ref('medium')
  const glassEffect = ref(true)
  const autoSave = ref(true)
  const spellCheck = ref(true)
  const showLineNumbers = ref(false)
  const wordWrap = ref(true)
  const notesLocation = ref('')
  // 默认开（T24 翻转）。两处默认值必须一致：这里是「全新安装 / key 不存在」时真正
  // 生效的那个（loadConfig 在 key 缺失时 continue，不读 CONFIG_SCHEMA.fallback），
  // storage.js 的 fallback 只管「重置设置」。两侧都写 true，否则会出现「重置后开、
  // 新装却关」或反之的错位。关掉它的唯一途径是设置页 / toggleAutoSync 写 'false'。
  const autoSync = ref(true)
  const sidebar = ref(true)
  // 新建笔记时使用的扩展名（md / markdown / txt），由 note.js 落盘与载入时共同遵守
  // 白名单本体见 @/constants/noteFile（下面 return 里照旧对外暴露同名引用）
  //
  // 持久化：写走 setNoteExtension，读走 CONFIG_SCHEMA 的 parse（asNoteExtension）。
  // 这一项过去在 schema 里带 skipLoad，于是只写不读 —— 用户改了默认扩展名能存进
  // localStorage，重启后又被这个 'md' 覆盖回去（「改了能存、重启就忘」）。现在
  // 读写两侧都用同一个 normalizeNoteExtension 归一化，口径一致。
  const noteExtension = ref('md')
  const initialized = ref(false)
  const ignoredWords = ref(new Set())
  const customDictionary = ref(new Set())
  const spellVersion = ref(0)
  const codeTheme = ref('github')
  // 编辑器缩放（百分比 50~200）：edit / live / preview 三种模式 + 阅读视图共用，
  // 保证切换模式时视觉大小不跳变
  const editorZoom = ref(100)
  const bingWallpaper = ref(false)
  const bingWallpaperUrl = ref('')
  const bingWallpaperTitle = ref('')
  const bingWallpaperDate = ref('')
  /** 壁纸实际来源：official（主进程官方接口）/ biturl（公开 API），用于设置页排障 */
  const bingWallpaperSource = ref('')
  const bingWallpaperError = ref('')
  const autoCheckUpdates = ref(true)
  const appVersion = ref('')
  // 可自定义快捷键：{ [shortcutId]: binding }，缺省回落到内置默认值
  const hotkeys = ref(createDefaultBindings())
  /**
   * 正在录制快捷键的命令 id（设置页用）。非空时 App.vue 的全局快捷键监听必须让路，
   * 否则录制 Ctrl+S 会顺手把笔记存了盘。
   */
  const shortcutRecordingId = ref(null)
  // 编辑器模式：edit(纯源码) / live(实时预览) / preview(阅读)
  // 注意：词汇必须与 EditorView 一致（历史版本用过 'source'，读取时会被归一成 'edit'）
  const editorMode = ref('edit')
  // 右栏面板
  const rightPanelTab = ref('outline')
  const rightPanelVisible = ref(true)
  // 全局模态：命令面板 & 快速切换器
  const commandPaletteOpen = ref(false)
  const quickSwitcherOpen = ref(false)
  // 全局模态：快捷键速查表（T08 的 <ShortcutCheatsheet /> 读它；命令 app.shortcutCheatsheet 切它）
  const shortcutCheatsheetOpen = ref(false)

  /**
   * 进入阅读模式（preview）之前的那个可编辑模式（edit / live）。
   *
   * 为什么要记：`Mod-Shift-e` 是「阅读模式往返键」，从 live 按进去必须回到 live，
   * 从 edit 按进去必须回到 edit，否则用户每按一次就被偷偷降级成纯源码模式。
   * 以前这份记忆在 EditorView.vue 里（本地 ref），导致「编辑器里的按钮」与
   * 「全局快捷键」各记一份、互不同步；现在收进 store，两个入口共用一份。
   * 刻意**不持久化**：它是会话内的临时状态，写进 localStorage 会让用户下次
   * 打开应用时莫名回到某个旧模式。
   */
  const lastEditableMode = ref('edit')

  /**
   * 编辑器命令执行器（由 EditorView 在 onMounted 注册、onUnmounted 置空）。
   *
   * 存在的意义：命令面板（T12）要能搜到并执行 **editor scope** 的命令，
   * 而这些命令只有在编辑器挂载后才有 CodeMirror 实例可用。用一个 shallowRef
   * 装「(id) => void」回调，面板就能在没有编辑器时优雅降级。
   * 用 shallowRef 而非 ref：函数不该被 reactive 递归代理。
   */
  const editorRunner = shallowRef(null)

  /**
   * CONFIG_SCHEMA 的 ref 字段指向这里的键名。新增持久化配置项时，除了在
   * @/constants/storage.js 里加 key 和 schema 行，还要在这里登记对应的 ref。
   */
  const configRefs = {
    theme,
    accentColor,
    fontSize,
    glassEffect,
    notesLocation,
    ignoredWords,
    customDictionary,
    autoSave,
    spellCheck,
    showLineNumbers,
    wordWrap,
    autoSync,
    noteExtension,
    sidebar,
    codeTheme,
    bingWallpaper,
    bingWallpaperUrl,
    bingWallpaperTitle,
    bingWallpaperDate,
    bingWallpaperSource,
    editorZoom,
    autoCheckUpdates,
    hotkeys,
    editorMode,
    rightPanelTab,
    rightPanelVisible
  }

  /**
   * 全局轻量通知队列。写盘失败、目录失效这类"用户必须知道"的错误需要一个
   * 统一出口，否则只能 console.error 然后静默丢数据。
   *
   * toast 元素的结构是 { id, type, message, timerId }：timerId 只是内部用的
   * 定时器句柄（用于手动关闭/重置时取消定时任务），不参与渲染。
   */
  const toasts = ref([])
  let toastSeq = 0

  function pushToast ({ type = 'info', message = '', duration = 5000 } = {}) {
    if (!message) return null
    const id = ++toastSeq
    const toast = { id, type, message, timerId: null }
    toasts.value.push(toast)
    if (toasts.value.length > 4) {
      // 队列超限被挤掉的那条，定时器也要一并取消，避免它到点后再遍历一次数组
      const dropped = toasts.value.shift()
      if (dropped && dropped.timerId) clearTimeout(dropped.timerId)
    }
    if (duration > 0) {
      toast.timerId = setTimeout(() => dismissToast(id), duration)
    }
    return id
  }

  function dismissToast (id) {
    const idx = toasts.value.findIndex(t => t.id === id)
    if (idx === -1) return
    const [toast] = toasts.value.splice(idx, 1)
    // 手动关闭后定时器必须停掉：否则它到点还会再跑一次无谓的数组遍历
    if (toast && toast.timerId) {
      clearTimeout(toast.timerId)
      toast.timerId = null
    }
  }

  /** 取消所有在途 toast 定时器并清空队列（重置配置 / 销毁 store 时用） */
  function clearToastTimers () {
    for (const toast of toasts.value) {
      if (toast.timerId) clearTimeout(toast.timerId)
    }
    toasts.value = []
  }

  let mediaQueryListener = null
  let spellSaveTimer = null
  let firstLoadDone = false

  // 字号（"稍微大一点"）：small 14 / medium 16 / large 18（每级相对旧值 +1 ~ +2px）
  const fontSizeMap = {
    small:  { body: '14px', h1: '30px', h2: '24px', h3: '20px', h4: '16px', base: '14px', lg: '16px', xl: '18px', h2xl: '22px', h3xl: '28px', h4xl: '32px', h5xl: '36px', sm: '13px', xs: '12px', xxs: '11px', xxxs: '10px' },
    medium: { body: '16px', h1: '34px', h2: '28px', h3: '23px', h4: '18px', base: '16px', lg: '18px', xl: '20px', h2xl: '24px', h3xl: '30px', h4xl: '36px', h5xl: '40px', sm: '14px', xs: '13px', xxs: '12px', xxxs: '11px' },
    large:  { body: '18px', h1: '38px', h2: '32px', h3: '26px', h4: '20px', base: '18px', lg: '20px', xl: '22px', h2xl: '26px', h3xl: '34px', h4xl: '40px', h5xl: '44px', sm: '16px', xs: '14px', xxs: '13px', xxxs: '12px' }
  }

  const effectiveTheme = computed(() => {
    if (theme.value === 'system') {
      return systemTheme.value
    }
    return theme.value
  })

  const accentColors = [
    '#4A90D9',
    '#E53935',
    '#FF7043',
    '#66BB6A',
    '#26C6DA',
    '#26A69A'
  ]

  function setupSystemThemeListener() {
    if (typeof window === 'undefined' || !window.matchMedia) return
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemTheme.value = mediaQuery.matches ? 'dark' : 'light'
    
    mediaQueryListener = (e) => {
      systemTheme.value = e.matches ? 'dark' : 'light'
      if (theme.value === 'system') {
        applyTheme()
      }
    }
    
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', mediaQueryListener)
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(mediaQueryListener)
    }
  }

  /**
   * 逐条走 CONFIG_SCHEMA：key → 解析 → 写回对应 ref。
   * 规则（全部原样保留旧行为）：key 不存在则跳过；parse 返回 SKIP 表示值不合法，
   * 也跳过并保持 ref 的默认值。
   */
  function loadConfig() {
    setupSystemThemeListener()

    for (const entry of CONFIG_SCHEMA) {
      if (entry.skipLoad || typeof entry.parse !== 'function') continue
      const raw = localStorage.getItem(entry.key)
      if (raw === null) continue
      const value = entry.parse(raw)
      if (value === SKIP) continue
      const target = configRefs[entry.ref]
      if (!target) {
        // schema 与 refMap 对不上是**改代码时才会犯的错**，用户看到的现象只是
        // 「这个设置项改了不生效」。记下来，别让排查只能靠读源码。
        appLog.warn('配置 schema 指向了不存在的 ref', { ref: entry.ref, key: entry.key })
        continue
      }
      target.value = value
    }

    // 快捷键不走通用循环：key 缺失时也要写回默认表，否则新版本新增的命令不会生效
    hotkeys.value = mergeBindings(localStorage.getItem(LS_KEYS.hotkeys))

    applyTheme()
    applyAccentColor()
    applyGlassEffect()
    applyFontSize()
    initialized.value = true
  }

  /**
   * 合并已保存的快捷键。直接 JSON.parse 会丢掉后续版本新增的命令，
   * 所以以默认表为底、用用户覆盖项打补丁；非字符串或空串视为"未设置"。
   *
   * ============ 持久化兼容（硬要求，改动前必读） ============
   * - 结构必须是 `{ [命令 id]: 绑定串原文 }` 的 **1:1 扁平对象**，key = `choyeon-hotkeys`。
   *   本轮**不**改成「一个命令绑多个组合键」的数组结构 —— 那会让所有老用户的配置整体失效。
   * - 语义严格保持「key 缺失补默认、已存在则保留」：老用户升级后已自定义的键位 100% 保留。
   * - 存的是用户录制的**原文**（可能是 `Ctrl+Alt+X` / `MOD-SHIFT-D` 这类非规范写法）。
   *   `normalizeBinding` **只在读取比较时**调用，`persistHotkeys` 绝不回写规范化结果 ——
   *   规范化不是双向可逆的，一旦回写，用户当初按下的键就再也重录不回来了。
   */
  function mergeBindings(raw) {
    const base = createDefaultBindings()
    if (!raw) return base
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return base
      for (const [id, binding] of Object.entries(parsed)) {
        if (!(id in base)) continue
        base[id] = typeof binding === 'string' ? binding : ''
      }
    } catch {
      /* 损坏的配置直接回退默认值 */
    }
    return base
  }

  function persistHotkeys() {
    localStorage.setItem(LS_KEYS.hotkeys, JSON.stringify(hotkeys.value))
  }

  /** 取某命令的当前绑定（用户自定义优先） */
  function getBinding(id) {
    const custom = hotkeys.value[id]
    return custom === undefined ? SHORTCUT_MAP[id]?.default || '' : custom
  }

  /**
   * 写入一条快捷键绑定，返回统一形状的三态回执。
   *
   * 三态（由 `findConflict` 给出的 severity 决定）：
   * 1. **hard 级保留键** → 拒绝写入，`status: 'reserved'`，`canOverride: false`。
   *    理由文案直接取 `describeReserved`（如「系统保留：关闭窗口（不可拦截）」）。
   * 2. **block 级（同 scope 实占）** → 默认拒绝，`status: 'conflict'`，`canOverride: true`；
   *    传 `override: true` 时把占用者的绑定**置空**再写自己，回执带 `overridden: [被清空的命令 id]`。
   * 3. **warn 级（跨 scope 抢键 / 保留键警告级）** → **允许写入**，回执带 `warnings` 供 UI 提示。
   *
   * 兼容说明：回执同时带 `status` 与 `reason` 两个同值字段 —— `reason` 是旧调用方
   * （设置页）在用的字段名，T11 改读 `status` 之前两边都能工作，不会改一处炸一处。
   *
   * @param {string} id 命令 id
   * @param {string} binding 绑定串**原文**（原样持久化）；空串 = 不绑键
   * @param {{ override?: boolean, isElectron?: boolean }} [options]
   *   `override` 默认 false；`isElectron` 默认取 `IS_ELECTRON`，测试可显式切环境
   * @returns {{
   *   ok: boolean,
   *   status: 'ok' | 'conflict' | 'reserved' | 'invalid' | 'unknown',
   *   reason: string,
   *   message: string,
   *   conflict: object | null,
   *   overridden: string[],
   *   warnings: Array<object>,
   *   canOverride: boolean
   * }}
   */
  function setHotkey(id, binding, options = {}) {
    const { override = false, isElectron: envElectron = IS_ELECTRON } = options
    const ok = (extra = {}) => ({
      ok: true,
      status: 'ok',
      reason: 'ok',
      message: '',
      conflict: null,
      overridden: [],
      warnings: [],
      canOverride: false,
      ...extra
    })
    const fail = (status, message, extra = {}) => ({
      ok: false,
      status,
      reason: status,
      message,
      conflict: null,
      overridden: [],
      warnings: [],
      canOverride: false,
      ...extra
    })

    if (!id || !(id in hotkeys.value)) {
      return fail('unknown', `命令不存在：${id}`)
    }

    // 只 trim，**不**规范化：写进 localStorage 的必须是用户录制的原文
    const next = typeof binding === 'string' ? binding.trim() : ''
    // 非空却解析不出主键（如 'Mod-'）→ 非法输入。这里只做校验，不改写 next
    if (next && !normalizeBinding(next)) {
      return fail('invalid', '按键组合不完整（缺少主键），请重新录制')
    }

    if (next) {
      const conflict = findConflict(id, next, undefined, { isElectron: envElectron })
      if (conflict) {
        if (conflict.severity === 'hard') {
          return fail(
            'reserved',
            conflict.reason || `「${conflict.binding}」是系统 / 浏览器保留键，无法绑定`,
            { conflict, canOverride: false }
          )
        }
        if (conflict.severity === 'block') {
          if (!override) {
            return fail('conflict', `与「${conflict.label}」冲突，请换一个组合键`, {
              conflict,
              canOverride: true
            })
          }
          // 强行覆盖：先把占用者的绑定置空，再写自己，一次落盘（避免中间态被别的监听读到）
          const overridden = conflict.id in hotkeys.value ? [conflict.id] : []
          const nextMap = { ...hotkeys.value, [id]: next }
          for (const victim of overridden) nextMap[victim] = ''
          hotkeys.value = nextMap
          persistHotkeys()
          return ok({
            message: `已覆盖「${conflict.label}」的键位`,
            conflict,
            overridden,
            canOverride: true
          })
        }
        // warn 级：允许写入，只把提示挂在回执上（可能同时命中保留键与跨 scope 占用，
        // 但 findConflict 是短路返回，这里最多一条 —— 保持数组是为了 UI 不写 if/else）
        hotkeys.value = { ...hotkeys.value, [id]: next }
        persistHotkeys()
        return ok({
          message: conflict.reason || '',
          warnings: [{
            id: conflict.id,
            label: conflict.label,
            binding: conflict.binding,
            kind: conflict.kind,
            severity: conflict.severity,
            reason: conflict.reason
          }]
        })
      }
    }

    hotkeys.value = { ...hotkeys.value, [id]: next }
    persistHotkeys()
    return ok()
  }

  function resetHotkey(id) {
    if (!(id in hotkeys.value)) return false
    hotkeys.value = { ...hotkeys.value, [id]: SHORTCUT_MAP[id]?.default || '' }
    persistHotkeys()
    return true
  }

  function resetAllHotkeys() {
    hotkeys.value = createDefaultBindings()
    persistHotkeys()
  }

  /**
   * 找出与给定绑定串冲突的东西；`null` 表示「可以直接写」。
   *
   * 返回统一形状的冲突对象 `{ id, label, binding, severity, kind, reason }`：
   * - `severity` 三档，直接决定 `setHotkey` 怎么处理：
   *   - `'hard'`：命中 `RESERVED_BINDINGS.hard`，或命中 `browserOnly` 且当前**非** Electron
   *     （`Mod-n` 在 Electron 下菜单已让路，是 `app.newNote` 的默认键，绝不能自杀式硬拒绝）；
   *   - `'block'`：同 scope 已有命令实占这个键（旧版唯一能查出的那一类）；
   *   - `'warn'`：跨 scope 抢键（给 app 命令绑 `Tab` 会与编辑器 `edit.indent` 打架）
   *     或命中 warn 级保留键 —— **允许写入**，只是提示用户。
   * - `kind`：`reserved-hard` | `reserved-browser` | `reserved-warn` | `same-scope` | `cross-scope`
   *
   * 判定顺序（短路）：reserved-hard / reserved-browser → same-scope(block) → reserved-warn → cross-scope(warn) → null。
   * 把同 scope 实占排在 warn 级保留键**之前**，是因为实打实的命令占用优先于「可能有问题」。
   *
   * 所有比较一律先过 `normalizeBinding`（T01 定的单一比较口径）。历史教训：这里原来做的是
   * `toLowerCase()` 后字符串全等，`shift-mod-d` ≠ `mod-shift-d`，于是 `edit.duplicateLine`
   * 与 `insert.date` 实际撞键却查不出来。
   *
   * **默认键自伤豁免**：若待绑的键正是该命令自己的 default（`app.newNote` 的 `Mod-n`、
   * `view.zoomOut` 的 `Mod--` 等），跳过保留键判定 —— 否则这些默认键会被自己判死，
   * 重置回默认、首次加载都过不去。
   *
   * hidden 命令**照旧参与**冲突检测：hidden 不等于不占键，历史上 hidden 的 `insert.date`
   * 就撞过 `edit.duplicateLine`。
   *
   * @param {string} id 待设置的命令 id
   * @param {unknown} binding 待检测的绑定串（任意写法，内部规范化）
   * @param {'app' | 'editor'} [scope] 缺省取该命令在注册表里的 scope
   * @param {{ isElectron?: boolean }} [options] 缺省取 `IS_ELECTRON`；测试可显式切环境
   * @returns {null | {id: string, label: string, binding: string,
   *   severity: 'block' | 'warn' | 'hard', kind: string, reason: string}}
   */
  function findConflict(id, binding, scope, options = {}) {
    const { isElectron: envElectron = IS_ELECTRON } = options
    const self = SHORTCUT_MAP[id]
    const targetScope = scope || self?.scope
    const normalized = normalizeBinding(binding)
    if (!normalized) return null

    // 默认键自伤豁免：绑的就是自己的 default → 不看保留键表
    const isOwnDefault = normalized === normalizeBinding(self?.default)

    if (!isOwnDefault) {
      const { level, reason } = describeReserved(normalized, { isElectron: envElectron })
      if (level === 'hard') {
        const kind = RESERVED_BINDINGS.hard[normalized] ? 'reserved-hard' : 'reserved-browser'
        return {
          id: RESERVED_CONFLICT_ID,
          label: '系统 / 浏览器保留键',
          binding: normalized,
          severity: 'hard',
          kind,
          reason
        }
      }
    }

    // 一次遍历同时找「同 scope 实占」与「跨 scope 抢键」，避免扫两遍注册表
    let sameScopeHit = null
    let crossScopeHit = null
    for (const s of SHORTCUTS) {
      if (s.id === id) continue
      const occupied = normalizeBinding(getBinding(s.id))
      if (!occupied || occupied !== normalized) continue
      if (s.scope === targetScope) {
        sameScopeHit = s
        break
      }
      if (!crossScopeHit) crossScopeHit = s
    }

    if (sameScopeHit) {
      return {
        id: sameScopeHit.id,
        label: sameScopeHit.label,
        binding: normalized,
        severity: 'block',
        kind: 'same-scope',
        reason: `与「${sameScopeHit.label}」冲突（同一作用域）`
      }
    }

    if (!isOwnDefault) {
      const { level, reason } = describeReserved(normalized, { isElectron: envElectron })
      if (level === 'warn') {
        return {
          id: RESERVED_CONFLICT_ID,
          label: '保留键',
          binding: normalized,
          severity: 'warn',
          kind: 'reserved-warn',
          reason
        }
      }
    }

    if (crossScopeHit) {
      const owner = crossScopeHit.scope === 'editor' ? '编辑器命令' : '全局命令'
      return {
        id: crossScopeHit.id,
        label: crossScopeHit.label,
        binding: normalized,
        severity: 'warn',
        kind: 'cross-scope',
        reason: `与${owner}「${crossScopeHit.label}」抢同一个键，该命令可能不生效`
      }
    }

    return null
  }

  function setEditorMode(mode) {
    const normalized = mode === 'source' ? 'edit' : mode
    if (!['edit', 'live', 'preview'].includes(normalized)) return
    // 与 EditorView.vue 的 setMode 对齐：只要是「可编辑模式」就记下来，
    // 供 toggleReadingMode 从 preview 切回来时按原样恢复（从 live 进去必须回 live）
    if (normalized !== 'preview') lastEditableMode.value = normalized
    editorMode.value = normalized
    localStorage.setItem(LS_KEYS.editorMode, normalized)
  }

  /**
   * 阅读模式往返：`preview` ↔ 「上一次的非 preview 模式」。
   *
   * 语义对齐 EditorView.vue 里那段被 T10 删掉的本地实现
   * （`setMode(editorMode === 'preview' ? lastEditableMode : 'preview')`）：
   * 记忆只有一份、放在 store 里，编辑器按钮与全局快捷键两个入口共用，
   * 不会出现「按钮记住 live、快捷键记住 edit」的错位。
   *
   * @returns {void}
   */
  function toggleReadingMode() {
    if (editorMode.value !== 'preview') {
      lastEditableMode.value = editorMode.value
      setEditorMode('preview')
      return
    }
    setEditorMode(lastEditableMode.value || 'edit')
  }

  /**
   * 实时预览**双向** toggle：`live` ↔ `edit`。
   *
   * 为什么必须双向：`view.liveMode` 现在挂在 app scope 上、由全局快捷键直接调用，
   * 单向 `setEditorMode('live')` 会让这个键变成「只能进不能出」 —— 再按一次毫无反应，
   * 用户会以为快捷键坏了。当前处于 preview 时也按「非 live → live」处理，
   * 与「按一次进实时预览」的直觉一致。
   *
   * @returns {void}
   */
  function toggleLiveMode() {
    setEditorMode(editorMode.value === 'live' ? 'edit' : 'live')
  }

  function setRightPanelTab(tab) {
    rightPanelTab.value = tab
    localStorage.setItem(LS_KEYS.rightPanelTab, tab)
  }

  function toggleRightPanel() {
    rightPanelVisible.value = !rightPanelVisible.value
    localStorage.setItem(LS_KEYS.rightPanelVisible, rightPanelVisible.value)
  }

  function saveNotesLocation(path) {
    notesLocation.value = path
    localStorage.setItem(LS_KEYS.notesLocation, path)
    localStorage.removeItem(LS_KEYS.mode)
  }

  function resetConfig() {
    // key 清单唯一来源：清掉 LS_KEYS 里的全部 key（含已废弃的 choyeon-mode）
    for (const key of Object.values(LS_KEYS)) {
      localStorage.removeItem(key)
    }

    // 定时器一并收干净：toast 的自动关闭 + 拼写数据的延迟落盘，
    // 否则重置后残留定时器还会再碰一次已被清空的队列
    clearToastTimers()
    if (spellSaveTimer) {
      clearTimeout(spellSaveTimer)
      spellSaveTimer = null
    }

    if (mediaQueryListener) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', mediaQueryListener)
      } else if (mediaQuery.removeListener) {
        mediaQuery.removeListener(mediaQueryListener)
      }
      mediaQueryListener = null
    }
    
    // 默认值同样来自 schema，新增配置项不会漏掉「重置但内存没回退」这一步
    for (const entry of CONFIG_SCHEMA) {
      const target = configRefs[entry.ref]
      if (target) target.value = entry.fallback()
    }
    // 壁纸错误态是纯内存状态（没有对应 key），单独清
    bingWallpaperError.value = ''

    applyTheme()
    applyAccentColor()
    applyGlassEffect()
    applyFontSize()
  }

  // ---------------------------------------------------------------------------
  // dev 期「注册表 ↔ 执行器」漂移守卫 —— 本轮**刻意未启用**，原因与启用条件如下
  // ---------------------------------------------------------------------------
  // 设计文档 §B3 腿 2 建议在 `import.meta.env.DEV` 下跑一次 `auditShortcuts` 并 console.error。
  // 但 audit 需要**完整的** executor id 集合，而 editor 侧的 `EDITOR_COMMAND_IDS`
  // 由 T04（useEditor.js）导出、app 侧与 App.vue 的装配由 T09 收口 —— T03 此刻两者都还没落地。
  // 现在就跑的后果：35 条 editor 命令会被全部判成 dead，控制台刷满假告警，
  // 反而把真正的漂移淹没掉（false alarm 比不告警更糟）。
  //
  // **启用条件（T04 + T09 落地后由 T13 在此处补 6 行即可）**：
  // ```js
  // if (import.meta.env.DEV || localStorage.getItem('choyeon-debug-audit') === '1') {
  //   const { APP_ACTION_IDS } = await import('@/composables/useAppActions')
  //   const { EDITOR_COMMAND_IDS } = await import('@/composables/useEditor')
  //   const result = auditShortcuts({ appActionIds: APP_ACTION_IDS, editorCommandIds: EDITOR_COMMAND_IDS })
  //   if (!result.ok) console.error('[shortcut-audit] 注册表校验未通过：', result)
  // }
  // ```
  // 用动态 import 而不是顶层 import：useEditor 会拖进整条 CodeMirror 依赖链，
  // 让 store 在 dev 期白白多解析几百个模块。

  function initTheme() {
    loadConfig()
    hydrateSpellDataFromDisk()
  }

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    localStorage.setItem(LS_KEYS.theme, theme.value)
    applyTheme()
  }

  function setTheme(newTheme) {
    theme.value = newTheme
    localStorage.setItem(LS_KEYS.theme, theme.value)
    applyTheme()
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', effectiveTheme.value)
  }

  function setAccentColor(color) {
    accentColor.value = color
    localStorage.setItem(LS_KEYS.accent, color)
    applyAccentColor()
  }

  function applyAccentColor() {
    document.documentElement.style.setProperty('--cho-primary', accentColor.value)
    document.documentElement.style.setProperty('--color-primary', accentColor.value)
  }

  function applyGlassEffect() {
    document.documentElement.setAttribute('data-glass', glassEffect.value ? 'true' : 'false')
  }

  function applyFontSize() {
    const m = fontSizeMap[fontSize.value] || fontSizeMap.medium
    const root = document.documentElement
    root.setAttribute('data-font-size', fontSize.value)
    root.style.setProperty('--font-size-body', m.body)
    root.style.setProperty('--font-size-sm', m.sm)
    root.style.setProperty('--font-size-xs', m.xs)
    root.style.setProperty('--font-size-2xs', m.xxs)
    root.style.setProperty('--font-size-3xs', m.xxxs)
    root.style.setProperty('--font-size-h1', m.h1)
    root.style.setProperty('--font-size-h2', m.h2)
    root.style.setProperty('--font-size-h3', m.h3)
    root.style.setProperty('--font-size-h4', m.h4)
    root.style.setProperty('--font-size-base', m.base)
    root.style.setProperty('--font-size-lg', m.lg)
    root.style.setProperty('--font-size-xl', m.xl)
    root.style.setProperty('--font-size-2xl', m.h2xl)
    root.style.setProperty('--font-size-3xl', m.h3xl)
    root.style.setProperty('--font-size-4xl', m.h4xl)
    root.style.setProperty('--font-size-5xl', m.h5xl)
  }

  function setFontSize(size) {
    fontSize.value = size
    localStorage.setItem(LS_KEYS.fontSize, size)
    applyFontSize()
  }

  function toggleGlassEffect() {
    glassEffect.value = !glassEffect.value
    localStorage.setItem(LS_KEYS.glassEffect, glassEffect.value)
    applyGlassEffect()
  }

  function toggleAutoSave() {
    autoSave.value = !autoSave.value
    localStorage.setItem(LS_KEYS.autoSave, autoSave.value)
  }

  function toggleSpellCheck() {
    spellCheck.value = !spellCheck.value
    localStorage.setItem(LS_KEYS.spellCheck, spellCheck.value)
  }

  function toggleLineNumbers() {
    showLineNumbers.value = !showLineNumbers.value
    localStorage.setItem(LS_KEYS.lineNumbers, showLineNumbers.value)
  }

  function toggleWordWrap() {
    wordWrap.value = !wordWrap.value
    localStorage.setItem(LS_KEYS.wordWrap, wordWrap.value)
  }

  function toggleAutoSync() {
    autoSync.value = !autoSync.value
    localStorage.setItem(LS_KEYS.autoSync, autoSync.value)
  }

  /**
   * 设置新建笔记的默认扩展名。
   *
   * 归一化后再比对白名单，而不是拿到就存：非白名单值一律拒绝（保持当前值不动），
   * 否则 'undefined' / '.md' 这类脏值会被写进 localStorage，重启后读回来就是
   * 一个「设置项存在但不可用」的状态 —— 与本轮要修的 bug 同一类。
   * 归一化规则复用 storage.js 的 normalizeNoteExtension，与读取侧 asNoteExtension
   * 同源，避免两边口径漂移。
   *
   * @param {string} ext 扩展名（不带点；允许 '.txt' / 'TXT' 这类写法）
   * @returns {boolean} 是否写入成功
   */
  function setNoteExtension(ext) {
    const normalized = normalizeNoteExtension(ext)
    if (!NOTE_EXTENSIONS.includes(normalized)) return false
    noteExtension.value = normalized
    localStorage.setItem(LS_KEYS.noteExtension, normalized)
    return true
  }

  function toggleSidebar() {
    sidebar.value = !sidebar.value
    localStorage.setItem(LS_KEYS.sidebar, sidebar.value)
  }

  function scheduleSpellPersist() {
    if (!isElectron) return
    if (spellSaveTimer) clearTimeout(spellSaveTimer)
    spellSaveTimer = setTimeout(async () => {
      try {
        if (window.electronAPI?.saveSpellData) {
          await window.electronAPI.saveSpellData({
            ignoredWords: [...ignoredWords.value],
            customDictionary: [...customDictionary.value]
          })
        }
      } catch (e) { /* ignore */ }
    }, 250)
  }

  function ignoreWord(word) {
    const lowerWord = word.toLowerCase()
    if (!ignoredWords.value.has(lowerWord)) {
      ignoredWords.value = new Set([...ignoredWords.value, lowerWord])
      localStorage.setItem(LS_KEYS.ignoredWords, JSON.stringify([...ignoredWords.value]))
      scheduleSpellPersist()
      spellVersion.value++
    }
  }

  function unignoreWord(word) {
    const lowerWord = word.toLowerCase()
    if (ignoredWords.value.has(lowerWord)) {
      const next = new Set(ignoredWords.value)
      next.delete(lowerWord)
      ignoredWords.value = next
      localStorage.setItem(LS_KEYS.ignoredWords, JSON.stringify([...ignoredWords.value]))
      scheduleSpellPersist()
      spellVersion.value++
    }
  }

  function clearIgnoredWords() {
    ignoredWords.value = new Set()
    localStorage.setItem(LS_KEYS.ignoredWords, '[]')
    scheduleSpellPersist()
    spellVersion.value++
  }

  function addToDictionary(word) {
    const lowerWord = word.toLowerCase()
    if (!customDictionary.value.has(lowerWord)) {
      customDictionary.value = new Set([...customDictionary.value, lowerWord])
      localStorage.setItem(LS_KEYS.customDictionary, JSON.stringify([...customDictionary.value]))
      scheduleSpellPersist()
      spellVersion.value++
    }
  }

  function removeFromDictionary(word) {
    const lowerWord = word.toLowerCase()
    if (customDictionary.value.has(lowerWord)) {
      const next = new Set(customDictionary.value)
      next.delete(lowerWord)
      customDictionary.value = next
      localStorage.setItem(LS_KEYS.customDictionary, JSON.stringify([...customDictionary.value]))
      scheduleSpellPersist()
      spellVersion.value++
    }
  }

  function clearCustomDictionary() {
    customDictionary.value = new Set()
    localStorage.setItem(LS_KEYS.customDictionary, '[]')
    scheduleSpellPersist()
    spellVersion.value++
  }

  async function hydrateSpellDataFromDisk() {
    if (!isElectron || firstLoadDone) return
    firstLoadDone = true
    try {
      if (window.electronAPI?.loadSpellData) {
        const data = await window.electronAPI.loadSpellData()
        if (data) {
          if (Array.isArray(data.ignoredWords) && data.ignoredWords.length > 0) {
            const merged = new Set([...ignoredWords.value, ...data.ignoredWords.map(w => String(w).toLowerCase())])
            ignoredWords.value = merged
            localStorage.setItem(LS_KEYS.ignoredWords, JSON.stringify([...merged]))
          }
          if (Array.isArray(data.customDictionary) && data.customDictionary.length > 0) {
            const merged = new Set([...customDictionary.value, ...data.customDictionary.map(w => String(w).toLowerCase())])
            customDictionary.value = merged
            localStorage.setItem(LS_KEYS.customDictionary, JSON.stringify([...merged]))
          }
          if (data.ignoredWords || data.customDictionary) spellVersion.value++
        }
      }
    } catch (e) { /* ignore */ }
  }

  function setCodeTheme(theme) {
    codeTheme.value = theme
    localStorage.setItem(LS_KEYS.codeTheme, theme)
  }

  /**
   * 设置编辑器缩放（百分比）。三种编辑模式 + 阅读视图共用同一个值，
   * 由 App.vue 写到 --editor-zoom CSS 变量上，所以这里不需要碰 DOM。
   */
  function setEditorZoom(value) {
    const z = Math.round(Number(value))
    if (!Number.isFinite(z)) return
    const clamped = Math.min(200, Math.max(50, z))
    editorZoom.value = clamped
    localStorage.setItem(LS_KEYS.editorZoom, String(clamped))
  }

  function resetEditorZoom() {
    setEditorZoom(100)
  }

  function toggleBingWallpaper() {
    bingWallpaper.value = !bingWallpaper.value
    localStorage.setItem(LS_KEYS.bingWallpaper, String(bingWallpaper.value))
  }

  /**
   * 写入一次壁纸结果。url 为空表示失败，此时只记 error 并保留旧图，
   * 避免网络抖动导致背景直接变黑。
   */
  function setBingWallpaper({ url = '', title = '', date = '', error = '', source = '' } = {}) {
    bingWallpaperError.value = error
    if (!url) return
    bingWallpaperUrl.value = url
    bingWallpaperTitle.value = title
    bingWallpaperDate.value = date
    if (source) bingWallpaperSource.value = source
    try {
      localStorage.setItem(LS_KEYS.bingWallpaperUrl, url)
      if (title) localStorage.setItem(LS_KEYS.bingWallpaperTitle, title)
      if (date) localStorage.setItem(LS_KEYS.bingWallpaperDate, date)
      if (source) localStorage.setItem(LS_KEYS.bingWallpaperSource, source)
    } catch (e) { /* localStorage 满或被禁用时忽略，不影响内存态 */ }
  }

  function toggleAutoCheckUpdates() {
    autoCheckUpdates.value = !autoCheckUpdates.value
    localStorage.setItem(LS_KEYS.autoCheckUpdates, autoCheckUpdates.value)
  }

  function openCommandPalette() {
    commandPaletteOpen.value = true
  }
  function closeCommandPalette() {
    commandPaletteOpen.value = false
  }
  function toggleCommandPalette() {
    commandPaletteOpen.value = !commandPaletteOpen.value
    if (commandPaletteOpen.value) quickSwitcherOpen.value = false
  }
  function openQuickSwitcher() {
    quickSwitcherOpen.value = true
  }
  function closeQuickSwitcher() {
    quickSwitcherOpen.value = false
  }
  function toggleQuickSwitcher() {
    quickSwitcherOpen.value = !quickSwitcherOpen.value
    if (quickSwitcherOpen.value) commandPaletteOpen.value = false
  }

  // 快捷键速查表（T08 的 <ShortcutCheatsheet /> 读 shortcutCheatsheetOpen；
  // useAppActions 的 app.shortcutCheatsheet 优先调 toggleShortcutCheatsheet）
  function openShortcutCheatsheet() {
    shortcutCheatsheetOpen.value = true
  }
  function closeShortcutCheatsheet() {
    shortcutCheatsheetOpen.value = false
  }
  function toggleShortcutCheatsheet() {
    shortcutCheatsheetOpen.value = !shortcutCheatsheetOpen.value
  }

  /**
   * 注册 / 注销编辑器命令执行器。
   *
   * 命令面板（T12）要执行 editor scope 命令，但它们只有编辑器挂载后才有 CodeMirror
   * 实例可用，所以由 EditorView 在 onMounted 注册、onUnmounted 传 null 注销。
   *
   * @param {((id: string) => void) | null} runner 执行器；非函数一律当作注销
   * @returns {void}
   */
  function setEditorRunner(runner) {
    editorRunner.value = typeof runner === 'function' ? runner : null
  }

  /**
   * 经编辑器执行器跑一条 editor scope 命令。
   * 没有注册执行器时静默返回 false（调用方决定是否提示用户）。
   *
   * @param {string} id 命令 id
   * @returns {boolean} 是否真的执行了
   */
  function runEditorCommand(id) {
    const runner = editorRunner.value
    if (typeof runner !== 'function') return false
    runner(id)
    return true
  }

  function setAppVersion(version) {
    appVersion.value = version
  }

  function isWordCorrect(word) {
    if (!word) return true
    const lowerWord = word.toLowerCase()
    
    if (ignoredWords.value.has(lowerWord)) return true
    if (customDictionary.value.has(lowerWord)) return true
    
    return isCommonEnglishWord(word)
  }

  function getSpellErrors(text) {
    return getSpellErrorsPure(text, {
      enabled: spellCheck.value,
      ignoredWords: ignoredWords.value,
      customDictionary: customDictionary.value
    })
  }

  return {
    theme,
    systemTheme,
    effectiveTheme,
    accentColor,
    accentColors,
    fontSize,
    glassEffect,
    autoSave,
    spellCheck,
    showLineNumbers,
    wordWrap,
    notesLocation,
    autoSync,
    noteExtension,
    NOTE_EXTENSIONS,
    sidebar,
    initialized,
    ignoredWords,
    customDictionary,
    spellVersion,
    codeTheme,
    editorZoom,
    bingWallpaper,
    bingWallpaperUrl,
    bingWallpaperTitle,
    bingWallpaperDate,
    bingWallpaperSource,
    bingWallpaperError,
    autoCheckUpdates,
    appVersion,
    hotkeys,
    editorMode,
    rightPanelTab,
    rightPanelVisible,
    commandPaletteOpen,
    quickSwitcherOpen,
    shortcutCheatsheetOpen,
    editorRunner,
    toasts,
    pushToast,
    dismissToast,
    initTheme,
    toggleTheme,
    setTheme,
    setAccentColor,
    setFontSize,
    toggleGlassEffect,
    toggleAutoSave,
    toggleSpellCheck,
    toggleLineNumbers,
    toggleWordWrap,
    toggleAutoSync,
    setNoteExtension,
    toggleSidebar,
    saveNotesLocation,
    resetConfig,
    loadConfig,
    ignoreWord,
    unignoreWord,
    clearIgnoredWords,
    addToDictionary,
    removeFromDictionary,
    clearCustomDictionary,
    hydrateSpellDataFromDisk,
    isWordCorrect,
    getSpellErrors,
    setCodeTheme,
    setEditorZoom,
    resetEditorZoom,
    toggleBingWallpaper,
    setBingWallpaper,
    toggleAutoCheckUpdates,
    getBinding,
    setHotkey,
    resetHotkey,
    resetAllHotkeys,
    findConflict,
    shortcutRecordingId,
    setEditorMode,
    toggleReadingMode,
    toggleLiveMode,
    setRightPanelTab,
    toggleRightPanel,
    openCommandPalette,
    closeCommandPalette,
    toggleCommandPalette,
    openQuickSwitcher,
    closeQuickSwitcher,
    toggleQuickSwitcher,
    openShortcutCheatsheet,
    closeShortcutCheatsheet,
    toggleShortcutCheatsheet,
    setEditorRunner,
    runEditorCommand,
    setAppVersion
  }
})
