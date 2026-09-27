/**
 * 全应用唯一的文本统计口径。
 *
 * 之前存在两套算法：编辑器用「CJK 按字 + 拉丁按词」，store 与阅读视图用
 * `content.replace(/\s/g,'').length`（不算空格的字符数）。同一篇笔记在编辑器里
 * 显示 320 字、阅读视图显示 1800 字，阅读时间的估算也跟着错。
 *
 * 统一规则：
 * - words：CJK 每个汉字/假名/谚文算 1 个词，拉丁文按连续词串算 1 个词
 * - chars：字符总数（含空白，与编辑器的 charCount 一致）
 * - lines：行数
 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/g
const LATIN_WORD_RE = /[A-Za-z0-9_'’\-]+/g

export function computeTextStats (text) {
  const str = typeof text === 'string' ? text : ''
  if (!str) return { words: 0, chars: 0, lines: 0 }
  const cjk = (str.match(CJK_RE) || []).length
  const latin = (str.replace(CJK_RE, ' ').match(LATIN_WORD_RE) || []).length
  return {
    words: cjk + latin,
    chars: str.length,
    lines: str.split('\n').length
  }
}

/** 阅读时间（分钟）：中文约 300 字/分钟，最少 1 分钟 */
export function estimateReadingMinutes (words) {
  return Math.max(1, Math.ceil((Number(words) || 0) / 300))
}
