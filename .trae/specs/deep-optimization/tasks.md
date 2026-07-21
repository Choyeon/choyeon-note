# Choyeon Note 深度优化 - Implementation Plan

## [x] Task 1: 修复 EditorView.vue 文件缺失
- **Priority**: high
- **Depends On**: None
- **Description**: 创建完整的编辑器视图组件，支持编辑/实时/预览三种模式，实现 Markdown 解析和渲染，支持快捷键操作
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `human-judgement` TR-1.1: 编辑器三种模式切换正常，Markdown 渲染正确
  - `human-judgement` TR-1.2: 快捷键工具栏功能正常，行号显示正确
- **Notes**: 需要处理实时模式下的 Markdown 解析和同步问题
- **Status**: ✅ 已完成 - 创建了完整的 EditorView.vue，支持编辑/实时/预览三种模式

## [x] Task 2: 修复毛玻璃效果不一致问题
- **Priority**: high
- **Depends On**: None
- **Description**: 统一所有卡片组件的毛玻璃效果，修正 `acrylic-card` 使用的变量，确保所有组件使用一致的 `--card-blur` 和 `--card-saturate` 变量
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `human-judgement` TR-2.1: 设置卡片、欢迎页面卡片、标签卡片毛玻璃效果一致
  - `human-judgement` TR-2.2: 毛玻璃开关切换时所有卡片效果同步变化
- **Notes**: 主要修改 style.css 中的 acrylic-card 类
- **Status**: ✅ 已完成 - 修复了 .acrylic-card 和 .cho-card 使用错误变量的问题

## [x] Task 3: 修复路由守卫逻辑问题
- **Priority**: high
- **Depends On**: None
- **Description**: 修复路由守卫中检查 `mode` 的逻辑，store 中无此状态导致判断异常。需要在 app store 中添加 mode 状态或修改路由守卫逻辑
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-3.1: 未选择文件夹时访问非 welcome 路由自动重定向
  - `programmatic` TR-3.2: 选择文件夹后正常访问所有路由
- **Notes**: 修改 router/index.js 和 stores/app.js
- **Status**: ✅ 已完成 - 移除了对不存在的 mode 状态的检查

## [x] Task 4: 修复状态管理问题
- **Priority**: high
- **Depends On**: None
- **Description**: 在 note store 中添加 `resetConfig()` 方法，使用正确的响应式方法更新 notes 数组，避免直接赋值破坏响应式
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `human-judgement` TR-4.1: 重置应用后所有数据正确恢复默认
  - `human-judgement` TR-4.2: 重置后 UI 同步更新
- **Notes**: 修改 stores/note.js 和 SettingsView.vue
- **Status**: ✅ 已完成 - 添加了 resetConfig() 方法，使用 push/pop 保持响应式

## [x] Task 5: 修复暗色模式显示问题
- **Priority**: high
- **Depends On**: None
- **Description**: 替换所有使用 `--color-primary-lighter` 的地方为 `--color-primary-surface`，确保暗色模式下显示正确
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `human-judgement` TR-5.1: 暗色模式下所有图标背景、按钮背景无白色方块
  - `human-judgement` TR-5.2: 暗色模式下所有文本颜色对比度足够
- **Notes**: 需要检查 CalendarView.vue、GraphView.vue、TagsView.vue 等文件
- **Status**: ✅ 已完成 - 替换了所有视图文件中的 --color-primary-lighter 为 --color-primary-surface

## [x] Task 6: 优化页面切换过渡效果
- **Priority**: medium
- **Depends On**: None
- **Description**: 优化页面切换动画，添加加载状态指示，避免切换时空白区域
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `human-judgement` TR-6.1: 页面切换时有平滑过渡动画
  - `human-judgement` TR-6.2: 切换过程中无明显空白或闪烁
- **Notes**: 修改 App.vue 和各视图组件
- **Status**: ✅ 已完成 - 添加了加载动画和更平滑的过渡效果

## [x] Task 7: 构建验证
- **Priority**: high
- **Depends On**: Task 1-6
- **Description**: 执行构建命令验证所有修改无语法错误，确保项目可以正常构建
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `programmatic` TR-7.1: `npm run build` 执行成功
  - `programmatic` TR-7.2: 构建产物无错误
- **Notes**: 需要确保所有修改都通过构建验证
- **Status**: ✅ 已完成 - npm run build 执行成功，无错误