const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const packageJson = require('../package.json')
const version = packageJson.version

const outputDir = `C:/choyeon-note-builds/v${version}`

console.log(`📦 构建 Choyeon Note v${version}`)
console.log(`📂 输出目录: ${outputDir}`)
console.log()

if (!fs.existsSync('C:/choyeon-note-builds')) {
  fs.mkdirSync('C:/choyeon-note-builds', { recursive: true })
}

console.log('🔨 运行 Vite 构建...')
execSync('vite build', { stdio: 'inherit' })

console.log()
console.log('⚡ 运行 Electron Builder (发布到 GitHub Release)...')
execSync(`electron-builder --win --x64 --config.directories.output="${outputDir}" --publish=always`, {
  stdio: 'inherit',
  env: process.env
})

console.log()
console.log(`🎉 构建完成！`)
console.log(`📂 输出目录: ${outputDir}`)
