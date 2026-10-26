mod agent;
mod storage;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn console_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL), Code::KeyK)
}

/// Bring the main window forward and ask the frontend to open the console.
fn summon(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("console:open", ());
}

/// Enable or disable the system-wide Ctrl+K. Called from Settings.
#[tauri::command]
fn set_global_shortcut(app: AppHandle, enabled: bool) -> Result<(), String> {
    let shortcut = console_shortcut();
    let registered = app.global_shortcut().is_registered(shortcut);
    if enabled && !registered {
        app.global_shortcut().register(shortcut).map_err(|e| e.to_string())
    } else if !enabled && registered {
        app.global_shortcut().unregister(shortcut).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &console_shortcut() {
                        summon(app);
                    }
                })
                .build(),
        )
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
            set_global_shortcut
        ])
        .setup(|app| {
            // Registration can fail when another app owns Ctrl+K; the in-app shortcut still works.
            let _ = app.global_shortcut().register(console_shortcut());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lyfestyle");
}
