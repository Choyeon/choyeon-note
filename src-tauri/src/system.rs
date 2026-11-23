//! Window controls, auto-update and the quit-time flush handshake.

use std::{
    io::Write,
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex},
    thread,
    time::Duration,
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

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

/// A release asset name is attacker-controlled metadata. Reduce it to a plain
/// filename before joining it to any directory.
fn safe_asset_name(raw: &str) -> String {
    let name = raw.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(|c| c.is_control())
    {
        "update.exe".to_string()
    } else {
        name.to_string()
    }
}

/// GitHub release assets carry `digest: "sha256:<hex>"`.
/// NOTE: this is only a transport-integrity fallback against a corrupted or
/// truncated download. It is NOT a tamper-proof supply-chain guarantee, since
/// the digest comes from the same release metadata as the binary. Long term
/// this should be replaced by tauri-plugin-updater with signature verification.
fn parse_sha256_digest(raw: Option<&str>) -> Option<String> {
    let hex = raw?.strip_prefix("sha256:")?;
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
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
    let (url, name, expected_hex) = match asset {
        Some(a) => {
            let url = match a.get("browser_download_url").and_then(|v| v.as_str()) {
                Some(u) => u.to_string(),
                None => return json!({ "ok": false, "error": "没有可用的安装包", "code": "not-found" }),
            };
            let raw_name = a.get("name").and_then(|v| v.as_str()).unwrap_or("update");
            let expected_hex = match parse_sha256_digest(a.get("digest").and_then(|v| v.as_str())) {
                Some(hex) => hex,
                None => {
                    let detail = json!({
                        "message": "更新包缺少校验信息",
                        "code": "digest-missing",
                        "name": "Error",
                    });
                    state.emit("updater:error", detail);
                    return json!({ "ok": false, "error": "更新包缺少校验信息", "code": "digest-missing" });
                }
            };
            (url, safe_asset_name(raw_name), expected_hex)
        }
        None => return json!({ "ok": false, "error": "没有可用的安装包", "code": "not-found" }),
    };

    let updates_dir = std::env::temp_dir().join("choyeon-note-updates");
    if let Err(e) = std::fs::create_dir_all(&updates_dir) {
        state.emit("updater:error", json!({
            "message": e.to_string(), "code": "", "name": "Error",
        }));
        return json!({ "ok": false, "error": e.to_string(), "code": "" });
    }
    let updates_dir = std::fs::canonicalize(&updates_dir).unwrap_or(updates_dir);
    let target = updates_dir.join(&name);
    if !target.starts_with(&updates_dir) {
        state.emit("updater:error", json!({
            "message": "非法更新文件名", "code": "", "name": "Error",
        }));
        return json!({ "ok": false, "error": "非法更新文件名", "code": "" });
    }

    let response = match client.get(&url).send().and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(e) => {
            let detail = updater_error(&e);
            state.emit("updater:error", detail);
            return json!({ "ok": false, "error": e.to_string(), "code": "" });
        }
    };
    let total = response.content_length().unwrap_or(0);
    let mut file = match std::fs::File::create(&target) {
        Ok(f) => f,
        Err(e) => {
            state.emit("updater:error", json!({
                "message": e.to_string(), "code": "", "name": "Error",
            }));
            return json!({ "ok": false, "error": e.to_string(), "code": "" });
        }
    };
    let mut hasher = Sha256::new();
    let mut transferred = 0u64;
    let mut reader = response;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = match std::io::Read::read(&mut reader, &mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let _ = std::fs::remove_file(&target);
                state.emit("updater:error", json!({
                    "message": e.to_string(), "code": "", "name": "Error",
                }));
                return json!({ "ok": false, "error": e.to_string(), "code": "" });
            }
        };
        let chunk = &buffer[..read];
        hasher.update(chunk);
        if file.write_all(chunk).is_err() {
            let _ = std::fs::remove_file(&target);
            state.emit("updater:error", json!({
                "message": "写入更新文件失败", "code": "", "name": "Error",
            }));
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
    if let Err(e) = file.flush() {
        let _ = std::fs::remove_file(&target);
        state.emit("updater:error", json!({
            "message": e.to_string(), "code": "", "name": "Error",
        }));
        return json!({ "ok": false, "error": e.to_string(), "code": "" });
    }
    drop(file);

    let actual_hex = format!("{:x}", hasher.finalize());
    if actual_hex != expected_hex {
        let _ = std::fs::remove_file(&target);
        state.emit("updater:error", json!({
            "message": "更新包校验失败", "code": "digest-mismatch", "name": "Error",
        }));
        return json!({ "ok": false, "error": "更新包校验失败", "code": "digest-mismatch" });
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
/// Normally the renderer flushes synchronously and calls `flush_complete`
/// before exiting, so this grace period is only a fallback for system-level
/// closes (Alt+F4 / taskbar) where the renderer cannot acknowledge in time.
const FLUSH_GRACE_MS: u64 = 2000;

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
