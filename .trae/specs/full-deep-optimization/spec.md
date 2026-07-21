# Choyeon Note 全面深度优化 - Product Requirement Document

## Overview
- **Summary**: 对 Choyeon Note 桌面笔记应用进行全面深度优化，修复所有已知 bug、完善逻辑漏洞、优化 UI 体验，确保项目达到生产级可落地标准。涵盖 Tailwind 变量修复、拼写检查功能修复、Electron 文件系统安全加固、设置持久化、系统主题支持、性能优化等 28+ 个问题的修复。
- **Purpose**: 解决当前项目中存在的功能失效、性能瓶颈、安全隐患和代码质量问题，打造一个稳定、高效、安全、美观的桌面笔记应用。
- **Target Users**: 需要本地优先、支持 Markdown、知识图谱、日历视图的笔记用户

## Goals
- 修复所有 5 个严重级别的 bug，确保核心功能正常运行
- 加固 Electron 文件系统安全性，防止路径遍历攻击
- 实现设置和笔记路径的持久化存储
- 完善系统主题支持，跟随系统深浅色切换
- 优化性能：保存防抖、日历索引、搜索分离
- 提升代码质量：修复单向数据流、消除重复逻辑、添加错误边界
- 统一 UI 样式：CSS 变量命名规范化、暗色模式一致性
- 项目可直接构建和发布，无已知 bug

## Non-Goals (Out of Scope)
- 不添加新的核心功能模块（如云同步、协作编辑）
- 不重构整体架构（保持 Vue 3 + Pinia + Electron 架构）
- 不更换 UI 框架或设计语言
- 不添加单元测试框架（仅手动验证功能正确性）
- 不实现多语言国际化

## Background & Context
Choyeon Note 是一个基于 Vue 3 + Vite + Tailwind CSS + Electron 构建的桌面笔记应用。当前版本已实现基本功能，但存在较多技术债务和 bug：
- Tailwind 配置与 CSS 变量不匹配导致部分样式失效
- 拼写检查功能逻辑错误完全失效
- 文件系统操作缺少安全校验
- 设置未持久化，刷新后丢失
- 系统主题支持不完整
- 存在多处单向数据流违反和重复逻辑

## Functional Requirements
- **FR-1**: 修复 Tailwind CSS 变量配置，确保所有 Tailwind 主题色类正常工作
- **FR-2**: 修复拼写检查功能，实现正确的单词校验逻辑
- **FR-3**: 知识图谱基于真实笔记内容关联（标题/标签/内容关键词）
- **FR-4**: Electron 文件系统操作添加路径安全校验，防止路径遍历
- **FR-5**: 笔记路径和应用设置持久化存储
- **FR-6**: 完善系统主题支持，监听系统配色方案变化
- **FR-7**: 笔记内容保存添加防抖，减少频繁磁盘写入
- **FR-8**: 侧边栏显示/隐藏功能正常工作
- **FR-9**: 添加 404 路由页面
- **FR-10**: 添加 Vue 错误边界，防止单组件错误导致白屏
- **FR-11**: 修复所有单向数据流违反（直接修改 store state）
- **FR-12**: 日历视图按日期建立笔记索引，优化性能

## Non-Functional Requirements
- **NFR-1**: 安全性 - 文件系统操作必须校验路径边界，防止任意文件访问
- **NFR-2**: 性能 - 输入时保存防抖延迟 ≤ 500ms，日历渲染无明显卡顿
- **NFR-3**: 可靠性 - 设置和数据持久化，应用重启后状态保留
- **NFR-4**: 可维护性 - 代码遵循单向数据流，无重复逻辑
- **NFR-5**: 一致性 - CSS 变量命名统一，暗色模式各组件表现一致
- **NFR-6**: 构建验证 - `npm run build` 和 `npm run build:electron` 均成功

## Constraints
- **技术栈**: Vue 3 (Composition API) + Vite + Tailwind CSS + Pinia + Electron
- **平台**: Windows 桌面应用（Electron）
- **依赖**: 保持现有依赖，不新增大型依赖库
- **兼容性**: 支持亮色/暗色主题，支持毛玻璃效果开关

## Assumptions
- marked 库可用于内容关键词提取和关联分析
- Electron 提供的 fs API 足够实现所有文件操作
- 用户本地有可用的拼写检查字典或使用浏览器内置拼写检查
- localStorage 可用于存储应用设置（非敏感数据）

## Acceptance Criteria

### AC-1: Tailwind 变量匹配
- **Given**: 应用运行中
- **When**: 使用 Tailwind 主题色类（如 `bg-background`, `text-foreground`）
- **Then**: 样式正确渲染，颜色与 CSS 变量一致
- **Verification**: `programmatic`
- **Notes**: 检查 tailwind.config.js 与 style.css 变量名对应关系

### AC-2: 拼写检查功能正常
- **Given**: 编辑器已开启拼写检查
- **When**: 输入正确单词和错误单词
- **Then**: 错误单词显示下划线标记，正确单词无标记
- **Verification**: `human-judgment`
- **Notes**: 至少验证 5 个正确单词和 5 个错误单词

### AC-3: 知识图谱真实关联
- **Given**: 有多篇笔记，部分笔记有相同标签或关键词
- **When**: 打开知识图谱视图
- **Then**: 有相同标签/关键词的笔记之间显示连线，无关联的笔记不连线
- **Verification**: `human-judgment`

### AC-4: 文件系统路径安全
- **Given**: 用户选择了笔记目录
- **When**: 尝试访问目录外的文件（通过路径遍历）
- **Then**: 请求被拒绝，无法访问目录外文件
- **Verification**: `programmatic`
- **Notes**: 测试包含 ../ 的路径应被拦截

### AC-5: 设置持久化
- **Given**: 用户修改了主题、字体大小、自动保存等设置
- **When**: 关闭并重新打开应用
- **Then**: 所有设置保持修改后的值
- **Verification**: `human-judgment`

### AC-6: 系统主题支持
- **Given**: 主题设置为"系统"
- **When**: 切换系统深色/浅色模式
- **Then**: 应用主题自动跟随系统变化
- **Verification**: `human-judgment`

### AC-7: 保存防抖
- **Given**: 自动保存已开启
- **When**: 快速连续输入文字
- **Then**: 停止输入 500ms 后才触发一次保存，而非每次输入都保存
- **Verification**: `programmatic`
- **Notes**: 可通过 console.log 或文件修改时间验证

### AC-8: 侧边栏切换正常
- **Given**: 应用在有侧边栏的页面
- **When**: 点击侧边栏切换按钮或使用快捷键
- **Then**: 侧边栏平滑显示/隐藏
- **Verification**: `human-judgment`

### AC-9: 404 路由
- **Given**: 应用运行中
- **When**: 访问不存在的路由路径
- **Then**: 显示友好的 404 页面，可返回首页
- **Verification**: `human-judgment`

### AC-10: 构建成功
- **Given**: 所有代码修改完成
- **When**: 执行 `npm run build`
- **Then**: 构建成功，无报错
- **Verification**: `programmatic`

### AC-11: 单向数据流
- **Given**: 审查所有组件代码
- **When**: 检查 store state 修改方式
- **Then**: 所有 state 修改都通过 store action/mutation，无直接赋值
- **Verification**: `programmatic`

### AC-12: 暗色模式一致性
- **Given**: 切换到暗色模式
- **When**: 浏览所有页面和组件
- **Then**: 无白色方块、无对比度过低、所有元素清晰可见
- **Verification**: `human-judgment`

## Open Questions
- [ ] 是否需要实现 Electron 单实例锁？（防止多开）
- [ ] 知识图谱关联算法的复杂度要求？（仅标签匹配 vs 内容语义分析）
- [ ] 是否需要添加数据导出/导入功能？
- [ ] 拼写检查使用什么词典？（浏览器内置 vs 自定义词典）
