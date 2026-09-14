const { app, BrowserWindow, Menu, ipcMain, dialog, net } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs/promises')
const fsConstants = require('fs')
const os = require('os')

const { validatePath, safeJoin } = require('./path-safety.cjs')

const isDev = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5176'

let mainWindow = null
let notesPath = null

// 认作笔记文件的扩展名（与 src/stores/note.js 的 KNOWN_EXTENSIONS 保持一致）
const NOTE_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

// ===== 笔记目录文件监听（设置页「自动同步」）=====
// 目录树变化很吵（一次保存可能触发 rename + change 多次），所以做两级降噪：
// 1) 本进程写入后 SELF_WRITE_QUIET_MS 内忽略（自己写的不用重载）
// 2) 其余事件合并到 WATCH_DEBOUNCE_MS 窗口里只发一次
let notesWatcher = null
let watchDebounceTimer = null
let suppressWatchUntil = 0
const WATCH_DEBOUNCE_MS = 600
const SELF_WRITE_QUIET_MS = 1500

function stopNotesWatcher() {
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  if (notesWatcher) {
    try { notesWatcher.close() } catch (e) { /* 已关闭 */ }
    notesWatcher = null
  }
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const spellDataFile = () => path.join(app.getPath('userData'), 'spell-data.json')
const workspacesFile = () => path.join(app.getPath('userData'), 'workspaces.json')
const vaultsDir = () => path.join(app.getPath('userData'), 'vaults')

let activeWorkspaceId = null

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch (error) {
    return fallback
  }
}

async function writeJson(file, data) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error(`Error writing ${file}:`, error.message)
    return false
  }
}

async function loadSettings() {
  try {
    const data = await fs.readFile(settingsFile(), 'utf-8')
    const settings = JSON.parse(data)
    if (settings.notesPath) {
      notesPath = settings.notesPath
    }
    if (settings.activeWorkspaceId) {
      activeWorkspaceId = settings.activeWorkspaceId
    }
  } catch (error) {
    // Settings file doesn't exist yet
  }
}

async function saveSettings() {
  try {
    const settings = { notesPath, activeWorkspaceId }
    await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch (error) {
    console.error('Error saving settings:', error.message)
  }
}

// ============================================================================
// 工作空间（Workspace）：多笔记库管理
// 为什么独立成文件：notesPath 只保存"当前"路径，无法支撑「最近工作空间列表 /
// 快速切换 / 失效路径标记」。工作空间元数据属于应用级配置，放 userData 而不是
// 笔记目录内，避免污染用户的 Markdown 库。
// ============================================================================
ipcMain.handle('workspace:list', async () => {
  return await readJson(workspacesFile(), [])
})

ipcMain.handle('workspace:save', async (_, workspaces) => {
  const list = Array.isArray(workspaces) ? workspaces : []
  return await writeJson(workspacesFile(), list)
})

ipcMain.handle('workspace:set-active', async (_, id) => {
  activeWorkspaceId = id || null
  await saveSettings()
  return true
})

ipcMain.handle('workspace:get-active', () => activeWorkspaceId)

ipcMain.handle('workspace:probe', async (_, dirPath) => {
  // 返回该路径下 .md 文件数量与是否可读写，供 UI 显示元信息 / 标记失效
  try {
    const stats = await fs.stat(dirPath)
    if (!stats.isDirectory()) return { exists: false, count: 0, writable: false }
    let count = 0
    let folders = 0
    const stack = [dirPath]
    while (stack.length) {
      const current = stack.pop()
      const entries = await fs.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          folders++
          stack.push(path.join(current, entry.name))
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
          count++
        }
      }
    }
    let writable = true
    try {
      await fs.access(dirPath, fsConstants.constants.W_OK)
    } catch {
      writable = false
    }
    return { exists: true, count, folders, writable }
  } catch (error) {
    return { exists: false, count: 0, folders: 0, writable: false, error: error.message }
  }
})

// ============================================================================
// 键值备忘录（KV Vault）
// 存放位置：userData/vaults/<workspaceId>.json —— 刻意不放进 notesPath。
// 原因：1) 内容多为账号/密码/Token，不应与可能被同步到云盘的 Markdown 混在一起；
//      2) notesPath 的 fs IPC 全部走 validatePath 白名单，扩展新目录会放宽安全边界。
// 注意：这是本地明文存储，仅提供基础的「掩码显示 + 不进搜索索引」保护，
//      不等价于加密保险库。
// ============================================================================
const vaultFileFor = (workspaceId) => path.join(vaultsDir(), `${workspaceId || 'default'}.json`)

ipcMain.handle('vault:load', async (_, workspaceId) => {
  const data = await readJson(vaultFileFor(workspaceId), { entries: [] })
  return Array.isArray(data.entries) ? data.entries : []
})

ipcMain.handle('vault:save', async (_, workspaceId, entries) => {
  return await writeJson(vaultFileFor(workspaceId), {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: Array.isArray(entries) ? entries : []
  })
})

function safeJoinWithNotes(...parts) {
  return safeJoin(notesPath, ...parts)
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
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
    const safePath = validatePath(notesPath, dirPath)
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
    const safePath = validatePath(notesPath, dirPath)
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
        } else if (file.isFile() && NOTE_FILE_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
          const ext = path.extname(file.name).toLowerCase()
          result.push({
            name: file.name,
            path: filePath,
            relativePath: fileRelativePath,
            isDirectory: false,
            isFile: true,
            extension: ext,
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

// ===== 笔记目录监听：外部改动（其它设备同步 / 手动编辑）自动刷新 =====
ipcMain.handle('fs:watch-notes', async (_, dirPath) => {
  try {
    const safePath = validatePath(notesPath, dirPath || notesPath)
    stopNotesWatcher()
    notesWatcher = fsConstants.watch(safePath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      if (!NOTE_FILE_EXTENSIONS.has(path.extname(String(filename)).toLowerCase())) return
      if (Date.now() < suppressWatchUntil) return
      if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
      watchDebounceTimer = setTimeout(() => {
        watchDebounceTimer = null
        mainWindow?.webContents.send('notes:external-change', {
          root: safePath,
          file: String(filename)
        })
      }, WATCH_DEBOUNCE_MS)
    })
    return true
  } catch (error) {
    console.error('Error watching notes directory:', error.message)
    return false
  }
})

ipcMain.handle('fs:unwatch-notes', async () => {
  stopNotesWatcher()
  return true
})

ipcMain.handle('fs:read-file', async (_, filePath) => {
  try {
    const safePath = validatePath(notesPath, filePath)
    const content = await fs.readFile(safePath, 'utf-8')
    return content
  } catch (error) {
    console.error('Error reading file:', error.message)
    return null
  }
})

ipcMain.handle('fs:write-file', async (_, filePath, content) => {
  try {
    const safePath = validatePath(notesPath, filePath)
    const dir = path.dirname(safePath)
    await fs.mkdir(dir, { recursive: true })
    // 标记"本进程写入"，让文件监听器忽略随后的 change 事件，避免自己写自己触发重载
    suppressWatchUntil = Date.now() + SELF_WRITE_QUIET_MS
    await fs.writeFile(safePath, content, 'utf-8')
    return true
  } catch (error) {
    console.error('Error writing file:', error.message)
    return false
  }
})

ipcMain.handle('fs:create-directory', async (_, dirPath) => {
  try {
    const safePath = validatePath(notesPath, dirPath)
    await fs.mkdir(safePath, { recursive: true })
    return true
  } catch (error) {
    console.error('Error creating directory:', error.message)
    return false
  }
})

ipcMain.handle('fs:delete-file', async (_, filePath) => {
  try {
    const safePath = validatePath(notesPath, filePath)
    await fs.unlink(safePath)
    return true
  } catch (error) {
    console.error('Error deleting file:', error.message)
    return false
  }
})

// ============= fs:move-file：重命名/拖放移动时的原子操作 =============
// 为什么需要独立 IPC：之前没有该 API，moveNote/renameNote 只能走 writeFile + deleteFile
// 的 fallback，会出现「写入成功但删除失败 → 重复文件」或「跨分区需要 copy+unlink」等
// 不一致问题。这里优先用 fs.rename（POSIX 原子性/Windows 同 NTFS 卷内原子），失败时退化为
// copy+unlink 并返回 true/false 标志，让渲染侧能正确更新 note.filePath。
ipcMain.handle('fs:move-file', async (_, oldPath, newPath) => {
  try {
    const safeOld = validatePath(notesPath, oldPath)
    const safeNew = validatePath(notesPath, newPath)
    if (safeOld === safeNew) return true
    // 目标目录预先创建
    await fs.mkdir(path.dirname(safeNew), { recursive: true })
    try {
      await fs.rename(safeOld, safeNew)
      return true
    } catch (renameErr) {
      // 跨设备 / 目录级 rename 不支持时 fallback：copy + unlink
      const stat = await fs.stat(safeOld)
      if (stat.isFile()) {
        await fs.copyFile(safeOld, safeNew)
        await fs.unlink(safeOld)
        return true
      }
      throw renameErr
    }
  } catch (error) {
    console.error('Error moving file:', error.message, { oldPath, newPath })
    return false
  }
})

ipcMain.handle('fs:file-exists', async (_, filePath) => {
  try {
    const safePath = validatePath(notesPath, filePath)
    await fs.access(safePath, fsConstants.constants.F_OK)
    return true
  } catch (error) {
    return false
  }
})

// 拼写数据持久化（userData/spell-data.json：ignoredWords / customDictionary 数组）
ipcMain.handle('spell:load', async () => {
  try {
    const raw = await fs.readFile(spellDataFile(), 'utf-8')
    const data = JSON.parse(raw || '{}')
    return {
      ignoredWords: Array.isArray(data.ignoredWords) ? data.ignoredWords : [],
      customDictionary: Array.isArray(data.customDictionary) ? data.customDictionary : []
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ignoredWords: [], customDictionary: [] }
    }
    console.error('spell:load error:', err?.message || String(err))
    return { ignoredWords: [], customDictionary: [] }
  }
})

ipcMain.handle('spell:save', async (_, payload) => {
  try {
    const data = {
      ignoredWords: Array.isArray(payload?.ignoredWords) ? payload.ignoredWords : [],
      customDictionary: Array.isArray(payload?.customDictionary) ? payload.customDictionary : []
    }
    await fs.writeFile(spellDataFile(), JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('spell:save error:', err?.message || String(err))
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

// ============================================================
// Bing 每日壁纸
// ------------------------------------------------------------
// 必须放主进程：渲染进程直连 www.bing.com/HPImageArchive.aspx 会被 CORS 拦掉
// （该接口不返回 Access-Control-Allow-Origin），所以功能一直是"开关能开、图不来"。
// 用 net.request 还能自动走系统代理设置。
// ============================================================
const BING_MARKETS = ['zh-CN', 'en-US']

function netGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url })
    let body = ''
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    req.setHeader('Accept', 'application/json')

    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume() // 读完响应体，避免连接悬挂
        fail(new Error('HTTP ' + res.statusCode))
        return
      }
      res.on('data', (chunk) => { body += chunk.toString() })
      res.on('end', () => {
        if (settled) return
        settled = true
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error('响应不是合法 JSON'))
        }
      })
    })
    req.on('error', fail)
    req.on('timeout', () => { req.abort(); fail(new Error('请求超时')) })

    req.setTimeout ? req.setTimeout(15000) : null
    req.end()
  })
}

ipcMain.handle('bing:fetch-wallpaper', async (_, market = 'zh-CN') => {
  const markets = BING_MARKETS.includes(market) ? [market, ...BING_MARKETS.filter(m => m !== market)] : [market]
  let lastError = null

  for (const mkt of markets) {
    try {
      const data = await netGetJson(
        `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=${encodeURIComponent(mkt)}`
      )
      const image = data && data.images && data.images[0]
      if (!image || !image.url) {
        lastError = new Error('接口未返回图片地址')
        continue
      }
      return {
        url: /^https?:/.test(image.url) ? image.url : 'https://www.bing.com' + image.url,
        title: image.title || '',
        copyright: image.copyright || '',
        date: image.startdate || '',
        market: mkt
      }
    } catch (err) {
      lastError = err
    }
  }
  return { error: (lastError && lastError.message) || '获取 Bing 壁纸失败' }
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
  stopNotesWatcher()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
