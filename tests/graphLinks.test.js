// ============================================================================
// graphLinks.test.js —— T34 双链进图内核的单测
//
// 两条铁律：
//   1) **纯内核测试**：不得 import vue / pinia / store / 任何组件。
//      本文件只依赖 vitest 与 node 内置 fs / path / url。
//   2) **源码级一致性**：tag 口径必须与 src/composables/useLinks.js:258 的
//      TAG_REGEX 逐字一致，靠下面的 readFileSync 断言守住 —— 任一侧漂移立刻变红，
//      这是把「两边各写一份正则」这个妥协关进笼子的唯一办法。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  EDGE_KINDS,
  EDGE_WEIGHT,
  buildWikiEdges,
  buildTagEdges,
  buildSimilarEdges,
  buildLinkEdges,
  extractWikiTargets,
  extractTagsDefault,
  extractTitleKeywordsDefault,
  extractContentKeywordsDefault
} from '../src/utils/graphLinks.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(TEST_DIR, '..')
const KERNEL_PATH = path.join(PROJECT_ROOT, 'src', 'utils', 'graphLinks.js')
const USELINKS_PATH = path.join(PROJECT_ROOT, 'src', 'composables', 'useLinks.js')

const KERNEL_SOURCE = fs.readFileSync(KERNEL_PATH, 'utf8')
const USELINKS_SOURCE = fs.readFileSync(USELINKS_PATH, 'utf8')

/**
 * 从源码里抽出 `const NAME = /.../flags` 那一行的正则字面量文本。
 * @param {string} source 源码全文
 * @param {string} name 常量名
 * @returns {string} 正则字面量（含两侧斜杠与 flags）；找不到返回空串
 */
function regexLiteralOf (source, name) {
  const lines = source.split(/\r?\n/)
  for (const line of lines) {
    if (!line.includes(`const ${name} =`)) continue
    const matched = line.match(/\/.*\/[gimsuy]*$/)
    return matched ? matched[0] : ''
  }
  return ''
}

/**
 * 造一篇笔记。缺省字段是 GraphView / noteStore 里最常见的形状。
 * @param {string} id 笔记 id
 * @param {string} title 标题
 * @param {string} content 正文
 * @param {Object} extra 覆盖字段
 * @returns {Object} 笔记对象
 */
function note (id, title, content, extra = {}) {
  return {
    id,
    title,
    folder: '',
    content,
    filePath: `${String(title).replace(/[/\\]/g, '_')}.md`,
    ...extra
  }
}

/**
 * 取一条无向边（自动按 source<target 归一）。
 * @param {Array<Object>} edges 边列表
 * @param {string} a 一端 id
 * @param {string} b 另一端 id
 * @param {string} kind 边类型
 * @returns {Object|undefined} 命中的边
 */
function edgeBetween (edges, a, b, kind) {
  const source = a < b ? a : b
  const target = a < b ? b : a
  return edges.find(e => e.source === source && e.target === target && e.kind === kind)
}

/**
 * 统计某端相关的边数（跨 kind），用于校验"没有多出来的边"。
 * @param {Array<Object>} edges 边列表
 * @param {string} id 笔记 id
 * @returns {number} 边数
 */
function degreeOf (edges, id) {
  return edges.filter(e => e.source === id || e.target === id).length
}

// ===========================================================================
describe('T34 · graphLinks —— 常量与零依赖约束', () => {
  it('EDGE_KINDS 暴露三类边，wiki 是第一公民', () => {
    expect(EDGE_KINDS).toEqual({ wiki: 'wiki', tag: 'tag', similar: 'similar' })
  })

  it('EDGE_WEIGHT 双链最高、tag 次之、similar 最低', () => {
    expect(EDGE_WEIGHT).toEqual({ wiki: 3, tag: 2, similar: 0.5 })
    expect(EDGE_WEIGHT.wiki).toBeGreaterThan(EDGE_WEIGHT.tag)
    expect(EDGE_WEIGHT.tag).toBeGreaterThan(EDGE_WEIGHT.similar)
  })

  it('graphLinks.js 不得有任何 import 行（零依赖硬约束）', () => {
    const bad = KERNEL_SOURCE.split(/\r?\n/).filter(l => /^import\b/.test(l.trim()))
    expect(bad).toEqual([])
  })

  it('graphLinks.js 不得使用 require / 动态 import', () => {
    expect(KERNEL_SOURCE).not.toMatch(/\brequire\s*\(/)
    expect(KERNEL_SOURCE).not.toMatch(/\bawait\s+import\s*\(/)
  })

  it('graphLinks.js 不得出现裸控制字节（除转义写法本身）', () => {
    // eslint-disable-next-line no-control-regex
    const hits = KERNEL_SOURCE.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g)
    expect(hits).toBeNull()
  })
})

// ===========================================================================
describe('T34 · wiki 边（R-G1 主角）', () => {
  it('[[B]] 必须连线，weight = 3', () => {
    const notes = [note('a', 'A', '正文 [[B]] 结束'), note('b', 'B', '')]
    const edges = buildWikiEdges(notes)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({ source: 'a', target: 'b', kind: 'wiki', weight: 3 })
  })

  it('[[B|别名]] 目标取竖线前的 B', () => {
    const notes = [note('a', 'A', '看 [[B|别名显示]] 这里'), note('b', 'B', '')]
    const edges = buildWikiEdges(notes)
    expect(edgeBetween(edges, 'a', 'b', 'wiki')).toBeTruthy()
    expect(edges).toHaveLength(1)
  })

  it('[[B#小节]] 目标取井号前的 B', () => {
    const notes = [note('a', 'A', '跳转到 [[B#第三节]] 处'), note('b', 'B', '')]
    const edges = buildWikiEdges(notes)
    expect(edgeBetween(edges, 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('[[B#^块]] 块引用同样解析到 B', () => {
    const notes = [note('a', 'A', '引用 [[B#^abc123]] 块'), note('b', 'B', '')]
    expect(extractWikiTargets(notes[0].content)).toEqual(['B'])
    expect(edgeBetween(buildWikiEdges(notes), 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('![[B]] 嵌入也算双链', () => {
    const notes = [note('a', 'A', '![[B]]'), note('b', 'B', '')]
    expect(buildWikiEdges(notes)).toHaveLength(1)
  })

  it('目标不存在时跳过：绝不连孤儿边', () => {
    const notes = [note('a', 'A', '[[不存在的笔记]]'), note('b', 'B', '')]
    expect(buildWikiEdges(notes)).toEqual([])
  })

  it('自环跳过：A 里写 [[A]] 不产生边', () => {
    const notes = [note('a', 'A', '回到 [[A]] 自己'), note('b', 'B', '')]
    expect(buildWikiEdges(notes)).toEqual([])
  })

  it('重复 [[B]] 只保留一条边', () => {
    const notes = [note('a', 'A', '[[B]] 再 [[B]] 还 [[B]]'), note('b', 'B', '')]
    expect(buildWikiEdges(notes)).toHaveLength(1)
  })

  it('大小写不敏感：[[b]] 命中标题 B', () => {
    const notes = [note('a', 'A', 'link [[b]]'), note('b', 'B', '')]
    expect(edgeBetween(buildWikiEdges(notes), 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('英文标题大小写反向也命中：[[Graph Note]] → 标题 graph note', () => {
    const notes = [note('a', 'A', '见 [[Graph Note]]'), note('b', 'graph note', '')]
    expect(edgeBetween(buildWikiEdges(notes), 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('中文标题照样连线', () => {
    const notes = [note('a', '甲笔记', '关联 [[乙笔记]]'), note('b', '乙笔记', '')]
    expect(edgeBetween(buildWikiEdges(notes), 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('[[B.md]] 后缀写法命中 B', () => {
    const notes = [note('a', 'A', '[[B.md]]'), note('b', 'B', '')]
    expect(edgeBetween(buildWikiEdges(notes), 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('[[文件夹/B]] 路径写法命中（folder/title 索引）', () => {
    const notes = [
      note('a', 'A', '[[技术/B]]', { folder: '随笔' }),
      note('b', 'B', '', { folder: '技术' })
    ]
    expect(edgeBetween(buildWikiEdges(notes), 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('frontmatter.title 也能被解析到', () => {
    const notes = [
      note('a', 'A', '读 [[真实书名]]'),
      note('b', '缩写', '---\ntitle: 真实书名\n---\n正文')
    ]
    expect(edgeBetween(buildWikiEdges(notes), 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('代码块里的 [[示例]] 不算链接', () => {
    const notes = [note('a', 'A', '```js\nconst s = "[[B]]"\n```\n'), note('b', 'B', '')]
    expect(buildWikiEdges(notes)).toEqual([])
  })

  it('行内代码里的 [[B]] 不算链接', () => {
    const notes = [note('a', 'A', '语法形如 `[[B]]` 这样'), note('b', 'B', '')]
    expect(buildWikiEdges(notes)).toEqual([])
  })

  it('frontmatter 区域里的 [[B]] 不参与连边', () => {
    const notes = [note('a', 'A', '---\nref: "[[B]]"\n---\n正文'), note('b', 'B', '')]
    expect(buildWikiEdges(notes)).toEqual([])
  })

  it('多跳：A→B、B→C 各一条，且互不影响', () => {
    const notes = [
      note('a', 'A', '[[B]]'),
      note('b', 'B', '[[C]]'),
      note('c', 'C', '')
    ]
    const edges = buildWikiEdges(notes)
    expect(edges).toHaveLength(2)
    expect(edgeBetween(edges, 'a', 'b', 'wiki')).toBeTruthy()
    expect(edgeBetween(edges, 'b', 'c', 'wiki')).toBeTruthy()
  })

  it('无向归一化：A→B 与 B→A 合成一条，且 source < target', () => {
    const notes = [note('a', 'A', '[[B]]'), note('b', 'B', '[[A]]')]
    const edges = buildWikiEdges(notes)
    expect(edges).toHaveLength(1)
    expect(edges[0].source).toBe('a')
    expect(edges[0].target).toBe('b')
  })

  it('注入 resolveTarget 优先于内部索引', () => {
    const notes = [note('a', 'A', '[[anything]]'), note('b', 'B', '')]
    const edges = buildWikiEdges(notes, { resolveTarget: (target) => (target === 'anything' ? 'b' : null) })
    expect(edgeBetween(edges, 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('注入 idOfTitle 也能工作，且拿不到 n ull 时不连边', () => {
    const notes = [note('a', 'A', '[[B]] , [[C]]'), note('b', 'B', '')]
    const edges = buildWikiEdges(notes, { idOfTitle: (t) => (t === 'B' ? 'b' : null) })
    expect(edges).toHaveLength(1)
    expect(edgeBetween(edges, 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('resolver 返回笔记对象也可（pickId 兜底）', () => {
    const notes = [note('a', 'A', '[[B]]'), note('b', 'B', '')]
    const edges = buildWikiEdges(notes, { resolveTarget: (t) => (t === 'B' ? { id: 'b', title: 'B' } : null) })
    expect(edgeBetween(edges, 'a', 'b', 'wiki')).toBeTruthy()
  })

  it('resolver 抛异常不炸，按"解析不到"处理', () => {
    const notes = [note('a', 'A', '[[B]]'), note('b', 'B', '')]
    const boom = () => { throw new Error('resolver boom') }
    expect(() => buildWikiEdges(notes, { resolveTarget: boom })).not.toThrow()
    expect(buildWikiEdges(notes, { resolveTarget: boom })).toEqual([])
  })

  it('content 为 null / 空串的笔记不抛异常', () => {
    const notes = [note('a', 'A', null), note('b', 'B', ''), note('c', 'C', undefined)]
    expect(() => buildWikiEdges(notes)).not.toThrow()
    expect(buildWikiEdges(notes)).toEqual([])
  })

  it('缺少 id 的笔记被跳过，不会连出空节点', () => {
    const notes = [{ title: 'A', content: '[[B]]' }, note('b', 'B', '')]
    const edges = buildWikiEdges(notes)
    expect(edges).toEqual([])
  })

  it('extractWikiTargets：一次正文里抽出全部目标（顺序、未去重）', () => {
    const md = '[[甲]] 与 [[乙|别名]] 与 [[丙#小节]] 还有 [[丁#^blk]]'
    expect(extractWikiTargets(md)).toEqual(['甲', '乙', '丙', '丁'])
  })
})

// ===========================================================================
describe('T34 · tag 边（R-G2 口径统一）', () => {
  const loose = (notes) => buildTagEdges(notes, extractTagsDefault)

  it('两篇共享 #tag 才连边，weight = 2', () => {
    const notes = [note('a', 'A', '正文 #graph'), note('b', 'B', '正文 #graph')]
    const edges = buildTagEdges(notes, extractTagsDefault)
    expect(edges).toEqual([{ source: 'a', target: 'b', kind: 'tag', weight: 2 }])
  })

  it('标签不同不连边', () => {
    const notes = [note('a', 'A', '#甲'), note('b', 'B', '#乙')]
    expect(loose(notes)).toEqual([])
  })

  it('#中文标签 正常识别并连边', () => {
    const notes = [note('a', 'A', '#知识管理 内容'), note('b', 'B', '#知识管理 别的')]
    expect(loose(notes)).toHaveLength(1)
  })

  it('C 语言的 #define（前面不是空白）不产生 tag 边', () => {
    const notes = [note('a', 'A', 'printf("#define"); 追加 #真实标签'), note('b', 'B', '也是 #真实标签')]
    const tagsA = extractTagsDefault(notes[0].content)
    expect(tagsA).not.toContain('define')
    expect(tagsA).toContain('真实标签')
    expect(loose(notes)).toHaveLength(1)
  })

  it('URL 里的 #anchor 不产生 tag 边', () => {
    const notes = [note('a', 'A', '见 https://x.com#anchor 文档 #接口'), note('b', 'B', '#接口 文档')]
    expect(extractTagsDefault(notes[0].content)).not.toContain('anchor')
    expect(loose(notes)).toHaveLength(1)
  })

  it('紧挨中文的 #define 同样被忽略', () => {
    expect(extractTagsDefault('使用#define定义宏')).toEqual([])
  })

  it('Markdown 标题里的 # 不当标签', () => {
    expect(extractTagsDefault('## 一级 heading 标题')).toEqual([])
  })

  it('代码块里的 #tag 不当标签', () => {
    expect(extractTagsDefault('```\n#notatag\n```')).toEqual([])
  })

  it('frontmatter 不参与正文取标签', () => {
    expect(extractTagsDefault('---\ntitle: x\n---\n#正文标签')).toEqual(['正文标签'])
  })

  it('tag 大小写归一：#Graph 与 #graph 连边', () => {
    const notes = [note('a', 'A', '#Graph'), note('b', 'B', '#graph')]
    expect(loose(notes)).toHaveLength(1)
  })

  it('同一对的 tag 边也做无向归一 + 去重', () => {
    const notes = [note('a', 'A', '#x #x'), note('b', 'B', '#x')]
    const edges = buildTagEdges(notes, extractTagsDefault)
    expect(edges).toHaveLength(1)
    expect(edges[0].source).toBe('a')
    expect(edges[0].target).toBe('b')
  })

  it('extractTags 未提供时返回 [] 而不是崩', () => {
    const notes = [note('a', 'A', '#x'), note('b', 'B', '#x')]
    expect(() => buildTagEdges(notes)).not.toThrow()
    expect(buildTagEdges(notes)).toEqual([])
  })

  it('extractTags 非函数（传对象/字符串）时也返回 []', () => {
    const notes = [note('a', 'A', '#x'), note('b', 'B', '#x')]
    expect(buildTagEdges(notes, { nope: 1 })).toEqual([])
    expect(buildTagEdges(notes, 'x')).toEqual([])
  })

  it('也支持 { extractTags } 选项对象形式，便于 T35 透传', () => {
    const notes = [note('a', 'A', '#x'), note('b', 'B', '#x')]
    expect(buildTagEdges(notes, { extractTags: extractTagsDefault })).toHaveLength(1)
  })

  it('extractTags 抛错不炸，该笔记的标签被忽略', () => {
    const notes = [note('a', 'A', '#x'), note('b', 'B', '#x')]
    const boom = () => { throw new Error('tag boom') }
    expect(() => buildTagEdges(notes, boom)).not.toThrow()
    expect(buildTagEdges(notes, boom)).toEqual([])
  })

  it('extractTags 返回非数组时不崩', () => {
    const notes = [note('a', 'A', '#x'), note('b', 'B', '#x')]
    expect(buildTagEdges(notes, () => 'not-an-array')).toEqual([])
  })

  it('maxBucket 生效：过于通用的标签跳过（与 GraphView MAX_BUCKET 同思路）', () => {
    const notes = [note('a', 'A', '#x'), note('b', 'B', '#x'), note('c', 'C', '#x')]
    expect(buildTagEdges(notes, extractTagsDefault, { maxBucket: 2 })).toEqual([])
    expect(buildTagEdges(notes, extractTagsDefault, { maxBucket: 3 })).toHaveLength(3)
  })

  it('TAG_REGEX 与 useLinks.js:258 逐字一致（源码级一致性断言）', () => {
    const mine = regexLiteralOf(KERNEL_SOURCE, 'TAG_REGEX')
    const authoritative = regexLiteralOf(USELINKS_SOURCE, 'TAG_REGEX')
    expect(mine).not.toBe('')
    expect(authoritative).not.toBe('')
    expect(mine).toBe(authoritative)
  })

  it('两侧正则的 source 与 flags 也完全相同', () => {
    const mine = regexLiteralOf(KERNEL_SOURCE, 'TAG_REGEX')
    const authoritative = regexLiteralOf(USELINKS_SOURCE, 'TAG_REGEX')
    const reMine = new RegExp(mine.slice(1, mine.lastIndexOf('/')), mine.slice(mine.lastIndexOf('/') + 1))
    const reAuth = new RegExp(
      authoritative.slice(1, authoritative.lastIndexOf('/')),
      authoritative.slice(authoritative.lastIndexOf('/') + 1)
    )
    expect(reMine.source).toBe(reAuth.source)
    expect(reMine.flags).toBe(reAuth.flags)
  })

  it('内核源码里不许出现 GraphView 那份宽松正则', () => {
    expect(KERNEL_SOURCE).not.toMatch(/#\(\\S\+\?/)
  })
})

// ===========================================================================
describe('T34 · similar 边（算法不重写，只注入）', () => {
  it('共享足够关键词时产出 similar 边，weight = 0.5', () => {
    const notes = [
      note('a', 'A', '力导向图 布局 算法 力导向图 布局 算法'),
      note('b', 'B', '力导向图 布局 算法 力导向图 布局 算法')
    ]
    const edges = buildSimilarEdges(notes)
    expect(edges).toHaveLength(1)
    expect(edges[0].kind).toBe('similar')
    expect(edges[0].weight).toBe(0.5)
  })

  it('只共享 1 个关键词时不出边（默认阈值 minShared = 2）', () => {
    const notes = [note('a', 'A', '甲乙 乙丙 甲乙 乙丙'), note('b', 'B', '甲乙 丙丁 甲乙 丙丁')]
    // 先证明样本本身有效（否则这条用例会「因为没关键词」而假绿）
    expect(extractContentKeywordsDefault(notes[0].content)).toContain('甲乙')
    expect(extractContentKeywordsDefault(notes[1].content)).toContain('甲乙')
    expect(buildSimilarEdges(notes)).toEqual([])
  })

  it('minShared 可调：降到 1 后上述两篇连边', () => {
    const notes = [note('a', 'A', '甲乙 乙丙 甲乙 乙丙'), note('b', 'B', '甲乙 丙丁 甲乙 丙丁')]
    expect(buildSimilarEdges(notes, { minShared: 1 })).toHaveLength(1)
  })

  it('完全无关的笔记不连 similar 边', () => {
    const notes = [note('a', 'A', '甲乙 乙丙 甲乙 乙丙'), note('b', 'B', '丙丁 丁戊 丙丁 丁戊')]
    expect(buildSimilarEdges(notes)).toEqual([])
  })

  it('注入的标题关键词提取器生效', () => {
    const notes = [note('a', '关系图 设计', ''), note('b', '关系图 实现', '')]
    const seen = []
    const edges = buildSimilarEdges(notes, {
      minShared: 1,
      extractTitleKeywords: (title, n) => {
        seen.push(title)
        return String(title).split(/\s+/)
      },
      extractContentKeywords: () => []
    })
    expect(seen.sort()).toEqual(['关系图 实现', '关系图 设计'])
    expect(edges).toHaveLength(1)
  })

  it('注入的正文关键词提取器生效（相似度语义仍由调用方持有）', () => {
    const notes = [note('a', 'A', 'x'), note('b', 'B', 'y')]
    const edges = buildSimilarEdges(notes, {
      extractTitleKeywords: () => [],
      extractContentKeywords: () => ['热力Engine', '渲染管线']
    })
    expect(edges).toHaveLength(1)
    expect(edges[0].kind).toBe('similar')
  })

  it('提取器抛错不影响其它笔记', () => {
    const notes = [note('a', 'A', 'x'), note('b', 'B', 'y'), note('c', 'C', 'z')]
    const edges = buildSimilarEdges(notes, {
      extractTitleKeywords: () => { throw new Error('kw boom') },
      extractContentKeywords: () => ['kw1', 'kw2']
    })
    expect(edges).toHaveLength(3)
  })

  it('similar 边同样做无向归一：source < target', () => {
    const notes = [
      note('z', 'Z', 'kw1 kw2 kw1 kw2'),
      note('a', 'A', 'kw1 kw2 kw1 kw2')
    ]
    const edges = buildSimilarEdges(notes)
    expect(edges).toHaveLength(1)
    expect(edges[0].source).toBe('a')
    expect(edges[0].target).toBe('z')
  })

  it('maxBucket 挡住过于通用的关键词', () => {
    const notes = [
      note('a', 'A', 'x'), note('b', 'B', 'x'), note('c', 'C', 'x')
    ]
    const opts = { extractTitleKeywords: () => [], extractContentKeywords: () => ['kw1', 'kw2'] }
    expect(buildSimilarEdges(notes, { ...opts, maxBucket: 2 })).toEqual([])
    expect(buildSimilarEdges(notes, { ...opts, maxBucket: 3 })).toHaveLength(3)
  })

  it('默认兜底提取器：中文长句能切出可用关键词', () => {
    const kws = extractContentKeywordsDefault('力导向布局算法 力导向布局算法 其它内容随便写写')
    expect(kws.length).toBeGreaterThan(0)
    expect(extractTitleKeywordsDefault('Graph View 关系图')).toContain('graph')
  })
})

// ===========================================================================
describe('T34 · buildLinkEdges 统一入口', () => {
  // 刻意让 b 反向链回 a：这样「source < target」这类全局不变量才真的被检验，
  // 而不是恰好顺着 note 顺序蒙混过关（注入实验 ② 就是靠这个才红得够多）
  const fixture = () => [
    note('a', 'A', '[[B]] 共享 #same 力导向布局 力导向布局'),
    note('b', 'B', '[[A]] 共享 #same 力导向布局 力导向布局'),
    note('c', 'C', '独立内容 独立内容')
  ]

  it('linkMode 默认 all：三类边都产出', () => {
    const edges = buildLinkEdges({ notes: fixture(), extractTags: extractTagsDefault })
    expect(edges.some(e => e.kind === 'wiki')).toBe(true)
    expect(edges.some(e => e.kind === 'tag')).toBe(true)
    expect(edges.some(e => e.kind === 'similar')).toBe(true)
  })

  it('linkMode = wiki-only：只出 wiki 边', () => {
    const edges = buildLinkEdges({ notes: fixture(), linkMode: 'wiki-only' })
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every(e => e.kind === 'wiki')).toBe(true)
  })

  it('未知 linkMode 退化为 all，不会让整张图变空', () => {
    const edges = buildLinkEdges({ notes: fixture(), extractTags: extractTagsDefault, linkMode: 'weird-mode' })
    expect(edges.some(e => e.kind === 'wiki')).toBe(true)
  })

  it('返回顺序稳定：wiki → tag → similar', () => {
    const kinds = buildLinkEdges({ notes: fixture(), extractTags: extractTagsDefault }).map(e => e.kind)
    const firstTag = kinds.indexOf('tag')
    const firstSimilar = kinds.indexOf('similar')
    expect(kinds.indexOf('wiki')).toBe(0)
    expect(firstTag).toBeGreaterThanOrEqual(0)
    expect(firstSimilar).toBeGreaterThanOrEqual(firstTag)
  })

  it('同一对跨 kind 可以共存（wiki + tag 是两条边）', () => {
    const edges = buildLinkEdges({ notes: [note('a', 'A', '[[B]] #same'), note('b', 'B', '#same')], extractTags: extractTagsDefault })
    expect(edgeBetween(edges, 'a', 'b', 'wiki')).toBeTruthy()
    expect(edgeBetween(edges, 'a', 'b', 'tag')).toBeTruthy()
  })

  it('所有边满足 source < target（无向归一化全局成立）', () => {
    const edges = buildLinkEdges({ notes: fixture() })
    for (const e of edges) expect(e.source < e.target).toBe(true)
  })

  it('所有边的 id 都来自真实笔记', () => {
    const notes = fixture()
    const ids = new Set(notes.map(n => n.id))
    for (const e of buildLinkEdges({ notes })) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
  })

  it('每条边只有 4 个字段，形状严格（source/target/kind/weight）', () => {
    for (const e of buildLinkEdges({ notes: fixture() })) {
      expect(Object.keys(e).sort()).toEqual(['kind', 'source', 'target', 'weight'])
      expect(typeof e.weight).toBe('number')
    }
  })

  it('防御：options 为 undefined / null 都不抛', () => {
    expect(() => buildLinkEdges()).not.toThrow()
    expect(buildLinkEdges()).toEqual([])
    expect(buildLinkEdges(null)).toEqual([])
  })

  it('防御：notes 为 null / 非数组返回 []', () => {
    expect(buildWikiEdges(null)).toEqual([])
    expect(buildWikiEdges('A')).toEqual([])
    expect(buildWikiEdges({ x: 1 })).toEqual([])
    expect(buildTagEdges(null, extractTagsDefault)).toEqual([])
    expect(buildSimilarEdges(undefined)).toEqual([])
    expect(buildLinkEdges({ notes: null })).toEqual([])
    expect(buildLinkEdges({ notes: 42 })).toEqual([])
  })

  it('防御：只有 1 篇笔记时返回 []', () => {
    const one = [note('a', 'A', '[[A]] #t 关键词 关键词')]
    expect(buildWikiEdges(one)).toEqual([])
    expect(buildTagEdges(one, extractTagsDefault)).toEqual([])
    expect(buildSimilarEdges(one)).toEqual([])
    expect(buildLinkEdges({ notes: one })).toEqual([])
  })

  it('防御：数组里混入 null / 字符串不会炸', () => {
    const notes = [null, 'bad', note('a', 'A', '[[B]]'), undefined, note('b', 'B', '')]
    expect(() => buildLinkEdges({ notes })).not.toThrow()
    expect(buildWikiEdges(notes)).toHaveLength(1)
  })
})

// ===========================================================================
describe('T34 · 性能（500 篇笔记）', () => {
  /**
   * 造 500 篇「每篇约 2KB、含 3 条 wiki 链 + 3 个 tag」的笔记，
   * 用固定种子 LCG 保证每次运行数据完全一致（不可因为随机数据掩盖波动）。
   * @param {number} count 笔记数
   * @returns {Array<Object>} 笔记列表
   */
  function buildCorpus (count) {
    let seed = 20240918
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length]
    const words = [
      '关系图', '双链', '笔记', '渲染', '缓存', '布局', '编辑器', '索引', '搜索', '主题',
      'graph', 'link', 'render', 'cache', 'layout', 'index', 'search', 'editor', 'note', 'theme'
    ]
    const notes = []
    for (let i = 0; i < count; i++) notes.push(note(`id${i}`, `笔记${i}`, '', { folder: `文件夹${i % 5}` }))
    for (let i = 0; i < count; i++) {
      const targets = [(i + 1) % count, (i + 7) % count, (i + 13) % count]
      const tags = [(i % 61), (i + 17) % 61, (i + 41) % 61]
      let body = `# ${notes[i].title}\n\n`
      body += `这是第 ${i} 篇用于压测的笔记，下面塞满重复词以保证关键词提取有产出。\n\n`
      for (let k = 0; k < 3; k++) {
        body += `引用 ${notes[targets[k]].title} 的内容：见 [[${notes[targets[k]].title}]] ，这里放几句公共词 `
        body += `${pick(words)}${pick(words)}${pick(words)}。\n\n`
      }
      body += `标签部分： #标签${tags[0]} #标签${tags[1]} #标签${tags[2]} 结束。\n\n`
      while (body.length < 2048) body += `${pick(words)} ${pick(words)} 填充内容 continue fill ${i} 。\n`
      notes[i].content = body
    }
    return notes
  }

  /**
   * 跑 N 次取最快值（best-of-N）。
   *
   * 为什么取 fastest 而不是 average：vitest 默认多线程并发跑 15 个测试文件，
   * 本机单次 sample 会被兄弟进程 / GC 停顿污染一整个数量级（实测 31ms vs 236ms）。
   * 取最快值滤掉的是「调度噪声」，滤不掉「算法退化」——
   * 真要是退化成 O(n²)，最快的一轮同样会爆表，守护作用不打折。
   * @param {Function} fn 被测函数
   * @param {number} times 重复次数
   * @returns {{best: number, samples: number[], result: any}} 计时结果
   */
  function measureFastest (fn, times = 5) {
    const samples = []
    let result = null
    for (let i = 0; i < times; i++) {
      const t0 = performance.now()
      result = fn()
      samples.push(performance.now() - t0)
    }
    return { best: Math.min(...samples), samples, result }
  }

  it('500 篇 × 2KB：全量 buildLinkEdges < 50ms', () => {
    const notes = buildCorpus(500)
    expect(notes).toHaveLength(500)
    expect(notes[0].content.length).toBeGreaterThanOrEqual(2048)

    const runner = () => buildLinkEdges({ notes, extractTags: extractTagsDefault })
    runner() // 预热一次，避免把 JIT 冷启动算进预算
    const { best, samples, result: edges } = measureFastest(runner)
    const ms = (v) => v.toFixed(2) + 'ms'

    const wikiCount = edges.filter(e => e.kind === 'wiki').length
    const tagCount = edges.filter(e => e.kind === 'tag').length
    const similarCount = edges.filter(e => e.kind === 'similar').length
    console.log(
      `[perf] 500 notes buildLinkEdges best=${ms(best)} samples=[${samples.map(ms).join(', ')}] ` +
      `(wiki=${wikiCount}, tag=${tagCount}, similar=${similarCount}, total=${edges.length})`
    )

    expect(wikiCount).toBeGreaterThan(1400) // 每篇 3 条链，去重后应接近 1500
    expect(tagCount).toBeGreaterThan(0)
    expect(best).toBeLessThan(50)
  })

  it('wiki-only 模式同样 < 50ms，且更省', () => {
    const notes = buildCorpus(500)
    const runner = () => buildLinkEdges({ notes, linkMode: 'wiki-only' })
    runner()
    const { best, result: edges } = measureFastest(runner)
    console.log(`[perf] wiki-only best=${best.toFixed(2)}ms, edges=${edges.length}`)
    expect(edges.every(e => e.kind === 'wiki')).toBe(true)
    expect(best).toBeLessThan(50)
  })

  it('wiki 边不出孤儿：边上两端都能在语料里找到', () => {
    const notes = buildCorpus(300)
    const ids = new Set(notes.map(n => n.id))
    const edges = buildLinkEdges({ notes })
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
    // 每篇文章有 3 条链：总度数应为 wiki 边数 × 2 左右（含去重）
    expect(degreeOf(edges, 'id0')).toBeGreaterThan(0)
  })
})
