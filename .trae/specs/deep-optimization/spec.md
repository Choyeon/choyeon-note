# Choyeon Note 深度优化 - Product Requirement Document

## Overview
- **Summary**: 对 Choyeon Note 项目进行全面深度优化，修复所有已知 bug、完善 UI/UX、优化性能、确保项目能够稳定落地。
- **Purpose**: 解决项目中存在的功能缺失、逻辑错误、UI 不一致、性能问题等，使产品达到生产级质量标准。
- **Target Users**: 所有使用 Choyeon Note 的用户，包括 Windows/macOS/Linux 平台的 Electron 用户和 Web 用户。

## Goals
- 修复所有功能缺失和逻辑错误，确保核心功能完整可用
- 统一 UI 设计语言，消除视觉不协调问题
- 优化性能和响应速度
- 增强错误处理和边界条件覆盖
- 确保多平台兼容性

## Non-Goals (Out of Scope)
- 添加全新功能特性（如协作、云同步等）
- 彻底重构技术栈或架构
- 更改项目的核心数据模型

## Background & Context
当前项目存在以下核心问题：
1. **EditorView.vue 文件缺失** - 路由配置了 `/editor/:id` 但文件不存在，导致无法编辑笔记
2. **毛玻璃效果不一致** - `acrylic-card` 使用错误的变量，与 `settings-card` 效果不一致
3. **路由守卫逻辑问题** - 检查 `mode` 但 store 中无此状态，导致逻辑异常
4. **状态管理问题** - `noteStore.resetConfig()` 不存在，直接赋值 notes 破坏响应式
5. **暗色模式显示问题** - 多处使用 `--color-primary-lighter` 在暗色模式下显示异常
6. **编辑器实时模式问题** - 使用 `contenteditable` 存在兼容性和数据同步问题
7. **响应式布局不完善** - 部分视图在不同屏幕尺寸下显示异常

## Functional Requirements
- **FR-1**: 笔记编辑器功能完整可用，支持编辑/实时/预览三种模式
- **FR-2**: 毛玻璃效果在所有组件中统一且协调
- **FR-3**: 路由导航逻辑正确，无死循环或异常跳转
- **FR-4**: 状态管理逻辑正确，数据响应式更新正常
- **FR-5**: 暗色模式下所有元素显示正确，无视觉冲突
- **FR-6**: 页面切换过渡流畅，无空白或闪烁

## Non-Functional Requirements
- **NFR-1**: 应用启动时间 < 2s
- **NFR-2**: 页面切换过渡 < 300ms
- **NFR-3**: 内存占用 < 150MB（Electron）
- **NFR-4**: 支持 Windows/macOS/Linux 平台
- **NFR-5**: 支持响应式布局（最小宽度 800px）

## Constraints
- **Technical**: Vue 3 + Vite + Tailwind CSS + Electron
- **Business**: 保持现有设计风格和用户体验
- **Dependencies**: 不新增第三方依赖，如需使用需评估影响

## Assumptions
- 用户使用现代浏览器（Chrome/Edge/Firefox）或最新版 Electron
- 用户熟悉 Markdown 语法
- 用户数据存储在本地文件系统或浏览器 localStorage

## Acceptance Criteria

### AC-1: 编辑器功能完整
- **Given**: 用户访问 `/editor/:id` 路由
- **When**: 页面加载完成
- **Then**: 显示笔记内容，支持编辑/实时/预览三种模式切换
- **Verification**: `human-judgment`

### AC-2: 毛玻璃效果统一
- **Given**: 应用运行在 Electron 环境且启用毛玻璃效果
- **When**: 查看设置页面、欢迎页面、标签页面等
- **Then**: 所有卡片组件使用一致的毛玻璃效果参数
- **Verification**: `human-judgment`

### AC-3: 路由导航正确
- **Given**: 用户未选择笔记文件夹
- **When**: 访问非 welcome 路由
- **Then**: 自动重定向到 welcome 页面
- **Verification**: `programmatic`

### AC-4: 状态管理正常
- **Given**: 用户重置应用配置
- **When**: 点击确认重置按钮
- **Then**: 所有配置恢复默认，数据响应式更新
- **Verification**: `human-judgment`

### AC-5: 暗色模式显示正确
- **Given**: 切换到暗色模式
- **When**: 浏览所有页面
- **Then**: 所有元素颜色协调，无白色方块或视觉冲突
- **Verification**: `human-judgment`

### AC-6: 构建验证
- **Given**: 执行 `npm run build`
- **When**: 构建过程完成
- **Then**: 构建成功，无错误或警告
- **Verification**: `programmatic`

## Open Questions
- [ ] 是否需要添加快捷键功能的实际实现（目前仅展示）
- [ ] 是否需要添加自动保存功能的实际实现
