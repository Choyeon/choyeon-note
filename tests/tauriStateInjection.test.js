/**
 * Tauri 状态注入守卫。
 *
 * 根因回溯：`init_state()` 用 `app.manage(Arc<AppState>)` 托管状态，但命令签名曾写成
 * `State<'_, AppState>`。Tauri 按精确类型查找，于是所有带状态的 IPC（选择目录、
 * 文件读写、日志、设置、更新）在运行时报 `state not managed`，而只有无状态的
 * `app_get_version` 正常——表现为欢迎页前两个卡片点了没反应。
 *
 * 这个守卫用源码级断言钉住「托管类型 = 命令声明类型」，避免以后只改其中一侧。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), 'src-tauri', 'src')
const rustFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.rs'))
const allSource = rustFiles.map((f) => fs.readFileSync(path.join(SRC, f), 'utf-8')).join('\n')

describe('Tauri 命令状态注入', () => {
  it('不再出现 State<AppState>：托管的是 Arc<AppState>', () => {
    expect(allSource).not.toContain("State<'_, AppState>")
  })

  it('init_state 用 Arc<AppState> 托管，并保留共享句柄', () => {
    const commands = fs.readFileSync(path.join(SRC, 'commands.rs'), 'utf-8')
    expect(commands).toContain('app.manage(state.clone())')
    expect(commands).toContain('SHARED_STATE.set(state)')
  })

  it('带状态的命令确实声明 State<Arc<AppState>>', () => {
    expect(allSource).toContain("State<'_, Arc<AppState>>")
    const affected = ['fs_commands.rs', 'settings.rs', 'logging.rs', 'system.rs', 'trash.rs']
    for (const file of affected) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf-8')
      expect(src, `${file} 应声明 State<Arc<AppState>>`).toContain("State<'_, Arc<AppState>>")
    }
  })
})
