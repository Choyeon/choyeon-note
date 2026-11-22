//! Command registration facade and shared state initialisation.

use std::sync::{Arc, OnceLock};

use tauri::{Manager, Wry};

use crate::state::AppState;

static SHARED_STATE: OnceLock<Arc<AppState>> = OnceLock::new();

pub fn shared_state() -> Option<Arc<AppState>> {
    SHARED_STATE.get().cloned()
}

pub fn init_state(app: &mut tauri::App<Wry>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let user_data = crate::state::electron_user_data(app);
    let state = Arc::new(AppState::new(handle, user_data));
    state.load_settings();
    app.manage(state.clone());
    let _ = SHARED_STATE.set(state);
    Ok(())
}

pub fn init_logging(app: &tauri::App<Wry>) {
    if let Some(state) = shared_state() {
        let version = app.package_info().version.to_string();
        crate::logging::mark_session_start_with_version(&state, &version);
    }
}

pub fn request_flush(handle: &tauri::AppHandle<Wry>) {
    if let Some(state) = shared_state() {
        let _ = handle;
        crate::system::request_flush(&state);
    }
}

pub use crate::fs_commands::{
    app_get_notes_path, app_select_notes_path, app_set_notes_path, fs_create_directory,
    fs_delete_file, fs_file_exists, fs_move_file, fs_read_directory, fs_read_directory_recursive,
    fs_read_file, fs_read_files, fs_remove_dir, fs_unwatch_notes, fs_watch_notes, fs_write_file,
    workspace_probe,
};
pub use crate::logging::{
    log_append, log_clear, log_export, log_path, log_read, log_set_level,
};
pub use crate::settings::{
    flush_complete, idmap_load, idmap_save, spell_load, spell_save, vault_decrypt,
    vault_encrypt, vault_encryption_available, vault_load, vault_save, workspace_get_active,
    workspace_list, workspace_save, workspace_set_active,
};
pub use crate::system::{
    app_get_version, bing_fetch_wallpaper, check_for_updates, download_update, quit_and_install,
    window_close, window_is_maximized, window_maximize, window_minimize,
};
pub use crate::trash::{trash_list, trash_purge, trash_restore};

// Window-count helpers used by the shell integration.
pub fn _assert_manager<M: Manager<Wry>>(_: &M) {}
