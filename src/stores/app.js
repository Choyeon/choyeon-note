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
  let mediaQueryListener = null

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
    document.documentElement.setAttribute('data-font-size', fontSize.value)
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

  function ignoreWord(word) {
    const lowerWord = word.toLowerCase()
    if (!ignoredWords.value.has(lowerWord)) {
      ignoredWords.value = new Set([...ignoredWords.value, lowerWord])
      localStorage.setItem('choyeon-ignored-words', JSON.stringify([...ignoredWords.value]))
      spellVersion.value++
    }
  }

  function addToDictionary(word) {
    const lowerWord = word.toLowerCase()
    if (!customDictionary.value.has(lowerWord)) {
      customDictionary.value = new Set([...customDictionary.value, lowerWord])
      localStorage.setItem('choyeon-custom-dictionary', JSON.stringify([...customDictionary.value]))
      spellVersion.value++
    }
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
    addToDictionary,
    isWordCorrect,
    getSpellErrors,
    setCodeTheme,
    toggleBingWallpaper,
    setBingWallpaperUrl,
    toggleAutoCheckUpdates,
    setAppVersion
  }
})
