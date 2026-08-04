import { describe, it, expect } from 'vitest'
import { isCommonEnglishWord, getSpellErrors } from '../src/utils/spellcheck.js'

describe('isCommonEnglishWord', () => {
  it('returns true for common English words', () => {
    expect(isCommonEnglishWord('the')).toBe(true)
    expect(isCommonEnglishWord('note')).toBe(true)
    expect(isCommonEnglishWord('markdown')).toBe(true)
  })

  it('returns true for numbers and single characters', () => {
    expect(isCommonEnglishWord('12345')).toBe(true)
    expect(isCommonEnglishWord('a')).toBe(true)
  })

  it('returns true for all-caps acronyms', () => {
    expect(isCommonEnglishWord('NASA')).toBe(true)
    expect(isCommonEnglishWord('JSON')).toBe(true)
  })

  it('returns true for capitalized proper nouns', () => {
    expect(isCommonEnglishWord('Beijing')).toBe(true)
    expect(isCommonEnglishWord('Obsidian')).toBe(true)
  })

  it('returns false for unknown lowercase typo words', () => {
    expect(isCommonEnglishWord('teh')).toBe(false)
    expect(isCommonEnglishWord('recieve')).toBe(false)
  })
})

describe('getSpellErrors', () => {
  const opts = { enabled: true }

  it('returns an empty array when disabled', () => {
    expect(getSpellErrors('some teh text', { enabled: false })).toEqual([])
  })

  it('returns an empty array for empty or falsy text', () => {
    expect(getSpellErrors('', opts)).toEqual([])
    expect(getSpellErrors(null, opts)).toEqual([])
  })

  it('flags misspelled words with correct offsets', () => {
    const errors = getSpellErrors('hello teh world', opts)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ word: 'teh', start: 6, end: 9 })
  })

  it('ignores words inside code blocks and inline code', () => {
    const text = '```\nteh inside block\n```\n`teh inline`\nhello teh'
    const errors = getSpellErrors(text, opts)
    expect(errors).toEqual([{ word: 'teh', start: text.lastIndexOf('teh'), end: text.lastIndexOf('teh') + 3 }])
  })

  it('respects ignoredWords and customDictionary', () => {
    const errors = getSpellErrors('teh recieve', {
      enabled: true,
      ignoredWords: new Set(['teh'])
    })
    expect(errors).toEqual([{ word: 'recieve', start: 4, end: 11 }])
  })

  it('flags multiple errors across the text', () => {
    const errors = getSpellErrors('teh resturant open', opts)
    expect(errors.map(e => e.word)).toEqual(['teh', 'resturant'])
  })

  it('does not flag common words', () => {
    expect(getSpellErrors('the hello world text', opts)).toEqual([])
  })
})