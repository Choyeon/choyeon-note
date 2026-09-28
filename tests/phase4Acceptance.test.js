// ============================================================================
// phase4Acceptance.test.js —— Phase 4 六模块**统一验收**（QA · 严过关）
//
// 定位：工程师侧已有 35 个测试文件 / 1405 例，把六个模块**各自**的逻辑都测过了。
// 这里刻意**不重复**那些单模块用例，只打两件他们没打的东西：
//
//   ① **跨模块不变量**：单个模块内部自洽、但拼起来会破的承诺
//      （id 双轨 × 磁盘、日期四级 × 迁移落盘、撤销栈 × 磁盘、reconcile × 内容安全）。
//   ② **端到端链路**：从「用户按键 / 点菜单」一路到「磁盘 + 内存 + UI 反馈」。
//
// 每一条断言都过一遍「故障注入自检」：把实现改坏，这条必须变红。不变红的就是
// 假绿，已经在开发过程中被改到会红为止（注入记录见交付报告的故障注入表）。
//
// 权限边界：本文件由 QA 新建，只增不改 —— 不修改 src/** 下任何文件。
// 故障注入时改源码，验证完用 `cp` 还原 + sha256 校验。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'

import {
  createIdMap,
  resolveId,
  bindPath,
  rebindPath,
  unbindPath,
  rebuildIdMap,
  pathHashId
} from '../src/utils/noteIdentity'
import {
  DATE_SOURCE,
  resolveNoteDate,
  toISODate
} from '../src/utils/dateAttribution'
import { runDateMigration, hasFrontmatterDateKey } from '../src/utils/dateMigration'
import { createReconciler, CONFLICT_REASONS } from '../src/composables/useExternalSync'
import { clearUndo, getUndoStack } from '../src/composables/useFileUndo'
import { useNoteStore } from '../src/stores/note'
import { useAppStore } from '../src/stores/app'
import { createAppActions, APP_ACTION_IDS } from '../src/composables/useAppActions'
import { SHORTCUT_MAP, normalizeBinding } from '../src/constants/shortcuts'
import { auditShortcuts } from '../src/utils/shortcutAudit'
import {
  TRASH_METHOD_SYSTEM,
  TRASH_METHOD_LIBRARY,
  extractTrashMethod,
  reportTrashMethod,
  resetSystemTrashState,
  getSystemTrashState
} from '../src/utils/trashState'
import { monthGrid, DAYS_PER_WEEK } from '../src/utils/calendarGrid'
import { buildLinkEdges, EDGE_WEIGHT, EDGE_KINDS } from '../src/utils/graphLinks'

const ROOT = 'C:/notes'
const PROJECT_ROOT = process.cwd()

const readSrc = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf-8')

// ===========================================================================
// A · 稳定 id 双轨：跨模块往返 + 绝不写用户 .md
// ===========================================================================

describe('A · 稳定 id 双轨往返（跨模块不变量）', () => {
  it('A1 改路径往返：resolveId → rebindPath → resolveId 拿到同一个 id', () => {
    const map = createIdMap()
    const oldPath = `${ROOT}/A.md`
    const newPath = `${ROOT}/工作笔记/A.md`

    const idBefore = resolveId(map, oldPath) // 兜底哈希（迁移期形态）
    rebindPath(map, oldPath, newPath)
    const idAfter = resolveId(map, newPath)

    expect(idBefore).toBeTruthy()
    expect(idAfter).toBe(idBefore)
    // 再搬一次仍然同一个 id —— 「固化」的意义正在于此
    rebindPath(map, newPath, `${ROOT}/归档/A.md`)
    expect(resolveId(map, `${ROOT}/归档/A.md`)).toBe(idBefore)
    // 旧路径必须已经从表里摘掉（不能留悬空正向项）
    expect(map.byPath[oldPath]).toBeUndefined()
    expect(map.byPath[newPath]).toBeUndefined()
    // 表外解析旧路径会退回兜底哈希 —— 而兜底哈希恰好等于搬走的那个 id，
    // 这正是「老书签 / 老双链在迁移期照样能解析」的原理，不是 bug
    expect(resolveId(map, oldPath)).toBe(idBefore)
  })

  it('A2 整条 id 解析链路一个 IPC 都不发（纯内存，绝不碰磁盘/笔记内容）', () => {
    const calls = []
    const spy = new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined
        return (...args) => { calls.push([prop, args]); return Promise.resolve(true) }
      },
      has: () => true
    })
    const prev = window.electronAPI
    window.electronAPI = spy
    try {
      const map = createIdMap()
      for (let i = 0; i < 50; i += 1) {
        rebindPath(map, `${ROOT}/n${i}.md`, `${ROOT}/moved/n${i}.md`)
      }
      for (let i = 0; i < 50; i += 1) resolveId(map, `${ROOT}/moved/n${i}.md`)
      unbindPath(map, `${ROOT}/moved/n0.md`)
      rebuildIdMap([`${ROOT}/a.md`, `${ROOT}/b.md`])
    } finally {
      if (prev === undefined) delete window.electronAPI
      else window.electronAPI = prev
    }
    // 「改路径」这件事本身不该产生任何 IPC —— 磁盘动作由 store 负责，
    // 这里一旦有调用，说明有人把「记 id」和「写文件」耦在了一起。
    expect(calls).toEqual([])
  })

  it('A3 源码级：noteIdentity / idMapStore 不得出现任何写文件能力', () => {
    const identity = readSrc('src/utils/noteIdentity.js')
    const store = readSrc('src/utils/idMapStore.js')

    for (const [name, src] of [['noteIdentity.js', identity], ['idMapStore.js', store]]) {
      // 零 import 是这两个文件的硬契约（noteIdentity）；idMapStore 允许 import 但不许有 fs
      expect(src, `${name} 出现了 fs 能力`).not.toMatch(/\b(require\(|from 'node:fs'|from "fs")\b/)
      expect(src, `${name} 出现了写文件调用`).not.toMatch(/\b(writeFile|appendFile|writeFileSync|appendFileSync)\s*\(/)
      expect(src, `${name} 出现了 markdown 写入语义`).not.toMatch(/\.md['"`]\s*\)?\s*;?\s*$/)
    }
    // idMapStore 的落盘点必须是应用侧 key，不是用户笔记
    expect(store).toContain('LS_KEYS.idMap')
    expect(identity).not.toContain('document')
  })

  it('A4 映射表丢失可复现：rebuildIdMap 后每个路径的 id 与丢失前一致', () => {
    const paths = [`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/子目录/c.md`]
    const first = rebuildIdMap(paths)
    const lost = rebuildIdMap(paths) // 「映射表丢了」：从磁盘路径重建
    const lostShuffled = rebuildIdMap([...paths].reverse()) // 扫描顺序不同

    for (const p of paths) {
      expect(lost.byPath[p], `重建后 ${p} 的 id 漂移`).toBe(first.byPath[p])
      expect(lostShuffled.byPath[p], `扫描顺序影响重建结果：${p}`).toBe(first.byPath[p])
    }
    // 双向索引严格互逆（不是只写了一半的残表）
    for (const [p, id] of Object.entries(lost.byPath)) expect(lost.byId[id]).toBe(p)
    // 未进表的路径仍走兜底哈希 —— 老库里的书签/双链因此不会断
    expect(resolveId(lost, `${ROOT}/未收录.md`)).toBe(pathHashId(`${ROOT}/未收录.md`))
  })

  it('A5 一对一约束：路径搬家后不留悬空反向项', () => {
    const map = createIdMap()
    bindPath(map, 'id-a', `${ROOT}/a.md`)
    bindPath(map, 'id-b', `${ROOT}/b.md`)
    // a 搬到 b 的位置：b 那个 id 必须被摘掉，否则 byId 里躺着两个指向同一路径的 id
    rebindPath(map, `${ROOT}/a.md`, `${ROOT}/b.md`)

    expect(map.byPath[`${ROOT}/b.md`]).toBe('id-a')
    expect(map.byId['id-b']).toBeUndefined()
    expect(map.byPath[`${ROOT}/a.md`]).toBeUndefined()
    for (const [p, id] of Object.entries(map.byPath)) expect(map.byId[id]).toBe(p)
  })
})

// ===========================================================================
// B · 日期四级归属 × 迁移落盘（主理人裁决 2）
// ===========================================================================

const BODY = '# 标题\n\n正文第一行\n正文第二行\n'

describe('B · 日期四级归属 × 迁移绝不落盘 ④ 级', () => {
  it('B1 优先级严格为 frontmatter > birthtime > 标题日期 > updatedAt', () => {
    const fm = new Date(2020, 0, 15, 12, 0, 0).getTime()
    const bt = new Date(2021, 5, 20, 9, 0, 0).getTime()
    const titleTs = new Date(2022, 8, 3, 0, 0, 0).getTime()
    const up = new Date(2023, 3, 9, 8, 0, 0).getTime()
    const now = new Date(2026, 0, 1).getTime()

    const base = {
      content: `---\ndate: 2020-01-15\n---\n\n${BODY}`,
      title: '2022-09-03 某天',
      updatedAt: new Date(up)
    }
    const full = resolveNoteDate(base, { birthtime: bt, now })
    // 四级同时存在：必须是 ①
    expect(new Date(full.date).getFullYear(), '① frontmatter 应当赢').toBe(2020)
    expect(full.source).toBe(DATE_SOURCE.FRONTMATTER)

    // 去掉 ① → ②
    const noFm = resolveNoteDate({ ...base, content: BODY }, { birthtime: bt, now })
    expect(new Date(noFm.date).getFullYear()).toBe(2021)
    expect(noFm.source).toBe(DATE_SOURCE.BIRTHTIME)

    // 去掉 ①② → ③
    const noBt = resolveNoteDate({ ...base, content: BODY }, { birthtime: null, now })
    expect(new Date(noBt.date).getFullYear()).toBe(2022)
    expect(noBt.source).toBe(DATE_SOURCE.TITLE)

    // 去掉 ①②③ → ④
    const onlyUp = resolveNoteDate({ ...base, content: BODY, title: '无日期标题' }, { birthtime: null, now })
    expect(new Date(onlyUp.date).getFullYear()).toBe(2023)
    expect(onlyUp.source).toBe(DATE_SOURCE.UPDATED_AT)

    // 顺带钉住①的原始值解析（不是靠「现在」算出来的）：
    // `date: 2020-01-15` 按本地日界 00:00 构造，不是 fm 那个 12:00
    expect(full.date).toBe(new Date(2020, 0, 15).getTime())
    expect(full.date).not.toBe(now)
  })

  it('B2 ★ trustworthyOnly 下 ④ 级一个字节都不写盘（主理人裁决 2）', async () => {
    const writes = []
    const note = {
      title: '没有可信日期的笔记',
      content: BODY, // 无 frontmatter、无日期标题
      updatedAt: new Date(2026, 4, 1, 10, 0, 0),
      filePath: `${ROOT}/无日期.md`
    }
    const original = note.content

    const res = await runDateMigration({
      notes: [note],
      writeFile: async (p, c) => { writes.push([p, c]); return true },
      readFlag: () => null,
      writeFlag: () => true,
      trustworthyOnly: true,
      now: new Date(2026, 4, 2).getTime()
    })

    // ④ 级不许固化：一个字节都不写
    expect(writes, '④ 级被写进了 frontmatter —— 等于把「跑迁移那天」伪装成笔记生日').toEqual([])
    expect(res.migrated).toBe(0)
    expect(res.untrusted).toBe(1)
    expect(note.content, '内存内容被改了').toBe(original)
  })

  it('B3 ★ ④ 级不落标记：那批笔记在等更可信的证据，不能被永久放弃', async () => {
    let flagWritten = null
    await runDateMigration({
      notes: [{ title: 'x', content: BODY, updatedAt: new Date(2026, 4, 1), filePath: `${ROOT}/x.md` }],
      writeFile: async () => true,
      readFlag: () => null,
      writeFlag: (v) => { flagWritten = v; return true },
      trustworthyOnly: true,
      now: 111
    })
    expect(flagWritten, '有 untrusted 却落了标记 = 永久放弃这批笔记').toBeNull()
  })

  it('B4 反面向：②③ 级在 trustworthyOnly 下**必须**被固化（防止矫枉过正）', async () => {
    const writes = []
    const notes = [
      { title: '无日期', content: BODY, birthtime: new Date(2019, 2, 4), filePath: `${ROOT}/b.md` },
      { title: '2018-07-09 日记', content: BODY, filePath: `${ROOT}/t.md` }
    ]
    const res = await runDateMigration({
      notes,
      writeFile: async (p, c) => { writes.push([p, c]); return true },
      readFlag: () => null,
      writeFlag: () => true,
      trustworthyOnly: true,
      now: new Date(2026, 0, 1).getTime()
    })
    expect(res.migrated).toBe(2)
    expect(res.untrusted).toBe(0)
    expect(writes.length).toBe(2)
    // 固化出来的日期来自 ② / ③，不是「今天」
    expect(writes[0][1]).toContain('date: 2019-03-04')
    expect(writes[1][1]).toContain('date: 2018-07-09')
    // 写进去之后必须能被 ① 级读出来（往返闭环）
    expect(resolveNoteDate({ content: writes[0][1], title: 'x', updatedAt: 0 }, { now: 0 }).source)
      .toBe(DATE_SOURCE.FRONTMATTER)
  })

  it('B5 正文零改动：迁移只在围栏里插 date，正文逐字节不变', async () => {
    let written = null
    const note = {
      title: '2017-05-06 标题',
      content: `---\ntags: [a]\n---\n\n${BODY}`,
      filePath: `${ROOT}/p.md`
    }
    await runDateMigration({
      notes: [note],
      writeFile: async (_p, c) => { written = c; return true },
      readFlag: () => null,
      writeFlag: () => true,
      trustworthyOnly: true,
      now: new Date(2026, 0, 1).getTime()
    })
    expect(written).toBeTruthy()
    // 剥掉 frontmatter 之后剩下的正文必须与原正文逐字节相同
    const tail = written.slice(written.indexOf('\n---\n') + 5)
    expect(tail).toBe(`\n${BODY}`)
    expect(written.startsWith('---\ndate: 2017-05-06\n')).toBe(true)
    // 原有的 tags 行还在（不是整块覆盖）
    expect(written).toContain('tags: [a]')
  })

  it('B6 已有 date 键的笔记绝不写第二个 date（重复键后半段永远读不到）', () => {
    expect(hasFrontmatterDateKey(`---\ncreated: 2020-01-01\n---\n\n${BODY}`)).toBe(true)
    expect(hasFrontmatterDateKey(`---\ncreatedAt: 2020-01-01\n---\n\n${BODY}`)).toBe(true)
    expect(hasFrontmatterDateKey(BODY)).toBe(false)
    // 正文里恰好有 date: 开头的一行，但没有围栏 —— 不算 frontmatter
    expect(hasFrontmatterDateKey(`正文\ndate: 2020-01-01\n`)).toBe(false)
  })

  it('B7 toISODate 按本地日界（不是 UTC），否则东八区整体错一天', () => {
    // 本地 2026-03-15 00:30 → 在东八区 UTC 是 2026-03-14 16:30
    const ts = new Date(2026, 2, 15, 0, 30, 0).getTime()
    expect(toISODate(ts)).toBe('2026-03-15')
  })
})

// ===========================================================================
// C · 日志双份拷贝：验证「已有守卫」的有效性（不重造 10 例）
// ===========================================================================

describe('C · 日志双份拷贝守卫的有效性', () => {
  it('C1 守卫存在且覆盖关键符号（本轮不重造，只钉住它还在）', () => {
    const guard = readSrc('tests/mainLogParity.test.js')
    for (const mark of ['DUAL-COPY', 'SENSITIVE_KEY_PATTERN', 'EMBEDDED_PATH_RE', 'HOME_ROOT_PATTERNS', 'LOG_MODULES']) {
      expect(guard, `mainLogParity 不再校验 ${mark}`).toContain(mark)
    }
  })

  it('C2 独立复核：两份实现里同一组正则/常量字面值逐字相同（换一套取法再比一次）', () => {
    const main = readSrc('electron/main.cjs')
    const sanitize = readSrc('src/utils/logSanitize.js')
    const flat = (s) => s.replace(/\s+/g, ' ')

    // 换一种取法（按行抓，而不是按声明起点抓），避免与既有守卫犯同一个错
    const grab = (src, re) => {
      const m = src.match(re)
      return m ? flat(m[0]) : null
    }
    const pairs = [
      [/const IS_ABSOLUTE_RE = .*/],
      [/const WHOLE_PATH_RE = .*/],
      [/const SENSITIVE_KEY_PATTERN = .*/]
    ]
    for (const [re] of pairs) {
      const a = grab(main, re)
      const b = grab(sanitize, re)
      expect(a, `main.cjs 缺少 ${re}`).not.toBeNull()
      expect(b, `logSanitize.js 缺少 ${re}`).not.toBeNull()
      // ESM 侧是 export const，去掉 export 前缀后必须逐字相同
      expect(flat(String(a).replace('export ', '')), `${re} 两侧漂移`).toBe(flat(String(b).replace('export ', '')))
    }
  })

  it('C3 两份都必须有 DUAL-COPY 标记（提醒改一处必须改两处）', () => {
    expect(readSrc('electron/main.cjs')).toContain('DUAL-COPY')
    expect(readSrc('src/utils/logSanitize.js')).toContain('DUAL-COPY')
  })
})

// ===========================================================================
// D · 撤销栈 ↔ 磁盘一致性（不是只看内存）
// ===========================================================================

let store
let appStore
let disk
let errSpy
let warnSpy

function seedListed (listed, absPath) {
  const i = String(absPath).lastIndexOf('/')
  if (i < 0) return
  const dir = absPath.slice(0, i)
  const name = absPath.slice(i + 1)
  const list = listed.get(dir) || []
  if (!list.some(e => e.name === name)) list.push({ name })
  listed.set(dir, list)
}

function createDisk () {
  const files = new Map()
  const listed = new Map()
  const disk = {
    files,
    listed,
    failNextWrite: false,
    writeFileImpl: async (p, content) => {
      if (disk.failNextWrite) return false
      files.set(p, content)
      seedListed(listed, p)
      return true
    },
    moveFileImpl: async (from, to) => {
      const fk = String(from).replace(/\/+$/, '')
      const tk = String(to).replace(/\/+$/, '')
      if (files.has(fk)) {
        files.set(tk, files.get(fk))
        files.delete(fk)
        seedListed(listed, tk)
        return true
      }
      let moved = false
      for (const k of [...files.keys()]) {
        if (k === fk || k.startsWith(fk + '/')) {
          const next = tk + k.slice(fk.length)
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
    deleteFileImpl: async (p) => { files.delete(p); return { ok: true, method: TRASH_METHOD_LIBRARY, path: p } },
    removeDirImpl: async (dir) => {
      const base = String(dir).replace(/\/+$/, '')
      for (const k of [...files.keys()]) {
        if (k === base || k.startsWith(base + '/')) files.delete(k)
      }
      return { ok: true, method: TRASH_METHOD_LIBRARY, path: dir }
    },
    readFileImpl: async (p) => (files.has(p) ? files.get(p) : null)
  }
  disk.api = {
    writeFile: vi.fn((p, c) => disk.writeFileImpl(p, c)),
    moveFile: vi.fn((f, t) => disk.moveFileImpl(f, t)),
    fileExists: vi.fn((p) => disk.fileExistsImpl(p)),
    readDirectory: vi.fn((d) => disk.readDirectoryImpl(d)),
    createDirectory: vi.fn((d) => disk.createDirectoryImpl(d)),
    deleteFile: vi.fn((p) => disk.deleteFileImpl(p)),
    removeDir: vi.fn((d) => disk.removeDirImpl(d)),
    readFile: vi.fn((p) => disk.readFileImpl(p))
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
    filePath: null
  }
  const merged = { ...base, ...over }
  if (over.filePath === undefined) {
    merged.filePath = merged.folder ? `${ROOT}/${merged.folder}/${merged.title}.md` : `${ROOT}/${merged.title}.md`
  }
  return merged
}

let addNote = () => {}
const byId = (id) => store.notes.find(n => n.id === id)

/**
 * 「内存 ↔ 磁盘」一致性快照。
 * 两侧互相核对：内存里每篇的 filePath 必须在磁盘上存在且内容相同；
 * 磁盘上库内路径的文件必须都能在内存里找到。
 */
function diskMismatch () {
  const problems = []
  for (const n of store.notes) {
    if (!n.filePath) { problems.push(`内存 ${n.id} 没有 filePath`); continue }
    if (!disk.files.has(n.filePath)) { problems.push(`磁盘缺文件：${n.filePath}`); continue }
    if (disk.files.get(n.filePath) !== n.content) problems.push(`内容不一致：${n.filePath}`)
  }
  for (const p of disk.files.keys()) {
    if (!store.notes.some(n => n.filePath === p)) problems.push(`孤儿文件：${p}`)
  }
  return problems
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  clearUndo()
  resetSystemTrashState()

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
    if (note.filePath) disk.files.set(note.filePath, note.content)
    return note
  }
})

afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
  for (const toast of [...appStore.toasts]) appStore.dismissToast(toast.id)
  delete window.electronAPI
})

describe('D · 撤销栈 ↔ 磁盘一致性（串操作后连续撤回）', () => {
  it('D1 ★ 移动 → 重命名 → 删除，连撤三步，每一步磁盘与内存都一致', async () => {
    addNote({ id: 'a', title: 'A', content: '# A\n\n原始正文\n' })
    const originPath = `${ROOT}/A.md`
    const originContent = '# A\n\n原始正文\n'
    expect(diskMismatch()).toEqual([])

    // ① 移动到「工作笔记」
    const moved = await store.moveNote('a', '工作笔记')
    expect(moved.ok, JSON.stringify(moved)).toBe(true)
    expect(diskMismatch()).toEqual([])
    expect(disk.files.has(`${ROOT}/工作笔记/A.md`)).toBe(true)

    // ② 重命名为 B
    const renamed = await store.renameNote('a', 'B')
    expect(renamed.ok === true || renamed === true, JSON.stringify(renamed)).toBe(true)
    expect(diskMismatch(), `重命名后不一致：${JSON.stringify(diskMismatch())}`).toEqual([])

    // ③ 删除
    await store.deleteNote('a')
    expect(byId('a')).toBeUndefined()
    expect(disk.files.has(`${ROOT}/工作笔记/B.md`), '删除后磁盘上不该还有').toBe(false)
    expect(diskMismatch()).toEqual([])

    // 连撤三步：每一步之后都要双向一致
    const u1 = await store.undoLastFileOperation()
    expect(u1.ok, JSON.stringify(u1)).toBe(true)
    expect(diskMismatch(), `撤回删除后不一致：${JSON.stringify(diskMismatch())}`).toEqual([])
    expect(byId('a')).toBeTruthy()
    expect(byId('a').filePath).toBe(`${ROOT}/工作笔记/B.md`)

    const u2 = await store.undoLastFileOperation()
    expect(u2.ok, JSON.stringify(u2)).toBe(true)
    expect(diskMismatch(), `撤回重命名后不一致：${JSON.stringify(diskMismatch())}`).toEqual([])
    expect(byId('a').title).toBe('A')

    const u3 = await store.undoLastFileOperation()
    expect(u3.ok, JSON.stringify(u3)).toBe(true)
    expect(diskMismatch(), `撤回移动后不一致：${JSON.stringify(diskMismatch())}`).toEqual([])

    // 完全回到起点：路径、内容、标题一个字都不能差
    expect(byId('a').filePath).toBe(originPath)
    expect(byId('a').content).toBe(originContent)
    expect(byId('a').title).toBe('A')
    expect(disk.files.get(originPath)).toBe(originContent)
  })

  it('D2 撤回删除：文件真的在磁盘上回来了（不是只在内存里复活）', async () => {
    addNote({ id: 'a', title: 'A', content: '# A\n\n不要丢\n' })
    await store.deleteNote('a')
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(false)

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(true)
    expect(disk.files.has(`${ROOT}/A.md`), '撤回后磁盘上没这个文件 = 只在内存复活').toBe(true)
    expect(disk.files.get(`${ROOT}/A.md`)).toBe('# A\n\n不要丢\n')
    // 内容也回了（不是空文件）
    expect(byId('a').content).toBe('# A\n\n不要丢\n')
  })

  it('D3 空栈撤回：ok:false / code=empty，且磁盘一个字节都不动', async () => {
    addNote({ id: 'a', title: 'A' })
    const snapshot = [...disk.files.entries()]
    expect(getUndoStack().length).toBe(0)

    const res = await store.undoLastFileOperation()
    expect(res.ok).toBe(false)
    expect(res.code).toBe('empty')
    expect(disk.files.size).toBe(snapshot.length)
    for (const [p, c] of snapshot) expect(disk.files.get(p)).toBe(c)
  })

  it('D4 撤回栈深度与操作序列一致（撤完就空，不会残留幽灵条目）', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', 'F1')
    await store.moveNote('a', 'F2')
    expect(getUndoStack().length).toBe(2)
    await store.undoLastFileOperation()
    expect(getUndoStack().length).toBe(1)
    await store.undoLastFileOperation()
    expect(getUndoStack().length).toBe(0)
    expect(store.canUndoFileOperation).toBe(false)
  })
})

// ===========================================================================
// E · 外部变更 reconcile：用户内容一个字节都不能被静默覆盖
// ===========================================================================

function makeReconcilerHarness (notes, opts = {}) {
  const diskFiles = new Map()
  for (const n of notes) if (n.filePath) diskFiles.set(n.filePath, n.content)
  const dirty = new Set(opts.dirty || [])
  const facade = {
    notes,
    dirtyNotes: dirty,
    currentNoteId: opts.currentNoteId || null,
    notesPath: ROOT,
    isDirty: (id) => dirty.has(id),
    upsert: (n) => { notes.push(n); return true },
    remove: (n) => {
      const i = notes.indexOf(n)
      if (i < 0) return false
      notes.splice(i, 1)
      return true
    },
    readFile: async (p) => (diskFiles.has(p) ? diskFiles.get(p) : null),
    persist: async (n) => { diskFiles.set(n.filePath, n.content); return true },
    reindex: () => {},
    clearDirty: (id) => { dirty.delete(id) },
    resolveNoteId: (p) => resolveId(null, p)
  }
  const rec = createReconciler({ noteStore: facade, log: { info () {}, warn () {}, error () {} } })
  return { rec, facade, diskFiles, dirty }
}

describe('E · 外部变更 reconcile 的内容安全（静默数据丢失重点区）', () => {
  it('E1 ★ 磁盘变更 + 内存脏笔记：内容一个字节都不许变，且进冲突队列', async () => {
    const memory = '# 我的稿子\n\n这是用户刚敲的、还没保存的内容\n'
    const notes = [{
      id: 'n1', title: '我的稿子', folder: '', content: memory,
      tags: [], filePath: `${ROOT}/我的稿子.md`, updatedAt: new Date(2026, 0, 1)
    }]
    const { rec, diskFiles } = makeReconcilerHarness(notes, { dirty: ['n1'] })
    diskFiles.set(`${ROOT}/我的稿子.md`, '# 别人的版本\n\n外部编辑器改的\n')

    const before = notes[0].content
    const res = await rec.apply([{ path: `${ROOT}/我的稿子.md`, kind: 'change' }])

    expect(res.conflicted, JSON.stringify(res)).toBe(1)
    expect(res.updated, '受保护的笔记被静默覆盖了').toBe(0)
    // 核心断言：逐字节
    expect(notes[0].content, '用户内容被覆盖 —— 静默数据丢失').toBe(before)
    expect(notes[0].content).toBe(memory)

    const pending = rec.pendingConflicts()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe('n1')
    expect(pending[0].reason).toBe(CONFLICT_REASONS.dirty)
    expect(pending[0].memoryPreview).toContain('这是用户刚敲的')
    expect(pending[0].diskPreview).toContain('外部编辑器改的')
  })

  it('E2 当前正在编辑的笔记（即使已落盘、不 dirty）同样受保护', async () => {
    const notes = [{
      id: 'n1', title: '正在编辑', folder: '', content: '光标在这里\n',
      tags: [], filePath: `${ROOT}/正在编辑.md`, updatedAt: new Date(2026, 0, 1)
    }]
    const { rec, diskFiles } = makeReconcilerHarness(notes, { currentNoteId: 'n1' })
    diskFiles.set(`${ROOT}/正在编辑.md`, '外部改的\n')

    const res = await rec.apply([{ path: `${ROOT}/正在编辑.md`, kind: 'change' }])
    expect(res.conflicted).toBe(1)
    expect(res.updated).toBe(0)
    expect(notes[0].content).toBe('光标在这里\n')
    expect(rec.pendingConflicts()[0].reason).toBe(CONFLICT_REASONS.current)
  })

  it('E3 反面向：不脏、也不是当前笔记 → 正常同步（不许过度保护）', async () => {
    const notes = [{
      id: 'n1', title: '随便', folder: '', content: '旧内容\n',
      tags: [], filePath: `${ROOT}/随便.md`, updatedAt: new Date(2026, 0, 1)
    }]
    const { rec, diskFiles } = makeReconcilerHarness(notes)
    diskFiles.set(`${ROOT}/随便.md`, '新内容\n')

    const res = await rec.apply([{ path: `${ROOT}/随便.md`, kind: 'change' }])
    expect(res.updated).toBe(1)
    expect(res.conflicted).toBe(0)
    expect(notes[0].content).toBe('新内容\n')
  })

  it('E4 整批：全库都脏时，每一篇的内容逐字节不变（批量场景最容易漏）', async () => {
    const notes = [0, 1, 2, 3, 4].map(i => ({
      id: `n${i}`, title: `笔记${i}`, folder: '', content: `第${i}篇的正文\n第二行${i}\n`,
      tags: [], filePath: `${ROOT}/笔记${i}.md`, updatedAt: new Date(2026, 0, 1)
    }))
    const before = notes.map(n => n.content)
    const { rec, diskFiles } = makeReconcilerHarness(notes, { dirty: notes.map(n => n.id) })
    for (const n of notes) diskFiles.set(n.filePath, `外部覆盖${n.id}\n`)

    const changes = notes.map(n => ({ path: n.filePath, kind: 'change' }))
    const res = await rec.apply(changes)

    expect(res.conflicted).toBe(5)
    expect(res.updated).toBe(0)
    notes.forEach((n, i) => {
      expect(n.content, `${n.id} 的内容被覆盖了`).toBe(before[i])
    })
  })

  it('E5 只有用户显式选 disk 才允许覆盖内存版；未知 choice 什么都不做', async () => {
    const notes = [{
      id: 'n1', title: 't', folder: '', content: '内存版\n',
      tags: [], filePath: `${ROOT}/t.md`, updatedAt: new Date(2026, 0, 1)
    }]
    const { rec, diskFiles, dirty } = makeReconcilerHarness(notes, { dirty: ['n1'] })
    diskFiles.set(`${ROOT}/t.md`, '磁盘版\n')
    await rec.apply([{ path: `${ROOT}/t.md`, kind: 'change' }])

    // 未知 choice：什么都不做（替用户做丢稿的决定是最坏的）
    await rec.resolveConflict('n1', 'whatever')
    expect(notes[0].content).toBe('内存版\n')
    expect(rec.pendingConflicts().length).toBe(1)

    // 显式选 disk
    await rec.resolveConflict('n1', 'disk')
    expect(notes[0].content).toBe('磁盘版\n')
    expect(rec.pendingConflicts().length).toBe(0)
    expect(dirty.has('n1'), '采用磁盘版后 dirty 应清除').toBe(false)
  })

  it('E6 选 memory：把内存版写回磁盘，外部改动被覆盖（用户有这个选择权）', async () => {
    const notes = [{
      id: 'n1', title: 't', folder: '', content: '内存版\n',
      tags: [], filePath: `${ROOT}/t.md`, updatedAt: new Date(2026, 0, 1)
    }]
    const { rec, diskFiles } = makeReconcilerHarness(notes, { dirty: ['n1'] })
    diskFiles.set(`${ROOT}/t.md`, '磁盘版\n')
    await rec.apply([{ path: `${ROOT}/t.md`, kind: 'change' }])

    await rec.resolveConflict('n1', 'memory')
    expect(notes[0].content).toBe('内存版\n')
    expect(diskFiles.get(`${ROOT}/t.md`), '内存版没有写回磁盘').toBe('内存版\n')
  })

  it('E7 磁盘上出现库里没有的新文件：入库，且绝不覆盖任何现存笔记', async () => {
    const notes = [{
      id: 'n1', title: '旧', folder: '', content: '旧的\n',
      tags: [], filePath: `${ROOT}/旧.md`, updatedAt: new Date(2026, 0, 1)
    }]
    const { rec, diskFiles } = makeReconcilerHarness(notes)
    diskFiles.set(`${ROOT}/新的.md`, '新来的\n')

    const res = await rec.apply([{ path: `${ROOT}/新的.md`, kind: 'add' }])
    expect(res.added).toBe(1)
    expect(notes.length).toBe(2)
    expect(notes[0].content, '现存笔记被新文件顶掉了').toBe('旧的\n')
  })
})

// ===========================================================================
// F · app.undoFileOp：三态反馈 × 键位不撞 × 真 store（不用替身）
// ===========================================================================

describe('F · app.undoFileOp 端到端（真 store，非替身）', () => {
  const lastToast = (s) => {
    const list = s.toasts
    return list.length ? { type: list[list.length - 1].type, message: list[list.length - 1].message } : null
  }

  it('F1 空栈 → info toast（不许静默）', async () => {
    clearUndo()
    addNote({ id: 'a', title: 'A' })
    const actions = createAppActions({ appStore, noteStore: store })
    actions['app.undoFileOp']()
    await new Promise(r => setTimeout(r, 0))

    const toast = lastToast(appStore)
    expect(toast).not.toBeNull()
    expect(toast.type).toBe('info')
    expect(toast.message).toContain('没有可撤回')
  })

  it('F2 ★ 成功 → success toast 且含操作 label（走真 store 的撤回链路）', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', '工作笔记')
    expect(store.canUndoFileOperation).toBe(true)

    const actions = createAppActions({ appStore, noteStore: store })
    actions['app.undoFileOp']()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const toast = lastToast(appStore)
    expect(toast, '撤回成功却没有任何 toast').not.toBeNull()
    expect(toast.type).toBe('success')
    expect(toast.message).toContain('已撤回')
    // 真 store 的 label 形如「移动「A」到「工作笔记」」—— 必须真的带出来
    expect(toast.message.length).toBeGreaterThan('已撤回：'.length)
    expect(diskMismatch(), `撤回后磁盘不一致：${JSON.stringify(diskMismatch())}`).toEqual([])
  })

  it('F3 ★ 失败 → error toast，绝不带「已撤回」（不许把失败 toast 成成功）', async () => {
    addNote({ id: 'a', title: 'A' })
    await store.moveNote('a', '工作笔记')
    // 注入磁盘失败：撤回要把文件搬回原路径，搬不动就必须报失败。
    // （用 moveFile 而不是 writeFile —— 撤回「移动」走的是搬文件那条路）
    disk.api.moveFile = vi.fn(async () => false)

    const actions = createAppActions({ appStore, noteStore: store })
    actions['app.undoFileOp']()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const toast = lastToast(appStore)
    expect(toast, '撤回失败却没 toast').not.toBeNull()
    expect(toast.type, `撤回失败却 toast 成 ${toast.type}：${toast.message}`).toBe('error')
    expect(toast.message).not.toContain('已撤回')
  })

  it('F4 键位：默认 Mod-Alt-z，刻意不等于 edit.redoAlt 的 Mod-Shift-z', () => {
    const undo = SHORTCUT_MAP['app.undoFileOp']
    const redoAlt = SHORTCUT_MAP['edit.redoAlt']
    expect(undo, '注册表里没有 app.undoFileOp').toBeTruthy()
    expect(undo.default).toBe('Mod-Alt-z')
    expect(undo.scope).toBe('app')
    // 跨 scope 撞键 auditShortcuts 查不出来，只能靠这条断言钉死
    expect(normalizeBinding(undo.default)).not.toBe(normalizeBinding(redoAlt.default))
  })

  it('F5 注册表没有死命令 / 重复键（undoFileOp 必须既有注册又有执行器）', () => {
    expect(APP_ACTION_IDS).toContain('app.undoFileOp')
    const audit = auditShortcuts()
    const fatal = (audit.issues || []).filter(i => i.reason === 'dead' || i.reason === 'duplicateDefault')
    expect(fatal, JSON.stringify(fatal)).toEqual([])
  })
})

// ===========================================================================
// G · 删除方式上报链路（note.js → trashState → Sidebar → /trash）
// ===========================================================================

describe('G · 删除方式上报与「最近删除」接线', () => {
  it('G1 布尔返回值（老主进程 / 未传 detail）被判成未知，绝不照记', () => {
    expect(extractTrashMethod(true)).toBe('')
    expect(extractTrashMethod(false)).toBe('')
    expect(extractTrashMethod(null)).toBe('')
    expect(extractTrashMethod({ ok: false, method: TRASH_METHOD_SYSTEM })).toBe('')
    expect(extractTrashMethod({ ok: true, method: TRASH_METHOD_SYSTEM })).toBe(TRASH_METHOD_SYSTEM)
    expect(extractTrashMethod({ ok: true, method: TRASH_METHOD_LIBRARY })).toBe(TRASH_METHOD_LIBRARY)
  })

  it('G2 只有 system-trash 点亮提示；library-trash 不点亮', () => {
    resetSystemTrashState()
    expect(reportTrashMethod(TRASH_METHOD_LIBRARY)).toBe(false)
    expect(getSystemTrashState().value.seen).toBe(false)

    expect(reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })).toBe(true)
    expect(getSystemTrashState().value.seen).toBe(true)
    expect(getSystemTrashState().value.count).toBe(1)
    resetSystemTrashState()
  })

  it('G3 deleteNoteOp 走 detail:true 并把 method 记进 lastTrashMethod', async () => {
    addNote({ id: 'a', title: 'A' })
    let seenOpts = null
    disk.api.deleteFile = vi.fn(async (p, opts) => {
      seenOpts = opts
      disk.files.delete(p)
      return { ok: true, method: TRASH_METHOD_SYSTEM, path: p }
    })

    await store.deleteNote('a')
    expect(seenOpts, '没传 detail:true，主进程只会回 true，读不到 method').toEqual({ detail: true })
    expect(store.lastTrashMethod).toBe(TRASH_METHOD_SYSTEM)
  })

  it('G4 侧边栏有「最近删除」导航项且指向 /trash（静态接线，防被改回去）', () => {
    const sidebar = readSrc('src/components/Sidebar.vue')
    expect(sidebar).toContain('最近删除')
    expect(sidebar).toMatch(/['"`]\/trash['"`]/)
  })

  it('G5 ★ /trash 仍是懒加载：路由用动态 import，且 Sidebar 不静态引 TrashView', () => {
    const router = readSrc('src/router/index.js')
    const sidebar = readSrc('src/components/Sidebar.vue')

    // 路由里 /trash 必须是 () => import(...) 形态
    const trashRoute = router.match(/path:\s*['"`]\/trash['"`][\s\S]{0,400}?import\(/)
    expect(trashRoute, '/trash 不再懒加载 —— 会被拖进首屏主 chunk').not.toBeNull()

    // Sidebar 若静态 import TrashView（1000+ 行），整块进主 chunk。
    // 只查 import 的**模块路径**（注释里提到 TrashView 是允许的，那正是防回归的说明）。
    const specifiers = [...sidebar.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
    const bad = specifiers.filter(s => /TrashView/.test(s))
    expect(bad, 'Sidebar 静态引入了 TrashView').toEqual([])
  })
})

// ===========================================================================
// H · 日历 × 图谱的跨模块口径
// ===========================================================================

describe('H · 日历与图谱的跨模块口径', () => {
  it('H1 月视图格数 = 行数 × 7，且行数随月份真实变化（不是恒定 6 行）', () => {
    // 2026-02 是 28 天且周一起始，排布恰好 4 行；2026-03 是 31 天 → 5 行
    const feb = monthGrid(2026, 2, { weekStartsOn: 1 })
    const mar = monthGrid(2026, 3, { weekStartsOn: 1 })
    expect(feb.cells.length % DAYS_PER_WEEK).toBe(0)
    expect(mar.cells.length % DAYS_PER_WEEK).toBe(0)
    expect(feb.cells.length).toBe(feb.rows * DAYS_PER_WEEK)
    expect(mar.cells.length).toBe(mar.rows * DAYS_PER_WEEK)
    expect(feb.weeks.length).toBe(feb.rows)

    // 行数必须随月份真实变化 —— 钉住「恒定 6 行 42 格」那个真 Bug 不再复发
    const rowCounts = new Set()
    for (let m = 1; m <= 12; m += 1) rowCounts.add(monthGrid(2026, m, { weekStartsOn: 1 }).rows)
    expect([...rowCounts].every(n => n >= 4 && n <= 6)).toBe(true)
    expect(rowCounts.has(5), '没有任何月份是 5 行 —— 恒定 42 格的 Bug 复发了').toBe(true)
    expect(rowCounts.size, '全年行数恒定 —— 网格没有按真实月历排布').toBeGreaterThan(1)
    // 2026-02 恰好 28 天 + 6 天前导 = 5 行 35 格（就是修复后应当出现的那一档）
    expect(feb.rows).toBe(5)
    expect(feb.cells.length).toBe(35)
  })

  it('H2 图谱：三种边都有权重，相似边为 0.5；无 similar 边时也不造边', () => {
    expect(EDGE_WEIGHT.wiki).toBeGreaterThan(EDGE_WEIGHT.tag)
    expect(EDGE_WEIGHT.tag).toBeGreaterThan(EDGE_WEIGHT.similar)
    expect(EDGE_WEIGHT.similar).toBe(0.5)
    expect(Object.keys(EDGE_KINDS).sort()).toEqual(['similar', 'tag', 'wiki'])

    const notes = [
      { id: 'a', title: 'A', content: '[[B]] 提到了 B', tags: ['t'], filePath: `${ROOT}/A.md` },
      { id: 'b', title: 'B', content: 'B 的正文', tags: ['t'], filePath: `${ROOT}/B.md` }
    ]
    const withSimilar = buildLinkEdges({ notes, includeSimilar: true })
    const wikiOnly = buildLinkEdges({ notes, mode: 'wiki-only', includeSimilar: true })

    expect(Array.isArray(withSimilar)).toBe(true)
    expect(withSimilar.length, '双链没能建出边').toBeGreaterThan(0)
    // wiki-only 模式下不该出现 tag / similar 边
    for (const e of wikiOnly) expect(e.kind).toBe('wiki')
    // 每条边都必须有 kind 与 weight（面板计数与渲染依赖它）
    for (const e of withSimilar) {
      expect(typeof e.kind).toBe('string')
      expect(typeof e.weight).toBe('number')
      expect(Object.values(EDGE_KINDS)).toContain(e.kind)
    }
    expect(withSimilar.some(e => e.kind === 'wiki')).toBe(true)
  })
})

// ===========================================================================
// H · W4 · 删除失败必须「笔记留在库里 + 把原因告诉用户」
//
// 背景：deleteNoteOp 原先对每条候选路径调 deleteFile 后**无条件** splice，失败只写
// 一行日志。于是文件路径还在磁盘上、内存里却没了这篇笔记 —— 下次启动它「复活」，
// 用户再建同名笔记还可能把真文件覆盖掉（BUG-1）。
// 同时 detail 通道（{ detail: true }）接了一半：主进程失败时回的是**真值对象**
// `{ ok:false, ... }` 而不是抛异常，代码只读了 method、没人读 ok（BUG-2）。
//
// 这七条每条都过故障注入自检：把实现改回旧样子，对应那条必须变红。
// ===========================================================================

describe('H · W4 删除失败不出库 + 失败原因可达 UI', () => {
  it('H1 ★ deleteFile 抛异常 → 笔记仍在库中、磁盘文件仍在、lastDeleteError 非空', async () => {
    addNote({ id: 'a', title: 'A' })
    const filePath = `${ROOT}/A.md`
    disk.deleteFileImpl = async () => { throw new Error('EBUSY: 文件被其它程序占用') }

    await store.deleteNote('a')

    // BUG-1 的核心：console.error 里留下一行痕迹是不够的，库里必须还有它
    expect(byId('a'), '删除失败却把笔记从库里摘了').toBeTruthy()
    expect(disk.files.has(filePath), '磁盘文件不该被删掉').toBe(true)
    expect(store.lastDeleteError).toBeTruthy()
    expect(store.lastDeleteError).toContain('EBUSY')
    // 失败时不该上报删除方式（Sidebar 读到它就会谎报成功）
    expect(store.lastTrashMethod, '失败时不能记录删除方式').toBe('')
    // 「内存 ↔ 磁盘」必须仍然一致：不再出现「磁盘上有、内存里没有」的孤儿文件
    expect(diskMismatch()).toEqual([])
    // 没有产生任何变化 → 不该往撤回栈里塞一条空操作
    expect(getUndoStack().length, '删除失败不应登记撤回条目').toBe(0)
  })

  it('H2 ★ deleteFile 回 {ok:false}（detail 形态真值对象）→ 同样不出库', async () => {
    addNote({ id: 'a', title: 'A' })
    const filePath = `${ROOT}/A.md`
    // BUG-2：这是**真值对象**，只判真假会被当成成功
    disk.deleteFileImpl = async () => ({
      ok: false, error: 'delete-failed', errno: -4042, message: '回收站不可用'
    })

    await store.deleteNote('a')

    expect(byId('a'), 'ok:false 被当成了成功').toBeTruthy()
    expect(disk.files.has(filePath)).toBe(true)
    expect(store.lastDeleteError).toBeTruthy()
    expect(store.lastDeleteError).toContain('回收站不可用')
    expect(store.lastTrashMethod).toBe('')
    expect(diskMismatch()).toEqual([])
  })

  it('H3 deleteFile 回 {ok:true, method:system-trash} → 正常出库并记下方式', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileImpl = async (p) => {
      disk.files.delete(p)
      return { ok: true, method: TRASH_METHOD_SYSTEM, path: p }
    }

    await store.deleteNote('a')

    expect(byId('a')).toBeUndefined()
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(false)
    expect(store.lastDeleteError, '成功时不该留下失败原因').toBe('')
    expect(store.lastTrashMethod).toBe(TRASH_METHOD_SYSTEM)
  })

  it('H4 向后兼容：老形态 true（不抛异常也不回对象）→ 仍视为成功', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileImpl = async (p) => { disk.files.delete(p); return true }

    await store.deleteNote('a')

    expect(byId('a'), '老形态 true 必须仍算删除成功').toBeUndefined()
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(false)
    expect(store.lastDeleteError).toBe('')
    // 老形态读不到 method，仍是未知 —— 这与 W3 的约定一致
    expect(store.lastTrashMethod).toBe('')
  })

  it('H5 ★ 向后兼容：老形态 false 必须算失败（归一式不能写成 Boolean(raw)）', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileImpl = async () => false

    await store.deleteNote('a')

    expect(byId('a'), 'false 被误判成成功').toBeTruthy()
    expect(disk.files.has(`${ROOT}/A.md`)).toBe(true)
    expect(store.lastDeleteError).toBeTruthy()
  })

  it('H6 浏览器模式（无 electronAPI）→ 没有磁盘可删，笔记照常出库', async () => {
    addNote({ id: 'a', title: 'A' })
    delete window.electronAPI

    await store.deleteNote('a')

    expect(byId('a'), '浏览器模式下删不掉 = 功能残废').toBeUndefined()
    expect(store.lastDeleteError, '浏览器模式不该报失败').toBe('')
    // 没有 IPC 通道时不该再去碰磁盘
    expect(disk.api.deleteFile).not.toHaveBeenCalled()
  })

  it('H7 candidates 为空（无 filePath 也算不出路径）→ 同样照常出库', async () => {
    addNote({ id: 'a', title: 'A', filePath: null })
    store.notesPath = null   // 拼不出 buildFilePath → candidates 为空
    // 磁盘操作恒失败：只要「拿不到 anyOk 就不出库」，这条会立刻红
    disk.deleteFileImpl = async () => ({ ok: false, error: 'never-called' })

    await store.deleteNote('a')

    expect(byId('a'), '没有磁盘路径可删时也必须能删除').toBeUndefined()
    expect(store.lastDeleteError).toBe('')
  })

  it('H8 ★ lastDeleteError 不残留：先失败再成功，第二次之后必须是空', async () => {
    addNote({ id: 'a', title: 'A' })
    disk.deleteFileImpl = async () => ({ ok: false, error: 'first-failed' })
    await store.deleteNote('a')
    expect(store.lastDeleteError).toBeTruthy()

    disk.deleteFileImpl = async (p) => { disk.files.delete(p); return true }
    await store.deleteNote('a')

    expect(store.lastDeleteError, '上一次的失败原因残留到了这次成功上').toBe('')
    expect(byId('a')).toBeUndefined()
  })

  it('H9 ★ W4-C：两条候选路径都成功时，system-trash 优先于 library-trash', async () => {
    // filePath 与「标题推出来的路径」不一致（典型场景：改过标题但还没落盘）
    addNote({ id: 'a', title: 'New', filePath: `${ROOT}/Old.md` })
    const methods = { [`${ROOT}/Old.md`]: TRASH_METHOD_SYSTEM, [`${ROOT}/New.md`]: TRASH_METHOD_LIBRARY }
    disk.deleteFileImpl = async (p) => {
      disk.files.delete(p)
      return { ok: true, method: methods[p] || TRASH_METHOD_LIBRARY, path: p }
    }

    await store.deleteNote('a')

    // 循环里后一条路径的成功不许把前一条更强的保证覆盖掉
    expect(store.lastTrashMethod, 'system-trash 被后面的 library-trash 覆盖了').toBe(TRASH_METHOD_SYSTEM)
    expect(store.lastDeleteError).toBe('')
  })
})
