<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-14 px-8 py-3 flex items-center gap-2.5 border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        @click="$router.back()"
      >
        <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
      <h1 class="text-2xl font-bold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">设置</h1>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar acrylic-content">
      <div class="max-w-[720px] mx-auto px-6 py-8 pb-20">
        <div class="mb-8">
          <div class="flex items-center gap-3 mb-4 px-1">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <SunMoon class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">外观</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Palette class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">主题模式</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">选择您喜欢的界面主题</div>
                </div>
              </div>
              <div class="segmented-control">
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.theme === 'light' }"
                  @click="appStore.setTheme('light')"
                >浅色</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.theme === 'dark' }"
                  @click="appStore.setTheme('dark')"
                >深色</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.theme === 'system' }"
                  @click="appStore.setTheme('system')"
                >系统</button>
              </div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Palette class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">强调色</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">自定义界面的主色调</div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <div 
                  v-for="color in appStore.accentColors" 
                  :key="color"
                  class="accent-circle"
                  :class="{ selected: appStore.accentColor === color }"
                  :style="{ background: color }"
                  @click="appStore.setAccentColor(color)"
                >
                  <svg v-if="appStore.accentColor === color" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
              </div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Type class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">字体大小</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">调整编辑器文字大小</div>
                </div>
              </div>
              <div class="segmented-control">
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.fontSize === 'small' }"
                  @click="appStore.setFontSize('small')"
                >小</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.fontSize === 'medium' }"
                  @click="appStore.setFontSize('medium')"
                >中</button>
                <button 
                  class="segment-btn"
                  :class="{ active: appStore.fontSize === 'large' }"
                  @click="appStore.setFontSize('large')"
                >大</button>
              </div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Layers class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">毛玻璃效果</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">启用半透明背景模糊</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                aria-label="毛玻璃效果"
                :aria-checked="appStore.glassEffect"
                @click="appStore.toggleGlassEffect()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Image class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">Bing 每日壁纸</div>
                  <div
                    class="text-[12px] mt-0.5"
                    :style="{ color: bingHasError ? 'var(--state-error)' : 'var(--color-text-tertiary)' }"
                    :title="bingTriedText"
                  >{{ bingStatus }}</div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  v-if="appStore.bingWallpaper"
                  class="px-2.5 h-7 rounded-lg text-[12px] font-medium cursor-pointer transition-all duration-150 hover:opacity-80 disabled:opacity-50 inline-flex items-center gap-1"
                  :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
                  :disabled="bingRefreshing"
                  @click="refreshBingWallpaper"
                >
                  <RefreshCw class="w-3.5 h-3.5" :class="{ 'spin': bingRefreshing }" />
                  {{ bingRefreshing ? '获取中' : '刷新' }}
                </button>
                <button 
                  class="toggle-switch"
                  role="switch"
                  aria-label="Bing 每日壁纸"
                  :aria-checked="appStore.bingWallpaper"
                  @click="appStore.toggleBingWallpaper()"
                >
                  <span class="toggle-knob"></span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-4 px-1">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <FileCode class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">编辑器</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <FileText class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">默认扩展名</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">新建笔记时使用的文件格式</div>
                </div>
              </div>
              <select 
                class="px-3 py-1.5 rounded-lg text-[13px] font-mono cursor-pointer border outline-none transition-all duration-200 focus:ring-2 focus:ring-[var(--color-primary-ring)]"
                :style="{ 
                  background: 'var(--color-bg-tertiary)', 
                  color: 'var(--color-text-primary)',
                  borderColor: 'var(--color-border)'
                }"
                :value="appStore.noteExtension"
                @change="appStore.setNoteExtension($event.target.value)"
              >
                <option v-for="ext in appStore.NOTE_EXTENSIONS" :key="ext" :value="ext">.{{ ext }}</option>
              </select>
            </div>

            <!-- 默认编辑器模式：三模式统一由 store 托管并持久化 -->
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Edit class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">默认编辑器模式</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">
                    三种模式共用同一份文档，切换笔记与重启后沿用
                  </div>
                </div>
              </div>
              <div class="segmented-control">
                <button
                  class="segment-btn"
                  :class="{ active: appStore.editorMode === 'edit' }"
                  @click="appStore.setEditorMode('edit')"
                >源码</button>
                <button
                  class="segment-btn"
                  :class="{ active: appStore.editorMode === 'live' }"
                  @click="appStore.setEditorMode('live')"
                >实时</button>
                <button
                  class="segment-btn"
                  :class="{ active: appStore.editorMode === 'preview' }"
                  @click="appStore.setEditorMode('preview')"
                >阅读</button>
              </div>
            </div>

            <!-- 编辑器缩放：edit / live / preview 三种模式 + 阅读视图共用 -->
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Maximize2 class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">编辑器缩放</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">
                    同时作用于编辑 / 实时 / 预览三种模式与阅读视图
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  class="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-150 hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
                  title="缩小"
                  :disabled="appStore.editorZoom <= 50"
                  @click="appStore.setEditorZoom(appStore.editorZoom - 10)"
                >
                  <ZoomOut class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
                </button>
                <input
                  type="range"
                  min="50"
                  max="200"
                  step="5"
                  :value="appStore.editorZoom"
                  class="zoom-slider"
                  :style="{ '--zoom-pct': appStore.editorZoom }"
                  @input="appStore.setEditorZoom($event.target.value)"
                />
                <button
                  class="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-150 hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
                  title="放大"
                  :disabled="appStore.editorZoom >= 200"
                  @click="appStore.setEditorZoom(appStore.editorZoom + 10)"
                >
                  <ZoomIn class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-secondary)' }" />
                </button>
                <span class="text-[13px] font-medium tabular-nums w-11 text-right" :style="{ color: 'var(--color-text-primary)' }">
                  {{ appStore.editorZoom }}%
                </span>
                <button
                  v-if="appStore.editorZoom !== 100"
                  class="px-2 h-7 rounded-lg text-[12px] cursor-pointer transition-all duration-150 hover:opacity-80"
                  :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
                  @click="appStore.resetEditorZoom()"
                >重置</button>
              </div>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <SpellCheck class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">拼写检查</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">检测并标记英文拼写错误</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                aria-label="拼写检查"
                :aria-checked="appStore.spellCheck"
                @click="appStore.toggleSpellCheck()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <!-- 拼写忽略词 + 自定义字典 管理（已抽到 views/settings/SettingsDictionary.vue） -->
            <SettingsDictionary />

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Save class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动保存</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">编辑时自动保存更改</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                aria-label="自动保存"
                :aria-checked="appStore.autoSave"
                @click="appStore.toggleAutoSave()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <ListOrdered class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">行号显示</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">在编辑模式显示行号</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                aria-label="行号显示"
                :aria-checked="appStore.showLineNumbers"
                @click="appStore.toggleLineNumbers()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <WrapText class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动换行</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">长文本自动换行显示</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                aria-label="自动换行"
                :aria-checked="appStore.wordWrap"
                @click="appStore.toggleWordWrap()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Palette class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">代码高亮主题</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">选择代码块的配色方案</div>
                </div>
              </div>
              <select 
                class="px-3 py-1.5 rounded-lg text-[13px] cursor-pointer border outline-none transition-all duration-200 focus:ring-2 focus:ring-[var(--color-primary-ring)]"
                :style="{ 
                  background: 'var(--color-bg-tertiary)', 
                  color: 'var(--color-text-primary)',
                  borderColor: 'var(--color-border)'
                }"
                :value="appStore.codeTheme"
                @change="appStore.setCodeTheme($event.target.value)"
              >
                <!-- 选项来自 utils/markdown 的 codeThemes 注册表（唯一的真相源）：
                     以前这里手写了一份，于是 UI 里有一个注册表根本没有的
                     "Dracula"，而注册表里真实存在的 Tokyo Night 又从不出现。 -->
                <option v-for="theme in codeThemeOptions" :key="theme.id" :value="theme.id">{{ theme.name }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="mb-8" v-if="isElectron">
          <div class="flex items-center gap-3 mb-4 px-1">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <FolderOpen class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">文件与同步</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Folder class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">笔记存储位置</div>
                  <!-- 显示「当前真正生效的库路径」而不是 appStore 那份镜像：
                       两者在载入失败等场景下会不同步，显示了镜像等于骗人。 -->
                  <div class="text-[12px] mt-0.5 font-mono" :style="{ color: 'var(--color-text-tertiary)' }">{{ currentNotesLocation || '未设置' }}</div>
                </div>
              </div>
              <button 
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95"
                :style="{ background: 'var(--color-primary)', color: 'white' }"
                @click="changeNotesLocation"
              >
                <FolderOpen class="w-3.5 h-3.5" />
                <span>更改</span>
              </button>
            </div>

            <!-- 自动同步（R-S4）：开关关掉时必须把后果写在下面，不能只有一句功能描述 -->
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <RefreshCw class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动同步</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">
                    监听笔记目录，外部改动时自动刷新
                  </div>
                  <p
                    class="settings-hint"
                    data-testid="auto-sync-hint"
                    :data-state="appStore.autoSync ? 'on' : 'off'"
                    :style="{ color: appStore.autoSync ? 'var(--color-text-tertiary)' : 'var(--state-warning)' }"
                  >{{ autoSyncHint }}</p>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                aria-label="自动同步"
                :aria-checked="appStore.autoSync"
                @click="appStore.toggleAutoSync()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Paperclip class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">笔记文件格式</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">
                    载入时识别 {{ appStore.NOTE_EXTENSIONS.map(e => '.' + e).join(' / ') }}
                  </div>
                </div>
              </div>
              <div class="inline-flex items-center px-3 py-1.5 rounded-lg font-mono text-[13px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
                {{ appStore.NOTE_EXTENSIONS.length }} 种
              </div>
            </div>
          </div>
        </div>

        <SettingsShortcuts />

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-4 px-1">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <RefreshCw class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">软件更新</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Zap class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动检查更新</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">启动时自动检测新版本</div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
                aria-label="自动检查更新"
                :aria-checked="appStore.autoCheckUpdates"
                @click="appStore.toggleAutoCheckUpdates()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <FileText class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">当前版本</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">v{{ currentVersion }}</div>
                </div>
              </div>
              <button 
                class="px-4 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
                :style="{ 
                  background: updateStatus === 'checking' ? 'var(--color-bg-tertiary)' : 'var(--color-primary-surface)', 
                  color: 'var(--color-primary)'
                }"
                :disabled="updateStatus === 'checking' || updateStatus === 'downloading'"
                @click="checkForUpdates"
              >
                <span v-if="updateStatus === 'checking'">检查中...</span>
                <span v-else-if="updateStatus === 'available'">立即更新</span>
                <span v-else-if="updateStatus === 'downloading'">下载中 {{ downloadProgress }}%</span>
                <span v-else-if="updateStatus === 'ready'">重启安装</span>
                <span v-else>检查更新</span>
              </button>
            </div>

            <div v-if="updateInfo" class="px-5 py-4 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
              <div class="text-[13px] font-medium mb-2" :style="{ color: 'var(--color-text-primary)' }">
                更新内容 v{{ updateInfo.version }}
              </div>
              <div 
                class="text-[12px] leading-relaxed update-release-notes" 
                :style="{ color: 'var(--color-text-secondary)' }"
                v-html="updateInfo.releaseNotes || '暂无更新说明'"
              ></div>
            </div>
          </div>
        </div>

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-4 px-1">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <MessageCircle class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">反馈与帮助</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <Github class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">提交反馈 / 功能建议</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">在 GitHub 上提交 Issue</div>
                </div>
              </div>
              <button 
                class="px-4 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
                :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
                @click="openFeedback"
              >
                前往
              </button>
            </div>
          </div>
        </div>

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-4 px-1">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'rgba(255,112,67,0.1)' }">
              <RotateCcw class="w-4 h-4" :style="{ color: 'var(--state-warning)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">高级</h2>
          </div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="flex items-center gap-3">
                <AlertTriangle class="w-4 h-4" :style="{ color: 'var(--state-warning)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">重置应用</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">清除所有配置并返回欢迎页</div>
                </div>
              </div>
              <button 
                class="px-4 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
                :style="{ background: 'rgba(255,112,67,0.1)', color: 'var(--state-warning)' }"
                @click="resetApp"
              >
                重置
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">Choyeon Notes</span>
      <span class="cho-statusbar-meta">v{{ currentVersion }}</span>
    </div>
  </div>

  <Teleport to="body">
    <Transition name="fade">
      <div 
        v-if="showResetConfirm" 
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="cancelReset"
      >
        <div 
          class="w-[440px] rounded-2xl overflow-hidden shadow-2xl"
          :style="{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }"
        >
          <div class="px-6 py-5 text-center">
            <div 
              class="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
              :style="{ background: 'rgba(255,112,67,0.1)' }"
            >
              <AlertTriangle class="w-7 h-7" :style="{ color: 'var(--state-warning)' }" />
            </div>
            <h3 class="text-[17px] font-semibold mb-2" :style="{ color: 'var(--color-text-primary)' }">确认重置应用？</h3>
            <p class="text-[13px] leading-relaxed" :style="{ color: 'var(--color-text-secondary)' }">
              重置将清除所有配置并返回欢迎页面。<br/>笔记文件不会被删除，但应用将不再管理它们。
            </p>
          </div>
          <div 
            class="px-5 py-4 flex items-center gap-3 border-t"
            :style="{ borderColor: 'var(--color-border)' }"
          >
            <button 
              class="flex-1 py-2.5 rounded-xl text-[13px] font-medium cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-[0.98]"
              :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }"
              @click="cancelReset"
            >
              取消
            </button>
            <button 
              class="flex-1 py-2.5 rounded-xl text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-[0.98]"
              :style="{ background: 'var(--state-warning)', color: '#fff' }"
              @click="confirmReset"
            >
              确认重置
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useNoteStore } from '@/stores/note'
import { useWorkspaceStore } from '@/stores/workspace'
import { fetchBingWallpaper } from '@/utils/bingWallpaper'
// 代码高亮主题的下拉选项必须来自 markdown 的 codeThemes 注册表：手抄一份等于
// 承认它可以漂移，而漂移的结果就是「设置里有、引擎里没有」。
import { codeThemes } from '@/utils/markdown'
// 「字典」与「快捷键」两块各自成组件，模板/样式/交互与拆出去之前完全一致
import SettingsDictionary from '@/views/settings/SettingsDictionary.vue'
import SettingsShortcuts from '@/views/settings/SettingsShortcuts.vue'
import { 
  ArrowLeft, SunMoon, Palette, Type, Layers, 
  FileCode, SpellCheck, Save, ListOrdered, WrapText,
  FolderOpen, RefreshCw, Paperclip, Folder, AlertTriangle, RotateCcw,
  FileText, Edit, Zap,
  Image, MessageCircle, Github,
  ZoomIn, ZoomOut, Maximize2
} from 'lucide-vue-next'
import { createLogger } from '@/utils/logger'
import { LOG_MODULES } from '@/constants/logging'

const router = useRouter()
const appStore = useAppStore()
const noteStore = useNoteStore()
const workspaceStore = useWorkspaceStore()

/** 代码高亮主题：唯一来源是 @/utils/markdown 的 codeThemes 注册表 */
const codeThemeOptions = codeThemes

/**
 * 当前真正生效的笔记库路径。
 *
 * 取 `noteStore.notesPath`（内存里的真相）优先于 `appStore.notesLocation`
 * （localStorage 的镜像）：切目录失败、重置配置等场景下两者会短暂不一致，
 * 显示镜像会让用户以为「已经切过去了」。
 *
 * @returns {string} 当前库路径；未设置时返回空串
 */
const currentNotesLocation = computed(() => noteStore.notesPath || appStore.notesLocation || '')

// LOG_MODULES 里没有专门的「设置页」模块：这里两处失败都是应用外壳级诊断
// （取版本号、自动更新 IPC），归到 app 才能被「按模块过滤」正常捞出来。
// 刻意不自建 'settings' 之类的名字 —— 那会让模块名单漂移回各写各的。
const log = createLogger(LOG_MODULES.app)
const showResetConfirm = ref(false)
const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI)

// ===== Bing 每日壁纸 =====
const bingRefreshing = ref(false)
const bingTried = ref([])
const bingHasError = computed(() => !!appStore.bingWallpaperError)

const SOURCE_LABELS = { official: '官方接口', biturl: '公开镜像' }

const bingStatus = computed(() => {
  if (bingRefreshing.value) return '正在获取今日壁纸…'
  if (appStore.bingWallpaperError) return `获取失败：${appStore.bingWallpaperError}`
  if (!appStore.bingWallpaper) return '使用 Bing 每日壁纸作为背景'
  if (appStore.bingWallpaperUrl) {
    const date = appStore.bingWallpaperDate
    const pretty = date && date.length === 8
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : ''
    const title = appStore.bingWallpaperTitle ? `${appStore.bingWallpaperTitle}` : '今日壁纸已就绪'
    const source = appStore.bingWallpaperSource
      ? SOURCE_LABELS[appStore.bingWallpaperSource] || appStore.bingWallpaperSource
      : ''
    return [title, pretty, source].filter(Boolean).join(' · ')
  }
  return '尚未获取，点"刷新"立即拉取'
})

// 手动刷新时逐个源的失败原因，挂在 status 的 tooltip 上方便排障
const bingTriedText = computed(() => (bingTried.value || []).join('\n'))

/** 自动同步自我解释的固定文案：关闭分支必须用这一句把后果说出口（R-S4） */
const AUTO_SYNC_OFF_HINT = '关闭时，笔记在应用外被修改不会自动同步进来'

/**
 * 自动同步开关下方的自解释文案。
 *
 * 开着的开关却没能监听（没设笔记目录）是一件必须让用户知道的事 —— 否则用户会以为
 * 功能坏了；关掉之后「外部改动不会进来」更必须说出口，这是 R-S4 的硬要求：
 * 用户得知道自己刚刚关掉了什么。
 */
const autoSyncHint = computed(() => {
  if (!appStore.autoSync) return AUTO_SYNC_OFF_HINT
  return noteStore.notesPath
    ? '正在监听：笔记在应用外被修改时会自动同步进来'
    : '需先设置笔记存储位置才会开始监听'
})

async function refreshBingWallpaper() {
  if (bingRefreshing.value) return
  bingRefreshing.value = true
  try {
    const result = await fetchBingWallpaper()
    bingTried.value = result.tried || []
    appStore.setBingWallpaper(result)
  } finally {
    bingRefreshing.value = false
  }
}

const currentVersion = ref('1.0.0')
const updateStatus = ref('idle')
const updateInfo = ref(null)
const downloadProgress = ref(0)
let updaterUnsubscribe = null
/** 进页面 2 秒后自动检查更新；句柄留着是为了离开页面时能取消 */
let updateCheckTimer = null

async function checkForUpdates() {
  if (!isElectron.value) return
  
  if (updateStatus.value === 'ready') {
    window.electronAPI.quitAndInstall()
    return
  }
  
  if (updateStatus.value === 'available') {
    updateStatus.value = 'downloading'
    downloadProgress.value = 0
    await window.electronAPI.downloadUpdate()
    return
  }
  
  updateStatus.value = 'checking'
  await window.electronAPI.checkForUpdates()
}

function openFeedback() {
  window.open('https://github.com/Choyeon/choyeon-note/issues/new/choose', '_blank')
}

function setupUpdaterListeners() {
  if (!isElectron.value) return
  
  updaterUnsubscribe = window.electronAPI.onUpdaterEvent((event, data) => {
    switch (event) {
      case 'updater:checking':
        updateStatus.value = 'checking'
        break
      case 'updater:update-available':
        updateStatus.value = 'available'
        updateInfo.value = data
        break
      case 'updater:update-not-available':
        updateStatus.value = 'idle'
        break
      case 'updater:error':
        updateStatus.value = 'idle'
        // data 是主进程透传的失败载荷（可能是对象也可能是字符串），作为结构化上下文
        // 进 data 而不是拼进 msg：拼串既丢字段又会绕不过走去 excerpt 截断。
        log.error('自动更新失败', { detail: data })
        break
      case 'updater:download-progress':
        updateStatus.value = 'downloading'
        downloadProgress.value = Math.round(data.percent || 0)
        break
      case 'updater:update-downloaded':
        updateStatus.value = 'ready'
        updateInfo.value = data
        break
    }
  })
}

onMounted(async () => {
  if (isElectron.value) {
    try {
      const version = await window.electronAPI.getVersion()
      currentVersion.value = version
      appStore.setAppVersion(version)
    } catch (e) {
      // e 可能是 IPC 抛出的 Error：logger 会拆成 message + data.err，保留 stack
      log.error('获取版本号失败', e)
    }
    setupUpdaterListeners()
    
    if (appStore.autoCheckUpdates) {
      // 2 秒内已经离开设置页的话必须取消：否则会白跑一次网络请求并改写 updateStatus
      updateCheckTimer = setTimeout(() => {
        updateCheckTimer = null
        checkForUpdates()
      }, 2000)
    }
  }
})

onUnmounted(() => {
  if (updaterUnsubscribe) {
    updaterUnsubscribe()
  }
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer)
    updateCheckTimer = null
  }
  // 快捷键录制由 SettingsShortcuts 自己收尾（它卸载时会摘掉全局 keydown 监听）
})

/**
 * 更改笔记存储位置。
 *
 * 顺序不能改回「先落盘再载入」：`loadNotesFromPath` 失败会把笔记库清空 +
 * 把 notesPath 指向那个读不出来的目录，此时若索引位置已经写进 localStorage，
 * 下一次启动会被路由守卫直接送进一个空库 —— 用户看到的是「我的笔记没了」。
 * 所以只有 `ok === true` 才持久化并跳转；失败则原地不动 + toast 说清原因。
 *
 * @returns {Promise<void>}
 */
async function changeNotesLocation() {
  if (!window.electronAPI?.selectNotesPath) {
    // 这一整节本来就有 v-if="isElectron" 兜着，走到这里说明 API 缺了一半 ——
    // 用 toast 而不是 alert：alert 会冻住整个渲染进程，且拿不到统一出口的日志。
    appStore.pushToast({
      type: 'error',
      message: '当前环境不支持选择笔记目录'
    })
    return
  }

  const previousPath = noteStore.notesPath || ''
  const path = await window.electronAPI.selectNotesPath()
  if (!path) return

  const result = await noteStore.loadNotesFromPath(path)
  if (!result?.ok) {
    if (result?.stale) return
    appStore.pushToast({
      type: 'error',
      message: `切换笔记目录失败：${result?.error || '无法读取该目录'}，已保留原目录`
    })
    // loadNotesFromPath 已经在开头把 notesPath 指向了失败的那个目录，
    // 这里必须拨回去，否则「笔记存储位置」会显示一个读不出来的路径
    if (previousPath && previousPath !== path) {
      try {
        await noteStore.loadNotesFromPath(previousPath)
      } catch {
        /* 回滚也失败时保持现状：用户至少还能看到 toast 与错误原因 */
      }
    }
    return
  }

  appStore.saveNotesLocation(path)
  router.push('/notes')
}

function resetApp() {
  showResetConfirm.value = true
}

async function confirmReset() {
  appStore.resetConfig()
  noteStore.resetConfig()
  // 工作空间是独立持久化层（userData/workspaces.json），必须一起清
  try { await workspaceStore.reset() } catch (e) { /* 重置失败不阻断跳转 */ }
  showResetConfirm.value = false
  router.push('/')
}

function cancelReset() {
  showResetConfirm.value = false
}
</script>

<style scoped>
/* 设置卡片 - 在全局基础上添加过渡动画，统一使用全局圆角与阴影 */
.settings-card {
  transition: box-shadow var(--transition-smooth);
}

/* 设置行 - 添加悬停过渡 */
.settings-row {
  transition: background-color var(--transition-micro);
}

/* 开关下方的自解释行（R-S4）：比描述再小半号，靠 data-state 区分普通/警示。
   关掉的开关必须把后果写出来，只改字号不换行 —— 换行会把卡片撑得参差不齐。 */
.settings-hint {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
}

.spin {
  animation: settings-spin 1s linear infinite;
}
@keyframes settings-spin {
  to { transform: rotate(360deg); }
}

/* 缩放滑块：轨道用主色填充到当前值，跨浏览器统一外观 */
.zoom-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 132px;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--color-primary) 0%,
    var(--color-primary) calc((var(--zoom-pct, 100) - 50) / 150 * 100%),
    var(--color-border) calc((var(--zoom-pct, 100) - 50) / 150 * 100%),
    var(--color-border) 100%
  );
  outline: none;
  cursor: pointer;
}
.zoom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--color-primary);
  box-shadow: var(--shadow-xs);
  cursor: pointer;
}
.zoom-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--color-primary);
  cursor: pointer;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
