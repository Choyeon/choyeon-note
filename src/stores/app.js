import { defineStore } from 'pinia'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { isCommonEnglishWord, getSpellErrors as getSpellErrorsPure } from '@/utils/spellcheck'
import { createDefaultBindings, SHORTCUT_MAP, SHORTCUTS } from '@/constants/shortcuts'

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
  const autoSync = ref(false)
  const sidebar = ref(true)
  // 新建笔记时使用的扩展名（md / markdown / txt），由 note.js 落盘与载入时共同遵守
  const NOTE_EXTENSIONS = ['md', 'markdown', 'txt']
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
  let mediaQueryListener = null
  let spellSaveTimer = null
  let firstLoadDone = false
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI

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

  function loadConfig() {
    const savedTheme = localStorage.getItem('choyeon-theme')
    const savedAccent = localStorage.getItem('choyeon-accent')
    const savedFontSize = localStorage.getItem('choyeon-font-size')
    const savedGlassEffect = localStorage.getItem('choyeon-glass-effect')
    const savedNotesLocation = localStorage.getItem('choyeon-notes-location')
    const savedIgnoredWords = localStorage.getItem('choyeon-ignored-words')
    const savedCustomDictionary = localStorage.getItem('choyeon-custom-dictionary')
    const savedAutoSave = localStorage.getItem('choyeon-auto-save')
    const savedSpellCheck = localStorage.getItem('choyeon-spell-check')
    const savedLineNumbers = localStorage.getItem('choyeon-line-numbers')
    const savedWordWrap = localStorage.getItem('choyeon-word-wrap')
    const savedAutoSync = localStorage.getItem('choyeon-auto-sync')
    const savedNoteExtension = localStorage.getItem('choyeon-note-extension')
    const savedSidebar = localStorage.getItem('choyeon-sidebar')
    const savedCodeTheme = localStorage.getItem('choyeon-code-theme')
    const savedBingWallpaper = localStorage.getItem('choyeon-bing-wallpaper')
    const savedBingUrl = localStorage.getItem('choyeon-bing-wallpaper-url')
    const savedBingTitle = localStorage.getItem('choyeon-bing-wallpaper-title')
    const savedBingDate = localStorage.getItem('choyeon-bing-wallpaper-date')
    const savedBingSource = localStorage.getItem('choyeon-bing-wallpaper-source')
    const savedEditorZoom = localStorage.getItem('choyeon-editor-zoom')
    const savedAutoCheckUpdates = localStorage.getItem('choyeon-auto-check-updates')
    const savedHotkeys = localStorage.getItem('choyeon-hotkeys')
    const savedEditorMode = localStorage.getItem('choyeon-editor-mode')
    const savedRightPanelTab = localStorage.getItem('choyeon-right-panel-tab')
    const savedRightPanelVisible = localStorage.getItem('choyeon-right-panel-visible')
    
    setupSystemThemeListener()
    
    if (savedTheme) {
      theme.value = savedTheme
    }

    if (savedAccent) {
      accentColor.value = savedAccent
    }

    if (savedFontSize) {
      fontSize.value = savedFontSize
    }

    if (savedGlassEffect !== null) {
      glassEffect.value = savedGlassEffect === 'true'
    }

    if (savedNotesLocation) {
      notesLocation.value = savedNotesLocation
    }

    if (savedIgnoredWords) {
      try {
        ignoredWords.value = new Set(JSON.parse(savedIgnoredWords))
      } catch (e) {
        ignoredWords.value = new Set()
      }
    }

    if (savedCustomDictionary) {
      try {
        customDictionary.value = new Set(JSON.parse(savedCustomDictionary))
      } catch (e) {
        customDictionary.value = new Set()
      }
    }

    if (savedAutoSave !== null) {
      autoSave.value = savedAutoSave === 'true'
    }

    if (savedSpellCheck !== null) {
      spellCheck.value = savedSpellCheck === 'true'
    }

    if (savedLineNumbers !== null) {
      showLineNumbers.value = savedLineNumbers === 'true'
    }

    if (savedWordWrap !== null) {
      wordWrap.value = savedWordWrap === 'true'
    }

    if (savedAutoSync !== null) {
      autoSync.value = savedAutoSync === 'true'
    }

    if (savedSidebar !== null) {
      sidebar.value = savedSidebar === 'true'
    }

    if (savedCodeTheme) {
      codeTheme.value = savedCodeTheme
    }

    // 缩放用 number 存储，坏值（NaN/越界）一律回落到 100
    if (savedEditorZoom !== null) {
      const z = Number(savedEditorZoom)
      if (Number.isFinite(z)) editorZoom.value = Math.min(200, Math.max(50, Math.round(z)))
    }

    if (savedBingWallpaper !== null) {
      bingWallpaper.value = savedBingWallpaper === 'true'
    }
    // 壁纸结果缓存：启动后立刻能显示昨天的图，再后台刷新
    if (savedBingUrl) bingWallpaperUrl.value = savedBingUrl
    if (savedBingTitle) bingWallpaperTitle.value = savedBingTitle
    if (savedBingDate) bingWallpaperDate.value = savedBingDate
    if (savedBingSource) bingWallpaperSource.value = savedBingSource

    if (savedAutoCheckUpdates !== null) {
      autoCheckUpdates.value = savedAutoCheckUpdates === 'true'
    }

    hotkeys.value = mergeBindings(savedHotkeys)

    if (savedEditorMode) {
      // 兼容历史值 'source'（等价于现在的 'edit'）
      const legacy = savedEditorMode === 'source' ? 'edit' : savedEditorMode
      if (['edit', 'live', 'preview'].includes(legacy)) {
        editorMode.value = legacy
      }
    }
    if (savedRightPanelTab) {
      rightPanelTab.value = savedRightPanelTab
    }
    if (savedRightPanelVisible !== null) {
      rightPanelVisible.value = savedRightPanelVisible === 'true'
    }

    applyTheme()
    applyAccentColor()
    applyGlassEffect()
    applyFontSize()
    initialized.value = true
  }

  /**
   * 合并已保存的快捷键。直接 JSON.parse 会丢掉后续版本新增的命令，
   * 所以以默认表为底、用用户覆盖项打补丁；非字符串或空串视为"未设置"。
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
    localStorage.setItem('choyeon-hotkeys', JSON.stringify(hotkeys.value))
  }

  /** 取某命令的当前绑定（用户自定义优先） */
  function getBinding(id) {
    const custom = hotkeys.value[id]
    return custom === undefined ? SHORTCUT_MAP[id]?.default || '' : custom
  }

  function setHotkey(id, binding) {
    if (!(id in hotkeys.value)) return { ok: false, reason: 'unknown' }
    const next = String(binding || '').trim()
    if (next) {
      const conflict = findConflict(id, next)
      if (conflict) return { ok: false, reason: 'conflict', conflict }
    }
    hotkeys.value = { ...hotkeys.value, [id]: next }
    persistHotkeys()
    return { ok: true }
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

  /** 返回与给定绑定串冲突的其它命令（同 scope 才算冲突） */
  function findConflict(id, binding, scope) {
    const self = SHORTCUT_MAP[id]
    const targetScope = scope || self?.scope
    const normalized = String(binding || '').trim().toLowerCase()
    if (!normalized) return null
    return SHORTCUTS.find(s => {
      if (s.id === id) return false
      if (s.scope !== targetScope) return false
      return String(getBinding(s.id) || '').trim().toLowerCase() === normalized
    }) || null
  }

  function setEditorMode(mode) {
    const normalized = mode === 'source' ? 'edit' : mode
    if (!['edit', 'live', 'preview'].includes(normalized)) return
    editorMode.value = normalized
    localStorage.setItem('choyeon-editor-mode', normalized)
  }

  function setRightPanelTab(tab) {
    rightPanelTab.value = tab
    localStorage.setItem('choyeon-right-panel-tab', tab)
  }

  function toggleRightPanel() {
    rightPanelVisible.value = !rightPanelVisible.value
    localStorage.setItem('choyeon-right-panel-visible', rightPanelVisible.value)
  }

  function saveNotesLocation(path) {
    notesLocation.value = path
    localStorage.setItem('choyeon-notes-location', path)
    localStorage.removeItem('choyeon-mode')
  }

  function resetConfig() {
    localStorage.removeItem('choyeon-theme')
    localStorage.removeItem('choyeon-accent')
    localStorage.removeItem('choyeon-font-size')
    localStorage.removeItem('choyeon-glass-effect')
    localStorage.removeItem('choyeon-notes-location')
    localStorage.removeItem('choyeon-ignored-words')
    localStorage.removeItem('choyeon-custom-dictionary')
    localStorage.removeItem('choyeon-auto-save')
    localStorage.removeItem('choyeon-spell-check')
    localStorage.removeItem('choyeon-line-numbers')
    localStorage.removeItem('choyeon-word-wrap')
    localStorage.removeItem('choyeon-auto-sync')
    localStorage.removeItem('choyeon-note-extension')
    localStorage.removeItem('choyeon-sidebar')
    localStorage.removeItem('choyeon-mode')
    localStorage.removeItem('choyeon-code-theme')
    localStorage.removeItem('choyeon-bing-wallpaper')
    localStorage.removeItem('choyeon-bing-wallpaper-url')
    localStorage.removeItem('choyeon-bing-wallpaper-title')
    localStorage.removeItem('choyeon-bing-wallpaper-date')
    localStorage.removeItem('choyeon-bing-wallpaper-source')
    localStorage.removeItem('choyeon-editor-zoom')
    localStorage.removeItem('choyeon-auto-check-updates')
    localStorage.removeItem('choyeon-hotkeys')
    localStorage.removeItem('choyeon-editor-mode')
    localStorage.removeItem('choyeon-right-panel-tab')
    localStorage.removeItem('choyeon-right-panel-visible')
    
    if (mediaQueryListener) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', mediaQueryListener)
      } else if (mediaQuery.removeListener) {
        mediaQuery.removeListener(mediaQueryListener)
      }
      mediaQueryListener = null
    }
    
    theme.value = 'system'
    accentColor.value = '#4A90D9'
    fontSize.value = 'medium'
    glassEffect.value = true
    autoSave.value = true
    spellCheck.value = true
    showLineNumbers.value = false
    wordWrap.value = true
    notesLocation.value = ''
    autoSync.value = false
    noteExtension.value = 'md'
    sidebar.value = true
    ignoredWords.value = new Set()
    customDictionary.value = new Set()
    codeTheme.value = 'github'
    editorZoom.value = 100
    bingWallpaper.value = false
    bingWallpaperUrl.value = ''
    bingWallpaperTitle.value = ''
    bingWallpaperDate.value = ''
    bingWallpaperSource.value = ''
    bingWallpaperError.value = ''
    autoCheckUpdates.value = true
    hotkeys.value = createDefaultBindings()
    editorMode.value = 'edit'
    rightPanelTab.value = 'outline'
    rightPanelVisible.value = true
    
    applyTheme()
    applyAccentColor()
    applyGlassEffect()
    applyFontSize()
  }

  function initTheme() {
    loadConfig()
    hydrateSpellDataFromDisk()
  }

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    localStorage.setItem('choyeon-theme', theme.value)
    applyTheme()
  }

  function setTheme(newTheme) {
    theme.value = newTheme
    localStorage.setItem('choyeon-theme', theme.value)
    applyTheme()
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', effectiveTheme.value)
  }

  function setAccentColor(color) {
    accentColor.value = color
    localStorage.setItem('choyeon-accent', color)
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
    localStorage.setItem('choyeon-font-size', size)
    applyFontSize()
  }

  function toggleGlassEffect() {
    glassEffect.value = !glassEffect.value
    localStorage.setItem('choyeon-glass-effect', glassEffect.value)
    applyGlassEffect()
  }

  function toggleAutoSave() {
    autoSave.value = !autoSave.value
    localStorage.setItem('choyeon-auto-save', autoSave.value)
  }

  function toggleSpellCheck() {
    spellCheck.value = !spellCheck.value
    localStorage.setItem('choyeon-spell-check', spellCheck.value)
  }

  function toggleLineNumbers() {
    showLineNumbers.value = !showLineNumbers.value
    localStorage.setItem('choyeon-line-numbers', showLineNumbers.value)
  }

  function toggleWordWrap() {
    wordWrap.value = !wordWrap.value
    localStorage.setItem('choyeon-word-wrap', wordWrap.value)
  }

  function toggleAutoSync() {
    autoSync.value = !autoSync.value
    localStorage.setItem('choyeon-auto-sync', autoSync.value)
  }

  function setNoteExtension(ext) {
    if (!NOTE_EXTENSIONS.includes(ext)) return
    noteExtension.value = ext
    localStorage.setItem('choyeon-note-extension', ext)
  }

  function toggleSidebar() {
    sidebar.value = !sidebar.value
    localStorage.setItem('choyeon-sidebar', sidebar.value)
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
      localStorage.setItem('choyeon-ignored-words', JSON.stringify([...ignoredWords.value]))
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
      localStorage.setItem('choyeon-ignored-words', JSON.stringify([...ignoredWords.value]))
      scheduleSpellPersist()
      spellVersion.value++
    }
  }

  function clearIgnoredWords() {
    ignoredWords.value = new Set()
    localStorage.setItem('choyeon-ignored-words', '[]')
    scheduleSpellPersist()
    spellVersion.value++
  }

  function addToDictionary(word) {
    const lowerWord = word.toLowerCase()
    if (!customDictionary.value.has(lowerWord)) {
      customDictionary.value = new Set([...customDictionary.value, lowerWord])
      localStorage.setItem('choyeon-custom-dictionary', JSON.stringify([...customDictionary.value]))
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
      localStorage.setItem('choyeon-custom-dictionary', JSON.stringify([...customDictionary.value]))
      scheduleSpellPersist()
      spellVersion.value++
    }
  }

  function clearCustomDictionary() {
    customDictionary.value = new Set()
    localStorage.setItem('choyeon-custom-dictionary', '[]')
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
            localStorage.setItem('choyeon-ignored-words', JSON.stringify([...merged]))
          }
          if (Array.isArray(data.customDictionary) && data.customDictionary.length > 0) {
            const merged = new Set([...customDictionary.value, ...data.customDictionary.map(w => String(w).toLowerCase())])
            customDictionary.value = merged
            localStorage.setItem('choyeon-custom-dictionary', JSON.stringify([...merged]))
          }
          if (data.ignoredWords || data.customDictionary) spellVersion.value++
        }
      }
    } catch (e) { /* ignore */ }
  }

  function setCodeTheme(theme) {
    codeTheme.value = theme
    localStorage.setItem('choyeon-code-theme', theme)
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
    localStorage.setItem('choyeon-editor-zoom', String(clamped))
  }

  function resetEditorZoom() {
    setEditorZoom(100)
  }

  function toggleBingWallpaper() {
    bingWallpaper.value = !bingWallpaper.value
    localStorage.setItem('choyeon-bing-wallpaper', String(bingWallpaper.value))
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
      localStorage.setItem('choyeon-bing-wallpaper-url', url)
      if (title) localStorage.setItem('choyeon-bing-wallpaper-title', title)
      if (date) localStorage.setItem('choyeon-bing-wallpaper-date', date)
      if (source) localStorage.setItem('choyeon-bing-wallpaper-source', source)
    } catch (e) { /* localStorage 满或被禁用时忽略，不影响内存态 */ }
  }

  function toggleAutoCheckUpdates() {
    autoCheckUpdates.value = !autoCheckUpdates.value
    localStorage.setItem('choyeon-auto-check-updates', autoCheckUpdates.value)
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
    setRightPanelTab,
    toggleRightPanel,
    openCommandPalette,
    closeCommandPalette,
    toggleCommandPalette,
    openQuickSwitcher,
    closeQuickSwitcher,
    toggleQuickSwitcher,
    setAppVersion
  }
})
