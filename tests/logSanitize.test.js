/**
 * tests/logSanitize.test.js —— 日志脱敏（src/utils/logSanitize.js）的回归守卫
 *
 * 为什么单独一个文件：logSanitize 是**整个日志系统的安全边界**——它是唯一能让「用户
 * 把日志直接贴进 GitHub Issue」（R-L6）成立的一层。它与 logger 的耦合点只有一处
 * （logger.applySanitize），因此这里的断言全部对着**纯函数**打，不需要任何替身，
 * 也不需要 Reset 全局状态（模块零状态），可以与 logger.test.js 并行演进。
 *
 * 覆盖地图：
 *   A. 敏感 key 判定 —— T08 补强记录里的实测清单，**逐条**转断言（含「刻意不命中」与「已知漏网」）
 *   B. isSecretEntry —— truthy 判定而非 === true（宁可多遮不可漏遮）
 *   C. redactPath —— 家目录剥离 + 保留一级父目录（验收标准 4）
 *   D. redactContent —— 按码点截断 + 控制字符折叠成转义文本
 *   E. sanitizeValue 结构化脱敏 —— sensitive key / secret 条目 / Error / Map·Set / 平台对象
 *   F. 失败即遮蔽（fail closed）与健壮性 —— 敌意 getter、Proxy、环、超深、超量预算
 *   G. 自由文本里的路径 —— 含 URL 保护与 CJK 语境
 *   H. 【已知边界】当前确实失守的场景 —— 诚实记录，未来补齐时这里的断言必须跟着改
 *   I. 结构性约束 —— 零 import、源码无裸 NUL 字节
 *
 * 两条写作纪律：
 *   · 控制字符一律用 String.fromCharCode(n) 构造，源码里不出现裸字节（项目硬约束）。
 *   · 「刻意不命中」与「已知漏网」都必须断言**当前的真实行为**，而不是假装它已被保护；
 *     后者一旦将来被修好，本文件会变红——那是**预期内的红**，改断言即代表口径已升级。
 */

import { describe, it, expect } from 'vitest'
import {
  REDACTED,
  SENSITIVE_KEY_PATTERN,
  SECRET_ENTRY_EXTRA_KEYS,
  isSensitiveKey,
  isSecretEntry,
  redactPath,
  redactContent,
  sanitizeValue
} from '../src/utils/logSanitize'

/** 路径省略符（U+2026）。与 logSanitize.js 的 ELLIPSIS 同字符，刻意在此重写一份以保证断言可读 */
const ELLIPSIS = '\u2026'

/**
 * 控制字符全部经 charCode 构造，避免在源码里出现裸字节：
 * LF=10 / CR=13 / TAB=9 / NUL=0 / DEL=127
 */
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const TAB = String.fromCharCode(9)
const NUL = String.fromCharCode(0)
const DEL = String.fromCharCode(127)

/** 控制字符（含 DEL）是否真的不存在于结果里 —— 用来证明折叠成了「文本」而非原始字节 */
function hasRawControlChar (s) {
  return /[\u0000-\u001F\u007F]/.test(String(s))
}

// ---------------------------------------------------------------------------
// A. 敏感 key 判定：T08 实测清单全量转断言
// ---------------------------------------------------------------------------

/** 原本就命中（无需补强） */
const HIT_ORIGINAL = [
  'password', 'apiKey', 'api_key', 'value', 'valueEnc', 'private',
  'apiKeyValue', 'apiSecret', 'accessToken', 'authToken', 'refreshToken',
  'idToken', 'clientSecret'
]

/** 2026-09-27 补强后命中：三个「敏感词在中间、类型后缀在结尾」的复合词 */
const HIT_REINFORCED = ['privateKey', 'secretKey', 'accessKey']

/** 刻意不命中 —— 防误伤。去掉结尾锚 $ 后这批会大批误伤，本组就是那道防线的守卫 */
const NOT_HIT = ['passwords', 'values', 'evaluated', 'tokens', 'credentials']

/**
 * 【已知边界】当前仍未命中的高危命名 —— 诚实记录。
 * T08 的裁决是「补 3 个复合词，不去锚」，这批因此处于失守状态。
 * 将来若有人把这些词补进 SENSITIVE_KEY_PATTERN，本用例会变红——那是**好消息**，
 * 请把它们从本组移到上面的 HIT_* 组，而不是放宽断言。
 */
const KNOWN_MISSING = [
  'passwordHash', 'token_str', 'credentialId', 'sessionId', 'cookie',
  'authorization', 'cvv', 'pin', 'mfaCode', 'otp', 'mnemonic'
]

describe('A. 敏感 key 判定（T08 实测清单全量）', () => {
  it('原本就命中的 13 个 key 全部判定为敏感', () => {
    for (const key of HIT_ORIGINAL) {
      expect(isSensitiveKey(key), `key=${key} 应命中敏感名单`).toBe(true)
    }
    expect(HIT_ORIGINAL.length).toBe(13)
  })

  it('补强后命中的 3 个复合词（privateKey / secretKey / accessKey）判定为敏感', () => {
    for (const key of HIT_REINFORCED) {
      expect(isSensitiveKey(key), `key=${key} 应命中（T08 补强项）`).toBe(true)
    }
  })

  it('privateKey 命中是刻意的：它装的是 PEM 私钥全文，漏了等于失窃', () => {
    // 同一家族的 SSH 私钥写法也必须一并覆盖
    for (const key of ['privateKey', 'sshPrivateKey', 'PRIVATEKEY', 'privatekey']) {
      expect(isSensitiveKey(key), `key=${key}`).toBe(true)
    }
  })

  it('刻意不命中的 5 个 key —— 防误伤，一个都不许命中', () => {
    for (const key of NOT_HIT) {
      expect(isSensitiveKey(key), `key=${key} 属于普通业务字段，命中即误伤`).toBe(false)
    }
  })

  it('【已知边界】仍漏网的 11 个高危 key：当前**确实**（记录用，非背书）', () => {
    for (const key of KNOWN_MISSING) {
      expect(isSensitiveKey(key), `key=${key} 已从漏网名单毕业，请把它移进 HIT_* 组`).toBe(false)
    }
    expect(KNOWN_MISSING.length).toBe(11)
  })

  it('判定对大小写不敏感（API_KEY / TOKEN / Password 同样命中）', () => {
    for (const key of ['API_KEY', 'TOKEN', 'Password', 'aPiKeY', 'VALUEENC']) {
      expect(isSensitiveKey(key), `key=${key}`).toBe(true)
    }
  })

  it('非字符串 / 空串 key 一律不算敏感（交回上层按普通值处理）', () => {
    for (const key of [null, undefined, '', 0, 42, true, {}, [], Symbol('x')]) {
      expect(isSensitiveKey(key), `key=${String(key)}`).toBe(false)
    }
  })

  it('SENSITIVE_KEY_PATTERN 保留结尾锚 $（去掉它 NOT_HIT 那批就会误伤）', () => {
    expect(SENSITIVE_KEY_PATTERN.source.endsWith('$')).toBe(true)
    expect(SENSITIVE_KEY_PATTERN.flags).toContain('i')
    // 全局标志会让 test() 有状态，必须是无 g 的
    expect(SENSITIVE_KEY_PATTERN.flags).not.toContain('g')
  })

  it('SECRET_ENTRY_EXTRA_KEYS 的口径恰好是 [key, note]', () => {
    expect([...SECRET_ENTRY_EXTRA_KEYS]).toEqual(['key', 'note'])
  })

  it('REDACTED 是整体替换标记，不是首尾保留的部分遮蔽（区别于 vault.js 的 mask()）', () => {
    // 与给 UI 用的 mask() 的关键差异：日志里不留任何首尾字符
    expect(REDACTED).toBe('[REDACTED]')
    expect(REDACTED.length).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// B. isSecretEntry
// ---------------------------------------------------------------------------

describe('B. isSecretEntry（truthy 判定，宁可多遮不可漏遮）', () => {
  it('secret 为真值时判定为敏感条目', () => {
    expect(isSecretEntry({ secret: true })).toBe(true)
    // 将来若有人把 secret 写成字符串/数字，仍必须按敏感处理
    expect(isSecretEntry({ secret: 1 })).toBe(true)
    expect(isSecretEntry({ secret: 'true' })).toBe(true)
    expect(isSecretEntry({ secret: 'no' })).toBe(true) // 非空字符串即 truthy
  })

  it('secret 为假值或缺字段时不是敏感条目', () => {
    expect(isSecretEntry({ secret: false })).toBe(false)
    expect(isSecretEntry({ secret: 0 })).toBe(false)
    expect(isSecretEntry({ secret: '' })).toBe(false)
    expect(isSecretEntry({ secret: null })).toBe(false)
    expect(isSecretEntry({ secret: undefined })).toBe(false)
    expect(isSecretEntry({})).toBe(false)
  })

  it('null / undefined / 原始值 / 函数都不算敏感条目（安全退化，不抛）', () => {
    for (const v of [null, undefined, 'x', 42, true, []]) {
      expect(isSecretEntry(v), `v=${String(v)}`).toBe(false)
    }
    const fn = () => {}
    fn.secret = true
    expect(isSecretEntry(fn)).toBe(false) // typeof function 不是 'object'
  })
})

// ---------------------------------------------------------------------------
// C. redactPath（验收标准 4：家目录不出现在输出中）
// ---------------------------------------------------------------------------

describe('C. redactPath —— 家目录剥离与「保留一级父目录」口径', () => {
  /** [输入, 显式 home, 期望输出] */
  const CASES = [
    // —— design §3.4 / §4.4 的样例行，必须逐字符对上 ——
    ['/Users/alice/notes/a.md', '', `${ELLIPSIS}/notes/a.md`],
    ['/Users/alice/a.md', '', `${ELLIPSIS}/a.md`],
    ['C:\\Users\\alice\\AppData\\x.json', '', `${ELLIPSIS}/AppData/x.json`],
    ['notes/a.md', '', `${ELLIPSIS}/notes/a.md`],
    ['a.md', '', 'a.md'],
    // 形状兜底：三大平台家目录常见写法
    ['/home/alice/notes/a.md', '', `${ELLIPSIS}/notes/a.md`],
    ['/root/a.md', '', `${ELLIPSIS}/a.md`],
    // XP 遗留写法：HOME 模式会把 "/Documents and Settings/<user>" 整段（含用户名）剥掉
    ['/Documents and Settings/alice/x.md', '', `${ELLIPSIS}/x.md`]
  ]

  it('design 样例逐条命中（保留 basename 与一级父目录，更上层折叠成 …/）', () => {
    for (const [input, home, want] of CASES) {
      expect(redactPath(input, { home }), `input=${input}`).toBe(want)
    }
  })

  it('重复分隔符必须先折叠再识别家目录（dir 以斜杠结尾的拼接习惯不能让家目录漏出）', () => {
    expect(redactPath('/Users/alice//notes/a.md')).toBe(`${ELLIPSIS}/notes/a.md`)
    expect(redactPath('C:\\\\Users\\\\alice\\\\notes\\\\a.md')).toBe(`${ELLIPSIS}/notes/a.md`)
  })

  it('显式 home 优先级高于形状识别', () => {
    expect(redactPath('/home/alice/notes/a.md', { home: '/home/alice' })).toBe(`${ELLIPSIS}/notes/a.md`)
    expect(redactPath('C:\\Users\\alice\\notes\\a.md', { home: 'C:/Users/alice' })).toBe(`${ELLIPSIS}/notes/a.md`)
    // 一个形状识别认不出的自定义根：只能靠显式 home
    expect(redactPath('/data/vault/users/bob/a.md', { home: '/data/vault/users/bob' })).toBe(`${ELLIPSIS}/a.md`)
  })

  it('显式 home 大小写与结尾斜杠差异都能容忍', () => {
    expect(redactPath('/Users/alice/a.md', { home: '/USERS/ALICE/' })).toBe(`${ELLIPSIS}/a.md`)
    expect(redactPath('/Users/alice/a.md', { home: '/users/alice' })).toBe(`${ELLIPSIS}/a.md`)
  })

  it('家目录自身（剩余为空）返回省略符：实现返回 …/ ，与 JSDoc 样例「…」有一处漂移', () => {
    // 注：JSDoc 第 274 行写的是 `'/Users/alice' → '…'`，实际实现 return `${ELLIPSIS}/`。
    // 本断言以**实现为准**，差异已上报；若将来统一成 '…'，请同步改这里。
    expect(redactPath('/Users/alice')).toBe(`${ELLIPSIS}/`)
    expect(redactPath('/Users/alice/')).toBe(`${ELLIPSIS}/`)
    expect(redactPath('/home/alice', { home: '/home/alice' })).toBe(`${ELLIPSIS}/`)
  })

  it('相对路径两级以上同样折叠；单名字保留原样（无从泄露）', () => {
    expect(redactPath('./a.md')).toBe('a.md')
    expect(redactPath('../a.md')).toBe('a.md')
    expect(redactPath('x/y/z/a.md')).toBe(`${ELLIPSIS}/z/a.md`)
    expect(redactPath('~/notes/a.md')).toBe(`${ELLIPSIS}/notes/a.md`)
    expect(redactPath('~')).toBe(`${ELLIPSIS}/~`)
  })

  it('非字符串入参安全退化为空串，绝不抛', () => {
    for (const v of [null, undefined, '', 0, 42, true, {}, [], Symbol('x')]) {
      expect(redactPath(v), `v=${String(v)}`).toBe('')
    }
    expect(() => redactPath(null)).not.toThrow()
  })

  it('验收标准 4：任何输入的输出里都不出现家目录用户名', () => {
    const paths = [
      '/Users/alice/notes/a.md',
      '/Users/alice/deep/private/2026/a.md',
      '/home/alice/vault/x.md',
      'C:\\Users\\alice\\AppData\\Roaming\\choyeon\\logs\\main.log',
      '读取失败 /Users/alice/notes/a.md' // 非路径形状也一并校验（整串不命中时由上层负责）
    ]
    for (const p of paths) {
      expect(redactPath(p).includes('alice'), `path=${p} 泄漏了家目录用户名`).toBe(false)
    }
  })

  it('深层私人目录结构不外泄（只留最后两级）', () => {
    expect(redactPath('/Users/alice/私密/公司/财报/a.md')).toBe(`${ELLIPSIS}/财报/a.md`)
    expect(redactPath('/Users/alice/私密/公司/财报/a.md').includes('公司')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D. redactContent
// ---------------------------------------------------------------------------

describe('D. redactContent —— 按码点截断 + 控制字符折叠成转义文本', () => {
  it('普通字符串原样返回', () => {
    expect(redactContent('hello')).toBe('hello')
    expect(redactContent('')).toBe('')
  })

  it('非字符串走 String() 兜底；拿不到文本时失败即遮蔽', () => {
    expect(redactContent(null)).toBe('null')
    expect(redactContent(undefined)).toBe('undefined')
    expect(redactContent(42)).toBe('42')
    expect(redactContent(true)).toBe('true')
    // String(Symbol) 是特例，不抛 —— 合法得到描述串
    expect(redactContent(Symbol('x'))).toBe('Symbol(x)')
    // 真正取不到文本的情况：toString 抛错 → REDACTED（fail closed）
    const evil = { toString () { throw new Error('boom') } }
    expect(redactContent(evil)).toBe(REDACTED)
  })

  it('换行 / 制表符折叠成文本而非原始字节', () => {
    expect(redactContent(`a${LF}b`)).toBe('a\\nb')
    expect(redactContent(`a${CR}${LF}b`)).toBe('a\\nb')
    expect(redactContent(`a${CR}b`)).toBe('a\\nb')
    expect(redactContent(`a${TAB}b`)).toBe('a\\tb')
  })

  it('NUL / DEL 折叠成 \\uXXXX 文本，输出里不存在真实控制字节', () => {
    const out = redactContent(`a${NUL}b${DEL}c`)
    expect(out).toBe('a\\u0000b\\u007fc')
    expect(hasRawControlChar(out)).toBe(false)
  })

  it('0x01~0x1F 全部折叠，且结果不含任何原始控制字节（满足「源码/产物禁裸 NUL」）', () => {
    // 折叠会把每个控制字符撑成 6 个字符，30 个就有 ~170 个码点 —— 必须放宽 max 才能看全尾巴，
    // 否则会被 120 的默认上限截断，断言 \u001f 存在时会得到假阴性。
    const raw = Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join('')
    const out = redactContent(raw, 2000)
    expect(hasRawControlChar(out)).toBe(false)
    expect(out.includes('\\u0001')).toBe(true)
    expect(out.includes('\\u001f')).toBe(true)
    // LF / CR / TAB 走的是专用短转义，不是 \u00XX
    expect(out.includes('\\n')).toBe(true)
    expect(out.includes('\\t')).toBe(true)
  })

  it('默认上限 120：恰好 120 不改，121 起截短并补省略符', () => {
    const exact = 'x'.repeat(120)
    expect(redactContent(exact)).toBe(exact)
    const over = 'x'.repeat(121)
    const out = redactContent(over)
    expect(out.length).toBe(121) // 120 + 省略符
    expect(out.endsWith(ELLIPSIS)).toBe(true)
  })

  it('自定义 max：合法值生效，非法值回落到 120', () => {
    expect(redactContent('abcdef', 3)).toBe(`abc${ELLIPSIS}`)
    expect(redactContent('abcdef', 0)).toBe('abcdef')
    expect(redactContent('abcdef', -1)).toBe('abcdef')
    expect(redactContent('abcdef', Number.NaN)).toBe('abcdef')
    expect(redactContent('abcdef', Number.POSITIVE_INFINITY)).toBe('abcdef')
    // 数字字符串会被 Number() 接受（positiveInt 的既定行为）
    expect(redactContent('abcdef', '3')).toBe(`abc${ELLIPSIS}`)
  })

  it('按**码点**切而非 UTF-16 码元：不把汉字劈成两半（不留 U+FFFD）', () => {
    // '\u{20BB7}' 是两个码元一个码点，按 length 切必碎
    const text = '\u{20BB7}'.repeat(121)
    expect(text.length).toBe(242) // 证明它确实是代理对
    const out = redactContent(text)
    expect(Array.from(out).length).toBe(121)
    expect(out.includes('\uFFFD')).toBe(false)
    expect(out.endsWith(ELLIPSIS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// E. sanitizeValue 结构化脱敏
// ---------------------------------------------------------------------------

describe('E. sanitizeValue —— 敏感字段整体替换', () => {
  it('验收标准 5：vault 条目的 value / valueEnc 永不入日志（整体 [REDACTED]）', () => {
    const entry = {
      id: 'e-1',
      label: 'GitHub Token',
      type: 'token',
      createdAt: '2026-01-01',
      value: 'ghp_abcdef123456',
      valueEnc: 'ENC:v1:9f8e7d…=='
    }
    const res = sanitizeValue(entry)
    expect(res.value).toBe(REDACTED)
    expect(res.valueEnc).toBe(REDACTED)
    // 非敏感字段必须保留 —— 否则日志失去排查价值
    expect(res.id).toBe('e-1')
    expect(res.label).toBe('GitHub Token')
    expect(res.type).toBe('token')
    expect(res.createdAt).toBe('2026-01-01')
    // 明文与密文都不许出现在序列化结果里
    const text = JSON.stringify(res)
    expect(text.includes('ghp_')).toBe(false)
    expect(text.includes('ENC:v1')).toBe(false)
  })

  it('secret === true 时 key 与 note 一并脱敏（账号名 + 用途备注）', () => {
    const res = sanitizeValue({
      secret: true,
      key: 'alice@corp.example',
      note: '公司 CI 的部署凭证',
      value: 'hunter2'
    })
    expect(res.key).toBe(REDACTED)
    expect(res.note).toBe(REDACTED)
    expect(res.value).toBe(REDACTED)
    expect(JSON.stringify(res).includes('alice@corp.example')).toBe(false)
    expect(JSON.stringify(res).includes('hunter2')).toBe(false)
  })

  it('secret 为假时 key / note 保留，但 value 仍遮蔽（两条规则互不替代）', () => {
    const res = sanitizeValue({ secret: false, key: 'alice@corp.example', note: '公司邮箱', value: 'hunter2' })
    expect(res.key).toBe('alice@corp.example')
    expect(res.note).toBe('公司邮箱')
    expect(res.value).toBe(REDACTED)
  })

  it('key 本身不在敏感名单里（它靠 secret 标记才被遮蔽）—— 防止口径漂移', () => {
    expect(isSensitiveKey('key')).toBe(false)
    expect(isSensitiveKey('note')).toBe(false)
  })

  it('secret 判定逐层生效：嵌套对象里的敏感条目也一并遮蔽', () => {
    const res = sanitizeValue({
      ok: 1,
      entry: { secret: true, key: '内网 VPN 账号', note: '运维组共用', value: 'p@ss' },
      plain: { secret: false, key: '公开账号', note: '可留', value: 'still-secret' }
    })
    expect(res.entry.key).toBe(REDACTED)
    expect(res.entry.note).toBe(REDACTED)
    expect(res.entry.value).toBe(REDACTED)
    expect(res.plain.key).toBe('公开账号')
    expect(res.plain.note).toBe('可留')
    expect(res.plain.value).toBe(REDACTED)
    expect(res.ok).toBe(1)
  })

  it('T08 实测清单里的 16 个命中 key，值全部被整体替换（端到端，不止判名）', () => {
    const payload = {}
    for (const key of [...HIT_ORIGINAL, ...HIT_REINFORCED]) payload[key] = `PLAINTEXT-${key}`
    const res = sanitizeValue(payload)
    for (const key of [...HIT_ORIGINAL, ...HIT_REINFORCED]) {
      expect(res[key], `key=${key} 的值应为 [REDACTED]`).toBe(REDACTED)
    }
    expect(JSON.stringify(res).includes('PLAINTEXT-')).toBe(false)
  })

  it('刻意不命中的 5 个 key：值保留原样（不能因为「长得像」就被遮蔽）', () => {
    const payload = {}
    for (const key of NOT_HIT) payload[key] = `keep-${key}`
    const res = sanitizeValue(payload)
    for (const key of NOT_HIT) {
      expect(res[key], `key=${key} 不该被遮蔽`).toBe(`keep-${key}`)
    }
  })

  it('深层嵌套里的敏感 key 同样被遮蔽（横向名字失效不存在）', () => {
    const res = sanitizeValue({ ctx: { auth: { accessToken: 'AAA', nestedOk: 1 } } })
    expect(res.ctx.auth.accessToken).toBe(REDACTED)
    expect(res.ctx.auth.nestedOk).toBe(1)
  })
})

describe('E2. sanitizeValue —— Error 必须被展开', () => {
  it('Error 展开为 {name, message, ...}：直接 JSON.stringify 只会得到 {}', () => {
    const err = new Error('写入失败')
    // 先证明问题真实存在：message / stack 是非枚举属性
    expect(JSON.stringify(err)).toBe('{}')
    const res = sanitizeValue(err)
    expect(res.name).toBe('Error')
    expect(res.message).toBe('写入失败')
  })

  it('Error 的 code / errno 一并保留（文件系统错误的排查命脉）', () => {
    const err = new Error('ENOENT: no such file')
    err.code = 'ENOENT'
    err.errno = -2
    const res = sanitizeValue(err)
    expect(res.code).toBe('ENOENT')
    expect(res.errno).toBe(-2)
  })

  it('子类 Error 的 name 保留真实类型（TypeError 不能被抹成 Error）', () => {
    expect(sanitizeValue(new TypeError('x')).name).toBe('TypeError')
    expect(sanitizeValue(new RangeError('y')).name).toBe('RangeError')
  })

  it('stack 只留栈顶三行，且换行被折叠成单行（日志必须一行一条）', () => {
    const err = new Error('boom')
    err.stack = `Error: boom${LF}    at fn1 (/Users/alice/app.js:1:1)${LF}    at fn2 (/Users/alice/app.js:2:2)${LF}    at fn3 (/Users/alice/app.js:3:3)${LF}    at fn4`
    const res = sanitizeValue(err)
    expect(res.stack.includes(LF)).toBe(false)
    // 三行用 ' | ' 连接 → 恰好两个分隔符
    expect(res.stack.split(' | ').length).toBe(3)
  })

  it('Error.stack 里的家目录同样被遮蔽（验收标准 4 的最后一块拼图）', () => {
    const err = new Error('boom')
    err.stack = `Error: boom${LF}    at readNote (/Users/alice/app/src/note.js:12:34)`
    const res = sanitizeValue(err)
    expect(res.stack.includes('alice')).toBe(false)
    expect(res.stack.includes(`${ELLIPSIS}/src/note.js`)).toBe(true)
  })

  it('嵌套在对象里的 Error 也走同一套展开', () => {
    const res = sanitizeValue({ err: new Error('内部炸了'), ok: 1 })
    expect(res.err.message).toBe('内部炸了')
    expect(res.err.name).toBe('Error')
    expect(res.ok).toBe(1)
  })
})

describe('E3. sanitizeValue —— 平台对象与特殊类型', () => {
  it('Map / Set 转成数组，保证结果可 JSON 序列化', () => {
    const res = sanitizeValue({ m: new Map([['a', 1]]), s: new Set(['x']) })
    expect(res.m).toEqual([['a', 1]])
    expect(res.s).toEqual(['x'])
  })

  it('Date 转 ISO 串；非法 Date 给 [InvalidDate] 而不是 "Invalid Date"', () => {
    expect(sanitizeValue({ d: new Date('2026-01-02T03:04:05.000Z') }).d).toBe('2026-01-02T03:04:05.000Z')
    expect(sanitizeValue({ d: new Date('nonsense') }).d).toBe('[InvalidDate]')
  })

  it('RegExp / BigInt / Symbol / Function 都被转成可序列化的字符串', () => {
    // 注意：RegExp 走的是 safeString(v) 直接返回，**不过** sanitizeString / 路径遮蔽，
    // 因此 '/abc/g' 原样保留（形状上像路径也没被处理）—— 这是 walkInner 的分派顺序决定的。
    expect(sanitizeValue({ r: /abc/g }).r).toBe('/abc/g')
    expect(sanitizeValue({ b: 10n }).b).toBe('10n')
    expect(sanitizeValue({ s: Symbol('tok') }).s).toBe('Symbol(tok)')
    expect(sanitizeValue({ f: () => {} }).f).toBe('[Function]')
  })

  it('二进制（ArrayBuffer / TypedArray）只留长度标记，不 dump 内容', () => {
    expect(sanitizeValue({ u: new Uint8Array([1, 2, 3]) }).u).toBe('[Binary:3]')
    expect(sanitizeValue({ a: new ArrayBuffer(8) }).a).toBe('[Binary:8]')
  })

  it('DOM 节点（jsdom）标记为 [DOMNode]，不递归展开其属性', () => {
    const res = sanitizeValue({ el: document.createElement('div') })
    expect(res.el).toBe('[DOMNode]')
  })

  it('非有限 number 转成字符串，不产生 NaN/Infinity 的 JSON 崩溃', () => {
    const res = sanitizeValue({ inf: Number.POSITIVE_INFINITY, nan: Number.NaN })
    expect(res.inf).toBe('Infinity')
    expect(res.nan).toBe('NaN')
    expect(typeof JSON.stringify(res)).toBe('string')
  })

  it('null / undefined 原样返回（保留「这个字段真的没给」的语义）', () => {
    expect(sanitizeValue(null)).toBe(null)
    expect(sanitizeValue(undefined)).toBe(undefined)
    expect(sanitizeValue({ a: null }).a).toBe(null)
  })

  it('基本类型直接返回原值', () => {
    expect(sanitizeValue(42)).toBe(42)
    expect(sanitizeValue(true)).toBe(true)
    expect(sanitizeValue('abc')).toBe('abc')
  })
})

// ---------------------------------------------------------------------------
// F. 失败即遮蔽 / 健壮性
// ---------------------------------------------------------------------------

describe('F. 失败即遮蔽（fail closed）与遍历健壮性', () => {
  it('敌意 getter：取属性抛错时该字段记为 [REDACTED]，且整体不抛', () => {
    const hostile = { ok: 1 }
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get () { throw new Error('getter boom') }
    })
    expect(() => sanitizeValue(hostile)).not.toThrow()
    const res = sanitizeValue(hostile)
    expect(res.boom).toBe(REDACTED)
    expect(res.ok).toBe(1)
  })

  it('敏感名字的敌意 getter 连 getter 都不会被调用（短路在前）', () => {
    let touched = false
    const hostile = {}
    Object.defineProperty(hostile, 'token', {
      enumerable: true,
      get () { touched = true; throw new Error('should not be called') }
    })
    const res = sanitizeValue(hostile)
    expect(touched).toBe(false)
    expect(res.token).toBe(REDACTED)
  })

  it('Object.keys 抛错（Proxy ownKeys trap）时该对象整体记为 [REDACTED]', () => {
    const proxy = new Proxy({}, {
      ownKeys () { throw new Error('ownKeys boom') }
    })
    expect(() => sanitizeValue({ p: proxy })).not.toThrow()
    expect(sanitizeValue({ p: proxy }).p).toBe(REDACTED)
  })

  it('敌意 getter 位于深层时，只污染它自己那一支，兄弟节点照常输出', () => {
    const inner = {}
    Object.defineProperty(inner, 'boom', { enumerable: true, get () { throw new Error('x') } })
    const res = sanitizeValue({ branchA: { inner }, branchB: { note: '正常' } })
    expect(res.branchA.inner.boom).toBe(REDACTED)
    expect(res.branchB.note).toBe('正常')
  })

  it('环引用（自引用对象）→ [Circular]，不栈溢出', () => {
    const a = { name: 'a' }
    a.self = a
    const res = sanitizeValue(a)
    expect(res.name).toBe('a')
    expect(res.self).toBe('[Circular]')
  })

  it('环引用（自引用数组）→ [Circular]', () => {
    const arr = []
    arr.push(arr)
    const res = sanitizeValue(arr)
    expect(res[0]).toBe('[Circular]')
  })

  it('互引用环 a→b→a 也能收敛，且不误伤重复引用（同一对象出现在两支都该渲染）', () => {
    const shared = { x: 1 }
    const res = sanitizeValue({ a: shared, b: shared })
    expect(res.a.x).toBe(1)
    expect(res.b.x).toBe(1)

    const p = {}
    const q = { p }
    p.q = q
    const ring = sanitizeValue(p)
    expect(ring.q.p).toBe('[Circular]')
  })

  it('超过 maxDepth 的部分标记 [Object:类型名]，内容一点都不带出来', () => {
    const deep = { l1: { l2: { l3: { inner: 'LEAK-ME' } } } }
    const res = sanitizeValue(deep) // 默认 maxDepth=3
    expect(res.l1.l2.l3).toBe('[Object:Object]')
    expect(JSON.stringify(res).includes('LEAK-ME')).toBe(false)
  })

  it('自定义 maxDepth 生效（浅层数可以更浅）', () => {
    const res = sanitizeValue({ l1: { l2: { l3: 1 } } }, { maxDepth: 1 })
    expect(res.l1).toBe('[Object:Object]')
  })

  it('超过节点预算 → [BudgetExceeded]（深而不宽的组合爆炸防线）', () => {
    const res = sanitizeValue([1, 2, 3, 4, 5], { maxNodes: 3 })
    expect(res).toEqual([1, 2, '[BudgetExceeded]', '[BudgetExceeded]', '[BudgetExceeded]'])
  })

  it('单个对象超过 maxKeys 截断并留 __truncated 计数', () => {
    const big = {}
    for (let i = 0; i < 45; i += 1) big[`k${i}`] = i
    const res = sanitizeValue(big)
    expect(Object.keys(res).length).toBe(41) // 40 + __truncated
    expect(res.__truncated).toBe(`${ELLIPSIS}(+5 keys)`)
    expect(res.k0).toBe(0)
    expect(res.k44).toBeUndefined()
  })

  it('单个数组超过 maxArray 截断并留 (+N) 计数', () => {
    const res = sanitizeValue(Array.from({ length: 35 }, (_, i) => i))
    expect(res.length).toBe(31) // 30 + 一个计数项
    expect(res[30]).toBe(`${ELLIPSIS}(+5)`)
    expect(res[0]).toBe(0)
  })

  it('不变量 1：任何结果都能 JSON.stringify（不留环 / Function / Symbol / 二进制）', () => {
    const messy = { s: Symbol('x'), f: () => {}, b: new Uint8Array([1]), m: new Map([['k', 'v']]), err: new Error('e') }
    messy.self = messy
    const res = sanitizeValue(messy)
    expect(typeof JSON.stringify(res)).toBe('string')
    expect(res.self).toBe('[Circular]')
  })

  it('不变量 4：入参再离谱也不抛（Symbol / 巨整数 / Proxy / DOM）', () => {
    expect(() => sanitizeValue(Symbol('x'))).not.toThrow()
    expect(() => sanitizeValue(new Proxy({}, { get () { throw new Error('x') } }))).not.toThrow()
    expect(() => sanitizeValue(document.createElement('div'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// G. 自由文本里的路径
// ---------------------------------------------------------------------------

describe('G. 字符串里的路径遮蔽（值本身是路径 / 自由文本内嵌）', () => {
  it('值整串是一条路径 → 直接走 redactPath', () => {
    expect(sanitizeValue({ path: '/Users/alice/notes/a.md' }).path).toBe(`${ELLIPSIS}/notes/a.md`)
    expect(sanitizeValue({ path: 'C:\\Users\\alice\\AppData\\x.json' }).path).toBe(`${ELLIPSIS}/AppData/x.json`)
  })

  it('自由文本里内嵌的绝对路径被替换（前面有空白作边界锚）', () => {
    const res = sanitizeValue({ msg: `读取失败 /Users/alice/a.md 已重试` })
    expect(res.msg).toBe(`读取失败 ${ELLIPSIS}/a.md 已重试`)
  })

  it('一行里出现多处路径，全部替换（每条各自算一级折叠）', () => {
    // 分隔符必须是**会被段字符类排除**的字符（这里用全角逗号 U+FF0C）；
    // 若只用空格分隔，两条路径会被贪婪合并成一个 token（见已知边界 5）。
    const res = sanitizeValue({ msg: `路径 /Users/alice/a.md，日志 /var/log/z.log` }).msg
    expect(res).toBe(`路径 ${ELLIPSIS}/a.md，日志 ${ELLIPSIS}/log/z.log`)
    expect(res.includes('alice')).toBe(false)
  })

  it('URL 不被误认成路径（边界锚刻意不含 : 与 /）', () => {
    const url = 'https://example.com/a/b'
    expect(sanitizeValue({ url }).url).toBe(url)
  })

  it('CJK 标点能终止路径识别：`…，然后失败` 不会把尾巴吃进路径', () => {
    const res = sanitizeValue({ msg: `打开 /Users/alice/a.md，然后失败` })
    expect(res.msg.includes('，然后失败')).toBe(true)
    expect(res.msg.includes('alice')).toBe(false)
  })

  it('通过 sanitizeValue 出去的字符串一律不再含原始控制字节', () => {
    const res = sanitizeValue({ note: `第一行${LF}第二行${TAB}带 NUL:${NUL}` })
    expect(res.note).toBe('第一行\\n第二行\\t带 NUL:\\u0000')
    expect(hasRawControlChar(res.note)).toBe(false)
  })

  it('超过 maxString 的字符串被截断 + 省略符', () => {
    const res = sanitizeValue({ content: 'y'.repeat(300) }, { maxString: 120 })
    expect(res.content.length).toBe(121)
    expect(res.content.endsWith(ELLIPSIS)).toBe(true)
  })

  it('home 参数一路透传到路径遮蔽', () => {
    const res = sanitizeValue({ path: '/data/vault/users/bob/a.md' }, { home: '/data/vault/users/bob' })
    expect(res.path).toBe(`${ELLIPSIS}/a.md`)
  })
})

// ---------------------------------------------------------------------------
// H. 【已知边界】当前确实失守的场景
// ---------------------------------------------------------------------------

describe('H. 【已知边界】当前实现尚未堵住的口子（诚实记录，非背书）', () => {
  it('已知边界 1：KNOWN_MISSING 里那 11 个 key 的值会原样进入日志', () => {
    const payload = {}
    for (const key of KNOWN_MISSING) payload[key] = `LEAK-${key}`
    const res = sanitizeValue(payload)
    for (const key of KNOWN_MISSING) {
      expect(res[key], `key=${key} 已受保护，请把 key 移出 KNOWN_MISSING`).toBe(`LEAK-${key}`)
    }
  })

  it('已知边界 2：CJK 汉字紧邻路径且前面无空白/ASCII 标点时识别不到（整条路径漏出）', () => {
    // EMBEDDED_PATH_RE 的边界锚只含空白与 ASCII 标点，'为' 这类汉字不算边界 → 匹配不上
    const res = sanitizeValue({ msg: `路径为/Users/alice/a.md` }).msg
    expect(res.includes('/Users/alice')).toBe(true)
    // ↑ 当前确实漏。修好之后此断言必须改为：
    //   expect(res).toBe(`路径为${ELLIPSIS}/a.md`)
    // 规避现行办法：路径放 data 字段、不要拼进中文 msg（T10 调用点纪律已在 logSanitize.js 文件头写明）
  })

  it('已知边界 3：Map / Set 的元素不受「key 名」判定保护（数组元素不查敏感名单）', () => {
    const res = sanitizeValue({ m: new Map([['password', 'hunter2']]) }).m
    expect(res[0][1]).toBe('hunter2')
  })

  it('已知边界 4：非 secret 条目里 pattern 认不出的新字段，会原样出去（靠名单兜底，不是万能）', () => {
    expect(sanitizeValue({ weird: 'plain' }).weird).toBe('plain')
  })

  it('已知边界 5：多条路径用**空格**分隔时会被贪婪合并成一个 token（仍遮蔽，但粒度变粗）', () => {
    // 段字符类允许空格 → 'x /Users/alice/a.md y /var/log/z.log' 被当成一整条路径，
    // 剥家目录后 parts = [a.md y, var, log, z.log] → 只留最后两级。
    // 用户名没漏（这才是底线），但第一条路径只剩 filenames 消失了。
    const res = sanitizeValue({ msg: `x /Users/alice/a.md y /var/log/z.log` }).msg
    expect(res).toBe(`x ${ELLIPSIS}/log/z.log`)
    expect(res.includes('alice')).toBe(false)
  })

  it('已知边界 6：带盘符的 XP 家目录 C:/Documents and Settings/<user> 识别不到 → 用户名漏出', () => {
    // HOME_ROOT_PATTERNS 里只有 /Users/<name> 那一条带 `(?:[A-Za-z]:)?` 盘符前缀，
    // 'Documents and Settings' 这条以 `^[\/]` 起头 —— 于是带了盘符就整段失配，
    // 用户名被当成普通目录尾巴留了下来。
    expect(redactPath('/Documents and Settings/alice/x.md')).toBe(`${ELLIPSIS}/x.md`) // 无盘符：正常
    expect(redactPath('C:/Documents and Settings/alice/x.md')).toBe(`${ELLIPSIS}/alice/x.md`) // 有盘符：漏
    // ↑ 最后一行当前确实漏。修法：给该 HOME 模式补上与 /Users 那条相同的盘符前缀。
  })

  it('已知边界 7：RegExp 的 String 形态不过路径遮蔽（分派顺序决定）', () => {
    // walkInner 里 isRegExpLike → safeString 直接返回，不走 sanitizeString。
    expect(sanitizeValue(/abc/g)).toBe('/abc/g')
  })
})

// ---------------------------------------------------------------------------
// I. 结构性约束
// ---------------------------------------------------------------------------

/**
 * 结构性约束要读源码本身。
 *
 * 刻意**不用 node:fs**：某些宿主（本项目测试环境的 fs shim 就是）会拦截 readFileSync /
 * fileURLToPath，对 URL 入参报 "The URL must be of scheme file"。改用 Vite 的 ?raw glob，
 * 走的是 vitest 自己的转换管道（与其余用例同一条加载路径），不受宿主 fs 实现影响。
 */
const SOURCES = import.meta.glob('../src/{utils/logSanitize,constants/logging}.js', {
  query: '?raw',
  import: 'default',
  eager: true
})

/** 按路径后缀取出源码文本；取不到返回空串（下面的断言会立刻把它打红） */
function sourceOf (suffix) {
  const key = Object.keys(SOURCES).find(k => k.endsWith(suffix))
  return key ? SOURCES[key] : ''
}

describe('I. 结构性约束（零 import / 无裸 NUL 字节）', () => {
  it('源码提取通道本身可用（glob 必须真读到两个文件，否则下面的断言都是假绿）', () => {
    expect(Object.keys(SOURCES).length).toBe(2)
    expect(sourceOf('utils/logSanitize.js').length).toBeGreaterThan(1000)
    expect(sourceOf('constants/logging.js').length).toBeGreaterThan(1000)
  })

  it('logSanitize.js 零 import（要同时跑在 ESM / CJS / 纯 node 三种宿主里）', () => {
    const src = sourceOf('utils/logSanitize.js')
    const importLines = src.split(/\r?\n/).filter(l => /^\s*import\s/.test(l))
    expect(importLines).toEqual([])
    // require 同样不许出现（CJS 里它会破坏 ESM 侧的静态分析）
    expect(src.includes('require(')).toBe(false)
  })

  it('constants/logging.js 同样零 import、零副作用', () => {
    const src = sourceOf('constants/logging.js')
    expect(src.split(/\r?\n/).filter(l => /^\s*import\s/.test(l))).toEqual([])
    expect(src.includes('require(')).toBe(false)
  })

  it('源码里不含裸 NUL 字节（项目硬约束）', () => {
    for (const suffix of ['utils/logSanitize.js', 'constants/logging.js']) {
      expect(sourceOf(suffix).includes(NUL), `file=${suffix}`).toBe(false)
    }
  })
})
