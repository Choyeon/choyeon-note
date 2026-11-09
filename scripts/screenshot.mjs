// 真实 Electron + CDP 截图脚本
// 自启 vite dev server(5176) 与真实 Electron(remote-debugging)，逐页截图到 docs/screenshots/
// 用法: node scripts/screenshot.mjs
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEV_URL = 'http://localhost:5176'
const CDP_PORT = 9223
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(2500, () => {
      req.destroy()
      reject(new Error('http timeout'))
    })
  })
}

async function waitForServer(url, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpGet(url)
      if (r.status === 200) {
        console.log(`✓ ${label} ready`)
        return
      }
    } catch {
      /* keep polling */
    }
    await wait(500)
  }
  throw new Error(`${label} not ready: ${url}`)
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ws.on('message', (d) => this._onMessage(d))
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
    })
  }
  _onMessage(data) {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

async function getTargets() {
  const r = await httpGet(`http://localhost:${CDP_PORT}/json`)
  return JSON.parse(r.body)
}

async function findPageTarget() {
  const start = Date.now()
  while (Date.now() - start < 60000) {
    try {
      const targets = await getTargets()
      const page = targets.find(
        (t) => t.type === 'page' && t.url && t.url.includes('localhost:5176')
      )
      if (page && page.webSocketDebuggerUrl) return page
    } catch {
      /* keep polling */
    }
    await wait(500)
  }
  throw new Error('page target not found')
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log('▶ starting vite dev server...')
  const vite = spawn(
    'node',
    ['node_modules/vite/bin/vite.js', '--port', '5176', '--strictPort'],
    { cwd: ROOT, env: cleanEnv({ CODEBUDDY_SAFE_DELETE_ENABLED: '0' }), stdio: 'ignore' }
  )

  await waitForServer(DEV_URL, 90000, 'vite dev server')

  console.log('▶ starting electron...')
  const electron = spawn(
    'node',
    ['node_modules/electron/cli.js', '.', '--remote-debugging-port=' + CDP_PORT],
    { cwd: ROOT, env: cleanEnv(), stdio: 'ignore' }
  )

  const target = await findPageTarget()
  console.log('✓ electron page target found:', target.url)
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 初次加载应用
  await cdp.send('Page.navigate', { url: DEV_URL + '/' })
  await wait(2500)

  async function setupMode(theme) {
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('choyeon-notes-location','sample');localStorage.setItem('choyeon-theme','${theme}');localStorage.setItem('choyeon-editor-mode','edit');'ok'`,
      returnByValue: true
    })
    await cdp.send('Page.reload')
    await wait(2000)
  }

  async function goto(hash) {
    await cdp.send('Runtime.evaluate', {
      expression: `location.hash = '#${hash}'; 'ok'`,
      returnByValue: true
    })
    await wait(1400)
  }

  async function clickLive() {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const b = [...document.querySelectorAll('.segment-btn')].find(x => x.title && x.title.includes('实时预览')); if (b) b.click(); return !!b; })()`,
      returnByValue: true
    })
    await wait(1200)
  }

  async function shot(name) {
    const res = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })
    const out = path.join(OUT_DIR, name + '.png')
    fs.writeFileSync(out, Buffer.from(res.data, 'base64'))
    const size = fs.statSync(out).size
    console.log(`  📸 ${name}.png (${size} bytes)`)
  }

  // ===== 浅色主题 =====
  console.log('▶ light theme')
  await setupMode('light')
  await goto('/welcome')
  await shot('light-welcome')
  await goto('/notes')
  await shot('light-notes')
  await goto('/editor')
  await clickLive()
  await shot('light-editor-live')
  await goto('/graph')
  await shot('light-graph')
  await goto('/calendar')
  await shot('light-calendar')
  await goto('/settings')
  await shot('light-settings')
  await goto('/vault')
  await shot('light-vault')
  await goto('/tags')
  await shot('light-tags')

  // ===== 暗色主题 =====
  console.log('▶ dark theme')
  await setupMode('dark')
  await goto('/editor')
  await clickLive()
  await shot('dark-editor-live')
  await goto('/welcome')
  await shot('dark-welcome')
  await goto('/settings')
  await shot('dark-settings')

  cdp.close()
  try {
    electron.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  try {
    vite.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  console.log('✓ done. screenshots in', OUT_DIR)
}

main().catch((err) => {
  console.error('Screenshot failed:', err)
  process.exit(1)
})
