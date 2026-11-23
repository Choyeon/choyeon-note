/**
 * IPC 契约双向差集守卫（tests/ipcContract.test.js）
 *
 * 这一份只回答一个问题：**前端能调的命令，后端真的注册了吗？后端注册的命令，
 * 前端真的调得到吗？传的参数名两边对得上吗？事件载荷解包了吗？**
 *
 * 背景：tauriBridge.js 手写约 48 个 call('cmd')，lib.rs 手写约 48 个
 * generate_handler! 注册，两侧仅靠命名约定对齐。任一处拼错 / 漏注册 / 漏桥接 /
 * 参数改名，都是「运行时才暴露」的 IPC 错误——浏览器预览没有 electronAPI，
 * 功能测试又全量 mock 掉它，所以 1605 个测试全绿也抓不到（这正是 P0-1 的教训）。
 *
 * 三条硬性约定：
 *   1. 纯源码级断言：不加载 Tauri、不 mock electronAPI、不触发真实 IPC；
 *   2. 双向差集都要查：既防「桥接了不存在的命令」，也防「注册了没桥接的命令」；
 *   3. 事件订阅（subscribe/on*）、payload 包装、别名不计入命令名集合——只取
 *      call('cmd') 的第一参，它与 generate_handler 的注册名是同一命名空间。
 *
 * 环境：本项目没有 vitest setup 文件，本文件只读源码，无需任何 window mock。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = process.cwd()
const bridgeSrc = readFileSync(resolve(ROOT, 'src/utils/tauriBridge.js'), 'utf8')
const libSrc = readFileSync(resolve(ROOT, 'src-tauri/src/lib.rs'), 'utf8')
const noteSrc = readFileSync(resolve(ROOT, 'src/stores/note.js'), 'utf8')

const rustDir = resolve(ROOT, 'src-tauri/src')
const rustSrc = readdirSync(rustDir)
  .filter(f => f.endsWith('.rs'))
  .map(f => readFileSync(join(rustDir, f), 'utf8'))
  .join('\n')

/** camelCase → snake_case（用于桥接参数名与 Rust 签名参数名比对） */
const toSnake = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

// ---------------------------------------------------------------------------
// 解析 bridge：只认 call('cmd', {key, ...})，事件订阅走 subscribe 不计入
// ---------------------------------------------------------------------------
const callPattern = /\bcall\(\s*'([a-z][a-z0-9_]*)'\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/g
const calls = []
for (const m of bridgeSrc.matchAll(callPattern)) {
  calls.push({ cmd: m[1], args: m[2] || '' })
}
const bridgeCmds = [...new Set(calls.map(c => c.cmd))].sort()

// ---------------------------------------------------------------------------
// 解析 lib.rs：generate_handler![ module::cmd, ... ]，只认真正注册的
// ---------------------------------------------------------------------------
const handlerBlock = (libSrc.match(/generate_handler!\s*\[([\s\S]*?)\]/) || [, ''])[1]
const regPattern = /\b([a-z_][a-z0-9_]*)::([a-z][a-z0-9_]*)\s*,/g
const registered = []
for (const m of handlerBlock.matchAll(regPattern)) {
  registered.push({ module: m[1], cmd: m[2] })
}
const libCmds = [...new Set(registered.map(r => r.cmd))].sort()

/** 按顶层分隔符切分（跳过 <> () 内的逗号，如 State<'_, Arc<AppState>>） */
function splitTopLevel (str, sep) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of str) {
    if (ch === '<' || ch === '(') depth++
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1)
    if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** 提取 Rust 命令的业务参数名（排除 State/AppHandle 注入与 _ 前缀） */
function rustParams (name) {
  const idx = rustSrc.indexOf(`fn ${name}(`)
  if (idx < 0) return null
  const open = rustSrc.indexOf('(', idx)
  let depth = 0
  let close = -1
  for (let i = open; i < rustSrc.length; i++) {
    if (rustSrc[i] === '(') depth++
    else if (rustSrc[i] === ')') {
      depth--
      if (depth === 0) { close = i; break }
    }
  }
  if (close < 0) return null
  const names = []
  for (const part of splitTopLevel(rustSrc.slice(open + 1, close), ',')) {
    const m = part.match(/^\s*(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/)
    if (!m) continue
    const pname = m[1]
    const ptype = m[2]
    if (pname.startsWith('_')) continue
    if (/\bState\s*</.test(ptype) || /AppHandle/.test(ptype)) continue
    names.push(toSnake(pname))
  }
  return names
}

/** 从 call 的 args 对象里取键名，转 snake_case */
function argKeys (args) {
  if (!args) return []
  return splitTopLevel(args, ',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const colon = s.indexOf(':')
      return (colon >= 0 ? s.slice(0, colon) : s).trim()
    })
    .filter(k => /^[a-zA-Z]\w*$/.test(k))
    .map(toSnake)
}

// ---------------------------------------------------------------------------
// 命令名双向差集
// ---------------------------------------------------------------------------
describe('IPC 命令名双向差集（bridge ↔ lib.rs）', () => {
  it('两侧都解析出足够多的命令，防止正则失效导致空集合假绿', () => {
    expect(bridgeCmds.length, 'bridge 命令数').toBeGreaterThanOrEqual(40)
    expect(libCmds.length, 'lib.rs 注册命令数').toBeGreaterThanOrEqual(40)
  })

  it('无孤儿桥接：bridge 调用的每个命令都在 lib.rs 注册', () => {
    const orphan = bridgeCmds.filter(c => !libCmds.includes(c))
    expect(orphan, '桥接了但未注册的命令（运行时必报 command not found）').toEqual([])
  })

  it('无未桥接命令：lib.rs 注册的每个命令都被 bridge 暴露', () => {
    const missing = libCmds.filter(c => !bridgeCmds.includes(c))
    expect(missing, '注册了但 bridge 未暴露的命令').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 参数名一致性（camelCase → snake_case）
// ---------------------------------------------------------------------------
describe('IPC 参数名一致性', () => {
  it('每个桥接参数键都能在对应 Rust 命令签名中找到同名（snake_case）参数', () => {
    const mismatches = []
    for (const { cmd, args } of calls) {
      const params = rustParams(cmd)
      if (params === null) {
        mismatches.push(`${cmd}: 未找到 Rust 命令签名`)
        continue
      }
      for (const key of argKeys(args)) {
        if (!params.includes(key)) {
          mismatches.push(`${cmd}: bridge 传 '${key}'，Rust 签名为 [${params.join(', ')}]`)
        }
      }
    }
    expect(mismatches, '参数名不匹配（运行时 Tauri 会拒绝注入该参数）').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 事件载荷解包（P0-1 回归）
// ---------------------------------------------------------------------------
describe('subscribe 事件载荷解包', () => {
  it('callback 收到的是解包后的 payload，而非整个 {event,id,payload} 事件对象', () => {
    expect(bridgeSrc, '必须识别 Tauri 事件包装对象').toMatch(/'payload'\s+in\s+evt/)
    expect(bridgeSrc, '必须取 evt.payload').toMatch(/evt\.payload/)
    expect(bridgeSrc, 'callback 必须收到解包后的 payload').toMatch(
      /callback\(\s*transform\s*\?\s*transform\(payload\)\s*:\s*payload\s*\)/
    )
  })

  it('不再出现把事件对象直接当 payload 转发的旧写法', () => {
    expect(bridgeSrc).not.toMatch(/callback\(transform \? transform\(evt\) : evt\)/)
    expect(bridgeSrc).not.toMatch(/listen\(\s*event\s*,\s*\(payload\)\s*=>\s*callback\(payload\)/)
  })
})

// ---------------------------------------------------------------------------
// setNotesPath 失败用户可见（静默失败回归）
// ---------------------------------------------------------------------------
describe('setNotesPath 失败用户可见', () => {
  it('setNotesPath 的 catch 块含 notifyError / pushToast 调用', () => {
    const idx = noteSrc.indexOf('await window.electronAPI.setNotesPath(path)')
    expect(idx, '应能定位 setNotesPath 调用').toBeGreaterThan(-1)
    const tail = noteSrc.slice(idx, idx + 600)
    const catchIdx = tail.indexOf('catch')
    expect(catchIdx, 'setNotesPath 调用后应有 catch 块').toBeGreaterThan(-1)
    const catchBlock = tail.slice(catchIdx, catchIdx + 320)
    expect(catchBlock, 'setNotesPath 失败必须给用户提示，不能只记日志').toMatch(
      /notifyError\s*\(|pushToast\s*\(/
    )
  })
})
