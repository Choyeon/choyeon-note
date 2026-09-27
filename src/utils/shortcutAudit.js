/**
 * 快捷键注册表 ↔ 执行器 覆盖校验。
 *
 * 为什么需要它：`SHORTCUTS`（注册表）是**声明**，真正的执行分散在两张互不知情的表里 ——
 * App 命令（`useAppActions.js` 的 APP_ACTION_IDS）与编辑器命令（`useEditor.js` 的 EDITOR_COMMAND_IDS）。
 * 两边没有编译期联系，历史上因此出现过「注册表有、执行器无」的死命令（设置页能改键、改完不生效）
 * 和「执行器有、注册表无」的野命令（功能能跑、但用户改不了键也搜不到）。
 * 本模块把这两类漂移变成可在 CI 中断言的纯函数结果。
 *
 * 约束：
 * - **纯函数**：不 import 任何 vue / store / router / CodeMirror，不碰 DOM，可在 node 与 jsdom 下直接跑。
 * - 只读依赖 `src/constants/shortcuts.js`（注册表 + 规范化器），除此之外无依赖。
 * - 判定只用入参，不读全局单例；`shortcuts` / `normalize` 可被注入，方便造人为故障做测试。
 * - **本模块自己不打日志**：校验结果只作为返回值交出去，告警由调用方（App.vue 的
 *   dev 期守卫，走 logger 的 app 模块）发出。这样 `auditShortcuts` 才可能在任何环境
 *   被调用且不产生任何副作用，同时避免「调用方记一条 + 模块内记一条」的重复日志。
 *   因此这里**不要** import logger —— 即便 logger 三件套本身确实是零依赖的纯模块。
 *
 * 预期调用方式（App.vue 开发期守卫与 tests/shortcuts.test.js 共用同一份形状）：
 *
 * ```js
 * import { auditShortcuts } from '@/utils/shortcutAudit'
 * import { APP_ACTION_IDS } from '@/composables/useAppActions'   // T02：Object.keys(createAppActions({}))
 * import { EDITOR_COMMAND_IDS } from '@/composables/useEditor'    // T04：Object.keys(EDITOR_COMMANDS)
 *
 * const result = auditShortcuts({
 *   appActionIds: APP_ACTION_IDS,
 *   editorCommandIds: EDITOR_COMMAND_IDS
 * })
 * // log 是调用方自己的 logger（App.vue 里为 createLogger(LOG_MODULES.app)）
 * if (!result.ok) log.error('[shortcut-audit] 注册表 ↔ 执行器 校验未通过', result.counts)
 * ```
 *
 * id 集合**必须从执行器对象派生**（`Object.keys(...)`），不要手写第二份清单 ——
 * 手写清单本身就会漂移，等于把这个模块的意义废掉。
 */

import { SHORTCUTS, SHORTCUT_SCOPES, normalizeBinding } from '../constants/shortcuts.js'

/** audit reason 枚举对应的语义说明，供日志 / 测试报错文案复用 */
export const AUDIT_REASONS = {
  'empty-key': 'default 非空但解析不出主键（如 "Mod-"）',
  'unknown-scope': 'scope 不是 app / editor，没有对应的执行器表',
  'duplicate-id': '注册表内出现了重复的命令 id',
  'not-normalized': 'default 的书写不是 normalizeBinding 的规范形式（如 "Shift-Mod-d"）'
}

/**
 * 把任意入参收敛成去重后的 id 数组，脏值一律丢弃。
 *
 * 兼容三种形态，是为了让「传错形状」不至于退化成静默通过：
 * - 数组 / Set（推荐形态：`Object.keys(执行器对象)`）
 * - 类数组
 * - 执行器对象本身（没有迭代器）→ 直接取 `Object.keys(input)`，容错但不推荐依赖
 */
function toIdList (input) {
  if (!input) return []
  let source = []
  if (Array.isArray(input) || input instanceof Set) {
    source = Array.from(input)
  } else if (typeof input === 'object' && typeof input[Symbol.iterator] === 'function') {
    source = Array.from(input)
  } else if (typeof input === 'object') {
    source = Object.keys(input)
  }
  const out = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * 校验注册表与两张执行器表的覆盖关系。
 *
 * 四类问题（与 PRD P0-1 逐字对齐）：
 * - `dead`：注册表中**非 hidden** 的命令，在其 scope 对应的执行器集合里查无此 id。
 *   hidden 命令跳过 dead 判定，是因为它们本来就是不打算暴露给用户的内部别名
 *   （如 `edit.redoAlt`、`insert.date`），但它们**仍然参与** duplicateDefault 判定 ——
 *   hidden 不等于不占键，历史上 `insert.date`（hidden）就撞过 `edit.duplicateLine`。
 * - `orphan`：执行器集合里有、注册表里没有的 id（用户无法自定义这些命令的键位）。
 * - `duplicateDefault`：规范化后**同 scope 内**默认键重复。跨 scope 不算冲突 ——
 *   `Mod-,` 同时给 app 和 editor 两条命令是合法且常见的。
 * - `invalidSyntax`：`default` 无法被正确解析（主键为空）、scope 非法、id 重复、
 *   或 default 的书写不是规范形式（会自动抓出 `Shift-Mod-d` 这类遗留写法）。
 *
 * @param {object} [options]
 * @param {Iterable<string>} [options.appActionIds] APP_ACTIONS 的 id 集合（由对象派生）
 * @param {Iterable<string>} [options.editorCommandIds] EDITOR_COMMANDS 的 id 集合（由对象派生）
 * @param {Array<{id: string, scope: string, default: string, hidden?: boolean}>} [options.shortcuts]
 *        默认读全局注册表；测试可注入带人为故障的假表
 * @param {(binding: string) => string} [options.normalize] 默认 `normalizeBinding`；可注入自定义规范化器
 * @returns {{
 *   ok: boolean,
 *   dead: string[],
 *   orphan: string[],
 *   duplicateDefault: Array<{scope: string, binding: string, ids: string[]}>,
 *   invalidSyntax: Array<{id: string, scope: string, default: string, reason: string}>,
 *   executorOverlap: string[],
 *   counts: {dead: number, orphan: number, duplicateDefault: number, invalidSyntax: number}
 * }} `executorOverlap` 仅作诊断用（同一 id 同时出现在两张执行器表），不计入 `ok`
 */
export function auditShortcuts (options = {}) {
  const {
    appActionIds = [],
    editorCommandIds = [],
    shortcuts = SHORTCUTS,
    normalize = normalizeBinding
  } = options

  const appIds = toIdList(appActionIds)
  const editorIds = toIdList(editorCommandIds)
  const appSet = new Set(appIds)
  const editorSet = new Set(editorIds)

  const dead = []
  const invalidSyntax = []
  const seenIds = new Set()
  const registryIds = new Set()

  // scope → 执行器 id 集合
  const runnersByScope = new Map([
    ['app', appSet],
    ['editor', editorSet]
  ])

  for (const item of shortcuts) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) continue

    registryIds.add(id)
    if (seenIds.has(id)) {
      invalidSyntax.push({ id, scope: item.scope, default: item.default, reason: 'duplicate-id' })
    } else {
      seenIds.add(id)
    }

    const rawDefault = typeof item.default === 'string' ? item.default : ''
    const normalized = normalize(rawDefault)

    // 1) default 非空却解析不出主键 → 语法非法
    if (rawDefault.trim() !== '' && normalized === '') {
      invalidSyntax.push({ id, scope: item.scope, default: rawDefault, reason: 'empty-key' })
    }
    // 2) default 不是规范书写 → 语法非法（能解析不代表写法统一，必须一并抓出来）
    if (rawDefault !== '' && normalized !== '' && normalized !== rawDefault) {
      invalidSyntax.push({ id, scope: item.scope, default: rawDefault, reason: 'not-normalized' })
    }

    // 3) scope 合法性 + 执行器是否存在
    const runner = runnersByScope.get(item.scope)
    if (!runner) {
      invalidSyntax.push({ id, scope: item.scope, default: rawDefault, reason: 'unknown-scope' })
      continue
    }
    if (!item.hidden && !runner.has(id)) {
      dead.push(id)
    }
  }

  // 4) 野命令：执行器有、注册表无
  const orphan = []
  for (const id of [...appIds, ...editorIds]) {
    if (!registryIds.has(id) && !orphan.includes(id)) orphan.push(id)
  }

  // 5) 默认键重复：按 scope 分组，只比同 scope
  const groups = new Map()
  for (const item of shortcuts) {
    if (!item || typeof item !== 'object') continue
    const normalized = normalize(typeof item.default === 'string' ? item.default : '')
    // 空 default（默认不绑键）不参与重复判定
    if (!normalized) continue
    if (!groups.has(item.scope)) groups.set(item.scope, new Map())
    const bucket = groups.get(item.scope)
    if (!bucket.has(normalized)) bucket.set(normalized, [])
    bucket.get(normalized).push(item.id)
  }

  const duplicateDefault = []
  for (const [scope, bucket] of groups) {
    for (const [binding, ids] of bucket) {
      if (ids.length > 1) duplicateDefault.push({ scope, binding, ids: [...ids] })
    }
  }

  // 6) 诊断项：同一 id 同时挂在两张执行器表上 —— 说明执行器切分出了问题，但不改变 ok 的口径
  const executorOverlap = appIds.filter(id => editorSet.has(id))

  const counts = {
    dead: dead.length,
    orphan: orphan.length,
    duplicateDefault: duplicateDefault.length,
    invalidSyntax: invalidSyntax.length
  }

  return {
    ok: counts.dead === 0 && counts.orphan === 0 && counts.duplicateDefault === 0 && counts.invalidSyntax === 0,
    dead,
    orphan,
    duplicateDefault,
    invalidSyntax,
    executorOverlap,
    counts
  }
}

/**
 * 把 audit 结果格式化成多行可读文本，供控制台告警 / 测试失败信息使用。
 *
 * @param {ReturnType<typeof auditShortcuts>} result
 * @returns {string} 无问题时返回空串
 */
export function formatAuditReport (result) {
  if (!result || result.ok) return ''
  const lines = []
  if (result.dead.length) {
    lines.push(`死命令 ${result.dead.length} 条（注册表有、执行器无）：${result.dead.join(', ')}`)
  }
  if (result.orphan.length) {
    lines.push(`野命令 ${result.orphan.length} 条（执行器有、注册表无）：${result.orphan.join(', ')}`)
  }
  if (result.duplicateDefault.length) {
    const detail = result.duplicateDefault
      .map(d => `[${d.scope}] ${d.binding} → ${d.ids.join(' / ')}`)
      .join('；')
    lines.push(`默认键冲突 ${result.duplicateDefault.length} 组：${detail}`)
  }
  if (result.invalidSyntax.length) {
    const detail = result.invalidSyntax
      .map(d => `${d.id} (${AUDIT_REASONS[d.reason] || d.reason})`)
      .join('；')
    lines.push(`语法非法 ${result.invalidSyntax.length} 条：${detail}`)
  }
  if (result.executorOverlap?.length) {
    lines.push(`执行器重叠（诊断）：${result.executorOverlap.join(', ')}`)
  }
  return lines.join('\n')
}

/** 注册表允许的 scope 集合，转发过来避免调用方再去 import 常量文件 */
export { SHORTCUT_SCOPES }
