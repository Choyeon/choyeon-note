//! Window controls, native menu, Bing wallpaper, auto-update and the
//! quit-time flush handshake.

use std::{
    io::Write,
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex},
    thread,
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

use crate::state::AppState;

static UPDATE_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[tauri::command]
pub fn window_minimize(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn window_maximize(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn window_is_maximized(app: tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_maximized().ok())
        .unwrap_or(false)
}

#[tauri::command]
pub fn app_get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Build the same menu tree Electron had, but let the renderer's shortcut
/// registry stay the single source of truth for key bindings.
#[allow(dead_code)]
pub fn build_menu(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "new-note", "新建笔记", true, None::<&str>)?,
            &MenuItem::with_id(app, "open", "打开文件夹", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "save", "保存", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("退出"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &MenuItem::with_id(app, "undo", "撤销", true, None::<&str>)?,
            &MenuItem::with_id(app, "redo", "重做", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(app, "select-all", "全选", true, None::<&str>)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &MenuItem::with_id(app, "toggle-sidebar", "切换侧栏", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::separator(app)?,
        ],
    )?;
    let tools = Submenu::with_items(
        app,
        "工具",
        true,
        &[
            &MenuItem::with_id(app, "search", "搜索", true, Some("CmdOrCtrl+P"))?,
            &MenuItem::with_id(app, "command-palette", "命令面板", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", "切换主题", true, None::<&str>)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "帮助",
        true,
        &[&MenuItem::with_id(app, "about", "关于 Choyeon Note", true, None::<&str>)?],
    )?;

    let menu = Menu::with_items(app, &[&file, &edit, &view, &tools, &window_menu, &help])?;
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        let mapped = match id {
            "new-note" => Some("menu:new-note"),
            "open" => Some("menu:open"),
            "save" => Some("menu:save"),
            "toggle-sidebar" => Some("menu:toggle-sidebar"),
            "search" => Some("menu:search"),
            "command-palette" => Some("menu:command-palette"),
            "toggle-theme" => Some("menu:toggle-theme"),
            _ => None,
        };
        if let Some(event_name) = mapped {
            let _ = _app.emit(event_name, ());
        }
    });
    menu.set_as_app_menu()?;
    Ok(())
}

const BING_MARKETS: [&str; 2] = ["zh-CN", "en-US"];

#[tauri::command]
pub fn bing_fetch_wallpaper(market: Option<String>) -> Value {
    let requested = market.filter(|m| !m.is_empty()).unwrap_or_else(|| "zh-CN".to_string());
    let mut markets = vec![requested.clone()];
    for m in BING_MARKETS {
        if m != requested {
            markets.push(m.to_string());
        }
    }
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let mut last_error = String::new();
    for mkt in markets {
        let url = format!(
            "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt={}",
            mkt
        );
        let response = client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .header("Accept", "application/json")
            .send();
        let data = match response.and_then(|r| r.error_for_status()).and_then(|r| r.json::<Value>()) {
            Ok(d) => d,
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        };
        let image = data.get("images").and_then(|v| v.get(0));
        let image_url = image
            .and_then(|i| i.get("url"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let image_url = match image_url {
            Some(u) => u,
            None => {
                last_error = "接口未返回图片地址".to_string();
                continue;
            }
        };
        let full_url = if image_url.starts_with("http://") || image_url.starts_with("https://") {
            image_url.to_string()
        } else {
            format!("https://www.bing.com{}", image_url)
        };
        return json!({
            "url": full_url,
            "title": image.and_then(|i| i.get("title")).and_then(|v| v.as_str()).unwrap_or(""),
            "copyright": image.and_then(|i| i.get("copyright")).and_then(|v| v.as_str()).unwrap_or(""),
            "date": image.and_then(|i| i.get("startdate")).and_then(|v| v.as_str()).unwrap_or(""),
            "market": mkt,
        });
    }
    json!({ "error": if last_error.is_empty() { "获取 Bing 壁纸失败" } else { &last_error } })
}

fn updater_error(err: &reqwest::Error) -> Value {
    json!({
        "message": err.to_string(),
        "code": err.status().map(|s| s.as_str().to_string()).unwrap_or_default(),
        "name": "Error",
    })
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

fn version_newer(latest: &str, current: &str) -> bool {
    let a = version_parts(latest);
    let b = version_parts(current);
    for i in 0..a.len().max(b.len()) {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av > bv {
            return true;
        }
        if av < bv {
            return false;
        }
    }
    false
}

#[tauri::command]
pub fn check_for_updates(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Value {
    state.emit("updater:checking", ());
    if state.update_in_flight.swap(true, Ordering::SeqCst) {
        return json!({ "ok": true, "skipped": true });
    }
    let current = app.package_info().version.to_string();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("choyeon-note-updater")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            let detail = json!({ "message": e.to_string(), "code": "", "name": "Error" });
            state.emit("updater:error", detail.clone());
            state.update_in_flight.store(false, Ordering::SeqCst);
            return json!({ "ok": false, "error": e.to_string(), "code": "" });
        }
    };
    let result = client
        .get("https://api.github.com/repos/Choyeon/choyeon-note/releases/latest")
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json::<Value>());
    match result {
        Ok(release) => {
            let version = release
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // electron-updater's UpdateInfo always carries `version`; the
            // renderer reads `data.version` for the toast. GitHub's release
            // object only has `tag_name`, so add the field explicitly.
            let mut info = release.clone();
            if let Some(map) = info.as_object_mut() {
                map.insert("version".to_string(), json!(version.trim_start_matches('v')));
            }
            if version_newer(&version, &current) {
                state.emit("updater:update-available", info.clone());
            } else {
                state.emit("updater:update-not-available", info.clone());
            }
            let out = json!({ "ok": true });
            state.update_in_flight.store(false, Ordering::SeqCst);
            out
        }
        Err(e) => {
            let detail = updater_error(&e);
            state.emit("updater:error", detail.clone());
            let out = json!({
                "ok": false,
                "error": detail.get("message").cloned().unwrap_or(json!("")),
                "code": detail.get("code").cloned().unwrap_or(json!("")),
            });
            state.update_in_flight.store(false, Ordering::SeqCst);
            out
        }
    }
}

#[tauri::command]
pub fn download_update(state: State<'_, Arc<AppState>>) -> Value {
    #[cfg(target_os = "windows")]
    let asset_hint = ".exe";
    #[cfg(target_os = "macos")]
    let asset_hint = ".dmg";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let asset_hint = ".AppImage";

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("choyeon-note-updater")
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e.to_string(), "code": "" }),
    };
    let release: Value = match client
        .get("https://api.github.com/repos/Choyeon/choyeon-note/releases/latest")
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
    {
        Ok(v) => v,
        Err(e) => {
            let detail = updater_error(&e);
            state.emit("updater:error", detail.clone());
            return json!({ "ok": false, "error": e.to_string(), "code": "" });
        }
    };
    let asset = release
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|assets| {
            assets
                .iter()
                .find(|a| {
                    a.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| n.ends_with(asset_hint))
                        .unwrap_or(false)
                })
                .or_else(|| assets.first())
        });
    let (url, name) = match asset
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|v| v.as_str())
    {
        Some(u) => (
            u.to_string(),
            asset
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("update")
                .to_string(),
        ),
        None => return json!({ "ok": false, "error": "没有可用的安装包", "code": "not-found" }),
    };
    let response = match client.get(&url).send().and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(e) => {
            let detail = updater_error(&e);
            state.emit("updater:error", detail);
            return json!({ "ok": false, "error": e.to_string(), "code": "" });
        }
    };
    let total = response.content_length().unwrap_or(0);
    let target = std::env::temp_dir().join(name);
    let mut file = match std::fs::File::create(&target) {
        Ok(f) => f,
        Err(e) => return json!({ "ok": false, "error": e.to_string(), "code": "" }),
    };
    let mut transferred = 0u64;
    let mut reader = response;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = match std::io::Read::read(&mut reader, &mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return json!({ "ok": false, "error": e.to_string(), "code": "" }),
        };
        if file.write_all(&buffer[..read]).is_err() {
            return json!({ "ok": false, "error": "写入更新文件失败", "code": "" });
        }
        transferred += read as u64;
        let percent = if total > 0 {
            transferred as f64 / total as f64 * 100.0
        } else {
            0.0
        };
        state.emit(
            "updater:download-progress",
            json!({ "percent": percent, "transferred": transferred, "total": total }),
        );
    }
    *UPDATE_FILE.lock().unwrap() = Some(target.clone());
    state.emit("updater:update-downloaded", release);
    json!({ "ok": true })
}

#[tauri::command]
pub fn quit_and_install(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Value {
    let file = UPDATE_FILE.lock().unwrap().clone();
    let file = match file {
        Some(f) if f.exists() => f,
        _ => {
            let detail = json!({ "message": "尚未下载更新", "code": "", "name": "Error" });
            state.emit("updater:error", detail);
            return json!({ "ok": false, "error": "尚未下载更新", "code": "" });
        }
    };
    let result = std::process::Command::new(&file).arg("/S").spawn();
    match result {
        Ok(_) => {
            app.exit(0);
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string(), "code": "" }),
    }
}

/// Called from the Tauri close-request handler.
/// Frontend flushes synchronously in closeWindow() before invoking window_close;
/// this grace period only covers system-level closes (Alt+F4 / taskbar).
const FLUSH_GRACE_MS: u64 = 300;

pub fn request_flush(state: &AppState) {
    if state.flush.waiting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.emit("app:flush-all", ());
    let state_ref = crate::commands::shared_state();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(FLUSH_GRACE_MS));
        if let Some(state) = state_ref {
            if state.flush.waiting.swap(false, Ordering::SeqCst) {
                backend_log(
                    &state,
                    "ipc",
                    "info",
                    "关闭宽限期结束，退出",
                    Some(json!({ "graceMs": FLUSH_GRACE_MS })),
                );
                finish_exit(&state);
            }
        }
    });
}

pub(crate) fn resolve_flush(state: &AppState) {
    if state.flush.waiting.swap(false, Ordering::SeqCst) {
        finish_exit(state);
    }
}

fn finish_exit(state: &AppState) {
    crate::watch::stop_watching(state);
    if let Some(handle) = state.app_handle.lock().ok().and_then(|h| h.clone()) {
        handle.exit(0);
    }
}

fn backend_log(state: &AppState, module: &str, level: &str, msg: &str, data: Option<Value>) {
    crate::util::backend_log(state, module, level, msg, data);
}
