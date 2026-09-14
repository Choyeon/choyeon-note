/**
 * 全局快捷键注册表。
 *
 * 设计要点：
 * 1. 单一数据源 —— 编辑器命令、应用命令、设置页展示、快捷键冲突检测全部读这里，
 *    避免「设置页显示的快捷键和实际生效的不一致」。
 * 2. 绑定串统一采用 CodeMirror 键位语法：`Mod` = Ctrl(Win/Linux) / Cmd(macOS)。
 *    这样同一份字符串既能喂给 CodeMirror keymap，也能被应用层解析匹配。
 * 3. scope 决定谁负责执行：`editor` 交给 CodeMirror（仅在编辑器聚焦时生效），
 *    `app` 交给 App.vue 的全局监听（任意位置生效）。
 */

export const SHORTCUT_CATEGORIES = [
  { id: 'file', label: '文件与工作空间', icon: 'FolderOpen' },
  { id: 'edit', label: '编辑', icon: 'PenLine' },
  { id: 'format', label: '格式化', icon: 'Type' },
  { id: 'view', label: '视图与导航', icon: 'LayoutDashboard' },
  { id: 'insert', label: '插入', icon: 'Plus' }
]

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
  { id: 'edit.redoAlt', scope: 'editor', category: 'edit', label: '重做（备选）', default: 'Shift-Mod-z', hidden: true },
  { id: 'edit.selectAll', scope: 'editor', category: 'edit', label: '全选', default: 'Mod-a' },
  { id: 'edit.indent', scope: 'editor', category: 'edit', label: '增加缩进', default: 'Tab' },
  { id: 'edit.outdent', scope: 'editor', category: 'edit', label: '减少缩进', default: 'Shift-Tab' },
  { id: 'edit.moveLineUp', scope: 'editor', category: 'edit', label: '上移当前行', default: 'Alt-ArrowUp' },
  { id: 'edit.moveLineDown', scope: 'editor', category: 'edit', label: '下移当前行', default: 'Alt-ArrowDown' },
  { id: 'edit.duplicateLine', scope: 'editor', category: 'edit', label: '复制当前行', default: 'Shift-Mod-d' },
  { id: 'edit.deleteLine', scope: 'editor', category: 'edit', label: '删除当前行', default: 'Mod-Shift-k' },
  { id: 'edit.insertLineBelow', scope: 'editor', category: 'edit', label: '下方插入空行', default: 'Mod-Enter' },
  { id: 'edit.toggleTask', scope: 'editor', category: 'edit', label: '切换待办状态', default: 'Mod-Enter', hidden: true },

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
  { id: 'format.quote', scope: 'editor', category: 'format', label: '引用', default: 'Mod-Shift-b' },
  { id: 'format.bulletList', scope: 'editor', category: 'format', label: '无序列表', default: 'Mod-Shift-8' },
  { id: 'format.orderedList', scope: 'editor', category: 'format', label: '有序列表', default: 'Mod-Shift-7' },
  { id: 'format.taskList', scope: 'editor', category: 'format', label: '待办列表', default: 'Mod-Shift-9' },

  // ---------------- 插入 ----------------
  { id: 'insert.codeBlock', scope: 'editor', category: 'insert', label: '代码块', default: 'Mod-Alt-c' },
  { id: 'insert.divider', scope: 'editor', category: 'insert', label: '分隔线', default: 'Mod-Alt--' },
  { id: 'insert.date', scope: 'editor', category: 'insert', label: '插入当前日期', default: 'Mod-Shift-d', hidden: true },
  { id: 'insert.wikiLink', scope: 'editor', category: 'insert', label: '插入双链 [[]]', default: 'Mod-Shift-l' },

  // ---------------- 视图 / 导航 ----------------
  { id: 'view.toggleSidebar', scope: 'app', category: 'view', label: '切换侧边栏', default: 'Mod-\\' },
  { id: 'view.readingMode', scope: 'editor', category: 'view', label: '切换阅读模式', default: 'Mod-Shift-e' },
  { id: 'view.liveMode', scope: 'editor', category: 'view', label: '切换实时预览', default: 'Mod-Shift-l', hidden: true },
  { id: 'view.graph', scope: 'app', category: 'view', label: '关系图谱', default: 'Mod-Shift-g' },
  { id: 'view.calendar', scope: 'app', category: 'view', label: '日历视图', default: 'Mod-Shift-c' },
  { id: 'view.search', scope: 'app', category: 'view', label: '搜索笔记', default: 'Mod-Shift-f' },
  { id: 'view.toggleTheme', scope: 'app', category: 'view', label: '切换明暗主题', default: 'Mod-Shift-t' }
]

export const SHORTCUT_MAP = Object.fromEntries(SHORTCUTS.map(s => [s.id, s]))

export const isMac =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')

/**
 * 把绑定串拆成「修饰键 + 主键」的标签数组，供设置页渲染成一个个按键胶囊。
 * 与 formatBinding 共用同一套映射，保证展示和实际生效永远一致。
 */
export function bindingParts(binding) {
  if (!binding) return []
  const raw = String(binding)
  // 'Mod-Alt--'（分隔线）结尾是两个短横，split 会吃掉主键，这里特殊还原
  const key = raw.endsWith('--') ? '-' : raw.split('-').pop()
  const mods = raw.replace(/--$/, '').split('-').slice(0, -1)
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
export function formatBinding(binding) {
  const parts = bindingParts(binding)
  if (parts.length === 0) return '未设置'
  return isMac ? parts.join('') : parts.join('+')
}

/**
 * 解析一次键盘事件，产出规范化绑定串（顺序固定：Mod-Shift-Alt-Key）。
 * 与 CodeMirror 的语法保持同构，便于双向比较。
 */
export function eventToBinding(event) {
  const key = event.key
  if (!key) return null
  // 单独按下修饰键不构成快捷键
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null

  const mods = []
  if (event.ctrlKey || event.metaKey) mods.push('Mod')
  if (event.shiftKey) mods.push('Shift')
  if (event.altKey) mods.push('Alt')

  let normalizedKey = key
  if (key === ' ') normalizedKey = 'Space'
  else if (key.length === 1) normalizedKey = key.toLowerCase()

  // Shift 会改变数字/符号键的 key 值（如 Shift+8 => '*'），无法还原，
  // 这里保留原始 key，配合 default 定义中的显式写法使用
  return [...mods, normalizedKey].join('-')
}

export function createDefaultBindings() {
  return Object.fromEntries(SHORTCUTS.map(s => [s.id, s.default]))
}
