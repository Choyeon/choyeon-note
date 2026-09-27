/**
 * T35 · GraphView 接入双链 —— 验收测试
 * ============================================================================
 * 用户最痛的诉求：「关系图里看不到自己的双链」。本文件从两个层面把它钉死：
 *
 *   A. 源码契约层：GraphView.vue 必须满足 T34 给的接入说明（5 个坑 + 2 个硬要求）。
 *      这层是"防倒退"——T34 逐行数过的坑（边 key 碰撞 / 力导向没用 strength /
 *      本地宽松 tagRegex / 混标计数）任何一个被改回去，这里立刻变红。
 *
 *   B. 真实挂载层：用 vue + pinia 把 GraphView.vue 真的挂到 jsdom 上，
 *      注入一篇写了 12 条 [[双链]] 的笔记，然后断言：
 *        · 「全部」模式下 wiki 边 = 12
 *        · 「仅双链」模式下渲染出的 <line> 就是 12 条
 *        · 节点详情面板分列显示「双链 12 / 相似 n」（R-G5 禁止混标）
 *      这层是"防自欺"——只测内核不算数，必须证明 GraphView 真的把它接上了。
 *
 * 为什么 B 层不直接 import 内核然后复算一遍？
 *   因为那样测的是内核，不是接入。接入可能错在 id→节点映射、可能错在漏传
 *   linkMode、可能错在把 wiki 边过滤掉了 —— 这些只有真渲染才暴露。
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import GraphView from '@/views/GraphView.vue'
import { EDGE_KINDS, EDGE_WEIGHT, LINK_MODES } from '@/utils/graphLinks'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const GRAPH_VIEW_PATH = path.resolve(SCRIPT_DIR, '../src/views/GraphView.vue')
const GRAPH_VIEW_SRC = fs.readFileSync(GRAPH_VIEW_PATH, 'utf8')

/** 等待 n 毫秒（真实定时器：GraphView 的重建防抖是 600ms） */
function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// A · 源码契约层
// ---------------------------------------------------------------------------

describe('A · GraphView.vue 源码契约（防倒退）', () => {
  it('A1 已引入 T34 内核：buildLinkEdges / EDGE_KINDS / LINK_MODES', () => {
    expect(GRAPH_VIEW_SRC).toContain("from '@/utils/graphLinks'")
    expect(GRAPH_VIEW_SRC).toContain('buildLinkEdges')
    expect(GRAPH_VIEW_SRC).toContain('EDGE_KINDS')
    expect(GRAPH_VIEW_SRC).toContain('LINK_MODES')
  })

  it('A2 已删除本地宽松 tagRegex，改注入 useLinks 的权威 extractTags', () => {
    // 旧实现：/#(\S+?)(?=\s|#|$)/g —— 会把 #define / #anchor / ###标题 全当标签
    expect(GRAPH_VIEW_SRC).not.toContain('#(\\S+?)')
    expect(GRAPH_VIEW_SRC).not.toMatch(/function\s+extractTags\s*\(/)
    expect(GRAPH_VIEW_SRC).toContain("from '@/composables/useLinks'")
    // 且这个 extractTags 必须真的被喂给了内核，而不是 import 了不用
    expect(GRAPH_VIEW_SRC).toMatch(/buildLinkEdges\(\{[^}]*extractTags/s)
  })

  it('A3 旧的本地 buildLinks 死代码已删除', () => {
    expect(GRAPH_VIEW_SRC).not.toMatch(/function\s+buildLinks\s*\(/)
    expect(GRAPH_VIEW_SRC).not.toContain('MAX_BUCKET')
    expect(GRAPH_VIEW_SRC).not.toContain('commonTitleKeywords')
  })

  it('A4 坑①：边的 :key 必须带 kind（wiki 边与 tag 边否则会碰撞丢边）', () => {
    const keyExpr = '${l.kind}|${l.source.id}|${l.target.id}'
    const hits = GRAPH_VIEW_SRC.split(keyExpr).length - 1
    expect(hits).toBe(2) // visibleLinks 的两个 return 分支都要改
    expect(GRAPH_VIEW_SRC).not.toContain('id: `${l.source.id}|${l.target.id}`')
  })

  it('A5 坑③：力导向必须把 strength 乘进去（否则双链在图上不会更紧）', () => {
    expect(GRAPH_VIEW_SRC).toMatch(/const force = \(dist - 150\) \* attractionStrength \* \(link\.strength \?\? 1\)/)
  })

  it('A6 getLinkCount 支持按 kind 过滤（R-G5 分列展示的前提）', () => {
    expect(GRAPH_VIEW_SRC).toMatch(/function getLinkCount\s*\(nodeId,\s*kind\)/)
    expect(GRAPH_VIEW_SRC).toContain('if (kind && l.kind !== kind) continue')
  })

  it('A7 R-G5：模板里双链 / 相似 / 标签必须分列，禁止混标成一个数字', () => {
    expect(GRAPH_VIEW_SRC).toContain('双链 {{ getLinkCount(selectedNode, EDGE_KINDS.wiki) }}')
    expect(GRAPH_VIEW_SRC).toContain('相似 {{ getLinkCount(selectedNode, EDGE_KINDS.similar) }}')
    expect(GRAPH_VIEW_SRC).toContain('标签 {{ getLinkCount(selectedNode, EDGE_KINDS.tag) }}')
    // 旧的混标写法必须消失
    expect(GRAPH_VIEW_SRC).not.toContain('{{ getLinkCount(selectedNode.id) }} 链接')
  })

  it('A7b 计数必须传 selectedNode（id 字符串）而不是 selectedNode.id', () => {
    // selectedNode 存的是节点 id 字符串，取 .id 恒为 undefined → 三个计数永远 0。
    // 这是整改前「N 链接」一直是 0 的直接原因，必须钉死。
    expect(GRAPH_VIEW_SRC).not.toContain('getLinkCount(selectedNode.id')
  })

  it('A8 R-G1：存在「仅双链」开关，且真的把 linkMode 传给了内核', () => {
    expect(GRAPH_VIEW_SRC).toContain('仅显示双链')
    expect(GRAPH_VIEW_SRC).toContain('LINK_MODES.WIKI_ONLY')
    expect(GRAPH_VIEW_SRC).toMatch(/buildLinkEdges\(\{[^}]*linkMode:\s*linkMode\.value/s)
    // 切换后必须重建图谱，否则点了没反应
    expect(GRAPH_VIEW_SRC).toMatch(/watch\(linkMode,/s)
  })

  it('A9 坑④：没有在逐条链接上调用 useLinks 的解析器（O(n·links)）', () => {
    expect(GRAPH_VIEW_SRC).not.toContain('resolveLink')
  })

  it('A10 tag 口径必须并上 note.tags（标签视图读的就是这个字段）', () => {
    expect(GRAPH_VIEW_SRC).toMatch(/function extractTagsForGraph\s*\(content,\s*note\)/)
    expect(GRAPH_VIEW_SRC).toContain('extractTags: extractTagsForGraph')
    expect(GRAPH_VIEW_SRC).toContain('tags: extractTagsForGraph(note.content, note)')
    // 节点配色也必须走同一口径，否则配色与边对不上
    expect(GRAPH_VIEW_SRC).not.toContain('tags: extractTags(note.content)')
  })
})

// ---------------------------------------------------------------------------
// B · 真实挂载层
// ---------------------------------------------------------------------------

/**
 * 造一批带双链的笔记：12 个目标 + 1 个枢纽（枢纽里手写 12 条 [[ ]]）。
 * 目标笔记的正文刻意做成互不相干，把 similar 边的干扰降到最低。
 *
 * @param {number} count 双链条数
 * @returns {Array<Object>} 笔记列表
 */
function makeWikiNotes (count = 12) {
  const notes = []
  for (let i = 1; i <= count; i++) {
    notes.push({
      id: `t35-target-${i}`,
      title: `T35目标${i}`,
      folder: '图谱验收',
      // 前两篇共享一个标签：让「全部」模式一定比「仅双链」多出 tag 边，
      // 否则两种模式的边数相同，B4 就没法证明开关真的在过滤。
      content: `# T35目标${i}\n\n独有正文 关键词${i} 关键词${i} 特殊段落${i} 冷门词${i}。${i <= 2 ? '\n\n#图谱验收\n' : ''}`,
      tags: [],
      filePath: null,
      createdAt: new Date('2024-01-01T00:00:00'),
      updatedAt: new Date('2024-01-01T00:00:00')
    })
  }

  const wikiLinks = []
  for (let i = 1; i <= count; i++) wikiLinks.push(`[[T35目标${i}]]`)
  notes.push({
    id: 't35-hub',
    title: 'T35枢纽',
    folder: '图谱验收',
    content: `# T35枢纽\n\n这一篇手写了 ${count} 条双链：\n\n${wikiLinks.join(' ')}\n`,
    tags: [],
    filePath: null,
    createdAt: new Date('2024-01-02T00:00:00'),
    updatedAt: new Date('2024-01-02T00:00:00')
  })
  return notes
}

/** 当前挂载的 app（afterEach 里卸载） */
let app = null
/** 挂载点 */
let host = null

/**
 * 把 GraphView 挂到 jsdom 上。
 * jsdom 里 getBoundingClientRect 恒为 0，而 GraphView 的 measureContainer()
 * 见到 0 会直接 return（图谱根本不生成），所以必须先把它打成真实尺寸。
 *
 * @param {Array<Object>} notes 要喂给 noteStore 的笔记
 * @returns {Promise<Object>} { container, store }
 */
async function mountGraph (notes) {
  const pinia = createPinia()
  setActivePinia(pinia)

  host = document.createElement('div')
  document.body.appendChild(host)

  app = createApp(GraphView)
  app.use(pinia)
  app.mount(host)

  const { useNoteStore } = await import('@/stores/note')
  const store = useNoteStore()
  store.notes = notes

  // onMounted → nextTick → generateGraph()
  await nextTick()
  await nextTick()
  // 防抖 watcher 600ms 后会再重建一次（用新 notes），等它跑完
  await wait(900)
  await nextTick()

  return { container: host, store }
}

/** 状态栏那一行文本：节点数 / 链接数 / 双链 / 标签 / 相似 */
function statusText () {
  const el = host.querySelector('.cho-statusbar-meta')
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''
}

/**
 * 解析状态栏里的分类计数。
 * @returns {{nodes: number, links: number, wiki: number, tag: number, similar: number}}
 */
function parseStatus () {
  const text = statusText()
  const num = (label) => {
    const m = text.match(new RegExp(`${label}\\s+(\\d+)`))
    return m ? Number(m[1]) : -1
  }
  const links = text.match(/(\d+)\s+链接/)
  const nodes = text.match(/(\d+)\s+节点/)
  return {
    nodes: nodes ? Number(nodes[1]) : -1,
    links: links ? Number(links[1]) : -1,
    wiki: num('双链'),
    tag: num('标签'),
    similar: num('相似')
  }
}

/** 画布里真正渲染出来的边（SVG <line>） */
function renderedEdges () {
  return host.querySelectorAll('.links line')
}

/**
 * 按 title 属性点一个按钮（jsdom 里没有真实布局，只能靠属性定位）。
 * @param {string} title title 属性
 * @returns {boolean} 是否点到
 */
function clickByTitle (title) {
  const btn = host.querySelector(`button[title="${title}"]`)
  if (!btn) return false
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}

/**
 * 点侧边栏节点列表里的某一项（视图里的导航必须走真实 DOM 点击）。
 * @param {string} label 节点标题
 * @returns {boolean} 是否点到
 */
function clickNodeInList (label) {
  const items = Array.from(host.querySelectorAll('aside .cursor-pointer'))
  const hit = items.find(el => el.textContent.trim() === label)
  if (!hit) return false
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}

/**
 * 节点详情面板（右上角那张卡片）里的文本。
 *
 * ⚠️ 必须限定在面板容器内取：状态栏那行也写着「双链 12 · 标签 1 · 相似 0」，
 * 如果这里图省事扫全组件的 span，测试会被状态栏"喂"出一个假绿 ——
 * 面板其实一直显示 0（selectedNode 是 id 字符串，取 .id 恒为 undefined）。
 *
 * @returns {string} 面板内所有 span 文本用 ' | ' 连接
 */
function panelText () {
  const box = host.querySelector('div.w-64')
  if (!box) return ''
  const spans = Array.from(box.querySelectorAll('span'))
  return spans.map(s => s.textContent.trim()).filter(Boolean).join(' | ')
}

beforeAll(() => {
  // jsdom 默认所有盒子都是 0×0，GraphView 会因此拒绝生成图谱
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 1000, height: 800, top: 0, left: 0,
      right: 1000, bottom: 800, x: 0, y: 0, toJSON () {}
    }
  }
  // 力导向的 RAF 循环在测试里没有意义：让它只跑第一帧就停
  let rafId = 0
  globalThis.requestAnimationFrame = () => ++rafId
  globalThis.cancelAnimationFrame = () => {}
})

afterEach(() => {
  if (app) {
    app.unmount()
    app = null
  }
  if (host && host.parentNode) host.parentNode.removeChild(host)
  host = null
})

describe('B · GraphView 真实挂载：手写 12 条 [[ ]] 必须显示 12 条双链', () => {
  it('B1 挂载后图谱非空，且状态栏给出了分类计数', async () => {
    await mountGraph(makeWikiNotes(12))
    const text = statusText()
    expect(text).toMatch(/13 节点/)
    expect(text).toMatch(/双链 12/)
    expect(renderedEdges().length).toBeGreaterThan(0)
  })

  it('B1b 渲染出的边数 === 双链 + 标签 + 相似（边 key 碰撞探测器）', async () => {
    // 一旦 :key 丢了 kind，同一对节点上的 wiki 边与 tag 边会互相覆盖，
    // 状态栏（读 linksRaw）仍报全量，但画布上少画 —— 这个等式就是那个差值。
    await mountGraph(makeWikiNotes(12))
    const s = parseStatus()
    expect(s.wiki).toBeGreaterThanOrEqual(0)
    expect(renderedEdges().length).toBe(s.wiki + s.tag + s.similar)
    expect(renderedEdges().length).toBe(s.links)
  })

  it('B9 同一对节点同时有 wiki 边和 tag 边时，两条都要画出来（坑①）', async () => {
    await mountGraph([
      { id: 'h', title: 'Hub', folder: '', content: '# Hub\n\n[[Alpha]] [[Beta]]\n\n#sharedtag\n', tags: [], filePath: null },
      { id: 'a', title: 'Alpha', folder: '', content: '# Zeta\n\n#sharedtag\n', tags: [], filePath: null },
      { id: 'b', title: 'Beta', folder: '', content: '# Omega\n\n#sharedtag\n', tags: [], filePath: null }
    ])
    // h-a / h-b 各有 1 条 wiki + 1 条 tag；a-b 只有 1 条 tag
    const s = parseStatus()
    expect(s.wiki).toBe(2)
    expect(s.tag).toBe(3)
    expect(renderedEdges().length).toBe(s.wiki + s.tag + s.similar)

    // 面板必须按 kind 分列：枢纽是 双链 2 / 标签 2，不是混标的 4
    expect(clickNodeInList('Hub')).toBe(true)
    await nextTick()
    await nextTick()
    const text = panelText()
    expect(text).toMatch(/双链 2\b/)
    expect(text).toMatch(/标签 2\b/)
  })

  it('B10 三级标题与 URL 锚点不能被当成标签（本地宽松正则的死穴）', async () => {
    // 宽松正则 /#(\S+?)(?=\s|#|$)/g 会把 `### 小节` 里的 # 和
    // `http://...#section` 的 #section 都当成标签，凭空造出边和节点配色。
    await mountGraph([
      { id: 'a', title: '甲', folder: '', content: '# 甲\n\n### 小节\n\n见 http://a.example.com/docs#section\n\n内容阿尔法 内容阿尔法\n', tags: [], filePath: null },
      { id: 'b', title: '乙', folder: '', content: '# 乙\n\n### 小节\n\n见 http://b.example.com/docs#section\n\n内容贝塔 内容贝塔\n', tags: [], filePath: null }
    ])
    expect(parseStatus().tag).toBe(0)
  })

  it('B2 R-G1 主验收：12 条手写双链 → 双链计数 = 12', async () => {
    await mountGraph(makeWikiNotes(12))
    expect(statusText()).toMatch(/双链 12\b/)
  })

  it('B3 选中枢纽笔记后，详情面板分列显示「双链 12」（R-G5）', async () => {
    await mountGraph(makeWikiNotes(12))
    expect(clickNodeInList('T35枢纽')).toBe(true)
    await nextTick()
    await nextTick()
    const text = panelText()
    expect(text).toContain('T35枢纽')
    expect(text).toMatch(/双链 12\b/)
    expect(text).toMatch(/相似 \d+/)
    // 混标写法必须不存在
    expect(text).not.toMatch(/^\d+ 链接$/)
  })

  it('B4 切到「仅双链」：只剩 wiki 边，条数 = 12', async () => {
    await mountGraph(makeWikiNotes(12))
    const allEdges = renderedEdges().length
    expect(clickByTitle('仅显示双链')).toBe(true)
    await nextTick()
    await nextTick()

    const wikiOnlyEdges = renderedEdges().length
    expect(wikiOnlyEdges).toBe(12)
    // 「全部」模式一定比「仅双链」多（还有 tag / similar 边）
    expect(allEdges).toBeGreaterThan(wikiOnlyEdges)
    expect(statusText()).toMatch(/链接（双链 12 · 标签 0 · 相似 0）/)
  })

  it('B5 切回「全部」：边数恢复（开关是双向的，不是一次性）', async () => {
    await mountGraph(makeWikiNotes(12))
    const allEdges = renderedEdges().length
    clickByTitle('仅显示双链')
    await nextTick()
    await nextTick()
    clickByTitle('全部关系（双链 + 标签 + 相似）')
    await nextTick()
    await nextTick()
    expect(renderedEdges().length).toBe(allEdges)
    expect(statusText()).toMatch(/双链 12/)
  })

  it('B6 双链条数随手写链接数变化（7 条就是 7，不是写死的 12）', async () => {
    await mountGraph(makeWikiNotes(7))
    expect(statusText()).toMatch(/8 节点/)
    expect(statusText()).toMatch(/双链 7\b/)
  })

  it('B7 一条双链都没有时：wiki 计数为 0，不会凭空造边', async () => {
    await mountGraph([
      { id: 'a', title: '甲', folder: '', content: '# 甲\n\n没有双链的正文。', tags: [], filePath: null },
      { id: 'b', title: '乙', folder: '', content: '# 乙\n\n也没有双链的正文。', tags: [], filePath: null }
    ])
    expect(statusText()).toMatch(/双链 0/)
  })

  it('B8 标签只写在 note.tags（正文里没有 #tag）时，图谱照样连边', async () => {
    // 示例库就是这种形态：tags 是元数据字段，正文里一个 # 都没有。
    // 只按正文提取的话这里会是 0 条边 —— 用户打开图谱看到的就是一堆散点。
    await mountGraph([
      { id: 'a', title: '甲', folder: '', content: '# 甲\n\n正文里没有标签。', tags: ['工作', '周报'], filePath: null },
      { id: 'b', title: '乙', folder: '', content: '# 乙\n\n正文里也没有标签。', tags: ['工作'], filePath: null },
      { id: 'c', title: '丙', folder: '', content: '# 丙\n\n正文里还是没有标签。', tags: ['个人'], filePath: null }
    ])
    expect(statusText()).toMatch(/标签 1\b/)
    expect(renderedEdges().length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// C · 渲染档位：三类边必须落在三档粗细上（接入说明第 ② 条的隐含契约）
// ---------------------------------------------------------------------------

describe('C · 权重 → 渲染档位映射', () => {
  it('C1 wiki=3 / tag=2 / similar=0.5 分别落入 2px / 1.5px / 1px 三档', () => {
    const widthOf = (strength) => (strength > 2 ? 2 : (strength > 1 ? 1.5 : 1))
    expect(widthOf(EDGE_WEIGHT.wiki)).toBe(2)
    expect(widthOf(EDGE_WEIGHT.tag)).toBe(1.5)
    expect(widthOf(EDGE_WEIGHT.similar)).toBe(1)
  })

  it('C2 力导向乘上 strength 后，wiki 的吸引力是 tag 的 1.5 倍、similar 的 6 倍', () => {
    const ratio = EDGE_WEIGHT.wiki / EDGE_WEIGHT.tag
    const ratio2 = EDGE_WEIGHT.wiki / EDGE_WEIGHT.similar
    expect(ratio).toBeCloseTo(1.5, 10)
    expect(ratio2).toBeCloseTo(6, 10)
  })

  it('C3 linkMode 常量只有 all / wiki-only 两个取值', () => {
    expect(Object.values(LINK_MODES)).toEqual(['all', 'wiki-only'])
    expect(Object.values(EDGE_KINDS)).toEqual(['wiki', 'tag', 'similar'])
  })
})
