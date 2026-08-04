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
  let match

  const excludedRanges = []
  const codeBlockRegex = /```[\s\S]*?```/g
  let cbMatch
  while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
    excludedRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length })
  }

  const inlineCodeRegex = /`[^`\n]+`/g
  let icMatch
  while ((icMatch = inlineCodeRegex.exec(text)) !== null) {
    excludedRanges.push({ start: icMatch.index, end: icMatch.index + icMatch[0].length })
  }

  function isInExcludedRange(pos) {
    return excludedRanges.some(r => pos >= r.start && pos < r.end)
  }

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