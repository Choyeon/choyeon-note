#!/usr/bin/env node
// ============================================================================
// 发布后校验：GitHub Release 上的资产是否真的能支撑 electron-updater
// ----------------------------------------------------------------------------
// 为什么必须有这个脚本：
//   v1.0.0 那次发布，release 上确实有 latest.yml，但里面写的
//     url/path: Choyeon-Note-Setup-1.0.0.exe
//   而实际上传的资产名是
//     Choyeon.Note.Setup.1.0.0.exe      （点号，NSIS 默认命名）
//   electron-updater 拿着 latest.yml 的名字去
//     https://github.com/<owner>/<repo>/releases/latest/download/<name>
//   拉包 → 404 → 界面上就只剩「更新失败」四个字，看不出是文件名对不上。
//
//   只要有 latest.yml 就算「更新配置存在」是自欺：名字对不上等于没有。
//   这个脚本把「名字必须对得上」变成一条可执行的闸门。
//
// 用法：
//   node scripts/verify-release-update.mjs                 # 校验 latest release
//   node scripts/verify-release-update.mjs --tag v1.1.0    # 校验指定 tag
//   node scripts/verify-release-update.mjs --local         # 只校验本地 dist-electron
//
// 退出码：0 = 通过；1 = 有不通过项（CI 可用它卡发布）
// ============================================================================

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const args = process.argv.slice(2)
const localOnly = args.includes('--local')
const tagArg = (() => {
  const i = args.indexOf('--tag')
  return i >= 0 ? args[i + 1] : ''
})()

const REPO = readRepoFromPackage()
// 默认 dist-electron；目录被占用（残留 win-unpacked 会 EPERM）而改过输出目录时用 --dir 指过去
const DIST_ELECTRON = (() => {
  const i = args.indexOf('--dir')
  return i >= 0 ? join(ROOT, args[i + 1]) : join(ROOT, 'dist-electron')
})()

/** latest*.yml 里 electron-updater 真正会去下载的字段 */
const UPDATE_MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']

const results = []
function check (name, ok, detail = '') {
  results.push({ name, ok, detail })
  return ok
}

function readRepoFromPackage () {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const p = pkg.build && pkg.build.publish
  if (!p || p.provider !== 'github') {
    fail(`package.json 的 build.publish 不是 github provider（当前：${JSON.stringify(p || null)}）`)
  }
  return { owner: p.owner, repo: p.repo }
}

function fail (msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

/** 极简 YAML 读取：只取 latest*.yml 需要的字段，不引第三方依赖 */
function parseUpdateManifest (text) {
  const out = { version: '', path: '', files: [] }
  let inFiles = false
  let cur = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    if (/^files:\s*$/.test(line)) { inFiles = true; continue }
    if (inFiles && /^\s*-\s*url:/.test(line)) {
      cur = { url: line.replace(/^\s*-\s*url:\s*/, '').trim() }
      out.files.push(cur)
      continue
    }
    if (inFiles && /^\s*sha512:\s*/.test(line)) {
      const v = line.replace(/^\s*sha512:\s*/, '').trim()
      if (cur) cur.sha512 = v; else out.sha512 = v
      continue
    }
    if (inFiles && /^\s*size:\s*/.test(line)) {
      const v = line.replace(/^\s*size:\s*/, '').trim()
      if (cur) cur.size = Number(v)
      continue
    }
    // 顶层键（缩进为 0）
    if (/^\S/.test(line)) {
      inFiles = false
      cur = null
      const m = line.match(/^(version|path|sha512|releaseDate):\s*(.*)$/)
      if (m) {
        const v = m[2].replace(/^['"]|['"]$/g, '')
        if (m[1] === 'version') out.version = v
        else if (m[1] === 'path') out.path = v
        else if (m[1] === 'sha512') out.sha512 = v
        else out.releaseDate = v
      }
    }
  }
  return out
}

function ghJson (cmdArgs) {
  const out = execFileSync('gh', cmdArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(out || '{}')
}

// ---------------------------------------------------------------------------
// 1) 本地产物自检
// ---------------------------------------------------------------------------
function verifyLocal () {
  console.log('\n── 本地产物（dist-electron）────────────────────────────')

  if (!existsSync(DIST_ELECTRON)) {
    fail(`找不到 ${DIST_ELECTRON}，先跑 npm run electron:build:win`)
  }

  const entries = readdirSync(DIST_ELECTRON)
  const manifests = entries.filter((n) => UPDATE_MANIFESTS.includes(n))

  check(
    '至少生成一个 latest*.yml',
    manifests.length > 0,
    manifests.length ? manifests.join(', ') : `目录里只有：${entries.slice(0, 8).join(', ')}`
  )
  if (!manifests.length) return []

  const localAssets = new Set(entries)
  const parsed = []

  for (const name of manifests) {
    const text = readFileSync(join(DIST_ELECTRON, name), 'utf8')
    const m = parseUpdateManifest(text)

    check(`${name} 含 version 字段`, Boolean(m.version), m.version)
    check(`${name} 含 path 字段`, Boolean(m.path), m.path)

    // path 指向的文件必须真的存在于同一目录 —— 这是 v1.0.0 踩的坑的本地版
    if (m.path) {
      check(
        `${name} 的 path 在本地产物中存在`,
        localAssets.has(m.path),
        localAssets.has(m.path) ? m.path : `latest.yml 写的是「${m.path}」，本地没有同名文件`
      )
    }
    for (const f of m.files) {
      check(
        `${name} 的 files[].url 在本地产物中存在`,
        localAssets.has(f.url),
        localAssets.has(f.url) ? f.url : `url「${f.url}」本地没有同名文件`
      )
    }
    parsed.push({ name, manifest: m })
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 2) GitHub Release 侧校验（核心：名字必须对得上）
// ---------------------------------------------------------------------------
function verifyRemote (tag) {
  console.log(`\n── GitHub Release（${REPO.owner}/${REPO.repo} @ ${tag}）────────`)

  let release
  try {
    release = ghJson(['release', 'view', tag, '--repo', `${REPO.owner}/${REPO.repo}`, '--json', 'tagName,isLatest,isDraft,isPrerelease,assets'])
  } catch (e) {
    fail(`读取 release ${tag} 失败：${e.message}\n（确认已 gh auth login，且该 tag 的 release 已创建）`)
  }

  check(`release ${tag} 不是草稿`, release.isDraft === false, `isDraft=${release.isDraft}`)
  check(`release ${tag} 不是预发布`, release.isPrerelease === false, `isPrerelease=${release.isPrerelease}`)
  // electron-updater 走 .../releases/latest/download/...，非 latest 的 release 取不到
  check(`release ${tag} 是 Latest`, release.isLatest === true, `isLatest=${release.isLatest}`)

  const assets = release.assets || []
  const assetNames = new Set(assets.map((a) => a.name))
  console.log(`   release 资产（${assets.length}）：${assets.map((a) => a.name).join(', ')}`)

  const remoteManifests = assets.filter((a) => UPDATE_MANIFESTS.includes(a.name))
  check(
    'release 上包含 latest*.yml',
    remoteManifests.length > 0,
    remoteManifests.length ? remoteManifests.map((a) => a.name).join(', ') : '一个都没有 —— 更新链路必然断'
  )
  if (!remoteManifests.length) return

  for (const a of remoteManifests) {
    const outDir = join(ROOT, 'tmp', 'verify-release')
    let text = ''
    try {
      execFileSync(
        'gh',
        ['release', 'download', tag, '--repo', `${REPO.owner}/${REPO.repo}`, '--pattern', a.name, '--dir', outDir, '--clobber'],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
      )
      text = readFileSync(join(outDir, a.name), 'utf8')
    } catch (e) {
      check(`能下载 ${a.name}`, false, e.message)
      continue
    }

    const m = parseUpdateManifest(text)
    check(`${a.name} 含 version 字段`, Boolean(m.version), m.version)
    check(`${a.name} 含 path 字段`, Boolean(m.path), m.path)

    if (!m.path) continue

    // ★ 本次事故的核心断言：latest.yml 里写的名字必须能在 release 资产里找到
    check(
      `${a.name} 的 path 在 release 资产中存在`,
      assetNames.has(m.path),
      assetNames.has(m.path)
        ? m.path
        : `latest.yml 写「${m.path}」，release 上却没有这个资产（实际：${[...assetNames].join(', ')}）`
    )

    for (const f of m.files) {
      check(
        `${a.name} 的 files[].url 在 release 资产中存在`,
        assetNames.has(f.url),
        assetNames.has(f.url) ? f.url : `url「${f.url}」不在 release 资产里`
      )
    }
  }

  // 额外：确认 release 里确实有安装包本体（不然 latest.yml 指谁都没用）
  const installer = assets.find((a) => /\.exe$|\.dmg$|\.AppImage$|\.deb$/.test(a.name))
  check('release 上包含安装包本体', Boolean(installer), installer ? installer.name : '没有 exe/dmg/AppImage/deb')
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
function report () {
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  console.log('\n── 校验结果 ────────────────────────────────────────────')
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  → ${r.detail}` : ''}`)
  }
  console.log(`\n通过 ${passed} / 共 ${results.length}`)

  if (failed.length) {
    console.error(`\n✗ 发布校验未通过（${failed.length} 项）。更新链路不可用，请勿对外宣布版本。`)
    process.exit(1)
  }
  console.log('\n✓ 发布校验通过：electron-updater 能按 latest*.yml 找到真实资产。')
}

const localParsed = verifyLocal()
if (localOnly) {
  report()
} else {
  const tag = tagArg || `v${localParsed[0]?.manifest.version || ''}`
  if (!tag || tag === 'v') fail('推不出 tag：--tag 未给，且本地 latest*.yml 没有 version 字段')
  verifyRemote(tag)
  report()
}
