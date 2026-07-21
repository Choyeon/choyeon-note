# Choyeon Note 全面深度优化 - Implementation Plan

## [x] Task 1: 修复 Tailwind CSS 变量配置
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 修复 tailwind.config.js 中的颜色变量名，使其与 style.css 中定义的 CSS 变量一致
  - 对齐所有主题色变量（background, foreground, primary, secondary, accent, muted, card, border 等）
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-1.1: Tailwind 配置中引用的所有 CSS 变量在 style.css 中都有定义
  - `human-judgement` TR-1.2: 使用 bg-background text-foreground 等类的元素样式正确显示
- **Notes**: 修改 tailwind.config.js
- **Status**: ✅ 已完成 - 修复了 tailwind.config.js 中所有变量名

## [x] Task 2: 修复拼写检查功能
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 修复 app store 中 isWordCorrect 函数逻辑错误
  - 实现正确的拼写检查逻辑（使用浏览器内置拼写检查或本地词典）
  - 确保 EditorView 中的拼写检查高亮正常工作
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `programmatic` TR-2.1: isWordCorrect 函数对正确单词返回 true，错误单词返回 false
  - `human-judgement` TR-2.2: 编辑器中错误单词显示红色下划线
- **Notes**: 修改 src/stores/app.js 和 src/views/EditorView.vue
- **Status**: ✅ 已完成 - 修复 isWordCorrect 函数，使用 isCommonEnglishWord 判断

## [x] Task 3: 加固 Electron 文件系统安全性
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 为所有文件 IPC handler 添加路径安全校验
  - 规范化路径并检查是否在 notesPath 目录范围内
  - 防止路径遍历攻击（../ 等）
  - 将 fs 同步 API 改为异步 API
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-3.1: 包含 ../ 的路径请求被拒绝
  - `programmatic` TR-3.2: 正常路径的文件读写正常工作
  - `programmatic` TR-3.3: 所有 fs 操作使用异步 API
- **Notes**: 修改 electron/main.js
- **Status**: ✅ 已完成 - 添加 validatePath 安全校验，全部使用 fs/promises 异步 API，notesPath 持久化到 userData

## [x] Task 4: 实现设置持久化
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 应用设置（主题、字体大小、毛玻璃、自动保存、拼写检查等）保存到 localStorage
  - 应用启动时从 localStorage 读取设置
  - notesPath 保存到 Electron userData 目录
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `programmatic` TR-4.1: 修改设置后 localStorage 中有对应键值
  - `human-judgement` TR-4.2: 刷新页面后设置保持不变
- **Notes**: 修改 src/stores/app.js, src/stores/note.js, electron/main.js
- **Status**: ✅ 已完成 - 所有设置均已持久化到 localStorage

## [x] Task 5: 完善系统主题支持
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - 添加 system 主题选项的完整支持
  - 监听 prefers-color-scheme 媒体查询变化
  - 统一暗色模式变量定义，消除重复
  - 修复 .electron-mode 选择器层级问题
- **Acceptance Criteria Addressed**: AC-6, AC-12
- **Test Requirements**:
  - `human-judgement` TR-5.1: 选择系统主题后，切换系统深浅色时应用跟随变化
  - `human-judgement` TR-5.2: 暗色模式下所有页面无白色方块，对比度足够
  - `programmatic` TR-5.3: CSS 变量命名统一，无多套命名混用
- **Notes**: 修改 src/style.css, src/stores/app.js, src/views/SettingsView.vue
- **Status**: ✅ 已完成 - 添加 systemTheme 状态和媒体查询监听，使用 effectiveTheme 计算属性

## [x] Task 6: 笔记保存防抖优化
- **Priority**: medium
- **Depends On**: None
- **Description**:
  - 在 note store 的 updateNoteContent 中添加防抖
  - 防抖延迟 500ms
  - 确保最后一次输入一定会被保存
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `programmatic` TR-6.1: 快速连续输入只触发一次保存
  - `human-judgement` TR-6.2: 停止输入后内容能正确保存
- **Notes**: 修改 src/stores/note.js
- **Status**: ✅ 已完成 - 添加 500ms 防抖，新增 flushSave 方法

## [x] Task 7: 修复侧边栏显示/隐藏功能
- **Priority**: medium
- **Depends On**: None
- **Description**:
  - 修复 Sidebar 组件 toggle-sidebar 事件不生效的问题
  - 侧边栏状态由 appStore.sidebar 控制
  - 添加平滑的展开/收起动画
- **Acceptance Criteria Addressed**: AC-8
- **Test Requirements**:
  - `human-judgement` TR-7.1: 点击切换按钮侧边栏平滑显示/隐藏
  - `programmatic` TR-7.2: appStore.sidebar 状态与 UI 同步
- **Notes**: 修改 src/App.vue, src/components/Sidebar.vue, src/stores/app.js
- **Status**: ✅ 已完成 - 侧边栏可平滑切换，状态持久化

## [x] Task 8: 知识图谱真实关联
- **Priority**: medium
- **Depends On**: None
- **Description**:
  - 将随机生成的连线改为基于真实内容的关联
  - 关联依据：相同标签、标题关键词匹配、内容关键词共现
  - 节点大小根据笔记字数/重要性调整
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `human-judgement` TR-8.1: 有相同标签的笔记之间有连线
  - `human-judgement` TR-8.2: 无关联的笔记之间没有连线
- **Notes**: 修改 src/views/GraphView.vue
- **Status**: ✅ 已完成 - 基于三级关联强度计算连线，节点大小随字数变化

## [x] Task 9: 修复单向数据流违反
- **Priority**: medium
- **Depends On**: None
- **Description**:
  - Sidebar 中直接修改 expandedFolders 改为调用 store action
  - SettingsView 中直接修改 notes/currentNoteId 改为调用 resetConfig
  - 所有其他组件中直接修改 store state 的地方都修复
- **Acceptance Criteria Addressed**: AC-11
- **Test Requirements**:
  - `programmatic` TR-9.1: 组件中无直接赋值 store state 的代码
  - `human-judgement` TR-9.2: 功能正常，无行为变化
- **Notes**: 修改 src/components/Sidebar.vue, src/views/SettingsView.vue, src/stores/note.js
- **Status**: ✅ 已完成 - 新增 toggleAllFolders、setExpandedFolders、setSelectedFolder actions

## [x] Task 10: 日历视图性能优化
- **Priority**: medium
- **Depends On**: None
- **Description**:
  - 预先按日期建立笔记索引（Map<dateString, note[]>）
  - calendarDays 计算属性从索引中查找，而非每次遍历所有笔记
- **Acceptance Criteria Addressed**: NFR-2
- **Test Requirements**:
  - `programmatic` TR-10.1: 日历渲染时单天查询复杂度 O(1)
  - `human-judgement` TR-10.2: 大量笔记时日历年切换无明显卡顿
- **Notes**: 修改 src/views/CalendarView.vue, src/stores/note.js
- **Status**: ✅ 已完成 - 新增 notesByDate 计算属性，getNotesByDate 使用索引查询

## [x] Task 11: 添加 404 路由和错误边界
- **Priority**: medium
- **Depends On**: None
- **Description**:
  - 添加通配符路由，指向 404 页面组件
  - 添加 Vue 错误边界组件，包裹 router-view
  - 错误时显示友好的错误提示和重试按钮
- **Acceptance Criteria Addressed**: AC-9
- **Test Requirements**:
  - `human-judgement` TR-11.1: 访问不存在路径显示 404 页面
  - `human-judgement` TR-11.2: 404 页面有返回首页按钮
- **Notes**: 新增 src/views/NotFound.vue，修改 src/App.vue, src/router/index.js
- **Status**: ✅ 已完成 - 新增 NotFound 组件，通配符路由，简化路由守卫

## [x] Task 12: 代码质量优化
- **Priority**: low
- **Depends On**: None
- **Description**:
  - 修复路由守卫冗余判断逻辑
  - 移除 ReadingView 重复的 onMounted 逻辑
  - 移除 WelcomeView 重复的路径检查
  - 修复 isActiveRoute 可能的误匹配
  - GraphView 动画帧保存 ID，组件卸载时取消
  - 修复 preload.js removeAllListeners 问题
- **Acceptance Criteria Addressed**: NFR-4
- **Test Requirements**:
  - `programmatic` TR-12.1: 无重复逻辑代码
  - `human-judgement` TR-12.2: 功能正常，无行为变化
- **Notes**: 修改多个文件
- **Status**: ✅ 已完成 - 路由守卫简化，移除重复逻辑

## [x] Task 13: 构建验证
- **Priority**: high
- **Depends On**: Task 1-12
- **Description**:
  - 执行 npm run build 验证 Web 构建
  - 确保所有修改无语法错误
  - 检查控制台无警告和错误
- **Acceptance Criteria Addressed**: AC-10
- **Test Requirements**:
  - `programmatic` TR-13.1: npm run build 执行成功，退出码 0
  - `programmatic` TR-13.2: 构建产物无错误
- **Notes**: 最终验证步骤
- **Status**: ✅ 已完成 - npm run build 构建成功，1414 模块转换完成