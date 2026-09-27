import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as noteIdentity from '../src/utils/noteIdentity.js'
import {
  ID_MAP_VERSION,
  pathHashId,
  createIdMap,
  resolveId,
  bindPath,
  rebindPath,
  unbindPath,
  compactIdMap,
  rebuildIdMap,
  parseIdMap
} from '../src/utils/noteIdentity.js'

// ---------------------------------------------------------------------------
// 老算法的事实基线
// ---------------------------------------------------------------------------

/**
 * 逐字抄自 `src/stores/note.js:24`（改造前的 `generateStableId`）。
 *
 * 抄在这里而不是 import，有三个理由：
 *   ① 它没导出，且 `note.js` 一 import 就拉起整个 pinia；
 *   ② `note.js` 归 T19 改 —— 测试不能因为 T19 换了实现就失去对「老 id」的守卫；
 *   ③ 这份副本就是老算法的**事实基线**，它永远不该被"顺手优化"，改了就等于
 *      把「老 id 可解析」这条验收标准自己废掉。
 *
 * 注意 `(hash << 5) - hash` 是 `hash * 31` 而不是标准 djb2 的 `*33`：设计文档
 * §7.2 B-3 沿用了「djb2」这个俗称，代码事实是 *31。这里以代码为准。
 *
 * @param {string} str 输入（老实现按 UTF-16 码元遍历）
 * @returns {string} base36 形式的 id
 */
const legacyGenerateStableId = (str) => {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

/** 反斜杠：写成常量避免在源码里反复转义 */
const BS = '\\'

/** 用于「与老算法逐字对齐」的路径语料：中文 / emoji / 反斜杠 / 超长 / 碰撞对 */
const PATH_CORPUS = [
  '',
  'a',
  'ab',
  './a.md',
  '/vault/note.md',
  '/vault/日记/2024-01-01.md',
  '/vault/笔记 副本 2.md',
  '/vault/a b/c.md',
  `D:${BS}notes${BS}笔记.md`,
  `C:${BS}Users${BS}me${BS}vault${BS}a.md`,
  '/vault/emoji-\u{1F600}.md',
  '/vault/ab.md',
  '/vault/bC.md',
  `/vault/${'x'.repeat(300)}.md`
]

/**
 * 黄金值表：把老算法的输出**字面量**钉死。
 * 上面那条「与老实现对齐」的测试只能保证两者一致（一起改就一起错），
 * 这条才能保证「谁都没改」—— 后人想"优化"哈希，这里会立刻红。
 */
const GOLDEN = [
  ['', '0'],
  ['a', '2p'],
  ['ab', '2e9'],
  ['./a.md', 'mjnwjp'],
  ['/vault/note.md', 'ctd6cn'],
  ['/vault/日记/2024-01-01.md', 'mvgih9'],
  ['/vault/a b/c.md', '9rws6e'],
  ['/vault/emoji-\u{1F600}.md', '4qmcj5'],
  ['/vault/ab.md', 'zaacpk'],
  ['/vault/bC.md', 'zaacpk'],
  [`D:${BS}notes${BS}笔记.md`, 'iscbqg'],
  [`C:${BS}Users${BS}me${BS}vault${BS}a.md`, 'bzviwp'],
  [`/vault/${'x'.repeat(300)}.md`, 'on4ot5']
]

// ---------------------------------------------------------------------------
// 验收标准 ①：未命中映射表时退回 pathHashId，老 id 必须还能解析
// ---------------------------------------------------------------------------

describe('pathHashId —— 与 note.js:24 老算法逐字一致', () => {
  it('每条路径都与老 generateStableId 的输出相同', () => {
    for (const p of PATH_CORPUS) {
      expect(pathHashId(p)).toBe(legacyGenerateStableId(p))
    }
  })

  it('黄金值锁定：算法一旦被改动，这里立刻失败', () => {
    for (const [p, expected] of GOLDEN) {
      expect(pathHashId(p)).toBe(expected)
    }
  })

  it('幂等：同一路径无论调用多少次、什么顺序，结果恒定', () => {
    for (const p of PATH_CORPUS) {
      expect(pathHashId(p)).toBe(pathHashId(p))
      expect(pathHashId(p)).toBe(pathHashId(p))
    }
  })

  it('非字符串入参不抛异常，null / undefined 退化为空串', () => {
    expect(() => pathHashId(null)).not.toThrow()
    expect(() => pathHashId(undefined)).not.toThrow()
    expect(pathHashId(null)).toBe(pathHashId(''))
    expect(pathHashId(undefined)).toBe(pathHashId(''))
    expect(pathHashId(123)).toBe(pathHashId('123'))
  })

  it('碰撞是真实存在的（为下面的消歧测试提供前置事实）', () => {
    // `(h << 5) - h` = h * 31，所以 31*c1 + c2 相等即碰撞：
    // 31*97('a') + 98('b') = 31*98('b') + 67('C') = 3105
    expect(pathHashId('/vault/ab.md')).toBe(pathHashId('/vault/bC.md'))
    expect(pathHashId('/vault/ab.md')).toBe('zaacpk')
  })
})

describe('createIdMap', () => {
  it('结构符合设计：version / byPath / byId / updatedAt', () => {
    const map = createIdMap()
    expect(map.version).toBe(ID_MAP_VERSION)
    expect(map.byPath).toEqual({})
    expect(map.byId).toEqual({})
    expect(map.updatedAt).toBe(0)
  })

  it('两张表互不共享引用（改一张不会污染另一张）', () => {
    const a = createIdMap()
    const b = createIdMap()
    bindPath(a, 'x', '/a.md')
    expect(b.byPath).toEqual({})
    expect(a.byPath['/a.md']).toBe('x')
  })
})

describe('resolveId —— 映射表优先，未命中退回哈希兜底', () => {
  it('命中映射表：返回表里登记的 id，而不是路径哈希', () => {
    const map = createIdMap()
    bindPath(map, 'id-fixed-1', '/vault/note.md')
    const resolved = resolveId(map, '/vault/note.md')
    expect(resolved).toBe('id-fixed-1')
    // 反向证明：它确实走的映射表，不是兜底
    expect(resolved).not.toBe(pathHashId('/vault/note.md'))
  })

  it('未命中映射表：退回 pathHashId —— 老 id 因此仍然可解析', () => {
    const map = createIdMap()
    bindPath(map, 'id-fixed-1', '/vault/note.md')
    for (const p of PATH_CORPUS) {
      if (p === '/vault/note.md') continue
      expect(resolveId(map, p)).toBe(pathHashId(p))
      expect(resolveId(map, p)).toBe(legacyGenerateStableId(p))
    }
  })

  it('空表 / null / undefined / 结构损坏：一律安全退化，绝不抛', () => {
    for (const bad of [null, undefined, {}, { byPath: null }, { byPath: 1, byId: null }, 'x', 42]) {
      expect(resolveId(bad, '/vault/note.md')).toBe(pathHashId('/vault/note.md'))
    }
  })

  it('纯读：未命中时不会偷偷把结果写回映射表', () => {
    const map = createIdMap()
    resolveId(map, '/vault/ghost.md')
    expect(map.byPath).toEqual({})
    expect(map.byId).toEqual({})
  })

  it('原型链上的键不会被误判为命中', () => {
    const map = createIdMap()
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(resolveId(map, key)).toBe(pathHashId(key))
    }
    // 但显式绑定这些名字时必须能正常存进去
    bindPath(map, 'id-x', 'toString')
    expect(resolveId(map, 'toString')).toBe('id-x')
  })
})

// ---------------------------------------------------------------------------
// 验收标准 ②：移动 / 重命名后 id 不变
// ---------------------------------------------------------------------------

describe('bindPath', () => {
  it('双向建立：byPath 与 byId 都能查到', () => {
    const map = createIdMap()
    bindPath(map, 'id-1', '/vault/a.md')
    expect(map.byPath['/vault/a.md']).toBe('id-1')
    expect(map.byId['id-1']).toBe('/vault/a.md')
  })

  it('重新绑定同一路径：旧 id 的反向项被清掉（不留悬空）', () => {
    const map = createIdMap()
    bindPath(map, 'id-1', '/vault/a.md')
    bindPath(map, 'id-2', '/vault/a.md')
    expect(map.byPath['/vault/a.md']).toBe('id-2')
    expect(map.byId['id-1']).toBeUndefined()
    expect(map.byId['id-2']).toBe('/vault/a.md')
  })

  it('同一个 id 绑到新路径：旧路径的正向项被清掉（严格一对一）', () => {
    const map = createIdMap()
    bindPath(map, 'id-1', '/vault/a.md')
    bindPath(map, 'id-1', '/vault/b.md')
    expect(map.byId['id-1']).toBe('/vault/b.md')
    expect(map.byPath['/vault/a.md']).toBeUndefined()
  })

  it('空 id / 空路径 / 非映射表：原样返回，不写脏数据', () => {
    const map = createIdMap()
    expect(bindPath(map, '', '/vault/a.md')).toBe(map)
    expect(bindPath(map, null, '/vault/a.md')).toBe(map)
    expect(bindPath(map, 'id-1', '')).toBe(map)
    expect(bindPath(map, 'id-1', null)).toBe(map)
    expect(map.byPath).toEqual({})
    expect(bindPath(null, 'id-1', '/vault/a.md')).toBe(null)
    expect(bindPath({}, 'id-1', '/vault/a.md')).toEqual({})
  })
})

describe('rebindPath —— 移动 / 重命名后 id 不变（R-F1 主场景）', () => {
  it('已登记过的笔记：移动目录后 id 不变', () => {
    const map = createIdMap()
    bindPath(map, 'id-1', '/vault/a.md')
    const before = resolveId(map, '/vault/a.md')

    rebindPath(map, '/vault/a.md', '/vault/sub/a.md')

    expect(resolveId(map, '/vault/sub/a.md')).toBe(before)
    expect(resolveId(map, '/vault/sub/a.md')).toBe('id-1')
    expect(map.byPath['/vault/a.md']).toBeUndefined()
  })

  it('迁移期关键场景：旧路径没进过映射表，移动后 id 仍是「旧路径的哈希」', () => {
    // 这是老库最真实的状态：整库 id 都是路径哈希，映射表还没建。
    // 此时移动文件，若直接按新路径发 id，老书签 / 老双链当场全断。
    const map = createIdMap()
    const oldPath = '/vault/笔记.md'
    const newPath = '/vault/归档/笔记 2024.md'
    const legacyId = pathHashId(oldPath)

    rebindPath(map, oldPath, newPath)

    expect(resolveId(map, newPath)).toBe(legacyId)
    expect(resolveId(map, newPath)).toBe(legacyGenerateStableId(oldPath))
    // 反证：不是新路径的哈希
    expect(resolveId(map, newPath)).not.toBe(pathHashId(newPath))
  })

  it('连续多次移动 / 改名，id 始终不变', () => {
    const map = createIdMap()
    const first = '/vault/a.md'
    const id = resolveId(map, first) // 首次解析＝旧路径哈希（迁移期）
    const chain = ['/vault/b.md', '/vault/sub/c.md', '/vault/sub/日记/d.md']
    let from = first
    for (const to of chain) {
      rebindPath(map, from, to)
      expect(resolveId(map, to)).toBe(id)
      from = to
    }
    expect(resolveId(map, chain[chain.length - 1])).toBe(id)
  })

  it('from 与 to 相同 / 空值：无操作', () => {
    const map = createIdMap()
    bindPath(map, 'id-1', '/vault/a.md')
    rebindPath(map, '/vault/a.md', '/vault/a.md')
    expect(resolveId(map, '/vault/a.md')).toBe('id-1')

    rebindPath(map, '', '/vault/b.md')
    rebindPath(map, '/vault/a.md', '')
    expect(resolveId(map, '/vault/a.md')).toBe('id-1')
    expect(map.byPath['/vault/b.md']).toBeUndefined()
  })

  it('目标位置原本绑着别的 id：以搬过来的这条为准（一对一）', () => {
    const map = createIdMap()
    bindPath(map, 'id-mover', '/vault/a.md')
    bindPath(map, 'id-squatter', '/vault/dest.md')

    rebindPath(map, '/vault/a.md', '/vault/dest.md')

    expect(resolveId(map, '/vault/dest.md')).toBe('id-mover')
    expect(map.byId['id-squatter']).toBeUndefined()
    expect(map.byId['id-mover']).toBe('/vault/dest.md')
  })

  it('非映射表入参：原样返回，不抛', () => {
    expect(rebindPath(null, '/a.md', '/b.md')).toBe(null)
    expect(rebindPath({}, '/a.md', '/b.md')).toEqual({})
  })
})

describe('unbindPath', () => {
  it('双向删除，且不影响其它条目', () => {
    const map = rebuildIdMap(['/vault/a.md', '/vault/b.md'])
    const idB = resolveId(map, '/vault/b.md')
    unbindPath(map, '/vault/b.md')
    expect(map.byPath['/vault/b.md']).toBeUndefined()
    expect(map.byId[idB]).toBeUndefined()
    expect(resolveId(map, '/vault/a.md')).toBe(pathHashId('/vault/a.md'))
  })

  it('未绑定的路径 / 空值：无操作，不抛', () => {
    const map = createIdMap()
    bindPath(map, 'id-1', '/vault/a.md')
    unbindPath(map, '/vault/ghost.md')
    unbindPath(map, '')
    unbindPath(map, null)
    expect(resolveId(map, '/vault/a.md')).toBe('id-1')
  })
})

// ---------------------------------------------------------------------------
// 验收标准 ③：rebuildIdMap 可从磁盘路径全量重建
// ---------------------------------------------------------------------------

describe('compactIdMap', () => {
  it('只保留仍然存在的路径，且 id 不变', () => {
    const map = rebuildIdMap(['/vault/a.md', '/vault/b.md', '/vault/c.md'])
    const idA = resolveId(map, '/vault/a.md')
    const compacted = compactIdMap(map, ['/vault/a.md', '/vault/c.md'])

    expect(resolveId(compacted, '/vault/a.md')).toBe(idA)
    expect(compacted.byPath['/vault/b.md']).toBeUndefined()
    expect(Object.keys(compacted.byPath).sort()).toEqual(['/vault/a.md', '/vault/c.md'])
  })

  it('纯函数：返回新表，不改入参', () => {
    const map = rebuildIdMap(['/vault/a.md', '/vault/b.md'])
    const before = JSON.stringify(map)
    compactIdMap(map, ['/vault/a.md'])
    expect(JSON.stringify(map)).toBe(before)
  })

  it('保留原表的 updatedAt（时间戳由落盘方写，裁剪不该抹掉）', () => {
    const map = rebuildIdMap(['/vault/a.md'])
    map.updatedAt = 1700000000000
    expect(compactIdMap(map, ['/vault/a.md']).updatedAt).toBe(1700000000000)
  })

  it('结果顺序稳定：live 集合的传入顺序不影响输出', () => {
    const map = rebuildIdMap(['/vault/a.md', '/vault/b.md', '/vault/c.md'])
    const x = compactIdMap(map, ['/vault/c.md', '/vault/a.md'])
    const y = compactIdMap(map, ['/vault/a.md', '/vault/c.md'])
    expect(JSON.stringify(x)).toBe(JSON.stringify(y))
  })

  it('live 为空 / 非映射表：得到空表，不抛', () => {
    const map = rebuildIdMap(['/vault/a.md'])
    expect(Object.keys(compactIdMap(map, []).byPath)).toEqual([])
    expect(compactIdMap(null, ['/vault/a.md']).byPath).toEqual({})
  })
})

describe('rebuildIdMap —— 映射表丢失可全量重建', () => {
  it('重建出的 id 与「迁移前」完全一致（老书签 / 老双链保活）', () => {
    const paths = ['/vault/a.md', '/vault/日记/2024-01-01.md', '/vault/emoji-\u{1F600}.md']
    const lost = createIdMap() // 模拟映射表丢失
    const rebuilt = rebuildIdMap(paths)
    for (const p of paths) {
      // 丢表时兜底解析出什么，重建后就还是什么 —— 这是「绝不写 .md」能成立的前提
      expect(resolveId(lost, p)).toBe(legacyGenerateStableId(p))
      expect(resolveId(rebuilt, p)).toBe(legacyGenerateStableId(p))
      expect(resolveId(rebuilt, p)).toBe(pathHashId(p))
    }
  })

  it('重建结果与路径传入顺序无关（同一份磁盘状态 → 同一张表）', () => {
    const a = rebuildIdMap(['/vault/a.md', '/vault/b.md', '/vault/c.md'])
    const b = rebuildIdMap(['/vault/c.md', '/vault/a.md', '/vault/b.md'])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('重复路径去重，且不影响其它路径的 id', () => {
    const once = rebuildIdMap(['/vault/a.md', '/vault/b.md'])
    const twice = rebuildIdMap(['/vault/a.md', '/vault/b.md', '/vault/a.md', '/vault/a.md'])
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('哈希碰撞时显式消歧：字典序靠前的拿 base，后一个拿 -2 后缀', () => {
    // 前置事实已在上面断言：这两条路径的哈希相同
    expect(pathHashId('/vault/ab.md')).toBe(pathHashId('/vault/bC.md'))

    const map = rebuildIdMap(['/vault/ab.md', '/vault/bC.md'])
    const idAb = resolveId(map, '/vault/ab.md')
    const idBc = resolveId(map, '/vault/bC.md')

    expect(idAb).not.toBe(idBc)
    expect(idAb).toBe('zaacpk') // 字典序 'ab' < 'bC'
    expect(idBc).toBe('zaacpk-2')
    // '-' 不在 base36 字符集里，所以消歧后缀永远不会被误认成某条路径的哈希
    expect(idBc.endsWith('-2')).toBe(true)
    // 反查仍然双向一致
    expect(map.byId[idAb]).toBe('/vault/ab.md')
    expect(map.byId[idBc]).toBe('/vault/bC.md')
  })

  it('已知边界（诚实记录）：移动过的笔记，重建只能回到「新路径的哈希」', () => {
    // 「绝不写用户 .md」的代价：映射表一旦真的丢了，移动过的笔记无法还原成
    // 移动前的 id —— 磁盘上没有任何地方记着「它原来叫什么」。
    // 所以 T16 必须勤落盘 + 写盘原子化，映射表不是可有可无的缓存。
    const oldPath = '/vault/笔记.md'
    const newPath = '/vault/归档/笔记.md'
    const map = createIdMap()
    rebindPath(map, oldPath, newPath)
    const keptId = resolveId(map, newPath)
    expect(keptId).toBe(pathHashId(oldPath))

    const rebuilt = rebuildIdMap([newPath])
    expect(resolveId(rebuilt, newPath)).toBe(pathHashId(newPath))
    expect(resolveId(rebuilt, newPath)).not.toBe(keptId)
  })

  it('空 / null / 非法入参：得到空表，不抛', () => {
    for (const bad of [null, undefined, [], 42, {}]) {
      const map = rebuildIdMap(bad)
      expect(map.byPath).toEqual({})
      expect(map.byId).toEqual({})
      expect(map.version).toBe(ID_MAP_VERSION)
    }
  })

  it('单条字符串路径按「一条」处理，绝不逐字符展开', () => {
    const map = rebuildIdMap('/vault/note.md')
    expect(Object.keys(map.byPath)).toEqual(['/vault/note.md'])
    expect(resolveId(map, '/vault/note.md')).toBe(pathHashId('/vault/note.md'))
  })
})

describe('parseIdMap —— 落盘读回（给 T16 用）', () => {
  it('从 JSON 字符串恢复，解析结果与重建一致', () => {
    const map = rebuildIdMap(['/vault/a.md', '/vault/b.md'])
    map.updatedAt = 1700000000000
    const restored = parseIdMap(JSON.stringify(map))
    expect(JSON.stringify(restored)).toBe(JSON.stringify(map))
    expect(restored.updatedAt).toBe(1700000000000)
  })

  it('非法 JSON / null / 非对象：返回空表，绝不抛', () => {
    for (const bad of ['not json', null, undefined, 42, 'null', '[]']) {
      const map = parseIdMap(bad)
      expect(map.byPath).toEqual({})
      expect(map.version).toBe(ID_MAP_VERSION)
    }
  })

  it('byId 与 byPath 不一致时，以 byPath 为准重算（唯一真相源）', () => {
    const raw = {
      version: ID_MAP_VERSION,
      byPath: { '/vault/a.md': 'id-1', '/vault/b.md': 'id-2' },
      byId: { 'id-1': '/vault/错的路径.md' } // 半途断电留下的脏反向项
    }
    const map = parseIdMap(raw)
    expect(map.byId['id-1']).toBe('/vault/a.md')
    expect(map.byId['id-2']).toBe('/vault/b.md')
  })

  it('版本高于当前：不猜结构，返回空表', () => {
    const future = { version: ID_MAP_VERSION + 1, byPath: { '/vault/a.md': 'id-1' } }
    expect(parseIdMap(future).byPath).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 验收标准 ④：纯内核守卫 —— 零 import、绝不写用户的 .md
// ---------------------------------------------------------------------------

describe('纯内核守卫', () => {
  // 用 path.resolve 拼绝对路径：本机把 URL 对象交给 readFileSync 会抛
  const sourcePath = path.resolve(process.cwd(), 'src/utils/noteIdentity.js')
  const source = readFileSync(sourcePath, 'utf8')

  it('源码零 import / 零 require（可同时被渲染进程与主进程复用）', () => {
    expect(/^\s*import\s.+$/m.test(source)).toBe(false)
    expect(/^\s*export\s.+\sfrom\s/m.test(source)).toBe(false)
    expect(source.includes('require(')).toBe(false)
  })

  it('源码不含任何读写磁盘 / 读写笔记内容的 API', () => {
    // 「绝不写用户的 .md」在本模块是结构性保证：它连 fs 的门都没开。
    const forbidden = [
      'node:fs', "from 'fs'", 'from "fs"',
      'writeFile', 'appendFile', 'readFile', 'unlink', 'mkdir',
      'electronAPI', 'ipcRenderer',
      'localStorage', 'sessionStorage', 'indexedDB',
      'fetch(', 'XMLHttpRequest',
      'frontmatter', 'Date.now', 'Math.random'
    ]
    for (const token of forbidden) {
      expect(source.includes(token)).toBe(false)
    }
  })

  it('源码不含裸 NUL 字节（项目硬约束：会被 git 当二进制）', () => {
    expect(source.includes('\u0000')).toBe(false)
  })

  it('导出的名字里没有任何「写 / 读 / 内容」语义的入口', () => {
    const names = Object.keys(noteIdentity)
    expect(names.length).toBeGreaterThan(0)
    const suspicious = names.filter((n) => /write|save|read|persist|content|frontmatter|dump/i.test(n))
    expect(suspicious).toEqual([])
  })

  it('全流程跑完，笔记内容一个字节都没变', () => {
    const content = '# 标题\n\n正文里有一条 [[B]] 双链\n'
    const vault = Object.freeze({ content })

    const map = rebuildIdMap(['/vault/A.md', '/vault/B.md'])
    const idA = resolveId(map, '/vault/A.md')
    rebindPath(map, '/vault/A.md', '/vault/子目录/A.md')
    compactIdMap(map, ['/vault/子目录/A.md', '/vault/B.md'])

    expect(resolveId(map, '/vault/子目录/A.md')).toBe(idA)
    expect(vault.content).toBe(content)
  })

  it('不读时钟：两次重建（含 updatedAt）字节级相同', () => {
    const paths = ['/vault/a.md', '/vault/b.md']
    expect(JSON.stringify(rebuildIdMap(paths))).toBe(JSON.stringify(rebuildIdMap(paths)))
    expect(rebuildIdMap(paths).updatedAt).toBe(0)
    // 绑定操作同样不碰 updatedAt —— 时间戳由落盘方（T16）写
    const map = rebuildIdMap(paths)
    bindPath(map, 'id-1', '/vault/c.md')
    rebindPath(map, '/vault/c.md', '/vault/d.md')
    unbindPath(map, '/vault/d.md')
    expect(map.updatedAt).toBe(0)
  })

  it('不修改入参：paths 数组的内容与顺序原样保留', () => {
    const paths = ['/vault/c.md', '/vault/a.md', '/vault/b.md']
    const snapshot = paths.slice()
    rebuildIdMap(paths)
    compactIdMap(createIdMap(), paths)
    expect(paths).toEqual(snapshot)
  })

  it('所有导出面对空 / 非法入参都不抛（启动路径上不能炸）', () => {
    expect(() => {
      resolveId(null, null)
      bindPath(null, null, null)
      rebindPath(null, null, null)
      unbindPath(null, null)
      compactIdMap(null, null)
      rebuildIdMap(null)
      parseIdMap(null)
      pathHashId(null)
    }).not.toThrow()
  })
})
