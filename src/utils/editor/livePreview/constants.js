/**
 * 实时预览用到的全部行级 / 行内正则。
 *
 * 集中定义的原因：这些判定必须和阅读视图（src/utils/markdown.js → marked）
 * 保持一致，散落在各个模块里必然出现「改了一处忘了另一处」的漂移。
 */

const HEADING_RE = /^(#{1,6})(\s+)(.*)$/
const QUOTE_RE = /^(\s*)(>"?)([ \t]?)/ // 逐个 > 处理，保留层级
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/
const TASK_RE = /^(\s*)([-*+])(\s+)\[([ xX])\](\s+)(.*)$/
const HR_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const FRONTMATTER_RE = /^---\s*$/
// callout 头行：`> [!note] 标题` / `> [!warning]- 折叠`
const CALLOUT_RE = /^>\s*\[!([a-z]+)\]([+-]?)\s*(.*)$/i
const WIKILINK_RE = /(!?)\[\[([^\]\n|]+)(\|([^\]\n]*))?\]\]/g
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g
const TAG_RE = /(^|[\s(（])#([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5/-]*)/g
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>()[\]]+)/g

// 表格：`| a | b |` + 分隔行 `|---|---|`。判定规则与 marked 的 GFM 表格保持一致
const TABLE_DELIM_CELL_RE = /^:?-{1,}:?$/
// 只有明确指向图片的地址才真的渲染 <img>，避免把普通链接变成破图
const IMAGE_SRC_RE = /^(https?:\/\/|data:image\/|\.{0,2}\/)/i

export {
  HEADING_RE,
  QUOTE_RE,
  LIST_RE,
  TASK_RE,
  HR_RE,
  FENCE_RE,
  FRONTMATTER_RE,
  CALLOUT_RE,
  WIKILINK_RE,
  MD_LINK_RE,
  TAG_RE,
  URL_RE,
  TABLE_DELIM_CELL_RE,
  IMAGE_SRC_RE
}
