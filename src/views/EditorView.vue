<template>
  <div class="h-full flex flex-col overflow-hidden editor-page-wrapper">
    <!-- ================= 顶栏：面包屑 + 模式切换 ================= -->
    <div
      class="flex flex-col border-b z-10 relative shrink-0"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <div class="min-h-11 px-6 py-2 flex items-center gap-3">
        <button
          v-if="currentNote"
          class="w-8 h-8 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          @click="$router.push('/notes')"
        >
          <ArrowLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <span class="text-[13px] whitespace-nowrap" :style="{ color: 'var(--color-text-tertiary)' }">
          {{ currentNote?.folder || '根目录' }} <span class="mx-1">&gt;</span> {{ currentNote?.title || '无标题' }}
        </span>
        <div class="flex-1"></div>

        <div class="segmented-control">
          <button
            class="segment-btn"
            :class="{ active: editorMode === 'edit' }"
            title="源码编辑模式"
            @click="setMode('edit')"
          >
            <Pencil class="w-[18px] h-[18px]" />
          </button>
          <button
            class="segment-btn"
            :class="{ active: editorMode === 'live' }"
            title="实时预览模式（Obsidian 风格）"
            @click="setMode('live')"
          >
            <Zap class="w-[18px] h-[18px]" />
          </button>
          <button
            class="segment-btn"
            :class="{ active: editorMode === 'preview' }"
            title="阅读预览模式"
            @click="setMode('preview')"
          >
            <Eye class="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      <div class="px-6 pb-2 flex items-center gap-0.5 flex-wrap">
        <template v-for="tool in formatTools" :key="tool.id">
          <div
            v-if="tool.type === 'divider'"
            class="w-px h-5 mx-1"
            :style="{ background: 'var(--color-border)' }"
          ></div>
          <button
            v-else
            class="w-9 h-9 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :title="tool.title"
            @click="onToolbarAction(tool.id)"
          >
            <component :is="tool.icon" class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
        </template>

        <div class="w-px h-5 mx-1" :style="{ background: 'var(--color-border)' }"></div>
        <button
          class="w-9 h-9 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-35 disabled:cursor-default"
          title="撤销 (Ctrl+Z)"
          :disabled="!editorApi?.canUndo"
          @click="editorApi?.undo()"
        >
          <Undo2 class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <button
          class="w-9 h-9 rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-35 disabled:cursor-default"
          title="重做 (Ctrl+Y)"
          :disabled="!editorApi?.canRedo"
          @click="editorApi?.redo()"
        >
          <Redo2 class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
      </div>
    </div>

    <!-- ================= 主体：编辑 / 实时 / 预览 + 右栏 ================= -->
    <div class="flex-1 min-h-0 flex overflow-hidden">
      <!-- edit / live 共用同一个 CodeMirror 实例：
           live 只是把装饰层打开（Obsidian 方案），底层始终是同一份文档，
           因此「实时编辑」与「源码编辑」「预览」三模式看到的内容永远一致，
           撤销栈、光标位置、搜索、补全在模式切换间全部保留。 -->
      <div
        v-show="editorMode !== 'preview'"
        class="flex-1 min-w-0 flex flex-col overflow-hidden acrylic-content"
        @mousedown="onEditMouseDown"
      >
        <MarkdownEditor
          ref="mdEditorRef"
          v-model="content"
          class="flex-1 min-h-0"
          :read-only="false"
          :live-preview="editorMode === 'live'"
          :doc-key="currentNote?.id || ''"
          :placeholder="editorPlaceholder"
          :completion-context="completionContext"
          @change="onContentChange"
          @save="saveNote"
          @open-note="openNoteById"
          @spell-click="onSpellClick"
          @selection-change="onSelectionChange"
          @context-menu="onContextMenu"
        />
      </div>

      <!-- 预览模式：与 live 装饰层共用同一渲染规则（同一套 CSS 变量） -->
      <div
        v-if="editorMode === 'preview'"
        class="flex-1 min-w-0 overflow-y-auto cho-scrollbar acrylic-content"
        @click="onPreviewClick"
      >
        <div class="max-w-[780px] mx-auto py-10 px-8 pb-32">
          <div v-if="!content" class="text-center py-20" :style="{ color: 'var(--color-text-tertiary)' }">
            <FileText class="w-14 h-14 mx-auto mb-4 opacity-40" />
            <p class="text-base">这篇笔记还是空的</p>
            <p class="text-sm mt-2">切换到编辑或实时模式开始创作</p>
          </div>
          <div v-else ref="previewBodyRef" class="markdown-body notion-preview unified-editor" v-html="renderedContent"></div>
        </div>
      </div>

      <!-- ================= 右栏 ================= -->
      <aside
        class="w-[300px] min-w-[300px] h-full acrylic-sidebar flex flex-col overflow-hidden border-l"
        :style="{ borderColor: 'var(--sidebar-border)' }"
      >
        <div
          class="flex items-stretch h-10 min-h-10 border-b px-2 gap-1 overflow-x-auto cho-scrollbar"
          :style="{ borderColor: 'var(--color-border)' }"
        >
          <template v-for="tab in rightPanelTabs" :key="tab.key">
            <div
              class="flex items-center px-2 cursor-pointer border-b-2 transition-colors whitespace-nowrap shrink-0"
              :style="rightPanelTab === tab.key ? { borderColor: 'var(--color-primary)' } : { borderColor: 'transparent' }"
              @click="rightPanelTab = tab.key"
            >
              <component :is="tab.icon" class="w-3.5 h-3.5 mr-1" :style="{ color: rightPanelTab === tab.key ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" />
              <span class="text-[12px] font-medium" :style="{ color: rightPanelTab === tab.key ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }">{{ tab.label }}</span>
              <span
                v-if="tab.badge !== undefined && tab.badge > 0"
                class="ml-1 text-[10px] px-1.5 rounded-full"
                :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
              >{{ tab.badge }}</span>
            </div>
          </template>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar p-2" ref="rightPanelRef">
          <!-- ============= 大纲 ============= -->
          <div v-if="rightPanelTab === 'outline'" class="flex flex-col gap-0.5">
            <div
              v-for="(item, index) in outlineItems"
              :key="'o'+index"
              class="outline-item flex items-center h-7 px-2 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
              :class="{ 'outline-item-active': index === 0 }"
              :style="{ paddingLeft: `${8 + (item.level - 1) * 12}px` }"
              @click="scrollToHeading(item)"
            >
              <span
                class="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
                :style="{
                  fontWeight: item.level === 1 ? '600' : '500',
                  color: index === 0 ? 'var(--color-primary)' : 'var(--color-text-secondary)'
                }"
              >{{ item.text }}</span>
            </div>
            <div v-if="outlineItems.length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
              暂无大纲，使用 # 标题 生成
            </div>
          </div>

          <!-- ============= 反向链接 ============= -->
          <div v-else-if="rightPanelTab === 'backlinks'" class="flex flex-col gap-2">
            <div v-if="backlinksList.length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
              暂无反向链接，使用 [[笔记名]] 来建立引用
            </div>
            <template v-else>
              <div v-for="group in groupedBacklinks" :key="group.id" class="rounded-lg overflow-hidden" :style="{ border: '1px solid var(--color-border-light)' }">
                <div
                  class="flex items-center justify-between px-2.5 h-8 cursor-pointer transition-colors"
                  :style="{ background: 'var(--color-surface)' }"
                  @click="openNoteById(group.id)"
                  @mouseenter="($event.currentTarget.style.background='var(--color-surface-hover)')"
                  @mouseleave="($event.currentTarget.style.background='var(--color-surface)')"
                >
                  <div class="flex items-center min-w-0">
                    <FileText class="w-3.5 h-3.5 mr-2 shrink-0" :style="{ color: 'var(--color-text-secondary)' }" />
                    <span class="text-[13px] font-medium truncate" :style="{ color: 'var(--color-text-primary)' }">{{ group.title }}</span>
                  </div>
                  <ChevronRight class="w-3.5 h-3.5 shrink-0" :style="{ color: 'var(--color-text-tertiary)' }" />
                </div>
                <div
                  v-for="(m, idx) in group.matches"
                  :key="idx"
                  class="px-3 py-2 text-[12px] border-t cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
                  :style="{ borderColor: 'var(--color-border-light)', color: 'var(--color-text-secondary)' }"
                  @click="openNoteById(group.id)"
                >
                  <span v-html="highlightWikiContext(m.context || '')"></span>
                </div>
              </div>
            </template>
          </div>

          <!-- ============= 出站链接 ============= -->
          <div v-else-if="rightPanelTab === 'outgoing'" class="flex flex-col gap-2">
            <div v-if="outgoingList.length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
              暂无出站链接
            </div>
            <template v-else>
              <div class="rounded-lg px-2.5 py-1.5 mb-1" :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border-light)' }">
                <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">已解析 {{ outgoingList.length }} 个链接 · {{ unresolvedOutgoing.length }} 个未找到</span>
              </div>
              <div
                v-for="(link, idx) in outgoingList"
                :key="'out'+idx"
                class="flex items-center justify-between px-2.5 h-9 rounded-lg cursor-pointer transition-colors"
                :class="{ 'opacity-70': !link.resolvedId }"
                :style="{ border: '1px solid var(--color-border-light)' }"
                @click="openOutgoingLink(link)"
                @mouseenter="($event.currentTarget.style.background='var(--color-surface-hover)')"
                @mouseleave="($event.currentTarget.style.background='transparent')"
              >
                <div class="flex items-center min-w-0 flex-1">
                  <component
                    :is="link.embed ? ImageIcon : ExternalLink"
                    class="w-3.5 h-3.5 mr-2 shrink-0"
                    :style="{ color: link.resolvedId ? 'var(--color-primary)' : 'var(--state-warning)' }"
                  />
                  <div class="min-w-0">
                    <div class="text-[13px] font-medium truncate" :style="{ color: 'var(--color-text-primary)' }">
                      {{ link.alias || link.displayTitle || link.target }}
                    </div>
                    <div class="text-[11px] truncate" :style="{ color: 'var(--color-text-tertiary)' }">
                      {{ link.resolvedId ? (link.targetFolder || '根目录') : '未创建 · 点击可新建' }}
                    </div>
                  </div>
                </div>
                <span
                  v-if="link.embed"
                  class="text-[10px] px-1.5 rounded shrink-0 ml-2"
                  :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
                >嵌入</span>
              </div>
            </template>
          </div>

          <!-- ============= 属性/Frontmatter ============= -->
          <div v-else-if="rightPanelTab === 'properties'" class="flex flex-col gap-1.5 px-0.5">
            <div class="flex items-center justify-between px-2 py-1.5">
              <span class="text-[11px] font-medium tracking-wide uppercase" :style="{ color: 'var(--color-text-tertiary)' }">属性 Frontmatter</span>
              <button
                class="text-[11px] px-2 py-0.5 rounded-md transition-colors"
                :style="{ color: 'var(--color-primary)' }"
                @click="ensureFrontmatter"
              >+ 添加</button>
            </div>
            <div v-if="Object.keys(frontmatter).length === 0" class="text-[13px] px-2 py-4 text-center" :style="{ color: 'var(--color-text-tertiary)' }">
              还没有设置属性，点击右上「添加」或直接在文档顶部写 YAML。
            </div>
            <template v-else>
              <div
                v-for="(value, key) in frontmatter"
                :key="key"
                class="flex flex-col rounded-lg px-2.5 py-1.5 transition-colors"
                :style="{ border: '1px solid var(--color-border-light)' }"
                @mouseenter="($event.currentTarget.style.background='var(--color-surface-hover)')"
                @mouseleave="($event.currentTarget.style.background='transparent')"
              >
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">{{ key }}</span>
                  <button
                    class="text-[11px] opacity-60 hover:opacity-100"
                    :style="{ color: 'var(--state-error)' }"
                    @click="removeProperty(key)"
                  >删除</button>
                </div>
                <input
                  v-if="!Array.isArray(value)"
                  type="text"
                  class="mt-0.5 text-[13px] bg-transparent outline-none"
                  :value="String(value ?? '')"
                  :style="{ color: 'var(--color-text-primary)' }"
                  @change="updateProperty(key, $event.target.value)"
                />
                <div v-else class="mt-0.5 flex flex-wrap gap-1.5">
                  <template v-for="(tag, i) in value" :key="i">
                    <span
                      class="inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full"
                      :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }"
                    >
                      {{ tag }}
                      <button
                        class="opacity-60 hover:opacity-100"
                        @click="removeArrayItem(key, i)"
                      >×</button>
                    </span>
                  </template>
                  <input
                    type="text"
                    placeholder="+ 新值"
                    class="text-[12px] bg-transparent outline-none w-16"
                    :style="{ color: 'var(--color-text-secondary)' }"
                    @keydown.enter.prevent="appendArrayItem(key, $event.target)"
                  />
                </div>
              </div>
              <div class="mt-2">
                <div class="text-[11px] px-2 mb-1" :style="{ color: 'var(--color-text-tertiary)' }">新建属性</div>
                <div class="flex items-center gap-1.5 px-2">
                  <input
                    v-model="newProp.key"
                    type="text"
                    placeholder="Key"
                    class="flex-1 text-[12px] px-2 py-1 rounded-md outline-none"
                    :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
                  />
                  <input
                    v-model="newProp.value"
                    type="text"
                    placeholder="Value"
                    class="flex-1 text-[12px] px-2 py-1 rounded-md outline-none"
                    :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-light)' }"
                  />
                  <button
                    class="text-[12px] px-2 py-1 rounded-md"
                    :style="{ background: 'var(--color-primary)', color: 'white' }"
                    @click="addNewProperty"
                  >+</button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </aside>
    </div>

    <!-- ================= 状态栏 ================= -->
    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        {{ editorApi?.stats?.words ?? 0 }} 字 &middot; {{ editorApi?.stats?.chars ?? 0 }} 字符 &middot; {{ editorApi?.stats?.lines ?? 0 }} 行
        &middot; Ln {{ editorApi?.cursorLine ?? 1 }}, Col {{ editorApi?.cursorColumn ?? 1 }}
        &middot; 最后编辑: {{ formatDate(currentNote?.updatedAt) }}
      </span>
      <span class="cho-statusbar-meta">
        {{ modeLabel }}
      </span>
    </div>

    <!-- ================= 拼写检查菜单（点击红波浪线触发） ================= -->
    <SpellMenu
      :show="spellMenu.show"
      :rect="spellMenu.rect"
      :word="spellMenu.word"
      :suggestions="spellMenu.suggestions"
      :occurrences="spellMenu.occurrences"
      @close="spellMenu.show = false"
      @replace="(w) => replaceSpellWord(w)"
      @replace-all="(w) => replaceSpellWordAll(w)"
      @ignore="(w) => ignoreSpellWord(w)"
      @add-dictionary="(w) => addSpellWordToDictionary(w)"
      @copy="(w) => copyText(w)"
    />

    <!-- ================= 浮动选区工具栏 ================= -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="floatingToolbar.show"
          class="fixed z-50"
          :style="{
            left: floatingToolbar.x + 'px',
            top: floatingToolbar.y + 'px',
            transform: floatingToolbar.placement === 'top'
              ? 'translate(-50%, -100%)'
              : 'translate(-50%, 0)'
          }"
          @mousedown.prevent
        >
          <div
            class="floating-toolbar flex items-center gap-0.5 rounded-lg overflow-hidden shadow-lg"
            :style="{
              background: 'var(--card-bg)',
              border: '1px solid var(--card-border)',
              padding: '4px'
            }"
          >
            <button class="ft-btn" title="加粗" @mousedown.prevent="editorApi?.applyCommand('format.bold')">
              <Bold class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="斜体" @mousedown.prevent="editorApi?.applyCommand('format.italic')">
              <Italic class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="删除线" @mousedown.prevent="editorApi?.applyCommand('format.strikethrough')">
              <Strikethrough class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="行内代码" @mousedown.prevent="editorApi?.applyCommand('format.code')">
              <Code class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="高亮" @mousedown.prevent="editorApi?.applyCommand('format.highlight')">
              <Highlighter class="w-3.5 h-3.5" />
            </button>
            <button class="ft-btn" title="链接" @mousedown.prevent="editorApi?.applyCommand('format.link')">
              <Link class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- ================= 右键菜单 ================= -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="contextMenu.show"
          class="fixed inset-0 z-50"
          @click="closeContextMenu"
          @contextmenu.prevent="closeContextMenu"
        >
          <div
            class="context-menu absolute rounded-lg overflow-hidden shadow-lg"
            :style="{
              left: contextMenu.x + 'px',
              top: contextMenu.y + 'px',
              background: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              minWidth: '240px',
              padding: '6px',
              backdropFilter: 'none',
              zIndex: 9999
            }"
            @click.stop
          >
            <template v-if="contextMenu.hasSelection">
              <div class="context-menu-label">格式化</div>
              <button class="context-menu-item" @click="contextMenuAction('format.bold')">
                <Bold class="w-3.5 h-3.5" />
                <span>粗体</span>
                <span class="context-menu-shortcut">{{ shortcutHint('format.bold') }}</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.italic')">
                <Italic class="w-3.5 h-3.5" />
                <span>斜体</span>
                <span class="context-menu-shortcut">{{ shortcutHint('format.italic') }}</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.code')">
                <Code class="w-3.5 h-3.5" />
                <span>行内代码</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.link')">
                <Link class="w-3.5 h-3.5" />
                <span>链接</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.highlight')">
                <Highlighter class="w-3.5 h-3.5" />
                <span>高亮</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.strikethrough')">
                <Strikethrough class="w-3.5 h-3.5" />
                <span>删除线</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="contextMenuAction('format.h1')">
                <Heading1 class="w-3.5 h-3.5" />
                <span>一级标题</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.h2')">
                <Heading2 class="w-3.5 h-3.5" />
                <span>二级标题</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.h3')">
                <Heading3 class="w-3.5 h-3.5" />
                <span>三级标题</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="contextMenuAction('format.quote')">
                <Quote class="w-3.5 h-3.5" />
                <span>引用</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.bulletList')">
                <List class="w-3.5 h-3.5" />
                <span>无序列表</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('format.taskList')">
                <CheckSquare class="w-3.5 h-3.5" />
                <span>待办事项</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="copySelection">
                <Copy class="w-3.5 h-3.5" />
                <span>复制</span>
                <span class="context-menu-shortcut">Ctrl+C</span>
              </button>
              <button class="context-menu-item" @click="cutSelection">
                <Scissors class="w-3.5 h-3.5" />
                <span>剪切</span>
                <span class="context-menu-shortcut">Ctrl+X</span>
              </button>
            </template>
            <template v-else>
              <button class="context-menu-item" @click="pasteFromClipboard">
                <ClipboardPaste class="w-3.5 h-3.5" />
                <span>粘贴</span>
                <span class="context-menu-shortcut">Ctrl+V</span>
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" @click="contextMenuAction('edit.selectAll')">
                <Check class="w-3.5 h-3.5" />
                <span>全选</span>
                <span class="context-menu-shortcut">Ctrl+A</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('edit.undo')">
                <Undo2 class="w-3.5 h-3.5" />
                <span>撤销</span>
                <span class="context-menu-shortcut">Ctrl+Z</span>
              </button>
              <button class="context-menu-item" @click="contextMenuAction('edit.redo')">
                <Redo2 class="w-3.5 h-3.5" />
                <span>重做</span>
                <span class="context-menu-shortcut">Ctrl+Y</span>
              </button>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { useAppStore } from '@/stores/app'
import { renderMarkdown, renderMermaidInContainer } from '@/utils/markdown'
import { suggestCorrections } from '@/utils/spellcheck'
import { formatBinding } from '@/constants/shortcuts'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import SpellMenu from '@/components/editor/SpellMenu.vue'
import {
  Bold, Italic, Code, Link, List, CheckSquare, ArrowLeft,
  Heading1, Heading2, Heading3, Quote, Minus, Highlighter,
  Strikethrough, Copy, Scissors, ClipboardPaste, Check,
  FileText, Eye, Pencil, Zap, ChevronRight, ExternalLink,
  ListTree, Link2, Settings2, Undo2, Redo2,
  Image as ImageIcon, Code2, GitBranch, PieChart, BarChart3
} from 'lucide-vue-next'
import { parseFrontmatter, extractOutline } from '@/composables/useLinks.js'

const route = useRoute()
const router = useRouter()
const noteStore = useNoteStore()
const appStore = useAppStore()

// =========================== 基础状态 ===========================
const editorMode = ref('edit') // edit | live | preview（edit/live 共用同一 CM 实例）
const rightPanelTab = ref('outline')
const newProp = ref({ key: '', value: '' })
const rightPanelRef = ref(null)
const content = ref('')
const mdEditorRef = ref(null)
const previewBodyRef = ref(null)

/** 模板直接读取的编辑器响应式 API（stats / canUndo / cursor 等） */
const editorApi = shallowRef(null)

const contextMenu = ref({ show: false, x: 0, y: 0, hasSelection: false })

const floatingToolbar = ref({ show: false, x: 0, y: 0, placement: 'top' })

const spellMenu = ref({
  show: false,
  rect: null,
  word: '',
  from: 0,
  to: 0,
  suggestions: [],
  occurrences: 1
})

// =========================== 工具栏定义 ===========================
const formatTools = [
  { id: 'format.h1', icon: Heading1, title: '一级标题' },
  { id: 'format.h2', icon: Heading2, title: '二级标题' },
  { id: 'format.h3', icon: Heading3, title: '三级标题' },
  { type: 'divider' },
  { id: 'format.bold', icon: Bold, title: '粗体' },
  { id: 'format.italic', icon: Italic, title: '斜体' },
  { id: 'format.code', icon: Code, title: '行内代码' },
  { type: 'divider' },
  { id: 'format.quote', icon: Quote, title: '引用' },
  { id: 'format.bulletList', icon: List, title: '无序列表' },
  { id: 'format.taskList', icon: CheckSquare, title: '待办列表' },
  { id: 'format.link', icon: Link, title: '链接' },
  { id: 'insert.divider', icon: Minus, title: '分隔线' },
  { type: 'divider' },
  { id: 'insert.codeBlock', icon: Code2, title: '代码块' },
  { id: 'insert.mermaid-flow', icon: GitBranch, title: '流程图' },
  { id: 'insert.mermaid-pie', icon: PieChart, title: '饼图' },
  { id: 'insert.mermaid-gantt', icon: BarChart3, title: '甘特图' }
]

const MERMAID_TEMPLATES = {
  'insert.mermaid-flow': '```mermaid\nflowchart TD\n    A[开始] --> B{判断}\n    B -->|是| C[处理]\n    B -->|否| D[结束]\n    C --> D\n```',
  'insert.mermaid-pie': '```mermaid\npie title 项目分布\n    "前端" : 40\n    "后端" : 30\n    "设计" : 20\n    "测试" : 10\n```',
  'insert.mermaid-gantt': '```mermaid\ngantt\n    title 项目计划\n    dateFormat YYYY-MM-DD\n    section 设计\n    需求分析 :a1, 2026-01-01, 7d\n    UI设计 :a2, after a1, 5d\n    section 开发\n    前端开发 :b1, after a2, 14d\n```'
}

function onToolbarAction(id) {
  if (MERMAID_TEMPLATES[id]) {
    mdEditorRef.value?.insertAtCursor(`\n${MERMAID_TEMPLATES[id]}\n`)
    return
  }
  mdEditorRef.value?.applyCommand(id)
}

function shortcutHint(id) {
  return formatBinding(appStore.getBinding(id))
}

// =========================== 笔记载入 / 内容同步 ===========================
const currentNote = computed(() => noteStore.currentNote)

const renderedContent = computed(() => renderMarkdown(content.value || ''))

const outlineItems = computed(() => {
  try { return extractOutline(content.value || '') } catch { return [] }
})

const editorPlaceholder = '开始书写你的想法...'

const modeLabel = computed(() => ({
  edit: '源码编辑模式',
  live: '实时预览模式',
  preview: '阅读模式'
}[editorMode.value] || ''))

function onContentChange(newContent) {
  const val = typeof newContent === 'string' ? newContent : content.value
  if (currentNote.value?.id) {
    noteStore.updateNoteContent(currentNote.value.id, val)
  }
}

function saveNote() {
  if (currentNote.value?.id) {
    noteStore.updateNoteContent(currentNote.value.id, content.value)
  }
}

function setMode(mode) {
  if (!['edit', 'live', 'preview'].includes(mode)) return
  editorMode.value = mode
  if (mode !== 'preview') {
    floatingToolbar.value.show = false
    nextTick(() => mdEditorRef.value?.focus())
  }
}

/** Mod-Shift-E：编辑（源码/实时） ↔ 预览 */
function toggleReadingMode() {
  setMode(editorMode.value === 'preview' ? (appStore.livePreview === false ? 'edit' : 'live') : 'preview')
}

// =========================== 编辑器 API 装配 ===========================
function onEditorReady() {
  const api = mdEditorRef.value
  if (!api) return
  // MarkdownEditor defineExpose 的响应式成员（stats/canUndo/cursorLine...）
  // 直接取 ref 对象本身，模板里即可实时读取
  editorApi.value = {
    get stats() { return api.stats },
    get canUndo() { return api.canUndo },
    get canRedo() { return api.canRedo },
    get cursorLine() { return api.cursorLine },
    get cursorColumn() { return api.cursorColumn },
    undo: () => api.undo(),
    redo: () => api.redo(),
    applyCommand: (id) => api.applyCommand(id)
  }
}

// =========================== 补全上下文 ===========================
const completionContext = computed(() => {
  const notes = (noteStore.notes || []).map(n => ({
    id: n.id,
    title: n.title,
    folder: n.folder,
    content: n.content
  }))
  return {
    notes,
    tags: noteStore.allTags || [],
    currentNoteId: currentNote.value?.id || null,
    outline: outlineItems.value,
    onCreateNote: (target) => {
      const folder = currentNote.value?.folder || ''
      return noteStore.createNoteFromWikiTarget?.(target, folder) || noteStore.createNote(folder, target)
    }
  }
})

// =========================== 右栏 Tabs ===========================
const rightPanelTabs = computed(() => [
  { key: 'outline', label: '大纲', icon: ListTree, badge: outlineItems.value.length || undefined },
  { key: 'backlinks', label: '反向链接', icon: Link2, badge: backlinksList.value.length || undefined },
  { key: 'outgoing', label: '出站链接', icon: ExternalLink, badge: outgoingList.value.length || undefined },
  { key: 'properties', label: '属性', icon: Settings2 }
])

// =========================== Frontmatter ===========================
const parsedFrontmatter = computed(() => parseFrontmatter(content.value || ''))
const frontmatter = computed(() => parsedFrontmatter.value.frontmatter || {})

function ensureFrontmatter() {
  const { body, hasFrontmatter } = parsedFrontmatter.value
  if (hasFrontmatter) return
  const preamble = '---\ntitle: ' + JSON.stringify(currentNote.value?.title || '无标题') + '\ntags: []\ndate: ' + new Date().toISOString().slice(0, 10) + '\n---\n\n'
  content.value = preamble + (body || content.value || '')
  onContentChange(content.value)
}

function updateProperty(key, value) {
  noteStore.updateNoteFrontmatter?.(currentNote.value?.id, { [key]: value })
}

function removeProperty(key) {
  noteStore.updateNoteFrontmatter?.(currentNote.value?.id, { [key]: undefined })
}

function addNewProperty() {
  const k = newProp.value.key?.trim()
  if (!k) return
  let v = newProp.value.value
  if (k === 'tags' || k === 'tag' || k === 'categories' || k === 'category') {
    v = v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []
  }
  noteStore.updateNoteFrontmatter?.(currentNote.value?.id, { [k]: v })
  newProp.value = { key: '', value: '' }
}

function appendArrayItem(key, inputEl) {
  const v = (inputEl.value || '').trim()
  if (!v) return
  const arr = Array.isArray(frontmatter.value[key]) ? [...frontmatter.value[key]] : []
  if (!arr.includes(v)) arr.push(v)
  noteStore.updateNoteFrontmatter?.(currentNote.value?.id, { [key]: arr })
  inputEl.value = ''
}

function removeArrayItem(key, index) {
  const arr = Array.isArray(frontmatter.value[key]) ? [...frontmatter.value[key]] : []
  arr.splice(index, 1)
  noteStore.updateNoteFrontmatter?.(currentNote.value?.id, { [key]: arr })
}

// =========================== 反向 / 出站链接 ===========================
const backlinksList = computed(() => {
  const id = currentNote.value?.id
  if (!id) return []
  try { return noteStore.getBacklinks?.(id) || [] } catch { return [] }
})

const groupedBacklinks = computed(() => {
  const map = new Map()
  for (const b of backlinksList.value) {
    const key = b.fromId || b.raw || ''
    if (!map.has(key)) {
      map.set(key, { id: b.fromId, title: b.fromTitle || '(未知笔记)', matches: [] })
    }
    map.get(key).matches.push({ context: b.context || b.raw, alias: b.alias })
  }
  return Array.from(map.values())
})

const outgoingList = computed(() => {
  const id = currentNote.value?.id
  if (!id) return []
  let raw = []
  try { raw = noteStore.getOutgoing?.(id) || [] } catch { raw = [] }
  const notesMap = new Map((noteStore.notes || []).map(n => [n.id, n]))
  return raw.map(link => {
    const resolvedNote = link.resolvedId ? notesMap.get(link.resolvedId) : null
    return {
      ...link,
      displayTitle: resolvedNote?.title || link.target,
      targetFolder: resolvedNote?.folder || ''
    }
  })
})

const unresolvedOutgoing = computed(() => outgoingList.value.filter(l => !l.resolvedId))

function highlightWikiContext(text) {
  if (!text) return ''
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/(!?\[\[[^\[\]]*?\]\])/g, '<span style="color:var(--color-primary);font-weight:500;">$1</span>')
}

function openNoteById(id) {
  if (!id) return
  noteStore.selectNote(id)
  router.replace(`/editor/${id}`)
}

function openOutgoingLink(link) {
  if (!link) return
  if (link.resolvedId) {
    openNoteById(link.resolvedId)
    if (link.hash) {
      nextTick(() => scrollToHeadingAnyMode(link.hash))
    }
    return
  }
  const folder = currentNote.value?.folder || ''
  const created = noteStore.createNoteFromWikiTarget?.(link.target, folder) || noteStore.createNote(folder, link.target)
  if (created?.id) openNoteById(created.id)
}

// =========================== 预览区 wikilink 点击 ===========================
function onPreviewClick(e) {
  if (!e) return
  const a = e.target?.closest?.('a.wikilink, a[data-wiki-target]')
  if (!a) {
    const embedCard = e.target?.closest?.('.embed-card, .wikilink-embed')
    if (!embedCard) return
    const target = embedCard.getAttribute('data-wiki-target') || embedCard.getAttribute('data-note-id')
    if (!target) return
    handleGenericWikilinkClick({ target, id: embedCard.getAttribute('data-note-id') || null, hash: embedCard.getAttribute('data-wiki-hash') || '' })
    e.preventDefault()
    e.stopPropagation()
    return
  }
  e.preventDefault()
  e.stopPropagation()
  const id = a.getAttribute('data-note-id') || null
  const target = a.getAttribute('data-wiki-target') || ''
  const hash = a.getAttribute('data-wiki-hash') || ''
  handleGenericWikilinkClick({ target, id, hash })
}

function handleGenericWikilinkClick({ target, id, hash }) {
  if (!target && hash) {
    scrollToHeadingAnyMode(hash)
    return
  }
  if (id) {
    openNoteById(id)
    if (hash) setTimeout(() => scrollToHeadingAnyMode(hash), 80)
    return
  }
  if (target) {
    const exact = (noteStore.notes || []).find(n => n.title === target)
    if (exact) {
      openNoteById(exact.id)
      if (hash) setTimeout(() => scrollToHeadingAnyMode(hash), 80)
      return
    }
    const fuzzy = (noteStore.notes || []).find(n => n.title.toLowerCase().includes(target.toLowerCase()))
    if (fuzzy) {
      openNoteById(fuzzy.id)
      if (hash) setTimeout(() => scrollToHeadingAnyMode(hash), 80)
      return
    }
    const created = noteStore.createNoteFromWikiTarget?.(target, currentNote.value?.folder || '') || noteStore.createNote(currentNote.value?.folder || '', target)
    if (created?.id) openNoteById(created.id)
  }
}

// =========================== 滚动 / 定位 ===========================
function scrollToHeadingAnyMode(text) {
  if (editorMode.value === 'preview' && previewBodyRef.value) {
    const els = previewBodyRef.value.querySelectorAll('h1, h2, h3, h4, h5, h6')
    const needle = String(text).trim().toLowerCase()
    for (const el of els) {
      if (el.textContent.trim().toLowerCase() === needle) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
    for (const el of els) {
      if (el.textContent.includes(text)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
    return
  }
  mdEditorRef.value?.scrollToHeadingText(text)
}

function scrollToHeading(item) {
  if (!item?.text) return
  if (editorMode.value === 'preview') {
    scrollToHeadingAnyMode(item.text)
    return
  }
  // 大纲条目按标题文本定位（与 wikilink 锚点一致的匹配规则）
  mdEditorRef.value?.scrollToHeadingText(item.text)
}

// =========================== 拼写检查菜单 ===========================
function onSpellClick(hit) {
  if (!hit) return
  const rect = mdEditorRef.value?.spellRect(hit) || null
  const suggestions = suggestCorrections(hit.word, appStore.customDictionary instanceof Set ? appStore.customDictionary : new Set(), 5)
  spellMenu.value = {
    show: true,
    rect,
    word: hit.word,
    from: hit.from,
    to: hit.to,
    suggestions,
    occurrences: countOccurrences(content.value, hit.word)
  }
}

function countOccurrences(text, word) {
  if (!word) return 0
  let count = 0
  let idx = text.indexOf(word)
  while (idx !== -1) {
    count++
    idx = text.indexOf(word, idx + word.length)
  }
  return count
}

function closeSpellMenu() {
  spellMenu.value.show = false
}

function replaceSpellWord(word) {
  const { from, to } = spellMenu.value
  if (typeof from === 'number' && typeof to === 'number' && to > from) {
    mdEditorRef.value?.replaceRange(from, to, word)
  }
  closeSpellMenu()
}

function replaceSpellWordAll(word) {
  const target = spellMenu.value.word
  if (!target) return
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  content.value = content.value.replace(new RegExp(escaped, 'g'), word)
  onContentChange(content.value)
  closeSpellMenu()
}

function ignoreSpellWord(word) {
  appStore.ignoreWord(word)
  closeSpellMenu()
}

function addSpellWordToDictionary(word) {
  appStore.addToDictionary(word)
  closeSpellMenu()
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''))
  } catch { /* 剪贴板不可用时静默失败 */ }
  closeSpellMenu()
}

// =========================== 浮动选区工具栏 ===========================
function onSelectionChange(info) {
  if (editorMode.value === 'preview') {
    floatingToolbar.value.show = false
    return
  }
  if (!info?.hasSelection || !info?.coords) {
    floatingToolbar.value.show = false
    return
  }
  const { coords } = info
  const width = 268
  const height = 40
  const margin = 8
  let x = (coords.left + coords.right) / 2
  x = Math.max(margin + width / 2, Math.min(window.innerWidth - margin - width / 2, x))
  const showBelow = coords.top < height + 60
  floatingToolbar.value = {
    show: true,
    x,
    y: showBelow ? coords.bottom + 10 : coords.top - 10,
    placement: showBelow ? 'bottom' : 'top'
  }
}

// =========================== 右键菜单 ===========================
function onContextMenu(event) {
  if (!event) return
  event.preventDefault()
  const hasSelection = !!mdEditorRef.value?.getSelection?.() && mdEditorRef.value.getSelection().from !== mdEditorRef.value.getSelection().to
  const estimatedWidth = 260
  const estimatedHeight = hasSelection ? 480 : 160
  let x = event.clientX
  let y = event.clientY
  if (x + estimatedWidth > window.innerWidth - 8) x = window.innerWidth - estimatedWidth - 8
  if (y + estimatedHeight > window.innerHeight - 8) {
    y = event.clientY - estimatedHeight
    if (y < 8) y = 8
  }
  floatingToolbar.value.show = false
  contextMenu.value = { show: true, x, y, hasSelection }
}

function closeContextMenu() {
  contextMenu.value.show = false
}

function contextMenuAction(commandId) {
  closeContextMenu()
  nextTick(() => {
    if (commandId === 'edit.selectAll') {
      mdEditorRef.value?.selectAll()
    } else {
      mdEditorRef.value?.applyCommand(commandId)
    }
  })
}

async function copySelection() {
  closeContextMenu()
  const sel = mdEditorRef.value?.getSelection?.()
  if (sel?.text) await copyText(sel.text)
}

async function cutSelection() {
  closeContextMenu()
  const sel = mdEditorRef.value?.getSelection?.()
  if (sel?.text) {
    await copyText(sel.text)
    mdEditorRef.value?.replaceRange(sel.from, sel.to, '')
  }
}

async function pasteFromClipboard() {
  closeContextMenu()
  try {
    const text = await navigator.clipboard.readText()
    if (text) mdEditorRef.value?.insertAtCursor(text)
  } catch { /* 剪贴板权限被拒时静默失败 */ }
}

// =========================== 编辑区鼠标 ===========================
function onEditMouseDown() {
  // 点击编辑区任意位置时收起浮动工具栏（spellMenu 自行管理关闭逻辑）
  if (floatingToolbar.value.show) floatingToolbar.value.show = false
}

// =========================== 生命周期 / 路由 ===========================
function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function loadFromRoute() {
  const routeId = route.params.id
  if (routeId) {
    noteStore.selectNote(routeId)
  } else if (noteStore.notes && noteStore.notes.length > 0) {
    const firstNote = noteStore.notes[0]
    if (firstNote && firstNote.id) {
      noteStore.selectNote(firstNote.id)
      router.replace(`/editor/${firstNote.id}`)
    }
  }
  if (currentNote.value) {
    content.value = currentNote.value.content
  }
}

watch(() => route.params.id, () => {
  loadFromRoute()
})

watch(currentNote, (note) => {
  if (note && typeof note.content === 'string') {
    content.value = note.content
  }
}, { deep: true })

// 预览模式下内容变化时重渲染 mermaid
watch([content, editorMode], async () => {
  if (editorMode.value === 'preview') {
    await nextTick()
    if (previewBodyRef.value) renderMermaidInContainer(previewBodyRef.value)
  }
})

/** 阅读模式快捷键（Mod-Shift-E）：从注册表读取，用户改键后立即生效 */
function onModeKeydown(e) {
  const readingKey = String(appStore.getBinding('view.readingMode') || '').toLowerCase()
  if (!readingKey) return
  const mod = e.ctrlKey || e.metaKey
  const k = (e.key || '').toLowerCase()
  // Mod-Shift-e → 匹配 readingKey
  const needShift = readingKey.includes('shift')
  const keyPart = readingKey.split('-').pop()
  if (mod && e.shiftKey === needShift && k === keyPart.toLowerCase()) {
    e.preventDefault()
    toggleReadingMode()
  }
}

onMounted(() => {
  loadFromRoute()
  nextTick(onEditorReady)
  window.addEventListener('keydown', onModeKeydown, true)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onModeKeydown, true)
})
</script>

<style scoped>
.editor-page-wrapper {
  position: relative;
}

.editor-page-wrapper::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--content-bg);
  backdrop-filter: blur(var(--content-blur)) saturate(var(--content-saturate));
  -webkit-backdrop-filter: blur(var(--content-blur)) saturate(var(--content-saturate));
  z-index: 0;
  pointer-events: none;
}

.outline-item-active {
  background: var(--color-primary-surface);
}

/* ===== 预览排版：与实时预览装饰层共用同一套变量（编辑/预览一致性） ===== */
.unified-editor,
.markdown-body {
  font-size: var(--font-size-body) !important;
  line-height: 1.72 !important;
  color: var(--color-text-primary) !important;
  font-family: var(--font-body) !important;
  word-break: break-word;
}

.markdown-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em !important;
  background: var(--color-bg-tertiary);
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--color-border-light);
  color: var(--state-error);
}

.markdown-body :deep(pre) {
  background: var(--color-bg-secondary);
  border-radius: 10px;
  border: 1px solid var(--color-border-light);
  padding: 14px 16px;
  margin: 10px 0;
  overflow-x: auto;
}

.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  border: none;
  color: var(--color-text-primary);
}

.markdown-body :deep(mark) {
  background: rgba(255, 213, 79, 0.4);
  color: inherit;
  padding: 1px 4px;
  border-radius: 4px;
}

.markdown-body :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s ease;
}
.markdown-body :deep(a:hover) {
  border-bottom-color: var(--color-primary);
}

.markdown-body :deep(blockquote) {
  padding: 4px 14px;
  border-left: 3px solid var(--color-text-tertiary);
  background: transparent;
  margin: 10px 0;
  color: var(--color-text-secondary);
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 22px 0;
}

.markdown-body :deep(input[type="checkbox"]) {
  margin-right: 8px;
  width: 16px;
  height: 16px;
  vertical-align: middle;
  accent-color: var(--color-primary);
}

/* ===== 浮动工具栏 ===== */
.ft-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  transition: background 0.15s ease;
}

.ft-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-primary);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.14s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
