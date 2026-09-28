/**
 * T31 · 多库（Vault）管理入口（tests/workspaceManager.test.js）
 *
 * 这一份只回答一个问题：**WorkspaceManager 上的每一个按钮按下去，事情真的发生了吗，
 * 而「绝不能发生的事」真的没发生吗？**
 *
 * 三条硬性约定（违反即等于没测）：
 *   1. 一律用**真的** Pinia store（workspaceStore / appStore / noteStore）与**真的**
 *      组件。禁止手写替身 store —— 假 store 只会证明替身自己接线正确。
 *   2. 每条用例必须以**可观测**的副作用收尾：DOM 文案 / class / IPC 调用记录 /
 *      localStorage / store 状态。
 *   3. 「移除不删磁盘」用**负向断言**钉住：把一整组删除类 IPC 都装上探针，
 *      任何一次调用都会让用例变红。
 *
 * 环境：本项目**没有 vitest setup 文件**，window.electronAPI / localStorage /
 * matchMedia 全部由本文件在 beforeEach 里 mock、afterEach 里还原。
 *
 * 组件与 store 都**懒加载**：`@/utils/env` 的 IS_ELECTRON 在模块加载时求值一次，
 * 顶层静态 import 会让它们在 electronAPI 装上之前就误判成「非 Electron 环境」。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ---------------------------------------------------------------------------
// 环境 mock：electronAPI / matchMedia / localStorage
// ---------------------------------------------------------------------------

/**
 * 一整组「删除 / 搬动磁盘文件」的 IPC。
 *
 * 它们**不在** preload 里 —— 这里装上去纯粹是为了负向断言：多库管理只摘列表记录，
 * 一个都不许被调到。谁要是哪天偷偷调了，用例立刻变红，而不是等用户发现笔记没了。
 */
const DELETE_IPCS = [
  'deleteFile',
  'deleteDirectory',
  'deleteDir',
  'removeDir',
  'removeDirectory',
  'deleteWorkspace',
  'removeWorkspace',
  'trashItem',
  'trashFile',
  'unlink',
  'rmdir',
  'moveFile',
  'renameFile',
  'renameDir',
  'renameDirectory'
]

const ipc = {
  /** 调用流水：[name, ...args] */
  calls: [],
  /** 持久化层：模拟 userData/workspaces.json */
  list: [],
  activeId: null,
  /** selectNotesPath 的返回值（null = 用户在系统对话框里取消） */
  picked: null,
  /** path → probe 结果；没登记的 path 走默认「存在」 */
  probe: {}
}

function ipcCount (name) {
  return ipc.calls.filter(call => call[0] === name).length
}

function ipcArgs (name) {
  return ipc.calls.filter(call => call[0] === name).map(call => call.slice(1))
}

/** 所有删除 / 搬动类 IPC 的调用总数（期望恒为 0） */
function destructiveCalls () {
  return ipc.calls.filter(call => DELETE_IPCS.includes(call[0]))
}

function installElectronAPI () {
  ipc.calls.length = 0
  const record = (name, args) => ipc.calls.push([name, ...args])
  const api = {
    // ===== 工作空间 =====
    listWorkspaces: async () => {
      record('listWorkspaces', [])
      return JSON.parse(JSON.stringify(ipc.list))
    },
    saveWorkspaces: async (list) => {
      record('saveWorkspaces', [list])
      ipc.list = JSON.parse(JSON.stringify(Array.isArray(list) ? list : []))
      return true
    },
    setActiveWorkspace: async (id) => {
      record('setActiveWorkspace', [id])
      ipc.activeId = id || null
      return true
    },
    getActiveWorkspace: async () => {
      record('getActiveWorkspace', [])
      return ipc.activeId
    },
    probeWorkspace: async (dirPath) => {
      record('probeWorkspace', [dirPath])
      const result = ipc.probe[dirPath]
      if (result && result.__throw) throw new Error(String(result.__throw))
      return result || { exists: true, count: 2, folders: 1, writable: true }
    },
    selectNotesPath: async () => {
      record('selectNotesPath', [])
      return ipc.picked
    },

    // ===== 笔记库读取（切换库后 noteStore.loadNotesFromPath 会走这一路）=====
    setNotesPath: async (p) => {
      record('setNotesPath', [p])
      return true
    },
    readDirectoryRecursive: async () => {
      record('readDirectoryRecursive', [])
      return []
    },
    readFiles: async () => ({ files: [], errors: [] }),
    readFile: async () => null,
    writeFile: async (...args) => {
      record('writeFile', args)
      return true
    },
    fileExists: async () => false,
    createDirectory: async () => true,
    watchNotes: async () => true,
    unwatchNotes: async () => true,
    onNotesExternalChange: () => () => {},
    onMenuAction: () => () => {},
    onUpdaterEvent: () => () => {},
    onAppFlush: () => () => {},
    idmap: {
      load: async () => ({ ok: true, data: null }),
      save: async () => ({ ok: true })
    },
    logAppend: async () => ({ ok: true, written: 0 }),
    loadSpellData: async () => null,
    saveSpellData: async () => true,
    getVersion: async () => '1.2.3',
    checkForUpdates: async () => {}
  }
  for (const name of DELETE_IPCS) {
    api[name] = async (...args) => {
      record(name, args)
      return true
    }
  }
  window.electronAPI = api
  return api
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

/** 懒加载：必须在 electronAPI 装上之后才 import（见文件头注释） */
let managerComponent = null

async function loadComponent () {
  if (!managerComponent) {
    const mod = await import('@/components/WorkspaceManager.vue')
    managerComponent = mod.default
  }
  return managerComponent
}

let pinia = null
let appStore = null
let noteStore = null
let workspaceStore = null
const mountedApps = []

async function settle (ms = 0) {
  await new Promise(resolve => setTimeout(resolve, ms))
  await nextTick()
}

/**
 * 反复重试点击，直到某个副作用出现为止。
 *
 * 为什么不能「点一次 + 等 50ms」：jsdom 里偶发这一次 click 压根没进 handler
 * （前面挂过别的组件之后更常见）。这不是被测代码的行为，所以用重试把环境抖动
 * 吸收掉。防「空跑」：调用方必须自己断言副作用真的发生过 —— 万一怎么都点不动，
 * 那条断言会把用例打红，重试不会把假通过变成真通过。
 *
 * @param {() => HTMLElement|undefined} findBtn 每轮重新查询按钮
 * @param {() => boolean} done 副作用是否已出现
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<boolean>} 最终是否达成
 */
async function clickUntil (findBtn, done, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (done()) return true
    const el = findBtn()
    if (el) el.click()
    await settle(20)
  }
  return done()
}

/** 挂载真实的 WorkspaceManager（自带真 Pinia，无需 router） */
async function mountManager (props = {}) {
  const component = await loadComponent()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(component, props)
  app.use(pinia)
  app.mount(host)
  mountedApps.push(app)
  await settle(30)
  return { app, host }
}

// ---------------------------------------------------------------------------
// DOM 查询小工具（面板 Teleport 到 body，所以一律从 document 查）
// ---------------------------------------------------------------------------

function qa (selector) {
  return Array.from(document.querySelectorAll(selector))
}

function items () {
  return qa('.wm-item')
}

/** 按显示名找到那一行（重命名后名字会变，所以按名字找而不是按下标） */
function itemFor (name) {
  return items().find(el => {
    const label = el.querySelector('.wm-item-name')
    return label && label.textContent.trim() === name
  })
}

/**
 * 按工作空间 id 找行。
 *
 * 进入重命名态后名字变成输入框、`.wm-item-name` 消失，按名字找会找不到 ——
 * 「点重命名之后就再也点不到这一行」正是要靠这些用例盯住的操作路径。
 */
function itemById (id) {
  return items().find(el => el.getAttribute('data-ws-id') === id)
}

function buttonByText (root, text) {
  const wanted = String(text).replace(/\s+/g, '')
  return Array.from(root.querySelectorAll('button')).find(
    btn => (btn.textContent || '').replace(/\s+/g, '') === wanted
  )
}

/** 在当前行内找按钮（切换 / 重命名 / 移除 / 保存 / 取消 / 确认移除） */
function rowButton (name, text) {
  const row = itemFor(name)
  return row ? buttonByText(row, text) : null
}

/** 按行 id 找按钮（重命名态下名字节点已经换成输入框，必须用 id 定位） */
function rowButtonById (id, text) {
  const row = itemById(id)
  return row ? buttonByText(row, text) : null
}

function setInput (el, value) {
  if (!el) throw new Error('输入框不存在')
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * 打开某一行的重命名输入框。
 *
 * 拿不到输入框就**抛**而不是返回 null：点不动时用例必须红，不能悄悄空跑
 * （这正是「重命名按钮点了没反应」这种 bug 唯一会被抓到的地方）。
 *
 * @param {string} id 工作空间 id
 * @returns {Promise<HTMLInputElement>} 重命名输入框
 */
async function openRename (id) {
  await clickUntil(
    () => rowButtonById(id, '重命名'),
    () => !!itemById(id)?.querySelector('.wm-rename-input')
  )
  const input = itemById(id)?.querySelector('.wm-rename-input')
  if (!input) throw new Error(`行 ${id} 的重命名输入框没出现`)
  return input
}

/**
 * 打开某一行的移除二次确认。
 *
 * @param {string} id 工作空间 id
 * @returns {Promise<HTMLElement>} 确认区元素
 */
async function openRemoveConfirm (id) {
  await clickUntil(
    () => rowButtonById(id, '移除'),
    () => !!itemById(id)?.querySelector('.wm-confirm')
  )
  const confirm = itemById(id)?.querySelector('.wm-confirm')
  if (!confirm) throw new Error(`行 ${id} 的移除确认没出现`)
  return confirm
}

function toastTexts () {
  return (appStore.toasts || []).map(t => t.message)
}

function lastToast (type) {
  const list = appStore.toasts || []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!type || list[i].type === type) return list[i]
  }
  return null
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('T31 · 多库管理入口（WorkspaceManager）', () => {
  beforeEach(async () => {
    localStorage.clear()
    installMatchMedia()
    installElectronAPI()

    pinia = createPinia()
    setActivePinia(pinia)
    // 懒加载 store 模块：必须在 electronAPI 装好之后
    const [{ useAppStore }, { useNoteStore }, { useWorkspaceStore }] = await Promise.all([
      import('@/stores/app'),
      import('@/stores/note'),
      import('@/stores/workspace')
    ])
    appStore = useAppStore()
    noteStore = useNoteStore()
    workspaceStore = useWorkspaceStore()

    ipc.list = []
    ipc.activeId = null
    ipc.picked = null
    ipc.probe = {}
  })

  afterEach(() => {
    for (const app of mountedApps.splice(0)) {
      app.unmount()
    }
    document.body.innerHTML = ''
    window.matchMedia = originalMatchMedia
    if (typeof window.electronAPI !== 'undefined') {
      delete window.electronAPI
    }
    localStorage.clear()
  })

  /** 播两个库：工作库（当前）/ 私人库；第三个 gone 库默认缺失 */
  function seedTwo () {
    ipc.list = [
      { id: 'ws-work', name: '工作库', path: '/vault/work', createdAt: 1, lastOpenedAt: 2 },
      { id: 'ws-personal', name: '私人库', path: '/vault/personal', createdAt: 1, lastOpenedAt: 1 }
    ]
    ipc.activeId = 'ws-work'
  }

  // ===== A. 列表渲染与存在 / 缺失状态 =====================================

  it('A1 挂载后列出已登记的库，并显示名称与路径', async () => {
    seedTwo()
    await mountManager()

    expect(items()).toHaveLength(2)
    const work = itemById('ws-work')
    expect(work).toBeTruthy()
    expect(work.querySelector('.wm-item-path-value').textContent).toContain('/vault/work')
    expect(workspaceStore.workspaces).toHaveLength(2)
  })

  it('A2 当前库带「当前」徽标', async () => {
    seedTwo()
    await mountManager()

    const work = itemById('ws-work')
    expect(work.classList.contains('wm-item--active')).toBe(true)
    expect(work.textContent).toContain('当前')
    expect(itemById('ws-personal').classList.contains('wm-item--active')).toBe(false)
  })

  it('A3 目录被删 / 拔掉的库显示「缺失」而不是崩', async () => {
    ipc.list = [{ id: 'ws-gone', name: '移动过的库', path: '/vault/gone' }]
    ipc.activeId = 'ws-gone'
    ipc.probe['/vault/gone'] = { exists: false, count: 0, folders: 0, writable: false }
    await mountManager()

    const row = itemFor('移动过的库')
    expect(row).toBeTruthy()
    expect(row.classList.contains('wm-item--missing')).toBe(true)
    expect(row.textContent).toContain('缺失')
    expect(row.textContent).toContain('目录不存在')
  })

  it('A4 probeWorkspace 抛错时组件照常渲染，并把该库标成缺失（不崩）', async () => {
    ipc.list = [{ id: 'ws-throw', name: '探测炸了的库', path: '/vault/boom' }]
    ipc.activeId = 'ws-throw'
    ipc.probe['/vault/boom'] = { __throw: 'EACCES' }
    await mountManager()

    const row = itemFor('探测炸了的库')
    expect(row).toBeTruthy()
    expect(row.classList.contains('wm-item--missing')).toBe(true)
    expect(workspaceStore.isMissing('ws-throw')).toBe(true)
  })

  it('A5 一个库都没有时显示空态引导，而不是空白面板', async () => {
    await mountManager()

    expect(items()).toHaveLength(0)
    const empty = document.querySelector('.wm-empty')
    expect(empty).toBeTruthy()
    expect(empty.textContent).toContain('还没有登记任何笔记库')
  })

  it('A6 探测结果显示文件数与文件夹数', async () => {
    ipc.list = [{ id: 'ws-work', name: '工作库', path: '/vault/work' }]
    ipc.activeId = 'ws-work'
    ipc.probe['/vault/work'] = { exists: true, count: 12, folders: 3, writable: true }
    await mountManager()

    expect(itemById('ws-work').textContent).toContain('12 个文件 · 3 个文件夹')
  })

  // ===== B. 新增 ==========================================================

  it('B1 点新增并选择目录 → 草稿行展开，默认名取目录名', async () => {
    seedTwo()
    ipc.picked = '/vault/reading'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )

    const draft = document.querySelector('.wm-draft')
    expect(draft).toBeTruthy()
    expect(draft.textContent).toContain('/vault/reading')
    expect(draft.querySelector('.wm-draft-input').value).toBe('reading')
    expect(ipcCount('selectNotesPath')).toBeGreaterThan(0)
  })

  it('B2 保存新增 → 列表多一个、写回持久化层与 localStorage', async () => {
    seedTwo()
    ipc.picked = '/vault/reading'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )
    setInput(document.querySelector('.wm-draft-input'), '读书库')
    await clickUntil(
      () => buttonByText(document.querySelector('.wm-draft'), '保存'),
      () => workspaceStore.workspaces.length === 3
    )

    expect(workspaceStore.workspaces.map(w => w.name)).toContain('读书库')
    expect(ipcCount('saveWorkspaces')).toBeGreaterThan(0)
    const persisted = JSON.parse(localStorage.getItem('choyeon-workspaces') || '[]')
    expect(persisted.some(w => w.name === '读书库' && w.path === '/vault/reading')).toBe(true)
  })

  it('B3 在系统对话框里取消 → 不新增、不留草稿', async () => {
    seedTwo()
    ipc.picked = null
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => ipcCount('selectNotesPath') >= 1
    )
    await settle(30)

    expect(document.querySelector('.wm-draft')).toBeNull()
    expect(workspaceStore.workspaces).toHaveLength(2)
    expect(toastTexts().some(t => t.includes('已新增'))).toBe(false)
  })

  it('B4 选到已登记的目录 → 提示已登记，不重复建', async () => {
    seedTwo()
    ipc.picked = '/vault/work'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => toastTexts().some(t => t.includes('已登记为'))
    )

    expect(document.querySelector('.wm-draft')).toBeNull()
    expect(workspaceStore.workspaces).toHaveLength(2)
    expect(lastToast('info').message).toContain('工作库')
  })

  it('B5 新增名称留空 → 拦下并提示，列表不变', async () => {
    seedTwo()
    ipc.picked = '/vault/reading'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )
    setInput(document.querySelector('.wm-draft-input'), '   ')
    await clickUntil(
      () => buttonByText(document.querySelector('.wm-draft'), '保存'),
      () => toastTexts().some(t => t.includes('名称不能为空'))
    )

    expect(workspaceStore.workspaces).toHaveLength(2)
    expect(lastToast('error').message).toBe('名称不能为空')
    // 拦下后草稿要留着：用户改一个字符就能重试
    expect(document.querySelector('.wm-draft')).toBeTruthy()
  })

  it('B6 新增名称与已有库重名 → 拦下并提示，列表不变', async () => {
    seedTwo()
    ipc.picked = '/vault/reading'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )
    setInput(document.querySelector('.wm-draft-input'), '工作库')
    await clickUntil(
      () => buttonByText(document.querySelector('.wm-draft'), '保存'),
      () => toastTexts().some(t => t.includes('已存在名为'))
    )

    expect(workspaceStore.workspaces).toHaveLength(2)
    expect(lastToast('error').message).toContain('已存在名为「工作库」')
  })

  it('B7 新增成功给出成功提示，且全程零删除类 IPC', async () => {
    seedTwo()
    ipc.picked = '/vault/reading'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )
    await clickUntil(
      () => buttonByText(document.querySelector('.wm-draft'), '保存'),
      () => toastTexts().some(t => t.includes('已新增笔记库'))
    )

    expect(lastToast('success').message).toContain('已新增笔记库')
    expect(destructiveCalls()).toHaveLength(0)
  })

  it('B8 取消新增 → 草稿消失且列表不变', async () => {
    seedTwo()
    ipc.picked = '/vault/reading'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )
    await clickUntil(
      () => buttonByText(document.querySelector('.wm-draft'), '取消'),
      () => !document.querySelector('.wm-draft')
    )

    expect(document.querySelector('.wm-draft')).toBeNull()
    expect(workspaceStore.workspaces).toHaveLength(2)
  })

  it('B9 首次登记（原来没有当前库）时新增后自动切过去', async () => {
    ipc.picked = '/vault/first'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )
    await clickUntil(
      () => buttonByText(document.querySelector('.wm-draft'), '保存'),
      () => !!workspaceStore.activeId
    )
    await settle(30)

    expect(workspaceStore.activeWorkspace?.path).toBe('/vault/first')
    expect(noteStore.notesPath).toBe('/vault/first')
  })

  // ===== C. 切换 ==========================================================

  it('C1 点切换 → 真的换当前库，并把笔记库路径落到 noteStore', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButton('私人库', '切换'),
      () => workspaceStore.activeId === 'ws-personal'
    )
    await settle(30)

    expect(ipcArgs('setActiveWorkspace').some(args => args[0] === 'ws-personal')).toBe(true)
    expect(noteStore.notesPath).toBe('/vault/personal')
    expect(appStore.notesLocation).toBe('/vault/personal')
    expect(lastToast('success').message).toContain('已切换到「私人库」')
  })

  it('C2 切换到目录已不存在的库 → 明确提示并拒绝切换（不静默切进空库）', async () => {
    ipc.list = [
      { id: 'ws-work', name: '工作库', path: '/vault/work' },
      { id: 'ws-gone', name: '拔掉的库', path: '/vault/gone' }
    ]
    ipc.activeId = 'ws-work'
    ipc.probe['/vault/gone'] = { exists: false, count: 0, folders: 0, writable: false }
    await mountManager()

    await clickUntil(
      () => rowButton('拔掉的库', '切换'),
      () => toastTexts().some(t => t.includes('目录已不存在'))
    )
    await settle(30)

    expect(workspaceStore.activeId).toBe('ws-work')
    expect(lastToast('error').message).toContain('未切换')
    expect(lastToast('error').message).toContain('/vault/gone')
    expect(noteStore.notesPath).not.toBe('/vault/gone')
  })

  it('C3 点当前库 → 提示「已经是当前笔记库」，不做无谓重载', async () => {
    seedTwo()
    await mountManager()

    const before = noteStore.notesPath
    await clickUntil(
      () => rowButton('工作库', '切换'),
      () => toastTexts().some(t => t.includes('已经是当前笔记库'))
    )

    expect(noteStore.notesPath).toBe(before)
    expect(workspaceStore.activeId).toBe('ws-work')
  })

  it('C4 切换失败（写盘失败）时保持原库并给出提示', async () => {
    seedTwo()
    await mountManager()
    // 让持久化层拒绝写入：setActive 检测到写失败会把指针拨回去
    window.electronAPI.saveWorkspaces = async () => {
      throw new Error('userData 只读')
    }

    await clickUntil(
      () => rowButton('私人库', '切换'),
      () => toastTexts().some(t => t.includes('切换笔记库失败'))
    )

    expect(workspaceStore.activeId).toBe('ws-work')
    expect(lastToast('error').message).toContain('切换笔记库失败')
  })

  it('C5 切换后列表里的「当前」徽标跟着走', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButton('私人库', '切换'),
      () => workspaceStore.activeId === 'ws-personal'
    )
    await settle(30)

    expect(itemById('ws-personal').classList.contains('wm-item--active')).toBe(true)
    expect(itemById('ws-work').classList.contains('wm-item--active')).toBe(false)
  })

  // ===== D. 重命名 ========================================================

  it('D1 重命名只改显示名：目录原封不动，且不触发任何删除 / 搬动类 IPC', async () => {
    seedTwo()
    await mountManager()

    const input = await openRename('ws-work')
    setInput(input, '公司库')
    await clickUntil(
      () => rowButtonById('ws-work', '保存'),
      () => workspaceStore.workspaces.some(w => w.name === '公司库')
    )
    await settle(30)

    const renamed = workspaceStore.workspaces.find(w => w.id === 'ws-work')
    expect(renamed.name).toBe('公司库')
    expect(renamed.path).toBe('/vault/work')
    // 写回持久化层的那条记录里，路径也必须还是原路径
    const persisted = JSON.parse(localStorage.getItem('choyeon-workspaces') || '[]')
    expect(persisted.find(w => w.id === 'ws-work').path).toBe('/vault/work')
    expect(destructiveCalls()).toHaveLength(0)
  })

  it('D2 重命名空名 → 拦下并提示，名字保持原样', async () => {
    seedTwo()
    await mountManager()

    const input = await openRename('ws-work')
    setInput(input, '  ')
    await clickUntil(
      () => rowButtonById('ws-work', '保存'),
      () => toastTexts().some(t => t.includes('名称不能为空'))
    )

    expect(workspaceStore.workspaces.find(w => w.id === 'ws-work').name).toBe('工作库')
    expect(lastToast('error').message).toBe('名称不能为空')
    // 拦下后输入框要留在原地，方便用户改一个字符就重试
    expect(itemById('ws-work').querySelector('.wm-rename-input')).toBeTruthy()
  })

  it('D3 重命名撞上已有库名 → 拦下并提示', async () => {
    seedTwo()
    await mountManager()

    const input = await openRename('ws-work')
    setInput(input, '私人库')
    await clickUntil(
      () => rowButtonById('ws-work', '保存'),
      () => toastTexts().some(t => t.includes('已存在名为'))
    )

    expect(workspaceStore.workspaces.find(w => w.id === 'ws-work').name).toBe('工作库')
    expect(lastToast('error').message).toContain('已存在名为「私人库」')
  })

  it('D4 重命名会 trim 首尾空白', async () => {
    seedTwo()
    await mountManager()

    const input = await openRename('ws-work')
    setInput(input, '   trimmed   ')
    await clickUntil(
      () => rowButtonById('ws-work', '保存'),
      () => workspaceStore.workspaces.some(w => w.name === 'trimmed')
    )

    expect(workspaceStore.workspaces.find(w => w.id === 'ws-work').name).toBe('trimmed')
  })

  it('D5 取消重命名 → 名字不变，输入框收起', async () => {
    seedTwo()
    await mountManager()

    await openRename('ws-work')
    await clickUntil(
      () => rowButtonById('ws-work', '取消'),
      () => !itemById('ws-work').querySelector('.wm-rename-input')
    )

    expect(workspaceStore.workspaces.find(w => w.id === 'ws-work').name).toBe('工作库')
    expect(itemById('ws-work').querySelector('.wm-item-name')).toBeTruthy()
  })

  it('D6 名称含路径分隔符 / 保留字符 → 拦下并提示', async () => {
    seedTwo()
    await mountManager()

    const input = await openRename('ws-work')
    setInput(input, 'a/b')
    await clickUntil(
      () => rowButtonById('ws-work', '保存'),
      () => toastTexts().some(t => t.includes('名称不能包含'))
    )

    expect(workspaceStore.workspaces.find(w => w.id === 'ws-work').name).toBe('工作库')
  })

  it('D7 store 层 renameWorkspace 只动 name，返回值里 path 与改前一致', async () => {
    seedTwo()
    await workspaceStore.hydrate()

    const result = await workspaceStore.renameWorkspace('ws-work', '公司库')

    expect(result.ok).toBe(true)
    expect(result.workspace.path).toBe('/vault/work')
    expect(workspaceStore.workspaces.find(w => w.id === 'ws-work').path).toBe('/vault/work')
    expect(destructiveCalls()).toHaveLength(0)
  })

  // ===== E. 移除 ==========================================================

  it('E1 点移除 → 出现二次确认，文案写明「仅从列表移除，磁盘文件不会删除」', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButtonById('ws-personal', '移除'),
      () => !!itemById('ws-personal')?.querySelector('.wm-confirm')
    )

    const confirm = itemById('ws-personal').querySelector('.wm-confirm')
    expect(confirm.textContent).toContain('仅从列表移除')
    expect(confirm.textContent).toContain('磁盘文件不会删除')
    expect(workspaceStore.workspaces).toHaveLength(2)
  })

  it('E2 确认移除 → 列表少一个，且**零**删除类 IPC（磁盘文件不动）', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButtonById('ws-personal', '移除'),
      () => !!itemById('ws-personal')?.querySelector('.wm-confirm')
    )
    await clickUntil(
      () => buttonByText(itemById('ws-personal').querySelector('.wm-confirm'), '确认移除'),
      () => workspaceStore.workspaces.length === 1
    )
    await settle(30)

    expect(workspaceStore.workspaces.map(w => w.id)).toEqual(['ws-work'])
    expect(ipcCount('saveWorkspaces')).toBeGreaterThan(0)
    expect(destructiveCalls()).toHaveLength(0)
    // 具体到名字：每一类删除 IPC 的调用次数都必须是 0
    for (const name of DELETE_IPCS) {
      expect(ipcCount(name), `不应调用 ${name}`).toBe(0)
    }
  })

  it('E3 移除后磁盘目录仍然登记在持久化层之外：本地列表里没有，但提示说清未删文件', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButtonById('ws-personal', '移除'),
      () => !!itemById('ws-personal')?.querySelector('.wm-confirm')
    )
    await clickUntil(
      () => buttonByText(itemById('ws-personal').querySelector('.wm-confirm'), '确认移除'),
      () => toastTexts().some(t => t.includes('磁盘文件未删除'))
    )

    expect(lastToast('success').message).toContain('私人库')
    expect(lastToast('success').message).toContain('磁盘文件未删除')
  })

  it('E4 取消移除 → 列表不变', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButtonById('ws-personal', '移除'),
      () => !!itemById('ws-personal')?.querySelector('.wm-confirm')
    )
    await clickUntil(
      () => buttonByText(itemById('ws-personal').querySelector('.wm-confirm'), '取消'),
      () => !itemById('ws-personal')?.querySelector('.wm-confirm')
    )

    expect(workspaceStore.workspaces).toHaveLength(2)
  })

  it('E5 移除当前库 → 当前指针转移到剩下的库，不会悬空', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButtonById('ws-work', '移除'),
      () => !!itemById('ws-work')?.querySelector('.wm-confirm')
    )
    await clickUntil(
      () => buttonByText(itemById('ws-work').querySelector('.wm-confirm'), '确认移除'),
      () => workspaceStore.workspaces.length === 1
    )
    await settle(30)

    expect(workspaceStore.activeId).toBe('ws-personal')
    expect(workspaceStore.activeWorkspace).toBeTruthy()
  })

  it('E6 store 层 removeWorkspace 对未知 id 返回失败而不是抛', async () => {
    seedTwo()
    await workspaceStore.hydrate()

    const result = await workspaceStore.removeWorkspace('ws-not-exist')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
    expect(workspaceStore.workspaces).toHaveLength(2)
  })

  it('E7 移除最后一个库后回到空态，且不崩', async () => {
    ipc.list = [{ id: 'ws-only', name: '唯一的库', path: '/vault/only' }]
    ipc.activeId = 'ws-only'
    await mountManager()

    await clickUntil(
      () => rowButtonById('ws-only', '移除'),
      () => !!itemById('ws-only')?.querySelector('.wm-confirm')
    )
    await clickUntil(
      () => buttonByText(itemById('ws-only').querySelector('.wm-confirm'), '确认移除'),
      () => workspaceStore.workspaces.length === 0
    )
    await settle(30)

    expect(workspaceStore.activeId).toBeNull()
    expect(document.querySelector('.wm-empty')).toBeTruthy()
    expect(destructiveCalls()).toHaveLength(0)
  })

  // ===== F. 健壮性 / 边界 =================================================

  it('F1 没有 electronAPI（浏览器预览 / 降级）时点新增给出明确提示且不崩', async () => {
    seedTwo()
    await mountManager()

    const saved = window.electronAPI
    window.electronAPI = undefined
    try {
      await clickUntil(
        () => buttonByText(document.body, '新增笔记库'),
        () => toastTexts().some(t => t.includes('当前环境不支持选择本地文件夹'))
      )
      expect(lastToast('info').message).toContain('当前环境不支持选择本地文件夹')
      expect(document.querySelector('.wm-draft')).toBeNull()
    } finally {
      window.electronAPI = saved
    }
  })

  it('F2 store 层 addWorkspace 拦住含控制字符（NUL）的路径', async () => {
    await workspaceStore.hydrate()
    // 用 String.fromCharCode 而不是字面量：源码里不许出现裸控制字节
    const withNul = `/vault/bad${String.fromCharCode(0)}name`

    const result = await workspaceStore.addWorkspace(withNul, '坏路径')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('非法字符')
    expect(workspaceStore.workspaces).toHaveLength(0)
  })

  it('F3 store 层 addWorkspace 拦住磁盘根目录 / 盘符根', async () => {
    await workspaceStore.hydrate()

    for (const bad of ['/', 'C:\\', '.', '..']) {
      const result = await workspaceStore.addWorkspace(bad, '根目录库')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('根目录')
    }
    expect(workspaceStore.workspaces).toHaveLength(0)
  })

  it('F4 store 层 addWorkspace 拦住空路径与非字符串', async () => {
    await workspaceStore.hydrate()

    expect((await workspaceStore.addWorkspace('', 'x')).ok).toBe(false)
    expect((await workspaceStore.addWorkspace('   ', 'x')).ok).toBe(false)
    expect((await workspaceStore.addWorkspace(null, 'x')).ok).toBe(false)
    expect((await workspaceStore.addWorkspace(123, 'x')).ok).toBe(false)
    expect((await workspaceStore.addWorkspace('sample', 'x')).ok).toBe(false)
  })

  it('F5 store 层 addWorkspace：同名不同目录也要拦（列表里两个同名项没法用）', async () => {
    await workspaceStore.hydrate()
    await workspaceStore.addWorkspace('/vault/a', '工作库')

    const result = await workspaceStore.addWorkspace('/vault/b', '工作库')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('已存在名为')
    expect(workspaceStore.workspaces).toHaveLength(1)
  })

  it('F6 store 层 addWorkspace：同一目录重复登记回传已有那条，不建第二条', async () => {
    await workspaceStore.hydrate()
    const first = await workspaceStore.addWorkspace('/vault/a', '工作库')

    const again = await workspaceStore.addWorkspace('/vault/a', '别的名字')

    expect(again.ok).toBe(true)
    expect(again.alreadyExists).toBe(true)
    expect(again.workspace.id).toBe(first.workspace.id)
    expect(workspaceStore.workspaces).toHaveLength(1)
  })

  it('F7 store 层 switchWorkspace 对未知 id 返回失败而不是抛', async () => {
    seedTwo()
    await workspaceStore.hydrate()

    const result = await workspaceStore.switchWorkspace('ws-not-exist')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
    expect(workspaceStore.activeId).toBe('ws-work')
  })

  it('F8 面板 Esc 先取消当前输入、再关面板（分层处理，不误丢输入）', async () => {
    seedTwo()
    await mountManager()

    await clickUntil(
      () => rowButtonById('ws-personal', '移除'),
      () => !!itemById('ws-personal')?.querySelector('.wm-confirm')
    )
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle(20)
    expect(itemById('ws-personal').querySelector('.wm-confirm')).toBeNull()
    expect(document.querySelector('.wm-panel')).toBeTruthy()

    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    // 关闭要等 Transition 的 leave 走完（jsdom 里不是同步移除），多给一点时间
    await clickUntil(() => null, () => !document.querySelector('.wm-panel'), 1000)
    expect(document.querySelector('.wm-panel')).toBeNull()
  })

  it('F9 有未完成输入时点遮罩不关闭面板', async () => {
    seedTwo()
    ipc.picked = '/vault/reading'
    await mountManager()

    await clickUntil(
      () => buttonByText(document.body, '新增笔记库'),
      () => !!document.querySelector('.wm-draft')
    )
    document.querySelector('.wm-backdrop').dispatchEvent(
      new window.MouseEvent('mousedown', { bubbles: true })
    )
    await settle(20)

    expect(document.querySelector('.wm-panel')).toBeTruthy()
    expect(document.querySelector('.wm-draft')).toBeTruthy()
  })
})
