import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  splitTableRow,
  isDelimiterRow,
  alignsFromDelimiter,
  renderInlineHtml,
  tokenizeHighlight,
  collectCalloutBlocks
} from '../src/utils/editor/livePreview.js'

const stateOf = (text) => EditorState.create({ doc: text })

/**
 * 实时预览（CodeMirror 装饰层）与阅读视图（marked）的一致性，
 * 前提是「表格切分 / 对齐判定 / 行内渲染 / hljs 分词」这四块基础逻辑正确。
 */
describe('live preview: 表格切分', () => {
  it('去掉首尾空心单元格', () => {
    expect(splitTableRow('| a | b |')).toEqual(['a', 'b'])
  })

  it('允许省略首尾竖线', () => {
    expect(splitTableRow('a | b')).toEqual(['a', 'b'])
  })

  it('保留转义竖线', () => {
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a | b', 'c'])
  })

  it('去除单元格两端空白', () => {
    expect(splitTableRow('|  a  |  b  |')).toEqual(['a', 'b'])
  })
})

describe('live preview: 分隔行与对齐', () => {
  it('识别分隔行', () => {
    expect(isDelimiterRow('|---|---|')).toBe(true)
    expect(isDelimiterRow('| :---: | ---: |')).toBe(true)
    expect(isDelimiterRow('---')).toBe(true)
  })

  it('非分隔行不误判', () => {
    expect(isDelimiterRow('| a | b |')).toBe(false)
    expect(isDelimiterRow('| --- | a |')).toBe(false)
  })

  it('解析对齐方式', () => {
    expect(alignsFromDelimiter('|:--|--:|:-:|')).toEqual(['left', 'right', 'center'])
    expect(alignsFromDelimiter('|---|---|')).toEqual(['left', 'left'])
  })
})

describe('live preview: 单元格行内渲染', () => {
  it('粗体 / 斜体 / 删除线 / 高亮', () => {
    expect(renderInlineHtml('**粗**')).toBe('<strong>粗</strong>')
    expect(renderInlineHtml('*斜*')).toBe('<em>斜</em>')
    expect(renderInlineHtml('~~删~~')).toBe('<del>删</del>')
    expect(renderInlineHtml('==高==')).toBe('<mark>高</mark>')
  })

  it('行内代码内容单独转义，不二次转义', () => {
    expect(renderInlineHtml('`a<b`')).toBe('<code>a&lt;b</code>')
  })

  it('双链优先展示别名', () => {
    expect(renderInlineHtml('[[笔记|别名]]')).toBe(
      '<span class="wikilink is-resolved">别名</span>'
    )
  })

  it('裸 HTML 一律转义，避免单元格注入', () => {
    const out = renderInlineHtml('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })
})

describe('live preview: hljs 输出分词', () => {
  it('普通 token', () => {
    const tokens = tokenizeHighlight(
      '<span class="hljs-keyword">const</span> x = <span class="hljs-string">"a"</span>'
    )
    expect(tokens).toEqual([
      { text: 'const', cls: 'hljs-keyword' },
      { text: ' x = ', cls: null },
      { text: '"a"', cls: 'hljs-string' }
    ])
  })

  it('嵌套 token（string > subst）保留外层类', () => {
    const tokens = tokenizeHighlight(
      '<span class="hljs-string">a<span class="hljs-subst">${b}</span>c</span>'
    )
    expect(tokens).toEqual([
      { text: 'a', cls: 'hljs-string' },
      { text: '${b}', cls: 'hljs-string hljs-subst' },
      { text: 'c', cls: 'hljs-string' }
    ])
  })

  it('还原 HTML 实体，保证 token 长度与源码一致', () => {
    const tokens = tokenizeHighlight('<span class="hljs-string">a&lt;b&amp;c</span>')
    expect(tokens).toEqual([{ text: 'a<b&c', cls: 'hljs-string' }])
  })
})

describe('live preview: callout 分块', () => {
  it('头行 + 后续连续的 > 行算同一块', () => {
    const blocks = collectCalloutBlocks(
      stateOf('> [!note] 标题\n> 正文一\n> 正文二\n\n普通段落')
    )
    expect(blocks).toEqual([{ start: 1, end: 3, type: 'note' }])
  })

  it('类型大小写不敏感', () => {
    expect(collectCalloutBlocks(stateOf('> [!WARNING]- 注意'))[0].type).toBe('warning')
  })

  it('空行会终止 callout 块', () => {
    expect(collectCalloutBlocks(stateOf('> [!tip] T\n\n> 引用')).map(b => b.end)).toEqual([1])
  })

  it('普通引用不产生 callout 块', () => {
    expect(collectCalloutBlocks(stateOf('> 只是引用\n> 第二行'))).toEqual([])
  })

  it('多个 callout 各自成块', () => {
    const blocks = collectCalloutBlocks(stateOf('> [!tip] A\n> a\n\n> [!danger] B'))
    expect(blocks).toEqual([
      { start: 1, end: 2, type: 'tip' },
      { start: 4, end: 4, type: 'danger' }
    ])
  })
})

describe('live preview: callout 分块', () => {
  it('头行 + 后续连续的 > 行算同一块', () => {
    const blocks = collectCalloutBlocks(
      stateOf('> [!note] 标题\n> 正文一\n> 正文二\n\n普通段落')
    )
    expect(blocks).toEqual([{ start: 1, end: 3, type: 'note' }])
  })

  it('类型大小写不敏感', () => {
    expect(collectCalloutBlocks(stateOf('> [!WARNING]- 注意'))[0].type).toBe('warning')
  })

  it('空行会终止 callout 块', () => {
    expect(collectCalloutBlocks(stateOf('> [!tip] T\n\n> 引用')).map(b => b.end)).toEqual([1])
  })

  it('普通引用不产生 callout 块', () => {
    expect(collectCalloutBlocks(stateOf('> 只是引用\n> 第二行'))).toEqual([])
  })

  it('多个 callout 各自成块', () => {
    const blocks = collectCalloutBlocks(stateOf('> [!tip] A\n> a\n\n> [!danger] B'))
    expect(blocks).toEqual([
      { start: 1, end: 2, type: 'tip' },
      { start: 4, end: 4, type: 'danger' }
    ])
  })
})
