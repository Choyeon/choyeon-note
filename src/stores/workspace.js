import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { IS_ELECTRON as isElectron } from '@/utils/env'
import { readLocal, writeLocal } from '@/utils/storage'

const LS_WORKSPACES = 'choyeon-workspaces'
const LS_ACTIVE_WS = 'choyeon-active-workspace'

const generateId = () => `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

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

  async function persist() {
    writeLocal(LS_WORKSPACES, workspaces.value)
    writeLocal(LS_ACTIVE_WS, activeId.value)
    if (isElectron) {
      // 传给 IPC 的必须是纯对象：Vue 响应式代理无法被结构化克隆
      await window.electronAPI.saveWorkspaces(JSON.parse(JSON.stringify(workspaces.value)))
      await window.electronAPI.setActiveWorkspace(activeId.value)
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
      await persist()
      return existing
    }
    const ws = {
      id: generateId(),
      name: name || dirPath.split(/[\\/]/).filter(Boolean).pop() || '工作空间',
      path: dirPath,
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
    workspaces.value.push(ws)
    await persist()
    return ws
  }

  async function setActive(id) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws) return null
    activeId.value = id
    ws.lastOpenedAt = Date.now()
    await persist()
    return ws
  }

  async function rename(id, name) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws || !name?.trim()) return false
    ws.name = name.trim()
    await persist()
    return true
  }

  async function remove(id) {
    const idx = workspaces.value.findIndex(w => w.id === id)
    if (idx === -1) return false
    workspaces.value.splice(idx, 1)
    delete meta.value[id]
    if (activeId.value === id) {
      activeId.value = workspaces.value[0]?.id || null
    }
    await persist()
    return true
  }

  /** 探测磁盘状态：文件数量 + 是否仍存在 / 可写，用于标记失效工作空间 */
  async function probe(id) {
    const ws = workspaces.value.find(w => w.id === id)
    if (!ws) return null
    if (!isElectron) {
      const result = { exists: true, count: 0, folders: 0, writable: true, probedAt: Date.now() }
      meta.value[id] = result
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

  async function pickDirectory() {
    if (!isElectron) return null
    return await window.electronAPI.selectNotesPath()
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
    metaFor,
    hydrate,
    persist,
    register,
    setActive,
    rename,
    remove,
    probe,
    probeAll,
    pickDirectory,
    reset
  }
})
