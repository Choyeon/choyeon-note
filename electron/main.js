const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs/promises')
const fsConstants = require('fs')
const os = require('os')

const isDev = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5176'

let mainWindow = null
let notesPath = null

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

async function loadSettings() {
  try {
    const data = await fs.readFile(settingsFile(), 'utf-8')
    const settings = JSON.parse(data)
    if (settings.notesPath) {
      notesPath = settings.notesPath
    }
  } catch (error) {
    // Settings file doesn't exist yet
  }
}

async function saveSettings() {
  try {
    const settings = { notesPath }
    await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch (error) {
    console.error('Error saving settings:', error.message)
  }
}

function validatePath(targetPath) {
  if (!notesPath) {
    throw new Error('Notes path not set')
  }
  const normalizedTarget = path.normalize(targetPath)
  const normalizedBase = path.normalize(notesPath)
  if (!normalizedTarget.startsWith(normalizedBase)) {
    throw new Error('Access denied: path outside notes directory')
  }
  return normalizedTarget
}

function safeJoin(...parts) {
  const joined = path.join(...parts)
  return validatePath(joined)
}

function createWindow() {
  const windowOptions = {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hiddenInset',
    hasShadow: true,
    icon: path.join(__dirname, '../build/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  }

  if (process.platform === 'win32') {
    windowOptions.backgroundMaterial = 'acrylic'
  } else if (process.platform === 'darwin') {
    windowOptions.vibrancy = 'under-window'
    windowOptions.visualEffectState = 'active'
    windowOptions.backgroundColor = 'rgba(255, 255, 255, 0.001)'
  } else {
    windowOptions.transparent = true
    windowOptions.backgroundColor = '#00000000'
  }

  mainWindow = new BrowserWindow(windowOptions)

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription)
    if (isDev) {
      setTimeout(() => {
        mainWindow?.loadURL(DEV_SERVER_URL)
      }, 2000)
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建笔记',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('menu:new-note')
          }
        },
        {
          label: '打开文件夹',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('menu:open')
          }
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow?.webContents.send('menu:save')
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '切换侧栏',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            mainWindow?.webContents.send('menu:toggle-sidebar')
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' }
      ]
    },
    {
      label: '工具',
      submenu: [
        {
          label: '搜索',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            mainWindow?.webContents.send('menu:search')
          }
        },
        {
          label: '命令面板',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            mainWindow?.webContents.send('menu:command-palette')
          }
        },
        { type: 'separator' },
        {
          label: '切换主题',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            mainWindow?.webContents.send('menu:toggle-theme')
          }
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Choyeon Note',
          click: () => {
            app.showAboutPanel()
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('window:is-maximized', () => {
  return mainWindow?.isMaximized()
})

ipcMain.handle('app:get-version', () => {
  return app.getVersion()
})

ipcMain.handle('app:select-notes-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择笔记存储文件夹',
    defaultPath: path.join(os.homedir(), 'Documents')
  })
  
  if (!result.canceled && result.filePaths.length > 0) {
    notesPath = result.filePaths[0]
    await saveSettings()
    return notesPath
  }
  return null
})

ipcMain.handle('app:get-notes-path', () => {
  return notesPath
})

ipcMain.handle('app:set-notes-path', async (_, path) => {
  notesPath = path
  await saveSettings()
  return true
})

ipcMain.handle('fs:read-directory', async (_, dirPath) => {
  try {
    const safePath = validatePath(dirPath)
    const files = await fs.readdir(safePath, { withFileTypes: true })
    const result = []
    
    for (const file of files) {
      if (file.name.startsWith('.')) continue
      
      const filePath = path.join(safePath, file.name)
      const stats = await fs.stat(filePath)
      
      result.push({
        name: file.name,
        path: filePath,
        isDirectory: file.isDirectory(),
        isFile: file.isFile(),
        extension: file.isFile() ? path.extname(file.name).toLowerCase() : '',
        size: stats.size,
        mtime: stats.mtime.getTime(),
        ctime: stats.ctime.getTime()
      })
    }
    
    return result
  } catch (error) {
    console.error('Error reading directory:', error.message)
    return []
  }
})

ipcMain.handle('fs:read-directory-recursive', async (_, dirPath) => {
  try {
    const safePath = validatePath(dirPath)
    const result = []
    
    async function readDir(currentPath, relativePath = '') {
      const files = await fs.readdir(currentPath, { withFileTypes: true })
      
      for (const file of files) {
        if (file.name.startsWith('.')) continue
        
        const filePath = path.join(currentPath, file.name)
        const stats = await fs.stat(filePath)
        const fileRelativePath = relativePath ? `${relativePath}/${file.name}` : file.name
        
        if (file.isDirectory()) {
          await readDir(filePath, fileRelativePath)
        } else if (file.isFile() && path.extname(file.name).toLowerCase() === '.md') {
          result.push({
            name: file.name,
            path: filePath,
            relativePath: fileRelativePath,
            isDirectory: false,
            isFile: true,
            extension: '.md',
            size: stats.size,
            mtime: stats.mtime.getTime(),
            ctime: stats.ctime.getTime()
          })
        }
      }
    }
    
    await readDir(safePath)
    return result
  } catch (error) {
    console.error('Error reading directory recursively:', error.message)
    return []
  }
})

ipcMain.handle('fs:read-file', async (_, filePath) => {
  try {
    const safePath = validatePath(filePath)
    const content = await fs.readFile(safePath, 'utf-8')
    return content
  } catch (error) {
    console.error('Error reading file:', error.message)
    return null
  }
})

ipcMain.handle('fs:write-file', async (_, filePath, content) => {
  try {
    const safePath = validatePath(filePath)
    const dir = path.dirname(safePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(safePath, content, 'utf-8')
    return true
  } catch (error) {
    console.error('Error writing file:', error.message)
    return false
  }
})

ipcMain.handle('fs:create-directory', async (_, dirPath) => {
  try {
    const safePath = validatePath(dirPath)
    await fs.mkdir(safePath, { recursive: true })
    return true
  } catch (error) {
    console.error('Error creating directory:', error.message)
    return false
  }
})

ipcMain.handle('fs:delete-file', async (_, filePath) => {
  try {
    const safePath = validatePath(filePath)
    await fs.unlink(safePath)
    return true
  } catch (error) {
    console.error('Error deleting file:', error.message)
    return false
  }
})

ipcMain.handle('fs:file-exists', async (_, filePath) => {
  try {
    const safePath = validatePath(filePath)
    await fs.access(safePath, fsConstants.constants.F_OK)
    return true
  } catch (error) {
    return false
  }
})

function setupAutoUpdater() {
  if (isDev) {
    autoUpdater.updateConfigPath = path.join(__dirname, '..', 'dev-app-update.yml')
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('updater:checking')
  })

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('updater:update-available', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    mainWindow?.webContents.send('updater:update-not-available', info)
  })

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('updater:error', err.message)
  })

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow?.webContents.send('updater:download-progress', progressObj)
  })

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('updater:update-downloaded', info)
  })
}

ipcMain.handle('updater:check-for-updates', async () => {
  try {
    await autoUpdater.checkForUpdates()
    return true
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('updater:download-update', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('updater:quit-and-install', () => {
  autoUpdater.quitAndInstall(false, true)
})

app.whenReady().then(async () => {
  await loadSettings()
  createWindow()
  createMenu()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
