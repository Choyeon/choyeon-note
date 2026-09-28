// ===========================================================================
// T24 · App.vue 接线 + 默认值翻转（批次 4 收口）
//
// 前两项（T21 主进程监听 / T22 reconcile 内核）在没接进 App.vue 之前全是死代码。
// 这个文件守的就是「那一棒」本身，分三层：
//
//   A · storage.js 的 autoSync 默认值（直接 import 常量取值，不 grep 源码）
//   B · note.js 的两个加性导出 isNoteDirty / reindexNote（真 Pinia，不是替身）
//   C · App.vue 的接线形态（去注释 + 括号配平的源码分析，容忍格式变化）
//   D · 按 App.vue 的真实形状跑一遍（真 store + 真内核 + 真门面）
//
// 为什么 C 组要「读源码」而不是挂组件：App.vue 依赖 router / CodeMirror / 主进程
// IPC，在 jsdom 里整体挂载的成本与脆弱度都远高于收益。而 R-F5 回归的唯一形态
// 是「watch 回调里出现 loadNotesFromPath」—— 这是**源码形态**问题，用源码断言
// 恰恰是最直接的判据；D 组再补上行为侧的一半。
//
// 为什么用例要能容忍格式变化：断言写成 `expect(src).not.toContain('...')` 这种
// 整行字符串匹配，别人换个换行就假红，一假红就会被注释掉。这里统一走
// 「去注释 → 按括号配对取出实参 → 在实参里找标识符」三步。
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'

import { CONFIG_SCHEMA, LS_KEYS } from '../src/constants/storage'
import { useAppStore } from '../src/stores/app'
import { useNoteStore } from '../src/stores/note'
import { createNoteStoreFacade, useExternalSync } from '../src/composables/useExternalSync'
import { EXT_PATTERN } from '../src/constants/noteFile'
import { setLogLevel, resetLogger, clearRingBuffer } from '../src/utils/logger.js'
import { cancelPendingIdMapSave } from '../src/utils/idMapStore'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..')

// ===========================================================================
// 源码分析工具（导出行内注释，便于别的批次复用）
// ===========================================================================

/**
 * 去掉 `//` 与 `/* *\/` 注释，保留字符串字面量与换行。
 *
 * 只做这一件事、不做词法分析：App.vue 里没有正则字面量，字符串一律按
 * ' " ` 三种定界 + 反斜杠转义处理就够了。
 *
 * @param {string} src 源码
 * @returns {string} 去注释后的源码
 */
export function stripComments (src) {
  let out = ''
  let i = 0
  let mode = 'code' // code | line | block | ' | " | `
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1] || ''
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i += 1; continue }
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; continue }
      if (c === '\n') out += c
      i += 1
      continue
    }
    if (c === '\\') { out += c + d; i += 2; continue }
    if (c === mode) { mode = 'code'; out += c; i += 1; continue }
    out += c
    i += 1
  }
  return out
}

/**
 * 取出 `name(...)` 的全部实参文本（按括号配对，字符串里的括号不算）。
 *
 * @param {string} src 源码（建议先过 stripComments）
 * @param {string} name 函数名 / 方法名
 * @returns {Array<string>} 每次调用的实参文本
 */
export function callArgs (src, name) {
  const out = []
  const needle = `${name}(`
  let from = 0
  for (;;) {
    const idx = src.indexOf(needle, from)
    if (idx < 0) break
    // 左侧边界：不能是标识符的一部分（避免 xxxFoo( 命中 Foo(）
    const prev = idx > 0 ? src[idx - 1] : ''
    if (/[A-Za-z0-9_$]/.test(prev)) { from = idx + 1; continue }
    let i = idx + needle.length
    let depth = 1
    let mode = 'code'
    let buf = ''
    while (i < src.length) {
      const c = src[i]
      const d = src[i + 1] || ''
      if (mode === 'code') {
        if (c === '(') { depth += 1; buf += c; i += 1; continue }
        if (c === ')') {
          depth -= 1
          if (depth === 0) break
          buf += c
          i += 1
          continue
        }
        if (c === "'" || c === '"' || c === '`') { mode = c; buf += c; i += 1; continue }
        buf += c
        i += 1
        continue
      }
      if (c === '\\') { buf += c + d; i += 2; continue }
      if (c === mode) { mode = 'code'; buf += c; i += 1; continue }
      buf += c
      i += 1
    }
    out.push(buf)
    from = idx + needle.length
  }
  return out
}

/**
 * 从箭头函数 / 匿名函数的形参文本里取第一个参数名。
 * @param {string} argText `applyExternalChanges(` 的实参文本（即回调源码）
 * @returns {string|null} 参数名；匿名无参返回 null
 */
export function firstParamName (argText) {
  const text = String(argText || '').trim()
  // (changes) => ...  |  (changes) => { ... }  |  changes => ...
  const paren = /^\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(text)
  if (paren) return paren[1]
  const bare = /^([A-Za-z_$][\w$]*)\s*=>/.exec(text)
  if (bare) return bare[1]
  const fn = /^function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(text)
  return fn ? fn[1] : null
}

/** 去注释后的 App.vue 源码（文件级读一次） */
const APP_SRC = stripComments(
  readFileSync(path.join(PROJECT_ROOT, 'src', 'App.vue'), 'utf8')
)
/** 模板部分（script setup 之前） */
const APP_TEMPLATE = APP_SRC.slice(0, Math.max(0, APP_SRC.indexOf('<script setup>')))

// ===========================================================================
// A · storage.js：autoSync 默认值翻转
// ===========================================================================

/**
 * 取 schema 里 autoSync 那一行。
 * @returns {object} schema 条目
 */
function autoSyncEntry () {
  const rows = CONFIG_SCHEMA.filter(row => row.ref === 'autoSync')
  expect(rows.length, 'CONFIG_SCHEMA 里 autoSync 必须且只能有一条').toBe(1)
  return rows[0]
}

describe('A · storage.js：autoSync 默认值必须是 true', () => {
  it('A1 localStorage key 字符串逐字保持历史值 choyeon-auto-sync（改了等于重置所有人的开关）', () => {
    expect(LS_KEYS.autoSync).toBe('choyeon-auto-sync')
    expect(autoSyncEntry().key).toBe('choyeon-auto-sync')
  })

  it('A2 fallback() 的默认值是 true —— 直接取值，不是 grep 源码', () => {
    expect(autoSyncEntry().fallback()).toBe(true)
  })

  it('A3 默认值翻转后，用户显式存过的 false 仍然生效（fallback 只在没存过时兜底）', () => {
    const parse = autoSyncEntry().parse
    expect(parse('false')).toBe(false)
    expect(parse('true')).toBe(true)
  })

  it('A4 schema 条目的 ref 名是 autoSync —— 与 appStore.autoSync / App.vue 的 watch 同口径', () => {
    expect(autoSyncEntry().ref).toBe('autoSync')
  })

  it('A5 全表 ref 名不重复（重复会出现「后者覆盖前者」的静默 bug）', () => {
    const refs = CONFIG_SCHEMA.map(r => r.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('A6 全新安装（key 不存在）时 appStore.autoSync 就是 true —— 默认值真正的出处', () => {
    // ⚠️ fallback 只被 resetConfig 用到；key 缺失时 loadConfig 直接 continue，
    // 所以「新用户拿到什么」由 app.js 里那个 ref 的初值决定。两边都要是 true。
    localStorage.removeItem('choyeon-auto-sync')
    setActivePinia(createPinia())
    const app = useAppStore()
    app.initTheme() // loadConfig 挂在 initTheme 上（App.vue onMounted 调的就是它）
    expect(app.autoSync).toBe(true)
  })

  it('A7 用户显式关掉（存了 false）仍然生效 —— 翻转默认值不能覆盖用户选择', () => {
    localStorage.setItem('choyeon-auto-sync', 'false')
    setActivePinia(createPinia())
    const app = useAppStore()
    app.initTheme()
    expect(app.autoSync).toBe(false)
    localStorage.removeItem('choyeon-auto-sync')
  })
})

// ===========================================================================
// B · note.js 的两个加性导出
// ===========================================================================

const ROOT = 'C:/t24-notes'
const P_A = `${ROOT}/A.md`
const P_B = `${ROOT}/B.md`

let disk = null
let store = null
let wiring = null
let notifications = null

/**
 * 最小假磁盘（只实现本文件用得到的四个 IPC）。
 * @returns {object} { files, api }
 */
function createDisk () {
  const files = new Map()
  const read = (p) => {
    if (files.has(p)) return files.get(p)
    const relaxed = String(p).replace(/\\/g, '/')
    return files.has(relaxed) ? files.get(relaxed) : null
  }
  return {
    files,
    api: {
      readFile: vi.fn(async (p) => read(p)),
      readFiles: vi.fn(async ({ paths }) => ({
        files: paths.map(p => ({ path: p, content: read(p) })).filter(f => f.content !== null),
        errors: []
      })),
      writeFile: vi.fn(async (p, content) => {
        files.set(p, content)
        return true
      }),
      fileExists: vi.fn(async (p) => read(p) !== null),
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
  }
}

/** 按路径取库里的笔记 */
function noteAt (p) {
  return store.notes.find(n => n.filePath === p) || null
}

beforeEach(async () => {
  setLogLevel('silent')
  // 自动保存的 500ms 防抖定时器会把「刚改过」的笔记落盘并清掉 dirty，
  // 那正是本文件要断言的东西 —— 冻结时钟，让 dirty 停在用户敲完字的那一刻。
  vi.useFakeTimers()
  setActivePinia(createPinia())

  disk = createDisk()
  disk.files.set(P_A, '# 笔记A\n\n正文A')
  disk.files.set(P_B, '# 笔记B\n\n正文B')
  window.electronAPI = disk.api

  store = useNoteStore()
  await store.loadNotesFromPath(ROOT)

  notifications = []
  // 与 App.vue **逐字同形**的接线：门面注入 isDirty（走新导出的 isNoteDirty），
  // readFile 走 IPC，onNotify 走 pushToast。
  const facade = createNoteStoreFacade(store, {
    readFile: (p) => window.electronAPI?.readFile?.(p),
    isDirty: (id) => store.isNoteDirty(id)
  })
  wiring = useExternalSync({
    noteStore: facade,
    readFile: (p) => window.electronAPI?.readFile?.(p),
    isNoteExtension: (p) => EXT_PATTERN.test(String(p || '')),
    onNotify: ({ type, message }) => notifications.push({ type, message })
  })
})

afterEach(() => {
  store.clearPendingSaves()
  cancelPendingIdMapSave()
  clearRingBuffer()
  resetLogger()
  setLogLevel('info')
  vi.useRealTimers()
  delete window.electronAPI
  vi.restoreAllMocks()
})

describe('B · note.js 加性导出：isNoteDirty / reindexNote', () => {
  it('B1 useNoteStore() 确实导出了这两个函数（T22 报的接线缺口）', () => {
    expect(typeof store.isNoteDirty).toBe('function')
    expect(typeof store.reindexNote).toBe('function')
  })

  it('B2 isNoteDirty 反映真实的「改过但还没落盘」', () => {
    const idB = noteAt(P_B).id
    expect(store.isNoteDirty(idB), '刚载入').toBe(false)
    store.updateNoteContent(idB, '# 笔记B\n\n我刚敲的字')
    expect(store.isNoteDirty(idB), '改完还没到防抖时间').toBe(true)
  })

  it('B3 isNoteDirty 对不存在的 id 返回 false（不抛、不误判）', () => {
    expect(store.isNoteDirty('压根不存在')).toBe(false)
    expect(store.isNoteDirty('')).toBe(false)
    expect(store.isNoteDirty(null)).toBe(false)
  })

  it('B4 reindexNote 让索引增量生效，不必等下次全量载入', () => {
    const idA = noteAt(P_A).id
    const noteB = noteAt(P_B)
    expect(store.getBacklinks(idA), '改之前 B 没链 A').toEqual([])

    // 绕开 updateNoteContent（它自己会 reindex），直接改内存对象再手动登记 ——
    // 这正是外部同步改完 content 之后要走的那一步
    noteB.content = '# 笔记B\n\n指向 [[笔记A]] 的新链接'
    store.reindexNote(noteB)

    expect(store.getBacklinks(idA).map(link => link.fromId)).toEqual([noteB.id])
  })
})

// ===========================================================================
// C · App.vue 接线形态（静态源码断言）
// ===========================================================================

describe('C · App.vue 接线形态', () => {
  it('C0 前置检查：去注释后的源码里 loadNotesFromPath 仍然存在（首屏载入），负向断言不是空跑', () => {
    expect(APP_SRC).toMatch(/loadNotesFromPath/)
  })

  it('C1 onNotesExternalChange 已注册，且回调带一个形参', () => {
    const args = callArgs(APP_SRC, 'onNotesExternalChange')
    expect(args.length, '必须注册外部变更订阅').toBeGreaterThan(0)
    const param = firstParamName(args[0])
    expect(param, '回调必须接收 changes 形参').toBeTruthy()
  })

  it('C2 R-F5 回归闸：watch 回调里不再调用 loadNotesFromPath（整库全量重载）', () => {
    const args = callArgs(APP_SRC, 'onNotesExternalChange')
    expect(args.length).toBeGreaterThan(0)
    for (const arg of args) {
      expect(arg, '外部变更回调里不允许出现整库重载').not.toMatch(/loadNotesFromPath/)
    }
  })

  it('C3 watch 回调把收到的 changes 原样交给 apply（形参必须被用上，不是摆设）', () => {
    const arg = callArgs(APP_SRC, 'onNotesExternalChange')[0]
    const param = firstParamName(arg)
    expect(new RegExp(`apply\\w*\\s*\\(\\s*${param}\\s*\\)`).test(arg)).toBe(true)
  })

  it('C4 useExternalSync 的返回值必须解构出 conflicts / apply / resolve', () => {
    // 不解构的话模板里的 sync.conflicts 是一个 Ref，Vue 不替你脱那层
    const m = /const\s*\{([^}]*)\}\s*=\s*useExternalSync\s*\(/.exec(APP_SRC)
    expect(m, '必须写成 const { ... } = useExternalSync(...)').toBeTruthy()
    expect(m[1]).toMatch(/\bconflicts\b/)
    expect(m[1]).toMatch(/\bapply\b/)
    expect(m[1]).toMatch(/\bresolve\b/)
  })

  it('C5 门面注入了 isDirty（走 noteStore.isNoteDirty），缺了它只有当前笔记受保护', () => {
    const args = callArgs(APP_SRC, 'createNoteStoreFacade')
    expect(args.length).toBeGreaterThan(0)
    expect(args[0]).toMatch(/isDirty/)
    expect(args[0]).toMatch(/isNoteDirty/)
  })

  it('C6 模板里挂了 ConflictDialog：队列整队传入 + resolve 事件接回', () => {
    expect(APP_TEMPLATE).toMatch(/<ConflictDialog/)
    expect(APP_TEMPLATE).toMatch(/:conflicts\s*=\s*["']conflicts["']/)
    expect(APP_TEMPLATE).toMatch(/@resolve\s*=\s*["']onResolveConflict["']/)
    expect(APP_SRC).toMatch(/import\s+ConflictDialog\s+from/)
  })

  it('C7 onResolveConflict 把 id / choice 交给 resolve —— 不接的话冲突永远不消', () => {
    expect(APP_SRC).toMatch(/function\s+onResolveConflict\s*\(/)
    const args = callArgs(APP_SRC, 'resolveConflict')
    expect(args.length, '必须有地方调用 resolve').toBeGreaterThan(0)
    expect(args.some(a => /\bid\b/.test(a) && /\bchoice\b/.test(a))).toBe(true)
  })

  it('C8 浏览器环境（没有 window.electronAPI）整段跳过，不报错', () => {
    const args = callArgs(APP_SRC, 'syncNotesWatch')
    // 函数体里必须有可选链守卫：window.electronAPI 不存在时直接 return
    const body = APP_SRC.slice(APP_SRC.indexOf('function syncNotesWatch'))
    expect(body.slice(0, 400)).toMatch(/window\.electronAPI\s*\?\./)
  })

  it('C9 生命周期保住了：卸载时退订（防止监听器泄漏到下一个实例）', () => {
    const args = callArgs(APP_SRC, 'onUnmounted')
    expect(args.length).toBeGreaterThan(0)
    expect(args[0]).toMatch(/stopNotesWatch\s*\(\s*\)/)
    // 同步开关 / 库路径变化时重建监听
    const watchArgs = callArgs(APP_SRC, 'watch')
    expect(watchArgs.some(a => /autoSync/.test(a))).toBe(true)
  })

  it('C10 订阅受 appStore.autoSync 控制 —— 默认值翻转正是靠这条落到实处', () => {
    const body = APP_SRC.slice(APP_SRC.indexOf('function syncNotesWatch'))
    const head = body.slice(0, 600)
    expect(head).toMatch(/appStore\.autoSync/)
  })
})

// ===========================================================================
// D · 按 App.vue 的真实形状跑一遍（行为侧）
// ===========================================================================

describe('D · 真实形状跑一遍：R-F5 / R-F6', () => {
  it('D1 R-F5 主验收：正在编辑 A 时外部改 B → B 更新、A 的内容与对象引用都不动', async () => {
    const noteA = noteAt(P_A)
    const beforeA = noteA.content
    store.currentNoteId = noteA.id
    disk.files.set(P_B, '# 笔记B\n\n别人改过的B')

    const result = await wiring.apply([{ path: P_B, kind: 'change' }])

    expect(result.updated).toBe(1)
    expect(result.conflicted).toBe(0)
    // A：内容、对象引用、仍是当前笔记，三样都没变
    expect(noteAt(P_A).content).toBe(beforeA)
    expect(noteAt(P_A)).toBe(noteA)
    expect(store.currentNoteId).toBe(noteA.id)
    // B：拿到的是磁盘上的新内容
    expect(noteAt(P_B).content).toBe('# 笔记B\n\n别人改过的B')
    expect(wiring.conflicts.value).toEqual([])
  })

  it('D2 dirty 的「非当前笔记」也受保护（isNoteDirty 接上之前只有当前笔记受保护）', async () => {
    const idA = noteAt(P_A).id
    const idB = noteAt(P_B).id
    store.currentNoteId = idA // 当前是 A，B 只是「切走前敲了字」
    store.updateNoteContent(idB, '# 笔记B\n\n我在B里敲的字')
    expect(store.isNoteDirty(idB)).toBe(true)

    disk.files.set(P_B, '# 笔记B\n\n外部改写的B')
    const result = await wiring.apply([{ path: P_B, kind: 'change' }])

    expect(result.conflicted).toBe(1)
    expect(result.updated).toBe(0)
    // 内存版一个字节都没被覆盖
    expect(noteAt(P_B).content).toBe('# 笔记B\n\n我在B里敲的字')
    expect(wiring.conflicts.value.map(c => c.id)).toEqual([idB])
  })

  it('D3 选「我的修改」：出队 + 写回磁盘，冲突不残留', async () => {
    const idB = noteAt(P_B).id
    store.updateNoteContent(idB, '# 笔记B\n\n我的稿子')
    disk.files.set(P_B, '# 笔记B\n\n外部的版本')
    await wiring.apply([{ path: P_B, kind: 'change' }])
    expect(wiring.conflicts.value.length).toBe(1)

    await wiring.resolve(idB, 'memory')

    expect(wiring.conflicts.value).toEqual([])
    expect(disk.files.get(P_B)).toBe('# 笔记B\n\n我的稿子')
  })

  it('D4 选「磁盘版本」：内存被覆盖成磁盘内容，冲突出队', async () => {
    const idB = noteAt(P_B).id
    store.updateNoteContent(idB, '# 笔记B\n\n我的稿子')
    disk.files.set(P_B, '# 笔记B\n\n外部的版本')
    await wiring.apply([{ path: P_B, kind: 'change' }])

    await wiring.resolve(idB, 'disk')

    expect(wiring.conflicts.value).toEqual([])
    expect(noteAt(P_B).content).toBe('# 笔记B\n\n外部的版本')
  })

  it('D4b 已知缺口（登记，不是期望行为）：选「磁盘版本」后 dirty 标记不会立刻清除', async () => {
    // 内核清 dirty 的两条路都要摸到那个 Set：facade.dirtyNotes 与 store.clearNoteDirty。
    // 前者 note.js 没导出（模块私有 Set），后者不存在 —— T24 只获准加性导出
    // isNoteDirty / reindexNote 两项，所以这条路的最后一步还是断的。
    //
    // 实际影响：残留的 dirty 会让下一次防抖自动保存把「已经是磁盘版」的内容再写
    // 一遍 —— 内容一致，不丢稿，代价是一次多余写盘（会被 isSelfWrite 过滤掉回声）。
    // 后续若补上 dirtyNotes（或 clearNoteDirty）导出，请把本条的 true 翻成 false。
    const idB = noteAt(P_B).id
    store.updateNoteContent(idB, '# 笔记B\n\n我的稿子')
    disk.files.set(P_B, '# 笔记B\n\n外部的版本')
    await wiring.apply([{ path: P_B, kind: 'change' }])
    await wiring.resolve(idB, 'disk')

    expect(store.isNoteDirty(idB)).toBe(true)
  })

  it('D5 onNotify 接得上：App.vue 就是靠它把「更新 N 篇 / N 篇冲突」送进 pushToast', async () => {
    disk.files.set(`${ROOT}/C.md`, '# 笔记C\n\n新增的C')
    await wiring.apply([{ path: `${ROOT}/C.md`, kind: 'add' }])

    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications.some(n => /新增 1 篇/.test(n.message))).toBe(true)
  })
})
