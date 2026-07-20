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
  const notesLocation = ref('D:\\Notes')
  const autoSync = ref(false)

  const accentColors = [
    '#4A90D9',
    '#E53935',
    '#FF7043',
    '#66BB6A',
    '#26C6DA',
    '#26A69A'
  ]

  function initTheme() {
    const savedTheme = localStorage.getItem('choyeon-theme')
    const savedAccent = localStorage.getItem('choyeon-accent')
    
    if (savedTheme) {
      theme.value = savedTheme
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme.value = 'dark'
    }

    if (savedAccent) {
      accentColor.value = savedAccent
    }

    applyTheme()
    applyAccentColor()
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
    toggleAutoSync
  }
})
