import { computed } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpen,
  Calendar,
  Clock,
  Command,
  Download,
  Eye,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  Keyboard,
  LayoutDashboard,
  List,
  Monitor,
  Moon,
  Network,
  Palette,
  PanelLeft,
  PanelRight,
  PenLine,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  Sparkles,
  Sun,
  Tags,
  Type,
  UploadCloud,
  ZoomIn,
  ZoomOut
} from 'lucide-vue-next'
import { createAppActions } from '@/composables/useAppActions'
import { SHORTCUTS, SHORTCUT_MAP, formatBinding, normalizeBinding } from '@/constants/shortcuts'
import { createLogger } from '@/utils/logger'
import { LOG_MODULES } from '@/constants/logging'

/** 本模块的诊断出口（执行器缺命令 / 选择笔记库失败 / 导出失败）。模块名取 LOG_MODULES.commands */
const log = createLogger(LOG_MODULES.commands)

/**
 * 全局命令聚合器。
 * 命令面板 (CommandPalette) 使用该 composable 生成可执行命令列表。
 * 每个命令具有: id / label / keywords(搜索辅助) / icon / action / section / hotkey
 *
 * ============ 本轮（T12）打通的核心：快捷键显示的唯一真源 ============
 * 历史问题：这里用的是自己那套冒号风格 id（`note:new`、`view:notes`、`theme:light`…），字段 `cmd.hotkey`
 * **从未被赋值过**，面板里显示的角标因此永远是空的；而真正的键位写在
 * `src/constants/shortcuts.js` 的注册表里 → 「新增一条快捷键命令要改两处」，极易漂移。
 * 现在：凡是注册表里存在的命令，一律用**注册表的 id**，角标走 `appStore.getBinding(id)`。
 *
 * 执行体同样不再另起炉灶：
 * - app scope 命令 → 直接调 T02 的 `createAppActions(ctx)`（本文件不抄任何业务逻辑）；
 * - editor scope 命令 → 经 T03 的 `appStore.runEditorCommand(id)`，由 EditorView 注册的
 *   runner 真正执行；没有 runner 时整组隐藏（见下方 §editor 段落）。
 */

/**
 * 注册表 category → 命令面板的分组标题。
 * 刻意用短名字，让注册表生成的条目与下面手写的条目落进**同一个**分组
 * （否则「视图」和「视图与导航」会分成两截，用户以为少了命令）。
 * @type {Record<string, string>}
 */
const CATEGORY_SECTION = {
  file: '文件',
  edit: '编辑',
  format: '格式化',
  insert: '插入',
  view: '视图'
}

/**
 * 注册表 category → 分组兜底图标（editor scope 生成的条目用它）。
 * 下拉不到细粒度图标的兜底值，宁可统一也不要一会儿有图标一会儿空白。
 * @type {Record<string, unknown>}
 */
const CATEGORY_ICON = {
  file: FolderOpen,
  edit: PenLine,
  format: Type,
  insert: Plus,
  view: LayoutDashboard
}

/**
 * 注册表里有、但手写条目没覆盖到的 app 命令的专属图标。
 * 只列「生成出来的那几条」，手写条目各自带图标，不需要进这张表。
 * @type {Record<string, unknown>}
 */
const GENERATED_APP_ICON = {
  'app.commandPalette': Command,
  'app.navigateBack': ArrowLeft,
  'app.navigateForward': ArrowRight,
  'app.shortcutCheatsheet': Keyboard,
  'view.toggleRightPanel': PanelRight,
  'view.readingMode': BookOpen,
  'view.liveMode': Eye,
  'view.zoomIn': ZoomIn,
  'view.zoomOut': ZoomOut,
  'view.zoomReset': RotateCcw
}

/**
 * 取某条命令在**注册表**里的当前绑定，渲染成面板角标。
 *
 * 三处细节（缺一不可）：
 * 1. `id` 不在注册表 → 返回 `''`：纯业务命令（导出、字号、最近笔记）本来就没有键位，
 *    不显示角标，而不是显示一堆假的。
 * 2. 绑定为空 → 返回 `''`：不渲染 `<kbd>`，避免面板被「未设置」占位填满。
 *    （速查表 T08 需要「未设置」这种显式文案，面板不需要 —— 它是执行入口，不是设置页。）
 * 3. 先过 `normalizeBinding` 再 `formatBinding`：用户 localStorage 里存的是录制**原文**
 *    （可能是 `Ctrl+Alt+X` / `MOD-SHIFT-D`），`formatBinding` 只认 `-` 分隔的规范串，
 *    不过规范化会显示成残缺的一坨。
 *
 * @param {object|undefined} appStore 应用 store
 * @param {string} id 注册表命令 id
 * @returns {string} 角标文案；`''` = 不显示
 */
function hotkeyLabel (appStore, id) {
  if (!id || !SHORTCUT_MAP[id]) return ''
  const binding = appStore?.getBinding?.(id)
  if (!binding) return ''
  return formatBinding(normalizeBinding(binding))
}

/**
 * @param {object} options
 * @param {object} [options.appStore] 应用 store
 * @param {object} [options.noteStore] 笔记 store
 * @param {object} [options.router] vue-router 实例
 * @param {Function} [options.openQuickSwitcher] 打开快速切换器（面板自己负责关闭）
 * @param {Function} [options.closePalette] 关闭命令面板
 * @returns {{ quickActions: import('vue').ComputedRef<Array<object>> }}
 */
export function useCommands (options = {}) {
  const { appStore, noteStore, router, openQuickSwitcher, closePalette } = options

  /**
   * app scope 命令的唯一执行体（T02 交付）。
   * 这里**禁止**再写一份 `router.push('/notes')` 之类的实现 ——
   * 那正是本轮要消灭的漂移：快捷键改了、面板走的还是旧路径。
   */
  const appActions = createAppActions({ appStore, noteStore, router })

  /** 包一层面板语义：跑完就关面板；执行器表里没有该 id 时不静默吞，打点告警 */
  function runApp (id) {
    return () => {
      const fn = appActions[id]
      if (typeof fn !== 'function') {
        // 命令 id 走 data 而不拼进 msg：面板里 id 是用户输入无关的注册表常量，
        // 放 data 才能被按字段过滤；msg 保持稳定的短句，便于日志检索。
        log.warn('app 命令未在执行器表中注册', { id })
        closePalette?.()
        return
      }
      fn()
      closePalette?.()
    }
  }

  /** 快速切换器：优先用调用方给的入口（它会先关面板再开切换器），给不了才回落执行器 */
  const runQuickSwitcher = openQuickSwitcher
    ? () => {
      closePalette?.()
      openQuickSwitcher()
    }
    : runApp('app.quickSwitcher')

  const quickActions = computed(() => {
    const items = []
    /** 已经入队的 id —— 手写条目先占位，注册表扫尾时跳过，保证 key 不重复 */
    const seen = new Set()

    /**
     * 统一入队口：算角标、填默认字段、去重。
     * id 尽量直接用**注册表 id**，这样 `SHORTCUT_MAP[id]` 命中，角标自动有了。
     */
    function push (item) {
      if (seen.has(item.id)) return
      seen.add(item.id)
      items.push({
        id: item.id,
        section: item.section || '其他',
        label: item.label,
        keywords: item.keywords || '',
        icon: item.icon,
        action: item.action,
        hotkey: hotkeyLabel(appStore, item.id)
      })
    }

    // ========== 视图导航（id 已换成注册表 id，执行走 T02 的 createAppActions） ==========
    push({
      id: 'view.notes',
      section: '视图',
      label: '打开笔记列表',
      keywords: 'notes list 笔记 列表 all files',
      icon: List,
      action: runApp('view.notes')
    })
    push({
      id: 'view.tags',
      section: '视图',
      label: '打开标签视图',
      keywords: 'tags 标签',
      icon: Tags,
      action: runApp('view.tags')
    })
    push({
      id: 'view.calendar',
      section: '视图',
      label: '打开日历视图',
      keywords: 'calendar 日历 daily',
      icon: Calendar,
      action: runApp('view.calendar')
    })
    push({
      id: 'view.graph',
      section: '视图',
      label: '打开关系图谱',
      keywords: 'graph 图谱 backlinks 关系',
      icon: Network,
      action: runApp('view.graph')
    })
    push({
      id: 'app.vault',
      section: '视图',
      label: '打开密码本',
      keywords: 'vault kv 密码本 备忘录 密码 服务器 ip token 账号 secret password',
      icon: Bookmark,
      action: runApp('app.vault')
    })
    push({
      id: 'view.search',
      section: '视图',
      label: '全局搜索',
      keywords: 'search 搜索 find 查找 ctrl+f cmd+k',
      icon: Search,
      action: runApp('view.search')
    })
    push({
      id: 'app.settings',
      section: '视图',
      label: '打开设置',
      keywords: 'settings 设置 preferences 选项',
      icon: Settings,
      action: runApp('app.settings')
    })

    // ========== 笔记操作 ==========
    push({
      id: 'app.newNote',
      section: '笔记',
      label: '新建笔记',
      keywords: 'new note create 新建 笔记',
      icon: FilePlus2,
      action: runApp('app.newNote')
    })
    // 根目录下新建文件夹：注册表里没有对应命令（属于纯业务逻辑），保持原样、不带角标
    push({
      id: 'note:new-folder',
      section: '笔记',
      label: '在根目录新建文件夹',
      keywords: 'new folder 新建 文件夹',
      icon: FolderPlus,
      action: () => {
        noteStore?.createFolderAtRoot?.()
        router?.push?.('/notes')
        closePalette?.()
      }
    })
    push({
      id: 'app.quickSwitcher',
      section: '笔记',
      label: '快速切换器：按标题跳转笔记',
      keywords: 'quick switcher open 打开 跳转 goto 快速',
      icon: Bookmark,
      action: runQuickSwitcher
    })
    push({
      id: 'app.save',
      section: '笔记',
      label: '保存当前笔记',
      keywords: 'save flush 保存',
      icon: Save,
      action: runApp('app.save')
    })

    // ========== 外观 / 界面 ==========
    // 三条主题直选项：注册表里没有（只有「切换明暗主题」），属于面板补充命令，无角标
    push({
      id: 'theme:light',
      section: '外观',
      label: '切换到亮色主题',
      keywords: 'theme light 亮色 白天',
      icon: Sun,
      action: () => {
        appStore?.setTheme('light')
        closePalette?.()
      }
    })
    push({
      id: 'theme:dark',
      section: '外观',
      label: '切换到暗色主题',
      keywords: 'theme dark 暗色 夜晚',
      icon: Moon,
      action: () => {
        appStore?.setTheme('dark')
        closePalette?.()
      }
    })
    push({
      id: 'theme:system',
      section: '外观',
      label: '跟随系统主题',
      keywords: 'theme system 系统 default 默认',
      icon: Monitor,
      action: () => {
        appStore?.setTheme('system')
        closePalette?.()
      }
    })
    push({
      id: 'view.toggleTheme',
      section: '外观',
      label: '切换亮/暗主题',
      keywords: 'toggle theme 切换',
      icon: Sparkles,
      action: runApp('view.toggleTheme')
    })
    push({
      id: 'view.toggleSidebar',
      section: '外观',
      label: '显示/隐藏侧边栏',
      keywords: 'sidebar 侧边栏 panel 面板',
      icon: PanelLeft,
      action: runApp('view.toggleSidebar')
    })
    push({
      id: 'ui:toggle-glass',
      section: '外观',
      label: '开关毛玻璃效果',
      keywords: 'glass acrylic 毛玻璃 透明',
      icon: Palette,
      action: () => {
        appStore?.toggleGlassEffect()
        closePalette?.()
      }
    })
    push({
      id: 'ui:font-small',
      section: '外观',
      label: '设置字号：小',
      keywords: 'font size small 字号 小',
      icon: Type,
      action: () => {
        appStore?.setFontSize('small')
        closePalette?.()
      }
    })
    push({
      id: 'ui:font-medium',
      section: '外观',
      label: '设置字号：中',
      keywords: 'font size medium 字号 中',
      icon: Type,
      action: () => {
        appStore?.setFontSize('medium')
        closePalette?.()
      }
    })
    push({
      id: 'ui:font-large',
      section: '外观',
      label: '设置字号：大',
      keywords: 'font size large 字号 大',
      icon: Type,
      action: () => {
        appStore?.setFontSize('large')
        closePalette?.()
      }
    })

    // ========== 文件 / 同步（纯业务，注册表无对应命令 → 无角标） ==========
    push({
      id: 'file:open-location',
      section: '文件',
      label: '选择笔记库路径（打开文件夹）',
      keywords: 'open folder vault library 笔记库 路径 打开文件夹',
      icon: UploadCloud,
      action: async () => {
        // 注意：preload 里只有 selectNotesPath（不存在 selectNotesLocation）。
        // 之前写错方法名后又被 `if (window.electronAPI?.xxx)` 守卫吃掉，
        // 表现为"点了命令面板这一项毫无反应"。
        if (window.electronAPI?.selectNotesPath) {
          try {
            const path = await window.electronAPI.selectNotesPath()
            if (path) {
              appStore?.saveNotesLocation(path)
              const result = await noteStore.loadNotesFromPath(path)
              if (result && result.ok === false && !result.stale) {
                appStore?.pushToast?.({ type: 'error', message: '载入笔记库失败，请确认目录可访问' })
              }
            }
          } catch (error) {
            // 只记诊断；给用户的提示仍走 toast（那是面向用户的输出，不是日志）
            log.error('选择笔记库失败', error)
            appStore?.pushToast?.({ type: 'error', message: '选择笔记库失败：' + (error?.message || error) })
          }
        } else {
          appStore?.pushToast?.({ type: 'info', message: '当前环境不支持选择本地文件夹' })
        }
        closePalette?.()
      }
    })
    push({
      id: 'file:recent',
      section: '文件',
      label: '查看最近打开的笔记',
      keywords: 'recent history 最近 历史',
      icon: Clock,
      action: () => {
        router?.push?.('/notes')
        closePalette?.()
      }
    })
    push({
      id: 'file:export',
      section: '文件',
      label: '导出当前笔记库为 Markdown 压缩包',
      keywords: 'export 导出 backup 备份 download',
      icon: Download,
      action: async () => {
        // 主进程没有 exportNotes IPC，之前点了完全没反应。
        // 这里用浏览器端 zip-less 方案：把每篇笔记打包成一个 .md 合集文件下载，
        // 至少保证"导出"这条路径真的能拿到数据。
        try {
          const notes = noteStore?.notes || []
          if (!notes.length) {
            appStore?.pushToast?.({ type: 'info', message: '没有可导出的笔记' })
            closePalette?.()
            return
          }
          const parts = notes.map(n => {
            const head = `# ${n.title || '无标题'}\n\n> 文件夹：${n.folder || '根目录'}　更新时间：${new Date(n.updatedAt).toLocaleString('zh-CN')}\n\n`
            return `${head}${n.content || ''}\n\n<!-- ${'='.repeat(40)} -->\n\n`
          })
          const blob = new Blob(parts, { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `choyeon-notes-${new Date().toISOString().slice(0, 10)}.md`
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          appStore?.pushToast?.({ type: 'success', message: `已导出 ${notes.length} 篇笔记` })
        } catch (error) {
          log.error('导出失败', error)
          appStore?.pushToast?.({ type: 'error', message: '导出失败：' + (error?.message || error) })
        }
        closePalette?.()
      }
    })

    // ========== 注册表里还没被上面手写条目覆盖的 app 命令 ==========
    // 这一段是本轮新增命令进面板的入口（后退/前进/速查表/右侧面板/阅读模式/实时预览/缩放…）。
    // 只补位、不覆盖：手写条目先入队并占住 id，这里跳过已有的，
    // 因此「打开笔记列表」保留更好读的标签，而不是被注册表的短标签顶掉。
    for (const s of SHORTCUTS) {
      if (s.scope !== 'app' || s.hidden) continue
      if (seen.has(s.id)) continue
      push({
        id: s.id,
        section: CATEGORY_SECTION[s.category] || '视图',
        label: s.label,
        keywords: `${s.id} ${s.label} shortcut hotkey 快捷键`,
        icon: GENERATED_APP_ICON[s.id] || CATEGORY_ICON[s.category] || Command,
        action: runApp(s.id)
      })
    }

    // ========== 注册表里的 editor scope 命令 ==========
    // E-3 硬要求 2：**没有 runner 就整组隐藏**，不显示出来点了报错。
    // 这里读 `appStore.editorRunner`（shallowRef）→ 注册/注销是响应式的，
    // EditorView 挂载 / 卸载后面板下一次打开就是正确的那一份列表。
    // hidden 命令（edit.redoAlt / insert.date）刻意不进面板：它们在设置页也不可见，
    // 面板里出现只会得到两条同名的「重做」。
    if (typeof appStore?.editorRunner === 'function') {
      for (const s of SHORTCUTS) {
        if (s.scope !== 'editor' || s.hidden) continue
        push({
          id: s.id,
          section: CATEGORY_SECTION[s.category] || '编辑',
          label: s.label,
          keywords: `${s.id} ${s.label} shortcut hotkey 快捷键 editor 编辑器`,
          icon: GENERATED_APP_ICON[s.id] || CATEGORY_ICON[s.category] || PenLine,
          action: () => {
            // 先关面板再执行：遮罩关闭后才轮到编辑器拿到焦点，
            // 否则 CodeMirror 的命令作用于当前 view、但焦点还留在已消失的输入框上
            closePalette?.()
            const ok = appStore.runEditorCommand?.(s.id)
            if (!ok) {
              log.warn('编辑器命令未执行（runner 已注销或命令不存在）', { id: s.id })
            }
          }
        })
      }
    }

    // ========== 快速条目：最近笔记（直接跳转） ==========
    const recent = (noteStore?.notes || [])
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 8)

    for (const n of recent) {
      push({
        id: `note:goto:${n.id}`,
        section: '最近笔记',
        label: `打开：${n.title || '未命名笔记'}`,
        keywords: `${n.title || ''} ${(n.tags || []).join(' ')}`,
        icon: FileText,
        action: () => {
          router?.push?.(`/editor/${n.id}`)
          closePalette?.()
        }
      })
    }

    return items
  })

  return { quickActions }
}

/**
 * 子序列命中打分：'gte' 能匹配到 'getEditorTheme'。
 * 子串匹配失败时的兜底——这也是 Obsidian 快速切换器"打几个首字母就能找到"的手感来源。
 * 返回 -1 表示未命中。
 */
function subsequenceScore (hay, token) {
  let qi = 0
  let hit = 0
  let first = -1
  for (let k = 0; k < hay.length && qi < token.length; k++) {
    if (hay[k] === token[qi]) {
      if (first < 0) first = k
      qi++
      hit++
    }
  }
  if (hit !== token.length) return -1
  // 命中位置越靠前越好；子序列得分恒定低于子串，保证精确匹配永远排在前面
  return Math.max(1, 30 - first / 4)
}

/** 单个 token 的得分：优先子串，退而求其次才是子序列 */
function tokenScore (hay, token, labelBonus = 0) {
  const idx = hay.indexOf(token)
  if (idx >= 0) return 100 - idx + labelBonus
  return subsequenceScore(hay, token)
}

/**
 * 对命令列表进行模糊匹配。
 * - 空 q: 原始顺序返回
 * - 否则: 每个 token 必须命中（子串优先，子序列兜底），多 token 累加得分
 */
export function rankCommands(commands, q) {
  const query = (q || '').trim().toLowerCase()
  if (!query) {
    return commands.slice()
  }
  const tokens = query.split(/\s+/).filter(Boolean)
  const scored = []
  for (const cmd of commands) {
    const hay = `${cmd.label} ${cmd.keywords || ''} ${cmd.section || ''}`.toLowerCase()
    const label = String(cmd.label || '').toLowerCase()
    let score = 0
    let ok = true
    for (const t of tokens) {
      const s = tokenScore(hay, t, label.includes(t) ? 40 : 0)
      if (s < 0) { ok = false; break }
      score += s
    }
    if (!ok) continue
    scored.push({ cmd, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.cmd)
}

/**
 * 对笔记列表做快速切换器模糊排名。
 * 空查询时按 MRU（最近打开）排序：记录来自 note 的 updatedAt + 本地最近访问表，
 * 这是 Obsidian 快速切换器的默认排序，比单纯按更新时间更符合"刚看过的先出现"。
 */
const RECENT_NOTE_KEY = 'choyeon-recent-note-ids'

export function markNoteVisited (id) {
  if (!id) return
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_NOTE_KEY) || '[]')
    const list = Array.isArray(raw) ? raw : []
    const next = [id, ...list.filter(x => x !== id)].slice(0, 50)
    localStorage.setItem(RECENT_NOTE_KEY, JSON.stringify(next))
  } catch (e) { /* 存储不可用时忽略，不影响主流程 */ }
}

function recentRank (list) {
  let mru = []
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_NOTE_KEY) || '[]')
    if (Array.isArray(raw)) mru = raw
  } catch (e) { mru = [] }
  const rankOf = (id) => {
    const i = mru.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return list
    .slice()
    .sort((a, b) => {
      const ra = rankOf(a.id)
      const rb = rankOf(b.id)
      // 有访问记录的按 MRU 排；都没记录时退回更新时间
      if (ra !== rb && (ra !== Number.MAX_SAFE_INTEGER || rb !== Number.MAX_SAFE_INTEGER)) {
        return ra - rb
      }
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })
}

export function rankNotes(notes, q) {
  const query = (q || '').trim().toLowerCase()
  const list = Array.isArray(notes) ? notes : []
  if (!query) {
    return recentRank(list).slice(0, 30)
  }
  const tokens = query.split(/\s+/).filter(Boolean)
  const scored = []
  for (const n of list) {
    const hay = `${n.title || ''} ${(n.tags || []).join(' ')} ${n.folder || ''}`.toLowerCase()
    const title = String(n.title || '').toLowerCase()
    let score = 0
    let ok = true
    for (const t of tokens) {
      const s = tokenScore(hay, t, title.includes(t) ? 50 : 0)
      if (s < 0) { ok = false; break }
      score += s
    }
    if (!ok) continue
    scored.push({ note: n, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.note).slice(0, 50)
}
