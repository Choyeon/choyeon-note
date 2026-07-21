import { defineStore } from 'pinia'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

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
    }
  }

  function addToDictionary(word) {
    const lowerWord = word.toLowerCase()
    if (!customDictionary.value.has(lowerWord)) {
      customDictionary.value = new Set([...customDictionary.value, lowerWord])
      localStorage.setItem('choyeon-custom-dictionary', JSON.stringify([...customDictionary.value]))
    }
  }

  function isWordCorrect(word) {
    if (!word) return true
    const lowerWord = word.toLowerCase()
    
    if (ignoredWords.value.has(lowerWord)) return true
    if (customDictionary.value.has(lowerWord)) return true
    
    return isCommonEnglishWord(word)
  }

  function getSpellErrors(text) {
    if (!spellCheck.value || !text) return []
    
    const errors = []
    const words = text.match(/[a-zA-Z]+/g) || []
    const seen = new Set()
    
    words.forEach(word => {
      const lowerWord = word.toLowerCase()
      if (seen.has(lowerWord)) return
      seen.add(lowerWord)
      
      if (ignoredWords.value.has(lowerWord)) return
      if (customDictionary.value.has(lowerWord)) return
      
      if (!isCommonEnglishWord(word)) {
        const indices = []
        let idx = text.indexOf(word)
        while (idx !== -1) {
          indices.push({ word, start: idx, end: idx + word.length })
          idx = text.indexOf(word, idx + word.length)
        }
        errors.push(...indices)
      }
    })
    
    return errors
  }

  function isCommonEnglishWord(word) {
    const lowerWord = word.toLowerCase()
    if (/^\d+$/.test(word)) return true
    if (word.length <= 1) return true
    if (word === word.toUpperCase() && word.length > 1) return true
    
    const commonWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
      'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
      'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
      'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
      'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
      'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
      'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
      'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
      'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
      'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
      'is', 'are', 'was', 'were', 'been', 'being', 'am', 'has', 'had', 'does',
      'did', 'done', 'doing', 'having', 'where', 'why', 'here', 'there', 'very', 'more',
      'much', 'many', 'such', 'same', 'own', 'other', 'some', 'any', 'every', 'each',
      'both', 'few', 'more', 'most', 'other', 'some', 'no', 'nor', 'not', 'only',
      'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'don', 'should',
      'now', 'yes', 'no', 'not', 'and', 'but', 'or', 'nor', 'for', 'yet', 'so',
      'either', 'neither', 'both', 'each', 'every', 'all', 'any', 'few', 'more',
      'most', 'some', 'such', 'no', 'nor', 'not', 'only', 'same', 'so', 'than',
      'too', 'very', 'can', 'will', 'just', 'don', 'should', 'now', 'test', 'hello',
      'world', 'code', 'note', 'notes', 'app', 'markdown', 'electron', 'vue', 'javascript',
      'html', 'css', 'json', 'api', 'url', 'http', 'https', 'www', 'com', 'org',
      'net', 'io', 'github', 'git', 'npm', 'yarn', 'node', 'python', 'java', 'cpp',
      'file', 'files', 'folder', 'folders', 'path', 'dir', 'directory', 'open', 'save',
      'close', 'edit', 'view', 'new', 'old', 'left', 'right', 'top', 'bottom', 'center',
      'font', 'size', 'color', 'theme', 'light', 'dark', 'mode', 'text', 'title', 'content',
      'word', 'char', 'line', 'count', 'date', 'time', 'week', 'month', 'year', 'day',
      'today', 'tomorrow', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
      'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
      'august', 'september', 'october', 'november', 'december', 'china', 'chinese', 'english',
      'american', 'europe', 'asian', 'beijing', 'shanghai', 'guangzhou', 'shenzhen', ' Obsidian',
      'type', 'types', 'typed', 'typing', 'keyboard', 'mouse', 'screen', 'window', 'windows',
      'linux', 'macos', 'ios', 'android', 'mobile', 'desktop', 'laptop', 'tablet', 'phone',
      'setting', 'settings', 'config', 'configuration', 'preference', 'preferences', 'option',
      'options', 'choice', 'choices', 'select', 'selected', 'selection', 'filter', 'filtered',
      'sort', 'sorted', 'sorting', 'search', 'searched', 'searching', 'find', 'found', 'finding',
      'replace', 'replaced', 'replacing', 'insert', 'inserted', 'inserting', 'delete', 'deleted',
      'deleting', 'remove', 'removed', 'removing', 'add', 'added', 'adding', 'create', 'created',
      'creating', 'update', 'updated', 'updating', 'read', 'reading', 'write', 'writing', 'written',
      'list', 'item', 'items', 'task', 'tasks', 'todo', 'done', 'complete', 'completed',
      'progress', 'pending', 'active', 'inactive', 'enable', 'enabled', 'disable', 'disabled',
      'true', 'false', 'null', 'undefined', 'function', 'return', 'const', 'let', 'var', 'class',
      'import', 'export', 'default', 'async', 'await', 'promise', 'resolve', 'reject', 'error',
      'warning', 'info', 'debug', 'log', 'message', 'data', 'value', 'key', 'object', 'array',
      'string', 'number', 'boolean', 'true', 'false', 'null', 'undefined', 'void', 'never', 'any'
    ])
    
    return commonWords.has(lowerWord) || /^[A-Z]/.test(word)
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
    getSpellErrors
  }
})
