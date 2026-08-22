import { defineStore } from 'pinia'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { isCommonEnglishWord, getSpellErrors as getSpellErrorsPure } from '@/utils/spellcheck'

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
  const initialized = ref(false)
  const ignoredWords = ref(new Set())
  const customDictionary = ref(new Set())
  const spellVersion = ref(0)
  const codeTheme = ref('github')
  const bingWallpaper = ref(false)
  const bingWallpaperUrl = ref('')
  const autoCheckUpdates = ref(true)
  const appVersion = ref('')
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
    const savedSidebar = localStorage.getItem('choyeon-sidebar')
    const savedCodeTheme = localStorage.getItem('choyeon-code-theme')
    const savedBingWallpaper = localStorage.getItem('choyeon-bing-wallpaper')
    const savedAutoCheckUpdates = localStorage.getItem('choyeon-auto-check-updates')
    
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

    if (savedBingWallpaper !== null) {
      bingWallpaper.value = savedBingWallpaper === 'true'
    }

    if (savedAutoCheckUpdates !== null) {
      autoCheckUpdates.value = savedAutoCheckUpdates === 'true'
    }

    applyTheme()
    applyAccentColor()
    applyGlassEffect()
    applyFontSize()
    initialized.value = true
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
    localStorage.removeItem('choyeon-sidebar')
    localStorage.removeItem('choyeon-mode')
    localStorage.removeItem('choyeon-code-theme')
    localStorage.removeItem('choyeon-bing-wallpaper')
    localStorage.removeItem('choyeon-auto-check-updates')
    
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
    sidebar.value = true
    ignoredWords.value = new Set()
    customDictionary.value = new Set()
    codeTheme.value = 'github'
    bingWallpaper.value = false
    bingWallpaperUrl.value = ''
    autoCheckUpdates.value = true
    
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

  function toggleBingWallpaper() {
    bingWallpaper.value = !bingWallpaper.value
    localStorage.setItem('choyeon-bing-wallpaper', bingWallpaper.value)
  }

  function setBingWallpaperUrl(url) {
    bingWallpaperUrl.value = url
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
    sidebar,
    initialized,
    ignoredWords,
    customDictionary,
    spellVersion,
    codeTheme,
    bingWallpaper,
    bingWallpaperUrl,
    autoCheckUpdates,
    appVersion,
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
    toggleBingWallpaper,
    setBingWallpaperUrl,
    toggleAutoCheckUpdates,
    openCommandPalette,
    closeCommandPalette,
    toggleCommandPalette,
    openQuickSwitcher,
    closeQuickSwitcher,
    toggleQuickSwitcher,
    setAppVersion
  }
})
