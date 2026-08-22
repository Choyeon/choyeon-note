/**
 * Electron 打包发布脚本（遵循用户偏好）：
 *   - 输出目录：C:\choyeon-note\v<version>  （C 盘项目名文件夹 / 版本子目录）
 *   - 使用 gh CLI 在 GitHub Releases 上创建/更新 tag = v<version>
 *   - 上传 nsis 安装包（exe）+ latest.yml，确保 electron-updater 能正常增量更新
 *
 * 依赖：
 *   - 已经通过 gh auth login（或 GH_TOKEN 环境变量）
 *   - 可选：HTTP_PROXY / HTTPS_PROXY （在脚本执行前已设则自动继承）
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

const packageJson = require('../package.json')
const version = packageJson.version

// ======== 1. 目录：C 盘项目名 / 版本子目录 ========
const rootDir = 'C:/choyeon-note'
const outputDir = `${rootDir}/v${version}`
const versionTag = `v${version}`

console.log(`📦 构建 Choyeon Note v${version}`)
console.log(`📂 输出目录: ${outputDir}`)
console.log()

if (!fs.existsSync(rootDir)) {
  console.log(`🪚 创建 C 盘项目根目录: ${rootDir}`)
  fs.mkdirSync(rootDir, { recursive: true })
}
fs.mkdirSync(outputDir, { recursive: true })

// ======== 2. Vite 构建（纯前端）========
console.log('🔨 运行 Vite 构建...')
execSync('vite build', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') })

// ======== 3. Electron Builder（生成安装包 + latest.yml，但不自动发布）========
console.log()
console.log('⚡ 运行 Electron Builder → 生成本地安装包...')
execSync(
  `electron-builder --win --x64 --config.directories.output="${outputDir}" --publish=never`,
  { stdio: 'inherit', cwd: path.resolve(__dirname, '..'), env: process.env }
)
console.log()

// ======== 4. 收集产物：latest.yml + 所有 exe（BlockMap 如有一并上传）========
const artifacts = []
const addIfExists = (f) => {
  const p = path.join(outputDir, f)
  if (fs.existsSync(p)) artifacts.push(p)
}
// electron-builder publish=github 时默认生成 latest.yml；publish=never 也会生成
addIfExists('latest.yml')
addIfExists(`Choyeon Note Setup ${version}.exe`)
addIfExists(`Choyeon Note Setup ${version}.exe.blockmap`)
// artifactName 未配置时的备选名（兼容不同 electron-builder 版本）
const exeGlob = fs.readdirSync(outputDir).filter(f => f.endsWith('.exe'))
exeGlob.forEach(f => {
  const full = path.join(outputDir, f)
  if (!artifacts.includes(full)) artifacts.push(full)
  const bm = full + '.blockmap'
  if (fs.existsSync(bm) && !artifacts.includes(bm)) artifacts.push(bm)
})

if (artifacts.length === 0) {
  console.error('❌ 未找到任何构建产物，终止发布。请检查 electron-builder 日志。')
  process.exit(2)
}
console.log('📦 发布产物列表:')
artifacts.forEach(a => console.log('   - ' + a))

// ======== 5. 使用 gh CLI 创建/更新 GitHub Release，并上传 latest.yml + 安装包 ========
console.log()
console.log(`🌐 发布到 GitHub Releases: tag=${versionTag}`)
const projectRoot = path.resolve(__dirname, '..')

// 检查 gh 是否可用
try {
  execSync('gh --version', { stdio: 'ignore', cwd: projectRoot })
} catch (_) {
  console.error('❌ 未找到 gh CLI。请先安装并 `gh auth login`。')
  process.exit(3)
}

// 检查当前 tag 是否已存在 release
let releaseExists = false
try {
  const out = execSync(`gh release view ${versionTag} --json tagName`, {
    encoding: 'utf8', cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore']
  })
  releaseExists = out && out.includes(versionTag)
} catch (_) { /* release 不存在 */ }

const quotedArtifacts = artifacts.map(a => `"${a}"`).join(' ')
if (releaseExists) {
  // 已存在：上传覆盖（先删除同名 assets 再上传，避免冲突）
  console.log(`🪛 release ${versionTag} 已存在，上传/覆盖 assets...`)
  // 先列出现有 assets 名称
  let existingAssets = []
  try {
    const out = execSync(`gh release view ${versionTag} --json assets`, { encoding: 'utf8', cwd: projectRoot })
    const data = JSON.parse(out || '{}')
    existingAssets = Array.isArray(data.assets) ? data.assets.map(a => a.name) : []
  } catch (_) {}
  for (const artifact of artifacts) {
    const base = path.basename(artifact)
    if (existingAssets.includes(base)) {
      try {
        execSync(`gh release delete-asset -y ${versionTag} "${base}"`, {
          stdio: 'inherit', cwd: projectRoot
        })
      } catch (_) { /* 忽略；某些权限情况需要手动 */ }
    }
  }
  execSync(`gh release upload --clobber ${versionTag} ${quotedArtifacts}`, {
    stdio: 'inherit', cwd: projectRoot, env: process.env
  })
  // 若不是 latest，标记为 latest（electron-updater 默认从 latest.yml 识别；这里确保 release 页面 = latest）
  try {
    execSync(`gh release edit ${versionTag} --latest`, { stdio: 'inherit', cwd: projectRoot })
  } catch (_) {}
} else {
  // 不存在：创建 release，并上传 assets + 标记 latest
  console.log(`✨ 新建 release ${versionTag}...`)
  const notes =
`## Choyeon Note v${version}

### 主要变更
- Obsidian 编辑器深度对标：WikiLinks / 嵌入 / Callouts / Properties / YAML frontmatter
- 反向链接 / 出站链接 / 大纲 / 属性 四合一右栏 Tabs
- 全局命令面板 Ctrl+Shift+P 与快速切换器 Ctrl+O/K
- 侧边栏文件夹树：拖放移动、右键菜单、内联重命名
- 快捷键 / 菜单 / 状态自洽，无静默失败 stub
- 关键逻辑修复：noteStore 漏导出 17 方法、DnD 共享上下文、moveFile IPC 原子操作

### 安装 / 自动更新
- 首次安装请下载 \`Choyeon Note Setup ${version}.exe\` 并运行
- 已有安装包可通过应用内「检查更新」自动升级，最新版本信息见 \`latest.yml\`
`
  const notesFile = path.join(outputDir, '.release-notes.md')
  fs.writeFileSync(notesFile, notes, 'utf-8')
  execSync(
    `gh release create ${versionTag} --title "Choyeon Note v${version}" --notes-file "${notesFile}" --latest ${quotedArtifacts}`,
    { stdio: 'inherit', cwd: projectRoot, env: process.env }
  )
}

console.log()
console.log(`🎉 构建+发布完成！`)
console.log(`📂 本地产物: ${outputDir}`)
console.log(`🌐 GitHub Release: https://github.com/Choyeon/choyeon-note/releases/tag/${versionTag}`)
