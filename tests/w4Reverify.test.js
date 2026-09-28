/**
 * W4 窄范围独立复验（QA 严过关）
 *
 * 与 tests/phase4Acceptance.test.js 的 H 组**刻意不重叠**：H 组打的是「失败不出库 /
 * 归一式 / W4-C 优先级」，这里打的是失败分支**留下的状态**是否干净：
 *   · id ↔ path 绑定有没有被 forgetPath 摘掉（Y1）
 *   · currentNoteId 有没有被挪走（Y2）
 *   · 撤回栈有没有被塞进一条「名不副实」的条目（Y3）
 *   · 「新建未落盘」的笔记失败之后还能不能删掉（Y4，兼验 flushSave 兜底是不是承重件）
 *   · 失败与成功之间会不会串味（Y5）
 *   · 失败原因文案对四种返回形态的翻译（Y6）
 *
 * 每条都过故障注入自检：把实现改坏，对应那条必须变红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { clearUndo, getUndoStack } from '../src/composables/useFileUndo'
import { useNoteStore } from '../src/stores/note'
import { useAppStore } from '../src/stores/app'
import { flushIdMapSave, cancelPendingIdMapSave } from '../src/utils/idMapStore'
import { TRASH_METHOD_SYSTEM } from '../src/utils/trashState'

const ROOT = 'C:/yk'
const ID_MAP_LS_KEY = 'choyeon-note-id-map'

let store
let appStore
let disk
let errSpy

/** 读降级到 localStorage 的那张 id 映射表 */
function persistedIdMap () {
  const raw = localStorage.getItem(ID_MAP_LS_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

/** 落盘后的映射表里，这条路径还挂着哪个 id */
function persistedIdOf (p) {
  const map = persistedIdMap()
  return map && map.byPath ? map.byPath[p] || '' : ''
}

function createDisk () {
  const files = new Map()
  const listed = new Map()
  const disk = {
    files,
    listed,
    /**
     * 真实磁盘语义：文件不存在时删不掉（ENOENT），存在才删得掉并进系统回收站。
     * 这条语义是 Y4 的前提 —— 「新建但还没落盘的笔记」第一次删必然失败。
     */
    deleteFileImpl: async (p) => {
      if (!files.has(p)) {
        return { ok: false, error: 'ENOENT', errno: -4058, message: '文件不存在' }
      }
      files.delete(p)
      return { ok: true, method: TRASH_METHOD_SYSTEM, path: p }
    }
  }
  disk.api = {
    writeFile: vi.fn(async (p, c) => {
      files.set(p, c)
      const i = String(p).lastIndexOf('/')
      if (i > -1) {
        const dir = p.slice(0, i)
        const name = p.slice(i + 1)
        const list = listed.get(dir) || []
        if (!list.some(e => e.name === name)) list.push({ name })
        listed.set(dir, list)
      }
      return true
    }),
    moveFile: vi.fn(async (from, to) => {
      if (files.has(from)) { files.set(to, files.get(from)); files.delete(from); return true }
      return false
    }),
    fileExists: vi.fn(async (p) => files.has(p)),
    readDirectory: vi.fn(async (d) => listed.get(d) || []),
    createDirectory: vi.fn(async () => true),
    deleteFile: vi.fn((p) => disk.deleteFileImpl(p)),
    removeDir: vi.fn(async () => ({ ok: true, method: 'library-trash' })),
    readFile: vi.fn(async (p) => (files.has(p) ? files.get(p) : null))
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

/** 建一篇已在磁盘上、且已登记 id↔path 绑定的笔记 */
async function addBoundNote (over = {}) {
  const note = mkNote(over)
  store.notes.push(note)
  disk.files.set(note.filePath, note.content)
  // 走一次真实落盘通道：它会 rememberPath，把 path → id 写进映射表
  await store.saveNoteToFile(note, note.folder || '')
  await flushIdMapSave()
  return note
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  clearUndo()
  cancelPendingIdMapSave()

  disk = createDisk()
  window.electronAPI = disk.api
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  appStore = useAppStore()
  store = useNoteStore()
  store.notesPath = ROOT
  store.notes.length = 0
})

afterEach(() => {
  errSpy.mockRestore()
  for (const toast of [...appStore.toasts]) appStore.dismissToast(toast.id)
  delete window.electronAPI
  cancelPendingIdMapSave()
})

// ---------------------------------------------------------------------------
// Y1 · 失败分支不许解绑路径映射（forgetPath 没被调用）
// ---------------------------------------------------------------------------
describe('Y1 · 删除失败：id ↔ path 绑定必须原样留在映射表里', () => {
  it('Y1a 失败后 flush 出来的映射表仍然挂着这条路径', async () => {
    const note = await addBoundNote({ id: 'a', title: 'A' })
    // 前提：绑定确实存在（否则这条断言成了空转）
    expect(persistedIdOf(note.filePath), '前置条件：绑定应先落盘').toBe('a')

    disk.deleteFileImpl = async () => ({ ok: false, error: 'delete-failed', message: '回收站不可用' })
    await store.deleteNote('a')

    expect(byId('a'), '删除失败却出库了').toBeTruthy()
    expect(store.lastDeleteError).toBeTruthy()
    await flushIdMapSave()
    // 文件还在磁盘上 → 绑定必须还在。摘掉它等于让这篇笔记下次启动时重新抽 id
    expect(persistedIdOf(note.filePath), '失败时 forgetPath 把绑定摘了').toBe('a')
  })

  it('Y1b 对照组：删除成功 → 绑定被摘掉（证明 Y1a 的断言不是恒真）', async () => {
    const note = await addBoundNote({ id: 'a', title: 'A' })
    expect(persistedIdOf(note.filePath)).toBe('a')

    await store.deleteNote('a') // 默认 deleteFileImpl 成功

    expect(byId('a')).toBeUndefined()
    await flushIdMapSave()
    expect(persistedIdOf(note.filePath), '成功删除后绑定应被解绑').toBe('')
  })
})

// ---------------------------------------------------------------------------
// Y2 · 失败分支不许动 currentNoteId
// ---------------------------------------------------------------------------
describe('Y2 · 删除失败：currentNoteId 保持不动', () => {
  it('Y2a 删的就是当前笔记，失败后它仍是当前笔记', async () => {
    // 诱饵必须排在下标 0：失败分支若「顺手切到 notes[0]」，而 notes[0] 正好是被删
    // 的那篇，断言就恒真、探测不到任何东西。把别人放在最前面才测得出区别。
    const decoy = mkNote({ id: 'z', title: 'Z', filePath: `${ROOT}/Z.md` })
    store.notes.push(decoy)
    disk.files.set(decoy.filePath, decoy.content)
    await addBoundNote({ id: 'a', title: 'A' })
    store.currentNoteId = 'a'
    disk.deleteFileImpl = async () => { throw new Error('EBUSY: 文件被占用') }

    await store.deleteNote('a')

    expect(byId('a')).toBeTruthy()
    expect(store.currentNoteId, '失败后把当前笔记换掉了').toBe('a')
  })

  it('Y2b 当前笔记另有其人时，删别人失败不许动它', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    const other = mkNote({ id: 'b', title: 'B', filePath: `${ROOT}/B.md` })
    store.notes.push(other)
    disk.files.set(other.filePath, other.content)
    store.currentNoteId = 'b'
    disk.deleteFileImpl = async () => ({ ok: false, message: '权限不足' })

    await store.deleteNote('a')

    expect(store.currentNoteId).toBe('b')
    expect(byId('a')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Y3 · 失败分支不许往撤回栈里塞条目（哪怕这篇笔记还有没落盘的改动）
// ---------------------------------------------------------------------------
describe('Y3 · 删除失败：撤回栈不登记（带挂起写入也不登记）', () => {
  it('Y3a 已落盘笔记 + 挂起改动 → 失败后撤回栈为空', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    // 制造挂起写入：正文改动进 dirty，防抖还没到点
    store.updateNoteContent('a', '# A\n\n刚敲的字\n')
    expect(store.isNoteDirty('a'), '前置条件：应有挂起写入').toBe(true)

    disk.deleteFileImpl = async () => ({ ok: false, message: '回收站不可用' })
    await store.deleteNote('a')

    expect(byId('a')).toBeTruthy()
    expect(store.lastDeleteError).toBeTruthy()
    const stack = getUndoStack()
    expect(stack.length, `失败却登记了撤回条目：${JSON.stringify(stack.map(e => e.label))}`).toBe(0)
    expect(store.canUndoFileOperation?.value ?? false, '失败不该让「撤回」按钮亮起来').toBe(false)
  })

  it('Y3b 库里笔记数组与顺序都不许变（diff 必须真空）', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    const snapshotIds = store.notes.map(n => n.id)
    const snapshotPaths = store.notes.map(n => n.filePath)
    store.updateNoteContent('a', '# A\n\n改一下\n')
    disk.deleteFileImpl = async () => false

    await store.deleteNote('a')

    expect(store.notes.map(n => n.id)).toEqual(snapshotIds)
    expect(store.notes.map(n => n.filePath)).toEqual(snapshotPaths)
    expect(getUndoStack().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Y4 · 「新建但还没落盘」的笔记：一次删除就该清掉
//
// ⚠ 语义变更（C2-A / N3 修复，2026-09-28）：
//   本条**原先**断言「第一次删必然失败、第二次才成功」。那正是 N3 报的回退 ——
//   W4 把「磁盘上压根没这个文件」当成真失败，于是新建不敲字的笔记要删两次。
//   C2-A 加了存在性前置闸门：确认磁盘上没有 → 没东西可删 → 不算失败 → 正常出库，
//   行为回到 W4 之前（一次删掉）。这条断言因此也随之翻转成「一次即出库」。
//
//   「失败分支里的 flushSave 兜底是不是承重件」这条**没有**被删掉，只是换了场景：
//   新建未落盘的场景不再进失败分支，兜底改由 tests/deleteExistsGate.test.js 的
//   H-3 组（文件真存在 + 有挂起写入 + 删不掉 → 改动被补回磁盘）钉住。
//   —— 即「场景变了所以不该触发」，不是「兜底被弄坏了」。
// ---------------------------------------------------------------------------
describe('Y4 · 新建未落盘的笔记：一次删除即出库（N3 修复后）', () => {
  it('Y4a 磁盘上没有这个文件 → 一次删除即出库，且不报失败', async () => {
    const note = store.createNote('', 'Y4')
    expect(note.filePath, '前置条件：新笔记还没落盘').toBeFalsy()
    expect(disk.files.has(`${ROOT}/Y4.md`), '前置条件：磁盘上不该有它').toBe(false)

    // ★ N3：一次就该删掉，不该弹「文件不存在」让用户再点一次
    await store.deleteNote(note.id)
    expect(byId(note.id), '★ 一次没删掉，还在库里（W4 的回退）').toBeUndefined()
    expect(store.lastDeleteError, '没东西可删却报了失败').toBe('')
    // 磁盘上什么都没删 → 不该上报删除方式（Sidebar 读到会谎报进了回收站）
    expect(store.lastTrashMethod, '没删任何东西却上报了方式').toBe('')

    // 再删一次是空操作：不许抛、不许把状态弄脏
    await store.deleteNote(note.id)
    expect(byId(note.id)).toBeUndefined()
    expect(store.lastDeleteError, '空操作不该留下失败原因').toBe('')
    expect(disk.files.has(`${ROOT}/Y4.md`), '磁盘上本来就没它，也不该凭空多出来').toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Y5 · 失败与成功之间不许串味
// ---------------------------------------------------------------------------
describe('Y5 · 上一次的失败原因不许沾到这一次', () => {
  it('Y5a A 失败 → 紧接着删 B 成功 → lastDeleteError 为空、方式照常上报', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    const b = mkNote({ id: 'b', title: 'B', filePath: `${ROOT}/B.md` })
    store.notes.push(b)
    disk.files.set(b.filePath, b.content)

    disk.deleteFileImpl = async (p) => {
      if (String(p).endsWith('A.md')) return { ok: false, message: 'A 删不掉' }
      disk.files.delete(p)
      return { ok: true, method: TRASH_METHOD_SYSTEM, path: p }
    }
    await store.deleteNote('a')
    expect(store.lastDeleteError).toBeTruthy()

    await store.deleteNote('b')

    expect(store.lastDeleteError, '上一次的失败原因串到了这次成功上').toBe('')
    expect(store.lastTrashMethod).toBe(TRASH_METHOD_SYSTEM)
    expect(byId('b')).toBeUndefined()
    expect(byId('a')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Y7 · 没有 electronAPI 时不许去碰 IPC
//       （FI-5b「把候选集构造移出守卫」在「删除结果」上等价，但在这一条上不等价：
//         它会去调 window.electronAPI.deleteFile 并往日志里写一条假的「删除文件失败」）
// ---------------------------------------------------------------------------
describe('Y7 · 浏览器模式：没有 IPC 通道就不许尝试磁盘操作', () => {
  it('Y7a 无 electronAPI → 正常出库，且不产生任何「删除文件失败」日志', async () => {
    const note = mkNote({ id: 'a', title: 'A' })
    store.notes.push(note)
    delete window.electronAPI

    await store.deleteNote('a')

    expect(byId('a'), '浏览器模式下删不掉 = 功能残废').toBeUndefined()
    expect(store.lastDeleteError).toBe('')
    const dumped = errSpy.mock.calls.map(c => JSON.stringify(c)).join('|')
    expect(dumped, '没有 IPC 通道却尝试了删文件并记了一条假失败').not.toContain('删除文件失败')
  })
})

// ---------------------------------------------------------------------------
// Y6 · 失败原因文案：四种返回形态都要翻成人话
// ---------------------------------------------------------------------------
describe('Y6 · readFileOpFailureReason 的四种输入（经 lastDeleteError 观测）', () => {
  const cases = [
    { name: '异常对象', impl: async () => { throw new Error('EBUSY: 文件被其它程序占用') }, expect: 'EBUSY' },
    { name: '老形态 false', impl: async () => false, expect: 'false' },
    { name: 'detail 形态 {ok:false}', impl: async () => ({ ok: false, error: 'delete-failed', errno: -4042, message: '回收站不可用' }), expect: '回收站不可用' },
    { name: 'undefined（没返回结果）', impl: async () => undefined, expect: '磁盘没有返回结果' },
    { name: '只有 errno 没有 message', impl: async () => ({ ok: false, errno: -4042 }), expect: '-4042' }
  ]

  for (const c of cases) {
    it(`Y6 · ${c.name} → 文案含「${c.expect}」`, async () => {
      await addBoundNote({ id: 'a', title: 'A' })
      disk.deleteFileImpl = c.impl

      await store.deleteNote('a')

      expect(store.lastDeleteError, `「${c.name}」没翻成人话`).toContain(c.expect)
      expect(byId('a')).toBeTruthy()
      expect(store.lastTrashMethod).toBe('')
    })
  }

  it('Y6f 失败原因进了日志（不是只在内存里自言自语）', async () => {
    await addBoundNote({ id: 'a', title: 'A' })
    disk.deleteFileImpl = async () => ({ ok: false, message: '回收站不可用' })

    await store.deleteNote('a')

    expect(errSpy).toHaveBeenCalled()
    const dumped = errSpy.mock.calls.map(c => JSON.stringify(c)).join('|')
    expect(dumped).toContain('删除文件失败')
  })
})
