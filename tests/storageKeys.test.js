/**
 * C3-A · localStorage「历史键 vs 当前键」的语义守卫（tests/storageKeys.test.js）
 * ============================================================================
 * 背景：QA 在 Phase 4 验收里指出 `stores/workspace.js` 迁移老数据时仍内联
 * `'choyeon-notes-location'` 字面量。该处读的是**冻结的历史键**，语义上不等于
 * `LS_KEYS.notesLocation`（当前键，将来可能改名），所以修法是「给历史键一个名字」
 * —— `LEGACY_NOTES_LOCATION` —— 而不是把它并进当前键。
 *
 * 这份文件只钉三件事：
 *   1. 历史键**有名字**且可用（不是一个空壳导出）；
 *   2. 「历史键」与「当前键」两个概念在**源码层面互相独立**：历史键的定义不许
 *      从 LS_KEYS 派生（派生 = 将来改当前键时迁移静默失效）；
 *   3. workspace.js 真的**消费**这个常量做迁移（不是死代码），且不再内联字面量。
 *
 * 刻意**不**写的断言：`LEGACY_NOTES_LOCATION === LS_KEYS.notesLocation`。
 * 今天这两个值相等纯属历史巧合，断言相等等于把两个概念重新绑死 —— 那正是本次
 * 整改要解开的结。本文件只保证「概念独立 + 迁移可用」。
 *
 * 环境：jsdom（vitest 默认），无 electronAPI → `@/utils/env` 的 IS_ELECTRON 为
 * false，hydrate() 走 localStorage 分支，正是老版本升级的真实路径之一。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'

const SRC_DIR = resolve(process.cwd(), 'src') + sep
const STORAGE_SRC = readFileSync(SRC_DIR + 'constants/storage.js', 'utf8')
const WORKSPACE_SRC = readFileSync(SRC_DIR + 'stores/workspace.js', 'utf8')

/**
 * 老版本**真实写进**用户 localStorage 的那个字符串。
 *
 * 这里必须写死成字面量、不许引用 LEGACY_NOTES_LOCATION：本文件要能抓出
 * 「有人把常量的值改坏了」这种情况（改坏了 → 老数据读不到 → K4 变红）。
 * 引用常量就等于让测试跟着错误一起改，等于没测。
 */
const OLD_KEY_LITERAL = 'choyeon-notes-location'

/** 迁移后落到新结构的工作空间列表键（见 stores/workspace.js 的 LS_WORKSPACES） */
const NEW_LIST_KEY = 'choyeon-workspaces'

describe('C3-A · 历史键 LEGACY_NOTES_LOCATION', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('K1 常量存在且是可用字符串（无害断言：非空、无首尾空白）', async () => {
    const { LEGACY_NOTES_LOCATION } = await import('@/constants/storage')
    expect(typeof LEGACY_NOTES_LOCATION).toBe('string')
    expect(LEGACY_NOTES_LOCATION.length).toBeGreaterThan(0)
    // 首尾空白会让 getItem 静默读不到 —— 这类脏值一眼看不出来
    expect(LEGACY_NOTES_LOCATION).toBe(LEGACY_NOTES_LOCATION.trim())
  })

  it('K2 两个概念独立：历史键的定义不是从 LS_KEYS 派生的（源码级）', () => {
    // 别名写法 `= LS_KEYS.notesLocation` 会把「迁移旧数据」和「读当前配置」绑死：
    // 将来真改当前键时，迁移会跟着新键走，老用户磁盘上的旧键从此读不到。
    expect(
      /LEGACY_NOTES_LOCATION\s*=\s*LS_KEYS/.test(STORAGE_SRC),
      'LEGACY_NOTES_LOCATION 不许写成 LS_KEYS 的别名：两个概念必须各自演进'
    ).toBe(false)

    // 正例：定义必须是一个字符串字面量（冻结值）
    expect(
      /export\s+const\s+LEGACY_NOTES_LOCATION\s*=\s*['"]/.test(STORAGE_SRC),
      'LEGACY_NOTES_LOCATION 应当以字符串字面量的形式冻结定义'
    ).toBe(true)

    // 反例补一道：也不许塞进 LS_KEYS —— resetConfig 遍历 Object.values(LS_KEYS)
    // 清键，塞进去等于「恢复默认设置 = 抹掉老版本的位置记录」。
    expect(
      /LEGACY_NOTES_LOCATION\s*:/.test(STORAGE_SRC),
      'LEGACY_NOTES_LOCATION 不应作为 LS_KEYS 的一个成员（会被 resetConfig 清掉）'
    ).toBe(false)
  })

  it('K3 workspace.js 的迁移读常量，不再内联历史 key 字面量', () => {
    expect(
      WORKSPACE_SRC.includes(`'${OLD_KEY_LITERAL}'`),
      'workspace.js 又内联了历史 key 字面量 —— 应改用 LEGACY_NOTES_LOCATION'
    ).toBe(false)
    expect(
      WORKSPACE_SRC.includes('LEGACY_NOTES_LOCATION'),
      'workspace.js 未引用 LEGACY_NOTES_LOCATION'
    ).toBe(true)
    expect(
      /getItem\(\s*LEGACY_NOTES_LOCATION\s*\)/.test(WORKSPACE_SRC),
      '迁移分支应当用 LEGACY_NOTES_LOCATION 去 getItem'
    ).toBe(true)
  })

  it('K4 老数据真的被迁移（证明常量被消费，不是死代码）', async () => {
    // 老版本升级上来的用户，localStorage 里躺的就是这一个键
    localStorage.setItem(OLD_KEY_LITERAL, '/legacy/vault/from-old-version')

    const { useWorkspaceStore } = await import('@/stores/workspace')
    const store = useWorkspaceStore()
    await store.hydrate()

    expect(store.workspaces).toHaveLength(1)
    expect(store.workspaces[0].path).toBe('/legacy/vault/from-old-version')
    // 默认名取路径最后一段
    expect(store.workspaces[0].name).toBe('from-old-version')
    expect(store.activeId).toBe(store.workspaces[0].id)

    // 迁移结果要落到新结构里，否则下次冷启动又从头迁一遍（重复造 id）
    expect(localStorage.getItem(NEW_LIST_KEY)).toContain('/legacy/vault/from-old-version')
  })

  it('K5 老值是示例哨兵 sample 时不迁移（哨兵语义没被改坏）', async () => {
    localStorage.setItem(OLD_KEY_LITERAL, 'sample')

    const { useWorkspaceStore } = await import('@/stores/workspace')
    const store = useWorkspaceStore()
    await store.hydrate()

    // 'sample' 是示例数据的历史哨兵，不是真目录 —— 拿它建库会指向一个不存在的路径
    expect(store.workspaces).toHaveLength(0)
    expect(store.activeId).toBe(null)
  })
})
