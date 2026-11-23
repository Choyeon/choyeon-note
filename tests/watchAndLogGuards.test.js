/**
 * 自写抑制 + 后端日志脱敏守卫（tests/watchAndLogGuards.test.js）
 *
 * 这一份钉住两条「静态看像对的、运行时才发现全错」的后端缺陷：
 *
 *   1. 自写抑制（P0-2）：mark_self_write 曾存 Instant::now()（当前时刻），
 *      而 is_self_write 判 `until > now`——标记永远早于检查时刻，恒 false，
 *      导致应用自己写盘被 watcher 当成外部变更，正在编辑的笔记被误判冲突。
 *      正确写法必须存「未来过期时刻」= now + 静默时长。
 *
 *   2. 后端日志脱敏兜底：log_append 曾直接把渲染层传入的 msg/data 落盘，
 *      只在 createLogger 路径上脱敏；一旦调用方绕过 createLogger 直接 invoke，
 *      绝对路径 / token / 密码本 value 就会明文写进日志文件。
 *      正确写法必须在写入前对 msg 与 data 做脱敏归一。
 *
 * 方法：纯源码级断言（与 tauriStateInjection.test.js 同口径）。Rust 逻辑无法在
 * vitest 里直接执行，只能用源码断言防止这两处回归；实现由 Cargo 侧保证可编译。
 *
 * 环境：无 vitest setup，本文件只读源码。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const stateSrc = readFileSync(resolve(ROOT, 'src-tauri/src/state.rs'), 'utf8')
const loggingSrc = readFileSync(resolve(ROOT, 'src-tauri/src/logging.rs'), 'utf8')

/** 截取 `fn name(` 到其后第一个函数体右花括号（按花括号配平） */
function fnBody (src, name) {
  const idx = src.indexOf(`fn ${name}(`)
  if (idx < 0) return ''
  const open = src.indexOf('{', idx)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// 自写抑制
// ---------------------------------------------------------------------------
describe('自写抑制窗口（P0-2 回归）', () => {
  const body = fnBody(stateSrc, 'mark_self_write')

  it('能定位 mark_self_write 函数体', () => {
    expect(body, 'state.rs 应有 mark_self_write').not.toBe('')
  })

  it('mark 存的是「未来过期时刻」（now + 时长），不是裸 Instant::now()', () => {
    const insert = body.match(/map\.insert\([^;]*\)/)
    expect(insert, 'mark_self_write 内应有 map.insert').toBeTruthy()
    const value = insert[0]
    // 必须含加法：Instant::now() + Duration / 命名常量等，语义是未来时刻
    expect(value, 'insert 的值必须带时差，否则 is_self_write 的 until>now 恒 false').toMatch(
      /Instant::now\(\)\s*\+/
    )
    expect(value).not.toMatch(/map\.insert\(path\.clone\(\),\s*Instant::now\(\)\)/)
  })

  it('静默时长来自具名 Duration，而非魔法数字散落', () => {
    expect(stateSrc, 'state.rs 应导入 Duration').toMatch(/Duration/)
    expect(body, '时差应由 Duration 构造，便于测试与复用').toMatch(/Duration::/)
  })
})

// ---------------------------------------------------------------------------
// 后端日志脱敏兜底
// ---------------------------------------------------------------------------
describe('log_append 后端脱敏兜底', () => {
  const body = fnBody(loggingSrc, 'log_append')

  it('能定位 log_append 函数体', () => {
    expect(body, 'logging.rs 应有 log_append').not.toBe('')
  })

  it('落盘前对 msg 调用字符串脱敏归一', () => {
    expect(body, 'msg 必须经脱敏函数处理，不能原样落盘').toMatch(
      /entry\.get_mut\("msg"\)[\s\S]{0,300}?redact_log_string/
    )
  })

  it('落盘前对 data 调用结构化脱敏（redact_value）', () => {
    expect(body, 'data 必须经 redact_value 处理').toMatch(
      /entry\.get_mut\("data"\)[\s\S]{0,300}?redact_value/
    )
  })

  it('脱敏发生在 format_line/落盘之前（map 链在 enqueue_lines 之前）', () => {
    const mapIdx = body.indexOf('.map(')
    const writeIdx = body.indexOf('enqueue_lines')
    expect(mapIdx, '应有 .map 脱敏链').toBeGreaterThan(-1)
    expect(writeIdx, '应有 enqueue_lines 落盘').toBeGreaterThan(-1)
    expect(mapIdx, '脱敏 map 必须在落盘之前').toBeLessThan(writeIdx)
  })
})
