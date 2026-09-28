// ===========================================================================
// W3 · 删除方式接线（note.js 记录 method + 契约不被破坏）
//
// 这里回答的是「接线有没有真的通、且有没有把别人的契约改坏」：
//   1. deleteFile / removeDir 带 detail:true 后，method 真的被记进 lastTrashMethod；
//   2. 非 detail 形态（布尔）与失败形态（ok:false）**不记录**（FI-1 / FI-2）；
//   3. deleteFolder 仍然返回 boolean（tests/fileUndo.test.js 的 toBe(true) 依赖它）；
//   4. removeDir 回 {ok:false} 时降级分支（笔记放回根目录）**照旧触发** ——
//      detail 形态是对象，真值判断一改错这里就会静默跳过，必须钉死；
//   5. lastTrashMethod 不会残留上一次的旧值（否则 Sidebar 会误报）。
//
// 用真 Pinia store（与 tests/fileUndo.test.js 同口径）：断言的是真实结果，
// 不是「某个方法被调用了」。
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useNoteStore } from '../src/stores/note'
import { useAppStore } from '../src/stores/app'

/**
 * 读出 src/ 下的源码文本（vitest 的 cwd 就是项目根）。
 * @param {string} relPath 相对 src/ 的路径
 * @returns {string} 源码文本
 */
function srcFile (relPath) {
  return readFileSync(resolve(process.cwd(), 'src', relPath), 'utf8')
}

const ROOT = 'C:/notes'

/** 造一篇笔记（与 fileUndo.test.js 同形状） */
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
 * 建一套可注入返回值的 `window.electronAPI` 替身。
 * @returns {object} 假磁盘
 */
function createDisk () {
  const files = new Map()
  const listed = new Map()
  const seedListed = (absPath) => {
    const i = String(absPath).lastIndexOf('/')
    if (i < 0) return
    const dir = absPath.slice(0, i)
    const list = listed.get(dir) || []
    const name = absPath.slice(i + 1)
    if (!list.some(e => e.name === name)) list.push({ name })
    listed.set(dir, list)
  }

  const disk = {
    files,
    listed,
    /** fs:delete-file 的返回值（默认：非 detail 老形态的 true） */
    deleteFileResult: true,
    /** fs:remove-dir 的返回值 */
    removeDirResult: true,
    writeFileImpl: async (p, content) => { files.set(p, content); seedListed(p); return true },
    moveFileImpl: async (from, to) => {
      if (!files.has(from)) return false
      files.set(to, files.get(from))
      files.delete(from)
      seedListed(to)
      return true
    },
    fileExistsImpl: async (p) => files.has(p),
    readDirectoryImpl: async (dir) => listed.get(dir) || [],
    createDirectoryImpl: async () => true,
    deleteFileImpl: async () => disk.deleteFileResult,
    removeDirImpl: async () => disk.removeDirResult,
    readFileImpl: async (p) => (files.has(p) ? files.get(p) : null)
  }

  disk.api = {
    writeFile: vi.fn((p, content) => disk.writeFileImpl(p, content)),
    moveFile: vi.fn((from, to) => disk.moveFileImpl(from, to)),
    fileExists: vi.fn((p) => disk.fileExistsImpl(p)),
    readDirectory: vi.fn((dir) => disk.readDirectoryImpl(dir)),
    createDirectory: vi.fn((dir) => disk.createDirectoryImpl(dir)),
    deleteFile: vi.fn((p, opts) => disk.deleteFileImpl(p, opts)),
    removeDir: vi.fn((dir, opts) => disk.removeDirImpl(dir, opts)),
    readFile: vi.fn((p) => disk.readFileImpl(p))
  }
  return disk
}

let store
let appStore
let disk
let errSpy
let warnSpy

/** 往库里加一篇笔记（内存 + 磁盘都有） */
let addNote = () => {}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  disk = createDisk()
  window.electronAPI = disk.api
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  appStore = useAppStore()
  store = useNoteStore()
  store.notesPath = ROOT
  store.notes.length = 0

  addNote = (over = {}) => {
    const note = mkNote(over)
    store.notes.push(note)
    if (note.filePath) {
      disk.files.set(note.filePath, note.content)
    }
    return note
  }
})

afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  for (const toast of [...appStore.toasts]) appStore.dismissToast(toast.id)
  delete window.electronAPI
})

describe('W3 · deleteNote 记录删除方式', () => {
  it('detail 形态 + system-trash → lastTrashMethod 记下它，且确实带上了 detail:true', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileResult = { ok: true, method: 'system-trash', path: `${ROOT}/A.md` }

    await store.deleteNote('a')

    expect(store.lastTrashMethod).toBe('system-trash')
    // 不带 detail 主进程只回 true，method 永远读不到
    expect(disk.api.deleteFile).toHaveBeenCalled()
    expect(disk.api.deleteFile.mock.calls[0][1]).toEqual({ detail: true })
  })

  it('detail 形态 + library-trash → 如实记录（降级到库内 .trash 也要能区分）', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileResult = { ok: true, method: 'library-trash', path: `${ROOT}/A.md` }

    await store.deleteNote('a')

    expect(store.lastTrashMethod).toBe('library-trash')
  })

  it('非 detail 形态（true）→ 未知，不记录（FI-1）', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileResult = true

    await store.deleteNote('a')

    expect(store.lastTrashMethod).toBe('')
  })

  it('失败形态 {ok:false} → 不记录（FI-2）', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileResult = { ok: false, error: 'delete-failed', method: 'system-trash' }

    await store.deleteNote('a')

    expect(store.lastTrashMethod).toBe('')
  })

  it('deleteNote 的返回契约仍是 void（不是 {ok, method}）', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileResult = { ok: true, method: 'system-trash' }

    const out = await store.deleteNote('a')

    expect(out).toBeUndefined()
  })
})

describe('W3 · deleteFolder 记录删除方式 + 契约不破', () => {
  it('removeDir 回 detail 成功 → 记录 method，且 deleteFolder 仍返回 true', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    disk.removeDirResult = { ok: true, method: 'library-trash', path: `${ROOT}/工作` }

    const ok = await store.deleteFolder('工作')

    expect(ok).toBe(true)
    expect(store.lastTrashMethod).toBe('library-trash')
    expect(disk.api.removeDir.mock.calls[0][1]).toEqual({ detail: true })
  })

  it('removeDir 回 true（老形态）→ 未知，不记录，但 ok 仍是 true', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    disk.removeDirResult = true

    const ok = await store.deleteFolder('工作')

    expect(ok).toBe(true)
    expect(store.lastTrashMethod).toBe('')
  })

  it('removeDir 回 {ok:false} → 返回 false，且降级分支照旧把笔记放回根目录', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    disk.removeDirResult = { ok: false, error: 'delete-failed' }

    const ok = await store.deleteFolder('工作')

    // ★ 关键：detail 形态是对象，`if (!ok)` 若没把对象归一成布尔就会静默跳过降级
    expect(ok).toBe(false)
    expect(store.notes.length).toBe(1)
    expect(store.notes[0].folder).toBe('')
    expect(store.lastTrashMethod).toBe('')
  })
})

describe('W3 · 不会拿上一次的旧值误报', () => {
  it('先成功再未知 → lastTrashMethod 必须是空，不能残留 system-trash', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileResult = { ok: true, method: 'system-trash' }
    await store.deleteNote('a')
    expect(store.lastTrashMethod).toBe('system-trash')

    addNote({ id: 'b', title: 'B' })
    disk.deleteFileResult = true
    await store.deleteNote('b')

    expect(store.lastTrashMethod).toBe('')
  })

  it('先成功再整篇删除失败 → 同样不留旧值', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileResult = { ok: true, method: 'system-trash' }
    await store.deleteNote('a')

    addNote({ id: 'b', title: 'B' })
    disk.deleteFileResult = { ok: false, error: 'delete-failed' }
    await store.deleteNote('b')

    expect(store.lastTrashMethod).toBe('')
  })

  it('浏览器模式（无 electronAPI）→ 不记录', async () => {
    addNote({ id: 'a', title: 'A' })
    delete window.electronAPI

    await store.deleteNote('a')

    expect(store.lastTrashMethod).toBe('')
    window.electronAPI = disk.api
  })
})

// ---------------------------------------------------------------------------
// 接线护栏（对源码的静态断言）
//
// 为什么需要这一层：Sidebar 的上报有两处**只有改了才会出事、而且出事即静默**的
// 写法 —— 从 TrashView.vue 引入（把懒加载视图拖进首屏主 chunk）、上报时丢掉
// notify:false（TrashView 自己的监听器会把它接回去派发，形成无限递归）。
// 真挂载 Sidebar 去断言代价太大（要 router + 弹窗 + store 全家桶），而这两条
// 恰好是**源码形状**问题，读源码断言是最直接也最不易腐化的判据。
// ---------------------------------------------------------------------------

describe('W3 · 接线护栏', () => {
  it('Sidebar 从零依赖 util 引入上报内核，绝不从 TrashView.vue 引入（FI-5）', () => {
    const src = srcFile('components/Sidebar.vue')
    expect(src).toContain("from '@/utils/trashState.js'")
    expect(src).not.toMatch(/from ['"]@\/views\/TrashView\.vue['"]/)
  })

  it('Sidebar 上报时必须带 notify:false（否则与 TrashView 监听器互相回抛 → 无限递归）（FI-3）', () => {
    const src = srcFile('components/Sidebar.vue')
    expect(src).toMatch(/reportTrashMethod\([^)]*\{\s*notify:\s*false\s*\}\s*\)/)
  })

  it('Sidebar 只读 noteStore.lastTrashMethod，未知就不上报', () => {
    const src = srcFile('components/Sidebar.vue')
    expect(src).toContain('noteStore.lastTrashMethod')
  })

  it('TrashView 改为从 util 引入内核（不再自带一份状态）', () => {
    const src = srcFile('views/TrashView.vue')
    expect(src).toContain("from '@/utils/trashState.js'")
  })

  it('事件名在三处口径一致：util 里的字面量就是 choyeon:trash-method（FI-4）', () => {
    const src = srcFile('utils/trashState.js')
    expect(src).toContain("export const TRASH_METHOD_EVENT = 'choyeon:trash-method'")
  })
})
