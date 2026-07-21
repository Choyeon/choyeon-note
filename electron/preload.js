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
  fileExists: (filePath) => ipcRenderer.invoke('fs:file-exists', filePath),
  
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
