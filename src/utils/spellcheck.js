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

/**
 * 受限编辑距离（Damerau–Levenshtein / OSA 变体）：把相邻两字符转置也算作 1 次编辑。
 * 否则 "teh"→"the" 这类最高频笔误会被标准 Levenshtein 记成 2 次编辑，
 * 导致短词（阈值 1）永远给不出 "the" 建议。
 * 超过 max 立即返回 max+1（候选词很多时省掉大量无用计算）。
 */
function boundedDistance(a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const n = b.length
  // 三行滚动：prev2 = d[i-2]、prev = d[i-1]、curr = d[i]（转置需要回看两行）
  let prev2 = new Array(n + 1).fill(0)
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    const ca = a.charCodeAt(i - 1)
    const caPrev = i >= 2 ? a.charCodeAt(i - 2) : -1
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      let d = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      // 相邻转置：a[i-2..i-1] == b[j-1..j-2]（即 a[i-1]==b[j-2] 且 a[i-2]==b[j-1]）
      if (i >= 2 && j >= 2 && ca === b.charCodeAt(j - 2) && caPrev === b.charCodeAt(j - 1)) {
        d = Math.min(d, prev2[j - 2] + 1)
      }
      curr[j] = d
      if (d < rowMin) rowMin = d
    }
    if (rowMin > max) return max + 1
    const tmp = prev2
    prev2 = prev
    prev = curr
    curr = tmp
  }
  return prev[n]
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
 * 判断 candidate 是否由 target 的某两个相邻字符交换得到（如 teh -> the）。
 * 相邻转置是最高频的英文笔误，却拿不到「前缀匹配」加分（前两字符已因交换而不同），
 * 所以需要单独识别并给最高优先级，否则 "teh" 会优先建议 "ten" 而非 "the"。
 */
function isAdjacentTransposition(target, candidate) {
  if (target.length !== candidate.length || target.length < 3) return false
  let swapIndex = -1
  for (let i = 0; i < target.length; i++) {
    if (target[i] !== candidate[i]) {
      if (swapIndex === -1) {
        swapIndex = i
      } else {
        // 第二个差异必须是紧邻的转置，且其后所有字符都相同（否则是多处差异，非纯转置）
        return i === swapIndex + 1 &&
               target[swapIndex] === candidate[i] &&
               target[i] === candidate[swapIndex] &&
               target.slice(i + 1) === candidate.slice(i + 1)
      }
    }
  }
  return false
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
    // 转置是独立错误类型：只按「距离 + 转置权重」打分，不再叠加键盘相邻/前缀加权
    // （转置本就意味着前两字符因交换而不同，键盘/前缀启发式会误判）。
    let score = distance
    if (isAdjacentTransposition(target, candidate)) {
      score -= 1.5
    } else {
      score -= neighborBonus(target, candidate) * 0.5
      score -= candidate.startsWith(target.slice(0, 2)) ? 0.5 : 0
    }
    scored.push({ word: candidate, score })
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
