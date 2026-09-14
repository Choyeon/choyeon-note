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
                :aria-checked="appStore.spellCheck"
                @click="appStore.toggleSpellCheck()"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>

            <!-- 拼写忽略词 + 自定义字典 管理 -->
            <div class="px-5 py-4 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
              <div class="flex items-center gap-2 mb-3">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center" :style="{ background: 'var(--state-error-lightest, rgba(239,68,68,0.1))' }">
                  <EyeOff class="w-4 h-4" :style="{ color: 'var(--state-error)' }" />
                </div>
                <div>
                  <div class="text-[14px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">忽略词列表</div>
                  <div class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">对"忽略此单词"的单词进行管理</div>
                </div>
                <div class="ml-auto flex items-center gap-2">
                  <div class="relative">
                    <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
                    <input
                      v-model="ignoredSearch"
                      type="text"
                      placeholder="搜索..."
                      class="h-8 pl-8 pr-3 rounded-lg text-[13px] outline-none transition-all duration-200"
                      :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', width: '150px', border: '1px solid var(--color-border-light)' }"
                    />
                  </div>
                  <button
                    class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95"
                    :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
                    @click="openAddIgnored"
                  >
                    <span class="inline-flex items-center gap-1"><Plus class="w-3.5 h-3.5"/>添加</span>
                  </button>
                  <button
                    v-if="ignoredWordsArray.length > 0"
                    class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
                    :style="{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--state-error)' }"
                    @click="appStore.clearIgnoredWords()"
                  >清空</button>
                </div>
              </div>
              <div 
                class="dict-grid-wrap rounded-lg"
                :style="{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-light)', minHeight: '120px', padding: '8px' }"
              >
                <div v-if="filteredIgnoredWords.length === 0" class="flex flex-col items-center justify-center py-6 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
                  <EyeOff class="w-6 h-6 opacity-40 mb-2" />
                  <p class="text-[13px]">暂无忽略词</p>
                </div>
                <div v-else class="dict-grid">
                  <div
                    v-for="w in filteredIgnoredWords"
                    :key="'ig-' + w"
                    class="dict-chip"
                  >
                    <span class="font-mono text-[13px] flex-1 min-w-0 truncate">{{ w }}</span>
                    <button
                      class="dict-chip-remove"
                      :title="`移除 ${w}`"
                      @click="appStore.unignoreWord(w)"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="px-5 py-4 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
              <div class="flex items-center gap-2 mb-3">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
                  <BookPlus class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
                </div>
                <div>
                  <div class="text-[14px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">自定义词典</div>
                  <div class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">添加到这里的单词会被判定为拼写正确</div>
                </div>
                <div class="ml-auto flex items-center gap-2">
                  <div class="relative">
                    <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
                    <input
                      v-model="dictionarySearch"
                      type="text"
                      placeholder="搜索..."
                      class="h-8 pl-8 pr-3 rounded-lg text-[13px] outline-none transition-all duration-200"
                      :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', width: '150px', border: '1px solid var(--color-border-light)' }"
                    />
                  </div>
                  <button
                    class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-95"
                    :style="{ background: 'var(--color-primary)', color: '#fff' }"
                    @click="openAddDictionary"
                  >
                    <span class="inline-flex items-center gap-1"><Plus class="w-3.5 h-3.5"/>添加</span>
                  </button>
                  <button
                    v-if="dictionaryArray.length > 0"
                    class="px-3 h-8 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 hover:opacity-80 active:scale-95"
                    :style="{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--state-error)' }"
                    @click="appStore.clearCustomDictionary()"
                  >清空</button>
                </div>
              </div>
              <div
                class="dict-grid-wrap rounded-lg"
                :style="{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-light)', minHeight: '120px', padding: '8px' }"
              >
                <div v-if="filteredDictionaryWords.length === 0" class="flex flex-col items-center justify-center py-6 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
                  <BookPlus class="w-6 h-6 opacity-40 mb-2" />
                  <p class="text-[13px]">自定义词典为空</p>
                </div>
                <div v-else class="dict-grid">
                  <div
                    v-for="w in filteredDictionaryWords"
                    :key="'dict-' + w"
                    class="dict-chip"
                    :style="{ background: 'var(--color-primary-surface, rgba(74,144,217,0.1))', borderColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)' }"
                  >
                    <span
                      class="font-mono text-[13px] flex-1 min-w-0 truncate"
                      :style="{ color: 'var(--color-primary)' }"
                    >{{ w }}</span>
                    <button
                      class="dict-chip-remove"
                      :title="`移除 ${w}`"
                      :style="{ color: 'var(--color-primary)' }"
                      @click="appStore.removeFromDictionary(w)"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 添加忽略词 模态框 -->
            <Teleport to="body">
              <Transition name="fade">
                <div
                  v-if="showAddIgnored"
                  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
                  @click.self="showAddIgnored = false"
                >
                  <div
                    class="w-[420px] rounded-2xl overflow-hidden shadow-2xl"
                    :style="{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }"
                  >
                    <div class="px-5 py-4 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
                      <h3 class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">添加忽略词</h3>
                      <p class="text-[12px] mt-1" :style="{ color: 'var(--color-text-tertiary)' }">支持一次性添加多个，使用空格或逗号分隔</p>
                    </div>
                    <div class="px-5 py-4">
                      <input
                        ref="ignoredInputRef"
                        v-model="ignoredInput"
                        type="text"
                        placeholder="例如：choyeon obsidian"
                        class="w-full h-10 px-3 rounded-lg text-[14px] outline-none transition-all duration-200"
                        :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
                        @keydown.enter="submitAddIgnored"
                      />
                    </div>
                    <div class="px-5 py-4 flex items-center justify-end gap-2 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
                      <button
                        class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:bg-[var(--color-surface-hover)]"
                        :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }"
                        @click="showAddIgnored = false"
                      >取消</button>
                      <button
                        class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:opacity-90 active:scale-95"
                        :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
                        @click="submitAddIgnored"
                      >确认添加</button>
                    </div>
                  </div>
                </div>
              </Transition>
            </Teleport>

            <!-- 添加自定义词典 模态框 -->
            <Teleport to="body">
              <Transition name="fade">
                <div
                  v-if="showAddDictionary"
                  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
                  @click.self="showAddDictionary = false"
                >
                  <div
                    class="w-[420px] rounded-2xl overflow-hidden shadow-2xl"
                    :style="{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }"
                  >
                    <div class="px-5 py-4 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
                      <h3 class="text-[15px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">添加自定义词典</h3>
                      <p class="text-[12px] mt-1" :style="{ color: 'var(--color-text-tertiary)' }">支持一次性添加多个，使用空格或逗号分隔</p>
                    </div>
                    <div class="px-5 py-4">
                      <input
                        ref="dictionaryInputRef"
                        v-model="dictionaryInput"
                        type="text"
                        placeholder="例如：Choyeon Electron Vue"
                        class="w-full h-10 px-3 rounded-lg text-[14px] outline-none transition-all duration-200"
                        :style="{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
                        @keydown.enter="submitAddDictionary"
                      />
                    </div>
                    <div class="px-5 py-4 flex items-center justify-end gap-2 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
                      <button
                        class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:bg-[var(--color-surface-hover)]"
                        :style="{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }"
                        @click="showAddDictionary = false"
                      >取消</button>
                      <button
                        class="px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-all hover:opacity-90 active:scale-95"
                        :style="{ background: 'var(--color-primary)', color: '#fff' }"
                        @click="submitAddDictionary"
                      >确认添加</button>
                    </div>
                  </div>
                </div>
              </Transition>
            </Teleport>

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
                <option value="github">GitHub</option>
                <option value="monokai">Monokai</option>
                <option value="dracula">Dracula</option>
                <option value="atom-one-dark">Atom One Dark</option>
                <option value="vs2015">VS 2015</option>
                <option value="gradient-dark">Gradient Dark</option>
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
                  <div class="text-[12px] mt-0.5 font-mono" :style="{ color: 'var(--color-text-tertiary)' }">{{ appStore.notesLocation || '未设置' }}</div>
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

            <div class="settings-row">
              <div class="flex items-center gap-3">
                <RefreshCw class="w-4 h-4" :style="{ color: 'var(--color-text-tertiary)' }" />
                <div>
                  <div class="text-[14px] font-medium" :style="{ color: 'var(--color-text-primary)' }">自动同步</div>
                  <div class="text-[12px] mt-0.5" :style="{ color: 'var(--color-text-tertiary)' }">
                    监听笔记目录，外部改动时自动刷新{{ autoSyncHint }}
                  </div>
                </div>
              </div>
              <button 
                class="toggle-switch"
                role="switch"
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

        <div class="mb-8">
          <div class="flex items-center gap-3 mb-4 px-1">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
              <Keyboard class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
            </div>
            <h2 class="text-[15px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">快捷键</h2>
            <button
              v-if="hasCustomHotkeys"
              class="ml-auto px-3 h-7 rounded-lg text-[12px] font-medium cursor-pointer transition-all duration-150 hover:opacity-80 active:scale-95"
              :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
              @click="resetAllShortcuts"
            >全部重置</button>
          </div>
          
          <div class="mb-3">
            <div class="relative">
              <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
              <input 
                v-model="shortcutSearch"
                type="text"
                placeholder="搜索快捷键（支持按键名，如 Ctrl）..."
                class="shortcut-search w-full h-10 pl-9 pr-4 rounded-lg text-[13px] outline-none transition-all duration-200"
                :style="{ 
                  background: 'var(--color-bg-secondary)', 
                  color: 'var(--color-text-primary)'
                }"
              />
            </div>
            <p
              v-if="recordError"
              class="mt-2 px-3 py-2 rounded-lg text-[12px]"
              :style="{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--state-error)' }"
            >{{ recordError }}</p>
          </div>

          <div 
            v-for="category in filteredShortcutCategories" 
            :key="category.id"
            class="settings-card mb-3"
          >
            <div class="px-5 py-3 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
              <div class="flex items-center gap-2">
                <component :is="category.icon" class="w-4 h-4" :style="{ color: 'var(--color-primary)' }" />
                <span class="text-[13px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">{{ category.label }}</span>
                <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">{{ category.items.length }}</span>
              </div>
            </div>
            <div class="divide-y" :style="{ borderColor: 'var(--color-border-light)' }">
              <div 
                v-for="item in category.items" 
                :key="item.id"
                class="flex items-center justify-between px-5 py-2.5 transition-colors"
                :class="appStore.shortcutRecordingId === item.id ? 'is-recording' : 'hover:bg-[var(--color-surface-hover)]'"
              >
                <div class="min-w-0 flex items-center gap-2">
                  <span class="text-[13px] truncate" :style="{ color: 'var(--color-text-primary)' }">{{ item.label }}</span>
                  <span
                    v-if="isCustomized(item)"
                    class="text-[11px] px-1.5 py-0.5 rounded shrink-0"
                    :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
                  >已自定义</span>
                </div>

                <div class="flex items-center gap-1.5 shrink-0">
                  <template v-if="appStore.shortcutRecordingId === item.id">
                    <span class="text-[12px] recording-hint" :style="{ color: 'var(--color-primary)' }">
                      按下新的组合键… Esc 取消 · Backspace 清除
                    </span>
                  </template>
                  <template v-else>
                    <span v-if="!currentBinding(item.id)" class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">未设置</span>
                    <span 
                      v-for="(key, idx) in bindingPartsOf(item.id)" 
                      :key="key + idx"
                      class="kbd-key"
                    >{{ key }}</span>
                    <button class="kbd-edit" :title="`修改「${item.label}」的快捷键`" @click="startRecording(item.id)">
                      <Pencil class="w-3.5 h-3.5" />
                    </button>
                    <button
                      v-if="isCustomized(item)"
                      class="kbd-edit"
                      :title="`恢复默认（${formatBinding(item.default)}）`"
                      @click="resetShortcut(item.id)"
                    >
                      <RotateCcw class="w-3.5 h-3.5" />
                    </button>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <div v-if="filteredShortcutCategories.length === 0" class="settings-card py-10 text-center">
            <Search class="w-8 h-8 mx-auto mb-2" :style="{ color: 'var(--color-text-tertiary)' }" />
            <p class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">未找到匹配的快捷键</p>
          </div>
        </div>

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
import {
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  bindingParts,
  formatBinding,
  eventToBinding
} from '@/constants/shortcuts'
import { 
  ArrowLeft, SunMoon, Palette, Type, Layers, 
  FileCode, SpellCheck, Save, ListOrdered, WrapText,
  FolderOpen, RefreshCw, Paperclip, Folder, AlertTriangle, RotateCcw,
  Keyboard, Search, FileText, Edit, Zap,
  Image, MessageCircle, Github, EyeOff, BookPlus, Plus, X,
  ZoomIn, ZoomOut, Maximize2, Pencil, PenLine, LayoutDashboard
} from 'lucide-vue-next'

/** SHORTCUT_CATEGORIES 里的 icon 是字符串，这里映射成真实组件 */
const CATEGORY_ICONS = {
  FolderOpen,
  PenLine,
  Type,
  LayoutDashboard,
  Plus
}

const router = useRouter()
const appStore = useAppStore()
const noteStore = useNoteStore()
const workspaceStore = useWorkspaceStore()
const showResetConfirm = ref(false)
const shortcutSearch = ref('')
const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI)

// ===== 拼写字典管理 =====
const ignoredSearch = ref('')
const dictionarySearch = ref('')
const showAddIgnored = ref(false)
const showAddDictionary = ref(false)
const ignoredInput = ref('')
const dictionaryInput = ref('')
const ignoredInputRef = ref(null)
const dictionaryInputRef = ref(null)

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

/** 自动同步的即时反馈：开着的开关却没目录监听，用户会以为功能坏了 */
const autoSyncHint = computed(() => {
  if (!appStore.autoSync) return ''
  return noteStore.notesPath ? '（正在监听）' : '（需先设置笔记存储位置）'
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

const ignoredWordsArray = computed(() => {
  return [...(appStore.ignoredWords || [])].sort((a, b) => a.localeCompare(b))
})
const dictionaryArray = computed(() => {
  return [...(appStore.customDictionary || [])].sort((a, b) => a.localeCompare(b))
})
const filteredIgnoredWords = computed(() => {
  const q = ignoredSearch.value.trim().toLowerCase()
  if (!q) return ignoredWordsArray.value
  return ignoredWordsArray.value.filter(w => w.includes(q))
})
const filteredDictionaryWords = computed(() => {
  const q = dictionarySearch.value.trim().toLowerCase()
  if (!q) return dictionaryArray.value
  return dictionaryArray.value.filter(w => w.includes(q))
})

function openAddIgnored() {
  ignoredInput.value = ''
  showAddIgnored.value = true
  setTimeout(() => ignoredInputRef.value?.focus(), 50)
}
function openAddDictionary() {
  dictionaryInput.value = ''
  showAddDictionary.value = true
  setTimeout(() => dictionaryInputRef.value?.focus(), 50)
}
function parseWords(str) {
  return String(str || '')
    .split(/[\s,，、;；]+/g)
    .map(w => w.trim().toLowerCase())
    .filter(Boolean)
}
function submitAddIgnored() {
  const words = parseWords(ignoredInput.value)
  words.forEach(w => appStore.ignoreWord(w))
  showAddIgnored.value = false
  ignoredInput.value = ''
}
function submitAddDictionary() {
  const words = parseWords(dictionaryInput.value)
  words.forEach(w => appStore.addToDictionary(w))
  showAddDictionary.value = false
  dictionaryInput.value = ''
}

const currentVersion = ref('1.0.0')
const updateStatus = ref('idle')
const updateInfo = ref(null)
const downloadProgress = ref(0)
let updaterUnsubscribe = null

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
        console.error('Update error:', data)
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
      console.error('Failed to get version:', e)
    }
    setupUpdaterListeners()
    
    if (appStore.autoCheckUpdates) {
      setTimeout(() => {
        checkForUpdates()
      }, 2000)
    }
  }
})

onUnmounted(() => {
  if (updaterUnsubscribe) {
    updaterUnsubscribe()
  }
  // 录制中途切走页面：摘掉监听，避免残留的全局 keydown 吞掉后续按键
  stopRecording()
})

// ===================== 快捷键 =====================
// 真实来源只有一份：constants/shortcuts.js 的 SHORTCUTS 注册表。
// 这里读什么、编辑器就绑什么、App.vue 也匹配什么，不会出现「设置页显示的按了没反应」。
function currentBinding(id) {
  return appStore.getBinding(id) || ''
}
function bindingPartsOf(id) {
  return bindingParts(currentBinding(id))
}
function isCustomized(item) {
  return currentBinding(item.id) !== item.default
}

const hasCustomHotkeys = computed(() =>
  SHORTCUTS.some(s => !s.hidden && currentBinding(s.id) !== s.default)
)

const recordError = ref('')

function startRecording(id) {
  recordError.value = ''
  appStore.shortcutRecordingId = id
  window.addEventListener('keydown', onRecordKeydown, true)
}

function stopRecording() {
  appStore.shortcutRecordingId = null
  window.removeEventListener('keydown', onRecordKeydown, true)
}

function onRecordKeydown(e) {
  // 录制期间吞掉所有按键：既不让浏览器/编辑器响应，也不让全局快捷键抢先执行
  e.preventDefault()
  e.stopPropagation()
  const id = appStore.shortcutRecordingId
  if (!id) {
    stopRecording()
    return
  }
  if (e.key === 'Escape') {
    stopRecording()
    return
  }
  // Backspace / Delete 表示"清空这个快捷键"，等价于禁用该命令
  if (e.key === 'Backspace' || e.key === 'Delete') {
    appStore.setHotkey(id, '')
    recordError.value = ''
    stopRecording()
    return
  }
  const binding = eventToBinding(e)
  if (!binding) return
  const result = appStore.setHotkey(id, binding)
  if (!result.ok) {
    recordError.value = result.reason === 'conflict'
      ? `与「${result.conflict.label}」冲突，请换一个组合键`
      : '设置失败，请重试'
    return
  }
  recordError.value = ''
  stopRecording()
}

function resetShortcut(id) {
  appStore.resetHotkey(id)
  recordError.value = ''
}

function resetAllShortcuts() {
  appStore.resetAllHotkeys()
  recordError.value = ''
}

const filteredShortcutCategories = computed(() => {
  const list = SHORTCUT_CATEGORIES.map(cat => ({
    id: cat.id,
    label: cat.label,
    icon: CATEGORY_ICONS[cat.icon] || Keyboard,
    items: SHORTCUTS.filter(s => s.category === cat.id && !s.hidden)
  })).filter(cat => cat.items.length > 0)

  const q = shortcutSearch.value.trim().toLowerCase()
  if (!q) return list

  return list.map(cat => ({
    ...cat,
    items: cat.items.filter(s =>
      s.label.toLowerCase().includes(q) ||
      bindingPartsOf(s.id).join(' ').toLowerCase().includes(q)
    )
  })).filter(cat => cat.items.length > 0)
})

async function changeNotesLocation() {
  if (!window.electronAPI) {
    alert('请在 Electron 环境中使用此功能')
    return
  }
  
  const path = await window.electronAPI.selectNotesPath()
  if (path) {
    appStore.saveNotesLocation(path)
    await noteStore.loadNotesFromPath(path)
    router.push('/notes')
  }
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

/* 搜索框 - 毛玻璃效果，聚焦时使用主色光环 */
.shortcut-search {
  border: 1px solid var(--color-border-light);
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
}
.shortcut-search:focus {
  background: var(--color-bg-tertiary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
  border-color: transparent;
}

/* 快捷键按键 - 毛玻璃表面效果，微妙层次感 */
.kbd-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  border: 1px solid var(--color-border-light);
}

/* 快捷键：修改 / 恢复默认 的小图标按钮 */
.kbd-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
}
.kbd-edit:hover {
  background: var(--color-surface-hover);
  color: var(--color-primary);
}

/* 录制中：整行高亮 + 提示文字呼吸，避免用户不知道在等什么 */
.is-recording {
  background: var(--color-primary-surface);
}
.recording-hint {
  animation: record-pulse 1.4s ease-in-out infinite;
}
@keyframes record-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ===== 拼写字典管理：词条网格 / chip ===== */
.dict-grid-wrap {
  overflow-y: auto;
  max-height: 220px;
}
.dict-grid-wrap::-webkit-scrollbar { width: 6px; }
.dict-grid-wrap::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 3px;
}

.dict-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.dict-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--color-surface);
  border: 1px solid var(--color-border-light);
  transition: all 0.15s ease;
  min-width: 0;
}
.dict-chip:hover {
  border-color: var(--color-border);
  background: var(--color-surface-hover);
}

.dict-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.dict-chip-remove:hover {
  background: rgba(239, 68, 68, 0.15);
  color: var(--state-error);
  transform: scale(1.1);
}
</style>
