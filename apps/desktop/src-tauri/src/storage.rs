//! Flat file storage under the app data directory.
//! Keys are relative paths such as `settings.json`, `conversations/<id>.json`, `documents/<id>.md`.

use std::{fs, io::ErrorKind, path::PathBuf};
use tauri::{AppHandle, Manager};

fn base(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
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
    let path = base(app)?.join(key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[tauri::command]
pub fn storage_read(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = resolve(&app, &key)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn storage_write(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let path = resolve(&app, &key)?;
    // Write to a sibling temp file first so a crash never leaves a half-written file.
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, value).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_delete(app: AppHandle, key: String) -> Result<(), String> {
    let path = resolve(&app, &key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// File names directly under `<data>/<prefix>`.
#[tauri::command]
pub fn storage_list(app: AppHandle, prefix: String) -> Result<Vec<String>, String> {
    let dir = if prefix.is_empty() { base(&app)? } else { resolve(&app, &prefix)? };
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut names = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
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
