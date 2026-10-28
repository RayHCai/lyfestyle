//! Runs the agent as a child process and streams its stdout to the frontend line by line.
//!
//! Default harness: the user's local Claude Code (`claude -p --output-format stream-json`).
//! Override: set `LYFESTYLE_AGENT_COMMAND` in the environment to any executable. It receives the
//! prompt on stdin, `--session <id>` when resuming, and may print either Claude-style JSON lines
//! or plain text.
//!
//! Every agent gets the same MCP servers: the app's own (`lyfestyle --mcp`, documents) and the
//! todo app's when Settings has its URL. Claude Code receives them as
//! `--mcp-config`; a custom command finds the same file in `LYFESTYLE_MCP_CONFIG`. Claude Code also
//! gets the user's SOUL.md (`soul.rs`) appended to its system prompt.

use crate::env_var;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use tauri::{AppHandle, Emitter, State};

pub const EVENT: &str = "agent-event";

/// Server secrets an agent has no use for. They reach the app when its environment was loaded
/// from `.env`, and Claude Code can read its own environment through its shell tools.
const SERVER_SECRETS: [&str; 3] = ["ENCRYPTION_KEY", "DATABASE_URL", "RESEND_API_KEY"];
/// The API bearer token. Kept for `LYFESTYLE_AGENT_COMMAND`, whose bridge
/// (`apps/runner/bin/lyfestyle-agent.mjs`) signs in to the API with it; Claude Code never gets it.
const API_TOKENS: [&str; 2] = ["API_TOKEN", "LYFESTYLE_API_TOKEN"];

type Children = Arc<Mutex<HashMap<String, Running>>>;

#[derive(Default)]
pub struct AgentState {
    children: Children,
    spawns: AtomicU64,
}

/// One agent process. A send for a conversation that still has one replaces it, so the reader
/// threads match on `spawn` and stop emitting once `superseded` is set: otherwise the old process's
/// last lines and its exit would land in the new turn.
struct Running {
    spawn: u64,
    child: Child,
    superseded: Arc<AtomicBool>,
}

impl AgentState {
    /// End every agent process tree; the app calls this as it exits.
    pub fn kill_all(&self) {
        let running: Vec<Running> = lock(&self.children).drain().map(|(_, r)| r).collect();
        for mut r in running {
            kill_tree(&mut r.child);
        }
    }
}

/// The map stays usable after a reader thread panics; nothing in it can be left half-updated.
fn lock(children: &Children) -> MutexGuard<'_, HashMap<String, Running>> {
    children.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Kill a child and everything under it. On Windows Claude Code runs under the npm shim's
/// cmd.exe, so killing the child alone would leave the agent running.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(crate::CREATE_NO_WINDOW)
            .output();
    }
    let _ = child.kill();
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
    /// `--effort` for Claude Code: low, medium, high, xhigh or max.
    pub effort: Option<String>,
    /// The todo app's Streamable HTTP MCP URL, secret path included.
    pub todo_mcp_url: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnv {
    pub harness: Option<String>,
    /// `LYFESTYLE_API_URL`, when the app should talk to the Lyfestyle API instead of local files.
    pub api_url: Option<String>,
    /// `LYFESTYLE_API_TOKEN`, falling back to `API_TOKEN` like the runner does.
    pub api_token: Option<String>,
}

#[tauri::command]
pub fn agent_env() -> AgentEnv {
    AgentEnv {
        harness: env_var("LYFESTYLE_AGENT_COMMAND"),
        api_url: env_var("LYFESTYLE_API_URL"),
        api_token: env_var("LYFESTYLE_API_TOKEN").or_else(|| env_var("API_TOKEN")),
    }
}

/// `LYFESTYLE_TODO_MCP_URL` from the environment, or in dev builds from the repo-root `.env`
/// (`pnpm desktop` does not load it). Only this key is read: loading the whole file would also
/// pick up `LYFESTYLE_API_URL` and switch the app to API mode.
fn env_todo_url() -> Option<String> {
    const KEY: &str = "LYFESTYLE_TODO_MCP_URL";
    if let Some(v) = env_var(KEY) {
        return Some(v);
    }
    if !cfg!(debug_assertions) {
        return None;
    }
    let dotenv = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env");
    std::fs::read_to_string(dotenv).ok()?.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        let v = v.trim().trim_matches('"');
        (k.trim() == KEY && !v.is_empty()).then(|| v.to_string())
    })
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

/// Write `mcp.json` (Claude Code's `--mcp-config` format) into the data folder and return its
/// path and the server names. Rewritten on every send so Settings changes apply to the next turn.
fn write_mcp_config(
    app: &AppHandle,
    todo_url: Option<&str>,
) -> Result<(PathBuf, Vec<String>), String> {
    let dir = crate::storage::base(app)?;
    let exe = std::env::current_exe().map_err(|e| format!("Could not locate the app: {e}"))?;
    let mut servers = serde_json::Map::new();
    servers.insert(
        "lyfestyle".into(),
        serde_json::json!({
            "type": "stdio",
            "command": exe,
            "args": ["--mcp", "--data-dir", dir],
        }),
    );
    if let Some(url) = todo_url.map(str::trim).filter(|u| !u.is_empty()) {
        servers.insert("todo".into(), serde_json::json!({ "type": "http", "url": url }));
    }
    let names = servers.keys().cloned().collect();
    let path = dir.join("mcp.json");
    let body = serde_json::json!({ "mcpServers": servers });
    // Sends run concurrently now, and another conversation's agent may be reading this file.
    crate::storage::write_atomic(&path, &body.to_string())
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok((path, names))
}

fn emit(app: &AppHandle, conversation_id: &str, kind: &str, line: String) {
    let _ = app.emit(
        EVENT,
        AgentEvent { conversation_id: conversation_id.to_string(), kind: kind.to_string(), line },
    );
}

#[tauri::command(async)]
pub fn agent_send(
    app: AppHandle,
    state: State<'_, AgentState>,
    args: SendArgs,
) -> Result<(), String> {
    let (command_line, from_env) = match env_var("LYFESTYLE_AGENT_COMMAND") {
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
    let cwd = args.cwd.as_deref().map(str::trim).filter(|d| !d.is_empty());
    if let Some(dir) = cwd {
        if !Path::new(dir).is_dir() {
            return Err(format!("Working directory {dir} does not exist."));
        }
    }
    let program = resolve_program(&words[0]);
    let mut argv: Vec<String> = words.drain(1..).collect();
    let todo_url = args.todo_mcp_url.clone().filter(|u| !u.trim().is_empty()).or_else(env_todo_url);
    let (mcp_config, mcp_servers) = write_mcp_config(&app, todo_url.as_deref())?;

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
        if let Some(effort) = args.effort.as_deref().filter(|e| !e.trim().is_empty()) {
            argv.push("--effort".into());
            argv.push(effort.to_string());
        }
        argv.push("--mcp-config".into());
        argv.push(mcp_config.to_string_lossy().into_owned());
        // Resumed sessions do not keep the system prompt, so the soul goes on every turn. The
        // `LYFESTYLE_AGENT_COMMAND` bridge gets it from the runner instead.
        if let Some(soul) = crate::soul::active(&app) {
            argv.push("--append-system-prompt-file".into());
            argv.push(soul.to_string_lossy().into_owned());
        }
        // Print mode cannot ask for permission, so the app's own servers are allowed up front.
        argv.push("--allowedTools".into());
        argv.push(mcp_servers.iter().map(|n| format!("mcp__{n}")).collect::<Vec<_>>().join(","));
        if let Some(sid) = &args.session_id {
            argv.push("--resume".into());
            argv.push(sid.clone());
        }
    }

    let mut cmd = Command::new(&program);
    cmd.args(&argv);
    cmd.env("LYFESTYLE_MCP_CONFIG", &mcp_config);
    for name in SERVER_SECRETS {
        cmd.env_remove(name);
    }
    if !from_env {
        for name in API_TOKENS {
            cmd.env_remove(name);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::CREATE_NO_WINDOW);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
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

    let spawn = state.spawns.fetch_add(1, Ordering::Relaxed);
    let superseded = Arc::new(AtomicBool::new(false));
    let previous = lock(&state.children)
        .insert(conversation_id.clone(), Running { spawn, child, superseded: superseded.clone() });
    if let Some(mut previous) = previous {
        previous.superseded.store(true, Ordering::Relaxed);
        // Its reader no longer finds it in the map, so reaping it falls to this send.
        thread::spawn(move || {
            kill_tree(&mut previous.child);
            let _ = previous.child.wait();
        });
    }

    if let Some(err) = stderr {
        let app2 = app.clone();
        let id = conversation_id.clone();
        let superseded = superseded.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if superseded.load(Ordering::Relaxed) {
                    break;
                }
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
                if superseded.load(Ordering::Relaxed) {
                    break;
                }
                emit(&app2, &id, "line", line);
            }
            let ours = {
                let mut map = lock(&children);
                match map.get(&id) {
                    Some(r) if r.spawn == spawn => map.remove(&id),
                    _ => None,
                }
            };
            // Waited on outside the lock, so other conversations' sends and cancels never queue
            // behind a process that is slow to exit.
            let code = ours.and_then(|mut r| r.child.wait().ok()).and_then(|s| s.code());
            if !superseded.load(Ordering::Relaxed) {
                emit(&app2, &id, "exit", code.unwrap_or(-1).to_string());
            }
        });
    }

    Ok(())
}

#[tauri::command(async)]
pub fn agent_cancel(state: State<'_, AgentState>, conversation_id: String) -> Result<(), String> {
    // Killed under the lock: while the entry is in the map its reader cannot reap the process, so
    // the PID taskkill is given cannot have been reused.
    if let Some(r) = lock(&state.children).get_mut(&conversation_id) {
        kill_tree(&mut r.child);
    }
    Ok(())
}
