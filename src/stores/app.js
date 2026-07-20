import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

export const useAppStore = defineStore('app', () => {
  const theme = ref('light')
  const accentColor = ref('#4A90D9')
  const fontSize = ref('medium')
  const glassEffect = ref(true)
  const autoSave = ref(true)
  const spellCheck = ref(true)
  const showLineNumbers = ref(false)
  const wordWrap = ref(true)
  const notesLocation = ref('')
  const autoSync = ref(false)
  const initialized = ref(false)
  const ignoredWords = ref(new Set())
  const customDictionary = ref(new Set())

  const accentColors = [
    '#4A90D9',
    '#E53935',
    '#FF7043',
    '#66BB6A',
    '#26C6DA',
    '#26A69A'
  ]

  function loadConfig() {
    const savedTheme = localStorage.getItem('choyeon-theme')
    const savedAccent = localStorage.getItem('choyeon-accent')
    const savedFontSize = localStorage.getItem('choyeon-font-size')
    const savedNotesLocation = localStorage.getItem('choyeon-notes-location')
    const savedIgnoredWords = localStorage.getItem('choyeon-ignored-words')
    const savedCustomDictionary = localStorage.getItem('choyeon-custom-dictionary')
    
    if (savedTheme) {
      theme.value = savedTheme
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme.value = 'dark'
    }

    if (savedAccent) {
      accentColor.value = savedAccent
    }

    if (savedFontSize) {
      fontSize.value = savedFontSize
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

    applyTheme()
    applyAccentColor()
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
    localStorage.removeItem('choyeon-notes-location')
    localStorage.removeItem('choyeon-ignored-words')
    localStorage.removeItem('choyeon-custom-dictionary')
    localStorage.removeItem('choyeon-mode')
    
    theme.value = 'light'
    accentColor.value = '#4A90D9'
    fontSize.value = 'medium'
    notesLocation.value = ''
    ignoredWords.value = new Set()
    customDictionary.value = new Set()
    
    applyTheme()
    applyAccentColor()
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
    if (theme.value === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
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

  function setFontSize(size) {
    fontSize.value = size
    localStorage.setItem('choyeon-font-size', size)
  }

  function toggleGlassEffect() {
    glassEffect.value = !glassEffect.value
  }

  function toggleAutoSave() {
    autoSave.value = !autoSave.value
  }

  function toggleSpellCheck() {
    spellCheck.value = !spellCheck.value
  }

  function toggleLineNumbers() {
    showLineNumbers.value = !showLineNumbers.value
  }

  function toggleWordWrap() {
    wordWrap.value = !wordWrap.value
  }

  function toggleAutoSync() {
    autoSync.value = !autoSync.value
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
    
    if (typeof window !== 'undefined' && 'spellcheck' in document.body && document.body.spellcheck) {
      return undefined
    }
    
    return undefined
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
    saveNotesLocation,
    resetConfig,
    loadConfig,
    ignoreWord,
    addToDictionary,
    isWordCorrect,
    getSpellErrors
  }
})
