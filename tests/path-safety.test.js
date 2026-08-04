import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { validatePath, safeJoin } from '../electron/path-safety.js'

const BASE = path.resolve('/home/user/notes')
const PARENT = path.resolve('/home/user')

describe('validatePath', () => {
  it('returns the normalized path when target is inside the notes dir', () => {
    const target = path.join(BASE, 'a.md')
    expect(validatePath(BASE, target)).toBe(path.normalize(target))
    expect(validatePath(BASE, path.join(BASE, 'sub', 'b.md'))).toBe(path.join(BASE, 'sub', 'b.md'))
  })

  it('allows the notes dir itself', () => {
    expect(validatePath(BASE, BASE)).toBe(path.normalize(BASE))
  })

  it('throws when target is the parent directory', () => {
    expect(() => validatePath(BASE, PARENT)).toThrow('Access denied')
  })

  it('throws on path traversal outside the notes dir', () => {
    expect(() => validatePath(BASE, path.join(BASE, '..', 'secret.md'))).toThrow('Access denied')
  })

  it('rejects a sibling dir with a common prefix (prefix-bypass guard)', () => {
    // notes_evil 与 notes 前缀相同，但位于父目录下，必须被拒绝
    const sibling = path.join(PARENT, 'notes_evil', 'x.md')
    expect(() => validatePath(BASE, sibling)).toThrow('Access denied')
  })

  it('throws when notesPath is not set', () => {
    expect(() => validatePath(null, path.join(BASE, 'a.md'))).toThrow('Notes path not set')
    expect(() => validatePath('', path.join(BASE, 'a.md'))).toThrow('Notes path not set')
  })

  it('normalizes dot segments that resolve inside the base', () => {
    expect(validatePath(BASE, path.join(BASE, '.', 'a.md'))).toBe(path.join(BASE, 'a.md'))
  })
})

describe('safeJoin', () => {
  it('joins parts and validates the result', () => {
    expect(safeJoin(BASE, BASE, 'a.md')).toBe(path.join(BASE, 'a.md'))
  })

  it('throws when the joined path escapes the base', () => {
    expect(() => safeJoin(BASE, BASE, '..', 'secret.md')).toThrow('Access denied')
  })

  it('returns the platform-specific normalized path', () => {
    const result = safeJoin(BASE, BASE, 'a.md')
    expect(result).toBe(path.normalize(path.join(BASE, 'a.md')))
  })
})