/**
 * C3-B · 图谱计数口径的守卫（tests/graphCountSemantics.test.js）
 * ============================================================================
 * 起因：QA 写图谱 CDP 探针时**自己被绊了一下** —— 状态栏写着「N 节点 · M 链接」，
 * 而画布 DOM 里数出来的 `<circle>` 却是节点数的 **2 倍**（每个节点画两个：
 * 外圈 halo + 主体），首版探针因此把 16 个节点读成 32。
 *
 * 这不是 Bug，是**口径没写在明面上**。整改只做两件事：
 *   1. 在状态栏的**计算处**和画布节点组上写清口径（注释）；
 *   2. 给状态栏 / 画布图例加 tooltip，把口径写给将来读代码的人。
 * 计数逻辑与计数口径一行未改 —— 所以这里断言的也不是「数字该是多少」，而是
 * 「口径说明在不在、以及它与模板的真实结构是否一致」。
 *
 * 为什么用源码级断言而不是挂组件数 DOM：
 *   - 挂载 GraphView 要依赖 noteStore / 力导向 / 600ms 防抖重建，脆弱且慢；
 *   - 这条 P3 要防的是「有人改了渲染结构 / 删了注释却忘了改口径说明」，
 *     源码结构断言（恰好 2 个 circle 标签）比一次快照式的 DOM 计数更稳。
 * 运行时事实（circle 数 ≈ 节点数 × 2）由 CDP 真机验证覆盖。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const GRAPH_SRC = readFileSync(resolve(process.cwd(), 'src') + sep + 'views/GraphView.vue', 'utf8')

/** 状态栏 meta 的**开标签**片段（含 title 属性） */
function statusMetaOpenTag () {
  return GRAPH_SRC.match(/<span\s+class="cho-statusbar-meta"[\s\S]*?>/)
}

/** 状态栏 meta 的**内容**片段（模板文本，未渲染） */
function statusMetaBody () {
  const m = GRAPH_SRC.match(/<span\s+class="cho-statusbar-meta"[\s\S]*?>([\s\S]*?)<\/span>/)
  return m ? m[1] : ''
}

describe('C3-B · 图谱计数口径（过滤后 / 每节点两个 circle）', () => {
  it('G1 计算处写明：链接数是「当前过滤条件下」的集合', () => {
    // 切「全部 / 仅双链」会改变边的集合 —— 状态栏的 M 跟着变，这不是 bug
    expect(
      GRAPH_SRC.includes('当前 linkMode 过滤后'),
      'linkStats / generateGraph 处应写明计数是 linkMode 过滤后的集合'
    ).toBe(true)
    expect(
      GRAPH_SRC.includes('当前过滤条件下'),
      'generateGraph 落 linksRaw 处应写明「当前过滤条件下」口径'
    ).toBe(true)
  })

  it('G2 计算处写明：每个节点渲染两个 circle，DOM 里 circle 数是 2 倍', () => {
    // `**两个**` 里的星号是注释里的强调标记，允许有也允许没有
    expect(
      /每个节点渲染\*{0,2}两个\*{0,2}\s*<circle>/.test(GRAPH_SRC),
      '应写明「每个节点渲染两个 <circle>」（halo + 主体）'
    ).toBe(true)
    expect(
      /DOM 里 circle 数是/.test(GRAPH_SRC),
      '应写明 DOM circle 数与节点数的 2 倍关系，防止后人拿 DOM 数当节点数'
    ).toBe(true)
  })

  it('G3 结构事实：模板里真实的 circle 标签恰好 2 个（halo + 主体）', () => {
    // 用 `<circle\s` 而不是 `<circle`：后者会把注释里提到的 `<circle>` 字面量也算进来。
    // 若哪天真的多画或少画一个 circle，这里会红 —— 提醒同步改口径注释与 tooltip。
    expect((GRAPH_SRC.match(/<circle\s/g) || []).length).toBe(2)
  })

  it('G4 状态栏带 tooltip，且 tooltip 里也是同一套口径', () => {
    const tag = statusMetaOpenTag()
    expect(tag, '未找到 .cho-statusbar-meta 元素').not.toBeNull()
    expect(tag[0].includes('title='), '状态栏 meta 应带 title（tooltip）').toBe(true)
    expect(tag[0].includes('过滤后'), 'tooltip 应说明链接数是过滤后的').toBe(true)
    expect(tag[0].includes('2 个 circle'), 'tooltip 应说明每节点 2 个 circle').toBe(true)
  })

  it('G5 画布图例带 tooltip，说明它与状态栏不是同一个口径', () => {
    const m = GRAPH_SRC.match(/title="画布内计数[^"]*"/)
    expect(m, '画布内图例应带 title（tooltip）').not.toBeNull()
    expect(m[0].includes('2 倍'), '画布图例 tooltip 应点明 circle 数是 2 倍').toBe(true)
  })

  it('G6 状态栏文案格式未变：N 节点 · M 链接（双链 X · 标签 Y · 相似 Z）', () => {
    // 加 tooltip 属于改属性，不能顺手改了既有文案 —— QA 的探针按这个格式解析
    const body = statusMetaBody()
    expect(body).toContain('{{ nodes.length }} 节点 · {{ links.length }} 链接')
    expect(body).toContain('双链 {{ linkStats.wiki }}')
    expect(body).toContain('标签 {{ linkStats.tag }}')
    expect(body).toContain('相似 {{ linkStats.similar }}')
  })
})
