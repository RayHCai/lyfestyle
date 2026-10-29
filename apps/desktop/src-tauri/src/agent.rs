//! Runs the agent as a child process and streams its stdout to the frontend line by line.
//!
//! Harnesses: the user's local Claude Code (`claude -p --output-format stream-json`, the default),
//! Codex (`codex exec --json`, whose JSON lines the frontend translates), or a custom command.
//! `LYFESTYLE_AGENT_COMMAND` in the environment overrides all three. A custom command receives the
//! prompt on stdin, `--session <id>` when resuming, and may print either Claude-style JSON lines
//! or plain text.
//!
//! In API mode the frontend runs claimed API runs through here too: it passes the run's MCP
//! servers (the API's own, with the run's agent token) in place of the app's local tool server.
//!
//! Every agent gets the same MCP servers: the app's own (`lyfestyle --mcp`, documents) and the
//! todo app's when Settings has its URL. Claude Code receives them as
//! `--mcp-config`; a custom command finds the same file in `LYFESTYLE_MCP_CONFIG`. Claude Code also
//! gets the user's SOUL.md (`soul.rs`) appended to its system prompt.

use crate::env_var;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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

#[derive(PartialEq, Clone, Copy)]
enum Kind {
    ClaudeCode,
    Codex,
    Command,
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
    /// `claude-code` (the default), `codex` or `command`.
    pub harness: Option<String>,
    /// An API run's servers in `--mcp-config` shape. They replace the app's local tool server and
    /// go in a file of their own, removed when the process exits, since they carry the run's token.
    pub mcp_servers: Option<Map<String, Value>>,
    /// Claude Code's `--max-budget-usd`: an API run's spending cap.
    pub max_budget_usd: Option<f64>,
}

/// A harness CLI the app knows how to drive, and where it was found on PATH.
#[derive(Serialize)]
pub struct DetectedHarness {
    pub id: &'static str,
    pub path: Option<String>,
}

const KNOWN: [(&str, &str); 2] = [("claude-code", "claude"), ("codex", "codex")];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnv {
    pub harness: Option<String>,
    /// `LYFESTYLE_API_URL`, when the app should talk to the Lyfestyle API instead of local files.
    pub api_url: Option<String>,
    /// `LYFESTYLE_API_TOKEN`, falling back to `API_TOKEN` like the runner does.
    pub api_token: Option<String>,
    /// Claude Code and Codex, with their path when they are on PATH.
    pub harnesses: Vec<DetectedHarness>,
}

#[tauri::command]
pub fn agent_env() -> AgentEnv {
    AgentEnv {
        harness: env_var("LYFESTYLE_AGENT_COMMAND"),
        api_url: env_var("LYFESTYLE_API_URL"),
        api_token: env_var("LYFESTYLE_API_TOKEN").or_else(|| env_var("API_TOKEN")),
        harnesses: KNOWN
            .iter()
            .map(|(id, program)| DetectedHarness {
                id,
                path: find_program(program).map(|p| p.to_string_lossy().into_owned()),
            })
            .collect(),
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

/// Find a bare program name (`claude`, `codex`) on PATH, including the npm `.cmd` shim on Windows.
fn find_program(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).find_map(|dir| {
        exts.iter().map(|ext| dir.join(format!("{name}{ext}"))).find(|c| c.is_file())
    })
}

/// A program as given when it is a path, else found on PATH.
fn resolve_program(name: &str) -> PathBuf {
    let given = Path::new(name);
    if given.components().count() > 1 || given.extension().is_some() {
        return given.to_path_buf();
    }
    find_program(name).unwrap_or_else(|| given.to_path_buf())
}

/// A TOML basic string. JSON's string escapes are all valid TOML.
fn toml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn toml_table<'a>(pairs: impl Iterator<Item = (&'a String, String)>) -> String {
    let body: Vec<String> = pairs.map(|(k, v)| format!("{}={v}", toml_str(k))).collect();
    format!("{{{}}}", body.join(","))
}

/// Codex takes MCP servers as `-c mcp_servers.<name>.<key>=<toml>` overrides. HTTP headers go
/// through `env_http_headers` (header -> variable name), so a token sits in the child's
/// environment rather than on its command line; the returned pairs are those variables.
fn codex_mcp_args(servers: &Map<String, Value>) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = vec![];
    let mut env = vec![];
    for (i, (name, spec)) in servers.iter().enumerate() {
        // Codex splits the override key on dots, so only plain names can be addressed.
        if name.is_empty()
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            eprintln!("codex: skipping MCP server {name:?}: unsupported name");
            continue;
        }
        let mut set = |k: &str, v: String| {
            args.push("-c".to_string());
            args.push(format!("mcp_servers.{name}.{k}={v}"));
        };
        let text = |k: &str| spec.get(k).and_then(Value::as_str);
        if let Some(command) = text("command") {
            set("command", toml_str(command));
            let argv: Vec<String> = spec
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(toml_str).collect())
                .unwrap_or_default();
            set("args", format!("[{}]", argv.join(",")));
            if let Some(vars) = spec.get("env").and_then(Value::as_object) {
                set(
                    "env",
                    toml_table(vars.iter().filter_map(|(k, v)| Some((k, toml_str(v.as_str()?))))),
                );
            }
        } else if let Some(url) = text("url") {
            set("url", toml_str(url));
            if let Some(headers) = spec.get("headers").and_then(Value::as_object) {
                let mut names = vec![];
                for (j, (header, value)) in headers.iter().enumerate() {
                    let Some(value) = value.as_str() else { continue };
                    let var = format!("LYFESTYLE_MCP_{i}_{j}");
                    names.push((header, toml_str(&var)));
                    env.push((var, value.to_string()));
                }
                if !names.is_empty() {
                    set("env_http_headers", toml_table(names.into_iter()));
                }
            }
        }
    }
    (args, env)
}

/// Write `mcp.json` (Claude Code's `--mcp-config` format) into the data folder and return its
/// path and the server names. Rewritten on every send so Settings changes apply to the next turn.
/// With `run_servers` (an API run's id and servers), those replace the local tool server and the
/// file is `mcp-<id>.json`, private to that process.
fn write_mcp_config(
    app: &AppHandle,
    todo_url: Option<&str>,
    run_servers: Option<(&str, &Map<String, Value>)>,
) -> Result<(PathBuf, Map<String, Value>), String> {
    let dir = crate::storage::base(app)?;
    let mut servers = Map::new();
    let file = match run_servers {
        Some((id, given)) => {
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(format!("Invalid run id {id:?}."));
            }
            servers.extend(given.clone());
            format!("mcp-{id}.json")
        }
        None => {
            let exe =
                std::env::current_exe().map_err(|e| format!("Could not locate the app: {e}"))?;
            servers.insert(
                "lyfestyle".into(),
                serde_json::json!({
                    "type": "stdio",
                    "command": exe,
                    "args": ["--mcp", "--data-dir", dir],
                }),
            );
            "mcp.json".into()
        }
    };
    if let Some(url) = todo_url.map(str::trim).filter(|u| !u.is_empty()) {
        servers.entry("todo").or_insert_with(|| serde_json::json!({ "type": "http", "url": url }));
    }
    let path = dir.join(file);
    let body = serde_json::json!({ "mcpServers": servers });
    // Sends run concurrently now, and another conversation's agent may be reading this file.
    crate::storage::write_atomic(&path, &body.to_string())
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok((path, servers))
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
    let given = args.command.clone().filter(|c| !c.trim().is_empty());
    let (command_line, kind) = match env_var("LYFESTYLE_AGENT_COMMAND") {
        Some(h) => (h, Kind::Command),
        None => match args.harness.as_deref() {
            Some("codex") => (given.unwrap_or_else(|| "codex".into()), Kind::Codex),
            Some("command") => {
                (given.ok_or("Set the custom agent command in Settings.")?, Kind::Command)
            }
            _ => (given.unwrap_or_else(|| "claude".into()), Kind::ClaudeCode),
        },
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
    let run_servers = args.mcp_servers.as_ref().map(|s| (args.conversation_id.as_str(), s));
    let (mcp_config, mcp_servers) = write_mcp_config(&app, todo_url.as_deref(), run_servers)?;
    let private_config = run_servers.is_some().then(|| mcp_config.clone());
    let mut prompt = args.prompt.clone();
    let mut extra_env = vec![];

    if kind == Kind::Command {
        if let Some(sid) = &args.session_id {
            argv.push("--session".into());
            argv.push(sid.clone());
        }
    } else if kind == Kind::Codex {
        argv.extend(["exec", "--json", "--skip-git-repo-check"].iter().map(|s| s.to_string()));
        if let Some(model) = args.model.as_deref().filter(|m| !m.trim().is_empty()) {
            argv.push("--model".into());
            argv.push(model.to_string());
        }
        if let Some(effort) = args.effort.as_deref().filter(|e| !e.trim().is_empty()) {
            argv.push("-c".into());
            argv.push(format!("model_reasoning_effort={}", toml_str(effort)));
        }
        let (mcp_args, env) = codex_mcp_args(&mcp_servers);
        argv.extend(mcp_args);
        extra_env = env;
        match &args.session_id {
            Some(sid) => {
                argv.push("resume".into());
                argv.push(sid.clone());
            }
            // Codex has no system-prompt flag, so a fresh session gets the soul as context.
            None => {
                if let Some(soul) = crate::soul::active(&app)
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .filter(|s| !s.trim().is_empty())
                {
                    prompt = format!("<soul>\n{}\n</soul>\n\n{prompt}", soul.trim());
                }
            }
        }
        // `-` reads the prompt from stdin.
        argv.push("-".into());
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
        if let Some(budget) = args.max_budget_usd.filter(|b| *b > 0.0) {
            argv.push("--max-budget-usd".into());
            argv.push(budget.to_string());
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
        argv.push(mcp_servers.keys().map(|n| format!("mcp__{n}")).collect::<Vec<_>>().join(","));
        if let Some(sid) = &args.session_id {
            argv.push("--resume".into());
            argv.push(sid.clone());
        }
    }

    let mut cmd = Command::new(&program);
    cmd.args(&argv);
    cmd.env("LYFESTYLE_MCP_CONFIG", &mcp_config);
    cmd.envs(extra_env);
    for name in SERVER_SECRETS {
        cmd.env_remove(name);
    }
    if kind != Kind::Command {
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
            if let Some(path) = private_config {
                let _ = std::fs::remove_file(path);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_mcp_args_keep_tokens_off_the_command_line() {
        let servers: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "lyfestyle": {
                "type": "http",
                "url": "https://api.example/mcp",
                "headers": { "Authorization": "Bearer secret" }
            },
            "files": { "type": "stdio", "command": "srv", "args": ["--a", "b c"], "env": { "K": "v" } },
            "bad.name": { "type": "http", "url": "https://x" }
        }))
        .unwrap();
        let (args, env) = codex_mcp_args(&servers);
        let joined = args.join(" ");
        assert!(!joined.contains("secret"));
        assert!(!joined.contains("bad.name"));
        for expected in [
            r#"mcp_servers.lyfestyle.url="https://api.example/mcp""#,
            r#"mcp_servers.files.command="srv""#,
            r#"mcp_servers.files.args=["--a","b c"]"#,
            r#"mcp_servers.files.env={"K"="v"}"#,
        ] {
            assert!(args.iter().any(|a| a == expected), "missing {expected}");
        }
        let (var, value) = env.first().unwrap();
        assert_eq!(value, "Bearer secret");
        assert!(args
            .iter()
            .any(|a| a.ends_with(&format!(r#"env_http_headers={{"Authorization"="{var}"}}"#))));
    }
}
