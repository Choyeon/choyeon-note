//! Filesystem commands. Return shapes and failure contracts match the original
//! `fs:*` IPC handlers in `electron/main.cjs`.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{json, Value};
use tauri::State;

use crate::{
    state::AppState,
    util::backend_log,
    util::{
        canonicalize_clean, extension_of, io_failure, is_note_extension, path_failure,
        path_string, read_json, symlink_failure, validate_path_async,
    },
};

const MAX_SCAN_DEPTH: usize = 32;

/// `symlink_metadata` inspects the link itself instead of following it.
fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

pub(crate) fn apply_notes_path(state: &AppState, candidate: &str) -> bool {
    if candidate.trim().is_empty() {
        return false;
    }
    let resolved = crate::util::normalize_absolute(Path::new(candidate));
    if resolved.parent().is_none() {
        return false;
    }
    if !resolved.is_dir() {
        return false;
    }
    if let Some(home) = dirs::home_dir() {
        if canonicalize_clean(&resolved).ok() == canonicalize_clean(&home).ok() {
            return false;
        }
    }
    *state.notes_path.lock().unwrap() = Some(canonicalize_clean(&resolved).unwrap_or(resolved));
    state.save_settings();
    true
}

#[tauri::command]
pub fn app_select_notes_path(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let home = dirs::home_dir().unwrap_or_default().join("Documents");
    let folder = app
        .dialog()
        .file()
        .set_title("选择笔记存储文件夹")
        .set_directory(home)
        .blocking_pick_folder();
    let path = folder?.into_path().ok()?;
    let text = path_string(&path);
    if apply_notes_path(&state, &text) {
        state
            .notes_path
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|v| path_string(v)))
    } else {
        None
    }
}

#[tauri::command]
pub fn app_get_notes_path(state: State<'_, Arc<AppState>>) -> Option<String> {
    state
        .notes_path
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|v| path_string(v)))
}

#[tauri::command]
pub fn app_set_notes_path(state: State<'_, Arc<AppState>>, candidate: String) -> bool {
    apply_notes_path(&state, &candidate)
}

#[tauri::command]
pub fn fs_read_directory(state: State<'_, Arc<AppState>>, dir_path: String) -> Value {
    let safe = match validate_path_async(&state.notes_path.lock().unwrap(), &dir_path) {
        Ok(p) => p,
        Err(e) => {
            backend_log(&state, "ipc", "warn", "读取目录失败", Some(json!({ "op": "fs:read-directory", "errno": e.errno })));
            return json!([]);
        }
    };
    let entries = match fs::read_dir(&safe) {
        Ok(e) => e,
        Err(_) => return json!([]),
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let (size, mtime, ctime) = if file_type.is_dir() {
            (0u64, 0i64, 0i64)
        } else {
            match entry.metadata() {
                Ok(meta) => (
                    meta.len(),
                    meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                    meta.created()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                ),
                Err(_) => (0, 0, 0),
            }
        };
        result.push(json!({
            "name": name,
            "path": path_string(&path),
            "isDirectory": file_type.is_dir(),
            "isFile": file_type.is_file(),
            "extension": if file_type.is_file() { extension_of(&name) } else { String::new() },
            "size": size,
            "mtime": mtime,
            "ctime": ctime,
        }));
    }
    json!(result)
}

#[tauri::command]
pub fn fs_read_directory_recursive(state: State<'_, Arc<AppState>>, dir_path: String) -> Value {
    let safe = match validate_path_async(&state.notes_path.lock().unwrap(), &dir_path) {
        Ok(p) => p,
        Err(_) => return json!([]),
    };
    let mut result: Vec<Value> = Vec::new();

    fn walk(current: &Path, relative: &str, depth: usize, out: &mut Vec<Value>) {
        if depth > MAX_SCAN_DEPTH {
            return;
        }
        let entries = match fs::read_dir(current) {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut pending: Vec<(String, PathBuf, String, String)> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let rel = if relative.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", relative, name)
            };
            if file_type.is_dir() {
                walk(&path, &rel, depth + 1, out);
            } else if file_type.is_file() && is_note_extension(&name) {
                let ext = extension_of(&name);
                pending.push((name, path, rel, ext));
            }
        }
        for (name, path, rel, ext) in pending {
            if let Ok(meta) = fs::metadata(&path) {
                out.push(json!({
                    "name": name,
                    "path": path_string(&path),
                    "relativePath": rel,
                    "isDirectory": false,
                    "isFile": true,
                    "extension": ext,
                    "size": meta.len(),
                    "mtime": meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
                    "ctime": meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
                }));
            }
        }
    }

    walk(&safe, "", 0, &mut result);
    json!(result)
}

#[tauri::command]
pub fn fs_read_file(state: State<'_, Arc<AppState>>, file_path: String) -> Option<String> {
    let safe = validate_path_async(&state.notes_path.lock().unwrap(), &file_path).ok()?;
    match fs::read_to_string(safe) {
        Ok(s) => Some(s),
        Err(e) => {
            backend_log(&state, "ipc", "error", "读取文件失败", Some(json!({ "op": "fs:read-file", "error": e.to_string() })));
            None
        }
    }
}

#[tauri::command]
pub fn fs_read_files(state: State<'_, Arc<AppState>>, payload: Value) -> Value {
    let requested: Vec<String> = payload
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut files = Vec::new();
    let mut errors = Vec::new();
    let notes_guard = state.notes_path.lock().unwrap();
    for requested_path in requested {
        match validate_path_async(&notes_guard, &requested_path) {
            Ok(safe) => match fs::read_to_string(&safe) {
                Ok(content) => files.push(json!({ "path": path_string(&safe), "content": content })),
                Err(e) => errors.push(json!({ "path": requested_path, "error": e.to_string() })),
            },
            Err(e) => errors.push(json!({ "path": requested_path, "error": e.message })),
        }
    }
    drop(notes_guard);
    json!({ "ok": true, "files": files, "errors": errors })
}

#[tauri::command]
pub fn fs_write_file(
    state: State<'_, Arc<AppState>>,
    file_path: String,
    content: Value,
    options: Option<Value>,
) -> Value {
    let detail = options
        .as_ref()
        .and_then(|o| o.get("detail"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let text = match content.as_str() {
        Some(s) => s.to_string(),
        None => {
            let failure = json!({
                "ok": false, "error": "invalid-content", "errno": "EIO", "message": "content-not-string"
            });
            backend_log(&state, "ipc", "error", "写入文件失败：内容不是字符串", Some(json!({ "op": "fs:write-file", "path": file_path })));
            return if detail { failure } else { json!(false) };
        }
    };
    let safe = match validate_path_async(&state.notes_path.lock().unwrap(), &file_path) {
        Ok(p) => p,
        Err(e) => {
            backend_log(&state, "ipc", "error", "写入文件失败", Some(json!({ "op": "fs:write-file", "path": file_path, "errno": e.errno })));
            return if detail {
                path_failure(&e, "write-failed")
            } else {
                json!(false)
            };
        }
    };
    // Realpath validation happens before this point; a link swapped in since
    // then must not be followed by the final write.
    if is_symlink(&safe) {
        backend_log(
            &state,
            "ipc",
            "error",
            "写入文件失败：拒绝跟随符号链接",
            Some(json!({ "op": "fs:write-file", "errno": "EPERM" })),
        );
        return if detail { symlink_failure() } else { json!(false) };
    }
    let result = (|| -> std::io::Result<()> {
        if let Some(parent) = safe.parent() {
            fs::create_dir_all(parent)?;
        }
        state.mark_self_write(&safe);
        fs::write(&safe, text)
    })();
    match result {
        Ok(_) => json!(true),
        Err(e) => {
            backend_log(&state, "ipc", "error", "写入文件失败", Some(json!({ "op": "fs:write-file", "path": file_path, "errno": crate::util::errno_of(&e) })));
            if detail { io_failure(&e, Some("write-failed")) } else { json!(false) }
        }
    }
}

#[tauri::command]
pub fn fs_create_directory(state: State<'_, Arc<AppState>>, dir_path: String) -> bool {
    let safe = match validate_path_async(&state.notes_path.lock().unwrap(), &dir_path) {
        Ok(p) => p,
        Err(_) => return false,
    };
    state.mark_self_write(&safe);
    fs::create_dir_all(safe).is_ok()
}

#[tauri::command]
pub fn fs_file_exists(state: State<'_, Arc<AppState>>, file_path: String) -> bool {
    validate_path_async(&state.notes_path.lock().unwrap(), &file_path)
        .map(|p| p.exists())
        .unwrap_or(false)
}

#[tauri::command]
pub fn fs_move_file(
    state: State<'_, Arc<AppState>>,
    old_path: String,
    new_path: String,
    options: Option<Value>,
) -> Value {
    let notes_guard = state.notes_path.lock().unwrap();
    let old = match validate_path_async(&notes_guard, &old_path) {
        Ok(p) => p,
        Err(e) => return path_failure(&e, "write-failed"),
    };
    let new = match validate_path_async(&notes_guard, &new_path) {
        Ok(p) => p,
        Err(e) => return path_failure(&e, "write-failed"),
    };
    drop(notes_guard);
    if old == new {
        return json!(true);
    }
    let overwrite = options
        .as_ref()
        .and_then(|o| o.get("overwrite"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !overwrite && new.exists() {
        return json!({
            "ok": false, "error": "target-exists", "errno": "EEXIST", "message": "目标已存在"
        });
    }
    if let Some(parent) = new.parent() {
        if fs::create_dir_all(parent).is_err() {
            return json!({ "ok": false, "error": "write-failed", "errno": "EIO", "message": "无法创建目标目录" });
        }
    }
    // Neither end may be a symlink: rename would move the link itself, and the
    // copy fallback would read through it.
    if is_symlink(&old) || is_symlink(&new) {
        return symlink_failure();
    }
    state.mark_self_write(&old);
    state.mark_self_write(&new);
    match fs::rename(&old, &new) {
        Ok(_) => json!(true),
        Err(rename_err) => {
            if fs::metadata(&old).map(|m| m.is_file()).unwrap_or(false) {
                if fs::copy(&old, &new).is_ok() && fs::remove_file(&old).is_ok() {
                    return json!(true);
                }
            }
            backend_log(&state, "ipc", "error", "移动文件失败", Some(json!({ "op": "fs:move-file", "from": old_path, "to": new_path, "errno": crate::util::errno_of(&rename_err) })));
            io_failure(&rename_err, Some("write-failed"))
        }
    }
}

#[tauri::command]
pub fn fs_delete_file(state: State<'_, Arc<AppState>>, file_path: String, options: Option<Value>) -> Value {
    let detail = options
        .as_ref()
        .and_then(|o| o.get("detail"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let safe = match validate_path_async(&state.notes_path.lock().unwrap(), &file_path) {
        Ok(p) => p,
        Err(e) => {
            backend_log(&state, "ipc", "error", "删除失败：路径校验未通过", Some(json!({ "op": "fs:delete-file", "path": file_path, "errno": e.errno })));
            return if detail { path_failure(&e, "invalid-path") } else { json!(false) };
        }
    };
    if is_symlink(&safe) {
        return if detail { symlink_failure() } else { json!(false) };
    }
    state.mark_self_write(&safe);
    crate::trash::delete_with_trash(&state, &safe, detail, false)
}

#[tauri::command]
pub fn fs_remove_dir(state: State<'_, Arc<AppState>>, dir_path: String, options: Option<Value>) -> Value {
    let detail = options
        .as_ref()
        .and_then(|o| o.get("detail"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let safe = match validate_path_async(&state.notes_path.lock().unwrap(), &dir_path) {
        Ok(p) => p,
        Err(e) => {
            backend_log(&state, "ipc", "error", "删除目录失败：路径校验未通过", Some(json!({ "op": "fs:remove-dir", "path": dir_path, "errno": e.errno })));
            return if detail { path_failure(&e, "invalid-path") } else { json!(false) };
        }
    };
    let notes_root = state.notes_path.lock().unwrap().clone();
    if notes_root
        .as_ref()
        .map(|r| canonicalize_clean(r).ok() == canonicalize_clean(&safe).ok())
        .unwrap_or(false)
    {
        return json!(false);
    }
    if is_symlink(&safe) {
        return if detail { symlink_failure() } else { json!(false) };
    }
    state.mark_self_write(&safe);
    crate::trash::delete_with_trash(&state, &safe, detail, true)
}

#[tauri::command]
pub fn fs_watch_notes(state: State<'_, Arc<AppState>>, dir_path: Option<String>) -> bool {
    crate::watch::start_watching(&state, dir_path)
}

#[tauri::command]
pub fn fs_unwatch_notes(state: State<'_, Arc<AppState>>) -> bool {
    crate::watch::stop_watching(&state);
    true
}

#[tauri::command]
pub fn workspace_probe(state: State<'_, Arc<AppState>>, dir_path: String) -> Value {
    let miss = json!({ "exists": false, "count": 0, "folders": 0, "writable": false });
    let target = match canonicalize_clean(Path::new(&dir_path)) {
        Ok(p) => p,
        Err(_) => return miss,
    };

    // A workspace other than the active one lives outside `notes_path`, so the
    // boundary check must use whichever registered root this path actually is.
    // Only the active notes path and workspaces persisted by `workspace_save`
    // may be probed — arbitrary directories stay out of reach.
    let mut allowed: Vec<PathBuf> = Vec::new();
    if let Some(root) = state.notes_path.lock().unwrap().as_ref() {
        allowed.push(root.clone());
    }
    let workspaces = read_json(&state.workspaces_file(), json!([]));
    if let Some(list) = workspaces.as_array() {
        for item in list {
            let raw = item
                .get("path")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("notesPath").and_then(|v| v.as_str()));
            if let Some(raw) = raw.filter(|s| !s.trim().is_empty()) {
                allowed.push(PathBuf::from(raw));
            }
        }
    }
    let base = allowed.into_iter().find(|root| {
        canonicalize_clean(root)
            .map(|real| real == target)
            .unwrap_or(false)
    });
    let base = match base {
        Some(b) => Some(b),
        None => return miss,
    };
    let safe = match validate_path_async(&base, &dir_path) {
        Ok(p) => p,
        Err(_) => return miss,
    };
    let path = match canonicalize_clean(&safe) {
        Ok(p) => p,
        Err(_) => return miss,
    };
    if !path.is_dir() {
        return miss;
    }
    let mut count = 0usize;
    let mut folders = 0usize;
    let mut stack = vec![path.clone()];
    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            // symlink_metadata never follows the link, so a link placed inside
            // the workspace cannot make the scan escape the validated root.
            let meta = match fs::symlink_metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let file_type = meta.file_type();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                folders += 1;
                stack.push(entry.path());
            } else if file_type.is_file() && is_note_extension(&name) {
                count += 1;
            }
        }
    }
    let mut writable = true;
    if let Ok(metadata) = fs::metadata(&path) {
        // On Windows the read-only attribute conveys writability.
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x1 != 0 {
                writable = false;
            }
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o222 == 0 {
                writable = false;
            }
        }
    }
    json!({ "exists": true, "count": count, "folders": folders, "writable": writable })
}

