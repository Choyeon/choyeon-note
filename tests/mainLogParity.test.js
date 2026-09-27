// ============================================================================
// mainLogParity.test.js —— 主进程日志侧与渲染侧脱敏/常量的一致性守卫
//
// 为什么必须有这个文件：
//   `src/utils/logSanitize.js`（ESM）与 `electron/main.cjs`（CJS）里各有一份
//   **等价的路径遮蔽实现**。不是有人偷懒复制 —— 主进程是 CommonJS，且
//   electron-builder 只打包 dist/** 与 electron/**，`src/` 不进安装包，主进程一旦
//   import 就必定 MODULE_NOT_FOUND（dev 下能跑、打包后炸，是最坏的一类不一致）。
//
//   但副本就一定会漂移，而漂移的后果是**隐私**：主进程记的恰恰是最容易夹带绝对
//   路径的那些（写盘失败、越界拒绝、errno 上下文）。一旦这边的正则没跟着改，
//   家目录就会明晃晃地躺在一份「用户要拿去贴 GitHub Issue」的日志里，而所有
//   功能测试仍然全绿 —— 这类故障只有源码级比对能拦住。
//
// 为什么放 tests/ 而不是塞进 tmp 脚本：
//   tmp 里的脚本要人记得跑才会跑，等于没有守卫。本用例挂在 `npm test` 上，
//   任何人改了其中一侧而忘了另一侧，CI 立刻变红。
//
// 注意：这里**只做源码级比对**（正则字面值 / 常量数值 / 双副本标记），不加载
// main.cjs —— 它第一行就 require('electron')，在 vitest 的 jsdom 环境下会直接
// MODULE_NOT_FOUND。运行时的行为一致性由 tmp/t09-recover-verify.mjs 覆盖。
// ============================================================================

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  LOG_LEVELS,
  DEFAULT_LOG_LEVEL,
  LOG_MAX_BYTES,
  LOG_KEEP_DAYS,
  LOG_MAX_FILES,
  LOG_DIR_NAME,
  LOG_FILE_NAME,
  LOG_CONTENT_MAX,
  LOG_MAX_STRING,
  LOG_MAX_DEPTH,
  LOG_LEVEL_WIDTH,
  LOG_FIELD_SEP,
  LOG_MODULES
} from '@/constants/logging'
import { SENSITIVE_KEY_PATTERN } from '@/utils/logSanitize'

const PROJECT_ROOT = process.cwd()
const MAIN_SRC = fs.readFileSync(path.join(PROJECT_ROOT, 'electron', 'main.cjs'), 'utf-8')
const SANITIZE_SRC = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'utils', 'logSanitize.js'), 'utf-8')

/**
 * 取出一段声明的源码文本。
 *
 * 刻意用「起点 + 终点标记」而不是完整解析：这里要比对的是**字面值**，任何
 * 格式化差异（换行 / 缩进）都应该被折叠掉，所以用 normalize 抹平空白。
 * 取不到时返回 null，由调用方的 expect 直接报红（「没找到」本身就是失败）。
 *
 * @param {string} src 源码
 * @param {string} startDecl 起点声明，如 'const IS_ABSOLUTE_RE = '
 * @param {string} endMarker 终点标记
 * @returns {string|null}
 */
function sliceDecl (src, startDecl, endMarker) {
  const start = src.indexOf(startDecl)
  if (start < 0) return null
  const rest = src.slice(start + startDecl.length)
  const end = rest.indexOf(endMarker)
  return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ').trim()
}

/**
 * 取跨行构造的 EMBEDDED_PATH_RE 字面值。
 *
 * 刻意只取到 `'g'` 为止而不含收尾的 `)`：仓库文件是 **CRLF** 行尾，用 `'\n)'`
 * 这类含裸 `\n` 的标记去 indexOf 会永远落空 —— 而这个用例的职责是比内容，
 * 不是比括号。
 * @param {string} src
 * @returns {string|null}
 */
function sliceEmbedded (src) {
  const start = src.indexOf('const EMBEDDED_PATH_RE = new RegExp(')
  if (start < 0) return null
  const rest = src.slice(start)
  const flagIndex = rest.indexOf("'g'")
  if (flagIndex < 0) return null
  return rest.slice(0, flagIndex + 3).replace(/\s+/g, ' ').trim()
}

/**
 * 计算 `2 * 1024 * 1024` 这类常量表达式的值。
 * 只放行数字 / 空格 / `*`，任何其它字符一律判为不可信并返回 NaN —— 这里读的是
 * 源码文本，不该给它执行任意东西的机会。
 * @param {string} expr
 * @returns {number}
 */
function evalProduct (expr) {
  if (!/^[0-9 ]*(\*[0-9 ]+)*$/.test(String(expr).trim())) return NaN
  return String(expr)
    .split('*')
    .map(part => Number(part.trim()))
    .reduce((acc, n) => acc * n, 1)
}

/**
 * 读主进程侧的数值常量。
 * @param {string} name 常量名
 * @returns {number}
 */
function mainNumber (name) {
  const m = MAIN_SRC.match(new RegExp(`const ${name} = ([0-9 ]*(?:\\*[0-9 ]+)*)`))
  return m ? evalProduct(m[1]) : NaN
}

/**
 * 读主进程侧的字符串常量。
 * @param {string} name 常量名
 * @returns {string|null}
 */
function mainString (name) {
  const m = MAIN_SRC.match(new RegExp(`const ${name} = '([^']*)'`))
  return m ? m[1] : null
}

describe('main.cjs 与 logSanitize.js 的双副本一致性', () => {
  it('P1 两侧都写着 DUAL-COPY 标记（提醒改一处必须改两处）', () => {
    expect(MAIN_SRC).toContain('DUAL-COPY')
    expect(SANITIZE_SRC).toContain('DUAL-COPY')
  })

  it('P2 敏感 key 正则逐字符相同', () => {
    const mainPattern = sliceDecl(MAIN_SRC, 'const SENSITIVE_KEY_PATTERN = ', '\n')
    const srcPattern = sliceDecl(SANITIZE_SRC, 'export const SENSITIVE_KEY_PATTERN = ', '\n')
    expect(mainPattern).not.toBeNull()
    expect(srcPattern).not.toBeNull()
    expect(mainPattern).toBe(srcPattern)
    // 光比字面还不够：真正生效的那份必须也相同（防止 main.cjs 里另有一个变体）
    expect(mainPattern).toBe(String(SENSITIVE_KEY_PATTERN))
  })

  it('P3 四个路径形状正则逐字符相同', () => {
    const pairs = [
      ['IS_ABSOLUTE_RE', 'const IS_ABSOLUTE_RE = '],
      ['WHOLE_PATH_RE', 'const WHOLE_PATH_RE = ']
    ]
    for (const [name, decl] of pairs) {
      const mainRe = sliceDecl(MAIN_SRC, decl, '\n')
      const srcRe = sliceDecl(SANITIZE_SRC, decl, '\n')
      expect(mainRe, `${name} 在 main.cjs 中缺失`).not.toBeNull()
      expect(srcRe, `${name} 在 logSanitize.js 中缺失`).not.toBeNull()
      expect(mainRe, `${name} 两侧不一致`).toBe(srcRe)
    }

    // EMBEDDED_PATH_RE 是跨行构造的 new RegExp(...)，单独取（见 sliceEmbedded）
    const mainEmbedded = sliceEmbedded(MAIN_SRC)
    const srcEmbedded = sliceEmbedded(SANITIZE_SRC)
    expect(mainEmbedded, 'main.cjs 缺少 EMBEDDED_PATH_RE').not.toBeNull()
    expect(srcEmbedded, 'logSanitize.js 缺少 EMBEDDED_PATH_RE').not.toBeNull()
    expect(mainEmbedded).toBe(srcEmbedded)
  })

  it('P4 家目录识别模式逐条相同', () => {
    const mainHomes = sliceDecl(MAIN_SRC, 'const HOME_ROOT_PATTERNS = [', '\n]')
    const srcHomes = sliceDecl(SANITIZE_SRC, 'const HOME_ROOT_PATTERNS = [', '\n]')
    expect(mainHomes).not.toBeNull()
    expect(srcHomes).not.toBeNull()
    expect(mainHomes).toBe(srcHomes)
    // 至少得覆盖 macOS / Linux 两种家目录形状，否则遮蔽形同虚设
    expect(mainHomes).toContain('Users')
    expect(mainHomes).toContain('home')
  })

  it('P5 省略符与替换标记同值', () => {
    // logSanitize 里是 const ELLIPSIS = '\u2026'，main.cjs 里同名同写法
    expect(MAIN_SRC).toContain("const ELLIPSIS = '\\u2026'")
    expect(SANITIZE_SRC).toContain("const ELLIPSIS = '\\u2026'")
    expect(MAIN_SRC).toContain("const REDACTED = '[REDACTED]'")
    expect(SANITIZE_SRC).toContain("export const REDACTED = '[REDACTED]'")
  })

  it('P6 脱敏的截断上限与 constants/logging.js 同值', () => {
    // 主进程侧给字符串的上限必须与 LOG_CONTENT_MAX 相等：
    // 两边不一致会让「同一条消息」在渲染侧和主进程侧被截成不同长度。
    expect(mainNumber('LOG_CONTENT_MAX')).toBe(LOG_CONTENT_MAX)
    expect(mainNumber('LOG_MAX_STRING')).toBe(LOG_MAX_STRING)
    expect(mainNumber('LOG_MAX_DEPTH')).toBe(LOG_MAX_DEPTH)
    // logSanitize.js 自己的默认值同样要等于常量（那份是「刻意重复、有注释标注」的）
    expect(SANITIZE_SRC).toContain('DEFAULT_CONTENT_MAX = 120')
    expect(LOG_CONTENT_MAX).toBe(120)
  })
})

describe('main.cjs 与 constants/logging.js 的常量一致性', () => {
  it('P7 落盘与轮转参数同值', () => {
    expect(mainNumber('LOG_MAX_BYTES')).toBe(LOG_MAX_BYTES)
    expect(mainNumber('LOG_KEEP_DAYS')).toBe(LOG_KEEP_DAYS)
    expect(mainNumber('LOG_MAX_FILES')).toBe(LOG_MAX_FILES)
    expect(mainString('LOG_DIR_NAME')).toBe(LOG_DIR_NAME)
    expect(mainString('LOG_FILE_NAME')).toBe(LOG_FILE_NAME)
    // 口径落在实处：2MB / 7 天 / 7 个文件
    expect(LOG_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(LOG_MAX_FILES).toBe(7)
  })

  it('P8 级别表与默认级别同值', () => {
    // LOG_LEVELS 在 main.cjs 里是对象字面量，逐个键比对
    for (const [level, weight] of Object.entries(LOG_LEVELS)) {
      const m = MAIN_SRC.match(new RegExp(`${level}:\\s*(\\d+)`))
      expect(m, `main.cjs 缺少级别 ${level}`).not.toBeNull()
      expect(Number(m[1]), `级别 ${level} 权重不一致`).toBe(weight)
    }
    expect(mainString('DEFAULT_LOG_LEVEL')).toBe(DEFAULT_LOG_LEVEL)
  })

  it('P9 行格式参数同值（否则两侧行文本不可能逐字节一致）', () => {
    expect(mainNumber('LOG_LEVEL_WIDTH')).toBe(LOG_LEVEL_WIDTH)
    // LOG_FIELD_SEP 是两个空格，比对的是实际字符而不是源码里的引号
    const m = MAIN_SRC.match(/const LOG_FIELD_SEP = '(.*)'/)
    expect(m).not.toBeNull()
    expect(m[1]).toBe(LOG_FIELD_SEP)
    expect(LOG_FIELD_SEP).toBe('  ')
  })

  it('P10 模块名约定覆盖 logging.js 的全部模块', () => {
    // 主进程用 LOG_MODULES.ipc 作为自产记录的模块名 —— 这个键必须在表里
    for (const name of Object.values(LOG_MODULES)) {
      expect(MAIN_SRC, `main.cjs 的 LOG_MODULES 缺少 ${name}`).toContain(`${name}: '${name}'`)
    }
    expect(LOG_MODULES.ipc).toBe('ipc')
  })
})
