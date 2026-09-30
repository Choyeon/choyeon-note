/**
 * 侧边栏外壳（chrome）结构闸门
 *
 * 覆盖的不是业务逻辑，而是「改版之后不许退化回去」的**结构事实**。分两组：
 *
 * A · 真挂载（createApp + pinia + router，jsdom）：
 *    收起按钮与搜索按钮的关系、根级笔记行的悬停操作区。
 *    为什么真挂载：这些是 DOM 父子关系 / class，断言源码字符串证不到 ——
 *    源码里写 `<button>` 写在哪一层，只有渲染出来才知道。
 *    项目没装 @vue/test-utils 也不允许为此引依赖，这里与
 *    tests/commandPaletteDisabledUI.test.js 同一口径：createApp(...).mount(host)。
 *
 * B · 源文本断言：收起态窄栏的布局形态（.sidebar-rail 必须是 <main> 之前的
 *    真实 flex 兄弟、绝不能是 absolute）。这个没法靠挂载证 —— jsdom 不做布局，
 *    元素是否遮挡 main 取决于它有没有脱离文档流，只能查源码结构。
 *
 * 三条历史回归，改任何一条前请先看这里的注释：
 *   1. button 套 button（收起按钮被塞进搜索按钮里）→ 非法 HTML，浏览器会拆节点；
 *   2. .sidebar-rail 加 absolute → 「收起后遮挡 main 内容」立刻回归；
 *   3. 两个按钮尺寸/圆角/阴影不一致 → 收起时按钮像换了一个控件。
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import Sidebar from '../src/components/Sidebar.vue'
import { useNoteStore } from '../src/stores/note'

// 与 tests/trashMethodWiring.test.js 同一口径：vitest 在仓库根目录起，
// 用 process.cwd() 定位源码，不依赖 import.meta.url（转换后它不是 file: 协议）。
const PROJECT_ROOT = process.cwd()

/**
 * 读源码文本（B 组断言用）。
 * @param {string} rel 相对项目根目录的路径，如 'src/App.vue'
 * @returns {string} 文件全文
 */
function readSrc (rel) {
  return readFileSync(resolve(PROJECT_ROOT, rel.replace(/^\//, '')), 'utf8')
}

// ---------------------------------------------------------------------------
// 几何常量（单位 px）：收起按钮在两个状态下「不许跳位」的账本。
// 单独抽成常量而不是写在断言里，是为了让「为什么是 2px」这件事可读、可测。
// ---------------------------------------------------------------------------
/** 收起态窄栏宽度：w-12 */
const RAIL_WIDTH = 48
/** 切换按钮尺寸：w-9 */
const TOGGLE_SIZE = 36
/** 展开态侧边栏行内横向内边距：px-2 */
const SIDEBAR_ROW_PADDING = 8
/** 两个状态的按钮上边缘内边距：pt-2 */
const ROW_TOP_PADDING = 8

/** 收起态：窄栏里水平居中 → 左边缘 = (48 - 36) / 2 */
const COLLAPSED_LEFT = (RAIL_WIDTH - TOGGLE_SIZE) / 2
/** 展开态：按钮靠行内左边缘 → 左边缘 = px-2 */
const EXPANDED_LEFT = SIDEBAR_ROW_PADDING

let app = null
let host = null

/**
 * 造一条根级笔记：只要能进 sortedRootNotes 并渲染出 .tree-note 即可。
 * @param {string} id 笔记 id
 * @param {string} title 标题
 * @returns {object} 笔记对象
 */
function makeNote (id, title) {
  return {
    id,
    title,
    folder: '',
    content: '',
    tags: [],
    filePath: null,
    createdAt: 1,
    updatedAt: 1
  }
}

/**
 * 真挂载侧边栏，并塞一条根级笔记让 .tree-note 渲染出来。
 * @returns {Promise<{host: HTMLElement, noteStore: object}>}
 */
async function mountSidebar () {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/search', component: { template: '<div />' } },
      { path: '/editor/:id', component: { template: '<div />' } }
    ]
  })
  host = document.createElement('div')
  document.body.appendChild(host)

  const noteStore = useNoteStore()
  noteStore.notes.length = 0
  noteStore.notes.push(makeNote('n1', '根级笔记一'))

  app = createApp(Sidebar)
  app.use(pinia)
  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(host)
  await nextTick()
  return { host, noteStore }
}

afterEach(() => {
  if (app) {
    app.unmount()
    app = null
  }
  if (host) {
    host.remove()
    host = null
  }
})

describe('侧边栏外壳 · 收起/展开按钮（真挂载）', () => {
  it('收起按钮不在搜索按钮内部（button 套 button 是非法 HTML）', async () => {
    const { host: el } = await mountSidebar()
    const collapseBtn = el.querySelector('button.sidebar-collapse-btn')
    const searchBtn = el.querySelector('button.sidebar-search-btn')
    expect(collapseBtn, '找不到收起按钮').toBeTruthy()
    expect(searchBtn, '找不到搜索按钮').toBeTruthy()
    // 双向断言：谁包谁都不行
    expect(searchBtn.contains(collapseBtn)).toBe(false)
    expect(collapseBtn.contains(searchBtn)).toBe(false)
  })

  it('收起按钮与搜索按钮是同级兄弟（各自成行，不嵌套）', async () => {
    const { host: el } = await mountSidebar()
    const collapseBtn = el.querySelector('button.sidebar-collapse-btn')
    const searchBtn = el.querySelector('button.sidebar-search-btn')
    expect(collapseBtn.parentElement).toBe(searchBtn.parentElement)
    // 两个 button 之间没有别的 button 层：父节点里只有这两个 button
    expect(collapseBtn.parentElement.querySelectorAll('button').length).toBe(2)
  })

  it('收起按钮带 sidebar-collapse-btn 类与「收起侧边栏」title', async () => {
    const { host: el } = await mountSidebar()
    const collapseBtn = el.querySelector('button.sidebar-collapse-btn')
    expect(collapseBtn.classList.contains('sidebar-collapse-btn')).toBe(true)
    expect(collapseBtn.getAttribute('title')).toBe('收起侧边栏')
  })

  it('搜索框独占整行（w-full），不再被收起按钮挤掉宽度', async () => {
    const { host: el } = await mountSidebar()
    const searchBtn = el.querySelector('button.sidebar-search-btn')
    expect(searchBtn.classList.contains('w-full')).toBe(true)
  })
})

describe('侧边栏外壳 · 根级笔记行悬停操作区（真挂载）', () => {
  it('.tree-note 带 group 类，且行内有 .row-actions', async () => {
    const { host: el } = await mountSidebar()
    const rows = el.querySelectorAll('.tree-note')
    expect(rows.length, '至少要有渲染出来的根级笔记行').toBeGreaterThan(0)
    rows.forEach(row => {
      expect(row.classList.contains('group')).toBe(true)
      const actions = row.querySelectorAll('.row-actions')
      expect(actions.length, '根级笔记行缺悬停操作区').toBe(1)
    })
  })

  it('.row-actions 里是重命名与删除两个小按钮', async () => {
    const { host: el } = await mountSidebar()
    const actions = el.querySelector('.tree-note .row-actions')
    const buttons = actions.querySelectorAll('button')
    expect(buttons.length).toBe(2)
    const titles = Array.from(buttons).map(b => b.getAttribute('title'))
    expect(titles[0]).toBe('重命名')
    expect(titles[1]).toBe('移到废纸篓')
  })
})

describe('侧边栏外壳 · 收起态窄栏结构闸门（源文本）', () => {
  it('.sidebar-rail 不是 absolute，且出现在 <main> 之前（遮挡 bug 的结构防线）', () => {
    const appSrc = readSrc('src/App.vue')
    // 匹配 `class="sidebar-rail `：注释里也会提到 .sidebar-rail，只看真正挂在元素上的那次
    const railIdx = appSrc.indexOf('class="sidebar-rail ')
    // 匹配 `<main class=`：模板上方那段「旧实现是 <main> 内部一个 absolute…」的
    // 说明里也有 <main> 字样，按标签原样匹配会命中注释而不是真实元素
    const mainIdx = appSrc.indexOf('<main class=')
    expect(railIdx, 'App.vue 里找不到 sidebar-rail').toBeGreaterThan(-1)
    expect(mainIdx).toBeGreaterThan(-1)
    expect(railIdx, '.sidebar-rail 必须排在 <main> 之前').toBeLessThan(mainIdx)

    // 只看这个元素自己的开标签，避免把注释里的 "absolute" 也算进去
    const openTag = appSrc.slice(appSrc.lastIndexOf('<div', railIdx), appSrc.indexOf('>', railIdx))
    expect(openTag).toContain('sidebar-rail')
    expect(/absolute/.test(openTag), '.sidebar-rail 一旦 absolute 就会脱离文档流压住 main').toBe(false)
    expect(openTag).toContain('shrink-0')
  })

  it('窄栏宽度与按钮尺寸符合几何账：收起/展开两态左边缘差 ≤ 8px、上边缘对齐', () => {
    const appSrc = readSrc('src/App.vue')
    const sidebarSrc = readSrc('src/components/Sidebar.vue')

    // 常量必须和源码对得上，否则账本会跟实现漂移
    expect(appSrc).toMatch(/class="sidebar-rail w-12\b/)
    expect(appSrc).toMatch(/class="sidebar-rail-btn w-9 h-9\b/)
    expect(sidebarSrc).toMatch(/class="sidebar-collapse-btn w-9 h-9\b/)
    // 窄栏与侧边栏头部的上内边距都是 pt-2 → 上边缘同为 8px
    expect(appSrc).toMatch(/class="sidebar-rail[^"]*\bpt-2\b/)
    expect(sidebarSrc).toMatch(/class="sidebar-header[^"]*\bpt-2\b/)

    expect(RAIL_WIDTH).toBe(48)
    expect(TOGGLE_SIZE).toBe(36)
    expect(COLLAPSED_LEFT).toBe(6)
    expect(EXPANDED_LEFT).toBe(8)
    expect(ROW_TOP_PADDING).toBe(8)
    expect(Math.abs(COLLAPSED_LEFT - EXPANDED_LEFT)).toBeLessThanOrEqual(8)
  })

  it('两个切换按钮共用同一套尺寸/圆角/对齐类，只有方向图标不同', () => {
    const appSrc = readSrc('src/App.vue')
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const classes = [
      (sidebarSrc.match(/class="sidebar-collapse-btn[^"]*"/) || [''])[0],
      (appSrc.match(/class="sidebar-rail-btn[^"]*"/) || [''])[0]
    ]
    classes.forEach(cls => {
      expect(cls, '两个按钮都要能取到 class 串').not.toBe('')
      expect(cls).toContain('w-9 h-9')
      expect(cls).toContain('rounded-lg')
      expect(cls).toContain('flex items-center justify-center')
    })
    // 方向图标：收起是 PanelLeft，展开是 PanelRight
    expect(sidebarSrc).toContain('<PanelLeft')
    expect(appSrc).toContain('<PanelRight')
  })

  it('两个切换按钮共用同一套视觉 token（底 / 边框 / 阴影 / hover）', () => {
    const appSrc = readSrc('src/App.vue')
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const rules = [
      [sidebarSrc, 'sidebar-collapse-btn'],
      [appSrc, 'sidebar-rail-btn']
    ]
    rules.forEach(([src, cls]) => {
      expect(new RegExp(`\\.${cls}\\s*\\{[^}]*background:\\s*var\\(--color-surface\\)`).test(src),
        `.${cls} 缺 surface 底`).toBe(true)
      expect(new RegExp(`\\.${cls}\\s*\\{[^}]*border:\\s*1px solid var\\(--color-border\\)`).test(src),
        `.${cls} 缺边框`).toBe(true)
      expect(new RegExp(`\\.${cls}\\s*\\{[^}]*box-shadow:\\s*var\\(--shadow-sm\\)`).test(src),
        `.${cls} 缺 --shadow-sm`).toBe(true)
      expect(new RegExp(`\\.${cls}:hover\\s*\\{[^}]*box-shadow:\\s*var\\(--shadow-md\\)`).test(src),
        `.${cls}:hover 缺 --shadow-md`).toBe(true)
    })
  })

  it('窄栏涂了侧边栏底色（收起态是「变窄的侧边栏」，不是空白里飘一个按钮）', () => {
    const appSrc = readSrc('src/App.vue')
    expect(/\.sidebar-rail\s*\{[^}]*background:\s*var\(--sidebar-bg\)/.test(appSrc)).toBe(true)
    expect(/\.sidebar-rail\s*\{[^}]*border-right:\s*1px solid var\(--color-border\)/.test(appSrc)).toBe(true)
  })

  it('选中行有左侧主色条（.nav-item / .tree-note / .root-folder-row / FolderNode 两处一致）', () => {
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const folderSrc = readSrc('src/components/FolderNode.vue')
    // Sidebar：三个选中态共用一条 ::before 规则
    const bar = sidebarSrc.match(/\.nav-item\.is-active::before,[\s\S]*?\{[^}]*\}/)
    expect(bar, 'Sidebar 缺选中态色条规则').toBeTruthy()
    expect(bar[0]).toContain('.tree-note.is-selected::before')
    expect(bar[0]).toContain('.root-folder-row.is-active::before')
    expect(bar[0]).toContain('background: var(--color-primary)')
    // FolderNode 同步同款
    expect(/\.folder-row\.is-selected::before,\s*\.note-row\.is-selected::before/.test(folderSrc)).toBe(true)
  })

  it('分区标题同规格：同一组 class + 同一 span 规格，只有上间距不同', () => {
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const titles = sidebarSrc.match(/<div class="sidebar-section-title[^"]*"/g) || []
    expect(titles.length).toBeGreaterThanOrEqual(2)
    titles.forEach(t => {
      expect(t).toContain('mb-1')
      expect(/mt-1|mt-4/.test(t)).toBe(true)
    })
    const spans = sidebarSrc.match(/<span class="text-\[11px\] font-semibold uppercase tracking-wider"/g) || []
    expect(spans.length).toBeGreaterThanOrEqual(2)
    // 旧的 font-medium 规格必须全部换成 font-semibold
    expect(sidebarSrc).not.toContain('text-[11px] font-medium uppercase tracking-wider')
  })
})
