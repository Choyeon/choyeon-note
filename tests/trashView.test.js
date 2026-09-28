/**
 * T28 ·「最近删除」视图测试（tests/trashView.test.js）
 *
 * 这一份只回答一个问题：**用户误删的东西，是不是真的能在应用里看见并一键找回？**
 *
 * 三条硬性约定（违反即等于没测）：
 *   1. 一律**真的挂载** TrashView（createApp + createPinia + 真 DOM），不手写
 *      store 替身、不手写组件替身 —— 假替身只会证明替身自己接线正确。
 *   2. IPC 用**调用记录**断言：trashRestore 到底带没带 strategy、trashPurge 到底
 *      有没有显式 all:true、还原成功后有没有真去刷一次索引，全都看 ipc.calls。
 *   3. 断言走 `data-testid`（与 settingsWiring.test.js 同一口径），不靠
 *      class 名 —— class 是 Tailwind 产物，重构一次就全红。
 *
 * 环境：本项目**没有 vitest setup 文件**，window.electronAPI / matchMedia /
 * localStorage 全部由本文件在 beforeEach 里 mock、afterEach 里还原。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import TrashView, {
  reportTrashMethod,
  resetSystemTrashState,
  getSystemTrashState,
  TRASH_METHOD_SYSTEM,
  TRASH_METHOD_EVENT
} from '@/views/TrashView.vue'
import { LS_KEYS } from '@/constants/storage'

// ---------------------------------------------------------------------------
// 常量与样本
// ---------------------------------------------------------------------------

/** 笔记库根（Windows 反斜杠形态，正是主进程回的那种） */
const ROOT = 'D:\\MyNotes'

/** 一个固定的删除时间（本地时区解析，格式化后仍在同一天） */
const TRASHED_AT = new Date(2026, 1, 1, 10, 20, 0).getTime()

/**
 * 造一条回收站条目。
 * @param {object} over 覆盖字段
 * @returns {object} 与 T27 trash:list 的 entry 形状一致
 */
function makeEntry (over = {}) {
  return {
    id: 'a.md__2026-02-01T02-20-00-000Z',
    name: 'a.md',
    trashName: 'a.md__2026-02-01T02-20-00-000Z',
    trashPath: `${ROOT}\\.trash\\a.md__2026-02-01T02-20-00-000Z`,
    metaPath: `${ROOT}\\.trash\\a.md__2026-02-01T02-20-00-000Z.trashmeta.json`,
    originPath: `${ROOT}\\sub\\a.md`,
    trashedAt: TRASHED_AT,
    trashedAtISO: new Date(TRASHED_AT).toISOString(),
    purgeAt: TRASHED_AT + 30 * 24 * 3600 * 1000,
    size: 2048,
    kind: 'file',
    degraded: false,
    degradedReason: null,
    hasMeta: true,
    outsideRoot: false,
    expired: false,
    ...over
  }
}

/** 成功响应壳子 */
function okList (entries, extra = {}) {
  return {
    ok: true,
    entries,
    trashDir: `${ROOT}\\.trash`,
    exists: true,
    retentionDays: 30,
    nowMs: TRASHED_AT + 1000,
    ...extra
  }
}

// ---------------------------------------------------------------------------
// 环境 mock
// ---------------------------------------------------------------------------

/** IPC 调用流水与可编程响应 */
const ipc = {
  calls: [],
  list: okList([]),
  restore: { ok: true, path: `${ROOT}\\sub\\a.md`, renamed: false, metaCleaned: true, kind: 'file', size: 2048 },
  purge: { ok: true, purged: ['x'], failed: [], kept: [] },
  /** 置为 Error 实例时，对应通道会抛 */
  listThrows: null,
  restoreThrows: null,
  /** 索引刷新次数（loadNotesFromPath → readDirectoryRecursive） */
  indexRefreshes: 0
}

function pushCall (name, args) {
  ipc.calls.push([name, ...args])
}

/** 取最近一次某通道的入参 */
function lastCall (name) {
  for (let i = ipc.calls.length - 1; i >= 0; i -= 1) {
    if (ipc.calls[i][0] === name) return ipc.calls[i]
  }
  return null
}

/** 某通道被调用的次数 */
function callCount (name) {
  return ipc.calls.filter((c) => c[0] === name).length
}

function installElectronAPI () {
  window.electronAPI = {
    trashList: async (options) => {
      pushCall('trashList', [options])
      if (ipc.listThrows) throw ipc.listThrows
      return ipc.list
    },
    trashRestore: async (payload) => {
      pushCall('trashRestore', [payload])
      if (ipc.restoreThrows) throw ipc.restoreThrows
      return typeof ipc.restore === 'function' ? ipc.restore(payload) : ipc.restore
    },
    trashPurge: async (payload) => {
      pushCall('trashPurge', [payload])
      return typeof ipc.purge === 'function' ? ipc.purge(payload) : ipc.purge
    },
    // ---- 还原 / 删除后 refreshIndex() 会走 loadNotesFromPath，这些都得在 ----
    readDirectoryRecursive: async () => {
      ipc.indexRefreshes += 1
      return []
    },
    readDirectory: async () => [],
    readFiles: async () => ({ ok: true, files: [], errors: [] }),
    setNotesPath: async () => true,
    getNotesPath: async () => ROOT,
    writeFile: async () => true,
    idmap: {
      load: async () => ({ ok: true, data: null }),
      save: async () => ({ ok: true })
    }
  }
}

function installMatchMedia () {
  window.matchMedia = window.matchMedia || ((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  }))
}

/** 等到所有已排队的微任务 + 一个宏任务跑完（IPC 全是 async，必须让出） */
async function flush (rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** 挂载 TrashView，返回宿主节点与实例 */
async function mountView () {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = createApp(TrashView)
  app.use(pinia)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const vm = app.mount(host)
  await flush()
  return { app, host, vm, pinia }
}

/** 取一个 testid 节点 */
function q (host, testid) {
  return host.querySelector(`[data-testid="${testid}"]`)
}

/** Teleport 到 body 的弹窗不在 host 里，得从 document 找 */
function qDoc (testid) {
  return document.querySelector(`[data-testid="${testid}"]`)
}

/** 点击（并等渲染） */
async function click (node) {
  expect(node, '要点击的节点不存在').toBeTruthy()
  node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flush()
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

let ctx = null

beforeEach(() => {
  resetSystemTrashState()
  ipc.calls = []
  ipc.list = okList([])
  ipc.restore = { ok: true, path: `${ROOT}\\sub\\a.md`, renamed: false, metaCleaned: true, kind: 'file', size: 2048 }
  ipc.purge = { ok: true, purged: ['x'], failed: [], kept: [] }
  ipc.listThrows = null
  ipc.restoreThrows = null
  ipc.indexRefreshes = 0
  installElectronAPI()
  installMatchMedia()
  localStorage.clear()
  localStorage.setItem(LS_KEYS.notesLocation, ROOT)
})

afterEach(() => {
  if (ctx && ctx.app) {
    ctx.app.unmount()
    if (ctx.host && ctx.host.parentNode) ctx.host.parentNode.removeChild(ctx.host)
  }
  ctx = null
  document.body.innerHTML = ''
  delete window.electronAPI
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('T28 · 最近删除视图（TrashView）', () => {
  // ---- 列表渲染 ----

  it('挂载后调 trashList 一次，并渲染出条目名', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    expect(callCount('trashList')).toBe(1)
    expect(q(ctx.host, 'entry-name').textContent.trim()).toBe('a.md')
  })

  it('列表渲染含来源路径，且是相对笔记库根的相对路径', async () => {
    ipc.list = okList([makeEntry({ originPath: `${ROOT}\\sub\\deep\\a.md` })])
    ctx = await mountView()
    const node = q(ctx.host, 'origin-path')
    expect(node.textContent.trim()).toBe('sub/deep/a.md')
  })

  it('来源路径的正斜杠写法同样能相对化（Windows / POSIX 分隔符归一化）', async () => {
    ipc.list = okList([makeEntry({ originPath: 'D:/MyNotes/x/y.md' })])
    ctx = await mountView()
    expect(q(ctx.host, 'origin-path').textContent.trim()).toBe('x/y.md')
  })

  it('悬停（title）给出完整绝对路径，不丢信息', async () => {
    ipc.list = okList([makeEntry({ originPath: `${ROOT}\\sub\\a.md` })])
    ctx = await mountView()
    expect(q(ctx.host, 'origin-path').getAttribute('title')).toBe(`${ROOT}\\sub\\a.md`)
  })

  it('不在库内的条目无法相对化，原样显示绝对路径', async () => {
    ipc.list = okList([makeEntry({ originPath: 'E:\\elsewhere\\a.md' })])
    ctx = await mountView()
    expect(q(ctx.host, 'origin-path').textContent.trim()).toBe('E:\\elsewhere\\a.md')
  })

  it('显示删除时间与体积', async () => {
    ipc.list = okList([makeEntry({ size: 2048 })])
    ctx = await mountView()
    expect(q(ctx.host, 'entry-time').textContent.trim()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(q(ctx.host, 'entry-time').textContent).toContain('2026-02-01')
    expect(q(ctx.host, 'entry-size').textContent.trim()).toBe('2.0 KB')
  })

  it('体积小于 1KB 时按 B 显示', async () => {
    ipc.list = okList([makeEntry({ size: 512 })])
    ctx = await mountView()
    expect(q(ctx.host, 'entry-size').textContent.trim()).toBe('512 B')
  })

  it('文件夹条目用文件夹图标分支渲染（kind=dir 不报错）', async () => {
    ipc.list = okList([makeEntry({ id: 'd', name: 'folder', kind: 'dir', size: 4096 })])
    ctx = await mountView()
    expect(q(ctx.host, 'entry-name').textContent.trim()).toBe('folder')
  })

  // ---- 三种标记 ----

  it('degraded 条目必须打「原位置未知，将还原到库根」标记', async () => {
    ipc.list = okList([makeEntry({ degraded: true, degradedReason: 'meta-missing' })])
    ctx = await mountView()
    const badge = q(ctx.host, 'badge-degraded')
    expect(badge).toBeTruthy()
    expect(badge.textContent.trim()).toBe('原位置未知，将还原到库根')
  })

  it('degraded 条目的来源路径标注为「推测」', async () => {
    ipc.list = okList([makeEntry({ degraded: true })])
    ctx = await mountView()
    expect(q(ctx.host, 'origin-path').textContent).toContain('（推测）')
  })

  it('未 degraded 的条目不带该标记', async () => {
    ipc.list = okList([makeEntry({ degraded: false })])
    ctx = await mountView()
    expect(q(ctx.host, 'badge-degraded')).toBeNull()
  })

  it('expired 条目打「即将被清理」', async () => {
    ipc.list = okList([makeEntry({ expired: true })])
    ctx = await mountView()
    expect(q(ctx.host, 'badge-expired').textContent.trim()).toBe('即将被清理')
  })

  it('outsideRoot 条目打「不在笔记库内」标记', async () => {
    ipc.list = okList([makeEntry({ outsideRoot: true })])
    ctx = await mountView()
    expect(q(ctx.host, 'badge-outside-root')).toBeTruthy()
  })

  it('outsideRoot 条目还原按钮置灰（disabled）', async () => {
    ipc.list = okList([makeEntry({ outsideRoot: true })])
    ctx = await mountView()
    const btn = q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z')
    expect(btn.disabled).toBe(true)
  })

  it('点置灰的还原按钮不会发出 trashRestore', async () => {
    ipc.list = okList([makeEntry({ outsideRoot: true })])
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    expect(callCount('trashRestore')).toBe(0)
  })

  // ---- 空态 / 错误态 ----

  it('回收站为空时显示空态，不发「清空」请求', async () => {
    ipc.list = okList([])
    ctx = await mountView()
    expect(q(ctx.host, 'trash-empty')).toBeTruthy()
    expect(q(ctx.host, 'btn-purge-all').disabled).toBe(true)
  })

  it('trashList 抛错 → 走错误态 + 重试按钮，页面不崩', async () => {
    ipc.listThrows = new Error('IPC 断了')
    ctx = await mountView()
    expect(q(ctx.host, 'trash-error')).toBeTruthy()
    expect(q(ctx.host, 'trash-error').textContent).toContain('IPC 断了')
    expect(q(ctx.host, 'trash-empty')).toBeNull()
  })

  it('trashList 回 ok:false → 走错误态', async () => {
    ipc.list = { ok: false, message: '读取回收站失败' }
    ctx = await mountView()
    expect(q(ctx.host, 'trash-error').textContent).toContain('读取回收站失败')
  })

  it('点「重试」会再打一次 trashList', async () => {
    ipc.listThrows = new Error('boom')
    ctx = await mountView()
    ipc.listThrows = null
    ipc.list = okList([makeEntry()])
    await click(q(ctx.host, 'btn-retry'))
    expect(callCount('trashList')).toBe(2)
    expect(q(ctx.host, 'entry-name')).toBeTruthy()
  })

  it('刷新按钮会重新拉列表', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    await click(q(ctx.host, 'btn-refresh'))
    expect(callCount('trashList')).toBe(2)
  })

  // ---- 还原 ----

  it('一键还原：默认策略调用 trashRestore({ id })', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    const call = lastCall('trashRestore')
    expect(call).toBeTruthy()
    expect(call[1]).toEqual({ id: 'a.md__2026-02-01T02-20-00-000Z' })
  })

  it('还原成功后主动刷一次索引（loadNotesFromPath）并重拉列表', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    expect(ipc.indexRefreshes).toBe(0)
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    // 主进程对还原目标做了 markSelfWrite，文件监听不会回灌这次变更 → 必须手动刷
    expect(ipc.indexRefreshes).toBeGreaterThanOrEqual(1)
    expect(callCount('trashList')).toBe(2)
  })

  it('还原成功后条目从列表消失', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    ipc.list = okList([])
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    expect(q(ctx.host, 'trash-empty')).toBeTruthy()
  })

  it('rename 还原（renamed:true）同样刷新索引', async () => {
    ipc.list = okList([makeEntry()])
    ipc.restore = { ok: true, path: `${ROOT}\\sub\\a-1.md`, renamed: true, metaCleaned: true, kind: 'file', size: 2048 }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    expect(ipc.indexRefreshes).toBeGreaterThanOrEqual(1)
  })

  it('还原失败（not-found）显示中文文案，不崩', async () => {
    ipc.list = okList([makeEntry()])
    ipc.restore = { ok: false, error: 'not-found', message: 'ENOENT' }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    expect(q(ctx.host, 'trash-error').textContent).toContain('回收站里已经没有这个条目了')
  })

  it('trashRestore 抛错 → 错误态，不崩', async () => {
    ipc.list = okList([makeEntry()])
    ipc.restoreThrows = new Error('restore exploded')
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    expect(q(ctx.host, 'trash-error').textContent).toContain('restore exploded')
  })

  // ---- 同名冲突 ----

  it('同名冲突（target-exists）弹冲突框，展示候选另存路径', async () => {
    ipc.list = okList([makeEntry()])
    ipc.restore = {
      ok: false,
      error: 'target-exists',
      message: 'EEXIST',
      requestedPath: `${ROOT}\\sub\\a.md`,
      suggestedPath: `${ROOT}\\sub\\a-1.md`
    }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    expect(qDoc('conflict-dialog')).toBeTruthy()
    expect(qDoc('conflict-suggested').textContent.trim()).toBe(`${ROOT}\\sub\\a-1.md`)
    expect(qDoc('conflict-dialog').textContent).toContain('是否另存为')
  })

  it('冲突框点「另存为」→ 用 strategy:rename 再调一次', async () => {
    ipc.list = okList([makeEntry()])
    ipc.restore = (payload) => {
      if (!payload.strategy) {
        return {
          ok: false,
          error: 'target-exists',
          requestedPath: `${ROOT}\\sub\\a.md`,
          suggestedPath: `${ROOT}\\sub\\a-1.md`
        }
      }
      return { ok: true, path: `${ROOT}\\sub\\a-1.md`, renamed: true, metaCleaned: true, kind: 'file', size: 2048 }
    }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    await click(qDoc('btn-conflict-rename'))
    const call = lastCall('trashRestore')
    expect(call[1]).toEqual({ id: 'a.md__2026-02-01T02-20-00-000Z', strategy: 'rename' })
    expect(callCount('trashRestore')).toBe(2)
    expect(qDoc('conflict-dialog')).toBeNull()
  })

  it('冲突框点「覆盖」→ 才用 strategy:overwrite', async () => {
    ipc.list = okList([makeEntry()])
    ipc.restore = (payload) => {
      if (!payload.strategy) {
        return { ok: false, error: 'target-exists', requestedPath: `${ROOT}\\sub\\a.md`, suggestedPath: `${ROOT}\\sub\\a-1.md` }
      }
      return { ok: true, path: `${ROOT}\\sub\\a.md`, renamed: false, metaCleaned: true, kind: 'file', size: 2048 }
    }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    await click(qDoc('btn-conflict-overwrite'))
    expect(lastCall('trashRestore')[1]).toEqual({ id: 'a.md__2026-02-01T02-20-00-000Z', strategy: 'overwrite' })
  })

  it('冲突框点「取消」→ 不再发任何 trashRestore', async () => {
    ipc.list = okList([makeEntry()])
    ipc.restore = { ok: false, error: 'target-exists', requestedPath: `${ROOT}\\sub\\a.md`, suggestedPath: `${ROOT}\\sub\\a-1.md` }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-restore-a.md__2026-02-01T02-20-00-000Z'))
    await click(qDoc('btn-conflict-cancel'))
    expect(callCount('trashRestore')).toBe(1)
    expect(qDoc('conflict-dialog')).toBeNull()
  })

  // ---- 彻底删除 ----

  it('单条彻底删除必须弹二次确认，文案带条目名 + 时间 + 体积', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    await click(q(ctx.host, 'btn-purge-a.md__2026-02-01T02-20-00-000Z'))
    expect(callCount('trashPurge')).toBe(0)
    const dialog = qDoc('purge-dialog')
    expect(dialog).toBeTruthy()
    expect(dialog.textContent).toContain('a.md')
    expect(dialog.textContent).toContain('2026-02-01')
    expect(dialog.textContent).toContain('2.0 KB')
    expect(dialog.textContent).toContain('不可撤销')
  })

  it('确认后 trashPurge 带 ids（不是 all）', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    await click(q(ctx.host, 'btn-purge-a.md__2026-02-01T02-20-00-000Z'))
    await click(qDoc('btn-purge-confirm'))
    expect(lastCall('trashPurge')[1]).toEqual({ ids: ['a.md__2026-02-01T02-20-00-000Z'] })
  })

  it('取消彻底删除 → 不发 trashPurge，列表条数不变', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    await click(q(ctx.host, 'btn-purge-a.md__2026-02-01T02-20-00-000Z'))
    await click(qDoc('btn-purge-cancel'))
    expect(callCount('trashPurge')).toBe(0)
    expect(qDoc('purge-dialog')).toBeNull()
    expect(q(ctx.host, 'entry-name')).toBeTruthy()
  })

  it('清空回收站：未勾二次确认时确认按钮 disabled，点了也不发请求', async () => {
    ipc.list = okList([makeEntry(), makeEntry({ id: 'b.md__x', name: 'b.md' })])
    ipc.purge = { ok: true, dryRun: true, targets: [makeEntry(), makeEntry({ id: 'b.md__x', name: 'b.md' })] }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-purge-all'))
    expect(qDoc('purge-all-confirm')).toBeTruthy()
    expect(qDoc('btn-purge-confirm').disabled).toBe(true)
    await click(qDoc('btn-purge-confirm'))
    expect(callCount('trashPurge')).toBe(1) // 只有 dryRun 那一次，没真删
  })

  it('清空回收站：勾选后确认，必须显式传 all:true', async () => {
    ipc.list = okList([makeEntry()])
    ipc.purge = (payload) => (payload && payload.dryRun
      ? { ok: true, dryRun: true, targets: [makeEntry()] }
      : { ok: true, purged: ['a.md__2026-02-01T02-20-00-000Z'], failed: [], kept: [] })
    ctx = await mountView()
    await click(q(ctx.host, 'btn-purge-all'))
    const checkbox = qDoc('checkbox-purge-all')
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(qDoc('btn-purge-confirm').disabled).toBe(false)
    await click(qDoc('btn-purge-confirm'))
    expect(lastCall('trashPurge')[1]).toEqual({ all: true })
  })

  it('清理过期：先 dryRun 预告，确认后 payload 为空（让主进程按保留期自裁）', async () => {
    const expiredEntry = makeEntry({ id: 'old.md__x', name: 'old.md', expired: true })
    ipc.list = okList([expiredEntry])
    ipc.purge = (payload) => (payload && payload.dryRun
      ? { ok: true, dryRun: true, expired: [expiredEntry] }
      : { ok: true, purged: ['old.md__x'], failed: [], kept: [] })
    ctx = await mountView()
    expect(q(ctx.host, 'btn-purge-expired').disabled).toBe(false)
    await click(q(ctx.host, 'btn-purge-expired'))
    expect(lastCall('trashPurge')[1]).toEqual({ dryRun: true })
    await click(qDoc('btn-purge-confirm'))
    expect(lastCall('trashPurge')[1]).toEqual({})
  })

  it('没有过期条目时「清理过期」按钮置灰', async () => {
    ipc.list = okList([makeEntry({ expired: false })])
    ctx = await mountView()
    expect(q(ctx.host, 'btn-purge-expired').disabled).toBe(true)
  })

  it('勾选批量彻底删除 → ids 含所选条目', async () => {
    ipc.list = okList([makeEntry(), makeEntry({ id: 'b.md__x', name: 'b.md' })])
    ctx = await mountView()
    const box = q(ctx.host, 'checkbox-a.md__2026-02-01T02-20-00-000Z')
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    await click(q(ctx.host, 'btn-purge-selected'))
    await click(qDoc('btn-purge-confirm'))
    expect(lastCall('trashPurge')[1]).toEqual({ ids: ['a.md__2026-02-01T02-20-00-000Z'] })
  })

  it('彻底删除成功后重拉列表', async () => {
    ipc.list = okList([makeEntry()])
    ctx = await mountView()
    await click(q(ctx.host, 'btn-purge-a.md__2026-02-01T02-20-00-000Z'))
    ipc.list = okList([])
    await click(qDoc('btn-purge-confirm'))
    expect(callCount('trashList')).toBe(2)
    expect(q(ctx.host, 'trash-empty')).toBeTruthy()
  })

  it('trashPurge 回 ok:false → 错误态', async () => {
    ipc.list = okList([makeEntry()])
    ipc.purge = { ok: false, error: 'purge-failed', message: 'EPERM' }
    ctx = await mountView()
    await click(q(ctx.host, 'btn-purge-a.md__2026-02-01T02-20-00-000Z'))
    await click(qDoc('btn-purge-confirm'))
    expect(q(ctx.host, 'trash-error').textContent).toContain('彻底删除失败')
  })

  // ---- 系统回收站 ----

  it('静态提示常驻：说明系统回收站的删除不在本列表', async () => {
    ctx = await mountView()
    const hint = q(ctx.host, 'system-trash-hint')
    expect(hint).toBeTruthy()
    expect(hint.textContent).toContain('系统回收站')
  })

  it('method=system-trash → 点亮横幅（跨实例存活）', async () => {
    ctx = await mountView()
    expect(q(ctx.host, 'system-trash-banner')).toBeNull()
    expect(reportTrashMethod(TRASH_METHOD_SYSTEM)).toBe(true)
    await flush()
    expect(q(ctx.host, 'system-trash-banner')).toBeTruthy()
    expect(getSystemTrashState().value.count).toBe(1)
  })

  it('method=library-trash 不点亮横幅（那种条目本来就躺在列表里）', async () => {
    ctx = await mountView()
    expect(reportTrashMethod('library-trash')).toBe(false)
    await flush()
    expect(q(ctx.host, 'system-trash-banner')).toBeNull()
  })

  it('window 事件通道也能点亮横幅（给 Sidebar / noteStore 用，避免反向 import 视图）', async () => {
    ctx = await mountView()
    window.dispatchEvent(new CustomEvent(TRASH_METHOD_EVENT, { detail: { method: TRASH_METHOD_SYSTEM } }))
    await flush()
    expect(q(ctx.host, 'system-trash-banner')).toBeTruthy()
  })

  it('点「知道了」收起横幅', async () => {
    ctx = await mountView()
    reportTrashMethod(TRASH_METHOD_SYSTEM)
    await flush()
    await click(q(ctx.host, 'btn-dismiss-system-trash'))
    expect(q(ctx.host, 'system-trash-banner')).toBeNull()
  })
})

describe('T28 · 路由挂载点', () => {
  it('/trash 解析到 trash 路由，而不是掉进 not-found', async () => {
    // 动态 import：路由模块会建 router 实例（hash 模式，jsdom 下可用）
    const mod = await import('@/router/index.js')
    const router = mod.default
    const resolved = router.resolve('/trash')
    expect(resolved.name).toBe('trash')
    expect(resolved.matched.length).toBeGreaterThan(0)
  })

  it('路由表里确实登记了 name=trash 这一条', async () => {
    const mod = await import('@/router/index.js')
    const names = mod.default.getRoutes().map((r) => r.name)
    expect(names).toContain('trash')
  })
})
