import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import { EMPTY_MAP, buildForLine, appendCodeBlock, buildTableDecorations } from './blocks.js'
import {
  collectCodeBlocks,
  collectCalloutBlocks,
  collectFrontmatterLines,
  collectActiveLines,
  activeLinesIntersect
} from './scan.js'

/**
 * Obsidian 风格「实时预览」装饰层。
 *
 * 为什么不用 contenteditable 自己渲染（项目旧实现）：
 * 旧方案用 div[contenteditable] 承接渲染结果，再 htmlToMarkdown 反向序列化回源码，
 * 往返过程中必然丢失 / 变形（表格、嵌套列表、代码块缩进、callout），导致
 * 「实时编辑」和「预览」永远对不齐。
 *
 * 这里的做法与 Obsidian 官方一致：底层始终是 CodeMirror 的纯文本文档，
 * 仅在渲染层用 Decoration.replace 隐藏语法标记、用 Decoration.mark 给内容加类。
 * 于是：
 *  - 光标所在行/选区行保持源码原样，随时可以编辑语法本身；
 *  - 其余行渲染成富文本，视觉与 marked 的预览结果共用同一套 CSS 变量；
 *  - 撤销栈、搜索、补全、拼写检查全部照常工作，因为它们面对的都是纯文本。
 *
 * 三个 CodeMirror 坑（分散在各模块，改之前先看对应注释）：
 *  1. plugin 不能提供 block decoration（widgets.js / blocks.js 的表格与分隔线处）；
 *  2. 因此表格必须整块放进 StateField（见 blocks.js 的 buildTableDecorations）；
 *  3. style module 的挂载顺序是反的（StyleModule.mount 内部 concat 后 reverse），
 *     详见 src/utils/editor/themes.js 的告警注释。
 *
 * 块级全文扫描由 scan.js 以不可变的 state.doc 引用作版本号统一记忆化，调用方不要
 * 绕过导出的 collect* 函数重复扫描文档。
 */

/**
 * 只为可视行建立块索引；块边界仍来自全文扫描，因此跨屏代码块和 callout 不会漏掉。
 */
function indexVisibleBlockLines (blocks, visibleLineRanges) {
  const byLine = new Map()
  for (const block of blocks) {
    for (const range of visibleLineRanges) {
      if (range.end < block.start) continue
      if (range.start > block.end) break
      const start = Math.max(block.start, range.start)
      const end = Math.min(block.end, range.end)
      for (let n = start; n <= end; n++) byLine.set(n, block)
    }
  }
  return byLine
}

/** 开关变化时派发此 effect，强制重建装饰（否则只在文档/选区变化时才重算） */
export const toggleLivePreview = StateEffect.define()

export function createLivePreviewPlugin(getEnabled) {
  const livePreviewTables = StateField.define({
    create: (state) => buildTableDecorations(state, getEnabled),
    update: (value, tr) => {
      const selectionChanged = !tr.startState.selection.eq(tr.state.selection)
      const toggled = tr.effects.some(e => e.is(toggleLivePreview))
      if (!tr.docChanged && !selectionChanged && !toggled) return value
      return buildTableDecorations(tr.state, getEnabled)
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.set)
  })

  const viewPlugin = ViewPlugin.fromClass(
    class LivePreviewPlugin {
      constructor(view) {
        this.decorations = this.build(view)
      }

      update(update) {
        // 注意：ViewUpdate 没有 effects 属性（@codemirror/view 6.x），
        // update.effects 永远是 undefined —— 直接 .some() 会抛错且可选链后永远不触发，
        // 必须遍历 transactions 才能拿到事务携带的 effect（如 toggleLivePreview）
        const toggled = update.transactions.some(tr =>
          tr.effects.some(e => e.is(toggleLivePreview))
        )
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged ||
          toggled
        ) {
          this.decorations = this.build(update.view)
        }
      }

      build(view) {
        if (!getEnabled()) return Decoration.none
        const decos = []
        const { state } = view
        const visibleLineRanges = view.visibleRanges.map(({ from, to }) => ({
          start: state.doc.lineAt(from).number,
          end: state.doc.lineAt(to).number
        }))

        // 光标 / 选区影响到的行：这些行保持源码，保证语法本身可编辑
        const activeLines = collectActiveLines(state)

        const { blocks: codeBlocks } = collectCodeBlocks(state)
        const frontmatterLines = collectFrontmatterLines(state)
        const codeLineBlock = indexVisibleBlockLines(codeBlocks, visibleLineRanges)

        // callout 是跨行块：先用全文块边界定位，再只索引可视行，避免漏掉跨屏块
        const calloutByLine = indexVisibleBlockLines(
          collectCalloutBlocks(state),
          visibleLineRanges
        )

        // 表格由 StateField 负责（block widget 不允许来自 plugin），
        // 这里只取它的行号索引：命中则整块跳过，避免重复装饰
        const tableByLine = view.state.field(livePreviewTables, false)?.byLine || EMPTY_MAP

        const cursorInRange = (start, end) => activeLinesIntersect(activeLines, start, end)

        const handledBlocks = new Set()
        const codeTokenCache = new Map()

        // 只装饰可视区，长文档不会退化
        for (const { from, to } of view.visibleRanges) {
          let pos = from
          while (pos <= to) {
            const line = state.doc.lineAt(pos)

            // --- 表格 ---
            const table = tableByLine.get(line.number)
            if (table) {
              if (!cursorInRange(table.start, table.end)) {
                // StateField 已把整块渲染成 <table>，这里整块跳过，避免重复装饰
                const endLine = state.doc.line(table.end)
                if (endLine.to >= to) break
                pos = endLine.to + 1
                continue
              }
              // 光标在表内：退回源码行，但仍保留表格的行分组视觉
              decos.push(
                Decoration.line({
                  class: 'cm-md-table-row' +
                    (line.number === table.start ? ' cm-md-table-header' : '')
                }).range(line.from)
              )
            }

            // --- 代码块：容器外观 + hljs 着色 ---
            const block = codeLineBlock.get(line.number)
            if (block) {
              if (!handledBlocks.has(block)) {
                handledBlocks.add(block)
                appendCodeBlock(
                  state, block, decos,
                  cursorInRange(block.start, block.end),
                  codeTokenCache
                )
              }
              if (line.to >= to) break
              pos = line.to + 1
              continue
            }

            if (frontmatterLines.has(line.number)) {
              decos.push(Decoration.line({ class: 'cm-md-raw-block' }).range(line.from))
            } else {
              buildForLine(state, line, decos, activeLines, calloutByLine.get(line.number))
            }
            if (line.to >= to) break
            pos = line.to + 1
          }
        }

        return Decoration.set(decos, true)
      }
    },
    {
      decorations: (plugin) => plugin.decorations
    }
  )

  return [livePreviewTables, viewPlugin]
}

// ---------------------------------------------------------------------------
// 对外接口：拆分前这些名字全部从 livePreview.js 直接导出，
// 这里逐条 re-export，保证 splitTableRow / renderInlineHtml / tokenizeHighlight
// 等既有引用路径（tests、useEditor）一行都不用改。
// ---------------------------------------------------------------------------

export {
  HEADING_RE,
  QUOTE_RE,
  LIST_RE,
  TASK_RE,
  HR_RE,
  FENCE_RE,
  FRONTMATTER_RE,
  CALLOUT_RE,
  WIKILINK_RE,
  MD_LINK_RE,
  TAG_RE,
  URL_RE,
  TABLE_DELIM_CELL_RE,
  IMAGE_SRC_RE
} from './constants.js'

export {
  collectTables,
  collectCodeBlocks,
  collectFrontmatterLines,
  collectCalloutBlocks,
  collectActiveLines,
  activeLinesIntersect,
  splitTableRow,
  isDelimiterRow,
  alignsFromDelimiter
} from './scan.js'

export {
  scanInline,
  scanDelimited,
  scanEmphasis,
  renderInlineHtml,
  setWikiResolver
} from './inline.js'

export { tokenizeHighlight, highlightCode } from './highlight.js'

export {
  appendCodeBlock,
  buildTableDecorations,
  buildForLine
} from './blocks.js'

export {
  HrWidget,
  ListBulletWidget,
  CheckboxWidget,
  TableWidget,
  EmbedWidget,
  ImageWidget
} from './widgets.js'
