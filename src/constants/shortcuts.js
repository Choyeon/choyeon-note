/**
 * 全局快捷键注册表 + 绑定串规范化内核。
 *
 * 设计要点：
 * 1. 单一数据源 —— 编辑器命令、应用命令、设置页展示、快捷键冲突检测全部读这里，
 *    避免「设置页显示的快捷键和实际生效的不一致」。
 * 2. 绑定串统一采用 CodeMirror 键位语法：`Mod` = Ctrl(Win/Linux) / Cmd(macOS)。
 *    这样同一份字符串既能喂给 CodeMirror keymap，也能被应用层解析匹配。
 * 3. scope 决定谁负责执行：`editor` 交给 CodeMirror（仅在编辑器聚焦时生效），
 *    `app` 交给 App.vue 的全局监听（任意位置生效）。只有这两个值。
 * 4. 绑定串的比较口径**唯一**：任何比较前都必须先过 `normalizeBinding`。
 *    历史教训：注册表里同时存在 `Shift-Mod-d` 与 `Mod-Shift-d` 两种写法，
 *    而冲突检测做的是字符串全等比较，导致 `edit.duplicateLine` 与 `insert.date`
 *    实际撞键却查不出来。
 *
 * 本轮（T01）相对旧版的**对外契约变化**：只新增导出，不改名、不改语义。
 * 新增：`normalizeBinding` / `CODE_TO_KEY` / `KEY_CANON` / `MODIFIER_ALIASES` /
 *      `MODIFIER_ORDER` / `RESERVED_BINDINGS` / `reservedLevel` / `describeReserved` /
 *      `SHORTCUT_SCOPES`。
 */

import { IS_ELECTRON } from '../utils/env.js'

/** 注册表允许的两个 scope —— 不引入第三种，否则 App.vue 与 CodeMirror 都不知道该谁执行 */
export const SHORTCUT_SCOPES = ['app', 'editor']

export const SHORTCUT_CATEGORIES = [
  { id: 'file', label: '文件与工作空间', icon: 'FolderOpen' },
  { id: 'edit', label: '编辑', icon: 'PenLine' },
  { id: 'format', label: '格式化', icon: 'Type' },
  { id: 'view', label: '视图与导航', icon: 'LayoutDashboard' },
  { id: 'insert', label: '插入', icon: 'Plus' }
]

/**
 * 注册表本体。字段含义：
 * - id：`<域>.<动作>`，域 ∈ {app, edit, format, insert, view}，**必须是执行器表里的同一个 key**，
 *   由 `auditShortcuts()` 保证不出现「死命令 / 野命令」。
 * - scope：'app' | 'editor'（见 SHORTCUT_SCOPES）。
 * - default：CodeMirror 语法的绑定串，**必须已经是 `normalizeBinding` 的规范形式**
 *   （修饰键按 Mod→Ctrl→Meta→Shift→Alt 排序、主键单字符小写 / 多字符用 KEY_CANON 规范名），
 *   否则会被 `auditShortcuts` 判为 `not-normalized`。空串表示该命令默认不绑键。
 * - hidden：不在设置页展示（但仍然可用、仍然占键）。
 */
export const SHORTCUTS = [
  // ---------------- 文件 / 工作空间 ----------------
  { id: 'app.newNote', scope: 'app', category: 'file', label: '新建笔记', default: 'Mod-n' },
  { id: 'app.save', scope: 'app', category: 'file', label: '保存笔记', default: 'Mod-s' },
  { id: 'app.quickSwitcher', scope: 'app', category: 'file', label: '快速跳转', default: 'Mod-o' },
  { id: 'app.commandPalette', scope: 'app', category: 'file', label: '命令面板', default: 'Mod-Shift-p' },
  { id: 'app.vault', scope: 'app', category: 'file', label: '密码本', default: 'Mod-Shift-v' },
  { id: 'app.settings', scope: 'app', category: 'file', label: '打开设置', default: 'Mod-,' },

  // ---------------- 编辑 ----------------
  { id: 'edit.undo', scope: 'editor', category: 'edit', label: '撤销', default: 'Mod-z' },
  { id: 'edit.redo', scope: 'editor', category: 'edit', label: '重做', default: 'Mod-y' },
  // 书写规范化：旧写法 Shift-Mod-z → Mod-Shift-z（键位本身没变，老用户数据不受影响）
  { id: 'edit.redoAlt', scope: 'editor', category: 'edit', label: '重做（备选）', default: 'Mod-Shift-z', hidden: true },
  { id: 'edit.selectAll', scope: 'editor', category: 'edit', label: '全选', default: 'Mod-a' },
  { id: 'edit.indent', scope: 'editor', category: 'edit', label: '增加缩进', default: 'Tab' },
  { id: 'edit.outdent', scope: 'editor', category: 'edit', label: '减少缩进', default: 'Shift-Tab' },
  { id: 'edit.moveLineUp', scope: 'editor', category: 'edit', label: '上移当前行', default: 'Alt-ArrowUp' },
  { id: 'edit.moveLineDown', scope: 'editor', category: 'edit', label: '下移当前行', default: 'Alt-ArrowDown' },
  // 书写规范化：旧写法 Shift-Mod-d → Mod-Shift-d（键位不变，仅统一比较口径）
  { id: 'edit.duplicateLine', scope: 'editor', category: 'edit', label: '复制当前行', default: 'Mod-Shift-d' },
  { id: 'edit.deleteLine', scope: 'editor', category: 'edit', label: '删除当前行', default: 'Mod-Shift-k' },
  { id: 'edit.insertLineBelow', scope: 'editor', category: 'edit', label: '下方插入空行', default: 'Mod-Enter' },
  // 原 Mod-Enter 与 edit.insertLineBelow 完全撞键且被其遮蔽 → 改 Mod-Shift-Enter 并转正（取消 hidden）
  { id: 'edit.toggleTask', scope: 'editor', category: 'edit', label: '切换待办状态', default: 'Mod-Shift-Enter' },

  // ---------------- 格式化 ----------------
  { id: 'format.bold', scope: 'editor', category: 'format', label: '加粗', default: 'Mod-b' },
  { id: 'format.italic', scope: 'editor', category: 'format', label: '斜体', default: 'Mod-i' },
  { id: 'format.underline', scope: 'editor', category: 'format', label: '下划线', default: 'Mod-u' },
  { id: 'format.highlight', scope: 'editor', category: 'format', label: '高亮', default: 'Mod-Shift-h' },
  { id: 'format.strikethrough', scope: 'editor', category: 'format', label: '删除线', default: 'Mod-Shift-x' },
  { id: 'format.code', scope: 'editor', category: 'format', label: '行内代码', default: 'Mod-e' },
  { id: 'format.link', scope: 'editor', category: 'format', label: '链接', default: 'Mod-k' },
  { id: 'format.h1', scope: 'editor', category: 'format', label: '一级标题', default: 'Mod-Alt-1' },
  { id: 'format.h2', scope: 'editor', category: 'format', label: '二级标题', default: 'Mod-Alt-2' },
  { id: 'format.h3', scope: 'editor', category: 'format', label: '三级标题', default: 'Mod-Alt-3' },
  { id: 'format.h4', scope: 'editor', category: 'format', label: '四级标题', default: 'Mod-Alt-4' },
  // h5 / h6：执行器（EDITOR_COMMANDS）早就有，只是注册表漏登记 → 之前用户改不了键也搜不到
  { id: 'format.h5', scope: 'editor', category: 'format', label: '五级标题', default: 'Mod-Alt-5' },
  { id: 'format.h6', scope: 'editor', category: 'format', label: '六级标题', default: 'Mod-Alt-6' },
  { id: 'format.quote', scope: 'editor', category: 'format', label: '引用', default: 'Mod-Shift-b' },
  { id: 'format.bulletList', scope: 'editor', category: 'format', label: '无序列表', default: 'Mod-Shift-8' },
  { id: 'format.orderedList', scope: 'editor', category: 'format', label: '有序列表', default: 'Mod-Shift-7' },
  { id: 'format.taskList', scope: 'editor', category: 'format', label: '待办列表', default: 'Mod-Shift-9' },

  // ---------------- 插入 ----------------
  { id: 'insert.codeBlock', scope: 'editor', category: 'insert', label: '代码块', default: 'Mod-Alt-c' },
  // 结尾两个短横：主键就是 `-`，任何解析器都不能把它当分隔符吃掉
  { id: 'insert.divider', scope: 'editor', category: 'insert', label: '分隔线', default: 'Mod-Alt--' },
  // 原 Mod-Shift-d 与 edit.duplicateLine 撞键 → 改 Mod-Alt-d（保持 hidden）
  { id: 'insert.date', scope: 'editor', category: 'insert', label: '插入当前日期', default: 'Mod-Alt-d', hidden: true },
  { id: 'insert.wikiLink', scope: 'editor', category: 'insert', label: '插入双链 [[]]', default: 'Mod-Shift-l' },
  // insert.table / insert.time：执行器已有，注册表漏登记 → 收编
  { id: 'insert.table', scope: 'editor', category: 'insert', label: '插入表格（3×3）', default: 'Mod-Alt-t' },
  { id: 'insert.time', scope: 'editor', category: 'insert', label: '插入当前时间', default: '' },
  // callout / tag：默认不绑键（对标 Obsidian「很多命令无默认键」），命令面板与速查表可用
  { id: 'insert.callout', scope: 'editor', category: 'insert', label: '插入 Callout', default: '' },
  { id: 'insert.tag', scope: 'editor', category: 'insert', label: '插入标签', default: '' },

  // ---------------- 视图 / 导航 ----------------
  { id: 'view.toggleSidebar', scope: 'app', category: 'view', label: '切换侧边栏', default: 'Mod-\\' },
  // scope: editor → app。原先靠 EditorView.vue 里手写的字符串比对 hack 兜底，现在由 APP_ACTIONS 统一调度，
  // 非编辑器页面按下也会直接改全局 editorMode（持久化状态，语义上不存在「当前页面不适用」）
  { id: 'view.readingMode', scope: 'app', category: 'view', label: '切换阅读模式', default: 'Mod-Shift-e' },
  // scope: editor → app + 取消 hidden + 改默认键：原 Mod-Shift-l 与 insert.wikiLink 撞键
  { id: 'view.liveMode', scope: 'app', category: 'view', label: '切换实时预览', default: 'Mod-Alt-l' },
  { id: 'view.graph', scope: 'app', category: 'view', label: '关系图谱', default: 'Mod-Shift-g' },
  // 原 Mod-Shift-c 在 Chromium 是「检查元素」，DevTools 打开时不可拦截 → 改 Mod-Alt-k
  { id: 'view.calendar', scope: 'app', category: 'view', label: '日历视图', default: 'Mod-Alt-k' },
  { id: 'view.search', scope: 'app', category: 'view', label: '搜索笔记', default: 'Mod-Shift-f' },
  { id: 'view.toggleTheme', scope: 'app', category: 'view', label: '切换明暗主题', default: 'Mod-Shift-t' },
  { id: 'app.navigateBack', scope: 'app', category: 'view', label: '导航后退', default: 'Mod-Alt-ArrowLeft' },
  { id: 'app.navigateForward', scope: 'app', category: 'view', label: '导航前进', default: 'Mod-Alt-ArrowRight' },
  { id: 'view.toggleRightPanel', scope: 'app', category: 'view', label: '切换右侧面板', default: 'Mod-Alt-r' },
  // 标签必须含「正文」：这三个改的是编辑器字号，与 Electron 菜单 role: zoomIn 缩放的是整个窗口，两者并存不冲突
  { id: 'view.zoomIn', scope: 'app', category: 'view', label: '放大正文', default: 'Mod-=' },
  { id: 'view.zoomOut', scope: 'app', category: 'view', label: '缩小正文', default: 'Mod--' },
  { id: 'view.zoomReset', scope: 'app', category: 'view', label: '重置正文缩放', default: 'Mod-0' },
  // 路由类命令默认不绑键，避免键位污染；命令面板 / 速查表可搜到
  { id: 'view.notes', scope: 'app', category: 'view', label: '笔记列表', default: '' },
  { id: 'view.tags', scope: 'app', category: 'view', label: '标签视图', default: '' },
  { id: 'app.shortcutCheatsheet', scope: 'app', category: 'view', label: '快捷键速查表', default: 'Mod-/' }
]

export const SHORTCUT_MAP = Object.fromEntries(SHORTCUTS.map(s => [s.id, s]))

export const isMac =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')

// -----------------------------------------------------------------------------
// 绑定串规范化 —— 全项目唯一的比较口径
// -----------------------------------------------------------------------------

/**
 * 修饰键别名 → 规范名。
 *
 * 注意 `Ctrl` / `Meta` **刻意不并入 `Mod`**：`Mod` 的语义是「Ctrl(Win) / Cmd(mac)」，
 * 而 `Meta` 在 Windows 上是 Win 键，二者不是一回事。注册表与录制器都只产出
 * `Mod / Shift / Alt`，`Ctrl` / `Meta` 只是为兼容用户手改 localStorage 的历史数据保留位次。
 */
export const MODIFIER_ALIASES = {
  mod: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  meta: 'Meta',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt'
}

/** 修饰键在绑定串里的固定排序 —— 升序按规定序，保证同一种组合只有一种字符串写法 */
export const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt']

/**
 * 多字符主键 → 规范名（查表键一律小写）。
 * 未命中的多字符主键**原样返回**，不猜大小写 —— 宁可比不出相等，也不要把
 * `Arrowup`（用户笔误）悄悄变成 `ArrowUp` 从而掩盖真实错误。
 */
export const KEY_CANON = {
  escape: 'Escape',
  esc: 'Escape',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  backspace: 'Backspace',
  space: 'Space',
  spacebar: 'Space',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  contextmenu: 'ContextMenu'
}

/**
 * 把任意写法的绑定串整理成唯一规范形式：`Mod-Ctrl-Meta-Shift-Alt-<主键>`。
 *
 * 为什么必须有它：同一组合存在多种等价写法（`Shift-Mod-d` vs `Mod-Shift-d`、
 * `MOD-SHIFT-D` vs `Mod-Shift-d`、`Ctrl+Alt+X` vs `Ctrl-Alt-x`），只要还有一处做
 * 裸字符串比较，冲突检测 / 键位匹配 / 重复判定就会漏判。
 *
 * 算法（六步，顺序不可换）：
 * 1. 非 string / trim 后为空 → `''`
 * 2. 分隔符归一：**仅当串中不含 `-`** 时才把 `+` 换成 `-`。
 *    含 `-` 时绝不能按 `+` 切，否则 `Mod-+`（主键是加号）会被切成 `['Mod','+']` 之外的形状。
 * 3. 左→右按 `-` 切分，连续吃修饰键；**遇到第一个非修饰键片段立刻停止**，
 *    其后所有片段用 `-` 重新 join 成主键 —— 这是 `Mod-Alt--`（分隔线）与
 *    `Mod--`（缩小正文）能被正确还原的关键：它们切分后尾部是空串，join 回 `-`。
 * 4. 主键归一：长度 1 → 转小写；长度 > 1 → 先小写查 KEY_CANON，未命中则原样返回。
 * 5. 修饰键去重后按 MODIFIER_ORDER 排序。
 * 6. 主键为空（`Mod-`、`Mod-Alt-`）→ 返回 `''`，调用方把它当成「非法绑定」。
 *
 * **必须幂等**：`normalizeBinding(normalizeBinding(x)) === normalizeBinding(x)`。
 * 幂等性一旦破坏，录制 → 比较 → 再录制会逐次漂移，键位永远无法重录回默认值。
 *
 * @param {unknown} binding 任意输入（允许非 string，方便直接喂 DOM / localStorage 的脏值）
 * @returns {string} 规范串；`''` 表示空值或非法（主键缺失）
 */
export function normalizeBinding (binding) {
  if (typeof binding !== 'string') return ''
  const trimmed = binding.trim()
  if (!trimmed) return ''

  // 步骤 2：只在完全没有 `-` 时才认 `+` 作为分隔符
  const raw = (!trimmed.includes('-') && trimmed.includes('+')) ? trimmed.split('+').join('-') : trimmed

  const pieces = raw.split('-')
  const mods = []
  let cursor = 0
  for (; cursor < pieces.length; cursor += 1) {
    const canonical = MODIFIER_ALIASES[pieces[cursor].toLowerCase()]
    if (!canonical) break
    if (!mods.includes(canonical)) mods.push(canonical) // 重复修饰符去重：`Mod-Mod-a` → `Mod-a`
  }

  // 步骤 3：停止位置之后的全部片段（可能含空串）重新拼成主键
  const rawMain = pieces.slice(cursor).join('-')
  if (!rawMain) return '' // `Mod-` / `Mod-Alt-` —— 缺主键

  // 步骤 4：主键归一
  const lowerMain = rawMain.toLowerCase()
  const mainKey = rawMain.length === 1 ? lowerMain : (KEY_CANON[lowerMain] ?? rawMain)
  if (!mainKey) return ''

  // 步骤 5：修饰键按规定序排序
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))

  return [...mods, mainKey].join('-')
}

// -----------------------------------------------------------------------------
// 键盘事件 → 绑定串
// -----------------------------------------------------------------------------

/**
 * `event.code`（物理键位）→ 主键串。
 *
 * 为什么必须反查 code：Shift 会改写 `event.key` —— `Ctrl+Shift+8` 的 `key` 是 `'*'`、
 * `Ctrl+Shift+,` 是 `'<'`。旧版 `eventToBinding` 直接吃 `event.key`，于是用户录出来的
 * `Mod-Shift-*` 与注册表里的 `Mod-Shift-8`（无序列表）永远对不上：键既录不准，也重录不回默认。
 * `code` 标示物理键，不受 Shift / 输入法影响，是唯一稳定的反查依据。
 *
 * 为什么不做「布局自检」（拿 `event.key` 校验映射值是否吻合）：一旦校验失败就回落 `event.key`，
 * 会出现「同一物理键两次录制得到不同串」的漂移。无条件用 code 是自洽的 ——
 * 显示的是物理键名，用户下次按同一物理键仍得到同一串。非 US 布局的正确显示属于 P2，本轮不做。
 */
export const CODE_TO_KEY = {
  // 数字行
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Minus: '-',
  Equal: '=',
  // 字母区
  KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f', KeyG: 'g',
  KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l', KeyM: 'm', KeyN: 'n',
  KeyO: 'o', KeyP: 'p', KeyQ: 'q', KeyR: 'r', KeyS: 's', KeyT: 't', KeyU: 'u',
  KeyV: 'v', KeyW: 'w', KeyX: 'x', KeyY: 'y', KeyZ: 'z',
  // 符号区
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  // 控制 / 导航
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ContextMenu: 'ContextMenu'
}

/** 单独按下不构成快捷键的键 —— 必须拦掉，否则按下 Ctrl 就会录出一个「Mod-Control」 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'OS'])

/**
 * 解析主键：优先 `event.code` 反查，取不到才回落 `event.key`。
 *
 * 回落场景（都是合理且必须兜住的）：
 * - `event.code` 为空 / undefined：jsdom 合成事件、部分自动化事件；
 * - `event.code` 不在表内：Numpad*、IntlBackslash、MediaPlayPause、厂商私有 code；
 * - `event.code` 命中但 `event.key` 是表外多字符名（`F13`、`LaunchApp1`）：由调用键决定，这里原样返回。
 *
 * @param {KeyboardEvent} event
 * @returns {string} 主键串
 */
function resolveMainKey (event) {
  const code = event.code
  if (code && Object.prototype.hasOwnProperty.call(CODE_TO_KEY, code)) {
    return CODE_TO_KEY[code]
  }
  const key = event.key
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toLowerCase()
  return KEY_CANON[key.toLowerCase()] ?? key
}

/**
 * 把绑定串拆成「修饰键 + 主键」的标签数组，供设置页渲染成一个个按键胶囊。
 * 与 formatBinding 共用同一套映射，保证展示和实际生效永远一致。
 *
 * ============ T06 修复：切分口径改为与 `normalizeBinding` 完全一致 ============
 * 旧实现是另一套切分：`raw.replace(/--$/, '').split('-').slice(0, -1)`。
 * 它先把 `Mod-Alt--` 削成 `Mod-Alt`，再切掉末段得到 `['Mod']` —— 于是 `Alt` 被吞掉，
 * 「插入分隔线」在设置页只显示成 `Ctrl -`（少一个修饰键，用户以为默认键是 Ctrl+-）。
 *
 * 现在的算法（与规范化器同源，不另起一套）：
 * 1. 按 `-` 切分；2. **从头连续吃修饰键**，遇到第一个非修饰键片段**立刻停止**；
 * 3. 停止位置之后的全部片段（可能含空串）用 `-` 重新 join 成主键。
 * 第 3 步正是 `Mod-Alt--` / `Mod--` 能被正确还原的关键：尾部空串 join 回来正好是 `-`。
 *
 * 刻意**不**在这里做修饰键排序 / 去重 / 主键小写化：本函数是纯展示层，
 * 注册表 default 已由 `auditShortcuts` 保证是规范形式，多做一步只会把老用户
 * localStorage 里的 `Shift-Mod-d` 这类原文悄悄改写，反而更难排查。
 *
 * @param {string} binding CodeMirror 语法的绑定串
 * @returns {string[]} 按键标签数组（修饰键在前、主键在后）；空绑定返回 []
 */
export function bindingParts (binding) {
  if (!binding) return []
  const raw = String(binding)
  const pieces = raw.split('-')
  // 修饰键集合直接复用规范化器的别名表 —— 两处各写一份必然漂移
  const mods = []
  let cursor = 0
  for (; cursor < pieces.length; cursor += 1) {
    if (!MODIFIER_ALIASES[pieces[cursor].toLowerCase()]) break
    mods.push(pieces[cursor])
  }
  // 停止位置之后的全部片段重新拼成主键（'Mod-Alt--' → 尾部 ['',''] → '-'）
  const key = pieces.slice(cursor).join('-')
  if (!key) return [] // 只有修饰键、没有主键 —— 不是合法绑定，不渲染
  const modLabels = mods.map(m => {
    if (m === 'Mod') return isMac ? '⌘' : 'Ctrl'
    if (m === 'Shift') return isMac ? '⇧' : 'Shift'
    if (m === 'Alt') return isMac ? '⌥' : 'Alt'
    if (m === 'Ctrl') return isMac ? '⌃' : 'Ctrl'
    if (m === 'Meta') return '⌘'
    return m
  })
  const keyLabel =
    key === 'Enter' ? (isMac ? '↩' : 'Enter') :
    key === 'ArrowUp' ? '↑' :
    key === 'ArrowDown' ? '↓' :
    key === 'ArrowLeft' ? '←' :
    key === 'ArrowRight' ? '→' :
    key === 'Space' ? '空格' :
    key.length === 1 ? key.toUpperCase() : key
  return [...modLabels, keyLabel]
}

/** 把 CodeMirror 绑定串渲染成人类可读的按键提示 */
export function formatBinding (binding) {
  const parts = bindingParts(binding)
  if (parts.length === 0) return '未设置'
  return isMac ? parts.join('') : parts.join('+')
}

/**
 * 解析一次键盘事件，产出规范化绑定串（顺序固定：Mod-Ctrl-Meta-Shift-Alt-Key）。
 * 与 CodeMirror 的语法保持同构，便于双向比较。
 *
 * 返回 `null` 表示「这次按键不构成快捷键」，调用方应直接放行不做任何处理。
 * 关键验收：录制 `Ctrl+Shift+8` 时 `event.key === '*'`、`event.code === 'Digit8'`
 * → 返回 `'Mod-Shift-8'`，与 `format.bulletList` 的 default 字符串相等。
 *
 * @param {KeyboardEvent} event
 * @returns {string | null}
 */
export function eventToBinding (event) {
  if (!event || !event.key) return null
  // 长按：不重复触发（速查表 Mod-/ 这种易长按的键尤其明显）
  if (event.repeat === true) return null
  // IME 组字中：中日韩输入法下 event.key 是临时值（且多数浏览器把 keyCode 置 229），
  // 此时录出来的键毫无意义，甚至会吞掉候选词的上/下/回车控制
  if (event.isComposing === true || event.keyCode === 229) return null
  // 死键：组合音标用的中间态，同样不构成快捷键
  if (event.key === 'Dead') return null
  if (MODIFIER_KEYS.has(event.key)) return null

  const mods = []
  if (event.ctrlKey || event.metaKey) mods.push('Mod')
  if (event.shiftKey) mods.push('Shift')
  if (event.altKey) mods.push('Alt')

  const mainKey = resolveMainKey(event)
  if (!mainKey) return null

  // 统一出口：无论主键来自 code 反查还是 key 回落，都过一遍规范器，保证产出串天然是规范序
  return normalizeBinding([...mods, mainKey].join('-'))
}

// -----------------------------------------------------------------------------
// 保留键（系统 / 浏览器 / CodeMirror 占用）
// -----------------------------------------------------------------------------

/**
 * 保留键三级清单，值是对用户展示的原因。
 *
 * 为什么要分级：一刀切「硬拒绝」会误杀自己的默认键 —— `Mod-n` 是 `app.newNote` 的默认键，
 * 它在 Chromium 里确实新建窗口不可拦截，但在 Electron 里菜单已经让路（方案 A），
 * renderer 完全可以接管。因此把「仅浏览器环境不可拦截」的键单列 `browserOnly`，
 * 只在非 Electron 环境才升级为硬拒绝。
 *
 * - hard：任何环境都不可拦截，override 也无效（操作系统级）。
 * - browserOnly：仅非 Electron 环境升级为 hard；Electron 下放行。
 * - warn：允许写入，但设置页 / 速查表给出提示（多为「抢了基础编辑键」这类可用性风险）。
 */
export const RESERVED_BINDINGS = {
  hard: {
    'Mod-w': '系统保留：关闭窗口（不可拦截）',
    'Mod-q': '系统保留：退出应用（不可拦截）',
    'Mod-Shift-w': '系统保留：关闭窗口（不可拦截）',
    'Mod-Shift-q': '系统保留：退出应用（不可拦截）',
    'Mod-t': '浏览器保留：新建标签页（不可拦截）',
    'Mod-Shift-t': '浏览器保留：恢复关闭的标签页（不可拦截）',
    'Mod-Shift-n': '浏览器保留：新建隐身窗口（不可拦截）',
    F11: '系统保留：全屏切换'
  },
  browserOnly: {
    // Electron 下 Ctrl+N 已被 app.newNote 占用（菜单已让路），**不能**自杀式硬拒绝
    'Mod-n': '浏览器保留：新建窗口（Electron 下已释放）',
    'Mod-Shift-i': '浏览器保留：开发者工具（Electron 下已释放）',
    'Mod-Shift-j': '浏览器保留：开发者工具（Electron 下已释放）',
    'Mod-Shift-c': '浏览器保留：检查元素（Electron 下已释放）'
  },
  warn: {
    Escape: '保留键：会阻断关闭模态 / 取消操作',
    Enter: '保留键：会阻断换行与确认',
    Backspace: '保留键：会阻断删除',
    Delete: '保留键：会阻断删除',
    Tab: '保留键：会阻断键盘焦点移动（无障碍）',
    'Shift-Tab': '保留键：会阻断键盘反向焦点移动（无障碍）',
    'Mod-f': '保留键：编辑器内查找由 CodeMirror 提供',
    'Mod-p': '保留键：系统打印习惯',
    'Mod-a': '系统级行为：全选（Electron 菜单 role 可能重复触发）',
    'Mod-c': '系统级行为：复制',
    'Mod-v': '系统级行为：粘贴',
    'Mod-x': '系统级行为：剪切',
    'Mod-z': '系统级行为：撤销（Electron 菜单 role 可能重复触发）',
    'Mod-y': '系统级行为：重做（Electron 菜单 role 可能重复触发）',
    'Mod-=': '浏览器中可能被浏览器缩放占用',
    'Mod--': '浏览器中可能被浏览器缩放占用',
    'Mod-0': '浏览器中可能被浏览器重置缩放占用',
    F5: '浏览器保留：刷新',
    F12: '浏览器保留：开发者工具'
  }
}

/**
 * 判定一个绑定串的保留级别。
 *
 * 判定顺序：hard（任何环境）→ browserOnly（仅非 Electron）→ warn → null。
 *
 * @param {string} binding 任意写法的绑定串（内部会过 normalizeBinding）
 * @param {{ isElectron?: boolean }} [options] 缺省取 `IS_ELECTRON`；测试里可显式传布尔值切换环境
 * @returns {'hard' | 'warn' | null} `browserOnly` 在非 Electron 下被提升为 `'hard'`
 */
export function reservedLevel (binding, options = {}) {
  const { isElectron = IS_ELECTRON } = options
  const key = normalizeBinding(binding)
  if (!key) return null
  if (RESERVED_BINDINGS.hard[key]) return 'hard'
  if (!isElectron && RESERVED_BINDINGS.browserOnly[key]) return 'hard'
  if (RESERVED_BINDINGS.warn[key]) return 'warn'
  return null
}

/**
 * 同上，但额外返回给用户看的原因文案。
 *
 * @param {string} binding
 * @param {{ isElectron?: boolean }} [options]
 * @returns {{ level: 'hard' | 'warn' | null, reason: string }}
 */
export function describeReserved (binding, options = {}) {
  const { isElectron = IS_ELECTRON } = options
  const key = normalizeBinding(binding)
  if (!key) return { level: null, reason: '' }
  if (RESERVED_BINDINGS.hard[key]) return { level: 'hard', reason: RESERVED_BINDINGS.hard[key] }
  if (!isElectron && RESERVED_BINDINGS.browserOnly[key]) {
    return { level: 'hard', reason: RESERVED_BINDINGS.browserOnly[key] }
  }
  if (RESERVED_BINDINGS.warn[key]) return { level: 'warn', reason: RESERVED_BINDINGS.warn[key] }
  return { level: null, reason: '' }
}

/** 默认键位表：key = 命令 id，value = default 绑定串（已是规范形式，供 persist / merge 使用） */
export function createDefaultBindings () {
  return Object.fromEntries(SHORTCUTS.map(s => [s.id, s.default]))
}
