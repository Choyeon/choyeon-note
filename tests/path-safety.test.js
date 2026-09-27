import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { validatePath, safeJoin, validatePathAsync } from '../electron/path-safety.cjs'

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

// ---------------------------------------------------------------------------
// validatePathAsync：真实文件系统上的符号链接校验
// ---------------------------------------------------------------------------
describe('validatePathAsync', () => {
  let base
  let outside

  beforeAll(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cho-safe-'))
    base = path.join(root, 'notes')
    outside = path.join(root, 'outside')
    await fs.mkdir(path.join(base, 'sub'), { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(base, 'a.md'), 'a', 'utf-8')
    await fs.writeFile(path.join(outside, 'secret.md'), 's', 'utf-8')
  })

  afterAll(async () => {
    try {
      await fs.rm(path.dirname(base), { recursive: true, force: true })
    } catch { /* 清理失败不影响测试结果 */ }
  })

  it('accepts a real file inside the notes dir', async () => {
    const result = await validatePathAsync(base, path.join(base, 'a.md'))
    expect(path.basename(result)).toBe('a.md')
  })

  it('accepts a file that does not exist yet but whose parent is inside', async () => {
    const result = await validatePathAsync(base, path.join(base, 'sub', 'new.md'))
    expect(path.basename(result)).toBe('new.md')
  })

  it('rejects string traversal before touching the filesystem', async () => {
    await expect(
      validatePathAsync(base, path.join(base, '..', 'outside', 'secret.md'))
    ).rejects.toThrow('Access denied')
  })

  it('rejects when notes dir does not exist', async () => {
    await expect(
      validatePathAsync(path.join(base, 'nope'), path.join(base, 'nope', 'x.md'))
    ).rejects.toThrow('Access denied')
  })

  it('resolves a symlinked escape out of the notes dir (symlink guard)', async () => {
    // Windows 无开发者模式时无法建 symlink，直接跳过而不是让测试失败
    const linkPath = path.join(base, 'escape')
    try {
      await fs.symlink(outside, linkPath, 'dir')
    } catch {
      return
    }
    await expect(
      validatePathAsync(base, path.join(linkPath, 'secret.md'))
    ).rejects.toThrow('Access denied')
  })
})