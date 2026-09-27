import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    // 正文色与阅读视图保持一致（.markdown-body p/li 用的就是 --color-text-body）；
    // 标题 / 引用 / 链接等各自显式覆盖，因此「编辑即所得」不会被带偏。
    color: 'var(--color-text-body)',
    fontSize: 'calc(var(--font-size-body) * var(--editor-zoom, 1))',
    fontFamily: "var(--font-body), 'Segoe UI', system-ui, sans-serif",
    lineHeight: '1.72'
  },
  '.cm-content': {
    caretColor: 'var(--color-primary)',
    padding: '40px 32px',
    minHeight: '100%',
    fontFamily: "var(--font-body), 'Segoe UI', system-ui, sans-serif",
    fontSize: 'calc(var(--font-size-body) * var(--editor-zoom, 1))',
    lineHeight: '1.72',
    maxWidth: '780px',
    margin: '0 auto'
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-primary)',
    borderLeftWidth: '2px'
  },
  '.cm-line': {
    padding: '2px 4px',
    fontSize: 'calc(var(--font-size-body) * var(--editor-zoom, 1))',
    lineHeight: '1.72'
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(74, 144, 217, 0.2) !important'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    padding: '40px 10px 40px 20px',
    fontSize: 'calc(var(--font-size-sm) * var(--editor-zoom, 1))',
    fontFamily: 'var(--font-mono)'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)'
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--color-surface-hover)'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-float)',
    padding: '6px'
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '8px 12px',
      borderRadius: '6px'
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--color-primary-surface)',
      color: 'var(--color-primary)'
    }
  },
  '.cm-panels': {
    backgroundColor: 'var(--color-bg-secondary)',
    color: 'var(--color-text-primary)'
  },
  '.cm-panel-search': {
    padding: '12px',
    borderBottom: '1px solid var(--color-border)'
  },
  '.cm-button': {
    backgroundColor: 'var(--color-bg-tertiary)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    padding: '6px 12px',
    color: 'var(--color-text-primary)',
    cursor: 'pointer'
  },
  '.cm-button:hover': {
    backgroundColor: 'var(--color-surface-hover)'
  },
  '.cm-textfield': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    padding: '6px 10px',
    color: 'var(--color-text-primary)'
  },
  '.cm-textfield:focus': {
    outline: 'none',
    borderColor: 'var(--color-primary)',
    boxShadow: '0 0 0 3px var(--color-primary-ring)'
  },
  '.cm-spell-error': {
    textDecoration: 'wavy underline var(--state-error)',
    textDecorationThickness: '1.8px',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
    textDecorationSkipInk: 'none',
    background: 'color-mix(in srgb, var(--state-error) 6%, transparent)',
    borderRadius: '3px'
  }
}, { dark: false })

const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-body)',
    fontSize: 'calc(var(--font-size-body) * var(--editor-zoom, 1))',
    fontFamily: "var(--font-body), 'Segoe UI', system-ui, sans-serif",
    lineHeight: '1.72'
  },
  '.cm-content': {
    caretColor: 'var(--color-primary)',
    padding: '40px 32px',
    minHeight: '100%',
    fontFamily: "var(--font-body), 'Segoe UI', system-ui, sans-serif",
    fontSize: 'calc(var(--font-size-body) * var(--editor-zoom, 1))',
    lineHeight: '1.72',
    maxWidth: '780px',
    margin: '0 auto'
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-primary)',
    borderLeftWidth: '2px'
  },
  '.cm-line': {
    padding: '2px 4px',
    fontSize: 'calc(var(--font-size-body) * var(--editor-zoom, 1))',
    lineHeight: '1.72'
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(74, 144, 217, 0.35) !important'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    padding: '40px 10px 40px 20px',
    fontSize: 'calc(var(--font-size-sm) * var(--editor-zoom, 1))',
    fontFamily: 'var(--font-mono)'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)'
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-float)',
    padding: '6px'
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '8px 12px',
      borderRadius: '6px'
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--color-primary-surface)',
      color: 'var(--color-primary-light)'
    }
  },
  '.cm-panels': {
    backgroundColor: 'var(--color-bg-secondary)',
    color: 'var(--color-text-primary)'
  },
  '.cm-panel-search': {
    padding: '12px',
    borderBottom: '1px solid var(--color-border)'
  },
  '.cm-button': {
    backgroundColor: 'var(--color-bg-tertiary)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    padding: '6px 12px',
    color: 'var(--color-text-primary)',
    cursor: 'pointer'
  },
  '.cm-button:hover': {
    backgroundColor: 'var(--color-surface-hover)'
  },
  '.cm-textfield': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    padding: '6px 10px',
    color: 'var(--color-text-primary)'
  },
  '.cm-textfield:focus': {
    outline: 'none',
    borderColor: 'var(--color-primary)',
    boxShadow: '0 0 0 3px var(--color-primary-ring)'
  },
  '.cm-spell-error': {
    textDecoration: 'wavy underline var(--state-error)',
    textDecorationThickness: '1.8px',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
    textDecorationSkipInk: 'none',
    background: 'color-mix(in srgb, var(--state-error) 10%, transparent)',
    borderRadius: '3px'
  }
}, { dark: true })

/**
 * 实时预览装饰层样式（与预览模式 .markdown-body 共用同一套 CSS 变量），
 * 两种模式因此拥有一致的字号 / 间距 / 颜色 —— 「编辑即所得」。
 * 主题无关，light / dark 共用一份。
 */
/** callout 配色：与 style.css 的 .callout-* 分组完全一致 */
const CALLOUT_ACCENTS = [
  [['note', 'info', 'abstract', 'summary', 'tldr'], 'var(--state-info)'],
  [['tip', 'hint', 'important', 'success'], 'var(--state-success)'],
  [['warning', 'caution', 'attention'], 'var(--state-warning)'],
  [['danger', 'error', 'fail', 'failure', 'bug', 'missing'], 'var(--state-error)'],
  [['question', 'example', 'quote', 'todo'], 'var(--color-accent)']
]

/**
 * 展开成 `.cm-md-callout-xxx { --callout-accent }` + 标题同色。
 * 只暴露 CSS 变量，颜色本身统一由 `var(--callout-accent, …)` 消费 ——
 * 与 style.css 的 `.callout-*` 分组写法一致，两种模式算出来的颜色必然相同。
 */
function buildCalloutRules() {
  const rules = {}
  for (const [types, accent] of CALLOUT_ACCENTS) {
    rules[types.map(t => `.cm-line.cm-md-callout-${t}`).join(', ')] = { '--callout-accent': accent }
    rules[types.map(t => `.cm-line.cm-md-callout-${t} .cm-md-callout-title`).join(', ')] = {
      color: 'var(--callout-accent, var(--color-primary))'
    }
  }
  return rules
}

const mdDecorationsTheme = EditorView.theme({
  // ---- 标题（字号/字重/间距与 .markdown-body h1~h6 一致）----
  '.cm-line.cm-md-heading': {
    fontFamily: 'var(--font-title)',
    fontWeight: '600',
    color: 'var(--color-text-primary)',
    lineHeight: '1.3',
    letterSpacing: '-0.3px'
  },
  '.cm-line.cm-md-h1': { fontSize: '1.86em', marginTop: '1.6em', marginBottom: '0.5em' },
  '.cm-line.cm-md-h2': { fontSize: '1.53em', marginTop: '1.6em', marginBottom: '0.5em' },
  '.cm-line.cm-md-h3': { fontSize: '1.27em', marginTop: '1.6em', marginBottom: '0.5em' },
  '.cm-line.cm-md-h4': { fontSize: '1.07em', marginTop: '1.6em', marginBottom: '0.5em' },
  '.cm-line.cm-md-h5': { fontSize: '0.93em', marginTop: '1.6em', marginBottom: '0.5em' },
  '.cm-line.cm-md-h6': { fontSize: '0.87em', marginTop: '1.6em', marginBottom: '0.5em', color: 'var(--color-text-secondary)' },
  // ---- 行内强调 ----
  // 加粗只改字重：颜色继承所在行，才能与阅读视图里 strong 的表现一致
  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-highlight': {
    background: 'rgba(255, 213, 79, 0.4)',
    color: 'inherit',
    borderRadius: '3px',
    padding: '0 1px'
  },
  '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--color-text-tertiary)' },
  // 行内代码：背景 / 圆角 / 内边距 / 颜色全部对齐 .markdown-body :not(pre) > code
  '.cm-md-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: 'calc(13px * var(--editor-zoom, 1))',
    background: 'var(--color-bg-tertiary)',
    borderRadius: '5px',
    padding: '2px 6px',
    color: 'var(--color-primary-darker)'
  },
  // ---- 链接 / 双链 / 标签 ----
  // 双链对齐 a.wikilink：胶囊底 + 主色
  '.cm-md-wikilink': {
    display: 'inline',
    color: 'var(--color-primary)',
    background: 'var(--color-primary-surface)',
    padding: '1px 6px',
    borderRadius: '5px',
    textDecoration: 'none',
    cursor: 'pointer',
    fontWeight: '500',
    border: '1px solid transparent'
  },
  '.cm-md-wikilink:hover': { background: 'var(--color-primary-lighter)' },
  // 未创建的笔记：与 `a.wikilink.is-unresolved` 完全一致（灰 / 斜体 / 虚线 / 尾部 +）
  '.cm-md-wikilink-missing': {
    color: 'var(--color-text-tertiary)',
    background: 'var(--color-bg-tertiary)',
    borderStyle: 'dashed',
    borderColor: 'var(--color-border)',
    fontStyle: 'italic'
  },
  '.cm-md-wikilink-missing::after': {
    content: "'+'",
    marginLeft: '3px',
    fontWeight: '600',
    opacity: '0.6'
  },
  // 普通链接对齐 .markdown-body a：默认无下划线，hover 才有
  '.cm-md-link, .cm-md-bare-url': {
    color: 'var(--color-primary)',
    textDecoration: 'none',
    cursor: 'pointer'
  },
  '.cm-md-link:hover, .cm-md-bare-url:hover': {
    textDecoration: 'underline',
    textUnderlineOffset: '2px'
  },
  '.cm-md-image': { color: 'var(--color-primary)' },
  '.cm-md-tag': {
    color: 'var(--color-primary)',
    background: 'var(--color-primary-surface)',
    borderRadius: '999px',
    padding: '1px 8px',
    fontSize: '0.86em',
    fontWeight: '500'
  },
  // ---- 列表 / 任务 ----
  '.cm-line.cm-md-list-line': { paddingLeft: '6px' },
  '.cm-md-list-marker': {
    color: 'var(--color-text-tertiary)',
    fontWeight: '600',
    display: 'inline-block',
    minWidth: '1.1em'
  },
  '.cm-line.cm-md-task-line': { paddingLeft: '2px' },
  '.cm-md-checkbox-wrap': { display: 'inline-flex', alignItems: 'center', marginRight: '2px', verticalAlign: 'middle' },
  '.cm-md-checkbox': {
    width: '15px',
    height: '15px',
    accentColor: 'var(--color-primary)',
    cursor: 'pointer'
  },
  // ---- 引用：对齐 .markdown-body blockquote ----
  '.cm-line.cm-md-quote-line': {
    padding: '0.6em 1em',
    borderLeft: '3px solid var(--color-border)',
    background: 'var(--color-bg-secondary)',
    borderRadius: '0 8px 8px 0',
    color: 'var(--color-text-body)'
  },
  // ---- callout：对齐 .obsidian-callout（4px accent 左边框 / 10px 圆角 / secondary 底）----
  '.cm-line.cm-md-callout': {
    borderLeftWidth: '4px',
    borderLeftColor: 'var(--callout-accent, var(--color-primary))',
    background: 'var(--color-bg-secondary)'
  },
  // 正文行：对应 .callout-body 的左右 14px（纵向间距交给行高，避免每行都加 padding）
  '.cm-line.cm-md-callout:not(.cm-md-callout-first)': { padding: '0 14px', borderRadius: '0' },
  // 末行：底部圆角 + 收口（对应 .callout-body 的 8px 14px 10px）
  '.cm-line.cm-md-callout:not(.cm-md-callout-first).cm-md-callout-last': {
    borderBottomLeftRadius: '10px',
    borderBottomRightRadius: '10px',
    padding: '0 14px 10px'
  },
  // 首行：标题栏（对应 .callout-header 的 8px 12px / 600 / accent 12% 底 / accent 字色）
  '.cm-line.cm-md-callout-first': {
    borderTopLeftRadius: '10px',
    borderTopRightRadius: '10px',
    padding: '8px 12px',
    fontWeight: '600',
    background: 'color-mix(in srgb, var(--callout-accent, var(--color-primary)) 12%, transparent)',
    color: 'var(--callout-accent, var(--color-primary))'
  },
  '.cm-md-callout-title': { fontWeight: '600' },
  ...buildCalloutRules(),
  // ---- 表格：与 .markdown-body table / th / td 逐一对应 ----
  '.cm-md-table': {
    width: '100%',
    borderCollapse: 'collapse',
    borderRadius: '10px',
    overflow: 'hidden',
    fontSize: 'calc(14px * var(--editor-zoom, 1))',
    boxShadow: 'var(--shadow-xs)',
    margin: '0.85em 0',
    color: 'var(--color-text-primary)'
  },
  '.cm-md-table th, .cm-md-table td': {
    padding: '8px 12px',
    border: '1px solid var(--color-border-light)',
    borderTop: 'none',
    borderLeft: 'none'
  },
  '.cm-md-table th': {
    background: 'var(--color-bg-secondary)',
    fontWeight: '600',
    textAlign: 'left',
    color: 'var(--color-text-primary)'
  },
  '.cm-md-table td': { color: 'var(--color-text-body)' },
  '.cm-md-table tr:last-child td': { borderBottom: 'none' },
  '.cm-md-table th:last-child, .cm-md-table td:last-child': { borderRight: 'none' },
  // 光标在表格内时的源码态：等宽 + 表头底色，列结构仍然可见
  '.cm-line.cm-md-table-row': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em'
  },
  '.cm-line.cm-md-table-header': { fontWeight: '600', background: 'var(--color-bg-secondary)' },
  // ---- 代码块：逐行拼成一个盒子，视觉等同 pre.code-block ----
  '.cm-line.cm-md-code-line': {
    fontFamily: 'var(--font-mono)',
    fontSize: 'calc(13px * var(--editor-zoom, 1))',
    lineHeight: '1.6',
    background: 'var(--color-bg-secondary)',
    borderLeft: '1px solid var(--color-border-light)',
    borderRight: '1px solid var(--color-border-light)',
    paddingLeft: '16px',
    paddingRight: '16px'
  },
  '.cm-line.cm-md-code-first': {
    position: 'relative',
    borderTop: '1px solid var(--color-border-light)',
    borderTopLeftRadius: '10px',
    borderTopRightRadius: '10px',
    paddingTop: '16px'
  },
  '.cm-line.cm-md-code-last': {
    borderBottom: '1px solid var(--color-border-light)',
    borderBottomLeftRadius: '10px',
    borderBottomRightRadius: '10px',
    paddingBottom: '14px'
  },
  // 语言角标：与 .markdown-body pre.code-block::before 完全同款
  '.cm-line.cm-md-code-first::before': {
    content: 'attr(data-code-lang)',
    position: 'absolute',
    top: '6px',
    right: '10px',
    fontSize: '10px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--color-text-tertiary)',
    fontFamily: 'var(--font-mono)'
  },
  '.cm-line.cm-md-code-fence': { fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
  '.cm-md-code-lang': { color: 'var(--color-text-tertiary)', fontStyle: 'italic' },
  '.cm-line.cm-md-raw-block': { fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
  // 注：`.cm-md-frontmatter-fence` 已随 buildForLine 里那段 frontmatter 分支一起移除 ——
  // frontmatter 整段现在由 collectFrontmatterLines 负责，统一走 .cm-md-raw-block。
  // 与 .markdown-body hr 同款：1px 实色条（用 height+background，不用 border-top）
  '.cm-md-hr': {
    border: 'none',
    height: '1px',
    background: 'var(--color-border)',
    margin: '1.5em 0'
  },
  // ---- 嵌入 / 图片 ----
  '.cm-md-embed': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '6px',
    background: 'var(--color-bg-tertiary)',
    border: '1px solid var(--color-border-light)',
    fontSize: '0.9em',
    color: 'var(--color-text-secondary)'
  },
  '.cm-md-image-wrap': { display: 'inline-block', maxWidth: '100%' },
  '.cm-md-image': {
    maxWidth: '100%',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-sm)',
    verticalAlign: 'middle'
  },
  '.cm-md-image-fallback': { color: 'var(--color-text-tertiary)', fontSize: '0.9em' }
}, { dark: false })

/**
 * 深色下的少量差异项（阅读视图用 [data-theme='dark'] 覆盖同一批属性）。
 *
 * ⚠️ CodeMirror 挂载 style module 时传的是
 *    `StyleModule.mount(root, styleModules.concat(baseTheme).reverse())`
 *    —— 数组会被**反转**后再写进样式表（见 @codemirror/view dist 第 8308 行），
 *    所以「想让它生效的覆盖」必须放在数组**更前面**，而不是后面。
 */
const mdDecorationsDarkTheme = EditorView.theme({
  '.cm-md-inline-code': { color: 'var(--color-primary-light)' }
}, { dark: true })

function safeTag(tagExpr) {
  try {
    const result = typeof tagExpr === 'function' ? tagExpr() : tagExpr
    if (result === undefined || result === null) return null
    return result
  } catch (e) {
    return null
  }
}

function buildHighlightStyle(specs) {
  const valid = []
  for (const spec of specs) {
    const tag = safeTag(spec.tag)
    if (tag) {
      valid.push({ ...spec, tag })
    }
  }
  if (valid.length === 0) {
    return HighlightStyle.define([{ tag: t.comment, color: '#888' }])
  }
  return HighlightStyle.define(valid)
}

const lightHighlightStyle = buildHighlightStyle([
  { tag: () => t.heading1, color: '#202124', fontWeight: '700', fontSize: '2em' },
  { tag: () => t.heading2, color: '#202124', fontWeight: '700', fontSize: '1.5em' },
  { tag: () => t.heading3, color: '#202124', fontWeight: '600', fontSize: '1.25em' },
  { tag: () => t.heading4, color: '#202124', fontWeight: '600' },
  { tag: () => t.heading5, color: '#202124', fontWeight: '600' },
  { tag: () => t.heading6, color: '#202124', fontWeight: '600' },
  { tag: () => t.strong, fontWeight: '700' },
  { tag: () => t.emphasis, fontStyle: 'italic' },
  { tag: () => t.strikethrough, textDecoration: 'line-through' },
  { tag: () => t.link, color: '#4a90d9', textDecoration: 'underline' },
  { tag: () => t.url, color: '#4a90d9' },
  { tag: () => t.monospace, color: '#ea4335', fontFamily: 'var(--font-mono)' },
  { tag: () => t.codeBlock, color: '#3c4043', fontFamily: 'var(--font-mono)' },
  { tag: () => t.processingInstruction, color: '#5f6368' },
  { tag: () => t.comment, color: '#80868b', fontStyle: 'italic' },
  { tag: () => t.keyword, color: '#a142f4' },
  { tag: () => t.atom, color: '#e53935' },
  { tag: () => t.number, color: '#fbbc04' },
  { tag: () => t.string, color: '#34a853' },
  { tag: () => t.variableName, color: '#4a90d9' },
  { tag: () => t.typeName, color: '#e53935' },
  { tag: () => t.definition && t.definition(t.variableName), color: '#4a90d9' },
  { tag: () => t.bool, color: '#e53935' },
  { tag: () => t.invalid, color: '#ea4335' },
  { tag: () => t.meta, color: '#5f6368' },
  { tag: () => t.documentMeta, color: '#5f6368', fontWeight: '600' },
  { tag: () => t.list, color: '#4a90d9' },
  { tag: () => t.quote, color: '#5f6368', fontStyle: 'italic' },
  { tag: () => t.inserted, color: '#34a853' },
  { tag: () => t.deleted, color: '#ea4335' },
  { tag: () => t.changed, color: '#fbbc04' },
  { tag: () => t.labelName, color: '#a142f4' },
  { tag: () => t.name, color: '#4a90d9' },
  { tag: () => t.contentSeparator, color: '#dadce0' },
  { tag: () => t.macroName, color: '#a142f4' }
])

const darkHighlightStyle = buildHighlightStyle([
  { tag: () => t.heading1, color: '#e8eaed', fontWeight: '700', fontSize: '2em' },
  { tag: () => t.heading2, color: '#e8eaed', fontWeight: '700', fontSize: '1.5em' },
  { tag: () => t.heading3, color: '#e8eaed', fontWeight: '600', fontSize: '1.25em' },
  { tag: () => t.heading4, color: '#e8eaed', fontWeight: '600' },
  { tag: () => t.heading5, color: '#e8eaed', fontWeight: '600' },
  { tag: () => t.heading6, color: '#e8eaed', fontWeight: '600' },
  { tag: () => t.strong, fontWeight: '700' },
  { tag: () => t.emphasis, fontStyle: 'italic' },
  { tag: () => t.strikethrough, textDecoration: 'line-through' },
  { tag: () => t.link, color: '#8ab4f8', textDecoration: 'underline' },
  { tag: () => t.url, color: '#8ab4f8' },
  { tag: () => t.monospace, color: '#f28b82', fontFamily: 'var(--font-mono)' },
  { tag: () => t.codeBlock, color: '#bdc1c6', fontFamily: 'var(--font-mono)' },
  { tag: () => t.processingInstruction, color: '#9aa0a6' },
  { tag: () => t.comment, color: '#80868b', fontStyle: 'italic' },
  { tag: () => t.keyword, color: '#c58af9' },
  { tag: () => t.atom, color: '#f28b82' },
  { tag: () => t.number, color: '#fdd663' },
  { tag: () => t.string, color: '#81c995' },
  { tag: () => t.variableName, color: '#8ab4f8' },
  { tag: () => t.typeName, color: '#f28b82' },
  { tag: () => t.definition && t.definition(t.variableName), color: '#8ab4f8' },
  { tag: () => t.bool, color: '#f28b82' },
  { tag: () => t.invalid, color: '#f28b82' },
  { tag: () => t.meta, color: '#9aa0a6' },
  { tag: () => t.documentMeta, color: '#9aa0a6', fontWeight: '600' },
  { tag: () => t.list, color: '#8ab4f8' },
  { tag: () => t.quote, color: '#9aa0a6', fontStyle: 'italic' },
  { tag: () => t.inserted, color: '#81c995' },
  { tag: () => t.deleted, color: '#f28b82' },
  { tag: () => t.changed, color: '#fdd663' },
  { tag: () => t.labelName, color: '#c58af9' },
  { tag: () => t.name, color: '#8ab4f8' },
  { tag: () => t.contentSeparator, color: '#3c4043' },
  { tag: () => t.macroName, color: '#c58af9' }
])

export function getEditorTheme(isDark) {
  const base = isDark
    ? [darkTheme, syntaxHighlighting(darkHighlightStyle)]
    : [lightTheme, syntaxHighlighting(lightHighlightStyle)]
  // 注意顺序：styleModules 会被 reverse 后写入样式表（见 mdDecorationsDarkTheme 注释），
  // 因此深色覆盖必须排在 mdDecorationsTheme **之前**才能真正覆盖它。
  return isDark
    ? [...base, mdDecorationsDarkTheme, mdDecorationsTheme]
    : [...base, mdDecorationsTheme]
}
