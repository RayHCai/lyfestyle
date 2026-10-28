//! Flat file storage under the app data directory.
//! Keys are relative paths such as `settings.json`, `conversations/<id>.json`, `documents/<id>.md`.
//!
//! These commands stay synchronous on purpose: the UI fires overlapping writes to the same key
//! (a document and the index on every save) and relies on them landing in the order it sent them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{fs, io, io::ErrorKind};
use tauri::{AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("Could not find the app data folder: {e}"))
}

/// The data folder, created if missing.
pub(crate) fn base(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Write through a sibling temp file and a rename, so a crash or a concurrent reader never sees a
/// half-written file. The temp name is unique per process and call because the app and its MCP
/// server (`mcp.rs`, a separate process) write the same files.
pub(crate) fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    static WRITES: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}-{}.tmp", std::process::id(), WRITES.fetch_add(1, Ordering::Relaxed)));
    let tmp = path.with_file_name(name);
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn resolve(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let bad = key.is_empty()
        || key.contains("..")
        || key.starts_with('/')
        || key.starts_with('\\')
        || key.contains(':');
    if bad {
        return Err(format!("invalid storage key: {key}"));
    }
    Ok(data_dir(app)?.join(key))
}

#[tauri::command]
pub fn storage_read(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = resolve(&app, &key)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {key}: {e}")),
    }
}

#[tauri::command]
pub fn storage_write(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let path = resolve(&app, &key)?;
    write_atomic(&path, &value).map_err(|e| format!("Could not write {key}: {e}"))
}

#[tauri::command]
pub fn storage_delete(app: AppHandle, key: String) -> Result<(), String> {
    let path = resolve(&app, &key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete {key}: {e}")),
    }
}

/// File names directly under `<data>/<prefix>`.
#[tauri::command]
pub fn storage_list(app: AppHandle, prefix: String) -> Result<Vec<String>, String> {
    let dir = if prefix.is_empty() { data_dir(&app)? } else { resolve(&app, &prefix)? };
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let failed = |e: io::Error| format!("Could not list {}: {e}", dir.display());
    let mut names = vec![];
    for entry in fs::read_dir(&dir).map_err(failed)? {
        let entry = entry.map_err(failed)?;
        if entry.path().is_file() {
            if let Some(name) = entry.file_name().to_str() {
                if !name.ends_with(".tmp") {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub fn storage_dir(app: AppHandle) -> Result<String, String> {
    Ok(base(&app)?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::write_atomic;
    use std::fs;

    #[test]
    fn writes_atomically_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("lyfestyle-storage-{}", std::process::id()));
        let file = dir.join("documents").join("index.json");
        write_atomic(&file, "[1]").unwrap();
        write_atomic(&file, "[2]").unwrap();
        let read = fs::read_to_string(&file);
        let left = fs::read_dir(file.parent().unwrap()).unwrap().count();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(read.unwrap(), "[2]");
        assert_eq!(left, 1);
    }
}
