# Choyeon Note

[![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一款现代化的桌面 Markdown 笔记应用。支持源码编辑、实时编辑、预览三种模式，原生 Obsidian 风格文件夹管理、wikilink 双向链接、Callout 提示块、Mermaid/KaTeX 图表公式、拼写检查与智能自动补全。

---

## ✨ 功能特性

### 编辑器
- **三种模式**：源码编辑 · 实时编辑（所见即所得）· 预览
- **Markdown 扩展**：表格、任务列表、脚注、定义列表
- **Obsidian 兼容**：`[[wikilink]]` 双向链接、`![[embed]]` 嵌入、Callout 提示块、Frontmatter
- **代码高亮**：Highlight.js 180+ 语言
- **数学公式**：KaTeX 渲染 LaTeX
- **图表**：Mermaid 流程图、时序图、甘特图等
- **智能补全**：Markdown 语法、wikilink、tag、命令面板

### 笔记管理
- **文件夹树**：拖拽排序、右键菜单、批量操作
- **快速切换**：`Ctrl/Cmd + O` 全局搜索打开任意笔记
- **命令面板**：`Ctrl/Cmd + Shift + P` 执行任意命令
- **反向链接**：查看哪些笔记引用了当前笔记
- **属性面板**：编辑 Frontmatter metadata
- **标签过滤**：按 `#tag` 筛选笔记

### 其他
- **拼写检查**：可忽略词 + 自定义词典，跨会话持久化
- **自动更新**：electron-updater 支持 GitHub Releases
- **深浅主题**：CSS 变量驱动，一键切换
- **毛玻璃 UI**：Windows 亚克力风格标题栏
- **Pinia 状态管理**：类型安全的 store 架构

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | Vue 3 + Composition API |
| 路由 | Vue Router 4 |
| 状态管理 | Pinia 2 |
| 样式 | Tailwind CSS 3 |
| Markdown | CodeMirror 6 (编辑) · marked (渲染) |
| 语法高亮 | Highlight.js |
| 数学公式 | KaTeX |
| 图表 | Mermaid |
| 拼写检查 | Electron `session.defaultSession` |
| 桌面框架 | Electron 43 |
| 打包 | electron-builder |
| 构建 | Vite 8 |
| 测试 | Vitest |
| 图标处理 | sharp (重采样) · 手写 ICO 容器 (15 尺寸 × 32bpp RGBA) |

## 📦 安装

### 前置要求
- Node.js 18+
- npm（项目使用 npm 作为包管理器）

### 开发模式

```bash
# 安装依赖
npm install

# 仅前端热重载
npm run dev

# Electron + Vite 并行开发
npm run electron:dev
```

### 生产构建

```bash
# 仅前端
npm run build

# Windows 安装包（NSIS）
npm run electron:build:win

# 完整构建 + GitHub Release 发布
npm run build:c
```

## 🏗️ 项目结构

```
choyeon-note/
├── build/
│   └── icons/              # 应用图标 (icon.ico + icon-*.png)
├── electron/
│   ├── main.cjs            # Electron 主进程
│   ├── preload.cjs         # Preload 脚本 (IPC 桥接)
│   └── path-safety.cjs     # 路径安全工具
├── public/                 # 静态资源
├── scripts/
│   ├── build-c.js          # 一键构建 + GitHub Release
│   └── generate-icons.js   # 图标生成脚本
├── src/
│   ├── components/         # 可复用组件
│   ├── composables/        # Vue Composition 函数
│   ├── stores/             # Pinia stores
│   ├── utils/              # 工具函数
│   ├── views/              # 页面视图
│   ├── App.vue
│   └── main.js
├── tests/                  # Vitest 测试
├── index.html
├── package.json
├── tailwind.config.js
└── vite.config.js
```

## 📋 键盘快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl/Cmd + P` | 命令面板 |
| `Ctrl/Cmd + O` | 快速切换笔记 |
| `Ctrl/Cmd + S` | 保存笔记 |
| `Ctrl/Cmd + \` | 侧边栏切换 |
| `Ctrl/Cmd + +` / `-` | 字号缩放 |
| `Ctrl/Cmd + Shift + T` | 主题切换 |

## 📝 与 Obsidian 兼容性

Choyeon Note 原生支持以下 Obsidian 语法：

| 特性 | 语法 |
|---|---|
| Wikilink | `[[笔记名]]`、`[[笔记名\|别名]]` |
| Embed | `![[笔记名]]`、`![[笔记名#章节]]` |
| Callout | `> [!note]`、`> [!warning]` 等 |
| Frontmatter | `---` 包裹的 YAML metadata |
| Tag | `#tag` |
| 反向链接 | 自动解析所有 `[[wikilink]]` |

## 🔄 自动更新

应用基于 electron-updater，版本发布到 GitHub Releases 后用户即可收到更新提示。更新链路要求：

1. Release 中包含 `latest.yml`
2. Release 为非 Draft 且 `isLatest: true`
3. Release 包含对应平台的安装包 (`.exe` + `.blockmap`)

本地完整发布命令：`npm run build:c`

## 📜 许可证

[MIT License](LICENSE)
