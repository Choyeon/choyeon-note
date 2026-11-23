/**
 * tauriBridge 事件载荷守卫。
 *
 * Tauri 的 listen() 回调参数是 { event, id, payload }，而 Electron preload.cjs
 * 直接回调 payload。桥接层若忘记解包，所有事件消费者都会收到包装对象：
 * 外部变更同步不触发、更新提示不显示，而且 1600+ 现有测试全部通过（它们
 * 只 mock window.electronAPI，从不加载真实桥接层）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('tauriBridge 事件载荷解包', () => {
  let handlers = {}
  let listenMock

  beforeEach(() => {
    vi.resetModules()
    handlers = {}
    listenMock = vi.fn(async (event, fn) => {
      handlers[event] = fn
      return () => {}
    })
    vi.doMock('@tauri-apps/api/event', () => ({ listen: listenMock }))
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
    window.__TAURI_INTERNALS__ = { invoke: () => {} }
  })

  afterEach(() => {
    delete window.electronAPI
    delete window.__TAURI_INTERNALS__
    vi.doUnmock('@tauri-apps/api/event')
    vi.doUnmock('@tauri-apps/api/core')
  })

  it('notes:external-change 回调收到 payload 而不是事件包装对象', async () => {
    await import('../src/utils/tauriBridge.js?event-payload-test')
    expect(typeof window.electronAPI?.onNotesExternalChange).toBe('function')

    const received = []
    const off = window.electronAPI.onNotesExternalChange((changes) => received.push(changes))
    await Promise.resolve()

    const payload = [{ path: 'C:\\notes\\a.md', kind: 'change' }]
    handlers['notes:external-change']({ event: 'notes:external-change', id: 1, payload })

    expect(listenMock).toHaveBeenCalled()
    expect(received).toEqual([payload])
    off()
  })

  it('updater 事件仍以 (eventName, payload) 形式回调', async () => {
    await import('../src/utils/tauriBridge.js?updater-payload-test')
    const received = []
    const off = window.electronAPI.onUpdaterEvent((name, data) => received.push([name, data]))
    await Promise.resolve()

    handlers['updater:update-available']({ event: 'updater:update-available', id: 2, payload: { version: '2.0.3' } })

    expect(received).toEqual([['updater:update-available', { version: '2.0.3' }]])
    off()
  })
})
