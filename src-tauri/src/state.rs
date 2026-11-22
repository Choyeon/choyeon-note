//! Shared application state, mirroring the module-level variables in
//! `electron/main.cjs` so command semantics stay identical.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64},
        Mutex,
    },
    time::Instant,
};

use notify::RecommendedWatcher;
use tauri::{AppHandle, Emitter, Manager, Wry};

pub const NOTE_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WatchKind {
    Add = 3,
    Change = 2,
    Unlink = 1,
}

pub struct LogState {
    pub dir: PathBuf,
    pub file: PathBuf,
    pub level: Mutex<String>,
    /// Serialises all writes, preserving log line ordering.
    pub write_lock: Mutex<()>,
    pub session_written: AtomicBool,
    pub rotation_seq: AtomicU64,
}

pub struct WatchState {
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub root: Mutex<Option<PathBuf>>,
    pub known: Mutex<HashSet<PathBuf>>,
    pub pending: Mutex<HashMap<PathBuf, WatchKind>>,
    /// A generation counter: a delayed flush is ignored if a newer window started.
    pub generation: AtomicU64,
}

pub struct FlushState {
    pub waiting: AtomicBool,
    pub generation: AtomicU64,
}

pub struct AppState {
    pub user_data: PathBuf,
    pub app_handle: Mutex<Option<AppHandle<Wry>>>,
    pub notes_path: Mutex<Option<PathBuf>>,
    pub active_workspace: Mutex<Option<String>>,
    pub self_writes: Mutex<HashMap<PathBuf, Instant>>,
    pub log: LogState,
    pub watch: WatchState,
    pub flush: FlushState,
    pub update_in_flight: AtomicBool,
}

impl AppState {
    pub fn new(app_handle: AppHandle<Wry>, user_data: PathBuf) -> Self {
        let log_dir = user_data.join("logs");
        let log_file = log_dir.join("main.log");
        Self {
            user_data,
            app_handle: Mutex::new(Some(app_handle)),
            notes_path: Mutex::new(None),
            active_workspace: Mutex::new(None),
            self_writes: Mutex::new(HashMap::new()),
            log: LogState {
                dir: log_dir,
                file: log_file,
                level: Mutex::new("info".to_string()),
                write_lock: Mutex::new(()),
                session_written: AtomicBool::new(false),
                rotation_seq: AtomicU64::new(0),
            },
            watch: WatchState {
                watcher: Mutex::new(None),
                root: Mutex::new(None),
                known: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                generation: AtomicU64::new(0),
            },
            flush: FlushState {
                waiting: AtomicBool::new(false),
                generation: AtomicU64::new(0),
            },
            update_in_flight: AtomicBool::new(false),
        }
    }

    pub fn settings_file(&self) -> PathBuf {
        self.user_data.join("settings.json")
    }
    pub fn spell_file(&self) -> PathBuf {
        self.user_data.join("spell-data.json")
    }
    pub fn workspaces_file(&self) -> PathBuf {
        self.user_data.join("workspaces.json")
    }
    pub fn vaults_dir(&self) -> PathBuf {
        self.user_data.join("vaults")
    }
    pub fn id_map_file(&self) -> PathBuf {
        self.user_data.join("note-id-map.json")
    }

    pub fn emit(&self, event: &str, payload: impl serde::Serialize + Clone) {
        if let Some(handle) = self.app_handle.lock().ok().and_then(|h| h.clone()) {
            let _ = handle.emit(event, payload);
        }
    }

    pub fn mark_self_write(&self, path: &PathBuf) {
        let mut map = match self.self_writes.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        map.insert(path.clone(), Instant::now());
        if map.len() > 500 {
            let now = Instant::now();
            map.retain(|_, until| *until > now);
        }
    }

    pub fn is_self_write(&self, path: &PathBuf) -> bool {
        let mut map = match self.self_writes.lock() {
            Ok(m) => m,
            Err(_) => return false,
        };
        match map.get(path) {
            Some(until) if *until > Instant::now() => true,
            Some(_) => {
                map.remove(path);
                false
            }
            None => false,
        }
    }

    /// Read the persisted notes path / active workspace on startup.
    pub fn load_settings(&self) {
        let raw = match std::fs::read_to_string(self.settings_file()) {
            Ok(s) => s,
            Err(_) => return,
        };
        let value: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return,
        };
        if let Some(p) = value.get("notesPath").and_then(|v| v.as_str()) {
            let candidate = PathBuf::from(p);
            if candidate.is_dir() {
                *self.notes_path.lock().unwrap() = Some(crate::util::canonicalize_clean(&candidate).unwrap_or(candidate));
            }
        }
        if let Some(id) = value.get("activeWorkspaceId").and_then(|v| v.as_str()) {
            *self.active_workspace.lock().unwrap() = Some(id.to_string());
        }
    }

    pub fn save_settings(&self) {
        let notes_path = self
            .notes_path
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|v| v.to_string_lossy().into_owned()));
        let active = self
            .active_workspace
            .lock()
            .ok()
            .and_then(|p| p.clone());
        let value = serde_json::json!({ "notesPath": notes_path, "activeWorkspaceId": active });
        let _ = std::fs::create_dir_all(self.user_data.clone());
        let tmp = self.settings_file().with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_string_pretty(&value).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, self.settings_file());
        }
    }
}

/// Resolve the directory that Electron used for `app.getPath('userData')`.
/// Keeping the same location means existing users do not lose their settings.
pub fn electron_user_data(app: &tauri::App<Wry>) -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = dirs::config_dir();
    #[cfg(target_os = "macos")]
    let base = dirs::data_dir();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = dirs::config_dir();

    let root = base.unwrap_or_else(|| app.path().app_data_dir().unwrap_or_default());
    let dir = root.join("choyeon-note");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
