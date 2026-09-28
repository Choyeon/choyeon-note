/**
 * 命令面板「条目级可用性（when）」机制 —— 数据源层单测
 *
 * 要证的四件事：
 *   1. `app.undoFileOp` 在**空撤回栈**时产出 `disabled: true`，条目仍在列表里（置灰，不是消失）；
 *   2. 撤回栈一有内容，同一个 computed **自动**变回可用 —— 不是打开面板那一刻的快照；
 *   3. 可用时 label 带上栈顶描述（QA 指出的「不知道将撤回什么」），且不会长到挤爆面板；
 *   4. 面板消费禁用项的三个纯函数（跳过 / 定位 / 拦击）行为正确。
 *
 * 为什么用**真 note store**：
 *   本轮的关键风险是「判定函数没读到 ref → computed 收集不到依赖 → 状态永不更新」。
 *   手搓一个 `{ canUndoFileOperation: true }` 的普通对象照样能测出 disabled 的值，
 *   但那样根本证不了响应式 —— 那正是上一轮最容易踩的坑。这里走
 *   `pushUndoEntry()`（模块级 ref）→ `fileUndo.canUndo`（computed）→ noteStore（Pinia 代理）
 *   → `useCommands` 的 computed 这条真实链路，并用 `watch` 计数证明它真的被触发了。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, watch } from 'vue'
import {
  useCommands,
  isCommandDisabled,
  firstSelectableIndex,
  nextSelectableIndex,
  runCommand
} from '../src/composables/useCommands'
import { useAppStore } from '../src/stores/app'
import { useNoteStore } from '../src/stores/note'
import { pushUndoEntry, clearUndo, getUndoStack } from '../src/composables/useFileUndo'
import { SHORTCUT_MAP } from '../src/constants/shortcuts'

/** 造一条能入栈的撤回记录（只要 records 非空，pushUndoEntry 就收） */
function entry (label) {
  return {
    kind: 'delete',
    label,
    records: [{
      id: 'n1',
      index: 0,
      afterIndex: -1,
      existedBefore: true,
      existedAfter: false,
      before: {
        id: 'n1', index: 0, title: '购物清单', folder: '', filePath: 'C:/notes/a.md',
        content: '', tags: [], createdAt: 1, updatedAt: 1, wordCount: 0, charCount: 0, lineCount: 0
      },
      after: {
        id: 'n1', index: -1, title: '', folder: '', filePath: null,
        content: '', tags: [], createdAt: null, updatedAt: null, wordCount: 0, charCount: 0, lineCount: 0
      },
      fields: ['__existence__']
    }]
  }
}

/** 建一套面板上下文（真 appStore + 真 noteStore） */
function setup () {
  const appStore = useAppStore()
  const noteStore = useNoteStore()
  const commands = useCommands({ appStore, noteStore, router: null })
  return { appStore, noteStore, commands }
}

/** 按 id 取条目 */
function findCmd (commands, id) {
  return commands.quickActions.value.find(c => c.id === id)
}

let stopWatch = null

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  // 撤回栈是模块级单例，用例之间必须清干净，否则「空栈」断言会被上一条用例污染
  clearUndo()
})

afterEach(() => {
  if (typeof stopWatch === 'function') {
    stopWatch()
    stopWatch = null
  }
  clearUndo()
})

describe('A. 空撤回栈：条目置灰但仍在列表里', () => {
  it('A1 app.undoFileOp 出现在面板里，且 disabled = true', () => {
    const { commands } = setup()
    const cmd = findCmd(commands, 'app.undoFileOp')
    expect(cmd, '命令面板里找不到 app.undoFileOp（被过滤掉了 = 隐藏，不是置灰）').toBeTruthy()
    expect(cmd.disabled).toBe(true)
  })

  it('A2 置灰条目仍能被搜到（rankCommands 搜「撤回」能命中它）', async () => {
    const { commands } = setup()
    const { rankCommands } = await import('../src/composables/useCommands')
    const hit = rankCommands(commands.quickActions.value, '撤回')
    expect(hit.some(c => c.id === 'app.undoFileOp')).toBe(true)
  })

  it('A3 置灰时给得出一句话原因（不是让用户干瞪眼）', () => {
    const { commands } = setup()
    const cmd = findCmd(commands, 'app.undoFileOp')
    expect(typeof cmd.disabledHint).toBe('string')
    expect(cmd.disabledHint.length).toBeGreaterThan(0)
  })

  it('A4 空栈时 label 保持注册表原文案（不编造描述）', () => {
    const { commands } = setup()
    const cmd = findCmd(commands, 'app.undoFileOp')
    expect(cmd.label).toBe(SHORTCUT_MAP['app.undoFileOp'].label)
    expect(cmd.label).not.toContain('撤回：')
  })

  it('A5 其余命令不受影响：没有判定表的条目恒为可用', () => {
    const { commands } = setup()
    const alwaysOn = ['view.notes', 'app.newNote', 'view.readingMode', 'app.save', 'file:export']
    for (const id of alwaysOn) {
      const cmd = findCmd(commands, id)
      expect(cmd, `面板里缺 ${id}`).toBeTruthy()
      expect(cmd.disabled, `${id} 不该被置灰`).toBe(false)
      expect(cmd.disabledHint).toBe('')
    }
  })
})

describe('B. 有可撤回操作时：自动解禁（响应式）', () => {
  it('B1 入栈后同一个 computed 变回可用 —— 不是打开面板那一刻的快照', () => {
    const { commands } = setup()
    expect(findCmd(commands, 'app.undoFileOp').disabled).toBe(true)

    pushUndoEntry(entry('已删除「购物清单」'))

    // 关键：没有重新建 useCommands、没有手动刷新，还是那一个 computed
    const cmd = findCmd(commands, 'app.undoFileOp')
    expect(cmd.disabled).toBe(false)
    expect(cmd.disabledHint).toBe('')
  })

  it('B2 store 的 canUndoFileOperation 与条目的 disabled 必须同源（不许各判各的）', () => {
    const { noteStore, commands } = setup()
    expect(noteStore.canUndoFileOperation).toBe(false)
    expect(findCmd(commands, 'app.undoFileOp').disabled).toBe(true)

    pushUndoEntry(entry('移动 笔记A'))
    expect(noteStore.canUndoFileOperation).toBe(true)
    expect(findCmd(commands, 'app.undoFileOp').disabled).toBe(false)
  })

  it('B3 响应式是真的：watch(disabled) 会被入栈动作触发（不是重读碰巧算对）', async () => {
    const { commands } = setup()
    const seen = []
    stopWatch = watch(
      () => findCmd(commands, 'app.undoFileOp')?.disabled,
      (v) => seen.push(v),
      { flush: 'sync' }
    )
    expect(seen).toEqual([])

    pushUndoEntry(entry('新建 笔记B'))
    await nextTick()

    // flush:'sync' 下入栈那一刻就该回调；有这条才敢说 computed 真的依赖了撤回栈
    expect(seen).toEqual([false])
    expect(getUndoStack().length).toBe(1)
  })

  it('B4 反向也成立：撤回栈清空后条目重新置灰', async () => {
    const { commands } = setup()
    pushUndoEntry(entry('删除 文件夹C'))
    expect(findCmd(commands, 'app.undoFileOp').disabled).toBe(false)

    clearUndo()
    await nextTick()

    expect(findCmd(commands, 'app.undoFileOp').disabled).toBe(true)
  })
})

describe('C. 可用时 label 带上「将撤回什么」', () => {
  it('C1 label 里带栈顶描述', () => {
    const { commands } = setup()
    pushUndoEntry(entry('已删除「购物清单」'))
    const label = findCmd(commands, 'app.undoFileOp').label
    expect(label).toContain('撤回：')
    expect(label).toContain('已删除「购物清单」')
  })

  it('C2 超长描述被截断（面板是单行 ellipsis，不截断会把角标挤出去）', () => {
    const { commands } = setup()
    const long = '已删除「2026 年度 OKR 对齐会议纪要（第三版 · 最终 · 真的最终）」'
    pushUndoEntry(entry(long))
    const label = findCmd(commands, 'app.undoFileOp').label
    expect(label.startsWith('撤回：')).toBe(true)
    // 「撤回：」3 字 + 正文最多 18 字 + 省略号
    expect(label.length).toBeLessThanOrEqual(3 + 18 + 1)
    expect(label.endsWith('…')).toBe(true)
  })

  it('C3 换一条栈顶，label 跟着换（不缓存旧描述）', () => {
    const { commands } = setup()
    pushUndoEntry(entry('移动 甲'))
    expect(findCmd(commands, 'app.undoFileOp').label).toContain('移动 甲')

    clearUndo()
    pushUndoEntry(entry('重命名 乙'))
    expect(findCmd(commands, 'app.undoFileOp').label).toContain('重命名 乙')
    expect(findCmd(commands, 'app.undoFileOp').label).not.toContain('移动 甲')
  })

  it('C4 描述为空字符串时回落原 label（不许出现「撤回：」后面空着）', () => {
    const { commands } = setup()
    pushUndoEntry(entry(''))
    const cmd = findCmd(commands, 'app.undoFileOp')
    // 栈顶 label 被 pushUndoEntry 兜底成 '文件操作'，总之不能是光秃秃的「撤回：」
    expect(cmd.label).not.toBe('撤回：')
    expect(cmd.label.length).toBeGreaterThan(3)
  })
})

describe('D. 面板消费禁用项的三个纯函数', () => {
  const list = [
    { id: 'a', disabled: true },
    { id: 'b', disabled: false },
    { id: 'c', disabled: true },
    { id: 'd', disabled: false }
  ]

  it('D1 isCommandDisabled 只认严格 true', () => {
    expect(isCommandDisabled({ disabled: true })).toBe(true)
    expect(isCommandDisabled({ disabled: false })).toBe(false)
    expect(isCommandDisabled({})).toBe(false)
    expect(isCommandDisabled(null)).toBe(false)
    // 'true' / 1 这类脏值不许被当成禁用（判定函数返回非布尔时的防御）
    expect(isCommandDisabled({ disabled: 'true' })).toBe(false)
    expect(isCommandDisabled({ disabled: 1 })).toBe(false)
  })

  it('D2 firstSelectableIndex 落在第一条可用项；全禁用返回 -1', () => {
    expect(firstSelectableIndex(list)).toBe(1)
    expect(firstSelectableIndex([{ disabled: true }, { disabled: true }])).toBe(-1)
    expect(firstSelectableIndex([])).toBe(-1)
    expect(firstSelectableIndex(null)).toBe(-1)
  })

  it('D3 nextSelectableIndex 跳过禁用项', () => {
    // 从 0（禁用）向下 → 1；从 1 向下 → 3（跳过 2）；从 3 向下循环 → 1
    expect(nextSelectableIndex(list, 0, 1)).toBe(1)
    expect(nextSelectableIndex(list, 1, 1)).toBe(3)
    expect(nextSelectableIndex(list, 3, 1)).toBe(1)
    // 向上同理
    expect(nextSelectableIndex(list, 3, -1)).toBe(1)
    expect(nextSelectableIndex(list, 1, -1)).toBe(3)
  })

  it('D4 只有一条可用项时 ↑↓ 停在那条上（不是空转）', () => {
    const one = [{ disabled: true }, { disabled: false }, { disabled: true }]
    expect(nextSelectableIndex(one, 0, 1)).toBe(1)
    expect(nextSelectableIndex(one, 1, 1)).toBe(1)
    expect(nextSelectableIndex(one, 1, -1)).toBe(1)
  })

  it('D5 当前无高亮（-1）：↓ 到第一条、↑ 到最后一条', () => {
    expect(nextSelectableIndex(list, -1, 1)).toBe(1)
    expect(nextSelectableIndex(list, -1, -1)).toBe(3)
  })

  it('D6 整列都不可用时返回 -1（面板此时不高亮任何一条）', () => {
    const all = [{ disabled: true }, { disabled: true }]
    expect(nextSelectableIndex(all, 0, 1)).toBe(-1)
    expect(nextSelectableIndex(all, -1, 1)).toBe(-1)
  })

  it('D7 runCommand：禁用的不执行，走 onBlocked；可用的走 onRun', () => {
    const calls = []
    const blocked = { id: 'x', disabled: true, action: () => calls.push('RanX') }
    const ok = { id: 'y', disabled: false, action: () => calls.push('RanY') }

    expect(runCommand(blocked, { onRun: (c) => c.action(), onBlocked: (c) => calls.push('Blocked:' + c.id) })).toBe('blocked')
    expect(runCommand(ok, { onRun: (c) => c.action(), onBlocked: (c) => calls.push('Blocked:' + c.id) })).toBe('ran')
    expect(runCommand(null, {})).toBe('none')
    expect(runCommand({ id: 'z' }, {})).toBe('none') // 没有 action

    expect(calls).toEqual(['Blocked:x', 'RanY'])
  })

  it('D8 runCommand 不吞 onRun 里的异常（面板自己负责 try/catch 与日志）', () => {
    expect(() => runCommand(
      { id: 'boom', disabled: false, action: () => { throw new Error('E_BOOM') } },
      { onRun: (c) => c.action() }
    )).toThrow('E_BOOM')
  })
})
