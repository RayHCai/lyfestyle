//! `lyfestyle --mcp --data-dir <dir>`: a stdio MCP server over the app's own flat files.
//!
//! The local agent (Claude Code or `LYFESTYLE_AGENT_COMMAND`) gets it through the MCP config that
//! `agent.rs` writes, so it reads and changes the same documents the app shows. Tool names and
//! shapes follow the API's `/mcp` server where local mode has the same concept (automations run
//! only on the API server, so they have no tools here). The app re-reads the files when a turn ends.
//!
//! The release profile aborts on panic, so a panic here kills the server mid-conversation: tool
//! input and the files on disk are untrusted and must never be indexed or unwrapped blindly.

use crate::storage::write_atomic;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, ErrorKind, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Protocol versions this server can speak, newest first; the same ones the API's MCP SDK takes.
const PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INDEX: &str = "documents/index.json";

const INSTRUCTIONS: &str = "\
Tools for the user's Lyfestyle workspace: their documents (called pages here).

Pages are markdown. Link to another page with [label](page:<page id>). Call pages_search or \
pages_list_recent to find ids, pages_get for the full text.";

/// Serve until stdin closes. Arguments are what followed `--mcp` on the command line.
pub fn serve(args: impl Iterator<Item = String>) {
    let mut args = args.peekable();
    let mut dir = None;
    while let Some(arg) = args.next() {
        if arg == "--data-dir" {
            dir = args.next().map(PathBuf::from);
        }
    }
    let Some(dir) = dir else {
        eprintln!("lyfestyle --mcp needs --data-dir <path>");
        std::process::exit(2);
    };
    let store = Store { dir };
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(&store, &msg),
            Err(e) => Some(error(Value::Null, -32700, format!("Parse error: {e}"))),
        };
        if let Some(reply) = reply {
            // stdout carries the protocol only; a closed pipe means the client is gone.
            if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
}

fn error(id: Value, code: i32, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One JSON-RPC message in, at most one out. Notifications and stray responses get no reply;
/// anything else that is not a request gets Invalid Request.
fn handle(store: &Store, msg: &Value) -> Option<Value> {
    let Some(obj) = msg.as_object() else {
        return Some(error(Value::Null, -32600, "Invalid Request: expected an object".into()));
    };
    let id = obj.get("id").cloned();
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        if id.is_some() && (obj.contains_key("result") || obj.contains_key("error")) {
            return None;
        }
        let id = id.filter(|id| id.is_string() || id.is_number()).unwrap_or(Value::Null);
        return Some(error(id, -32600, "Invalid Request: method is missing".into()));
    };
    let id = id?;
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            Ok(json!({
                "protocolVersion": asked.filter(|v| PROTOCOLS.contains(v)).unwrap_or(PROTOCOLS[0]),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "lyfestyle", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            Ok(match run(store, name, &args) {
                Ok(v) => json!({ "content": [{ "type": "text", "text": v.to_string() }] }),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            })
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error(id, code, message),
    })
}

/// The annotations the API sends for the same tools.
enum Kind {
    Read,
    Write,
    Destructive,
}

fn tools() -> Value {
    let id = json!({ "type": "string", "description": "Page id" });
    let tool = |name: &str, kind: Kind, description: &str, properties: Value, required: &[&str]| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": { "type": "object", "properties": properties, "required": required },
            "annotations": {
                "readOnlyHint": matches!(kind, Kind::Read),
                "destructiveHint": matches!(kind, Kind::Destructive),
            },
        })
    };
    json!([
        tool(
            "pages_search",
            Kind::Read,
            "Search the user's documents. Matches words in page titles and bodies, and partial titles. Returns summaries with a short excerpt; call pages_get for the full markdown.",
            json!({
                "query": { "type": "string", "minLength": 1 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
            }),
            &["query"],
        ),
        tool(
            "pages_list_recent",
            Kind::Read,
            "List the most recently edited pages, newest first.",
            json!({ "limit": { "type": "integer", "minimum": 1, "maximum": 100 } }),
            &[],
        ),
        tool(
            "pages_get",
            Kind::Read,
            "Read one page in full: title and markdown content.",
            json!({ "id": id }),
            &["id"],
        ),
        tool(
            "pages_create",
            Kind::Write,
            "Create a page. Content is markdown. Link to another page with [label](page:<page id>); links may form cycles.",
            json!({ "title": { "type": "string" }, "content": { "type": "string" } }),
            &["title"],
        ),
        tool(
            "pages_update",
            Kind::Write,
            "Replace a page's title or content. Fields left out are unchanged.",
            json!({ "id": id, "title": { "type": "string" }, "content": { "type": "string" } }),
            &["id"],
        ),
        tool(
            "pages_append",
            Kind::Write,
            "Add markdown to the end of a page without rewriting what is there.",
            json!({ "id": id, "content": { "type": "string", "minLength": 1 } }),
            &["id", "content"],
        ),
        tool(
            "pages_delete",
            Kind::Destructive,
            "Delete a page permanently. Local mode has no trash.",
            json!({ "id": id }),
            &["id"],
        ),
        tool(
            "pages_backlinks",
            Kind::Read,
            "List the pages that link to a page.",
            json!({ "id": id }),
            &["id"],
        ),
    ])
}

fn run(store: &Store, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "pages_search" => {
            let query = non_empty(args, "query")?.to_lowercase();
            let words: Vec<&str> = query.split_whitespace().collect();
            let limit = count(args, 10, 50);
            let mut hits = vec![];
            for meta in store.docs()? {
                let title = field(&meta, "title").to_lowercase();
                // One unreadable file should not hide every other match.
                let Ok(body) = store.read_doc(field(&meta, "id")) else { continue };
                let lower = body.to_lowercase();
                let matches = title.contains(&query)
                    || (!words.is_empty()
                        && words.iter().all(|w| title.contains(w) || lower.contains(w)));
                if matches {
                    let excerpt = body
                        .lines()
                        .find(|l| words.iter().any(|w| l.to_lowercase().contains(w)))
                        .unwrap_or("")
                        .trim()
                        .chars()
                        .take(200)
                        .collect::<String>();
                    let mut hit = meta;
                    hit["excerpt"] = json!(excerpt);
                    hits.push(hit);
                }
                if hits.len() >= limit {
                    break;
                }
            }
            Ok(json!(hits))
        }
        "pages_list_recent" => {
            Ok(json!(store.docs()?.into_iter().take(count(args, 20, 100)).collect::<Vec<_>>()))
        }
        "pages_get" => {
            let mut page = store.find_doc(text(args, "id")?)?;
            page["content"] = json!(store.read_doc(field(&page, "id"))?);
            Ok(page)
        }
        "pages_create" => {
            let now = now();
            let meta = json!({
                "id": uuid(),
                "title": title(text(args, "title")?),
                "createdAt": now,
                "updatedAt": now,
            });
            store.write_doc(field(&meta, "id"), optional(args, "content").unwrap_or(""))?;
            let mut docs = store.docs()?;
            docs.insert(0, meta.clone());
            store.write_list(INDEX, &docs)?;
            Ok(meta)
        }
        "pages_update" | "pages_append" => {
            let id = text(args, "id")?;
            let content = if name == "pages_append" {
                let more = non_empty(args, "content")?;
                let current = store.read_doc(id)?;
                let current = current.trim_end();
                Some(if current.is_empty() {
                    more.to_string()
                } else {
                    format!("{current}\n\n{more}")
                })
            } else {
                optional(args, "content").map(str::to_string)
            };
            // Found in the same list that is written back, so nothing goes stale between reads.
            let mut docs = store.docs()?;
            let meta = docs
                .iter_mut()
                .find(|d| d["id"] == id)
                .ok_or_else(|| format!("No page with id {id}"))?;
            if let Some(content) = &content {
                store.write_doc(id, content)?;
            }
            if name == "pages_update" {
                if let Some(t) = optional(args, "title") {
                    meta["title"] = json!(title(t));
                }
            }
            meta["updatedAt"] = json!(now());
            let meta = meta.clone();
            docs.sort_by_key(|d| std::cmp::Reverse(d["updatedAt"].as_u64().unwrap_or(0)));
            store.write_list(INDEX, &docs)?;
            Ok(meta)
        }
        "pages_delete" => {
            let id = text(args, "id")?;
            let path = store.doc_path(id)?;
            let mut docs = store.docs()?;
            let at = docs
                .iter()
                .position(|d| d["id"] == id)
                .ok_or_else(|| format!("No page with id {id}"))?;
            let meta = docs.remove(at);
            store.write_list(INDEX, &docs)?;
            match fs::remove_file(path) {
                Err(e) if e.kind() != ErrorKind::NotFound => {
                    return Err(format!("Could not delete page {id}: {e}"))
                }
                _ => {}
            }
            Ok(json!({ "deleted": meta }))
        }
        "pages_backlinks" => {
            let id = text(args, "id")?;
            store.find_doc(id)?;
            // The API's link syntax, `[label](page:<id>)`; ids are lowercase UUIDs.
            let needle = format!("](page:{})", id.to_lowercase());
            let mut pages = vec![];
            for meta in store.docs()? {
                let Ok(body) = store.read_doc(field(&meta, "id")) else { continue };
                if body.to_lowercase().contains(&needle) {
                    pages.push(meta);
                }
            }
            Ok(json!(pages))
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

struct Store {
    dir: PathBuf,
}

impl Store {
    fn read_list(&self, rel: &str) -> Result<Vec<Value>, String> {
        match fs::read_to_string(self.dir.join(rel)) {
            Ok(s) if s.trim().is_empty() => Ok(vec![]),
            Ok(s) => serde_json::from_str(&s).map_err(|e| format!("{rel} is not valid JSON: {e}")),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(format!("Could not read {rel}: {e}")),
        }
    }

    fn write_list(&self, rel: &str, list: &[Value]) -> Result<(), String> {
        let body = serde_json::to_string(list).map_err(|e| e.to_string())?;
        write_atomic(&self.dir.join(rel), &body).map_err(|e| format!("Could not write {rel}: {e}"))
    }

    /// The index, newest first, the order the app shows. Entries that are not objects are
    /// dropped, so later code can set fields on any entry without panicking.
    fn docs(&self) -> Result<Vec<Value>, String> {
        let mut docs = self.read_list(INDEX)?;
        docs.retain(Value::is_object);
        docs.sort_by_key(|d| std::cmp::Reverse(d["updatedAt"].as_u64().unwrap_or(0)));
        Ok(docs)
    }

    fn find_doc(&self, id: &str) -> Result<Value, String> {
        self.docs()?
            .into_iter()
            .find(|d| d["id"] == id)
            .ok_or_else(|| format!("No page with id {id}"))
    }

    fn doc_path(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(format!("Invalid page id: {id}"));
        }
        Ok(self.dir.join("documents").join(format!("{id}.md")))
    }

    fn read_doc(&self, id: &str) -> Result<String, String> {
        match fs::read_to_string(self.doc_path(id)?) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("Could not read page {id}: {e}")),
        }
    }

    fn write_doc(&self, id: &str, content: &str) -> Result<(), String> {
        write_atomic(&self.doc_path(id)?, content)
            .map_err(|e| format!("Could not write page {id}: {e}"))
    }
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    optional(args, key).ok_or_else(|| format!("{key} is required"))
}

/// Like the API's `z.string().min(1)`.
fn non_empty<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    Some(text(args, key)?).filter(|s| !s.is_empty()).ok_or_else(|| format!("{key} is empty"))
}

fn optional<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn field<'a>(meta: &'a Value, key: &str) -> &'a str {
    meta.get(key).and_then(Value::as_str).unwrap_or("")
}

fn count(args: &Value, fallback: usize, max: usize) -> usize {
    args.get("limit").and_then(Value::as_u64).map_or(fallback, |n| (n as usize).clamp(1, max))
}

fn title(t: &str) -> String {
    let t = t.trim();
    if t.is_empty() {
        "Untitled".into()
    } else {
        t.into()
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A v4-style UUID like the app's `crypto.randomUUID()`, from std's randomly keyed hasher.
fn uuid() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store in a fresh temp folder, removed again when the test ends, pass or fail.
    struct TempStore(Store);

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.dir);
        }
    }

    impl std::ops::Deref for TempStore {
        type Target = Store;
        fn deref(&self) -> &Store {
            &self.0
        }
    }

    fn store() -> TempStore {
        let dir = std::env::temp_dir().join(format!("lyfestyle-mcp-{}", uuid()));
        fs::create_dir_all(&dir).unwrap();
        TempStore(Store { dir })
    }

    fn reply(store: &Store, name: &str, args: Value) -> Value {
        let reply = handle(
            store,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } }),
        )
        .unwrap();
        reply["result"].clone()
    }

    fn call(store: &Store, name: &str, args: Value) -> Value {
        let result = reply(store, name, args);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(result.get("isError").is_none(), "{name} failed: {text}");
        serde_json::from_str(text).unwrap()
    }

    fn fails(store: &Store, name: &str, args: Value) -> String {
        let result = reply(store, name, args);
        assert_eq!(result["isError"], true, "{name} should have failed");
        result["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn answers_the_handshake_and_skips_notifications() {
        let s = store();
        let init = |version: &str| {
            handle(&s, &json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": version } }))
                .unwrap()
        };
        assert_eq!(init("2025-03-26")["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init("1999-01-01")["result"]["protocolVersion"], PROTOCOLS[0]);
        assert_eq!(init("2025-03-26")["result"]["serverInfo"]["name"], "lyfestyle");
        assert!(handle(&s, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .is_none());
        assert!(handle(&s, &json!({ "jsonrpc": "2.0", "id": 3, "result": {} })).is_none());
        let list =
            handle(&s, &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 8);
        let delete = tools.iter().find(|t| t["name"] == "pages_delete").unwrap();
        assert_eq!(delete["annotations"]["destructiveHint"], true);
    }

    #[test]
    fn rejects_json_that_is_not_a_request() {
        let s = store();
        for msg in [json!([1, 2]), json!("ping"), json!({ "jsonrpc": "2.0", "id": 7 })] {
            let reply = handle(&s, &msg).unwrap();
            assert_eq!(reply["error"]["code"], -32600, "{msg}");
        }
        assert_eq!(handle(&s, &json!({ "id": 7 })).unwrap()["id"], 7);
    }

    #[test]
    fn pages_round_trip_through_the_app_files() {
        let s = store();
        let page = call(&s, "pages_create", json!({ "title": "Groceries", "content": "- eggs" }));
        let id = page["id"].as_str().unwrap().to_string();
        assert_eq!(fs::read_to_string(s.dir.join(format!("documents/{id}.md"))).unwrap(), "- eggs");

        call(&s, "pages_append", json!({ "id": id, "content": "- milk" }));
        let got = call(&s, "pages_get", json!({ "id": id }));
        assert_eq!(got["content"], "- eggs\n\n- milk");

        let hits = call(&s, "pages_search", json!({ "query": "milk" }));
        assert_eq!(hits[0]["excerpt"], "- milk");

        call(&s, "pages_update", json!({ "id": id, "title": "Shopping" }));
        assert_eq!(call(&s, "pages_list_recent", json!({}))[0]["title"], "Shopping");

        call(&s, "pages_delete", json!({ "id": id }));
        assert_eq!(call(&s, "pages_list_recent", json!({})), json!([]));
        assert!(!s.dir.join(format!("documents/{id}.md")).exists());
    }

    #[test]
    fn rejects_empty_input_and_unknown_ids_without_panicking() {
        let s = store();
        let page = call(&s, "pages_create", json!({ "title": "Notes" }));
        assert!(fails(&s, "pages_search", json!({ "query": "" })).contains("query"));
        assert!(fails(&s, "pages_append", json!({ "id": page["id"], "content": "" }))
            .contains("content"));
        for tool in ["pages_update", "pages_append", "pages_delete", "pages_backlinks"] {
            let missing = "00000000-0000-4000-8000-000000000000";
            assert!(fails(&s, tool, json!({ "id": missing, "content": "x" })).contains("No page"));
        }
        // A hand-edited index with junk in it.
        fs::write(s.dir.join(INDEX), r#"[1, "x", null, {"id": "a", "title": "A"}]"#).unwrap();
        assert_eq!(call(&s, "pages_list_recent", json!({})).as_array().unwrap().len(), 1);
        assert_eq!(call(&s, "pages_update", json!({ "id": "a", "title": "B" }))["title"], "B");
    }

    #[test]
    fn lists_backlinks_and_skips_unreadable_pages_in_search() {
        let s = store();
        let target = call(&s, "pages_create", json!({ "title": "Target" }));
        let id = target["id"].as_str().unwrap();
        let from = call(
            &s,
            "pages_create",
            json!({ "title": "Source", "content": format!("see [it](page:{id}) target") }),
        );
        call(&s, "pages_create", json!({ "title": "Other", "content": "target, no link" }));
        let links = call(&s, "pages_backlinks", json!({ "id": id }));
        assert_eq!(links.as_array().unwrap().len(), 1);
        assert_eq!(links[0]["id"], from["id"]);

        // An index entry whose file name is not a valid id cannot be read; search goes on.
        let mut index: Vec<Value> =
            serde_json::from_str(&fs::read_to_string(s.dir.join(INDEX)).unwrap()).unwrap();
        index.push(json!({ "id": "../escape", "title": "target" }));
        fs::write(s.dir.join(INDEX), serde_json::to_string(&index).unwrap()).unwrap();
        let hits = call(&s, "pages_search", json!({ "query": "target" }));
        assert_eq!(hits.as_array().unwrap().len(), 3);
    }

    /// Releases bump `tauri.conf.json`; `serverInfo.version` reports Cargo's.
    #[test]
    fn cargo_version_matches_the_tauri_config() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"));
    }
}
