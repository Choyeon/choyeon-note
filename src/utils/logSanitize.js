// ============================================================================
// logSanitize.js —— 日志脱敏（零 import 纯函数）
//
// 背景：日志要能被用户「直接贴进 GitHub Issue 而无隐私泄漏」（R-L6），所以脱敏不是
// 锦上添花，是这个模块存在的唯一理由。它必须跑在每一条日志出门前的最后一道，
// 且失败时**必须失败在「遮蔽」这一侧**（fail closed）。
//
// 给定的判定基准（design §2.2 / §3.4，架构师已核查）：
//   1. 敏感 key 一律整体替换为 '[REDACTED]'，**不是**首尾保留的部分遮蔽。
//      理由在 vault.js:352-359：`mask()` 保留首尾字符是给 UI 看的（用户需要认出
//      「这是我自己那条 Github Token」），但日志要外发给陌生人，首尾字符恰恰是
//      缩小爆破空间的线索。同一个字段，UI 与日志用两套遮蔽强度，不是重复实现。
//   2. `entry.value` / `entry.valueEnc` 永不入日志（vault 明文与 safeStorage 密文）。
//   3. `secret === true` 的 vault 条目：`key` 与 `note` 一并脱敏。
//      理由同样来自既有口径 vault.js:193-194 —— 敏感值不参与内容搜索，「避免搜索框
//      成为泄露面」。账号名/用途备注虽然不是密码，但「哪个系统的哪一类凭证」本身
//      就是社工有用的信息，日志按同一标准处理。
//   4. 家目录路径必须遮蔽；内容片段截断到 120 字符。
//
// 硬约束：**本文件零 import**。它要被渲染进程（ESM）、主进程（CJS）、单测复用。
// 因此 maxString/maxDepth 的默认值在这里各写一份（与 constants/logging.js 同名
// 常量保持一致），不 import 常量。
//
// 两条使用纪律（**无法由本模块代为执行，属于调用点责任**，已同步给 T10）：
//   · `vaultEncrypt` / `vaultDecrypt` 的输入输出「整条禁记」——它们多半是裸字符串入参，
//     没有 key 名可判敏感，只有调用方知道自己在记什么。要不写，要么写成计数器/长度。
//   · 任何 `logger.*('xxx', { plain: 明文 })` 同理：脱敏只能认得出**名字**像凭证的字段。
// ============================================================================

// ---------------------------------------------------------------------------
// 常量与判定表
// ---------------------------------------------------------------------------

/**
 * 完整的替换标记。整体替换而非部分遮蔽 —— 见文件头理由 1。
 * 刻意写成四角括号：它在日志里必须一眼可辨，不能被误认为是某个真值。
 */
export const REDACTED = '[REDACTED]'

/**
 * 路径被遮蔽后用的省略符。
 * 用 U+2026 而不是三个点，是为了让「这是本模块产出」可回溯：日志里 `…/` 一出现，
 * 就知道上面有层目录被裁掉了。
 */
const ELLIPSIS = '\u2026'

/**
 * 敏感 key 判定模式。
 *
 * 结尾锚 `$` 的含义：**以这些词收尾**的 key 才算敏感。`passwordHash` 不命中、
 * `passwords`（集合名）不命中。`/i` 让 `valueEnc` / `API_KEY` 这类写法也命中。
 *
 * 为什么坚持留着 `$` 而不是放开成「包含即敏感」：去掉锚会让 `passwords` / `values`
 * / `evaluated` 这类普通字段名大批误伤，脱敏噪音大到没人愿意看日志，最后的结果
 * 往往是有人把脱敏整体绕过。**精准命中 + 显式补高危词** 优于「一网打尽」。
 *
 * 已知代价：`value` 在模式里 → 任何无关对象的 `{ value: 'hello' }` 也会被遮蔽。
 * 这是刻意选的假阳性：漏一个真凭证的代价远大于遮蔽一个普通字段。
 *
 * 2026-09-27 修订（T08 补强，用户裁决）：补进 `privatekey` / `secretkey` / `accesskey`
 * 三个**复合词**。背景是原模式下 `privateKey` 这种「敏感词在中间、类型后缀在结尾」
 * 的命名完全漏网 —— 而它装的是 PEM 私钥全文，泄露即失窃。补词而不是去锚，是裁决
 * 定的方向。注意 apiKeyValue / apiSecret / accessToken 这类**本来就命中**（分别被
 * `value` / `secret` / `token` 收尾锚接住），不需要额外补。
 *
 * ⚠️ 本常量的字面值已与设计文档 §3.4 的初版不同，是**基于本文记录的裁决**有意修订的。
 * T14 写断言时请以这里的实际值为准（现在是下面这行的模样）。
 *
 * 仍然漏网的命名（本轮**刻意不补**，维持待裁定）：
 *   · `passwordHash` —— 哈希不是可直接使用的凭证，且一补就得连带 tokenHash/checksum
 *     整条家族，等于滑向去锚；
 *   · `token_str` / `credentialId` —— 个人化很强的写法，逐个补补不全；
 *   · `sessionId` / `cookie` / `authorization` / `cvv` / `pin` / `mfaCode` / `otp`
 *     / `mnemonic` —— 完整家族，不是「显式补几个词」能解决的量级，且本项目 vault 的
 *     条目类型（credential/server/token/database/contact/other）里它们不是既有字段。
 *     真要收进来应作为下一次专项（连同 T10 的调用点纪律一起），而不是这里偷偷加。
 */
export const SENSITIVE_KEY_PATTERN = /(pass|passwd|password|secret|secretkey|token|credential|apikey|api_key|private|privatekey|accesskey|value|valueenc)$/i

/**
 * vault 条目里除 `value` / `valueEnc` 之外还要一并遮蔽的字段（仅在 secret 为真时）。
 * `key` 是账号名，`note` 是「用途 / 归属系统」备注 —— 见文件头理由 3。
 */
export const SECRET_ENTRY_EXTRA_KEYS = Object.freeze(['key', 'note'])

/** 单字符串默认截断上限，必须与 constants/logging.js 的 LOG_CONTENT_MAX 相等 */
const DEFAULT_CONTENT_MAX = 120

/** sanitizeValue 的默认单个字符串上限（= LOG_MAX_STRING） */
const DEFAULT_MAX_STRING = 200

/** sanitizeValue 的默认下潜层数（= LOG_MAX_DEPTH） */
const DEFAULT_MAX_DEPTH = 3

/** 单个对象最多保留多少个 key：防止把一个上千键的对象整体抄进日志 */
const DEFAULT_MAX_KEYS = 40

/** 单个数组最多保留多少项 */
const DEFAULT_MAX_ARRAY = 30

/**
 * 一次 sanitize 最多处理多少个节点（对象/数组/字符串都算）。
 * 这是**总量闸门**：上面的 key/array 上限是「宽度」，防止单个巨对象；这个防止
 * 「深而不宽」的组合爆炸，也防止 Vue 响应式代理这类 getter 被扇出式遍历。
 */
const DEFAULT_MAX_NODES = 500

// ---------------------------------------------------------------------------
// 路径形状识别
// ---------------------------------------------------------------------------

/** 绝对路径的起手式：POSIX 根 / Windows 盘符（斜杠反斜杠都算） / ~ 开头的家目录简写 */
const IS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|~)/

/**
 * 「整串就是一个路径」的形状：可选盘符或 ~ 起头，后面全是分隔符分段。
 * 用于把 `{ path: '/Users/alice/notes/a.md' }` 这类**值本身就是路径**的主流情况
 * 一次性交给 redactPath 处理。
 * 字符类里排除的是控制字符与分隔符；空格是允许的（Windows 路径 `My Notes/` 常见）。
 */
const WHOLE_PATH_RE = /^(?:~|[A-Za-z]:)?[\\/](?:[^\\/\u0000-\u001F]+[\\/])*[^\\/\u0000-\u001F]*$/

/**
 * 自由文本里**内嵌**的绝对路径。
 *
 * 两段式构成：① 边界锚 ——必须是行首，或空白/引号/括号类符号；这里刻意不含 `:`
 * 与 `/`，所以 `https://example.com/a/b` 里的 `//a/b` 不会被误认成路径（URL 保护）。
 * ② 路径体 ——至少含一个“段+分隔符”的重复组，避免把单个 `/` 当成路径。
 *
 * 段内字符类的排除项是刻意的：
 *   · 控制字符：进日志会把一行日志撕成多行；
 *   · `:*?"<>|`：Windows 文件名非法组合，出现即说明这一段不是路径；
 *   · `\u3000-\u303F`（CJK 标点：、。「」【】等）与全角标点 —— **中文语境的关键一条**，
 *     否则 `路径为/Users/alice/a.md，然后失败` 会把感叹句尾巴一起吃进路径里；
 *   · 其余 CJK 汉字允许出现（本项目用户库里中文目录名/文件名是常态）。
 */
const EMBEDDED_PATH_RE = new RegExp(
  '(^|[\\s\'"(,;=|[`*+{<])((?:[A-Za-z]:[\\\\/]|[\\\\/])(?:' +
  '[^\\\\/\\u0000-\\u001F:*?"<>|\\u3000-\\u303F\\u2018-\\u201F\\u2026\\uFF01-\\uFF65\\uFFE0-\\uFFEF]+' +
  '[\\\\/])+[^\\\\/\\u0000-\\u001F:*?"<>|\\u3000-\\u303F\\u2018-\\u201F\\u2026\\uFF01-\\uFF65\\uFFE0-\\uFFEF]*)',
  'g'
)

/**
 * 家目录根的常见写法。没有 `os` / `process` 可用（零 import），只能靠形状识别：
 * 主进程知道真实 home 时应当通过 `opts.home` 显式传入，这里只是兜底。
 */
const HOME_ROOT_PATTERNS = [
  /^(?:[A-Za-z]:)?[\\/]?Users[\\/][^\\/]+(?=[\\/]|$)/i, // macOS /Users/<name>，也覆盖 C:\Users\<name>
  /^[\\/]home[\\/][^\\/]+(?=[\\/]|$)/i, // Linux /home/<name>
  /^[\\/]root(?=[\\/]|$)/i, // root 家目录
  /^[\\/]Documents and Settings[\\/][^\\/]+(?=[\\/]|$)/i // Windows XP 遗留
]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 取一个正整数参数，非法值回落到 fallback */
function positiveInt (raw, fallback) {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * 把 Windows 分隔符与各类前缀统一成 POSIX 形态，便于后续按 '/' 切分。
 *
 * 为什么最后要折叠重复分隔符：`dir + '/' + file` 这种拼接在调用方到处都是，一旦
 * dir 自身已经以斜杠结尾就会产出 `C:/Users/alice//notes/a.md`。不折叠的话家目录
 * 的形状识别（`C:/Users/<name>`）会因为多了一个斜杠而失配 —— 于是家目录就整段漏进
 * 日志里。宁可在 normalization 阶段多花一次正则，也不能把「认不认得出家目录」
 * 这种致命判定交给调用方的拼接习惯。
 * @param {string} raw
 * @returns {string}
 */
function normalizeSeparators (raw) {
  return String(raw)
    .replace(/^\\\\\?\\/, '') // \\?\C:\... 长路径标记
    .replace(/^\\\\\.\\/, '') // \\.\ 设备命名空间
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
}

/** home 参数归一化：同一套分隔符，去掉结尾斜杠 */
function normalizeHome (home) {
  return normalizeSeparators(home).replace(/\/+$/, '')
}

/** 是否为带类型的平台对象（全部靠形状判断，不 import 任何模块） */
function isDateLike (v) {
  return Object.prototype.toString.call(v) === '[object Date]'
}
function isRegExpLike (v) {
  return Object.prototype.toString.call(v) === '[object RegExp]'
}
function isErrorLike (v) {
  // 跨 realm（iframe / Electron 隔离世界）时 instanceof Error 会失灵，按形状判定更稳
  return v instanceof Error || Object.prototype.toString.call(v) === '[object Error]'
}
function isDomNode (v) {
  return !!v && typeof v === 'object' && typeof v.nodeType === 'number' && typeof v.nodeName === 'string'
}
function isBinaryLike (v) {
  return (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) ||
    (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(v))
}

// ---------------------------------------------------------------------------
// 对外 API 1：敏感 key 判定
// ---------------------------------------------------------------------------

/**
 * key 是否命中敏感名单。
 * @param {unknown} key 对象的属性名（非字符串一律不算敏感，交给上层按普通值处理）
 * @returns {boolean}
 */
export function isSensitiveKey (key) {
  if (typeof key !== 'string' || key === '') return false
  // 模式没有 g 标志，test 无状态，重复调用安全
  return SENSITIVE_KEY_PATTERN.test(key)
}

/**
 * 这是一个“敏感 vault 条目”吗？
 *
 * 为什么用真值判定而不是 `=== true`：
 * 见到 truthy 就按敏感处理，等价于只走私最保守的那条分支；而只认 `=== true` 的话，
 * 一旦将来有人把 secret 写成字符串 'true' 或 1，key/note 就会悄悄回到明文。
 * 这里宁可多遮，不可漏遮。
 * @param {object|null} obj
 * @returns {boolean}
 */
export function isSecretEntry (obj) {
  return !!obj && typeof obj === 'object' && !!obj.secret
}

// ---------------------------------------------------------------------------
// 对外 API 2：路径遮蔽
// ---------------------------------------------------------------------------

/**
 * 剥掉家目录前缀，返回剩余部分与「是否剥过」。
 *
 * 顺序：显式 home（主进程给的 `app.getPath('home')`，最准）→ 形状兜底（上面四条
 * 常见写法 → 无则不动。返回 hadHome 是为了让调用方知道「上面其实还有东西」，
 * 从而决定要不要补 `…/` 前缀。
 * @param {string} normalized 已归一化分隔符的路径
 * @param {string} home 显式家目录（已归一化，无尾斜杠）
 * @returns {{rest: string, hadHome: boolean}}
 */
function stripHome (normalized, home) {
  if (home) {
    const lowerAll = normalized.toLowerCase()
    const lowerHome = home.toLowerCase()
    if (lowerAll === lowerHome) return { rest: '', hadHome: true }
    if (lowerAll.startsWith(lowerHome + '/')) return { rest: normalized.slice(home.length + 1), hadHome: true }
  }
  for (const re of HOME_ROOT_PATTERNS) {
    const m = re.exec(normalized)
    if (m) return { rest: normalized.slice(m[0].length), hadHome: true }
  }
  return { rest: normalized, hadHome: false }
}

/**
 * ⚠️ 双副本警告（DUAL-COPY）：`redactPath` 及其关键正则 / 常量在
 * `electron/main.cjs` 里还有一份**等价的 CJS 副本** —— 主进程是 CommonJS 且
 * `src/` 不进安装包，无法 import 本模块。**改这里必须同步改那边**，否则
 * 「家目录必须遮蔽」会在主进程侧漏掉，而主进程记的恰恰是最容易夹带绝对路径的
 * 那些记录（写盘失败 / 越界拒绝 / errno 上下文）。
 * 两份的一致性由 `tests/mainLogParity.test.js`（源码级比对）守卫。
 *
 * 遮蔽路径：剥家目录 + 只保留文件名与其**父目录名**，更上层一律折叠成 `…/`。
 *
 * 例子（与 design §3.4 / §4.4 的样例对齐）：
 *   '/Users/alice/notes/a.md'            → '…/notes/a.md'
 *   '/Users/alice/a.md'                  → '…/a.md'
 *   'C:\\Users\\alice\\AppData\\x.json'  → '…/AppData/x.json'
 *   'notes/a.md'                         → '…/notes/a.md'   （相对路径，两级以上同样折叠）
 *   'a.md'                               → 'a.md'           （只有一个名字，无从泄露）
 *   '/Users/alice'                       → '…'
 *
 * 为什么保留一级父目录而不是只留文件名：日志里 `path=…/a.md` 无法区分同名文件，
 * 而 Obsidian 式库里同名笔记本来就多；一级目录名已经足够定位，又不会把
 * 「用户把笔记放在哪个深层私人目录」这条信息交出去。**这是设计给定的口径**
 * （design §3.4「保留 basename，目录层替换为 …/」+ §4.4 样例），不是本模块自选。
 *
 * @param {unknown} p 待处理的路径
 * @param {{home?: string}} [opts] home：显式家目录，优先级高于形状识别
 * @returns {string} 永远是字符串；非字符串入参返回空串
 */
export function redactPath (p, opts = {}) {
  if (typeof p !== 'string' || p === '') return ''

  const home = typeof opts.home === 'string' ? normalizeHome(opts.home) : ''
  const raw = normalizeSeparators(p).trim()
  const isAbs = IS_ABSOLUTE_RE.test(raw)

  const { rest, hadHome } = stripHome(raw, home)
  // '.' 是「当前目录」，没有信息量；'..' 一旦保留反而暗示了相对位置，一并丢弃
  const parts = rest.split('/').filter(seg => seg !== '' && seg !== '.' && seg !== '..')

  // 家目录本身：剩余为空，只能给出省略符
  if (parts.length === 0) return hadHome || isAbs ? `${ELLIPSIS}/` : ''

  const base = parts[parts.length - 1]
  // 绝对路径唯一名字也要带 '…/'：它明确告诉读日志的人「上面被裁掉了」，
  // 同时也让 `path=…/a.md`（design §3.4 样例）这种形态对所有绝对路径保持一致。
  if (parts.length === 1) {
    if (hadHome || isAbs) return `${ELLIPSIS}/${base}`
    return base
  }
  return `${ELLIPSIS}/${parts[parts.length - 2]}/${base}`
}

// ---------------------------------------------------------------------------
// 对外 API 3：内容截断
// ---------------------------------------------------------------------------

/**
 * 控制字符折叠成一行的转义文本。
 *
 * 两个目的：① 日志必须一行一条，正文里的换行会把 `t / lvl / mod` 的时间线撕断，
 *    后面的记录看着像是格式坏了；② Windows 文件名/编辑器插件都可能带来控制字符，
 *    原文进日志等于往文件里塞不可见字节。**输出的是转义后的文本而不是原始字节**，
 *    这条同时满足了项目「源码与产物里禁止裸 NUL 字节」的硬约束。
 * @param {string} s
 * @returns {string}
 */
function foldControlChars (s) {
  return String(s)
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001F\u007F]/g, ch => {
      const code = ch.charCodeAt(0).toString(16).padStart(4, '0')
      return `\\u${code}`
    })
}

/**
 * 内容片段脱敏（截断 + 折叠换行）。
 *
 * 按**码点**而不是 UTF-16 码元切：'\u{20BB7}'.length === 2，按 length 切片会把一个
 * 汉字劈成两半，日志里留下 U+FFFD。Array.from 之后切片再 join 可保证不破字。
 *
 * @param {unknown} s 待处理内容
 * @param {number} [max=120] 上限；非法值回落到 120
 * @returns {string}
 */
export function redactContent (s, max = DEFAULT_CONTENT_MAX) {
  let text
  // String(Symbol()) 会抛；拿不到文本时按最保守处理（失败即遮蔽）
  try {
    text = typeof s === 'string' ? s : String(s)
  } catch {
    return REDACTED
  }
  const limit = positiveInt(max, DEFAULT_CONTENT_MAX)
  const folded = foldControlChars(text)
  // 折叠后长度可能变化，一律按码点切
  const chars = Array.from(folded)
  if (chars.length <= limit) return folded
  return chars.slice(0, limit).join('') + ELLIPSIS
}

// ---------------------------------------------------------------------------
// 字符串中的路径遮蔽
// ---------------------------------------------------------------------------

/** 单串处理：整串是路径直接整体遮蔽；否则只替换内嵌的绝对路径片段 */
function sanitizeString (raw, state) {
  let text
  try {
    text = typeof raw === 'string' ? raw : String(raw)
  } catch {
    return REDACTED
  }
  let masked
  if (WHOLE_PATH_RE.test(text)) {
    masked = redactPath(text, { home: state.home })
  } else {
    masked = text.replace(EMBEDDED_PATH_RE, (_, lead, token) => lead + redactPath(token, { home: state.home }))
  }
  return redactContent(masked, state.maxString)
}

// ---------------------------------------------------------------------------
// 对外 API 4：通用值脱敏
// ---------------------------------------------------------------------------

/** Error 序列化：message / stack 是非枚举属性，直接展开对象是空的 */
function errorToObject (err, state, depth) {
  const out = {}
  for (const k of ['name', 'message', 'code', 'errno']) {
    const v = err[k]
    if (v === undefined || v === null) continue
    out[k] = typeof v === 'string' ? sanitizeString(v, state) : walkValue(v, state, depth + 1)
  }
  if (typeof err.stack === 'string' && err.stack) {
    // 只留栈顶三行：再往下全是框架内部帧，对排查无用却把样例体积翻几倍
    const frames = err.stack.split(/\r?\n/).slice(0, 3).join(' | ')
    out.stack = sanitizeString(frames, state)
  }
  return out
}

/** 单个节点的类型分派 */
function walkValue (value, state, depth) {
  // 每个节点都兜一层 try/catch：任何一个分支抛出（Vue 响应式 getter、宿主对象的
  // Proxy trap、跨 realm 对象的怪异 toString）都必须收敛成 REDACTED，而不是把
  // 原始值放行出去，也不是把异常抛给正在打日志的业务代码。
  try {
    return walkInner(value, state, depth)
  } catch {
    return REDACTED
  }
}

function walkInner (value, state, depth) {
  if (value === null || value === undefined) return value

  // 总量闸门：超预算的节点直接给标记，不再深入
  if (state.nodes >= state.maxNodes) return '[BudgetExceeded]'
  state.nodes += 1

  // ---- 基本类型 ----
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return safeString(value)
  if (typeof value === 'function') return '[Function]'
  if (typeof value === 'string') return sanitizeString(value, state)

  // ---- 平台对象 ----
  if (isDomNode(value)) return '[DOMNode]'
  if (isBinaryLike(value)) return `[Binary:${typeof value.byteLength === 'number' ? value.byteLength : '?'}]`
  if (isDateLike(value)) return Number.isFinite(value.getTime()) ? sanitizeString(value.toISOString(), state) : '[InvalidDate]'
  if (isRegExpLike(value)) return safeString(value)
  if (isErrorLike(value)) return errorToObject(value, state, depth)

  // ---- 结构类型：MAP / SET 转成数组，让日志文本渲染与普通数组一致 ----
  const tag = Object.prototype.toString.call(value)
  if (tag === '[object Map]' || tag === '[object Set]') {
    return walkArrayLike(Array.from(value), state, depth)
  }

  if (depth >= state.maxDepth) return value.constructor && typeof value.constructor.name === 'string'
    ? `[Object:${value.constructor.name}]`
    : '[Object]'

  // 环路保护：只跟踪「当前祖先链」而不是全局访问过的对象，这样同一份数据在树的不同
  // 分支里重复出现仍能各自渲染（对排查很有用），只有真的自引用才判定为环。
  if (state.chain.has(value)) return '[Circular]'
  state.chain.add(value)
  try {
    if (Array.isArray(value)) return walkArrayLike(value, state, depth)
    return walkObject(value, state, depth)
  } finally {
    state.chain.delete(value)
  }
}

function safeString (v) {
  try {
    return String(v)
  } catch {
    return REDACTED
  }
}

function walkArrayLike (list, state, depth) {
  const out = []
  const cap = Math.min(list.length, state.maxArray)
  for (let i = 0; i < cap; i += 1) {
    out.push(walkValue(list[i], state, depth + 1))
  }
  if (list.length > cap) out.push(`${ELLIPSIS}(+${list.length - cap})`)
  return out
}

function walkObject (obj, state, depth) {
  // secret 条目的额外脱敏名单（仅对本层生效）——理由见文件头 3
  const extraSensitive = isSecretEntry(obj)
  const out = {}
  let keys
  try {
    keys = Object.keys(obj)
  } catch {
    return REDACTED
  }
  const cap = Math.min(keys.length, state.maxKeys)
  for (let i = 0; i < cap; i += 1) {
    const k = keys[i]
    if (isSensitiveKey(k) || (extraSensitive && SECRET_ENTRY_EXTRA_KEYS.includes(k))) {
      // 整体替换：连类型与长度都不留（'{ value: "[REDACTED]" }' 里的长度信息虽然弱，
      // 但「这条密码是 6 位还是 32 位」仍然是在回答攻击者的问题）
      out[k] = REDACTED
      continue
    }
    let v
    try {
      v = obj[k] // 取属性本身可能抛（getter），单独兜一层，失败即遮蔽
    } catch {
      out[k] = REDACTED
      continue
    }
    out[k] = walkValue(v, state, depth + 1)
  }
  if (keys.length > cap) out.__truncated = `${ELLIPSIS}(+${keys.length - cap} keys)`
  return out
}

/**
 * 通用值脱敏：把任意入参转成「可以安全出日志的结构」。
 *
 * 不变量（T14 可逐条断言）：
 *   1. 返回值一定可以被 JSON.stringify —— 不留 Function / Symbol / 二进制 / 环；
 *   2. 任何命中敏感名单的 key、以及 secret 条目的 key/note，值恒为 '[REDACTED]'；
 *   3. 所有字符串已过路径遮蔽 + 长度截断；
 *   4. **绝不抛异常**：外层已有 try/catch 兜底，业务代码不会因为「打条日志」而崩。
 *
 * @param {unknown} value 任意值
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=3] 下潜层数
 * @param {number} [opts.maxString=200] 单串上限（logger 调用时传 120）
 * @param {number} [opts.maxKeys=40] 单对象 key 数上限
 * @param {number} [opts.maxArray=30] 单数组项数上限
 * @param {number} [opts.maxNodes=500] 本次处理的总节点预算
 * @param {string} [opts.home] 显式家目录，用于路径遮蔽
 * @returns {any}
 */
export function sanitizeValue (value, opts = {}) {
  const state = {
    maxDepth: positiveInt(opts.maxDepth, DEFAULT_MAX_DEPTH),
    maxString: positiveInt(opts.maxString, DEFAULT_MAX_STRING),
    maxKeys: positiveInt(opts.maxKeys, DEFAULT_MAX_KEYS),
    maxArray: positiveInt(opts.maxArray, DEFAULT_MAX_ARRAY),
    maxNodes: positiveInt(opts.maxNodes, DEFAULT_MAX_NODES),
    home: typeof opts.home === 'string' ? normalizeHome(opts.home) : '',
    chain: new Set(),
    nodes: 0
  }
  return walkValue(value, state, 0)
}
