/**
 * 命令面板数据源 useCommands 的测试（由 tmp/t12-check.mjs 提升而来）
 *
 * 覆盖范围：
 *   A. editor 命令的门控 —— 没注册 runner 就整组隐藏；注册后整组出现；hidden 命令永不进面板
 *   B. 覆盖完整性 —— 注册表里 scope='app' 的命令一条不漏地进面板；面板 id 无重复
 *   C. 角标真源 —— hotkey 必须是 formatBinding(normalizeBinding(getBinding(id)))；
 *                  非注册表命令（纯业务条目）不得显示角标
 *   D. 执行路径 —— 面板命令必须落到 createAppActions / appStore.runEditorCommand，
 *                  不在本文件另抄一份业务逻辑（历史漂移点）
 *   E. 与 T10 的交叉验证 —— 面板里的 view.readingMode / view.liveMode 与全局快捷键
 *                  走的是**同一组** store 方法（toggleReadingMode / toggleLiveMode），
 *                  避免「按钮记住 live、快捷键记住 edit」那类双份记忆错位
 *
 * 为什么用**真 Pinia store** 而不是替身：
 *   tmp/t12-check.mjs 用的是手搓 appStore 替身，只能断言「某个方法被调用了」；
 *   换成真 store 之后可以断言**真实结果**（editorMode 真的变成 preview、editorZoom 真的 +10），
 *   因此 store 方法一旦被改名/删除，这里会直接红，而不是像替身那样悄悄放行。
 *   这是比原脚本更严的一档，不是更松。
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCommands } from '../src/composables/useCommands'
import { useAppStore } from '../src/stores/app'
import {
  SHORTCUTS,
  SHORTCUT_MAP,
  createDefaultBindings,
  formatBinding,
  normalizeBinding
} from '../src/constants/shortcuts'

/** 面板里可见（非 hidden）的 editor 命令全集 */
const VISIBLE_EDITOR = SHORTCUTS.filter(s => s.scope === 'editor' && !s.hidden)
/** 注册表里 scope='app' 的命令 id 全集 */
const ALL_APP_IDS = SHORTCUTS.filter(s => s.scope === 'app').map(s => s.id)

/** router 替身：只记录调用，不需要真路由 */
function makeRouter () {
  const calls = []
  return {
    calls,
    push: p => calls.push(p),
    back: () => calls.push('back'),
    forward: () => calls.push('forward')
  }
}

/** noteStore 替身：只提供面板读取笔记列表所需的字段 */
function makeNoteStore (notes = []) {
  return { notes }
}

/** 建一套面板运行所需的最小上下文 */
function setupCommands ({ notes = [], withRunner = false } = {}) {
  const appStore = useAppStore()
  const router = makeRouter()
  const editorCalls = []
  const closePalette = vi.fn()
  if (withRunner) {
    appStore.setEditorRunner(id => { editorCalls.push(id) })
  }
  const commands = useCommands({
    appStore,
    noteStore: makeNoteStore(notes),
    router,
    closePalette
  })
  return { appStore, router, editorCalls, closePalette, commands }
}

/** 从面板列表里按 id 取条目 */
function findCmd (commands, id) {
  return commands.quickActions.value.find(c => c.id === id)
}

let warnSpy = null

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  // 执行器表缺命令时 useCommands 会 console.warn —— 把它接住，防止刷屏同时便于断言
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (warnSpy) warnSpy.mockRestore()
  warnSpy = null
})

describe('A. editor 命令门控（没 runner 就整组隐藏）', () => {
  it('未注册 runner 时，面板里一条 editor 命令都不出现', () => {
    const { commands } = setupCommands({ withRunner: false })
    const editorCmds = commands.quickActions.value.filter(
      c => SHORTCUT_MAP[c.id]?.scope === 'editor'
    )
    expect(editorCmds.map(c => c.id)).toEqual([])
  })

  it('注册 runner 后，全部可见 editor 命令整组出现', () => {
    const { commands } = setupCommands({ withRunner: true })
    const got = commands.quickActions.value.filter(
      c => SHORTCUT_MAP[c.id]?.scope === 'editor'
    )
    expect(got.length).toBe(VISIBLE_EDITOR.length)
    for (const s of VISIBLE_EDITOR) {
      expect(got.some(c => c.id === s.id)).toBe(true)
    }
  })

  it('runner 的注册/注销是响应式的：同一个 computed 会跟着变', () => {
    const { appStore, commands } = setupCommands({ withRunner: false })
    const before = commands.quickActions.value.filter(
      c => SHORTCUT_MAP[c.id]?.scope === 'editor'
    ).length
    expect(before).toBe(0)

    appStore.setEditorRunner(() => {})
    const after = commands.quickActions.value.filter(
      c => SHORTCUT_MAP[c.id]?.scope === 'editor'
    ).length
    expect(after).toBe(VISIBLE_EDITOR.length)

    appStore.setEditorRunner(null)
    const afterOff = commands.quickActions.value.filter(
      c => SHORTCUT_MAP[c.id]?.scope === 'editor'
    ).length
    expect(afterOff).toBe(0)
  })

  it('hidden 命令（edit.redoAlt / insert.date）永不进面板', () => {
    const { commands } = setupCommands({ withRunner: true })
    const ids = commands.quickActions.value.map(c => c.id)
    expect(ids).not.toContain('edit.redoAlt')
    expect(ids).not.toContain('insert.date')
  })
})

describe('B. 覆盖完整性', () => {
  it('注册表里每条 app 命令都能在面板里找到（一条都不能漏）', () => {
    const { commands } = setupCommands({ withRunner: true })
    const ids = commands.quickActions.value.map(c => c.id)
    const missing = ALL_APP_IDS.filter(id => !ids.includes(id))
    expect(missing).toEqual([])
  })

  it('本轮（T12）新增的 11 条 app 命令可见', () => {
    const { commands } = setupCommands({ withRunner: true })
    const ids = commands.quickActions.value.map(c => c.id)
    const required = [
      'app.navigateBack',
      'app.navigateForward',
      'app.shortcutCheatsheet',
      'view.toggleRightPanel',
      'view.readingMode',
      'view.liveMode',
      'view.notes',
      'view.tags',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomReset'
    ]
    expect(required.filter(id => !ids.includes(id))).toEqual([])
  })

  it('面板条目 id 无重复', () => {
    const { commands } = setupCommands({
      withRunner: true,
      notes: [{ id: 'n1', title: '甲', updatedAt: 2 }, { id: 'n2', title: '乙', updatedAt: 1 }]
    })
    const ids = commands.quickActions.value.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('最近笔记条目按 updatedAt 倒序进面板', () => {
    const { commands } = setupCommands({
      notes: [
        { id: 'old', title: '旧', updatedAt: 1 },
        { id: 'new', title: '新', updatedAt: 9 }
      ]
    })
    const ids = commands.quickActions.value.map(c => c.id)
    expect(ids.indexOf('note:goto:new')).toBeLessThan(ids.indexOf('note:goto:old'))
  })
})

describe('C. 角标真源 = 注册表绑定', () => {
  it('每条命令的角标都等于 formatBinding(normalizeBinding(getBinding(id)))', () => {
    const { appStore, commands } = setupCommands({ withRunner: true })
    const wrongs = []
    for (const cmd of commands.quickActions.value) {
      if (!SHORTCUT_MAP[cmd.id]) {
        // 非注册表命令（纯业务条目）不得带角标
        if (cmd.hotkey) wrongs.push(`${cmd.id} 非注册命令却有角标「${cmd.hotkey}」`)
        continue
      }
      const binding = appStore.getBinding(cmd.id)
      const expected = binding ? formatBinding(normalizeBinding(binding)) : ''
      if (cmd.hotkey !== expected) wrongs.push(`${cmd.id}: 「${cmd.hotkey}」≠「${expected}」`)
    }
    expect(wrongs).toEqual([])
  })

  it('注册表里"有绑定"的命令都带角标，没绑定的都不带', () => {
    const { appStore, commands } = setupCommands({ withRunner: true })
    const list = commands.quickActions.value
    const registryIds = new Set([
      ...ALL_APP_IDS,
      ...VISIBLE_EDITOR.map(s => s.id)
    ])
    const boundInRegistry = [...registryIds].filter(id => !!appStore.getBinding(id))
    const withKey = list.filter(c => registryIds.has(c.id) && c.hotkey).map(c => c.id)
    expect(withKey.slice().sort()).toEqual(boundInRegistry.slice().sort())
  })

  it('纯业务命令（导出）没有角标', () => {
    const { commands } = setupCommands({ withRunner: true })
    expect(findCmd(commands, 'file:export').hotkey).toBe('')
  })

  it('用户自定义键位后，角标跟着变（不是写死默认值）', () => {
    const { appStore, commands } = setupCommands({ withRunner: true })
    const before = findCmd(commands, 'view.readingMode').hotkey
    // 改成一个明显不同的组合键。
    // 注意：这里不能用 Mod-Alt-z —— 批次 6 的 app.undoFileOp 已把它占为默认键（同 app scope），
    // setHotkey 会判同 scope 冲突而拒绝写入，断言就会假红。Mod-Alt-m 在 app / editor 两侧都无人占用。
    appStore.setHotkey('view.readingMode', 'Mod-Alt-m')
    const after = findCmd(commands, 'view.readingMode').hotkey
    expect(after).not.toBe(before)
    expect(after).toBe(formatBinding(normalizeBinding('Mod-Alt-m')))
  })
})

describe('D. 执行路径（必须落到 createAppActions，不另抄一份）', () => {
  it('view.notes / view.tags 走 router.push', () => {
    const { router, commands } = setupCommands({})
    findCmd(commands, 'view.notes').action()
    findCmd(commands, 'view.tags').action()
    expect(router.calls).toContain('/notes')
    expect(router.calls).toContain('/tags')
  })

  it('app.navigateBack / Forward 走 router.back / forward', () => {
    const { router, commands } = setupCommands({})
    findCmd(commands, 'app.navigateBack').action()
    findCmd(commands, 'app.navigateForward').action()
    expect(router.calls).toContain('back')
    expect(router.calls).toContain('forward')
  })

  it('view.zoomIn / zoomOut / zoomReset 真的改变 editorZoom（步长 10）', () => {
    const { appStore, commands } = setupCommands({})
    appStore.resetEditorZoom()
    expect(appStore.editorZoom).toBe(100)

    findCmd(commands, 'view.zoomIn').action()
    expect(appStore.editorZoom).toBe(110)

    appStore.resetEditorZoom()
    findCmd(commands, 'view.zoomOut').action()
    expect(appStore.editorZoom).toBe(90)

    findCmd(commands, 'view.zoomReset').action()
    expect(appStore.editorZoom).toBe(100)
  })

  it('app.shortcutCheatsheet 走 store 的 toggleShortcutCheatsheet', () => {
    const { appStore, commands } = setupCommands({})
    expect(appStore.shortcutCheatsheetOpen).toBe(false)
    findCmd(commands, 'app.shortcutCheatsheet').action()
    expect(appStore.shortcutCheatsheetOpen).toBe(true)
  })

  it('editor 命令经 appStore.runEditorCommand 派发给 runner，且先关面板', () => {
    const { editorCalls, closePalette, commands } = setupCommands({ withRunner: true })
    findCmd(commands, 'format.bold').action()
    expect(editorCalls).toEqual(['format.bold'])
    expect(closePalette).toHaveBeenCalledTimes(1)
  })

  it('执行 app 命令后关闭面板', () => {
    const { appStore, closePalette, commands } = setupCommands({})
    findCmd(commands, 'view.readingMode').action()
    expect(appStore.editorMode).toBe('preview')
    expect(closePalette).toHaveBeenCalledTimes(1)
  })

  it('执行器表里没有的命令：只 warn + 关面板，不抛异常', () => {
    const { closePalette, commands } = setupCommands({})
    // 手写一个执行器表里不存在的 id 的 action 无法直接构造，改用
    // 「未提供 openQuickSwitcher 时回落到 runApp('app.quickSwitcher')」这条分支验证不抛错
    expect(() => findCmd(commands, 'view.toggleTheme').action()).not.toThrow()
    expect(closePalette).toHaveBeenCalled()
  })
})

describe('E. 与 T10 交叉：面板与全局快捷键共用同一组 store 方法', () => {
  it('面板的 view.readingMode 会真的把模式切到 preview，再切回上一个可编辑模式', () => {
    const { appStore, commands } = setupCommands({})
    expect(appStore.editorMode).toBe('edit')

    findCmd(commands, 'view.readingMode').action()
    expect(appStore.editorMode).toBe('preview')
    // 持久化键必须同步（真实浏览器里冒烟脚本读的就是这个键）
    expect(localStorage.getItem('choyeon-editor-mode')).toBe('preview')

    findCmd(commands, 'view.readingMode').action()
    expect(appStore.editorMode).toBe('edit')
    expect(localStorage.getItem('choyeon-editor-mode')).toBe('edit')
  })

  it('从 live 进阅读模式再回来，必须回到 live 而不是被降级成 edit', () => {
    const { appStore, commands } = setupCommands({})
    appStore.setEditorMode('live')
    expect(appStore.editorMode).toBe('live')

    findCmd(commands, 'view.readingMode').action()
    expect(appStore.editorMode).toBe('preview')

    findCmd(commands, 'view.readingMode').action()
    expect(appStore.editorMode).toBe('live')
  })

  it('面板的 view.liveMode 是双向的：live ↔ edit', () => {
    const { appStore, commands } = setupCommands({})
    expect(appStore.editorMode).toBe('edit')

    findCmd(commands, 'view.liveMode').action()
    expect(appStore.editorMode).toBe('live')

    findCmd(commands, 'view.liveMode').action()
    expect(appStore.editorMode).toBe('edit')
  })

  it('面板命令执行期间没有触发「执行器表缺命令」告警', () => {
    const { commands } = setupCommands({ withRunner: true })
    for (const id of ['view.readingMode', 'view.liveMode', 'view.zoomIn', 'app.shortcutCheatsheet']) {
      findCmd(commands, id).action()
    }
    const drift = (warnSpy?.mock?.calls || [])
      .map(c => String(c[0] ?? ''))
      .filter(t => t.includes('未在执行器表中注册'))
    expect(drift).toEqual([])
  })
})

describe('F. 默认绑定的自洽性', () => {
  it('createDefaultBindings 覆盖注册表全部命令', () => {
    const defaults = createDefaultBindings()
    for (const s of SHORTCUTS) {
      expect(Object.prototype.hasOwnProperty.call(defaults, s.id)).toBe(true)
    }
    expect(Object.keys(defaults).length).toBe(SHORTCUTS.length)
  })
})
