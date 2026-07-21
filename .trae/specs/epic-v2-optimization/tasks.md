# Choyeon Note v2.0 史诗级优化 - Implementation Plan

## [ ] Task 1: 知识图谱深度优化（参考 Obsidian）
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 力导向布局算法优化，节点分布更自然
  - 节点大小反映笔记重要性（字数/链接数）
  - 连线粗细反映关联强度
  - 悬浮高亮：悬停节点时高亮邻居，其他节点变暗
  - 滚轮缩放 + 拖拽平移
  - 点击节点跳转到对应笔记
  - 节点颜色按标签/文件夹区分
  - 局部图谱模式：显示当前笔记的直接关联
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `human-judgement` TR-1.1: 节点分布自然，大小/颜色有区分度
  - `human-judgement` TR-1.2: 悬浮高亮效果流畅自然
  - `human-judgement` TR-1.3: 缩放和平移操作流畅
  - `programmatic` TR-1.4: 点击节点正确跳转
- **Notes**: 修改 src/views/GraphView.vue

## [ ] Task 2: 拼写检查增强 - 忽略字典和浮动工具栏
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 自定义忽略字典，持久化到 localStorage
  - 选中错误单词弹出浮动工具栏（忽略一次/全部忽略/添加到字典）
  - 工具栏位置智能，不与选中区域冲突
  - 鼠标可平滑移动到工具栏（延迟隐藏 + 安全区域）
  - 编辑模式和实时模式都支持
  - 阅读模式隐藏拼写错误样式
  - 设置页面添加字典管理
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `human-judgement` TR-2.1: 选中错词弹出工具栏，操作流畅
  - `human-judgement` TR-2.2: 鼠标能移到工具栏点击按钮
  - `programmatic` TR-2.3: 添加到字典后刷新仍有效
  - `human-judgement` TR-2.4: 阅读模式无拼写错误标记
- **Notes**: 修改 src/stores/app.js, src/views/EditorView.vue, src/views/ReadingView.vue, src/views/SettingsView.vue

## [ ] Task 3: 编辑器增强 - 代码高亮
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 集成 highlight.js 实现代码块语法高亮
  - 支持 20+ 常用编程语言
  - 提供多套高亮主题（monokai, github, dracula 等）
  - 实时模式和阅读模式都正常显示
  - 编辑模式代码块保持可编辑
  - 代码块行号显示（可选）
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `human-judgement` TR-3.1: 代码块有正确的语法高亮
  - `human-judgement` TR-3.2: 多种语言高亮正确
  - `programmatic` TR-3.3: 切换主题后样式更新
- **Notes**: 新增依赖 highlight.js，修改 src/views/EditorView.vue, src/views/ReadingView.vue

## [ ] Task 4: 编辑器增强 - Mermaid 图表和 KaTeX 公式
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - 集成 mermaid 支持流程图、时序图、甘特图、饼图等
  - 集成 KaTeX 支持数学公式（行内和块级）
  - 工具栏添加图表插入按钮
  - 实时模式和阅读模式图表正常渲染
  - 编辑模式下代码块可编辑
  - 图表渲染失败降级显示
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `human-judgement` TR-4.1: mermaid 图表正确渲染
  - `human-judgement` TR-4.2: KaTeX 公式正确渲染
  - `human-judgement` TR-4.3: 工具栏按钮可插入图表模板
  - `programmatic` TR-4.4: 渲染失败有降级
- **Notes**: 新增依赖 mermaid, katex，修改 EditorView.vue, ReadingView.vue

## [ ] Task 5: 自动更新功能
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 集成 electron-updater
  - 启动时自动检测更新
  - 设置页面手动检查更新按钮
  - 更新日志 HTML 渲染显示
  - 下载进度显示
  - 下载完成提示重启安装
  - 更新渠道设置（稳定版）
  - package.json 配置 publish 配置
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-5.1: electron-updater 正确配置
  - `human-judgement` TR-5.2: 更新日志 HTML 正常渲染
  - `programmatic` TR-5.3: 下载进度回调正常
- **Notes**: 新增依赖 electron-updater，修改 electron/main.js, src/views/SettingsView.vue

## [ ] Task 6: 设置页面增强 - 字体大小和代码高亮主题
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - 修复字体大小调节功能，实时生效
  - 代码高亮主题下拉选择框
  - 选择时实时预览代码效果
  - 设置持久化到 localStorage
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgement` TR-6.1: 字体大小调节实时生效
  - `human-judgement` TR-6.2: 代码主题下拉有实时预览
  - `programmatic` TR-6.3: 设置持久化保存
- **Notes**: 修改 src/views/SettingsView.vue, src/stores/app.js, src/style.css

## [ ] Task 7: 设置页面增强 - Bing 每日壁纸背景
- **Priority**: medium
- **Depends On**: None
- **Description**:
  - Bing 每日壁纸 API 集成
  - 背景应用到主内容区域
  - 磨砂玻璃效果叠加
  - 支持手动刷新壁纸
  - 设置中开关控制
  - 壁纸缓存，避免重复请求
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgement` TR-7.1: Bing 壁纸正常显示
  - `human-judgement` TR-7.2: 磨砂玻璃效果协调
  - `programmatic` TR-7.3: 开关控制正常
- **Notes**: 修改 src/App.vue, src/views/SettingsView.vue, src/stores/app.js

## [ ] Task 8: 设置页面增强 - 反馈和字典管理
- **Priority**: medium
- **Depends On**: Task 2
- **Description**:
  - 反馈按钮，点击跳转到 GitHub Issues
  - 自定义字典管理界面（查看/删除单词）
  - 重置所有设置按钮
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgement` TR-8.1: 反馈按钮打开正确链接
  - `human-judgement` TR-8.2: 字典管理可增删
  - `programmatic` TR-8.3: 重置设置功能正常
- **Notes**: 修改 src/views/SettingsView.vue, src/stores/app.js

## [ ] Task 9: 整体 Bug 检查和性能优化
- **Priority**: high
- **Depends On**: Task 1-8
- **Description**:
  - 全面测试所有功能
  - 修复发现的 bug
  - 性能优化（防抖、节流、虚拟滚动等）
  - 内存泄漏检查
  - 控制台错误清理
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `programmatic` TR-9.1: 构建无错误
  - `programmatic` TR-9.2: 控制台无报错
  - `human-judgement` TR-9.3: 主要功能无 bug
- **Notes**: 全项目范围

## [ ] Task 10: 构建打包和发布
- **Priority**: high
- **Depends On**: Task 9
- **Description**:
  - 配置 electron-builder 打包
  - Windows 安装包生成
  - 推送到 GitHub
  - 创建 GitHub Release
  - 上传安装包到 Release
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `programmatic` TR-10.1: 打包成功生成 exe
  - `programmatic` TR-10.2: GitHub Release 创建成功
  - `human-judgement` TR-10.3: Release 页面有安装包和更新日志
- **Notes**: 使用 electron-builder + gh CLI