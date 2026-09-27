/**
 * 快捷键速查表组件测试（T08）
 *
 * 覆盖 4 组行为：
 *   A. 渲染契约 —— 开关由 store 驱动、hidden 命令不显示、未绑定显示「未设置」且不渲染胶囊
 *   B. 键位来源 —— 显示的是**用户改过之后的**键位，改过的行带「已自定义」小圆点
 *   C. 搜索匹配 —— 中文标签（「加粗」）与按键名（「ctrl」）都要命中
 *   D. 生命周期 —— Escape 关闭；onUnmounted 之后 window keydown 监听确实被摘掉
 *
 * 约定：
 * - 项目**没有**装 @vue/test-utils，也不允许为此引入新依赖，因此这里直接用
 *   `createApp(组件).mount()` + Teleport 到 body，再从 body 上读真实 DOM。
 *   Teleport 的目标就是 body，读 document.body 正好是面板真实所在位置。
 * - jsdom 下 navigator.platform / userAgent 为空且不含 mac → `isMac === false`，
 *   但断言一律由 `bindingParts` 推导期望值，不在测试里写死平台标签。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import ShortcutCheatsheet from '../src/components/ShortcutCheatsheet.vue'
import { useAppStore } from '../src/stores/app.js'
import { SHORTCUTS, bindingParts, normalizeBinding } from '../src/constants/shortcuts.js'

/** 面板挂载后的容器；Teleport 的内容挂在 body 下，不是这个 el 里 */
let host = null
let app = null
let router = null

function makeRouter () {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/settings', component: { template: '<div />' } }
    ]
  })
}

function mountCheatsheet () {
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  router = makeRouter()
  app = createApp(ShortcutCheatsheet)
  app.use(pinia)
  app.use(router)
  app.mount(host)
  setActivePinia(pinia)
  return useAppStore(pinia)
}

/** 把面板里真实渲染出来的行读成结构化的对象，避免断言被空白/顺序干扰 */
function readRows () {
  return Array.from(document.body.querySelectorAll('.sc-row')).map(el => {
    const labelEl = el.querySelector('.sc-row-label')
    const keysEl = el.querySelector('.sc-keys')
    return {
      label: (labelEl?.textContent || '').trim(),
      // 多个 <kbd> 之间在 DOM 里是紧邻的，textContent 会直接拼起来
      keys: (keysEl?.textContent || '').trim(),
      hasKeys: Boolean(keysEl),
      unset: Boolean(el.querySelector('.sc-unset')),
      customized: Boolean(el.querySelector('.sc-dot'))
    }
  })
}

function rowByLabel (label) {
  return readRows().find(r => r.label === label)
}

/** 模拟在搜索框里输入（v-model 靠 input 事件驱动） */
async function typeQuery (value) {
  const input = document.body.querySelector('.sc-input')
  expect(input).toBeTruthy()
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

function pressEscape () {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  // 卸载 + 清理 Teleport 残留，避免用例之间互相看到上一轮的面板
  app?.unmount()
  host?.remove()
  document.body.querySelectorAll('.sc-backdrop').forEach(el => el.remove())
  app = null
  host = null
  router = null
})

describe('ShortcutCheatsheet 渲染', () => {
  it('A1 开关完全由 store 驱动：未打开时不渲染，打开后渲染全部非 hidden 命令', async () => {
    const store = mountCheatsheet()
    await nextTick()
    expect(document.body.querySelector('.sc-panel')).toBeNull()

    store.openShortcutCheatsheet()
    await nextTick()

    const expected = SHORTCUTS.filter(s => !s.hidden)
    const rows = readRows()
    expect(rows.length).toBe(expected.length)
    // hidden 命令绝不出现（edit.redoAlt / insert.date 是注册表里仅有的两条 hidden）
    expect(rows.some(r => r.label === '重做（备选）')).toBe(false)
    expect(rows.some(r => r.label === '插入当前日期')).toBe(false)
  })

  it('A2 未绑定的命令显示「未设置」且不渲染按键胶囊', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()

    // insert.time 默认就是空绑定
    const row = rowByLabel('插入当前时间')
    expect(row).toBeTruthy()
    expect(row.unset).toBe(true)
    expect(row.hasKeys).toBe(false)
    expect(row.keys).toBe('')
  })

  it('A3 打开时焦点落在搜索框', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()
    // 组件的 watch 回调里还要再 await 一次 nextTick 才 focus（v-if 让输入框下一帧才存在），
    // 所以这里必须多等一帧，否则断言跑在 focus 之前。
    await nextTick()
    // jsdom 下 focus() 生效，activeElement 指向 input 本身
    expect(document.activeElement).toBe(document.body.querySelector('.sc-input'))
  })
})

describe('ShortcutCheatsheet 键位来源', () => {
  it('B1 显示的是用户改过之后的键位，并带「已自定义」标记', async () => {
    const store = mountCheatsheet()
    // Mod-Alt-b 在注册表里无人占用（同为 editor scope），写入不会被冲突拦截
    const result = store.setHotkey('format.bold', 'Mod-Alt-b')
    expect(result.ok).toBe(true)

    store.openShortcutCheatsheet()
    await nextTick()

    const bold = rowByLabel('加粗')
    expect(bold.keys).toBe(bindingParts('Mod-Alt-b').join(''))
    expect(bold.customized).toBe(true)
    expect(bold.unset).toBe(false)

    // 未改过的命令不打点
    const italic = rowByLabel('斜体')
    expect(italic.customized).toBe(false)
    expect(italic.keys).toBe(bindingParts('Mod-i').join(''))
  })
})

describe('ShortcutCheatsheet 搜索', () => {
  it('C1 搜中文标签「加粗」命中对应命令', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()

    await typeQuery('加粗')

    const rows = readRows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(r => r.label === '加粗')).toBe(true)
    // 不该把「加粗」以外的无关命令带进来（注册表里只有 format.bold 带这两个字）
    expect(rows.length).toBe(1)
  })

  it('C2 搜按键名「ctrl」命中所有带 Mod 的命令（含别名兜底）', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()

    await typeQuery('ctrl')

    const rows = readRows()
    // 期望集：非 hidden 且当前绑定含 Mod 的全部命令
    const expected = SHORTCUTS
      .filter(s => !s.hidden)
      .filter(s => normalizeBinding(store.getBinding(s.id)).startsWith('Mod-'))

    expect(rows.length).toBe(expected.length)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(r => r.label === '加粗')).toBe(true)
    // 纯 Alt 命令（上移当前行 = Alt-ArrowUp）不该被 ctrl 命中
    expect(rows.some(r => r.label === '上移当前行')).toBe(false)
  })

  it('C3 无命中时显示空态', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()

    await typeQuery('zzz-不存在的命令')
    expect(readRows().length).toBe(0)
    expect(document.body.querySelector('.sc-empty')).toBeTruthy()
  })
})

describe('ShortcutCheatsheet 生命周期', () => {
  it('D1 Escape 关闭面板', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()
    expect(store.shortcutCheatsheetOpen).toBe(true)

    pressEscape()
    await nextTick()
    expect(store.shortcutCheatsheetOpen).toBe(false)
  })

  it('D2 onUnmounted 后 window keydown 监听已摘除（不会残留吞键）', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()
    pressEscape()
    await nextTick()

    app.unmount()
    await nextTick()

    // 卸载后再打开 store：如果监听没摘，Escape 会被已销毁的处理器吃掉（这里表现为被关闭）
    store.openShortcutCheatsheet()
    pressEscape()
    await nextTick()
    expect(store.shortcutCheatsheetOpen).toBe(true)
  })

  it('D3 底部「打开快捷键设置」跳 /settings 并关闭面板', async () => {
    const store = mountCheatsheet()
    store.openShortcutCheatsheet()
    await nextTick()

    const btn = document.body.querySelector('.sc-settings-btn')
    expect(btn).toBeTruthy()
    btn.click()
    await nextTick()
    await router.isReady()

    expect(store.shortcutCheatsheetOpen).toBe(false)
    expect(router.currentRoute.value.path).toBe('/settings')
  })
})
