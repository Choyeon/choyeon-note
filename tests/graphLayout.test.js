/**
 * T36 · 图谱布局持久化 + 指纹补全 —— 验收测试
 * ============================================================================
 * 用户诉求「优化关系图系统」的最后一块（R-G3 / R-G4）：
 *
 *   R-G3  图谱布局不稳定 —— 每次打开图谱节点位置都不一样，摆好的图下次全乱。
 *         根因有两个，本文件分别钉死：
 *           · 初值用了 Math.random()（力导向是混沌系统，初值差一点收敛就完全不同）
 *           · 坐标从来不存盘（关掉再开必然重排）
 *   R-G4  重建指纹只有 id:title:content.length，漏掉两类改动：
 *           · 笔记换文件夹（正文一字未改）→ 指纹不变 → 不重建
 *           · 正文等长改写 → 长度不变 → 不重建
 *
 * 分四层：
 *   A · 源码契约层   —— 防倒退：Math.random 回来 / 阈值被乱调 → 立刻变红
 *   B · 指纹函数单测 —— 直接 import GraphView.vue 的具名导出，不靠挂载反推
 *   C · 真实挂载层   —— R-G3 主验收：冷启动两次排布一致
 *   D · 性能约束层   —— 斥力阈值不许动；坐标不许每帧写 localStorage
 *
 * 挂载要点（照抄 T35 踩过的坑）：
 *   · jsdom 里 getBoundingClientRect 恒为 0，GraphView 的 measureContainer()
 *     见到 0 会直接 return —— 图谱根本不生成。必须打成 1000×800。
 *   · T35 把 requestAnimationFrame 打成了「永不回调」的桩，那样仿真永远停在
 *     第一帧、永远不收敛，坐标也就永远不落盘。这里改成**可手动泵送的队列**，
 *     才能真的把 400 帧力导向跑完并触发落盘。
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
// 具名导出来自 GraphView.vue 顶部的普通 `<script>` 块（不是 `<script setup>`），
// 那块专放纯函数与存档读写，就是为了能被直接单测。
import GraphView, {
  hashSeed,
  contentFingerprint,
  noteFingerprint,
  graphFingerprint,
  graphSignature,
  readGraphPositions,
  writeGraphPositions,
  clearGraphPositions,
  GRAPH_POSITIONS_VERSION
} from '@/views/GraphView.vue'
import { LS_KEYS } from '@/constants/storage'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const GRAPH_VIEW_PATH = path.resolve(SCRIPT_DIR, '../src/views/GraphView.vue')
const STORAGE_PATH = path.resolve(SCRIPT_DIR, '../src/constants/storage.js')
const GRAPH_VIEW_SRC = fs.readFileSync(GRAPH_VIEW_PATH, 'utf8')
const STORAGE_SRC = fs.readFileSync(STORAGE_PATH, 'utf8')

/** 坐标落盘去抖窗口：与 GraphView 里的 SAVE_DEBOUNCE_MS 对齐 */
const SAVE_DEBOUNCE_MS = 1000

/** 等待 n 毫秒（真实定时器：重建防抖 600ms、落盘去抖 1000ms 都是真 setTimeout） */
function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 去掉 SFC 里的注释，只留代码。
 * Math.random() 这个词在注释里是会正常出现的（要解释为什么不用它），
 * 直接 toContain 会永远为真 —— 必须先剥注释再断言，否则这条断言是假的。
 *
 * @param {string} src 源文件文本
 * @returns {string} 去掉注释后的文本
 */
function stripComments (src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\*|\/\/)/.test(line))
    .join('\n')
}

/** 造 n 篇互相有双链的笔记（成环），让力导向有活干 */
function makeNotes (count = 10) {
  const notes = []
  for (let i = 1; i <= count; i++) {
    const next = (i % count) + 1
    notes.push({
      id: `t36-n${i}`,
      title: `节点${i}`,
      folder: '图谱',
      content: `# 节点${i}\n\n正文关键词${i} 独有内容${i} 冷门词条${i}\n\n[[节点${next}]]\n`,
      tags: [],
      filePath: null,
      createdAt: new Date('2024-01-01T00:00:00'),
      updatedAt: new Date('2024-01-01T00:00:00')
    })
  }
  return notes
}

// ---------------------------------------------------------------------------
// A · 源码契约层（防倒退）
// ---------------------------------------------------------------------------

describe('A · GraphView.vue 源码契约（防倒退）', () => {
  it('A1 R-G3 根因：代码里一个 Math.random() 都不能有', () => {
    const code = stripComments(GRAPH_VIEW_SRC)
    expect(code).not.toContain('Math.random')
    // 旧的两行随机初值必须彻底消失
    expect(GRAPH_VIEW_SRC).not.toContain('Math.random() * 0.3')
    expect(GRAPH_VIEW_SRC).not.toContain('Math.random() * 80')
  })

  it('A2 初始坐标由 id 派生的确定性种子算出', () => {
    expect(GRAPH_VIEW_SRC).toMatch(/const seed = hashSeed\(`\$\{note\.id\}#\$\{index\}#\$\{layoutNonce\}`\)/)
    expect(GRAPH_VIEW_SRC).toContain('((seed & 0xffff) / 0xffff) * 0.3')
    expect(GRAPH_VIEW_SRC).toContain('(((seed >>> 16) & 0xffff) / 0xffff) * 80')
  })

  it('A2b 「重新布局」换的是排位与相位，不是只抖一下（小图否则会被拉回同一处）', () => {
    // CDP 探针实测：只抖 ±0.3 rad 时，9 节点的示例库收敛后与重排前差值 < 0.2px，
    // 按钮点了跟没点一样。排位挪位 + 起始相位换掉才能真的落到另一处。
    expect(GRAPH_VIEW_SRC).toContain('const slot = notes.length > 0 ? (index + layoutNonce) % notes.length : 0')
    expect(GRAPH_VIEW_SRC).toContain('const phase = (hashSeed(`phase#${layoutNonce}`) / 0xffffffff) * 2 * Math.PI')
    // 但这两者都必须只依赖 nonce：nonce 恒为 0 的冷启动必须仍是一套固定坐标
    expect(GRAPH_VIEW_SRC).not.toMatch(/const slot = [^\n]*Math\.random/)
  })

  it('A3 坐标存档 key 登记在 LS_KEYS 里，且字符串值逐字一致', () => {
    // storage.js 必须是唯一登记处，值必须逐字等于 'choyeon-graph-positions'
    expect(STORAGE_SRC).toContain("graphPositions: 'choyeon-graph-positions'")
    expect(LS_KEYS.graphPositions).toBe('choyeon-graph-positions')
    // GraphView 必须引用登记值，而不是自己再抄一份字符串（抄两份迟早漂移）
    expect(GRAPH_VIEW_SRC).toContain('localStorage.getItem(LS_KEYS.graphPositions)')
    expect(GRAPH_VIEW_SRC).toContain('localStorage.setItem(LS_KEYS.graphPositions')
    expect(GRAPH_VIEW_SRC).toContain('localStorage.removeItem(LS_KEYS.graphPositions)')
    // 并且不许用裸字符串绕开登记
    const code = stripComments(GRAPH_VIEW_SRC)
    expect(code).not.toContain("'choyeon-graph-positions'")
  })

  it('A4 存档带版本号，坏了就丢弃而不是读坏数据', () => {
    expect(GRAPH_VIEW_SRC).toContain('if (parsed.v !== GRAPH_POSITIONS_VERSION) return null')
    expect(GRAPH_VIEW_SRC).toMatch(/try \{[\s\S]{0,400}?catch \(error\) \{\s*\n\s*return null/)
  })

  it('A5 恢复坐标时校验有限数：NaN 会让整张图消失', () => {
    expect(GRAPH_VIEW_SRC).toContain('Number.isFinite(Number(savedPos.x))')
    expect(GRAPH_VIEW_SRC).toContain('Number.isFinite(Number(savedPos.y))')
  })

  it('A6 「重新布局」必须清存档 + 换种子，而不是把旧坐标读回来（随机化函数已不存在）', () => {
    expect(GRAPH_VIEW_SRC).toMatch(/function relayout\s*\(\)/)
    expect(GRAPH_VIEW_SRC).not.toMatch(/function randomize\s*\(/)
    const body = GRAPH_VIEW_SRC.slice(GRAPH_VIEW_SRC.indexOf('function relayout()'))
    expect(body).toContain('layoutNonce++')
    expect(body).toContain('clearGraphPositions()')
    expect(body).toContain('startSimulation()')
    // nonce 必须是自增整数：拿时间戳/随机数当种子会毁掉冷启动确定性
    expect(body).not.toContain('Date.now()')
  })

  it('A7 R-G4：指纹里必须有 folder，且正文不能只比长度', () => {
    expect(GRAPH_VIEW_SRC).toContain('() => graphFingerprint(noteStore.notes)')
    expect(GRAPH_VIEW_SRC).toMatch(/`\$\{id\}:\$\{title\}:\$\{folder\}:\$\{contentFingerprint\(/)
    // 旧的「只比长度」写法必须消失
    expect(GRAPH_VIEW_SRC).not.toContain('${n.id}:${n.title}:${(n.content || \'\').length}')
    // 正文指纹不能退化回纯 length
    expect(GRAPH_VIEW_SRC).toContain('function contentFingerprint')
  })

  it('A8 落盘只在「坐标不再变」的时刻排，不在每帧排', () => {
    const code = stripComments(GRAPH_VIEW_SRC)

    // 全文件只允许一处真正写 localStorage —— 就是 writeGraphPositions 这一条。
    // 有人在 tick 里手滑加一句 setItem，这条立刻从 1 变 2。
    expect(code.split('localStorage.setItem(').length - 1).toBe(1)

    // tick 函数体内：只能标记脏 + 在收敛分支排一次写入，不允许直接落盘
    const start = code.indexOf('function tick()')
    const callSite = code.indexOf('\n  tick()', start)
    const tickBody = code.slice(start, callSite > start ? callSite : code.length)
    expect(tickBody).toContain('positionsDirty = true')
    expect(tickBody).toContain('scheduleSavePositions()')
    expect(tickBody).not.toContain('writeGraphPositions')
    expect(tickBody).not.toContain('flushSavePositions')

    // 去抖常量必须存在（没有去抖就是每次触发都同步写）
    expect(code).toContain('const SAVE_DEBOUNCE_MS = 1000')
    expect(code).toContain('const SAVE_MAX_WAIT_MS = 5000')
  })

  it('A9 性能红线：斥力阈值与截断距离不许乱调', () => {
    // 阈值一改，≥1200 节点的图就会切换算法 → 收敛结果整体变化 → 布局又"不稳"了
    expect(GRAPH_VIEW_SRC).toContain('const REPULSION_CUTOFF = 320')
    expect(GRAPH_VIEW_SRC).toContain('const REPULSION_GRID_MIN = 1200')
  })
})

// ---------------------------------------------------------------------------
// B · 指纹函数单测（R-G4）
// ---------------------------------------------------------------------------

describe('B · 重建指纹（R-G4）', () => {
  it('B1 同一份笔记 → 同一个指纹（指纹本身必须是纯函数）', () => {
    const notes = makeNotes(5)
    expect(graphFingerprint(notes)).toBe(graphFingerprint(notes))
    expect(hashSeed('abc')).toBe(hashSeed('abc'))
  })

  it('B2 只换文件夹（正文一字未改）→ 指纹必须变', () => {
    const a = [{ id: 'a', title: 'T', folder: '工作', content: '# T\n\n正文。' }]
    const b = [{ id: 'a', title: 'T', folder: '归档', content: '# T\n\n正文。' }]
    expect(graphFingerprint(a)).not.toBe(graphFingerprint(b))
  })

  it('B3 等长改写正文（短笔记）→ 指纹必须变', () => {
    const a = [{ id: 'a', title: 'T', folder: '', content: '# T\n\n' + 'AAAA'.repeat(30) }]
    const b = [{ id: 'a', title: 'T', folder: '', content: '# T\n\n' + 'BBBB'.repeat(30) }]
    expect(a[0].content.length).toBe(b[0].content.length)
    expect(graphFingerprint(a)).not.toBe(graphFingerprint(b))
  })

  it('B4 等长改写正文（长笔记，走采样分支）→ 指纹必须变', () => {
    const head = '# T\n\n'
    const tail = '\n\n结尾段落。'
    const fillerA = '甲'.repeat(4000)
    const fillerB = '乙'.repeat(4000)
    const a = [{ id: 'a', title: 'T', folder: '', content: head + fillerA + tail }]
    const b = [{ id: 'a', title: 'T', folder: '', content: head + fillerB + tail }]
    expect(a[0].content.length).toBe(b[0].content.length)
    expect(a[0].content.length).toBeGreaterThan(256)
    expect(graphFingerprint(a)).not.toBe(graphFingerprint(b))
  })

  it('B5 只改长度 → 指纹变（旧行为不能丢）', () => {
    const a = [{ id: 'a', title: 'T', folder: '', content: '短' }]
    const b = [{ id: 'a', title: 'T', folder: '', content: '长一点点' }]
    expect(graphFingerprint(a)).not.toBe(graphFingerprint(b))
  })

  it('B6 改 title / 改 id → 指纹变', () => {
    const base = { id: 'a', title: 'T', folder: '', content: 'x' }
    expect(graphFingerprint([base])).not.toBe(graphFingerprint([{ ...base, title: 'T2' }]))
    expect(graphFingerprint([base])).not.toBe(graphFingerprint([{ ...base, id: 'b' }]))
  })

  it('B7 缺字段（undefined folder / null content）不炸，且稳定', () => {
    const a = [{ id: 'a', title: 'T' }]
    const b = [{ id: 'a', title: 'T', folder: undefined, content: null }]
    expect(graphFingerprint(a)).toBe(graphFingerprint(b))
    expect(noteFingerprint({})).toBeTypeOf('string')
    expect(graphFingerprint(null)).toBe('')
  })

  it('B8 指纹计算是 O(采样) 而不是 O(全量正文)', () => {
    // 断言写成"规模比"而不是"绝对毫秒数"：vitest 多个测试文件并行跑，
    // 单机的绝对耗时能被别的 worker 拖到几十毫秒，写死阈值只会造出随机红灯。
    //
    // 判据：正文放大 30 倍，耗时不该跟着放大 30 倍。
    //   全量哈希 → 次数正比于正文长度 → 比值 ≈ 30（必红）
    //   采样哈希 → 每篇固定 96 个采样点 → 比值 ≈ 1
    // 这个上限是防止有人"图省事"改回全量哈希：指纹在 watch 的 getter 里算，
    // 每敲一个字都会跑一遍全库，全量哈希会把每次按键拖到几十毫秒。
    const build = (len) => {
      const notes = []
      for (let i = 0; i < 300; i++) {
        notes.push({ id: `p${i}`, title: `P${i}`, folder: '', content: '字'.repeat(len) + i })
      }
      return notes
    }
    const mid = build(1000)
    const huge = build(30000)
    const timeOf = (notes) => {
      const started = Date.now()
      graphFingerprint(notes)
      return Date.now() - started
    }
    timeOf(mid)
    timeOf(huge) // 预热，避开首次 JIT 的噪声
    const tMid = timeOf(mid)
    const tHuge = timeOf(huge)
    expect(tHuge).toBeLessThan(Math.max(tMid, 1) * 5 + 20)
    // 再加一道很宽松的绝对上限，兜住"整体退化"（本机实测个位数毫秒）
    expect(tHuge).toBeLessThan(500)
  })

  it('B9 结构签名：边顺序不影响签名（否则每次打开都误判成"图变了"）', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const mk = (s, t, kind) => ({ kind, source: { id: s }, target: { id: t } })
    const l1 = [mk('a', 'b', 'wiki'), mk('b', 'c', 'tag')]
    const l2 = [mk('b', 'c', 'tag'), mk('a', 'b', 'wiki')]
    expect(graphSignature(nodes, l1)).toBe(graphSignature(nodes, l2))
    // 但边集合真的变了就必须变
    expect(graphSignature(nodes, l1)).not.toBe(graphSignature(nodes, [mk('a', 'b', 'wiki')]))
    // 节点集合变了也要变
    expect(graphSignature(nodes, l1)).not.toBe(graphSignature([{ id: 'a' }, { id: 'b' }], l1))
  })
})

// ---------------------------------------------------------------------------
// C · 真实挂载层（R-G3 主验收）
// ---------------------------------------------------------------------------

/** 当前挂载的 app */
let app = null
/** 挂载点 */
let host = null
/** RAF 回调队列：可手动泵送，让 400 帧力导向真的跑完 */
let rafQueue = []
let rafId = 0

/**
 * 把 RAF 队列里的回调跑干（力导向靠 RAF 自我续帧）。
 *
 * @param {number} max 最多泵几帧（MAX_SIMULATION_FRAMES = 400，给足余量）
 * @returns {Promise<number>} 实际泵了几帧
 */
async function pumpFrames (max = 600) {
  let n = 0
  while (rafQueue.length > 0 && n < max) {
    const callbacks = rafQueue
    rafQueue = []
    for (const cb of callbacks) cb(0)
    n++
    // 每 25 帧让出一次事件循环：Vue 的渲染调度器靠微任务 flush，
    // 一直同步跑下去会攒下一堆待处理的更新
    if (n % 25 === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return n
}

/**
 * 挂载 GraphView。
 *
 * 笔记在 mount **之前**塞进 store：这样 watch 不会因为"notes 变了"而触发
 * 600ms 防抖重建，图谱在 onMounted 里就按最终数据建好了，测试不必空等。
 *
 * @param {Array<Object>} notes 笔记列表
 * @returns {Promise<{store: Object, queued: number, frames: number}>}
 *   queued = 挂载后 RAF 队列长度（>0 表示跑了力导向，=0 表示走了纯恢复）
 */
async function mountGraph (notes) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useNoteStore } = await import('@/stores/note')
  const store = useNoteStore()
  store.notes = notes

  host = document.createElement('div')
  document.body.appendChild(host)

  app = createApp(GraphView)
  app.use(pinia)
  app.mount(host)

  await nextTick()
  await nextTick()

  const queued = rafQueue.length
  const frames = await pumpFrames(600)
  await nextTick()
  await nextTick()

  return { store, queued, frames }
}

/** 卸载并摘掉挂载点（卸载时会补一次落盘） */
function unmountGraph () {
  if (app) {
    app.unmount()
    app = null
  }
  if (host && host.parentNode) host.parentNode.removeChild(host)
  host = null
  rafQueue = []
}

/**
 * 从真实 DOM 里读出每个节点的坐标。
 * 走 DOM 而不是读 localStorage —— 读存档只能证明"存对了"，证明不了
 * "渲染出来的就是这一套坐标"。
 *
 * @returns {Object<string, {x: number, y: number}>} 标签 → 坐标
 */
function nodeCoords () {
  const out = {}
  if (!host) return out
  const groups = host.querySelectorAll('.nodes g.node-group')
  groups.forEach(g => {
    const transform = g.getAttribute('transform') || ''
    const m = transform.match(/translate\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)/)
    const labelEl = g.querySelector('text')
    const label = labelEl ? labelEl.textContent.trim() : ''
    if (m && label) {
      out[label] = { x: Number(m[1]), y: Number(m[2]) }
    }
  })
  return out
}

/**
 * 读画布外层 <g> 的平移量。
 * generateGraph 会顺带把 offsetX/offsetY 重算（即平移复位），所以「平移量被复位」
 * 是"图谱真的重建了"的一个可观测信号 —— 换文件夹未必改变边数，靠边数断言不出东西。
 *
 * @returns {{x: number, y: number, scale: number}}
 */
function outerOffset () {
  const g = host.querySelector('svg > g')
  const transform = g ? (g.getAttribute('transform') || '') : ''
  const m = transform.match(/translate\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)\s*scale\(\s*(-?[\d.eE+-]+)\s*\)/)
  if (!m) return { x: NaN, y: NaN, scale: NaN }
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) }
}

/** 把画布拖歪一段距离（用于探测"图谱是否重建过"） */
function panCanvas (dx, dy) {
  const canvas = host.querySelector('.graph-canvas')
  canvas.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
  canvas.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: dx, clientY: dy }))
  canvas.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
}

/** 按 title 属性点按钮（jsdom 无布局，只能靠属性定位） */
function clickByTitle (title) {
  const btn = host.querySelector(`button[title="${title}"]`)
  if (!btn) return false
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}

/** 两套坐标的最大差值 */
function maxDelta (a, b) {
  let max = 0
  for (const key of Object.keys(a)) {
    if (!b[key]) return Number.POSITIVE_INFINITY
    max = Math.max(max, Math.abs(a[key].x - b[key].x), Math.abs(a[key].y - b[key].y))
  }
  return max
}

beforeAll(() => {
  // jsdom 默认所有盒子都是 0×0，GraphView 的 measureContainer() 见到 0 会
  // 直接 return，图谱根本不生成 —— 这是 T35 踩过的坑
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 1000, height: 800, top: 0, left: 0,
      right: 1000, bottom: 800, x: 0, y: 0, toJSON () {}
    }
  }
  globalThis.requestAnimationFrame = (cb) => {
    rafQueue.push(cb)
    return ++rafId
  }
  globalThis.cancelAnimationFrame = () => {}
})

beforeEach(() => {
  localStorage.clear()
  rafQueue = []
})

afterEach(() => {
  unmountGraph()
})

describe('C · 真实挂载：冷启动两次排布一致（R-G3 主验收）', () => {
  it('C1 首次挂载：没有存档 → 跑力导向 → 收敛后坐标落盘', async () => {
    expect(readGraphPositions()).toBeNull()
    const { queued, frames } = await mountGraph(makeNotes(10))

    const coords = nodeCoords()
    expect(Object.keys(coords).length).toBe(10)
    // 没有存档时必须真的排一次
    expect(queued).toBeGreaterThan(0)
    expect(frames).toBeGreaterThan(0)

    // 去抖窗口内还没写：证明写入不是每帧发生的
    expect(readGraphPositions()).toBeNull()
    await wait(SAVE_DEBOUNCE_MS + 400)
    const saved = readGraphPositions()
    expect(saved).not.toBeNull()
    expect(saved.v).toBe(GRAPH_POSITIONS_VERSION)
    expect(Object.keys(saved.positions).length).toBe(10)
    expect(saved.sig).toBeTruthy()
    for (const pos of Object.values(saved.positions)) {
      expect(Number.isFinite(pos.x)).toBe(true)
      expect(Number.isFinite(pos.y)).toBe(true)
    }
  })

  it('C2 R-G3 主验收：冷启动两次，坐标是同一套', async () => {
    const notes = makeNotes(10)

    // 第一次冷启动：全新的 pinia / 全新的组件实例，localStorage 是空的
    await mountGraph(notes)
    const first = nodeCoords()
    expect(Object.keys(first).length).toBe(10)
    await wait(SAVE_DEBOUNCE_MS + 400)
    const archiveA = readGraphPositions()
    unmountGraph()

    // 第二次冷启动：又是全新的 pinia / 组件实例，唯一共享的是 localStorage
    const second = await mountGraph(notes)
    const coords2 = nodeCoords()
    expect(Object.keys(coords2).length).toBe(10)

    // 不要求像素级，但必须是"同一套坐标"
    expect(maxDelta(first, coords2)).toBeLessThan(0.01)

    // 而且第二次根本不该再排一次版：纯恢复，一帧力导向都不跑
    expect(second.queued).toBe(0)
    expect(second.frames).toBe(0)
    // 存档内容也没有被第二次启动改写
    expect(readGraphPositions()).toEqual(archiveA)
  })

  it('C3 第三次冷启动仍然一致（不是碰巧两次相同）', async () => {
    const notes = makeNotes(8)
    const snapshots = []
    for (let i = 0; i < 3; i++) {
      await mountGraph(notes)
      snapshots.push(nodeCoords())
      await wait(SAVE_DEBOUNCE_MS + 400)
      unmountGraph()
    }
    expect(maxDelta(snapshots[0], snapshots[1])).toBeLessThan(0.01)
    expect(maxDelta(snapshots[1], snapshots[2])).toBeLessThan(0.01)
  })

  it('C3b 无存档时两次冷启动也一致（种子确定性，不靠存档兜底）', async () => {
    // ⚠️ 这条是 C2 的必要补充：C2 只要存档还在，"初值随不随机"都能过 ——
    // 第二次挂载直接读存档，随机初值根本没参与。故障注入 fi1（把 Math.random
    // 装回种子）实测只红了 A1 / A2 两条源码契约，C2 照样绿 —— 那等于
    // 「布局确定性」这条验收在行为层没人守。
    // 所以这里每次挂载前都清空存档，强迫两次都走"种子 → 力导向"的完整路径。
    const notes = makeNotes(8)
    const snapshots = []
    for (let i = 0; i < 2; i++) {
      localStorage.removeItem(LS_KEYS.graphPositions)
      const mounted = await mountGraph(notes)
      expect(mounted.queued).toBeGreaterThan(0) // 确实走了重排分支
      snapshots.push(nodeCoords())
      unmountGraph()
    }
    expect(Object.keys(snapshots[0]).length).toBe(8)
    expect(maxDelta(snapshots[0], snapshots[1])).toBeLessThan(0.01)
  })

  it('C4 重新布局：坐标真的变了，且新坐标落盘并稳定下来', async () => {
    const notes = makeNotes(10)
    await mountGraph(notes)
    const before = nodeCoords()
    await wait(SAVE_DEBOUNCE_MS + 400)
    const archiveBefore = readGraphPositions()

    // 一键重排
    expect(clickByTitle('重新布局')).toBe(true)
    await nextTick()
    await nextTick()
    await pumpFrames(600)
    await nextTick()
    await wait(SAVE_DEBOUNCE_MS + 400)

    const after = nodeCoords()
    const moved = Object.keys(before).filter(k =>
      Math.abs(before[k].x - after[k].x) > 1 || Math.abs(before[k].y - after[k].y) > 1
    )
    // 点了重排却一个节点都没动 = 按钮是摆设（坐标持久化的典型退化）
    expect(moved.length).toBeGreaterThan(5)

    const archiveAfter = readGraphPositions()
    expect(archiveAfter).not.toBeNull()
    expect(archiveAfter.positions).not.toEqual(archiveBefore.positions)

    // 重排后的新坐标也要能稳定复现
    unmountGraph()
    const third = await mountGraph(notes)
    expect(maxDelta(after, nodeCoords())).toBeLessThan(0.01)
    expect(third.queued).toBe(0)
  })

  it('C5 新增笔记：老节点保持原位，只有新节点需要重排', async () => {
    const notes = makeNotes(8)
    await mountGraph(notes)
    const before = nodeCoords()
    await wait(SAVE_DEBOUNCE_MS + 400)
    unmountGraph()

    // 加两篇新笔记 → 签名变了 → 会跑力导向，但以存档坐标为热启动初值
    const extended = notes.concat(makeNotes(2).map(n => ({ ...n, id: `new-${n.id}`, title: `新${n.title}` })))
    const second = await mountGraph(extended)
    const after = nodeCoords()

    expect(Object.keys(after).length).toBe(10)
    expect(second.queued).toBeGreaterThan(0) // 有新节点 → 确实排了版
    // 老节点不是从零重排：大致还在原来的地方（热启动）
    const kept = Object.keys(before).filter(k => after[k])
    expect(kept.length).toBe(8)
    const drift = kept.filter(k =>
      Math.abs(before[k].x - after[k].x) < 200 && Math.abs(before[k].y - after[k].y) < 200
    )
    expect(drift.length).toBeGreaterThanOrEqual(6)
  })

  it('C6 拖动节点后坐标落盘（手动摆的位要能存下来）', async () => {
    await mountGraph(makeNotes(6))
    await wait(SAVE_DEBOUNCE_MS + 400)
    const before = readGraphPositions()

    const firstId = Object.keys(before.positions)[0]
    // 模拟一次拖拽：mousedown 在节点上 → mousemove → mouseup
    const group = host.querySelector('.nodes g.node-group')
    expect(group).not.toBeNull()
    group.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }))
    host.querySelector('.graph-canvas').dispatchEvent(
      new window.MouseEvent('mousemove', { bubbles: true, clientX: 260, clientY: 220 })
    )
    host.querySelector('.graph-canvas').dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true })
    )
    await nextTick()
    await pumpFrames(600)
    await wait(SAVE_DEBOUNCE_MS + 400)

    const after = readGraphPositions()
    expect(after).not.toBeNull()
    const moved = Object.keys(after.positions).some(id => {
      const b = before.positions[id]
      const a = after.positions[id]
      return !b || Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1
    })
    expect(moved).toBe(true)
    expect(after.positions[firstId]).toBeDefined()
  })

  it('C7 损坏的存档 / 版本不符：不炸，回落到确定性种子布局', async () => {
    localStorage.setItem(LS_KEYS.graphPositions, '{ 这不是 JSON')
    expect(readGraphPositions()).toBeNull()
    const first = await mountGraph(makeNotes(6))
    expect(Object.keys(nodeCoords()).length).toBe(6)
    expect(first.queued).toBeGreaterThan(0) // 走了重排分支
    await wait(SAVE_DEBOUNCE_MS + 400)

    // 版本不符同理
    localStorage.setItem(LS_KEYS.graphPositions, JSON.stringify({
      v: GRAPH_POSITIONS_VERSION + 99, sig: 'x', positions: { 't36-n1': { x: 1, y: 2 } }
    }))
    expect(readGraphPositions()).toBeNull()

    // 结构对但坐标是脏值：不能让节点飞到 NaN
    writeGraphPositions({ 't36-n1': { x: 'abc', y: null } }, 'sig')
    const second = await mountGraph(makeNotes(6))
    const coords = nodeCoords()
    expect(Object.keys(coords).length).toBe(6)
    for (const pos of Object.values(coords)) {
      expect(Number.isFinite(pos.x)).toBe(true)
      expect(Number.isFinite(pos.y)).toBe(true)
    }
    // 有脏坐标 → 不能判定为纯恢复
    expect(second.queued).toBeGreaterThan(0)
  })

  it('C8 种子确定性：同一个 id 必然得到同一个初值（Math.random 不会回来）', () => {
    // 直接钉死哈希的确定性：不同 id → 不同种子，同 id → 同种子，且落在 uint32
    expect(hashSeed('t36-n1#0#0')).toBe(hashSeed('t36-n1#0#0'))
    expect(hashSeed('t36-n1#0#0')).not.toBe(hashSeed('t36-n2#0#0'))
    expect(hashSeed('t36-n1#0#0')).not.toBe(hashSeed('t36-n1#0#1'))
    for (const v of [hashSeed(''), hashSeed('a'), hashSeed('中文测试')]) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('C9 换文件夹会触发重建（R-G4 第一条，走真实 watch）', async () => {
    // 怎么观测"重建了"？generateGraph 会顺带把画布平移复位（offsetX/offsetY
    // 重算），所以先把画布拖歪，再只改 folder —— 平移被复位就证明重建真的跑了。
    // 不能直接看边数：换文件夹未必改变边集合，那就断言不出任何东西。
    const { store } = await mountGraph(makeNotes(6))
    await wait(SAVE_DEBOUNCE_MS + 400)

    panCanvas(160, 120)
    await nextTick()
    expect(outerOffset().x).toBeCloseTo(160, 0)

    // 正文一字未改，只把整批笔记挪到另一个文件夹
    store.notes = store.notes.map(n => ({ ...n, folder: '新目录' }))
    await wait(900)
    await pumpFrames(600)
    await nextTick()
    await nextTick()

    // 旧指纹（id:title:content.length）在这里完全不变 → 不会重建 → 平移会停在 160
    expect(outerOffset().x).toBeCloseTo(0, 0)
  })

  it('C10 正文等长改写会触发重建（R-G4 第二条，走真实 watch）', async () => {
    const { store } = await mountGraph(makeNotes(6))
    await wait(SAVE_DEBOUNCE_MS + 400)

    panCanvas(160, 120)
    await nextTick()
    expect(outerOffset().x).toBeCloseTo(160, 0)

    // 等长改写：关键词 → 关键语（3 字换 3 字），长度严格不变
    const original = store.notes
    const rewritten = original.map(n => ({ ...n, content: n.content.replace(/关键词/g, '关键语') }))
    for (let i = 0; i < rewritten.length; i++) {
      expect(rewritten[i].content.length).toBe(original[i].content.length)
      expect(rewritten[i].content).not.toBe(original[i].content)
      expect(contentFingerprint(rewritten[i].content)).not.toBe(contentFingerprint(original[i].content))
    }
    store.notes = rewritten
    await wait(900)
    await pumpFrames(600)
    await nextTick()
    await nextTick()

    // 旧指纹只看长度 → 不会重建 → 平移会停在 160
    expect(outerOffset().x).toBeCloseTo(0, 0)
  })
})

// ---------------------------------------------------------------------------
// D · 性能约束层
// ---------------------------------------------------------------------------

describe('D · 性能约束', () => {
  it('D1 坐标落盘次数与仿真帧数无关（不是每帧写 localStorage）', async () => {
    const proto = Object.getPrototypeOf(window.localStorage)
    const original = proto.setItem
    let writes = 0
    proto.setItem = function (key, value) {
      if (key === LS_KEYS.graphPositions) writes++
      return original.call(this, key, value)
    }
    try {
      const { frames } = await mountGraph(makeNotes(12))
      expect(frames).toBeGreaterThan(20) // 确实跑了很多帧力导向
      // 收敛后去抖窗口内：一次都还没写 —— 这是"不许每帧写"的直接证据
      expect(writes).toBe(0)
      await wait(SAVE_DEBOUNCE_MS + 400)
      expect(writes).toBe(1)
      // 之后再等一个窗口，也不该有第二次写入（坐标没动就不写）
      await wait(SAVE_DEBOUNCE_MS + 400)
      expect(writes).toBe(1)
    } finally {
      proto.setItem = original
    }
  })

  it('D2 纯恢复时不写 localStorage（打开即稳定，零 IO）', async () => {
    await mountGraph(makeNotes(8))
    await wait(SAVE_DEBOUNCE_MS + 400)
    unmountGraph()

    const proto = Object.getPrototypeOf(window.localStorage)
    const original = proto.setItem
    let writes = 0
    proto.setItem = function (key, value) {
      if (key === LS_KEYS.graphPositions) writes++
      return original.call(this, key, value)
    }
    try {
      const second = await mountGraph(makeNotes(8))
      expect(second.queued).toBe(0)
      expect(second.frames).toBe(0)
      await wait(SAVE_DEBOUNCE_MS + 400)
      expect(writes).toBe(0)
      // 卸载时也不该补写（坐标压根没动过，positionsDirty 是 false）
      unmountGraph()
      expect(writes).toBe(0)
    } finally {
      proto.setItem = original
    }
  })

  it('D3 卸载时补一次落盘：去抖窗口没到也要把坐标保住', async () => {
    await mountGraph(makeNotes(8))
    // 收敛后立刻卸载，不等去抖窗口
    expect(readGraphPositions()).toBeNull()
    unmountGraph()
    const saved = readGraphPositions()
    expect(saved).not.toBeNull()
    expect(Object.keys(saved.positions).length).toBe(8)
  })

  it('D4 clearGraphPositions 真的清得掉（「重新布局」与 resetConfig 都靠它）', () => {
    writeGraphPositions({ a: { x: 1, y: 2 } }, 'sig')
    expect(readGraphPositions()).not.toBeNull()
    clearGraphPositions()
    expect(readGraphPositions()).toBeNull()
    expect(localStorage.getItem(LS_KEYS.graphPositions)).toBeNull()
  })
})
