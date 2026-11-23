/**
 * UI / 安全审计修复守卫（源码级，不渲染 DOM）。
 *
 * 锁定四件事，避免回滚到审计前的状态：
 *  1. 欢迎页主按钮文本走 --btn-primary-text，而不是硬编码白色；
 *  2. 该 token 在 :root / [data-theme='dark'] / .electron-mode /
 *     .electron-mode[data-theme='dark'] 四个块都有定义，浏览器与亚克力暗色不漂移；
 *  3. Mermaid 渲染错误分支对 e.message 做 HTML 转义；
 *  4. 已删除的 callout 回填路径不再回来，vault normalize 不再丢 decryptFailed。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

const welcome = read(path.join('src', 'views', 'WelcomeView.vue'))
const css = read(path.join('src', 'style.css'))
const markdown = read(path.join('src', 'utils', 'markdown.js'))
const vault = read(path.join('src', 'stores', 'vault.js'))
const vaultView = read(path.join('src', 'views', 'VaultView.vue'))

/** 取顶层规则块体（花括号配对），避免把注释里提到的选择器当成真块。 */
function blockBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{`, 'm')
  const m = re.exec(css)
  if (!m) return ''
  const start = css.indexOf('{', m.index)
  let depth = 0
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(start + 1, i)
    }
  }
  return ''
}

function tokenValue(selector) {
  const body = blockBody(selector)
  const m = /--btn-primary-text\s*:\s*([^;]+);/.exec(body)
  return m ? m[1].trim() : ''
}

describe('欢迎页主按钮文本 token', () => {
  it('WelcomeView 不再硬编码白色，改用 --btn-primary-text', () => {
    expect(welcome).toContain('var(--btn-primary-text)')
    expect(welcome).not.toContain('#ffffff')
    expect(welcome).not.toContain('text-white')
  })

  it('四个主题块都定义 --btn-primary-text，避免暗色/亚克力漂移', () => {
    for (const selector of [
      ':root',
      "[data-theme='dark']",
      '.electron-mode',
      ".electron-mode[data-theme='dark']",
    ]) {
      expect(blockBody(selector), `${selector} 缺少 --btn-primary-text 定义`).toMatch(
        /--btn-primary-text\s*:/,
      )
    }
  })

  it('浅色与浏览器暗色跟随已存在的 text-on-primary token', () => {
    expect(tokenValue(':root')).toBe('var(--color-text-on-primary)')
    expect(tokenValue("[data-theme='dark']")).toBe('var(--color-text-on-primary)')
  })

  it('两个亚克力块用半透明前景色，且注释说明是文本 token 而非背景 token', () => {
    expect(tokenValue('.electron-mode')).toBe('rgba(255, 255, 255, 0.95)')
    expect(tokenValue(".electron-mode[data-theme='dark']")).toBe('rgba(32, 33, 36, 0.95)')
    expect(css).toMatch(/主按钮文本 token[^\n]*前景色[^\n]*不是背景 token/)
  })
})

describe('markdown 渲染安全', () => {
  it('Mermaid 错误分支转义 e.message（错误 class 与文案前缀保持不变）', () => {
    expect(markdown).toContain('escapeHtml(e.message)')
    expect(markdown).toContain('<div class="mermaid-error">图表渲染失败: ')
    expect(markdown).not.toContain('图表渲染失败: ${e.message}')
  })

  it('callout 回填路径已删除：不导出函数、不留 template 占位', () => {
    expect(markdown).not.toContain('hydrateCalloutsInContainer')
    expect(markdown).not.toContain('data-callout-inner')
    expect(markdown).not.toContain('unescapeHtml')
  })
})

describe('vault 解密失败不再静默为空', () => {
  it('normalize 保留 decryptFailed 标记', () => {
    expect(vault).toContain('decryptFailed: !!e.decryptFailed')
  })

  it('VaultView 给解密失败条目可访问提示（title + aria-label + 行内文案）', () => {
    expect(vaultView).toContain('entry.decryptFailed')
    expect(vaultView).toContain('解密失败（无法读取）')
    expect(vaultView).toContain(':aria-label="entry.decryptFailed')
    expect(vaultView).toContain('请重新输入该值')
  })
})
