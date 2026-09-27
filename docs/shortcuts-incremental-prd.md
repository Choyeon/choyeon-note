# 增量 PRD：完整完善快捷键功能

| 项 | 内容 |
| --- | --- |
| 需求名称 | 完整完善快捷键功能 |
| 文档类型 | 增量 PRD（本轮唯一需求，不扩及其它模块） |
| 撰写人 | 许清楚（产品经理） |
| 项目 | choyeon-note（Electron + Vue 3 + Pinia + CodeMirror 6 + Vite） |
| 产品目标 | 对标 Obsidian 的快捷键体系 |
| Language | 中文 |
| 范围约束 | 不引入任何新依赖/新技术；不破坏已持久化的 `hotkeys` 数据结构；用户已改过的键不丢失 |

---

## 1. 核心问题陈述

现状调研（代码已读，非推测）确认「快捷键功能不完整」不是一个 bug，而是 **四层结构性问题叠加**。

### 问题 A：注册表 ↔ 执行器之间没有覆盖保证（根因）

`src/constants/shortcuts.js` 的 `SHORTCUTS`（44 条）是**声明**，而真正执行分散在两张互不知情的表里：

- `App.vue` 的 `APP_ACTIONS`（11 条，只认 `scope:'app'`）
- `useEditor.js` 的 `EDITOR_COMMANDS`（35 条，只认 `scope:'editor'`，由 `buildHotkeyBindings()` 遍历生成 CodeMirror keymap）

两者之间**没有任何校验**。实测结果：

| 方向 | 数量 | 具体命令 | 后果 |
| --- | --- | --- | --- |
| 死命令（注册表有、执行器无） | 2 | `view.liveMode`（真死，且 hidden，按了完全无反应）<br>`view.readingMode`（半死，靠 `EditorView.vue:769` 手写的字符串比对 hack 兜底） | 设置页能看、能改键，改完不生效 |
| 野命令（执行器有、注册表无） | 4 | `format.h5`、`format.h6`、`insert.table`、`insert.time` | 工具栏/命令能跑，但用户**无法自定义键位**，设置页和速查表里也搜不到 |

更进一步：`EditorView.vue` 的 hack 本身就是「scope 语义不够用」的证据——`view.readingMode` 被标成 `editor`，实际需求是「非编辑器聚焦时也要生效」。

### 问题 B：Electron 菜单加速器与注册表键位重叠，形成双通道执行（新增发现，优先级等同 A）

`electron/main.cjs` 里已注册了 7 个自定义 accelerator。其中 **5 个与注册表默认键完全重叠**：

| 菜单 accelerator | 菜单行为 | 注册表同键命令 | 注册表行为 | 实际后果 |
| --- | --- | --- | --- | --- |
| `CmdOrCtrl+N` | `menu:new-note` 新建笔记 | `app.newNote` = `Mod-n` | 新建笔记 | 同键同行为，可能**新建两篇** |
| `CmdOrCtrl+O` | `menu:open` 跳 `/notes` | `app.quickSwitcher` = `Mod-o` | 打开快速跳转 | 语义冲突，用户改键后菜单仍抢 |
| `CmdOrCtrl+S` | `menu:save` 保存 | `app.save` = `Mod-s` + `useEditor.js:521` 硬编码 `Mod-s` | 保存 | **三通道**，且硬编码那处**不受用户改键影响** |
| `CmdOrCtrl+P` | `menu:search` 打开快速跳转 | （注册表无 `Mod-p` 命令，但 `Mod-o` 也是快速跳转） | — | 两个键打开同一个面板 |
| `CmdOrCtrl+Shift+P` | `menu:command-palette` 打开命令面板 | `app.commandPalette` = `Mod-Shift-p` | `toggleCommandPalette()` | **最严重**：toggle 被执行两次 = 开了又关，表现为「按了没反应」 |
| `CmdOrCtrl+B` | `menu:toggle-sidebar` 切侧栏 | `format.bold` = `Mod-b`（editor scope） | 加粗 | 编辑器里按 Ctrl+B **同时**加粗 + 切侧栏（跨 scope 无人拦截） |
| `CmdOrCtrl+T` | `menu:toggle-theme` 切主题 | （`view.toggleTheme` = `Mod-Shift-t`，不重叠） | — | 安全 |

结论：**用户改键只在 renderer 层生效，菜单层永远不改**。这与「设置页是单一数据源」的产品承诺直接矛盾。

### 问题 C：绑定串规范化不统一，导致冲突检测与录制双双失真

1. **修饰键顺序不统一**：注册表里同时存在 `Shift-Mod-z`（`edit.redoAlt`）和 `Mod-Shift-d`（`insert.date`）、`Shift-Mod-d`（`edit.duplicateLine`）。`findConflict()` 做的是 `toLowerCase()` 后字符串全等比较，`shift-mod-d` ≠ `mod-shift-d`，**同 scope 的默认键冲突被漏判**（`edit.duplicateLine` 与 `insert.date` 实际撞键）。
2. **Shift + 数字/符号键无法还原**：`eventToBinding()` 自己承认「Shift+8 → `*` 无法还原」。后果：用户录制 `Mod-Shift-8`（无序列表）得到 `Mod-Shift-*`，与 default 不一致，键位**永远无法被正确重录或重置回默认**。同理影响 `Mod-Shift-7`、`Mod-Shift-9`。
3. **App.vue 匹配与 CodeMirror 匹配是两套比较逻辑**（字符串比较 vs CodeMirror keymap 解析），同一串在两层含义可能不同。

### 问题 D：冲突检测维度不足

- 只查**同 scope**：`app` 绑 `Tab` 会与编辑器 `edit.indent` 打架，检测不到。
- 不查**系统/浏览器保留键**：`Mod-w`（关窗口）、`Ctrl+Shift+T`（恢复标签页）、`Ctrl+N`（新窗口）在 Chromium 里不可拦截。
- 不查 **CodeMirror 内置键**（`Mod-f` 查找、`Escape`、`Enter`、`Backspace`、`Tab`）：用户可把这些键抢走并破坏基础编辑。
- 冲突时只回一句「与 X 冲突」，**没有「强行覆盖」出口**，用户必须自己先去把 X 清掉。

---

## 2. 竞品对照：Obsidian 快捷键体系

### 2.1 分层与分类

Obsidian 明确把键盘操作分成**两层**（[Hotkeys](https://help.obsidian.md/hotkeys) / [Editing shortcuts](https://obsidian.md/help/editing-shortcuts)）：

- **Hotkeys（可自定义）**：命令级，Settings → Hotkeys 里全部可改。
- **Editing shortcuts（不可自定义）**：由操作系统 / Electron / CodeMirror 提供的编辑行为（复制、按词移动、删除整行 `Ctrl+Shift+K`、全文首尾跳转等），**明确不在 Hotkeys 里暴露**。

> 对本项目的启示：现注册表把 `edit.undo` / `edit.redo` / `edit.selectAll`（`Mod-z` / `Mod-y` / `Mod-a`）列为可自定义命令，与 Obsidian 的分层相反，且它们与 Electron 菜单的 `role: undo/redo/selectAll` 又重叠一次（见问题 B 同族风险）。建议本轮至少在设置页对这几条加「系统级行为，修改可能不生效」的说明。

分类方式上，Obsidian 设置页**不按分类分组**，而是一条平铺列表 + 搜索过滤（分类信息体现在命令名前缀上，如 "Toggle …" / "Insert …"）。本项目现有的 5 分类平铺 + 分组卡片的做法比 Obsidian 更清晰，**建议保留**。

### 2.2 默认键位（Obsidian 官方/主流整理来源交叉核对）

| 能力 | Win/Linux | macOS | 来源 |
| --- | --- | --- | --- |
| 命令面板 | `Ctrl+P` | `⌘P` | shortcut.fyi / fastshortcuts / keyshortcuts |
| 快速跳转 | `Ctrl+O` | `⌘O` | 同上 |
| 新建笔记 | `Ctrl+N` | `⌘N` | 同上 |
| 保存当前文件 | `Ctrl+S` | `⌘S` | 同上 |
| 打开设置 | `Ctrl+,` | `⌘,` | 同上 |
| 全局搜索 | `Ctrl+Shift+F` | `⌘⇧F` | 同上 |
| 当前文件查找 / 替换 | `Ctrl+F` / `Ctrl+H` | `⌘F` / `⌘H` | fastshortcuts / keyshortcuts |
| 关系图谱 | `Ctrl+G` | `⌘G` | 同上 |
| 切换编辑/阅读视图 | `Ctrl+E` | `⌘E` | 同上 |
| 导航后退 / 前进 | `Ctrl+Alt+←/→` | `⌘⌥←/→` | shortcut.fyi / fastshortcuts（另有来源记为 `Alt+←/→`，**存在分歧**） |
| 放大 / 缩小 / 重置缩放 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | `⌘=` / `⌘-` / `⌘0` | shortcuts.kstanchev.com |
| 关闭当前页 / 恢复关闭 | `Ctrl+W` / `Ctrl+Shift+T` | `⌘W` / `⌘⇧T` | fastshortcuts / kstanchev |
| 下一个/上一个标签页 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 同 | fastshortcuts |
| 加粗 / 斜体 / 插入链接 | `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | `⌘B` / `⌘I` / `⌘K` | 全部来源一致 |
| 切换待办（checkbox） | `Ctrl+Enter` 或 `Ctrl+L` | `⌘↵` / `⌘L` | 来源分歧（shortcut.fyi 记 `Ctrl+L`，fastshortcuts 记 `Ctrl+Enter`） |
| 缩进 / 反缩进 | `Ctrl+]` / `Ctrl+[` | `⌘]` / `⌘[` | ref.toolkits.cn / fastshortcuts |
| 列表项缩进 / 反缩进 | `Tab` / `Shift+Tab` | 同 | 同上 |
| 上移 / 下移行 | `Alt+↑` / `Alt+↓` | `⌥↑` / `⌥↓` | fastshortcuts |
| 删除当前行 | `Ctrl+Shift+K` | `⌘⇧K` | 官方 Editing shortcuts |
| 删除当前段落 | `Ctrl+D` | `⌘D` | fastshortcuts |
| 复制当前行 | `Ctrl+Shift+D` | `⌘⇧D` | keyshortcuts |
| 删除线 | `Ctrl+Shift+X` 或 `Alt+Shift+D` | 同构 | 来源分歧（fastshortcuts / keyshortcuts） |
| 切换批注 | `Ctrl+/` | `⌘/` | keyshortcuts |
| 插入模板 | `Ctrl+Shift+Space` | `⌘⇧Space` | keyshortcuts |
| 折叠当前标题 | 无默认键（命令面板可用） | — | 多来源均未列默认键 |

**核对结论**：各第三方整理站在 toggle 系列、导航前后、删除线上存在分歧；仅「命令面板 / 快速跳转 / 新建 / 设置 / 搜索 / 图谱 / 切视图 / 加粗 / 斜体 / 链接 / 缩进」这一组是多源一致的**稳定核心集**。本项目默认键应对齐这一组，其余按自有语义决定。

**来源**：
- Obsidian 官方 Hotkeys：https://help.obsidian.md/hotkeys
- Obsidian 官方 Editing shortcuts：https://obsidian.md/help/editing-shortcuts
- https://shortcut.fyi/obsidian-shortcuts
- https://fastshortcuts.com/shortcuts/obsidian/
- https://shortcuts.kstanchev.com/apps/obsidian
- https://keyshortcuts.net/obsidian-shortcuts（部分条目与官方不一致，仅作补充）
- https://ref.toolkits.cn/obsidian.html

### 2.3 设置页 UX（Settings → Hotkeys）

| 能力 | Obsidian | 本项目现状 | 差距 |
| --- | --- | --- | --- |
| 搜索命令 | 有（search filter） | **已有**（`shortcutSearch`，且支持按按键名搜） | 无 |
| 只显示已分配/已修改 | 有（漏斗图标 = 只显示已有快捷键的命令） | **无** | 需补「仅看已修改」 |
| 冲突提示 | 无显式冲突 UI（后绑定者静默覆盖） | **已有**文字提示 `与「X」冲突` | 本项目已优于竞品，需补「强行覆盖」 |
| 录制交互 | 点 + 号 → 按组合 → 点 Save 确认 | **已有**点铅笔 → 按键立即生效 | 无 |
| Esc 取消 | 有（等同关闭录制） | **已有** | 无 |
| 清除键位 | 点 X 移除 | **已有**（Backspace / Delete） | 需补：录制中失焦/点其它行自动结束 |
| 重置单条 / 全部 | 有（X 恢复默认） | **已有**（`RotateCcw` / 全部重置） | 无 |
| 多组合键 | 支持一个命令绑多个键 | 不支持（数据结构是 1:1） | P2 |
| 键位显示 | 统一按 US 布局显示 | `bindingParts` 已按 isMac 出 `⌘⇧⌥` | 无 |

> 说明：任务书里列为待办的四项（搜索框、冲突提示、Esc 取消、Backspace 清除）**代码里已实现**。真正缺的是「仅看已修改」「显示占用者并可强行覆盖」「录制态的退出兜底」。

---

## 3. 缺口清单

列：`命令 id | 中文标签 | 建议默认键 | scope | 需新增执行器吗 | 优先级 | 备注`

### 3.1 现有 44 条里的问题项

| 命令 id | 中文标签 | 建议默认键 | scope | 需新增执行器吗 | 优先级 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `view.liveMode` | 切换实时预览 | `Mod-Alt-l`（原 `Mod-Shift-l`） | `editor` → **`app`** | 否（`appStore.setEditorMode('live')` 已存在） | **P0** | 当前完全死命令；且 `Mod-Shift-l` 与 `insert.wikiLink` 撞键。改 app scope 后极低成本可接 |
| `view.readingMode` | 切换阅读模式 | 保持 `Mod-Shift-e` | `editor` → **`app`** | 否（逻辑已有，只需搬进 store/APP_ACTIONS） | **P0** | 顺带删除 `EditorView.vue:761-790` 的手写 hack 与 `onMounted/onUnmounted` 监听 |
| `edit.toggleTask` | 切换待办状态 | `Mod-Shift-Enter`（原 `Mod-Enter`） | editor | 否 | **P0** | 原默认与 `edit.insertLineBelow` 完全撞键且被其遮蔽；建议同时**取消 hidden**（对标 Obsidian 的一等命令） |
| `edit.duplicateLine` | 复制当前行 | `Mod-Shift-d`（规范化，原 `Shift-Mod-d`） | editor | 否 | **P0** | 仅改书写顺序，键位不变（不丢用户数据） |
| `insert.date` | 插入当前日期 | `Mod-Alt-d`（原 `Mod-Shift-d`） | editor | 否 | **P0** | 与 `duplicateLine` 撞键（规范化后会被检出）。保持 hidden |
| `edit.redoAlt` | 重做（备选） | `Mod-Shift-z`（规范化） | editor | 否 | P1 | 仅顺序规范化；hidden 保留 |
| `app.save` | 保存笔记 | 保持 `Mod-s` | app | 否 | **P0** | 必须同时删除 `useEditor.js:521` 的硬编码 `Mod-s`，否则用户改键后编辑器内仍按旧键保存 |
| `app.newNote` | 新建笔记 | 保持 `Mod-n` | app | 否 | **P0** | Chromium 中 `Ctrl+N` 不可拦截 → Electron-only；需与菜单去重（问题 B） |
| `app.quickSwitcher` | 快速跳转 | 保持 `Mod-o` | app | 否 | **P0** | 菜单 `CmdOrCtrl+O` 语义不同（跳 `/notes`），需去重 |
| `app.commandPalette` | 命令面板 | 保持 `Mod-Shift-p` | app | 否 | **P0** | 与菜单 `CmdOrCtrl+Shift+P` 双通道导致「开了又关」；去重后键位可保留（对齐 VS Code 肌肉记忆） |
| `edit.indent` / `edit.outdent` | 增/减缩进 | 保持 `Tab` / `Shift-Tab` | editor | 否 | P1 | `Tab` 与焦点移动冲突（无障碍）。保留默认（对齐 Obsidian），但需在设置页标「保留键」提示；备选键列入 P2 |
| `format.bold` | 加粗 | 保持 `Mod-b` | editor | 否 | **P0** | 与菜单 `CmdOrCtrl+B`（切侧栏）跨 scope 重叠 → 编辑器内按一次触发两件事 |
| `view.calendar` | 日历视图 | `Mod-Shift-c` → 建议 `Mod-Alt-k` | app | 否 | P1 | `Ctrl+Shift+C` 在 Chromium 是「检查元素」，DevTools 打开时不可拦截 |
| `view.toggleTheme` | 切换明暗主题 | 保持 `Mod-Shift-t` | app | 否 | P1 | `Ctrl+Shift+T` 在 Chromium 是「恢复关闭标签页」，不可拦截；Electron 下安全，需加保留键提示 |
| `edit.undo` / `edit.redo` / `edit.selectAll` | 撤销/重做/全选 | 保持 | editor | 否 | P1 | 与 Electron 菜单 `role: undo/redo/selectAll` 重叠，存在双触发风险；设置页需标注「系统级行为」 |
| `view.search` | 搜索笔记 | 保持 `Mod-Shift-f` | app | 否 | P2 | 编辑器内 `Mod-f` 由 CodeMirror `searchKeymap` 提供，两者语义不同（全局 vs 本文件），暂不并入注册表，避免抢键 |

### 3.2 建议新增（均满足「执行器已存在或极低成本」）

| 命令 id | 中文标签 | 建议默认键 | scope | 需新增执行器吗 | 优先级 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `format.h5` | 五级标题 | `Mod-Alt-5` | editor | **否**（`EDITOR_COMMANDS` 已有） | **P0** | 纯补注册表条目，零成本收编野命令 |
| `format.h6` | 六级标题 | `Mod-Alt-6` | editor | **否**（已有） | **P0** | 同上 |
| `insert.table` | 插入表格（3×3） | `Mod-Alt-t` | editor | **否**（`md.insertTable` 已有） | **P0** | 同上；高频，给默认键 |
| `insert.time` | 插入当前时间 | 不绑定（默认 `''`） | editor | **否**（已有） | **P0** | 收编即可，默认不绑键（对标 Obsidian「很多命令无默认键」） |
| `app.navigateBack` | 导航后退 | `Mod-Alt-ArrowLeft` | app | **极低成本**（`router.back()`） | P1 | 对标 Obsidian `Ctrl+Alt+←`；需实测与 CodeMirror `standardKeymap` 是否重叠 |
| `app.navigateForward` | 导航前进 | `Mod-Alt-ArrowRight` | app | **极低成本**（`router.forward()`） | P1 | 同上 |
| `view.toggleRightPanel` | 切换右侧面板 | `Mod-Alt-r` | app | **否**（`appStore.toggleRightPanel` 已有） | P1 | 对标 Obsidian `Ctrl+Shift+R` |
| `view.zoomIn` | 放大 | `Mod-=` | app | **否**（`appStore.setEditorZoom` 已有） | P1 | **注意**：与 Electron `role: zoomIn` 重叠，需同批次去重 |
| `view.zoomOut` | 缩小 | `Mod--` | app | **否**（已有） | P1 | 绑定串以 `--` 结尾，`bindingParts` 已兼容；仅走 app scope 匹配，不进 CodeMirror，规避解析风险 |
| `view.zoomReset` | 重置缩放 | `Mod-0` | app | **否**（`appStore.resetEditorZoom` 已有） | P1 | 同上 |
| `view.notes` | 笔记列表 | 不绑定（默认 `''`） | app | **极低成本**（`router.push('/notes')`） | P1 | 默认不绑键，避免键位污染；命令面板可用 |
| `view.tags` | 标签视图 | 不绑定（默认 `''`） | app | **极低成本**（`router.push('/tags')`） | P1 | `TagsView.vue` 已存在 |
| `app.shortcutCheatsheet` | 快捷键速查表 | `Mod-/` | app | **是**（新增面板组件，属本 PRD 范围） | P1 | 组件本身是 P1-2 需求；默认键待裁决（见 §6） |
| `insert.callout` | 插入 Callout | 不绑定（默认 `''`） | editor | **低成本**（新增 `md.insertCallout`，约 15 行） | P1 | 需裁决是否本轮纳入（见 §6） |
| `insert.tag` | 插入标签 | 不绑定（默认 `''`） | editor | **极低成本**（`md.insertText('#')` 一行） | P1 | 同上 |
| `edit.foldCurrentHeading` | 折叠当前标题 | 不绑定（默认 `''`） | editor | **否**（`md.foldCurrentHeading` 已导出） | P2 | 低成本但非键盘体系核心，放 P2 |
| `edit.toggleComment` | 切换批注 `%%` | 不绑定（默认 `''`） | editor | **低成本**（`toggleWrap('%%')`） | P2 | 对标 Obsidian `Ctrl+/`，但 `Mod-/` 已给速查表 |
| `edit.indentAlt` / `edit.outdentAlt` | 缩进备选 `Mod-]` / `Mod-[` | `Mod-]` / `Mod-[` | editor | **否**（已有命令，新增别名条目） | P2 | 无障碍备选，对标 Obsidian |

**明确列入 P2「待定/不做」**（均需新增业务功能，违反本轮范围约束）：星标/置顶笔记、模板插入、日记命令、分屏/新建窗格、多窗口、幻灯片、打开帮助、重命名/删除笔记（危险操作不应有默认键）。

---

## 4. 功能需求池

### P0（必须做，否则「快捷键功能不完整」不成立）

**P0-1 注册表 ↔ 执行器覆盖校验**
- 新增纯函数模块 `src/utils/shortcutAudit.js`，导出 `auditShortcuts({ appActionIds, editorCommandIds })`，返回 `{ dead, orphan, duplicateDefault, invalidSyntax }`。
  - `dead`：注册表非 hidden 命令，但对应 scope 的执行器表里没有 id。
  - `orphan`：执行器表里有、注册表里没有的 id。
  - `duplicateDefault`：规范化后同 scope 内默认键重复。
  - `invalidSyntax`：`default` 无法被 `bindingParts()` 正确解析（如主键为空）。
- 开发期：`App.vue` 在 `import.meta.env.DEV` 下 `onMounted` 跑一次，`dead` 非空时 `console.error` 列出命令 id。
- 测试期：新增 `tests/shortcuts.test.js`（vitest 已装），断言以上四类均为空。
- **验收标准**：
  1. 人为从 `EDITOR_COMMANDS` 删掉一条 → `npm test` 失败并指出死命令 id。
  2. 人为在 `SHORTCUTS` 加一条无执行器的命令 → `npm test` 失败。
  3. 故意让两条同 scope 命令 default 相同 → `npm test` 失败。
  4. `npm run dev` 打开控制台，无任何快捷键 audit 报错。

**P0-2 绑定串规范化（单一比较口径）**
- 在 `src/constants/shortcuts.js` 新增并导出 `normalizeBinding(str)`：
  1. 修饰键统一排序为 `Mod` → `Shift` → `Alt`；
  2. 主键小写化；
  3. 全等比较一律先过 `normalizeBinding`。
- `eventToBinding()` 增加**主键反查**：优先用 `event.code` 还原被 Shift 变换的键（`Digit8`→`8`、`Digit7`→`7`、`Digit9`→`9`、`Comma`→`,`、`Period`→`.`、`Slash`→`/`、`Minus`→`-`、`BracketLeft`→`[`、`Semicolon`→`;`），未命中时回落 `event.key`。
- 改造调用点：`appStore.findConflict`、`App.vue` 的 keydown 匹配、`buildHotkeyBindings`（传给 CodeMirror 前规范化）、设置页展示。
- 注册表内所有 default 改写为规范顺序（`Shift-Mod-z` → `Mod-Shift-z`、`Shift-Mod-d` → `Mod-Shift-d`）。
- **验收标准**：
  1. `findConflict('edit.duplicateLine', 'Mod-Shift-d')` 命中 `insert.date`。
  2. 在设置页录制 `Ctrl+Shift+8`，得到的绑定串与 `format.bulletList` 的 default **字符串相等**，且列表功能立即生效。
  3. localStorage 中 `choyeon-note-hotkeys` 的 JSON 结构不变（仍存原文），老用户升级后已改键位全部保留（读取时归一化，不改写入格式）。

**P0-3 消灭死命令、收编野命令**
- `format.h5`、`format.h6`、`insert.table`、`insert.time` 进入 `SHORTCUTS`（默认键见 §3.2）。
- `view.readingMode` / `view.liveMode` 的 scope 改为 `app`；把 `EditorView.vue` 里的 `onModeKeydown` hack（第 761–790 行及其 `onMounted/onUnmounted` 监听）删除，改由 `APP_ACTIONS` 统一调度（`appStore.setEditorMode`）。
- 删除 `useEditor.js:521` 硬编码的 `Mod-s`。
- **验收标准**：
  1. 注册表条目 44 → 48，`auditShortcuts` 的 `dead`/`orphan` 均为空。
  2. 在**非编辑器页面**（如设置页）按 `Mod-Shift-e` 也能生效或给出「当前页面不适用」提示，不再依赖编辑器挂载。
  3. 把 `app.save` 改成 `Mod-Alt-s` 后，编辑器内按 `Mod-s` **不再保存**。

**P0-4 消除默认键内部冲突与菜单双通道**
- `edit.toggleTask` 默认改 `Mod-Shift-Enter`；`insert.date` 默认改 `Mod-Alt-d`；`view.liveMode` 默认改 `Mod-Alt-l`。
- 处理 `electron/main.cjs` 与注册表的重叠（推荐方案 A，待裁决）：
  - **方案 A（推荐）**：删除 `main.cjs` 中与注册表重叠的自定义 accelerator（`CmdOrCtrl+N/O/S/Shift+P`），并把 `CmdOrCtrl+B`（切侧栏）改为不与 `Mod-b` 冲突的组合或直接移除；菜单项保留，仅鼠标点击可用。renderer 成为键位唯一来源。
  - **方案 B**：保留菜单，在注册表条目上加 `menuBound: true` 标记，renderer 在 Electron 下检测到该键已被菜单占用时跳过。
- **验收标准**：
  1. 按 `Mod-Shift-P`：命令面板**稳定打开一次**（不闪关）。
  2. 在编辑器里按 `Mod-B`：仅加粗，侧栏**不动**。
  3. 按 `Mod-N`：只新建**一篇**笔记。
  4. 按 `Mod-S`：只触发一次保存（可通过保存计数/埋点日志验证）。

**P0-5 冲突检测增强**
- `findConflict()` 扩展返回 `{ id, label, severity }`：
  - `block`：同 scope 硬冲突（现状行为，拒绝写入）。
  - `warn`：跨 scope 冲突、命中保留键白名单。
- 新增保留键清单 `RESERVED_BINDINGS`（分级）：
  - 硬拒绝：`Mod-w`、`Mod-q`、`Mod-t`、`Mod-n`（仅浏览器环境）、`Mod-Shift-n`、`Mod-Shift-t`、`Ctrl+Alt+Del` 类。
  - 警告：`Escape`、`Enter`、`Backspace`、`Delete`、`Tab`、`Shift-Tab`、`Mod-f`、`Mod-p`、`Mod-c/v/x`（剪切复制粘贴）。
- `setHotkey(id, binding, { override = false })`：`override: true` 时把冲突命令的绑定置空并写入，返回 `{ ok: true, overridden: [被清空的命令] }`。
- **验收标准**：
  1. 给 app 命令绑定 `Tab` → 弹出警告但仍允许保存。
  2. 给任意命令绑定 `Mod-w` → 明确拒绝并提示原因。
  3. 对已冲突键选择「强行覆盖」→ 占用者变为「未设置」，新键生效且写入 localStorage。

### P1（体系完整度）

**P1-1 设置页改版**
- 「仅看已修改」过滤开关（对标 Obsidian 漏斗图标）。
- 冲突行可视化：行右侧按键胶囊加 `--state-error` 描边 + 下方小字「与「X」冲突 · [强行覆盖]」。
- 保留键提示：命中警告级保留键时，胶囊旁显示警告图标与 tooltip。
- 录制兜底：点击其它命令行、`click` 空白处、路由离开 → 自动 `stopRecording()`（当前只有 Esc/成功才停，误点会一直吞键）。
- 录制实时预览：按下组合但未提交时显示已捕获的按键胶囊。
- **验收标准**：开关只显示已自定义项；冲突行有红标且「强行覆盖」可用；录制中点击页面其它区域，全局快捷键恢复响应；`onUnmounted` 不再有残留监听。

**P1-2 快捷键速查表面板**
- 新增 `src/components/ShortcutCheatsheet.vue`（app 级模态），命令 `app.shortcutCheatsheet`，默认键 `Mod-/`（待裁决）。
- 内容：顶部搜索框、按 5 个分类分组、每行「标签 + 按键胶囊 + 已自定义标记」；空态复用设置页空态。
- 「打开设置」入口按钮跳转 `/settings` 快捷键盘区。
- **验收标准**：`Mod-/` 任意页面可开；搜索「加粗」命中并高亮；显示的是**用户改过之后的**键位；`Escape` 关闭；未绑定命令显示为「未设置」且不占视觉噪音。

**P1-3 新增命令批次**
- 落地 §3.2 中 P1 的 11 条命令（`app.navigateBack/Forward`、`view.toggleRightPanel`、`view.zoomIn/Out/Reset`、`view.notes`、`view.tags`、以及 P0 之外的收编项）。
- 命令面板（`CommandPalette.vue`）的数据源若尚未读注册表，需打通，避免「新增命令要改两处」。
- **验收标准**：每条新命令在设置页可见可改键、在命令面板可搜到、按下即执行；`auditShortcuts` 仍全绿。

**P1-4 键位变更的即时生效与不丢数据**
- 改键后：CodeMirror 走 `hotkeyCompartment` 重配置（已有，保留撤销栈）；App.vue 匹配实时读 `getBinding`（已有）。
- `mergeBindings()`（app.js）保持「key 缺失时补默认、已存在则保留」的语义不变。
- **验收标准**：改一条键位后，正在编辑的长文**撤销栈不清空**（回归验证 `hotkeyCompartment` 行为）；老版本 localStorage 数据加载后已改键位全部保留。

### P2（待定 / 明确不做）
- 多组合键（一个命令绑多个键，Obsidian 支持，需改 `hotkeys` 数据结构 → 违反本轮「结构不变」约束）。
- 键位方案导入/导出 JSON。
- `edit.indentAlt` / `edit.outdentAlt`（`Mod-]` / `Mod-[`）无障碍备选。
- `edit.foldCurrentHeading`、`edit.toggleComment`。
- 星标/置顶、模板、日记、分屏、多窗口、幻灯片、打开帮助（需新增业务功能）。
- 非 US 键盘布局的正确显示。

---

## 5. UI 设计稿

统一沿用现有 CSS 变量，不引入新色值：
`--color-primary`、`--color-primary-surface`、`--color-primary-ring`、`--color-bg-secondary`、`--color-bg-tertiary`、`--color-surface-hover`、`--color-text-primary` / `-secondary` / `-tertiary`、`--color-border-light`、`--state-error`。
复用现有类：`.settings-card`、`.kbd-key`、`.kbd-edit`、`.shortcut-search`、`.is-recording`、`.recording-hint`。

### 5.1 设置页 → 快捷键（改版）

```
┌──────────────────────────────────────────────────────────────┐
│ ⌨ 快捷键                            [仅看已修改]  [全部重置]  │
│                                                              │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ 🔍 搜索快捷键（支持按键名，如 Ctrl）...                   │  │
│ └────────────────────────────────────────────────────────┘  │
│ ⚠ 与「切换待办状态」冲突 · [强行覆盖]   ← 仅冲突时出现        │
│                                                              │
│ ┌─ 📁 文件与工作空间 ──────────────────────── 8 ─────────┐  │
│ │ 新建笔记                       [Ctrl][N]  ✏️            │  │
│ │ 保存笔记                       [Ctrl][S]  ✏️            │  │
│ │ 快速跳转                       [Ctrl][O]  ✏️  ↺         │  │
│ │    ↑ 已自定义（原 Ctrl+O 已改）                          │  │
│ │ 命令面板            ⚠️[Ctrl][Shift][P] ✏️               │  │
│ │   ⚠ 与系统保留键冲突（浏览器不可拦截）                   │  │
│ └────────────────────────────────────────────────────────┘  │
│ ┌─ ✏️ 编辑 ─────────────────────────────────── 12 ───────┐  │
│ │ 增加缩进                       [Tab] ⚠️ ✏️              │  │
│ │   ⚠ 保留键：会阻断键盘焦点移动                          │  │
│ │ 录制中：按下新的组合键… [Ctrl][Shift][8]  Esc 取消 · Del │  │
│ └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

交互要点：
- 胶囊 `.kbd-key` 冲突态：`border-color: var(--state-error)` + `color: var(--state-error)`。
- 警告态（保留键）：胶囊后跟 14px 警告图标，tooltip 说明，不阻断保存。
- 「已修改」过滤开启时，分类卡只保留含自定义项的分类；顶部计数变为已修改条数。
- 录制行沿用 `.is-recording` 主色底 + 呼吸动画，并显示实时捕获的胶囊预览。

### 5.2 快捷键速查表（新，P1-2）

```
┌─────────────────── 快捷键速查表 ──────── [Esc] ──────────────┐
│ ┌────────────────────────────────────────────────────────┐  │
│ │ 🔍 搜索命令或按键…                            48 条     │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                              │
│ 文件与工作空间                                                │
│ ┌────────────────────────┬────────────────────────┐         │
│ │ 新建笔记      [Ctrl][N]│ 保存笔记      [Ctrl][S] │         │
│ │ 快速跳转      [Ctrl][O]│ 命令面板   [Ctrl][⇧][P]│         │
│ └────────────────────────┴────────────────────────┘         │
│                                                              │
│ 编辑                                                         │
│ ┌────────────────────────┬────────────────────────┐         │
│ │ 撤销          [Ctrl][Z]│ 重做          [Ctrl][Y] │         │
│ │ 上移当前行     [Alt][↑]│ 下移当前行     [Alt][↓] │         │
│ └────────────────────────┴────────────────────────┘         │
│                                                              │
│ 底部：[打开快捷键设置 →]                                      │
└──────────────────────────────────────────────────────────────┘
```

交互要点：
- 两列网格（窄屏降为单列），分组标题用 `--color-text-tertiary` 12px。
- 已自定义项在标签后加 `--color-primary-surface` 底的小圆点。
- 未绑定命令渲染为 `--color-text-tertiary` 的「未设置」，不渲染胶囊。
- `Escape` / 点击遮罩关闭；打开时焦点落在搜索框；`↑↓` 在结果间移动，`Enter` 直接执行该命令（可选，P2）。

---

## 6. 待确认问题（交总监裁决）

1. **【最关键】Electron 菜单与注册表谁做键位唯一来源？** 方案 A（删掉 `main.cjs` 中与注册表重叠的 accelerator，renderer 独裁）vs 方案 B（保留菜单、注册表加 `menuBound` 标记让路）。我推荐 **A**——改动小、用户改键立刻真正生效、消除 `Mod-Shift-P` 闪关这类确定性 bug；代价是菜单项不再显示快捷键提示。**需裁决**。
2. **是否只做「覆盖校验」还是合并成单一命令总线？** P0-1 只加校验（改动小、可测试）；另一种做法是把 `APP_ACTIONS` + `EDITOR_COMMANDS` 合并为 `src/constants/commands.js` 的单一命令表，从结构上消灭死命令。后者更彻底但改动面大、需重构 `App.vue` 与 `useEditor.js` 的装配。**需裁决本轮是否只做校验**。
3. **速查表默认键用 `Mod-/` 还是 `?`？** `Mod-/` 安全但和「切换批注」的常见肌肉记忆冲突；`?` 更贴近部分产品的「帮助」直觉，但需要 `Shift+/` 且必须与「焦点不在输入框」条件绑定，且在非 US 布局上位置不定。**需裁决**（我倾向 `Mod-/`，并预留 `?` 作为隐藏备选）。
4. `insert.callout` / `insert.tag` 是否本轮纳入？两者都要新增极少量执行器（`insertCallout` 约 15 行 / `insertTag` 一行），不违反「不引入新依赖」，但严格说属于「新增业务功能」。**需裁决**是否按 P1 纳入，还是降级 P2。
5. `edit.toggleTask` 是否取消 hidden？它原本因与 `insertLineBelow` 撞键而被藏起来，现在改键后可以转正（对标 Obsidian 的 `Cmd+Enter`）。**需裁决**转正还是维持 hidden。
6. `view.zoomIn/Out/Reset` 与 Electron 菜单 `role: zoomIn/zoomOut/resetZoom` 天然重叠。若采用问题 1 的方案 A，这三个 role 是否一并处理（还是允许两者并存，因为 role 缩放与编辑器字体缩放是不同对象）？**需裁决**。
7. `app.commandPalette` 默认键是否从 `Mod-Shift-p` 改为 `Mod-p` 以对齐 Obsidian？当前 `Mod-p` 被菜单的「搜索」占用。若采用方案 A 且释放 `Mod-p`，是否改？**需裁决**（我倾向保持 `Mod-Shift-p`，避免与 Electron 打印习惯冲突，但需要你确认）。

---

## 7. 验收总纲（本轮完成的定义）

1. `npm test` 全绿，且 `tests/shortcuts.test.js` 能捕获人为注入的死命令/野命令/重复默认键。
2. `npm run dev` 控制台无快捷键 audit 报错。
3. 注册表 48 条命令**每一条**都能做到：设置页可见 → 可改键 → 改完立即生效 → 可重置 → 可在速查表/命令面板搜到。
4. `Mod-n / Mod-s / Mod-b / Mod-Shift-p` 在 Electron 下各只触发一次动作。
5. 录制 `Ctrl+Shift+8` 得到的绑定串与默认串一致，功能生效。
6. 老用户升级：localStorage 结构不变，已自定义键位 100% 保留。
