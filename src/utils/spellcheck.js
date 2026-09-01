// 纯函数拼写检查模块：从 app store 中抽取，便于单元测试
import { COMMON_ENGLISH_WORDS } from './dictionary'

/**
 * 判断一个英文单词是否属于"常见词"（无需拼写纠错）。
 * @param {string} word
 * @returns {boolean}
 */
export function isCommonEnglishWord(word) {
  const lowerWord = word.toLowerCase()
  if (/^\d+$/.test(word)) return true
  if (word.length <= 1) return true
  if (word === word.toUpperCase() && word.length > 1) return true

  return COMMON_ENGLISH_WORDS.has(lowerWord) || /^[A-Z]/.test(word)
}

/**
 * 计算需要跳过的区间：代码块、行内代码、frontmatter、URL、HTML 标签、
 * wikilink 目标、标签、数学公式。
 * 这些区域内出现"非词典词"（变量名、域名、文件名）是正常现象，标红只会制造噪音。
 */
export function getExcludedRanges(text) {
  const ranges = []
  const push = (start, end) => {
    if (end > start) ranges.push({ start, end })
  }

  const addPattern = (re) => {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      push(m.index, m.index + m[0].length)
      if (m[0].length === 0) re.lastIndex++
    }
  }

  // frontmatter：文档开头 --- 到下一个 ---
  if (/^---\s*\r?\n/.test(text)) {
    const close = text.search(/\r?\n---/)
    push(0, close === -1 ? text.length : close + 4)
  }

  addPattern(/```[\s\S]*?```/g)          // 围栏代码块
  addPattern(/~~~[\s\S]*?~~~/g)          // 波浪围栏代码块
  addPattern(/`[^`\n]+`/g)               // 行内代码
  addPattern(/\$\$[\s\S]*?\$\$/g)        // 块级公式
  addPattern(/\$[^$\n]+\$/g)             // 行内公式
  addPattern(/<[^<>\n]+>/g)              // HTML 标签
  addPattern(/https?:\/\/\S+/g)          // URL
  addPattern(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g) // 邮箱
  addPattern(/!?\[\[[^\]\n]*\]\]/g)      // wikilink / embed
  addPattern(/\b[\w-]+[./][\w./-]+\b/g)  // 路径 / 包名 / 域名形态
  addPattern(/#[^\s#]{1,40}/g)           // 标签（#tag）

  ranges.sort((a, b) => a.start - b.start)
  return ranges
}

/**
 * 从文本中提取需要拼写纠错的单词列表。
 * @param {string} text 待检查文本
 * @param {{enabled: boolean, ignoredWords?: Set<string>, customDictionary?: Set<string>}} options
 * @returns {Array<{word: string, start: number, end: number}>}
 */
export function getSpellErrors(text, options = {}) {
  const { enabled, ignoredWords = new Set(), customDictionary = new Set() } = options
  if (!enabled || !text) return []

  const errors = []
  const wordRegex = /\b[a-zA-Z]+\b/g
  const excludedRanges = getExcludedRanges(text)

  const isInExcludedRange = (pos) =>
    excludedRanges.some(r => pos >= r.start && pos < r.end)

  let match
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0]
    const lowerWord = word.toLowerCase()

    if (isInExcludedRange(match.index)) continue
    if (ignoredWords.has(lowerWord)) continue
    if (customDictionary.has(lowerWord)) continue

    if (!isCommonEnglishWord(word)) {
      errors.push({
        word,
        start: match.index,
        end: match.index + word.length
      })
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// 纠错建议
// ---------------------------------------------------------------------------

/** 受限编辑距离，超过 max 立即返回 Infinity（候选词很多时省掉大量无用计算） */
function boundedDistance(a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev = new Array(b.length + 1)
  const curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

/** 键盘相邻键，用于给"打错一个字母"的候选加权（qwerty 布局） */
const NEIGHBORS = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yijh',
  i: 'uokj', o: 'iplk', p: 'ol', a: 'qwsz', s: 'awedxz', d: 'serfcx',
  f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk'
}

function neighborBonus(a, b) {
  let bonus = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      if ((NEIGHBORS[a[i]] || '').includes(b[i])) bonus += 1
    }
  }
  return bonus
}

/**
 * 给出拼写建议。距离阈值随词长放宽：短词只接受 1 个编辑距离，
 * 否则 "it" 会被建议成 "at/in/is" 一堆噪声。
 * @param {string} word
 * @param {Set<string>} customDictionary
 * @param {number} limit
 */
export function suggestCorrections(word, customDictionary = new Set(), limit = 5) {
  const target = String(word || '').toLowerCase()
  if (target.length < 3) return []

  const max = target.length <= 5 ? 1 : target.length <= 8 ? 2 : 3
  const first = target[0]
  const scored = []

  const consider = (candidate) => {
    if (candidate === target) return
    if (candidate.length < 2) return
    // 首字符不同基本不可能是手误，直接剪枝（候选集很大时收益明显）
    if (Math.abs(candidate.length - target.length) > max) return
    if (candidate[0] !== first && boundedDistance(target.slice(0, 1), candidate.slice(0, 1), 1) > 0) {
      // 允许首字母错误，但权重降低
    }
    const distance = boundedDistance(target, candidate, max)
    if (distance > max) return
    const bonus = neighborBonus(target, candidate)
    const prefix = candidate.startsWith(target.slice(0, 2)) ? 0.5 : 0
    scored.push({ word: candidate, score: distance - bonus * 0.5 - prefix })
  }

  for (const candidate of COMMON_ENGLISH_WORDS) consider(candidate)
  for (const candidate of customDictionary) consider(candidate)

  scored.sort((a, b) => a.score - b.score || a.word.localeCompare(b.word))

  // 去重并保留原词大小写形态（首字母大写时建议也大写）
  const seen = new Set()
  const result = []
  for (const item of scored) {
    if (seen.has(item.word)) continue
    seen.add(item.word)
    result.push(matchCase(word, item.word))
    if (result.length >= limit) break
  }
  return result
}

function matchCase(source, candidate) {
  if (!source) return candidate
  if (source === source.toUpperCase()) return candidate.toUpperCase()
  if (source[0] === source[0].toUpperCase()) {
    return candidate[0].toUpperCase() + candidate.slice(1)
  }
  return candidate
}
