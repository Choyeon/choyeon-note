/**
 * updaterFeedback.test.js —— 「软件更新」链路的用户可见性守卫
 *
 * 这一份只回答一个问题：**点了「检查更新」之后，用户到底看到变化了吗？**
 *
 * 之前的链路每一段单独看都「能跑」，拼起来却是静默的：检查失败只进日志、
 * 已是最新时界面纹丝不动、版本号取不到时理直气壮显示 1.0.0、IPC 回执形状换了
 * 前端不认。功能测试全绿，用户结论是「更新功能不可用」。
 *
 * 三条硬性约定（违反即等于没测）：
 *   1. 一律挂**真的** SettingsView.vue 与**真的** Pinia store。禁止手写替身组件
 *      或假 store —— 假替身只会证明替身自己接线正确。
 *   2. 每条用例必须以**可观测**的副作用收尾：toast 队列 / DOM 文案 / 按钮态 /
 *      v-html 产物。不许断言「内部变量变了」就交差。
 *   3. **不依赖真实网络、不加载真实 electron**：`window.electronAPI` 是 mock，
 *      主进程契约（`{ ok }` 形状）用**源码级断言**钉住（main.cjs 第一行就
 *      require('electron')，在 vitest 里根本加载不起来）。
 *
 * 环境：本项目**没有 vitest setup 文件**，electronAPI / matchMedia 全部由本文件
 * 在 beforeEach 里装、afterEach 里还原。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAppStore } from '@/stores/app'
import SettingsView, {
  normalizeUpdaterResult,
  isUpdaterResultFailure,
  updaterResultCode,
  extractUpdateErrorMessage,
  truncateText,
  formatVersionText,
  sanitizeReleaseNotes,
  UNKNOWN_VERSION_TEXT,
  FALLBACK_RELEASE_NOTES,
  MAX_UPDATE_ERROR_LENGTH
} from '@/views/SettingsView.vue'

/** 主进程源码：主进程行为只能用源码级断言覆盖（理由见文件头） */
const MAIN_SRC = readFileSync(resolve(process.cwd(), 'electron', 'main.cjs'), 'utf8')

/** 设置页挂载后自动检查的延迟（与 SettingsView 的 2000ms 对齐） */
const AUTO_CHECK_DELAY = 2000

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

const originalMatchMedia = window.matchMedia

/** mock 出来的 IPC 回执，由用例按需改；默认三个通道全部「成功」 */
const ipcState = {
  version: '1.2.3',
  checkResult: { ok: true },
  downloadResult: { ok: true },
  installResult: { ok: true },
  calls: [],
  handlers: []
}

function installElectronAPI () {
  ipcState.calls.length = 0
  ipcState.handlers.length = 0
  const write = (name, args) => ipcState.calls.push([name, ...args])
  window.electronAPI = {
    getVersion: async () => {
      write('getVersion', [])
      return ipcState.version
    },
    onUpdaterEvent: (cb) => {
      write('onUpdaterEvent', [])
      ipcState.handlers.push(cb)
      return function off () {
        const idx = ipcState.handlers.indexOf(cb)
        if (idx >= 0) ipcState.handlers.splice(idx, 1)
      }
    },
    checkForUpdates: async () => {
      write('checkForUpdates', [])
      if (ipcState.checkResult instanceof Error) throw ipcState.checkResult
      return ipcState.checkResult
    },
    downloadUpdate: async () => {
      write('downloadUpdate', [])
      return ipcState.downloadResult
    },
    quitAndInstall: async () => {
      write('quitAndInstall', [])
      return ipcState.installResult
    },
    onMenuAction: () => () => {},
    onAppFlush: () => () => {},
    onNotesExternalChange: () => () => {},
    readDirectoryRecursive: async () => [],
    readDirectory: async () => [],
    fileExists: async () => false,
    selectNotesPath: async () => ''
  }
}

function installMatchMedia () {
  window.matchMedia = (query) => ({
    media: query,
    matches: false,
    addEventListener () {},
    removeEventListener () {},
    addListener () {},
    removeListener () {},
    dispatchEvent () {}
  })
}

let pinia = null
let mounted = []
let hosts = []

/** 让 DOM / 定时器跑完一轮 */
async function settle (ms = 0) {
  await nextTick()
  if (ms > 0) await new Promise((r) => setTimeout(r, ms))
  await nextTick()
}

/**
 * 挂真的 SettingsView。
 *
 * @param {{autoCheck?: boolean}} options autoCheck=false 时关掉挂载后的 2s 自动检查
 * @returns {Promise<{app: object, host: HTMLElement, store: object}>}
 */
async function mountSettings (options = {}) {
  const { autoCheck = false } = options
  const store = useAppStore()
  // 这条用例不测「挂载后自动检查」那条时间线，留着它会在 2s 后改写 updateStatus
  if (!autoCheck && store.autoCheckUpdates) store.toggleAutoCheckUpdates()

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'home', component: { template: '<div class="probe">home</div>' } }]
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  hosts.push(host)

  const app = createApp(SettingsView)
  app.use(pinia)
  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(host)
  await settle()
  mounted.push(app)
  return { app, host, store }
}

/** 向已挂载的设置页推一条主进程 updater 事件 */
function emitUpdater (event, data) {
  ipcState.handlers.forEach((cb) => cb(event, data))
}

/** 点「检查更新」那颗按钮（文案随状态变，因此按 testid 定位） */
async function clickUpdateButton (host) {
  const button = host.querySelector('[data-testid="update-action"]')
  if (!button) throw new Error('找不到更新按钮 [data-testid="update-action"]')
  button.click()
  await settle()
}

/** 更新按钮当前文案 */
function updateButtonText (host) {
  const button = host.querySelector('[data-testid="update-action"]')
  return button ? button.textContent.trim() : ''
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  installMatchMedia()
  installElectronAPI()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  hosts.forEach((host) => host.remove())
  hosts = []
  pinia = null
  window.matchMedia = originalMatchMedia
  delete window.electronAPI
  ipcState.version = '1.2.3'
  ipcState.checkResult = { ok: true }
  ipcState.downloadResult = { ok: true }
  ipcState.installResult = { ok: true }
})

// ---------------------------------------------------------------------------
// A · 用户按下按钮之后：结果必须看得见
// ---------------------------------------------------------------------------

describe('更新反馈 · A 用户点了就必须有回话', () => {
  it('A1 【D1】已是最新版本：推成功 toast，而不是让界面纹丝不动', async () => {
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)
    expect(ipcState.calls.some((c) => c[0] === 'checkForUpdates')).toBe(true)

    emitUpdater('updater:update-not-available', { version: '1.2.3' })
    await settle()

    expect(store.toasts.some((t) => t.type === 'success' && String(t.message).includes('已是最新'))).toBe(true)
    // 按钮要回到可再次点击的初始态，否则用户以为还在检查
    expect(updateButtonText(host)).toBe('检查更新')
  })

  it('A2 【D2】检查失败（错误载荷是字符串）：推 error toast 且按钮状态回 idle', async () => {
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)

    emitUpdater('updater:error', 'Cannot find latest.yml: 404 Not Found')
    await settle()

    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast, '失败了一条 toast 都没有 = 用户眼里检查没发生').toBeTruthy()
    expect(String(toast.message)).toContain('检查更新失败')
    expect(updateButtonText(host)).toBe('检查更新')
  })

  it('A3 【D2】检查失败（错误载荷是结构化对象）：toast 取 message 字段', async () => {
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)

    emitUpdater('updater:error', { message: 'net::ERR_INTERNET_DISCONNECTED', code: 'ENOTFOUND', name: 'Error' })
    await settle()

    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast).toBeTruthy()
    expect(String(toast.message)).toContain('net::ERR_INTERNET_DISCONNECTED')
    expect(updateButtonText(host)).toBe('检查更新')
  })

  it('A4 【D6】下载过程中失败：文案说「下载更新失败」而不是「检查更新失败」', async () => {
    const { host, store } = await mountSettings()
    // 先进入 downloading 态（available → 点按钮 → 走 downloadUpdate）
    emitUpdater('updater:update-available', { version: '2.0.0', releaseNotes: '<p>x</p>' })
    await settle()
    // 让主进程在 download 里失败：这里用事件而不是 IPC 回执，模拟下载中断
    await clickUpdateButton(host)
    expect(updateButtonText(host)).toContain('下载中')

    emitUpdater('updater:error', { message: 'download interrupted', code: 'EINTR' })
    await settle()

    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast).toBeTruthy()
    expect(String(toast.message)).toContain('下载更新失败')
    expect(String(toast.message)).not.toContain('检查更新失败')
    expect(updateButtonText(host)).toBe('检查更新')
  })

  it('A5 【D2】超长错误只保留前 N 个字符（toast 不是日志窗口）', async () => {
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)

    const long = 'E' + 'r'.repeat(400)
    emitUpdater('updater:error', { message: long })
    await settle()

    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast).toBeTruthy()
    // 截断后仍需带省略号提示「后面还有」，长度以一个 toast 读得完为准
    expect(String(toast.message)).toContain('…')
    expect(String(toast.message).length).toBeLessThanOrEqual('检查更新失败：'.length + MAX_UPDATE_ERROR_LENGTH + 2)
  })
})

// ---------------------------------------------------------------------------
// B · IPC 回执形状：主进程换了形状，前端要么认得出、要么别误判
// ---------------------------------------------------------------------------

describe('更新反馈 · B IPC 回执形状', () => {
  it('B1 【D5】回执 { ok:false, error }：推错误 toast，状态回 idle', async () => {
    ipcState.checkResult = { ok: false, error: 'latest.yml not found', code: 'ENOENT' }
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)

    expect(updateButtonText(host)).toBe('检查更新')
    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast).toBeTruthy()
    expect(String(toast.message)).toContain('检查更新失败')
    expect(String(toast.message)).toContain('latest.yml not found')
  })

  it('B2 【D5】回执 true（旧成功形状）：不得误判成失败', async () => {
    ipcState.checkResult = true
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)

    expect(store.toasts.filter((t) => t.type === 'error')).toHaveLength(0)
    // 检查已发出且仍停留在「检查中」——等 updater:checking/update-not-available 事件落地
    expect(updateButtonText(host)).toBe('检查中...')
  })

  it('B3 【D5】IPC reject：不再是 unhandled rejection，而是 toast 兜住', async () => {
    ipcState.checkResult = new Error('ipc channel gone')
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)

    expect(updateButtonText(host)).toBe('检查更新')
    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast).toBeTruthy()
    expect(String(toast.message)).toContain('检查更新失败')
  })

  it('B4 【D5】下载回执 { ok:false }：判失败并回到 idle', async () => {
    ipcState.downloadResult = { ok: false, error: 'ENOENT', code: 'ENOENT' }
    const { host, store } = await mountSettings()
    emitUpdater('updater:update-available', { version: '2.0.0' })
    await settle()
    await clickUpdateButton(host)

    expect(updateButtonText(host)).toBe('检查更新')
    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast).toBeTruthy()
    expect(String(toast.message)).toContain('下载更新失败')
  })

  it('B5 【D5】重启安装回执 { ok:false }：提示重试，且停在 ready 让人还能再点', async () => {
    ipcState.installResult = { ok: false, error: 'no update downloaded', code: '' }
    const { host, store } = await mountSettings()
    emitUpdater('updater:update-downloaded', { version: '2.0.0' })
    await settle()
    expect(updateButtonText(host)).toBe('重启安装')

    await clickUpdateButton(host)
    const toast = store.toasts.find((t) => t.type === 'error')
    expect(toast).toBeTruthy()
    expect(String(toast.message)).toContain('重启安装失败')
    expect(updateButtonText(host)).toBe('重启安装')
  })

  it('B6 同一条错误不会同时从 IPC 回执与事件各弹一次（去重窗口）', async () => {
    ipcState.checkResult = { ok: false, error: 'boom' }
    const { host, store } = await mountSettings()
    await clickUpdateButton(host)
    emitUpdater('updater:error', { message: 'boom' })
    await settle()

    expect(store.toasts.filter((t) => t.type === 'error')).toHaveLength(1)
    expect(updateButtonText(host)).toBe('检查更新')
  })

  it('B7 下载失败时 IPC 回执与事件同时到达：只弹一条「下载更新失败」', async () => {
    ipcState.downloadResult = { ok: false, error: 'write EPERM', code: 'EPERM' }
    const { host, store } = await mountSettings()
    emitUpdater('updater:update-available', { version: '2.0.0' })
    await settle()
    await clickUpdateButton(host)
    // 事件比回执慢一步到：真实链路里 electron-updater 两个都推
    emitUpdater('updater:error', { message: 'write EPERM', code: 'EPERM' })
    await settle()

    const errors = store.toasts.filter((t) => t.type === 'error')
    expect(errors).toHaveLength(1)
    expect(String(errors[0].message)).toContain('下载更新失败')
    expect(updateButtonText(host)).toBe('检查更新')
  })
})

// ---------------------------------------------------------------------------
// C · 版本号与更新说明
// ---------------------------------------------------------------------------

describe('更新反馈 · C 版本与说明', () => {
  it('C1 【D4】版本号取不到时显示「未知」，不再编造 1.0.0', async () => {
    ipcState.version = ''
    const { host } = await mountSettings()
    await settle(20)

    expect(host.querySelector('[data-testid="current-version"]').textContent.trim()).toBe(UNKNOWN_VERSION_TEXT)
    expect(host.querySelector('[data-testid="statusbar-version"]').textContent.trim()).toBe(UNKNOWN_VERSION_TEXT)
    expect(document.body.textContent).not.toContain('v1.0.0')
  })

  it('C2 【D4】版本号拿得到时照旧显示 v 前缀', async () => {
    ipcState.version = '3.4.5'
    const { host } = await mountSettings()
    await settle(20)

    expect(host.querySelector('[data-testid="current-version"]').textContent.trim()).toBe('v3.4.5')
    expect(host.querySelector('[data-testid="statusbar-version"]').textContent.trim()).toBe('v3.4.5')
  })

  it('C3 【D3】releaseNotes 是不可信输入：注入的 onerror 事件处理器被净化掉', async () => {
    const { host } = await mountSettings()
    emitUpdater('updater:update-available', {
      version: '9.9.9',
      releaseNotes: '<img src=x onerror="window.__pwned=1">'
    })
    await settle()

    const notes = host.querySelector('[data-testid="update-release-notes"]')
    expect(notes).toBeTruthy()
    expect(notes.innerHTML).not.toContain('onerror')
    expect(window.__pwned).toBeUndefined()
  })

  it('C4 【D3】releaseNotes 为空时仍显示「暂无更新说明」', async () => {
    const { host } = await mountSettings()
    emitUpdater('updater:update-available', { version: '9.9.9', releaseNotes: '' })
    await settle()

    expect(host.querySelector('[data-testid="update-release-notes"]').textContent.trim()).toBe(FALLBACK_RELEASE_NOTES)
  })

  it('C5 挂载后真的发了 getVersion（版本不是从空气里来的）', async () => {
    await mountSettings()
    await settle(20)
    expect(ipcState.calls.some((c) => c[0] === 'getVersion')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D · 纯函数层：形状判定的每条分支都要有人落地（比组件级测试便宜得多）
// ---------------------------------------------------------------------------

describe('更新反馈 · D 形状判定纯函数', () => {
  it('D1 主进程返回的新形状：{ ok:true } 与 { ok:true, skipped:true } 都不算失败', () => {
    expect(isUpdaterResultFailure({ ok: true })).toBe(false)
    expect(isUpdaterResultFailure({ ok: true, skipped: true })).toBe(false)
    expect(normalizeUpdaterResult({ ok: true, skipped: true }).skipped).toBe(true)
  })

  it('D2 主进程返回的失败形状：{ ok:false, error, code } 判失败且字段不丢', () => {
    const res = { ok: false, error: 'latest.yml 404', code: 'ENOENT' }
    expect(isUpdaterResultFailure(res)).toBe(true)
    expect(extractUpdateErrorMessage(res)).toBe('latest.yml 404')
    expect(updaterResultCode(res)).toBe('ENOENT')
  })

  it('D3 旧形状兼容：true / undefined / 空对象按成功；{ error } 按失败', () => {
    expect(isUpdaterResultFailure(true)).toBe(false)
    expect(isUpdaterResultFailure(undefined)).toBe(false)
    expect(isUpdaterResultFailure(null)).toBe(false)
    expect(isUpdaterResultFailure({})).toBe(false)
    expect(isUpdaterResultFailure({ error: 'boom' })).toBe(true)
  })

  it('D4 错误消息提取：字符串 / 对象 message / 对象 error 三种来源都能取到', () => {
    expect(extractUpdateErrorMessage('raw string')).toBe('raw string')
    expect(extractUpdateErrorMessage({ message: 'from message' })).toBe('from message')
    expect(extractUpdateErrorMessage({ ok: false, error: 'from error' })).toBe('from error')
    expect(extractUpdateErrorMessage({})).toBe('')
    expect(extractUpdateErrorMessage(null)).toBe('')
  })

  it('D5 长消息按上限截断并带省略号', () => {
    expect(truncateText('短路')).toBe('短路')
    expect(truncateText('x'.repeat(200)).length).toBeLessThanOrEqual(MAX_UPDATE_ERROR_LENGTH + 1)
    expect(truncateText('x'.repeat(200))).toContain('…')
    expect(truncateText('')).toBe('')
  })

  it('D6 版本文案：空值返回「未知」', () => {
    expect(formatVersionText('')).toBe(UNKNOWN_VERSION_TEXT)
    expect(formatVersionText(null)).toBe(UNKNOWN_VERSION_TEXT)
    expect(formatVersionText(undefined)).toBe(UNKNOWN_VERSION_TEXT)
    expect(formatVersionText('2.0.0')).toBe('v2.0.0')
  })

  it('D7 更新说明净化：script / onerror / javascript: 一律出不来', () => {
    const dirty = '<script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a><p>正常内容</p>'
    const clean = sanitizeReleaseNotes(dirty)
    expect(clean).not.toContain('onerror')
    expect(clean).not.toContain('<script')
    expect(clean.toLowerCase()).not.toContain('javascript:')
    expect(clean).toContain('正常内容')
  })

  it('D8 更新说明的空值分支背后只有一个兜底文案', () => {
    expect(sanitizeReleaseNotes('')).toBe(FALLBACK_RELEASE_NOTES)
    expect(sanitizeReleaseNotes(null)).toBe(FALLBACK_RELEASE_NOTES)
    expect(sanitizeReleaseNotes('   ')).toBe(FALLBACK_RELEASE_NOTES)
  })
})

// ---------------------------------------------------------------------------
// E · 主进程契约（源码级）
// ---------------------------------------------------------------------------

describe('更新反馈 · E 主进程返回形状契约（源码级）', () => {
  it('E1 【A3】updater:check-for-updates 成功返回 { ok:true }，并发时被合并成 skipped', () => {
    expect(MAIN_SRC).toContain('return { ok: true, skipped: true }')
    expect(MAIN_SRC).toContain('let updateCheckInFlight = false')
    expect(MAIN_SRC).toContain('await autoUpdater.checkForUpdates()')
  })

  it('E2 【A3】三条通道的失败回执统一为 { ok:false, error, code }', () => {
    expect(MAIN_SRC).toContain('return { ok: false, error: detail.message, code: detail.code }')
    expect(MAIN_SRC).toContain('return { ok: false, error: detail.message, code: detail.code }')
    // quit-and-install 也必须不再裸调用（未下载完时会抛）
    expect(MAIN_SRC).toContain('ipcMain.handle(\'updater:quit-and-install\'')
    expect(MAIN_SRC).toContain('return { ok: true }')
  })

  it('E3 【A2】updater:error 事件载荷是结构化对象而不是裸字符串', () => {
    expect(MAIN_SRC).toContain('mainWindow?.webContents.send(\'updater:error\', detail)')
    expect(MAIN_SRC).toContain('function describeUpdaterError')
    expect(MAIN_SRC).not.toContain('send(\'updater:error\', err.message)')
  })

  it('E4 【A5】关键节点进主进程日志，而不是只有 console', () => {
    expect(MAIN_SRC).toContain('ipcLog.info(\'开始检查更新\'')
    expect(MAIN_SRC).toContain('ipcLog.info(\'发现新版本\'')
    expect(MAIN_SRC).toContain('ipcLog.info(\'当前已是最新版本\'')
    expect(MAIN_SRC).toContain('ipcLog.info(\'新版本下载完成\'')
  })
})

// ---------------------------------------------------------------------------
// F · preload 契约（源码级）
// ---------------------------------------------------------------------------

describe('更新反馈 · F preload 事件白名单', () => {
  it('F1 【B】主进程发的 6 个事件，preload 一个不少地登记了，且退订会摘干净', () => {
    const preload = readFileSync(resolve(process.cwd(), 'electron', 'preload.cjs'), 'utf8')
    const channels = [
      'updater:checking',
      'updater:update-available',
      'updater:update-not-available',
      'updater:error',
      'updater:download-progress',
      'updater:update-downloaded'
    ]
    channels.forEach((channel) => {
      expect(preload, 'preload 少了通道 ' + channel).toContain(`'${channel}'`)
    })
    // 内核：send 的通道必须逐个 ipcRenderer.removeListener 回去
    channels.forEach((channel) => {
      expect(MAIN_SRC, 'main 少了事件 ' + channel).toContain(`'${channel}'`)
    })
    expect(preload).toContain('ipcRenderer.removeListener(event, listener)')
  })
})

// ---------------------------------------------------------------------------
// G · 挂载后的自动检查（时间线）
// ---------------------------------------------------------------------------

describe('更新反馈 · G 自动检查', () => {
  it('G1 设置项开着时：挂载 2s 后真发一次 checkForUpdates', async () => {
    await mountSettings({ autoCheck: true })
    await settle(AUTO_CHECK_DELAY + 400)
    expect(ipcState.calls.some((c) => c[0] === 'checkForUpdates')).toBe(true)
  }, 10000)

  it('G2 设置项关着时：一次都不发', async () => {
    await mountSettings({ autoCheck: false })
    await settle(AUTO_CHECK_DELAY + 400)
    expect(ipcState.calls.some((c) => c[0] === 'checkForUpdates')).toBe(false)
  }, 10000)
})
