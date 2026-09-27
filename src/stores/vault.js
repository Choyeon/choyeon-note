import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { IS_ELECTRON as isElectron } from '@/utils/env'
import { readLocal } from '@/utils/storage'
import { createLogger } from '../utils/logger.js'
import { LOG_MODULES } from '../constants/logging.js'

/**
 * 密码本的模块 logger。
 *
 * 记录纪律（与 utils/logSanitize.js 文件头的口径一致，**违反即泄露**）：
 *   · `entry.value`（明文）与 `entry.valueEnc`（safeStorage 密文）永不入日志；
 *   · `secret` 条目的 `key` / `note` 由内核自动一并遮蔽，所以即使不小心把整条
 *     条目塞进 data，也只剩结构信息 —— 但**不要依赖这层兜底**，能不记就不记；
 *   · 需要「记了什么」时只记计数、长度、id 这类**不含内容**的事实。
 */
const vaultLog = createLogger(LOG_MODULES.vault)

const LS_VAULT = 'choyeon-kv-vault'

const SAVE_DEBOUNCE_MS = 400
/** 空闲多久自动锁定（掩码 + 清空已展开项） */
const AUTO_LOCK_MS = 5 * 60 * 1000

const generateId = () => `kv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/**
 * 预置条目类型。作用不只是打标签：
 * - icon / accent 决定卡片视觉；
 * - secret 决定默认是否掩码（凭证类默认掩码，IP 这类非凭证默认明文）；
 * - template 提供一键填充的 key 占位，降低录入成本。
 */
export const VAULT_KINDS = [
  { id: 'credential', label: '账号密码', icon: 'KeyRound', accent: '#E53935', secret: true, template: { key: '账号', note: '用途 / 归属系统' } },
  { id: 'server', label: '服务器', icon: 'Server', accent: '#4A90D9', secret: false, template: { key: '服务器 IP', note: '环境 / 机房 / 负责人' } },
  { id: 'token', label: 'Token / 密钥', icon: 'KeySquare', accent: '#8B5CF6', secret: true, template: { key: 'API Token', note: '生效范围 / 过期时间' } },
  { id: 'database', label: '数据库', icon: 'Database', accent: '#26A69A', secret: true, template: { key: '数据库连接', note: '库名 / 环境' } },
  { id: 'contact', label: '联系方式', icon: 'Contact', accent: '#66BB6A', secret: false, template: { key: '联系人', note: '关系 / 备注' } },
  { id: 'other', label: '其他', icon: 'StickyNote', accent: '#FF7043', secret: false, template: { key: '', note: '' } }
]

export const KIND_MAP = Object.fromEntries(VAULT_KINDS.map(k => [k.id, k]))

export function kindOf(id) {
  return KIND_MAP[id] || KIND_MAP.other
}

export const useVaultStore = defineStore('vault', () => {
  const entries = ref([])
  const query = ref('')
  const activeGroup = ref('all') // 'all' | '__favorite' | 具体分组名
  const workspaceId = ref('default')
  const isLoading = ref(false)
  const revealed = ref(new Set()) // 临时放掩码的条目 id（不落盘）
  /** 主进程 safeStorage 是否可用：决定敏感值是加密落盘还是明文落盘 */
  const encryptionAvailable = ref(false)
  /** 锁定态：锁定后所有敏感值强制掩码 */
  const locked = ref(false)
  let saveTimer = null
  let idleTimer = null

  // ---------------------------------------------------------------- 加密
  async function refreshEncryptionState() {
    if (!isElectron || !window.electronAPI?.vaultEncryptionAvailable) {
      encryptionAvailable.value = false
      return false
    }
    try {
      encryptionAvailable.value = !!(await window.electronAPI.vaultEncryptionAvailable())
    } catch {
      encryptionAvailable.value = false
    }
    return encryptionAvailable.value
  }

  async function encryptValue(plain) {
    if (!encryptionAvailable.value || !window.electronAPI?.vaultEncrypt) return null
    try {
      return await window.electronAPI.vaultEncrypt(String(plain ?? ''))
    } catch {
      return null
    }
  }

  async function decryptValue(cipher) {
    if (!encryptionAvailable.value || !cipher || !window.electronAPI?.vaultDecrypt) return null
    try {
      return await window.electronAPI.vaultDecrypt(cipher)
    } catch {
      return null
    }
  }

  /**
   * 落盘形状：敏感条目把明文换成 safeStorage 密文。
   * safeStorage 用操作系统凭据库（Windows DPAPI / macOS Keychain / Linux libsecret）
   * 加密，密钥不在应用数据里，任何直接读 vaults/*.json 的程序拿不到明文。
   * 加密不可用时保留明文（并把状态回报给 UI，由界面明确提示风险）。
   */
  async function toPersistable() {
    const out = []
    for (const e of entries.value) {
      const plain = { ...e }
      if (plain.secret && encryptionAvailable.value) {
        const cipher = await encryptValue(plain.value)
        if (cipher) {
          plain.value = ''
          plain.valueEnc = cipher
        }
      }
      out.push(plain)
    }
    return out
  }

  /** 载入形状 → 内存形状：把密文还原成明文 */
  async function fromPersisted(list) {
    const out = []
    for (const e of list) {
      const item = { ...e }
      if (item.valueEnc) {
        const plain = await decryptValue(item.valueEnc)
        item.value = plain ?? ''
        // 解密失败（换了机器 / keyring 不可用）时不要把密文当成值展示
        if (plain === null) item.decryptFailed = true
        delete item.valueEnc
      }
      out.push(item)
    }
    return out
  }

  // ---------------------------------------------------------------- 自动锁定
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer)
    if (locked.value) return
    idleTimer = setTimeout(() => lockNow(), AUTO_LOCK_MS)
  }

  /** 任何与敏感数据相关的操作都要调用，推迟自动锁定 */
  function markActivity() {
    if (!locked.value) resetIdleTimer()
  }

  function lockNow() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    revealed.value.clear()
    locked.value = true
  }

  function unlock() {
    locked.value = false
    resetIdleTimer()
  }

  // ---------------------------------------------------------------- 派生数据
  const groups = computed(() => {
    const set = new Set()
    entries.value.forEach(e => {
      if (e.group) set.add(e.group)
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  })

  const filteredEntries = computed(() => {
    const q = query.value.trim().toLowerCase()
    let list = entries.value

    if (activeGroup.value === '__favorite') {
      list = list.filter(e => e.favorite)
    } else if (activeGroup.value !== 'all') {
      list = list.filter(e => (e.group || '') === activeGroup.value)
    }

    if (!q) {
      return [...list].sort(sortEntries)
    }

    return list
      .map(e => ({ entry: e, score: scoreEntry(e, q) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || sortEntries(a.entry, b.entry))
      .map(x => x.entry)
  })

  const favoriteCount = computed(() => entries.value.filter(e => e.favorite).length)
  const secretCount = computed(() => entries.value.filter(e => e.secret).length)

  function sortEntries(a, b) {
    if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  }

  /** 轻量打分：字段前缀命中 > 包含命中；键名权重高于值 */
  function scoreEntry(entry, q) {
    const key = String(entry.key || '').toLowerCase()
    const value = String(entry.value || '').toLowerCase()
    const note = String(entry.note || '').toLowerCase()
    const group = String(entry.group || '').toLowerCase()
    let score = 0
    if (key.startsWith(q)) score += 100
    else if (key.includes(q)) score += 60
    if (group.startsWith(q)) score += 40
    else if (group.includes(q)) score += 20
    if (note.includes(q)) score += 25
    // 敏感值不参与内容搜索，避免搜索框成为泄露面
    if (!entry.secret && value.includes(q)) score += 30
    if ((entry.tags || []).some(t => String(t).toLowerCase().includes(q))) score += 15
    return score
  }

  // ---------------------------------------------------------------- 持久化
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * 立即落盘。敏感值先加密再写。
   *
   * localStorage 只在**非 Electron（浏览器预览）**环境当后备存储用：
   * Electron 下如果再往 localStorage 写一份明文副本，任何渲染进程脚本或 XSS
   * 都能绕过加密直接读走全部凭据 —— 等于加密白做。
   */
  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const payload = await toPersistable()

    if (isElectron) {
      try {
        await window.electronAPI.saveVault(workspaceId.value, JSON.parse(JSON.stringify(payload)))
      } catch (error) {
        // 只记异常本身 —— payload（可能含明文 value / safeStorage 密文 valueEnc）
        // 绝不能进 data，否则「保存失败」这条日志就成了泄密现场。
        vaultLog.error('保存失败', { err: error })
      }
    } else {
      try {
        localStorage.setItem(LS_VAULT, JSON.stringify(payload))
      } catch {
        /* 忽略配额错误 */
      }
    }
  }

  let hydrateToken = 0

  async function hydrate(wsId) {
    const token = ++hydrateToken
    isLoading.value = true
    workspaceId.value = wsId || 'default'
    await refreshEncryptionState()
    try {
      let loaded
      if (isElectron) {
        loaded = await window.electronAPI.loadVault(workspaceId.value)
      } else {
        loaded = readLocal(LS_VAULT, [])
      }
      if (token !== hydrateToken) return // 过期响应丢弃，避免快速进出页面互相覆盖
      entries.value = normalize(await fromPersisted(Array.isArray(loaded) ? loaded : []))
    } catch (error) {
      // 载入失败绝不能再静默吞掉：密码本「加载不出来」与「本来就是空的」在 UI 上
      // 长得一模一样，没有这条记录就永远分不清是 IPC 挂了、文件被拒，还是库真的
      // 是空的 —— 而误判成后者，用户会以为自己把密码弄丢了。
      //
      // 记录内容的边界（与 logSanitize.js 文件头的纪律一致）：
      //   · 只记**环境事实**：哪个工作区、加密通道是否可用、这次响应是否已过期；
      //   · 条目本身（key / value / valueEnc / note）一条都不进日志 —— 明文与
      //     safeStorage 密文同属禁区；即便将来有人误塞，内核也会按敏感 key 与
      //     secret 条目规则整体遮蔽，但**不要依赖这层兜底**。
      vaultLog.error('载入失败，回退到本地后备存储', {
        workspace: workspaceId.value,
        encrypted: encryptionAvailable.value,
        stale: token !== hydrateToken,
        err: error
      })
      if (token !== hydrateToken) return
      entries.value = normalize(readLocal(LS_VAULT, []))
    } finally {
      if (token === hydrateToken) {
        isLoading.value = false
        resetIdleTimer()
      }
    }
  }

  function normalize(list) {
    if (!Array.isArray(list)) return []
    return list
      .filter(Boolean)
      .map(e => ({
        id: e.id || generateId(),
        key: String(e.key ?? ''),
        value: String(e.value ?? ''),
        note: String(e.note ?? ''),
        group: String(e.group ?? ''),
        kind: KIND_MAP[e.kind] ? e.kind : 'other',
        tags: Array.isArray(e.tags) ? e.tags.filter(Boolean).map(String) : [],
        secret: !!e.secret,
        favorite: !!e.favorite,
        createdAt: e.createdAt || Date.now(),
        updatedAt: e.updatedAt || e.createdAt || Date.now()
      }))
  }

  // ---------------------------------------------------------------- CRUD
  function addEntry(payload = {}) {
    const kind = kindOf(payload.kind)
    const now = Date.now()
    const entry = {
      id: generateId(),
      key: (payload.key ?? kind.template.key ?? '').trim(),
      value: String(payload.value ?? ''),
      note: String(payload.note ?? ''),
      group: String(payload.group ?? '').trim(),
      kind: kind.id,
      tags: (payload.tags || []).filter(Boolean).map(t => String(t).trim()),
      secret: payload.secret ?? kind.secret,
      favorite: !!payload.favorite,
      createdAt: now,
      updatedAt: now
    }
    entries.value.unshift(entry)
    scheduleSave()
    return entry
  }

  function updateEntry(id, patch) {
    const entry = entries.value.find(e => e.id === id)
    if (!entry) return null
    Object.assign(entry, patch, { updatedAt: Date.now() })
    if (patch.kind && !KIND_MAP[patch.kind]) entry.kind = 'other'
    scheduleSave()
    return entry
  }

  function removeEntry(id) {
    const idx = entries.value.findIndex(e => e.id === id)
    if (idx === -1) return false
    entries.value.splice(idx, 1)
    revealed.value.delete(id)
    scheduleSave()
    return true
  }

  function toggleFavorite(id) {
    const entry = entries.value.find(e => e.id === id)
    if (!entry) return false
    entry.favorite = !entry.favorite
    entry.updatedAt = Date.now()
    scheduleSave()
    return entry.favorite
  }

  function toggleReveal(id) {
    markActivity()
    if (revealed.value.has(id)) revealed.value.delete(id)
    else revealed.value.add(id)
  }

  function isRevealed(id) {
    // 锁定态下即使之前展开过也强制掩码
    return !locked.value && revealed.value.has(id)
  }

  function revealAll() {
    markActivity()
    entries.value.filter(e => e.secret).forEach(e => revealed.value.add(e.id))
  }

  function hideAll() {
    revealed.value.clear()
  }

  /** 掩码：保留首尾少量字符，中间用 • 填充，长度不随明文长度线性暴露 */
  function mask(value) {
    const text = String(value ?? '')
    if (!text) return ''
    if (text.length <= 4) return '••••'
    const head = text.slice(0, Math.min(2, Math.floor(text.length / 4)))
    const tail = text.slice(-Math.min(2, Math.floor(text.length / 4)))
    return `${head}${'•'.repeat(Math.min(10, Math.max(4, text.length - head.length - tail.length)))}${tail}`
  }

  function displayValue(entry) {
    if (!entry.secret) return entry.value
    return isRevealed(entry.id) ? entry.value : mask(entry.value)
  }

  // ---------------------------------------------------------------- 批量
  function importEntries(list) {
    const normalized = normalize(list)
    const existingKeys = new Set(entries.value.map(e => `${e.key}\u0000${e.group}`))
    let added = 0
    for (const item of normalized) {
      if (existingKeys.has(`${item.key}\u0000${item.group}`)) continue
      items_push(item)
      added++
    }
    scheduleSave()
    return added
  }

  function items_push(item) {
    entries.value.unshift({ ...item, id: generateId(), createdAt: Date.now(), updatedAt: Date.now() })
  }

  function exportEntries() {
    // 导出为明文 CSV（用户主动行为），敏感项由 UI 二次确认
    const header = ['键', '值', '备注', '分组', '类型', '标签']
    const rows = entries.value.map(e => [
      e.key, e.value, e.note, e.group, kindOf(e.kind).label, (e.tags || []).join('|')
    ])
    const escape = (v) => `"${String(v).replace(/"/g, '""')}"`
    return [header, ...rows].map(r => r.map(escape).join(',')).join('\r\n')
  }

  function parseCsv(text) {
    const lines = String(text).split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) return []
    const parseRow = (line) => {
      const cells = []
      let current = ''
      let inQuote = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (inQuote && line[i + 1] === '"') { current += '"'; i++ }
          else inQuote = !inQuote
        } else if (ch === ',' && !inQuote) {
          cells.push(current); current = ''
        } else {
          current += ch
        }
      }
      cells.push(current)
      return cells
    }
    const header = parseRow(lines[0]).map(h => h.trim())
    return lines.slice(1).map(line => {
      const cells = parseRow(line)
      const row = {}
      header.forEach((h, i) => { row[h] = cells[i] ?? '' })
      const kindId = VAULT_KINDS.find(k => k.label === row['类型'])?.id || 'other'
      return {
        key: row['键'] || '',
        value: row['值'] || '',
        note: row['备注'] || '',
        group: row['分组'] || '',
        kind: kindId,
        tags: (row['标签'] || '').split('|').filter(Boolean)
      }
    }).filter(r => r.key)
  }

  function clearAll() {
    entries.value = []
    revealed.value.clear()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    scheduleSave()
  }

  /** 页面卸载时清理定时器，避免闲置锁定回调打到已销毁的组件 */
  function dispose() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  }

  return {
    entries,
    query,
    activeGroup,
    workspaceId,
    isLoading,
    revealed,
    encryptionAvailable,
    locked,
    groups,
    filteredEntries,
    favoriteCount,
    secretCount,
    hydrate,
    flush,
    addEntry,
    updateEntry,
    removeEntry,
    toggleFavorite,
    toggleReveal,
    isRevealed,
    revealAll,
    hideAll,
    lockNow,
    unlock,
    markActivity,
    mask,
    displayValue,
    importEntries,
    exportEntries,
    parseCsv,
    clearAll,
    dispose
  }
})
