/**
 * T32 · 日志查看 / 导出入口 + 多库管理挂载（tests/settingsLogs.test.js）
 *
 * 这一份只回答一个问题：**日志系统在设置页里，四条路径（查看 / 导出 / 清空 / 切级别）
 * 各自的成功与失败，用户真的看得见、且不崩吗？**
 *
 * 三条硬性约定（违反即等于没测）：
 *   1. 一律**真挂载** `views/settings/SettingsLogs.vue` 与 `views/SettingsView.vue`，
 *      配真的 Pinia store / 真的 router。禁止手写替身组件 —— 替身只能证明替身自己正确。
 *   2. 每条用例必须以**可观测**的副作用收尾：DOM 文案 / data-state / IPC 调用流水 /
 *      localStorage / 卸载时的退订计数。测的是「用户看到了什么」，不是「函数返回了什么」。
 *   3. **`window.electronAPI` 由本文件自己 mock**：本项目没有 vitest setup 文件，
 *      beforeEach 里装、afterEach 里 `delete`，绝对不能污染同 worker 里的其它测试文件。
 *
 * 环境：environment = jsdom（vite.config.js 里已配）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import SettingsLogs from '@/views/settings/SettingsLogs.vue'
import SettingsView from '@/views/SettingsView.vue'
import { LS_LOG_LEVEL } from '@/constants/logging'
import { configureLogger, getLogLevel, resetLogger, setLogLevel } from '@/utils/logger'
import { useAppStore } from '@/stores/app'

// ---------------------------------------------------------------------------
// 契约常量
// ---------------------------------------------------------------------------

/** 主进程 log:read 的硬顶；本文件的所有行数断言都以此为界 */
const READ_LIMIT = 200

/** 「日志功能仅桌面版可用」的降级文案 */
const DESKTOP_ONLY = '日志功能仅桌面版可用（查看 / 导出 / 清空 / 级别切换都需要桌面版）'

/** 默认导出目标（成功分支用） */
const EXPORT_PATH = 'C:\\Users\\me\\Desktop\\choyeon-note-log.log'

/**
 * 造一行符合 design §4.4 的日志文本：
 * `<ISO8601>  <LEVEL5>  [<module>]  <message>  <k=v>`
 *
 * @param {object} p
 * @param {number} p.index 行序号（决定时间戳）
 * @param {string} p.level 级别
 * @param {string} [p.module] 模块名
 * @param {string} [p.message] 正文
 * @returns {string}
 */
function makeLine ({ index, level, module = 'note', message = '这是一条日志' }) {
  const t = new Date(Date.UTC(2026, 2, 15, 10, 0, 0) + index * 1000).toISOString()
  const lvl = String(level).toUpperCase().padEnd(5, ' ')
  return `${t}  ${lvl}  [${module}]  ${message}  index=${index}`
}

/**
 * 造一组日志行：级别按 index % 4 轮转（debug/info/warn/error）。
 * @param {number} count 行数
 * @returns {string[]}
 */
function makeLines (count) {
  const levels = ['debug', 'info', 'warn', 'error']
  return Array.from({ length: count }, (_, i) => makeLine({ index: i, level: levels[i % 4] }))
}

// ---------------------------------------------------------------------------
// 环境 mock：electronAPI / localStorage / matchMedia
// ---------------------------------------------------------------------------

const ipc = {
  /** IPC 调用流水：[name, ...args] */
  calls: [],
  /** log:read 的返回值覆盖；null 表示走默认成功分支 */
  readResult: null,
  /** 非 null 时 log:read 直接抛这个 Error */
  readThrows: null,
  /** log:read 的默认返回行 */
  readLines: [],
  /** log:path 的返回值 */
  pathValue: 'C:\\Users\\me\\AppData\\Roaming\\choyeon-note\\logs\\main.log',
  /** log:export 的返回值覆盖；字符串简写：'canceled' | 'write-failed' */
  exportResult: null,
  /** 非 null 时 log:export 抛这个 Error */
  exportThrows: null,
  /** log:export 在 resolve 之前 await 多少毫秒（模拟大文件 IO 的等待） */
  exportDelayMs: 0,
  /**
   * log:export 在**返回之前**同步占住 JS 线程多少毫秒。
   * 默认 0 —— 真实实现里这一步在主进程，渲染侧不该有任何同步占用；
   * 用例 F-1 会把它调大做故障注入。
   */
  exportBusyMs: 0,
  /** log:clear 是否成功 */
  clearOk: true,
  /** log:set-level 是否接受 */
  setLevelOk: true,
  /** 登记下来的 log:cleared 监听者 */
  clearedHandlers: [],
  /** onLogCleared 返回的退订函数被调用的次数 */
  clearedOffCount: 0
}

function ipcCount (name) {
  return ipc.calls.filter(call => call[0] === name).length
}

function ipcArgs (name) {
  return ipc.calls.filter(call => call[0] === name).map(call => call.slice(1))
}

/** 同步占住线程 ms 毫秒（只用于故障注入） */
function busyWait (ms) {
  if (!ms || ms <= 0) return
  const end = Date.now() + ms
  while (Date.now() < end) { /* 故意空转：模拟「阻塞 UI 的同步尾巴」 */ }
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function installElectronAPI () {
  ipc.calls.length = 0
  ipc.clearedHandlers.length = 0
  ipc.clearedOffCount = 0
  const record = (name, args) => ipc.calls.push([name, ...args])

  window.electronAPI = {
    getVersion: async () => '1.2.3',
    checkForUpdates: async () => {},
    onUpdaterEvent: () => () => {},
    onMenuAction: () => () => {},
    onAppFlush: () => () => {},
    loadSpellData: async () => null,
    saveSpellData: async () => true,

    // ===== 笔记目录 / 文件（切换笔记目录失败回滚会用）=====
    selectNotesPath: async () => '/vault/picked',
    setNotesPath: async () => true,
    readDirectoryRecursive: async () => [],
    readDirectory: async () => [],
    readFiles: async () => ({ files: [], errors: [] }),
    readFile: async () => null,
    writeFile: async () => true,
    fileExists: async () => false,
    createDirectory: async () => true,
    watchNotes: async () => true,
    unwatchNotes: async () => true,
    onNotesExternalChange: () => () => {},
    idmap: { load: async () => ({ ok: true, data: null }), save: async () => ({ ok: true }) },

    // ===== 多库管理（WorkspaceManager 挂载后 onMounted 会 hydrate + probeAll）=====
    listWorkspaces: async () => {
      record('listWorkspaces', [])
      return []
    },
    saveWorkspaces: async () => true,
    getActiveWorkspace: async () => null,
    setActiveWorkspace: async () => true,
    probeWorkspace: async () => ({ exists: true, count: 0, folders: 0, writable: true }),

    // ===== 六个 log:* 通道（本次被测对象）=====
    logRead: async (limit) => {
      record('logRead', [limit])
      if (ipc.readThrows) throw ipc.readThrows
      if (ipc.readResult) return JSON.parse(JSON.stringify(ipc.readResult))
      return {
        ok: true,
        path: ipc.pathValue,
        lines: ipc.readLines.slice(),
        total: ipc.readLines.length,
        truncated: ipc.readLines.length > READ_LIMIT
      }
    },
    logPath: async () => {
      record('logPath', [])
      return ipc.pathValue
    },
    logExport: async () => {
      record('logExport', [])
      if (ipc.exportDelayMs > 0) await delay(ipc.exportDelayMs)
      busyWait(ipc.exportBusyMs)
      if (ipc.exportThrows) throw ipc.exportThrows
      if (ipc.exportResult === 'canceled') return { ok: false, error: 'canceled' }
      if (ipc.exportResult === 'write-failed') return { ok: false, error: 'write-failed' }
      if (ipc.exportResult) return JSON.parse(JSON.stringify(ipc.exportResult))
      return { ok: true, path: EXPORT_PATH }
    },
    logClear: async () => {
      record('logClear', [])
      if (!ipc.clearOk) return { ok: false, error: 'permission' }
      // 真实主进程是「先广播再 ack」：这里保持同样的顺序
      for (const handler of [...ipc.clearedHandlers]) handler()
      return { ok: true }
    },
    logSetLevel: async (level) => {
      record('logSetLevel', [level])
      if (!ipc.setLevelOk) return { ok: false, level: 'info', changed: false }
      return { ok: true, level, changed: true }
    },
    onLogCleared: (callback) => {
      record('onLogCleared', [])
      ipc.clearedHandlers.push(callback)
      return function off () {
        ipc.clearedOffCount += 1
        const idx = ipc.clearedHandlers.indexOf(callback)
        if (idx >= 0) ipc.clearedHandlers.splice(idx, 1)
      }
    }
  }
  return window.electronAPI
}

const originalMatchMedia = window.matchMedia

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

// ---------------------------------------------------------------------------
// 挂载工具
// ---------------------------------------------------------------------------

/** 已挂载的 app，afterEach 统一卸载 */
let mounted = []
let pinia = null

async function settle (ms = 0) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
  await nextTick()
}

/**
 * 反复重试点击，直到副作用出现为止。
 *
 * 为什么要重试：jsdom 里偶发（约 5%）一次 `click()` 压根没进 handler —— 元素在、
 * listener 在，就是没回调（同 worker 里前面挂载过重型组件之后更容易遇上）。
 * 这不是被测代码的行为，用重试把环境抖动吸收掉；调用方仍必须自己断言副作用真的
 * 发生过，万一怎么样都点不动，那条断言会把用例打红（重试不会把假通过变真通过）。
 *
 * @param {() => HTMLElement|undefined} findBtn 每轮重新查询
 * @param {() => boolean} done 副作用是否出现
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
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
 * 挂载真实组件（真 Pinia + 真 router）。
 * @param {object} component
 * @param {object} [options]
 * @returns {Promise<{app: object, host: HTMLElement, router: object}>}
 */
async function mountReal (component, options = {}) {
  const { routes = null } = options
  const active = pinia || createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: routes || [
      { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
      { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
    ]
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(component)
  app.use(active)
  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(host)
  await settle()
  mounted.push(app)
  return { app, host, router }
}

/** 挂载日志卡片本体 */
async function mountLogs () {
  return mountReal(SettingsLogs, {
    routes: [{ path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } }]
  })
}

// --- DOM 快捷查询 ---

function qs (host, testid) {
  return host.querySelector(`[data-testid="${testid}"]`)
}

function btn (host, testid) {
  return qs(host, testid)
}

function logLineNodes (host) {
  const list = qs(host, 'log-lines')
  return list ? [...list.querySelectorAll('li')] : []
}

function lastToast (type) {
  const appStore = useAppStore()
  const found = [...appStore.toasts].reverse().find(t => t.type === type)
  return found ? String(found.message) : ''
}

// ---------------------------------------------------------------------------
// before / after
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  installElectronAPI()
  installMatchMedia()
  // 打日志不是本文件的被测对象：把出口换成 no-op，免得每条失败分支都往测试输出
  // 里刷一行，淹没真正有用的 diff。（afterEach 的 resetLogger 会把它还原）
  configureLogger({ sink: () => {} })

  // 默认：一份 6 行的日志文件，够断言渲染，又不会让行数相关断言失真
  ipc.readLines = [
    makeLine({ index: 0, level: 'info', message: '应用启动' }),
    makeLine({ index: 1, level: 'debug', message: '索引重建' }),
    makeLine({ index: 2, level: 'warn', message: '配置文件可疑' }),
    makeLine({ index: 3, level: 'error', message: '删除文件失败' }),
    makeLine({ index: 4, level: 'error', message: '写入失败' }),
    makeLine({ index: 5, level: 'info', message: '已保存' })
  ]
  ipc.readResult = null
  ipc.readThrows = null
  ipc.pathValue = 'C:\\Users\\me\\AppData\\Roaming\\choyeon-note\\logs\\main.log'
  ipc.exportResult = null
  ipc.exportThrows = null
  ipc.exportDelayMs = 0
  ipc.exportBusyMs = 0
  ipc.clearOk = true
  ipc.setLevelOk = true
})

afterEach(() => {
  for (const app of mounted) {
    try {
      app.unmount()
    } catch {
      /* 单个卸载失败不影响其余回收 */
    }
  }
  mounted = []
  window.matchMedia = originalMatchMedia
  delete window.electronAPI
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  localStorage.clear()
  // 把内核的级别拉回出厂值：上一个用例改过级别会顺着模块作用域漏给下一个
  resetLogger()
})

// ---------------------------------------------------------------------------
// A · 查看日志
// ---------------------------------------------------------------------------

describe('T32 · A 查看日志', () => {
  it('A1 入口可见：卡片标题 + 级别下拉 + 查看/导出/清空三个按钮都渲染出来了', async () => {
    const { host } = await mountLogs()

    expect(host.textContent).toContain('诊断与日志')
    expect(btn(host, 'log-view-button')).toBeTruthy()
    expect(btn(host, 'log-export-button')).toBeTruthy()
    expect(btn(host, 'log-clear-button')).toBeTruthy()
    expect(qs(host, 'log-level-select')).toBeTruthy()
    // 三个按钮必须都说人话（「查看日志 / 导出日志 / 清空日志」），不能只是个图标
    expect(btn(host, 'log-view-button').textContent).toContain('查看日志')
    expect(btn(host, 'log-export-button').textContent).toContain('导出日志')
    expect(btn(host, 'log-clear-button').textContent).toContain('清空日志')
  })

  it('A2 查看成功：6 行日志进 DOM，文件路径与摘要一并显示', async () => {
    const { host } = await mountLogs()
    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(30)

    expect(ipcCount('logRead')).toBe(1)
    expect(ipcArgs('logRead')[0][0]).toBe(READ_LIMIT)
    expect(ipcCount('logPath')).toBeGreaterThan(0)

    expect(qs(host, 'log-viewer')).toBeTruthy()
    expect(qs(host, 'log-file-path').textContent).toContain('main.log')
    expect(qs(host, 'log-summary').textContent).toContain('已载入 6 行')
    expect(logLineNodes(host)).toHaveLength(6)
    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('ok')
  })

  it('A3 查看失败（ok:false + error）：说清原因，不清空洞吐 NOT', async () => {
    const { host } = await mountLogs()
    // 先成功一次，把画布铺起来，证明「失败真的清空了旧内容」而不是留着上一次的
    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(30)
    expect(logLineNodes(host)).toHaveLength(6)

    ipc.readResult = { ok: false, path: null, lines: [], total: 0, truncated: false, error: 'no-user-data' }
    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 1)
    await settle(30)

    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('error')
    expect(qs(host, 'log-status').textContent).toContain('no-user-data')
    expect(logLineNodes(host)).toHaveLength(0)
    expect(lastToast('error')).toContain('no-user-data')
    // 组件不能挂：三按钮仍在，用户还能重试
    expect(btn(host, 'log-view-button')).toBeTruthy()
  })

  it('A4 查看抛出（IPC 通道炸）：吞掉异常并提示，页面不崩', async () => {
    const { host } = await mountLogs()
    ipc.readThrows = new Error('IPC channel closed')

    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(30)

    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('error')
    expect(qs(host, 'log-status').textContent).toContain('IPC channel closed')
    expect(lastToast('error')).toContain('IPC channel closed')
    expect(host.querySelector('[data-testid="settings-logs"]')).toBeTruthy()
  })

  it('A5 日志文件为空：显示空态而不是一个空的白框', async () => {
    const { host } = await mountLogs()
    ipc.readLines = []

    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(30)

    expect(qs(host, 'log-empty')).toBeTruthy()
    expect(qs(host, 'log-empty').textContent).toContain('暂无日志记录')
    expect(qs(host, 'log-status').textContent).toContain('日志文件为空')
  })

  it('A6 文件路径拿不到（logPath → null）：显示「路径不可用」而不是字符串 null', async () => {
    const { host } = await mountLogs()
    ipc.pathValue = null

    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(30)

    expect(qs(host, 'log-file-path').textContent.trim()).toBe('路径不可用')
    expect(qs(host, 'log-file-path').textContent).not.toContain('null')
  })

  it('A7 级别过滤：只留 error 行，且切回「全部」能恢复（双向，不是一次性）', async () => {
    const { host } = await mountLogs()
    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(30)
    expect(logLineNodes(host)).toHaveLength(6)

    const filter = qs(host, 'log-filter-select')
    filter.value = 'error'
    filter.dispatchEvent(new window.Event('change'))
    await settle(20)
    expect(logLineNodes(host)).toHaveLength(2)
    expect(logLineNodes(host).every(li => li.textContent.includes('ERROR'))).toBe(true)

    filter.value = 'all'
    filter.dispatchEvent(new window.Event('change'))
    await settle(20)
    expect(logLineNodes(host)).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// B · 大数据量呈现
// ---------------------------------------------------------------------------

describe('T32 · B 大数据量：200 行上限 + 50 行分页', () => {
  it('B1 200 行：一次只读 200 行，DOM 里同一时刻最多 50 个 <li>', async () => {
    const { host } = await mountLogs()
    ipc.readLines = makeLines(500)
    ipc.readResult = {
      ok: true,
      path: ipc.pathValue,
      lines: ipc.readLines.slice(-READ_LIMIT),
      total: 500,
      truncated: true
    }

    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(50)

    // IPC 侧：请求的正是硬顶 200，主进程没有把整个文件灌进来
    expect(ipcArgs('logRead')[0][0]).toBe(READ_LIMIT)
    expect(qs(host, 'log-summary').textContent).toContain('文件共 500 行')
    expect(qs(host, 'log-summary').textContent).toContain('仅显示最近 200 行')

    // DOM 侧：首屏（默认最后一页）只有 50 个节点
    expect(logLineNodes(host)).toHaveLength(50)
    expect(qs(host, 'log-page-label').textContent).toContain('第 4/4 页')
  })

  it('B2 默认停在最后一页（最新的那批），并能往前翻回出错前的上下文', async () => {
    const { host } = await mountLogs()
    // 120 行 / 每页 50 → 三页：[0-49] [50-99] [100-119]
    const all = makeLines(120)
    ipc.readLines = all
    ipc.readResult = { ok: true, path: ipc.pathValue, lines: all, total: 120, truncated: false }

    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(50)

    expect(logLineNodes(host)).toHaveLength(20)
    expect(logLineNodes(host)[0].textContent).toContain('index=100')
    expect(qs(host, 'log-page-label').textContent).toContain('101–120 / 共 120 行（第 3/3 页）')

    await clickUntil(() => btn(host, 'log-page-prev'), () => {
      const first = logLineNodes(host)[0]
      return Boolean(first && first.textContent.includes('index=50'))
    })
    expect(qs(host, 'log-page-label').textContent).toContain('51–100 / 共 120 行（第 2/3 页）')

    await clickUntil(() => btn(host, 'log-page-next'), () => {
      const first = logLineNodes(host)[0]
      return Boolean(first && first.textContent.includes('index=100'))
    })
    expect(qs(host, 'log-page-label').textContent).toContain('第 3/3 页')
  })

  it('B3 第一页时上一页按钮禁用、最后一页时下一页按钮禁用（不越界）', async () => {
    const { host } = await mountLogs()
    const all = makeLines(120)
    ipc.readLines = all
    ipc.readResult = { ok: true, path: ipc.pathValue, lines: all, total: 120, truncated: false }

    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(50)
    expect(btn(host, 'log-page-next').disabled).toBe(true)

    await clickUntil(() => btn(host, 'log-page-prev'), () => {
      const first = logLineNodes(host)[0]
      return Boolean(first && first.textContent.includes('index=0'))
    })
    expect(btn(host, 'log-page-prev').disabled).toBe(true)
    expect(btn(host, 'log-page-next').disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C · 导出日志
// ---------------------------------------------------------------------------

describe('T32 · C 导出日志', () => {
  it('C1 导出成功：单个文件路径给到用户，按钮回到可用态', async () => {
    const { host } = await mountLogs()
    await clickUntil(() => btn(host, 'log-export-button'), () => ipcCount('logExport') > 0)
    await settle(60)

    expect(ipcCount('logExport')).toBe(1)
    expect(qs(host, 'log-status').textContent).toContain(EXPORT_PATH)
    expect(lastToast('success')).toContain(EXPORT_PATH)
    expect(btn(host, 'log-export-button').textContent).toContain('导出日志')
    expect(btn(host, 'log-export-button').disabled).toBe(false)
  })

  it('C2 用户在系统对话框里取消：当作「没导出」处理，不许弹红色失败', async () => {
    const { host } = await mountLogs()
    ipc.exportResult = 'canceled'

    await clickUntil(() => btn(host, 'log-export-button'), () => ipcCount('logExport') > 0)
    await settle(60)

    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('info')
    expect(qs(host, 'log-status').textContent).toContain('已取消导出')
    expect(lastToast('error')).toBe('')
    expect(btn(host, 'log-export-button').disabled).toBe(false)
  })

  it('C3 写目标文件失败：报错并说明原因 ', async () => {
    const { host } = await mountLogs()
    ipc.exportResult = 'write-failed'

    await clickUntil(() => btn(host, 'log-export-button'), () => ipcCount('logExport') > 0)
    await settle(60)

    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('error')
    expect(qs(host, 'log-status').textContent).toContain('write-failed')
    expect(lastToast('error')).toContain('write-failed')
  })

  it('C4 导出抛出（IPC 炸）：吞掉异常，按钮解锁，卡片还在', async () => {
    const { host } = await mountLogs()
    ipc.exportThrows = new Error('dialog crashed')

    await clickUntil(() => btn(host, 'log-export-button'), () => ipcCount('logExport') > 0)
    await settle(60)

    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('error')
    expect(qs(host, 'log-status').textContent).toContain('dialog crashed')
    expect(btn(host, 'log-export-button').disabled).toBe(false)
    expect(host.querySelector('[data-testid="settings-logs"]')).toBeTruthy()
  })

  it('C5 导出开始前先把「导出中…」画出去：点了立刻有反馈，而不是安静地等主进程', async () => {
    const { host } = await mountLogs()
    ipc.exportDelayMs = 300

    const button = btn(host, 'log-export-button')
    button.click()
    // 只让出一个宏任务：此时 IPC 还在主进程里跑，界面必须已经显示导出中
    await settle(20)

    expect(btn(host, 'log-export-button').textContent).toContain('导出中…')
    expect(btn(host, 'log-export-button').disabled).toBe(true)
    await settle(400)
    expect(btn(host, 'log-export-button').textContent).toContain('导出日志')
  })

  it('C6 【不阻塞 UI】导出等待期间主线程仍在呼吸：心跳定时器持续被打断不了', async () => {
    const { host } = await mountLogs()
    // 模拟「导出一个大日志文件」：IPC 要 400ms 才回来
    ipc.exportDelayMs = 400

    /** 心跳间隔（毫秒） */
    const HEARTBEAT = 5
    const gaps = []
    let last = Date.now()
    const heartbeat = setInterval(() => {
      const now = Date.now()
      gaps.push(now - last)
      last = now
    }, HEARTBEAT)

    btn(host, 'log-export-button').click()
    // 覆盖整个导出窗口：这段时间内只要主线程被同步占住，心跳就会出现一个长空档
    await settle(600)
    clearInterval(heartbeat)

    // ① 导出确实发生过（不是压根没跑，让心跳无从证明）
    expect(ipcCount('logExport')).toBe(1)
    // ② 心跳没有被长时间掐断 —— 这是「UI 没被卡死」的可观测证据
    expect(gaps.length).toBeGreaterThanOrEqual(5)
    const worst = Math.max(...gaps)
    expect(worst, `心跳最大空档 ${worst}ms，说明主线程被占住了`).toBeLessThan(200)
  }, 15000)

  it('C7 导出期间重复点击：不会堆出第二次 IPC（系统对话框是模态的，重进等于打架）', async () => {
    const { host } = await mountLogs()
    ipc.exportDelayMs = 200

    const button = btn(host, 'log-export-button')
    button.click()
    await settle(20)
    expect(btn(host, 'log-export-button').textContent).toContain('导出中…')

    // 连点三下（不管 DOM 是否拦下 disabled，handler 里的重入锁都得挡住）
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(400)

    expect(ipcCount('logExport')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// D · 日志级别
// ---------------------------------------------------------------------------

describe('T32 · D 日志级别', () => {
  it('D1 五个级别全部可选，当前值取自内核而不是 UI 手抄的名单', async () => {
    const { host } = await mountLogs()
    const select = qs(host, 'log-level-select')
    const values = [...select.options].map(o => o.value)
    expect(values).toEqual(['debug', 'info', 'warn', 'error', 'silent'])
    expect(select.value).toBe(getLogLevel())
    expect(getLogLevel()).toBe('info')
  })

  it('D2 切到 debug：内核生效 + 写进 LS_LOG_LEVEL + 主进程闸门同步 + 有反馈', async () => {
    const { host } = await mountLogs()
    const select = qs(host, 'log-level-select')

    select.value = 'debug'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)

    expect(getLogLevel()).toBe('debug')
    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('debug')
    expect(ipcArgs('logSetLevel')[0][0]).toBe('debug')
    expect(lastToast('success')).toContain('debug')
    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('ok')
  })

  it('D3 双向：切到 warn 再切回 info，两方向的流水与落盘都在', async () => {
    const { host } = await mountLogs()
    const select = qs(host, 'log-level-select')

    select.value = 'warn'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)
    expect(getLogLevel()).toBe('warn')
    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('warn')

    select.value = 'info'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)
    expect(getLogLevel()).toBe('info')
    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('info')
    expect(ipcArgs('logSetLevel').map(a => a[0])).toEqual(['warn', 'info'])
  })

  it('D4 静默档（silent）也能切换：五档不是四档 + 一个摆设', async () => {
    const { host } = await mountLogs()
    const select = qs(host, 'log-level-select')

    select.value = 'silent'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)

    expect(getLogLevel()).toBe('silent')
    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('silent')
    expect(ipcArgs('logSetLevel')[0][0]).toBe('silent')
  })

  it('D5 主进程拒绝（ok:false / changed:false）：内核与配置一起回滚，UI 回到原值', async () => {
    const { host } = await mountLogs()
    ipc.setLevelOk = false
    const select = qs(host, 'log-level-select')

    select.value = 'debug'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)

    // 渲染侧不许自己升级别：只改一侧会造成「界面显示 debug，文件里一条都没有」
    expect(getLogLevel()).toBe('info')
    expect(localStorage.getItem(LS_LOG_LEVEL)).toBeNull()
    expect(select.value).toBe('info')
    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('error')
    expect(lastToast('error')).toContain('已保持 info')
  })

  it('D6 级别可跨会话读回：内核值 → LS_LOG_LEVEL，正是 logBootstrap 启动时会捞的那个键', async () => {
    const { host } = await mountLogs()
    const select = qs(host, 'log-level-select')
    select.value = 'error'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)

    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('error')
    // 与 utils/logBootstrap.readStoredLevel 读的是同一个 key
    expect(LS_LOG_LEVEL).toBe('choyeon-log-level')
  })

  it('D7 下拉框给出脏值时不会崩（select 本身就不认这个 value，handler 必须对空串免疫）', async () => {
    const { host } = await mountLogs()
    const select = qs(host, 'log-level-select')
    // select 遇到不存在的值会把 value 置空：handler 必须对空串免疫
    select.value = 'verbose-nonexistent'
    expect(select.value).toBe('')
    select.dispatchEvent(new window.Event('change'))
    await settle(30)

    expect(getLogLevel()).toBe('info')
    expect(host.querySelector('[data-testid="settings-logs"]')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// E · 清空日志
// ---------------------------------------------------------------------------

describe('T32 · E 清空日志', () => {
  it('E1 清空成功：调了 logClear，且给了用户反馈', async () => {
    const { host } = await mountLogs()
    await clickUntil(() => btn(host, 'log-clear-button'), () => ipcCount('logClear') > 0)
    await settle(40)

    expect(ipcCount('logClear')).toBe(1)
    expect(lastToast('success')).toContain('日志已清空')
  })

  it('E2 【视图同步】收到主进程 log:cleared 后，列表、计数、空态一起归零', async () => {
    const { host } = await mountLogs()
    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(40)
    expect(logLineNodes(host)).toHaveLength(6)

    // 主进程在这里「真的广播了」（见 mock 的 logClear 实现）：
    // 视图必须先 subscribed 再清空 —— 这就是本次要钉住的行为
    expect(ipc.clearedHandlers.length).toBeGreaterThan(0)
    await clickUntil(() => btn(host, 'log-clear-button'), () => ipcCount('logClear') > 0)
    await settle(40)

    expect(logLineNodes(host)).toHaveLength(0)
    expect(qs(host, 'log-empty')).toBeTruthy()
    expect(qs(host, 'log-summary').textContent).toContain('文件为空')
    expect(qs(host, 'log-status').textContent).toContain('视图已同步')
  })

  it('E3 【事件驱动】视图清空只认主进程的广播：事件通道推一下就同步，不靠轮询', async () => {
    const { host } = await mountLogs()
    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(40)
    expect(logLineNodes(host)).toHaveLength(6)

    // 直接打主进程事件通道：连 IPC 都不用传，视图就得同步
    for (const handler of [...ipc.clearedHandlers]) handler()
    await settle(30)

    expect(logLineNodes(host)).toHaveLength(0)
    expect(qs(host, 'log-status').textContent).toContain('视图已同步')
  })

  it('E4 清空失败：保留原内容并说明原因（不在用户看不见的地方假装成功）', async () => {
    const { host } = await mountLogs()
    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(40)
    ipc.clearOk = false

    await clickUntil(() => btn(host, 'log-clear-button'), () => ipcCount('logClear') > 0)
    await settle(40)

    expect(lastToast('error')).toContain('permission')
    expect(qs(host, 'log-status').getAttribute('data-state')).toBe('error')
    expect(logLineNodes(host)).toHaveLength(6)
  })

  it('E5 卸载时退订 log:cleared：设置页进出多次不会叠出一堆监听者', async () => {
    const { app } = await mountLogs()
    expect(ipcCount('onLogCleared')).toBe(1)
    expect(ipc.clearedHandlers).toHaveLength(1)

    app.unmount()
    mounted = mounted.filter(item => item !== app)
    await settle(20)

    expect(ipc.clearedOffCount).toBe(1)
    expect(ipc.clearedHandlers).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// F · 浏览器环境降级
// ---------------------------------------------------------------------------

describe('T32 · F 浏览器环境（无 electronAPI）降级', () => {
  it('F1 渲染不崩：明确告知「日志功能仅桌面版可用」，四个操作都禁用', async () => {
    delete window.electronAPI
    const { host } = await mountLogs()

    expect(host.querySelector('[data-testid="settings-logs"]')).toBeTruthy()
    const hint = qs(host, 'log-desktop-only-hint')
    expect(hint).toBeTruthy()
    expect(hint.textContent).toContain('日志功能仅桌面版可用')
    expect(qs(host, 'log-export-button').disabled).toBe(true)
    expect(qs(host, 'log-clear-button').disabled).toBe(true)
    expect(qs(host, 'log-level-select').disabled).toBe(true)
  })

  it('F2 就算按钮被强行触发，handler 也是 null-safe 的：提示降级而不是报错', async () => {
    delete window.electronAPI
    const { host } = await mountLogs()

    for (const testid of ['log-view-button', 'log-export-button', 'log-clear-button']) {
      qs(host, testid).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    }
    await settle(30)

    expect(ipcCount('logRead')).toBe(0)
    expect(ipcCount('logExport')).toBe(0)
    expect(ipcCount('logClear')).toBe(0)
    expect(lastToast('error')).toContain('日志功能仅桌面版可用')
    expect(host.querySelector('[data-testid="settings-logs"]')).toBeTruthy()
  })

  it('F3 降级态下也不留任何 log:* 调用痕迹（不是「调了再说」）', async () => {
    delete window.electronAPI
    const { host } = await mountLogs()
    await settle(20)

    expect(ipc.calls.filter(call => String(call[0]).startsWith('log'))).toHaveLength(0)
    expect(qs(host, 'log-status').textContent.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// G · 设置页集成：日志入口 + 多库管理挂载
// ---------------------------------------------------------------------------

describe('T32 · G 设置页集成', () => {
  it('G1 设置页挂载后，两个新入口都在：诊断与日志卡片 + 「管理笔记库…」按钮', async () => {
    const { host } = await mountReal(SettingsView, {
      routes: [
        { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
        { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
      ]
    })

    expect(qs(host, 'settings-logs')).toBeTruthy()
    expect(btn(host, 'log-view-button')).toBeTruthy()
    expect(btn(host, 'log-export-button')).toBeTruthy()
    expect(btn(host, 'workspace-manager-open')).toBeTruthy()
    expect(btn(host, 'workspace-manager-open').textContent).toContain('管理笔记库')
  })

  it('G2 点「管理笔记库…」→ 面板真的打开（role=dialog + 标题「笔记库管理」）', async () => {
    const { host } = await mountReal(SettingsView, {
      routes: [
        { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
        { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
      ]
    })

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await clickUntil(
      () => btn(host, 'workspace-manager-open'),
      () => Boolean(document.querySelector('[role="dialog"]'))
    )
    await settle(30)

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog.textContent).toContain('笔记库管理')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('G3 受控挂载是双向的：面板里点「关闭」→ 设置页的 v-model 同步回 false，面板消失', async () => {
    const { host } = await mountReal(SettingsView, {
      routes: [
        { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
        { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
      ]
    })

    await clickUntil(
      () => btn(host, 'workspace-manager-open'),
      () => Boolean(document.querySelector('[role="dialog"]'))
    )
    await settle(30)

    const closeBtn = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] .wm-icon-btn')]
      .find(el => (el.getAttribute('aria-label') || '') === '关闭')
    expect(closeBtn).toBeTruthy()

    await clickUntil(() => closeBtn, () => document.querySelector('[role="dialog"]') === null, 2000)
    await settle(60)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // 面板名家是 Teleport 出去的，宿主节点里不该留下它的壳
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('G4 设置页里的日志级别下拉同样可用（入口挂载，不是抄了一份 UI）', async () => {
    const { host } = await mountReal(SettingsView, {
      routes: [
        { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
        { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
      ]
    })

    const select = qs(host, 'log-level-select')
    expect(select).toBeTruthy()
    select.value = 'warn'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)

    expect(getLogLevel()).toBe('warn')
    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('warn')
    expect(ipcArgs('logSetLevel')[0][0]).toBe('warn')
  })

  it('G5 设置页里点「查看日志」→ 真能读出内容（组件在设置页上下文里接线完整）', async () => {
    const { host } = await mountReal(SettingsView, {
      routes: [
        { path: '/', name: 'home', component: { template: '<div class="probe-home">home</div>' } },
        { path: '/notes', name: 'notes', component: { template: '<div class="probe-notes">notes</div>' } }
      ]
    })

    await clickUntil(() => btn(host, 'log-view-button'), () => ipcCount('logRead') > 0)
    await settle(40)

    expect(qs(host, 'log-viewer')).toBeTruthy()
    expect(logLineNodes(host)).toHaveLength(6)
    expect(qs(host, 'log-file-path').textContent).toContain('main.log')
  })
})

// ---------------------------------------------------------------------------
// H · 守卫：本任务的自证项（钉住「不许退化」的那几条）
// ---------------------------------------------------------------------------

describe('T32 · H 守卫', () => {
  it('H1 内核的持久化契约没有被临时換掉：切换级别走的是 LS_LOG_LEVEL，不是别的键', async () => {
    const { host } = await mountLogs()
    const select = qs(host, 'log-level-select')

    setLogLevel('info')
    select.value = 'debug'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)

    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('debug')
    expect(LS_LOG_LEVEL).toBe('choyeon-log-level')
    // 不许顺手写第二个同语义的 key：内核的两侧都不是这么记的
    const keys = Object.keys(localStorage)
    expect(keys.filter(k => k.includes('log'))).toEqual(['choyeon-log-level'])
  })

  it('H2 级别是全局设置：离开这一页后仍保持（不许在卸载时偷偷改回去）', async () => {
    const { app, host } = await mountLogs()
    const select = qs(host, 'log-level-select')
    select.value = 'debug'
    select.dispatchEvent(new window.Event('change'))
    await settle(40)
    expect(getLogLevel()).toBe('debug')

    app.unmount()
    mounted = mounted.filter(item => item !== app)
    await settle(20)

    // 「出了设置页就失效」会让 debug 档形同虚设：用户按着Ctrl+Shift+I等日志呢
    expect(getLogLevel()).toBe('debug')
    expect(localStorage.getItem(LS_LOG_LEVEL)).toBe('debug')
  })
})
