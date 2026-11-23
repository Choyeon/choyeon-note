//! Choyeon Note - Tauri backend library.
//!
//! The renderer is intentionally unchanged from the Electron build: it detects
//! `window.electronAPI`, so the bridge in `src/utils/tauriBridge.js` exposes that
//! exact surface on top of the commands registered here.

pub mod commands;
pub mod fs_commands;
pub mod logging;
pub mod settings;
pub mod state;
pub mod system;
pub mod trash;
pub mod util;
pub mod watch;

use tauri::{Manager, WindowEvent};

/// Collect every command exported to the webview.
pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        system::window_minimize,
        system::window_maximize,
        system::window_close,
        system::window_is_maximized,
        system::app_get_version,
        system::check_for_updates,
        system::download_update,
        system::quit_and_install,
        fs_commands::app_select_notes_path,
        fs_commands::app_get_notes_path,
        fs_commands::app_set_notes_path,
        fs_commands::fs_read_directory,
        fs_commands::fs_read_directory_recursive,
        fs_commands::fs_read_file,
        fs_commands::fs_read_files,
        fs_commands::fs_write_file,
        fs_commands::fs_create_directory,
        fs_commands::fs_delete_file,
        fs_commands::fs_remove_dir,
        fs_commands::fs_move_file,
        fs_commands::fs_file_exists,
        fs_commands::fs_watch_notes,
        fs_commands::fs_unwatch_notes,
        fs_commands::workspace_probe,
        trash::trash_list,
        trash::trash_restore,
        trash::trash_purge,
        settings::spell_load,
        settings::spell_save,
        settings::idmap_load,
        settings::idmap_save,
        settings::workspace_list,
        settings::workspace_save,
        settings::workspace_set_active,
        settings::workspace_get_active,
        settings::vault_load,
        settings::vault_save,
        settings::vault_encryption_available,
        settings::vault_encrypt,
        settings::vault_decrypt,
        settings::flush_complete,
        logging::log_append,
        logging::log_read,
        logging::log_path,
        logging::log_export,
        logging::log_clear,
        logging::log_set_level,
    ]
}

/// Application entry point used by the binary.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(setup)
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running Choyeon Note");
}

/// Shared setup for both the library entry point and the binary.
pub fn setup(app: &mut tauri::App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    commands::init_state(app)?;
    commands::init_logging(app);

    if let Some(window) = app.get_webview_window("main") {
        // Electron showed the window only after the first frame and had a 3s
        // fallback. Tauri can show immediately without a white flash because
        // the renderer owns the background styling.
        let _ = window.show();
        let _ = window.set_focus();

        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 前端 closeWindow() 在调用 window_close 之前已 await flushEverything()，
                // 数据已经落盘。旧的 prevent_close + app:flush-all 回执握手在 Tauri 下
                // 从未收到前端回执，导致每次关闭都要等满 3 秒超时强杀。
                // 这里改为：短暂宽限期让系统级关闭（Alt+F4/任务栏）也有机会触发
                // 前端 beforeunload 落盘，然后主动退出。
                api.prevent_close();
                commands::request_flush(&handle);
            }
        });
    }

    // Electron used `frame: false` with an application menu that Windows did
    // not draw. Tauri would render a native menu strip on the frameless window
    // and change the UI, so keep the renderer as the single source of truth
    // for actions (command palette + registered shortcuts).
    Ok(())
}
