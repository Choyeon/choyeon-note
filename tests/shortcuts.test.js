/**
 * 快捷键体系单测（T06）
 *
 * 覆盖 6 组能力：
 *   A. 覆盖校验基线 —— 用**真实派生**的执行器 id 集合跑 auditShortcuts，断言四类问题全为 0
 *   B. 故障注入 —— 对合成输入注入四类问题，证明校验真的抓得住（不是永远返回 ok 的橡皮图章）
 *   C. normalizeBinding —— 边界表 + 幂等性 + `Shift-Mod-d` 与 `Mod-Shift-d` 同归一（撞键漏判根因）
 *   D. eventToBinding —— code 反查（Shift+数字键回归）/ IME / repeat / 单独修饰键 / 无 code 回落
 *   E. bindingParts / formatBinding —— `Mod-Alt--` 丢 Alt 的显示缺陷回归
 *   F. appStore 冲突检测与 setHotkey 三态 —— warn 放行 / hard 拒绝 / override 覆盖
 *
 * 约定：
 * - 全部用合成事件对象，**不依赖真实键盘、真实 DOM 焦点**，可稳定重跑。
 * - jsdom 下 navigator.platform 为空、userAgent 不含 mac → `isMac === false`，
 *   展示类断言一律用 isMac 推导期望值，不在测试里写死平台。
 * - 每个 store 用例前重建 Pinia + 清空 localStorage，避免用例间互相污染。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  SHORTCUTS,
  SHORTCUT_MAP,
  normalizeBinding,
  eventToBinding,
  bindingParts,
  formatBinding,
  reservedLevel,
  isMac
} from '../src/constants/shortcuts.js'
import { auditShortcuts, formatAuditReport } from '../src/utils/shortcutAudit.js'
import { APP_ACTION_IDS } from '../src/composables/useAppActions.js'
// EDITOR_COMMAND_IDS 定义在 src/composables/useEditor.js（由 `Object.keys(EDITOR_COMMANDS)` 派生，
// 不在 markdownCommands.js）。选择**直接 import** 该文件的原因：
// 实测 vitest/jsdom 下 import 成功、耗时约 2ms、无副作用报错（CodeMirror 依赖链在 jsdom 下
// 只是被加载、不创建 EditorView），因此没有理由退回近似方案。若改成从 markdownCommands.js
// 反推或手写一份 id 清单，就等于再造一份「可能与 EDITOR_COMMANDS 漂移」的清单，
// 而 auditShortcuts 存在的全部意义正是消灭这种漂移 —— 宁可多加载 CodeMirror 也不能假绿。
import { EDITOR_COMMAND_IDS } from '../src/composables/useEditor.js'
import { useAppStore } from '../src/stores/app.js'
import { LS_KEYS } from '../src/constants/storage.js'

/** 展示层期望值随平台变化，统一在这里推导，避免测试写死 Win 标签 */
const LABEL_CTRL = isMac ? '⌘' : 'Ctrl'
const LABEL_SHIFT = isMac ? '⇧' : 'Shift'
const LABEL_ALT = isMac ? '⌥' : 'Alt'

/**
 * 合成键盘事件。
 * 刻意**不用** `new KeyboardEvent()`：jsdom 会把未显式传入的 `code` 置为空串，
 * 而且 `isComposing` / `keyCode` 这类字段在构造参数里支持得不一致。
 * 这里手写普通对象，字段与 KeyboardEvent 同名，eventToBinding 只读这些字段。
 */
function keyEvent (props = {}) {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    ...props
  }
}

// -----------------------------------------------------------------------------
// A. 覆盖校验基线（真实派生集合）
// -----------------------------------------------------------------------------

describe('A. 注册表 ↔ 执行器 覆盖校验（真实派生集合）', () => {
  // 条数随注册表/执行器同步增长：新增一条命令必须同时动这两处数字，
  // 只加注册表不加执行器会被 audit 判 dead（或反之判 orphan），这里不会替你兜住。
  it('执行器 id 集合由对象派生，条数与设计一致（app 23 / editor 37）', () => {
    expect(APP_ACTION_IDS.length).toBe(23)
    expect(EDITOR_COMMAND_IDS.length).toBe(37)
    expect(SHORTCUTS.length).toBe(60)
  })

  it('用真实集合跑 auditShortcuts：四类问题全为 0', () => {
    const result = auditShortcuts({
      appActionIds: APP_ACTION_IDS,
      editorCommandIds: EDITOR_COMMAND_IDS
    })
    // 失败时把可读报告一起打出来，避免只看到 "expected [] to have length 0"
    expect(formatAuditReport(result)).toBe('')
    expect(result.ok).toBe(true)
    expect(result.dead).toEqual([])
    expect(result.orphan).toEqual([])
    expect(result.duplicateDefault).toEqual([])
    expect(result.invalidSyntax).toEqual([])
    expect(result.counts).toEqual({ dead: 0, orphan: 0, duplicateDefault: 0, invalidSyntax: 0 })
  })

  it('两张执行器表没有重叠 id（同一命令不会既走 app 又走 editor）', () => {
    const result = auditShortcuts({
      appActionIds: APP_ACTION_IDS,
      editorCommandIds: EDITOR_COMMAND_IDS
    })
    expect(result.executorOverlap).toEqual([])
  })

  it('每条非 hidden 命令都能在自己的 scope 里找到执行器（dead 判定的正向版）', () => {
    const appSet = new Set(APP_ACTION_IDS)
    const editorSet = new Set(EDITOR_COMMAND_IDS)
    for (const s of SHORTCUTS) {
      if (s.hidden) continue
      const pool = s.scope === 'app' ? appSet : editorSet
      expect(pool.has(s.id), `${s.id} 在 ${s.scope} 执行器里查无此 id`).toBe(true)
    }
  })

  it('注册表里每条 default 都已经是 normalizeBinding 的规范形式', () => {
    for (const s of SHORTCUTS) {
      if (!s.default) continue
      expect(normalizeBinding(s.default), `${s.id} 的 default 不是规范书写`).toBe(s.default)
    }
  })

  /**
   * auditShortcuts 的已知盲区兜底：它的 duplicateDefault **只比同 scope**，
   * 于是「app 抢了 editor 的键」这类跨 scope 撞键它会判 0 问题（套件照样全绿）。
   * 但本应用里这是真事故：App.vue 在 window 的**捕获阶段**监听 keydown，
   * 命中 app 命令后 preventDefault + stopPropagation，editor 那条命令就永远收不到这个键
   * —— 典型就是 Mod-Shift-z（editor 的 edit.redoAlt）被 app 抢走后编辑器重做失灵。
   * 所以这一条不靠 audit，在这里独立兜住：任何 app 默认键都不许与 editor 默认键相同。
   */
  it('跨 scope 撞键兜底：app 的默认键不得与 editor 的默认键相同（audit 查不出这一条）', () => {
    const appBindings = new Map()
    const editorBindings = new Map()
    for (const s of SHORTCUTS) {
      // hidden 命令同样占键（edit.redoAlt / insert.date 历史上就撞过别人），必须一起算
      const binding = normalizeBinding(s.default)
      if (!binding) continue
      const bucket = s.scope === 'app' ? appBindings : editorBindings
      if (!bucket.has(binding)) bucket.set(binding, [])
      bucket.get(binding).push(s.id)
    }
    const collisions = []
    for (const [binding, appIds] of appBindings) {
      const editorIds = editorBindings.get(binding)
      if (editorIds) collisions.push(`${binding}: app=${appIds.join('/')} editor=${editorIds.join('/')}`)
    }
    expect(collisions, `发现跨 scope 撞键（app 会抢掉 editor 的键）：${collisions.join('；')}`).toEqual([])
    // 显式钉住这条历史教训：Mod-Shift-z 归 editor 的 edit.redoAlt，app 侧不得再占用
    expect(SHORTCUT_MAP['edit.redoAlt'].default).toBe('Mod-Shift-z')
    expect(appBindings.has('Mod-Shift-z'), 'Mod-Shift-z 被 app 命令占用会让编辑器重做失灵').toBe(false)
  })
})

// -----------------------------------------------------------------------------
// B. 故障注入（证明校验真的能抓到问题）
// -----------------------------------------------------------------------------

describe('B. 故障注入：四类问题必须被检出', () => {
  /** 一份干净的合成注册表 + 对应的执行器集合，作为注入基线 */
  const clean = () => ({
    shortcuts: [
      { id: 'app.alpha', scope: 'app', category: 'file', label: '甲', default: 'Mod-Alt-a' },
      { id: 'app.beta', scope: 'app', category: 'file', label: '乙', default: 'Mod-Alt-b' },
      { id: 'ed.gamma', scope: 'editor', category: 'edit', label: '丙', default: 'Mod-Alt-c' }
    ],
    appActionIds: ['app.alpha', 'app.beta'],
    editorCommandIds: ['ed.gamma']
  })

  it('基线本身是干净的（否则后面的注入断言没有意义）', () => {
    const c = clean()
    const r = auditShortcuts(c)
    expect(r.ok).toBe(true)
    expect(r.counts).toEqual({ dead: 0, orphan: 0, duplicateDefault: 0, invalidSyntax: 0 })
  })

  it('注册表有、执行器无 → dead 命中', () => {
    const c = clean()
    // 模拟「有人从 createAppActions 里删掉了 app.beta」
    const r = auditShortcuts({ ...c, appActionIds: ['app.alpha'] })
    expect(r.dead).toEqual(['app.beta'])
    expect(r.counts.dead).toBe(1)
    expect(r.ok).toBe(false)
  })

  it('hidden 命令缺执行器不算 dead（它们本来就不暴露给用户）', () => {
    const c = clean()
    c.shortcuts.push({ id: 'ed.hidden', scope: 'editor', category: 'edit', label: '隐', default: 'Mod-Alt-h', hidden: true })
    const r = auditShortcuts(c)
    expect(r.dead).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('执行器有、注册表无 → orphan 命中', () => {
    const c = clean()
    // 模拟「EDITOR_COMMANDS 里加了一条命令但忘了登记注册表」
    const r = auditShortcuts({ ...c, editorCommandIds: ['ed.gamma', 'ed.ghost'] })
    expect(r.orphan).toEqual(['ed.ghost'])
    expect(r.counts.orphan).toBe(1)
    expect(r.ok).toBe(false)
  })

  it('同 scope 两条命令 default 相同 → duplicateDefault 命中', () => {
    const c = clean()
    c.shortcuts[1].default = 'Mod-Alt-a' // app.beta 与 app.alpha 撞键
    const r = auditShortcuts(c)
    expect(r.duplicateDefault).toEqual([{ scope: 'app', binding: 'Mod-Alt-a', ids: ['app.alpha', 'app.beta'] }])
    expect(r.counts.duplicateDefault).toBe(1)
    expect(r.ok).toBe(false)
  })

  it('跨 scope 同名 default 不算冲突（app 与 editor 各用各的）', () => {
    const c = clean()
    c.shortcuts[2].default = 'Mod-Alt-a' // editor 命令用和 app.alpha 一样的键
    const r = auditShortcuts(c)
    expect(r.duplicateDefault).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('default 主键为空 → invalidSyntax / empty-key 命中', () => {
    const c = clean()
    c.shortcuts.push({ id: 'app.delta', scope: 'app', category: 'file', label: '丁', default: 'Mod-' })
    c.appActionIds.push('app.delta')
    const r = auditShortcuts(c)
    const hit = r.invalidSyntax.filter(x => x.reason === 'empty-key')
    expect(hit.map(x => x.id)).toEqual(['app.delta'])
    expect(r.ok).toBe(false)
  })

  it('default 非规范顺序（Shift-Mod-d）→ invalidSyntax / not-normalized 命中', () => {
    const c = clean()
    c.shortcuts[1].default = 'Shift-Mod-d'
    const r = auditShortcuts(c)
    const hit = r.invalidSyntax.filter(x => x.reason === 'not-normalized')
    expect(hit.map(x => x.id)).toEqual(['app.beta'])
    expect(hit[0].default).toBe('Shift-Mod-d')
    expect(r.ok).toBe(false)
  })

  it('scope 非法 → invalidSyntax / unknown-scope 命中；id 重复 → duplicate-id 命中', () => {
    const c = clean()
    c.shortcuts.push({ id: 'app.omega', scope: 'global', category: 'file', label: '戊', default: 'Mod-Alt-o' })
    c.shortcuts.push({ id: 'app.alpha', scope: 'app', category: 'file', label: '甲（重复）', default: 'Mod-Alt-z' })
    const r = auditShortcuts(c)
    const reasons = r.invalidSyntax.map(x => `${x.id}:${x.reason}`)
    expect(reasons).toContain('app.omega:unknown-scope')
    expect(reasons).toContain('app.alpha:duplicate-id')
  })
})

// -----------------------------------------------------------------------------
// C. normalizeBinding
// -----------------------------------------------------------------------------

describe('C. normalizeBinding 行为', () => {
  const cases = [
    // [输入, 期望输出, 说明]
    ['', '', '空串'],
    ['   ', '', '纯空白'],
    ['Mod-Alt--', 'Mod-Alt--', '主键就是 -（insert.divider）'],
    ['Mod--', 'Mod--', '主键就是 -（view.zoomOut）'],
    ['Mod-=', 'Mod-=', '主键 =（view.zoomIn）'],
    ['Shift-/', 'Shift-/', '主键 /'],
    ['Shift-Mod-d', 'Mod-Shift-d', '修饰键重排'],
    ['MOD-SHIFT-D', 'Mod-Shift-d', '大小写'],
    ['Mod-Shift-Z', 'Mod-Shift-z', '单字符主键小写'],
    ['Mod-Mod-a', 'Mod-a', '重复修饰符去重'],
    ['Mod-', '', '缺主键'],
    ['Mod-Alt-', '', '缺主键'],
    ['Tab', 'Tab', '纯主键'],
    ['Shift-Tab', 'Shift-Tab', '修饰键 + 主键'],
    ['Mod-Shift-8', 'Mod-Shift-8', 'format.bulletList 默认键'],
    ['mod-shift-ARROWLEFT', 'Mod-Shift-ArrowLeft', '多字符主键查 KEY_CANON'],
    ['Mod-+', 'Mod-+', '主键 +（含 - 时不按 + 切）'],
    ['Ctrl+Alt+X', 'Ctrl-Alt-x', '无 - 时才按 + 切'],
    ['Mod-s', 'Mod-s', '最常见的保存键'],
    ['Mod-\\', 'Mod-\\', '主键反斜杠（view.toggleSidebar）']
  ]

  it.each(cases)('normalizeBinding(%j) === %j（%s）', (input, expected) => {
    expect(normalizeBinding(input)).toBe(expected)
  })

  it('非字符串输入一律返回空串（localStorage 脏值不该炸）', () => {
    expect(normalizeBinding(null)).toBe('')
    expect(normalizeBinding(undefined)).toBe('')
    expect(normalizeBinding(0)).toBe('')
    expect(normalizeBinding({})).toBe('')
    expect(normalizeBinding(['Mod-a'])).toBe('')
  })

  it('幂等性：二次归一化结果不变（否则录制→比较→重录会漂移）', () => {
    for (const [input] of cases) {
      const once = normalizeBinding(input)
      expect(normalizeBinding(once), `『${input}』二次归一化漂移了`).toBe(once)
    }
  })

  it('撞键漏判根因：Shift-Mod-d 与 Mod-Shift-d 归一后必须全等', () => {
    // 历史教训：edit.duplicateLine 写 Mod-Shift-d、insert.date 写 Shift-Mod-d，
    // 旧版冲突检测做裸字符串比较 → 实际撞键却查不出来。
    expect(normalizeBinding('Shift-Mod-d')).toBe(normalizeBinding('Mod-Shift-d'))
    expect(normalizeBinding('Shift-Mod-d')).toBe('Mod-Shift-d')
  })
})

// -----------------------------------------------------------------------------
// D. eventToBinding
// -----------------------------------------------------------------------------

describe('D. eventToBinding 行为', () => {
  it('Ctrl+Shift+8（code=Digit8, key="*"）→ Mod-Shift-8，且与 format.bulletList 的 default 全等', () => {
    // 这条是本轮核心回归：旧版直接吃 event.key，录出来是 Mod-Shift-*，
    // 与注册表里的 Mod-Shift-8 永远对不上 → 「录制 Shift+数字键永远录不回默认」。
    const binding = eventToBinding(keyEvent({ key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true }))
    expect(binding).toBe('Mod-Shift-8')
    expect(binding).toBe(SHORTCUT_MAP['format.bulletList'].default)
  })

  it('Shift+数字键家族逐个验证（7/8/9 分别对应有序/无序/待办列表）', () => {
    expect(eventToBinding(keyEvent({ key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true })))
      .toBe(SHORTCUT_MAP['format.orderedList'].default)
    expect(eventToBinding(keyEvent({ key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true })))
      .toBe(SHORTCUT_MAP['format.taskList'].default)
  })

  it('Shift+符号键走 code 反查：< → Shift-, 、_ → Shift--', () => {
    expect(eventToBinding(keyEvent({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true }))).toBe('Mod-Shift-,')
    expect(eventToBinding(keyEvent({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }))).toBe('Mod-Shift--')
    expect(eventToBinding(keyEvent({ key: '+', code: 'Equal', ctrlKey: true }))).toBe('Mod-=')
  })

  it('IME 组字中（isComposing / keyCode 229）→ null', () => {
    expect(eventToBinding(keyEvent({ key: 'a', code: 'KeyA', ctrlKey: true, isComposing: true }))).toBeNull()
    expect(eventToBinding(keyEvent({ key: 'a', code: 'KeyA', ctrlKey: true, keyCode: 229 }))).toBeNull()
  })

  it('长按 repeat → null（速查表 Mod-/ 这种易长按的键不该重复触发）', () => {
    expect(eventToBinding(keyEvent({ key: '/', code: 'Slash', ctrlKey: true, repeat: true }))).toBeNull()
  })

  it('单独按修饰键 → null', () => {
    for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'OS']) {
      expect(eventToBinding(keyEvent({ key })), `单独按 ${key} 不该产出绑定`).toBeNull()
    }
  })

  it('死键 Dead → null；无 key / 无事件 → null', () => {
    expect(eventToBinding(keyEvent({ key: 'Dead', code: 'KeyA' }))).toBeNull()
    expect(eventToBinding(keyEvent({ key: '' }))).toBeNull()
    expect(eventToBinding(null)).toBeNull()
    expect(eventToBinding(undefined)).toBeNull()
  })

  it('无 code 时回落 event.key（jsdom 合成事件 / 私有 code 的兜底）', () => {
    expect(eventToBinding(keyEvent({ key: 'A', ctrlKey: true }))).toBe('Mod-a')
    expect(eventToBinding(keyEvent({ key: 'ArrowLeft', altKey: true }))).toBe('Alt-ArrowLeft')
    expect(eventToBinding(keyEvent({ key: ' ' }))).toBe('Space')
    // code 不在 CODE_TO_KEY 表里 → 同样回落 key
    expect(eventToBinding(keyEvent({ key: 'F13', code: 'F13' }))).toBe('F13')
  })

  it('metaKey 也算 Mod（macOS 上 Cmd 走 metaKey）', () => {
    expect(eventToBinding(keyEvent({ key: 's', code: 'KeyS', metaKey: true }))).toBe('Mod-s')
  })

  it('产出的串天然是规范序（Mod-Shift-Alt-主键），可直接与注册表比较', () => {
    const binding = eventToBinding(keyEvent({ key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true, altKey: true }))
    expect(binding).toBe('Mod-Shift-Alt-d')
    expect(normalizeBinding(binding)).toBe(binding)
  })
})

// -----------------------------------------------------------------------------
// E. bindingParts / formatBinding（T06 修复点）
// -----------------------------------------------------------------------------

describe('E. bindingParts / formatBinding', () => {
  it('修复回归：Mod-Alt-- 必须保留 Alt，返回 [Ctrl, Alt, -]', () => {
    // 修复前：raw.replace(/--$/,'').split('-').slice(0,-1) → ['Mod']，Alt 被吞，界面显示成「Ctrl -」
    const parts = bindingParts('Mod-Alt--')
    expect(parts.length).toBe(3)
    expect(parts[2]).toBe('-')
    expect(parts).toEqual([LABEL_CTRL, LABEL_ALT, '-'])
  })

  it('Mod-- 同样保留主键 -（view.zoomOut 缩小正文）', () => {
    expect(bindingParts('Mod--')).toEqual([LABEL_CTRL, '-'])
  })

  it('常见绑定串拆分不受本次修复影响', () => {
    expect(bindingParts('Mod-Shift-8')).toEqual([LABEL_CTRL, LABEL_SHIFT, '8'])
    expect(bindingParts('Mod-Alt-ArrowLeft')).toEqual([LABEL_CTRL, LABEL_ALT, '←'])
    expect(bindingParts('Mod-Alt-ArrowRight')).toEqual([LABEL_CTRL, LABEL_ALT, '→'])
    expect(bindingParts('Escape')).toEqual(['Escape'])
    expect(bindingParts('Mod-s')).toEqual([LABEL_CTRL, 'S'])
    expect(bindingParts('Mod-Enter')).toEqual([LABEL_CTRL, isMac ? '↩' : 'Enter'])
    expect(bindingParts('Mod-Space')).toEqual([LABEL_CTRL, '空格'])
  })

  it('空绑定与非法绑定返回空数组', () => {
    expect(bindingParts('')).toEqual([])
    expect(bindingParts(null)).toEqual([])
    expect(bindingParts('Mod-')).toEqual([]) // 只有修饰键、没有主键
  })

  it('formatBinding 跟着修好：insert.divider 的展示含全部三个键', () => {
    const text = formatBinding('Mod-Alt--')
    expect(text).toBe([LABEL_CTRL, LABEL_ALT, '-'].join(isMac ? '' : '+'))
    expect(text.includes('Alt')).toBe(true)
    expect(formatBinding('')).toBe('未设置')
  })
})

// -----------------------------------------------------------------------------
// F. 保留键分级
// -----------------------------------------------------------------------------

describe('F. reservedLevel 保留键分级', () => {
  it('hard 级：系统 / 浏览器不可拦截', () => {
    expect(reservedLevel('Mod-w', { isElectron: true })).toBe('hard')
    expect(reservedLevel('Mod-q', { isElectron: true })).toBe('hard')
    expect(reservedLevel('F11', { isElectron: true })).toBe('hard')
    // 非规范写法也要先归一再查表（这里正是 T01 的价值）
    expect(reservedLevel('Shift-Mod-w', { isElectron: true })).toBe('hard')
  })

  it('browserOnly 级：Mod-n 在 Electron 下放行、在浏览器里升级为 hard', () => {
    // Mod-n 是 app.newNote 的默认键 —— 一刀切硬拒绝会把它自己判死
    expect(reservedLevel('Mod-n', { isElectron: true })).toBe(null)
    expect(reservedLevel('Mod-n', { isElectron: false })).toBe('hard')
  })

  it('warn 级：允许绑定但给提示', () => {
    expect(reservedLevel('Tab', { isElectron: true })).toBe('warn')
    expect(reservedLevel('Mod-z', { isElectron: true })).toBe('warn')
  })

  it('普通组合键与空串都不是保留键', () => {
    expect(reservedLevel('Mod-Alt-z', { isElectron: true })).toBe(null)
    expect(reservedLevel('', { isElectron: true })).toBe(null)
  })
})

// -----------------------------------------------------------------------------
// G. appStore 冲突检测与 setHotkey 三态
// -----------------------------------------------------------------------------

describe('G. appStore 冲突检测与 setHotkey 三态', () => {
  let store

  beforeEach(() => {
    localStorage.clear()
    // 每个用例一份全新 Pinia：hotkeys 会从 createDefaultBindings() 重新初始化
    setActivePinia(createPinia())
    store = useAppStore()
  })

  it('给 app 命令绑 Tab → warn 级，允许写入', () => {
    const conflict = store.findConflict('view.notes', 'Tab', undefined, { isElectron: true })
    expect(conflict).not.toBeNull()
    expect(conflict.severity).toBe('warn')

    const result = store.setHotkey('view.notes', 'Tab', { isElectron: true })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('ok')
    expect(result.warnings.length).toBe(1)
    expect(store.getBinding('view.notes')).toBe('Tab')
  })

  it('给任意命令绑 Mod-w → hard 级，拒绝写入且原绑定不变', () => {
    const result = store.setHotkey('view.notes', 'Mod-w', { isElectron: true })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('reserved')
    expect(result.canOverride).toBe(false)
    // view.notes 默认不绑键，写入被拒后仍然是空串
    expect(store.getBinding('view.notes')).toBe('')
  })

  it('同 scope 实占 → 默认拒绝；override: true 后成功且占用者被清空', () => {
    // 两条默认都不绑键的 app 命令，先让 app 侧 view.notes 占住一个键
    expect(store.setHotkey('view.notes', 'Mod-Alt-9', { isElectron: true }).ok).toBe(true)

    const blocked = store.setHotkey('view.tags', 'Mod-Alt-9', { isElectron: true })
    expect(blocked.ok).toBe(false)
    expect(blocked.status).toBe('conflict')
    expect(blocked.canOverride).toBe(true)
    expect(blocked.conflict.id).toBe('view.notes')
    expect(store.getBinding('view.tags')).toBe('') // 没写进去

    const forced = store.setHotkey('view.tags', 'Mod-Alt-9', { override: true, isElectron: true })
    expect(forced.ok).toBe(true)
    expect(forced.status).toBe('ok')
    expect(forced.overridden).toEqual(['view.notes'])
    expect(store.getBinding('view.tags')).toBe('Mod-Alt-9')
    expect(store.getBinding('view.notes')).toBe('') // 占用者被清空
  })

  it('持久化存的是录制原文，比较时才归一化', () => {
    // 'Shift-Mod-d' 是老用户 localStorage 里的典型旧写法：必须与 edit.duplicateLine 的默认键
    // 判成同一个键（跨 scope → warn 放行），但落盘的必须是原文，不能回写规范化结果
    const result = store.setHotkey('view.notes', 'Shift-Mod-d', { isElectron: true })
    expect(result.ok).toBe(true)
    expect(result.warnings[0].id).toBe('edit.duplicateLine') // 归一化后确实比较出了撞键

    expect(store.getBinding('view.notes')).toBe('Shift-Mod-d')
    const persisted = JSON.parse(localStorage.getItem(LS_KEYS.hotkeys))
    expect(persisted['view.notes']).toBe('Shift-Mod-d')
    expect(normalizeBinding(store.getBinding('view.notes'))).toBe(SHORTCUT_MAP['edit.duplicateLine'].default)
  })

  it('不存在的命令 / 不完整组合 → unknown / invalid，一律不落盘', () => {
    expect(store.setHotkey('view.nope', 'Mod-Alt-9').status).toBe('unknown')
    expect(store.setHotkey('view.notes', 'Mod-').status).toBe('invalid')
    expect(store.getBinding('view.notes')).toBe('')
    expect(localStorage.getItem(LS_KEYS.hotkeys)).toBeNull()
  })
})
