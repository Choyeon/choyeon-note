//! Notes-directory watcher. Ported contract from the `fs:watch-notes` section of
//! `electron/main.cjs`: 600ms debounce, 1500ms self-write silence, hidden-segment
//! filtering and a `Array<{path, kind}>` payload on `notes:external-change`.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    thread,
    time::Duration,
};

use notify::{Event, RecursiveMode, Watcher};
use serde_json::json;
use tauri::State;

use crate::{
    state::{AppState, WatchKind},
    util::backend_log,
    util::{canonicalize_clean, path_string, validate_path_async},
};

const WATCH_DEBOUNCE_MS: u64 = 600;
const WATCH_MAX_BATCH: usize = 2000;
const WATCH_MAX_KNOWN: usize = 50_000;

fn hidden_segment(path: &Path, root: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        name.starts_with('.') && name.len() > 1
    })
}

fn seed_known(root: &Path) -> std::collections::HashSet<PathBuf> {
    let mut known = std::collections::HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        if known.len() >= WATCH_MAX_KNOWN {
            break;
        }
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            known.insert(path.clone());
            if known.len() >= WATCH_MAX_KNOWN {
                break;
            }
            let file_type = entry.file_type().ok();
            if file_type.map(|t| t.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with('.') {
                    stack.push(path);
                }
            }
        }
    }
    known
}

fn classify(state: &AppState, target: &Path) -> WatchKind {
    let exists = target.exists();
    let mut known = state.watch.known.lock().unwrap();
    if !exists {
        known.remove(target);
        return WatchKind::Unlink;
    }
    if known.contains(target) {
        WatchKind::Change
    } else {
        known.insert(target.to_path_buf());
        WatchKind::Add
    }
}

fn merge(pending: &mut HashMap<PathBuf, WatchKind>, target: &PathBuf, kind: WatchKind) {
    match pending.get(target).copied() {
        None => {
            pending.insert(target.clone(), kind);
        }
        Some(prev) if prev == kind => {}
        Some(WatchKind::Add) if kind == WatchKind::Unlink => {
            pending.remove(target);
        }
        Some(WatchKind::Unlink) if kind == WatchKind::Add || kind == WatchKind::Change => {
            pending.insert(target.clone(), WatchKind::Change);
        }
        Some(prev) if kind > prev => {
            pending.insert(target.clone(), kind);
        }
        _ => {}
    }
}

fn flush_changes(state: &Arc<AppState>) {
    let root = state.watch.root.lock().unwrap().clone();
    let changes: Vec<serde_json::Value> = {
        let mut pending = state.watch.pending.lock().unwrap();
        if pending.is_empty() {
            return;
        }
        let mut list = Vec::with_capacity(pending.len());
        for (path, kind) in pending.iter() {
            let label = match kind {
                WatchKind::Add => "add",
                WatchKind::Change => "change",
                WatchKind::Unlink => "unlink",
            };
            list.push(json!({ "path": path_string(path), "kind": label }));
        }
        pending.clear();
        list
    };
    let counts = (
        changes.iter().filter(|c| c["kind"] == "add").count(),
        changes.iter().filter(|c| c["kind"] == "change").count(),
        changes.iter().filter(|c| c["kind"] == "unlink").count(),
    );
    backend_log(
        state,
        "watcher",
        "info",
        "外部变更批次已发出",
        Some(json!({
            "root": root.as_ref().and_then(|r| r.file_name()).map(|n| n.to_string_lossy()).unwrap_or_default(),
            "count": changes.len(), "add": counts.0, "change": counts.1, "unlink": counts.2,
        })),
    );
    state.emit("notes:external-change", changes);
}

fn on_event(state: &Arc<AppState>, event: notify::Result<Event>) {
    let event = match event {
        Ok(e) => e,
        Err(_) => return,
    };
    let root_guard = state.watch.root.lock().unwrap();
    let root = match root_guard.as_ref() {
        Some(r) => r.clone(),
        None => return,
    };
    drop(root_guard);

    for path in event.paths {
        if !path.starts_with(&root) || hidden_segment(&path, &root) {
            continue;
        }
        if state.is_self_write(&path) {
            continue;
        }
        let canonical = canonicalize_clean(&path).unwrap_or(path);
        if !canonical.starts_with(&root) {
            continue;
        }
        let kind = classify(state, &canonical);
        let (generation, spawn_timer, force_flush) = {
            let mut pending = match state.watch.pending.lock() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let was_empty = pending.is_empty();
            merge(&mut pending, &canonical, kind);
            if pending.len() >= WATCH_MAX_BATCH {
                let gen = state.watch.generation.fetch_add(1, Ordering::SeqCst) + 1;
                (gen, false, true)
            } else if was_empty {
                let gen = state.watch.generation.fetch_add(1, Ordering::SeqCst) + 1;
                (gen, true, false)
            } else {
                (state.watch.generation.load(Ordering::SeqCst), false, false)
            }
        };
        if force_flush {
            flush_changes(state);
            continue;
        }
        // The generation guard makes an older timer a no-op once a newer
        // debounce window has started.
        if spawn_timer {
            let state_ref = Arc::clone(state);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(WATCH_DEBOUNCE_MS));
                if state_ref.watch.generation.load(Ordering::SeqCst) == generation {
                    flush_changes(&state_ref);
                }
            });
        }
    }
}

pub(crate) fn stop_watching(state: &AppState) {
    state.watch.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut watcher) = state.watch.watcher.lock() {
        *watcher = None;
    }
    if let Ok(mut pending) = state.watch.pending.lock() {
        pending.clear();
    }
    if let Ok(mut known) = state.watch.known.lock() {
        known.clear();
    }
    if let Ok(mut root) = state.watch.root.lock() {
        *root = None;
    }
}

pub(crate) fn start_watching(state: &AppState, dir_path: Option<String>) -> bool {
    let notes_guard = state.notes_path.lock().unwrap();
    let requested = dir_path
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| path_string(notes_guard.as_ref().unwrap_or(&PathBuf::new())));
    let safe = match validate_path_async(&notes_guard, &requested) {
        Ok(p) => p,
        Err(e) => {
            backend_log(state, "watcher", "error", "启动笔记目录监听失败", Some(json!({ "error": e.message, "errno": e.errno })));
            return false;
        }
    };
    drop(notes_guard);
    stop_watching(state);

    *state.watch.root.lock().unwrap() = Some(safe.clone());
    let known = seed_known(&safe);
    let seeded = known.len();
    *state.watch.known.lock().unwrap() = known;

    let state_arc = state_arc_from_handle(state);
    let watcher = notify::recommended_watcher(move |event| on_event(&state_arc, event));
    let mut watcher = match watcher {
        Ok(w) => w,
        Err(e) => {
            backend_log(state, "watcher", "error", "启动笔记目录监听失败", Some(json!({ "error": e.to_string() })));
            stop_watching(state);
            return false;
        }
    };
    if watcher.watch(&safe, RecursiveMode::Recursive).is_err() {
        backend_log(state, "watcher", "error", "启动笔记目录监听失败", Some(json!({ "error": "watch-failed" })));
        stop_watching(state);
        return false;
    }
    *state.watch.watcher.lock().unwrap() = Some(watcher);
    backend_log(
        state,
        "watcher",
        "info",
        "已启动笔记目录监听（原生递归模式）",
        Some(json!({
            "root": safe.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
            "baseline": seeded,
        })),
    );
    true
}

/// `start_watching` receives `State<AppState>` from Tauri, which is an `Arc`
/// under the hood but not publicly convertible. `commands.rs` stores the same
/// `Arc` in `AppState.app_handle`; this helper retrieves it from the registry.
fn state_arc_from_handle(_state: &AppState) -> Arc<AppState> {
    crate::commands::shared_state().expect("AppState must be initialised before watcher")
}

#[tauri::command]
pub fn watch_noop(_state: State<'_, Arc<AppState>>) {}
