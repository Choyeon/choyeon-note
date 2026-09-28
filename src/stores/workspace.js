import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { IS_ELECTRON as isElectron, hasElectronAPI } from '@/utils/env'
import { readLocal, writeLocal } from '@/utils/storage'

const LS_WORKSPACES = 'choyeon-workspaces'
const LS_ACTIVE_WS = 'choyeon-active-workspace'

const generateId = () => `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** 常量：校验规则的单一来源（UI 与 store 共用同一套口径） */
export const WS_NAME_MAX = 80
export const WS_PATH_MAX = 4096
/** 显示名里禁止出现的字符：路径分隔符 + Windows 保留字符（含控制字符） */
export const WS_NAME_ILLEGAL = /[\u0000-\u001f\u007f/\\:*?"<>|]/

/** 取路径最后一段作为默认库名（兼容 Windows 与 POSIX 两种分隔符） */
export function basenameOf (dirPath) {
  return String(dirPath || '').split(/[\\/]/).filter(Boolean).pop() || ''
}

/**
 * 校验库显示名。
 *
 * 只做「拦得住的坏事」：空名、超长、含路径分隔符 / 保留字符、控制字符、重名。
 * 大小写不同视为同名（Windows / macOS 默认文件系统不区分大小写，允许
 * 「工作库」与「工作库」并存只会让用户自己都分不清）。
 *
 * @param {string} name 待校验名称
 * @param {string|null} excludeId 重命名时排除自身 id
 * @returns {{ok: boolean, name?: string, error: string}}
 */
export function validateWorkspaceName (name, excludeId = null) {
  const raw = typeof name === 'string' ? name : ''
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: '名称不能为空' }
  if (trimmed.length > WS_NAME_MAX) {
    return { ok: false, error: `名称不能超过 ${WS_NAME_MAX} 个字符` }
  }
  if (WS_NAME_ILLEGAL.test(trimmed)) {
    return { ok: false, error: '名称不能包含 / \\ : * ? " < > | 等字符' }
  }
  return { ok: true, name: trimmed, error: '' }
}

/**
 * 校验库路径。
 *
 * 拦的是三类会直接把应用带进沟里的输入：空 / 非字符串、含控制字符（含 NUL，
 * 传给主进程 fs 会直接抛）、以及「把整个盘符或根目录当成库」（那会把系统盘
 * 全量扫一遍）。'sample' 是示例数据的历史哨兵，不是真目录。
 *
 * @param {string} dirPath 待校验路径
 * @returns {{ok: boolean, path?: string, error: string}}
 */
export function validateWorkspacePath (dirPath) {
  if (typeof dirPath !== 'string') return { ok: false, error: '路径无效' }
  const trimmed = dirPath.trim()
  if (!trimmed) return { ok: false, error: '路径不能为空' }
  if (trimmed === 'sample') return { ok: false, error: '示例目录不能作为笔记库' }
  if (trimmed.length > WS_PATH_MAX) return { ok: false, error: '路径过长' }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, error: '路径包含非法字符' }
  const flat = trimmed.replace(/\\/g, '/')
  if (flat === '/' || flat === '.' || flat === '..' || /^[A-Za-z]:\/?$/.test(flat)) {
    return { ok: false, error: '不能把磁盘根目录作为笔记库' }
  }
  return { ok: true, path: trimmed, error: '' }
}

/**
 * 工作空间（Vault / 笔记库）管理。
 *
 * 数据分两层持久化：Electron 下写入 userData/workspaces.json，浏览器 / 降级场景
 * 写入 localStorage。activeWorkspace.path 同时同步给 appStore.notesLocation，
 * 保证路由守卫等既有逻辑（读 localStorage 的 choyeon-notes-location）继续生效。
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref([])
  const activeId = ref(null)
  const isLoading = ref(false)
  const error = ref('')
  const meta = ref({}) // { [workspaceId]: { count, folders, writable, exists, probedAt } }

  const activeWorkspace = computed(
    () => workspaces.value.find(w => w.id === activeId.value) || null
  )

  const sortedWorkspaces = computed(() =>
    [...workspaces.value].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
  )

  const hasWorkspaces = computed(() => workspaces.value.length > 0)

  function metaFor(id) {
    return meta.value[id] || null
  }

  /**
   * 磁盘缺失标记表：{ [workspaceId]: boolean }。
   *
   * 只认 probe 探测出来的 `exists === false`（含 probe 抛错时的兜底记录），
   * **从不**把「没探测过」当成缺失 —— 否则首帧还没 probe 完就会把整个列表
   * 闪成红色缺失，用户会以为库全丢了。
   */
  const missingMap = computed(() => {
    const map = {}
    for (const ws of workspaces.value) {
      const record = meta.value[ws.id]
      map[ws.id] = ws.missing === true || (!!record && record.exists === false)
    }
    return map
  })

  /**
   * 该库在磁盘上是否缺失（目录被移动 / U 盘拔了 / 网络盘断了）。
   *
   * @param {string} id 工作空间 id
   * @returns {boolean} 缺失为 true；未探测过为 false
   */
  function isMissing(id) {
    return missingMap.value[id] === true
  }

  /**
   * 在列表范围内校验名称（含重名）。
   *
   * @param {string} name 待校验名称
   * @param {string|null} excludeId 排除自身的 id（重命名时用）
   * @returns {{ok: boolean, name?: string, error: string}}
   */
  function checkName(name, excludeId = null) {
    const basic = validateWorkspaceName(name, excludeId)
    if (!basic.ok) return basic
    const lower = basic.name.toLowerCase()
    const taken = workspaces.value.some(
      w => w.id !== excludeId && String(w.name || '').trim().toLowerCase() === lower
    )
    if (taken) return { ok: false, error: `已存在名为「${basic.name}」的笔记库` }
    return basic
  }

  async function hydrate() {
    if (isElectron) {
      try {
        const [list, active] = await Promise.all([
          window.electronAPI.listWorkspaces(),
          window.electronAPI.getActiveWorkspace()
        ])
        workspaces.value = Array.isArray(list) ? list : []
        activeId.value = active || readLocal(LS_ACTIVE_WS, null)
      } catch {
        workspaces.value = readLocal(LS_WORKSPACES, [])
        activeId.value = readLocal(LS_ACTIVE_WS, null)
      }
    } else {
      workspaces.value = readLocal(LS_WORKSPACES, [])
      activeId.value = readLocal(LS_ACTIVE_WS, null)
    }

    // 兼容旧版本：升级前只有 choyeon-notes-location 一个字符串
    if (!workspaces.value.length) {
      const legacy = localStorage.getItem('choyeon-notes-location')
      if (legacy && legacy !== 'sample') {
        const migrated = {
          id: generateId(),
          name: legacy.split(/[\\/]/).filter(Boolean).pop() || '默认工作空间',
          path: legacy,
          createdAt: Date.now(),
          lastOpenedAt: Date.now()
        }
        workspaces.value = [migrated]
        activeId.value = migrated.id
        await persist()
      }
    }

    if (activeId.value && !workspaces.value.some(w => w.id === activeId.value)) {
      activeId.value = workspaces.value[0]?.id || null
    }
  }

  /**
   * 回写两层持久化。
   *
   * @returns {Promise<boolean>} 是否写成功；失败时 error 里留原因
   */
  async function persist() {
    writeLocal(LS_WORKSPACES, workspaces.value)
    writeLocal(LS_ACTIVE_WS, activeId.value)
    if (!hasElectronAPI()) return true
    try {
      // 传给 IPC 的必须是纯对象：Vue 响应式代理无法被结构化克隆
      await window.electronAPI.saveWorkspaces(JSON.parse(JSON.stringify(workspaces.value)))
      await window.electronAPI.setActiveWorkspace(activeId.value)
      return true
    } catch (persistError) {
      // 写不回去（userData 只读 / IPC 断了）时必须出声：列表看起来改了，
      // 重启后又退回旧状态，这种「改了但没生效」最难排查
      error.value = `保存笔记库列表失败：${persistError?.message || persistError}`
      return false
    }
  }

  /**
   * 登记（或复用）一个工作空间。已存在同路径时只更新名称与打开时间，
   * 避免同一个目录被重复登记成两个工作空间。
   */
  async function register(dirPath, name) {
    if (!dirPath || dirPath === 'sample') return null
    const existing = workspaces.value.find(w => w.path === dirPath)
    if (existing) {
      if (name) existing.name = name
      existing.lastOpenedAt = Date.now()
      const saved = await persist()
      return saved ? existing : null
    }
    const ws = {
      id: generateId(),
      name: name || basenameOf(dirPath) || '工作空间',
      path: dirPath,
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
    workspaces.value.push(ws)
    const saved = await persist()
    return saved ? ws : null
  }

  async function setActive(id) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws) return null
    const previousId = activeId.value
    activeId.value = id
    ws.lastOpenedAt = Date.now()
    const saved = await persist()
    if (!saved) {
      // 写盘失败就把指针拨回去：宁可「没切成」也不要「列表里是 A、磁盘上是 B」
      activeId.value = previousId
      return null
    }
    return ws
  }

  async function rename(id, name) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws || !name?.trim()) return false
    ws.name = name.trim()
    return await persist()
  }

  async function remove(id) {
    const idx = workspaces.value.findIndex(w => w.id === id)
    if (idx === -1) return false
    workspaces.value.splice(idx, 1)
    delete meta.value[id]
    if (activeId.value === id) {
      activeId.value = workspaces.value[0]?.id || null
    }
    // 只摘列表记录 —— 这里**绝不**调用任何删除类 IPC（deleteFile / removeDir /
    // trashItem …）：磁盘上的笔记是用户的，应用只保管「这个目录是库」这条索引。
    return await persist()
  }

  /**
   * 登记一个新的笔记库（多库管理入口的「新增」）。
   *
   * 与既有 register() 的差别：先校验再落库，并把失败原因带回去给 UI 提示。
   * 同一个目录重复登记时**不报错也不重复建**，而是回传已存在的那条
   * （alreadyExists）—— 用户点「打开已有库」是正常操作，不是错误。
   *
   * @param {string} dirPath 目录绝对路径
   * @param {string} [name] 显示名；留空则取目录名
   * @returns {Promise<{ok: boolean, workspace?: object|null, alreadyExists?: boolean, error: string}>}
   */
  async function addWorkspace(dirPath, name = '') {
    const pathCheck = validateWorkspacePath(dirPath)
    if (!pathCheck.ok) {
      error.value = pathCheck.error
      return { ok: false, error: pathCheck.error }
    }
    const target = pathCheck.path

    const existing = workspaces.value.find(w => w.path === target)
    if (existing) {
      error.value = ''
      return { ok: true, workspace: existing, alreadyExists: true, error: '' }
    }

    const fallbackName = basenameOf(target) || '笔记库'
    const nameCheck = checkName((name || '').trim() || fallbackName, null)
    if (!nameCheck.ok) {
      error.value = nameCheck.error
      return { ok: false, error: nameCheck.error }
    }

    const ws = await register(target, nameCheck.name)
    if (!ws) {
      const message = '登记笔记库失败'
      error.value = message
      return { ok: false, error: message }
    }
    error.value = ''
    return { ok: true, workspace: ws, alreadyExists: false, error: '' }
  }

  /**
   * 切换到指定笔记库。
   *
   * 硬要求：**目标库在磁盘上不存在时拒绝切换**，不静默切进一个空库。
   * 「切过去发现笔记全没了」比「切不过去」严重得多 —— 后者只是一条提示，
   * 前者会让用户以为数据丢了。只有 Electron 下才探测（浏览器预览没有 fs）。
   *
   * @param {string} id 工作空间 id
   * @returns {Promise<{ok: boolean, workspace?: object|null, missing?: boolean, error: string}>}
   */
  async function switchWorkspace(id) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws) {
      error.value = '笔记库不存在，可能已被移除'
      return { ok: false, error: error.value }
    }

    if (hasElectronAPI() && typeof window.electronAPI.probeWorkspace === 'function') {
      let record = null
      try {
        record = await probe(id)
      } catch (probeError) {
        record = { exists: false }
      }
      if (record && record.exists === false) {
        const message = `「${ws.name}」的目录已不存在，未切换：${ws.path}`
        error.value = message
        return { ok: false, workspace: ws, missing: true, error: message }
      }
    }

    const active = await setActive(id)
    if (!active) {
      const message = '切换笔记库失败'
      error.value = message
      return { ok: false, error: message }
    }
    error.value = ''
    return { ok: true, workspace: active, missing: false, error: '' }
  }

  /**
   * 重命名笔记库：**只改显示名，不动目录**。
   *
   * 与 Obsidian 口径一致：目录名是用户在文件系统里自己定的，改它等于替用户
   * 搬运数据（搬运还可能半途失败、还要通知监听器换路径）。显示名只是列表里
   * 的标签，改错了再改回来零成本。路径在 UI 上单独一行显示，不会混淆。
   *
   * @param {string} id 工作空间 id
   * @param {string} name 新显示名
   * @returns {Promise<{ok: boolean, workspace?: object|null, error: string}>}
   */
  async function renameWorkspace(id, name) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws) {
      error.value = '笔记库不存在，可能已被移除'
      return { ok: false, error: error.value }
    }
    const check = checkName(name, id)
    if (!check.ok) {
      error.value = check.error
      return { ok: false, workspace: ws, error: check.error }
    }
    const ok = await rename(id, check.name)
    if (!ok) {
      const message = '重命名失败'
      error.value = message
      return { ok: false, workspace: ws, error: message }
    }
    error.value = ''
    return { ok: true, workspace: ws, error: '' }
  }

  /**
   * 从列表移除笔记库。
   *
   * 硬要求：**绝不删磁盘文件**。这里只从列表里摘掉一条记录 + 回写持久化，
   * 文件中删除类 IPC（deleteFile / removeDir / trashItem …）一个都不许调用。
   * 用户的笔记是用户的，应用只保管「这个目录是库」这条索引。
   *
   * @param {string} id 工作空间 id
   * @returns {Promise<{ok: boolean, workspace?: object|null, error: string}>}
   */
  async function removeWorkspace(id) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws) {
      error.value = '笔记库不存在，可能已被移除'
      return { ok: false, error: error.value }
    }
    const removed = await remove(id)
    if (!removed) {
      const message = '移除笔记库失败'
      error.value = message
      return { ok: false, workspace: ws, error: message }
    }
    error.value = ''
    return { ok: true, workspace: ws, error: '' }
  }

  /** 探测磁盘状态：文件数量 + 是否仍存在 / 可写，用于标记失效工作空间 */
  async function probe(id) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws) return null
    if (!isElectron) {
      const result = { exists: true, count: 0, folders: 0, writable: true, probedAt: Date.now() }
      meta.value[id] = result
      // 探测通过就把「缺失」标记清掉：目录被重新接上后不应该还挂着红标
      ws.missing = false
      return result
    }
    try {
      const result = await window.electronAPI.probeWorkspace(ws.path)
      const record = { ...result, probedAt: Date.now() }
      meta.value[id] = record
      ws.missing = !record.exists
      return record
    } catch {
      const record = { exists: false, count: 0, folders: 0, writable: false, probedAt: Date.now() }
      meta.value[id] = record
      ws.missing = true
      return record
    }
  }

  async function probeAll() {
    await Promise.all(workspaces.value.map(w => probe(w.id)))
  }

  /**
   * 弹出系统选目录对话框。
   *
   * 用 hasElectronAPI() 而不是模块级的 isElectron：浏览器预览 / 单测里
   * electronAPI 是后装的，模块加载时它还不在。
   *
   * @returns {Promise<string|null>} 选中的目录；取消或不支持为 null
   */
  async function pickDirectory() {
    if (!hasElectronAPI() || typeof window.electronAPI.selectNotesPath !== 'function') {
      return null
    }
    try {
      const picked = await window.electronAPI.selectNotesPath()
      return typeof picked === 'string' && picked.trim() ? picked : null
    } catch {
      return null
    }
  }

  /**
   * 重置：清空工作空间列表。调用 persist() 把空状态写回磁盘，
   * 否则 Electron 的 workspaces.json 还留着旧列表，重启后又冒出来。
   */
  async function reset() {
    workspaces.value = []
    activeId.value = null
    meta.value = {}
    error.value = ''
    await persist()
  }

  return {
    workspaces,
    activeId,
    activeWorkspace,
    sortedWorkspaces,
    hasWorkspaces,
    isLoading,
    error,
    meta,
    missingMap,
    metaFor,
    isMissing,
    hydrate,
    persist,
    register,
    setActive,
    rename,
    remove,
    addWorkspace,
    switchWorkspace,
    renameWorkspace,
    removeWorkspace,
    checkName,
    probe,
    probeAll,
    pickDirectory,
    reset
  }
})
