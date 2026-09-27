import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  MAX_NAME_BYTES,
  FALLBACK_NAME,
  sanitizeFileName,
  dedupeFileName,
  isReservedDeviceName,
  truncateBytes,
  normalizeDisplayPath,
  extOf
} from '../src/utils/fileNaming.js'

/**
 * UTF-8 字节长度。vitest 的 jsdom 环境不保证挂 TextEncoder，
 * 所以优先用 Node 的 Buffer，两者都没有时才回退。
 * @param {string} s 输入
 * @returns {number} 字节数
 */
const bytesOf = (s) => {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8')
  return new TextEncoder().encode(s).length
}

/** 取词干（去掉扩展名）用于断言，避免把断言写成对实现的复述 */
const stemOf = (name) => {
  const ext = extOf(name)
  return ext ? name.slice(0, name.length - ext.length) : name
}

describe('isReservedDeviceName', () => {
  it('识别 CON / PRN / AUX / NUL 四个无编号保留名', () => {
    expect(isReservedDeviceName('CON')).toBe(true)
    expect(isReservedDeviceName('PRN')).toBe(true)
    expect(isReservedDeviceName('AUX')).toBe(true)
    expect(isReservedDeviceName('NUL')).toBe(true)
  })

  it('大小写不敏感（Win32 判定设备名时忽略大小写）', () => {
    expect(isReservedDeviceName('con')).toBe(true)
    expect(isReservedDeviceName('nUl')).toBe(true)
    expect(isReservedDeviceName('lpt1')).toBe(true)
  })

  it('识别带扩展名的形式：NUL.md 在 Win32 里同样指向空设备', () => {
    expect(isReservedDeviceName('NUL.md')).toBe(true)
    expect(isReservedDeviceName('CON.foo.md')).toBe(true)
    expect(isReservedDeviceName('aux.txt.bak')).toBe(true)
  })

  it('识别 COM1-9 / LPT1-9', () => {
    for (let n = 1; n <= 9; n += 1) {
      expect(isReservedDeviceName(`COM${n}`)).toBe(true)
      expect(isReservedDeviceName(`LPT${n}`)).toBe(true)
    }
  })

  it('结尾空格仍算保留名（Win32 会先裁尾部再判定）', () => {
    expect(isReservedDeviceName('NUL ')).toBe(true)
    expect(isReservedDeviceName('CON..')).toBe(true)
  })

  it('不误伤 CONSOLE / CON1 / COM0 / LPT10 这类合法文件名', () => {
    expect(isReservedDeviceName('CONSOLE')).toBe(false)
    expect(isReservedDeviceName('CON1')).toBe(false)
    expect(isReservedDeviceName('COM0')).toBe(false)
    expect(isReservedDeviceName('LPT10')).toBe(false)
    expect(isReservedDeviceName('NULL')).toBe(false)
  })

  it('加过下划线前缀的名字不再保留', () => {
    expect(isReservedDeviceName('_CON')).toBe(false)
    expect(isReservedDeviceName('_NUL.md')).toBe(false)
  })
})

describe('truncateBytes', () => {
  it('按字节截断 ASCII', () => {
    expect(truncateBytes('abcdef', 3)).toBe('abc')
    expect(truncateBytes('abcdef', 100)).toBe('abcdef')
  })

  it('绝不把 3 字节的汉字切一半', () => {
    expect(truncateBytes('汉汉汉', 4)).toBe('汉')
    expect(truncateBytes('汉汉汉', 6)).toBe('汉汉')
    expect(truncateBytes('汉汉汉', 8)).toBe('汉汉')
    expect(truncateBytes('汉汉汉', 9)).toBe('汉汉汉')
  })

  it('绝不把 4 字节的 emoji 切成孤立代理项', () => {
    const one = truncateBytes('😀😀', 5)
    expect(Array.from(one).length).toBe(1)
    expect(bytesOf(one)).toBe(4)
    // 孤立代理项在 UTF-8 编码下会变成 U+FFFD，这里必须一个都没有
    expect(one.includes('\uFFFD')).toBe(false)
  })

  it('结果字节数永不超过上限', () => {
    const long = 'a'.repeat(100) + '汉'.repeat(100) + '😀'.repeat(20)
    for (let max = 0; max <= 40; max += 1) {
      expect(bytesOf(truncateBytes(long, max))).toBeLessThanOrEqual(max)
    }
  })

  it('上限 <= 0 或首字符就超限时返回空串', () => {
    expect(truncateBytes('abc', 0)).toBe('')
    expect(truncateBytes('abc', -1)).toBe('')
    expect(truncateBytes('汉', 2)).toBe('')
  })

  it('非法上限回落到默认 255 字节', () => {
    expect(truncateBytes('a'.repeat(300), undefined)).toBe('a'.repeat(255))
    expect(truncateBytes('a'.repeat(300), Number.NaN)).toBe('a'.repeat(255))
  })
})

describe('extOf', () => {
  it('返回带前导点的扩展名（与 node 的 path.extname 同语义）', () => {
    expect(extOf('a.md')).toBe('.md')
    expect(extOf('a.markdown')).toBe('.markdown')
    expect(extOf('a.b.md')).toBe('.md')
  })

  it('无扩展名时返回空串', () => {
    expect(extOf('a')).toBe('')
    expect(extOf('')).toBe('')
    expect(extOf('folder/a')).toBe('')
  })

  it('点文件不算有扩展名（否则消解会造出 " 1.gitignore"）', () => {
    expect(extOf('.gitignore')).toBe('')
  })

  it('只取最后一段路径的扩展名，两种分隔符都认', () => {
    expect(extOf('folder/sub/a.md')).toBe('.md')
    expect(extOf('C:\\notes\\a.md')).toBe('.md')
    expect(extOf('folder.md/a')).toBe('')
  })
})

describe('dedupeFileName', () => {
  it('不冲突时原样返回', () => {
    expect(dedupeFileName('a.md', new Set(['b.md']))).toBe('a.md')
    expect(dedupeFileName('a.md', null)).toBe('a.md')
    expect(dedupeFileName('a.md')).toBe('a.md')
  })

  it('冲突时序号加在扩展名之前（对标 Obsidian 的空格 + 序号）', () => {
    expect(dedupeFileName('a.md', new Set(['a.md']))).toBe('a 1.md')
    expect(dedupeFileName('a.md', new Set(['a.md', 'a 1.md']))).toBe('a 2.md')
    expect(dedupeFileName('a.md', new Set(['a.md', 'a 1.md', 'a 2.md']))).toBe('a 3.md')
  })

  it('无扩展名时序号直接接在名字后面', () => {
    expect(dedupeFileName('a', new Set(['a']))).toBe('a 1')
  })

  it('接受数组形式的已存在名集合', () => {
    expect(dedupeFileName('笔记.md', ['笔记.md', '笔记 1.md'])).toBe('笔记 2.md')
  })

  it('不修改传入的集合（纯函数，避免污染调用方的目录快照）', () => {
    const taken = new Set(['a.md'])
    dedupeFileName('a.md', taken)
    expect(taken.size).toBe(1)
    expect(taken.has('a 1.md')).toBe(false)
  })

  it('同一入参多次调用结果一致', () => {
    const taken = new Set(['a.md'])
    expect(dedupeFileName('a.md', taken)).toBe(dedupeFileName('a.md', taken))
  })
})

describe('sanitizeFileName — Windows 保留设备名（验收点 ①）', () => {
  it('CON 落盘为 _CON.md，不再指向控制台设备', () => {
    const result = sanitizeFileName('CON', 'md')
    expect(result).toBe('_CON.md')
    expect(isReservedDeviceName(result)).toBe(false)
  })

  it('NUL.md 落盘为合法名，不再指向空设备', () => {
    expect(sanitizeFileName('NUL.md', '')).toBe('_NUL.md')
    expect(isReservedDeviceName(sanitizeFileName('NUL.md', ''))).toBe(false)
  })

  it('标题带 .md 且又传 ext=md 时按现有追加语义处理（词干先脱设备名）', () => {
    // 现状 safeFileName 就是无脑追加扩展名，本内核不改变这一点；
    // 关键是不管怎么拼，产出的词干都必须是 '_NUL.md' 而不是 'NUL.md'。
    const result = sanitizeFileName('NUL.md', 'md')
    expect(result).toBe('_NUL.md.md')
    expect(stemOf(result)).toBe('_NUL.md')
    expect(isReservedDeviceName(result)).toBe(false)
  })

  it('AUX 落盘为 _AUX.md', () => {
    expect(sanitizeFileName('AUX', 'md')).toBe('_AUX.md')
  })

  it('LPT1 落盘为 _LPT1.md', () => {
    expect(sanitizeFileName('LPT1', 'md')).toBe('_LPT1.md')
    expect(isReservedDeviceName(sanitizeFileName('LPT1', 'md'))).toBe(false)
  })

  it('COM1-9 / LPT1-9 全段覆盖', () => {
    for (let n = 1; n <= 9; n += 1) {
      expect(sanitizeFileName(`COM${n}`, 'md')).toBe(`_COM${n}.md`)
      expect(sanitizeFileName(`LPT${n}`, 'md')).toBe(`_LPT${n}.md`)
    }
  })

  it('非保留名不被误加前缀', () => {
    expect(sanitizeFileName('CONSOLE', 'md')).toBe('CONSOLE.md')
    expect(sanitizeFileName('COM0', 'md')).toBe('COM0.md')
    expect(sanitizeFileName('LPT10', 'md')).toBe('LPT10.md')
    expect(sanitizeFileName('NULL', 'md')).toBe('NULL.md')
  })

  it('控制字符剥掉之后才判定保留名（顺序 ① 在 ④ 之前）', () => {
    expect(sanitizeFileName('CON\u0000', 'md')).toBe('_CON.md')
    expect(sanitizeFileName('NUL\u001F', 'md')).toBe('_NUL.md')
  })
})

describe('sanitizeFileName — 结尾空格与点（验收点 ②）', () => {
  it('剥掉结尾空格', () => {
    expect(sanitizeFileName('note ', 'md')).toBe('note.md')
    expect(sanitizeFileName('笔记   ', 'md')).toBe('笔记.md')
  })

  it('剥掉结尾的点', () => {
    expect(sanitizeFileName('note.', 'md')).toBe('note.md')
    expect(sanitizeFileName('note...', 'md')).toBe('note.md')
  })

  it('空格与点混合的尾巴一并剥掉', () => {
    expect(sanitizeFileName('note . ', 'md')).toBe('note.md')
    expect(sanitizeFileName('note. .', 'md')).toBe('note.md')
  })

  it('扩展名由调用方给定时，词干同样不留尾巴', () => {
    expect(sanitizeFileName('note ', '')).toBe('note')
    expect(sanitizeFileName('note. ', '')).toBe('note')
  })

  it('中间的空格与点保留（只有结尾是非法的）', () => {
    expect(sanitizeFileName('note 1. draft', 'md')).toBe('note 1. draft.md')
  })

  it('全是点或空格时回退兜底名', () => {
    expect(sanitizeFileName('...', 'md')).toBe(`${FALLBACK_NAME}.md`)
    expect(sanitizeFileName('   ', 'md')).toBe(`${FALLBACK_NAME}.md`)
  })

  it('任意输入产出的词干都不以空格或点结尾', () => {
    const titles = ['a ', 'a.', 'a .', '笔记 .', 'a\\', 'a/', 'a* ']
    for (const title of titles) {
      const result = sanitizeFileName(title, 'md')
      expect(stemOf(result)).not.toMatch(/[. ]$/)
    }
  })
})

describe('sanitizeFileName — 控制字符与非法字符（验收点 ③）', () => {
  it('清除控制字符而不是转义它们', () => {
    expect(sanitizeFileName('a\u0000b', 'md')).toBe('ab.md')
    expect(sanitizeFileName('笔记\u0007', 'md')).toBe('笔记.md')
    expect(sanitizeFileName('a\u0009b\u001Fc', 'md')).toBe('abc.md')
  })

  it('只剩控制字符时回退兜底名', () => {
    expect(sanitizeFileName('\u0000\u001F', 'md')).toBe(`${FALLBACK_NAME}.md`)
  })

  it('非法字符替换成下划线，且不会粘连成难读的一坨', () => {
    expect(sanitizeFileName('a/b', 'md')).toBe('a_b.md')
    expect(sanitizeFileName('a:b*c?d"e<f>g|h', 'md')).toBe('a_b_c_d_e_f_g_h.md')
  })

  it('路径分隔符被吃掉，返回值永远不含目录层级', () => {
    const result = sanitizeFileName('../../etc/passwd', 'md')
    expect(result).toBe('.._.._etc_passwd.md')
    expect(result).not.toMatch(/[\\/]/)
  })

  it('反斜杠同样被吃掉（Windows 分隔符）', () => {
    expect(sanitizeFileName('sub\\note', 'md')).toBe('sub_note.md')
  })
})

describe('sanitizeFileName — 255 字节 UTF-8 安全截断（验收点 ③）', () => {
  it('默认上限是 255 字节', () => {
    expect(MAX_NAME_BYTES).toBe(255)
  })

  it('3 字节汉字：截断后整名正好 255 字节', () => {
    const result = sanitizeFileName('汉'.repeat(200), 'md')
    expect(bytesOf(result)).toBe(255)
    expect(result).toBe(`${'汉'.repeat(84)}.md`)
  })

  it('4 字节 emoji：截断后整名正好 255 字节', () => {
    const result = sanitizeFileName('😀'.repeat(100), 'md')
    expect(bytesOf(result)).toBe(255)
    expect(Array.from(result).length).toBe(63 + 3)
    expect(result.includes('\uFFFD')).toBe(false)
  })

  it('1 字节 ASCII：截断后整名正好 255 字节', () => {
    const result = sanitizeFileName('a'.repeat(300), 'md')
    expect(bytesOf(result)).toBe(255)
    expect(result).toBe(`${'a'.repeat(252)}.md`)
  })

  it('扩展名更长的字节也要先从预算里扣掉', () => {
    const result = sanitizeFileName('a'.repeat(300), 'markdown')
    expect(bytesOf(result)).toBe(255)
    expect(result).toBe(`${'a'.repeat(246)}.markdown`)
  })

  it('绝不产出半个汉字（不出现替换字符，且字节数不越界）', () => {
    const result = sanitizeFileName(`${'a'.repeat(251)}汉字`, 'md')
    expect(bytesOf(result)).toBeLessThanOrEqual(255)
    expect(result).toBe(`${'a'.repeat(251)}.md`)
    expect(result.includes('\uFFFD')).toBe(false)
    expect(result.includes('汉')).toBe(false)
  })

  it('maxBytes 可通过选项收紧', () => {
    const result = sanitizeFileName('汉'.repeat(100), 'md', { maxBytes: 12 })
    expect(result).toBe('汉汉汉.md')
    expect(bytesOf(result)).toBe(12)
  })

  it('截断后若重新露出结尾空格，会再剥一次', () => {
    // 252 个 'a' 后面正好是空格：截断后末尾是空格，必须再剥掉
    const title = `${'a'.repeat(252)} `
    const result = sanitizeFileName(title, 'md')
    expect(result).toBe(`${'a'.repeat(252)}.md`)
    expect(stemOf(result)).not.toMatch(/[. ]$/)
  })
})

describe('sanitizeFileName — 空值兜底与扩展名规范', () => {
  it('空 / null 标题回退到兜底名', () => {
    expect(sanitizeFileName('', 'md')).toBe(`${FALLBACK_NAME}.md`)
    expect(sanitizeFileName(null, 'md')).toBe(`${FALLBACK_NAME}.md`)
    expect(sanitizeFileName(undefined, 'md')).toBe(`${FALLBACK_NAME}.md`)
  })

  it('ext 传 "md" 与 ".md" 结果一致', () => {
    expect(sanitizeFileName('笔记', 'md')).toBe('笔记.md')
    expect(sanitizeFileName('笔记', '.md')).toBe('笔记.md')
  })

  it('ext 为空时不追加点', () => {
    expect(sanitizeFileName('笔记', '')).toBe('笔记')
    expect(sanitizeFileName('笔记', null)).toBe('笔记')
  })

  it('ext 自身带非法字符时被净化（防止拼出路径穿越）', () => {
    expect(sanitizeFileName('笔记', '.m/d')).toBe('笔记.md')
    expect(sanitizeFileName('笔记', '..')).toBe('笔记')
  })

  it('正常输入不被改动', () => {
    expect(sanitizeFileName('我的笔记', 'md')).toBe('我的笔记.md')
    expect(sanitizeFileName('2026-03-15 周报', 'md')).toBe('2026-03-15 周报.md')
  })
})

describe('sanitizeFileName — 同名消解（验收点 ④）', () => {
  it('传入已存在名集合时自动消解', () => {
    expect(sanitizeFileName('笔记', 'md', { taken: new Set(['笔记.md']) })).toBe('笔记 1.md')
    expect(sanitizeFileName('笔记', 'md', { taken: new Set(['笔记.md', '笔记 1.md']) })).toBe('笔记 2.md')
  })

  it('与合法化联动：CON 且已存在 _CON.md 时得到 _CON 1.md', () => {
    const result = sanitizeFileName('CON', 'md', { taken: new Set(['_CON.md']) })
    expect(result).toBe('_CON 1.md')
    expect(isReservedDeviceName(result)).toBe(false)
  })

  it('连续新建 3 篇同名笔记得到 3 个互不覆盖的文件', () => {
    const taken = new Set()
    const created = []
    for (let i = 0; i < 3; i += 1) {
      const name = sanitizeFileName('笔记', 'md', { taken })
      created.push(name)
      taken.add(name)
    }
    expect(created).toEqual(['笔记.md', '笔记 1.md', '笔记 2.md'])
    expect(new Set(created).size).toBe(3)
  })

  it('消解序号是在截断之后追加的，必须把词干再截回来（否则超出 255 字节）', () => {
    const base = '汉'.repeat(200)
    const first = sanitizeFileName(base, 'md')
    expect(bytesOf(first)).toBe(255)

    const second = sanitizeFileName(base, 'md', { taken: new Set([first]) })
    expect(second).toBe(`${'汉'.repeat(83)} 1.md`)
    expect(bytesOf(second)).toBeLessThanOrEqual(255)
    expect(second).not.toBe(first)
  })

  it('序号很大时同样不越界', () => {
    const taken = new Set(['笔记.md', '笔记 1.md', '笔记 2.md', '笔记 3.md'])
    expect(sanitizeFileName('笔记', 'md', { taken })).toBe('笔记 4.md')
  })
})

describe('normalizeDisplayPath', () => {
  it('反斜杠统一成正斜杠', () => {
    expect(normalizeDisplayPath('C:\\notes\\sub\\a.md')).toBe('C:/notes/sub/a.md')
    expect(normalizeDisplayPath('notes\\a.md')).toBe('notes/a.md')
  })

  it('正斜杠路径保持原样', () => {
    expect(normalizeDisplayPath('/home/user/notes/a.md')).toBe('/home/user/notes/a.md')
  })

  it('折叠重复斜杠', () => {
    expect(normalizeDisplayPath('/notes//sub///a.md')).toBe('/notes/sub/a.md')
  })

  it('去掉结尾斜杠（保留根目录与盘符根）', () => {
    expect(normalizeDisplayPath('/notes/sub/')).toBe('/notes/sub')
    expect(normalizeDisplayPath('/')).toBe('/')
    expect(normalizeDisplayPath('C:/')).toBe('C:/')
  })

  it('保留 UNC 的前导双斜杠', () => {
    expect(normalizeDisplayPath('\\\\server\\share\\a.md')).toBe('//server/share/a.md')
  })

  it('空值返回空串', () => {
    expect(normalizeDisplayPath('')).toBe('')
    expect(normalizeDisplayPath(null)).toBe('')
    expect(normalizeDisplayPath(undefined)).toBe('')
  })

  it('不解析 . / .. 段（日志里必须能看到真实路径）', () => {
    expect(normalizeDisplayPath('notes/./sub/../a.md')).toBe('notes/./sub/../a.md')
  })
})

describe('纯函数 / 零 import 约束（验收点 ⑤）', () => {
  // 用 path.resolve 拼绝对路径：本机把 URL 对象交给 readFileSync 会抛
  // "The URL must be of scheme file"（CLI 的 fs 代理层不接受 URL 入参）。
  const source = readFileSync(path.resolve(process.cwd(), 'src/utils/fileNaming.js'), 'utf8')

  it('源码不含任何 import / require（可在主进程直接复用）', () => {
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })

  it('源码不含裸控制字符（项目硬约束，含裸 NUL 会被 git 当二进制）', () => {
    expect(source.includes('\u0000')).toBe(false)
    for (let code = 0; code <= 0x1f; code += 1) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue
      expect(source.includes(String.fromCharCode(code))).toBe(false)
    }
  })

  it('导出的都是函数，常量是字面量', () => {
    expect(typeof sanitizeFileName).toBe('function')
    expect(typeof dedupeFileName).toBe('function')
    expect(typeof isReservedDeviceName).toBe('function')
    expect(typeof truncateBytes).toBe('function')
    expect(typeof normalizeDisplayPath).toBe('function')
    expect(typeof extOf).toBe('function')
    expect(MAX_NAME_BYTES).toBe(255)
    expect(FALLBACK_NAME).toBe('无标题')
  })

  it('同入参重复调用结果完全一致（不读时钟 / 不读磁盘）', () => {
    const taken = new Set(['笔记.md'])
    const first = sanitizeFileName('笔记', 'md', { taken })
    const second = sanitizeFileName('笔记', 'md', { taken })
    expect(first).toBe(second)
    // 不写回 taken：调用方自己决定何时登记新名字
    expect(taken.size).toBe(1)
  })
})
