// ===========================================================================
// T29 · 文件操作撤回（R-D5 可恢复性）
//
// 这个文件回答六个问题（每条都对应一个用户可感知的痛点）：
//   1. 移动 / 重命名 / 删除之后能一步撤回，且**结构回到原处**；
//   2. 撤回时 `rebindPath` 也跟着回滚 —— 稳定 id 的承诺不会因为撤回而断掉；
//   3. **误删文件夹一步回到原位置，笔记数一个不少**（硬验收）；
//   4. 撤回栈有容量上限，不会无限增长；
//   5. 目标已被再次改动 → 判定失效并拒绝（不撤半截）；
//   6. 撤回跨越 UI 操作（含组件销毁 / 中途切页面）仍然有效。
//
// 与 T28「最近删除」的分工（两者刻意不互相调用）：
//   这里撤的是**应用内的操作**（Ctrl+Z 式的「刚才那一步不算」），
//   T28 恢复的是**磁盘 .trash 的内容**（哪怕重启过也能找回）。
//
// 为什么用**真 Pinia store**（与 tests/noteFileOps.test.js 同口径）：
//   手搓替身只能断言「某个方法被调用了」。这里要断言的是「笔记数不变」
//   「filePath 回到原处」「id 映射表也回滚了」这些**真实结果** —— 一旦有人
//   把撤回做成只改内存不动磁盘，或者漏掉 movePathBinding，用例必须直接变红。
//
// 为什么自己 mock `window.electronAPI`：
//   vite.config.js 只配了 `environment: 'jsdom'`，**没有 setup 文件**，所以每个
//   要用 IPC 的用例必须自行 mock 并在 afterEach 还原。
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { useNoteStore } from '../src/stores/note'
import { useAppStore } from '../src/stores/app'
import {
  useFileUndo,
  pushUndoEntry,
  snapshotNotes,
  diffSnapshots,
  valuesEqual,
  validateUndoEntry,
  clearUndo,
  getUndoStack,
  UNDO_LIMIT
} from '../src/composables/useFileUndo'

/** 虚拟库根目录。刻意用正斜杠：note.js 的 buildFilePath 就是正斜杠硬拼 */
const ROOT = 'C:/notes'

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
 * 建一套 `window.electronAPI` 替身。
 *
 * 每个 IPC 方法都先过一层 `xxxImpl`，测试只要替换 Impl 就能注入失败 ——
 * `vi.fn` 仍然留在 api 上，调用次数与入参照样可断言。
 *
 * @returns {object} 假磁盘
 */
function createDisk () {
  /** 绝对路径 → 文件内容（真实磁盘的近似） */
  const files = new Map()
  /** 目录 → Array<{name}> */
  const listed = new Map()

  const disk = {
    files,
    listed,
    writeFileImpl: async (p, content) => {
      files.set(p, content)
      seedListed(listed, p)
      return true
    },
    moveFileImpl: async (from, to) => {
      const fromKey = String(from).replace(/\/+$/, '')
      const toKey = String(to).replace(/\/+$/, '')
      // 单个文件
      if (files.has(fromKey)) {
        files.set(toKey, files.get(fromKey))
        files.delete(fromKey)
        seedListed(listed, toKey)
        return true
      }
      // 目录：moveFolder / renameFolder 搬的是**整个目录**，整棵子树一起走
      // （真实 IPC 的 fs.rename 就是这个语义；mock 不做这层就会让文件夹操作
      //  全部返回 false，进而连撤回都登记不上）
      let moved = false
      for (const k of [...files.keys()]) {
        if (k === fromKey || k.startsWith(fromKey + '/')) {
          const next = toKey + k.slice(fromKey.length)
          files.set(next, files.get(k))
          files.delete(k)
          seedListed(listed, next)
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
      return true
    },
    /** 删目录：把整棵子树从 files 里抹掉（与真实 removeDir 同语义） */
    removeDirImpl: async (dir) => {
      const base = String(dir).replace(/\/+$/, '')
      for (const k of [...files.keys()]) {
        if (k === base || k.startsWith(base + '/')) files.delete(k)
      }
      return true
    },
    readFileImpl: async (p) => (files.has(p) ? files.get(p) : null)
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
 * 在磁盘上预置一个文件。
 * @param {object} disk 假磁盘
 * @param {string} absPath 绝对路径
 * @param {string} content 内容
 * @returns {void}
 */
function seedDiskFile (disk, absPath, content) {
  disk.files.set(absPath, content)
  seedListed(disk.listed, absPath)
}

/**
 * 造一篇笔记。
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

// ---------------------------------------------------------------------------
// 用例脚手架
// ---------------------------------------------------------------------------

let store
let appStore
let disk
let errSpy
let warnSpy

/** 往库里加一篇笔记（内存 + 磁盘都有） */
let addNote = () => {}

/** 按 id 取库里的笔记（响应式代理） */
function byId (id) {
  return store.notes.find(n => n.id === id)
}

/** 逐字段快照，用于断言「撤回后结构完全复原」 */
function shape (id) {
  const n = byId(id)
  if (!n) return null
  return { id: n.id, title: n.title, folder: n.folder, filePath: n.filePath, content: n.content }
}

/** id ↔ path 映射表的绑定情况：用来断言「撤回把映射表也回滚了」 */
function binding () {
  return store.getIdMapStats()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  // 撤回栈是**模块级单例**：用例之间必须显式清干净，否则上一条的记录
  // 会漏到下一条里，让「空栈」这类断言变成自证。
  clearUndo()

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
    if (note.filePath) seedDiskFile(disk, note.filePath, note.content)
    return note
  }
})

afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  for (const toast of [...appStore.toasts]) appStore.dismissToast(toast.id)
  delete window.electronAPI
})

// ---------------------------------------------------------------------------
// A. 移动（move）
// ---------------------------------------------------------------------------

describe('移动笔记的撤回', () => {
  it('撤回后 folder 与 filePath 回到原位', async () => {
    addNote({ id: 'a', title: 'A' })
    const before = shape('a')

    const moved = await store.moveNote('a', '工作笔记')
    expect(moved.ok).toBe(true)
    expect(byId('a').folder).toBe('工作笔记')
    expect(byId('a').filePath).toBe(`${ROOT}/工作笔记/A.md`)

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    expect(shape('a')).toEqual(before)
  })

  it('撤回后 id 一个字都不变', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', '工作笔记')
    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    // 同一条记录、同一个 id —— 书签 / 最近打开 / 图谱坐标因此全部保活
    expect(byId('a').id).toBe('a')
  })

  it('撤回把 rebindPath 也回滚了（映射表重新绑回原路径）', async () => {
    addNote({ id: 'a', title: 'A' })
    // 先让原路径进映射表：否则「bound」在移动前后都是 0，断言失去区分力
    const moved = await store.moveNote('a', '工作笔记')
    expect(moved.ok).toBe(true)
    expect(binding().bound).toBe(1)

    await store.undoLastFileOperation()

    // 若漏掉 movePathBinding(新→旧)，映射表还绑在**新**路径上，
    // 而 note.filePath 已经是旧路径 → 这篇笔记会掉进 unbound，bound 归 0。
    const stats = binding()
    expect(stats.total).toBe(1)
    expect(stats.bound).toBe(1)
    expect(stats.unbound).toEqual([])
  })

  it('撤回把磁盘上的文件也搬回原路径', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', '工作笔记')
    expect(disk.files.has(`${ROOT}/工作笔记/A.md`)).toBe(true)
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(false)

    await store.undoLastFileOperation()
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(true)
    expect(disk.files.has(`${ROOT}/工作笔记/A.md`)).toBe(false)
  })

  it('移动到当前目录（noop）不占一个撤回位', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作笔记' })
    const res = await store.moveNote('a', '工作笔记')
    expect(res.code).toBe('noop')
    expect(getUndoStack().length).toBe(0)
  })

  it('移动失败（目标已存在）不登记撤回', async () => {
    addNote({ id: 'a', title: 'A' })
    seedDiskFile(disk, `${ROOT}/工作笔记/A.md`, '别人的笔记')
    const res = await store.moveNote('a', '工作笔记')
    expect(res.ok).toBe(false)
    expect(res.code).toBe('target-exists')
    expect(getUndoStack().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// B. 重命名（rename）
// ---------------------------------------------------------------------------

describe('重命名笔记的撤回', () => {
  it('撤回后 title / content / filePath 全部复原', async () => {
    addNote({ id: 'a', title: 'A', content: '# A\n\n正文' })
    const before = shape('a')

    const res = await store.renameNote('a', 'B')
    expect(res.ok).toBe(true)
    expect(byId('a').title).toBe('B')
    expect(byId('a').filePath).toBe(`${ROOT}/B.md`)

    await store.undoLastFileOperation()
    expect(shape('a')).toEqual(before)
  })

  it('撤回后 id 不变，映射表也绑回原路径', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.renameNote('a', 'B')
    await store.undoLastFileOperation()
    expect(byId('a').id).toBe('a')
    expect(binding().bound).toBe(1)
    expect(binding().unbound).toEqual([])
  })

  it('重命名连带改写的 [[双链]] 一起复原', async () => {
    addNote({ id: 'a', title: 'A', content: '# A\n\n正文' })
    addNote({ id: 'b', title: 'B', content: '# B\n\n见 [[A]] 详情' })

    await store.renameNote('a', 'A2')
    // 别处的链接确实被改写了
    expect(byId('b').content).toContain('[[A2]]')

    await store.undoLastFileOperation()
    // 目标复原
    expect(byId('a').title).toBe('A')
    // 被连带改写的那篇也必须复原 —— 否则双链停在半改状态
    expect(byId('b').content).toContain('[[A]]')
    expect(byId('b').content).not.toContain('[[A2]]')
  })

  it('重命名失败（撞名）不登记撤回', async () => {
    addNote({ id: 'a', title: 'A' })
    seedDiskFile(disk, `${ROOT}/B.md`, '别人的')
    const res = await store.renameNote('a', 'B')
    expect(res.ok).toBe(false)
    expect(getUndoStack().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// C. 删除单篇（delete）
// ---------------------------------------------------------------------------

describe('删除笔记的撤回', () => {
  it('撤回后笔记数不变（删掉的那篇回来了）', async () => {
    addNote({ id: 'a', title: 'A' })
    addNote({ id: 'b', title: 'B' })
    expect(store.notes.length).toBe(2)

    await store.deleteNote('a')
    expect(store.notes.length).toBe(1)

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    expect(store.notes.length).toBe(2)
    expect(store.notes.map(n => n.id).sort()).toEqual(['a', 'b'])
  })

  it('撤回后内容与下标都复原，磁盘文件也写回原处', async () => {
    addNote({ id: 'a', title: 'A', content: '# A\n\n要保住的内容' })
    addNote({ id: 'b', title: 'B' })

    await store.deleteNote('a')
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(false)

    await store.undoLastFileOperation()
    expect(byId('a').content).toBe('# A\n\n要保住的内容')
    // 插回原来的下标：顺序与删除前一致
    expect(store.notes[0].id).toBe('a')
    expect(disk.files.get(`${ROOT}/A.md`)).toBe('# A\n\n要保住的内容')
  })

  it('撤回把 forgetPath 解掉的绑定补回去', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.deleteNote('a')
    await store.undoLastFileOperation()
    // 不补 rememberPath 的话，这篇笔记会掉回「路径哈希 id」——
    // 下次移动就换 id，稳定 id 的承诺在这里断掉。
    const stats = binding()
    expect(stats.bound).toBe(1)
    expect(stats.unbound).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// D. 删除文件夹（R-D5 硬验收）
// ---------------------------------------------------------------------------

describe('误删文件夹一步回到原位置', () => {
  it('整棵子树的笔记数一个不少', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    addNote({ id: 'b', title: 'B', folder: '工作' })
    addNote({ id: 'c', title: 'C', folder: '工作/子目录' })
    addNote({ id: 'd', title: 'D', folder: '别的' })
    const countBefore = store.notes.length
    expect(countBefore).toBe(4)

    const ok = await store.deleteFolder('工作')
    expect(ok).toBe(true)
    expect(store.notes.length).toBe(1)

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    // ★ 硬验收：笔记数不变
    expect(store.notes.length).toBe(countBefore)
    expect(store.notes.map(n => n.id).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('每一篇的 folder / filePath / title 都回到原处', async () => {
    const a = addNote({ id: 'a', title: 'A', folder: '工作', content: '# A\n\n一' })
    const c = addNote({ id: 'c', title: 'C', folder: '工作/子目录', content: '# C\n\n三' })
    const beforeA = shape('a')
    const beforeC = shape('c')

    await store.deleteFolder('工作')
    await store.undoLastFileOperation()

    expect(shape('a')).toEqual(beforeA)
    expect(shape('c')).toEqual(beforeC)
    // 引用保持可用：内容没被换成空壳
    expect(byId('c').content).toBe('# C\n\n三')
  })

  it('磁盘上的整棵子树都写回原路径', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    addNote({ id: 'c', title: 'C', folder: '工作/子目录' })

    await store.deleteFolder('工作')
    expect(disk.files.has(`${ROOT}/工作/A.md`)).toBe(false)
    expect(disk.files.has(`${ROOT}/工作/子目录/C.md`)).toBe(false)

    await store.undoLastFileOperation()
    expect(disk.files.has(`${ROOT}/工作/A.md`)).toBe(true)
    expect(disk.files.has(`${ROOT}/工作/子目录/C.md`)).toBe(true)
  })

  it('展开态与选中目录一起复原', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    store.setSelectedFolder('工作')
    store.setExpandedFolders(['工作'])

    await store.deleteFolder('工作')
    expect(store.selectedFolder).toBe('')

    await store.undoLastFileOperation()
    expect(store.selectedFolder).toBe('工作')
    expect(store.expandedFolders).toContain('工作')
  })
})

// ---------------------------------------------------------------------------
// E. 文件夹移动 / 重命名
// ---------------------------------------------------------------------------

describe('文件夹移动与重命名的撤回', () => {
  it('moveFolder 后撤回：整棵子树的路径回到原处（含磁盘）', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    addNote({ id: 'c', title: 'C', folder: '工作/子目录' })

    // moveFolder 的语义是「搬进目标父目录」：'工作' → '归档/工作'（不是改名为 '归档'）
    const ok = await store.moveFolder('工作', '归档')
    expect(ok).toBe(true)
    expect(byId('a').folder).toBe('归档/工作')
    expect(byId('c').folder).toBe('归档/工作/子目录')

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    expect(byId('a').folder).toBe('工作')
    expect(byId('c').folder).toBe('工作/子目录')
    expect(byId('a').filePath).toBe(`${ROOT}/工作/A.md`)
    expect(byId('c').filePath).toBe(`${ROOT}/工作/子目录/C.md`)
    expect(disk.files.has(`${ROOT}/工作/A.md`)).toBe(true)
    expect(disk.files.has(`${ROOT}/归档/工作/A.md`)).toBe(false)
  })

  it('renameFolder 后撤回：folder 名回到原处', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    const ok = await store.renameFolder('工作', '新工作')
    expect(ok).toBe(true)
    expect(byId('a').folder).toBe('新工作')

    await store.undoLastFileOperation()
    expect(byId('a').folder).toBe('工作')
    expect(byId('a').filePath).toBe(`${ROOT}/工作/A.md`)
  })
})

// ---------------------------------------------------------------------------
// F. 撤回栈本身
// ---------------------------------------------------------------------------

describe('撤回栈', () => {
  it('空栈撤回返回 empty，不抛异常', async () => {
    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(false)
    expect(res.code).toBe('empty')
  })

  it('LIFO：连续两次操作，先撤最近的那一次', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', 'X')
    await store.moveNote('a', 'Y')
    expect(byId('a').folder).toBe('Y')

    await store.undoLastFileOperation()
    expect(byId('a').folder).toBe('X')
    await store.undoLastFileOperation()
    expect(byId('a').folder).toBe('')
    expect(getUndoStack().length).toBe(0)
  })

  it(`容量上限 ${UNDO_LIMIT}：满了丢最老的，不无限增长`, async () => {
    // 纯内核口径：序号是**模块级**递增的（跨用例不清零），所以这里用 label
    // 断言「谁留下了、谁被丢了」，而不是断言具体 seq 值 —— 后者会随执行顺序漂移。
    clearUndo()
    const total = UNDO_LIMIT + 5
    for (let i = 1; i <= total; i += 1) {
      pushUndoEntry({ kind: 'move', label: `第${i}次`, records: [{ id: 'a', fields: ['folder'], existedBefore: true, existedAfter: true, before: {}, after: {} }] })
    }
    const stack = getUndoStack()
    expect(stack.length).toBe(UNDO_LIMIT)
    // 最老那条已被丢掉，留下的是最近 20 条
    expect(stack[0].label).toBe(`第${total - UNDO_LIMIT + 1}次`)
    expect(stack[stack.length - 1].label).toBe(`第${total}次`)
  })

  it(`真实操作连做 ${UNDO_LIMIT + 6} 次，栈也不会超过上限`, async () => {
    addNote({ id: 'a', title: 'A' })
    for (let i = 0; i < UNDO_LIMIT + 6; i += 1) {
      await store.moveNote('a', i % 2 === 0 ? 'X' : 'Y')
    }
    expect(getUndoStack().length).toBe(UNDO_LIMIT)
  })

  it('切库清空撤回栈（跨库撤回没有意义）', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', 'X')
    expect(getUndoStack().length).toBe(1)

    await store.loadNotesFromPath('C:/另一个库')
    expect(getUndoStack().length).toBe(0)
  })

  it('resetConfig 清空撤回栈', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', 'X')
    expect(getUndoStack().length).toBe(1)

    store.resetConfig()
    expect(getUndoStack().length).toBe(0)
  })

  it('label 是人类可读的中文描述（供 UI 直接显示）', async () => {
    addNote({ id: 'a', title: '周报' })
    await store.moveNote('a', '工作笔记')
    expect(store.undoFileOperationLabel).toContain('周报')
    expect(store.undoFileOperationLabel).toContain('工作笔记')
  })
})

// ---------------------------------------------------------------------------
// G. 失效判定
// ---------------------------------------------------------------------------

describe('失效判定', () => {
  it('目标被再次改动 → stale，且内存一个字段都不动', async () => {
    addNote({ id: 'a', title: 'A', folder: '' })
    const res = await store.moveNote('a', 'X')
    expect(res.ok).toBe(true)
    expect(byId('a').folder).toBe('X')

    // 模拟「登记之后、撤回之前，目标又被别的操作改了一次」
    await store.moveNote('a', 'Y')
    // 记录里写的是「操作后 folder = 'X'」，而现在它是 'Y' → 判死
    byId('a').folder = 'Z'

    const undone = await store.undoLastFileOperation()
    expect(undone.ok).toBe(false)
    expect(undone.code).toBe('stale')
    // 拒绝撤回 = 内存一个字段都没被动过
    expect(byId('a').folder).toBe('Z')
  })

  it('记录里「已被删除」的那篇现在还在 → stale', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.deleteNote('a')
    // 用户（或同步）又把同一篇造了回来
    addNote({ id: 'a', title: 'A' })

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(false)
    expect(res.code).toBe('stale')
    expect(store.notes.length).toBe(1)    // 没有被重复插入
  })

  it('撤回删除时原路径已被占用 → target-exists（绝不覆盖别人的笔记）', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.deleteNote('a')
    // 别的笔记占了 A.md 这个路径
    addNote({ id: 'z', title: 'A', folder: '' })

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(false)
    expect(res.code).toBe('target-exists')
    expect(store.notes.length).toBe(1)
    expect(byId('z').content).toBe('# A\n\n')
  })

  it('失效的条目会被摘掉，不会让用户反复撞同一堵墙', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', 'X')
    byId('a').folder = 'Z'
    expect(getUndoStack().length).toBe(1)

    await store.undoLastFileOperation()
    // 失效 = 永远不可能再安全执行 → 摘掉
    expect(getUndoStack().length).toBe(0)
  })

  it('编辑正文**不会**让「移动」的撤回失效（按字段判定，不整篇比对）', async () => {
    addNote({ id: 'a', title: 'A', content: '# A\n\n旧' })
    await store.moveNote('a', 'X')
    // 之后用户改了正文：这是「移动」之外的改动，不该让撤回判死
    store.updateNoteContent('a', '# A\n\n新内容')

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    expect(byId('a').folder).toBe('')            // 位置撤回来了
    expect(byId('a').content).toBe('# A\n\n新内容') // 刚敲的字**没有被吞掉**
  })

  it('磁盘失败时保留记录（修好权限还能再撤一次）', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.deleteNote('a')

    // 让「写回原路径」失败
    disk.writeFileImpl = async () => false

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(false)
    expect(res.code).toBe('write-failed')
    // 记录**保留**：与「失效」不同，磁盘失败是可重试的
    expect(getUndoStack().length).toBe(1)
    expect(store.notes.length).toBe(0)   // 内存没被动过
  })
})

// ---------------------------------------------------------------------------
// H. 跨页面 / 跨组件生命周期
// ---------------------------------------------------------------------------

describe('撤回跨越 UI 操作', () => {
  it('栈不挂在组件上：组件销毁后仍然可撤', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.deleteNote('a')
    expect(store.notes.length).toBe(0)

    const scopeA = effectScope()
    const undoA = scopeA.run(() => useFileUndo())
    expect(undoA.canUndo.value).toBe(true)
    scopeA.stop()   // 组件卸载

    const scopeB = effectScope()
    const undoB = scopeB.run(() => useFileUndo())
    expect(undoB.canUndo.value).toBe(true)

    const res = await undoB.undoLast()
    expect(res.ok).toBe(true)
    expect(store.notes.length).toBe(1)
    scopeB.stop()
  })

  it('中途切页面（改选中目录 / 搜索词 / 当前笔记）不影响撤回', async () => {
    addNote({ id: 'a', title: 'A', folder: '工作' })
    addNote({ id: 'b', title: 'B', folder: '别的' })
    const ok = await store.deleteFolder('工作')
    expect(ok).toBe(true)

    // 模拟切到别的页面：视图状态被改得面目全非
    store.setSelectedFolder('别的')
    store.setSearchQuery('zzz')
    store.setSortBy('title')
    store.selectNote('b')
    expect(store.currentNoteId).toBe('b')

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    expect(store.notes.length).toBe(2)
    expect(byId('a').folder).toBe('工作')
  })

  it('另一处新建的 useFileUndo() 看到的是同一份栈', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', 'X')

    const scope = effectScope()
    const a = scope.run(() => useFileUndo())
    const b = scope.run(() => useFileUndo())
    expect(a.undoStack).toBe(b.undoStack)
    expect(a.undoDepth.value).toBe(1)
    expect(b.undoDepth.value).toBe(1)
    scope.stop()
  })
})

// ---------------------------------------------------------------------------
// I. 纯内核
// ---------------------------------------------------------------------------

describe('撤回内核纯函数', () => {
  it('diffSnapshots：什么都没变 → 零条记录（noop 不登记）', () => {
    const notes = [mkNote({ id: 'a' })]
    const before = snapshotNotes(notes)
    expect(diffSnapshots(before, notes)).toEqual([])
  })

  it('diffSnapshots：只认真正变了的字段', () => {
    const notes = [mkNote({ id: 'a', title: 'A', folder: '' })]
    const before = snapshotNotes(notes)
    notes[0].folder = 'X'
    notes[0].updatedAt = new Date('2025-01-01T00:00:00.000Z')

    const records = diffSnapshots(before, notes)
    expect(records.length).toBe(1)
    // updatedAt 刻意不在比对字段里：它每次操作都会刷新，拿它当判据
    // 会让「移动之后随手改一个字」就把撤回判死
    expect(records[0].fields).toEqual(['folder'])
  })

  it('diffSnapshots：新增记为 __existence__', () => {
    const notes = [mkNote({ id: 'a' })]
    const before = snapshotNotes(notes)

    notes.push(mkNote({ id: 'b', title: 'B' }))
    const added = diffSnapshots(before, notes)
    expect(added.length).toBe(1)
    expect(added[0].id).toBe('b')
    expect(added[0].existedBefore).toBe(false)
    expect(added[0].existedAfter).toBe(true)
    expect(added[0].fields).toEqual(['__existence__'])
  })

  it('diffSnapshots：删除记为 __existence__，并保留可供插回的完整快照', () => {
    const notes = [mkNote({ id: 'a', title: 'A', content: '# A\n\n别丢' })]
    const before = snapshotNotes(notes)

    notes.shift()
    const removed = diffSnapshots(before, notes)
    expect(removed.length).toBe(1)
    expect(removed[0].id).toBe('a')
    expect(removed[0].existedAfter).toBe(false)
    expect(removed[0].fields).toEqual(['__existence__'])
    // 完整快照：撤回要靠它把笔记原样插回库里，少一个字段就是永久错位
    expect(removed[0].before.content).toBe('# A\n\n别丢')
    expect(removed[0].before.index).toBe(0)
  })

  it('valuesEqual：Date 比时间戳、null/undefined 互等、NaN 互等', () => {
    expect(valuesEqual(new Date(1), new Date(1))).toBe(true)
    expect(valuesEqual(new Date(1), new Date(2))).toBe(false)
    expect(valuesEqual(null, undefined)).toBe(true)
    expect(valuesEqual(null, 'x')).toBe(false)
    expect(valuesEqual(NaN, NaN)).toBe(true)
    expect(valuesEqual('A', 'A')).toBe(true)
  })

  it('validateUndoEntry：没有宿主 → no-host（不假装能撤）', () => {
    const notes = [mkNote({ id: 'a' })]
    const before = snapshotNotes(notes)
    notes[0].folder = 'X'
    const entry = pushUndoEntry({
      kind: 'move',
      label: 'x',
      records: diffSnapshots(before, notes)
    })
    expect(validateUndoEntry(entry, null).code).toBe('no-host')
    clearUndo()
  })

  it('pushUndoEntry：空记录不入栈', () => {
    expect(pushUndoEntry({ kind: 'move', label: 'x', records: [] })).toBe(null)
    expect(getUndoStack().length).toBe(0)
  })
})
