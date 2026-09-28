// ===========================================================================
// W3 · 删除方式上报内核（src/utils/trashState.js）
//
// 为什么单独一个文件：trashState.js 是**零 import** 的纯内核（与 noteIdentity /
// trashIndex / dateAttribution 同规格），必须在 node 环境下能直接 import 跑。
// 这里断言的是「跨模块状态 + 事件通道」这两件事本身，不牵扯任何组件。
//
// 每条用例都对应一个真实故障：
//   · method 取值 / 事件名写错 → 静默断链（TrashView 收不到，指示条永远过期）；
//   · 布尔返回值被当成对象解 → undefined 方法被照记（FI-1 / FI-2）；
//   · notify 用错 → 「事件 → 上报 → 派发 → 事件」无限递归（FI-3）；
//   · 事件名改名 → 断链（FI-4）。
// ===========================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  TRASH_METHOD_SYSTEM,
  TRASH_METHOD_LIBRARY,
  TRASH_METHOD_EVENT,
  TRASH_METHOD_UNKNOWN,
  getSystemTrashState,
  resetSystemTrashState,
  subscribeTrashState,
  isSelfDispatched,
  extractTrashMethod,
  reportTrashMethod
} from '../src/utils/trashState'

/** 状态是模块级单例，用例之间必须显式归零 */
beforeEach(() => {
  resetSystemTrashState()
})

afterEach(() => {
  resetSystemTrashState()
})

describe('W3 · 常量口径', () => {
  it('method 字面量与主进程 fs:delete-file / fs:remove-dir 一致', () => {
    expect(TRASH_METHOD_SYSTEM).toBe('system-trash')
    expect(TRASH_METHOD_LIBRARY).toBe('library-trash')
  })

  it('事件名恒为 choyeon:trash-method（改名 = 与 TrashView 静默断链）', () => {
    expect(TRASH_METHOD_EVENT).toBe('choyeon:trash-method')
  })
})

describe('W3 · extractTrashMethod 的安全降级', () => {
  it('detail 形态 + 成功 → 取到 method', () => {
    expect(extractTrashMethod({ ok: true, method: 'system-trash', path: '/a.md' })).toBe('system-trash')
    expect(extractTrashMethod({ ok: true, method: 'library-trash', path: '/a.md' })).toBe('library-trash')
  })

  it('不传 detail 时主进程回 true → 未知，绝不解出 undefined 还照记（FI-1）', () => {
    expect(extractTrashMethod(true)).toBe('')
    expect(extractTrashMethod(false)).toBe('')
  })

  it('失败形态 {ok:false} → 未知（FI-2）', () => {
    expect(extractTrashMethod({ ok: false, error: 'delete-failed' })).toBe('')
    expect(extractTrashMethod({ ok: false, error: 'delete-failed', method: 'system-trash' })).toBe('')
  })

  it('null / undefined / 非对象 → 未知', () => {
    expect(extractTrashMethod(null)).toBe('')
    expect(extractTrashMethod(undefined)).toBe('')
    expect(extractTrashMethod(0)).toBe('')
    expect(extractTrashMethod('system-trash')).toBe('')
  })

  it('ok:true 但 method 缺失或不是非空字符串 → 未知', () => {
    expect(extractTrashMethod({ ok: true })).toBe('')
    expect(extractTrashMethod({ ok: true, method: '' })).toBe('')
    expect(extractTrashMethod({ ok: true, method: 42 })).toBe('')
  })

  it('未知常量就是空串（便于直接判真假）', () => {
    expect(TRASH_METHOD_UNKNOWN).toBe('')
  })
})

describe('W3 · reportTrashMethod 的记账口径', () => {
  it('system-trash → 点亮并计数 +1', () => {
    expect(reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })).toBe(true)
    expect(getSystemTrashState().value.seen).toBe(true)
    expect(getSystemTrashState().value.count).toBe(1)
  })

  it('library-trash 不点亮（那种条目本来就躺在列表里）', () => {
    expect(reportTrashMethod(TRASH_METHOD_LIBRARY, { notify: false })).toBe(false)
    expect(getSystemTrashState().value.seen).toBe(false)
    expect(getSystemTrashState().value.count).toBe(0)
  })

  it('未知 / null / undefined 一律不点亮', () => {
    expect(reportTrashMethod('', { notify: false })).toBe(false)
    expect(reportTrashMethod(null, { notify: false })).toBe(false)
    expect(reportTrashMethod(undefined, { notify: false })).toBe(false)
    expect(getSystemTrashState().value.seen).toBe(false)
  })

  it('多次上报累加，reset 归零', () => {
    reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })
    reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })
    expect(getSystemTrashState().value.count).toBe(2)
    resetSystemTrashState()
    expect(getSystemTrashState().value.count).toBe(0)
    expect(getSystemTrashState().value.seen).toBe(false)
  })
})

describe('W3 · notify 通道与自派发去重', () => {
  it('默认 notify → 往 window 派发一次事件', () => {
    let hits = 0
    const onEvent = () => { hits += 1 }
    window.addEventListener(TRASH_METHOD_EVENT, onEvent)
    try {
      expect(reportTrashMethod(TRASH_METHOD_SYSTEM)).toBe(true)
      expect(hits).toBe(1)
    } finally {
      window.removeEventListener(TRASH_METHOD_EVENT, onEvent)
    }
  })

  it('notify:false → 只记状态，绝不回抛（否则监听器里再上报就是无限递归）', () => {
    let hits = 0
    const onEvent = () => { hits += 1 }
    window.addEventListener(TRASH_METHOD_EVENT, onEvent)
    try {
      expect(reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })).toBe(true)
      expect(hits).toBe(0)
      expect(getSystemTrashState().value.count).toBe(1)
    } finally {
      window.removeEventListener(TRASH_METHOD_EVENT, onEvent)
    }
  })

  it('自派发出去的事件能被 isSelfDispatched 认出来', () => {
    let seen = null
    const onEvent = (event) => { seen = event }
    window.addEventListener(TRASH_METHOD_EVENT, onEvent)
    try {
      reportTrashMethod(TRASH_METHOD_SYSTEM)
      expect(isSelfDispatched(seen)).toBe(true)
    } finally {
      window.removeEventListener(TRASH_METHOD_EVENT, onEvent)
    }
  })

  it('别人派发的事件不算自派发（必须被监听器正常记账）', () => {
    let seen = null
    const onEvent = (event) => { seen = event }
    window.addEventListener(TRASH_METHOD_EVENT, onEvent)
    try {
      window.dispatchEvent(new CustomEvent(TRASH_METHOD_EVENT, { detail: { method: TRASH_METHOD_SYSTEM } }))
      expect(isSelfDispatched(seen)).toBe(false)
    } finally {
      window.removeEventListener(TRASH_METHOD_EVENT, onEvent)
    }
  })

  it('isSelfDispatched(null / undefined) 恒为 false', () => {
    expect(isSelfDispatched(null)).toBe(false)
    expect(isSelfDispatched(undefined)).toBe(false)
  })

  /**
   * 这条是 FI-3 的哨兵：完整复刻 TrashView 的监听器形状。
   * 谁把监听回调里的 `{ notify: false }` 去掉（或改 true），
   * 就会「事件 → 上报 → 派发 → 事件」无限递归 —— 本用例直接爆栈变红。
   */
  it('监听器用 notify:false 回灌 → 一次上报只记一次，且不递归', () => {
    const onTrashMethodEvent = (event) => {
      if (isSelfDispatched(event)) return
      const method = event && event.detail ? event.detail.method : null
      reportTrashMethod(method, { notify: false })
    }
    window.addEventListener(TRASH_METHOD_EVENT, onTrashMethodEvent)
    try {
      // 外部派发一次（模拟别的入口上报）
      window.dispatchEvent(new CustomEvent(TRASH_METHOD_EVENT, { detail: { method: TRASH_METHOD_SYSTEM } }))
      expect(getSystemTrashState().value.count).toBe(1)
      // 直接上报一次（notify 默认开）也不该被记两遍
      reportTrashMethod(TRASH_METHOD_SYSTEM)
      expect(getSystemTrashState().value.count).toBe(2)
    } finally {
      window.removeEventListener(TRASH_METHOD_EVENT, onTrashMethodEvent)
    }
  })
})

describe('W3 · 订阅（视图把内核状态同步进自己的 ref）', () => {
  it('注册时立刻回调当前快照', () => {
    let snap = null
    const off = subscribeTrashState((s) => { snap = s })
    try {
      expect(snap).toEqual({ seen: false, count: 0 })
    } finally {
      off()
    }
  })

  it('内核变更会推给订阅者', () => {
    const seen = []
    const off = subscribeTrashState((s) => { seen.push(s) })
    try {
      reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })
      resetSystemTrashState()
      expect(seen.length).toBe(3)
      expect(seen[1]).toEqual({ seen: true, count: 1 })
      expect(seen[2]).toEqual({ seen: false, count: 0 })
    } finally {
      off()
    }
  })

  it('取消订阅后不再收到推送', () => {
    let calls = 0
    const off = subscribeTrashState(() => { calls += 1 })
    off()
    reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })
    expect(calls).toBe(1)
  })

  it('订阅者自己抛错不影响记账主流程', () => {
    const off = subscribeTrashState(() => { throw new Error('视图同步炸了') })
    try {
      expect(reportTrashMethod(TRASH_METHOD_SYSTEM, { notify: false })).toBe(true)
      expect(getSystemTrashState().value.count).toBe(1)
    } finally {
      off()
    }
  })

  it('非函数入参 → 返回空操作，不炸', () => {
    const off = subscribeTrashState(null)
    expect(typeof off).toBe('function')
    off()
  })
})
