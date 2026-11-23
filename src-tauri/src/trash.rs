//! In-library `.trash` implementation, ported from `electron/main.cjs`.
//! System trash is attempted first; the library trash is the safe fallback.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tauri::State;

use crate::{
    state::AppState,
    util::backend_log,
    util::{
        errno_of, io_failure, path_string, redact_content, validate_path,
        validate_path_async,
    },
};

const TRASH_DIR_NAME: &str = ".trash";
const TRASH_META_SUFFIX: &str = ".trashmeta.json";
const TRASH_META_VERSION: i64 = 1;
const TRASH_NAME_SEP: &str = "__";
const TRASH_RETENTION_DAYS: i64 = 30;
const TRASH_DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    chrono::DateTime::from_timestamp(secs, millis * 1_000_000)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn trash_stamp_of(ms: i64) -> String {
    iso_from_ms(ms).replace([':', '.'], "-")
}

fn trash_name_of(base: &str, ms: i64) -> String {
    format!("{}{}{}", trash_stamp_of(ms), TRASH_NAME_SEP, base)
}

fn meta_path_of(trash_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}{}", trash_path.to_string_lossy(), TRASH_META_SUFFIX))
}

fn is_trash_noise(name: &str) -> bool {
    name.is_empty() || name.starts_with('.') || name.ends_with(TRASH_META_SUFFIX)
}

fn trash_stamp_parse(name: &str) -> i64 {
    let sep = match name.find(TRASH_NAME_SEP) {
        Some(i) if i > 0 => i,
        _ => return 0,
    };
    let stamp = &name[..sep];
    // YYYY-MM-DDTHH-MM-SS-mmmZ
    if stamp.len() != 24 || !stamp.ends_with('Z') {
        return 0;
    }
    let digits: Vec<&str> = stamp[..23]
        .split(|c| c == '-' || c == 'T')
        .collect();
    if digits.len() != 7 || digits.iter().any(|d| d.len() != 2 && d.len() != 4 && d.len() != 3) {
        return 0;
    }
    let nums: Option<Vec<i64>> = digits.iter().map(|d| d.parse::<i64>().ok()).collect();
    let n = match nums {
        Some(n) => n,
        None => return 0,
    };
    let datetime = chrono::NaiveDate::from_ymd_opt(n[0] as i32, n[1] as u32, n[2] as u32)
        .and_then(|d| d.and_hms_milli_opt(n[3] as u32, n[4] as u32, n[5] as u32, n[6] as u32));
    datetime
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0)
}

fn trash_failure_reason(error: &str) -> String {
    redact_content(error, 120)
}

fn read_trash_meta(meta_path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(meta_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    if parsed.get("originPath").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return None;
    }
    Some(parsed)
}

fn write_trash_meta(trash_path: &Path, meta: &Value) -> std::io::Result<()> {
    fs::write(
        meta_path_of(trash_path),
        serde_json::to_string_pretty(meta).unwrap_or_default(),
    )
}

fn trash_size_of(path: &Path, depth: usize) -> u64 {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if !meta.is_dir() || depth >= 12 {
        return meta.len();
    }
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_trash_noise(&name) {
                continue;
            }
            total += trash_size_of(&entry.path(), depth + 1);
        }
    }
    total
}

pub(crate) fn trash_root_path(state: &AppState) -> Result<PathBuf, String> {
    let notes = state
        .notes_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Notes path not set".to_string())?;
    let target = path_string(&notes.join(TRASH_DIR_NAME));
    validate_path_async(&Some(notes), &target).map_err(|e| e.message)
}

fn is_safe_notes_path(state: &AppState, candidate: &str) -> bool {
    let notes = state.notes_path.lock().unwrap();
    validate_path(&notes, candidate).is_ok()
}

fn build_trash_entry(
    state: &AppState,
    trash_root: &Path,
    name: &str,
    now: i64,
    retention_days: i64,
) -> Option<Value> {
    let trash_path = trash_root.join(name);
    let stat = fs::metadata(&trash_path).ok()?;
    let kind = if stat.is_dir() { "dir" } else { "file" };
    let meta = read_trash_meta(&meta_path_of(&trash_path));
    let name_stamp = trash_stamp_parse(name);

    let trashed_at;
    let mut degraded = false;
    let mut degraded_reason: Option<&str> = None;
    if let Some(value) = meta
        .as_ref()
        .and_then(|m| m.get("trashedAt"))
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
    {
        trashed_at = value;
    } else if name_stamp > 0 {
        trashed_at = name_stamp;
        degraded = true;
        degraded_reason = Some("meta-missing");
    } else {
        trashed_at = stat
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(now);
        degraded = true;
        degraded_reason = Some("no-timestamp");
    }

    let parsed_base = if name_stamp > 0 {
        name[name.find(TRASH_NAME_SEP).unwrap() + TRASH_NAME_SEP.len()..].to_string()
    } else {
        name.to_string()
    };
    let display_name = meta
        .as_ref()
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&parsed_base)
        .to_string();
    let origin_path = meta
        .as_ref()
        .and_then(|m| m.get("originPath"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            let notes = state.notes_path.lock().unwrap();
            path_string(notes.as_ref().map(|n| n.join(&display_name)).unwrap_or_default().as_path())
        });
    if meta.is_none() {
        degraded = true;
        if degraded_reason.is_none() {
            degraded_reason = Some("meta-missing");
        }
    }

    let size = trash_size_of(&trash_path, 0);
    Some(json!({
        "id": name,
        "name": display_name,
        "trashName": name,
        "trashPath": path_string(&trash_path),
        "metaPath": path_string(&meta_path_of(&trash_path)),
        "originPath": origin_path,
        "trashedAt": trashed_at,
        "trashedAtISO": iso_from_ms(trashed_at),
        "purgeAt": trashed_at + retention_days * TRASH_DAY_MS,
        "size": size,
        "kind": kind,
        "degraded": degraded,
        "degradedReason": degraded_reason,
        "hasMeta": meta.is_some(),
        "outsideRoot": !is_safe_notes_path(state, &origin_path),
        "expired": trashed_at > 0 && trashed_at <= now - retention_days * TRASH_DAY_MS,
    }))
}

fn move_to_library_trash(state: &AppState, safe_path: &Path) -> Value {
    let trash_root = match trash_root_path(state) {
        Ok(p) => p,
        Err(e) => {
            return json!({ "ok": false, "error": "invalid-path", "errno": "EPERM", "message": e })
        }
    };
    if fs::create_dir_all(&trash_root).is_err() {
        return json!({ "ok": false, "error": "write-failed", "errno": "EIO", "message": "无法创建回收站目录" });
    }
    let base = safe_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ms = now_ms();
    let size = trash_size_of(safe_path, 0);
    let kind = fs::metadata(safe_path).map(|m| if m.is_dir() { "dir" } else { "file" }).unwrap_or("file");

    let mut trash_path = trash_root.join(trash_name_of(&base, ms));
    let mut dup = 1usize;
    while trash_path.exists() && dup <= 1000 {
        let dot = base.rfind('.');
        let (stem, ext) = match dot {
            Some(i) if i > 0 => (&base[..i], &base[i..]),
            _ => (base.as_str(), ""),
        };
        trash_path = trash_root.join(trash_name_of(&format!("{}-{}{}", stem, dup, ext), ms));
        dup += 1;
    }

    state.mark_self_write(&trash_path.to_path_buf());
    let moved = match fs::rename(safe_path, &trash_path) {
        Ok(_) => true,
        Err(_) => fs::copy(safe_path, &trash_path).is_ok() && remove_recursive(safe_path),
    };
    if !moved {
        return json!({ "ok": false, "error": "write-failed", "errno": "EIO", "message": "移入回收站失败" });
    }

    let meta = json!({
        "v": TRASH_META_VERSION,
        "originPath": path_string(safe_path),
        "name": base,
        "trashedAt": ms,
        "kind": kind,
        "size": size,
    });
    match write_trash_meta(&trash_path, &meta) {
        Ok(_) => json!({ "ok": true, "metaOk": true, "trashPath": path_string(&trash_path) }),
        Err(e) => {
            backend_log(&state, "ipc", "warn", "写入回收站来源元数据失败", Some(json!({ "op": "fs:delete-file", "errno": errno_of(&e) })));
            json!({
                "ok": true, "metaOk": false, "trashPath": path_string(&trash_path),
                "error": "meta-write-failed", "errno": errno_of(&e), "message": trash_failure_reason(&e.to_string()),
            })
        }
    }
}

fn remove_recursive(path: &Path) -> bool {
    if path.is_dir() {
        fs::remove_dir_all(path).is_ok()
    } else {
        fs::remove_file(path).is_ok()
    }
}

/// Shared by `fs:delete-file` and `fs:remove-dir`.
pub(crate) fn delete_with_trash(state: &AppState, safe_path: &Path, detail: bool, is_dir: bool) -> Value {
    let system_result = trash::delete(safe_path);
    match system_result {
        Ok(_) => {
            if detail {
                json!({ "ok": true, "method": "system-trash", "path": path_string(safe_path) })
            } else {
                json!(true)
            }
        }
        Err(trash_err) => {
            let moved = move_to_library_trash(state, safe_path);
            if moved.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                if detail {
                    let noun = if is_dir { "目录" } else { "文件" };
                    json!({
                        "ok": true, "method": "library-trash", "path": path_string(safe_path),
                        "trashPath": moved.get("trashPath").cloned().unwrap_or(json!(null)),
                        "metaOk": moved.get("metaOk").and_then(|v| v.as_bool()).unwrap_or(false),
                        "fallbackReason": trash_failure_reason(&trash_err.to_string()),
                        "note": format!("系统回收站不可用，{}已移入库内 .trash，可在「最近删除」中还原", noun),
                    })
                } else {
                    json!(true)
                }
            } else {
                let error = std::io::Error::new(std::io::ErrorKind::Other, trash_err.to_string());
                if detail {
                    let mut failure = io_failure(&error, Some("delete-failed"));
                    if let Some(obj) = failure.as_object_mut() {
                        obj.insert("fallbackReason".to_string(), json!(trash_failure_reason(&trash_err.to_string())));
                    }
                    failure
                } else {
                    json!(false)
                }
            }
        }
    }
}

#[tauri::command]
pub fn trash_list(state: State<'_, Arc<AppState>>, payload: Option<Value>) -> Value {
    let opts = payload.unwrap_or(json!({}));
    let notes = state.notes_path.lock().unwrap().clone();
    if notes.is_none() {
        return json!({ "ok": false, "error": "no-notes-path", "entries": [], "message": "尚未设置笔记目录" });
    }
    let root = match trash_root_path(&state) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": "read-failed", "entries": [], "message": e }),
    };
    let retention_days = opts
        .get("retentionDays")
        .and_then(|v| v.as_i64())
        .filter(|n| *n >= 0)
        .unwrap_or(TRASH_RETENTION_DAYS);
    let now = opts
        .get("nowMs")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(now_ms);
    let entries = match fs::read_dir(&root) {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return json!({
                "ok": true, "entries": [], "trashDir": path_string(&root),
                "exists": false, "retentionDays": retention_days, "nowMs": now,
            })
        }
        Err(e) => return io_failure(&e, Some("read-failed")),
    };
    let mut list: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_trash_noise(&name) {
            continue;
        }
        if let Some(item) = build_trash_entry(&state, &root, &name, now, retention_days) {
            list.push(item);
        }
    }
    list.sort_by(|a, b| {
        let a_time = a.get("trashedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let b_time = b.get("trashedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        b_time
            .cmp(&a_time)
            .then_with(|| a.get("trashName").and_then(|v| v.as_str()).cmp(&b.get("trashName").and_then(|v| v.as_str())))
    });
    json!({
        "ok": true, "entries": list, "trashDir": path_string(&root),
        "exists": true, "retentionDays": retention_days, "nowMs": now,
    })
}

#[tauri::command]
pub fn trash_restore(state: State<'_, Arc<AppState>>, payload: Option<Value>) -> Value {
    let opts = payload.unwrap_or(json!({}));
    if state.notes_path.lock().unwrap().is_none() {
        return json!({ "ok": false, "error": "no-notes-path", "message": "尚未设置笔记目录" });
    }
    let id = opts.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || id.starts_with('.')
    {
        return json!({ "ok": false, "error": "invalid-id", "message": "非法的回收站条目 id" });
    }
    let strategy = opts
        .get("strategy")
        .and_then(|v| v.as_str())
        .filter(|s| *s == "rename" || *s == "overwrite")
        .unwrap_or("fail");
    let root = match trash_root_path(&state) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": "restore-failed", "message": e }),
    };
    let now = now_ms();
    let entry = match build_trash_entry(&state, &root, id, now, TRASH_RETENTION_DAYS) {
        Some(e) => e,
        None => return json!({ "ok": false, "error": "not-found", "message": "回收站里没有这个条目" }),
    };
    let origin = entry
        .get("originPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let entry_kind = entry.get("kind").cloned().unwrap_or(json!("file"));
    let entry_size = entry.get("size").cloned().unwrap_or(json!(0));
    let notes_guard = state.notes_path.lock().unwrap();
    let requested = match validate_path(&notes_guard, &origin) {
        Ok(p) => p,
        Err(_) => {
            drop(notes_guard);
            backend_log(&state, "ipc", "warn", "拒绝还原到笔记库之外", Some(json!({ "op": "trash:restore", "id": id })));
            return json!({
                "ok": false, "error": "outside-root", "message": "该条目记录的原始路径不在笔记库内",
                "requestedPath": origin,
            });
        }
    };
    drop(notes_guard);

    let mut target = requested.clone();
    let mut renamed = false;
    if target.exists() {
        if strategy == "fail" {
            let (stem, ext) = split_stem_ext(&path_string(&requested));
            let mut candidate = format!("{}-1{}", stem, ext);
            for n in 2..=1000 {
                if !Path::new(&candidate).exists() {
                    break;
                }
                candidate = format!("{}-{}{}", stem, n, ext);
            }
            return json!({
                "ok": false, "error": "target-exists", "message": "原位置已经存在同名文件",
                "requestedPath": path_string(&requested), "suggestedPath": candidate,
            });
        }
        if strategy == "rename" {
            let (stem, ext) = split_stem_ext(&path_string(&requested));
            for n in 1..=1000 {
                let candidate = PathBuf::from(format!("{}-{}{}", stem, n, ext));
                if !candidate.exists() {
                    target = candidate;
                    renamed = true;
                    break;
                }
            }
        }
    }
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let trash_path = root.join(id);
    let meta_file = meta_path_of(&trash_path);
    state.mark_self_write(&trash_path);
    state.mark_self_write(&target);
    let moved = match fs::rename(&trash_path, &target) {
        Ok(_) => true,
        Err(_) => {
            let copied = if trash_path.is_dir() {
                copy_dir_recursive(&trash_path, &target).is_ok()
            } else {
                fs::copy(&trash_path, &target).is_ok()
            };
            copied && remove_recursive(&trash_path)
        }
    };
    if !moved {
        return json!({ "ok": false, "error": "restore-failed", "errno": "EIO", "message": "还原失败", "requestedPath": path_string(&requested) });
    }
    let meta_cleaned = fs::remove_file(&meta_file).is_ok();
    json!({
        "ok": true, "path": path_string(&target), "requestedPath": path_string(&requested),
        "renamed": renamed, "metaCleaned": meta_cleaned,
        "kind": entry_kind, "size": entry_size,
    })
}

fn split_stem_ext(path: &str) -> (String, String) {
    match path.rfind('.') {
        Some(i) if i > 0 => (path[..i].to_string(), path[i..].to_string()),
        _ => (path.to_string(), String::new()),
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn trash_purge(state: State<'_, Arc<AppState>>, payload: Option<Value>) -> Value {
    let opts = payload.unwrap_or(json!({}));
    if state.notes_path.lock().unwrap().is_none() {
        return json!({ "ok": false, "error": "no-notes-path", "purged": [], "failed": [], "message": "尚未设置笔记目录" });
    }
    let dry_run = opts.get("dryRun").and_then(|v| v.as_bool()).unwrap_or(false);
    let retention_days = opts
        .get("retentionDays")
        .and_then(|v| v.as_i64())
        .filter(|n| *n >= 0)
        .unwrap_or(TRASH_RETENTION_DAYS);
    let now = opts.get("nowMs").and_then(|v| v.as_i64()).unwrap_or_else(now_ms);
    let cutoff = now - retention_days * TRASH_DAY_MS;
    let retention_ms = retention_days * TRASH_DAY_MS;
    let root = match trash_root_path(&state) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": "purge-failed", "purged": [], "failed": [], "message": e }),
    };
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return json!({
                "ok": true, "purged": [], "failed": [], "kept": [], "expired": [],
                "retentionDays": retention_days, "retentionMs": retention_ms,
                "cutoffMs": cutoff, "dryRun": false,
            })
        }
        Err(err) => return io_failure(&err, Some("purge-failed")),
    };
    let mut listed = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_trash_noise(&name) {
            continue;
        }
        if let Some(item) = build_trash_entry(&state, &root, &name, now, retention_days) {
            listed.push(item);
        }
    }
    let has_ids = opts.get("ids").and_then(|v| v.as_array()).is_some();
    let purge_all = opts.get("all").and_then(|v| v.as_bool()).unwrap_or(false);
    let targets: Vec<String> = if has_ids {
        opts.get("ids")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    } else {
        listed
            .iter()
            .filter(|e| {
                purge_all
                    || e.get("trashedAt")
                        .and_then(|v| v.as_i64())
                        .map(|t| t > 0 && t <= cutoff)
                        .unwrap_or(false)
            })
            .filter_map(|e| e.get("id").and_then(|v| v.as_str().map(String::from)))
            .collect()
    };
    let expired: Vec<Value> = listed
        .iter()
        .filter(|e| {
            e.get("trashedAt")
                .and_then(|v| v.as_i64())
                .map(|t| t > 0 && t <= cutoff)
                .unwrap_or(false)
        })
        .map(|e| {
            json!({
                "id": e.get("id").cloned().unwrap_or(json!(null)),
                "trashedAt": e.get("trashedAt").cloned().unwrap_or(json!(null)),
                "originPath": e.get("originPath").cloned().unwrap_or(json!(null)),
            })
        })
        .collect();
    let kept: Vec<String> = listed
        .iter()
        .filter(|e| {
            e.get("id")
                .and_then(|v| v.as_str())
                .map(|id| !targets.iter().any(|t| t == id))
                .unwrap_or(false)
        })
        .filter_map(|e| e.get("id").and_then(|v| v.as_str().map(String::from)))
        .collect();

    if dry_run {
        return json!({
            "ok": true, "purged": [], "failed": [], "kept": kept, "expired": expired,
            "targets": targets, "retentionDays": retention_days, "retentionMs": retention_ms,
            "cutoffMs": cutoff, "dryRun": true,
        });
    }

    let mut purged = Vec::new();
    let mut failed = Vec::new();
    for raw_id in targets {
        if raw_id.is_empty()
            || raw_id == "."
            || raw_id == ".."
            || raw_id.contains('/')
            || raw_id.contains('\\')
            || raw_id.starts_with('.')
        {
            failed.push(json!({ "id": raw_id, "error": "invalid-id", "message": "非法的回收站条目 id" }));
            continue;
        }
        let trash_path = root.join(&raw_id);
        let meta_file = meta_path_of(&trash_path);
        let kind = fs::metadata(&trash_path)
            .map(|m| if m.is_dir() { "dir" } else { "file" })
            .unwrap_or("file");
        state.mark_self_write(&trash_path);
        state.mark_self_write(&meta_file);
        if remove_recursive(&trash_path) {
            if fs::remove_file(&meta_file).is_err() {
                failed.push(json!({ "id": raw_id, "error": "meta-cleanup-failed", "message": "本体已删除，元数据残留" }));
                continue;
            }
            purged.push(json!({ "id": raw_id, "trashPath": path_string(&trash_path), "kind": kind }));
        } else {
            failed.push(json!({ "id": raw_id, "error": "not-found", "message": "条目已不存在" }));
        }
    }
    if !purged.is_empty() || !failed.is_empty() {
        backend_log(&state, "ipc", "info", "回收站清理完成", Some(json!({ "op": "trash:purge", "purged": purged.len(), "failed": failed.len(), "dryRun": false })));
    }
    json!({
        "ok": failed.is_empty(), "purged": purged, "failed": failed, "kept": kept,
        "expired": expired, "retentionDays": retention_days, "retentionMs": retention_ms,
        "cutoffMs": cutoff, "dryRun": false,
    })
}
