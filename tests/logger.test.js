/**
 * tests/logger.test.js —— 统一日志内核（src/utils/logger.js）的回归守卫
 *
 * 为什么需要这个文件：logger 持有**模块级可变状态**（级别 / sink / 脱敏器 / 家目录 /
 * 环形缓冲），一个用例改了级别，后面所有用例都会跟着吃哑巴亏。因此每个用例前后都调
 * 用 T08 专门提供的 `resetLogger()` 做隔离（见 beforeEach / afterEach）。
 *
 * 被测性质：
 *   A. 级别过滤 —— 验收标准 1
 *   B. 模块标签与 child 分层 —— 验收标准 2
 *   C. 文本行格式（时间 / 级别 / 模块）—— 验收标准 3
 *   D. 家目录与路径遮蔽 —— 验收标准 4
 *   E. vault 敏感字段端到端遮蔽 —— 验收标准 5
 *   F. 环形缓冲 500 条语义
 *   G. LogEntry 契约、sink 行为与健壮性（打日志绝不许让业务崩）
 *   H. constants/logging.js 数值口径与结构性约束
 *   I. 【已知边界】
 *
 * 断言风格：与 tests/commandPalette.test.js 同档——能断言**真实结果**就不断言
 * 「某个替身被调用了」。因此这里用真 ring buffer、真定时器、真 sink 探针，
 * 唯一的替身是 console（为了防止测试输出刷屏，同时便于断言 consoleSink 的分发）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createLogger,
  configureLogger,
  resetLogger,
  setLogLevel,
  getLogLevel,
  getAvailableLevels,
  isLevelEnabled,
  getRingBuffer,
  clearRingBuffer,
  formatLogLine,
  consoleSink
} from '../src/utils/logger'
import { REDACTED } from '../src/utils/logSanitize'
import {
  LOG_LEVELS,
  LOG_LEVEL_ORDER,
  DEFAULT_LOG_LEVEL,
  LOG_RING_SIZE,
  LOG_CONTENT_MAX,
  LOG_MAX_STRING,
  LOG_MAX_DEPTH,
  LOG_LEVEL_WIDTH,
  LOG_FIELD_SEP,
  LS_LOG_LEVEL,
  LOG_MODULES,
  LOG_MAX_BYTES,
  LOG_KEEP_DAYS,
  LOG_MAX_FILES,
  LOG_DIR_NAME,
  LOG_FILE_NAME
} from '../src/constants/logging'

/** 与 logSanitize.js 的 ELLIPSIS 同字符（U+2026） */
const ELLIPSIS = '\u2026'

/** 控制字符一律经 String.fromCharCode 构造，源码里不出现裸字节 */
const LF = String.fromCharCode(10)
const TAB = String.fromCharCode(9)
const NUL = String.fromCharCode(0)

/** console 的五个方法全部替身化：既防止刷屏，也便于断言 consoleSink 的分发 */
const CONSOLE_METHODS = ['log', 'debug', 'info', 'warn', 'error']
let consoleSpy = {}

beforeEach(() => {
  resetLogger()
  for (const m of CONSOLE_METHODS) {
    consoleSpy[m] = vi.spyOn(console, m).mockImplementation(() => {})
  }
})

afterEach(() => {
  for (const s of Object.values(consoleSpy)) s.mockRestore()
  consoleSpy = {}
  resetLogger()
})

/** 换上一个「只记录，不外发」的捕获型 sink，返回它收集到的 entry 与渲染行 */
function capture () {
  const entries = []
  const lines = []
  configureLogger({
    sink: (entry, line) => {
      entries.push(entry)
      lines.push(line)
    }
  })
  return { entries, lines }
}

/** console 上是否出现过包含 marker 的输出（用于断言「确实一个字节都没外发」） */
function consoleReceived (marker) {
  return Object.values(consoleSpy).some(s => s.mock.calls.some(c => String(c[0]).includes(marker)))
}

// ---------------------------------------------------------------------------
// A. 级别过滤（验收标准 1）
// ---------------------------------------------------------------------------

describe('A. 级别过滤（验收标准 1）', () => {
  it('默认级别是 info：debug 被丢弃，info / warn / error 通过', () => {
    expect(getLogLevel()).toBe('info')
    const { entries } = capture()
    const log = createLogger('note')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(entries.map(e => e.lvl)).toEqual(['info', 'warn', 'error'])
    expect(getRingBuffer().map(e => e.lvl)).toEqual(['info', 'warn', 'error'])
  })

  it('setLogLevel("error") 之后只剩 error（只输出 error+）', () => {
    setLogLevel('error')
    const { entries } = capture()
    const log = createLogger('note')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(entries.map(e => e.lvl)).toEqual(['error'])
    expect(entries[0].msg).toBe('e')
  })

  it('setLogLevel("warn") 之后剩 warn + error', () => {
    setLogLevel('warn')
    const { entries } = capture()
    const log = createLogger('note')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(entries.map(e => e.lvl)).toEqual(['warn', 'error'])
  })

  it('silent 全关：连 error 都不出，缓冲也一条不留', () => {
    setLogLevel('silent')
    const { entries } = capture()
    const log = createLogger('note')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(entries).toEqual([])
    expect(getRingBuffer()).toEqual([])
  })

  it('debug 全开：四个方法一条不漏', () => {
    setLogLevel('debug')
    const { entries } = capture()
    const log = createLogger('note')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(entries.map(e => e.lvl)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('四个级别 × 四个方法的完整真值表（权重比较，直接对齐 LOG_LEVELS）', () => {
    for (const current of LOG_LEVEL_ORDER) {
      for (const lvl of LOG_LEVEL_ORDER) {
        resetLogger()
        setLogLevel(current)
        const { entries } = capture()
        const log = createLogger('note')
        log[lvl](`m`)
        const shouldPass = LOG_LEVELS[lvl] >= LOG_LEVELS[current]
        expect(entries.length === 1, `当前级别=${current} 调用=${lvl} 期望通过=${shouldPass}`).toBe(shouldPass)
      }
    }
  })

  it('级别运行时切换：同一个 logger 实例下一次调用立即生效，无需重建', () => {
    const { entries } = capture()
    const log = createLogger('note')
    log.debug('切之前')
    expect(entries.length).toBe(0)

    expect(setLogLevel('debug')).toBe('debug')
    log.debug('切之后')
    expect(entries.length).toBe(1)
    expect(entries[0].msg).toBe('切之后')

    // 再调回 error：同一个实例立刻重新关门
    setLogLevel('error')
    log.debug('又关上')
    log.error('只有我出得来')
    expect(entries.length).toBe(2)
    expect(entries[1].lvl).toBe('error')
  })

  it('configureLogger({level}) 与 setLogLevel 等价', () => {
    configureLogger({ level: 'warn' })
    expect(getLogLevel()).toBe('warn')
    configureLogger({ level: 'debug' })
    expect(getLogLevel()).toBe('debug')
  })

  it('setLogLevel 返回实际生效的级别', () => {
    expect(setLogLevel('error')).toBe('error')
    expect(setLogLevel('silent')).toBe('silent')
    expect(setLogLevel('debug')).toBe('debug')
  })

  it('非法级别值一律被忽略并返回旧值（闸门不能被脏值拆掉）', () => {
    expect(setLogLevel('warn')).toBe('warn')
    const bads = [null, undefined, '', ' ', 'DEBUG', 'Info', 'verbose', 42, {}, [], true, 'debug ', ' debug', 'error\n']
    for (const bad of bads) {
      expect(setLogLevel(bad), `非法值=${JSON.stringify(bad)} 应被忽略`).toBe('warn')
      expect(getLogLevel(), `非法值=${JSON.stringify(bad)} 不应改变当前级别`).toBe('warn')
    }
  })

  it('非法级别值不会让 isLevelEnabled 把关门条件算错', () => {
    setLogLevel('error')
    // 未知级别按 info 权重处理 —— 在 error 闸门下仍然关闭
    expect(isLevelEnabled('nonsense')).toBe(false)
    expect(isLevelEnabled(undefined)).toBe(false)
    setLogLevel('debug')
    expect(isLevelEnabled('nonsense')).toBe(true)
  })

  it('isLevelEnabled 与真实 emit 行为一致（前置判断不许撒谎）', () => {
    for (const current of LOG_LEVEL_ORDER) {
      resetLogger()
      setLogLevel(current)
      const { entries } = capture()
      const log = createLogger('note')
      const wanted = LOG_LEVEL_ORDER.filter(l => isLevelEnabled(l))
      LOG_LEVEL_ORDER.forEach(l => log[l]('x'))
      expect(entries.map(e => e.lvl), `当前级别=${current}`).toEqual(wanted)
    }
  })

  it('getAvailableLevels 覆盖四个可输出级别 + silent，且每次返回新数组', () => {
    expect(getAvailableLevels()).toEqual(['debug', 'info', 'warn', 'error', 'silent'])
    expect(getAvailableLevels()).not.toBe(getAvailableLevels())
  })
})

// ---------------------------------------------------------------------------
// B. 模块标签（验收标准 2）
// ---------------------------------------------------------------------------

describe('B. 模块标签与 child 分层（验收标准 2）', () => {
  it('createLogger(module).module 归一化：去首尾空白', () => {
    expect(createLogger('note').module).toBe('note')
    expect(createLogger('  note  ').module).toBe('note')
  })

  it('空 / null / undefined 模块名兜底为 app，长度截断到 32', () => {
    expect(createLogger('').module).toBe('app')
    expect(createLogger('   ').module).toBe('app')
    expect(createLogger(null).module).toBe('app')
    expect(createLogger(undefined).module).toBe('app')
    expect(createLogger('x'.repeat(50)).module.length).toBe(32)
  })

  it('非字符串模块名安全退化，不抛', () => {
    expect(() => createLogger(123)).not.toThrow()
    expect(createLogger(123).module).toBe('123')
    expect(createLogger([]).module).toBe('app') // String([]) === '' → 兜底
  })

  it('每条 entry 都带 mod，可以按模块过滤出子集', () => {
    const { entries } = capture()
    const note = createLogger('note')
    const app = createLogger('app')
    const watcher = createLogger('watcher')
    note.info('a')
    app.info('b')
    watcher.warn('c')
    note.error('d')

    expect(entries.map(e => e.mod)).toEqual(['note', 'app', 'watcher', 'note'])
    const noteEntries = getRingBuffer().filter(e => e.mod === 'note')
    expect(noteEntries.map(e => e.lvl)).toEqual(['info', 'error'])
    expect(getRingBuffer().filter(e => e.mod === 'watcher').length).toBe(1)
    expect(getRingBuffer().filter(e => e.mod === 'graph')).toEqual([])
  })

  it('child(sub) 用 ":" 分隔（如 note:persist），并去空白', () => {
    const log = createLogger('note')
    expect(log.child('persist').module).toBe('note:persist')
    expect(log.child(' persist ').module).toBe('note:persist')
  })

  it('child 可多级串联：note:persist:retry', () => {
    expect(createLogger('note').child('persist').child('retry').module).toBe('note:persist:retry')
  })

  it('空子名返回**同模块**的新实例（不许拼出 note:app 这种莫名其妙的后缀）', () => {
    const log = createLogger('note')
    for (const sub of ['', '   ', null, undefined, 0, {}]) {
      const child = log.child(sub)
      expect(child.module, `sub=${JSON.stringify(sub)} 应回落为父模块`).toBe('note')
    }
  })

  it('child 产出的 logger 行为完整：四个方法都在，且带完整分层名', () => {
    const { entries } = capture()
    const child = createLogger('note').child('persist')
    expect(typeof child.debug).toBe('function')
    expect(typeof child.info).toBe('function')
    expect(typeof child.warn).toBe('function')
    expect(typeof child.error).toBe('function')
    expect(typeof child.child).toBe('function')

    child.debug('d')
    child.info('i')
    child.warn('w')
    child.error('e')
    expect(entries.map(e => e.lvl)).toEqual(['info', 'warn', 'error'])
    expect(entries.every(e => e.mod === 'note:persist')).toBe(true)
  })

  it('渲染行里模块写作 [mod]，child 的分层名原样出现在方括号里', () => {
    const { lines } = capture()
    createLogger('note').child('persist').info('落盘完成')
    expect(lines[0]).toContain('[note:persist]')
    expect(lines[0].endsWith('[note:persist]  落盘完成')).toBe(true)
  })

  it('LOG_MODULES 是模块名唯一来源：13 个，键与值同名（防 block 漂移）', () => {
    const keys = Object.keys(LOG_MODULES)
    expect(keys.length).toBe(13)
    for (const key of keys) {
      expect(LOG_MODULES[key], `LOG_MODULES.${key}`).toBe(key)
    }
    expect(keys).toContain('note')
    expect(keys).toContain('vault')
    expect(keys).toContain('main')
    expect(keys).toContain('actions')
    expect(keys).toContain('commands')
  })

  it('模块名超长时渲染行里的 [模块] 列被限长，不会被动态字符串撑爆', () => {
    const line = formatLogLine({ t: 'T', lvl: 'info', mod: 'z'.repeat(100), msg: 'm' })
    expect(line).toContain(`[${'z'.repeat(32)}]`)
    expect(line.length).toBeLessThan(80)
  })
})

// ---------------------------------------------------------------------------
// C. 文本行格式（验收标准 3）
// ---------------------------------------------------------------------------

describe('C. 文本行格式：<时间>  <级别>  [模块]  <消息>  <k=v…>（验收标准 3）', () => {
  it('四个级别的完整字形（级别栏定宽 5，不足补尾空格）', () => {
    expect(formatLogLine({ t: 'T', lvl: 'debug', mod: 'a', msg: 'm' })).toBe('T  DEBUG  [a]  m')
    expect(formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: 'm' })).toBe('T  INFO   [a]  m')
    expect(formatLogLine({ t: 'T', lvl: 'warn', mod: 'a', msg: 'm' })).toBe('T  WARN   [a]  m')
    expect(formatLogLine({ t: 'T', lvl: 'error', mod: 'a', msg: 'm' })).toBe('T  ERROR  [a]  m')
  })

  it('级别栏定宽的意义：[模块] 起始列在四个级别下完全一致', () => {
    const cols = LOG_LEVEL_ORDER.map(lvl => formatLogLine({ t: 'T', lvl, mod: 'note', msg: 'm' }).indexOf('[note]'))
    expect(cols.every(c => c === cols[0]), `列=${JSON.stringify(cols)}`).toBe(true)
    expect(cols[0]).toBe(String('T').length + LOG_FIELD_SEP.length + LOG_LEVEL_WIDTH + LOG_FIELD_SEP.length)
  })

  it('行内含时间戳：既可以外部指定，缺省时自动补当前 ISO 8601', () => {
    const ts = '2026-03-15T10:23:45.123Z'
    const line = formatLogLine({ t: ts, lvl: 'error', mod: 'note', msg: '删除文件失败' })
    expect(line.startsWith(ts)).toBe(true)
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z  ERROR  \[note\]  删除文件失败$/.test(line)).toBe(true)

    const auto = formatLogLine({ lvl: 'info', mod: 'a', msg: 'm' })
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z  INFO /.test(auto)).toBe(true)
  })

  it('design §4.4 样例行逐字符对齐（含路径已脱敏的形态）', () => {
    const line = formatLogLine({
      t: '2026-03-15T10:23:45.123Z',
      lvl: 'error',
      mod: 'note',
      msg: '删除文件失败',
      data: { path: `${ELLIPSIS}/a.md`, code: 'permission' }
    })
    expect(line).toBe(`2026-03-15T10:23:45.123Z  ERROR  [note]  删除文件失败  path=${ELLIPSIS}/a.md code=permission`)
  })

  it('data 尾巴：含空格或空串的值用 JSON 引号包住，保证可反向解析', () => {
    const line = formatLogLine({
      t: 'T', lvl: 'info', mod: 'a', msg: 'm',
      data: { title: 'hello world', n: 1, b: true, empty: '' }
    })
    expect(line).toBe('T  INFO   [a]  m  title="hello world" n=1 b=true empty=""')
  })

  it('data 尾巴：对象值 JSON 化，undefined 跳过（不渲染成 u=undefined）', () => {
    const line = formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: 'm', data: { obj: { x: 1 }, u: undefined, keep: 2 } })
    expect(line).toBe('T  INFO   [a]  m  obj={"x":1} keep=2')
  })

  it('data 为标量 / null / 空对象时的尾巴形态', () => {
    expect(formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: 'm', data: 5 })).toBe('T  INFO   [a]  m  5')
    expect(formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: 'm', data: 'txt' })).toBe('T  INFO   [a]  m  "txt"')
    expect(formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: 'm', data: false })).toBe('T  INFO   [a]  m  false')
    expect(formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: 'm', data: null })).toBe('T  INFO   [a]  m')
    expect(formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: 'm', data: {} })).toBe('T  INFO   [a]  m')
  })

  it('缺字段 / null / undefined / 非对象 entry 也能渲染成合规行，绝不抛', () => {
    for (const bad of [null, undefined, {}, 42, 'x', []]) {
      const line = formatLogLine(bad)
      expect(typeof line, `入参=${JSON.stringify(bad)}`).toBe('string')
      expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(line)).toBe(true)
      expect(line).toContain('[app]')
      expect(line).toContain('INFO')
    }
  })

  it('msg getter 抛错时该段降级成 [REDACTED]，整行不报废', () => {
    const hostile = { t: 'T', lvl: 'info', mod: 'a' }
    Object.defineProperty(hostile, 'msg', { enumerable: true, get () { throw new Error('boom') } })
    expect(formatLogLine(hostile)).toBe('T  INFO   [a]  [REDACTED]')
  })

  it('连 t 都取不到时降级成一行「渲染失败」日志，仍带时间戳与 [logger]', () => {
    const hostile = {}
    Object.defineProperty(hostile, 't', { enumerable: true, get () { throw new Error('boom') } })
    const line = formatLogLine(hostile)
    expect(line).toContain('[logger]')
    expect(line).toContain(REDACTED)
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(line)).toBe(true)
  })

  it('设计口径：formatLogLine 不重复脱敏、不折叠换行（信任边界内的 entry）', () => {
    // 由上游 buildEntry 负责脱敏；这里若再脱一次会让主/渲染两侧对同一条记录产出两份文本
    const line = formatLogLine({ t: 'T', lvl: 'info', mod: 'a', msg: `x${LF}y` })
    expect(line).toBe(`T  INFO   [a]  x${LF}y`)
  })
})

// ---------------------------------------------------------------------------
// D. 家目录与路径（验收标准 4）
// ---------------------------------------------------------------------------

describe('D. 家目录绝不出现在输出中（验收标准 4）', () => {
  it('data.path 的家目录被剥掉（未注入 homeDir，靠形状识别兜底）', () => {
    const { entries, lines } = capture()
    createLogger('note').info('打开笔记', { path: '/Users/alice/notes/a.md' })
    expect(entries[0].data.path).toBe(`${ELLIPSIS}/notes/a.md`)
    expect(lines[0].includes('alice')).toBe(false)
    expect(lines[0]).toContain(`path=${ELLIPSIS}/notes/a.md`)
  })

  it('configureLogger({homeDir}) 后连自定义根目录也一并剥掉', () => {
    configureLogger({ homeDir: '/data/vault/users/bob' })
    const { entries } = capture()
    createLogger('note').info('读取', { path: '/data/vault/users/bob/x/y/a.md' })
    expect(entries[0].data.path).toBe(`${ELLIPSIS}/y/a.md`)
    expect(entries[0].data.path.includes('bob')).toBe(false)
  })

  it('Windows 路径：盘符与反斜杠同样处理', () => {
    const { entries } = capture()
    createLogger('note').info('读取', { path: 'C:\\Users\\alice\\AppData\\main.log' })
    expect(entries[0].data.path).toBe(`${ELLIPSIS}/AppData/main.log`)
  })

  it('msg 里手写的路径也过一遍遮蔽（先定形状再脱敏）', () => {
    const { entries } = capture()
    createLogger('note').error(`打开失败 /Users/alice/notes/a.md，已重试`)
    expect(entries[0].msg).toBe(`打开失败 ${ELLIPSIS}/notes/a.md，已重试`)
    expect(entries[0].msg.includes('alice')).toBe(false)
  })

  it('Error stack 里的家目录也被遮蔽', () => {
    const { entries } = capture()
    const err = new Error('boom')
    err.stack = `Error: boom${LF}    at readNote (/Users/alice/app/src/note.js:12:34)`
    createLogger('note').error(err)
    expect(entries[0].data.err.stack.includes('alice')).toBe(false)
    expect(entries[0].data.err.stack).toContain(`${ELLIPSIS}/src/note.js`)
  })

  it('homeDir 传非法值会被重置为空串（回到形状识别，自定义根此时会露头）', () => {
    configureLogger({ homeDir: '/data/vault/users/bob' })
    configureLogger({ homeDir: 123 })
    const { entries } = capture()
    // 注：显式 home 被清掉后，这条只能靠形状识别 —— 认不出 '/data/vault/users/bob'
    createLogger('note').info('读取', { path: '/data/vault/users/bob/a.md' })
    expect(entries[0].data.path).toBe(`${ELLIPSIS}/bob/a.md`)
  })

  it('resetLogger 把级别 / sink / 脱敏器 / 家目录 / 缓冲全部恢复出厂', () => {
    configureLogger({ homeDir: '/Users/alice', level: 'debug', sink: null, sanitize: () => 'X', ringSize: 3 })
    resetLogger()

    expect(getLogLevel()).toBe('info')
    expect(getRingBuffer()).toEqual([])

    // sink 恢复成 consoleSink
    const before = consoleSpy.info.mock.calls.length
    createLogger('note').info('RESET-MARKER')
    expect(consoleSpy.info.mock.calls.length - before).toBe(1)

    // 脱敏器恢复成内置
    const { entries } = capture()
    createLogger('note').info('x', { password: 'plain' })
    expect(entries[0].data.password).toBe(REDACTED)

    // 家目录也一并清空：/Users/alice 仍能被形状识别兜住
    createLogger('note').info('y', { path: '/Users/alice/a.md' })
    expect(entries[1].data.path).toBe(`${ELLIPSIS}/a.md`)
  })

  it('一条真实日志行的整体形态：含时间 / 级别 / 模块，且不含家目录', () => {
    const { lines } = capture()
    createLogger('note').error('保存失败', { path: '/Users/alice/notes/a.md', code: 'EACCES' })
    const line = lines[0]
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z  ERROR  \[note\]/.test(line)).toBe(true)
    expect(line.includes('alice')).toBe(false)
    expect(line.endsWith(`保存失败  path=${ELLIPSIS}/notes/a.md code=EACCES`)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// E. vault 敏感字段（验收标准 5）
// ---------------------------------------------------------------------------

describe('E. vault 敏感字段端到端遮蔽（验收标准 5）', () => {
  it('entry.value / valueEnc 永不入日志：整体替换，不留首尾字符', () => {
    const { entries, lines } = capture()
    createLogger('vault').error('保存凭证失败', {
      id: 'e-1',
      label: 'GitHub Token',
      value: 'ghp_abcdef123456',
      valueEnc: 'ENC:v1:9f8e7d=='
    })
    expect(entries[0].data.value).toBe(REDACTED)
    expect(entries[0].data.valueEnc).toBe(REDACTED)
    // 非敏感字段必须保留，否则日志失去排查价值
    expect(entries[0].data.id).toBe('e-1')
    expect(entries[0].data.label).toBe('GitHub Token')

    expect(lines[0]).toContain('value=[REDACTED]')
    expect(lines[0].includes('ghp_')).toBe(false)
    expect(lines[0].includes('ENC:v1')).toBe(false)
  })

  it('secret === true 时 key 与 note 与 value 一并脱敏', () => {
    const { entries, lines } = capture()
    createLogger('vault').error('校验失败', {
      secret: true,
      key: 'alice@corp.example',
      note: '公司 CI 部署凭证',
      value: 'hunter2'
    })
    expect(entries[0].data.key).toBe(REDACTED)
    expect(entries[0].data.note).toBe(REDACTED)
    expect(entries[0].data.value).toBe(REDACTED)
    expect(lines[0].includes('alice@corp.example')).toBe(false)
    expect(lines[0].includes('公司 CI 部署凭证')).toBe(false)
    expect(lines[0].includes('hunter2')).toBe(false)
  })

  it('secret 为假时 key / note 保留，value 照旧遮蔽（两条规则互不替代）', () => {
    const { entries } = capture()
    createLogger('vault').info('读取', { secret: false, key: '公开账号', note: '可留备注', value: 'hunter2' })
    expect(entries[0].data.key).toBe('公开账号')
    expect(entries[0].data.note).toBe('可留备注')
    expect(entries[0].data.value).toBe(REDACTED)
  })

  it('失败即遮蔽：自定义 sanitize 抛错时整份 data 收敛成 [REDACTED]，业务不崩', () => {
    configureLogger({ sanitize: () => { throw new Error('sanitize boom') } })
    const { entries } = capture()
    expect(() => createLogger('vault').error('落库失败', { password: 'plain-text' })).not.toThrow()
    expect(entries[0].data).toBe(REDACTED)
    expect(JSON.stringify(entries[0]).includes('plain-text')).toBe(false)
  })

  it('通过 logger 出去的字符串一律按 LOG_CONTENT_MAX(120) 截断（不是 200）', () => {
    expect(LOG_CONTENT_MAX).toBe(120)
    const { entries } = capture()
    createLogger('note').info('x', { content: 'y'.repeat(300) })
    expect(entries[0].data.content.length).toBe(121) // 120 + 省略符
    expect(entries[0].data.content.endsWith(ELLIPSIS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// F. 环形缓冲
// ---------------------------------------------------------------------------

describe('F. 环形缓冲（500 条上限）', () => {
  it('LOG_RING_SIZE 是 500（design §3.4 口径）', () => {
    expect(LOG_RING_SIZE).toBe(500)
  })

  it('写 620 条之后长度恰好 500，首尾都正确（保留最近 500 条）', () => {
    capture()
    const log = createLogger('note')
    for (let i = 0; i < 620; i += 1) log.info(`m${i}`)

    const ring = getRingBuffer()
    expect(ring.length).toBe(500)
    expect(ring.length).toBe(LOG_RING_SIZE)
    expect(ring[0].msg).toBe('m120')
    expect(ring[1].msg).toBe('m121')
    expect(ring[ring.length - 1].msg).toBe('m619')
  })

  it('getRingBuffer() 返回副本：外部对数组增删不影响内部队列', () => {
    capture()
    createLogger('note').info('a')
    createLogger('note').info('b')
    const snap = getRingBuffer()
    snap.length = 0
    snap.push({ msg: 'tampered' })
    expect(getRingBuffer().length).toBe(2)
    expect(getRingBuffer().map(e => e.msg)).toEqual(['a', 'b'])
  })

  it('getRingBuffer() 的元素也是副本：改顶层字段不影响内部', () => {
    capture()
    createLogger('note').info('orig')
    const snap = getRingBuffer()
    snap[0].msg = 'tampered'
    snap[0].lvl = 'error'
    expect(getRingBuffer()[0].msg).toBe('orig')
    expect(getRingBuffer()[0].lvl).toBe('info')
  })

  it('getRingBuffer(limit) 取末尾 N 条', () => {
    capture()
    const log = createLogger('note')
    for (let i = 0; i < 10; i += 1) log.info(`m${i}`)
    expect(getRingBuffer(3).map(e => e.msg)).toEqual(['m7', 'm8', 'm9'])
    expect(getRingBuffer(1).map(e => e.msg)).toEqual(['m9'])
    expect(getRingBuffer(10).length).toBe(10)
  })

  it('limit 非法或超界时回落到「全部」', () => {
    capture()
    createLogger('note').info('only')
    for (const bad of [0, -5, Number.NaN, 9999, undefined, '5', {}]) {
      expect(getRingBuffer(bad).map(e => e.msg), `limit=${JSON.stringify(bad)}`).toEqual(['only'])
    }
  })

  it('clearRingBuffer() 清空队列', () => {
    capture()
    createLogger('note').info('a')
    expect(getRingBuffer().length).toBe(1)
    clearRingBuffer()
    expect(getRingBuffer()).toEqual([])
  })

  it('configureLogger({ringSize}) 改上限；小于当前长度时立即裁剪', () => {
    capture()
    const log = createLogger('note')
    for (let i = 0; i < 10; i += 1) log.info(`m${i}`)
    configureLogger({ ringSize: 3 })
    expect(getRingBuffer().map(e => e.msg)).toEqual(['m7', 'm8', 'm9'])
    log.info('m10')
    expect(getRingBuffer().map(e => e.msg)).toEqual(['m8', 'm9', 'm10'])
  })

  it('ringSize 非法值被忽略，维持上一次的合法值', () => {
    configureLogger({ ringSize: 0 })
    configureLogger({ ringSize: -1 })
    configureLogger({ ringSize: Number.NaN })
    configureLogger({ ringSize: 'oops' })
    for (let i = 0; i < 600; i += 1) createLogger('note').info('x')
    expect(getRingBuffer().length).toBe(LOG_RING_SIZE)
  })

  it('resetLogger 把上限恢复成 LOG_RING_SIZE', () => {
    configureLogger({ ringSize: 3 })
    resetLogger()
    for (let i = 0; i < 600; i += 1) createLogger('note').info('x')
    expect(getRingBuffer().length).toBe(LOG_RING_SIZE)
  })

  it('缓冲独立于 sink：即使没有任何 sink，记录照样留存（浏览器降级场景）', () => {
    configureLogger({ sink: null })
    const log = createLogger('note')
    log.info('a')
    log.warn('b')
    log.error('c')
    expect(getRingBuffer().map(e => e.lvl)).toEqual(['info', 'warn', 'error'])
  })
})

// ---------------------------------------------------------------------------
// G. LogEntry 契约、sink 与健壮性
// ---------------------------------------------------------------------------

describe('G. LogEntry 契约与 sink 行为', () => {
  it('entry 形状固定为 {t, lvl, mod, msg, data}（IPC 契约，不许增删字段）', () => {
    const { entries } = capture()
    createLogger('note').info('m', { a: 1 })
    expect(Object.keys(entries[0]).sort()).toEqual(['data', 'lvl', 'mod', 'msg', 't'])
    // 没给 data 时字段仍在（值为 undefined），落盘方的解析分支得以统一
    createLogger('note').info('m2')
    expect(Object.keys(entries[1]).sort()).toEqual(['data', 'lvl', 'mod', 'msg', 't'])
    expect(entries[1].data).toBeUndefined()
  })

  it('emit 返回构造好的 entry；被级别过滤掉时返回 undefined', () => {
    capture()
    const log = createLogger('note')
    expect(log.info('x').lvl).toBe('info')
    expect(log.debug('x')).toBeUndefined() // 默认 info 闸门下 debug 被丢
  })

  it('sink 收到 (entry, line)：line 就是 formermatter 渲染好的那一行', () => {
    const seen = []
    configureLogger({ sink: (entry, line) => seen.push({ entry, line }) })
    createLogger('note').error('boom', { code: 'E1' })
    expect(seen.length).toBe(1)
    expect(typeof seen[0].line).toBe('string')
    expect(seen[0].line).toBe(formatLogLine(seen[0].entry))
    expect(seen[0].line).toContain('code=E1')
  })

  it('性质 1：出口故障不外溢 —— sink 抛错时调用点不崩，缓冲照常记录', () => {
    configureLogger({ sink: () => { throw new Error('sink boom') } })
    expect(() => createLogger('note').error('x')).not.toThrow()
    expect(getRingBuffer().length).toBe(1)
    expect(getRingBuffer()[0].msg).toBe('x')
  })

  it('sink 为 null / undefined：只入缓冲，一个字节都不外发', () => {
    configureLogger({ sink: null })
    createLogger('note').info('QUIET-MARKER-1')
    configureLogger({ sink: undefined })
    createLogger('note').warn('QUIET-MARKER-2')
    expect(getRingBuffer().length).toBe(2)
    expect(consoleReceived('QUIET-MARKER')).toBe(false)
  })

  it('非函数 sink 被当作「没有 sink」处理', () => {
    configureLogger({ sink: 42 })
    createLogger('note').info('QUIET-MARKER-3')
    expect(getRingBuffer().length).toBe(1)
    expect(consoleReceived('QUIET-MARKER')).toBe(false)
  })

  it('重入保护：sink 内部再打日志最多套一层，不会栈溢出', () => {
    const log = createLogger('app')
    let calls = 0
    configureLogger({
      sink: () => {
        calls += 1
        log.info('内部日志')
      }
    })
    expect(() => log.info('外部日志')).not.toThrow()
    expect(calls).toBe(2) // 外层 1 次 + 嵌套 1 次，第三层被丢弃
    expect(getRingBuffer().length).toBe(2)
  })

  it('consoleSink 按级别分发到对应 console 方法；未知级别回落到 log', () => {
    consoleSink({ lvl: 'error' }, 'e')
    expect(consoleSpy.error).toHaveBeenCalledWith('e')
    consoleSink({ lvl: 'warn' }, 'w')
    expect(consoleSpy.warn).toHaveBeenCalledWith('w')
    consoleSink({ lvl: 'info' }, 'i')
    expect(consoleSpy.info).toHaveBeenCalledWith('i')
    consoleSink({ lvl: 'debug' }, 'd')
    expect(consoleSpy.debug).toHaveBeenCalledWith('d')

    expect(consoleSpy.log).toHaveBeenCalledTimes(0)
    consoleSink({ lvl: 'silent' }, 's')
    consoleSink({}, 'u')
    expect(consoleSpy.log).toHaveBeenCalledTimes(2)
  })

  it('consoleSink 只输出渲染好的单行文本，绝不把对象原样 console.log 出去', () => {
    const entry = { t: 'T', lvl: 'info', mod: 'a', msg: 'm', data: { password: REDACTED } }
    consoleSink(entry, 'T  INFO   [a]  m  password=[REDACTED]')
    const args = consoleSpy.info.mock.calls[0]
    expect(args.length).toBe(1)
    expect(typeof args[0]).toBe('string')
  })

  it('宿主没有 console 时 consoleSink 静默降级，不抛', () => {
    vi.stubGlobal('console', undefined)
    try {
      expect(() => consoleSink({ lvl: 'info' }, 'x')).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('自定义 sanitize 生效；传 null 或非函数时恢复内置脱敏', () => {
    configureLogger({ sanitize: () => ({ custom: true }) })
    const { entries } = capture()
    createLogger('note').info('x', { password: 'p' })
    expect(entries[0].data).toEqual({ custom: true })

    configureLogger({ sanitize: null })
    createLogger('note').info('x', { password: 'p' })
    expect(entries[1].data.password).toBe(REDACTED)

    configureLogger({ sanitize: 42 })
    createLogger('note').info('x', { password: 'p' })
    expect(entries[2].data.password).toBe(REDACTED)
  })

  it('Error 作为首参：拆成 "name: message" 的 msg + data.err（stack 不丢）', () => {
    const { entries } = capture()
    createLogger('note').error(new Error('写入失败'))
    expect(entries[0].msg).toBe('Error: 写入失败')
    expect(entries[0].data.err.name).toBe('Error')
    expect(entries[0].data.err.message).toBe('写入失败')
    expect(typeof entries[0].data.err.stack).toBe('string')
    // 关键：JSON.stringify(err) 只会得到 '{}'，这里必须留下了真实信息
    expect(JSON.stringify(new Error('写入失败'))).toBe('{}')
    expect(JSON.stringify(entries[0].data.err)).toContain('写入失败')
  })

  it('Error 首参 + 第二参 data：合并进 data.data', () => {
    const { entries } = capture()
    createLogger('note').error(new Error('boom'), { path: 'a.md' })
    expect(entries[0].data.err.message).toBe('boom')
    expect(entries[0].data.data.path).toBe('a.md')
  })

  it('msg 传 null / undefined / 无参都安全退化为空正文，而不是 "undefined"', () => {
    const { entries } = capture()
    const log = createLogger('note')
    log.info()
    log.info(null)
    log.info(undefined)
    expect(entries.map(e => e.msg)).toEqual(['', '', ''])
  })

  it('data 传 null / undefined / 非对象都安全退化，不抛', () => {
    const { entries } = capture()
    const log = createLogger('note')
    const payloads = [null, undefined, 42, 'str', true, Symbol('s'), () => {}]
    for (const data of payloads) {
      expect(() => log.info('m', data)).not.toThrow()
    }
    expect(entries.length).toBe(payloads.length)
    expect(entries[0].data).toBe(null)
    expect(entries[1].data).toBeUndefined()
    expect(entries[2].data).toBe(42)
    expect(entries[3].data).toBe('str')
    expect(entries[4].data).toBe(true)
    expect(entries[5].data).toBe('Symbol(s)')
    expect(entries[6].data).toBe('[Function]')
  })

  it('data 里的敌意 getter → 该字段 [REDACTED]，兄弟字段保留，调用点不崩', () => {
    const { entries } = capture()
    const data = { ok: 1 }
    Object.defineProperty(data, 'boom', { enumerable: true, get () { throw new Error('getter boom') } })
    expect(() => createLogger('note').info('m', data)).not.toThrow()
    expect(entries[0].data.ok).toBe(1)
    expect(entries[0].data.boom).toBe(REDACTED)
  })

  it('logger 产出的行永远不含真实控制字节（换行在脱敏阶段就被折叠成转义文本）', () => {
    const { lines } = capture()
    createLogger('note').error(`多行${LF}正文${TAB}带NUL${NUL}`, { note: `x${LF}y` })
    expect(lines[0].includes(LF)).toBe(false)
    expect(lines[0].includes(NUL)).toBe(false)
    expect(lines[0].includes(TAB)).toBe(false)
    expect(lines[0].includes('\\n')).toBe(true)
    expect(lines[0].includes('\\u0000')).toBe(true)
  })

  it('emit 的返回值与环形缓冲里的是同一份内容（便于测试直接断言）', () => {
    capture()
    const entry = createLogger('note').info('同一份', { n: 1 })
    const ring = getRingBuffer()
    expect(ring.length).toBe(1)
    expect(ring[0].msg).toBe(entry.msg)
    expect(ring[0].data).toEqual(entry.data)
  })
})

// ---------------------------------------------------------------------------
// H. constants/logging.js 数值口径
// ---------------------------------------------------------------------------

describe('H. constants/logging.js 数值口径与结构性约束', () => {
  it('级别权重单调递增；silent 是闸门权重，不属于可输出级别', () => {
    expect(LOG_LEVELS).toEqual({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 })
    const weights = LOG_LEVEL_ORDER.map(l => LOG_LEVELS[l])
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i] > weights[i - 1], `${LOG_LEVEL_ORDER[i]} 权重应 > ${LOG_LEVEL_ORDER[i - 1]}`).toBe(true)
    }
    expect(LOG_LEVEL_ORDER.includes('silent')).toBe(false)
    expect(LOG_LEVELS.silent).toBeGreaterThan(LOG_LEVELS.error)
  })

  it('内核口径：默认 info / 缓冲 500 / 内容 120 / 字符串 200 / 深度 3 / 级别宽 5 / 分隔符两空格', () => {
    expect(DEFAULT_LOG_LEVEL).toBe('info')
    expect(LOG_RING_SIZE).toBe(500)
    expect(LOG_CONTENT_MAX).toBe(120)
    expect(LOG_MAX_STRING).toBe(200)
    expect(LOG_MAX_DEPTH).toBe(3)
    expect(LOG_LEVEL_WIDTH).toBe(5)
    expect(LOG_FIELD_SEP).toBe('  ')
  })

  it('落盘口径（T09 消费）：2MB 轮转 / 保留 7 天 / 最多 7 个 / logs 目录 / main.log', () => {
    expect(LOG_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(LOG_KEEP_DAYS).toBe(7)
    expect(LOG_MAX_FILES).toBe(7)
    expect(LOG_DIR_NAME).toBe('logs')
    expect(LOG_FILE_NAME).toBe('main.log')
  })

  it('级别持久化 key：带 choyeon- 前缀，与其它 LS key 同命名空间', () => {
    expect(LS_LOG_LEVEL).toBe('choyeon-log-level')
    expect(LS_LOG_LEVEL.startsWith('choyeon-')).toBe(true)
  })

  it('LogEntry 形状常量与 design §3.4 的 SCR 级别集合一致（不含 silent）', () => {
    expect(LOG_LEVEL_ORDER).toEqual(['debug', 'info', 'warn', 'error'])
  })
})

// ---------------------------------------------------------------------------
// I. 【已知边界】
// ---------------------------------------------------------------------------

describe('I. 【已知边界】当前实现的口子（诚实记录，非背书）', () => {
  it('getRingBuffer() 是**浅**拷贝：顶层字段隔离，但 data 子对象仍与内部共享引用', () => {
    capture()
    createLogger('note').info('m', { nested: { v: 1 } })
    const snap = getRingBuffer()
    snap[0].data.nested.v = 99
    expect(getRingBuffer()[0].data.nested.v).toBe(99)
    // ↑ 当前确实如此。若将来改成深拷贝，请把本断言改成反向（期望仍是 1）
  })

  it('配置 homeDir 被清空后，形状识别认不出的自定义根会露出来（显式注入的价值所在）', () => {
    configureLogger({ homeDir: '/srv/vault' })
    const { entries } = capture()
    createLogger('note').info('a', { path: '/srv/vault/a.md' })
    expect(entries[0].data.path).toBe(`${ELLIPSIS}/a.md`)

    configureLogger({ homeDir: '' })
    createLogger('note').info('b', { path: '/srv/vault/a.md' })
    expect(entries[1].data.path).toBe(`${ELLIPSIS}/vault/a.md`)
    // ↑ 主进程务必通过 configureLogger({homeDir}) 注入真实 home，不要指望形状兜底
  })
})
