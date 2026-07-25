import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-body)',
    fontFamily: "var(--font-mono), 'Consolas', 'Monaco', 'Courier New', monospace",
    lineHeight: '1.7'
  },
  '.cm-content': {
    caretColor: 'var(--color-primary)',
    padding: '20px 24px',
    minHeight: '100%'
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-primary)',
    borderLeftWidth: '2px'
  },
  '.cm-line': {
    padding: '0 4px'
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(74, 144, 217, 0.2) !important'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    padding: '20px 8px 20px 16px',
    fontSize: '12px',
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
    borderRadius: '8px',
    boxShadow: 'var(--shadow-float)',
    padding: '4px'
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '6px 10px',
      borderRadius: '4px'
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
    borderRadius: '6px',
    padding: '4px 10px',
    color: 'var(--color-text-primary)',
    cursor: 'pointer'
  },
  '.cm-button:hover': {
    backgroundColor: 'var(--color-surface-hover)'
  },
  '.cm-textfield': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    padding: '4px 8px',
    color: 'var(--color-text-primary)'
  },
  '.cm-textfield:focus': {
    outline: 'none',
    borderColor: 'var(--color-primary)',
    boxShadow: '0 0 0 3px var(--color-primary-ring)'
  },
  '.cm-spell-error': {
    textDecoration: 'wavy underline var(--state-error)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '2px',
    cursor: 'pointer'
  }
}, { dark: false })

const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-body)',
    fontFamily: "var(--font-mono), 'Consolas', 'Monaco', 'Courier New', monospace",
    lineHeight: '1.7'
  },
  '.cm-content': {
    caretColor: 'var(--color-primary)',
    padding: '20px 24px',
    minHeight: '100%'
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-primary)',
    borderLeftWidth: '2px'
  },
  '.cm-line': {
    padding: '0 4px'
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(74, 144, 217, 0.35) !important'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    padding: '20px 8px 20px 16px',
    fontSize: '12px',
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
    borderRadius: '8px',
    boxShadow: 'var(--shadow-float)',
    padding: '4px'
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '6px 10px',
      borderRadius: '4px'
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
    borderRadius: '6px',
    padding: '4px 10px',
    color: 'var(--color-text-primary)',
    cursor: 'pointer'
  },
  '.cm-button:hover': {
    backgroundColor: 'var(--color-surface-hover)'
  },
  '.cm-textfield': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    padding: '4px 8px',
    color: 'var(--color-text-primary)'
  },
  '.cm-textfield:focus': {
    outline: 'none',
    borderColor: 'var(--color-primary)',
    boxShadow: '0 0 0 3px var(--color-primary-ring)'
  },
  '.cm-spell-error': {
    textDecoration: 'wavy underline var(--state-error)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '2px',
    cursor: 'pointer'
  }
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
  return isDark ? [darkTheme, syntaxHighlighting(darkHighlightStyle)] : [lightTheme, syntaxHighlighting(lightHighlightStyle)]
}
