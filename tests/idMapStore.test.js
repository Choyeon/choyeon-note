// ============================================================================
// idMapStore.test.js —— T16 落盘层单测
//
// 分五组：
//   A Electron 路径：mock window.electronAPI.idmap，验证 load/save 的语义与容错；
//   B 去抖与 flush：连写合并、即时 flush、beforeunload / pagehide 兜底；
//   C 浏览器降级：没有 electronAPI 时走 localStorage，含损坏 / 存储不可用；
//   D 绝不写用户 .md：真实临时目录里的 .md 跑完整流程，逐字节比对；
//   E 真实 main.cjs：在子进程里用桩 electron 模块 require 真实的 electron/main.cjs
//     （本项目没有 vitest setup 文件，electron 不是浏览器能 require 的东西），注入
//     fs 探针后驱动 idmap:load / idmap:save 通道，验证「原子写 = tmp + rename」。
//
// 关于 mock 的边界(mock 的是什么)：
//   A 组 mock 的是 **preload 暴露的那层**，用来测 idMapStore 自己的判定逻辑;E 组不
//   mock 任何实现 —— 它 require 的是磁盘上真实的 main.cjs，只把 electron 这个
//   **宿主环境**换成桩,这样"改坏主进程实现必须能让用例变红"才成立。
//
// 环境注意：本项目 vitest 没有 setup 文件，`window.electronAPI` 由各用例在
// beforeEach 里注入、afterEach 里删除，和仓储既有约定一致。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const execFileAsync = promisify(execFile)

import { LS_KEYS } from '@/constants/storage'
import {
  ID_MAP_VERSION,
  pathHashId,
  createIdMap,
  bindPath,
  rebindPath,
  rebuildIdMap,
  parseIdMap
} from '@/utils/noteIdentity'
import {
  loadIdMap,
  saveIdMap,
  scheduleSaveIdMap,
  flushIdMapSave,
  cancelPendingIdMapSave,
  installIdMapFlush,
  ID_MAP_SAVE_DEBOUNCE_MS
} from '@/utils/idMapStore'
import { configureLogger, getRingBuffer, clearRingBuffer, resetLogger } from '@/utils/logger'

// ---------------------------------------------------------------------------
// 通用脚手架
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd()
const WIN_PATH_A = 'C:\\notes\\a.md'
const WIN_PATH_B = 'C:\\notes\\sub\\b.md'

/** 取 mod==='ipc' 的日志条目（本组件的落盘层全部打在这个模块名下） */
function ipcLogs () {
  return getRingBuffer(400).filter(e => e.mod === 'ipc')
}

/** 建一个临时的 userData / 笔记 目录 */
async function makeTempDir (prefix) {
  return fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), `choyeon-t16-${prefix}-`))
}

/** 造一张带两条绑定的映射表 */
function sampleMap () {
  const map = createIdMap()
  bindPath(map, 'id-a', WIN_PATH_A)
  bindPath(map, 'id-b', WIN_PATH_B)
  return map
}

/**
 * 注入一个内存实现的 electronAPI（模拟主进程那层的最终效果）。
 * @param {object} opts { store: { raw: string|null }, loadImpl, saveImpl }
 */
function installElectronMock (opts = {}) {
  const state = { saves: [], loads: 0, raw: opts.store && opts.store.raw !== undefined ? opts.store.raw : null }
  const api = {
    idmap: {
      load: async () => {
        state.loads += 1
        if (opts.loadImpl) return opts.loadImpl(state)
        if (state.raw === null) return { ok: true, data: null }
        try {
          return { ok: true, data: JSON.parse(state.raw) }
        } catch (e) {
          return { ok: false, data: null, error: e.message, errno: '' }
        }
      },
      save: async (payload) => {
        state.saves.push(payload)
        if (opts.saveImpl) return opts.saveImpl(state, payload)
        state.raw = JSON.stringify({ ...payload, updatedAt: 111 })
        return { ok: true }
      }
    }
  }
  window.electronAPI = api
  return state
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach：状态必须每次归零
// ---------------------------------------------------------------------------

let tempDirs = []

beforeAll(() => {
  // 测试期间关掉 logger 的控制台出口，别让预期中的 warn/error 刷屏；环形缓冲照收。
  configureLogger({ sink: null })
})

afterAll(() => {
  resetLogger()
})

beforeEach(() => {
  clearRingBuffer()
  localStorage.clear()
  delete window.electronAPI
  // 去抖状态是模块级的：先取消可能残留的定时器 / pending。
  // 有没有装过监听器无法直接问，用「安装 → 立刻卸载」的方式强制复位，
  // 保证每个用例起点都是「没监听、没定时器」。
  cancelPendingIdMapSave()
  installIdMapFlush()()
})

afterEach(() => {
  cancelPendingIdMapSave()
  installIdMapFlush()()
  delete window.electronAPI
  localStorage.clear()
  if (vi.isFakeTimers()) vi.useRealTimers()
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
  tempDirs = []
})

// ===========================================================================
// A · Electron 路径
// ===========================================================================

describe('A · Electron 路径（idmap:load / idmap:save）', () => {
  it('A1 映射表不存在时 loadIdMap 返回 null（而不是空表）', async () => {
    installElectronMock()
    const map = await loadIdMap()
    expect(map).toBeNull()
  })

  it('A2 saveIdMap → loadIdMap 往返，byPath / byId 两个方向都保住', async () => {
    const state = installElectronMock()
    const saved = sampleMap()
    expect(await saveIdMap(saved)).toBe(true)
    expect(state.saves).toHaveLength(1)

    const loaded = await loadIdMap()
    expect(loaded).not.toBeNull()
    expect(loaded.version).toBe(ID_MAP_VERSION)
    expect(loaded.byPath[WIN_PATH_A]).toBe('id-a')
    expect(loaded.byPath[WIN_PATH_B]).toBe('id-b')
    expect(loaded.byId['id-a']).toBe(WIN_PATH_A)
    expect(loaded.byId['id-b']).toBe(WIN_PATH_B)
  })

  it('A3 saveIdMap 原样透传调用方给的结构，不自作主张补字段', async () => {
    const state = installElectronMock()
    const map = sampleMap()
    map.updatedAt = 0
    await saveIdMap(map)
    const payload = state.saves[0]
    expect(payload.version).toBe(ID_MAP_VERSION)
    expect(Object.keys(payload.byPath).sort()).toEqual([WIN_PATH_B, WIN_PATH_A].sort())
    // 纯内核不读时钟，updatedAt 恒为 0；由谁写盘谁盖时间戳 -> 渲染侧侧放行原值
    expect(payload.updatedAt).toBe(0)
  })

  it('A4 load 回来的一定是归一化过的表（byId 缺失时由 byPath 反推）', async () => {
    installElectronMock({
      store: { raw: JSON.stringify({ version: 1, byPath: { 'C:\\x.md': 'idx' }, updatedAt: 5 }) }
    })
    const map = await loadIdMap()
    expect(map.byPath['C:\\x.md']).toBe('idx')
    expect(map.byId.idx).toBe('C:\\x.md')
  })

  it('A5 主进程报 ok:false 时 loadIdMap 返回 null 并留一条 warn（不静默）', async () => {
    installElectronMock({
      loadImpl: () => ({ ok: false, data: null, error: 'read-failed', errno: 'EACCES' })
    })
    const map = await loadIdMap()
    expect(map).toBeNull()
    const logs = ipcLogs().filter(e => e.lvl === 'warn')
    expect(logs).toHaveLength(1)
    expect(logs[0].msg).toContain('读取 id 映射表失败')
  })

  it('A6 主进程保存失败时 saveIdMap 返回 false 并留一条 error', async () => {
    installElectronMock({ saveImpl: () => ({ ok: false, error: 'ENOSPC', errno: 'ENOSPC' }) })
    expect(await saveIdMap(sampleMap())).toBe(false)
    const logs = ipcLogs().filter(e => e.lvl === 'error')
    expect(logs).toHaveLength(1)
    expect(logs[0].msg).toContain('保存 id 映射表失败')
  })

  it('A7 load 通道抛异常时不炸而是降级到 localStorage，并记一条 warn', async () => {
    localStorage.setItem(LS_KEYS.idMap, JSON.stringify(sampleMap()))
    installElectronMock({ loadImpl: () => { throw new Error('channel gone') } })

    const map = await loadIdMap()
    expect(map).not.toBeNull()
    expect(map.byPath[WIN_PATH_A]).toBe('id-a')
    expect(ipcLogs().some(e => e.lvl === 'warn' && e.msg.includes('idmap:load'))).toBe(true)
  })

  it('A8 老 preload（electronAPI 存在但没有 idmap 组）自动降级，不为 undefined 炸掉', async () => {
    window.electronAPI = { getVersion: () => '1.0.0' }
    expect(await saveIdMap(sampleMap())).toBe(true)
    expect(localStorage.getItem(LS_KEYS.idMap)).toBeTruthy()
    const map = await loadIdMap()
    expect(map.byPath[WIN_PATH_A]).toBe('id-a')
  })

  it('A9 端到端语义：文件移动后 id 不变（R-F1 的主场景）', async () => {
    const state = installElectronMock()
    const movedTo = 'C:\\notes\\renamed\\a.md'

    const map = rebuildIdMap([WIN_PATH_A, WIN_PATH_B])
    const idBefore = map.byPath[WIN_PATH_A]
    await saveIdMap(map)

    const reloaded = await loadIdMap()
    rebindPath(reloaded, WIN_PATH_A, movedTo)
    await saveIdMap(reloaded)

    const after = await loadIdMap()
    expect(after.byPath[movedTo]).toBe(idBefore)
    expect(after.byId[idBefore]).toBe(movedTo)
    expect(after.byPath[WIN_PATH_A]).toBeUndefined()
    expect(state.saves).toHaveLength(2)
  })

  it('A10 saveIdMap 拒绝非法结构，且不去打扰 IPC', async () => {
    const state = installElectronMock()
    expect(await saveIdMap(null)).toBe(false)
    expect(await saveIdMap(undefined)).toBe(false)
    expect(await saveIdMap({})).toBe(false)
    expect(await saveIdMap('{"byPath":{}}')).toBe(false)
    expect(state.saves).toHaveLength(0)
    expect(ipcLogs().some(e => e.msg.includes('拒绝保存非法的 id 映射表'))).toBe(true)
  })

  it('A11 saveIdMap 接受「只有 byPath」的表（byId 是派生的，可缺）', async () => {
    const state = installElectronMock()
    expect(await saveIdMap({ version: 1, byPath: { 'C:\\y.md': 'idy' } })).toBe(true)
    expect(state.saves).toHaveLength(1)
  })
})

// ===========================================================================
// B · 去抖与 flush
// ===========================================================================

describe('B · 去抖与退出前 flush', () => {
  it('B1 连续 5 次 scheduleSaveIdMap 只落盘一次', async () => {
    vi.useFakeTimers()
    const state = installElectronMock()
    const map = sampleMap()
    for (let i = 0; i < 5; i += 1) {
      expect(scheduleSaveIdMap(map)).toBe(true)
    }
    expect(state.saves).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(ID_MAP_SAVE_DEBOUNCE_MS)
    expect(state.saves).toHaveLength(1)
  })

  it('B2 窗口未到（799ms）不写，跨过窗口才写', async () => {
    vi.useFakeTimers()
    const state = installElectronMock()
    scheduleSaveIdMap(sampleMap())
    await vi.advanceTimersByTimeAsync(ID_MAP_SAVE_DEBOUNCE_MS - 1)
    expect(state.saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(state.saves).toHaveLength(1)
  })

  it('B3 窗口内多次调用，最终写的是最后一次传进来的表', async () => {
    vi.useFakeTimers()
    const state = installElectronMock()
    const first = sampleMap()
    const second = createIdMap()
    bindPath(second, 'id-c', 'C:\\c.md')

    scheduleSaveIdMap(first)
    scheduleSaveIdMap(second)
    await vi.advanceTimersByTimeAsync(ID_MAP_SAVE_DEBOUNCE_MS)

    expect(state.saves).toHaveLength(1)
    expect(state.saves[0]).toBe(second)
    expect(state.saves[0].byPath['C:\\c.md']).toBe('id-c')
  })

  it('B4 去抖窗口之后再排一次，会各自独立落盘', async () => {
    vi.useFakeTimers()
    const state = installElectronMock()
    scheduleSaveIdMap(sampleMap())
    await vi.advanceTimersByTimeAsync(ID_MAP_SAVE_DEBOUNCE_MS)
    scheduleSaveIdMap(sampleMap())
    await vi.advanceTimersByTimeAsync(ID_MAP_SAVE_DEBOUNCE_MS)
    expect(state.saves).toHaveLength(2)
  })

  it('B5 flushIdMapSave 在没有待写内容时返回 true 且不触发写', async () => {
    const state = installElectronMock()
    expect(await flushIdMapSave()).toBe(true)
    expect(state.saves).toHaveLength(0)
  })

  it('B6 flushIdMapSave 立刻写掉待写内容并清掉定时器', async () => {
    vi.useFakeTimers()
    const state = installElectronMock()
    scheduleSaveIdMap(sampleMap())
    expect(state.saves).toHaveLength(0)

    expect(await flushIdMapSave()).toBe(true)
    expect(state.saves).toHaveLength(1)

    // 定时器已被清掉：再推进时间不应产生第二次写
    await vi.advanceTimersByTimeAsync(ID_MAP_SAVE_DEBOUNCE_MS * 2)
    expect(state.saves).toHaveLength(1)
  })

  it('B7 cancelPendingIdMapSave 之后的 flush 什么都不写', async () => {
    vi.useFakeTimers()
    const state = installElectronMock()
    scheduleSaveIdMap(sampleMap())
    expect(cancelPendingIdMapSave()).toBe(true)
    expect(await flushIdMapSave()).toBe(true)
    expect(state.saves).toHaveLength(0)
  })

  it('B8 去抖失败（IPC 报错）时 flush 返回 false 并记 error，不抛出去', async () => {
    vi.useFakeTimers()
    const state = installElectronMock({ saveImpl: () => ({ ok: false, error: 'EIO', errno: 'EIO' }) })
    scheduleSaveIdMap(sampleMap())
    expect(await flushIdMapSave()).toBe(false)
    expect(state.saves).toHaveLength(1)
    expect(ipcLogs().some(e => e.lvl === 'error')).toBe(true)
  })

  it('B9 beforeunload 会触发 flush', async () => {
    const state = installElectronMock()
    const uninstall = installIdMapFlush()
    try {
      scheduleSaveIdMap(sampleMap())
      expect(state.saves).toHaveLength(0)
      window.dispatchEvent(new Event('beforeunload'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(state.saves).toHaveLength(1)
    } finally {
      uninstall()
    }
  })

  it('B10 pagehide 同样会触发 flush（覆盖 beforeunload 不到的场景）', async () => {
    const state = installElectronMock()
    const uninstall = installIdMapFlush()
    try {
      scheduleSaveIdMap(sampleMap())
      window.dispatchEvent(new Event('pagehide'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(state.saves).toHaveLength(1)
    } finally {
      uninstall()
    }
  })

  it('B11 重复 install 不会叠加监听器（一次事件只写一次）', async () => {
    const state = installElectronMock()
    const uninstall1 = installIdMapFlush()
    const uninstall2 = installIdMapFlush()
    try {
      scheduleSaveIdMap(sampleMap())
      window.dispatchEvent(new Event('beforeunload'))
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(state.saves).toHaveLength(1)
      expect(uninstall1).toBe(uninstall2)
    } finally {
      uninstall1()
    }
  })

  it('B12 uninstall 之后事件不再触发写（幂等卸载）', async () => {
    const state = installElectronMock()
    const uninstall = installIdMapFlush()
    uninstall()
    uninstall() // 再卸一次也不该报错
    scheduleSaveIdMap(sampleMap())
    window.dispatchEvent(new Event('beforeunload'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.saves).toHaveLength(0)
  })

  it('B13 去抖窗口常量是 800ms（单测与文档共用同一份，不抄数字）', () => {
    expect(ID_MAP_SAVE_DEBOUNCE_MS).toBe(800)
  })

  it('B14 scheduleSaveIdMap 拒绝非法结构，返回 false 且不排队列', async () => {
    vi.useFakeTimers()
    const state = installElectronMock()
    expect(scheduleSaveIdMap(null)).toBe(false)
    expect(scheduleSaveIdMap({ byPath: 'nope' })).toBe(false)
    await vi.advanceTimersByTimeAsync(ID_MAP_SAVE_DEBOUNCE_MS)
    expect(state.saves).toHaveLength(0)
  })
})

// ===========================================================================
// C · 浏览器降级（localStorage）
// ===========================================================================

describe('C · 无 electronAPI 时降级到 localStorage', () => {
  it('C1 走降级写时落的是 LS_KEYS.idMap 这个键', async () => {
    expect(await saveIdMap(sampleMap())).toBe(true)
    expect(localStorage.getItem(LS_KEYS.idMap)).toBeTruthy()
    expect(localStorage.getItem('note-id-map')).toBeNull()
  })

  it('C2 降级路径往返一致', async () => {
    await saveIdMap(sampleMap())
    const map = await loadIdMap()
    expect(map.byPath[WIN_PATH_A]).toBe('id-a')
    expect(map.byId['id-b']).toBe(WIN_PATH_B)
    expect(map.version).toBe(ID_MAP_VERSION)
  })

  it('C3 键不存在时返回 null', async () => {
    expect(await loadIdMap()).toBeNull()
  })

  it('C4 存的是空字符串也算没有（返回 null）', async () => {
    localStorage.setItem(LS_KEYS.idMap, '')
    expect(await loadIdMap()).toBeNull()
  })

  it('C5 JSON 损坏时返回 null 并记 warn（不是静默吞掉）', async () => {
    localStorage.setItem(LS_KEYS.idMap, '{"version":1,"byPath":{oops')
    expect(await loadIdMap()).toBeNull()
    const logs = ipcLogs().filter(e => e.lvl === 'warn')
    expect(logs).toHaveLength(1)
    expect(logs[0].msg).toContain('本地 id 映射表损坏')
  })

  it('C6 setItem 抛异常（配额 / 隐私模式）时返回 false 并记 error', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      expect(await saveIdMap(sampleMap())).toBe(false)
    } finally {
      spy.mockRestore()
    }
    const logs = ipcLogs().filter(e => e.lvl === 'error')
    expect(logs).toHaveLength(1)
    expect(logs[0].msg).toContain('写入本地 id 映射表失败')
  })

  it('C7 getItem 抛异常时返回 null 并记 warn', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    try {
      expect(await loadIdMap()).toBeNull()
    } finally {
      spy.mockRestore()
    }
    expect(ipcLogs().some(e => e.lvl === 'warn' && e.msg.includes('读取本地 id 映射表失败'))).toBe(true)
  })

  it('C8 版本比内核新时不猜（拿到空表而不是 null，由上层决定重建）', async () => {
    localStorage.setItem(LS_KEYS.idMap, JSON.stringify({
      version: ID_MAP_VERSION + 1,
      byPath: { 'C:\\future.md': 'idf' },
      byId: { idf: 'C:\\future.md' },
      updatedAt: 9
    }))
    const map = await loadIdMap()
    expect(map).not.toBeNull()
    expect(Object.keys(map.byPath)).toHaveLength(0)
  })

  it('C9 Electron 可用时**不会**顺手再写一份 localStorage（真相源只有一个）', async () => {
    const state = installElectronMock()
    await saveIdMap(sampleMap())
    expect(state.saves).toHaveLength(1)
    expect(localStorage.getItem(LS_KEYS.idMap)).toBeNull()
  })
})

// ===========================================================================
// D · 绝不写用户的 .md
// ===========================================================================

describe('D · 映射表流程绝不触碰用户的 .md（字节级）', () => {
  /** 在真临时目录里铺 3 篇笔记，返回 { dir, files: [{path, bytes}] } */
  async function seedNotes () {
    const dir = await makeTempDir('notes')
    tempDirs.push(dir)
    const files = [
      { rel: 'a.md', body: '# 标题 A\r\n\r\n内容 with emoji \u{1F600}\r\n' },
      { rel: 'b.md', body: '---\r\ntitle: B\r\ncreated: 2024-01-01\r\n---\r\n\r\n正文 B\r\n' },
      { rel: nodePath.join('sub', 'c.md'), body: '二进制尾巴：\u0001\u0002\u00FF end\r\n' }
    ]
    const out = []
    await fsp.mkdir(nodePath.join(dir, 'sub'), { recursive: true })
    for (const f of files) {
      const full = nodePath.join(dir, f.rel)
      await fsp.writeFile(full, f.body, 'utf-8')
      out.push({ path: full, bytes: await fsp.readFile(full) })
    }
    return { dir, files: out }
  }

  /** 断言 .md 内容与「目录里不多不少」都与流程开始前一致 */
  async function expectUntouched (dir, files) {
    for (const f of files) {
      const now = await fsp.readFile(f.path)
      expect(Buffer.compare(now, f.bytes)).toBe(0)
    }
    const listed = []
    const walk = async (current) => {
      for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
        const full = nodePath.join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else listed.push(full)
      }
    }
    await walk(dir)
    expect(listed.sort()).toEqual(files.map(f => f.path).sort())
  }

  it('D1 完整流程（rebuild → save → load）跑完，3 篇 .md 逐字节不变、目录无新增文件', async () => {
    const { dir, files } = await seedNotes()
    const paths = files.map(f => f.path)

    const map = rebuildIdMap(paths)
    expect(await saveIdMap(map)).toBe(true)
    const loaded = await loadIdMap()
    expect(Object.keys(loaded.byPath).sort()).toEqual(paths.slice().sort())

    await expectUntouched(dir, files)
  })

  it('D2 外部移动 + rebindPath + 落盘后，.md 内容不变且 id 跟着文本走', async () => {
    const { dir, files } = await seedNotes()
    const oldPath = files[0].path
    const newPath = nodePath.join(dir, 'sub', 'a-moved.md')
    const originOld = await fsp.readFile(oldPath)

    const map = rebuildIdMap(files.map(f => f.path))
    const idBefore = map.byPath[oldPath]
    expect(idBefore).toBe(pathHashId(oldPath))

    // 模拟「外部把文件搬走了」——真在磁盘上改名，随后流程必须承认这个新路径
    await fsp.rename(oldPath, newPath)
    await fsp.writeFile(newPath, originOld, 'utf-8')

    const persisted = await loadIdMap()
    const base = persisted || map
    rebindPath(base, oldPath, newPath)
    expect(await saveIdMap(base)).toBe(true)

    const after = await loadIdMap()
    expect(after.byPath[newPath]).toBe(idBefore)
    expect(after.byId[idBefore]).toBe(newPath)

    const moved = await fsp.readFile(newPath)
    expect(Buffer.compare(moved, originOld)).toBe(0)

    // 把文件放回原位，D 组的通用断言才对得上
    await fsp.rename(newPath, oldPath)
    await expectUntouched(dir, files)
  })

  it('D3 反复 save / load 10 轮，笔记录入 Effects zero（内容不变、无影子文件）', async () => {
    const { dir, files } = await seedNotes()
    const paths = files.map(f => f.path)
    let map = rebuildIdMap(paths)

    for (let i = 0; i < 10; i += 1) {
      expect(await saveIdMap(map)).toBe(true)
      map = await loadIdMap()
      expect(Object.keys(map.byPath)).toHaveLength(3)
    }
    await expectUntouched(dir, files)
  })

  it('D4 映射表不会被写进笔记目录（笔记目录里只有原始的 .md）', async () => {
    const { dir, files } = await seedNotes()
    const state = installElectronMock()
    await saveIdMap(rebuildIdMap(files.map(f => f.path)))

    // Electron 路径下 IO 由主进程完成：这里能确认的是「没有往笔记目录写任何东西」
    expect(state.saves).toHaveLength(1)
    const all = await fsp.readdir(dir, { withFileTypes: true })
    const names = all.map(e => e.name).sort()
    expect(names).toEqual(['a.md', 'b.md', 'sub'])
    expect(names.some(n => n.includes('id-map') || n.includes('.json'))).toBe(false)
  })
})

// ===========================================================================
// E · 真实 electron/main.cjs（子进程 + 桩宿主）
// ===========================================================================

/**
 * 子进程里跑的桩脚本。
 *
 * 为什么不直接在 vitest 里 require main.cjs：它第一行就 `require('electron')`，
 * 而下 Preload / ipcMain 这些只有真 Electron 进程才有。这里把**宿主**替换掉、
 * 业务代码用磁盘上的真实文件，于是「主进程实现被改坏 → 用例变红」成立。
 *
 * 结果通过文件而不是 stdout 回传：Node 在 process.exit 时管道里的 stdout 可能被
 * 截断，写文件没有这个问题。
 */
const MAIN_HARNESS = [
  "const Module = require('module')",
  "const fs = require('fs')",
  "const fsp = require('fs/promises')",
  "const nodePath = require('path')",
  "const nodeOs = require('os')",
  // 主进程 whenReady 链上的任何异常都与本轮要验的通道无关，别让它把子进程带崩
  "process.on('unhandledRejection', () => {})",
  "const userData = process.env.T16_USER_DATA",
  "const scenario = process.env.T16_SCENARIO",
  "const extra = JSON.parse(process.env.T16_EXTRA_JSON || '{}')",
  "const resultPath = process.env.T16_RESULT",
  "const mainPath = process.env.T16_MAIN",
  // ---- fs 探针：证明原子写确实是「先写 tmp 再 rename」而不是直写目标文件
  "const ops = []",
  "const rawWriteFile = fsp.writeFile",
  "const rawRename = fsp.rename",
  "fsp.writeFile = async function (target, data, opt) { ops.push({ op: 'write', target: String(target) }); return rawWriteFile.call(fsp, target, data, opt) }",
  "fsp.rename = async function (a, b) { ops.push({ op: 'rename', from: String(a), to: String(b) }); return rawRename.call(fsp, a, b) }",
  "const noop = function () {}",
  "const autoStub = function (overrides) {",
  "  const target = overrides || {}",
  "  return new Proxy(target, {",
  "    get: function (t, key) {",
  "      if (key in t) return t[key]",
  "      if (typeof key === 'symbol') return undefined",
  "      return noop",
  "    },",
  "    set: function (t, key, value) { t[key] = value; return true }",
  "  })",
  "}",
  "const handlers = new Map()",
  "const webContents = autoStub({ send: noop, openDevTools: noop, on: noop, once: noop, setWindowOpenHandler: noop })",
  "const winStub = autoStub({",
  "  loadURL: noop, loadFile: noop, on: noop, once: noop, show: noop, focus: noop, restore: noop,",
  "  isDestroyed: function () { return false }, isMinimized: function () { return false },",
  "  webContents: webContents",
  "})",
  "function BrowserWindow () { return winStub }",
  "BrowserWindow.getAllWindows = function () { return [] }",
  "const app = {",
  "  isPackaged: false,",
  "  getPath: function (name) { return name === 'userData' ? userData : nodeOs.tmpdir() },",
  "  getName: function () { return 'choyeon-note' },",
  "  getVersion: function () { return '0.0.0-test' },",
  "  getLocale: function () { return 'zh-CN' },",
  "  on: noop, off: noop, quit: noop, exit: noop, focus: noop,",
  "  whenReady: function () { return Promise.resolve() },",
  "  requestSingleInstanceLock: function () { return true },",
  "  setAboutPanelOptions: noop, showAboutPanel: noop, setAppUserModelId: noop",
  "}",
  "const ipcMain = { handle: function (channel, fn) { handlers.set(channel, fn) }, on: noop, removeHandler: noop }",
  "const Menu = { buildFromTemplate: function () { return autoStub() }, setApplicationMenu: noop, getApplicationMenu: function () { return null } }",
  "const dialog = { showSaveDialog: async function () { return { canceled: true } }, showOpenDialog: async function () { return { canceled: true } }, showMessageBox: async function () { return { response: 0 } } }",
  "const net = { request: function () { return autoStub({ end: noop, write: noop }) } }",
  "const shell = { trashItem: async function () { return true }, openExternal: noop, openPath: noop, showItemInFolder: noop, beep: noop }",
  "const safeStorage = { isEncryptionAvailable: function () { return false }, encryptString: function (s) { return Buffer.from(String(s)) }, decryptString: function (b) { return String(b) } }",
  "const electronStub = { app: app, BrowserWindow: BrowserWindow, Menu: Menu, ipcMain: ipcMain, dialog: dialog, net: net, shell: shell, safeStorage: safeStorage, screen: autoStub(), nativeTheme: autoStub(), clipboard: autoStub() }",
  "const updaterStub = { autoUpdater: autoStub({ checkForUpdates: async function () { return null }, downloadUpdate: async function () { return [] }, quitAndInstall: noop }) }",
  "const realLoad = Module._load",
  "Module._load = function (request) {",
  "  if (request === 'electron') return electronStub",
  "  if (request === 'electron-updater') return updaterStub",
  "  return realLoad.apply(this, arguments)",
  "}",
  "require(mainPath)",
  "async function run () {",
  "  const out = { channels: Array.from(handlers.keys()).filter(function (c) { return c.indexOf('idmap:') === 0 }) }",
  "  const load = handlers.get('idmap:load')",
  "  const save = handlers.get('idmap:save')",
  "  if (scenario === 'missing') {",
  "    out.res = await load(null)",
  "  } else if (scenario === 'roundtrip') {",
  "    out.saveRes = await save(null, extra.map)",
  "    out.raw = fs.readFileSync(nodePath.join(userData, 'note-id-map.json'), 'utf-8')",
  "    out.res = await load(null)",
  "    out.entries = fs.readdirSync(userData).filter(function (n) { return n.indexOf('note-id-map') === 0 })",
  "    out.ops = ops.filter(function (o) { return String(o.target || o.to || '').indexOf('note-id-map') >= 0 })",
  "  } else if (scenario === 'overwrite') {",
  "    await save(null, extra.map)",
  "    await save(null, extra.map2)",
  "    out.res = await load(null)",
  "    out.entries = fs.readdirSync(userData).filter(function (n) { return n.indexOf('note-id-map') === 0 })",
  "    out.ops = ops.filter(function (o) { return String(o.target || o.to || '').indexOf('note-id-map') >= 0 })",
  "  } else if (scenario === 'corrupt') {",
  "    fs.writeFileSync(nodePath.join(userData, 'note-id-map.json'), extra.raw)",
  "    out.res = await load(null)",
  "  } else if (scenario === 'shape') {",
  "    out.res = await save(null, extra.payload)",
  "    out.entries = fs.readdirSync(userData).filter(function (n) { return n.indexOf('note-id-map') === 0 })",
  "  } else if (scenario === 'readonly-dir') {",
  "    out.res = await save(null, extra.map)",
  "  } else {",
  "    throw new Error('unknown scenario: ' + scenario)",
  "  }",
  "  return out",
  "}",
  // 退出前必须留一个 tick，且**先等再读再写结果**：
  //   ① 主进程 logger 的落盘是 fire-and-forget（记日志不能阻塞业务），直接
  //      process.exit(0) 会把最后这一行截断在半路上；
  //   ② 因此 main.log 必须在等待之后才读 —— 在 run() 里读会读到空文件；
  //   ③ 结果文件最后写，这样带回的 logText 才是等完之后的样子。
  // 主进程恢复统一 logger（T09）后，warn/error 落在 userData/logs/main.log 而不是 console。
  "run().then(async function (out) {",
  "  await new Promise(function (r) { setTimeout(r, 80) })",
  "  try { out.logText = fs.readFileSync(nodePath.join(userData, 'logs', 'main.log'), 'utf-8') }",
  "  catch (e) { out.logText = '' }",
  "  fs.writeFileSync(resultPath, JSON.stringify({ ok: true, out: out }))",
  "  process.exit(0)",
  "}).catch(function (e) {",
  "  fs.writeFileSync(resultPath, JSON.stringify({ ok: false, fatal: String((e && e.stack) || e) }))",
  "  process.exit(1)",
  "})"
].join('\n')

/**
 * 在子进程里驱动真实的 electron/main.cjs。
 *
 * 用**异步** execFile 而不是 spawnSync：Node 在 Windows 上对 synchronize spawn 有
 * EBUSY 限制（libuv 同一时刻只允许一个同步 spawn，vitest 的 worker 线程里必踩），
 * 表现为 status=null / signal=null 且拿不到任何子进程输出。异步版本没有这个限制。
 *
 * @param {string} scenario 场景名
 * @param {object} extra 场景入参
 * @param {string} [userData] userData 目录（缺省用临时目录）
 * @returns {Promise<{out: object, stderr: string, result: object}>}
 */
async function runMainScenario (scenario, extra, userData) {
  const dir = userData || fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'choyeon-t16-ud-'))
  tempDirs.push(dir)
  const resultPath = nodePath.join(dir, 'harness-result.json')
  const env = {
    ...process.env,
    T16_USER_DATA: dir,
    T16_SCENARIO: scenario,
    T16_EXTRA_JSON: JSON.stringify(extra || {}),
    T16_RESULT: resultPath,
    T16_MAIN: nodePath.join(PROJECT_ROOT, 'electron', 'main.cjs')
  }

  let stderr = ''
  let spawnError = null
  try {
    const spawned = await execFileAsync(process.execPath, ['-e', MAIN_HARNESS], {
      cwd: PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024
    })
    stderr = String(spawned.stderr || '')
  } catch (error) {
    // 子进程以非 0 退出时会走到这里，但结果文件可能已经写好（结果优先，退出码是次位信息）
    spawnError = error
    stderr = String((error && error.stderr) || '')
  }

  if (!fs.existsSync(resultPath)) {
    throw new Error(
      `主进程桩没有产出结果文件：${spawnError ? (spawnError.stack || spawnError.message) : '未知原因'}\n` +
      `stderr: ${stderr.slice(0, 2000)}`
    )
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
  if (!result.ok) throw new Error(`主进程桩内部失败：${result.fatal}`)
  return { out: result.out, stderr, result }
}

describe('E · 真实 electron/main.cjs 通道（宿主打桩，业务代码不打桩）', () => {
  it('E1 idmap:load / idmap:save 两个通道确实注册了', async () => {
    const { out } = await runMainScenario('missing')
    expect(out.channels.sort()).toEqual(['idmap:load', 'idmap:save'])
  })

  it('E2 文件不存在时返回 { ok:true, data:null }，不抛也不报错五级', async () => {
    const { out } = await runMainScenario('missing')
    expect(out.res).toEqual({ ok: true, data: null })
  })

  it('E3 保存后 userData 下出现 note-id-map.json，内容就是映射表 + 时间戳', async () => {
    const map = sampleMap()
    const { out } = await runMainScenario('roundtrip', { map })

    expect(out.saveRes).toEqual({ ok: true })
    const parsed = JSON.parse(out.raw)
    expect(parsed.version).toBe(ID_MAP_VERSION)
    expect(parsed.byPath[WIN_PATH_A]).toBe('id-a')
    expect(parsed.byPath[WIN_PATH_B]).toBe('id-b')
    // updatedAt 由写盘的这一方盖上（纯内核不读时钟）
    expect(typeof parsed.updatedAt).toBe('number')
    expect(parsed.updatedAt).toBeGreaterThan(0)
  })

  it('E4 真实落盘确确实实是原子写：先写 .tmp，再 rename 到目标文件', async () => {
    const { out } = await runMainScenario('roundtrip', { map: sampleMap() })
    const writes = out.ops.filter(o => o.op === 'write')
    const renames = out.ops.filter(o => o.op === 'rename')

    expect(writes).toHaveLength(1)
    expect(writes[0].target.endsWith('note-id-map.json.tmp')).toBe(true)
    expect(renames).toHaveLength(1)
    expect(renames[0].from.endsWith('note-id-map.json.tmp')).toBe(true)
    expect(renames[0].to.endsWith('note-id-map.json')).toBe(true)
    // 没有任何一次是直接写目标文件的 —— 那就是「非原子写」的形状
    expect(writes.some(w => w.target.endsWith('note-id-map.json'))).toBe(false)
  })

  it('E5 写完后 .tmp 不留残留，目录里只有最终的 note-id-map.json', async () => {
    const { out } = await runMainScenario('roundtrip', { map: sampleMap() })
    expect(out.entries).toEqual(['note-id-map.json'])
  })

  it('E6 第二次写也走 tmp+rename 并且覆盖成功（只剩一个文件）', async () => {
    const { out } = await runMainScenario('overwrite', {
      map: sampleMap(),
      map2: (() => {
        const m = createIdMap()
        bindPath(m, 'id-z', 'C:\\z.md')
        return m
      })()
    })
    expect(out.res.ok).toBe(true)
    expect(out.res.data.byPath['C:\\z.md']).toBe('id-z')
    expect(out.res.data.byPath[WIN_PATH_A]).toBeUndefined()
    expect(out.entries).toEqual(['note-id-map.json'])
    expect(out.ops.filter(o => o.op === 'write')).toHaveLength(2)
    expect(out.ops.filter(o => o.op === 'rename')).toHaveLength(2)
  })

  it('E7 JSON 损坏时返回 { ok:false, data:null } 并写一行 warn（不抛）', async () => {
    const { out } = await runMainScenario('corrupt', { raw: '{"version":1,"byPath":{' })
    expect(out.res.ok).toBe(false)
    expect(out.res.data).toBeNull()
    expect(typeof out.res.error).toBe('string')
    expect(out.res.error.length).toBeGreaterThan(0)
    // 「记一行 warn」的落点：主进程的统一 logger（T09 恢复后），即 userData/logs/main.log。
    // 之前断言 stderr 是因为 idmap 通道在 logger 被误还原期间用过临时 console 出口；
    // logger 修回来之后，warn 就该在文件里 —— 断言文件比断言控制台更贴近真实语义。
    expect(out.logText).toContain('读取 id 映射表失败')
    expect(out.logText).toContain('[ipc]')
  })

  it('E8 形状非法的 payload 直接拒收（不写出半张表）', async () => {
    const { out } = await runMainScenario('shape', { payload: { version: 1 } })
    expect(out.res).toEqual({ ok: false, error: 'shape-invalid', errno: '' })
    expect(out.entries).toEqual([])
  })

  it('E9 拒收数组等非对象 payload', async () => {
    const r1 = await runMainScenario('shape', { payload: [] })
    expect(r1.out.res.ok).toBe(false)
    const r2 = await runMainScenario('shape', { payload: null })
    expect(r2.out.res.ok).toBe(false)
  })

  it('E10 真实 .md 全程不被读改写：主进程读写的同时笔记文件字节不变', async () => {
    const notesDir = await makeTempDir('mdbytes')
    const mdPath = nodePath.join(notesDir, 'real.md')
    const body = '# 真实笔记\r\n\r\n\t带制表符与 emoji \u{1F680}\r\n---\r\n结尾\r\n'
    await fsp.writeFile(mdPath, body, 'utf-8')
    const before = await fsp.readFile(mdPath)
    const beforeStat = await fsp.stat(mdPath)

    const map = rebuildIdMap([mdPath])
    const { out } = await runMainScenario('roundtrip', { map })
    expect(out.res.ok).toBe(true)
    expect(out.res.data.byPath[mdPath]).toBe(pathHashId(mdPath))

    const after = await fsp.readFile(mdPath)
    expect(Buffer.compare(after, before)).toBe(0)
    const afterStat = await fsp.stat(mdPath)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
    expect((await fsp.readdir(notesDir)).sort()).toEqual(['real.md'])
  })

  it('E11 渲染层 loadIdMap 能吃下真实主进程写出来的那份文件', async () => {
    const map = sampleMap()
    const { out } = await runMainScenario('roundtrip', { map })
    const parsed = parseIdMap(JSON.parse(out.raw))
    expect(parsed.byPath[WIN_PATH_A]).toBe('id-a')
    expect(parsed.byId['id-b']).toBe(WIN_PATH_B)
    expect(parsed.version).toBe(ID_MAP_VERSION)
  })

  it('E12 preload 与主进程的通道名逐一对得上（打错字只会静默失效）', () => {
    const preloadSrc = fs.readFileSync(nodePath.join(PROJECT_ROOT, 'electron', 'preload.cjs'), 'utf-8')
    const mainSrc = fs.readFileSync(nodePath.join(PROJECT_ROOT, 'electron', 'main.cjs'), 'utf-8')
    const storeSrc = fs.readFileSync(nodePath.join(PROJECT_ROOT, 'src', 'utils', 'idMapStore.js'), 'utf-8')

    const invoked = new Set([...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]))
    const handled = new Set([...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]))

    // 本任务新增的两个通道，两边都得有
    expect(invoked.has('idmap:load')).toBe(true)
    expect(invoked.has('idmap:save')).toBe(true)
    expect(handled.has('idmap:load')).toBe(true)
    expect(handled.has('idmap:save')).toBe(true)
    // 反过来：preload 暴露的每一个通道都得有主进程实现，否则调用只会 reject。
    // 用集合差而不是逐条 expect —— 失败时能直接打出「缺哪几个通道」，而不是
    // 「expected false to be true」这种没法排障的话。
    const missing = [...invoked].filter(c => !handled.has(c))
    expect(missing).toEqual([])
    // preload 暴露的键名与渲染侧调用的名字也必须一致
    expect(preloadSrc).toContain('idmap: {')
    expect(storeSrc).toContain('idmap.load')
    expect(storeSrc).toContain('idmap.save')
  })
})
