#!/usr/bin/env node
// ============================================================================
// 打包前闸门：dist/ 必须是「刚刚由当前源码构建出来的」
// ----------------------------------------------------------------------------
// 为什么需要：
//   vite build 清空 outDir 时如果被拦（本项目环境里 outDir 有上百个文件，
//   会撞上批量删除闸门），`dist/` **不会被更新，但构建命令的失败很容易被忽略** ——
//   紧接着的 electron-builder 照样成功，把上一版的前端代码打进新安装包。
//   结果是：安装包版本号是新的，里面的界面却是旧的，
//   而且「vite build 通过 / 单元测试通过」都发现不了。
//
//   这条闸门只回答一个问题：dist/index.html 是不是比所有源码都新。
//
// 用法：
//   node scripts/check-dist-fresh.mjs            # 用默认输入范围
//   node scripts/check-dist-fresh.mjs --quiet    # 只在失败时输出
//
// 退出码：0 = dist 是最新的；1 = dist 缺失或比源码旧（不要继续打包）
// ============================================================================

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')

/** 参与构建的源码入口：这些目录/文件任意一个比 dist 新，都说明 dist 是旧的 */
const SOURCE_ROOTS = [
  'src',
  'electron',
  'index.html',
  'package.json',
  'vite.config.js',
  'vite.config.mjs'
]

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.vue', '.json', '.html', '.css'])

function newestSourceMtime () {
  let newest = 0
  let newestPath = ''

  const walk = (abs) => {
    let st
    try {
      st = statSync(abs)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        // 只看构建输入，跳过 node_modules 之类的干扰
        if (name === 'node_modules' || name === '.git') continue
        walk(join(abs, name))
      }
      return
    }
    if (!SOURCE_EXT.has(extname(abs).toLowerCase())) return
    if (st.mtimeMs > newest) {
      newest = st.mtimeMs
      newestPath = abs
    }
  }

  for (const rel of SOURCE_ROOTS) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    walk(abs)
  }
  return { mtime: newest, path: newestPath }
}

const distIndex = join(ROOT, 'dist', 'index.html')
if (!existsSync(distIndex)) {
  console.error('✗ dist/index.html 不存在 —— 先跑 vite build，不要打包。')
  process.exit(1)
}

const distMtime = statSync(distIndex).mtimeMs
const src = newestSourceMtime()

// 1 秒容差：文件系统时间戳精度与并行写入会造成毫秒级抖动
const TOLERANCE_MS = 1000
const stale = src.mtime > distMtime + TOLERANCE_MS

const relSrc = src.path ? src.path.replace(ROOT + '\\', '').replace(ROOT + '/', '') : '(无)'

if (stale) {
  console.error('✗ dist/ 比源码旧，它很可能是**上一次构建失败后的残留**。')
  console.error(`    最新源码：${relSrc}`)
  console.error(`    源码时间：${new Date(src.mtime).toISOString()}`)
  console.error(`    dist 时间：${new Date(distMtime).toISOString()}`)
  console.error('  继续打包会把旧界面打进新版本安装包。请先确认 vite build 真的成功。')
  process.exit(1)
}

if (!quiet) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  console.log(`✓ dist/ 是最新的（version ${pkg.version}，dist 时间 ${new Date(distMtime).toISOString()}）`)
}
