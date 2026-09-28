// ============================================================================
// trashIndex.test.js —— 回收站内格（src/utils/trashIndex.js）的单元测试
//
// 为什么要有**两套** filesystem adapter：
//   · memFs（内存，时钟可控）——跑降级 / 过期 / 越界这类「不好在真盘上构造」的
//     分支，毫秒级、零 IO，30 天过期不需要真的等 30 天，也不依赖系统时间；
//   · realFs（真的 os.tmpdir）——跑「删除 → 还原 → 内容字节一致」这条主链路。
//     这条链路是整个 R-D5 的验收核心，用假 fs 自证有点自欺欺人：真盘上过一遍
//     rename / mkdir -p / recursive stat，并用 sha256 比对前后内容，才能说
//     「还原回来的就是原来那篇笔记」。
//
// 两套 adapter 喂给的是**同一个**内核 —— 内核不知道自己在真盘还是内存里，这正
// 是依赖注入的意义：被测的策略只有一份。
//
// 不 import vue / pinia：本用例只测纯内核，渲染侧接线由 appSyncWiring 之类的
// 用例负责。
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  createTrashIndex,
  TRASH_DIR_NAME,
  TRASH_META_SUFFIX,
  TRASH_META_VERSION,
  TRASH_NAME_SEP,
  DEFAULT_RETENTION_DAYS,
  DAY_MS,
  TRASH_ERROR_CODES,
  formatTrashStamp,
  parseTrashStamp,
  makeTrashName,
  parseTrashName,
  metaNameOf,
  isTrashMetaName,
  isTrashNoiseName,
  isWithinRoot
} from '../src/utils/trashIndex.js'

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD_PATH = path.join(REAL_ROOT, 'electron', 'preload.cjs')
const MAIN_PATH = path.join(REAL_ROOT, 'electron', 'main.cjs')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** Windows 上是 \，posix 是 / —— 断言统一用 / 便于书写 */
const slash = (p) => p.replace(/\\/g, '/')

// ---------------------------------------------------------------------------
// adapter 1：真的 node fs（主链路验证用）
// ---------------------------------------------------------------------------

function createRealFsAdapter () {
  return {
    listDir: (dir) => fs.readdir(dir, { withFileTypes: true }),
    stat: async (p) => {
      const s = await fs.stat(p)
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() }
    },
    exists: async (p) => {
      try {
        await fs.access(p)
        return true
      } catch {
        return false
      }
    },
    makeDir: (dir) => fs.mkdir(dir, { recursive: true }),
    move: async (src, dst) => {
      // 先确认目标的父目录存在 —— **这里不能替内核兜底**。
      // 曾经这一层是「rename 失败就 cp」而 cp 自带 mkdir -p 语义，于是内核里少了
      // 一句 mkdir 也照样全绿（FI-1 就是被它放过去的，直到把注入做完才发现——忘了
      // 建父目录是真实会发生的回归：原文件夹被整个删掉后必须重建才能还原回去）。
      // adapter 的职责是模拟真实磁盘，不是替被测代码擦屁股。
      const parentDir = path.dirname(dst)
      try {
        await fs.access(parentDir)
      } catch (error) {
        const err = new Error(`ENOENT: no such directory, move target parent missing: ${parentDir}`)
        err.code = 'ENOENT'
        throw err
      }
      try {
        await fs.rename(src, dst)
      } catch (error) {
        // 父目录还在但 rename 失败（跨设备 / 占用）：copy + 递归删除兜底
        await fs.cp(src, dst, { recursive: true, force: true })
        await fs.rm(src, { recursive: true, force: true })
      }
    },
    remove: (p) => fs.rm(p, { recursive: true, force: true }),
    readMeta: async (p) => {
      try {
        return JSON.parse(await fs.readFile(p, 'utf-8'))
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
    },
    writeMeta: (p, meta) => fs.writeFile(p, JSON.stringify(meta, null, 2), 'utf-8'),
    now: () => Date.now(),
    path
  }
}

// ---------------------------------------------------------------------------
// adapter 2：内存 fs（时钟可控，构造异常场景用）
// ---------------------------------------------------------------------------

/**
 * 极简虚拟文件系统：只实现内核用到的六个动词。
 * 节点用扁平 Map 存 path → { kind, data, mtimeMs }，目录的子节点靠路径前缀推算。
 */
function createMemFs (startMs = 1700000000000) {
  /** @type {Map<string, {kind: 'file'|'dir', data: Buffer|null, mtimeMs: number}>} */
  const nodes = new Map()
  let clock = startMs

  // ---- 路径 key 约定 ----
  // 所有 key 都是「resolve → 统一成 / → 去掉结尾斜杠」的形式：
  //   posix 根的表现是 `''`，Windows 盘符根是 `'D:'`。
  // 这里**不能**用 path.dirname 逐层上溯：一旦从 'D:/' 退到 'D:'，再喂回
  // path.resolve 会被当成「D 盘当前目录」而不是根目录，于是又开始往上爬 ——
  // 在某台机器上它会一直爬到你怀疑人生。改成纯字符串砍掉最后一段，长度严格递减，
  // 终止性是构造出来的，不依赖 path 的实现细节。
  const normKey = (p) => slash(path.resolve(p)).replace(/\/+$/, '')

  /** 上一层 key；已经到根就返回 null */
  function parentKey (k) {
    if (k === '' || k === null) return null
    const idx = k.lastIndexOf('/')
    if (idx < 0) return null
    return k.slice(0, idx)
  }

  /** 连它的所有祖宗目录一起建出来 */
  function ensureDir (dir) {
    let cursor = normKey(dir)
    while (cursor !== null && cursor !== '') {
      if (!nodes.has(cursor)) nodes.set(cursor, { kind: 'dir', data: null, mtimeMs: clock })
      cursor = parentKey(cursor)
    }
  }

  const api = {
    /** 测试用：写一个文件（自动建父目录） */
    writeFile (p, content, mtimeMs = clock) {
      ensureDir(path.dirname(p))
      nodes.set(normKey(p), {
        kind: 'file',
        data: Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf-8'),
        mtimeMs
      })
      return normKey(p)
    },
    /** 测试用：读文件内容 Buffer */
    readFile (p) {
      const node = nodes.get(normKey(p))
      return node && node.kind === 'file' ? node.data : null
    },
    /** 测试用：直接塞一个坏 meta（JSON 语法错了） */
    writeRawMeta (p, raw) {
      ensureDir(path.dirname(p))
      nodes.set(normKey(p), { kind: 'file', data: Buffer.from(raw, 'utf-8'), mtimeMs: clock })
      return normKey(p)
    },
    setClock (ms) { clock = ms },
    tick (ms) { clock += ms; return clock },
    getClock: () => clock,
    has: (p) => nodes.has(normKey(p)),
    /** 测试用：列出全部路径，便于写断言 */
    keys: () => [...nodes.keys()],

    // ---- 以下是注入给内核的部分 ----
    listDir: async (dir) => {
      const target = normKey(dir)
      const prefix = target === '' ? '/' : `${target}/`
      const seen = new Set()
      const out = []
      for (const full of nodes.keys()) {
        if (full === target || full === '/') continue
        if (!full.startsWith(prefix)) continue
        const rest = full.slice(prefix.length)
        const name = rest.split('/')[0]
        if (!name || seen.has(name)) continue
        seen.add(name)
        const childKey = prefix + name
        const node = nodes.get(childKey)
        out.push({ name, isDirectory: node ? node.kind === 'dir' : rest.includes('/') })
      }
      return out
    },
    stat: async (p) => {
      const node = nodes.get(normKey(p))
      if (!node) {
        const err = new Error(`ENOENT: ${p}`)
        err.code = 'ENOENT'
        throw err
      }
      return {
        size: node.kind === 'file' ? node.data.length : 0,
        mtimeMs: node.mtimeMs,
        isDirectory: node.kind === 'dir'
      }
    },
    exists: async (p) => nodes.has(normKey(p)),
    makeDir: async (dir) => { ensureDir(dir) },
    move: async (src, dst) => {
      const from = normKey(src)
      const to = normKey(dst)
      const node = nodes.get(from)
      if (!node) {
        const err = new Error(`ENOENT: ${src}`)
        err.code = 'ENOENT'
        throw err
      }
      if (node.kind === 'dir') {
        const prefix = `${from}/`
        for (const full of [...nodes.keys()]) {
          if (full === from || full.startsWith(prefix)) {
            const rest = full.slice(from.length)
            nodes.set(to + rest, nodes.get(full))
            nodes.delete(full)
          }
        }
      } else {
        nodes.set(to, node)
        nodes.delete(from)
      }
      ensureDir(path.dirname(dst))
    },
    remove: async (p) => {
      const target = normKey(p)
      const node = nodes.get(target)
      if (!node) {
        const err = new Error(`ENOENT: ${p}`)
        err.code = 'ENOENT'
        throw err
      }
      if (node.kind === 'dir') {
        const prefix = `${target}/`
        for (const full of [...nodes.keys()]) {
          if (full === target || full.startsWith(prefix)) nodes.delete(full)
        }
      } else {
        nodes.delete(target)
      }
    },
    readMeta: async (p) => {
      const node = nodes.get(normKey(p))
      if (!node) return null
      if (node.kind !== 'file') return null
      return JSON.parse(node.data.toString('utf-8'))
    },
    writeMeta: async (p, meta) => {
      ensureDir(path.dirname(p))
      nodes.set(normKey(p), {
        kind: 'file',
        data: Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'),
        mtimeMs: clock
      })
    },
    now: () => clock,
    path
  }
  return api
}

/** 用 memFs 造一个内核实例 */
function memKernel (mem, opts = {}) {
  return createTrashIndex(mem, opts)
}

// ---------------------------------------------------------------------------
// A. 纯 helper：文件名 ⇄ 元数据
// ---------------------------------------------------------------------------

describe('trashIndex · 文件名编解码', () => {
  it('formatTrashStamp 产出文件名安全的时间戳（不含冒号与点）', () => {
    const stamp = formatTrashStamp(Date.UTC(2024, 4, 5, 12, 34, 56, 789))
    expect(stamp).toBe('2024-05-05T12-34-56-789Z')
    expect(stamp).not.toMatch(/[:.]/)
  })

  it('parseTrashStamp 能精确还原到毫秒', () => {
    const ms = Date.UTC(2024, 4, 5, 12, 34, 56, 789)
    expect(parseTrashStamp(formatTrashStamp(ms))).toBe(ms)
  })

  it('parseTrashStamp 拒绝非法前缀', () => {
    expect(parseTrashStamp('not-a-stamp')).toBeNull()
    expect(parseTrashStamp('2024-05-05')).toBeNull()
    expect(parseTrashStamp(null)).toBeNull()
  })

  it('makeTrashName / parseTrashName 往返一致', () => {
    const ms = Date.UTC(2024, 10, 11, 1, 2, 3, 4)
    const name = makeTrashName('周报.md', ms)
    expect(name).toBe(`2024-11-11T01-02-03-004Z${TRASH_NAME_SEP}周报.md`)
    expect(parseTrashName(name)).toEqual({ trashedAt: ms, base: '周报.md' })
  })

  it('parseTrashName 兼容 T27 之前写下的旧条目名', () => {
    const legacy = '2024-05-05T12-00-00-000Z__note.md'
    const parsed = parseTrashName(legacy)
    expect(parsed).not.toBeNull()
    expect(parsed.base).toBe('note.md')
    expect(parsed.trashedAt).toBe(Date.UTC(2024, 4, 5, 12, 0, 0, 0))
  })

  it('文件名本身含分隔符时保留完整的 base（取第一个分隔符）', () => {
    const name = makeTrashName('my__note.md', Date.UTC(2024, 0, 1))
    expect(parseTrashName(name).base).toBe('my__note.md')
  })

  it('没有时间戳前缀的名字解析为 null（用户手工丢进来的文件）', () => {
    expect(parseTrashName('随便起的名字.md')).toBeNull()
    expect(parseTrashName('.DS_Store')).toBeNull()
  })

  it('metaNameOf / isTrashMetaName / isTrashNoiseName 互相自洽', () => {
    const meta = metaNameOf('2024-05-05T12-00-00-000Z__a.md')
    expect(meta.endsWith(TRASH_META_SUFFIX)).toBe(true)
    expect(isTrashMetaName(meta)).toBe(true)
    expect(isTrashNoiseName(meta)).toBe(true)
    expect(isTrashNoiseName('.DS_Store')).toBe(true)
    expect(isTrashNoiseName('2024-05-05T12-00-00-000Z__a.md')).toBe(false)
  })

  it('isWithinRoot 挡住越界与前缀陷阱', () => {
    expect(isWithinRoot('/notes', '/notes/a.md')).toBe(true)
    expect(isWithinRoot('/notes', '/notes/sub/deep/a.md')).toBe(true)
    expect(isWithinRoot('/notes', '/notes')).toBe(false) // 库根自身不算在内
    expect(isWithinRoot('/notes', '/notes-evil/a.md')).toBe(false) // 前缀陷阱
    expect(isWithinRoot('/notes', '/other/a.md')).toBe(false)
  })

  it('Windows 盘符路径：两侧都是 Windows 形态时按大小写无关比较', () => {
    expect(isWithinRoot('C:/notes', 'c:/notes/a.md')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B. 依赖注入契约
// ---------------------------------------------------------------------------

describe('trashIndex · 依赖注入契约', () => {
  it('缺少依赖时构造即抛错，并把缺哪些列清楚', () => {
    expect(() => createTrashIndex(null)).toThrow(TypeError)
    expect(() => createTrashIndex({})).toThrow(/缺少依赖/)
    // 少一个 listDir：错误信息里要点出名字，而不是让人对着 undefined 猜
    const deps = createMemFs()
    delete deps.listDir
    expect(() => createTrashIndex(deps)).toThrow(/listDir/)
  })

  it('deps.path 缺方法时构造即抛错', () => {
    const deps = createMemFs()
    const broken = Object.assign({}, deps, { path: { join: path.join } })
    expect(() => createTrashIndex(broken)).toThrow(/deps.path 缺少/)
  })

  it('TRASH_ERROR_CODES 覆盖了实现里用到的错误码', () => {
    expect(Array.isArray(TRASH_ERROR_CODES)).toBe(true)
    expect(TRASH_ERROR_CODES).toContain('target-exists')
    expect(TRASH_ERROR_CODES).toContain('outside-root')
    expect(TRASH_ERROR_CODES).toContain('not-found')
  })
})

// ---------------------------------------------------------------------------
// C. 删除 → 列表（真实 filesystem）
// ---------------------------------------------------------------------------

describe('trashIndex · 删除入站与列表（真实文件系统）', () => {
  let root = ''
  let kernel = null

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'choyeon-t27-'))
    kernel = createTrashIndex(createRealFsAdapter())
  })

  afterAll(async () => {
    try {
      await fs.rm(root, { recursive: true, force: true })
    } catch (error) {
      /* 清理失败不影响用例结论 */
    }
  })

  it('删除后条目在列表里可见，且带齐 原路径/体积/时间/类型', async () => {
    const target = path.join(root, 'sub', '周报.md')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '# 周报\ncontent', 'utf-8')

    const moved = await kernel.moveToTrash({ root, targetPath: target })
    expect(moved.ok).toBe(true)
    expect(moved.metaOk).toBe(true)

    const listed = await kernel.list({ root })
    expect(listed.ok).toBe(true)
    expect(listed.entries).toHaveLength(1)
    const entry = listed.entries[0]
    expect(entry.originPath).toBe(target)
    expect(entry.kind).toBe('file')
    expect(entry.size).toBe(Buffer.byteLength('# 周报\ncontent', 'utf-8'))
    expect(entry.trashedAt).toBeGreaterThan(0)
    expect(entry.degraded).toBe(false)
    expect(entry.hasMeta).toBe(true)
    expect(slash(entry.trashPath)).toContain(`/${TRASH_DIR_NAME}/`)
  })

  it('入站后 .md 内容一个字节都没被改写（no frontmatter 注入）', async () => {
    const content = '# 原始内容\n不会被加任何元数据\n'
    const target = path.join(root, 'clean.md')
    await fs.writeFile(target, content, 'utf-8')
    const before = sha256(await fs.readFile(target))

    await kernel.moveToTrash({ root, targetPath: target })
    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.name === 'clean.md')
    expect(entry).toBeTruthy()
    const after = sha256(await fs.readFile(entry.trashPath))
    expect(after).toBe(before) // 元数据住在 sidecar 里，绝不写进用户的 .md
  })

  it('同名笔记放在不同目录也各自记得自己的家', async () => {
    const a = path.join(root, 'dirA', 'same.md')
    const b = path.join(root, 'dirB', 'same.md')
    await fs.mkdir(path.dirname(a), { recursive: true })
    await fs.mkdir(path.dirname(b), { recursive: true })
    await fs.writeFile(a, 'A 分支的内容', 'utf-8')
    await fs.writeFile(b, 'B 分支的内容', 'utf-8')

    await kernel.moveToTrash({ root, targetPath: a })
    await kernel.moveToTrash({ root, targetPath: b, nowMs: Date.now() + 1 })

    const listed = await kernel.list({ root })
    const origins = listed.entries.filter((e) => e.name === 'same.md').map((e) => slash(e.originPath))
    expect(origins).toHaveLength(2)
    expect(origins.some((p) => p.endsWith('/dirA/same.md'))).toBe(true)
    expect(origins.some((p) => p.endsWith('/dirB/same.md'))).toBe(true)
    // 两条不能共用一个 .trash 里的名字 —— 否则后一条会静默覆盖前一条
    const names = listed.entries.filter((e) => e.name.startsWith('same')).map((e) => e.trashName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('同一毫秒内的同名冲突自动改名而不是覆盖', async () => {
    const ms = Date.UTC(2024, 6, 7, 8, 9, 10, 11)
    const first = path.join(root, 'collide', 'dup.md')
    await fs.mkdir(path.dirname(first), { recursive: true })
    await fs.writeFile(first, '第一份', 'utf-8')
    await kernel.moveToTrash({ root, targetPath: first, nowMs: ms })

    // 同名文件原处再生成一次，同一毫秒再删一次
    await fs.writeFile(first, '第二份', 'utf-8')
    await kernel.moveToTrash({ root, targetPath: first, nowMs: ms })

    const listed = await kernel.list({ root })
    const dups = listed.entries.filter((e) => e.trashName.includes('dup'))
    expect(dups).toHaveLength(2)
    const bodies = await Promise.all(dups.map((e) => fs.readFile(e.trashPath, 'utf-8')))
    expect(bodies.sort()).toEqual(['第一份', '第二份'].sort())
  })

  it('目录也能整棵进站，kind=dir 且体积为递归合计', async () => {
    const dir = path.join(root, 'folder')
    await fs.mkdir(path.join(dir, 'nested'), { recursive: true })
    await fs.writeFile(path.join(dir, 'one.md'), '12345', 'utf-8')
    await fs.writeFile(path.join(dir, 'nested', 'two.md'), '1234567890', 'utf-8')

    const moved = await kernel.moveToTrash({ root, targetPath: dir })
    expect(moved.ok).toBe(true)
    expect(moved.entry.kind).toBe('dir')
    expect(moved.entry.size).toBe(15)
  })

  it('拒绝把库外的东西塞进回收站', async () => {
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'choyeon-t27-x-')), 'x.md')
    await fs.writeFile(outside, 'x', 'utf-8')
    const res = await kernel.moveToTrash({ root, targetPath: outside })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('outside-root')
    expect(await fs.readFile(outside, 'utf-8')).toBe('x') // 必须没被动过
  })

  it('缺 targetPath / root 时返回 invalid-args 或 missing-root，不抛异常', async () => {
    const res = await kernel.moveToTrash({ root, targetPath: '' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('invalid-args')
    await expect(kernel.list({})).rejects.toThrow(/缺少 root/)
    // code 是稳定的机器可读值，渲染侧若要做分支判断应当用它而不是中文 message
    await expect(kernel.list({})).rejects.toMatchObject({ code: 'missing-root' })
  })
})

// ---------------------------------------------------------------------------
// D. 还原（真实 filesystem：内容字节一致）
// ---------------------------------------------------------------------------

describe('trashIndex · 还原回原文件夹', () => {
  let root = ''
  let kernel = null

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'choyeon-t27r-'))
    kernel = createTrashIndex(createRealFsAdapter())
  })

  afterAll(async () => {
    try {
      await fs.rm(root, { recursive: true, force: true })
    } catch (error) {
      /* ignore */
    }
  })

  it('★ 核心链路：删除 → 列表可见 → 还原回原文件夹，内容字节一致', async () => {
    const body = '# 秘密笔记\n\n含中文、emoji ✨ 与换行\n第二行\n'
    const origin = path.join(root, '工作', '2024', '秘密.md')
    await fs.mkdir(path.dirname(origin), { recursive: true })
    await fs.writeFile(origin, body, 'utf-8')
    const before = sha256(await fs.readFile(origin))

    const moved = await kernel.moveToTrash({ root, targetPath: origin })
    expect(moved.ok).toBe(true)
    expect(await fs.access(origin).then(() => true, () => false)).toBe(false)

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.originPath === origin)
    expect(entry).toBeTruthy()

    const res = await kernel.restore({ root, id: entry.id })
    expect(res.ok).toBe(true)
    expect(res.path).toBe(origin)
    expect(res.renamed).toBe(false)

    const after = sha256(await fs.readFile(origin))
    expect(after).toBe(before)
    expect(await fs.readFile(origin, 'utf-8')).toBe(body)
  })

  it('还原成功后回收站里不再留有它，sidecar 也一并清掉', async () => {
    const origin = path.join(root, 'to-restore.md')
    await fs.writeFile(origin, 'body', 'utf-8')
    await kernel.moveToTrash({ root, targetPath: origin })

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.originPath === origin)
    expect(await fs.access(entry.metaPath).then(() => true, () => false)).toBe(true)

    const res = await kernel.restore({ root, id: entry.id })
    expect(res.ok).toBe(true)
    expect(res.metaCleaned).toBe(true)
    expect(res.error).toBeNull()

    const after = await kernel.list({ root })
    expect(after.entries.some((e) => e.id === entry.id)).toBe(false)
    expect(await fs.access(entry.metaPath).then(() => true, () => false)).toBe(false)
  })

  it('原文件夹已被删掉时自动重建（父目录不存在）', async () => {
    const origin = path.join(root, 'deeply', 'lost', 'dir', 'note.md')
    await fs.mkdir(path.dirname(origin), { recursive: true })
    await fs.writeFile(origin, 'find me', 'utf-8')
    await kernel.moveToTrash({ root, targetPath: origin })
    // 把整棵目录树删干净：模拟「文件夹被删了才发现里面还有笔记」
    await fs.rm(path.join(root, 'deeply'), { recursive: true, force: true })

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.originPath === origin)
    const res = await kernel.restore({ root, id: entry.id })
    expect(res.ok).toBe(true)
    expect(await fs.readFile(origin, 'utf-8')).toBe('find me')
  })

  it('原位置已有同名文件时默认拒绝，并给出 suggestedPath', async () => {
    const origin = path.join(root, 'conflict.md')
    await fs.writeFile(origin, '旧版本内容', 'utf-8')
    await kernel.moveToTrash({ root, targetPath: origin })
    await fs.writeFile(origin, '期间新建的同名文件', 'utf-8') // 占位

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.name === 'conflict.md')
    const res = await kernel.restore({ root, id: entry.id })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('target-exists')
    expect(res.suggestedPath).toBe(path.join(root, 'conflict-1.md'))
    // 占位文件不能被悄悄覆盖
    expect(await fs.readFile(origin, 'utf-8')).toBe('期间新建的同名文件')

    const renamed = await kernel.restore({ root, id: entry.id, strategy: 'rename' })
    expect(renamed.ok).toBe(true)
    expect(renamed.renamed).toBe(true)
    expect(renamed.path).toBe(path.join(root, 'conflict-1.md'))
    expect(await fs.readFile(path.join(root, 'conflict-1.md'), 'utf-8')).toBe('旧版本内容')
    expect(await fs.readFile(origin, 'utf-8')).toBe('期间新建的同名文件')
  })

  it('strategy=overwrite 时才 overwrite（UI 二次确认后）', async () => {
    const origin = path.join(root, 'ow.md')
    await fs.writeFile(origin, '被覆盖者', 'utf-8')
    await kernel.moveToTrash({ root, targetPath: origin })
    await fs.writeFile(origin, '占位者', 'utf-8')

    const entry = (await kernel.list({ root })).entries.find((e) => e.name === 'ow.md')
    const res = await kernel.restore({ root, id: entry.id, strategy: 'overwrite' })
    expect(res.ok).toBe(true)
    expect(res.path).toBe(origin)
    expect(await fs.readFile(origin, 'utf-8')).toBe('被覆盖者')
  })

  it('未知 id / 非法 id 都被挡住而不抛异常', async () => {
    const missing = await kernel.restore({ root, id: '并不存在.md' })
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('not-found')

    for (const bad of ['../../evil.md', '..', '.', 'a/b.md', '']) {
      const res = await kernel.restore({ root, id: bad })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('invalid-id')
    }
  })

  it('元数据被改写成库外路径时拒绝还原（安全边界）', async () => {
    const origin = path.join(root, 'tainted.md')
    await fs.writeFile(origin, 'content', 'utf-8')
    await kernel.moveToTrash({ root, targetPath: origin })
    const entry = (await kernel.list({ root })).entries.find((e) => e.name === 'tainted.md')
    // 模拟元数据被人为篡改：sidecar 是纯文本，不能无条件相信
    await fs.writeFile(
      entry.metaPath,
      JSON.stringify({ v: TRASH_META_VERSION, originPath: 'C:/Windows/evil.md', trashedAt: Date.now() }),
      'utf-8'
    )
    const res = await kernel.restore({ root, id: entry.id })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('outside-root')
    expect(await fs.access(entry.trashPath).then(() => true, () => false)).toBe(true) // 本体还在
  })

  it('元数据缺失的降级条目照样能还原（且不带假的「清理失败」警告）', async () => {
    const trashRootReal = path.join(root, '.trash')
    await fs.mkdir(trashRootReal, { recursive: true })
    const stamp = '2024-05-05T12-00-00-000Z__legacy.md'
    await fs.writeFile(path.join(trashRootReal, stamp), 'legacy body', 'utf-8') // 没有 sidecar

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.trashName === stamp)
    expect(entry).toBeTruthy()
    expect(entry.degraded).toBe(true)
    expect(entry.hasMeta).toBe(false)

    const res = await kernel.restore({ root, id: entry.id })
    expect(res.ok).toBe(true)
    expect(res.metaCleaned).toBe(true) // 本来就没有 sidecar：ENOENT 不算失败
    expect(res.error).toBeNull()
    expect(res.path).toBe(path.join(root, 'legacy.md'))
    expect(await fs.readFile(res.path, 'utf-8')).toBe('legacy body')
  })
})

// ---------------------------------------------------------------------------
// E. 元数据降级（内存 fs，时钟可控）
// ---------------------------------------------------------------------------

describe('trashIndex · 元数据降级', () => {
  const T0 = Date.UTC(2024, 4, 5, 12, 0, 0, 0)

  function setup () {
    const mem = createMemFs(T0)
    const root = '/root/notes'
    const trashDir = `${root}/${TRASH_DIR_NAME}`
    mem.writeFile(`${root}/a.md`, 'hello')
    return { mem, root, trashDir, kernel: memKernel(mem) }
  }

  it('没有 sidecar 时：degraded=true，且用文件名前缀还原删除时间', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = '2024-05-05T12-00-00-000Z__orphan.md'
    mem.writeFile(`${trashDir}/${name}`, 'body')

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.trashName === name)
    expect(entry).toBeTruthy()
    expect(entry.degraded).toBe(true)
    expect(entry.degradedReason).toBe('meta-missing')
    expect(entry.hasMeta).toBe(false)
    expect(entry.trashedAt).toBe(T0)
    // 位置未知 → 退到库根，UI 应当据此标注「原位置未知」
    expect(entry.originPath).toBe(path.join(root, 'orphan.md'))
    expect(entry.outsideRoot).toBe(false)
  })

  it('sidecar 是坏 JSON 时：degraded=meta-unreadable，列表不炸', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0)}${TRASH_NAME_SEP}broken.md`
    mem.writeFile(`${trashDir}/${name}`, 'body')
    mem.writeRawMeta(`${trashDir}/${metaNameOf(name)}`, '{ this is not json ')

    const listed = await kernel.list({ root })
    expect(listed.ok).toBe(true)
    const entry = listed.entries.find((e) => e.trashName === name)
    expect(entry.degraded).toBe(true)
    expect(entry.degradedReason).toBe('meta-unreadable')
  })

  it('sidecar 缺 originPath 字段时：degraded=meta-incomplete', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0)}${TRASH_NAME_SEP}partial.md`
    mem.writeFile(`${trashDir}/${name}`, 'body')
    await mem.writeMeta(`${trashDir}/${metaNameOf(name)}`, { v: TRASH_META_VERSION, trashedAt: T0 })

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.trashName === name)
    expect(entry.degraded).toBe(true)
    expect(entry.degradedReason).toBe('meta-incomplete')
    expect(entry.trashedAt).toBe(T0) // 时间仍然从文件名前缀救回来了
  })

  it('连时间戳前缀都没有的文件：删除时间取 mtime 且 > 0', async () => {
    const { mem, root, trashDir, kernel } = setup()
    mem.writeFile(`${trashDir}/手工放的.md`, 'body', T0 - 5 * DAY_MS)

    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.trashName === '手工放的.md')
    expect(entry).toBeTruthy()
    expect(entry.trashedAt).toBe(T0 - 5 * DAY_MS)
    expect(entry.trashedAt).toBeGreaterThan(0)
    expect(entry.degraded).toBe(true)
    expect(entry.degradedReason).toBe('no-timestamp')
  })

  it('列表跳过 sidecar 与点文件，不作为条目计数', async () => {
    const { mem, root, trashDir, kernel } = setup()
    mem.writeFile(`${trashDir}/${formatTrashStamp(T0)}${TRASH_NAME_SEP}real.md`, 'body')
    mem.writeFile(`${trashDir}/.DS_Store`, 'junk')
    const listed = await kernel.list({ root })
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0].name).toBe('real.md')
  })

  it('.trash 目录还不存在时 list 返回空列表而不是报错（首次使用）', async () => {
    const mem = createMemFs(T0)
    const kernel = memKernel(mem)
    mem.writeFile('/root/notes/a.md', 'x')
    const listed = await kernel.list({ root: '/root/notes' })
    expect(listed.ok).toBe(true)
    expect(listed.entries).toEqual([])
  })

  it('条目越界时打上 outsideRoot 标记，UI 可以据此置灰还原按钮', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0)}${TRASH_NAME_SEP}escapee.md`
    mem.writeFile(`${trashDir}/${name}`, 'body')
    await mem.writeMeta(`${trashDir}/${metaNameOf(name)}`, {
      v: TRASH_META_VERSION,
      originPath: '/etc/passwd',
      trashedAt: T0
    })
    const listed = await kernel.list({ root })
    const entry = listed.entries.find((e) => e.trashName === name)
    expect(entry.outsideRoot).toBe(true)
    expect(entry.originPath).toBe('/etc/passwd')
  })
})

// ---------------------------------------------------------------------------
// F. 过期清理
// ---------------------------------------------------------------------------

describe('trashIndex · 30 天过期清理', () => {
  const T0 = Date.UTC(2024, 4, 5, 12, 0, 0, 0)

  function setup () {
    const mem = createMemFs(T0)
    const root = '/root/notes'
    const trashDir = `${root}/${TRASH_DIR_NAME}`
    mem.writeFile(`${root}/a.md`, 'hello')
    return { mem, root, trashDir, kernel: memKernel(mem) }
  }

  /** 直接摆一个带完整 sidecar 的条目到 .trash 里 */
  async function plant (mem, trashDir, name, ms, originPath) {
    mem.writeFile(`${trashDir}/${name}`, 'body', ms)
    await mem.writeMeta(`${trashDir}/${metaNameOf(name)}`, {
      v: TRASH_META_VERSION,
      originPath,
      trashedAt: ms,
      name,
      kind: 'file',
      size: 4
    })
  }

  it('超过 30 天的条目会被清掉（内容 + sidecar 一起）', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0 - 31 * DAY_MS)}${TRASH_NAME_SEP}old.md`
    await plant(mem, trashDir, name, T0 - 31 * DAY_MS, `${root}/old.md`)
    expect(mem.has(`${trashDir}/${name}`)).toBe(true)

    mem.setClock(T0)
    const res = await kernel.purgeExpired({ root })
    expect(res.ok).toBe(true)
    expect(res.purged.map((p) => p.id)).toContain(name)
    expect(mem.has(`${trashDir}/${name}`)).toBe(false)
    expect(mem.has(`${trashDir}/${metaNameOf(name)}`)).toBe(false)
  })

  it('未满 30 天的条目必须保留', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0 - 29 * DAY_MS)}${TRASH_NAME_SEP}fresh.md`
    await plant(mem, trashDir, name, T0 - 29 * DAY_MS, `${root}/fresh.md`)

    mem.setClock(T0)
    const res = await kernel.purgeExpired({ root })
    expect(res.purged).toHaveLength(0)
    expect(res.kept).toContain(name)
    expect(mem.has(`${trashDir}/${name}`)).toBe(true)
  })

  it('恰好满 30 天（<= cutoff）走清理', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0 - 30 * DAY_MS)}${TRASH_NAME_SEP}border.md`
    await plant(mem, trashDir, name, T0 - 30 * DAY_MS, `${root}/border.md`)
    mem.setClock(T0)
    const res = await kernel.purgeExpired({ root })
    expect(res.purged.map((p) => p.id)).toContain(name)
  })

  it('保留天数可通过 retentionDays 覆盖（7 天场景）', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0 - 10 * DAY_MS)}${TRASH_NAME_SEP}week.md`
    await plant(mem, trashDir, name, T0 - 10 * DAY_MS, `${root}/week.md`)
    mem.setClock(T0)

    const loose = await kernel.purgeExpired({ root, retentionDays: 30 })
    expect(loose.kept).toContain(name)

    const tight = await kernel.purgeExpired({ root, retentionDays: 7 })
    expect(tight.retentionDays).toBe(7)
    expect(tight.purged.map((p) => p.id)).toContain(name)
  })

  it('dryRun 只报告不删除', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0 - 40 * DAY_MS)}${TRASH_NAME_SEP}dry.md`
    await plant(mem, trashDir, name, T0 - 40 * DAY_MS, `${root}/dry.md`)
    mem.setClock(T0)

    const res = await kernel.purgeExpired({ root, dryRun: true })
    expect(res.expired.map((e) => e.id)).toContain(name)
    expect(res.purged).toHaveLength(0)
    expect(mem.has(`${trashDir}/${name}`)).toBe(true)
  })

  it('元数据缺失的过期条目同样会被清理（时间来自文件名前缀）', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const name = `${formatTrashStamp(T0 - 45 * DAY_MS)}${TRASH_NAME_SEP}nometa.md`
    mem.writeFile(`${trashDir}/${name}`, 'body', T0 - 45 * DAY_MS)
    mem.setClock(T0)
    const res = await kernel.purgeExpired({ root })
    expect(res.purged.map((p) => p.id)).toContain(name)
    expect(mem.has(`${trashDir}/${name}`)).toBe(false)
  })

  it('purge 指定单个 id；未知 id 进 failed 而不整体失败', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const keep = `${formatTrashStamp(T0)}${TRASH_NAME_SEP}keep.md`
    const drop = `${formatTrashStamp(T0)}${TRASH_NAME_SEP}drop.md`
    await plant(mem, trashDir, keep, T0, `${root}/keep.md`)
    await plant(mem, trashDir, drop, T0, `${root}/drop.md`)

    const res = await kernel.purge({ root, ids: [drop, 'ghost.md'] })
    expect(res.purged.map((p) => p.id)).toEqual([drop])
    expect(res.failed.map((f) => f.id)).toContain('ghost.md')
    expect(res.failed.find((f) => f.id === 'ghost.md').error).toBe('not-found')
    expect(mem.has(`${trashDir}/${keep}`)).toBe(true)
    expect(mem.has(`${trashDir}/${drop}`)).toBe(false)
  })

  it('purge 不传 ids = 清空回收站（用户主动点「清空」不受 30 天限制）', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const fresh = `${formatTrashStamp(T0)}${TRASH_NAME_SEP}fresh.md`
    await plant(mem, trashDir, fresh, T0, `${root}/fresh.md`)
    const res = await kernel.purge({ root })
    expect(res.ok).toBe(true)
    expect(res.purged.map((p) => p.id)).toContain(fresh)
    expect((await kernel.list({ root })).entries).toHaveLength(0)
  })

  it('list 会算出每个条目的 expired 标记，供 UI 提示「即将过期」', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const oldName = `${formatTrashStamp(T0 - 40 * DAY_MS)}${TRASH_NAME_SEP}old.md`
    const newName = `${formatTrashStamp(T0)}${TRASH_NAME_SEP}new.md`
    await plant(mem, trashDir, oldName, T0 - 40 * DAY_MS, `${root}/old.md`)
    await plant(mem, trashDir, newName, T0, `${root}/new.md`)

    const listed = await kernel.list({ root, nowMs: T0 })
    const oldEntry = listed.entries.find((e) => e.trashName === oldName)
    const newEntry = listed.entries.find((e) => e.trashName === newName)
    expect(oldEntry.expired).toBe(true)
    expect(newEntry.expired).toBe(false)
    expect(newEntry.purgeAt).toBe(T0 + DEFAULT_RETENTION_DAYS * DAY_MS)
  })

  it('列表按删除时间倒序：最新删除的排在最前（UI 的「最近删除」直觉）', async () => {
    const { mem, root, trashDir, kernel } = setup()
    const older = `${formatTrashStamp(T0 - 3 * DAY_MS)}${TRASH_NAME_SEP}older.md`
    const newer = `${formatTrashStamp(T0 - DAY_MS)}${TRASH_NAME_SEP}newer.md`
    await plant(mem, trashDir, older, T0 - 3 * DAY_MS, `${root}/older.md`)
    await plant(mem, trashDir, newer, T0 - DAY_MS, `${root}/newer.md`)

    const listed = await kernel.list({ root, nowMs: T0 })
    expect(listed.entries[0].trashName).toBe(newer)
    expect(listed.entries[1].trashName).toBe(older)
  })
})

// ---------------------------------------------------------------------------
// G. 双副本 / 通道一致性（主进程 + preload）
//
// 内核在 src/utils/trashIndex.js（ESM，被 vitest 直接加载），而真正跑 IPC 的
// 是 electron/main.cjs —— 它不能 require src/（打包时 src 不进安装包，详见
// tests/mainLogParity.test.js 的头部说明），所以那里有一份等价实现。
// 副本一定会漂移，而漂移的后果是「UI 看到的元数据格式和主进程写出来的不是一
// 回事」—— 这类故障单测永远抓不到，只能源码级比对。
// ---------------------------------------------------------------------------

describe('trashIndex · 主进程/ preload 通道一致性', () => {
  /** @type {string} */
  let mainSrc = ''
  /** @type {string} */
  let preloadSrc = ''

  beforeAll(async () => {
    mainSrc = await fs.readFile(MAIN_PATH, 'utf-8')
    preloadSrc = await fs.readFile(PRELOAD_PATH, 'utf-8')
  })

  const handled = () => new Set([...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]))
  const invoked = () => new Set([...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))

  it('三个回收站通道在主进程里都有实现', () => {
    expect(handled().has('trash:list')).toBe(true)
    expect(handled().has('trash:restore')).toBe(true)
    expect(handled().has('trash:purge')).toBe(true)
  })

  it('三个回收站通道都在 preload 白名单里暴露（缺一个 = 调用直接 reject）', () => {
    expect(invoked().has('trash:list')).toBe(true)
    expect(invoked().has('trash:restore')).toBe(true)
    expect(invoked().has('trash:purge')).toBe(true)
    // 反过来也验一遍：preload 暴露的每个通道都得有主进程实现
    const missing = [...invoked()].filter((c) => !handled().has(c))
    expect(missing).toEqual([])
  })

  it('主进程侧常量与内核一致（目录名 / 元数据后缀 / 保留天数 / 分隔符）', () => {
    expect(mainSrc).toContain(`const TRASH_DIR_NAME = '${TRASH_DIR_NAME}'`)
    expect(mainSrc).toContain(`const TRASH_META_SUFFIX = '${TRASH_META_SUFFIX}'`)
    expect(mainSrc).toContain('const TRASH_RETENTION_DAYS = 30')
    expect(mainSrc).toContain(`const TRASH_NAME_SEP = '${TRASH_NAME_SEP}'`)
  })

  it('主进程写入的元数据字段与内核读取的字段同名（originPath / trashedAt / kind / size）', () => {
    expect(mainSrc).toContain('originPath')
    expect(mainSrc).toContain('trashedAt')
    // writeTrashMeta 的存在保证退化链路也会留下来源路径
    expect(mainSrc).toMatch(/function writeTrashMeta|const writeTrashMeta/)
    expect(mainSrc).toMatch(/function metaPathOf|const metaPathOf/)
  })

  it('主进程还原时会重建父目录并检查同名冲突', () => {
    // 缺少 recursive mkdir 的话，「文件夹已被删」场景会直接失败
    expect(mainSrc).toMatch(/mkdir\(\s*[^,]+,\s*\{\s*recursive:\s*true\s*\}\s*\)/)
    expect(mainSrc).toContain('restore-failed')
    expect(mainSrc).toContain('target-exists')
  })

  it('fs:delete-file 的返回值里带得动「回收站不可用」的原因', () => {
    expect(mainSrc).toContain('system-trash')
    expect(mainSrc).toContain('library-trash')
    expect(mainSrc).toContain('detail')
  })
})
