import { marked } from 'marked'
import hljs from 'highlight.js'
import mermaid from 'mermaid'
import DOMPurify from 'dompurify'
import { parseFrontmatter, parseCallouts } from '../composables/useLinks.js'

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
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
  github: 'github',
  monokai: 'monokai',
  dracula: 'dracula',
  'atom-one-dark': 'atom-one-dark',
  vs2015: 'vs2015',
  'gradient-dark': 'gradient-dark'
}

async function loadCodeTheme (themeId) {
  const themeName = themeMap[themeId] || 'github'

  if (currentStyleElement) {
    currentStyleElement.remove()
    currentStyleElement = null
  }

  try {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = new URL(`../../../node_modules/highlight.js/styles/${themeName}.css`, import.meta.url).href
    link.setAttribute('data-highlight-theme', themeId)
    document.head.appendChild(link)
    currentStyleElement = link
    currentCodeTheme = themeId
  } catch (e) {
    console.error('Failed to load code theme:', e)
  }
}

function setCodeTheme (theme) {
  currentCodeTheme = theme
  loadCodeTheme(theme)
}

function getCodeTheme () {
  return currentCodeTheme
}

// ============================================================================
// Pre-process: frontmatter 剥离 + [[wiki-links]]/![[embed]]/callouts 转换
// ============================================================================
function escapeHtml (s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把 Obsidian 风格语法糖预编译成 HTML/markdown，让 marked 后续处理不丢语义
 * @param {string} md
 * @param {{ onWikiLink?: (link)=>any, resolveTarget?:(target)=>{resolved:boolean, id?:string, title?:string} }} opts
 * @returns {{ htmlReady: string, links: Array, embeds: Array, callouts: Array, frontmatter: object }}
 */
export function preprocessObsidian (md, opts = {}) {
  const { frontmatter, body } = parseFrontmatter(md || '')
  const links = []
  const embeds = []
  const callouts = parseCallouts(body)

  // 1) 先处理 fenced code：用占位符保护起来
  const fences = []
  let protectedText = ''
  let i = 0
  while (i < body.length) {
    if (body[i] === '`' && body[i + 1] === '`' && body[i + 2] === '`') {
      let j = i + 3
      while (j < body.length) {
        if (body[j] === '`' && body[j + 1] === '`' && body[j + 2] === '`') { j += 3; break }
        j++
      }
      fences.push(body.slice(i, j))
      protectedText += `\u0000F${fences.length - 1}F\u0000`
      i = j
      continue
    }
    protectedText += body[i]
    i++
  }
  const restoreFences = (s) => s.replace(/\u0000F(\d+)F\u0000/g, (_, idx) => fences[+idx] || '')

  // 2) 处理 callouts：逐块重写为 HTML div.obsidian-callout
  //    callouts 是跨多行的块级元素，先按行扫一遍
  const lines = protectedText.split(/\r?\n/)
  const outLines = []
  let k = 0
  while (k < lines.length) {
    const header = lines[k].match(/^>\s*\[!(note|tip|info|todo|important|warning|caution|failure|danger|bug|example|quote|success|question|abstract|summary|tldr|hint|attention|fail|error|missing)\]\s*(.*)$/i)
    if (header) {
      const type = header[1].toLowerCase()
      const title = header[2].trim()
      const innerLines = []
      k++
      while (k < lines.length && /^>/.test(lines[k])) {
        // 去除每行前导 `>`
        innerLines.push(lines[k].replace(/^>\s?/, ''))
        k++
      }
      const inner = innerLines.join('\n')
      const id = 'callout-' + Math.random().toString(36).slice(2, 9)
      outLines.push(
        `<div class="obsidian-callout callout-${type}" data-callout="${type}">` +
          `<div class="callout-header">` +
            `<span class="callout-icon callout-icon-${type}"></span>` +
            `<div class="callout-title">${title || defaultCalloutTitle(type)}</div>` +
          `</div>` +
          `<div class="callout-body" id="${id}"><!-- CALLOUT_INNER_${id} --></div>` +
        `</div>`
      )
      // 把 inner markdown 占位（marked 不对 HTML 标签内部做处理，但我们用独立 marked.parse(inner) 注入）
      outLines.push(`<template data-callout-inner="${id}">${escapeHtml(inner)}</template>`)
    } else {
      outLines.push(lines[k])
      k++
    }
  }
  let processed = outLines.join('\n')

  // 3) 处理 inline code (防 wiki 解析伤反引号)
  const inlines = []
  processed = processed.replace(/`([^`\n]+?)`/g, (m, c) => {
    inlines.push(m)
    return `\u0000I${inlines.length - 1}I\u0000`
  })
  const restoreInlines = (s) => s.replace(/\u0000I(\d+)I\u0000/g, (_, idx) => inlines[+idx] || '')

  // 4) 处理 [[target#hash|alias]] 和 ![[target]]
  processed = processed.replace(/(!?)\[\[([^\]#|\r\n]+)(#[^\]|\r\n]+)?(\|[^\]\r\n]+)?\]\]/g, (raw, bang, target, hash, aliasPart) => {
    const embed = bang === '!'
    const t = target.trim()
    const h = (hash || '').replace(/^#/, '')
    const alias = (aliasPart || '').replace(/^\|/, '').trim()
    const resolved = opts.resolveTarget ? opts.resolveTarget(t) : null
    const record = {
      raw, embed, target: t, hash: h, alias,
      resolved: !!(resolved && resolved.resolved),
      resolvedId: resolved?.id || null,
      resolvedTitle: resolved?.title || null
    }
    const displayName = alias || t
    if (embed) {
      embeds.push(record)
      const cls = 'obsidian-embed' + (record.resolved ? '' : ' is-unresolved')
      const title = record.resolved
        ? (record.resolvedTitle || t)
        : `嵌入（未找到：${t}）`
      return (
        `<div class="${cls}" data-embed-target="${escapeHtml(t)}" data-embed-hash="${escapeHtml(h)}">` +
          `<div class="obsidian-embed-title">📎 ${escapeHtml(title)}</div>` +
          `<div class="obsidian-embed-placeholder" data-resolved="${record.resolved ? '1' : '0'}">` +
            (record.resolved
              ? `<em class="embed-hint">已嵌入笔记预览 (点击跳转)</em>`
              : `<em class="embed-hint embed-missing">笔记未创建 - 点击可新建 "${escapeHtml(t)}"</em>`) +
          `</div>` +
        `</div>`
      )
    }
    links.push(record)
    const cls = 'wikilink' + (record.resolved ? ' is-resolved' : ' is-unresolved')
    const attrs = [
      `class="${cls}"`,
      `data-wiki-target="${escapeHtml(t)}"`,
      record.resolvedId ? `data-note-id="${escapeHtml(record.resolvedId)}"` : '',
      h ? `data-wiki-hash="${escapeHtml(h)}"` : '',
      `title="${escapeHtml(t + (h ? '#' + h : ''))}"`
    ].filter(Boolean).join(' ')
    opts.onWikiLink?.(record)
    return `<a ${attrs}>${escapeHtml(displayName)}</a>`
  })

  // 还原
  processed = restoreInlines(processed)
  processed = restoreFences(processed)

  return { htmlReady: processed, links, embeds, callouts, frontmatter }
}

/**
 * 把 callout inner 的占位 template 内容经 marked 解析后替换进 callout-body
 * 在 DOM 渲染后调用（v-html 完成后，EditorView updateLiveEditor / afterMermaid）
 */
export function hydrateCalloutsInContainer (container) {
  if (!container) return
  const templates = container.querySelectorAll('template[data-callout-inner]')
  for (const tpl of templates) {
    const id = tpl.dataset.calloutInner
    const body = container.querySelector(`#${id}`)
    if (!body) continue
    try {
      const md = unescapeHtml(tpl.innerHTML || tpl.textContent || '')
      body.innerHTML = renderMarkdownInner(md)
    } catch (e) {
      body.innerHTML = `<div class="muted">callout render fail: ${escapeHtml(e.message)}</div>`
    }
    tpl.remove()
  }
}

function unescapeHtml (s) {
  const e = document.createElement('textarea')
  e.innerHTML = s
  return e.value
}

// marked wrapper (内部用，不要 DOMPurify，因为 hydrateCallouts 前已经净化过)
function renderMarkdownInner (md) {
  try {
    return marked.parse(md || '', { breaks: true, gfm: true })
  } catch {
    return String(md || '').replace(/</g, '&lt;')
  }
}

function defaultCalloutTitle (t) {
  const map = {
    note: '备注', tip: '提示', info: '信息', todo: '待办', important: '重要',
    warning: '警告', caution: '注意', failure: '失败', danger: '危险', bug: 'Bug',
    example: '示例', quote: '引用', success: '成功', question: '疑问', abstract: '摘要',
    summary: '摘要', tldr: 'TL;DR', hint: '提示', attention: '注意', fail: '失败',
    error: '错误', missing: '缺失'
  }
  return map[t] || t.charAt(0).toUpperCase() + t.slice(1)
}

// ============================================================================
// Renderer
// ============================================================================
const renderer = new marked.Renderer()

renderer.code = function (text, lang) {
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

renderer.link = function (href, title, text) {
  // 普通外部链接：新标签打开，加安全属性；wikilink 已在 preprocess 阶段处理完毕
  const t = title ? ` title="${escapeHtml(title)}"` : ''
  const target = /^https?:/i.test(href || '') ? ' target="_blank" rel="noopener noreferrer"' : ''
  return `<a href="${escapeHtml(href)}"${target}${t} class="md-external-link">${text}</a>`
}

marked.setOptions({
  breaks: true,
  gfm: true,
  renderer
})

/**
 * 主渲染函数：Obsidian 语法糖 + marked + DOMPurify
 * @param {string} content 原始 markdown
 * @param {{resolveTarget?: (target:string)=>{resolved:boolean,id?:string,title?:string}}} opts
 */
function renderMarkdown (content, opts = {}) {
  const { htmlReady } = preprocessObsidian(content, opts)
  const rawHtml = marked.parse(htmlReady || '')
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: [
      'data-mermaid-id', 'data-mermaid-code', 'data-lang', 'data-highlight-theme',
      'data-wiki-target', 'data-wiki-hash', 'data-note-id',
      'data-callout', 'data-callout-inner',
      'data-embed-target', 'data-embed-hash', 'data-resolved'
    ],
    ADD_TAGS: ['template']
  })
}

async function renderMermaidInContainer (container) {
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
