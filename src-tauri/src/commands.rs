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
