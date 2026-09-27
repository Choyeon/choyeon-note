// ===========================================================================
// T19 · note.js 接入稳定 id（R-F1）+ 日期归属迁移（R-C1 / 裁决 2）
//
// 这个文件回答五个问题（每条都对应一个用户可感知的痛点）：
//   1. 老用户的 id 一个都没变（首次载入仍走路径哈希，黄金值钉死）；
//   2. 移动 / 重命名之后 id **不变**（书签 / 最近打开 / 图谱 / 当前笔记不丢）；
//   3. 映射表丢了也能从磁盘路径重建出同一批 id（绝不写用户的 .md 能成立的前提）；
//   4. 删除会解绑：同名文件重建时不再接回已删笔记的 id；
//   5. 日期迁移后日历**不漂移**，且 ④ 级（updatedAt）一个字节都没被写死。
//
// 为什么用**真 Pinia store**（与 tests/noteFileOps.test.js 同口径）：
//   手搓替身只能断言「某个方法被调用了」。这里要断言的是**磁盘 + 内存 + 映射表**
//   三者的真实一致性 —— 一旦有人把 resolveNoteId 改回 generateStableId，或者
//   移动成功之后忘了 rebindPath，用例必须直接变红，而不是悄悄放行。
//
// 为什么自己 mock `window.electronAPI`：
//   vite.config.js 只配了 `environment: 'jsdom'`，**没有 setup 文件**，所以每个
//   要用 IPC 的用例必须自行 mock 并在 afterEach 还原。
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNoteStore } from '../src/stores/note'
import { useAppStore } from '../src/stores/app'
import { LS_KEYS } from '../src/constants/storage'
import { pathHashId, parseIdMap } from '../src/utils/noteIdentity'
import { cancelPendingIdMapSave, flushIdMapSave } from '../src/utils/idMapStore'
import { dateKeyOf } from '../src/utils/noteIndex'
import { resolveNoteDate } from '../src/utils/dateAttribution'
import { getRingBuffer, resetLogger } from '../src/utils/logger.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 虚拟库根目录。刻意用正斜杠：note.js 的 buildFilePath 就是正斜杠硬拼 */
const ROOT = 'C:/notes'

/** 固定时钟：所有「现在」相关的判断都用它，保证同一份库永远得到同一份结果 */
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

/** 默认 mtime（④ 级日期来源） */
const DEFAULT_MTIME = new Date('2024-01-02T03:04:05.000Z')
/** 默认 ctime（note.createdAt；按裁决 1，它**不参与**日期归属） */
const DEFAULT_CTIME = new Date('2020-05-06T07:08:09.000Z')

// ---------------------------------------------------------------------------
// 假磁盘
// ---------------------------------------------------------------------------

/**
 * 把文件路径登记进「目录列表」，让 readDirectory 与 files 保持一致。
 * @param {Map<string, Array<object>>} listed 目录列表
 * @param {string} absPath 绝对路径
 * @returns {void}
 */
function seedListed (listed, absPath) {
  const i = String(absPath).lastIndexOf('/')
  if (i < 0) return
  const dir = absPath.slice(0, i)
  const name = absPath.slice(i + 1)
  const list = listed.get(dir) || []
  if (!list.some(e => e.name === name)) list.push({ name })
  listed.set(dir, list)
}

/**
 * 建一套 `window.electronAPI` 替身（含 T16 的 idmap 通道，可按需装上）。
 * @returns {object} 假磁盘
 */
function createDisk () {
  /** 绝对路径 → 文件内容 */
  const files = new Map()
  /** 绝对路径 → { ctime, mtime } */
  const meta = new Map()
  /** 目录 → Array<{name}> */
  const listed = new Map()

  const disk = {
    files,
    meta,
    listed,
    /** idmap IPC 的调用记录（默认不装 idmap 通道 → 走 localStorage 降级） */
    idmap: { loads: 0, saves: [], enabled: false, loadResult: { ok: true, data: null } },

    /**
     * 预置一个文件（模拟磁盘上真实存在的笔记）。
     * @param {string} absPath 绝对路径
     * @param {string} content 内容
     * @param {object} [over] 覆盖 ctime / mtime
     * @returns {void}
     */
    seed (absPath, content, over = {}) {
      files.set(absPath, content)
      meta.set(absPath, {
        ctime: over.ctime || DEFAULT_CTIME,
        mtime: over.mtime || DEFAULT_MTIME
      })
      seedListed(listed, absPath)
    },

    // ---- 默认实现：全部成功 ----
    writeFileImpl: async (p, content) => {
      files.set(p, content)
      seedListed(listed, p)
      return true
    },
    /** 既能搬文件，也能搬目录（整棵子树） */
    moveFileImpl: async (from, to) => {
      if (files.has(from)) {
        const content = files.get(from)
        files.delete(from)
        files.set(to, content)
        meta.set(to, meta.get(from) || { ctime: DEFAULT_CTIME, mtime: DEFAULT_MTIME })
        meta.delete(from)
        seedListed(listed, to)
        return true
      }
      let moved = false
      for (const key of [...files.keys()]) {
        if (key === from || key.startsWith(from + '/')) {
          const rest = key.slice(from.length)
          files.set(to + rest, files.get(key))
          files.delete(key)
          meta.set(to + rest, meta.get(key) || { ctime: DEFAULT_CTIME, mtime: DEFAULT_MTIME })
          meta.delete(key)
          seedListed(listed, to + rest)
          moved = true
        }
      }
      return moved
    },
    fileExistsImpl: async (p) => files.has(p),
    readDirectoryImpl: async (dir) => listed.get(dir) || [],
    createDirectoryImpl: async () => true,
    deleteFileImpl: async (p) => {
      files.delete(p)
      meta.delete(p)
      return true
    },
    removeDirImpl: async (dir) => {
      for (const k of [...files.keys()]) {
        if (k === dir || k.startsWith(dir + '/')) {
          files.delete(k)
          meta.delete(k)
        }
      }
      return true
    },
    readFileImpl: async (p) => (files.has(p) ? files.get(p) : null),
    readDirectoryRecursiveImpl: async (dir) => {
      const base = String(dir).replace(/\/+$/, '')
      const out = []
      for (const [p] of files) {
        if (!p.startsWith(base + '/')) continue
        const relativePath = p.slice(base.length + 1)
        const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
        const m = meta.get(p) || {}
        out.push({
          path: p,
          name,
          relativePath,
          ctime: m.ctime || DEFAULT_CTIME,
          mtime: m.mtime || DEFAULT_MTIME
        })
      }
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    readFilesImpl: async ({ paths }) => ({
      files: paths.filter(p => files.has(p)).map(p => ({ path: p, content: files.get(p) })),
      errors: []
    }),
    setNotesPathImpl: async () => true
  }

  /**
   * 注入「写盘抛异常」。
   * @param {Error} error 要抛的异常
   * @returns {void}
   */
  disk.throwWriteAlways = (error) => {
    disk.writeFileImpl = async () => {
      throw error
    }
  }

  disk.api = {
    writeFile: vi.fn((p, content) => disk.writeFileImpl(p, content)),
    moveFile: vi.fn((from, to) => disk.moveFileImpl(from, to)),
    fileExists: vi.fn((p) => disk.fileExistsImpl(p)),
    readDirectory: vi.fn((dir) => disk.readDirectoryImpl(dir)),
    createDirectory: vi.fn((dir) => disk.createDirectoryImpl(dir)),
    deleteFile: vi.fn((p) => disk.deleteFileImpl(p)),
    removeDir: vi.fn((dir) => disk.removeDirImpl(dir)),
    readFile: vi.fn((p) => disk.readFileImpl(p)),
    readDirectoryRecursive: vi.fn((dir) => disk.readDirectoryRecursiveImpl(dir)),
    readFiles: vi.fn(({ paths }) => disk.readFilesImpl({ paths })),
    setNotesPath: vi.fn((p) => disk.setNotesPathImpl(p))
  }

  /**
   * 装上 Electron 侧的 idmap IPC 通道（默认不装 → 走 localStorage 降级）。
   * @param {object|null} data load 返回的数据
   * @returns {void}
   */
  disk.installIdmapIPC = (data = null) => {
    disk.idmap.enabled = true
    disk.idmap.loadResult = { ok: true, data }
    disk.api.idmap = {
      load: vi.fn(async () => {
        disk.idmap.loads += 1
        return disk.idmap.loadResult
      }),
      save: vi.fn(async (map) => {
        disk.idmap.saves.push(map)
        return { ok: true }
      })
    }
  }

  return disk
}

// ---------------------------------------------------------------------------
// 用例脚手架
// ---------------------------------------------------------------------------

let store
let appStore
let disk
let api
let errSpy
let warnSpy

/** 在磁盘上放一篇笔记（相对 ROOT 的路径） */
function put (relativePath, content, over = {}) {
  disk.seed(`${ROOT}/${relativePath}`, content, over)
  return `${ROOT}/${relativePath}`
}

/** 没有 frontmatter、标题也没有日期串的普通笔记正文（→ ④ 级 updatedAt） */
function plain (title, extra = '') {
  return `# ${title}\n\n正文一段${extra}。\n`
}

/** 带 frontmatter 日期的正文（→ ① 级） */
function withFmDate (title, iso) {
  return `---\ndate: ${iso}\n---\n\n# ${title}\n\n正文。\n`
}

/**
 * 按当前口径算一篇笔记的日期分组键。
 * @param {object} n 笔记
 * @returns {string} dateKey
 */
function dateKeyOfNote (n) {
  const r = resolveNoteDate(
    { content: n.content, title: n.title, updatedAt: n.updatedAt },
    { now: NOW }
  )
  return dateKeyOf(r.date)
}

/** 库里所有笔记的 id → dateKey 快照 */
function dateKeySnapshot () {
  const out = {}
  for (const n of store.notes) out[n.id] = dateKeyOfNote(n)
  return out
}

/** 库里所有笔记的 path → id 快照 */
function idSnapshot () {
  const out = {}
  for (const n of store.notes) out[n.filePath] = n.id
  return out
}

/** 已落盘的映射表（localStorage 里的那份） */
function persistedMap () {
  const raw = localStorage.getItem(LS_KEYS.idMap)
  return raw ? parseIdMap(raw) : null
}

beforeEach(async () => {
  setActivePinia(createPinia())
  localStorage.clear()
  // 默认**关掉**日期迁移：id 相关用例不该被迁移的写盘干扰。
  // 需要迁移的用例自己把它删掉（见「H · 日期迁移」组）。
  localStorage.setItem(LS_KEYS.dateMigration, '1710000000000')
  // 日志内核持有跨用例的模块级状态（级别 / 环形缓冲 / sink）
  resetLogger()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  disk = createDisk()
  api = disk.api
  window.electronAPI = api

  appStore = useAppStore()
  store = useNoteStore()
  // 空库载入一次：清掉示例笔记（它们 fileFolder 为 ''、filePath 为 null），
  // 同时把模块级 idMap 与派生索引重置到确定状态（真实载入路径，不碰私有变量）
  await store.loadNotesFromPath(ROOT)
})

afterEach(() => {
  // 去抖写盘是模块级状态，用例之间必须掐断，否则上一条的映射会写进下一条
  cancelPendingIdMapSave()
  errSpy.mockRestore()
  warnSpy.mockRestore()
  for (const toast of [...appStore.toasts]) appStore.dismissToast(toast.id)
  delete window.electronAPI
})

// ===========================================================================
// A · 首次载入：id 必须还是老算法算出来的那个（存量用户零漂移）
// ===========================================================================
describe('A · 首次载入的 id 仍然等于路径哈希（存量用户零漂移）', () => {
  it('A1 固定路径的黄金值：与老 generateStableId 逐字相同', async () => {
    // 这五个值由 tmp/t19-hash-parity.mjs 用「note.js 原样抄写」的
    // generateStableId 与 pathHashId 对跑 3015 例后取出（零差异）
    const goldens = [
      ['工作笔记/会议记录.md', 'vf9hyi'],
      ['项目文档/设计说明.md', 'jg0t0w'],
      ['日记/2026-03-15.md', 'xsp6e4'],
      ['README.md', '5tdi27'],
      ['vault/a/b/c.md', '74jrb4']
    ]
    for (const [rel, golden] of goldens) put(rel, plain('标题'))
    await store.loadNotesFromPath(ROOT)

    for (const [rel, golden] of goldens) {
      const path = `${ROOT}/${rel}`
      const note = store.notes.find(n => n.filePath === path)
      expect(note, `${path} 没被载入`).toBeTruthy()
      expect(note.id, `${path} 的 id 与老算法不一致`).toBe(golden)
    }
  })

  it('A2 全库逐条等于 pathHashId（含中文 / emoji / 深层目录）', async () => {
    const rels = [
      'a.md', 'b.markdown', 'c.txt',
      '中文目录/笔记 名.md',
      'deep/er/est/note.md',
      'emoji/🎉笔记.md',
      ' spaced /name.md',
      'UPPER/CASE.md'
    ]
    for (const rel of rels) put(rel, plain('T'))
    await store.loadNotesFromPath(ROOT)

    expect(store.notes).toHaveLength(rels.length)
    for (const n of store.notes) {
      expect(n.id).toBe(pathHashId(n.filePath))
    }
  })

  it('A3 载入后每一条路径都登记进了映射表（覆盖率 100%）', async () => {
    put('a.md', plain('A'))
    put('sub/b.md', plain('B'))
    await store.loadNotesFromPath(ROOT)

    const stats = store.getIdMapStats()
    expect(stats.total).toBe(2)
    expect(stats.bound).toBe(2)
    expect(stats.unbound).toEqual([])
    expect(stats.coverage).toBe(1)
    expect(stats.entries).toBe(2)
  })

  it('A4 载入 → flush → 重新载入，id 一个都不变（持久化往返）', async () => {
    put('a.md', plain('A'))
    put('sub/b.md', plain('B'))
    await store.loadNotesFromPath(ROOT)
    const before = idSnapshot()
    await flushIdMapSave()

    await store.loadNotesFromPath(ROOT)
    expect(idSnapshot()).toEqual(before)
    // 第二次载入走的是「映射表命中」分支，结论必须与兜底哈希一致
    for (const n of store.notes) expect(n.id).toBe(pathHashId(n.filePath))
  })

  it('A6 已有映射表时新出现的文件（外部新建 / 同步过来）会被登记进表', async () => {
    // 这是「未命中 → 哈希兜底 + 顺手登记」那一条分支的唯一真实场景：
    // 映射表里没有这条路径（文件是载入之后才出现的），解析时就必须把它补进去，
    // 否则它永远靠兜底哈希活着 —— 一旦被移动就会换 id。
    put('a.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    await flushIdMapSave()
    expect(persistedMap().byPath[`${ROOT}/a.md`]).toBeTruthy()

    put('newcomer.md', plain('New'))
    await store.loadNotesFromPath(ROOT)
    await flushIdMapSave()

    const stats = store.getIdMapStats()
    expect(stats.total).toBe(2)
    expect(stats.unbound).toEqual([])          // ★ 新来的那条也必须已登记
    expect(stats.coverage).toBe(1)
    expect(persistedMap().byPath[`${ROOT}/newcomer.md`]).toBe(pathHashId(`${ROOT}/newcomer.md`))
  })

  it('A5 空库载入不炸，映射表是空的（不是 null）', async () => {
    const r = await store.loadNotesFromPath(ROOT)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(0)
    const stats = store.getIdMapStats()
    expect(stats.total).toBe(0)
    expect(stats.coverage).toBe(1)
    expect(stats.entries).toBe(0)
  })
})

// ===========================================================================
// B · 移动 / 重命名之后 id 不变（R-F1 主场景）
// ===========================================================================
describe('B · 移动 / 重命名后 id 不变', () => {
  it('B1 移动笔记到别的文件夹 → id 不变，且磁盘上真的搬了', async () => {
    const path = put('src/A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const before = store.notes.find(n => n.filePath === path).id

    const r = await store.moveNote(before, 'dest')

    expect(r.ok).toBe(true)
    const moved = store.notes.find(n => n.id === before)
    expect(moved).toBeTruthy()
    expect(moved.id).toBe(before)
    expect(moved.filePath).toBe(`${ROOT}/dest/A.md`)
    expect(disk.files.has(`${ROOT}/dest/A.md`)).toBe(true)
    expect(disk.files.has(path)).toBe(false)
  })

  it('B2 移动之后重新载入（走持久化映射表）→ id 仍然是原来那个', async () => {
    const path = put('src/A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes.find(n => n.filePath === path).id

    await store.moveNote(id, 'dest')
    await flushIdMapSave()
    await store.loadNotesFromPath(ROOT)

    // 命中映射表：filePath 已经是新路径，id 却还是旧的那个（不再是新路径的哈希）
    const reloaded = store.notes.find(n => n.filePath === `${ROOT}/dest/A.md`)
    expect(reloaded).toBeTruthy()
    expect(reloaded.id).toBe(id)
    expect(reloaded.id).not.toBe(pathHashId(`${ROOT}/dest/A.md`))
  })

  it('B3 映射表里旧路径让位、新路径接手（不是留下一条悬空绑定）', async () => {
    const oldPath = put('src/A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes[0].id
    await store.moveNote(id, 'dest')
    await flushIdMapSave()

    const map = persistedMap()
    expect(map.byPath[`${ROOT}/dest/A.md`]).toBe(id)
    expect(Object.prototype.hasOwnProperty.call(map.byPath, oldPath)).toBe(false)
    expect(map.byId[id]).toBe(`${ROOT}/dest/A.md`)
  })

  it('B4 重命名 → id 不变', async () => {
    const path = put('A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes.find(n => n.filePath === path).id

    const r = await store.renameNote(id, 'B')

    expect(r.ok).toBe(true)
    const renamed = store.notes.find(n => n.id === id)
    expect(renamed.id).toBe(id)
    expect(renamed.title).toBe('B')
    expect(renamed.filePath).toBe(`${ROOT}/B.md`)
  })

  it('B5 重命名之后重新载入 → id 不变', async () => {
    put('A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes[0].id

    await store.renameNote(id, 'B')
    await flushIdMapSave()
    await store.loadNotesFromPath(ROOT)

    const reloaded = store.notes.find(n => n.filePath === `${ROOT}/B.md`)
    expect(reloaded.id).toBe(id)
    expect(reloaded.id).not.toBe(pathHashId(`${ROOT}/B.md`))
  })

  it('B6 连续移动两次 → id 仍然是最初那个（不是第二次的哈希）', async () => {
    put('a/A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes[0].id

    await store.moveNote(id, 'b')
    await store.moveNote(id, 'c')

    const note = store.notes.find(n => n.id === id)
    expect(note.filePath).toBe(`${ROOT}/c/A.md`)
    expect(note.id).toBe(id)
  })

  it('B7 移动 → 重命名 → 再移动：三次操作 id 全程不变', async () => {
    put('a/A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes[0].id

    await store.moveNote(id, 'b')
    await store.renameNote(id, 'Renamed')
    await store.moveNote(id, 'c')

    const note = store.notes.find(n => n.id === id)
    expect(note).toBeTruthy()
    expect(note.filePath).toBe(`${ROOT}/c/Renamed.md`)
    expect(note.id).toBe(id)
  })

  it('B8 文件夹改名 → 整棵子树的 id 都不变', async () => {
    put('work/a.md', plain('A'))
    put('work/sub/b.md', plain('B'))
    await store.loadNotesFromPath(ROOT)
    const before = idSnapshot()

    const ok = await store.renameFolder('work', '工作')

    expect(ok).toBe(true)
    const after = {}
    for (const n of store.notes) after[n.filePath] = n.id
    // 路径变了，id 一个都没变
    expect(Object.values(after).sort()).toEqual(Object.values(before).sort())
    expect(store.notes.some(n => n.filePath === `${ROOT}/工作/a.md`)).toBe(true)
    expect(store.notes.some(n => n.filePath === `${ROOT}/工作/sub/b.md`)).toBe(true)
  })

  it('B9 新建笔记落盘后也能保住 id（随机 id 被登记，之后移动不变）', async () => {
    await store.loadNotesFromPath(ROOT)
    const note = store.createNote('', '新笔记')
    await store.saveNoteToFile(note, '')
    const id = note.id
    expect(note.filePath).toBe(`${ROOT}/新笔记.md`)

    await store.moveNote(id, 'archive')

    const moved = store.notes.find(n => n.id === id)
    expect(moved).toBeTruthy()
    expect(moved.filePath).toBe(`${ROOT}/archive/新笔记.md`)
    expect(moved.id).toBe(id)
  })
})

// ===========================================================================
// C · 映射表丢失 → 从磁盘路径重建
// ===========================================================================
describe('C · 映射表丢失后从磁盘路径重建', () => {
  it('C1 localStorage 清空后重新载入 → id 与丢失前逐条相同', async () => {
    put('a.md', plain('A'))
    put('sub/b.md', plain('B'))
    put('sub/deep/c.md', plain('C'))
    await store.loadNotesFromPath(ROOT)
    const before = idSnapshot()
    await flushIdMapSave()
    expect(persistedMap()).not.toBe(null)

    // 映射表丢了（重置设置 / 清缓存 / 换机器）
    localStorage.clear()
    localStorage.setItem(LS_KEYS.dateMigration, '1710000000000')
    await store.loadNotesFromPath(ROOT)

    expect(idSnapshot()).toEqual(before)
    for (const n of store.notes) expect(n.id).toBe(pathHashId(n.filePath))
  })

  it('C2 Electron 侧 idmap.load 返回 null（没存过）→ 同样按磁盘重建', async () => {
    disk.installIdmapIPC(null)
    put('a.md', plain('A'))
    put('sub/b.md', plain('B'))
    await store.loadNotesFromPath(ROOT)

    expect(disk.idmap.loads).toBe(1)
    for (const n of store.notes) expect(n.id).toBe(pathHashId(n.filePath))
  })

  it('C3 Electron 侧有映射表 → 走 IPC 载入，id 由表说了算', async () => {
    const knownId = 'known-id-1'
    const path = put('a.md', plain('A'))
    disk.installIdmapIPC({ version: 1, byPath: { [path]: knownId }, byId: { [knownId]: path }, updatedAt: 0 })

    await store.loadNotesFromPath(ROOT)

    expect(store.notes[0].id).toBe(knownId)
    // 与「没迁移过的老库」不同：这里映射表是真相源，哈希只是兜底
    expect(knownId).not.toBe(pathHashId(path))
  })

  it('C4 Electron 侧：移动之后 flush → 真的走 idmap.save 落盘', async () => {
    disk.installIdmapIPC(null)
    put('src/A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes[0].id

    await store.moveNote(id, 'dest')
    await flushIdMapSave()

    expect(disk.idmap.saves.length).toBeGreaterThan(0)
    const saved = disk.idmap.saves[disk.idmap.saves.length - 1]
    expect(saved.byPath[`${ROOT}/dest/A.md`]).toBe(id)
  })

  it('C5 已知边界（文档化，不是回归）：丢失前**已经移动过**的笔记，重建后回到当前路径的哈希', async () => {
    // 双轨方案的真相只存在于映射表（绝不写用户的 .md，所以 .md 里没有 id）。
    // 映射表丢了且笔记移动过 → 只能按「现存的磁盘路径」重建，拿到的就是新路径
    // 的哈希。这正是 T16 文件头写的「兜底哈希存在的唯一目的」的反面：覆盖率的
    // 价值就在这里，所以 B/C 组那些用例才是必须守住的。
    put('src/A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes[0].id
    await store.moveNote(id, 'dest')
    await flushIdMapSave()

    localStorage.clear()
    localStorage.setItem(LS_KEYS.dateMigration, '1710000000000')
    await store.loadNotesFromPath(ROOT)

    expect(store.notes[0].filePath).toBe(`${ROOT}/dest/A.md`)
    expect(store.notes[0].id).toBe(pathHashId(`${ROOT}/dest/A.md`))
  })
})

// ===========================================================================
// D · 删除 → 解绑
// ===========================================================================
describe('D · 删除后解绑：同名文件重建不再接回已删笔记的 id', () => {
  it('D1 删除笔记 → 映射表里不再有这条路径', async () => {
    const path = put('A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    await flushIdMapSave()
    expect(Object.prototype.hasOwnProperty.call(persistedMap().byPath, path)).toBe(true)

    await store.deleteNote(store.notes[0].id)
    await flushIdMapSave()

    const map = persistedMap()
    expect(Object.prototype.hasOwnProperty.call(map.byPath, path)).toBe(false)
    expect(Object.keys(map.byId).length).toBe(0)
  })

  it('D2 删除后同名文件被重新建出来 → 拿到**新** id，不再复用已删笔记的 id', async () => {
    await store.loadNotesFromPath(ROOT)
    const created = store.createNote('', 'A')
    await store.saveNoteToFile(created, '')
    const deletedId = created.id
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(true)

    await store.deleteNote(deletedId)
    await flushIdMapSave()

    // 同名文件重新出现（外部同步 / 用户手工重建 / 回收站还原）
    put('A.md', plain('A'))
    await store.loadNotesFromPath(ROOT)

    const reborn = store.notes[0]
    expect(reborn.filePath).toBe(`${ROOT}/A.md`)
    expect(reborn.id).not.toBe(deletedId)
    expect(reborn.id).toBe(pathHashId(`${ROOT}/A.md`))
  })

  it('D3 删除文件夹 → 整棵子树的路径全部解绑', async () => {
    put('work/a.md', plain('A'))
    put('work/sub/b.md', plain('B'))
    await store.loadNotesFromPath(ROOT)
    await flushIdMapSave()

    await store.deleteFolder('work')
    await flushIdMapSave()

    const map = persistedMap()
    expect(Object.keys(map.byPath)).toEqual([])
    expect(Object.keys(map.byId)).toEqual([])
  })

  it('D4 目录删除失败被放回根目录 → 绑定补回去，不退化成哈希 id', async () => {
    put('work/a.md', plain('A'))
    await store.loadNotesFromPath(ROOT)
    const id = store.notes[0].id
    disk.removeDirImpl = async () => false

    await store.deleteFolder('work')
    await flushIdMapSave()

    const note = store.notes.find(n => n.id === id)
    expect(note).toBeTruthy()
    expect(note.folder).toBe('')
    expect(store.getIdMapStats().bound).toBe(1)
  })
})

// ===========================================================================
// E · 失败分支绝不改映射表（内存不动）
// ===========================================================================
describe('E · 操作失败时映射表一个字节都不动', () => {
  /**
   * 载入 + 落盘一份「可比较的」映射表快照。
   * @returns {Promise<string>} localStorage 里的原始 JSON
   */
  async function loadAndPersist (rel, content) {
    put(rel, content)
    await store.loadNotesFromPath(ROOT)
    await flushIdMapSave()
    return localStorage.getItem(LS_KEYS.idMap)
  }

  it('E1 移动撞名（target-exists）→ 映射表逐字节不变，且没有 dest 键', async () => {
    const before = await loadAndPersist('src/A.md', plain('A'))
    put('dest/A.md', plain('别人的笔记'))
    const id = store.notes[0].id

    const r = await store.moveNote(id, 'dest')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('target-exists')
    await flushIdMapSave()

    expect(localStorage.getItem(LS_KEYS.idMap)).toBe(before)
    const map = persistedMap()
    expect(map.byPath[`${ROOT}/src/A.md`]).toBe(id)
    expect(Object.prototype.hasOwnProperty.call(map.byPath, `${ROOT}/dest/A.md`)).toBe(false)
  })

  it('E2 移动时磁盘拒绝（permission）→ 映射表不变', async () => {
    const before = await loadAndPersist('src/A.md', plain('A'))
    disk.moveFileImpl = async () => {
      throw new Error('EPERM: operation not permitted')
    }
    const id = store.notes[0].id

    const r = await store.moveNote(id, 'dest')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('permission')
    await flushIdMapSave()

    expect(localStorage.getItem(LS_KEYS.idMap)).toBe(before)
    expect(store.notes.find(n => n.id === id).filePath).toBe(`${ROOT}/src/A.md`)
  })

  it('E3 重命名撞名（target-exists）→ 映射表不变，标题也没动', async () => {
    const before = await loadAndPersist('A.md', plain('A'))
    put('B.md', plain('别人的笔记'))
    const id = store.notes[0].id

    const r = await store.renameNote(id, 'B')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('target-exists')
    await flushIdMapSave()

    expect(localStorage.getItem(LS_KEYS.idMap)).toBe(before)
    expect(store.notes.find(n => n.id === id).title).toBe('A')
  })

  it('E4 失败前后 getIdMapStats 完全一致（内存侧同样没动）', async () => {
    await loadAndPersist('src/A.md', plain('A'))
    put('dest/A.md', plain('别人的笔记'))
    const before = store.getIdMapStats()

    await store.moveNote(store.notes[0].id, 'dest')

    expect(store.getIdMapStats()).toEqual(before)
  })

  it('E5 移动失败不会产生「半截绑定」：byId 与 byPath 仍然一一对应', async () => {
    await loadAndPersist('src/A.md', plain('A'))
    put('dest/A.md', plain('别人的笔记'))
    await store.moveNote(store.notes[0].id, 'dest')
    await flushIdMapSave()

    const map = persistedMap()
    const paths = Object.keys(map.byPath)
    const ids = Object.keys(map.byId)
    expect(paths.length).toBe(ids.length)
    for (const p of paths) expect(map.byId[map.byPath[p]]).toBe(p)
  })
})

// ===========================================================================
// F · 接线守卫（这些不是逻辑测试，是「别把线拔了」的守卫）
// ===========================================================================
describe('F · 接线守卫', () => {
  it('F1 src/main.js 真的装了 installIdMapFlush（否则去抖窗口内的绑定会丢）', () => {
    // vitest 下 import.meta.url 不一定是 file: scheme，用进程 cwd 拼更稳
    const src = readFileSync(join(process.cwd(), 'src/main.js'), 'utf8')
    expect(src).toContain("from './utils/idMapStore'")
    expect(src).toContain('installIdMapFlush()')
    // 必须是「调用」而不是只 import
    expect(/installIdMapFlush\s*\(/.test(src)).toBe(true)
  })

  it('F2 note.js 造 id 的入口已经不是 generateStableId（走映射表优先）', () => {
    const src = readFileSync(join(process.cwd(), 'src/stores/note.js'), 'utf8')
    // 载入处必须是 resolveNoteId(file.path)
    expect(src).toContain('id: resolveNoteId(file.path)')
    expect(src).not.toContain('id: generateStableId(file.path)')
    // 兜底哈希必须来自内核
    expect(src).toContain("from '../utils/noteIdentity'")
    expect(src).toContain('pathHashId')
  })

  it('F3 store 导出了 safeWriteFile（迁移复用同一条落盘通道）', () => {
    expect(typeof store.safeWriteFile).toBe('function')
  })

  it('F4 store 导出了 T20 要读的两个体检接口', () => {
    put('a.md', plain('A'))
    void store.loadNotesFromPath(ROOT)
    const idStats = store.getIdMapStats()
    const dateStats = store.getDateSourceStats()
    expect(idStats).toHaveProperty('coverage')
    expect(dateStats).toHaveProperty('bySource')
    expect(dateStats).toHaveProperty('days')
  })
})

// ===========================================================================
// G · 排序口径没有被改动（行为破坏守卫）
// ===========================================================================
describe('G · 列表排序仍按 updatedAt（不因日期口径改动而变化）', () => {
  it('G1 sortBy=updated 时顺序由 updatedAt 决定，与新归属日期无关', async () => {
    // 乙的 updatedAt 更晚，但它的标题日期更早 —— 顺序必须按 updatedAt
    put('甲.md', plain('甲'), { mtime: new Date('2024-05-01T00:00:00.000Z') })
    put('乙.md', plain('乙 2020-01-01'), { mtime: new Date('2025-05-01T00:00:00.000Z') })
    await store.loadNotesFromPath(ROOT)

    const ids = store.filteredNotes.map(n => n.title)
    expect(ids).toEqual(['乙 2020-01-01', '甲'])
  })

  it('G2 日历（getNotesByDate）走的是归属日期，不跟着 updatedAt 跑', async () => {
    const mtime = new Date('2025-05-01T10:00:00.000Z')
    put('甲.md', withFmDate('甲', '2020-01-01'), { mtime })
    await store.loadNotesFromPath(ROOT)

    const onBirthday = store.getNotesByDate(new Date(2020, 0, 1))
    const onUpdateDay = store.getNotesByDate(new Date(2025, 4, 1))
    expect(onBirthday.map(n => n.title)).toEqual(['甲'])
    expect(onUpdateDay).toEqual([])
  })
})

// ===========================================================================
// H · 日期迁移（裁决 2：④ 级不许固化；且日历不漂移）
// ===========================================================================
describe('H · 日期迁移：日历不漂移 + ④ 级不被写死', () => {
  /** 打开迁移（清掉防重跑标记） */
  function enableMigration () {
    localStorage.removeItem(LS_KEYS.dateMigration)
  }

  it('H1 迁移后每一篇的 dateKey 与迁移前逐条相等（日历不漂移）', async () => {
    put('a.md', plain('甲'))
    put('b.md', plain('乙 2021-03-08'))
    put('c.md', withFmDate('丙', '2019-09-09'))
    put('sub/d.md', plain('丁 2018年12月25日'))
    await store.loadNotesFromPath(ROOT)          // 这一次迁移被 flag 挡住
    const before = dateKeySnapshot()

    enableMigration()
    await store.loadNotesFromPath(ROOT)          // 这一次真跑迁移

    expect(Object.keys(dateKeySnapshot()).length).toBe(4)
    expect(dateKeySnapshot()).toEqual(before)
  })

  it('H2 ④ 级（updatedAt）笔记：迁移前后文件字节完全不变，writeFile 一次都没被调', async () => {
    put('a.md', plain('甲'))
    put('b.md', plain('乙'))
    enableMigration()

    await store.loadNotesFromPath(ROOT)

    expect(api.writeFile).not.toHaveBeenCalled()
    for (const n of store.notes) {
      expect(n.content.includes('date:')).toBe(false)
    }
    // 磁盘上的字节也必须是原样
    expect(disk.files.get(`${ROOT}/a.md`)).toBe(plain('甲'))
  })

  it('H3 ④ 级笔记的日期来源仍然是 updatedAt（没有被悄悄升级成 frontmatter）', async () => {
    put('a.md', plain('甲'))
    enableMigration()
    await store.loadNotesFromPath(ROOT)

    const stats = store.getDateSourceStats()
    expect(stats.bySource.updatedAt).toBe(1)
    expect(stats.bySource.frontmatter || 0).toBe(0)
  })

  it('H4 ③ 级（标题日期串）会被固化 —— 证明迁移真的接上了，不是被 flag 全挡掉', async () => {
    put('a.md', plain('甲 2021-03-08'))
    enableMigration()

    await store.loadNotesFromPath(ROOT)

    expect(api.writeFile).toHaveBeenCalledTimes(1)
    const [path, content] = api.writeFile.mock.calls[0]
    expect(path).toBe(`${ROOT}/a.md`)
    expect(content).toContain('date: 2021-03-08')
    // 正文零改动：原文原样留在末尾
    expect(content.endsWith(plain('甲 2021-03-08'))).toBe(true)
    expect(store.getDateSourceStats().bySource.frontmatter).toBe(1)
  })

  it('H5 ① 级（已有 frontmatter date）→ skipped，绝不写第二个 date', async () => {
    put('a.md', withFmDate('甲', '2019-09-09'))
    enableMigration()
    const original = disk.files.get(`${ROOT}/a.md`)

    await store.loadNotesFromPath(ROOT)

    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.files.get(`${ROOT}/a.md`)).toBe(original)
  })

  it('H6 同一批里 ①②③④ 混合 → 只有 ③ 被写，其余各就各位', async () => {
    put('a.md', withFmDate('甲', '2019-09-09'))            // ① skipped
    put('b.md', plain('乙 2021-03-08'))                    // ③ migrated
    put('c.md', plain('丙'))                               // ④ untrusted
    enableMigration()

    await store.loadNotesFromPath(ROOT)

    const written = api.writeFile.mock.calls.map(c => c[0]).sort()
    expect(written).toEqual([`${ROOT}/b.md`])
    // ④ 那一篇字节不变
    expect(disk.files.get(`${ROOT}/c.md`)).toBe(plain('丙'))
    // ① 那一篇字节不变
    expect(disk.files.get(`${ROOT}/a.md`)).toBe(withFmDate('甲', '2019-09-09'))
  })

  it('H7 迁移写盘失败 → 启动照常完成，且留了一条可查的 warn（不卡住）', async () => {
    put('a.md', plain('甲 2021-03-08'))
    enableMigration()
    disk.throwWriteAlways(new Error('EROFS: read-only file system'))

    const r = await store.loadNotesFromPath(ROOT)

    expect(r.ok).toBe(true)
    expect(r.count).toBe(1)
    expect(store.notes).toHaveLength(1)
    const hits = getRingBuffer().filter(e => e && e.mod === 'note')
    expect(hits.some(e => String(e.msg || '').includes('日期迁移'))).toBe(true)
  })

  it('H8 迁移写盘失败 → 不落标记，下次启动会重试（同一批笔记再跑一次）', async () => {
    put('a.md', plain('甲 2021-03-08'))
    enableMigration()
    disk.throwWriteAlways(new Error('EROFS: read-only file system'))
    await store.loadNotesFromPath(ROOT)
    expect(localStorage.getItem(LS_KEYS.dateMigration)).toBe(null)

    // 磁盘修好：再跑一次就该写进去
    disk.writeFileImpl = async (p, content) => {
      disk.files.set(p, content)
      seedListed(disk.listed, p)
      return true
    }
    await store.loadNotesFromPath(ROOT)
    expect(api.writeFile).toHaveBeenCalled()
    expect(disk.files.get(`${ROOT}/a.md`)).toContain('date: 2021-03-08')
  })

  it('H9 迁移后索引的日期桶与迁移前一致（日历同一批格子、同一批 id）', async () => {
    put('a.md', plain('甲 2021-03-08'))
    put('b.md', plain('乙'))
    put('c.md', withFmDate('丙', '2019-09-09'))
    await store.loadNotesFromPath(ROOT)
    const before = new Map()
    for (const n of store.notes) before.set(n.id, dateKeyOfNote(n))

    enableMigration()
    await store.loadNotesFromPath(ROOT)

    for (const n of store.notes) {
      expect(dateKeyOfNote(n)).toBe(before.get(n.id))
      // 索引里那一格真的能取到这篇
      expect(store.getNotesByDate(new Date(before.get(n.id))).some(x => x.id === n.id)).toBe(true)
    }
  })

  it('H10 迁移没写任何文件时，不重复写盘（重置设置后重跑也零写入）', async () => {
    put('a.md', plain('甲'))
    put('b.md', plain('乙'))
    enableMigration()
    await store.loadNotesFromPath(ROOT)
    expect(api.writeFile).not.toHaveBeenCalled()

    // 模拟「重置设置」清掉标记后再跑一次
    localStorage.removeItem(LS_KEYS.dateMigration)
    await store.loadNotesFromPath(ROOT)
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.files.get(`${ROOT}/a.md`)).toBe(plain('甲'))
  })
})
