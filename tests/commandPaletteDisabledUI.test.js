/**
 * 命令面板「条目级可用性（when）」机制 —— 真 DOM 交互单测
 *
 * 与 commandPaletteDisabled.test.js 的分工：那边证**数据源**（disabled 怎么算出来、
 * 会不会响应式更新），这边证**面板真的按契约消费它**：
 *   1. 空撤回栈时，「撤回」条目在 DOM 里是置灰的（有 .cp-item-disabled），不是被过滤掉；
 *   2. 点置灰条目：不执行、不关面板、给一句提示（不许"点了没反应"）；
 *   3. 撤回栈一有内容，同一次打开里置灰态真的解除，label 带上具体描述；
 *   4. ↑↓ 导航跳过禁用项：只剩一条禁用项匹配时，↓ 与 ⏎ 都不会执行任何命令；
 *   5. 过滤逻辑改动不能把「无匹配结果」空状态弄坏。
 *
 * 为什么真挂载（createApp + jsdom）而不是断言源码字符串：
 *   置灰是 class、点击是事件、导航是 keydown —— 这些只有真 DOM 才证得到。
 *   项目没有 @vue/test-utils，这里跟 tests/graphLayout.test.js 同一口径：
 *   `createApp(组件).use(pinia).use(router).mount(host)`。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import CommandPalette from '../src/components/CommandPalette.vue'
import { useAppStore } from '../src/stores/app'
import { useNoteStore } from '../src/stores/note'
import { pushUndoEntry, clearUndo } from '../src/composables/useFileUndo'

/** 造一条能入栈的撤回记录 */
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

let app = null
let host = null

/**
 * 真挂载命令面板并打开它。
 * @returns {Promise<{appStore: object, noteStore: object}>}
 */
async function mountPalette () {
  const pinia = createPinia()
  setActivePinia(pinia)
  // 路由表只求「命令执行时 push 得到落点」：缺了 /notes 会刷一条 router warn，
  // 那是测试脚手架的噪音，不是被测行为的失败
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/notes', component: { template: '<div />' } },
      { path: '/tags', component: { template: '<div />' } }
    ]
  })
  const appStore = useAppStore()
  const noteStore = useNoteStore()

  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(CommandPalette)
  app.use(pinia)
  app.use(router)
  app.mount(host)

  appStore.openCommandPalette()
  await nextTick()
  await nextTick()
  return { appStore, noteStore }
}

/**
 * 卸载并**清干净残节点**。
 *
 * 面板根节点是 `<Teleport to="body">` + `<Transition>`：Vue 的离场是
 * 「等 transitionend / 超时」再摘节点，在 jsdom 里这一步是异步的，
 * 不清掉的话下一个用例的 `document.querySelectorAll('.cp-item')` 会命中
 * 上一轮面板的残骸（表现为条目数翻倍、出现多个高亮项）。
 */
async function unmountPalette () {
  if (app) {
    app.unmount()
    app = null
  }
  if (host && host.parentNode) host.parentNode.removeChild(host)
  host = null
  await new Promise(resolve => setTimeout(resolve, 0))
  for (const sel of ['.command-palette-backdrop', '.command-palette-panel']) {
    document.querySelectorAll(sel).forEach(el => el.remove())
  }
}

/** 在搜索框里输入（走 v-model，触发 watch 与重排） */
async function typeQuery (text) {
  const input = document.querySelector('.cp-input')
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await nextTick()
}

/** 按 id 找 DOM 里的条目按钮（id 不在 DOM 上，按文案找） */
function itemByText (keyword) {
  const items = Array.from(document.querySelectorAll('.cp-item'))
  return items.find(el => (el.textContent || '').includes(keyword)) || null
}

/** 最后一次 toast */
function lastToast (appStore) {
  const list = appStore.toasts || []
  return list.length ? { type: list[list.length - 1].type, message: list[list.length - 1].message } : null
}

beforeEach(() => {
  localStorage.clear()
  clearUndo()
})

afterEach(async () => {
  await unmountPalette()
  clearUndo()
})

describe('A. 空撤回栈：置灰可见、点不动', () => {
  it('A1 「撤回」条目在 DOM 里且带置灰标记（是被置灰，不是被过滤掉）', async () => {
    const { appStore } = await mountPalette()
    expect(appStore.commandPaletteOpen).toBe(true)
    await typeQuery('撤回')

    const el = itemByText('撤回')
    expect(el, '搜「撤回」搜不到条目 —— 禁用项不该被隐藏').toBeTruthy()
    expect(el.classList.contains('cp-item-disabled')).toBe(true)
    expect(el.getAttribute('aria-disabled')).toBe('true')
  })

  it('A2 点置灰条目：不执行、不关面板、给提示（不许"点了没反应"）', async () => {
    const { appStore } = await mountPalette()
    await typeQuery('撤回')
    const el = itemByText('撤回')
    const toastsBefore = (appStore.toasts || []).length

    el.click()
    await nextTick()
    await nextTick()

    expect(appStore.commandPaletteOpen, '点禁用项把面板关掉了 = 点了没反应').toBe(true)
    const toast = lastToast(appStore)
    expect(toast, '点禁用项没有任何提示').toBeTruthy()
    expect(toast.type).toBe('info')
    // 执行器那条是「没有可撤回的文件操作」；走的是拦截分支才会是这句
    expect(toast.message).toBe('暂无可撤回的文件操作')
    expect((appStore.toasts || []).length).toBe(toastsBefore + 1)
  })

  it('A3 置灰条目不高亮：进面板后不存在 .cp-item-selected 落在它身上', async () => {
    await mountPalette()
    await typeQuery('撤回')
    const selected = document.querySelector('.cp-item-selected')
    if (selected) {
      expect(selected.classList.contains('cp-item-disabled')).toBe(false)
    }
  })
})

describe('B. 有可撤回操作：同一次打开里真的解禁', () => {
  it('B1 入栈后置灰态解除，且 label 带上具体描述', async () => {
    await mountPalette()
    await typeQuery('撤回')

    const before = itemByText('撤回')
    expect(before.classList.contains('cp-item-disabled')).toBe(true)

    pushUndoEntry(entry('已删除「购物清单」'))
    await nextTick()
    await nextTick()

    const after = itemByText('撤回')
    expect(after, '解禁后条目消失了').toBeTruthy()
    expect(after.classList.contains('cp-item-disabled')).toBe(false)
    expect(after.getAttribute('aria-disabled')).toBe('false')
    expect(after.textContent).toContain('撤回：')
    expect(after.textContent).toContain('已删除「购物清单」')
  })

  it('B2 解禁后再点：真的执行（面板关闭 + 撤回被调起）', async () => {
    const { appStore } = await mountPalette()
    await typeQuery('撤回')
    pushUndoEntry(entry('已删除「购物清单」'))
    await nextTick()
    await nextTick()

    itemByText('撤回').click()
    await nextTick()
    await nextTick()

    // 走的是执行分支：面板关闭（不是被拦截留在原地）
    expect(appStore.commandPaletteOpen, '解禁后点了却没执行').toBe(false)
  })

  it('B3 可用项与禁用项混排时可正常执行（不被新机制误伤）', async () => {
    const { appStore } = await mountPalette()
    await typeQuery('笔记列表')
    const el = itemByText('笔记列表')
    expect(el).toBeTruthy()
    expect(el.classList.contains('cp-item-disabled')).toBe(false)

    el.click()
    await nextTick()
    expect(appStore.commandPaletteOpen).toBe(false)
  })
})

describe('C. 键盘导航跳过禁用项', () => {
  it('C1 唯一匹配是禁用项时：↓ 不产生高亮，⏎ 不执行任何命令', async () => {
    const { appStore } = await mountPalette()
    await typeQuery('撤回')

    const input = document.querySelector('.cp-input')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    await nextTick()

    expect(document.querySelectorAll('.cp-item-selected').length,
      '↓ 停在了禁用项上（导航没有跳过）').toBe(0)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    await nextTick()

    expect(appStore.commandPaletteOpen, '禁用项被回车执行了').toBe(true)
    expect(lastToast(appStore), '回车不该产生任何 toast').toBeNull()
  })

  it('C2 有可用项时 ↓ 落在可用项上（不是跳过整列）', async () => {
    await mountPalette()
    // 搜「视图」会命中多条可用命令
    await typeQuery('视图')
    const input = document.querySelector('.cp-input')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await nextTick()
    const selected = document.querySelector('.cp-item-selected')
    expect(selected, '↓ 之后应该有高亮项').toBeTruthy()
    expect(selected.classList.contains('cp-item-disabled')).toBe(false)
  })
})

describe('D. 空状态没被过滤逻辑弄坏', () => {
  it('D1 搜不到时仍显示「没有匹配的命令」，且列表里没有条目', async () => {
    await mountPalette()
    await typeQuery('zzz-不存在的命令-zzz')
    expect(document.querySelectorAll('.cp-item').length).toBe(0)
    const empty = document.querySelector('.cp-empty')
    expect(empty, '空状态丢了').toBeTruthy()
    expect(empty.textContent).toContain('没有匹配的命令')
  })

  it('D2 清空搜索后列表回来（空状态不是卡死状态）', async () => {
    await mountPalette()
    await typeQuery('zzz-不存在的命令-zzz')
    expect(document.querySelector('.cp-empty')).toBeTruthy()

    await typeQuery('')
    expect(document.querySelector('.cp-empty')).toBeNull()
    expect(document.querySelectorAll('.cp-item').length).toBeGreaterThan(10)
  })
})
