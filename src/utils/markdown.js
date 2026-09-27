import { marked } from 'marked'
// 用 common 精简集（约 40 种主流语言）替代全量 190+ 语言，主 bundle 显著减小；
// 罕见语言会退化为 highlightAuto 兜底（无高亮但不报错）
import hljs from 'highlight.js/lib/common'
// 主题 CSS 以 ?raw 方式打包进 bundle：
// 旧实现用 <link href="../../../node_modules/..."> 注入，dev 下能取到，
// 打包后 import.meta.url 变成 /assets/*.js，那个相对路径直接 404 —— 生产环境
// 代码块完全没有高亮配色。CSS 已内置到 src/assets/code-themes（rolldown 无法
// 解析带 query 的包内子路径，故不走 node_modules），两种环境都能拿到。
// 实时预览同样依赖这份 .hljs-* 规则，所以它是「两模式一致」的前提。
import githubCss from '../assets/code-themes/github.css?raw'
import monokaiCss from '../assets/code-themes/monokai.css?raw'
import tokyoNightCss from '../assets/code-themes/tokyo-night-dark.css?raw'
import atomOneDarkCss from '../assets/code-themes/atom-one-dark.css?raw'
import vs2015Css from '../assets/code-themes/vs2015.css?raw'
import gradientDarkCss from '../assets/code-themes/gradient-dark.css?raw'
import DOMPurify from 'dompurify'
import { parseFrontmatter, parseCallouts } from '../composables/useLinks.js'
// 日志：主题加载失败属于「用户看到没高亮但说不清原因」的问题，必须有据可查。
// 这里只引入 logger 内核，它及其两个依赖（constants/logging.js、utils/logSanitize.js）
// 都是零 import、零副作用的纯模块，不会给本文件的加载带来环境要求。
import { createLogger } from '../utils/logger.js'
import { LOG_MODULES } from '../constants/logging.js'

/** 渲染 / 代码高亮相关的日志出口 */
const mdLog = createLogger(LOG_MODULES.editor)

let currentCodeTheme = 'github'
let currentStyleElement = null

// 注：旧版本里的 dracula 在当前 highlight.js 中并不存在（一直 404），
// 换成同色系的 Tokyo Night；dracula 保留成别名，老用户的设置不会失效
const codeThemes = [
  { id: 'github', name: 'GitHub' },
  { id: 'monokai', name: 'Monokai' },
  { id: 'tokyo-night-dark', name: 'Tokyo Night' },
  { id: 'atom-one-dark', name: 'Atom One Dark' },
  { id: 'vs2015', name: 'VS 2015' },
  { id: 'gradient-dark', name: 'Gradient Dark' }
]

const themeMap = {
  github: 'github',
  monokai: 'monokai',
  dracula: 'tokyo-night-dark',
  'tokyo-night-dark': 'tokyo-night-dark',
  'atom-one-dark': 'atom-one-dark',
  vs2015: 'vs2015',
  'gradient-dark': 'gradient-dark'
}

const themeCssMap = {
  github: githubCss,
  monokai: monokaiCss,
  'tokyo-night-dark': tokyoNightCss,
  'atom-one-dark': atomOneDarkCss,
  vs2015: vs2015Css,
  'gradient-dark': gradientDarkCss
}

async function loadCodeTheme (themeId) {
  const themeName = themeMap[themeId] || 'github'

  if (currentStyleElement) {
    currentStyleElement.remove()
    currentStyleElement = null
  }

  const css = themeCssMap[themeName]
  if (!css) {
    // themeId / themeName 走 data 而不是拼进 msg：它们来自用户设置，值本身不可信
    // （可能被写成一长串），拼进正文既挤压可读性又会在截断后被切掉；放进 data 由
    // logger 渲染成 `k=v` 尾巴，原样保留。logger 出口已自动脱敏，这里不重复处理。
    mdLog.error('未知代码高亮主题，未注入主题样式', { themeId, themeName })
    return
  }

  const style = document.createElement('style')
  style.setAttribute('data-highlight-theme', themeId)
  style.textContent = css
  document.head.appendChild(style)
  currentStyleElement = style
  currentCodeTheme = themeId
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
      // 正文直接就地把 markdown 渲染成 HTML 塞进 callout-body。
      // 之前这里塞的是 `<template data-callout-inner>` 占位，靠 DOM 渲染后调用
      // hydrateCalloutsInContainer 回填——但那个函数从来没有被调用过，
      // 结果所有 callout 在阅读视图里只剩标题、正文消失。
      // 占位符必须先还原：inner 里的代码块在此之前已被换成 \u0000FnF\u0000，
      // 就地还原后再交给 marked 才能拿到高亮过的 <pre><code>。
      const innerHtml = renderMarkdownInner(restoreFences(inner))
      outLines.push(
        `<div class="obsidian-callout callout-${type}" data-callout="${type}">` +
          `<div class="callout-header">` +
            `<span class="callout-icon callout-icon-${type}"></span>` +
            `<div class="callout-title">${title || defaultCalloutTitle(type)}</div>` +
          `</div>` +
          `<div class="callout-body">${innerHtml}</div>` +
        `</div>`
      )
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

  // 4.5) ==高亮== 与 #标签
  //     与实时预览（livePreview.js 的 .cm-md-highlight / .cm-md-tag）保持同款视觉，
  //     避免同一段笔记在「实时预览」有高亮/标签胶囊、切到「阅读视图」却只剩纯文本。
  //     必须排在双链之后：否则别名里的 #tag 会被塞进 [[...]] 内部而破坏双链解析。
  processed = processed.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
  processed = processed.replace(
    /(^|[\s(（])#([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5/-]*)/g,
    (_, lead, tag) => `${lead}<span class="md-tag">#${tag}</span>`
  )

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
    // substr 已废弃，slice(2, 11) 与其等价（仍是 9 位 base36 字符，ID 格式兼容）
    const id = 'mermaid-' + Math.random().toString(36).slice(2, 11)
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

// mermaid 体积大（约 1.5MB 未压缩），懒加载：只有笔记里真正出现 mermaid 图表时才引入
let mermaidPromise = null
function getMermaid () {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const m = mod.default
      m.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
        fontFamily: 'inherit',
        fontSize: 14,
        // 甘特图默认配置过小（barHeight 20、字号 11），在阅读视图里几乎不可读
        gantt: {
          fontSize: 14,
          sectionFontSize: 14,
          barHeight: 28,
          barGap: 8,
          topPadding: 56,
          leftPadding: 100,
          gridLineStartPadding: 40,
          useMaxWidth: true
        }
      })
      return m
    })
  }
  return mermaidPromise
}

async function renderMermaidInContainer (container) {
  if (!container) return

  const charts = container.querySelectorAll('.mermaid-chart')
  if (!charts.length) return

  const mermaid = await getMermaid()

  for (const chart of charts) {
    const id = chart.dataset.mermaidId
    const code = decodeURIComponent(chart.dataset.mermaidCode || '')

    try {
      const { svg } = await mermaid.render(id, code)
      chart.innerHTML = svg
      chart.classList.add('mermaid-rendered')
      // mermaid 会在 svg 上写死内联 max-width（自然宽度），导致图表永远不随窗口放大。
      // 清除后交给 CSS 控制：宽幅图（甘特/时间线等）随容器拉伸，窄图保持自然尺寸居中。
      const el = chart.querySelector('svg')
      if (el) {
        const natural = parseFloat(el.style.maxWidth) || parseFloat(el.getAttribute('width')) || 0
        el.style.maxWidth = ''
        if (natural >= 480) {
          chart.classList.add('is-wide')
        } else if (natural > 0) {
          // 窄图（简单流程图等）固定自然宽度居中，避免被 width="100%" 属性拉变形
          el.style.width = natural + 'px'
        }
      }
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
  hljs
}
