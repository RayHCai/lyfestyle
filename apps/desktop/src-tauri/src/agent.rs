//! Runs the agent as a child process and streams its stdout to the frontend line by line.
//!
//! Default harness: the user's local Claude Code (`claude -p --output-format stream-json`).
//! Override: set `LYFESTYLE_AGENT_COMMAND` in the environment to any executable. It receives the
//! prompt on stdin, `--session <id>` when resuming, and may print either Claude-style JSON lines
//! or plain text.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const EVENT: &str = "agent-event";

#[derive(Default)]
pub struct AgentState {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Serialize, Clone)]
struct AgentEvent {
    conversation_id: String,
    kind: String, // "line" | "stderr" | "exit"
    line: String,
}

#[derive(Deserialize)]
pub struct SendArgs {
    pub conversation_id: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub command: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnv {
    pub harness: Option<String>,
    pub platform: String,
    /// `LYFESTYLE_API_URL`, when the app should talk to the Lyfestyle API instead of local files.
    pub api_url: Option<String>,
    /// `LYFESTYLE_API_TOKEN`, falling back to `API_TOKEN` like the runner does.
    pub api_token: Option<String>,
}

fn env_harness() -> Option<String> {
    std::env::var("LYFESTYLE_AGENT_COMMAND").ok().filter(|s| !s.trim().is_empty())
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.trim().is_empty())
}

#[tauri::command]
pub fn agent_env() -> AgentEnv {
    AgentEnv {
        harness: env_harness(),
        platform: std::env::consts::OS.to_string(),
        api_url: env_var("LYFESTYLE_API_URL"),
        api_token: env_var("LYFESTYLE_API_TOKEN").or_else(|| env_var("API_TOKEN")),
    }
}

/// Quote-aware whitespace split, enough for `"C:\Program Files\x.exe" --flag`.
fn shell_split(input: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in input.chars() {
        match (c, quote) {
            ('"', None) | ('\'', None) => quote = Some(c),
            (c, Some(q)) if c == q => quote = None,
            (c, None) if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Find `claude` on PATH, including the npm `.cmd` shim on Windows.
fn resolve_program(name: &str) -> PathBuf {
    let given = Path::new(name);
    if given.components().count() > 1 || given.extension().is_some() {
        return given.to_path_buf();
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for ext in exts {
                let candidate = dir.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    given.to_path_buf()
}

fn emit(app: &AppHandle, conversation_id: &str, kind: &str, line: String) {
    let _ = app.emit(
        EVENT,
        AgentEvent { conversation_id: conversation_id.to_string(), kind: kind.to_string(), line },
    );
}

#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: State<'_, AgentState>,
    args: SendArgs,
) -> Result<(), String> {
    let (command_line, from_env) = match env_harness() {
        Some(h) => (h, true),
        None => (
            args.command
                .clone()
                .filter(|c| !c.trim().is_empty())
                .unwrap_or_else(|| "claude".into()),
            false,
        ),
    };
    let mut words = shell_split(&command_line);
    if words.is_empty() {
        return Err("Agent command is empty.".into());
    }
    let program = resolve_program(&words[0]);
    let mut argv: Vec<String> = words.drain(1..).collect();

    if from_env {
        if let Some(sid) = &args.session_id {
            argv.push("--session".into());
            argv.push(sid.clone());
        }
    } else {
        argv.extend(
            ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
                .iter()
                .map(|s| s.to_string()),
        );
        if let Some(model) = args.model.as_deref().filter(|m| !m.trim().is_empty()) {
            argv.push("--model".into());
            argv.push(model.to_string());
        }
        if let Some(sid) = &args.session_id {
            argv.push("--resume".into());
            argv.push(sid.clone());
        }
    }

    let mut cmd = Command::new(&program);
    cmd.args(&argv);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(dir) = args.cwd.as_deref().filter(|d| !d.trim().is_empty()) {
        if Path::new(dir).is_dir() {
            cmd.current_dir(dir);
        }
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child =
        cmd.spawn().map_err(|e| format!("Could not start `{}`: {e}", program.display()))?;

    let conversation_id = args.conversation_id.clone();

    if let Some(mut stdin) = child.stdin.take() {
        let prompt = args.prompt.clone();
        thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
            let _ = stdin.flush();
            // Dropping stdin closes the pipe, which tells the CLI the prompt is complete.
        });
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut map = state.children.lock().map_err(|_| "agent state poisoned".to_string())?;
        if let Some(mut previous) = map.insert(conversation_id.clone(), child) {
            let _ = previous.kill();
        }
    }

    if let Some(err) = stderr {
        let app2 = app.clone();
        let id = conversation_id.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                emit(&app2, &id, "stderr", line);
            }
        });
    }

    if let Some(out) = stdout {
        let app2 = app.clone();
        let id = conversation_id.clone();
        let children = state.children.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                emit(&app2, &id, "line", line);
            }
            let code = {
                let mut map = children.lock().unwrap_or_else(|e| e.into_inner());
                match map.remove(&id) {
                    Some(mut c) => c.wait().ok().and_then(|s| s.code()).unwrap_or(-1),
                    None => -1,
                }
            };
            emit(&app2, &id, "exit", code.to_string());
        });
    }

    Ok(())
}

#[tauri::command]
pub fn agent_cancel(state: State<'_, AgentState>, conversation_id: String) -> Result<(), String> {
    let mut map = state.children.lock().map_err(|_| "agent state poisoned".to_string())?;
    if let Some(child) = map.get_mut(&conversation_id) {
        #[cfg(windows)]
        {
            // The npm shim runs through cmd.exe, so kill the whole tree.
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &child.id().to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        let _ = child.kill();
    }
    Ok(())
}
