import { EditorView, Decoration } from '@codemirror/view'
import { StateEffect, StateField, Facet } from '@codemirror/state'

/** 强制重算拼写装饰（忽略词 / 词典 / 开关变化时使用） */
export const forceSpellUpdate = StateEffect.define()

/**
 * 拼写配置 Facet。把「如何取错误列表」「是否启用」「版本号」注入 StateField，
 * 而不是靠闭包捕获外部变量 —— 这样 StateField 可以在模块级定义一次，
 * 外部工具函数（findSpellErrorAt / spellRectOf）才能直接按位置查询装饰。
 */
const spellConfig = Facet.define({
  combine: (values) => values[0] || { getErrors: () => [], isEnabled: () => false, getVersion: () => 0, onSpellClick: null }
})

let lastVersion = -1

const spellField = StateField.define({
  create(state) {
    lastVersion = state.facet(spellConfig).getVersion?.() ?? 0
    return build(state)
  },
  update(decorations, tr) {
    const config = tr.state.facet(spellConfig)
    const version = config.getVersion?.() ?? 0
    const versionChanged = version !== lastVersion
    lastVersion = version
    if (tr.docChanged || versionChanged || tr.effects.some(e => e.is(forceSpellUpdate))) {
      return build(tr.state)
    }
    return decorations
  },
  provide: (f) => EditorView.decorations.from(f)
})

function build(state) {
  const config = state.facet(spellConfig)
  if (!config.isEnabled()) return Decoration.none
  const text = state.doc.toString()
  if (!text) return Decoration.none

  const errors = config.getErrors(text) || []
  if (!errors.length) return Decoration.none

  const max = state.doc.length
  const decos = []
  let lastEnd = 0
  for (const error of errors) {
    const from = Math.max(0, Math.min(error.start, max))
    const to = Math.max(0, Math.min(error.end, max))
    if (to <= from || from < lastEnd) continue
    decos.push(
      Decoration.mark({
        class: 'cm-spell-error',
        attributes: {
          'data-spell-word': error.word,
          title: `拼写存疑：${error.word}（点击可忽略 / 加入词典）`
        }
      }).range(from, to)
    )
    lastEnd = to
  }
  return Decoration.set(decos, true)
}

/**
 * 拼写检查扩展。
 *
 * 旧实现的问题：菜单触发依赖「mousemove 时按 offset 反查错误列表」，
 * 命中判定与菜单定位被拆在两处（mousemove 打开 / 全局 click 关闭），
 * 于是出现「点第一个词正常、点第二个词打不开」「菜单离单词很远」等现象。
 *
 * 现在的做法：
 * 1. 每个错误都是独立的 <span class="cm-spell-error" data-spell-word="...">，
 *    命中不再依赖坐标反查，任何一个波浪线都能被稳定点中；
 * 2. 命中判定统一收敛到 findSpellErrorAt(view, pos)，DOM 路径与坐标路径共用；
 * 3. 菜单坐标由 view.coordsAtPos 给出波浪线自身的屏幕矩形，永远贴着单词，
 *    不受滚动位置、换行、字号影响；
 * 4. 关闭只认「点到菜单外」，移除 pinned / 定时器构成的隐式状态机。
 */
export function spellCheckExtension(config) {
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false
      const state = view.state.facet(spellConfig)
      if (!state.isEnabled()) return false
      const hit = hitTest(view, event)
      if (!hit) return false
      event.preventDefault()
      // 附上点击元素自身的屏幕矩形。view.coordsAtPos 在位置滚出视口（或视图
      // 尚未完成 measure）时返回 null，会导致菜单定位失效而不可见；而用户能
      // 点中的元素必有有效 getBoundingClientRect，用它作为菜单锚点最可靠。
      const target = event.target
      if (target && target.nodeType === 1) {
        const r = target.getBoundingClientRect()
        if (r.width > 0 || r.height > 0) {
          hit.rect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        }
      }
      state.onSpellClick?.(hit)
      return true
    }
  })

  return [spellConfig.of(config), spellField, clickHandler]
}

/**
 * 命中测试：把一次鼠标事件解析成 { word, from, to }。
 * 先按 DOM target 精确命中装饰 span，失败再退回坐标反查，两条路径共用同一份 RangeSet。
 */
export function hitTest(view, event) {
  const target = event.target
  if (target && target.nodeType === 1 && target.classList?.contains('cm-spell-error')) {
    const word = target.getAttribute('data-spell-word')
    if (word) {
      const pos = view.posAtDOM(target, 0)
      const byPos = pos >= 0 ? findSpellErrorAt(view, pos) : null
      if (byPos) return byPos
      const byWord = findSpellErrorByWord(view, word)
      if (byWord) return byWord
    }
  }

  if (typeof event.clientX !== 'number') return null
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
  if (pos < 0) return null
  return findSpellErrorAt(view, pos)
}

/** 返回覆盖该文档位置的拼写错误区间；不存在返回 null */
export function findSpellErrorAt(view, pos) {
  const decorations = view.state.field(spellField, false)
  if (!decorations || pos < 0) return null
  const len = view.state.doc.length
  let found = null
  // 用一个字符宽的区域查询：只命中真正覆盖 pos 的区间
  decorations.between(Math.max(0, pos - 1), Math.min(pos + 1, len), (from, to, value) => {
    if (found) return
    if (pos >= from && pos <= to) {
      found = { from, to, word: value.spec?.attributes?.['data-spell-word'] || view.state.sliceDoc(from, to) }
    }
  })
  return found
}

function findSpellErrorByWord(view, word) {
  const decorations = view.state.field(spellField, false)
  if (!decorations) return null
  let found = null
  const cursor = decorations.iter()
  while (cursor.value && !found) {
    const attr = cursor.value.spec?.attributes
    if (attr && attr['data-spell-word'] === word) {
      found = { from: cursor.from, to: cursor.to, word }
    }
    cursor.next()
  }
  return found
}

/** 波浪线自身的屏幕矩形，用于定位菜单 */
export function spellRectOf(view, range) {
  if (!view || !range) return null
  const start = view.coordsAtPos(range.from)
  const end = range.to > range.from ? view.coordsAtPos(range.to) : null
  if (!start) return null
  return {
    left: start.left,
    right: end ? end.left : start.right,
    top: start.top,
    bottom: start.bottom
  }
}
