// ============================================================================
// tauriBridge.js —— Tauri → Electron 兼容层
//
// 目标：让 src/ 下的 Vue 组件、store、composable 与样式**一行都不用改**。
// preload.cjs 注入的是 window.electronAPI；这里在 Tauri WebView 里注入一个
// 形状完全相同的对象，底层走 Tauri invoke / event。纯浏览器预览下不做任何
// 注入，electronAPI 仍然不存在，原有降级路径保持不变。
//
// 本文件必须是 main.js 的第一个 import：src/utils/env.js 在模块加载时就会
// 求值 IS_ELECTRON，晚一步注入就会让所有桌面端分支被判成浏览器分支。
// ============================================================================

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : null

if (internals && typeof internals.invoke === 'function') {
  const call = (command, args) => invoke(command, args)

  /** 把 Tauri 事件还原成 preload 的订阅 API：同步返回退订函数。 */
  const subscribe = (event, callback, transform) => {
    let unlisten = null
    let cancelled = false
    listen(event, (evt) => {
      if (cancelled) return
      // @tauri-apps/api/event 的回调参数是 { event, id, payload } 事件对象，
      // preload.cjs 则直接回调 payload。这里必须解包，否则外部变更同步与
      // 更新提示收到的是整个事件包装对象，所有事件消费者都会静默失效。
      const payload = evt && typeof evt === 'object' && 'payload' in evt ? evt.payload : evt
      callback(transform ? transform(payload) : payload)
    })
      .then((fn) => {
        unlisten = fn
        if (cancelled) fn()
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }

  const menuEvents = [
    'menu:new-note',
    'menu:open',
    'menu:save',
    'menu:toggle-sidebar',
    'menu:search',
    'menu:command-palette',
    'menu:toggle-theme'
  ]

  const updaterEvents = [
    'updater:checking',
    'updater:update-available',
    'updater:update-not-available',
    'updater:error',
    'updater:download-progress',
    'updater:update-downloaded'
  ]

  window.electronAPI = {
    // ===== 窗口 =====
    minimize: () => call('window_minimize'),
    maximize: () => call('window_maximize'),
    close: () => call('window_close'),
    isMaximized: () => call('window_is_maximized'),
    getVersion: () => call('app_get_version'),

    // ===== 笔记目录 =====
    selectNotesPath: () => call('app_select_notes_path'),
    getNotesPath: () => call('app_get_notes_path'),
    setNotesPath: (path) => call('app_set_notes_path', { candidate: path }),

    // ===== 文件系统 =====
    readDirectory: (dirPath) => call('fs_read_directory', { dirPath }),
    readDirectoryRecursive: (dirPath) =>
      call('fs_read_directory_recursive', { dirPath }),
    readFile: (filePath) => call('fs_read_file', { filePath }),
    readFiles: (payload) => call('fs_read_files', { payload }),
    writeFile: (filePath, content, options) =>
      call('fs_write_file', { filePath, content, options }),
    createDirectory: (dirPath) => call('fs_create_directory', { dirPath }),
    deleteFile: (filePath, options) =>
      call('fs_delete_file', { filePath, options }),
    removeDir: (dirPath, options) =>
      call('fs_remove_dir', { dirPath, options }),
    moveFile: (oldPath, newPath, options) =>
      call('fs_move_file', { oldPath, newPath, options }),
    fileExists: (filePath) => call('fs_file_exists', { filePath }),

    // ===== 回收站 =====
    trashList: (options) => call('trash_list', { payload: options }),
    trashRestore: (payload) => call('trash_restore', { payload }),
    trashPurge: (payload) => call('trash_purge', { payload }),

    // ===== 外部变更监听 =====
    watchNotes: (dirPath) => call('fs_watch_notes', { dirPath }),
    unwatchNotes: () => call('fs_unwatch_notes'),
    onNotesExternalChange: (callback) =>
      subscribe('notes:external-change', callback),

    // ===== 拼写数据 =====
    loadSpellData: () => call('spell_load'),
    saveSpellData: (payload) => call('spell_save', { payload }),

    // ===== id ↔ path 映射表 =====
    idmap: {
      load: () => call('idmap_load'),
      save: (payload) => call('idmap_save', { payload })
    },

    // ===== 工作空间 =====
    listWorkspaces: () => call('workspace_list'),
    saveWorkspaces: (list) => call('workspace_save', { workspaces: list }),
    setActiveWorkspace: (id) => call('workspace_set_active', { id }),
    getActiveWorkspace: () => call('workspace_get_active'),
    probeWorkspace: (dirPath) => call('workspace_probe', { dirPath }),

    // ===== 密码本 =====
    loadVault: (workspaceId) => call('vault_load', { workspaceId }),
    saveVault: (workspaceId, entries) =>
      call('vault_save', { workspaceId, entries }),
    vaultEncryptionAvailable: () => call('vault_encryption_available'),
    vaultEncrypt: (plainText) => call('vault_encrypt', { plainText }),
    vaultDecrypt: (cipherBase64) => call('vault_decrypt', { cipherBase64 }),

    // ===== 退出前刷盘 =====
    onAppFlush: (callback) => subscribe('app:flush-all', callback),
    notifyFlushComplete: () => call('flush_complete'),

    // ===== 日志 =====
    logAppend: (entry) => call('log_append', { entry }),
    logRead: (limit) => call('log_read', { limit }),
    logPath: () => call('log_path'),
    logExport: () => call('log_export'),
    logClear: () => call('log_clear'),
    logSetLevel: (level) => call('log_set_level', { level }),
    onLogCleared: (callback) => subscribe('log:cleared', callback),

    // ===== Bing 壁纸 =====
    fetchBingWallpaper: (market) =>
      call('bing_fetch_wallpaper', { market: market || 'zh-CN' }),

    // ===== 菜单事件 =====
    onMenuAction: (callback) => {
      const unsubscribes = menuEvents.map((event) =>
        subscribe(event, () => callback(event))
      )
      return () => unsubscribes.forEach((off) => off())
    },

    // ===== 更新 =====
    checkForUpdates: () => call('check_for_updates'),
    downloadUpdate: () => call('download_update'),
    quitAndInstall: () => call('quit_and_install'),
    onUpdaterEvent: (callback) => {
      const unsubscribes = updaterEvents.map((event) =>
        subscribe(event, (data) => callback(event, data))
      )
      return () => unsubscribes.forEach((off) => off())
    }
  }
}
