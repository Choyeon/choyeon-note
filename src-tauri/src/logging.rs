//! Log persistence, ported from the `log:*` section of `electron/main.cjs`.
//! The line format is byte-compatible with `src/utils/logger.js`.

use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tauri::State;

use crate::{
    state::AppState,
    util::{read_json, redact_content, redact_path},
};

const LOG_LEVELS: [(&str, i32); 5] = [
    ("debug", 10),
    ("info", 20),
    ("warn", 30),
    ("error", 40),
    ("silent", 100),
];
const DEFAULT_LEVEL: &str = "info";
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const KEEP_DAYS: u64 = 7;
const MAX_FILES: usize = 7;
const FLUSH_CHUNK: usize = 256 * 1024;
const READ_DEFAULT: usize = 200;
const READ_HARD: usize = 5000;

fn weight(level: &str) -> i32 {
    LOG_LEVELS
        .iter()
        .find(|(name, _)| *name == level)
        .map(|(_, w)| *w)
        .unwrap_or_else(|| LOG_LEVELS[1].1)
}

fn enabled(state: &AppState, level: &str) -> bool {
    let current = state
        .log
        .level
        .lock()
        .map(|l| l.clone())
        .unwrap_or_else(|_| DEFAULT_LEVEL.to_string());
    weight(level) >= weight(&current)
}

fn level_pad(level: &str) -> String {
    let s = level.to_uppercase();
    if s.len() >= 5 {
        s
    } else {
        format!("{}{}", s, " ".repeat(5 - s.len()))
    }
}

fn render_tail(data: &Value) -> String {
    if data.is_null() {
        return String::new();
    }
    let obj = match data.as_object() {
        Some(o) => o,
        None => return format!("  {}", json!(data)),
    };
    let mut parts = Vec::new();
    for (key, value) in obj {
        if value.is_null() {
            continue;
        }
        let rendered = match value {
            Value::String(s) => {
                if s.chars().any(|c| c.is_whitespace()) || s.is_empty() {
                    json!(s).to_string()
                } else {
                    s.clone()
                }
            }
            Value::Object(_) | Value::Array(_) => json!(value).to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            Value::Null => continue,
        };
        parts.push(format!("{}={}", key, rendered));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("  {}", parts.join(" "))
    }
}

/// Byte-identical to `formatLogLine` in `src/utils/logger.js`.
pub fn format_line(entry: &Value) -> String {
    let ts = entry
        .get("t")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(now_iso);
    let module = match entry.get("mod") {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let message = match entry.get("msg") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let level = entry
        .get("lvl")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_LEVEL);
    let module = if module.is_empty() { "app" } else { &module };
    format!(
        "{}  {}  [{}]  {}{}",
        ts,
        level_pad(level),
        module,
        message,
        render_tail(entry.get("data").unwrap_or(&Value::Null))
    )
}

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let secs = now.div_euclid(1000);
    let millis = now.rem_euclid(1000);
    let dt = chrono::DateTime::from_timestamp(secs, (millis * 1_000_000) as u32)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap());
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn rotated_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("main.{}.log", index))
}

fn rotate_if_needed(state: &AppState) {
    let dir = state.log.dir.clone();
    let file = state.log.file.clone();
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    if size <= MAX_BYTES {
        return;
    }
    let _ = std::fs::remove_file(rotated_path(&dir, MAX_FILES - 1));
    for i in (1..MAX_FILES - 1).rev() {
        let _ = std::fs::rename(rotated_path(&dir, i), rotated_path(&dir, i + 1));
    }
    let _ = std::fs::rename(&file, rotated_path(&dir, 1));
    prune_rotated(&dir);
}

fn prune_rotated(dir: &Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let cutoff = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
        - (KEEP_DAYS * 24 * 60 * 60 * 1000) as i64;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("main.") || !name.ends_with(".log") {
            continue;
        }
        let stem = name.trim_start_matches("main.").trim_end_matches(".log");
        if stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64)
            .unwrap_or(i64::MAX);
        if modified < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Enqueue formatted lines, serialised through `write_lock` like the JS chain.
fn enqueue_lines(state: &AppState, lines: &[String]) -> usize {
    let _guard = match state.log.write_lock.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    if std::fs::create_dir_all(&state.log.dir).is_err() {
        return 0;
    }

    let mut payload = Vec::new();
    if !state.log.session_written.swap(true, Ordering::SeqCst) && enabled(state, "info") {
        payload.push(format_line(&json!({
            "t": now_iso(),
            "lvl": "info",
            "mod": "main",
            "msg": "主进程日志会话开始",
            "data": { "v": env!("CARGO_PKG_VERSION") }
        })));
    }
    payload.extend_from_slice(lines);
    if payload.is_empty() {
        return 0;
    }

    let mut buffer = Vec::new();
    let mut bytes = 0usize;
    let mut ok = true;
    for line in payload {
        bytes += line.len() + 1;
        buffer.push(line);
        if bytes >= FLUSH_CHUNK {
            ok &= flush_buffer(&state.log.file, &buffer);
            buffer.clear();
            bytes = 0;
            rotate_if_needed(state);
        }
    }
    if !buffer.is_empty() {
        ok &= flush_buffer(&state.log.file, &buffer);
        rotate_if_needed(state);
    }
    if ok {
        lines.len()
    } else {
        0
    }
}

fn flush_buffer(file: &Path, lines: &[String]) -> bool {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    match options.open(file) {
        Ok(mut handle) => {
            let mut text = String::new();
            for line in lines {
                text.push_str(line);
                text.push('\n');
            }
            handle.write_all(text.as_bytes()).is_ok()
        }
        Err(_) => false,
    }
}

/// Write the startup session marker, matching Electron's `markSessionStart()`.
/// The version comes from the same Cargo package that produces the binary.
pub fn mark_session_start_with_version(state: &AppState, _version: &str) {
    let _ = enqueue_lines(state, &[]);
}

fn normalize_incoming(state: &AppState, raw: &Value) -> Option<Value> {
    let lvl = raw
        .get("lvl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| DEFAULT_LEVEL.to_string());
    if lvl == "silent" || weight(&lvl) == 0 || !LOG_LEVELS.iter().any(|(n, _)| *n == lvl) {
        return None;
    }
    if !enabled(state, &lvl) {
        return None;
    }
    let t = raw
        .get("t")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(now_iso);
    let module = match raw.get("mod") {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let msg = match raw.get("msg") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let mut out = json!({ "t": t, "lvl": lvl, "mod": module, "msg": msg });
    if let Some(data) = raw.get("data") {
        if !data.is_null() {
            out["data"] = data.clone();
        }
    }
    Some(out)
}

/// Backend-owned log record. Main-process data is redacted before writing.
pub fn write_main_record(
    state: &AppState,
    module: &str,
    level: &str,
    msg: &str,
    data: Option<Value>,
) {
    if !enabled(state, level) {
        return;
    }
    // Match the renderer's WHOLE_PATH_RE: only a string that *is* a path is
    // masked as a whole; URLs and ordinary prose keep their shape.
    let whole_path = (msg.starts_with('/')
        || msg.starts_with('~')
        || (msg.len() >= 2
            && msg.as_bytes()[1] == b':'
            && msg.as_bytes()[0].is_ascii_alphabetic()))
        && !msg.contains("://");
    let message = if whole_path {
        redact_content(&redact_path(msg), 120)
    } else {
        redact_content(msg, 120)
    };
    let safe_data = data.map(|v| redact_value(&v));
    let mut entry = json!({
        "t": now_iso(),
        "lvl": level,
        "mod": if module.is_empty() { "app" } else { module },
        "msg": message,
    });
    if let Some(d) = safe_data {
        entry["data"] = d;
    }
    enqueue_lines(state, &[format_line(&entry)]);
}

fn redact_value(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact_content(&redact_path(s), 120)),
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let lower = k.to_lowercase();
                if lower.ends_with("pass")
                    || lower.ends_with("password")
                    || lower.ends_with("secret")
                    || lower.ends_with("token")
                    || lower.ends_with("credential")
                    || lower.ends_with("apikey")
                    || lower.ends_with("api_key")
                    || lower.ends_with("privatekey")
                    || lower.ends_with("accesskey")
                    || lower.ends_with("value")
                    || lower.ends_with("valueenc")
                {
                    out.insert(k.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    out.insert(k.clone(), redact_value(v));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[tauri::command]
pub fn log_append(state: State<'_, Arc<AppState>>, entry: Value) -> Value {
    let list: Vec<Value> = if entry.is_array() {
        entry.as_array().unwrap().clone()
    } else {
        vec![entry]
    };
    let mut entries: Vec<Value> = list
        .iter()
        .filter_map(|raw| normalize_incoming(&state, raw))
        .collect();
    if entries.is_empty() {
        return json!({ "ok": true, "written": 0 });
    }
    entries.sort_by(|a, b| {
        a.get("t")
            .and_then(|v| v.as_str())
            .cmp(&b.get("t").and_then(|v| v.as_str()))
    });
    let lines: Vec<String> = entries.iter().map(format_line).collect();
    let written = enqueue_lines(&state, &lines);
    json!({ "ok": true, "written": written })
}

#[tauri::command]
pub fn log_read(state: State<'_, Arc<AppState>>, limit: Option<usize>) -> Value {
    let file = state.log.file.clone();
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return json!({ "ok": true, "path": path_string(&file), "lines": [], "total": 0, "truncated": false });
            }
            return json!({ "ok": false, "path": path_string(&file), "lines": [], "total": 0, "truncated": false, "error": e.to_string() });
        }
    };
    let all: Vec<&str> = text.split('\n').filter(|line| !line.is_empty()).collect();
    let want = limit
        .filter(|n| *n > 0)
        .map(|n| n.min(READ_HARD))
        .unwrap_or(READ_DEFAULT);
    let total = all.len();
    let lines: Vec<&str> = if total > want {
        all[total - want..].to_vec()
    } else {
        all.clone()
    };
    json!({
        "ok": true,
        "path": path_string(&file),
        "lines": lines,
        "total": total,
        "truncated": total > want,
    })
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[tauri::command]
pub fn log_path(state: State<'_, Arc<AppState>>) -> Option<String> {
    if state.log.file.as_os_str().is_empty() {
        None
    } else {
        Some(path_string(&state.log.file))
    }
}

#[tauri::command]
pub fn log_export(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let stamp = now_iso().replace([':', '.'], "-");
    let home = dirs::home_dir().unwrap_or_default();
    let default = home.join(format!("choyeon-note-log-{}.log", stamp));
    let destination = app
        .dialog()
        .file()
        .set_title("导出日志")
        .add_filter("日志文件", &["log", "txt"])
        .set_directory(home)
        .blocking_save_file();
    let destination = match destination {
        Some(p) => p.into_path().unwrap_or(default),
        None => return json!({ "ok": false, "error": "canceled" }),
    };
    let mut chunks = Vec::new();
    for i in (1..MAX_FILES).rev() {
        if let Ok(text) = std::fs::read_to_string(rotated_path(&state.log.dir, i)) {
            chunks.push(text);
        }
    }
    if let Ok(text) = std::fs::read_to_string(&state.log.file) {
        chunks.push(text);
    }
    let merged = chunks
        .iter()
        .map(|c| c.trim_end())
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    match std::fs::write(&destination, merged) {
        Ok(_) => json!({ "ok": true, "path": path_string(&destination) }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn log_clear(state: State<'_, Arc<AppState>>) -> Value {
    let entries = match std::fs::read_dir(&state.log.dir) {
        Ok(e) => e,
        Err(_) => return json!({ "ok": false, "error": "no-user-data" }),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "main.log" || (name.starts_with("main.") && name.ends_with(".log")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    state.log.session_written.store(false, Ordering::SeqCst);
    state.emit("log:cleared", ());
    json!({ "ok": true })
}

#[tauri::command]
pub fn log_set_level(state: State<'_, Arc<AppState>>, level: Option<String>) -> Value {
    let requested = match level {
        Some(l) => l,
        None => {
            return json!({
                "ok": false,
                "level": state.log.level.lock().map(|l| l.clone()).unwrap_or_default(),
                "changed": false,
            })
        }
    };
    if !LOG_LEVELS.iter().any(|(name, _)| *name == requested) {
        return json!({
            "ok": false,
            "level": state.log.level.lock().map(|l| l.clone()).unwrap_or_default(),
            "changed": false,
        });
    }
    let mut current = state.log.level.lock().unwrap();
    let changed = *current != requested;
    *current = requested.clone();
    json!({ "ok": true, "level": requested, "changed": changed })
}

/// Read the persisted log level key kept by the renderer bootstrap.
pub fn stored_log_level(state: &AppState) -> String {
    let file = state.user_data.join("log-level.json");
    let value = read_json(&file, json!({}));
    value
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_LEVEL)
        .to_string()
}

/// Small helper used by other modules to keep a `HashMap` of counters in logs.
#[allow(dead_code)]
fn counts(map: &HashMap<String, usize>) -> String {
    map.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(" ")
}
