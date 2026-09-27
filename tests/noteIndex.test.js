import { describe, it, expect } from 'vitest'
import { createNoteIndex } from '../src/utils/noteIndex'
import { buildLinkGraph, extractTags } from '../src/composables/useLinks.js'

// ===========================================================================
// 这组测试是 note.js 「linkGraph 从 buildLinkGraph 换成派生索引」能否合入的
// 唯一判据：走索引的 snapshot() 必须与直接 buildLinkGraph(notes) 逐方法相等。
// ===========================================================================

/**
 * 构造一篇笔记。
 * @param {object} opts 字段
 * @returns {object} 笔记对象
 */
function note ({ id, title, folder = '', content = '', tags = [], updatedAt = '2024-01-02T03:04:05.000Z', filePath = null }) {
  return {
    id,
    title,
    folder,
    content,
    tags,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    wordCount: 0,
    charCount: 0,
    lineCount: 0,
    filePath
  }
}

/**
 * Map<string, Set<string>> 转成可稳定比较的普通结构。
 * @param {Map<any, any>} m 索引
 * @returns {Array<Array<any>>} 排序后的键值对
 */
function plainMap (m) {
  return Array.from(m.entries())
    .map(([k, v]) => {
      const value = v instanceof Set ? Array.from(v) : v
      return [String(k), Array.isArray(value) ? value.map(String) : String(value)]
    })
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * 核心断言：索引快照与直接 buildLinkGraph 的结果完全等价。
 * @param {Array<object>} notes 笔记数组
 * @param {string} label 用例名，失败时便于定位
 * @returns {object} { direct, snap }
 */
function assertSameGraph (notes, label = '') {
  const direct = buildLinkGraph(notes)
  const idx = createNoteIndex()
  idx.replaceAll(notes)
  const snap = idx.snapshot()

  const titles = new Set()
  const tags = new Set()
  for (const n of notes) {
    titles.add(n.title)
    titles.add(`${n.folder || ''}/${n.title}`)
    titles.add('肯定不存在的一篇笔记')
    for (const t of extractTags(n.content)) tags.add(t)
    for (const t of n.tags || []) tags.add(t)
  }
  for (const t of direct.tagIndex.keys()) tags.add(t)

  for (const n of notes) {
    expect(snap.getBacklinks(n.id), `${label} getBacklinks(${n.id})`).toEqual(direct.getBacklinks(n.id))
    expect(snap.getOutgoing(n.id), `${label} getOutgoing(${n.id})`).toEqual(direct.getOutgoing(n.id))
    expect(snap.getUnresolved(n.id), `${label} getUnresolved(${n.id})`).toEqual(direct.getUnresolved(n.id))
  }
  for (const t of titles) {
    expect(snap.getByTitle(t), `${label} getByTitle(${t})`).toEqual(direct.getByTitle(t))
  }
  for (const t of tags) {
    expect(snap.getNotesByTag(t), `${label} getNotesByTag(${t})`).toEqual(direct.getNotesByTag(t))
  }

  expect(plainMap(snap.titleIndex), `${label} titleIndex`).toEqual(plainMap(direct.titleIndex))
  expect(plainMap(snap.pathIndex), `${label} pathIndex`).toEqual(plainMap(direct.pathIndex))
  expect(plainMap(snap.tagIndex), `${label} tagIndex`).toEqual(plainMap(direct.tagIndex))
  expect(Array.from(snap.backlinks.keys()), `${label} backlinks keys`).toEqual(Array.from(direct.backlinks.keys()))
  expect(Array.from(snap.unresolved.keys()), `${label} unresolved keys`).toEqual(Array.from(direct.unresolved.keys()))

  return { direct, snap }
}

// ---------------------------------------------------------------------------
// 1) 有反链
// ---------------------------------------------------------------------------
describe('noteIndex snapshot：有反链', () => {
  const notes = [
    note({ id: 'a1', title: 'Alpha', folder: 'work', content: '# Alpha\n\n这里指向 [[Beta]]。\n' }),
    note({ id: 'b1', title: 'Beta', folder: 'work', content: '# Beta\n\n目标本身不链出。\n' })
  ]

  it('getBacklinks 与 buildLinkGraph 完全一致', () => {
    const { snap } = assertSameGraph(notes, '有反链')
    expect(snap.getBacklinks('b1')).toHaveLength(1)
    expect(snap.getBacklinks('b1')[0].fromId).toBe('a1')
    expect(snap.getBacklinks('b1')[0].raw).toBe('[[Beta]]')
    expect(snap.getBacklinks('b1')[0].context).toContain('[[Beta]]')
  })

  it('getOutgoing 的 resolvedId 指向目标笔记', () => {
    const { snap } = assertSameGraph(notes, '有反链')
    expect(snap.getOutgoing('a1')[0].resolvedId).toBe('b1')
    expect(snap.getOutgoing('a1')[0].embed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2) 无反链
// ---------------------------------------------------------------------------
describe('noteIndex snapshot：无反链', () => {
  const notes = [
    note({ id: 'lonely', title: '孤岛', folder: '', content: '# 孤岛\n\n没有任何链接。\n' }),
    note({ id: 'other', title: '别人', folder: 'inbox', content: '# 别人\n\n只有自指 [[别人]]。\n' })
  ]

  it('没有任何引用时返回空数组（而不是 undefined）', () => {
    const { snap } = assertSameGraph(notes, '无反链')
    expect(snap.getBacklinks('lonely')).toEqual([])
    expect(snap.getBacklinks('不存在的 id')).toEqual([])
    expect(snap.getOutgoing('lonely')).toEqual([])
    expect(snap.getUnresolved('lonely')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3) 有别名双链（同一目标被两篇以不同别名引用）
// ---------------------------------------------------------------------------
describe('noteIndex snapshot：有别名双链', () => {
  const notes = [
    note({ id: 'x1', title: 'X1', folder: '', content: '# X1\n\n参考 [[Beta|别名一]] 继续写。\n' }),
    note({ id: 'x2', title: 'X2', folder: 'docs', content: '# X2\n\n也参考 [[Beta#小节|别名二]]。\n' }),
    note({ id: 'beta', title: 'Beta', folder: 'docs', content: '# Beta\n' })
  ]

  it('两条反链的别名、锚点、上下文、顺序都对得上', () => {
    const { snap } = assertSameGraph(notes, '别名双链')
    const back = snap.getBacklinks('beta')
    expect(back).toHaveLength(2)
    expect(back.map(x => x.fromId)).toEqual(['x1', 'x2'])
    expect(back.map(x => x.alias)).toEqual(['别名一', '别名二'])
    expect(back[1].raw).toBe('[[Beta#小节|别名二]]')

    const out1 = snap.getOutgoing('x1')[0]
    expect(out1.target).toBe('Beta')
    expect(out1.hash).toBe('')
    expect(out1.alias).toBe('别名一')
    expect(snap.getOutgoing('x2')[0].hash).toBe('小节')
  })
})

// ---------------------------------------------------------------------------
// 4) 嵌入链接 ![[target]]
// ---------------------------------------------------------------------------
describe('noteIndex snapshot：嵌入链接', () => {
  const notes = [
    note({ id: 'embed-src', title: 'Embed Src', folder: '', content: '# Embed Src\n\n嵌入：![[Beta]] 与 ![[Beta|带别名]]\n' }),
    note({ id: 'beta', title: 'Beta', folder: '', content: '# Beta\n' })
  ]

  it('embed 标记与 raw 字符串保持原样', () => {
    const { snap } = assertSameGraph(notes, '嵌入')
    const out = snap.getOutgoing('embed-src')
    expect(out.map(x => x.embed)).toEqual([true, true])
    expect(out.map(x => x.raw)).toEqual(['![[Beta]]', '![[Beta|带别名]]'])
    expect(snap.getBacklinks('beta').map(x => x.raw)).toEqual(['![[Beta]]', '![[Beta|带别名]]'])
  })
})

// ---------------------------------------------------------------------------
// 5) 未解析链接
// ---------------------------------------------------------------------------
describe('noteIndex snapshot：未解析链接', () => {
  const notes = [
    note({ id: 'u1', title: 'U1', folder: '', content: '# U1\n\n[[查不到的笔记]] 和 [[work/也查不到]] 都悬空。\n' }),
    note({ id: 'u2', title: 'U2', folder: '', content: '# U2\n\n这条能解析 [[U1]]。\n' })
  ]

  it('getUnresolved 与原实现一致，且解析成功的那条不出现在里面', () => {
    const { snap } = assertSameGraph(notes, '未解析')
    expect(snap.getUnresolved('u1').map(x => x.target)).toEqual(['查不到的笔记', 'work/也查不到'])
    expect(snap.getUnresolved('u1').map(x => x.reason)).toEqual(['not-found', 'not-found'])
    expect(snap.getUnresolved('u2')).toEqual([])
    expect(snap.getOutgoing('u1')[0].resolvedId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6) 标签（frontmatter tags + 正文 #tag + 代码块里的 # 不算）
// ---------------------------------------------------------------------------
describe('noteIndex snapshot：标签', () => {
  const notes = [
    note({
      id: 't1',
      title: 'T1',
      folder: '',
      tags: ['declared'],
      content: '---\ntags: [alpha, beta]\n---\n\n# T1\n\n正文 #gamma\n\n```js\n// #not-a-tag\n```\n'
    }),
    note({ id: 't2', title: 'T2', folder: 'docs', content: '# T2\n\n#beta 与 #中文标签\n' })
  ]

  it('getNotesByTag 结果与 buildLinkGraph 一致', () => {
    const { snap } = assertSameGraph(notes, '标签')
    expect(snap.getNotesByTag('beta').sort()).toEqual(['t1', 't2'])
    expect(snap.getNotesByTag('not-a-tag')).toEqual([])
    expect(snap.getNotesByTag('中文标签')).toEqual(['t2'])
  })

  it('allTags() 与旧 note.allTags computed 语义一致（note.tags ∪ 正文标签，保序）', () => {
    const idx = createNoteIndex()
    idx.replaceAll(notes)

    const expectedSet = new Set()
    notes.forEach(n => {
      for (const t of n.tags || []) expectedSet.add(t)
      for (const t of extractTags(n.content)) expectedSet.add(t)
    })

    expect(idx.allTags()).toEqual(Array.from(expectedSet))
    expect(idx.allTags()).toContain('declared')
    expect(idx.allTags()).toContain('alpha')
    expect(idx.allTags()).not.toContain('not-a-tag')
  })
})

// ---------------------------------------------------------------------------
// 7) 综合场景：frontmatter aliases / filePath 候选名 / 代码块屏蔽 /
//    同名笔记消歧 / 代码块里的链接
// ---------------------------------------------------------------------------
describe('noteIndex snapshot：综合场景', () => {
  const complexNotes = [
    note({
      id: 'n1',
      title: 'Front Title',
      folder: 'a/b/c',
      filePath: 'D:/vault/a/b/c/Front.md',
      content: [
        '---',
        'tags: [graph]',
        'aliases:',
        '  - 别名甲',
        '  - 别名乙',
        'title: FM 标题',
        '---',
        '',
        '# H1 标题',
        '',
        '代码块里的链接不能进图：',
        '',
        '```md',
        '[[Beta]]',
        '[[不该算]]',
        '```',
        '',
        '真实链接 [[Beta]] / [[Beta|别名]] / [[a/b/c/Beta]] / ![[Beta]] / [[没有这篇]]',
        ''
      ].join('\n')
    }),
    note({
      id: 'n2',
      title: 'Beta',
      folder: 'a/b/c',
      filePath: 'D:/vault/a/b/c/Beta.markdown',
      content: '# Beta\n\n回指 [[Front Title]] 与 [[Front]]\n'
    }),
    note({
      id: 'n3',
      title: 'Beta',
      folder: 'other',
      filePath: 'D:/vault/other/Beta.md',
      content: '# Beta\n\n同名不同目录\n'
    }),
    note({ id: 'n4', title: 'Tail', folder: 'other', content: '# Tail\n' })
  ]

  it('候选标题（title / 文件名 / H1 / aliases / fm title）全部命中', () => {
    const { snap } = assertSameGraph(complexNotes, '综合')
    expect(snap.getByTitle('Front Title')).toEqual(['n1'])
    expect(snap.getByTitle('Front')).toEqual(['n1'])
    expect(snap.getByTitle('H1 标题')).toEqual(['n1'])
    expect(snap.getByTitle('别名甲')).toEqual(['n1'])
    expect(snap.getByTitle('FM 标题')).toEqual(['n1'])
    // 同名：两个 Beta 都在索引里，顺序与 buildLinkGraph 一致
    expect(snap.getByTitle('Beta').sort()).toEqual(['n2', 'n3'])
  })

  it('代码块里的链接被屏蔽；Cha1 分支产物与原实现一致', () => {
    const { snap } = assertSameGraph(complexNotes, '综合')
    const out = snap.getOutgoing('n1')
    expect(out.map(x => x.target)).toEqual(['Beta', 'Beta', 'a/b/c/Beta', 'Beta', '没有这篇'])
    expect(out.map(x => x.embed)).toEqual([false, false, false, true, false])
    expect(snap.getUnresolved('n1').map(x => x.target)).toEqual(['没有这篇'])
    // 绝对路径式链接走 pathIndex，指向 a/b/c 那个 Beta
    expect(out[2].resolvedId).toBe('n2')
  })

  it('重名链接的同文件夹消歧结果一致', () => {
    const { snap } = assertSameGraph(complexNotes, '综合')
    // ctx = a/b/c 里的笔记链接 Beta → 优先解析到同目录的 n2
    expect(snap.getOutgoing('n2').map(x => x.resolvedId)).toEqual(['n1', 'n1'])
    expect(snap.getBacklinks('n1').map(x => x.fromId)).toEqual(['n2', 'n2'])
  })
})

// ---------------------------------------------------------------------------
// 8) 增量维护：upsert / remove 之后仍然与全量重算等价
// ---------------------------------------------------------------------------
describe('noteIndex 增量维护', () => {
  const base = [
    note({ id: 'i1', title: 'One', folder: '', content: '# One\n\n[[Two]]\n' }),
    note({ id: 'i2', title: 'Two', folder: '', content: '# Two\n\n原始内容\n' }),
    note({ id: 'i3', title: 'Three', folder: 'deep/deeper', content: '# Three\n\n#tag-a\n' })
  ]

  it('upsert 改内容后，索引与全量重算一致', () => {
    const idx = createNoteIndex()
    idx.replaceAll(base)

    const updated = base.map(n => (n.id === 'i2' ? { ...n, content: '# Two\n\n新增 [[One]] 和 [[One|别名]]\n#tag-b\n' } : n))
    idx.upsert(updated[1])

    const direct = buildLinkGraph(updated)
    const snap = idx.snapshot()
    expect(snap.getBacklinks('i1').map(x => x.fromId)).toEqual(direct.getBacklinks('i1').map(x => x.fromId))
    expect(snap.getBacklinks('i1')).toEqual(direct.getBacklinks('i1'))
    expect(snap.getOutgoing('i2')).toEqual(direct.getOutgoing('i2'))
    expect(snap.getNotesByTag('tag-b')).toEqual(direct.getNotesByTag('tag-b'))
    expect(idx.allTags().sort()).toEqual(['tag-a', 'tag-b'])
  })

  it('remove 之后，被删笔记不再出现在任何索引里', () => {
    const idx = createNoteIndex()
    idx.replaceAll(base)
    idx.remove('i1')

    let remaining = base.filter(n => n.id !== 'i1')
    // i2 指向 One，删除后应变成未解析
    const direct = buildLinkGraph(remaining)
    const snap = idx.snapshot()

    expect(snap.getBacklinks('i1')).toEqual([])
    expect(snap.getByTitle('One')).toEqual([])
    expect(snap.getUnresolved('i2')).toEqual(direct.getUnresolved('i2'))
    expect(snap.getOutgoing('i2')).toEqual(direct.getOutgoing('i2'))
    expect(idx.byDate(new Date(base[0].updatedAt).toDateString()).map(n => n.id)).toEqual(['i2', 'i3'])
  })

  it('upsert 到最前 （notes.unshift 场景）与数组顺序保持一致', () => {
    const idx = createNoteIndex()
    idx.replaceAll(base)
    const fresh = note({ id: 'i0', title: 'Zero', folder: '', content: '# Zero\n\n[[One]]\n' })
    idx.upsert(fresh, 0)

    const withFresh = [fresh, ...base]
    const direct = buildLinkGraph(withFresh)
    const snap = idx.snapshot()

    // 顺序敏感：遍历顺序决定 titleIndex 首个成员（重名消歧的 fallback）
    expect(Array.from(idx.byId.keys())).toEqual(['i0', 'i1', 'i2', 'i3'])
    expect(snap.getBacklinks('i1')).toEqual(direct.getBacklinks('i1'))
    expect(snap.getByTitle('Zero')).toEqual(['i0'])
  })

  it('replaceAll 会整体替换，不残留上一次的笔记', () => {
    const idx = createNoteIndex()
    idx.replaceAll(base)
    const other = [note({ id: 'z1', title: 'Z1', folder: '', content: '# Z1\n' })]
    idx.replaceAll(other)

    const direct = buildLinkGraph(other)
    const snap = idx.snapshot()
    expect(Array.from(idx.byId.keys())).toEqual(['z1'])
    expect(snap.getByTitle('One')).toEqual([])
    expect(snap.getBacklinks('z1')).toEqual(direct.getBacklinks('z1'))
    expect(idx.allTags()).toEqual([])
  })

  it('byDate 按 new Date(updatedAt).toDateString() 分组且保持原顺序', () => {
    const dayOne = '2024-03-01T10:00:00.000Z'
    const dayTwo = '2024-03-02T10:00:00.000Z'
    const notes = [
      note({ id: 'd1', title: 'D1', updatedAt: dayOne }),
      note({ id: 'd2', title: 'D2', updatedAt: dayTwo }),
      note({ id: 'd3', title: 'D3', updatedAt: dayOne })
    ]
    const idx = createNoteIndex()
    idx.replaceAll(notes)

    const keyOne = new Date(dayOne).toDateString()
    const keyTwo = new Date(dayTwo).toDateString()
    expect(idx.byDate(keyOne).map(n => n.id)).toEqual(['d1', 'd3'])
    expect(idx.byDate(keyTwo).map(n => n.id)).toEqual(['d2'])
    expect(idx.byDate('Mon Jan 01 1990')).toEqual([])
    expect(Array.from(idx.dateIndex.keys())).toEqual([keyOne, keyTwo])
  })

  it('snapshot() 在索引未变时返回同一个对象（避免重复构造）', () => {
    const idx = createNoteIndex()
    idx.replaceAll(base)
    const a = idx.snapshot()
    const b = idx.snapshot()
    expect(a).toBe(b)
    idx.upsert({ ...base[0], content: '# One\n\n变了\n' })
    expect(idx.snapshot()).not.toBe(a)
  })
})
