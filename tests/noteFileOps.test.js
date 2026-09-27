/**
 * 批次 1 的回归守卫：note.js 的文件操作（落盘取名 / 同名消解 / 移动 / 重命名）
 * + app.js + storage.js 的默认扩展名持久化（R-S1）。
 *
 * 覆盖的需求与验收点：
 *   R-F2 文件名合法化 —— 保留设备名 / 结尾空格与点 / 控制字符 / 超长截断 四类，
 *                        且「mock 写盘失败时有明确报错而非静默孤儿」（验收 ③）
 *   R-F3 同名消解     —— 连续 3 篇同名得到 3 个互不覆盖的文件（验收 ①）；
 *                        用户能看到实际使用的文件名（验收 ②）；零覆盖（验收 ③）
 *   R-D2 双链改写可信 —— rewriteBacklinks 全 await 并返回
 *                        { total, succeeded, failed, changedIds }；
 *                        磁盘只读时有明确失败提示（验收 ①）；返回能覆盖「改了 N 篇 / 成功 M 篇」（验收 ③）
 *   R-D3 移动/重命名可信 —— 返回 OpResult；撞名时不发生结构跳动，直接给出失败原因（验收 ①）
 *   R-S1 扩展名持久化   —— 设为 txt → 重启 → 新建仍是 txt；脏值回落 md；
 *                        noteExtension 绝不能再拿回 skipLoad
 *
 * 三份「别人跑过但没留下」的用例已被移植进本文件：
 *   (A) tmp/t03-verification.test.js 的 19 条 —— 见下方 R-D2 / R-D3 三组
 *   (B) T04 的端到端扩展名用例 —— 见「R-S1 默认扩展名持久化」
 *   (C) T02 的 8 个同名消解场景 —— 见「R-F3 同名消解」
 *
 * 为什么用**真 Pinia store** 而不是手搓替身（与 tests/commandPalette.test.js 同口径）：
 *   手搓替身只能断言「某个方法被调用了」；真 store 能断言**磁盘与内存的真实结果**。
 *   因此 store 方法一旦被改名 / 删除 / 改回同步 `return true`，这里会直接变红，
 *   而不是像替身那样悄悄放行。
 *
 * 为什么自己 mock `window.electronAPI`：
 *   vite.config.js 只配了 `environment: 'jsdom'`，**没有 setup 文件**（设计文档 §4.6），
 *   所以每个要用 IPC 的用例必须自行 mock 并在 afterEach 还原。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNoteStore } from '../src/stores/note'
import { useAppStore } from '../src/stores/app'
import { CONFIG_SCHEMA, LS_KEYS } from '../src/constants/storage'
import { isReservedDeviceName } from '../src/utils/fileNaming'
// 环形缓冲是「失败有没有留痕」的唯一可断言出口：T10 起 moveNote / renameNote 的
// 结构类失败（撞名 / 搬动不动）不再走 reportSaveError，改成 noteLog.warn 记一笔。
import { getRingBuffer, resetLogger } from '../src/utils/logger.js'

/** 虚拟库根目录。刻意用正斜杠：note.js 的 buildFilePath 就是正斜杠硬拼 */
const ROOT = 'C:/notes'

/** 控制字符：用 fromCharCode 而不是字面量，避免源码里出现可疑字节 */
const CTRL_CHAR = String.fromCharCode(7)

// ---------------------------------------------------------------------------
// 假磁盘：一个可注入失败的内存文件系统
// ---------------------------------------------------------------------------

/**
 * 建一套 `window.electronAPI` 替身。
 *
 * 每个 IPC 方法都先过一层 `xxxImpl`，测试只要替换 Impl 就能注入失败 —— 这样
 * `vi.fn` 仍然保留在 api 上，调用次数与入参照样可以断言（T03 的用例依赖这一点）。
 *
 * @returns {object} { files, listed, api, ... }
 */
function createDisk () {
  /** 绝对路径 → 文件内容（真实磁盘的近似） */
  const files = new Map()
  /** 目录 → Array<{name}>（readDirectory 的返回源，可与 files 不一致以模拟竞态） */
  const listed = new Map()

  const disk = {
    files,
    listed,

    // ---- 默认实现：全部成功 ----
    writeFileImpl: async (p, content) => {
      files.set(p, content)
      seedListed(listed, p)
      return true
    },
    moveFileImpl: async (from, to) => {
      if (!files.has(from)) return false
      const content = files.get(from)
      files.delete(from)
      files.set(to, content)
      seedListed(listed, to)
      return true
    },
    fileExistsImpl: async (p) => files.has(p),
    readDirectoryImpl: async (dir) => listed.get(dir) || [],
    createDirectoryImpl: async () => true,
    deleteFileImpl: async (p) => {
      files.delete(p)
      return true
    },
    removeDirImpl: async () => true,
    readFileImpl: async (p) => (files.has(p) ? files.get(p) : null)
  }

  /**
   * 注入「写盘失败」：命中 predicate 的路径返回 false，其余**照常落盘**。
   *
   * 必须包在默认实现**外面**而不是整体替换它 —— 整体替换会让「写成功的那几篇」
   * 也不再落到 files 里，于是「其余照常落盘」这条断言就变成自证了。
   * @param {(path: string) => boolean} predicate 命中即失败
   * @returns {void}
   */
  disk.failWriteWhen = (predicate) => {
    const base = disk.writeFileImpl
    disk.writeFileImpl = async (p, content) => (predicate(p) ? false : base(p, content))
  }

  /**
   * 注入「写盘抛异常」（磁盘只读 / 被占用的真实形态）。
   * @param {(path: string) => boolean} predicate 命中即抛
   * @param {Error} error 要抛的异常
   * @returns {void}
   */
  disk.throwWriteWhen = (predicate, error) => {
    const base = disk.writeFileImpl
    disk.writeFileImpl = async (p, content) => {
      if (predicate(p)) throw error
      return base(p, content)
    }
  }

  disk.api = {
    writeFile: vi.fn((p, content) => disk.writeFileImpl(p, content)),
    moveFile: vi.fn((from, to, opts) => disk.moveFileImpl(from, to, opts)),
    fileExists: vi.fn((p) => disk.fileExistsImpl(p)),
    readDirectory: vi.fn((dir) => disk.readDirectoryImpl(dir)),
    createDirectory: vi.fn((dir) => disk.createDirectoryImpl(dir)),
    deleteFile: vi.fn((p) => disk.deleteFileImpl(p)),
    removeDir: vi.fn((dir) => disk.removeDirImpl(dir)),
    readFile: vi.fn((p) => disk.readFileImpl(p))
  }

  return disk
}

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
 * 在磁盘上预置一个「内存里没有」的文件（模拟外部新建 / 云同步过来的文件）。
 * @param {object} disk 假磁盘
 * @param {string} absPath 绝对路径
 * @param {string} content 文件内容
 * @returns {void}
 */
function seedDiskFile (disk, absPath, content = '外部写入的内容') {
  disk.files.set(absPath, content)
  seedListed(disk.listed, absPath)
}

/**
 * 造一篇笔记。字段与 note.js 里真实笔记的形状保持一致。
 * @param {object} over 覆盖字段
 * @returns {object} 笔记对象
 */
function mkNote (over = {}) {
  const base = {
    id: 'a',
    title: 'A',
    folder: '',
    content: '# A\n\n',
    tags: [],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    wordCount: 0,
    charCount: 0,
    lineCount: 1,
    filePath: null
  }
  const merged = { ...base, ...over }
  if (over.filePath === undefined) {
    merged.filePath = merged.folder
      ? `${ROOT}/${merged.folder}/${merged.title}.md`
      : `${ROOT}/${merged.title}.md`
  }
  return merged
}

/**
 * 造一篇笔记并同时放进内存与磁盘。
 * 「内存有、磁盘也有」是 moveNote / renameNote 走磁盘分支的前提
 * （`canTouchDisk = filePath && window.electronAPI && notesPath`）。
 * @param {object} over 覆盖字段
 * @returns {object} 笔记对象
 */
function addNote (over = {}) {
  const note = mkNote(over)
  store.notes.push(note)
  if (note.filePath) seedDiskFile(disk, note.filePath, note.content)
  return note
}

/** 取文件名部分 */
function baseNameOf (p) {
  const s = String(p || '').replace(/\\/g, '/')
  return s.slice(s.lastIndexOf('/') + 1)
}

/** 断言一个落盘名对 Windows 而言一定合法（R-F2 的不变量） */
function expectLegalFileName (name) {
  expect(name).toBeTruthy()
  expect(/[\\/:*?"<>|]/.test(name)).toBe(false)          // 非法字符
  expect(/[. ]$/.test(name)).toBe(false)                 // 结尾空格与点
  expect(/[\u0000-\u001F]/.test(name)).toBe(false)       // 控制字符
  expect(isReservedDeviceName(name)).toBe(false)         // 保留设备名（含带扩展名形式）
}

/** UTF-8 字节数（与 fileNaming.js 的口径一致） */
function byteLength (s) {
  return new TextEncoder().encode(String(s)).length
}

// ---------------------------------------------------------------------------
// 用例脚手架
// ---------------------------------------------------------------------------

let store
let appStore
let api
let disk
let errSpy
let warnSpy

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  // 日志内核持有跨用例的模块级状态（级别 / 环形缓冲 / sink）。读环形缓冲的用例
  // 必须在每条用例开始前清空，否则上一条的留痕会让下一条「看起来记过了」。
  resetLogger()
  // note.js 的 reportSaveError 会 console.error；collectTakenNames 失败分支会 console.warn。
  // 接住它们：既防止刷屏，又让「有明确报错」成为可断言的事实。
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  disk = createDisk()
  api = disk.api
  window.electronAPI = api

  appStore = useAppStore()
  store = useNoteStore()
  store.notesPath = ROOT
  // 清掉示例库：示例笔记 folder 为 '' 且 filePath 为 null，会被 collectTakenNames
  // 当成「同目录待落盘笔记」登记，污染同名消解的断言
  store.notes.length = 0
})

afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  // toast 带 5s 自动关闭定时器，不清理会在用例之间泄漏。
  // app.js 没有导出 clearToastTimers，所以逐条 dismissToast（它同样会清定时器）
  for (const toast of [...appStore.toasts]) appStore.dismissToast(toast.id)
  delete window.electronAPI
})

/** 按 id 取库里的笔记（响应式代理，读写都会落到真实对象上） */
function byId (id) {
  return store.notes.find(n => n.id === id)
}

/** 逐字段快照：用于断言「失败时内存一个字段都没动」 */
function snapshot (id) {
  const n = byId(id)
  return {
    id: n.id,
    title: n.title,
    folder: n.folder,
    filePath: n.filePath,
    content: n.content
  }
}

/** 把 console.error 的历次调用拼成一个字符串 */
function errorLogText () {
  return errSpy.mock.calls
    .map(args => args.map(a => (a instanceof Error ? a.message : String(a))).join(' '))
    .join('\n')
}

/** 用户可见的报错：note.js 的 reportSaveError 会 pushToast({type:'error'}) */
function errorToasts () {
  return appStore.toasts.filter(t => t.type === 'error')
}

/**
 * 「写盘失败」这一类**IO 类失败**的断言：控制台有记录 且 用户能看到 toast。
 *
 * 适用范围：`safeWriteFile` / `safeMoveFile` 抛错或返回 false 的场景 —— 这些仍然
 * 走 `reportSaveError()`，由 store 自己负责告知用户（还没有 UI 侧调用方接手）。
 * 本文件里 9 处用的是这一类。
 */
function expectExplicitError () {
  expect(errorLogText()).toContain('[note] 写入失败')
  expect(errorToasts().length).toBeGreaterThan(0)
}

/** 级别权重（与 constants/logging.js 的 LOG_LEVELS 同口径，这里只取可输出那四级） */
const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 环形缓冲里 note 模块「够得上严重程度」的记录。
 *
 * @param {string} [minLevel='warn'] 最低级别；'warn' 表示 warn 与 error 都算
 * @returns {Array<object>} LogEntry 副本数组
 */
function loggedFailures (minLevel = 'warn') {
  const floor = LEVEL_WEIGHT[minLevel] || 0
  return getRingBuffer().filter(
    e => e && e.mod === 'note' && (LEVEL_WEIGHT[e.lvl] || 0) >= floor
  )
}

/**
 * 「撞名 / 搬动不动」这一类**结构类失败**的断言（R-D3 ① 的等价强度版本）。
 *
 * 为什么不能再用 `expectExplicitError()`：T10 起 moveNote / renameNote 的失败分支
 * 不再调 `reportSaveError()` —— 提示职责已转移给 Sidebar（它 `await` 到 OpResult 后
 * 按 `code` 弹「移动失败：…」）。store 若再自己弹一条「保存失败：…」，移动撞名时
 * 用户会同时看到两条互相矛盾的提示（一条说保存坏了、一条说撞名了），这是真实
 * 可见的 UX bug。所以「有明确报错」在这里必须换成两个不可退让的事实：
 *
 *   ① 用户侧：store **没有**抢着弹 error toast —— 出口只剩 Sidebar 一个，不会重复；
 *   ② 诊断侧：失败**确实留了痕** —— 环形缓冲里有一条 note 模块、warn 及以上、
 *      且结构化 `data.code` 就是失败原因的记录（不是 console.log 一句了事）。
 *
 * ①②合起来仍守住原来的验收意图：**写盘失败必须有明确报错，而不是静默产生孤儿**。
 * 一旦有人把失败分支改回「静默成功」（比如撞名时 `return opOk('ok')`），
 * ② 会立刻变红 —— 缓冲里不会再有任何一条。
 *
 * @param {string} code 期望被记录下来的失败码，如 'target-exists'
 * @returns {void}
 */
function expectStructuralFailure (code) {
  // ① 职责已转移到 Sidebar：store 一条 error toast 都不许自己弹
  expect(errorToasts().length).toBe(0)
  // 也不许再冒充「保存失败」—— 那会把撞名误导成磁盘坏了
  expect(errorLogText()).not.toContain('[note] 写入失败')

  // ② 失败必须留痕：warn 及以上，且结构化 data.code 能体现失败原因
  const hits = loggedFailures('warn')
  expect(hits.length).toBeGreaterThan(0)
  const matched = hits.filter(e => e.data && e.data.code === code)
  expect(matched.length).toBeGreaterThan(0)
  // 光有 code 不够：msg 得写给人看，否则环形缓冲里是一条没有正文的记录
  expect(String(matched[0].msg || '')).not.toBe('')
}

/**
 * 新建一篇笔记并立刻落盘（不经过 createNewNoteFile，便于在落盘前改内容）。
 * @param {string} title 标题
 * @param {string} folder 文件夹
 * @param {string} [content] 正文；缺省用 createNote 生成的 `# 标题`
 * @returns {Promise<object>} 笔记对象
 */
async function createAndSave (title, folder = '', content = null) {
  const note = store.createNote(folder, title)
  if (content !== null) note.content = content
  await store.saveNoteToFile(note, folder)
  return note
}

// ===========================================================================
// R-D3 移动原子化（移植 T03 的 moveNote 用例）
// ===========================================================================

describe('R-D3 moveNote 原子化：返回 OpResult，失败时磁盘与内存都不动', () => {
  it('目标已存在 → target-exists；moveFile 一次都没被调用，folder/filePath 逐字段未变', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    seedDiskFile(disk, `${ROOT}/dest/A.md`, '别人的笔记')

    const before = snapshot('a')
    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('target-exists')
    // 验收 ①：UI 不发生结构跳动 —— 磁盘层一次都没被碰过
    expect(api.moveFile).not.toHaveBeenCalled()
    expect(snapshot('a')).toEqual(before)
    expect(byId('a').folder).toBe('src')
    expect(byId('a').filePath).toBe(`${ROOT}/src/A.md`)
    // 唯一发生的一次写盘是原子化前的必要动作：把自身内容刷到旧路径
    expect(api.writeFile).toHaveBeenCalledTimes(1)
    expect(api.writeFile.mock.calls[0][0]).toBe(`${ROOT}/src/A.md`)
    // 失败必须是明确的，不能静默（提示口在 Sidebar，留痕在环形缓冲 —— 见 helper 说明）
    expectStructuralFailure('target-exists')
  })

  it('成功 → ok，且 folder / filePath 在磁盘成功之后才更新', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(true)
    expect(r.code).toBe('ok')
    expect(r.changed).toBe(1)
    expect(r.succeeded).toBe(1)
    expect(api.moveFile).toHaveBeenCalledWith(
      `${ROOT}/src/A.md`, `${ROOT}/dest/A.md`, { overwrite: false }
    )
    expect(byId('a').folder).toBe('dest')
    expect(byId('a').filePath).toBe(`${ROOT}/dest/A.md`)
  })

  it('内容刷盘失败 → write-failed，不继续移动也不改内存', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    disk.failWriteWhen(() => true)

    const before = snapshot('a')
    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('write-failed')
    expect(api.moveFile).not.toHaveBeenCalled()
    expect(snapshot('a')).toEqual(before)
    expectExplicitError()
  })

  it('move 返回 false 且源文件也没了 → not-found', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    // 源文件被外部同步工具删掉了：探测不到它 → not-found
    disk.fileExistsImpl = async () => false
    disk.moveFileImpl = async () => false

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('not-found')
    expect(byId('a').folder).toBe('src')
    expect(byId('a').filePath).toBe(`${ROOT}/src/A.md`)
  })

  it('move 返回 false 且目标目录也建不了 → permission', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    disk.moveFileImpl = async () => false
    disk.createDirectoryImpl = async () => false

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('permission')
    expect(byId('a').folder).toBe('src')
  })

  it('IPC 抛 EPERM → permission（errno 被还原成可读的错误码）', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    disk.moveFileImpl = async () => {
      throw new Error("EPERM: operation not permitted, rename 'x'")
    }

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('permission')
    expect(byId('a').folder).toBe('src')
    expectExplicitError()
  })

  it('move 报 target-exists（预检漏掉的竞态）→ target-exists', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    disk.fileExistsImpl = async () => false      // 预检被绕过
    disk.moveFileImpl = async () => ({ error: 'target-exists' })

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('target-exists')
    expect(byId('a').folder).toBe('src')
  })

  it('源与目标同时存在（疑似产生副本）→ conflict，绝不当成成功', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    // 主进程 copy 成功、unlink 失败：调用返回 false，但磁盘上两份都在
    disk.moveFileImpl = async (from, to) => {
      disk.files.set(to, disk.files.get(from))
      seedListed(disk.listed, to)
      return false
    }

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('conflict')
    expect(byId('a').folder).toBe('src')
    expect(byId('a').filePath).toBe(`${ROOT}/src/A.md`)
  })

  it('主进程报错但磁盘上其实已经挪好 → 按成功处理，不留错位', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    disk.moveFileImpl = async (from, to) => {
      const content = disk.files.get(from)
      disk.files.delete(from)
      disk.files.set(to, content)
      return false
    }

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(true)
    expect(r.code).toBe('ok')
    expect(byId('a').folder).toBe('dest')
    expect(byId('a').filePath).toBe(`${ROOT}/dest/A.md`)
  })

  it('同目录 → noop，不产生任何 IPC', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })

    const r = await store.moveNote('a', 'src')

    expect(r.ok).toBe(true)
    expect(r.code).toBe('noop')
    expect(api.moveFile).not.toHaveBeenCalled()
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  it('找不到笔记 → not-found', async () => {
    const r = await store.moveNote('none', 'dest')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not-found')
  })

  it('无磁盘环境（示例库）时只改内存 → ok，filePath 保持 null', async () => {
    store.notes.push(mkNote({ id: 'a', title: 'A', folder: 'src', filePath: null }))

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(true)
    expect(byId('a').folder).toBe('dest')
    expect(byId('a').filePath).toBe(null)
  })

  it('移动失败不产生孤儿：IPC 抛错后源文件还在，目标处没有半截副本', async () => {
    addNote({ id: 'a', title: 'A', folder: 'src' })
    disk.moveFileImpl = async () => {
      throw new Error('EACCES: permission denied')
    }

    const r = await store.moveNote('a', 'dest')

    expect(r.ok).toBe(false)
    expect(disk.files.has(`${ROOT}/src/A.md`)).toBe(true)
    expect(disk.files.has(`${ROOT}/dest/A.md`)).toBe(false)
    expect(disk.files.size).toBe(1)
    expectExplicitError()
  })
})

// ===========================================================================
// R-D3 重命名原子化 + R-D2 双链改写（移植 T03 的 renameNote 用例）
// ===========================================================================

describe('R-D3 renameNote 原子化 + R-D2 双链改写落盘可信', () => {
  it('成功 → 双链写盘被 await，返回 total / succeeded 能覆盖「改了 N 篇 / 成功 M 篇」', async () => {
    addNote({ id: 'a', title: 'A', content: '# A\n\n' })
    addNote({
      id: 'b', title: 'B', content: '# B\n\n指向 [[A]] 的链接\n'
    })

    const r = await store.renameNote('a', 'C')

    expect(r.ok).toBe(true)
    expect(r.code).toBe('ok')
    expect(r.total).toBe(2)
    expect(r.succeeded).toBe(2)
    expect(r.failed).toEqual([])
    expect(api.moveFile).toHaveBeenCalledWith(`${ROOT}/A.md`, `${ROOT}/C.md`, { overwrite: false })

    const written = api.writeFile.mock.calls
    // 反向链接那篇必须真的写过盘，且写进去的已经是新标题
    expect(written.some(c => c[0] === `${ROOT}/B.md` && c[1].includes('[[C]]'))).toBe(true)
    expect(byId('b').content.includes('[[C]]')).toBe(true)
    // 自身正文在新路径上同步过一次
    expect(written.some(c => c[0] === `${ROOT}/C.md` && c[1].startsWith('# C'))).toBe(true)
    expect(byId('a').title).toBe('C')
    expect(byId('a').filePath).toBe(`${ROOT}/C.md`)
  })

  it('目标已存在 → target-exists，内存连标题都没动（逐字段）', async () => {
    addNote({ id: 'a', title: 'A' })
    seedDiskFile(disk, `${ROOT}/C.md`, '别人的笔记')

    const before = snapshot('a')
    const r = await store.renameNote('a', 'C')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('target-exists')
    expect(api.moveFile).not.toHaveBeenCalled()
    expect(snapshot('a')).toEqual(before)
    // 与 moveNote 同口径：用户提示归 Sidebar，诊断留痕归环形缓冲
    expectStructuralFailure('target-exists')
  })

  it('反链写盘失败 → rename-partial，失败的那篇 content 仍含 [[A]]（内存没动）', async () => {
    addNote({ id: 'a', title: 'A' })
    addNote({
      id: 'b', title: 'B', content: '# B\n\n指向 [[A]] 的链接\n'
    })
    // 磁盘只读：只让反链那篇写不进去
    disk.failWriteWhen(p => p === `${ROOT}/B.md`)

    const r = await store.renameNote('a', 'C')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('rename-partial')
    expect(r.partial).toBe(true)
    expect(r.total).toBe(2)
    expect(r.succeeded).toBe(1)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].id).toBe('b')
    expect(r.failed[0].path).toBe(`${ROOT}/B.md`)
    expect(r.failed[0].reason).toBe('backlink')
    // 没写成功的那一篇与磁盘保持一致，重做一次就能补全（幂等）
    expect(byId('b').content.includes('[[A]]')).toBe(true)
    // 主体本身确实改名了 —— 磁盘已经动了，不能假装没动
    expect(byId('a').title).toBe('C')
    expect(byId('a').filePath).toBe(`${ROOT}/C.md`)
    // R-D2 验收 ①：磁盘只读必须有明确失败提示，不是静默
    expectExplicitError()
  })

  it('自身正文写盘失败 → rename-partial（reason=content）', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.failWriteWhen(p => p === `${ROOT}/C.md`)

    const r = await store.renameNote('a', 'C')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('rename-partial')
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].reason).toBe('content')
    expect(byId('a').title).toBe('C')
    expect(byId('a').filePath).toBe(`${ROOT}/C.md`)
    expectExplicitError()
  })

  it('新标题为空 → invalid-title，什么都不改', async () => {
    addNote({ id: 'a', title: 'A' })
    const before = snapshot('a')

    const r = await store.renameNote('a', '   ')

    expect(r.ok).toBe(false)
    expect(r.code).toBe('invalid-title')
    expect(snapshot('a')).toEqual(before)
  })

  it('找不到笔记 → not-found', async () => {
    const r = await store.renameNote('none', 'X')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not-found')
  })

  it('rewriteBacklinks 返回 { total, succeeded, failed, changedIds }，写盘全部 await', async () => {
    addNote({ id: 'a', title: 'A' })
    addNote({ id: 'b', title: 'B', content: '# B\n\n指向 [[A]] 的链接\n' })
    addNote({ id: 'c', title: 'C', content: '# C\n\n指向 [[A|别名]] 的链接\n' })

    const r = await store.rewriteBacklinks('A', 'Z')

    expect(r.total).toBe(2)
    expect(r.succeeded).toBe(2)
    expect(r.failed).toEqual([])
    // 两篇都真的写过盘（不是 fire-and-forget）
    expect(api.writeFile).toHaveBeenCalledTimes(2)
    expect(byId('b').content.includes('[[Z]]')).toBe(true)
    // 锚点与别名必须保留
    expect(byId('c').content.includes('[[Z|别名]]')).toBe(true)
    expect(r.changedIds.has('b')).toBe(true)
    expect(r.changedIds.has('c')).toBe(true)
  })

  it('rewriteBacklinks：新旧标题相同时什么也不做', async () => {
    addNote({ id: 'a', title: 'A' })

    const r = await store.rewriteBacklinks('A', 'A')

    expect(r.total).toBe(0)
    expect(r.succeeded).toBe(0)
    expect(r.failed).toEqual([])
    expect(r.changedIds.size).toBe(0)
    expect(api.writeFile).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// R-F2 文件名合法化：四类非法输入落盘后必须是合法名
// ===========================================================================

describe('R-F2 文件名合法化：非法标题落盘后一定合法', () => {
  it.each([
    ['CON', '_CON.md'],
    ['NUL.md', '_NUL.md.md'],
    ['AUX', '_AUX.md'],
    ['LPT1', '_LPT1.md'],
    ['COM9', '_COM9.md'],
    ['笔记 ', '笔记.md'],
    ['笔记.', '笔记.md'],
    ['a/b', 'a_b.md']
  ])('标题 %j → 落盘为 %j，且不指向系统设备', async (title, expected) => {
    const note = await createAndSave(title)

    expect(api.writeFile).toHaveBeenCalledTimes(1)
    const writtenPath = api.writeFile.mock.calls[0][0]
    expect(baseNameOf(writtenPath)).toBe(expected)
    expect(note.filePath).toBe(`${ROOT}/${expected}`)
    // 验收 ①：不指向系统设备
    expectLegalFileName(baseNameOf(writtenPath))
  })

  it('控制字符被清除，不进文件名', async () => {
    const note = await createAndSave(`笔${CTRL_CHAR}记`)

    const name = baseNameOf(note.filePath)
    expect(name).toBe('笔记.md')
    expectLegalFileName(name)
  })

  it('超长标题按 UTF-8 字节截断，不切坏多字节字符', async () => {
    const longTitle = '啊'.repeat(120)   // 360 字节
    const note = await createAndSave(longTitle)

    const name = baseNameOf(note.filePath)
    expect(name.endsWith('.md')).toBe(true)
    expect(byteLength(name)).toBeLessThanOrEqual(255)
    expectLegalFileName(name)
    // 截断不能切出半个汉字（截断后重新解析仍是完整字符）
    expect(Array.from(name).every(ch => byteLength(ch) > 0)).toBe(true)
  })

  it('空标题回落到「无标题」，不写出空文件名', async () => {
    const note = await createAndSave('')

    expect(baseNameOf(note.filePath)).toBe('无标题.md')
    expectLegalFileName(baseNameOf(note.filePath))
  })

  it('R-F2 验收 ③：合法化场景注入写盘失败 → 明确报错，且磁盘零孤儿', async () => {
    disk.failWriteWhen(() => true)

    const note = store.createNote('', 'CON')
    const ok = await store.saveNoteToFile(note, '')

    expect(ok).toBe(false)
    // 明确报错：控制台 + 用户可见 toast，二者缺一都不算「告知了用户」
    expectExplicitError()
    // 静默孤儿的判据：内存里没有 filePath、磁盘上没有任何文件
    expect(note.filePath).toBe(null)
    expect(byId(note.id).filePath).toBe(null)
    expect(disk.files.size).toBe(0)
  })
})

// ===========================================================================
// R-F3 同名消解（移植 T02 的 8 个场景）
// ===========================================================================

describe('R-F3 同名消解：连续新建不覆盖', () => {
  it('连续新建 3 篇同名 → 同名.md / 同名 1.md / 同名 2.md，零覆盖', async () => {
    const a = await createAndSave('同名', '', '# 同名\n\n第 1 篇')
    const b = await createAndSave('同名', '', '# 同名\n\n第 2 篇')
    const c = await createAndSave('同名', '', '# 同名\n\n第 3 篇')

    expect(baseNameOf(a.filePath)).toBe('同名.md')
    expect(baseNameOf(b.filePath)).toBe('同名 1.md')
    expect(baseNameOf(c.filePath)).toBe('同名 2.md')

    // 验收 ③：不发生任何内容覆盖 —— 三份内容各自独立存在
    expect(disk.files.size).toBe(3)
    expect(disk.files.get(`${ROOT}/同名.md`)).toContain('第 1 篇')
    expect(disk.files.get(`${ROOT}/同名 1.md`)).toContain('第 2 篇')
    expect(disk.files.get(`${ROOT}/同名 2.md`)).toContain('第 3 篇')
  })

  it('createNote ×3 后一次性 flushAll → 同样是 3 个互不覆盖的文件', async () => {
    const a = store.createNote('', '同名')
    const b = store.createNote('', '同名')
    const c = store.createNote('', '同名')
    a.content = '# 同名\n\n第 1 篇'
    b.content = '# 同名\n\n第 2 篇'
    c.content = '# 同名\n\n第 3 篇'

    await store.flushAll()

    // 最早建的那篇拿到干净名（下标更大 = 更早创建）
    expect(baseNameOf(a.filePath)).toBe('同名.md')
    expect(baseNameOf(b.filePath)).toBe('同名 1.md')
    expect(baseNameOf(c.filePath)).toBe('同名 2.md')
    expect(disk.files.size).toBe(3)
    expect(new Set([a.filePath, b.filePath, c.filePath]).size).toBe(3)
  })

  it('磁盘有「外部.md」但内存没有 → 新建得到「外部 1.md」，原文件内容不变', async () => {
    seedDiskFile(disk, `${ROOT}/外部.md`, '外部工具的原始内容')

    const note = await createAndSave('外部')

    expect(baseNameOf(note.filePath)).toBe('外部 1.md')
    expect(disk.files.get(`${ROOT}/外部.md`)).toBe('外部工具的原始内容')
    expect(disk.files.size).toBe(2)
  })

  it('磁盘有 note.md、新建标题 Note（大小写）→ 不覆盖', async () => {
    seedDiskFile(disk, `${ROOT}/note.md`, '原始 note')

    const note = await createAndSave('Note')

    expect(baseNameOf(note.filePath)).toBe('Note 1.md')
    expect(disk.files.get(`${ROOT}/note.md`)).toBe('原始 note')
    expect(disk.files.size).toBe(2)
  })

  it('磁盘有 X.MD、新建标题 X → 不覆盖', async () => {
    seedDiskFile(disk, `${ROOT}/X.MD`, '原始 X')

    const note = await createAndSave('X')

    expect(baseNameOf(note.filePath)).toBe('X 1.md')
    expect(disk.files.get(`${ROOT}/X.MD`)).toBe('原始 X')
  })

  it('子文件夹内同名与根目录互不干扰', async () => {
    const inSub = await createAndSave('同名', 'work', '# 同名\n\n子文件夹')
    const inRoot = await createAndSave('同名', '', '# 同名\n\n根目录')

    expect(inSub.filePath).toBe(`${ROOT}/work/同名.md`)
    expect(inRoot.filePath).toBe(`${ROOT}/同名.md`)
    expect(disk.files.size).toBe(2)
  })

  it('删掉 readDirectory 只留 fileExists → 仍然不覆盖（内存侧来源独立有效）', async () => {
    delete api.readDirectory

    const a = await createAndSave('同名', '', '# 同名\n\n第 1 篇')
    const b = await createAndSave('同名', '', '# 同名\n\n第 2 篇')

    expect(baseNameOf(a.filePath)).toBe('同名.md')
    expect(baseNameOf(b.filePath)).toBe('同名 1.md')
    expect(disk.files.size).toBe(2)
  })

  it('readDirectory 说谎（返回空）但 fileExists 命中 → 最后一道闸门独立拦住', async () => {
    seedDiskFile(disk, `${ROOT}/外部.md`, '外部工具的原始内容')
    // 目录列表读不到（模拟目录读取失败 / 竞态），只留 fs:file-exists 复核
    disk.readDirectoryImpl = async () => []

    const note = await createAndSave('外部')

    expect(baseNameOf(note.filePath)).toBe('外部 1.md')
    expect(disk.files.get(`${ROOT}/外部.md`)).toBe('外部工具的原始内容')
  })

  it('单篇新建不得凭空多一个「 1」后缀（响应式代理 vs 原始对象的 === 陷阱）', async () => {
    // T02 真踩过的坑：notes.value[i] 是响应式代理，createNote 返回的是原始对象，
    // 二者 `===` 为 false。若「排除自己」按引用比，自己会被算进 taken，
    // 于是每篇新建都凭空多一个 ' 1'。所有排除判断必须按 id 比。
    const a = await createAndSave('X')
    expect(a.filePath).toBe(`${ROOT}/X.md`)

    // 同目录下第二篇才应该有后缀
    const b = await createAndSave('X')
    expect(b.filePath).toBe(`${ROOT}/X 1.md`)
  })

  it('R-F3 验收 ②：最后一道闸门改了名字时，必须告知用户实际使用的文件名', async () => {
    seedDiskFile(disk, `${ROOT}/外部.md`, '外部工具的原始内容')
    // 目录列表读不到（退化为内存侧），改名只能由最后一道 fileExists 闸门完成
    disk.readDirectoryImpl = async () => []

    const note = await createAndSave('外部')

    expect(baseNameOf(note.filePath)).toBe('外部 1.md')
    const infos = appStore.toasts.filter(t => t.type === 'info')
    expect(infos.length).toBeGreaterThan(0)
    expect(infos[infos.length - 1].message).toContain('外部 1.md')
  })

  it('消解只属于新建落盘：已落盘笔记写回自己的 filePath，不被二次消解', async () => {
    const note = await createAndSave('同名')
    const firstPath = note.filePath

    await store.flushSave(note.id)

    expect(note.filePath).toBe(firstPath)
    expect(api.writeFile.mock.calls.filter(c => c[0] === firstPath).length).toBeGreaterThan(0)
    expect(disk.files.size).toBe(1)
  })
})

// ===========================================================================
// 写盘失败注入：必须有明确报错，绝不能静默产生孤儿
// ===========================================================================

describe('写盘失败注入：明确报错而非静默孤儿', () => {
  it('新建笔记写盘返回 false → 报错 + filePath 保持 null + 磁盘零文件', async () => {
    disk.failWriteWhen(() => true)

    const note = store.createNote('', '会失败的笔记')
    const ok = await store.saveNoteToFile(note, '')

    expect(ok).toBe(false)
    expectExplicitError()
    expect(note.filePath).toBe(null)
    expect(disk.files.size).toBe(0)
  })

  it('新建笔记写盘抛 EROFS → 报错 + 磁盘零文件（异常不能被吞）', async () => {
    const erofs = new Error('EROFS: read-only file system')
    erofs.code = 'EROFS'
    disk.throwWriteWhen(() => true, erofs)

    const note = store.createNote('', '只读盘笔记')
    const ok = await store.saveNoteToFile(note, '')

    expect(ok).toBe(false)
    expect(errorLogText()).toContain('EROFS')
    expect(errorToasts().length).toBeGreaterThan(0)
    expect(note.filePath).toBe(null)
    expect(disk.files.size).toBe(0)
  })

  it('已落盘笔记写回失败 → 报错，且不改写 filePath', async () => {
    const note = await createAndSave('已落盘')
    const path = note.filePath

    disk.failWriteWhen(() => true)
    const ok = await store.flushSave(note.id)

    expect(ok).toBe(false)
    expectExplicitError()
    expect(note.filePath).toBe(path)
    // 未落盘标记必须保留，下一次 Ctrl+S 还要重试
    expect(store.hasPendingSaves()).toBe(true)
  })

  it('批量落盘中某一篇失败 → 其余照常落盘，失败的那篇有报错', async () => {
    const a = store.createNote('', '甲')
    const b = store.createNote('', '乙')
    a.content = '# 甲'
    b.content = '# 乙'
    disk.failWriteWhen(p => p === `${ROOT}/乙.md`)

    await store.flushAll()

    expect(disk.files.has(`${ROOT}/甲.md`)).toBe(true)
    expect(disk.files.has(`${ROOT}/乙.md`)).toBe(false)
    expect(a.filePath).toBe(`${ROOT}/甲.md`)
    expect(b.filePath).toBe(null)
    expectExplicitError()
  })
})

// ===========================================================================
// R-S1 默认扩展名持久化（移植 T04 的端到端用例）
//
// 为什么这条必须留守卫：noteExtension 曾是 CONFIG_SCHEMA 里第二项 skipLoad，
// 造成「改了能存、重启就忘」。现在没有任何测试盯着 skipLoad，将来谁再把它
// 加回去，这个 bug 会悄无声息地复活。
// ===========================================================================

describe('R-S1 默认扩展名持久化：改了能存，重启还在', () => {
  it('设为 txt → 模拟重启 → loadConfig → 新建笔记确实落到 .txt', async () => {
    const app1 = useAppStore()
    expect(app1.setNoteExtension('txt')).toBe(true)
    expect(localStorage.getItem(LS_KEYS.noteExtension)).toBe('txt')

    // 模拟重启：全新 pinia（全新 store 实例），重新走一次 loadConfig
    setActivePinia(createPinia())
    const app2 = useAppStore()
    expect(app2.noteExtension).toBe('md')   // 新实例的出厂默认值
    app2.loadConfig()
    expect(app2.noteExtension).toBe('txt')  // ★ 守卫点：真的读回来了

    // 端到端：新建 → 落盘路径必须以「测试笔记.txt」结尾
    const noteStore = useNoteStore()
    noteStore.notesPath = ROOT
    noteStore.notes.length = 0
    const note = noteStore.createNote('', '测试笔记')
    await noteStore.saveNoteToFile(note, '')

    expect(api.writeFile).toHaveBeenCalledTimes(1)
    const writtenPath = api.writeFile.mock.calls[0][0]
    expect(writtenPath.endsWith('测试笔记.txt')).toBe(true)
    expect(note.filePath).toBe(`${ROOT}/测试笔记.txt`)
  })

  it('localStorage 里的脏值一律回落 md（undefined / null / 空串）', () => {
    for (const dirty of ['undefined', 'null', '']) {
      localStorage.setItem(LS_KEYS.noteExtension, dirty)
      setActivePinia(createPinia())
      const app = useAppStore()
      app.loadConfig()
      expect(app.noteExtension).toBe(dirty === '' ? 'md' : 'md')
    }
  })

  it('白名单外的扩展名（exe）回落 md', () => {
    localStorage.setItem(LS_KEYS.noteExtension, 'exe')
    setActivePinia(createPinia())
    const app = useAppStore()
    app.loadConfig()
    expect(app.noteExtension).toBe('md')
  })

  it('路径穿越型脏值回落 md', () => {
    localStorage.setItem(LS_KEYS.noteExtension, '../../etc/passwd')
    setActivePinia(createPinia())
    const app = useAppStore()
    app.loadConfig()
    expect(app.noteExtension).toBe('md')
  })

  it('「.MARKDOWN」带点大写 → 归一化后读作 markdown，写入侧与读取侧同口径', () => {
    const app = useAppStore()
    expect(app.setNoteExtension('.MARKDOWN')).toBe(true)
    expect(app.noteExtension).toBe('markdown')
    expect(localStorage.getItem(LS_KEYS.noteExtension)).toBe('markdown')

    // 重启后读回来仍然是 markdown
    setActivePinia(createPinia())
    const app2 = useAppStore()
    app2.loadConfig()
    expect(app2.noteExtension).toBe('markdown')
  })

  it('setNoteExtension 拒绝非法值且不写盘', () => {
    const app = useAppStore()
    expect(app.setNoteExtension('exe')).toBe(false)
    expect(app.noteExtension).toBe('md')
    expect(localStorage.getItem(LS_KEYS.noteExtension)).toBe(null)
  })

  it('守卫：整个 schema 里只有 hotkeys 保留 skipLoad，noteExtension 绝不能再加回去', () => {
    const withSkipLoad = CONFIG_SCHEMA.filter(e => e.skipLoad === true).map(e => e.ref)
    expect(withSkipLoad).toEqual(['hotkeys'])

    const ext = CONFIG_SCHEMA.find(e => e.ref === 'noteExtension')
    const hotkeys = CONFIG_SCHEMA.find(e => e.ref === 'hotkeys')
    // hotkeys 的 skipLoad 是有意保留的历史行为（由 mergeBindings 单独处理）
    expect(hotkeys.skipLoad).toBe(true)
    expect(ext.skipLoad).toBe(undefined)
    // 光有 parse 还不够：parse 必须真的把合法值读出来
    expect(typeof ext.parse).toBe('function')
    expect(ext.parse('txt')).toBe('txt')
  })

  it('resetConfig 后回到 md，且 localStorage 里不留残留', () => {
    const app = useAppStore()
    app.setNoteExtension('txt')
    expect(app.noteExtension).toBe('txt')

    app.resetConfig()

    expect(app.noteExtension).toBe('md')
    expect(localStorage.getItem(LS_KEYS.noteExtension)).toBe(null)
  })
})
