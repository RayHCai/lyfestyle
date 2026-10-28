//! Skills from a folder of `<name>/SKILL.md`, made visible to the local Claude Code.
//!
//! `claude -p` loads user skills from `~/.claude/skills`, so each skill folder is linked there (a
//! junction on Windows, which needs no admin rights). Existing entries are left alone. The list
//! feeds the composer's `/` menu.

use crate::env_var;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
}

/// `name`, `description` and `user-invocable` from the YAML frontmatter; enough for flat keys.
fn frontmatter(text: &str) -> Option<(Option<String>, String, bool)> {
    let body = text.trim_start_matches('\u{feff}').strip_prefix("---")?;
    let end = body.find("\n---")?;
    let (mut name, mut description, mut invocable) = (None, String::new(), true);
    for line in body[..end].lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = value,
            "user-invocable" => invocable = value != "false",
            _ => {}
        }
    }
    Some((name, description, invocable))
}

/// `path` as it can go between double quotes on a cmd.exe command line. cmd has no escape for
/// `"` inside quotes and expands `%VAR%` even there.
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_quotable(path: &Path) -> Result<&str, String> {
    let text = path.to_str().ok_or_else(|| format!("{} is not valid Unicode", path.display()))?;
    if text.contains(['"', '%']) || text.chars().any(char::is_control) {
        return Err(format!("{text} contains \", % or a control character"));
    }
    Ok(text)
}

fn link(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let (link, target) = (cmd_quotable(link)?, cmd_quotable(target)?);
        // mklink is a cmd.exe builtin, so the line is cmd syntax: quoting keeps `&`, `|` and the
        // like in a folder name from running anything. Rust's own argument quoting is for
        // CommandLineToArgvW, which cmd does not use. /D skips AutoRun, /V:OFF keeps `!` literal.
        let output = std::process::Command::new("cmd")
            .raw_arg(format!(r#"/D /V:OFF /C mklink /J "{link}" "{target}""#))
            .creation_flags(crate::CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Could not run mklink: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        })
        .trim()
        .to_string();
        Err(format!("mklink /J failed: {text}"))
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
    }
}

/// Return the user-invocable skills, sorted by name. With a folder (`dir`, else
/// `LYFESTYLE_SKILLS_DIR`) every skill in it is first linked into `~/.claude/skills`; without one
/// this lists what is already there. A folder that cannot be read or linked is skipped and logged.
#[tauri::command(async)]
pub fn skills_load(app: AppHandle, dir: Option<String>) -> Result<Vec<Skill>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let user_skills = home.join(".claude").join("skills");
    let source = dir
        .filter(|d| !d.trim().is_empty())
        .or_else(|| env_var("LYFESTYLE_SKILLS_DIR"))
        .map(PathBuf::from);
    let (dir, link_into) = match source {
        Some(dir) => (dir, Some(user_skills.as_path())),
        None => (user_skills.clone(), None),
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Could not read {}: {e}", dir.display())),
    };
    if let Some(into) = link_into {
        fs::create_dir_all(into)
            .map_err(|e| format!("Could not create {}: {e}", into.display()))?;
    }

    let mut skills = vec![];
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                eprintln!("lyfestyle: skipped an entry in {}: {e}", dir.display());
                continue;
            }
        };
        let path = entry.path();
        let Ok(text) = fs::read_to_string(path.join("SKILL.md")) else { continue };
        let Some((name, description, invocable)) = frontmatter(&text) else { continue };
        let folder = entry.file_name().to_string_lossy().into_owned();
        if let Some(into) = link_into {
            let linked = into.join(&folder);
            // A broken link still exists as an entry; symlink_metadata sees it, exists() does not.
            if fs::symlink_metadata(&linked).is_err() {
                if let Err(e) = link(&path, &linked) {
                    // Claude Code could not load it, so it stays out of the menu too.
                    eprintln!("lyfestyle: skipped skill {folder}: {e}");
                    continue;
                }
            }
        }
        if invocable {
            skills.push(Skill { name: name.unwrap_or(folder), description });
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

#[cfg(test)]
mod tests {
    use super::{cmd_quotable, frontmatter};
    use std::path::Path;

    #[test]
    fn reads_flat_frontmatter() {
        let text = "\u{feff}---\nname: larp\ndescription: \"Check: is it larp\"\nuser-invocable: false\n---\nbody";
        let (name, description, invocable) = frontmatter(text).unwrap();
        assert_eq!(name.as_deref(), Some("larp"));
        assert_eq!(description, "Check: is it larp");
        assert!(!invocable);
    }

    #[test]
    fn quotes_only_paths_cmd_cannot_misread() {
        assert!(cmd_quotable(Path::new(r"C:\skills\x&calc")).is_ok());
        assert!(cmd_quotable(Path::new(r"C:\skills\a (b) | c ^ d")).is_ok());
        assert!(cmd_quotable(Path::new(r"C:\skills\%PATH%")).is_err());
        assert!(cmd_quotable(Path::new(r"C:\skills\x!y")).is_ok());
        assert!(cmd_quotable(Path::new("C:\\skills\\a\"b")).is_err());
        assert!(cmd_quotable(Path::new("C:\\skills\\a\nb")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn links_a_folder_whose_name_cmd_would_run() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("lyfestyle-skills-{}", std::process::id()));
        // No space, so nothing quotes it by accident. Unquoted, cmd would run `echo.injected!`
        // after a failed mklink and report success; quoted, it is just part of the name.
        let target = root.join("source").join("x&echo.injected!");
        let linked = root.join("linked").join("x&echo.injected!");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(linked.parent().unwrap()).unwrap();
        fs::write(target.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
        let result = super::link(&target, &linked);
        let through = fs::read_to_string(linked.join("SKILL.md"));
        // Remove the junction itself first so cleanup never walks into the target.
        let _ = fs::remove_dir(&linked);
        fs::remove_dir_all(&root).unwrap();
        result.unwrap();
        assert!(through.unwrap().contains("name: x"));
    }
}
