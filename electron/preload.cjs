const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  
  selectNotesPath: () => ipcRenderer.invoke('app:select-notes-path'),
  getNotesPath: () => ipcRenderer.invoke('app:get-notes-path'),
  setNotesPath: (path) => ipcRenderer.invoke('app:set-notes-path', path),
  
  readDirectory: (dirPath) => ipcRenderer.invoke('fs:read-directory', dirPath),
  readDirectoryRecursive: (dirPath) => ipcRenderer.invoke('fs:read-directory-recursive', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  createDirectory: (dirPath) => ipcRenderer.invoke('fs:create-directory', dirPath),
  deleteFile: (filePath) => ipcRenderer.invoke('fs:delete-file', filePath),
  moveFile: (oldPath, newPath) => ipcRenderer.invoke('fs:move-file', oldPath, newPath),
  fileExists: (filePath) => ipcRenderer.invoke('fs:file-exists', filePath),

  // ===== 笔记目录监听（设置页「自动同步」）=====
  watchNotes: (dirPath) => ipcRenderer.invoke('fs:watch-notes', dirPath),
  unwatchNotes: () => ipcRenderer.invoke('fs:unwatch-notes'),
  onNotesExternalChange: (callback) => {
    const listener = (_, data) => callback(data)
    ipcRenderer.on('notes:external-change', listener)
    return () => ipcRenderer.removeListener('notes:external-change', listener)
  },

  loadSpellData: () => ipcRenderer.invoke('spell:load'),
  saveSpellData: (payload) => ipcRenderer.invoke('spell:save', payload),

  // ===== 工作空间 =====
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  saveWorkspaces: (list) => ipcRenderer.invoke('workspace:save', list),
  setActiveWorkspace: (id) => ipcRenderer.invoke('workspace:set-active', id),
  getActiveWorkspace: () => ipcRenderer.invoke('workspace:get-active'),
  probeWorkspace: (dirPath) => ipcRenderer.invoke('workspace:probe', dirPath),

  // ===== 键值备忘录 =====
  loadVault: (workspaceId) => ipcRenderer.invoke('vault:load', workspaceId),
  saveVault: (workspaceId, entries) => ipcRenderer.invoke('vault:save', workspaceId, entries),

  // ===== Bing 每日壁纸（走主进程，避免渲染进程被 CORS 拦截）=====
  fetchBingWallpaper: (market) => ipcRenderer.invoke('bing:fetch-wallpaper', market),

  onMenuAction: (callback) => {
    const events = [
      'menu:new-note',
      'menu:open',
      'menu:save',
      'menu:toggle-sidebar',
      'menu:search',
      'menu:command-palette',
      'menu:toggle-theme'
    ]
    const listeners = []
    events.forEach(event => {
      const listener = () => callback(event)
      ipcRenderer.on(event, listener)
      listeners.push({ event, listener })
    })
    return () => {
      listeners.forEach(({ event, listener }) => {
        ipcRenderer.removeListener(event, listener)
      })
    }
  },

  checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download-update'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),

  onUpdaterEvent: (callback) => {
    const events = [
      'updater:checking',
      'updater:update-available',
      'updater:update-not-available',
      'updater:error',
      'updater:download-progress',
      'updater:update-downloaded'
    ]
    const listeners = []
    events.forEach(event => {
      const listener = (_, data) => callback(event, data)
      ipcRenderer.on(event, listener)
      listeners.push({ event, listener })
    })
    return () => {
      listeners.forEach(({ event, listener }) => {
        ipcRenderer.removeListener(event, listener)
      })
    }
  }
})
