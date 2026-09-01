import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const LS_VAULT = 'choyeon-kv-vault'

const isElectron = typeof window !== 'undefined' && !!window.electronAPI

const SAVE_DEBOUNCE_MS = 400

const generateId = () => `kv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

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
  let saveTimer = null

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

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    try {
      localStorage.setItem(LS_VAULT, JSON.stringify(entries.value))
    } catch {
      /* 忽略配额错误 */
    }
    if (isElectron) {
      window.electronAPI.saveVault(workspaceId.value, entries.value)
    }
  }

  async function hydrate(wsId) {
    isLoading.value = true
    workspaceId.value = wsId || 'default'
    try {
      if (isElectron) {
        const loaded = await window.electronAPI.loadVault(workspaceId.value)
        entries.value = normalize(loaded)
      } else {
        entries.value = normalize(readLocal(LS_VAULT, []))
      }
    } catch {
      entries.value = normalize(readLocal(LS_VAULT, []))
    } finally {
      isLoading.value = false
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
    if (revealed.value.has(id)) revealed.value.delete(id)
    else revealed.value.add(id)
  }

  function isRevealed(id) {
    return revealed.value.has(id)
  }

  function revealAll() {
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
    const existingKeys = new Set(entries.value.map(e => `${e.key} ${e.group}`))
    let added = 0
    for (const item of normalized) {
      if (existingKeys.has(`${item.key} ${item.group}`)) continue
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
    scheduleSave()
  }

  return {
    entries,
    query,
    activeGroup,
    workspaceId,
    isLoading,
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
    mask,
    displayValue,
    importEntries,
    exportEntries,
    parseCsv,
    clearAll
  }
})
