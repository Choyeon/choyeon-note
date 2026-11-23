//! Application-private persistence: spell data, id map, workspaces and vault.
//! All files live under the same userData directory Electron used, so existing
//! installations keep their settings across the migration.

use std::{path::PathBuf, sync::Arc};

use serde_json::{json, Value};
use tauri::State;

use crate::{
    state::AppState,
    util::backend_log,
    util::{read_json, safe_id, write_json, write_json_atomic},
};

#[tauri::command]
pub fn spell_load(state: State<'_, Arc<AppState>>) -> Value {
    let value = read_json(&state.spell_file(), json!({}));
    json!({
        "ignoredWords": value.get("ignoredWords").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        "customDictionary": value.get("customDictionary").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
    })
}

#[tauri::command]
pub fn spell_save(state: State<'_, Arc<AppState>>, payload: Value) -> bool {
    let value = json!({
        "ignoredWords": payload.get("ignoredWords").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        "customDictionary": payload.get("customDictionary").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
    });
    write_json(&state.spell_file(), &value)
}

#[tauri::command]
pub fn idmap_load(state: State<'_, Arc<AppState>>) -> Value {
    let file = state.id_map_file();
    if !file.exists() {
        return json!({ "ok": true, "data": null });
    }
    match std::fs::read_to_string(&file) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(data) if data.is_object() => json!({ "ok": true, "data": data }),
            _ => {
                backend_log(&state, "ipc", "warn", "读取 id 映射表失败", Some(json!({ "error": "id-map-shape-invalid" })));
                json!({ "ok": false, "data": null, "error": "id-map-shape-invalid", "errno": "" })
            }
        },
        Err(e) => {
            backend_log(&state, "ipc", "warn", "读取 id 映射表失败", Some(json!({ "error": e.to_string() })));
            json!({ "ok": false, "data": null, "error": e.to_string(), "errno": crate::util::errno_of(&e) })
        }
    }
}

#[tauri::command]
pub fn idmap_save(state: State<'_, Arc<AppState>>, payload: Option<Value>) -> Value {
    let payload = match payload {
        Some(p) if p.is_object() && p.get("byPath").and_then(|v| v.as_object()).is_some() => p,
        _ => {
            backend_log(&state, "ipc", "warn", "拒绝写入非法的 id 映射表", Some(json!({ "reason": "shape-invalid" })));
            return json!({ "ok": false, "error": "shape-invalid", "errno": "" });
        }
    };
    let mut data = payload;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    if let Some(map) = data.as_object_mut() {
        map.insert("updatedAt".to_string(), json!(now));
    }
    match write_json_atomic(&state.id_map_file(), &data) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => {
            backend_log(&state, "ipc", "error", "写入 id 映射表失败", Some(json!({ "error": e.to_string() })));
            json!({ "ok": false, "error": e.to_string(), "errno": crate::util::errno_of(&e) })
        }
    }
}

#[tauri::command]
pub fn workspace_list(state: State<'_, Arc<AppState>>) -> Value {
    read_json(&state.workspaces_file(), json!([]))
}

#[tauri::command]
pub fn workspace_save(state: State<'_, Arc<AppState>>, workspaces: Option<Value>) -> bool {
    let list = workspaces
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    write_json(&state.workspaces_file(), &json!(list))
}

#[tauri::command]
pub fn workspace_set_active(state: State<'_, Arc<AppState>>, id: Option<String>) -> bool {
    *state.active_workspace.lock().unwrap() = id;
    state.save_settings();
    true
}

#[tauri::command]
pub fn workspace_get_active(state: State<'_, Arc<AppState>>) -> Option<String> {
    state.active_workspace.lock().unwrap().clone()
}

fn vault_file_for(state: &AppState, workspace_id: Option<&str>) -> PathBuf {
    let id = workspace_id.filter(|id| safe_id(id)).unwrap_or("default");
    state.vaults_dir().join(format!("{}.json", id))
}

#[tauri::command]
pub fn vault_load(state: State<'_, Arc<AppState>>, workspace_id: Option<String>) -> Value {
    let id = workspace_id.as_deref();
    if let Some(value) = id {
        if !value.is_empty() && !safe_id(value) {
            return json!([]);
        }
    }
    let data = read_json(&vault_file_for(&state, id), json!({}));
    data.get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| json!([]))
}

#[tauri::command]
pub fn vault_save(
    state: State<'_, Arc<AppState>>,
    workspace_id: Option<String>,
    entries: Option<Value>,
) -> bool {
    let id = workspace_id.as_deref();
    if let Some(value) = id {
        if !value.is_empty() && !safe_id(value) {
            return false;
        }
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    write_json(
        &vault_file_for(&state, id),
        &json!({
            "version": 1,
            "updatedAt": now,
            "entries": entries.and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        }),
    )
}

/// Electron `safeStorage` uses OS-backed encryption: DPAPI on Windows,
/// Keychain on macOS and libsecret on Linux. Only DPAPI can be provided
/// without extra system services, so availability mirrors Electron there.
#[tauri::command]
pub fn vault_encryption_available() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn vault_encrypt(plain_text: Option<String>) -> Option<String> {
    let text = plain_text?;
    #[cfg(windows)]
    {
        dpapi_encrypt(&text).map(|bytes| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes))
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        None
    }
}

#[tauri::command]
pub fn vault_decrypt(cipher_base64: Option<String>) -> Option<String> {
    let text = cipher_base64?;
    if text.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text).ok()?;
        dpapi_decrypt(&bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        None
    }
}

#[cfg(windows)]
fn dpapi_encrypt(plain: &str) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let bytes = plain.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let result = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(output.pbData as _);
    }
    Some(result)
}

#[cfg(windows)]
fn dpapi_decrypt(cipher: &[u8]) -> Option<String> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let result = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(output.pbData as _);
    }
    String::from_utf8(result).ok()
}

#[tauri::command]
pub fn flush_complete(state: State<'_, Arc<AppState>>) {
    crate::system::resolve_flush(&state);
}
