const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const sizes = [
  { size: 16, name: '16x16' },
  { size: 24, name: '24x24' },
  { size: 32, name: '32x32' },
  { size: 48, name: '48x48' },
  { size: 64, name: '64x64' },
  { size: 128, name: '128x128' },
  { size: 256, name: '256x256' },
  { size: 512, name: '512x512' },
  { size: 1024, name: '1024x1024' }
]

const icoSizes = [16, 24, 32, 48, 64, 128, 256]

const inputPath = process.argv[2] || path.join(__dirname, '..', 'build', 'icons', 'source.png')
const outputDir = path.join(__dirname, '..', 'build', 'icons')

async function generateIco(pngBuffers, outputPath) {
  const iconCount = pngBuffers.length
  const headerSize = 6
  const entrySize = 16
  const dirSize = headerSize + entrySize * iconCount
  
  const iconDataOffsets = []
  let dataOffset = dirSize
  
  const iconImages = []
  for (const buf of pngBuffers) {
    iconImages.push(buf)
    iconDataOffsets.push(dataOffset)
    dataOffset += buf.length
  }
  
  const totalSize = dataOffset
  const buffer = Buffer.alloc(totalSize)
  
  buffer.writeUInt16LE(0, 0)
  buffer.writeUInt16LE(1, 2)
  buffer.writeUInt16LE(iconCount, 4)
  
  let offset = 6
  for (let i = 0; i < iconCount; i++) {
    const imgBuf = iconImages[i]
    const img = await sharp(imgBuf).metadata()
    const width = img.width >= 256 ? 0 : img.width
    const height = img.height >= 256 ? 0 : img.height
    
    buffer.writeUInt8(width, offset)
    buffer.writeUInt8(height, offset + 1)
    buffer.writeUInt8(0, offset + 2)
    buffer.writeUInt8(0, offset + 3)
    buffer.writeUInt16LE(1, offset + 4)
    buffer.writeUInt16LE(32, offset + 6)
    buffer.writeUInt32LE(imgBuf.length, offset + 8)
    buffer.writeUInt32LE(iconDataOffsets[i], offset + 12)
    offset += entrySize
  }
  
  for (let i = 0; i < iconCount; i++) {
    iconImages[i].copy(buffer, iconDataOffsets[i])
  }
  
  fs.writeFileSync(outputPath, buffer)
}

async function generateIcons() {
  console.log('📱 正在生成应用图标...')
  console.log('📂 输入文件:', inputPath)
  console.log('📂 输出目录:', outputDir)

  if (!fs.existsSync(inputPath)) {
    console.error('❌ 错误：找不到输入文件:', inputPath)
    console.log('💡 请将源图标放置在 build/icons/icon.png，或通过命令行参数指定路径')
    process.exit(1)
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const metadata = await sharp(inputPath).metadata()
  console.log('✅ 源图片加载成功，尺寸:', metadata.width + 'x' + metadata.height)

  for (const { size, name } of sizes) {
    const outputPath = path.join(outputDir, `icon-${name}.png`)
    await sharp(inputPath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath)
    console.log(`  ✅ 生成 icon-${name}.png`)
  }

  console.log('🖼️  正在生成 icon.ico (Windows 图标)...')
  
  const icoPngBuffers = []
  for (const size of icoSizes) {
    const buf = await sharp(inputPath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    icoPngBuffers.push(buf)
  }
  
  const icoPath = path.join(outputDir, 'icon.ico')
  await generateIco(icoPngBuffers, icoPath)
  console.log('  ✅ 生成 icon.ico')

  console.log('🖼️  正在生成 icon.png (主图标 512x512)...')
  const mainIconPath = path.join(outputDir, 'icon.png')
  await sharp(inputPath)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(mainIconPath)
  console.log('  ✅ 生成 icon.png (512x512)')

  console.log('📱 生成 macOS 图标 (icon-1024x1024.png)')
  console.log('  ✅ macOS 图标准备完成')

  console.log('\n🎉 所有图标生成完成！')
  console.log('📂 输出目录:', outputDir)
  console.log('📋 生成的文件:')
  console.log('   - icon.png (512x512, 主图标)')
  console.log('   - icon.ico (Windows 安装包图标)')
  for (const { name } of sizes) {
    console.log(`   - icon-${name}.png`)
  }
}

generateIcons().catch(err => {
  console.error('❌ 生成图标失败:', err)
  process.exit(1)
})
