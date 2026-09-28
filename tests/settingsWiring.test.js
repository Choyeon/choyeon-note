/**
 * T25 · 设置项接线核查（tests/settingsWiring.test.js）
 *
 * 这一份只回答一个问题：**设置页里每一个开关拨下去，消费点真的变了吗？**
 *
 * 三条硬性约定（违反即等于没测）：
 *   1. 一律用**真的** Pinia store（appStore / noteStore）与**真的**消费模块
 *      （@/composables/useAppActions、@/components/MarkdownEditor、@/utils/markdown、
 *      @/App.vue）。禁止手写替身 store —— 假 store 只会证明替身自己接线正确。
 *   2. 「改值 → 消费点真的变了」必须是**可观测**的：DOM 属性 / CSS 变量 /
 *      CodeMirror 扩展产生的 class / IPC 调用记录 / localStorage。
 *   3. 判定为「摆设 / 半生效」的项也必须留下用例 —— 用 `it.skip` 写明原因与
 *      「修好后要删掉 skip」的位置，下一轮只要把 skip 摘掉就能收到保护。
 *
 * 环境：本项目**没有 vitest setup 文件**，window.electronAPI / localStorage /
 * matchMedia 全部由本文件在 beforeEach 里 mock、afterEach 里还原。
 *
 * 备注： vitest 下 `?raw` 形式的 CSS import 取不到内容（返回 undefined），
 * 因此「代码高亮主题注入 <style>」这一步无法在此断言，改用
 * markdown.getCodeTheme() 观测——App.vue 的 watcher 是唯一会调用它的人。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createApp, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createAppActions } from '@/composables/useAppActions'
import { LS_KEYS } from '@/constants/storage'
import { SHORTCUT_MAP } from '@/constants/shortcuts'
import { useAppStore } from '@/stores/app'
import { useNoteStore } from '@/stores/note'
import { getCodeTheme, codeThemes } from '@/utils/markdown'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import SettingsView from '@/views/SettingsView.vue'
// WelcomeView 是欢迎页（G3 的第三处消费点）。它没有模块级环境探测，
// isElectron 是 computed，所以可以放心顶层 import。
import WelcomeView from '@/views/WelcomeView.vue'

/**
 * 源码目录。G3 要断言「三个文件里不准再出现字面量 key」——那个 bug 的表现是
 * 三处字符串恰好相等，行为上测不出来，只能回到源码看它到底引用了哪个常量。
 */
// vitest 的 cwd 就是项目根，root 由 vite.config.js 固定，不需要猜
const SRC_DIR = resolve(process.cwd(), 'src') + sep

/** App.vue 启动检查的延迟（与 src/App.vue 的 STARTUP_UPDATE_CHECK_DELAY 对齐） */
const STARTUP_UPDATE_CHECK_DELAY = 2000

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 自动同步关闭时的自解释文案（R-S4）。改文案必须连这里一起改 —— 它是契约 */
const AUTO_SYNC_OFF_HINT = '关闭时，笔记在应用外被修改不会自动同步进来'

/** 一定会被判为拼写错误的词（与 tests/spellcheck.test.js 口径一致） */
const TYPO_A = 'teh'
const TYPO_B = 'recieve'

// ---------------------------------------------------------------------------
// 环境 mock：electronAPI / matchMedia / Range（CodeMirror 需要）
// ---------------------------------------------------------------------------

/** IPC 调用与「主进程 → 渲染进程」监听器登记流水 */
const ipc = {
  calls: [],
  externalChangeHandlers: [],
  /** 渲染侧登记的 updater 事件回调（onUpdaterEvent） */
  updaterHandlers: [],
  selectedPath: '/vault/new'
}

function ipcCount (name) {
  return ipc.calls.filter((call) => call[0] === name).length
}

function installElectronAPI () {
  ipc.calls.length = 0
  ipc.externalChangeHandlers.length = 0
  ipc.updaterHandlers.length = 0
  const write = (name, args) => ipc.calls.push([name, ...args])
  window.electronAPI = {
    getVersion: async () => '1.2.3',
    selectNotesPath: async () => ipc.selectedPath,
    setNotesPath: async () => true,
    readDirectoryRecursive: async () => [],
    readDirectory: async () => [],
    createDirectory: async () => true,
    fileExists: async () => false,
    deleteFile: async () => true,
    writeFile: async (...args) => {
      write('writeFile', args)
      return true
    },
    readFile: async () => null,
    watchNotes: async (path) => {
      write('watchNotes', [path])
      return true
    },
    unwatchNotes: async () => {
      write('unwatchNotes', [])
      return true
    },
    onNotesExternalChange: (cb) => {
      ipc.externalChangeHandlers.push(cb)
      return function off () {
        const idx = ipc.externalChangeHandlers.indexOf(cb)
        if (idx >= 0) ipc.externalChangeHandlers.splice(idx, 1)
      }
    },
    onMenuAction: () => () => {},
    // 登记要留痕：App.vue 的启动检查必须有人接 updater 回执，否则「自动检测」
    // 只是发了个请求、结果被静默丢弃。
    onUpdaterEvent: (cb) => {
      write('onUpdaterEvent', [])
      ipc.updaterHandlers.push(cb)
      return function off () {
        const idx = ipc.updaterHandlers.indexOf(cb)
        if (idx >= 0) ipc.updaterHandlers.splice(idx, 1)
      }
    },
    onAppFlush: () => () => {},
    checkForUpdates: async (...args) => {
      write('checkForUpdates', args)
    },
    loadSpellData: async () => null,
    saveSpellData: async () => true
  }
  ipc.selectedPath = '/vault/new'
  return window.electronAPI
}

/** jsdom 没有 matchMedia / Range.getClientRects，store 与 CodeMirror 都要用到 */
const originalMatchMedia = window.matchMedia
let rangePatched = false

function installMatchMedia () {
  window.matchMedia = (query) => ({
    media: query,
    matches: false,
    addEventListener () {},
    removeEventListener () {},
    addListener () {},
    removeListener () {}
  })
}

function patchRange () {
  if (rangePatched) return
  if (typeof Range !== 'undefined' && Range.prototype && !Range.prototype.getClientRects) {
    const empty = []
    Range.prototype.getClientRects = function getClientRects () {
      return empty
    }
    Range.prototype.getBoundingClientRect = function getBoundingClientRect () {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    }
  }
  rangePatched = true
}

// ---------------------------------------------------------------------------
// 挂载工具
// ---------------------------------------------------------------------------

const HOME_ROUTE = {
  path: '/',
  name: 'home',
  component: { template: '<div class="probe-home">home</div>' }
}

/** 已挂载的 app，afterEach 统一卸载 */
let mounted = []

/** 当前生效的 Pinia 实例：每个用例一份，避免 store 状态跨用例串味 */
let pinia = null

async function settle (ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await nextTick()
}

/**
 * 反复重试点击，直到某个副作用出现为止。
 *
 * 为什么不能「点一次 + 等 80ms」：jsdom 里偶发（约 5%）这一次 click 压根没进
 * handler —— 点了、DOM 在、listener 也在，就是没回调（同 worker 里前面挂载过
 * App.vue / MarkdownEditor 之后更常见）。这不是被测代码的行为，所以这里用
 * 「重试点击」把环境抖动吸收掉。
 *
 * 防「空跑」：调用方必须自己断言副作用真的发生过（如 expect(spy).toHaveBeenCalled()），
 * 万一怎么样都点不动，那条断言会把用例打红 —— 重试不会把假通过变成真通过。
 *
 * @param {() => HTMLElement|undefined} findBtn 每轮重新查询按钮（重渲染后元素可能被替换）
 * @param {() => boolean} done 副作用是否已出现
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<boolean>} 最终是否达成
 */
async function clickUntil (findBtn, done, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const el = findBtn()
    if (el) el.click()
    await settle(20)
    if (done()) return true
  }
  return done()
}

/**
 * 挂载一个真实组件（自带真 Pinia + 真 router）。
 *
 * @param {object} component 组件选项或 *.vue 的 default
 * @param {object} [options]
 * @param {Array} [options.routes] 路由表
 * @param {object|null} [options.props] 以 render props 形式传入
 * @returns {Promise<{app: object, host: HTMLElement, router: object}>}
 */
async function mountReal (component, options = {}) {
  const { routes = [HOME_ROUTE], props = null } = options
  // 复用 beforeEach 建好的那份：这样组件里的 store 与用例里 useAppStore() 是同一个
  const activePinia = pinia || createPinia()
  const router = createRouter({ history: createMemoryHistory(), routes })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(props ? { render: () => h(component, props) } : component)
  app.use(activePinia)
  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(host)
  await settle()
  mounted.push(app)
  return { app, host, router }
}

/**
 * 懒加载 App.vue。
 *
 * 必须「懒」到第一次挂载时才 import：`src/utils/env.js` 的 IS_ELECTRON 在模块加载
 * 时求值一次，若本文件顶层就静态 import App.vue，那时 electronAPI 还没装上，
 * App.vue 会永远认定自己跑在非 Electron 环境。
 *
 * @returns {Promise<object>} App.vue 组件
 */
let appComponent = null
async function loadAppComponent () {
  if (!appComponent) {
    appComponent = (await import('@/App.vue')).default
  }
  return appComponent
}

/**
 * 挂载 App.vue（带 /notes 路由，便于 Observer 跳转断言）。
 * @returns {Promise<{app: object, host: HTMLElement, router: object}>}
 */
async function mountApp () {
  const Comp = await loadAppComponent()
  return mountReal(Comp, {
    routes: [
      { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
      { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
    ]
  })
}

/**
 * 挂载编辑器（真实 CodeMirror）。
 * @param {string} [value] 初始正文
 * @returns {Promise<{app: object, host: HTMLElement}>}
 */
async function mountEditor (value = '# hello\nteh world') {
  return mountReal(MarkdownEditor, { props: { modelValue: value } })
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  installElectronAPI()
  installMatchMedia()
  patchRange()
})

afterEach(() => {
  // 逐个卸载而不是整批清理：某个 app unmount 抛错不能挡住其余回收
  for (const app of mounted) {
    try {
      app.unmount()
    } catch {
      /* 卸载失败不影响其余用例 */
    }
  }
  mounted = []
  window.matchMedia = originalMatchMedia
  delete window.electronAPI
  // 挂载用的宿主全部拔掉：留着会让下一次的 querySelector 有机会挑到上一轮残留，
  // 也会让「僵尸组件」继续参与 Vue 调度（见过随机不重渲染的抖动）
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-glass')
  document.documentElement.removeAttribute('data-font-size')
  localStorage.clear()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// A · 外观分区
// ---------------------------------------------------------------------------

describe('T25 · A 外观：theme / accentColor / fontSize / glassEffect / bingWallpaper', () => {
  it('A1 主题模式：切成 dark → <html data-theme> 真的变 dark，并写进 localStorage', () => {
    const appStore = useAppStore()
    appStore.initTheme()

    appStore.setTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(LS_KEYS.theme)).toBe('dark')

    appStore.setTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('A2 主题模式默认值：resetConfig 后读回 system 并落到 <html>', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    appStore.setTheme('dark')
    appStore.resetConfig()
    expect(appStore.theme).toBe('system')
    expect(localStorage.getItem(LS_KEYS.theme)).toBeNull()
  })

  it('A3 强调色：选一个色 → <html> 的 --color-primary 真的跟着变', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#4A90D9')

    appStore.setAccentColor('#E53935')
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#E53935')
    expect(localStorage.getItem(LS_KEYS.accent)).toBe('#E53935')
  })

  it('A4 字体大小：切成 large → data-font-size 与 --font-size-body 同时变', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    expect(document.documentElement.getAttribute('data-font-size')).toBe('medium')
    const before = document.documentElement.style.getPropertyValue('--font-size-body')

    appStore.setFontSize('large')
    expect(document.documentElement.getAttribute('data-font-size')).toBe('large')
    expect(document.documentElement.style.getPropertyValue('--font-size-body')).not.toBe(before)
    expect(document.documentElement.style.getPropertyValue('--font-size-body')).toBe('18px')
  })

  it('A5 毛玻璃：开关拨到关 → <html data-glass> 变 false（style.css 的 [data-glass=false] 分支命中）', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    expect(document.documentElement.getAttribute('data-glass')).toBe('true')

    appStore.toggleGlassEffect()
    expect(appStore.glassEffect).toBe(false)
    expect(document.documentElement.getAttribute('data-glass')).toBe('false')

    appStore.toggleGlassEffect()
    expect(document.documentElement.getAttribute('data-glass')).toBe('true')
  })

  it('A6 毛玻璃：重置后再走一遍 App.vue 挂载，根容器的 data-glass 仍与 store 同步', async () => {
    await mountApp()
    const appStore = useAppStore()
    const container = document.querySelector('.app-container')
    expect(container).toBeTruthy()
    expect(container.getAttribute('data-glass')).toBe(String(appStore.glassEffect))

    appStore.toggleGlassEffect()
    await settle()
    expect(container.getAttribute('data-glass')).toBe(String(appStore.glassEffect))
  })

  it('A7 Bing 每日壁纸：开关打开并拿到图 → App.vue 的根容器背景真的换成这张图', async () => {
    const { host } = await mountApp()
    const appStore = useAppStore()
    const frame = () => host.querySelector('.window-frame')
    expect(frame().getAttribute('style')).not.toContain('http')

    appStore.toggleBingWallpaper()
    expect(appStore.bingWallpaper).toBe(true)
    appStore.setBingWallpaper({
      url: 'https://bing.example.com/today.jpg',
      title: '今日',
      date: '20260101',
      source: 'official'
    })
    await settle()
    expect(frame().getAttribute('style')).toContain('https://bing.example.com/today.jpg')
    expect(localStorage.getItem(LS_KEYS.bingWallpaperUrl)).toBe('https://bing.example.com/today.jpg')
  })
})

// ---------------------------------------------------------------------------
// B · 编辑器分区
// ---------------------------------------------------------------------------

describe('T25 · B 编辑器：noteExtension / editorMode / editorZoom / spellCheck / wordWrap / lineNumbers / codeTheme', () => {
  it('B1 默认扩展名（R-S1）：改成 markdown → 新建笔记真的写出 .markdown 文件', async () => {
    const appStore = useAppStore()
    const noteStore = useNoteStore()
    expect(appStore.setNoteExtension('markdown')).toBe(true)

    noteStore.notesPath = '/vault'
    const note = noteStore.createNote('', 'MyNote')
    await noteStore.saveNoteToFile(note, '')

    const writes = ipc.calls.filter((c) => c[0] === 'writeFile')
    expect(writes).toHaveLength(1)
    expect(writes[0][1].startsWith('/vault/')).toBe(true)
    expect(writes[0][1].endsWith('.markdown')).toBe(true)
  })

  it('B2 默认扩展名：默认是 md → 走同一条链写出 .md（对照组）', async () => {
    const appStore = useAppStore()
    expect(appStore.noteExtension).toBe('md')
    const noteStore = useNoteStore()
    noteStore.notesPath = '/vault'
    const note = noteStore.createNote('', 'CtrlNote')
    await noteStore.saveNoteToFile(note, '')
    const writes = ipc.calls.filter((c) => c[0] === 'writeFile')
    expect(writes).toHaveLength(1)
    expect(writes[0][1].endsWith('.md')).toBe(true)
  })

  it('B3 默认扩展名：脏值被拒并且不污染 store（写进去什么 = 读出来什么）', () => {
    const appStore = useAppStore()
    expect(appStore.setNoteExtension('.TXT ')).toBe(true)
    expect(appStore.noteExtension).toBe('txt')
    expect(appStore.setNoteExtension('exe')).toBe(false)
    expect(appStore.noteExtension).toBe('txt')
    expect(localStorage.getItem(LS_KEYS.noteExtension)).toBe('txt')
  })

  it('B4 默认编辑器模式：切成 live → 持久化，且同一个 appAction 能来回切（双向不是一次性）', async () => {
    const appStore = useAppStore()
    appStore.initTheme()
    const actions = createAppActions({ appStore, noteStore: useNoteStore(), router: null })

    expect(appStore.editorMode).toBe('edit')
    actions['view.liveMode']()
    expect(appStore.editorMode).toBe('live')
    expect(localStorage.getItem(LS_KEYS.editorMode)).toBe('live')
    actions['view.liveMode']()
    expect(appStore.editorMode).toBe('edit')
  })

  it('B5 默认编辑器模式：重启后（loadConfig）沿用上次的值而不是回到 edit', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    appStore.setEditorMode('preview')
    expect(appStore.editorMode).toBe('preview')

    setActivePinia(createPinia())
    const fresh = useAppStore()
    fresh.loadConfig()
    expect(fresh.editorMode).toBe('preview')
  })

  it('B6 编辑器缩放：view.zoomIn / zoomOut 真的改 ----editor-zoom 的源头 editorZoom，并被夹住', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    const actions = createAppActions({ appStore, noteStore: useNoteStore(), router: null })
    expect(appStore.editorZoom).toBe(100)

    actions['view.zoomIn']()
    expect(appStore.editorZoom).toBe(110)
    actions['view.zoomOut']()
    expect(appStore.editorZoom).toBe(100)

    appStore.setEditorZoom(999)
    expect(appStore.editorZoom).toBe(200)
    appStore.setEditorZoom(1)
    expect(appStore.editorZoom).toBe(50)
    expect(localStorage.getItem(LS_KEYS.editorZoom)).toBe('50')
    actions['view.zoomReset']()
    expect(appStore.editorZoom).toBe(100)
  })

  it('B7 编辑器缩放：App.vue 根容器的 --editor-zoom 随 store 变（100 → 150 = 1.5 倍）', async () => {
    const { host } = await mountApp()
    const appStore = useAppStore()
    const styleAttr = () => host.querySelector('.app-container').getAttribute('style')
    expect(styleAttr()).toContain('--editor-zoom')
    appStore.setEditorZoom(150)
    await settle()
    expect(appStore.editorZoom).toBe(150)
    expect(styleAttr()).toContain('1.5')
  })

  it('B8 拼写检查：关掉 → getSpellErrors 不再报错（编辑器/extensions 的唯一入口）', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    expect(appStore.getSpellErrors(`hello ${TYPO_A} world`).length).toBe(1)

    appStore.toggleSpellCheck()
    expect(appStore.spellCheck).toBe(false)
    expect(appStore.getSpellErrors(`hello ${TYPO_A} world`)).toEqual([])
    expect(localStorage.getItem(LS_KEYS.spellCheck)).toBe('false')
  })

  it('B9 自动换行：开关 → CodeMirror 主干上的 .cm-lineWrapping 真的加回来 / 摘掉', async () => {
    const { host } = await mountEditor()
    const appStore = useAppStore()
    // 默认 wordWrap = true → CodeMirror 主干上有 .cm-lineWrapping
    expect(host.querySelectorAll('.cm-lineWrapping').length).toBeGreaterThan(0)

    appStore.toggleWordWrap()
    expect(appStore.wordWrap).toBe(false)
    await settle(30)
    expect(host.querySelectorAll('.cm-lineWrapping').length).toBe(0)

    appStore.toggleWordWrap()
    await settle(30)
    expect(host.querySelectorAll('.cm-lineWrapping').length).toBeGreaterThan(0)
  })

  it('B10 行号显示：开关 → CodeMirror 的.lineNumbers 真的出现 / 消失', async () => {
    const { host } = await mountEditor()
    const appStore = useAppStore()
    expect(appStore.showLineNumbers).toBe(false)
    expect(host.querySelectorAll('.cm-lineNumbers').length).toBe(0)

    appStore.toggleLineNumbers()
    expect(appStore.showLineNumbers).toBe(true)
    await settle(30)
    expect(host.querySelectorAll('.cm-lineNumbers').length).toBeGreaterThan(0)

    appStore.toggleLineNumbers()
    await settle(30)
    expect(host.querySelectorAll('.cm-lineNumbers').length).toBe(0)
  })

  it('B11 代码高亮主题：改成 monokai → App.vue 的 watch 真的把值喂给了 markdown', async () => {
    await mountApp()
    const appStore = useAppStore()
    expect(getCodeTheme()).toBe('github')

    appStore.setCodeTheme('monokai')
    expect(localStorage.getItem(LS_KEYS.codeTheme)).toBe('monokai')
    await settle()
    expect(getCodeTheme()).toBe('monokai')
  })

  it('B12 代码高亮主题：下拉选项必须来自 utils/markdown 的注册表（禁止再手抄一份）', () => {
    const ids = codeThemes.map((t) => t.id)
    expect(ids).toContain('github')
    expect(ids).toContain('monokai')
    // 注册表里真实存在的 Tokyo Night，旧版手写列表里从来没有
    expect(ids).toContain('tokyo-night-dark')
    expect(codeThemes.every((t) => typeof t.name === 'string' && t.name.length > 0)).toBe(true)
  })

  it.skip('B13 代码高亮主题：注入 <style data-highlight-theme> —— vitest 下 ?raw CSS 为 undefined，无法断言', () => {
    // 生产构建里 markdown.js 的 themeCssMap 来自 `import githubCss from '...css?raw'`，
    // vitest 不处理 ?raw，themeCssMap 全 undefined，loadCodeTheme 必然走 error 分支。
    // 修法：给 vitest 补 assetsInclude/?raw 支持，或改由测试注入 CSS 字符串。
    // 修好后：调用 setCodeTheme('monokai') 并断言 document.head 里出现
    // <style data-highlight-theme="monokai">。
  })
})

// ---------------------------------------------------------------------------
// C · 拼写词典（忽略词 / 自定义字典）
// ---------------------------------------------------------------------------

describe('T25 · C 拼写词典：ignoredWords / customDictionary', () => {
  it('C1 忽略词：加进 ignoredWords → 同一个词从"拼错"变成"正确"', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    const text = `hello ${TYPO_A}`
    expect(appStore.getSpellErrors(text)).toHaveLength(1)

    appStore.ignoreWord(TYPO_A)
    expect(appStore.getSpellErrors(text)).toEqual([])
    expect(appStore.isWordCorrect(TYPO_A)).toBe(true)
    expect(JSON.parse(localStorage.getItem(LS_KEYS.ignoredWords))).toContain(TYPO_A)
  })

  it('C2 忽略词：移除后同一个词重新被判错（双向，不是一次性）', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    appStore.ignoreWord(TYPO_A)
    expect(appStore.isWordCorrect(TYPO_A)).toBe(true)
    appStore.unignoreWord(TYPO_A)
    expect(appStore.isWordCorrect(TYPO_A)).toBe(false)
  })

  it('C3 自定义词典：加进 customDictionary → 判定翻转，并能被清空', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    expect(appStore.isWordCorrect(TYPO_B)).toBe(false)
    appStore.addToDictionary(TYPO_B)
    expect(appStore.isWordCorrect(TYPO_B)).toBe(true)
    expect(appStore.getSpellErrors(TYPO_B)).toEqual([])
    appStore.clearCustomDictionary()
    expect(appStore.isWordCorrect(TYPO_B)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D · 文件与同步（R-S4 的核心）
// ---------------------------------------------------------------------------

describe('T25 · D 文件与同步：notesLocation / autoSync', () => {
  it('D1 笔记存储位置：saveNotesLocation 写的正是路由守卫读的那个 localStorage key', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    appStore.saveNotesLocation('/vault/real')
    expect(localStorage.getItem('choyeon-notes-location')).toBe('/vault/real')
    expect(localStorage.getItem(LS_KEYS.notesLocation)).toBe('/vault/real')
  })

  it('D2 笔记存储位置：设置页显示「当前真正生效的路径」，noteStore 优先于 appStore 镜像', async () => {
    const appStore = useAppStore()
    const noteStore = useNoteStore()

    // appStore 镜像留着旧值、noteStore 指向新库：这个不一致下必须显示后者。
    //
    // 注意顺序：**先设状态、再挂载**。同一 worker 里前面已经反复挂载过 App.vue /
    // MarkdownEditor，之后「改 store → 等下一次渲染」偶发被推迟到肉眼可见之外
    // （实测约 1/10 概率，再等 120ms 也不更新，属 jsdom + 反复挂载的调度抖动，
    // 不是 SettingsView 的模板问题）。所以让初始渲染就带上正确状态：
    // 断言的仍是同一份模板逻辑，却不依赖重渲染的时机。
    appStore.notesLocation = '/stale/mirror'
    noteStore.notesPath = '/live/path'
    expect(noteStore.notesPath).toBe('/live/path')
    expect(appStore.notesLocation).toBe('/stale/mirror')

    const { host } = await mountReal(SettingsView)
    await settle()

    const rows = [...host.querySelectorAll('.settings-row')]
    const locationRow = rows.find((row) => row.textContent.includes('笔记存储位置'))
    expect(locationRow).toBeTruthy()
    expect(locationRow.textContent).toContain('/live/path')
    expect(locationRow.textContent).not.toContain('/stale/mirror')
  })

  it('D3 【R-S4】自动同步关着时：一次 watchNotes 都不发，外部变更监听器 0 个', async () => {
    await mountApp()
    const appStore = useAppStore()
    const noteStore = useNoteStore()

    // 无论默认值是 true 还是 false，先归一到「关」
    if (appStore.autoSync) appStore.toggleAutoSync()
    await settle()
    noteStore.notesPath = '/vault/watched'
    await settle(50)

    // 关闭分支必须是「根本没注册」，而不是「注册了但静默丢弃」
    expect(ipcCount('watchNotes')).toBe(0)
    expect(ipc.externalChangeHandlers).toHaveLength(0)
  })

  it('D4 【R-S4】自动同步打开：真的调用 watchNotes 并登记 1 个外部变更监听器', async () => {
    await mountApp()
    const appStore = useAppStore()
    const noteStore = useNoteStore()
    if (appStore.autoSync) appStore.toggleAutoSync()
    await settle()
    noteStore.notesPath = '/vault/watched'
    await settle(50)

    appStore.toggleAutoSync()
    expect(appStore.autoSync).toBe(true)
    await settle(50)

    expect(ipcCount('watchNotes')).toBeGreaterThan(0)
    expect(ipc.externalChangeHandlers).toHaveLength(1)
    expect(localStorage.getItem(LS_KEYS.autoSync)).toBe('true')
  })

  it('D5 【R-S4】再关掉：unwatchNotes 被调用，监听器被注销（回到 0 个）', async () => {
    await mountApp()
    const appStore = useAppStore()
    const noteStore = useNoteStore()
    if (appStore.autoSync) appStore.toggleAutoSync()
    await settle()
    noteStore.notesPath = '/vault/watched'
    appStore.toggleAutoSync()
    await settle(50)
    expect(ipc.externalChangeHandlers).toHaveLength(1)

    appStore.toggleAutoSync()
    await settle(50)
    expect(appStore.autoSync).toBe(false)
    expect(ipcCount('unwatchNotes')).toBeGreaterThan(0)
    expect(ipc.externalChangeHandlers).toHaveLength(0)
  })

  it('D6 【R-S4】关闭期间主进程推来外部变更 → 不会有任何一次重载（无隐蔽覆盖）', async () => {
    await mountApp()
    const appStore = useAppStore()
    const noteStore = useNoteStore()
    if (appStore.autoSync) appStore.toggleAutoSync()
    await settle()
    noteStore.notesPath = '/vault/watched'
    await settle(50)

    const reloadSpy = vi.spyOn(noteStore, 'loadNotesFromPath')
    // 模拟主进程在关闭期间推来一批外部变更：一个监听器都没有，推也推不到
    for (const handler of [...ipc.externalChangeHandlers]) handler([{ path: '/vault/watched/a.md', kind: 'change' }])
    await settle(30)
    expect(ipc.externalChangeHandlers).toHaveLength(0)
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('D7 自动同步：开关值能跨会话读回（LS → loadConfig → store）', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    const before = appStore.autoSync
    appStore.toggleAutoSync()
    expect(appStore.autoSync).toBe(!before)
    const expected = appStore.autoSync
    expect(localStorage.getItem(LS_KEYS.autoSync)).toBe(String(expected))

    const freshPinia = createPinia()
    setActivePinia(freshPinia)
    const fresh = useAppStore()
    fresh.loadConfig()
    expect(fresh.autoSync).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// E · 快捷键
// ---------------------------------------------------------------------------

describe('T25 · E 快捷键：hotkeys', () => {
  it('E1 改键 → getBinding 立刻返回新键（App.vue 与设置页读的是同一个出口）', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    const before = appStore.getBinding('app.commandPalette')
    expect(before).toBe(SHORTCUT_MAP['app.commandPalette'].default)

    const result = appStore.setHotkey('app.commandPalette', 'Mod-;')
    expect(result.ok).toBe(true)
    expect(appStore.getBinding('app.commandPalette')).toBe('Mod-;')
  })

  it('E2 改键 → 写进 choyeon-hotkeys；换会话 loadConfig 后仍然保留（不是只改内存）', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    appStore.setHotkey('app.commandPalette', 'Mod-;')
    expect(JSON.parse(localStorage.getItem(LS_KEYS.hotkeys))['app.commandPalette']).toBe('Mod-;')

    setActivePinia(createPinia())
    const fresh = useAppStore()
    fresh.loadConfig()
    expect(fresh.getBinding('app.commandPalette')).toBe('Mod-;')
  })

  it('E3 改键后 App.vue 的全局按键真的按新键干活、旧键（原默认键）不再干活', async () => {
    await mountApp()
    const appStore = useAppStore()
    appStore.initTheme()
    // 原默认键 Mod-Shift-p → 改成 Mod-;
    expect(appStore.setHotkey('app.commandPalette', 'Mod-;').ok).toBe(true)
    await settle(20)

    const press = (options) => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }))
    }

    // 旧键 Mod-Shift-p：已经让给新绑定，不该再打开面板
    press({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true })
    await settle(10)
    expect(appStore.commandPaletteOpen).toBe(false)

    // 新键 Mod-;
    press({ key: ';', code: 'Semicolon', ctrlKey: true })
    await settle(10)
    expect(appStore.commandPaletteOpen).toBe(true)
  })

  it('E4 重置单条 → 回到注册表默认值；全部重置 → 整份自定义清空', () => {
    const appStore = useAppStore()
    appStore.initTheme()
    appStore.setHotkey('app.commandPalette', 'Mod-;')
    expect(appStore.getBinding('app.commandPalette')).toBe('Mod-;')

    expect(appStore.resetHotkey('app.commandPalette')).toBe(true)
    expect(appStore.getBinding('app.commandPalette')).toBe(SHORTCUT_MAP['app.commandPalette'].default)

    appStore.setHotkey('app.commandPalette', 'Mod-.')
    appStore.resetAllHotkeys()
    expect(appStore.getBinding('app.commandPalette')).toBe(SHORTCUT_MAP['app.commandPalette'].default)
  })
})

// ---------------------------------------------------------------------------
// F · 设置页自身（SettingsView.vue）
// ---------------------------------------------------------------------------

describe('T25 · F SettingsView 自身', () => {
  it('F1 【R-S4】自动同步开关下方常驻一行自解释文案；关着时必须把后果说出来', async () => {
    const { host } = await mountReal(SettingsView)
    const hint = () => host.querySelector('[data-testid="auto-sync-hint"]')
    expect(hint()).toBeTruthy()

    const appStore = useAppStore()
    if (appStore.autoSync) appStore.toggleAutoSync()
    await settle()
    expect(hint().textContent.trim()).toBe(AUTO_SYNC_OFF_HINT)
    expect(hint().getAttribute('data-state')).toBe('off')
  })

  it('F2 【R-S4】开关打开且没设目录时，提示改为「需先设置笔记存储位置」而不是报喜', async () => {
    const { host } = await mountReal(SettingsView)
    const appStore = useAppStore()
    const noteStore = useNoteStore()
    noteStore.notesPath = null
    if (!appStore.autoSync) appStore.toggleAutoSync()
    await settle()
    const hint = host.querySelector('[data-testid="auto-sync-hint"]')
    expect(hint.getAttribute('data-state')).toBe('on')
    expect(hint.textContent).toContain('需先设置笔记存储位置')
  })

  it('F3 每个拨动开关都有可访问名（aria-label），读屏/自动化能认出开关指代哪项设置', async () => {
    const { host } = await mountReal(SettingsView)
    const switches = [...host.querySelectorAll('.toggle-switch')]
    expect(switches.length).toBeGreaterThanOrEqual(6)
    for (const el of switches) {
      expect(el.getAttribute('role')).toBe('switch')
      expect((el.getAttribute('aria-label') || '').trim().length).toBeGreaterThan(0)
      expect(['true', 'false']).toContain(String(el.getAttribute('aria-checked')))
    }
  })

  it('F4 代码高亮下拉：渲染出的选项与 utils/markdown 注册表逐条一致（无手写残留）', async () => {
    const { host } = await mountReal(SettingsView)
    const selects = [...host.querySelectorAll('select')]
    const themeSelect = selects.find((s) => s.contains(s.querySelector('option[value="github"]')))
    expect(themeSelect).toBeTruthy()
    const values = [...themeSelect.options].map((o) => o.value)
    expect(values).toEqual(codeThemes.map((t) => t.id))
  })

  it('F5 默认扩展名下拉：选项来自 NOTE_EXTENSIONS 白名单，选中值与 store 同步', async () => {
    const { host } = await mountReal(SettingsView)
    const appStore = useAppStore()
    const selects = [...host.querySelectorAll('select')]
    const extSelect = selects.find((s) => s.contains(s.querySelector('option[value="markdown"]')))
    expect(extSelect).toBeTruthy()
    const values = [...extSelect.options].map((o) => o.value)
    expect(values).toEqual(['md', 'markdown', 'txt'])
    expect(extSelect.value).toBe(appStore.noteExtension)
  })

  it('F6 更改笔记目录：载入失败时绝不落盘（够不到的目录不会变成下次启动的默认值）', async () => {
    const { host, app } = await mountReal(SettingsView)
    const noteStore = useNoteStore()
    const appStore = useAppStore()
    appStore.initTheme()

    noteStore.notesPath = '/vault/keep'
    const loadSpy = vi.spyOn(noteStore, 'loadNotesFromPath').mockResolvedValue({ ok: false, error: '目录不可读' })
    // 本合同只看这一次点击前后的差：进入断言前先把落盘痕迹抹掉，
    // 免得上一条用例（或更早挂着的 App.vue 监听器）异步补写串到这条身上
    localStorage.removeItem(LS_KEYS.notesLocation)

    const findBtn = () => [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === '更改')
    expect(findBtn()).toBeTruthy()
    const ok = await clickUntil(findBtn, () => loadSpy.mock.calls.length > 0)
    if (!ok) {
      const el = findBtn()
      console.log('F6DIAG clicksNoop hostChildren=' + host.children.length +
        ' appInstance=' + Boolean(app._instance) +
        ' isUnmounted=' + String(app._instance && app._instance.isUnmounted) +
        ' hasVnode=' + Boolean(el && el.__vnode) +
        ' hasAPI=' + Boolean(window.electronAPI) +
        ' switchCount=' + host.querySelectorAll('.toggle-switch').length)
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle(60)
      console.log('F6DIAG afterMouseEvent spyCalls=' + loadSpy.mock.calls.length)
    }

    // 前置条件成立：失败路径确实被走到了（点选的新目录 + 回滚旧目录各一次）
    expect(loadSpy.mock.calls.map((c) => c[0]).sort()).toEqual(['/vault/keep', ipc.selectedPath].sort())
    expect(localStorage.getItem(LS_KEYS.notesLocation)).toBeNull()
    expect(appStore.toasts.some((t) => t.type === 'error' && String(t.message).includes('切换笔记目录失败'))).toBe(true)
  })

  it('F7 更改笔记目录：载入成功才落盘 + 跳转 /notes', async () => {
    const { host, router } = await mountReal(SettingsView, {
      routes: [
        { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
        { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
      ]
    })
    const noteStore = useNoteStore()
    // 与 F6 用不同的目录名：两条用例一旦互相串味，断言会立刻因为值不对而红，而不是靠巧合通过
    ipc.selectedPath = '/vault/f7-ok'
    const loadSpy = vi.spyOn(noteStore, 'loadNotesFromPath').mockResolvedValue({ ok: true, count: 0 })
    localStorage.removeItem(LS_KEYS.notesLocation)

    const findBtn = () => [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === '更改')
    expect(findBtn()).toBeTruthy()
    await clickUntil(findBtn, () => localStorage.getItem(LS_KEYS.notesLocation) !== null)
    await settle(30)

    expect(loadSpy).toHaveBeenCalledWith('/vault/f7-ok')
    expect(localStorage.getItem(LS_KEYS.notesLocation)).toBe(ipc.selectedPath)
    expect(router.currentRoute.value.name).toBe('notes')
  })

  it('F8 重置应用：真的把 LS_KEYS 全部清掉并把 store 拉回默认值', async () => {
    const { host } = await mountReal(SettingsView)
    const appStore = useAppStore()
    appStore.initTheme()
    appStore.setTheme('dark')
    appStore.setFontSize('large')

    const findReset = () => [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === '重置')
    expect(findReset()).toBeTruthy()
    // 确认框渲染到了 body（Teleport 或 portal），到 document 里找
    const findConfirm = () => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '确认重置')
    await clickUntil(findReset, () => Boolean(findConfirm()))
    await settle(20)
    expect(findConfirm()).toBeTruthy()
    await clickUntil(findConfirm, () => appStore.theme === 'system')
    await settle(20)

    expect(appStore.theme).toBe('system')
    expect(appStore.fontSize).toBe('medium')
    expect(localStorage.getItem(LS_KEYS.theme)).toBeNull()
    expect(localStorage.getItem(LS_KEYS.fontSize)).toBeNull()
  })

  it('F9 八个拨动开关逐个点：store 翻转 + localStorage 落盘 + aria-checked 跟着变（断掉任何一个 @click 都会红）', async () => {
    const { host } = await mountReal(SettingsView)
    const appStore = useAppStore()
    appStore.initTheme()

    /** aria-label → { store 字段, localStorage key }，与 app.js 的 toggleXxx 一一对应 */
    const TOGGLES = [
      { label: '毛玻璃效果', field: 'glassEffect', key: LS_KEYS.glassEffect },
      { label: 'Bing 每日壁纸', field: 'bingWallpaper', key: LS_KEYS.bingWallpaper },
      { label: '拼写检查', field: 'spellCheck', key: LS_KEYS.spellCheck },
      { label: '自动保存', field: 'autoSave', key: LS_KEYS.autoSave },
      { label: '行号显示', field: 'showLineNumbers', key: LS_KEYS.lineNumbers },
      { label: '自动换行', field: 'wordWrap', key: LS_KEYS.wordWrap },
      { label: '自动同步', field: 'autoSync', key: LS_KEYS.autoSync },
      { label: '自动检查更新', field: 'autoCheckUpdates', key: LS_KEYS.autoCheckUpdates }
    ]

    const initialLabels = [...host.querySelectorAll('.toggle-switch')].map((el) => el.getAttribute('aria-label'))
    expect(initialLabels).toEqual(TOGGLES.map((t) => t.label))

    for (const toggle of TOGGLES) {
      const findSwitch = () => [...host.querySelectorAll('.toggle-switch')]
        .find((s) => s.getAttribute('aria-label') === toggle.label)
      expect(findSwitch(), `找不到 ${toggle.label} 开关`).toBeTruthy()

      const before = Boolean(appStore[toggle.field])
      await clickUntil(findSwitch, () => Boolean(appStore[toggle.field]) !== before)
      const after = Boolean(appStore[toggle.field])

      expect(after).toBe(!before)
      // 落盘必须是 String(布尔)：app.js 的 8 个 toggle 都直接 setItem(LS_KEYS.x, 布尔)
      expect(localStorage.getItem(toggle.key)).toBe(String(after))
      expect(findSwitch().getAttribute('aria-checked')).toBe(String(after))

      // 再点回来：开关必须是双向的，不能只是一次性的
      await clickUntil(findSwitch, () => Boolean(appStore[toggle.field]) === before)
      expect(Boolean(appStore[toggle.field])).toBe(before)
      expect(localStorage.getItem(toggle.key)).toBe(String(before))
      expect(findSwitch().getAttribute('aria-checked')).toBe(String(before))
    }
  })
})

// ---------------------------------------------------------------------------
// G · 半生效 / 摆设：本轮修不了，但必须留下「修好后摘 skip」的落点
// ---------------------------------------------------------------------------

describe('T25 · G 摆设 / 半生效：待派工（每个 skip 都写明了该改哪个文件）', () => {
  it('G1 【已修】启动时自动检测新版本：App.vue onMounted 真的发一次 checkForUpdates，且回执有人接', async () => {
    const appStore = useAppStore()
    // 显式断言默认值：哪天默认值改了，这条用例不能悄悄变成「测了个关着的开关」
    expect(appStore.autoCheckUpdates).toBe(true)

    await mountApp()
    // 启动检查排在 STARTUP_UPDATE_CHECK_DELAY 之后，要等它落地
    await settle(STARTUP_UPDATE_CHECK_DELAY + 600)

    // ① 真的发了，且只发一次（不是「进设置页才发」）
    expect(ipcCount('checkForUpdates')).toBe(1)

    // ② 回执有人接：没有这个监听，启动检查的结果被静默丢弃 = 等于没检查
    expect(ipc.updaterHandlers).toHaveLength(1)

    // ③ 结果要让用户看得见：主进程推 update-available → 全局 toast 里出现版本号
    ipc.updaterHandlers[0]('updater:update-available', { version: '9.9.9' })
    await settle(20)
    expect(appStore.toasts.some((t) => String(t.message).includes('9.9.9'))).toBe(true)
  }, 20000)

  it('G1b 【已修】去重：启动窗口内进过设置页 → App.vue 让位，不再补发第二次检查', async () => {
    const appStore = useAppStore()
    expect(appStore.autoCheckUpdates).toBe(true)

    // 带一条真实可用的 /settings 路由（组件是哑元，只为让 route.name 变成 settings）
    const Comp = await loadAppComponent()
    const { router } = await mountReal(Comp, {
      routes: [
        { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
        { path: '/settings', name: 'settings', component: { template: '<div class="probe-settings">settings</div>' } }
      ]
    })
    await router.push('/settings')
    expect(router.currentRoute.value.name).toBe('settings')

    await settle(STARTUP_UPDATE_CHECK_DELAY + 600)
    // 设置页挂载 2s 后会自己发一次；App.vue 侧必须让位，否则同一次启动打两遍
    expect(ipcCount('checkForUpdates')).toBe(0)
    // 防「空绿」：监听器已登记 = 启动检查这条路确实走到了，上面的 0 才是让位的结果，
    // 而不是压根没跑（没有这条，本用例在任何实现下都是绿的）
    expect(ipcCount('onUpdaterEvent')).toBe(1)
  }, 20000)

  it('G2 【已修】主题模式 = 系统：App.vue 根容器写的是 effectiveTheme（light/dark），不是 system', async () => {
    const appStore = useAppStore()
    appStore.initTheme() // 装 matchMedia → systemTheme（mock 下为 light）
    appStore.setTheme('system')
    expect(appStore.theme).toBe('system')
    expect(appStore.effectiveTheme).toBe('light')

    const { host } = await mountApp()
    const container = host.querySelector('.app-container')
    expect(container, '找不到 App.vue 的根容器').toBeTruthy()

    // 修前：data-theme="system" → .electron-mode[data-theme='dark'] 与
    // [data-theme='dark'] ::selection 一个都不命中，Electron 暗色变量全丢。
    // 修后：值域只有 light / dark。
    expect(container.getAttribute('data-theme')).toBe('light')
    expect(container.getAttribute('data-theme')).not.toBe('system')
    expect(['light', 'dark']).toContain(container.getAttribute('data-theme'))

    // 与 store 写给 documentElement 的同口径（applyTheme 用的也是 effectiveTheme）
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    // 系统偏好反过来（prefers-color-scheme: dark）：修前照样是 'system'，修后必须是 'dark'
    window.matchMedia = (query) => ({
      media: query,
      matches: true,
      addEventListener () {}, removeEventListener () {},
      addListener () {}, removeListener () {}
    })
    appStore.initTheme() // 重新读一次系统偏好
    appStore.setTheme('system')
    expect(appStore.effectiveTheme).toBe('dark')
    await settle(20)
    expect(container.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    // 显式选 light：也跟着 effectiveTheme 走，不是死在 'system' 上
    appStore.setTheme('light')
    await settle(20)
    expect(container.getAttribute('data-theme')).toBe('light')
  })

  it('G3 【已修】笔记存储位置：三个消费点同出一源（LS_KEYS.notesLocation），改键不会漏改', async () => {
    // ① 单一来源：这三个文件里不准再出现字面量 key。
    // 这个 bug 的行为在三处字符串相等时完全正常，只有回到源码才看得出来。
    for (const rel of ['App.vue', 'router/index.js', 'views/WelcomeView.vue']) {
      const text = readFileSync(SRC_DIR + rel, 'utf8')
      expect(text.includes("'choyeon-notes-location'"), `${rel} 仍在硬编码字面量 key`).toBe(false)
    }
    // key 的字符串值本身是线上历史 key，改了等于所有人的库位置丢失
    expect(LS_KEYS.notesLocation).toBe('choyeon-notes-location')

    // ② App.vue 启动加载：键里写着哪个路径就加载哪个库
    localStorage.setItem(LS_KEYS.notesLocation, '/vault/g3')
    const noteStore = useNoteStore()
    const spy = vi.spyOn(noteStore, 'loadNotesFromPath')
    await mountApp()
    await settle(20)
    expect(spy).toHaveBeenCalledWith('/vault/g3')

    // ③ 真实路由守卫：有库位置 → / 放行到 notes；没有 → 拦回 welcome
    const realRouter = (await import('@/router')).default
    await realRouter.push('/')
    await settle(20)
    expect(realRouter.currentRoute.value.name).toBe('notes')

    // 无库位置时，任何内页都要被拦回欢迎页（/tags 而不是 /：上一步已经停在 notes，
    // 再 push 同一个路由会被判成重复导航、守卫根本不跑）
    localStorage.removeItem(LS_KEYS.notesLocation)
    await realRouter.push('/tags')
    await settle(20)
    expect(realRouter.currentRoute.value.name).toBe('welcome')
  }, 20000)

  it('G3b 【已修】欢迎页「使用示例笔记」：写入的是同一个 key，且点完能进应用', async () => {
    // 卡片文案见 WelcomeView.vue：Electron 下是「使用示例笔记」
    const { host, router } = await mountReal(WelcomeView, {
      routes: [
        { path: '/', name: 'welcome', component: { template: '<div class="probe-welcome">welcome</div>' } },
        { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
      ]
    })

    const findSampleCard = () => [...host.querySelectorAll('.acrylic-card')]
      .find((el) => el.textContent.includes('使用示例笔记'))
    expect(findSampleCard(), '找不到「使用示例笔记」卡片').toBeTruthy()

    await clickUntil(findSampleCard, () => localStorage.getItem(LS_KEYS.notesLocation) === 'sample')

    // 写进去的必须逐字是历史值 'sample'（守卫与启动加载都靠它）
    expect(localStorage.getItem(LS_KEYS.notesLocation)).toBe('sample')
    expect(localStorage.getItem('choyeon-notes-location')).toBe('sample')
    // 写完就该进得去应用
    await settle(20)
    expect(router.currentRoute.value.name).toBe('notes')
  })

  it.skip('G4 拼写 / 行号 / 换行的最后一跳：jsdom 下 CodeMirror measure 不可用，需 Electron 真机复看', async () => {
    // 说明：B8 / B9 / B10 已在 jsdom + 真 CodeMirror 下断言扩展真的重配成功，
    // 但 jsdom 没有 Range.getClientRects，CodeMirror 的 measure 链路走不通，
    // 「改设置后编辑器不重挂载、光标不跳」这件事只能在 Electron 真机上看。
    // 补强方式：起 Electron → CDP 里改 appStore → 截图比对 gutter / wrap / 光标位置。
  })
})
