// ============================================================================
// dateMigration.js —— 一次性「日期固化」迁移（T18 · R-C1 / R-D1）
//
// 背景：日期归属口径已由 `dateAttribution.js` 定成四级回落
//   （frontmatter > birthtime > 标题日期串 > updatedAt），`noteIndex.js` 的
//   dateKey 也改用它。但 ②③④ 三级本质上都是「每次启动重新猜一遍」：
//   birthtime 会被复制/同步重置、标题日期靠字符串扫描、updatedAt 更是每天在动。
//
// 本模块做且只做一件事：把**当前** `resolveNoteDate()` 解析出来的日期写进
// frontmatter 的 `date:`，让日期从此变成笔记自带的事实。跑完之后 ① 级永久
// 生效，日历与排序不再随文件属性漂移。
//
// 形态为什么是依赖注入：
//   · `writeFile` 由调用方给 —— 本模块不碰 IPC、不碰 electronAPI，Node 单测里
//     塞一个记录器就能断言「正文零改动」；
//   · `readFlag` / `writeFlag` 由调用方给 —— 防重跑标记落在哪儿（localStorage /
//     userData JSON）是宿主的决定，本模块只认「有没有」；
//   · `now` 可注入 —— 让「同一份库 + 同一个时钟」永远得到同一份结果。
//
// 四条铁律：
//   1. **只写 frontmatter，正文一个字节都不动**（写入前后正文逐字节相等）；
//   2. **写入失败不落标记**，下次启动还能重试（落了标记 = 永久放弃这批笔记）；
//   3. **已有 `date:`（或 DATE_KEYS 任一兼容键）的笔记直接跳过**，绝不写第二个
//      date 键 —— 重复键里「先写先赢」，后写的那个永远读不到，等于白写；
//   4. **④ 级（updatedAt）不许固化**（主理人裁决 2，见 `trustworthyOnly`）。
//      `updatedAt` 的语义是「最后一次修改时间」，把它写进 frontmatter 等于把
//      「用户碰巧在哪天跑迁移」写成笔记的生日 —— 那是造假数据；而且一旦写死成
//      ① 级，后续批次真正接进 `fs.stat().birthtime` 之后，② 级证据就再也没有
//      机会让位上来了。所以 ④ 级一律留在「每次启动实时解析」的状态。
//
// 纯内核边界：本模块不 import vue / pinia / store，也不 import 任何组件。
// 唯一的环境依赖是默认 flag 读写兜底用的 localStorage（缺环境时自动降级为
// 「读不到 / 写不进」，不抛异常）。
// ============================================================================

import { LS_KEYS } from '../constants/storage.js'
import {
  DATE_SOURCE,
  DATE_SOURCES,
  DATE_KEYS,
  resolveNoteDate,
  toISODate
} from './dateAttribution.js'

// ---------------------------------------------------------------------------
// frontmatter 围栏：与 dateAttribution.js / useLinks.js 三方逐字对齐
// ---------------------------------------------------------------------------

/**
 * 三个正则逐字抄自 `src/composables/useLinks.js:10-11` 与 `:27`，与
 * `dateAttribution.js` 内部的 FM_* 完全一致。
 *
 * 抄而不 import 的理由与 `dateAttribution.js` 文件头一致（那两处不是导出的）。
 * 这里多抄一份是**刻意的重复**：迁移写进去的 `date:` 必须能被
 * `dateAttribution` 读出来，两侧对「什么算 frontmatter」的定义一旦漂移，
 * 迁移就变成「写了但读不到」的静默失败。tests/dateMigration.test.js 里有
 * 一组用例专门钉住这个往返（写进去 → resolveNoteDate 读到 frontmatter 级）。
 */
const FM_START = /^---\s*\n/
const FM_FENCE = /^---\s*\n([\s\S]*?)\n---\s*\n?/m
const FM_HEADER = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*:\s*(.*)$/

/** DATE_KEYS 的小写集合：键名匹配大小写不敏感（YAML 手写的现实） */
const DATE_KEY_SET = new Set(DATE_KEYS.map(key => String(key).toLowerCase()))

/** 迁移写入的规范化键。DATE_KEYS 里它排第一，写进去就一定赢。 */
const WRITE_KEY = 'date'

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * bySource 的零值直方图（键由 DATE_SOURCES 生成，加来源不用改这里）。
 * @returns {Record<string, number>} 四级来源全 0
 */
function emptyBySource () {
  const out = {}
  for (const source of DATE_SOURCES) out[source] = 0
  return out
}

/**
 * 造一份结果对象。
 * @param {number} total 笔记总数
 * @param {boolean} ran 是否真的跑了（false = 被 flag 拦下）
 * @returns {object} 结果
 */
function makeResult (total, ran) {
  return {
    total,
    migrated: 0,
    /** 跳过：笔记里已经有 DATE_KEYS 中某个键，不需要写 */
    skipped: 0,
    /** 失败：writeFile 抛异常 / 返回假值。有它就不写 flag */
    failed: 0,
    /** 无法落盘：笔记本身不是对象、或没有 filePath。不阻塞 flag */
    unwritable: 0,
    /**
     * 不被采信（`trustworthyOnly` 开启时专有）：来源为 ④ 级 `updatedAt`，按裁决
     * 主动**不固化**。单独计数而不混进 `skipped`，是为了让「跳过是因为已经有
     * date」与「跳过是因为不敢写」在验证脚本里能分开读 —— 前者是终态，后者是
     * 「等更可信的证据」。
     */
    untrusted: 0,
    /**
     * 四级来源直方图，只统计**真正写入**的那些笔记（也就是迁移前它们是靠哪
     * 一级证据定日期的）。被跳过的那批来源恒为 frontmatter，数量就是 skipped。
     */
    bySource: emptyBySource(),
    ran
  }
}

/**
 * 默认标记读取：localStorage。缺环境时返回 null（视为「没跑过」）。
 * @returns {string|null} 标记值
 */
function defaultReadFlag () {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null
    return localStorage.getItem(LS_KEYS.dateMigration)
  } catch {
    return null
  }
}

/**
 * 默认标记写入：localStorage。写不进去返回 false，不抛。
 * @param {number|string} value 完成时间戳
 * @returns {boolean} 是否写进去了
 */
function defaultWriteFlag (value) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false
    localStorage.setItem(LS_KEYS.dateMigration, String(value))
    return true
  } catch {
    return false
  }
}

/**
 * 标记算不算「已经跑过」。
 *
 * 只有 null / undefined / 空串算没跑过：`'0'` 也是一次合法的完成时间戳
 * （1970 年），不能因为字符串假值判断把它当成没跑过而重跑一遍。
 *
 * @param {unknown} value readFlag 的返回值
 * @returns {boolean}
 */
function flagPresent (value) {
  return value !== null && value !== undefined && value !== ''
}

/**
 * 检测文件用的是 CRLF 还是 LF，插入的行必须跟着走。
 * @param {string} text 笔记全文
 * @returns {string} '\r\n' 或 '\n'
 */
function detectEol (text) {
  return text.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 笔记的 frontmatter 里是不是已经有日期键（DATE_KEYS 任一）。
 *
 * 注意这是**键存在性**判断，不是「能不能解析出来」：
 *   · `date: 待定` 也算有键 → 跳过。因为再写一个 `date:` 会变成重复键，而
 *     dateAttribution 的规则是「同优先级先写先赢」，后写的永远读不到，白写。
 *   · 这种笔记的正确修法是人工改，不是脚本覆盖。
 *
 * 必须带围栏：正文里某行恰好以 `date:` 开头（代码块、摘录）不算 frontmatter。
 *
 * @param {string|null} content 笔记全文
 * @returns {boolean} 有日期键返回 true
 */
export function hasFrontmatterDateKey (content) {
  const text = typeof content === 'string' ? content : ''
  if (!FM_START.test(text)) return false
  const m = text.match(FM_FENCE)
  if (!m) return false
  for (const rawLine of m[1].split(/\r?\n/)) {
    // CRLF 时块末尾会残留 \r（\n 被围栏正则吃掉），先剥再匹配
    const line = rawLine.replace(/\r+$/, '')
    const h = FM_HEADER.exec(line)
    if (!h) continue
    if (DATE_KEY_SET.has(String(h[1]).toLowerCase())) return true
  }
  return false
}

/**
 * 把 `date: YYYY-MM-DD` 写进 frontmatter，**正文一个字节都不动**。
 *
 * 三种输入形态：
 *   ① 有完整围栏 → 插到围栏内第一行（最显眼，且绝不会被上方的嵌套结构吞掉）；
 *   ② 没有围栏 / 围栏没闭合 → 整块前置（`---\ndate: X\n---\n` + 原文）。
 *      原文逐字节保留，只是前面多了一个规范的 frontmatter 块。
 *      围栏没闭合时只能这么办：往一个没闭合的块里塞 date 仍然读不出来
 *      （FM_FENCE 要求闭合），那就等于白写。
 *   ③ 空内容 → 结果就是那个块本身。
 *
 * 行尾跟着文件走（CRLF 文件插入 CRLF 行），否则一个文件里混两种换行，
 * 后续 diff / 同步工具会整篇报改。
 *
 * @param {string|null} content 笔记全文
 * @param {string} isoDate 'YYYY-MM-DD'（本地日历日，来自 toISODate）
 * @returns {string} 新的笔记全文；isoDate 为空时原样返回
 */
export function withFrontmatterDate (content, isoDate) {
  const text = typeof content === 'string' ? content : ''
  if (!isoDate) return text

  const eol = detectEol(text)
  const line = `${WRITE_KEY}: ${isoDate}`

  if (FM_START.test(text)) {
    const fenced = text.match(FM_FENCE)
    if (fenced) {
      // FM_START 保证开头一定有一个 \n（`---\s*\n`），它就是首行的结束
      const breakAt = text.indexOf('\n')
      if (breakAt >= 0) {
        const opening = text.slice(0, breakAt + 1)
        return opening + line + eol + text.slice(breakAt + 1)
      }
    }
  }

  // 无围栏 / 围栏未闭合 / 极端到连一个 \n 都没有：整块前置
  return `---${eol}${line}${eol}---${eol}` + text
}

/**
 * 一次性日期固化迁移。
 *
 * 流程：
 *   1. `readFlag()` 有值 → 直接返回，**不重跑**（返回形状见下）；
 *   2. 逐篇：已有日期键 → skipped；无 filePath / 非对象 → unwritable；
 *      否则 `resolveNoteDate()` 解析 → `withFrontmatterDate()` 造新内容 →
 *      `writeFile(path, next)`；
 *   3. 有任意一篇 failed → **不写 flag**（下次启动整库重来，已固化那批会
 *      被 skipped，不会重复写）；
 *   4. 一篇都没走到终态（migrated + skipped === 0，典型是 writeFile 没接上）
 *      → 也不写 flag，否则等于把迁移永久关掉；
 *   5. 空库（total === 0）不写 flag —— 否则「笔记还没载入就跑了一次迁移」会把
 *      标记打死，真库永远轮不到迁移；
 *   6. 其余 → `writeFlag(nowTs)`。
 *
 * @param {object} [options] 选项
 * @param {Array<object>} [options.notes=[]] 笔记数组
 * @param {(path: string, content: string) => Promise<boolean>} options.writeFile
 *        写盘函数，返回真值算成功，抛异常或返回假值算失败
 * @param {boolean} [options.trustworthyOnly=false] **裁决 2**：只固化「可信来源」
 *        —— frontmatter(已跳过) / birthtime / 标题日期串 三类；解析来源为
 *        `DATE_SOURCE.UPDATED_AT`（④ 级）的笔记**一个字节都不写**，计入
 *        `untrusted`。理由见文件头铁律 4：把「最后一次修改时间」固化成生日是
 *        造假，且会永久压住后续批次接进来的 birthtime。默认 false 保留 T18
 *        的原始行为（全量固化），T19 的 note.js 调用时**必须**传 true。
 * @param {() => (string|null|undefined)} [options.readFlag] 读标记；默认读 localStorage
 * @param {(value: number) => boolean} [options.writeFlag] 写标记；默认写 localStorage
 * @param {number} [options.now=Date.now()] 可注入时钟（毫秒）
 * @returns {Promise<{ total: number, migrated: number, skipped: number,
 *                     failed: number, unwritable: number, untrusted: number,
 *                     bySource: Record<string, number>, ran: boolean }>}
 *          恒有 `total === migrated + skipped + failed + unwritable + untrusted`。
 *          被 flag 拦下时：`{ total: notes.length, migrated: 0, skipped: total,
 *          failed: 0, unwritable: 0, untrusted: 0, bySource: 全 0, ran: false }`。
 *
 * 关于「什么时候写 flag」（与 trustworthyOnly 直接相关，容易踩）：
 *   只要 `trustworthyOnly` 开启且本轮有 `untrusted > 0`，就**不写 flag** ——
 *   那批笔记是在等更可信的证据（将来接进来的 birthtime），标记一落就等于永远
 *   放弃它们。代价是：库里只要还剩一篇 ④ 级笔记，迁移每次启动都会重跑一遍
 *   （纯内存解析，不写任何文件），直到那批笔记拿到更高级的证据为止。
 */
export async function runDateMigration (options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const notes = Array.isArray(opts.notes) ? opts.notes : []
  const writeFile = typeof opts.writeFile === 'function' ? opts.writeFile : null
  const readFlag = typeof opts.readFlag === 'function' ? opts.readFlag : defaultReadFlag
  const writeFlag = typeof opts.writeFlag === 'function' ? opts.writeFlag : defaultWriteFlag
  // 裁决 2：true 时只固化可信来源，④ 级（updatedAt）一律不写
  const trustworthyOnly = opts.trustworthyOnly === true

  const nowRaw = opts.now === undefined ? Date.now() : opts.now
  const nowNumber = Number(nowRaw)
  const nowTs = Number.isFinite(nowNumber) ? nowNumber : Date.now()

  const result = makeResult(notes.length, true)

  // ---- 前置闸门：跑过就不再跑 ----
  if (flagPresent(readFlag())) {
    return {
      total: notes.length,
      migrated: 0,
      skipped: notes.length,
      failed: 0,
      unwritable: 0,
      untrusted: 0,
      bySource: emptyBySource(),
      ran: false
    }
  }

  // 逐篇串行写：写盘是覆盖语义，并发同一个文件会互相踩；500 篇的库一次
  // 启动也就多几百毫秒，换来的顺序可预测性值得。
  for (const note of notes) {
    if (!note || typeof note !== 'object') {
      result.unwritable += 1
      continue
    }

    const filePath = typeof note.filePath === 'string' ? note.filePath : ''
    if (!filePath || !writeFile) {
      result.unwritable += 1
      continue
    }

    const content = typeof note.content === 'string' ? note.content : ''

    // 已有日期键：跳过（理由见 hasFrontmatterDateKey 的注释）
    if (hasFrontmatterDateKey(content)) {
      result.skipped += 1
      continue
    }

    // birthtime 走 note.birthtime：渲染侧拿到它得靠主进程 fs.stat（后续批次），
    // 现在没有就是 undefined → resolveNoteDate 自动落到下一级。
    const resolved = resolveNoteDate(
      { content, title: note.title, updatedAt: note.updatedAt },
      { birthtime: note.birthtime === undefined ? null : note.birthtime, now: nowTs }
    )

    // 裁决 2：④ 级（updatedAt）不固化 —— 「最后修改时间」不是生日，写进去就是
    // 造假，而且会永久压住后续批次接进来的 birthtime。留在实时解析状态。
    if (trustworthyOnly && resolved.source === DATE_SOURCE.UPDATED_AT) {
      result.untrusted += 1
      continue
    }

    const isoDate = toISODate(resolved.date)
    // 防御：拿不到合法日期就绝不落盘（宁可 failed 也不能把垃圾固化进去）
    if (!isoDate) {
      result.failed += 1
      continue
    }

    const next = withFrontmatterDate(content, isoDate)
    // 防御：内容没变化就别写（也不会发生，留着防将来改动写坏）
    if (next === content) {
      result.skipped += 1
      continue
    }

    let ok = false
    try {
      ok = await writeFile(filePath, next)
    } catch {
      ok = false
    }
    ok = Boolean(ok)

    if (!ok) {
      result.failed += 1
      continue
    }

    result.migrated += 1
    if (Object.prototype.hasOwnProperty.call(result.bySource, resolved.source)) {
      result.bySource[resolved.source] += 1
    }
    // 同步内存里的 content：不这么做的话索引里的 dateKey 还是旧值，
    // 用户得重启才能看到日历变化（写入成功才同步，失败保持原样）
    note.content = next
  }

  // 能不能落标记，看的是「有没有一篇走到终态」：
  //   · failed > 0 → 绝不落（落了 = 永久放弃这批笔记）；
  //   · migrated + skipped === 0 → 说明这批笔记一篇都没处理成（全是 unwritable，
  //     典型是 writeFile 没接上），落标记等于把迁移永远关掉，也不落。
  const settled = result.migrated + result.skipped
  // 「还有一批在等更可信的证据」时不落标记：落了就等于永久放弃它们（见 JSDoc）
  const waitingForBetterEvidence = trustworthyOnly && result.untrusted > 0
  if (result.total > 0 && result.failed === 0 && settled > 0 && !waitingForBetterEvidence) {
    writeFlag(nowTs)
  }

  return result
}

/**
 * 四级来源常量再导出：调用方（T19 的日志 / 验证脚本）不必再去找
 * dateAttribution.js 要这份名单。
 */
export { DATE_SOURCE, DATE_SOURCES, DATE_KEYS }
