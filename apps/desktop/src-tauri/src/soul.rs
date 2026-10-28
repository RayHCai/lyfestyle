//! SOUL.md: the user's guiding doc, given to every agent run.
//!
//! It lives at `~/.lyfestyle/SOUL.md` rather than in the app data folder because the runner
//! (`apps/runner/src/soul.ts`) reads the same file for API-backed runs; both run on this machine.

use std::{fs, io::ErrorKind, path::PathBuf};
use tauri::{AppHandle, Manager};

/// Written the first time the doc is read, so there is always one to edit.
const STARTER: &str = "# SOUL.md

- Keep output as concise as possible.
- Avoid em dashes, unnecessary semicolons and other filler punctuation.
";

pub(crate) fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".lyfestyle").join("SOUL.md"))
}

/// The file's path, when it has anything in it; what `--append-system-prompt-file` is given.
pub(crate) fn active(app: &AppHandle) -> Option<PathBuf> {
    let file = path(app).ok()?;
    let text = fs::read_to_string(&file).ok()?;
    (!text.trim().is_empty()).then_some(file)
}

#[tauri::command(async)]
pub fn soul_read(app: AppHandle) -> Result<String, String> {
    let file = path(&app)?;
    match fs::read_to_string(&file) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            soul_write(app, STARTER.into())?;
            Ok(STARTER.into())
        }
        Err(e) => Err(format!("Could not read {}: {e}", file.display())),
    }
}

#[tauri::command(async)]
pub fn soul_write(app: AppHandle, text: String) -> Result<(), String> {
    let file = path(&app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    fs::write(&file, text).map_err(|e| format!("Could not write {}: {e}", file.display()))
}
