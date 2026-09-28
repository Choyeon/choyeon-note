/**
 * localStorage key 与「配置项 → ref」映射的单一来源。
 *
 * 背景：key 原先散落在 stores/app.js 的 loadConfig（26 次 getItem）与
 * resetConfig（24 次 removeItem）里，新增一个设置项要同时改三处，漏一处就是
 * 「能存不能读」或「重置了但内存里还是旧值」这类静默 bug。
 *
 * 现在新增一个持久化配置项的改动面收敛成两步：
 *   1. 在 LS_KEYS 里登记 key；
 *   2. 在 CONFIG_SCHEMA 里加一行（parse 负责读取解析，fallback 负责重置默认值）。
 *
 * 约定：
 *   - LS_KEYS 的字符串值必须与历史版本逐字一致，改动会让老用户的配置失效；
 *   - parse(raw) 只在 key 存在（getItem 非 null）时被调用，返回 SKIP 表示
 *     「这个值不合法/不存在，保持 ref 当前默认值」；
 *   - fallback() 是工厂函数，避免 Set / 对象这类引用值被多个 ref 共享；
 *   - CONFIG_SCHEMA[].ref 是 appStore 内部 refMap 的键名（见 stores/app.js）。
 */

import { createDefaultBindings } from '@/constants/shortcuts'
import { NOTE_EXTENSIONS } from '@/constants/noteFile'
// 日志级别的 key 出自日志模块（主进程也要读，那边不能 import 本文件），这里直接
// 引用而不是再抄一份字符串 —— 抄两份迟早漂移，而漂移的后果是「设置页写 A、主进程读 B」。
import { LS_LOG_LEVEL } from '@/constants/logging'

/** parse 的返回值哨兵：跳过赋值，保留默认值 */
export const SKIP = Symbol('choyeon-storage-skip')

/**
 * 全部 localStorage key。字符串值即线上已有的 key，禁止修改。
 */
export const LS_KEYS = Object.freeze({
  theme: 'choyeon-theme',
  accent: 'choyeon-accent',
  fontSize: 'choyeon-font-size',
  glassEffect: 'choyeon-glass-effect',
  notesLocation: 'choyeon-notes-location',
  ignoredWords: 'choyeon-ignored-words',
  customDictionary: 'choyeon-custom-dictionary',
  autoSave: 'choyeon-auto-save',
  spellCheck: 'choyeon-spell-check',
  lineNumbers: 'choyeon-line-numbers',
  wordWrap: 'choyeon-word-wrap',
  autoSync: 'choyeon-auto-sync',
  noteExtension: 'choyeon-note-extension',
  sidebar: 'choyeon-sidebar',
  /** 历史遗留的「工作模式」开关：早已不再读取，重置时仍要清掉 */
  mode: 'choyeon-mode',
  codeTheme: 'choyeon-code-theme',
  bingWallpaper: 'choyeon-bing-wallpaper',
  bingWallpaperUrl: 'choyeon-bing-wallpaper-url',
  bingWallpaperTitle: 'choyeon-bing-wallpaper-title',
  bingWallpaperDate: 'choyeon-bing-wallpaper-date',
  bingWallpaperSource: 'choyeon-bing-wallpaper-source',
  editorZoom: 'choyeon-editor-zoom',
  autoCheckUpdates: 'choyeon-auto-check-updates',
  hotkeys: 'choyeon-hotkeys',
  editorMode: 'choyeon-editor-mode',
  rightPanelTab: 'choyeon-right-panel-tab',
  rightPanelVisible: 'choyeon-right-panel-visible',
  /**
   * 日志级别。key 直接取自日志模块的单一来源 `LS_LOG_LEVEL`；登记在这里是为了让
   * resetConfig 能一并清掉它（resetConfig 遍历 Object.values(LS_KEYS)）。
   *
   * 刻意**不加** CONFIG_SCHEMA 条目：级别不是「设置页里的一项配置 ref」，它由
   * 渲染侧宿主读出后喂给 setLogLevel()，加进 schema 反而会牵动 refMap 与守卫断言。
   */
  logLevel: LS_LOG_LEVEL,

  /**
   * id ↔ path 映射表的浏览器降级存储（T16 · R-F1 双轨稳定 id）。
   * Electron 下真相源是 `userData/note-id-map.json`，这里只在「没有 electronAPI」
   * （浏览器预览 / 单测）时兜底。两者都存同一份 JSON 结构，由
   * `utils/idMapStore.js` 统一读写 —— 只有它知道该往哪儿落。
   *
   * 刻意**不加** CONFIG_SCHEMA 条目：它不是「设置页里的一项配置 ref」，而是应用
   * 内部数据，加进 schema 会让 resetConfig（遍历 LS_KEYS 清键）把它一起清掉 ——
   * 那就是「重置设置 = 全库 id 漂移」，与 R-F1 的目标正好相反。
   */
  idMap: 'choyeon-note-id-map',

  /**
   * 日期迁移标记（T18 用，此处只登记 key，逻辑不在本文件）。
   * 记一次性的迁移完成状态：`frontmatter.created / updated` 回填过就打上标记，
   * 下次启动跳过扫描，避免每次开机都重写用户文件。
   */
  dateMigration: 'choyeon-date-migration-v1',

  /**
   * 图谱节点坐标存档（T36 · R-G3 布局持久化）。
   * 存的是 `{ v, sig, savedAt, positions: { [noteId]: {x, y} } }`，由
   * `views/GraphView.vue` 独占读写（它是唯一知道坐标系语义的地方）。
   *
   * 刻意**不加** CONFIG_SCHEMA 条目：它不是「设置页里的一项配置 ref」，加进
   * schema 会让 loadConfig 在启动时把它读进 refMap、resetConfig 再按 schema
   * 写一遍默认值 —— 那等于「重置设置 = 顺手清掉用户摆好的图」。
   *
   * 但它**要**留在 LS_KEYS 里：resetConfig 遍历 Object.values(LS_KEYS) 清键，
   * 让「恢复默认设置」也能把图谱布局记忆一并清掉（回到确定性种子布局）。
   */
  graphPositions: 'choyeon-graph-positions'
})

/** 编辑器缩放的合法区间，越界值一律夹紧 */
const ZOOM_MIN = 50
const ZOOM_MAX = 200

/** 编辑器模式白名单（'source' 是历史值，等价于 'edit'） */
const EDITOR_MODES = ['edit', 'live', 'preview']

// ---------------------------------------------------------------------------
// 解析器：localStorage 字符串 → ref 的值（或 SKIP）
// ---------------------------------------------------------------------------

/** 非空字符串原样采用，空串视为未设置 */
function asString (raw) {
  return raw ? raw : SKIP
}

/** 布尔值统一存 'true' / 'false' 字符串 */
function asBoolean (raw) {
  return raw === 'true'
}

/** 字符串集合（忽略词 / 自定义词典），JSON 数组格式；损坏时回落到空集合 */
function asStringSet (raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed[Symbol.iterator] === 'function' ? new Set(parsed) : new Set()
  } catch {
    return new Set()
  }
}

/** 缩放百分比：NaN / 越界 / 小数都夹紧到 50~200 的整数 */
function asZoom (raw) {
  const z = Number(raw)
  if (!Number.isFinite(z)) return SKIP
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z)))
}

/** 编辑器模式：不在白名单里就保持默认，'source' 归一成 'edit' */
function asEditorMode (raw) {
  if (!raw) return SKIP
  const legacy = raw === 'source' ? 'edit' : raw
  return EDITOR_MODES.includes(legacy) ? legacy : SKIP
}

/**
 * 默认笔记扩展名：先归一化再比对白名单，不在白名单里返回 SKIP。
 *
 * 为什么不能直接用 asString：这个值最终是**新建笔记文件名的一部分**，
 * 落到非法值（'undefined' / 'null' / '' / 被手改过的 '.MD'）会写出白名单外的
 * 文件 —— 那种文件载入时不被认作笔记，用户看到的是「新建了却找不到」。
 * 归一化（去首尾空白 / 去前导点 / 转小写）后才比对，脏数据一律回落到默认 'md'。
 *
 * 归一化规则与 appStore 的 setNoteExtension 共用同一个
 * `normalizeNoteExtension`，保证「写进去什么」与「读出来什么」是同一口径。
 * @param {string} raw localStorage 里的原始字符串
 * @returns {string|symbol} 合法扩展名或 SKIP
 */
export function normalizeNoteExtension (raw) {
  return String(raw).trim().toLowerCase().replace(/^\.+/, '')
}

function asNoteExtension (raw) {
  const normalized = normalizeNoteExtension(raw)
  return NOTE_EXTENSIONS.includes(normalized) ? normalized : SKIP
}

// ---------------------------------------------------------------------------
// 配置 schema
// ---------------------------------------------------------------------------

/**
 * 每个持久化配置项一行。字段说明见文件头注释。
 *
 * skipLoad 现在只剩 hotkeys 一项，是刻意保留的历史行为、不是遗漏：它需要
 * 「key 不存在时也写回默认表」的语义（新版本新增的命令要能补上），由
 * appStore 的 mergeBindings 单独处理 —— 通用循环做不到这一点。
 *
 * noteExtension 曾是这里第二项 skipLoad（写了 localStorage 却从不读回，造成
 * 「改了能存、重启就忘」），现已改为正常解析 + 白名单校验，不要再改回去。
 */
export const CONFIG_SCHEMA = Object.freeze([
  { key: LS_KEYS.theme, ref: 'theme', parse: asString, fallback: () => 'system' },
  { key: LS_KEYS.accent, ref: 'accentColor', parse: asString, fallback: () => '#4A90D9' },
  { key: LS_KEYS.fontSize, ref: 'fontSize', parse: asString, fallback: () => 'medium' },
  { key: LS_KEYS.glassEffect, ref: 'glassEffect', parse: asBoolean, fallback: () => true },
  { key: LS_KEYS.notesLocation, ref: 'notesLocation', parse: asString, fallback: () => '' },
  { key: LS_KEYS.ignoredWords, ref: 'ignoredWords', parse: raw => (raw ? asStringSet(raw) : SKIP), fallback: () => new Set() },
  { key: LS_KEYS.customDictionary, ref: 'customDictionary', parse: raw => (raw ? asStringSet(raw) : SKIP), fallback: () => new Set() },
  { key: LS_KEYS.autoSave, ref: 'autoSave', parse: asBoolean, fallback: () => true },
  { key: LS_KEYS.spellCheck, ref: 'spellCheck', parse: asBoolean, fallback: () => true },
  { key: LS_KEYS.lineNumbers, ref: 'showLineNumbers', parse: asBoolean, fallback: () => false },
  { key: LS_KEYS.wordWrap, ref: 'wordWrap', parse: asBoolean, fallback: () => true },
  // 默认值 true（T24 翻转）。必须与「定向 reconcile」同批生效：只开默认、不做定向
  // reconcile = 用户正在打字时整库重载，内容被冲掉（R-F5）；只做 reconcile、不开
  // 默认 = 功能根本不触发。key 字符串（'choyeon-auto-sync'）保持历史值不变 ——
  // 改一个字符就等于把所有老用户的开关重置一遍。
  { key: LS_KEYS.autoSync, ref: 'autoSync', parse: asBoolean, fallback: () => true },
  { key: LS_KEYS.noteExtension, ref: 'noteExtension', parse: asNoteExtension, fallback: () => 'md' },
  { key: LS_KEYS.sidebar, ref: 'sidebar', parse: asBoolean, fallback: () => true },
  { key: LS_KEYS.codeTheme, ref: 'codeTheme', parse: asString, fallback: () => 'github' },
  { key: LS_KEYS.bingWallpaper, ref: 'bingWallpaper', parse: asBoolean, fallback: () => false },
  { key: LS_KEYS.bingWallpaperUrl, ref: 'bingWallpaperUrl', parse: asString, fallback: () => '' },
  { key: LS_KEYS.bingWallpaperTitle, ref: 'bingWallpaperTitle', parse: asString, fallback: () => '' },
  { key: LS_KEYS.bingWallpaperDate, ref: 'bingWallpaperDate', parse: asString, fallback: () => '' },
  { key: LS_KEYS.bingWallpaperSource, ref: 'bingWallpaperSource', parse: asString, fallback: () => '' },
  { key: LS_KEYS.editorZoom, ref: 'editorZoom', parse: asZoom, fallback: () => 100 },
  { key: LS_KEYS.autoCheckUpdates, ref: 'autoCheckUpdates', parse: asBoolean, fallback: () => true },
  { key: LS_KEYS.hotkeys, ref: 'hotkeys', skipLoad: true, fallback: () => createDefaultBindings() },
  { key: LS_KEYS.editorMode, ref: 'editorMode', parse: asEditorMode, fallback: () => 'edit' },
  { key: LS_KEYS.rightPanelTab, ref: 'rightPanelTab', parse: asString, fallback: () => 'outline' },
  { key: LS_KEYS.rightPanelVisible, ref: 'rightPanelVisible', parse: asBoolean, fallback: () => true }
])
