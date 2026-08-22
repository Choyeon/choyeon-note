import { computed } from 'vue'
import {
  FileText,
  FolderPlus,
  Search,
  Settings,
  Calendar,
  Network,
  Tags,
  List,
  Sun,
  Moon,
  Monitor,
  PanelLeft,
  Type,
  Sparkles,
  Save,
  FilePlus2,
  Clock,
  Bookmark,
  Palette,
  Download,
  UploadCloud
} from 'lucide-vue-next'

/**
 * 全局命令聚合器。
 * 命令面板 (CommandPalette) 使用该 composable 生成可执行命令列表。
 * 每个命令具有: id / label / keywords(搜索辅助) / icon / action / section
 */
export function useCommands({ appStore, noteStore, router, openQuickSwitcher, closePalette }) {
  const quickActions = computed(() => {
    const items = []

    // ========== 视图导航 ==========
    items.push({
      id: 'view:notes',
      section: '视图',
      label: '打开笔记列表',
      keywords: 'notes list 笔记 列表 all files',
      icon: List,
      action: () => {
        router.push('/notes')
        closePalette?.()
      }
    })
    items.push({
      id: 'view:tags',
      section: '视图',
      label: '打开标签视图',
      keywords: 'tags 标签',
      icon: Tags,
      action: () => {
        router.push('/tags')
        closePalette?.()
      }
    })
    items.push({
      id: 'view:calendar',
      section: '视图',
      label: '打开日历视图',
      keywords: 'calendar 日历 daily',
      icon: Calendar,
      action: () => {
        router.push('/calendar')
        closePalette?.()
      }
    })
    items.push({
      id: 'view:graph',
      section: '视图',
      label: '打开关系图谱',
      keywords: 'graph 图谱 backlinks 关系',
      icon: Network,
      action: () => {
        router.push('/graph')
        closePalette?.()
      }
    })
    items.push({
      id: 'view:search',
      section: '视图',
      label: '全局搜索',
      keywords: 'search 搜索 find 查找 ctrl+f cmd+k',
      icon: Search,
      action: () => {
        router.push('/search')
        closePalette?.()
      }
    })
    items.push({
      id: 'view:settings',
      section: '视图',
      label: '打开设置',
      keywords: 'settings 设置 preferences 选项',
      icon: Settings,
      action: () => {
        router.push('/settings')
        closePalette?.()
      }
    })

    // ========== 笔记操作 ==========
    items.push({
      id: 'note:new',
      section: '笔记',
      label: '新建笔记',
      keywords: 'new note create 新建 笔记',
      icon: FilePlus2,
      action: () => {
        const note = noteStore.createNote('', '新笔记')
        router.push(`/editor/${note.id}`)
        closePalette?.()
      }
    })
    items.push({
      id: 'note:new-folder',
      section: '笔记',
      label: '在根目录新建文件夹',
      keywords: 'new folder 新建 文件夹',
      icon: FolderPlus,
      action: () => {
        noteStore.createFolderAtRoot && noteStore.createFolderAtRoot()
        router.push('/notes')
        closePalette?.()
      }
    })
    items.push({
      id: 'note:quick-switch',
      section: '笔记',
      label: '快速切换器：按标题跳转笔记',
      keywords: 'quick switcher open 打开 跳转 goto 快速',
      icon: Bookmark,
      action: () => {
        closePalette?.()
        openQuickSwitcher?.()
      }
    })
    items.push({
      id: 'note:save-current',
      section: '笔记',
      label: '保存当前笔记',
      keywords: 'save flush 保存',
      icon: Save,
      action: () => {
        if (noteStore.currentNote?.id) {
          noteStore.flushSave?.(noteStore.currentNote.id)
        }
        closePalette?.()
      }
    })

    // ========== 外观 / 界面 ==========
    items.push({
      id: 'theme:light',
      section: '外观',
      label: '切换到亮色主题',
      keywords: 'theme light 亮色 白天',
      icon: Sun,
      action: () => {
        appStore.setTheme('light')
        closePalette?.()
      }
    })
    items.push({
      id: 'theme:dark',
      section: '外观',
      label: '切换到暗色主题',
      keywords: 'theme dark 暗色 夜晚',
      icon: Moon,
      action: () => {
        appStore.setTheme('dark')
        closePalette?.()
      }
    })
    items.push({
      id: 'theme:system',
      section: '外观',
      label: '跟随系统主题',
      keywords: 'theme system 系统 default 默认',
      icon: Monitor,
      action: () => {
        appStore.setTheme('system')
        closePalette?.()
      }
    })
    items.push({
      id: 'theme:toggle',
      section: '外观',
      label: '切换亮/暗主题',
      keywords: 'toggle theme 切换',
      icon: Sparkles,
      action: () => {
        appStore.toggleTheme()
        closePalette?.()
      }
    })
    items.push({
      id: 'ui:toggle-sidebar',
      section: '外观',
      label: '显示/隐藏侧边栏',
      keywords: 'sidebar 侧边栏 panel 面板',
      icon: PanelLeft,
      action: () => {
        appStore.toggleSidebar()
        closePalette?.()
      }
    })
    items.push({
      id: 'ui:toggle-glass',
      section: '外观',
      label: '开关毛玻璃效果',
      keywords: 'glass acrylic 毛玻璃 透明',
      icon: Palette,
      action: () => {
        appStore.toggleGlassEffect()
        closePalette?.()
      }
    })
    items.push({
      id: 'ui:font-small',
      section: '外观',
      label: '设置字号：小',
      keywords: 'font size small 字号 小',
      icon: Type,
      action: () => {
        appStore.setFontSize('small')
        closePalette?.()
      }
    })
    items.push({
      id: 'ui:font-medium',
      section: '外观',
      label: '设置字号：中',
      keywords: 'font size medium 字号 中',
      icon: Type,
      action: () => {
        appStore.setFontSize('medium')
        closePalette?.()
      }
    })
    items.push({
      id: 'ui:font-large',
      section: '外观',
      label: '设置字号：大',
      keywords: 'font size large 字号 大',
      icon: Type,
      action: () => {
        appStore.setFontSize('large')
        closePalette?.()
      }
    })

    // ========== 文件 / 同步 ==========
    items.push({
      id: 'file:open-location',
      section: '文件',
      label: '选择笔记库路径（打开文件夹）',
      keywords: 'open folder vault library 笔记库 路径 打开文件夹',
      icon: UploadCloud,
      action: async () => {
        if (window.electronAPI?.selectNotesLocation) {
          const path = await window.electronAPI.selectNotesLocation()
          if (path) {
            appStore.saveNotesLocation(path)
            await noteStore.loadNotesFromPath(path)
          }
        }
        closePalette?.()
      }
    })
    items.push({
      id: 'file:recent',
      section: '文件',
      label: '查看最近打开的笔记',
      keywords: 'recent history 最近 历史',
      icon: Clock,
      action: () => {
        router.push('/notes')
        closePalette?.()
      }
    })
    items.push({
      id: 'file:export',
      section: '文件',
      label: '导出笔记库（待后端对接）',
      keywords: 'export 导出 backup 备份 download',
      icon: Download,
      action: () => {
        // 预留：Electron 主进程 export 入口
        if (window.electronAPI?.exportNotes) {
          window.electronAPI.exportNotes?.()
        }
        closePalette?.()
      }
    })

    // ========== 快速条目：最近笔记（直接跳转） ==========
    const recent = (noteStore.notes || [])
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 8)

    for (const n of recent) {
      items.push({
        id: `note:goto:${n.id}`,
        section: '最近笔记',
        label: `打开：${n.title || '未命名笔记'}`,
        keywords: `${n.title || ''} ${(n.tags || []).join(' ')}`,
        icon: FileText,
        action: () => {
          router.push(`/editor/${n.id}`)
          closePalette?.()
        }
      })
    }

    return items
  })

  return { quickActions }
}

/**
 * 对命令列表进行简单的模糊匹配。
 * - 空 q: 按 section 分组 + 原始顺序返回
 * - 否则: 对 label + keywords 进行包含匹配，并给包含更多 token 的项更高分
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
    if (!tokens.every((t) => hay.includes(t))) continue
    let score = 0
    for (const t of tokens) {
      const idx = hay.indexOf(t)
      if (idx >= 0) score += 100 - idx
      if (cmd.label.toLowerCase().includes(t)) score += 40
    }
    scored.push({ cmd, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.cmd)
}

/**
 * 对笔记列表做快速切换器模糊排名（和上面一致，专门给笔记）。
 */
export function rankNotes(notes, q) {
  const query = (q || '').trim().toLowerCase()
  const list = Array.isArray(notes) ? notes : []
  if (!query) {
    return list
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 30)
  }
  const tokens = query.split(/\s+/).filter(Boolean)
  const scored = []
  for (const n of list) {
    const hay = `${n.title || ''} ${(n.tags || []).join(' ')} ${n.folder || ''}`.toLowerCase()
    if (!tokens.every((t) => hay.includes(t))) continue
    let score = 0
    for (const t of tokens) {
      const idx = hay.indexOf(t)
      if (idx >= 0) score += 100 - idx
      if ((n.title || '').toLowerCase().includes(t)) score += 50
    }
    scored.push({ note: n, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.note).slice(0, 50)
}
