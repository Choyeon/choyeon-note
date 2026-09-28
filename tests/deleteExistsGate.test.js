/**
 * C2 · 删除前的存在性前置闸门（N3 + N1 同根同源）
 *
 * 两条 QA 遗留 P3 不阻塞项：
 *   N3 —— 「文件本就不存在」被判成删除失败。新建一篇笔记不敲字直接删，
 *         W4 之后会弹「没能删除笔记…原因：文件不存在」，得点第二次才删掉；
 *         W4 之前是一次删掉，所以这是 W4 引入的轻微回退（数据不丢、有提示、
 *         二次可成，故不阻塞）。
 *   N1 —— 同一个场景里，失败分支的 flushSave 兜底把 filePath 从 null 补成
 *         真路径，diffSnapshots 认 filePath 字段 → 产出记录 → 撤回栈被塞进
 *         一条 kind:'delete'、label「已删除「X」」、而笔记其实还在库里的
 *         **名不副实**条目。
 *
 * 一个闸门同时解决两条：删之前先 fileExists 探一次，确认不在 = 没东西可删 =
 * 不算失败 → 正常出库（不再进失败分支 → 不再 flushSave → filePath 不变 →
 * diff 只产出「真的删掉了」这一条真实记录）。
 *
 * 本文件同时钉住三条**硬约束**（改坏了这里会立刻红）：
 *   H-1 fileExists 不可用时必须回退到「照旧尝试 delete」，不能因为拿不到
 *       探测能力就删不掉东西；
 *   H-2 fileExists 抛异常 / 回 undefined → 按「未知」处理，仍然尝试 delete；
 *   H-3 W4 的 flushSave 兜底**仍然是承重件** —— 只是「新建未落盘」这个场景
 *       不再走失败分支，真文件删不掉时它照旧把改动补回磁盘。
 *
 * 每条都过故障注入自检（见交付报告 FI-1 ~ FI-5）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { clearUndo, getUndoStack } from '../src/composables/useFileUndo'
import { useNoteStore } from '../src/stores/note'
import { useAppStore } from '../src/stores/app'
import { cancelPendingIdMapSave, flushIdMapSave } from '../src/utils/idMapStore'
import { TRASH_METHOD_SYSTEM } from '../src/utils/trashState'

const ROOT = 'C:/yk'

let store
let appStore
let disk
let errSpy
let warnSpy

/**
 * 假磁盘：刻意做成**真实语义** —— 文件不存在时 deleteFile 回 ENOENT。
 * N3 之所以会出现，就是因为真实主进程就是这个语义；mock 若无条件返回成功，
 * 这组用例全部退化成自证。
 */
function createDisk () {
  const files = new Map()
  const listed = new Map()
  const seedListed = (absPath) => {
    const i = String(absPath).lastIndexOf('/')
    if (i < 0) return
    const dir = absPath.slice(0, i)
    const name = absPath.slice(i + 1)
    const list = listed.get(dir) || []
    if (!list.some(e => e.name === name)) list.push({ name })
    listed.set(dir, list)
  }
  const disk = {
    files,
    listed,
    deleteFileImpl: async (p) => {
      if (!files.has(p)) {
        return { ok: false, error: 'ENOENT', errno: -4058, message: '文件不存在' }
      }
      files.delete(p)
      return { ok: true, method: TRASH_METHOD_SYSTEM, path: p }
    },
    fileExistsImpl: async (p) => files.has(p)
  }
  disk.api = {
    writeFile: vi.fn(async (p, c) => {
      files.set(p, c)
      seedListed(p)
      return true
    }),
    moveFile: vi.fn(async (from, to) => {
      if (files.has(from)) { files.set(to, files.get(from)); files.delete(from); return true }
      return false
    }),
    createDirectory: vi.fn(async () => true),
    readDirectory: vi.fn(async (d) => listed.get(d) || []),
    readFile: vi.fn(async (p) => (files.has(p) ? files.get(p) : null)),
    removeDir: vi.fn(async () => ({ ok: true, method: 'library-trash' })),
    fileExists: vi.fn((p) => disk.fileExistsImpl(p)),
    deleteFile: vi.fn((p) => disk.deleteFileImpl(p))
  }
  return disk
}

function mkNote (over = {}) {
  const base = {
    id: 'a',
    title: 'A',
    folder: '',
    content: '# A\n\n正文A\n',
    tags: [],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    wordCount: 0,
    charCount: 0,
    lineCount: 2,
    filePath: `${ROOT}/A.md`
  }
  return { ...base, ...over }
}

const byId = (id) => store.notes.find(n => n.id === id)

/** 内存 + 磁盘都有，且已登记 id ↔ path 绑定 */
async function addBoundNote (over = {}) {
  const note = mkNote(over)
  store.notes.push(note)
  disk.files.set(note.filePath, note.content)
  await store.saveNoteToFile(note, note.folder || '')
  await flushIdMapSave()
  return note
}

/**
 * 「名不副实」的撤回条目 = 一条写着「已删除」、可它点名那篇笔记还在库里。
 * N1 说的就是它。任何时候这个数组都必须是空的。
 */
function phantomDeleteEntries () {
  const out = []
  for (const entry of getUndoStack()) {
    for (const rec of entry.records || []) {
      if (rec.existedBefore && !rec.existedAfter && byId(rec.id)) {
        out.push({ kind: entry.kind, label: entry.label, id: rec.id })
      }
    }
  }
  return out
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  clearUndo()
  cancelPendingIdMapSave()

  disk = createDisk()
  window.electronAPI = disk.api
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  appStore = useAppStore()
  store = useNoteStore()
  store.notesPath = ROOT
  store.notes.length = 0
})

afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  for (const toast of [...appStore.toasts]) appStore.dismissToast(toast.id)
  delete window.electronAPI
  cancelPendingIdMapSave()
})

// ---------------------------------------------------------------------------
// N3 · 新建未落盘的笔记：一次删除就该删掉（W4 之前的行为）
// ---------------------------------------------------------------------------
describe('N3 · 「文件本就不存在」不算删除失败', () => {
  it('N3a ★ 新建未敲字的笔记 → 一次删除即出库，无失败原因、无删除方式', async () => {
    const note = store.createNote('', 'N3')
    // 前置条件：新笔记既没 filePath，磁盘上也没有它（否则这条用例空转）
    expect(note.filePath, '前置条件：新笔记还没落盘').toBeFalsy()
    expect(disk.files.has(`${ROOT}/N3.md`), '前置条件：磁盘上不该有它').toBe(false)

    await store.deleteNote(note.id)

    expect(byId(note.id), '★ N3：一次没删掉，还在库里（W4 的回退）').toBeUndefined()
    expect(store.lastDeleteError, '不该把「没有文件可删」报成失败').toBe('')
    // 什么都没删 → 不该上报删除方式（Sidebar 读到它就会谎报进了回收站）
    expect(store.lastTrashMethod, '没删任何东西却上报了方式').toBe('')
  })

  it('N3b ★ 一次删除即可，且不用第二次（连续删两次也不报错）', async () => {
    const note = store.createNote('', 'N3b')

    await store.deleteNote(note.id)
    expect(byId(note.id), '第一次就该删掉').toBeUndefined()

    // 第二次是空操作（笔记已经不在了），不许抛、不许污染状态
    await store.deleteNote(note.id)
    expect(store.lastDeleteError).toBe('')
    expect(byId(note.id)).toBeUndefined()
  })

  it('N3c 两个候选都不存在 → 一个 deleteFile 都不该发（省掉必然失败的 IPC）', async () => {
    const note = store.createNote('', 'N3c')

    await store.deleteNote(note.id)

    expect(byId(note.id)).toBeUndefined()
    expect(disk.api.deleteFile, '确认不存在还去调 deleteFile = 闸门没生效').not.toHaveBeenCalled()
  })

  it('N3d 有磁盘副本的老笔记照旧真删（闸门不能把真文件放过）', async () => {
    await addBoundNote({ id: 'a', title: 'A' })

    await store.deleteNote('a')

    expect(byId('a')).toBeUndefined()
    expect(disk.files.has(`${ROOT}/A.md`), '真文件没被删掉').toBe(false)
    expect(store.lastTrashMethod, '真删掉了就该上报方式').toBe(TRASH_METHOD_SYSTEM)
    expect(disk.api.deleteFile).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// N1 · 撤回栈里不许出现「已删除「X」」但笔记还在的名不副实条目
// ---------------------------------------------------------------------------
describe('N1 · 删除后的撤回栈：条目与库里的事实必须一致', () => {
  it('N1a ★ 新建未落盘的笔记删除后，撤回栈里没有名不副实的条目', async () => {
    const note = store.createNote('', 'N1')

    await store.deleteNote(note.id)

    expect(byId(note.id), '笔记确实被删掉了').toBeUndefined()
    expect(phantomDeleteEntries(), '★ N1：栈里有「已删除」但笔记还在的条目').toEqual([])
  })

  it('N1b ★ 那条撤回条目是**真实**的：撤销能把笔记原样撤回来', async () => {
    const note = store.createNote('', 'N1b')
    await store.deleteNote(note.id)
    const stack = getUndoStack()
    // 这是**期望**的一条：笔记真被删了，登记一条撤回是对的（别和 N1a 搞混）
    expect(stack.length, '真删掉了就该登记一条可撤回的记录').toBe(1)
    expect(stack[0].kind).toBe('delete')

    const res = await store.undoLastFileOperation()

    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(byId(note.id), '撤销之后笔记该回来').toBeTruthy()
    expect(byId(note.id).title).toBe('N1b')
  })

  it('N1c 真文件删不掉（失败分支）→ 撤回栈仍是空的（W4 语义不变）', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    disk.deleteFileImpl = async () => ({ ok: false, message: '回收站不可用' })

    await store.deleteNote('a')

    expect(byId('a')).toBeTruthy()
    expect(getUndoStack().length, '失败却登记了撤回条目').toBe(0)
    expect(phantomDeleteEntries()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// H-1 · 没有 fileExists 能力 → 回退到现有行为（直接 delete，失败即失败）
//       「拿不到探测能力」绝不能变成「删不掉东西」
// ---------------------------------------------------------------------------
describe('H-1 · fileExists 不可用时回退到旧行为', () => {
  it('H-1a ★ 没有 fileExists → 真文件照旧删得掉（不能因为探测缺失而删不掉）', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    delete window.electronAPI.fileExists
    expect(typeof window.electronAPI.fileExists).toBe('undefined')

    await store.deleteNote('a')

    expect(byId('a'), '没有 fileExists 就删不掉 = 功能残废').toBeUndefined()
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(false)
    expect(store.lastDeleteError).toBe('')
  })

  it('H-1b 没有 fileExists → 回到 W4 的旧行为：无文件的笔记第一次删会失败', async () => {
    const note = store.createNote('', 'H1b')
    delete window.electronAPI.fileExists

    await store.deleteNote(note.id)

    // 这就是「回退到现状」的可观测证据：探测能力缺失时不替用户做决定，
    // 该失败就失败（用户能看到原因、点第二次仍能删掉）。
    expect(byId(note.id), '拿不到 fileExists 时应当回退到「尝试删除 → 失败」').toBeTruthy()
    expect(store.lastDeleteError).toBeTruthy()
  })

  it('H-1c 没有 fileExists → 真文件删不掉时照旧不出库', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    delete window.electronAPI.fileExists
    disk.deleteFileImpl = async () => ({ ok: false, message: '回收站不可用' })

    await store.deleteNote('a')

    expect(byId('a')).toBeTruthy()
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(true)
    expect(store.lastDeleteError).toContain('回收站不可用')
  })
})

// ---------------------------------------------------------------------------
// H-2 · fileExists 自己不可靠（抛异常 / 回 undefined）→ 按「未知」处理，
//       仍然尝试 delete。探测失败不该让文件留在磁盘上。
// ---------------------------------------------------------------------------
describe('H-2 · 探测无结论时必须保守地仍然尝试删除', () => {
  it('H-2a ★ fileExists 抛异常 → 仍然 delete，真文件照旧被删掉', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    disk.fileExistsImpl = async () => { throw new Error('EBUSY: 探测不了') }

    await store.deleteNote('a')

    expect(disk.api.deleteFile, '探测失败就不删了 → 文件留在磁盘上').toHaveBeenCalled()
    expect(byId('a')).toBeUndefined()
    expect(disk.files.has(`${ROOT}/A.md`), '探测失败导致文件没删掉').toBe(false)
  })

  it('H-2b fileExists 回 undefined（不是布尔）→ 同样按未知处理', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    disk.fileExistsImpl = async () => undefined

    await store.deleteNote('a')

    expect(disk.api.deleteFile).toHaveBeenCalled()
    expect(byId('a')).toBeUndefined()
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(false)
  })

  it('H-2c 未知状态下 deleteFile 失败 → 照旧走 W4 的失败分支（不出库）', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    disk.fileExistsImpl = async () => { throw new Error('EBUSY: 探测不了') }
    disk.deleteFileImpl = async () => ({ ok: false, message: '回收站不可用' })

    await store.deleteNote('a')

    expect(byId('a'), '探测未知 + 删除失败 → 必须留在库里').toBeTruthy()
    expect(store.lastDeleteError).toContain('回收站不可用')
    expect(store.lastTrashMethod).toBe('')
  })
})

// ---------------------------------------------------------------------------
// H-3 · W4 的 flushSave 兜底仍然是承重件
//       —— C2-A 只是让「新建未落盘」不再走失败分支，兜底本身不许被弄坏
// ---------------------------------------------------------------------------
describe('H-3 · 删除失败后的 flushSave 兜底仍是承重件', () => {
  it('H-3a ★ 文件真存在 + 有挂起写入 + 删不掉 → 改动被补回磁盘', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    store.updateNoteContent('a', '# A\n\n刚敲的字\n')
    expect(store.isNoteDirty('a'), '前置条件：应有挂起写入').toBe(true)
    disk.deleteFileImpl = async () => ({ ok: false, message: '回收站不可用' })

    await store.deleteNote('a')

    expect(byId('a'), '删不掉就该留在库里').toBeTruthy()
    // ★ 兜底还在：刚敲的字被写回磁盘，重启不丢
    expect(disk.files.get(`${ROOT}/A.md`), '★ flushSave 兜底被弄坏了：改动没回盘')
      .toContain('刚敲的字')
    expect(store.isNoteDirty('a'), '回盘之后不该还挂着 dirty').toBe(false)
  })

  it('H-3b 兜底被摘掉时这条会红（挂起写入留在内存里、磁盘上还是旧内容）', async () => {
    await addBoundNote({ id: 'a', title: 'A', content: '# A\n\n旧内容\n' })
    store.updateNoteContent('a', '# A\n\n新内容\n')
    disk.deleteFileImpl = async () => ({ ok: false, message: '回收站不可用' })

    await store.deleteNote('a')

    // 对照组语义：只要兜底在，磁盘上看到的必然是「新内容」而不是「旧内容」
    expect(disk.files.get(`${ROOT}/A.md`)).not.toContain('旧内容')
    expect(disk.files.get(`${ROOT}/A.md`)).toContain('新内容')
  })
})

// ---------------------------------------------------------------------------
// 边界：多候选 / 浏览器模式 / 状态不串味
// ---------------------------------------------------------------------------
describe('存在性闸门的边界', () => {
  it('B1 一个存在、一个不存在 → 只删存在的那条（另一条不该发 IPC）', async () => {
    await addBoundNote({ id: 'a', title: 'New', filePath: `${ROOT}/Old.md` })
    // 标题推出来的 New.md 磁盘上没有；Old.md 有
    expect(disk.files.has(`${ROOT}/Old.md`)).toBe(true)
    expect(disk.files.has(`${ROOT}/New.md`)).toBe(false)

    await store.deleteNote('a')

    expect(byId('a')).toBeUndefined()
    const called = disk.api.deleteFile.mock.calls.map(c => c[0])
    expect(called, `不该对不存在的路径发删除：${JSON.stringify(called)}`).toEqual([`${ROOT}/Old.md`])
    expect(disk.files.has(`${ROOT}/Old.md`), '存在的那个必须真被删掉').toBe(false)
  })

  it('B2 磁盘文件被外部删掉了（filePath 还在）→ 也不该报失败', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    disk.files.delete(`${ROOT}/A.md`)   // 用户在资源管理器里先删了

    await store.deleteNote('a')

    expect(byId('a'), '文件早就不在了，不该卡住出库').toBeUndefined()
    expect(store.lastDeleteError).toBe('')
  })

  it('B3 浏览器模式（无 electronAPI）→ 正常出库且不碰 IPC', async () => {
    const note = mkNote({ id: 'a', title: 'A' })
    store.notes.push(note)
    delete window.electronAPI

    await store.deleteNote('a')

    expect(byId('a'), '浏览器模式下删不掉 = 功能残废').toBeUndefined()
    expect(store.lastDeleteError).toBe('')
    expect(disk.api.deleteFile).not.toHaveBeenCalled()
  })

  it('B4 先「无可删之物」再真删 → 状态不串味', async () => {
    const ghost = store.createNote('', 'Ghost')
    await store.deleteNote(ghost.id)
    expect(store.lastDeleteError).toBe('')
    expect(store.lastTrashMethod).toBe('')

    await addBoundNote({ id: 'a', title: 'A' })
    await store.deleteNote('a')

    expect(byId('a')).toBeUndefined()
    expect(store.lastTrashMethod).toBe(TRASH_METHOD_SYSTEM)
    expect(store.lastDeleteError).toBe('')
  })
})
