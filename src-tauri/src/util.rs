//! Path safety, error shaping and redaction helpers.
//! Behaviour mirrors `electron/path-safety.cjs` and the corresponding sections
//! of `electron/main.cjs`.

use std::path::{Component, Path, PathBuf};

use crate::state::AppState;

/// Remove `\\?\` verbatim prefixes added by `std::fs::canonicalize` on Windows.
/// Node's `fs.realpath` never returns them, and the renderer compares paths.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
        if let Some(rest) = text.strip_prefix(r"\\.\") {
            return PathBuf::from(rest);
        }
    }
    let _ = text;
    path
}

pub fn canonicalize_clean(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(strip_verbatim)
}

/// Lexical absolute-path normalisation (equivalent to Node `path.resolve` +
/// `path.normalize` for already-absolute inputs).
pub fn normalize_absolute(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(part.as_os_str()),
        }
    }
    out
}

fn eq_component(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Port of `isInside`: `path.relative(base, target)` containment, no `..` escape.
pub fn is_inside(base: &Path, target: &Path) -> bool {
    let base_parts: Vec<_> = base.components().collect();
    let target_parts: Vec<_> = target.components().collect();
    if target_parts.len() < base_parts.len() {
        return false;
    }
    for (i, part) in base_parts.iter().enumerate() {
        if !eq_component(part.as_os_str(), target_parts[i].as_os_str()) {
            return false;
        }
    }
    true
}

/// Resolve a real path; for a not-yet-existing target resolve its parent and
/// re-append the file name, so a symlinked parent directory cannot escape.
pub fn realpath_or_parent(path: &Path) -> Option<PathBuf> {
    if let Ok(real) = canonicalize_clean(path) {
        return Some(real);
    }
    let parent = path.parent()?;
    if parent == path {
        return None;
    }
    let real_parent = canonicalize_clean(parent).ok()?;
    Some(real_parent.join(path.file_name()?))
}

/// Semantic description of a path-validation failure (used by `ioFailure`).
#[derive(Debug, Clone)]
pub struct PathError {
    pub message: String,
    pub errno: String,
}

impl PathError {
    fn new(message: &str, errno: &str) -> Self {
        Self {
            message: message.to_string(),
            errno: errno.to_string(),
        }
    }
}

/// Port of `validatePath` (string boundary check).
pub fn validate_path(notes_path: &Option<PathBuf>, target: &str) -> Result<PathBuf, PathError> {
    let base = notes_path
        .as_ref()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| PathError::new("Notes path not set", "ENOENT"))?;
    if target.is_empty() {
        return Err(PathError::new("Invalid path", "EINVAL"));
    }
    let normalized_target = normalize_absolute(Path::new(target));
    let normalized_base = normalize_absolute(base);
    if !is_inside(&normalized_base, &normalized_target) {
        return Err(PathError::new(
            "Access denied: path outside notes directory",
            "EPERM",
        ));
    }
    Ok(normalized_target)
}

/// Port of `validatePathAsync` (realpath boundary check).
pub fn validate_path_async(
    notes_path: &Option<PathBuf>,
    target: &str,
) -> Result<PathBuf, PathError> {
    let pre_checked = validate_path(notes_path, target)?;
    let base_hint = notes_path
        .as_ref()
        .ok_or_else(|| PathError::new("Notes path not set", "ENOENT"))?;
    let real_base = realpath_or_parent(base_hint)
        .ok_or_else(|| PathError::new("Access denied: notes directory is not accessible", "EPERM"))?;
    let real_target = realpath_or_parent(&pre_checked)
        .ok_or_else(|| PathError::new("Access denied: parent directory does not exist", "EPERM"))?;
    if !is_inside(&real_base, &real_target) {
        return Err(PathError::new(
            "Access denied: path resolves outside notes directory",
            "EPERM",
        ));
    }
    Ok(real_target)
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Map a raw OS error number to a POSIX-style errno string.
pub fn errno_of(error: &std::io::Error) -> String {
    if let Some(code) = error.raw_os_error() {
        return match code {
            1 | 13 => "EACCES",
            2 => "ENOENT",
            17 => "EEXIST",
            20 => "ENOTDIR",
            22 => "EINVAL",
            28 => "ENOSPC",
            30 => "EROFS",
            _ => "EIO",
        }
        .to_string();
    }
    let message = error.to_string().to_lowercase();
    if message.contains("outside") {
        "EPERM".to_string()
    } else if message.contains("access denied") || message.contains("permission") {
        "EACCES".to_string()
    } else if message.contains("not set") {
        "ENOENT".to_string()
    } else if message.contains("invalid path") {
        "EINVAL".to_string()
    } else if message.contains("not a directory") {
        "ENOTDIR".to_string()
    } else {
        "EIO".to_string()
    }
}

/// `errno` → kebab-case error code, matching `errnoToCode` in main.cjs.
pub fn errno_to_code(errno: &str) -> &'static str {
    match errno {
        "EACCES" | "EPERM" | "EROFS" => "permission",
        "ENOENT" | "ENOTDIR" => "not-found",
        "EEXIST" => "target-exists",
        "EINVAL" => "invalid-path",
        _ => "write-failed",
    }
}

pub fn io_failure(error: &std::io::Error, fallback: Option<&str>) -> serde_json::Value {
    let errno = errno_of(error);
    serde_json::json!({
        "ok": false,
        "error": fallback.unwrap_or_else(|| errno_to_code(&errno)),
        "errno": errno,
        "message": redact_content(&error.to_string(), 120),
    })
}

pub fn path_failure(error: &PathError, fallback: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": fallback,
        "errno": error.errno,
        "message": redact_content(&error.message, 120),
    })
}

/// Standard failure response when a target is a symbolic link and the operation
/// refuses to follow it. Pure function: builds a value, performs no filesystem I/O.
pub fn symlink_failure() -> serde_json::Value {
    io_failure(
        &std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "access denied: symbolic link target is not allowed",
        ),
        Some("permission"),
    )
}

pub fn is_note_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    crate::state::NOTE_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{}", ext)))
}

pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn fold_control_chars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str("\\n");
            }
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) <= 0x1F || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

pub fn redact_content(input: &str, max: usize) -> String {
    let folded = fold_control_chars(input);
    let chars: Vec<char> = folded.chars().collect();
    if chars.len() <= max {
        folded
    } else {
        format!("{}…", chars[..max].iter().collect::<String>())
    }
}

/// Approximate `redactPath`: strip the home directory, keep the last two segments.
pub fn redact_path(input: &str) -> String {
    let normalized = input.replace('\\', "/");
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase())
        .unwrap_or_default();
    let lower = normalized.to_lowercase();
    let rest = if !home.is_empty() && lower.starts_with(&(home.clone() + "/")) {
        &normalized[home.len() + 1..]
    } else {
        normalized.as_str()
    };
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..").collect();
    match parts.len() {
        0 => "…/".to_string(),
        1 => format!("…/{}", parts[0]),
        _ => format!("…/{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]),
    }
}

pub fn read_json(path: &Path, fallback: serde_json::Value) -> serde_json::Value {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

pub fn write_json(path: &Path, data: &serde_json::Value) -> bool {
    match std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))) {
        Ok(_) => {}
        Err(_) => return false,
    }
    match serde_json::to_string_pretty(data) {
        Ok(text) => std::fs::write(path, text).is_ok(),
        Err(_) => false,
    }
}

/// Atomic JSON write: write `.tmp` then rename over the target.
pub fn write_json_atomic(path: &Path, data: &serde_json::Value) -> std::io::Result<()> {
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
    let tmp = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
    let mut text = serde_json::to_string_pretty(data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    text.push('\n');
    std::fs::write(&tmp, text)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

pub fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Runtime log sink used by backend commands; never fails the caller.
pub fn backend_log(state: &AppState, module: &str, level: &str, msg: &str, data: Option<serde_json::Value>) {
    crate::logging::write_main_record(state, module, level, msg, data);
}
