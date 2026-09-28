// ============================================================================
// useFileUndo.js —— 文件操作撤回栈（T29 · R-D5 可恢复性）
//
// 痛点：误删 / 误移 / 误改名没有回头路。Obsidian 的做法是「操作级撤销」——
// 刚才那一步不算，与「最近删除」的**内容级**恢复（T28，磁盘 .trash，重启后
// 也能找回）互补。两者刻意**不互相调用**：本模块只认内存里的操作栈，
// 绝不读 .trash、也不知道回收站的存在。
//
// 三条硬性设计约束：
//
//   ① 撤回栈必须是 **模块级单例**，不能挂在组件上。
//      用户「删了文件夹 → 切到图谱页 → 再切回来 → 撤回」必须照样有效。
//      组件一 unmount，挂在它身上的栈就没了。所以这里是模块作用域的 ref：
//      与组件生命周期无关，只随 JS 模块的生命周期存在。
//
//   ② 栈必须有**容量上限**。
//      无限增长等于用内存换「理论上能撤到昨天」，而实际没人会连撤 50 步。
//      上限 UNDO_LIMIT=20：满了丢最老的（FIFO）。每条记录只持有笔记字段的
//      **引用**（字符串不可变），所以一条记录的成本是「被改动的那几篇」，
//      不是整库拷贝 —— 20 条也就几十 KB。
//
//   ③ 撤回必须做**失效判定**：目标已被再次改动就别撤了，否则越撤越乱。
//      判据是「按字段」而不是「整篇」：
//        · 只对**本次操作真正改过的字段**比对（fields 由 diffSnapshots 算出）；
//        · 移动只改了 folder/filePath → 之后编辑正文**不会**让撤回失效，
//          而且撤销时也不碰正文（用户刚敲的字不会被吞掉）；
//        · 反过来，若 folder/filePath 已被另一次移动改掉 → stale，拒绝。
//      `updatedAt` 刻意**不参与失效判定**（每次操作都会刷新它，拿它当判据
//      会让撤回几乎总是失效），但会参与回滚（撤回到操作前的时间戳）。
//      任一受影响笔记判定失效 → 整条撤回作废（不撤半截）。
//
// 为什么用「全库 diff」而不是每个操作手写回滚逻辑：
//   moveNote / renameNote / deleteNote / deleteFolder / moveFolder / renameFolder
//   六个操作要覆盖，其中 renameNote 还会连带改写别处的 [[双链]]，
//   deleteFolder 会带走整棵子树 —— 手写六份回滚，任何一份漏字段就是永久错位。
//   统一改成「操作前后各快照一次、diff 出受影响的那几篇」，六个操作共用一份
//   回滚实现，且**将来新增任何改结构的 store 方法都自动被覆盖**。
//
// 与 note.js 的分工（避免循环依赖）：
//   本模块**不 import note.js**。note.js 在创建 store 时把自己的能力注册进来
//   （bindUndoHost），本模块只认宿主接口 { findNote / pathTaken / apply }。
//   这样 UI 侧 `useFileUndo()` 拿到的 `undoLast()` 才能真的执行回滚，
//   同时两个模块之间没有 import 环。
//
// 不变量（由 tests/fileUndo.test.js 逐条断言）：
//   1. 移动后撤回：folder/filePath 回到原位，且 **id 不变**（rebindPath 反向搬回）；
//   2. 重命名后撤回：title/content/filePath 复原，连带改写的双链也复原；
//   3. 删除（含删文件夹）后撤回：**笔记数不变**；
//   4. 栈容量不超过 UNDO_LIMIT，满了丢最老的；
//   5. 目标被再动过 → 返回 stale，且内存一个字段都不动；
//   6. 组件卸载 / 换作用域 / 切页面之后，栈里的条目仍在且可撤。
// ============================================================================

import { ref, computed } from 'vue'

/**
 * 撤回栈容量上限。
 *
 * 取 20：Obsidian 的撤销历史也是有限步，而「误删/误移」的黄金撤回窗口就
 * 在最近这几步内。再往上堆只会让「撤到某个远古状态」成为可能 —— 那正是
 * 越撤越乱的来源。满了丢最老的（FIFO），不是拒绝入栈。
 */
export const UNDO_LIMIT = 20

/**
 * 参与「有没有变」比对的字段。
 *
 * 刻意不含 updatedAt：它每次操作都会被刷新（`note.updatedAt = new Date()`），
 * 拿它当失效判据会让「移动之后随手改一个字」就把撤回判死。它照旧参与回滚。
 */
export const COMPARE_FIELDS = ['title', 'content', 'folder', 'filePath']

/** 快照要带走的字段：足够把一篇笔记原样插回库里 */
const SNAPSHOT_FIELDS = [
  'id', 'title', 'content', 'folder', 'filePath', 'tags',
  'createdAt', 'updatedAt', 'wordCount', 'charCount', 'lineCount'
]

// ---------------------------------------------------------------------------
// 模块级单例状态：与组件生命周期无关
// ---------------------------------------------------------------------------

/** @type {import('vue').Ref<Array<object>>} 撤回栈，栈顶是最近一次操作 */
const undoStack = ref([])

/** 递增序号：给每条记录一个稳定身份，便于精确移除 */
let seqCounter = 0

/**
 * 回滚能力的宿主（note.js 注册）。见文件头「与 note.js 的分工」。
 * @type {{findNote: Function, pathTaken: Function, apply: Function}|null}
 */
let undoHost = null

/**
 * 注册回滚宿主。note.js 在创建 store 时调用；每个 pinia 实例都会重新注册，
 * 因此「最后创建的那个 store」就是宿主（单库应用里等价，测试里也正确）。
 * @param {{findNote: Function, pathTaken: Function, apply: Function}|null} host 宿主
 * @returns {void}
 */
export function bindUndoHost (host) {
  undoHost = host && typeof host.findNote === 'function' ? host : null
}

/**
 * 取当前宿主（测试与诊断用）。
 * @returns {object|null} 宿主
 */
export function getUndoHost () {
  return undoHost
}

/**
 * 取栈的原始数组（测试 / 诊断用）。
 * @returns {Array<object>} 记录数组（由旧到新）
 */
export function getUndoStack () {
  return undoStack.value
}

/** 清空撤回栈：切库 / resetConfig 之后，跨库的撤回没有意义 */
export function clearUndo () {
  undoStack.value = []
}

// ---------------------------------------------------------------------------
// 纯函数：快照 / diff / 比对 / 校验
// ---------------------------------------------------------------------------

/**
 * 两个值是否相等（笔记字段口径）。
 *
 * Date 按时间戳比、null/undefined 互等、字符串按 String() 比。
 * NaN 与 NaN 判等 —— `new Date('坏值')` 会算出 NaN，不特殊处理的话
 * 两篇同样「时间坏了」的笔记会被判成永远不同，撤回就永远失效。
 *
 * @param {*} a 左值
 * @param {*} b 右值
 * @returns {boolean} 相等返回 true
 */
export function valuesEqual (a, b) {
  if (a === b) return true
  const aDate = a instanceof Date
  const bDate = b instanceof Date
  if (aDate || bDate) {
    const ta = aDate ? a.getTime() : (a === null || a === undefined ? NaN : new Date(a).getTime())
    const tb = bDate ? b.getTime() : (b === null || b === undefined ? NaN : new Date(b).getTime())
    if (Number.isNaN(ta) && Number.isNaN(tb)) return true
    return ta === tb
  }
  const aEmpty = a === null || a === undefined
  const bEmpty = b === null || b === undefined
  if (aEmpty || bEmpty) return aEmpty && bEmpty
  // NaN 与 NaN 判等：`new Date('坏值')` 会算出 NaN，不特殊处理的话两篇同样
  // 「时间坏了」的笔记会被判成永远不同，撤回就永远失效。
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true
  }
  if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b)
  return false
}

/**
 * 快照单篇笔记（浅拷贝：字符串不可变，拷的是引用，成本 O(字段数)）。
 * @param {object} note 笔记
 * @param {number} index 在数组中的下标
 * @returns {object} 快照
 */
function snapshotOne (note, index) {
  const out = { index }
  for (const f of SNAPSHOT_FIELDS) out[f] = note ? note[f] : undefined
  return out
}

/** 只带 id 的空快照：用于「操作前/后不存在」的一侧 */
function blankSnapshot (id) {
  return { id, index: -1, title: '', content: '', folder: '', filePath: null, tags: [], updatedAt: null }
}

/**
 * 快照整个库。
 *
 * 只存字段引用，不复制正文字符串 —— 全库 2000 篇也是 2000 个小对象，
 * 且正文字符串在 JS 里不可变，存引用就等价于存内容。
 *
 * @param {Array<object>} notes 笔记数组
 * @returns {Array<object>} 快照数组（顺序与入参一致）
 */
export function snapshotNotes (notes) {
  const list = Array.isArray(notes) ? notes : []
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const n = list[i]
    if (!n || n.id === undefined || n.id === null) continue
    out.push(snapshotOne(n, i))
  }
  return out
}

/**
 * 比对「操作前快照」与「操作后的现状」，产出受影响的记录。
 *
 * 只有字段真的变了的笔记才会进记录 —— 所以 noop（移动到了同一个目录）
 * 自然产出空数组，调用方据此不登记撤回。
 *
 * @param {Array<object>} before 操作前快照（snapshotNotes 的产物）
 * @param {Array<object>} notes 操作后的笔记数组
 * @returns {Array<object>} 记录数组
 */
export function diffSnapshots (before, notes) {
  const beforeList = Array.isArray(before) ? before : []
  const nowList = Array.isArray(notes) ? notes : []

  const beforeMap = new Map()
  for (const s of beforeList) beforeMap.set(s.id, s)

  const nowMap = new Map()
  for (let i = 0; i < nowList.length; i += 1) {
    const n = nowList[i]
    if (!n || n.id === undefined || n.id === null) continue
    nowMap.set(n.id, { note: n, index: i })
  }

  // 遍历顺序：先按 before 的顺序，再补上新增的 —— 保证同一份输入得到同一份输出
  const ids = []
  const seen = new Set()
  for (const s of beforeList) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    ids.push(s.id)
  }
  for (const id of nowMap.keys()) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  const records = []
  for (const id of ids) {
    const b = beforeMap.get(id) || null
    const cur = nowMap.get(id) || null
    const existedBefore = Boolean(b)
    const existedAfter = Boolean(cur)

    if (existedBefore && existedAfter) {
      const fields = []
      for (const f of COMPARE_FIELDS) {
        if (!valuesEqual(b[f], cur.note[f])) fields.push(f)
      }
      if (b.index !== cur.index) fields.push('index')
      if (fields.length === 0) continue
      records.push({
        id,
        index: b.index,
        afterIndex: cur.index,
        existedBefore: true,
        existedAfter: true,
        before: b,
        after: snapshotOne(cur.note, cur.index),
        fields
      })
      continue
    }

    // 存在性变化：新增 或 删除
    records.push({
      id,
      index: existedBefore ? b.index : cur.index,
      afterIndex: existedAfter ? cur.index : -1,
      existedBefore,
      existedAfter,
      before: existedBefore ? b : blankSnapshot(id),
      after: existedAfter ? snapshotOne(cur.note, cur.index) : blankSnapshot(id),
      fields: ['__existence__']
    })
  }
  return records
}

/**
 * 失效判定：这条撤回现在还能不能安全执行。
 *
 * 逐条比对「本次操作真正改过的字段」的**现值**与「操作后的记录值」：
 *   · 不一致 → 目标已被再次改动 → stale（不撤半截，整条作废）；
 *   · 记录里这篇「操作后是被删掉的」，现在却还在 → stale；
 *   · 记录里这篇「操作后是被删掉的」，且它的旧路径已被别的笔记占用
 *     → target-exists（撤回去会覆盖别人，同样不撤）。
 *
 * `index` 不做失效判定：插入/删除别的笔记会整体平移下标，那不是「被改动」。
 *
 * @param {object} entry 撤回记录
 * @param {{findNote: Function, pathTaken: Function}|null} host 宿主
 * @returns {{ok: boolean, code: string}} 判定结果
 */
export function validateUndoEntry (entry, host) {
  if (!entry || !Array.isArray(entry.records) || entry.records.length === 0) {
    return { ok: false, code: 'not-found' }
  }
  if (!host || typeof host.findNote !== 'function') {
    return { ok: false, code: 'no-host' }
  }
  for (const rec of entry.records) {
    const now = host.findNote(rec.id)
    if (rec.existedAfter) {
      if (!now) return { ok: false, code: 'stale' }
      for (const f of rec.fields) {
        if (f === 'index' || f === '__existence__') continue
        if (!valuesEqual(now[f], rec.after[f])) return { ok: false, code: 'stale' }
      }
      continue
    }
    // 操作后这篇是「被删掉了」
    if (now) return { ok: false, code: 'stale' }
    const path = rec.before && rec.before.filePath
    if (path && typeof host.pathTaken === 'function' && host.pathTaken(path)) {
      return { ok: false, code: 'target-exists' }
    }
  }
  return { ok: true, code: 'ok' }
}

/**
 * 入栈一条撤回记录（超出容量丢最老的）。
 *
 * 空记录不入栈：noop（比如移动到同一个目录）不该占一个撤回位，
 * 否则用户连点几次「撤回」什么都没发生，反而以为功能坏了。
 *
 * @param {{kind: string, label: string, records: Array<object>, ui?: object}} spec 记录内容
 * @returns {object|null} 入栈的记录；未入栈返回 null
 */
export function pushUndoEntry (spec) {
  if (!spec || !Array.isArray(spec.records) || spec.records.length === 0) return null
  seqCounter += 1
  const entry = {
    seq: seqCounter,
    kind: String(spec.kind || 'unknown'),
    label: String(spec.label || '文件操作'),
    at: Date.now(),
    records: spec.records,
    ui: spec.ui || null
  }
  const next = undoStack.value.concat([entry])
  // FIFO 丢最老的：撤回栈保留的是「最近这几步」，不是历史档案馆
  undoStack.value = next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next
  return entry
}

/**
 * 从栈里摘掉一条记录。
 * @param {number} targetSeq 记录序号
 * @returns {boolean} 是否真的摘掉了
 */
function removeEntry (targetSeq) {
  const idx = undoStack.value.findIndex(e => e.seq === targetSeq)
  if (idx < 0) return false
  undoStack.value.splice(idx, 1)
  return true
}

// ---------------------------------------------------------------------------
// 对外 composable
// ---------------------------------------------------------------------------

/**
 * 文件操作撤回。
 *
 * 返回的 `undoStack` / `canUndo` / `undoLabel` 是响应式的，可直接绑到 UI
 * （toast 的「撤销」按钮、命令面板条目）。`undoLast()` 内部通过宿主执行回滚，
 * 所以调用方不需要知道 note store 的存在。
 *
 * @param {object} [options={}] 选项
 * @param {object} [options.host] 覆盖宿主（测试用；默认用 bindUndoHost 注册的那个）
 * @returns {object} 撤回 API
 */
export function useFileUndo (options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const resolveHost = () => opts.host || undoHost || null

  /** @type {import('vue').ComputedRef<boolean>} 有没有可撤的操作 */
  const canUndo = computed(() => undoStack.value.length > 0)

  /** @type {import('vue').ComputedRef<number>} 栈深（诊断 / 测试用） */
  const undoDepth = computed(() => undoStack.value.length)

  /** @type {import('vue').ComputedRef<string>} 栈顶那条的人类可读描述 */
  const undoLabel = computed(() => {
    const top = undoStack.value[undoStack.value.length - 1]
    return top ? top.label : ''
  })

  /**
   * 取栈顶记录（不弹出）。
   * @returns {object|null} 栈顶记录
   */
  function peekUndo () {
    return undoStack.value[undoStack.value.length - 1] || null
  }

  /**
   * 撤回一步。
   *
   * 失效（stale / target-exists）时**把这条记录摘掉**：它已经永远不可能安全
   * 执行了，留在栈里只会让用户反复点到同一个错误。
   * 磁盘类失败（write-failed / permission）时**保留**记录：修好权限可以再试。
   *
   * @param {number} [targetSeq] 指定撤回哪一条；省略则撤栈顶
   * @returns {Promise<{ok: boolean, code: string, label: string, entry: object|null}>} 结果
   */
  async function undo (targetSeq) {
    const entry = targetSeq === undefined
      ? peekUndo()
      : (undoStack.value.find(e => e.seq === targetSeq) || null)
    if (!entry) return { ok: false, code: 'empty', label: '', entry: null }

    const host = resolveHost()
    const check = validateUndoEntry(entry, host)
    if (!check.ok) {
      // 失效 = 永远不可能再安全执行 → 摘掉，别让用户反复撞同一堵墙
      removeEntry(entry.seq)
      return { ok: false, code: check.code, label: entry.label, entry }
    }

    const result = await host.apply(entry)
    if (result && result.ok === true) {
      removeEntry(entry.seq)
      return { ok: true, code: 'ok', label: entry.label, entry, result }
    }
    // 磁盘失败保留记录：用户修好权限还能再撤一次
    return {
      ok: false,
      code: (result && result.code) || 'write-failed',
      label: entry.label,
      entry,
      result: result || null
    }
  }

  /**
   * 撤回栈顶一步（undo() 的语义化别名）。
   * @returns {Promise<object>} 同 undo()
   */
  function undoLast () {
    return undo()
  }

  return {
    undoStack,
    canUndo,
    undoDepth,
    undoLabel,
    peekUndo,
    undo,
    undoLast,
    clearUndo,
    pushUndoEntry
  }
}

export default useFileUndo
