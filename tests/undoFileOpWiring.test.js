/**
 * app.undoFileOp（撤回上一步文件操作）执行器单测
 *
 * 批次 6 交付了 useFileUndo 内核 + note store 的四个对外接口，本轮 W2 把它接进
 * 「注册表 → 执行器 → 命令面板 → 全局快捷键」。这个文件只测**执行器这一环**：
 *
 *   1. 空栈不许静默 —— 必须给 toast，否则用户按了没反应会以为快捷键坏了
 *   2. `undoLastFileOperation()` 是 async —— 必须等 Promise 落定才知道成败，
 *      绝不能把「调用已发起」当「撤回已成功」（这是本条命令最容易写错的地方）
 *   3. 失败必须 toast 成**失败**（带 code），不许伪装成成功
 *   4. 零 import 契约不破 —— `createAppActions({})` 仍要能跑出完整 key 集合
 *
 * 为什么用真 appStore 而不是替身：toast 是用户唯一能看到的反馈，
 * 断言「appStore.toasts 里真的多了一条」比断言「某个 mock 被调用了」更接近真实。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { createAppActions, APP_ACTION_IDS } from '../src/composables/useAppActions'
import { useAppStore } from '../src/stores/app'

/** 造一个 noteStore 替身：只提供撤回命令真正读的那三个字段 */
function makeNoteStore ({ canUndo = true, label = '', undoImpl = async () => ({ ok: true, code: 'ok', label: '移动 笔记A' }) } = {}) {
  return {
    canUndoFileOperation: canUndo,
    undoFileOperationLabel: label,
    undoLastFileOperation: undoImpl
  }
}

/** 取最后一条 toast 的 { type, message } */
function lastToast (appStore) {
  const list = appStore.toasts
  return list.length ? { type: list[list.length - 1].type, message: list[list.length - 1].message } : null
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('app.undoFileOp 执行器', () => {
  it('执行器表里必须有 app.undoFileOp（否则 auditShortcuts 判 dead）', () => {
    expect(APP_ACTION_IDS).toContain('app.undoFileOp')
    // 零 import 契约：空 ctx 也要能构造出完整 key 集合
    expect(Object.keys(createAppActions({}))).toContain('app.undoFileOp')
  })

  it('空撤回栈：给 info toast，且不调用撤回接口（不许静默什么都不做）', () => {
    const appStore = useAppStore()
    let called = 0
    const noteStore = makeNoteStore({
      canUndo: false,
      undoImpl: async () => { called += 1; return { ok: true, code: 'ok', label: 'x' } }
    })
    createAppActions({ appStore, noteStore })['app.undoFileOp']()

    expect(called).toBe(0)
    const toast = lastToast(appStore)
    expect(toast).toEqual({ type: 'info', message: '没有可撤回的文件操作' })
  })

  it('撤回成功：等 Promise 落定后给 success toast，并把栈顶文案带出来', async () => {
    const appStore = useAppStore()
    const noteStore = makeNoteStore({
      canUndo: true,
      label: '移动 笔记A',
      undoImpl: async () => ({ ok: true, code: 'ok', label: '移动 笔记A' })
    })
    createAppActions({ appStore, noteStore })['app.undoFileOp']()

    // 关键：调用刚返回时 Promise 还没落定，此刻不许已经 toast 成成功
    expect(lastToast(appStore)).toBeNull()
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))

    const toast = lastToast(appStore)
    expect(toast.type).toBe('success')
    expect(toast.message).toContain('已撤回')
    expect(toast.message).toContain('移动 笔记A')
  })

  it('撤回失败：toast 必须是 error，绝不许出现「已撤回」（不能把失败说成成功）', async () => {
    const appStore = useAppStore()
    const noteStore = makeNoteStore({
      canUndo: true,
      label: '删除 笔记B',
      undoImpl: async () => ({ ok: false, code: 'target-exists', label: '删除 笔记B' })
    })
    createAppActions({ appStore, noteStore })['app.undoFileOp']()
    await new Promise(resolve => setTimeout(resolve, 0))

    const toast = lastToast(appStore)
    expect(toast.type).toBe('error')
    expect(toast.message).not.toContain('已撤回')
    expect(toast.message).toContain('撤回失败')
    expect(toast.message).toContain('target-exists')
  })

  it('撤回接口抛异常：转成 error toast，不把异常冒泡到按键处理链', async () => {
    const appStore = useAppStore()
    const noteStore = makeNoteStore({
      canUndo: true,
      undoImpl: async () => { throw new Error('EACCES') }
    })
    expect(() => createAppActions({ appStore, noteStore })['app.undoFileOp']()).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))

    const toast = lastToast(appStore)
    expect(toast.type).toBe('error')
    expect(toast.message).toContain('EACCES')
  })

  it('noteStore 缺接口（store 侧改名 / 漏导出）：error toast + 不抛，绝不静默', () => {
    const appStore = useAppStore()
    // 只有 canUndo 为真、没有 undoLastFileOperation —— 模拟重构漏导出
    const noteStore = { canUndoFileOperation: true, undoFileOperationLabel: '新建 笔记C' }
    expect(() => createAppActions({ appStore, noteStore })['app.undoFileOp']()).not.toThrow()

    const toast = lastToast(appStore)
    expect(toast.type).toBe('error')
    expect(toast.message).toContain('撤回失败')
  })

  it('canUndo 的三种形态（boolean / getter / 未解包 ref）都被正确识别', () => {
    const appStore = useAppStore()
    // 真实运行时是 Pinia 解包后的 boolean；测试替身可能是 getter 或未解包 ref
    const yes = [
      { canUndoFileOperation: true },
      { canUndoFileOperation: () => true },
      { canUndoFileOperation: ref(true) }
    ]
    for (const shape of yes) {
      const noteStore = { ...shape, undoFileOperationLabel: 'X', undoLastFileOperation: async () => ({ ok: true, code: 'ok', label: 'X' }) }
      createAppActions({ appStore, noteStore })['app.undoFileOp']()
      // 有可撤回 → 走的是撤回分支（同步阶段不会先弹「没有可撤回」）
      expect(lastToast(appStore)?.message).not.toBe('没有可撤回的文件操作')
    }
    const no = [
      { canUndoFileOperation: false },
      { canUndoFileOperation: () => false },
      { canUndoFileOperation: ref(false) },
      {} // 完全没有这个字段
    ]
    for (const shape of no) {
      const noteStore = { ...shape, undoLastFileOperation: async () => ({ ok: true, code: 'ok', label: 'X' }) }
      createAppActions({ appStore, noteStore })['app.undoFileOp']()
      expect(lastToast(appStore)).toEqual({ type: 'info', message: '没有可撤回的文件操作' })
    }
  })
})
