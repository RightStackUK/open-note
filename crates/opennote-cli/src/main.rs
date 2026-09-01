//! `opennote` — the automation surface.
//!
//! A CLI rather than platform-native automation frameworks, deliberately: it
//! works on all three desktop platforms, composes with everything a shell can
//! do, needs no native extension target, and gives the scripting story a home
//! that survives the move to mobile.
//!
//! The vault is addressed directly on disk — `--vault`, `$OPEN_NOTE_VAULT`, or
//! the repository the working directory sits in. `open` alone talks to the
//! app, through the same `opennote://` scheme a browser would use.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use git_port::{GitPort, SystemGit};

const USAGE: &str = "\
opennote — Markdown notes, backed by Git

USAGE:
  opennote new <title> [--vault DIR] [--folder F] [--tags a,b] [--body TEXT|-]
  opennote append <path> [--vault DIR] [TEXT|-]
  opennote search <query> [--vault DIR]
  opennote open <path> [--vault DIR]

  new     Create a note. Refuses to overwrite; `--body -` reads stdin.
  append  Add text to the end of a note, creating it if missing. `-` reads stdin.
  search  Case-insensitive text search over the vault's notes; prints path:line.
  open    Open a note in the Open Note app, via the opennote:// URL scheme.

  The vault is --vault, then $OPEN_NOTE_VAULT, then the Git repository the
  working directory is inside.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("opennote: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    let mut positional: Vec<String> = Vec::new();
    let mut vault: Option<PathBuf> = None;
    let mut folder = String::new();
    let mut tags = String::new();
    let mut body: Option<String> = None;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--vault" => vault = Some(PathBuf::from(expect_value(&mut iter, "--vault")?)),
            "--folder" => folder = expect_value(&mut iter, "--folder")?,
            "--tags" => tags = expect_value(&mut iter, "--tags")?,
            "--body" => body = Some(expect_value(&mut iter, "--body")?),
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            other if other.starts_with("--") => {
                return Err(format!("unknown flag `{other}` — try --help"));
            }
            _ => positional.push(arg),
        }
    }

    let Some(command) = positional.first().cloned() else {
        println!("{USAGE}");
        return Ok(());
    };

    match command.as_str() {
        "new" => {
            let title = positional.get(1).ok_or("new needs a title")?.clone();
            let root = resolve_vault(vault)?;
            let text = match body.as_deref() {
                Some("-") => read_stdin()?,
                Some(text) => text.to_string(),
                None => String::new(),
            };
            new_note(&root, &title, &folder, &tags, &text)
        }
        "append" => {
            let path = positional.get(1).ok_or("append needs a note path")?.clone();
            let root = resolve_vault(vault)?;
            let text = match positional.get(2).map(String::as_str) {
                Some("-") | None => read_stdin()?,
                Some(text) => text.to_string(),
            };
            append_note(&root, &path, &text)
        }
        "search" => {
            let query = positional.get(1).ok_or("search needs a query")?.clone();
            let root = resolve_vault(vault)?;
            search_notes(&root, &query)
        }
        "open" => {
            let path = positional.get(1).ok_or("open needs a note path")?.clone();
            let root = resolve_vault(vault)?;
            open_in_app(&root, &path)
        }
        other => Err(format!("unknown command `{other}` — try --help")),
    }
}

fn expect_value(iter: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    iter.next().ok_or_else(|| format!("{flag} needs a value"))
}

fn read_stdin() -> Result<String, String> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    Ok(text)
}

/// `--vault`, `$OPEN_NOTE_VAULT`, or the repository the cwd is inside.
fn resolve_vault(flag: Option<PathBuf>) -> Result<PathBuf, String> {
    let candidate = flag
        .or_else(|| std::env::var_os("OPEN_NOTE_VAULT").map(PathBuf::from))
        .or_else(|| {
            // The vault is the whole repository, so discovery climbs to its top
            // level rather than opening whatever subdirectory the shell is in.
            let git = SystemGit::new();
            let cwd = std::env::current_dir().ok()?;
            git.repo_root(&cwd).ok()
        })
        .ok_or("no vault: pass --vault, set $OPEN_NOTE_VAULT, or run inside one")?;

    let root = candidate
        .canonicalize()
        .map_err(|e| format!("{}: {e}", candidate.display()))?;
    if !SystemGit::new().is_repository(&root) {
        return Err(format!("{} is not a Git repository", root.display()));
    }
    Ok(root)
}

/// The same paranoia the app applies at its IPC boundary: relative, no `..`,
/// and never into `.git`.
fn resolve_within(root: &Path, relative: &str) -> Result<PathBuf, String> {
    // Backslashes are treated as separators too, so a Windows-style
    // `..\outside` cannot slip past the parent-dir check.
    let normalised = relative.trim().replace('\\', "/");
    if Path::new(&normalised).is_absolute() || normalised.starts_with('/') {
        return Err(format!("{relative} escapes the vault"));
    }
    let trimmed = normalised.trim_matches('/');
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    let path = Path::new(trimmed);
    if path.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::Prefix(_)
        )
    }) {
        return Err(format!("{relative} escapes the vault"));
    }
    if trimmed == ".git" || trimmed.starts_with(".git/") {
        return Err(".git is off limits".into());
    }

    let resolved = root.join(path);
    // Symlinks are the real escape: `notes -> /tmp/outside` passes every string
    // check above. Any existing ancestor of the target is canonicalised and
    // confirmed to sit under the (canonical) vault root.
    let root_real = root.canonicalize().map_err(|e| e.to_string())?;
    let mut probe = resolved.as_path();
    loop {
        if let Ok(real) = probe.canonicalize() {
            if !real.starts_with(&root_real) {
                return Err(format!("{relative} escapes the vault through a symlink"));
            }
            break;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    Ok(resolved)
}

fn with_extension(path: &str) -> String {
    if path.to_lowercase().ends_with(".md") {
        path.to_string()
    } else {
        format!("{path}.md")
    }
}

fn new_note(root: &Path, title: &str, folder: &str, tags: &str, body: &str) -> Result<(), String> {
    let name = title.replace(['/', '\\'], " ");
    let relative = if folder.is_empty() {
        with_extension(&name)
    } else {
        format!("{}/{}", folder.trim_matches('/'), with_extension(&name))
    };
    let path = resolve_within(root, &relative)?;
    if path.exists() {
        return Err(format!(
            "{relative} already exists — `new` never overwrites"
        ));
    }

    let tag_line: String = tags
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| format!("#{}", t.trim_start_matches('#')))
        .collect::<Vec<_>>()
        .join(" ");

    let mut content = format!("# {title}\n\n");
    if !body.is_empty() {
        content.push_str(body.trim_end());
        content.push('\n');
    }
    if !tag_line.is_empty() {
        content.push('\n');
        content.push_str(&tag_line);
        content.push('\n');
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // create_new is the atomic clobber guard: two racing `new` processes cannot
    // both win, and an existing note — even an unreadable one — is never
    // truncated. exists()+write has a hole between the two.
    use std::io::Write;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => file
            .write_all(content.as_bytes())
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!(
                "{relative} already exists — `new` never overwrites"
            ));
        }
        Err(e) => return Err(e.to_string()),
    }
    println!("{relative}");
    Ok(())
}

fn append_note(root: &Path, relative: &str, text: &str) -> Result<(), String> {
    let target = with_extension(relative);
    let path = resolve_within(root, &target)?;
    // A note that exists but will not read as UTF-8 must not be silently
    // truncated by treating it as empty; only a genuine miss starts fresh.
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{target}: {e}")),
    };
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(text.trim_end());
    next.push('\n');
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, next).map_err(|e| e.to_string())?;
    println!("{target}");
    Ok(())
}

fn search_notes(root: &Path, query: &str) -> Result<(), String> {
    let git = SystemGit::new();
    let files = git.list_files(root).map_err(|e| e.to_string())?;
    let needle = query.to_lowercase();
    let mut hits = 0usize;

    const MAX_SEARCH_BYTES: u64 = 8 * 1024 * 1024;
    let root_real = root.canonicalize().map_err(|e| e.to_string())?;
    for file in files {
        let name = file.to_string_lossy();
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let path = root.join(&file);
        // A tracked `leak.md -> /outside/secret` must not read across the
        // boundary, and one giant note must not be slurped whole into memory.
        match path.canonicalize() {
            Ok(real) if !real.starts_with(&root_real) => continue,
            Ok(_) => {}
            Err(_) => continue,
        }
        if std::fs::metadata(&path)
            .map(|m| m.len())
            .unwrap_or(u64::MAX)
            > MAX_SEARCH_BYTES
        {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                println!("{name}:{}:{}", index + 1, line.trim());
                hits += 1;
            }
        }
    }

    if hits == 0 {
        eprintln!("no matches");
    }
    Ok(())
}

/// Hand off to the app via the URL scheme — the one verb that needs a window.
fn open_in_app(root: &Path, relative: &str) -> Result<(), String> {
    let target = with_extension(relative);
    resolve_within(root, &target)?;
    let url = format!(
        "opennote://open?vault={}&path={}",
        urlencode(&root.display().to_string()),
        urlencode(&target),
    );

    #[cfg(target_os = "macos")]
    let launcher = ("open", vec![url.clone()]);
    #[cfg(target_os = "windows")]
    let launcher = (
        "cmd",
        vec!["/C".into(), "start".into(), String::new(), url.clone()],
    );
    #[cfg(all(unix, not(target_os = "macos")))]
    let launcher = ("xdg-open", vec![url.clone()]);

    let status = std::process::Command::new(launcher.0)
        .args(&launcher.1)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("could not open {url}"));
    }
    Ok(())
}

fn urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_cannot_escape_or_touch_git() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let root = dir.path();
        assert!(resolve_within(root, "../escape.md").is_err());
        assert!(resolve_within(root, "/etc/passwd").is_err());
        assert!(resolve_within(root, ".git/config").is_err());
        assert!(resolve_within(root, "notes/a.md").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_vault_is_refused() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let outside = tempfile::TempDir::new().expect("outside");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).expect("symlink");
        assert!(resolve_within(dir.path(), "escape/secret.md").is_err());
    }

    #[test]
    fn extension_is_added_once() {
        assert_eq!(with_extension("a"), "a.md");
        assert_eq!(with_extension("a.md"), "a.md");
        assert_eq!(with_extension("A.MD"), "A.MD");
    }

    #[test]
    fn urlencoding_keeps_slashes_and_escapes_spaces() {
        assert_eq!(urlencode("a b/c"), "a%20b/c");
    }
}
