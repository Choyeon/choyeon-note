// ===========================================================================
// T22 · 外部磁盘变更的定向 reconcile（R-F5 / R-F6）
//
// 这个文件回答六个问题，每条都对应一个用户能感知的痛点：
//   1. 正在 A 里打字，外部改了 B —— A 的 content 一个字节都不许动（R-F5 主验收）；
//   2. dirty / 当前笔记被外部改 —— 入冲突队列，content 不动，用户自己选（R-F6）；
//   3. 选「磁盘版」就是磁盘版，选「我的修改」就是我的修改 + 覆盖回磁盘；
//   4. add 入库、unlink 出库，且都是**定向**的（只动那一条）；
//   5. 非笔记文件（.canvas）不触发任何库变更；
//   6. **绝不调用 loadNotesFromPath**（整库全量重载 = R-F5 的根因）。
//
// 为什么用**真 Pinia**（与 tests/noteIdStability.test.js 同口径）：
//   手搓 store 替身只能断言「某个方法被调了」。这里要断言的是「内存里的笔记内容、
//   对象引用、脏标记、磁盘内容」四者的真实一致性 —— 一旦有人把 apply 改回整库
//   重载，或者对 dirty 笔记直接覆盖 content，用例必须直接变红。
//
// 为什么自己 mock `window.electronAPI`：
//   vite.config.js 只配了 `environment: 'jsdom'`，**没有 setup 文件**，所以每个
//   要用 IPC 的用例必须自行 mock 并在 afterEach 还原。
//
// 唯一一处「注入」是 dirtyNotes：note.js 目前没把它导出（见交付说明 §4），
// 因此门面接受一个外部 Set。除它之外 notes / currentNoteId / saveNoteToFile /
// updateNoteContent 全部走真实 store。
//
// ⚠️ 断言一律用「载入之后实际读到的值」，不拿种子常量硬比：
//   loadNotesFromPath 尾巴上会跑一次日期固化迁移（T18），它可能给笔记补一段
//   frontmatter。拿种子常量硬比会在迁移行为变化时假红 —— 那不是本用例要守的东西。
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNoteStore } from '../src/stores/note'
import {
  createReconciler,
  createNoteStoreFacade,
  useExternalSync,
  normalizePath,
  fileNameOf,
  deriveTitle,
  deriveFolder,
  buildPreview,
  describeSyncResult,
  describeRemovedDirty,
  CONFLICT_REASONS,
  CONFLICT_PREVIEW_LIMIT,
  SYNC_KINDS
} from '../src/composables/useExternalSync'
import { pathHashId } from '../src/utils/noteIdentity'
import { EXT_PATTERN } from '../src/constants/noteFile'
import { setLogLevel, resetLogger, clearRingBuffer } from '../src/utils/logger.js'
import { cancelPendingIdMapSave } from '../src/utils/idMapStore'

/** 虚拟库根目录。刻意用正斜杠：note.js 的 buildFilePath 就是正斜杠硬拼 */
const ROOT = 'C:/notes'

const P_A = `${ROOT}/A.md`
const P_B = `${ROOT}/B.md`
const P_C = `${ROOT}/C.md`
const P_D = `${ROOT}/D.md` // 只在磁盘上、库里没有（测「未知路径的 change」）
const P_CANVAS = `${ROOT}/画板.canvas`

const C_A = '# 笔记A\n\n正文A'
const C_B = '# 笔记B\n\n正文B'
const C_C = '# 笔记C\n\n正文C'

/** 门面里那个会炸的 loadNotesFromPath 抛出的标记 */
const BOOM = 'RECONCILE_BOOM: 绝不允许整库全量重载'

// ---------------------------------------------------------------------------
// 假磁盘 + 真 store
// ---------------------------------------------------------------------------

/**
 * 建一套最小可用的 `window.electronAPI` 替身。
 * @returns {object} 假磁盘（files 是 path → content）
 */
function createDisk () {
  const files = new Map()
  /**
   * 按路径取内容，兼容反斜杠分隔符（真实磁盘在 Windows 上给回来的就是 `\`，
   * note.js 自己的 lookupContent 也做了同样的宽松匹配）。
   * @param {string} p 路径
   * @returns {string|null} 内容
   */
  const read = (p) => {
    if (files.has(p)) return files.get(p)
    const relaxed = String(p).replace(/\\/g, '/')
    return files.has(relaxed) ? files.get(relaxed) : null
  }
  const api = {
    readFile: vi.fn(async (p) => read(p)),
    readFiles: vi.fn(async ({ paths }) => ({
      files: paths.map(p => ({ path: p, content: read(p) })).filter(f => f.content !== null),
      errors: []
    })),
    writeFile: vi.fn(async (p, content) => {
      files.set(p, content)
      return true
    }),
    fileExists: vi.fn(async (p) => files.has(p) || files.has(String(p).replace(/\\/g, '/'))),
    createDirectory: vi.fn(async () => true),
    deleteFile: vi.fn(async (p) => {
      files.delete(p)
      return true
    }),
    moveFile: vi.fn(async () => true),
    removeDir: vi.fn(async () => true),
    readDirectory: vi.fn(async () => []),
    readDirectoryRecursive: vi.fn(async (dir) => {
      const base = String(dir).replace(/\/+$/, '')
      return [...files.keys()]
        .filter(p => p.startsWith(base + '/'))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map(p => {
          const relativePath = p.slice(base.length + 1)
          const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
          return {
            path: p,
            name,
            relativePath,
            ctime: new Date('2020-05-06T07:08:09.000Z'),
            mtime: new Date('2024-01-02T03:04:05.000Z')
          }
        })
    }),
    setNotesPath: vi.fn(async () => true)
  }
  return { files, api }
}

/** 收集型 logger：让「记了什么」也能被断言，同时不污染测试输出 */
function createLogSpy () {
  const rows = []
  const push = level => (msg, data) => rows.push({ level, msg, data })
  return {
    rows,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error')
  }
}

let disk = null
let store = null
let dirtyNotes = null
let facade = null
let reconciler = null
let logSpy = null
/** 门面上 loadNotesFromPath 的调用记录（正常情况下必须恒为空） */
let reloadCalls = null

/**
 * 按路径取库里的笔记。
 * @param {string} path 路径
 * @returns {object|null} 笔记
 */
function noteAt (path) {
  return store.notes.find(n => n.filePath === path) || null
}

/**
 * 取某篇笔记的 content。
 * @param {string} path 路径
 * @returns {string} 正文
 */
function contentAt (path) {
  const note = noteAt(path)
  return note ? note.content : ''
}

beforeEach(async () => {
  setLogLevel('silent')
  setActivePinia(createPinia())

  disk = createDisk()
  disk.files.set(P_A, C_A)
  disk.files.set(P_B, C_B)
  disk.files.set(P_C, C_C)
  window.electronAPI = disk.api

  store = useNoteStore()
  await store.loadNotesFromPath(ROOT)
  store.currentNoteId = noteAt(P_A).id

  dirtyNotes = new Set()
  reloadCalls = []
  logSpy = createLogSpy()

  facade = createNoteStoreFacade(store, {
    readFile: (p) => disk.api.readFile(p),
    dirtyNotes
  })
  // 这是一个**会炸**的替身：只要 reconcile 内核碰一下全量重载，用例立刻变红
  facade.loadNotesFromPath = () => {
    reloadCalls.push(1)
    throw new Error(BOOM)
  }

  reconciler = createReconciler({
    noteStore: facade,
    readFile: (p) => disk.api.readFile(p),
    log: logSpy,
    isNoteExtension: (p) => EXT_PATTERN.test(String(p || ''))
  })
})

afterEach(() => {
  store.clearPendingSaves()
  cancelPendingIdMapSave()
  clearRingBuffer()
  resetLogger()
  setLogLevel('info')
  delete window.electronAPI
  vi.restoreAllMocks()
})

// ===========================================================================
// A · 纯工具（不依赖 store）：路径 / 标题 / 预览
// ===========================================================================

describe('A · 纯工具：路径 / 标题 / 预览', () => {
  it('A1 normalizePath 把 Windows 反斜杠换成正斜杠，非字符串一律成空串', () => {
    expect(normalizePath('C:\\notes\\A.md')).toBe('C:/notes/A.md')
    expect(normalizePath('C:/notes/A.md')).toBe('C:/notes/A.md')
    expect(normalizePath(null)).toBe('')
    expect(normalizePath(undefined)).toBe('')
    expect(normalizePath(123)).toBe('')
  })

  it('A2 fileNameOf 取最后一段', () => {
    expect(fileNameOf('C:/notes/sub/A.md')).toBe('A.md')
    expect(fileNameOf('A.md')).toBe('A.md')
    expect(fileNameOf(null)).toBe('')
  })

  it('A3 deriveTitle 认正文首个 H1', () => {
    expect(deriveTitle('# 标题一\n\n正文', P_A)).toBe('标题一')
  })

  it('A4 deriveTitle 没有 H1 时退回文件名（去扩展名）', () => {
    expect(deriveTitle('没有标题的正文', 'C:/notes/无标题.md')).toBe('无标题')
  })

  it('A5 deriveTitle 不把 frontmatter 里的 YAML 注释当成标题（与 updateNoteContent 同口径）', () => {
    const content = '---\n# 这是一条注释\ntags: [x]\n---\n\n# 真标题\n'
    expect(deriveTitle(content, P_A)).toBe('真标题')
  })

  it('A6 deriveFolder 由库根推导相对目录；根目录本身是空串', () => {
    expect(deriveFolder('C:/notes/A.md', 'C:/notes')).toBe('')
    expect(deriveFolder('C:/notes/工作/B.md', 'C:/notes')).toBe('工作')
    expect(deriveFolder('C:/notes/工作/子目录/B.md', 'C:/notes')).toBe('工作/子目录')
  })

  it('A7 deriveFolder 拿不到库根 / 路径不在库里时返回空串（不猜层级）', () => {
    expect(deriveFolder('C:/notes/A.md', '')).toBe('')
    expect(deriveFolder('D:/别的库/A.md', 'C:/notes')).toBe('')
  })

  it('A8 buildPreview 超限截断并写明总字符数', () => {
    const long = 'x'.repeat(CONFLICT_PREVIEW_LIMIT + 50)
    const preview = buildPreview(long)
    expect(preview.length).toBeLessThan(long.length)
    expect(preview).toContain(`共 ${long.length} 字符`)
  })

  it('A9 buildPreview 把 CRLF 统一成 LF，并把控制字符换成空格（不出现裸控制字节）', () => {
    const preview = buildPreview('a\r\nb\u0000c\u0007d')
    expect(preview).toBe('a\nb c d')
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(preview)).toBe(false)
  })

  it('A10 buildPreview 非字符串入参不炸', () => {
    expect(buildPreview(null)).toBe('')
    expect(buildPreview(undefined)).toBe('')
  })

  it('A11 describeSyncResult 拼出用户可见的摘要；无事发生时是空串', () => {
    expect(describeSyncResult({ added: 0, updated: 2, removed: 0, conflicted: 1, ignored: 0 }))
      .toBe('更新 2 篇 / 1 篇冲突待处理')
    expect(describeSyncResult({ added: 0, updated: 0, removed: 0, conflicted: 0, ignored: 3 })).toBe('')
  })

  it('A12 describeRemovedDirty 说清「未保存修改没写进磁盘」', () => {
    const text = describeRemovedDirty({ title: '日记', path: P_B })
    expect(text).toContain('日记')
    expect(text).toContain('未保存')
  })

  it('A13 契约常量：三种 kind 与三种冲突原因都在', () => {
    expect(Array.from(SYNC_KINDS)).toEqual(['add', 'change', 'unlink'])
    expect(typeof CONFLICT_REASONS.dirty).toBe('string')
    expect(typeof CONFLICT_REASONS.current).toBe('string')
    expect(typeof CONFLICT_REASONS.dirtyCurrent).toBe('string')
  })
})

// ===========================================================================
// B · R-F5 主验收：改 B 绝不动 A
// ===========================================================================

describe('B · R-F5 主验收：正在编辑 A，外部改 B', () => {
  it('B1 A 正在编辑（dirty + current），外部改 B → A 的 content 引用与字节都不变，B 被定向更新', async () => {
    const noteA = noteAt(P_A)
    const beforeA = noteA.content
    const beforeAUpdatedAt = noteA.updatedAt
    dirtyNotes.add(noteA.id)
    expect(store.currentNoteId).toBe(noteA.id)
    expect(beforeA).toContain('正文A')

    disk.files.set(P_B, '# 笔记B\n\n外部改过的B')

    const result = await reconciler.apply([{ path: P_B, kind: 'change' }])

    // A：对象还是那一个对象，内容逐字节相同，连 updatedAt 都没被碰
    expect(noteAt(P_A)).toBe(noteA)
    expect(noteA.content).toBe(beforeA)
    expect(noteA.updatedAt).toBe(beforeAUpdatedAt)
    // B：被定向更新成磁盘上的新内容
    expect(contentAt(P_B)).toBe('# 笔记B\n\n外部改过的B')
    // 计数
    expect(result.updated).toBe(1)
    expect(result.conflicted).toBe(0)
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
  })

  it('B2 A 的标题 / 字数统计 / 标签同样一个字段都不许变', async () => {
    const noteA = noteAt(P_A)
    const snapshot = {
      title: noteA.title,
      wordCount: noteA.wordCount,
      charCount: noteA.charCount,
      lineCount: noteA.lineCount,
      folder: noteA.folder,
      filePath: noteA.filePath,
      tags: JSON.stringify(noteA.tags)
    }
    dirtyNotes.add(noteA.id)
    disk.files.set(P_B, '# 笔记B\n\n外部改过的B')

    await reconciler.apply([{ path: P_B, kind: 'change' }])

    expect({
      title: noteA.title,
      wordCount: noteA.wordCount,
      charCount: noteA.charCount,
      lineCount: noteA.lineCount,
      folder: noteA.folder,
      filePath: noteA.filePath,
      tags: JSON.stringify(noteA.tags)
    }).toEqual(snapshot)
  })

  it('B3 库里其它笔记（C）也一个字节都不动', async () => {
    const noteC = noteAt(P_C)
    const beforeC = noteC.content
    dirtyNotes.add(noteAt(P_A).id)
    disk.files.set(P_B, '# 笔记B\n\n外部改过的B')

    await reconciler.apply([{ path: P_B, kind: 'change' }])

    expect(noteC.content).toBe(beforeC)
    expect(store.notes).toHaveLength(3)
  })

  it('B4 反过来：正在编辑 B，外部改 A → B 不动，A 被更新', async () => {
    const noteB = noteAt(P_B)
    const beforeB = noteB.content
    store.currentNoteId = noteB.id
    dirtyNotes.add(noteB.id)
    disk.files.set(P_A, '# 笔记A\n\n外部改过的A')

    const result = await reconciler.apply([{ path: P_A, kind: 'change' }])

    expect(noteB.content).toBe(beforeB)
    expect(contentAt(P_A)).toBe('# 笔记A\n\n外部改过的A')
    expect(result.updated).toBe(1)
  })

  it('B5 定向更新会同步标题（与全量载入同一个 H1 口径）', async () => {
    disk.files.set(P_B, '# 全新标题\n\n正文B')

    await reconciler.apply([{ path: P_B, kind: 'change' }])

    expect(noteAt(P_B).title).toBe('全新标题')
    expect(noteAt(P_B).content).toBe('# 全新标题\n\n正文B')
  })

  it('B6 定向更新会重算字数统计与标签', async () => {
    disk.files.set(P_B, '# 笔记B\n\n#标签X #标签Y\n\n正文')

    await reconciler.apply([{ path: P_B, kind: 'change' }])

    const noteB = noteAt(P_B)
    expect(noteB.wordCount).toBeGreaterThan(0)
    expect(noteB.charCount).toBe(noteB.content.length)
    expect(noteB.tags).toContain('标签X')
  })

  it('B7 一批变更里混着多条：逐条处理，只动该动的那些', async () => {
    const noteA = noteAt(P_A)
    const beforeA = noteA.content
    dirtyNotes.add(noteA.id)
    disk.files.set(P_B, '# 笔记B\n\n改B')
    disk.files.set(P_C, '# 笔记C\n\n改C')

    const result = await reconciler.apply([
      { path: P_B, kind: 'change' },
      { path: P_C, kind: 'change' }
    ])

    expect(noteA.content).toBe(beforeA)
    expect(contentAt(P_B)).toBe('# 笔记B\n\n改B')
    expect(contentAt(P_C)).toBe('# 笔记C\n\n改C')
    expect(result.updated).toBe(2)
  })

  it('B8 空变更清单 → 全 0，且不碰库', async () => {
    const result = await reconciler.apply([])
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, conflicted: 0, ignored: 0 })
    expect(store.notes).toHaveLength(3)
  })

  it('B9 非数组入参（null / undefined）不崩，返回全 0', async () => {
    await expect(reconciler.apply(null)).resolves.toMatchObject({ added: 0, updated: 0 })
    await expect(reconciler.apply(undefined)).resolves.toMatchObject({ added: 0, updated: 0 })
    expect(store.notes).toHaveLength(3)
  })

  it('B10 SyncResult 的五个契约字段都在，且都是数字', async () => {
    disk.files.set(P_B, '# 笔记B\n\n改B')
    const result = await reconciler.apply([{ path: P_B, kind: 'change' }])
    for (const key of ['added', 'updated', 'removed', 'conflicted', 'ignored']) {
      expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(true)
      expect(typeof result[key]).toBe('number')
    }
  })
})

// ===========================================================================
// C · 冲突队列（R-F6）
// ===========================================================================

describe('C · 冲突队列：dirty / 当前笔记被外部改', () => {
  it('C1 dirty 的笔记被外部 change → 入冲突队列，content 一个字节都不动', async () => {
    const noteB = noteAt(P_B)
    const before = noteB.content
    dirtyNotes.add(noteB.id)
    disk.files.set(P_B, '# 笔记B\n\n外部版本')

    const result = await reconciler.apply([{ path: P_B, kind: 'change' }])

    expect(noteB.content).toBe(before)
    expect(result.conflicted).toBe(1)
    expect(result.updated).toBe(0)
    expect(reconciler.pendingConflicts()).toHaveLength(1)
  })

  it('C2 当前笔记被外部 change（即便非 dirty）→ 入冲突，content 不动', async () => {
    const noteA = noteAt(P_A)
    const before = noteA.content
    expect(dirtyNotes.has(noteA.id)).toBe(false)
    expect(store.currentNoteId).toBe(noteA.id)
    disk.files.set(P_A, '# 笔记A\n\n外部版本')

    const result = await reconciler.apply([{ path: P_A, kind: 'change' }])

    expect(noteA.content).toBe(before)
    expect(result.conflicted).toBe(1)
  })

  it('C3 Conflict 对象的形状严格等于契约那 6 个字段', async () => {
    const noteB = noteAt(P_B)
    dirtyNotes.add(noteB.id)
    disk.files.set(P_B, '# 笔记B\n\n外部版本')

    await reconciler.apply([{ path: P_B, kind: 'change' }])

    const [conflict] = reconciler.pendingConflicts()
    expect(Object.keys(conflict).sort()).toEqual(
      ['diskPreview', 'id', 'memoryPreview', 'path', 'reason', 'title'].sort()
    )
    expect(conflict.id).toBe(noteB.id)
    expect(conflict.path).toBe(P_B)
    expect(conflict.title).toBe('笔记B')
    expect(conflict.diskPreview).toContain('外部版本')
    expect(conflict.memoryPreview).toContain('正文B')
    expect(typeof conflict.reason).toBe('string')
  })

  it('C4 reason 区分「有未保存修改」「正在编辑」「两者都有」', async () => {
    const idA = noteAt(P_A).id
    const idB = noteAt(P_B).id
    const idC = noteAt(P_C).id

    // 第一轮：A 是当前笔记且有未保存修改；B 只是有未保存修改
    dirtyNotes.add(idA)
    dirtyNotes.add(idB)
    disk.files.set(P_A, '# 笔记A\n\n外部')
    disk.files.set(P_B, '# 笔记B\n\n外部')
    await reconciler.apply([
      { path: P_A, kind: 'change' },
      { path: P_B, kind: 'change' }
    ])

    const byId = new Map(reconciler.pendingConflicts().map(c => [c.id, c]))
    expect(byId.get(idA).reason).toBe(CONFLICT_REASONS.dirtyCurrent)
    expect(byId.get(idB).reason).toBe(CONFLICT_REASONS.dirty)

    // 第二轮：把当前指针挪到 C（C 没有未保存修改）
    store.currentNoteId = idC
    dirtyNotes.delete(idA)
    dirtyNotes.delete(idB)
    disk.files.set(P_C, '# 笔记C\n\n外部')
    await reconciler.apply([{ path: P_C, kind: 'change' }])

    const cEntry = reconciler.pendingConflicts().find(c => c.id === idC)
    expect(cEntry.reason).toBe(CONFLICT_REASONS.current)
  })

  it('C5 同一篇被反复 change → 队列里仍只有一条，但磁盘预览刷新到最新', async () => {
    const noteB = noteAt(P_B)
    const before = noteB.content
    dirtyNotes.add(noteB.id)
    disk.files.set(P_B, '# 笔记B\n\n第一版')

    const first = await reconciler.apply([{ path: P_B, kind: 'change' }])
    expect(first.conflicted).toBe(1)

    disk.files.set(P_B, '# 笔记B\n\n第二版')
    const second = await reconciler.apply([{ path: P_B, kind: 'change' }])
    expect(second.conflicted).toBe(0)
    expect(reconciler.pendingConflicts()).toHaveLength(1)
    expect(reconciler.pendingConflicts()[0].diskPreview).toContain('第二版')
    expect(noteB.content).toBe(before)
  })

  it('C6 pendingConflicts 的顺序 = 入队顺序', async () => {
    dirtyNotes.add(noteAt(P_B).id)
    dirtyNotes.add(noteAt(P_C).id)
    disk.files.set(P_B, '# 笔记B\n\n外部')
    disk.files.set(P_C, '# 笔记C\n\n外部')

    await reconciler.apply([
      { path: P_C, kind: 'change' },
      { path: P_B, kind: 'change' }
    ])

    expect(reconciler.pendingConflicts().map(c => c.path)).toEqual([P_C, P_B])
  })

  it('C7 非 dirty 且非当前笔记 → 直接更新，不入冲突', async () => {
    const before = store.currentNoteId
    disk.files.set(P_C, '# 笔记C\n\n外部版本')

    const result = await reconciler.apply([{ path: P_C, kind: 'change' }])

    expect(result.updated).toBe(1)
    expect(result.conflicted).toBe(0)
    expect(reconciler.pendingConflicts()).toHaveLength(0)
    expect(store.currentNoteId).toBe(before)
  })

  it('C8 冲突期间磁盘读不出来 → 计 ignored，绝不拿空内容改内存', async () => {
    const noteB = noteAt(P_B)
    const before = noteB.content
    dirtyNotes.add(noteB.id)
    disk.api.readFile = vi.fn(async () => { throw new Error('EACCES') })

    const result = await reconciler.apply([{ path: P_B, kind: 'change' }])

    expect(noteB.content).toBe(before)
    expect(result.ignored).toBe(1)
    expect(result.conflicted).toBe(0)
  })
})

// ===========================================================================
// D · 冲突解决
// ===========================================================================

describe('D · resolveConflict：磁盘版 / 内存版二选一', () => {
  /**
   * 在 B 上造一条冲突。
   * @returns {Promise<{ id: string, memory: string, disk: string }>} 上下文
   */
  async function seedConflict () {
    const noteB = noteAt(P_B)
    const memory = noteB.content
    const diskContent = '# 笔记B\n\n磁盘版本内容'
    dirtyNotes.add(noteB.id)
    disk.files.set(P_B, diskContent)
    await reconciler.apply([{ path: P_B, kind: 'change' }])
    return { id: noteB.id, memory, disk: diskContent }
  }

  it('D1 选 disk → 内容变成磁盘版，且脏标记被清除', async () => {
    const ctx = await seedConflict()
    await reconciler.resolveConflict(ctx.id, 'disk')

    expect(contentAt(P_B)).toBe(ctx.disk)
    expect(dirtyNotes.has(ctx.id)).toBe(false)
    expect(reconciler.pendingConflicts()).toHaveLength(0)
  })

  it('D2 选 memory → 内容保持内存版，并且写回磁盘覆盖外部改动', async () => {
    const ctx = await seedConflict()
    const writeSpy = disk.api.writeFile
    writeSpy.mockClear()

    await reconciler.resolveConflict(ctx.id, 'memory')

    expect(contentAt(P_B)).toBe(ctx.memory)
    expect(disk.files.get(P_B)).toBe(ctx.memory)
    // safeWriteFile 会多带一个 { detail: true } 的第三参，这里只认前两个
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0][0]).toBe(P_B)
    expect(writeSpy.mock.calls[0][1]).toBe(ctx.memory)
    expect(reconciler.pendingConflicts()).toHaveLength(0)
    expect(dirtyNotes.has(ctx.id)).toBe(false)
  })

  it('D3 选 disk 时再读一次磁盘：拿到的是「现在」的磁盘，不是弹窗那一刻的快照', async () => {
    const ctx = await seedConflict()
    const newest = '# 笔记B\n\n又改了一次'
    disk.files.set(P_B, newest)

    await reconciler.resolveConflict(ctx.id, 'disk')

    expect(contentAt(P_B)).toBe(newest)
  })

  it('D4 选 disk 时磁盘已被删（读不到）→ 退回入队时的快照，不把内容清空', async () => {
    const ctx = await seedConflict()
    disk.files.delete(P_B)

    await reconciler.resolveConflict(ctx.id, 'disk')

    expect(contentAt(P_B)).toBe(ctx.disk)
  })

  it('D5 未知 choice → 冲突还在队列里，content 保持内存版（绝不静默替用户选）', async () => {
    const ctx = await seedConflict()
    await reconciler.resolveConflict(ctx.id, 'whatever')

    expect(contentAt(P_B)).toBe(ctx.memory)
    expect(reconciler.pendingConflicts()).toHaveLength(1)
    expect(logSpy.rows.some(r => r.level === 'warn')).toBe(true)
  })

  it('D6 解决一条不存在的冲突不崩', async () => {
    await expect(reconciler.resolveConflict('不存在的id', 'disk')).resolves.toBeUndefined()
  })

  it('D7 resolveConflict 只动目标笔记，队列里其它冲突不受影响', async () => {
    const beforeC = contentAt(P_C)
    dirtyNotes.add(noteAt(P_B).id)
    dirtyNotes.add(noteAt(P_C).id)
    disk.files.set(P_B, '# 笔记B\n\n磁盘B')
    disk.files.set(P_C, '# 笔记C\n\n磁盘C')
    await reconciler.apply([
      { path: P_B, kind: 'change' },
      { path: P_C, kind: 'change' }
    ])
    expect(reconciler.pendingConflicts()).toHaveLength(2)

    await reconciler.resolveConflict(noteAt(P_B).id, 'disk')

    expect(reconciler.pendingConflicts()).toHaveLength(1)
    expect(reconciler.pendingConflicts()[0].path).toBe(P_C)
    expect(contentAt(P_C)).toBe(beforeC)
  })

  it('D8 等待期间笔记被删 → 冲突出队，不崩', async () => {
    const ctx = await seedConflict()
    store.notes.splice(store.notes.findIndex(n => n.id === ctx.id), 1)

    await expect(reconciler.resolveConflict(ctx.id, 'disk')).resolves.toBeUndefined()
    expect(reconciler.pendingConflicts()).toHaveLength(0)
  })
})

// ===========================================================================
// E · add / unlink
// ===========================================================================

describe('E · add / unlink：定向入库出库', () => {
  it('E1 add 新文件 → 入库，字段与全量载入同口径', async () => {
    const newPath = `${ROOT}/新建.md`
    disk.files.set(newPath, '# 新建笔记\n\n内容')

    const result = await reconciler.apply([{ path: newPath, kind: 'add' }])

    expect(result.added).toBe(1)
    expect(store.notes).toHaveLength(4)
    const note = noteAt(newPath)
    expect(note).not.toBeNull()
    expect(note.id).toBe(pathHashId(newPath))
    expect(note.title).toBe('新建笔记')
    expect(note.content).toBe('# 新建笔记\n\n内容')
    expect(note.folder).toBe('')
  })

  it('E2 add 子目录的新文件 → folder 按库根推导', async () => {
    const newPath = `${ROOT}/工作/子笔记.md`
    disk.files.set(newPath, '# 子笔记')

    await reconciler.apply([{ path: newPath, kind: 'add' }])

    expect(noteAt(newPath).folder).toBe('工作')
  })

  it('E3 add 一个读不出来的文件 → 计 ignored，绝不造空笔记', async () => {
    const result = await reconciler.apply([{ path: `${ROOT}/幽灵.md`, kind: 'add' }])
    expect(result.ignored).toBe(1)
    expect(result.added).toBe(0)
    expect(store.notes).toHaveLength(3)
  })

  it('E4 add 一个非笔记文件（.canvas）→ 计 ignored，库长度不变', async () => {
    disk.files.set(P_CANVAS, '{}')
    const result = await reconciler.apply([{ path: P_CANVAS, kind: 'add' }])
    expect(result.ignored).toBe(1)
    expect(result.added).toBe(0)
    expect(store.notes).toHaveLength(3)
  })

  it('E5 change 一个非笔记文件（.canvas）→ 计 ignored，一次库变更都没有', async () => {
    disk.files.set(P_CANVAS, '{"nodes":[]}')
    const result = await reconciler.apply([{ path: P_CANVAS, kind: 'change' }])
    expect(result.ignored).toBe(1)
    expect(result.updated).toBe(0)
    expect(store.notes).toHaveLength(3)
  })

  it('E6 unlink → 定向出库', async () => {
    const result = await reconciler.apply([{ path: P_C, kind: 'unlink' }])
    expect(result.removed).toBe(1)
    expect(store.notes).toHaveLength(2)
    expect(noteAt(P_C)).toBeNull()
  })

  it('E7 unlink 只删那一条，其它笔记与当前笔记都不动', async () => {
    const noteA = noteAt(P_A)
    const beforeA = noteA.content
    const beforeB = contentAt(P_B)
    await reconciler.apply([{ path: P_C, kind: 'unlink' }])

    expect(noteA.content).toBe(beforeA)
    expect(store.currentNoteId).toBe(noteA.id)
    expect(contentAt(P_B)).toBe(beforeB)
  })

  it('E8 unlink 一个 dirty 的笔记 → 出库 + 进 removedDirty（供 UI toast）', async () => {
    const noteC = noteAt(P_C)
    const beforeC = noteC.content
    dirtyNotes.add(noteC.id)

    const result = await reconciler.apply([{ path: P_C, kind: 'unlink' }])

    expect(result.removed).toBe(1)
    expect(result.removedDirty).toHaveLength(1)
    expect(result.removedDirty[0]).toMatchObject({ id: noteC.id, title: '笔记C', path: P_C })
    expect(result.removedDirty[0].content).toBe(beforeC)
  })

  it('E9 unlink 一个正在编辑的笔记 → 同样进 removedDirty，并把当前指针挪开', async () => {
    const noteC = noteAt(P_C)
    store.currentNoteId = noteC.id

    const result = await reconciler.apply([{ path: P_C, kind: 'unlink' }])

    expect(result.removedDirty).toHaveLength(1)
    expect(store.currentNoteId).not.toBe(noteC.id)
    expect(store.currentNoteId).toBe(noteAt(P_A).id)
  })

  it('E10 unlink 一个库里没有的路径 → 计 ignored，不崩', async () => {
    const result = await reconciler.apply([{ path: `${ROOT}/不存在.md`, kind: 'unlink' }])
    expect(result.ignored).toBe(1)
    expect(result.removed).toBe(0)
    expect(store.notes).toHaveLength(3)
  })

  it('E11 unlink 之后挂在这条路径上的冲突一并丢弃', async () => {
    dirtyNotes.add(noteAt(P_C).id)
    disk.files.set(P_C, '# 笔记C\n\n外部')
    await reconciler.apply([{ path: P_C, kind: 'change' }])
    expect(reconciler.pendingConflicts()).toHaveLength(1)

    await reconciler.apply([{ path: P_C, kind: 'unlink' }])

    expect(reconciler.pendingConflicts()).toHaveLength(0)
  })

  it('E12 未知路径（库里没有）收到 change → 按 add 入库，不崩不丢', async () => {
    disk.files.set(P_D, '# D笔记\n\n内容')

    const result = await reconciler.apply([{ path: P_D, kind: 'change' }])

    expect(result.added).toBe(1)
    expect(store.notes).toHaveLength(4)
    expect(noteAt(P_D).title).toBe('D笔记')
  })

  it('E13 已存在的路径收到 add → 走 change 判定：非 dirty 就更新，不重复入库', async () => {
    disk.files.set(P_B, '# 笔记B\n\n外部')

    const result = await reconciler.apply([{ path: P_B, kind: 'add' }])

    expect(result.added).toBe(0)
    expect(result.updated).toBe(1)
    expect(store.notes).toHaveLength(3)
    expect(contentAt(P_B)).toBe('# 笔记B\n\n外部')
  })

  it('E14 已存在的路径收到 add 且它是 dirty → 入冲突，绝不覆盖', async () => {
    const noteB = noteAt(P_B)
    const before = noteB.content
    dirtyNotes.add(noteB.id)
    disk.files.set(P_B, '# 笔记B\n\n外部')

    const result = await reconciler.apply([{ path: P_B, kind: 'add' }])

    expect(result.conflicted).toBe(1)
    expect(noteB.content).toBe(before)
  })

  it('E15 用 Windows 反斜杠路径也能命中（watcher 给的是磁盘真实分隔符）', async () => {
    disk.files.set(P_B, '# 笔记B\n\n反斜杠版本')
    const result = await reconciler.apply([{ path: 'C:\\notes\\B.md', kind: 'change' }])
    expect(result.updated).toBe(1)
    expect(contentAt(P_B)).toBe('# 笔记B\n\n反斜杠版本')
  })
})

// ===========================================================================
// F · 绝不做全量重载（R-F5 的根因）
// ===========================================================================

describe('F · 绝不调用 loadNotesFromPath', () => {
  it('F1 门面上的 loadNotesFromPath 是「一碰就炸」的替身：跑完 apply 既没抛也没被调', async () => {
    // 先证明这个陷阱是活的（这一下自己会记一笔，所以紧接着清零）
    expect(() => facade.loadNotesFromPath(ROOT)).toThrow(BOOM)
    reloadCalls.length = 0

    const noteA = noteAt(P_A)
    dirtyNotes.add(noteA.id)
    disk.files.set(P_B, '# 笔记B\n\n外部')

    await expect(reconciler.apply([{ path: P_B, kind: 'change' }])).resolves.toBeTruthy()
    expect(reloadCalls).toHaveLength(0)
  })

  it('F2 真实 store 上的 loadNotesFromPath 全程零调用（add / change / unlink 三种都跑一遍）', async () => {
    const spy = vi.spyOn(store, 'loadNotesFromPath')
    dirtyNotes.add(noteAt(P_B).id)
    disk.files.set(P_B, '# 笔记B\n\n外部')

    await reconciler.apply([{ path: P_B, kind: 'change' }])
    await reconciler.apply([{ path: P_C, kind: 'unlink' }])
    await reconciler.apply([{ path: `${ROOT}/新建.md`, kind: 'add' }])

    expect(spy).not.toHaveBeenCalled()
  })

  it('F3 笔记数组对象本身没被换掉（整库重载会 length=0 再 push）', async () => {
    const arrayRef = store.notes
    disk.files.set(P_B, '# 笔记B\n\n外部')

    await reconciler.apply([{ path: P_B, kind: 'change' }])
    await reconciler.apply([{ path: P_C, kind: 'unlink' }])

    expect(store.notes).toBe(arrayRef)
    expect(store.notes).toHaveLength(2)
  })

  it('F4 内核源码里根本不出现 store / loadNotesFromPath（静态检查）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/composables/useExternalSync.js'), 'utf8')
    // 去掉整行注释再查：注释里**当然**要写清「为什么不许调它」，那不算调用
    const code = src
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).not.toContain('stores/note')
    expect(code).not.toContain('loadNotesFromPath')
    expect(code).not.toContain('useNoteStore')
  })

  it('F5 冲突解决路径同样不许碰全量重载', async () => {
    const noteB = noteAt(P_B)
    dirtyNotes.add(noteB.id)
    disk.files.set(P_B, '# 笔记B\n\n外部')
    await reconciler.apply([{ path: P_B, kind: 'change' }])

    await reconciler.resolveConflict(noteB.id, 'disk')
    await reconciler.resolveConflict(noteB.id, 'memory')

    expect(reloadCalls).toHaveLength(0)
  })
})

// ===========================================================================
// G · 健壮性 / 接线层
// ===========================================================================

describe('G · 健壮性与 Vue 接线层', () => {
  it('G1 畸形条目（缺 path / 非对象）→ 计 ignored，不崩', async () => {
    const result = await reconciler.apply([{ kind: 'change' }, null, undefined, 42])
    expect(result.ignored).toBe(4)
    expect(store.notes).toHaveLength(3)
  })

  it('G2 未知 kind → 计 ignored 并留一条 warn', async () => {
    const result = await reconciler.apply([{ path: P_B, kind: 'rename' }])
    expect(result.ignored).toBe(1)
    expect(logSpy.rows.some(r => r.level === 'warn' && String(r.msg).includes('未知类型'))).toBe(true)
  })

  it('G3 readFile 抛异常 → 计 ignored，整批继续', async () => {
    disk.api.readFile = vi.fn(async () => { throw new Error('boom') })
    const result = await reconciler.apply([
      { path: P_B, kind: 'change' },
      { path: P_C, kind: 'change' }
    ])
    expect(result.ignored).toBe(2)
    expect(result.updated).toBe(0)
  })

  it('G4 完全不给 log → 用默认 logger，不崩', async () => {
    const bare = createReconciler({
      noteStore: facade,
      readFile: (p) => disk.api.readFile(p)
    })
    disk.files.set(P_B, '# 笔记B\n\n外部')
    await expect(bare.apply([{ path: P_B, kind: 'change' }])).resolves.toMatchObject({ updated: 1 })
  })

  it('G5 不给 isNoteExtension → 走 noteFile 白名单默认实现，.canvas 照样被忽略', async () => {
    const bare = createReconciler({
      noteStore: facade,
      readFile: (p) => disk.api.readFile(p),
      log: logSpy
    })
    disk.files.set(P_CANVAS, '{}')
    const result = await bare.apply([{ path: P_CANVAS, kind: 'change' }])
    expect(result.ignored).toBe(1)
    expect(store.notes).toHaveLength(3)
  })

  it('G6 noteStore 完全缺失 → 不崩（返回全 0）', async () => {
    const bare = createReconciler({ log: logSpy })
    await expect(bare.apply([{ path: P_B, kind: 'change' }])).resolves.toMatchObject({
      added: 0,
      updated: 0,
      conflicted: 0
    })
  })

  it('G7 并发调用两个 apply → 串行执行，计数不串台', async () => {
    disk.files.set(P_B, '# 笔记B\n\n改B')
    disk.files.set(P_C, '# 笔记C\n\n改C')
    const [r1, r2] = await Promise.all([
      reconciler.apply([{ path: P_B, kind: 'change' }]),
      reconciler.apply([{ path: P_C, kind: 'change' }])
    ])
    expect(r1.updated + r2.updated).toBe(2)
    expect(contentAt(P_B)).toBe('# 笔记B\n\n改B')
    expect(contentAt(P_C)).toBe('# 笔记C\n\n改C')
  })

  it('G8 useExternalSync：apply 后 conflicts 同步，resolve 后清空', async () => {
    const sync = useExternalSync({
      noteStore: facade,
      readFile: (p) => disk.api.readFile(p),
      log: logSpy,
      isNoteExtension: (p) => EXT_PATTERN.test(String(p || ''))
    })
    const memory = contentAt(P_B)
    dirtyNotes.add(noteAt(P_B).id)
    disk.files.set(P_B, '# 笔记B\n\n外部')

    await sync.apply([{ path: P_B, kind: 'change' }])
    expect(sync.conflicts.value).toHaveLength(1)
    expect(sync.conflicts.value[0].id).toBe(noteAt(P_B).id)
    expect(contentAt(P_B)).toBe(memory)

    // 只断言「队列空了」是不够的 —— 万一把 disk / memory 分支对调，队列照样会空。
    // 这里把「内容到底变成了哪一边」也钉死。
    await sync.resolve(sync.conflicts.value[0].id, 'disk')
    expect(sync.conflicts.value).toHaveLength(0)
    expect(contentAt(P_B)).toBe('# 笔记B\n\n外部')
  })

  it('G8b useExternalSync：选 memory 时内容保持内存版且写回磁盘', async () => {
    const sync = useExternalSync({
      noteStore: facade,
      readFile: (p) => disk.api.readFile(p),
      log: logSpy,
      isNoteExtension: (p) => EXT_PATTERN.test(String(p || ''))
    })
    const memory = contentAt(P_C)
    dirtyNotes.add(noteAt(P_C).id)
    disk.files.set(P_C, '# 笔记C\n\n外部')

    await sync.apply([{ path: P_C, kind: 'change' }])
    await sync.resolve(sync.conflicts.value[0].id, 'memory')

    expect(contentAt(P_C)).toBe(memory)
    expect(disk.files.get(P_C)).toBe(memory)
    expect(sync.conflicts.value).toHaveLength(0)
  })

  it('G9 useExternalSync：unlink 掉一篇 dirty 笔记会给上游发 toast', async () => {
    const notifications = []
    const sync = useExternalSync({
      noteStore: facade,
      readFile: (p) => disk.api.readFile(p),
      log: logSpy,
      isNoteExtension: (p) => EXT_PATTERN.test(String(p || '')),
      onNotify: (n) => notifications.push(n)
    })
    dirtyNotes.add(noteAt(P_C).id)

    await sync.apply([{ path: P_C, kind: 'unlink' }])

    expect(notifications.some(n => String(n.message).includes('已在磁盘上被删除'))).toBe(true)
  })

  it('G10 真实 store 的 dirty 机制确实存在（updateNoteContent → hasPendingSaves）', async () => {
    // 这一条是给 T24 的接线依据：dirty 是 note.js 里真实存在的状态，
    // 接线时必须把它接到门面的 dirtyNotes / isDirty 上（见交付说明 §4）
    const idB = noteAt(P_B).id
    expect(store.hasPendingSaves()).toBe(false)

    store.updateNoteContent(idB, '# 笔记B\n\n用户正在敲的字')
    expect(contentAt(P_B)).toBe('# 笔记B\n\n用户正在敲的字')
    expect(store.hasPendingSaves()).toBe(true)

    await store.flushSave(idB)
    expect(store.hasPendingSaves()).toBe(false)
  })

  it('G11 门面直接改的是 store 自己的响应式数组（不是副本）', async () => {
    const newPath = `${ROOT}/接线测试.md`
    disk.files.set(newPath, '# 接线测试')
    await reconciler.apply([{ path: newPath, kind: 'add' }])
    // store 的 computed 必须能立刻看到新笔记
    expect(store.notes.some(n => n.filePath === newPath)).toBe(true)
    expect(store.filteredNotes.some(n => n.filePath === newPath)).toBe(true)
  })
})
