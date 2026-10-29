mod agent;
pub mod mcp;
mod skills;
mod soul;
mod storage;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// `CreateProcess` flag that keeps a console child (cmd.exe, taskkill, the npm shim) from flashing
/// a window.
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// An environment variable, treating an empty or blank value as unset like the runner does.
pub(crate) fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.trim().is_empty())
}

/// Show a system notification. API mode calls it for each new `/notifications` item, so the JS
/// side needs no notification package of its own.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: Option<String>) -> Result<(), String> {
    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body.filter(|b| !b.is_empty()) {
        builder = builder.body(body);
    }
    builder.show().map_err(|e| e.to_string())
}

/// Ask to install a newer published release, if there is one. Installed builds only: a dev build's
/// version says nothing about what is on disk.
async fn check_for_update(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let prompt = app
        .dialog()
        .message(format!(
            "Lyfestyle {} is available (you have {}). Install it now? The app will restart.",
            update.version, update.current_version
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()));
    let accepted =
        tauri::async_runtime::spawn_blocking(move || prompt.blocking_show()).await.unwrap_or(false);
    if accepted {
        update.download_and_install(|_, _| {}, || {}).await?;
        app.restart();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(agent::AgentState::default())
        .invoke_handler(tauri::generate_handler![
            storage::storage_read,
            storage::storage_write,
            storage::storage_delete,
            storage::storage_list,
            storage::storage_dir,
            agent::agent_send,
            agent::agent_cancel,
            agent::agent_env,
            skills::skills_load,
            soul::soul_read,
            soul::soul_write,
            notify
        ])
        .setup(|app| {
            // The whole UI renders at 80%, like pressing Ctrl - twice in a browser.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_zoom(0.8);
            }
            if !cfg!(debug_assertions) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Offline or no release yet: try again next launch.
                    if let Err(e) = check_for_update(handle).await {
                        eprintln!("update check failed: {e}");
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lyfestyle")
        .run(|app, event| {
            // A running agent is not tied to the window; without this it outlives the app.
            if let RunEvent::Exit = event {
                app.state::<agent::AgentState>().kill_all();
            }
        });
}
