import { marked } from 'marked'
import hljs from 'highlight.js'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  fontFamily: 'inherit',
  fontSize: 14
})

let currentCodeTheme = 'github'
let currentStyleElement = null

const codeThemes = [
  { id: 'github', name: 'GitHub' },
  { id: 'monokai', name: 'Monokai' },
  { id: 'dracula', name: 'Dracula' },
  { id: 'atom-one-dark', name: 'Atom One Dark' },
  { id: 'vs2015', name: 'VS 2015' },
  { id: 'gradient-dark', name: 'Gradient Dark' }
]

const themeMap = {
  'github': 'github',
  'monokai': 'monokai',
  'dracula': 'dracula',
  'atom-one-dark': 'atom-one-dark',
  'vs2015': 'vs2015',
  'gradient-dark': 'gradient-dark'
}

async function loadCodeTheme(themeId) {
  const themeName = themeMap[themeId] || 'github'
  
  if (currentStyleElement) {
    currentStyleElement.remove()
    currentStyleElement = null
  }
  
  try {
    const cssModule = await import(`highlight.js/styles/${themeName}.css?inline`)
    
    const style = document.createElement('style')
    style.textContent = cssModule.default
    style.setAttribute('data-highlight-theme', themeId)
    document.head.appendChild(style)
    currentStyleElement = style
    currentCodeTheme = themeId
  } catch (e) {
    console.error('Failed to load code theme:', e)
  }
}

function setCodeTheme(theme) {
  currentCodeTheme = theme
  loadCodeTheme(theme)
}

function getCodeTheme() {
  return currentCodeTheme
}

const renderer = new marked.Renderer()

renderer.code = function({ text, lang }) {
  const language = lang || 'text'
  
  if (language === 'mermaid') {
    const id = 'mermaid-' + Math.random().toString(36).substr(2, 9)
    return `<div class="mermaid-chart" data-mermaid-id="${id}" data-mermaid-code="${encodeURIComponent(text)}"></div>`
  }
  
  let highlighted = text
  try {
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value
    } else {
      highlighted = hljs.highlightAuto(text).value
    }
  } catch (e) {
    highlighted = text
  }
  
  return `<pre class="code-block" data-lang="${language}"><code class="hljs language-${language}">${highlighted}</code></pre>`
}

marked.setOptions({
  breaks: true,
  gfm: true,
  renderer
})

function renderMarkdown(content) {
  return marked.parse(content || '')
}

async function renderMermaidInContainer(container) {
  if (!container) return
  
  const charts = container.querySelectorAll('.mermaid-chart')
  
  for (const chart of charts) {
    const id = chart.dataset.mermaidId
    const code = decodeURIComponent(chart.dataset.mermaidCode || '')
    
    try {
      const { svg } = await mermaid.render(id, code)
      chart.innerHTML = svg
      chart.classList.add('mermaid-rendered')
    } catch (e) {
      chart.innerHTML = `<div class="mermaid-error">图表渲染失败: ${e.message}</div>`
    }
  }
}

export {
  renderMarkdown,
  renderMermaidInContainer,
  setCodeTheme,
  getCodeTheme,
  codeThemes,
  hljs,
  mermaid
}
