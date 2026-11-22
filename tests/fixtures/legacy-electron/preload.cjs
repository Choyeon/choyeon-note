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
  // 批量读取：一次 IPC 读完整个目录，避免 N 次串行往返。
  // 入参 { paths: string[] }，返回 { ok, files: [{ path, content }], errors: [{ path, error }] }
  readFiles: (payload) => ipcRenderer.invoke('fs:read-files', payload),
  // options: { detail: true } —— 主进程 fs:write-file 默认只回 `false`（向后兼容），
  // 只有显式传 detail 才回 { ok:false, error, errno, message }，errno 就此传出来。
  // options 这个形参不能省：省了之后 invoke 只带两个参数，主进程收到的恒为
  // undefined，写盘失败原因永远停留在「猜 errno 关键词」的时代。
  writeFile: (filePath, content, options) => ipcRenderer.invoke('fs:write-file', filePath, content, options),
  createDirectory: (dirPath) => ipcRenderer.invoke('fs:create-directory', dirPath),
  deleteFile: (filePath, options) => ipcRenderer.invoke('fs:delete-file', filePath, options),
  // 删除目录（走系统回收站，不可用时退化为库内 .trash）
  removeDir: (dirPath, options) => ipcRenderer.invoke('fs:remove-dir', dirPath, options),
  // ===== 回收站「最近删除」（T27 主进程 / T28 面板）=====
  // 这三个通道管的是**库内 .trash**：系统回收站里的东西拿不到原路径，不在其列。
  //
  // trashList(options?)
  //   options: { trashDir?, retentionDays?, nowMs? }（都可省）
  //   → { ok, entries[], trashDir, exists, retentionDays, nowMs }
  //     entries 按 trashedAt 倒序，每条：
  //       { id, name, trashName, trashPath, metaPath, originPath, trashedAt,
  //         trashedAtISO, purgeAt, size, kind:'file'|'dir', degraded,
  //         degradedReason, hasMeta, outsideRoot, expired }
  //     · id         —— 还原 / 彻底删除时回传它（就是 .trash 里的文件名）
  //     · originPath —— 原始绝对路径，展示时用「相对笔记库的路径」更好读
  //     · degraded   —— true 表示元数据丢了，originPath 是**推测**的（UI 该标注）
  //     · expired    —— 超过 retentionDays，下次清空会被删掉（UI 该提醒）
  //     · outsideRoot—— true 时禁止还原（元数据被改坏），UI 该置灰按钮
  //
  // trashRestore({ id, strategy? })
  //   strategy: 'fail'(默认) | 'rename' | 'overwrite'
  //   → { ok:true, path, requestedPath, renamed, metaCleaned, kind, size }
  //   | { ok:false, error, errno, message, requestedPath?, suggestedPath? }
  //     error: 'invalid-id' | 'not-found' | 'outside-root' | 'target-exists'
  //            | 'restore-failed' | 'no-notes-path'
  //     同名冲突时先拿 suggestedPath 让用户确认，再改用 strategy:'rename'
  //
  // trashPurge(payload?)
  //   payload: { ids?: string[], all?: true, expiredOnly?: true,
  //              retentionDays?: number, dryRun?: true, nowMs?: number }
  //   → { ok, purged[], failed[], kept[], expired[], retentionDays, retentionMs,
  //       cutoffMs, dryRun, targets? }
  //   规则（安全性）：什么都不传 = 只清过期条目；要清空整个回收站必须显式 all:true；
  //   dryRun:true 只返回清单不动手，适合做「还有 N 条即将过期」的预告。
  trashList: (options) => ipcRenderer.invoke('trash:list', options),
  trashRestore: (payload) => ipcRenderer.invoke('trash:restore', payload),
  trashPurge: (payload) => ipcRenderer.invoke('trash:purge', payload),
  // options: { overwrite } —— 默认拒绝覆盖已存在目标，返回 { error: 'target-exists' }
  moveFile: (oldPath, newPath, options) => ipcRenderer.invoke('fs:move-file', oldPath, newPath, options),
  fileExists: (filePath) => ipcRenderer.invoke('fs:file-exists', filePath),

  // ===== 笔记目录监听（设置页「自动同步」）=====
  // watchNotes(dirPath)   → true | false（false = 目录不可访问 / 越界，主进程已记 error）
  //                         可重复调用：语义是**替换**而非叠加，重复调用不会多挂监听器
  // unwatchNotes()        → true
  watchNotes: (dirPath) => ipcRenderer.invoke('fs:watch-notes', dirPath),
  unwatchNotes: () => ipcRenderer.invoke('fs:unwatch-notes'),
  //
  // onNotesExternalChange(callback) —— 外部（Obsidian / VS Code / 同步盘 / 手动改文件）
  // 改了笔记目录时触发。**注意 payload 形状在 T21 变了**：
  //
  //   callback(changes)     其中
  //   changes: Array<{ path: string, kind: 'add' | 'change' | 'unlink' }>
  //
  //   · path —— **绝对路径**，直接可喂给 fs:read-file，无需再拼根目录
  //   · kind —— 只有三个取值：
  //       'add'    新增（基线快照里没有它）
  //       'change' 内容变了
  //       'unlink' 删掉了（也可能被移走，盘上不在了）
  //
  // 以前这个回调是**无参**的，收到就整库 loadNotesFromPath() 全量重载 —— 那会在用户
  // 打字的瞬间把编辑器内容冲掉（R-F5）。现在一次回调带一批变更，渲染侧据此做增量
  // reconcile 即可。
  //
  // 主进程侧的时序与过滤，渲染侧可以依赖这些前提：
  //   1. 600ms 去抖，窗口内多条变更**合并成一批**发出（不是一条一个事件）
  //   2. 本进程自己写过的路径在 1.5s 内被 isSelfWrite 吃掉，不会回灌
  //   3. 同一路径在一批里最多出现一次（已按 kind 优先级裁决过）
  //   4. 隐藏段（.git / .trash / .obsidian…）不上报
  //   5. **不做扩展名过滤**：.canvas / .png / 子目录 / 无扩展名文件全都会出现在
  //      changes 里 —— 认不认由渲染侧的 isNoteExtension 决定（R-F7）
  //   6. 窗口还没建好时不发（本批丢弃并记 warn），所以**不会**有「首帧全量快照」
  //      冲进来：主进程只在启监听时静默采一份基线，用来区分 add / change，基线本身
  //      不产生任何回调
  onNotesExternalChange: (callback) => {
    // 这里原样透传：主进程发的就是 changes 数组本身（不是 {root, changes} 包装）
    const listener = (_, changes) => callback(changes)
    ipcRenderer.on('notes:external-change', listener)
    return () => ipcRenderer.removeListener('notes:external-change', listener)
  },

  loadSpellData: () => ipcRenderer.invoke('spell:load'),
  saveSpellData: (payload) => ipcRenderer.invoke('spell:save', payload),

  // ===== id ↔ path 映射表（T16 · R-F1 双轨稳定 id）=====
  // 笔记 id 从「路径哈希」升级为「映射表说了算」，映射表由主进程保管在 userData 下
  // （**绝不写用户的 .md**）。渲染侧不要直接用它，走 utils/idMapStore.js —— 那里统一
  // 处理「没有 electronAPI 时降级 localStorage」以及去抖 / flush。
  //
  // idmapLoad：→ { ok, data } | { ok:true, data:null }（文件不存在）
  //            | { ok:false, data:null, error, errno }（损坏 / 读失败，主进程已记 warn）
  // idmapSave：payload 需带 byPath 对象 → { ok } | { ok:false, error, errno }
  idmap: {
    load: () => ipcRenderer.invoke('idmap:load'),
    save: (payload) => ipcRenderer.invoke('idmap:save', payload)
  },

  // ===== 工作空间 =====
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  saveWorkspaces: (list) => ipcRenderer.invoke('workspace:save', list),
  setActiveWorkspace: (id) => ipcRenderer.invoke('workspace:set-active', id),
  getActiveWorkspace: () => ipcRenderer.invoke('workspace:get-active'),
  probeWorkspace: (dirPath) => ipcRenderer.invoke('workspace:probe', dirPath),

  // ===== 键值备忘录 =====
  loadVault: (workspaceId) => ipcRenderer.invoke('vault:load', workspaceId),
  saveVault: (workspaceId, entries) => ipcRenderer.invoke('vault:save', workspaceId, entries),
  // 密文字段走主进程 safeStorage（操作系统凭据库），密钥不落应用数据
  vaultEncryptionAvailable: () => ipcRenderer.invoke('vault:encryption-available'),
  vaultEncrypt: (plainText) => ipcRenderer.invoke('vault:encrypt', plainText),
  vaultDecrypt: (cipherBase64) => ipcRenderer.invoke('vault:decrypt', cipherBase64),

  // ===== 退出前刷盘握手 =====
  // 主进程 before-quit 时发来信号，渲染侧 flush 完必须回报，否则最多等 3 秒
  onAppFlush: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:flush-all', listener)
    return () => ipcRenderer.removeListener('app:flush-all', listener)
  },
  notifyFlushComplete: () => ipcRenderer.send('app:flush-complete'),

  // ===== 日志系统（T09）=====
  // 渲染进程在 contextIsolation + sandbox 下拿不到 fs，落盘与导出都由主进程代劳。
  // 这里只透传结构化条目与参数，**不接受任意路径**（log:export 的目标位置由系统
  // 保存对话框给出，属于用户显式授权），从而维持既有安全模型。
  //
  // logAppend：entry 或 entry[]（LogEntry = { t, lvl, mod, msg, data }，渲染侧已脱敏）
  //            → { ok, written }；批量传数组能省掉高频日志的 IPC 往返
  logAppend: (entry) => ipcRenderer.invoke('log:append', entry),
  // logRead：最近 N 行 → { ok, path, lines[], total, truncated }
  logRead: (limit) => ipcRenderer.invoke('log:read', limit),
  // logPath：main.log 的绝对路径（展示 / 打开所在目录用），无 userData 时为 null
  logPath: () => ipcRenderer.invoke('log:path'),
  // logExport：弹保存对话框导出单文件 → { ok, path } | { ok:false, error }
  //            error === 'canceled' 表示用户主动取消，不要当成失败提示
  logExport: () => ipcRenderer.invoke('log:export'),
  // logClear：清空 main.log 与全部轮转文件 → { ok } | { ok:false, error }
  logClear: () => ipcRenderer.invoke('log:clear'),
  // logSetLevel：运行时切级别 → { ok, level, changed }；内核不持久化，重启后的值
  //              需由渲染侧引导层读 LS_LOG_LEVEL 后从这里喂进来
  logSetLevel: (level) => ipcRenderer.invoke('log:set-level', level),
  // 主进程清空文件后回调：设置页应在此调用 clearRingBuffer()，
  // 否则列表仍留着缓冲里的 500 条
  onLogCleared: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('log:cleared', listener)
    return () => ipcRenderer.removeListener('log:cleared', listener)
  },

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
