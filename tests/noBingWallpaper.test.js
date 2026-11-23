/**
 * Bing 壁纸功能已彻底移除的回归守卫。
 *
 * 只禁用运行时符号与外链来源；英文单词 bingo / grabbing 等不算命中。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const forbidden = [
  'bing_fetch_wallpaper',
  'fetchBingWallpaper',
  'setBingWallpaper',
  'toggleBingWallpaper',
  'WALLPAPER_MARKETS',
  'bing.biturl.top',
  'HPImageArchive'
]

function collectFiles (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'target', 'dist', '.git', 'tmp', 'release-assets'].includes(entry.name)) continue
    if (entry.name === 'noBingWallpaper.test.js') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (/\.(js|vue|rs|json|md|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('Bing 壁纸功能已移除', () => {
  it('源码与配置中不再出现壁纸运行时符号', () => {
    const hits = []
    for (const file of collectFiles(root)) {
      const text = fs.readFileSync(file, 'utf-8')
      for (const token of forbidden) {
        if (text.includes(token)) hits.push(`${path.relative(root, file)} -> ${token}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('CSP 不再放行 bing 域名', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf-8'))
    const csp = conf.app?.security?.csp || ''
    expect(csp).not.toContain('bing.com')
  })

  it('bingWallpaper.js 已删除', () => {
    expect(fs.existsSync(path.join(root, 'src/utils/bingWallpaper.js'))).toBe(false)
  })
})
