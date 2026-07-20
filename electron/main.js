const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const isDev = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5176'

let mainWindow = null
let notesPath = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: true
  })

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
    return notesPath
  }
  return null
})

ipcMain.handle('app:get-notes-path', () => {
  return notesPath
})

ipcMain.handle('app:set-notes-path', (_, path) => {
  notesPath = path
  return true
})

ipcMain.handle('fs:read-directory', async (_, dirPath) => {
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true })
    const result = []
    
    for (const file of files) {
      if (file.name.startsWith('.')) continue
      
      const filePath = path.join(dirPath, file.name)
      const stats = fs.statSync(filePath)
      
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
    console.error('Error reading directory:', error)
    return []
  }
})

ipcMain.handle('fs:read-directory-recursive', async (_, dirPath) => {
  try {
    const result = []
    
    function readDir(currentPath, relativePath = '') {
      const files = fs.readdirSync(currentPath, { withFileTypes: true })
      
      for (const file of files) {
        if (file.name.startsWith('.')) continue
        
        const filePath = path.join(currentPath, file.name)
        const stats = fs.statSync(filePath)
        const fileRelativePath = relativePath ? `${relativePath}/${file.name}` : file.name
        
        if (file.isDirectory()) {
          readDir(filePath, fileRelativePath)
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
    
    readDir(dirPath)
    return result
  } catch (error) {
    console.error('Error reading directory recursively:', error)
    return []
  }
})

ipcMain.handle('fs:read-file', async (_, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return content
  } catch (error) {
    console.error('Error reading file:', error)
    return null
  }
})

ipcMain.handle('fs:write-file', async (_, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8')
    return true
  } catch (error) {
    console.error('Error writing file:', error)
    return false
  }
})

ipcMain.handle('fs:create-directory', async (_, dirPath) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
    return true
  } catch (error) {
    console.error('Error creating directory:', error)
    return false
  }
})

ipcMain.handle('fs:delete-file', async (_, filePath) => {
  try {
    fs.unlinkSync(filePath)
    return true
  } catch (error) {
    console.error('Error deleting file:', error)
    return false
  }
})

ipcMain.handle('fs:file-exists', async (_, filePath) => {
  try {
    return fs.existsSync(filePath)
  } catch (error) {
    return false
  }
})

app.whenReady().then(() => {
  createWindow()
  createMenu()

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
