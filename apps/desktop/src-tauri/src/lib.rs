pub mod menu;
pub mod prefs;
// Public so the integration tests can drive the same code the commands wrap.
pub mod vault;

use std::path::{Path, PathBuf};

use git_port::{
    Branch, CommitInfo, ConflictSide, GitPort, MergeOutcome, MergeResult, RepoStatus, SystemGit,
};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use vault::{VaultError, VaultFile, VaultInfo};

/// Reports the system `git` version, or `None` when no usable binary is on PATH.
#[tauri::command]
fn git_probe() -> Option<String> {
    SystemGit::new().describe().ok()
}

/// Ask the user for a folder to open as a vault. `None` means they cancelled.
#[tauri::command]
async fn pick_vault(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Open a vault")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    rx.recv()
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("the platform always provides a config directory")
}

/// Read the recent list and bring File → Open Recent back in step with it.
///
/// Every read and every change goes through here, which is what keeps the menu
/// and the welcome screen showing one list rather than two copies that
/// disagree the first time an entry is removed. Pruning happens on read, so
/// this is also where a vault that has since been deleted stops being offered.
fn recents(app: &tauri::AppHandle) -> Vec<String> {
    let dir = config_dir(app);
    let mut p = prefs::load(&dir);
    let before = p.recent_vaults.len();
    prefs::prune_missing(&mut p);
    if p.recent_vaults.len() != before {
        let _ = prefs::save(&dir, &p);
    }
    // A menu that cannot be rebuilt is not a reason to fail the call the user
    // actually made.
    let _ = menu::refresh_recents(app, &p.recent_vaults);
    p.recent_vaults
}

/// Vaults opened before, most recent first. Entries whose folder has since been
/// moved or deleted are dropped rather than offered.
#[tauri::command]
fn recent_vaults(app: tauri::AppHandle) -> Vec<String> {
    recents(&app)
}

#[tauri::command]
fn forget_vault(app: tauri::AppHandle, root: String) {
    let dir = config_dir(&app);
    let mut p = prefs::load(&dir);
    prefs::forget(&mut p, &root);
    let _ = prefs::save(&dir, &p);
    recents(&app);
}

/// Show the keymap's binding for `vault.open` next to File → Open…
///
/// Pushed from the webview because the keymap lives in the vault, is resolved
/// there, and can change while the app is running.
#[tauri::command]
fn set_open_accelerator(app: tauri::AppHandle, accelerator: Option<String>) {
    let _ = menu::set_open_accelerator(&app, accelerator.as_deref());
}

/// Empty the recent list — File → Open Recent → Clear Menu.
#[tauri::command]
fn clear_recent_vaults(app: tauri::AppHandle) {
    let dir = config_dir(&app);
    let mut p = prefs::load(&dir);
    p.recent_vaults.clear();
    let _ = prefs::save(&dir, &p);
    recents(&app);
}

#[tauri::command]
fn open_vault(app: tauri::AppHandle, root: String) -> Result<VaultInfo, VaultError> {
    let info = vault::open(&SystemGit::new(), &PathBuf::from(&root))?;

    // Only remember a vault that actually opened, so a bad path never sticks
    // around on the welcome screen.
    let dir = config_dir(&app);
    let mut p = prefs::load(&dir);
    prefs::remember(&mut p, &info.root);
    let _ = prefs::save(&dir, &p);
    recents(&app);

    Ok(info)
}

#[tauri::command]
fn list_vault_files(root: String) -> Result<Vec<VaultFile>, VaultError> {
    vault::list(&SystemGit::new(), &PathBuf::from(root))
}

#[tauri::command]
fn read_note(root: String, path: String) -> Result<String, VaultError> {
    vault::read_note(&PathBuf::from(root), &path)
}

#[tauri::command]
fn write_note(root: String, path: String, contents: String) -> Result<(), VaultError> {
    vault::write_note(&PathBuf::from(root), &path, &contents)
}

#[tauri::command]
fn read_image(root: String, path: String) -> Result<String, VaultError> {
    vault::read_image_data_url(&PathBuf::from(root), &path)
}

/// Extensions the OS would *execute* rather than open for viewing. A vault can
/// be cloned from anywhere, so a committed script must not be one click from
/// running; those are revealed in the file manager instead, where launching is
/// an explicit second decision.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "app", "sh", "command", "bat", "cmd", "exe", "msi", "scpt", "ps1", "jar", "com", "vbs",
    "desktop", "url", "lnk",
];

/// Open a vault file in whatever the OS considers its handler.
#[tauri::command]
fn open_in_default_app(root: String, path: String) -> Result<(), VaultError> {
    let resolved = vault::resolve_within(&PathBuf::from(root), &path)?;
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if EXECUTABLE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(VaultError::Io(format!(
            "{path} looks executable; reveal it in the file manager and open it there deliberately"
        )));
    }
    tauri_plugin_opener::open_path(resolved.display().to_string(), None::<String>)
        .map_err(|e| VaultError::Io(e.to_string()))
}

/// Reveal a vault file in Finder / Explorer / the file manager.
#[tauri::command]
fn reveal_in_file_manager(root: String, path: String) -> Result<(), VaultError> {
    let resolved = vault::resolve_within(&PathBuf::from(root), &path)?;
    tauri_plugin_opener::reveal_item_in_dir(&resolved).map_err(|e| VaultError::Io(e.to_string()))
}

#[tauri::command]
fn read_pdf(root: String, path: String) -> Result<String, VaultError> {
    vault::read_pdf_data_url(&PathBuf::from(root), &path)
}

/// Pick any file and store it as an attachment; `None` means cancelled.
///
/// The read happens here rather than in the webview so no file bytes cross the
/// IPC twice, and the storing goes through the same content-hash pipeline as a
/// pasted image.
#[tauri::command]
async fn pick_attachment(
    app: tauri::AppHandle,
    root: String,
    folder: String,
) -> Result<Option<serde_json::Value>, VaultError> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Attach a file")
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(picked) = rx.recv().ok().flatten().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };

    // The whole file is read into memory to hash and store it; a ceiling keeps
    // an accidental 8 GB video from taking the process with it.
    const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;
    let size = std::fs::metadata(&picked)
        .map_err(|e| VaultError::Io(e.to_string()))?
        .len();
    if size > MAX_ATTACHMENT_BYTES {
        return Err(VaultError::TooLarge(size));
    }

    let bytes = std::fs::read(&picked).map_err(|e| VaultError::Io(e.to_string()))?;
    let extension = picked
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_string();
    let name = picked
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let size = bytes.len() as u64;
    let relative = vault::write_attachment(&PathBuf::from(root), &folder, &extension, &bytes)?;
    Ok(Some(
        serde_json::json!({ "path": relative, "name": name, "size": size }),
    ))
}

#[tauri::command]
fn vault_status(root: String) -> Result<RepoStatus, VaultError> {
    Ok(SystemGit::new().status(&PathBuf::from(root))?)
}

// ---------------------------------------------------------------------------
// Granular git operations.
//
// The sync engine lives in the frontend (packages/core) and drives these one at
// a time, so it can debounce, back off and stop on conflict independently per
// vault. `sync_vault` below remains the one-shot manual path.
// ---------------------------------------------------------------------------

#[tauri::command]
fn vault_commit(root: String, message: String) -> Result<String, VaultError> {
    let id = SystemGit::new().commit(&PathBuf::from(root), &[], &message)?;
    Ok(id.0)
}

#[tauri::command]
fn vault_fetch(root: String, remote: String) -> Result<git_port::FetchOutcome, VaultError> {
    Ok(SystemGit::new().fetch(&PathBuf::from(root), &remote)?)
}

#[tauri::command]
fn vault_pull_rebase(root: String) -> Result<MergeOutcome, VaultError> {
    Ok(SystemGit::new().pull_rebase(&PathBuf::from(root))?)
}

#[tauri::command]
fn vault_push(root: String, remote: String, branch: String) -> Result<(), VaultError> {
    Ok(SystemGit::new().push(&PathBuf::from(root), &remote, &branch)?)
}

// ---------------------------------------------------------------------------
// Branches and history.
// ---------------------------------------------------------------------------

#[tauri::command]
fn remote_url(root: String, remote: String) -> Result<Option<String>, VaultError> {
    Ok(SystemGit::new().remote_url(&PathBuf::from(root), &remote)?)
}

/// Clone a repository into a folder the user picked, and open it as a vault.
#[tauri::command]
async fn clone_vault(
    app: tauri::AppHandle,
    url: String,
    parent: String,
    name: String,
) -> Result<VaultInfo, VaultError> {
    let git = SystemGit::new();
    // The folder name comes from the webview; keep it a single plain segment so
    // a crafted name cannot write outside the chosen parent.
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(VaultError::Io(format!(
            "'{name}' is not a valid folder name"
        )));
    }
    let dest = PathBuf::from(parent).join(&name);
    git.clone_repository(&url, &dest)?;

    let info = vault::open(&git, &dest)?;
    let dir = config_dir(&app);
    let mut prefs = prefs::load(&dir);
    prefs::remember(&mut prefs, &info.root);
    let _ = prefs::save(&dir, &prefs);
    Ok(info)
}

/// Turn a picked folder of Markdown into a vault: `git init`, first commit,
/// and it opens like any other. This is the cheap half of importing, and it
/// covers everyone arriving from another Markdown app.
#[tauri::command]
async fn import_folder_as_vault(app: tauri::AppHandle) -> Result<Option<VaultInfo>, VaultError> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Choose a folder of notes")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let dir = config_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = rx.recv().ok().flatten().and_then(|p| p.into_path().ok()) else {
            return Ok(None);
        };

        // `git init` on the home directory — or worse — would swallow
        // everything the user owns into a repository, secrets included. The
        // dialog makes it one misclick, so it is refused outright.
        let canonical = picked
            .canonicalize()
            .map_err(|e| VaultError::Io(e.to_string()))?;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        if canonical.parent().is_none() || home.as_deref() == Some(canonical.as_path()) {
            return Err(VaultError::Io(
                "that folder is too broad to become a vault — pick the notes folder itself".into(),
            ));
        }

        // A folder *inside* an existing repository must not open as a vault of
        // its own: the vault model is the whole repository, and a nested view
        // would sync and commit against history the user cannot see.
        if !canonical.join(".git").exists() {
            let mut ancestor = canonical.parent();
            while let Some(dir) = ancestor {
                if dir.join(".git").exists() {
                    return Err(VaultError::Io(format!(
                        "that folder sits inside the repository at {} — open that instead",
                        dir.display()
                    )));
                }
                ancestor = dir.parent();
            }
        }

        let git = SystemGit::new();
        if !git.is_repository(&picked) {
            git.init_repository(&picked)?;
            // The import commit only happens for a fresh repository; a folder
            // that was already one keeps its history exactly as it stands.
            match git.commit(&picked, &[], "notes: initial import") {
                Ok(_) => {}
                // An empty folder still becomes a usable, empty vault.
                Err(git_port::GitError::NothingToCommit) => {}
                Err(e) => return Err(e.into()),
            }
        }

        let info = vault::open(&git, &picked)?;
        let mut p = prefs::load(&dir);
        prefs::remember(&mut p, &info.root);
        let _ = prefs::save(&dir, &p);
        Ok(Some(info))
    })
    .await
    .map_err(|e| VaultError::Io(e.to_string()))?
}

/// Ask the user where a clone should go. `None` means they cancelled.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Where should the vault go?")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.recv().ok().flatten().and_then(|p| p.into_path().ok())?;
    // Bulk export writes many files under a picked folder.
    approve_export(&picked);
    Some(picked.display().to_string())
}

#[tauri::command]
fn list_branches(root: String) -> Result<Vec<Branch>, VaultError> {
    Ok(SystemGit::new().branches(&PathBuf::from(root))?)
}

#[tauri::command]
fn create_branch(root: String, name: String, start: Option<String>) -> Result<(), VaultError> {
    Ok(SystemGit::new().create_branch(&PathBuf::from(root), &name, start.as_deref())?)
}

#[tauri::command]
fn switch_branch(root: String, name: String) -> Result<(), VaultError> {
    Ok(SystemGit::new().switch_branch(&PathBuf::from(root), &name)?)
}

#[tauri::command]
fn merge_branch(root: String, name: String) -> Result<MergeResult, VaultError> {
    Ok(SystemGit::new().merge_branch(&PathBuf::from(root), &name)?)
}

#[tauri::command]
fn delete_branch(root: String, name: String, force: bool) -> Result<(), VaultError> {
    Ok(SystemGit::new().delete_branch(&PathBuf::from(root), &name, force)?)
}

#[tauri::command]
fn note_history(root: String, path: String, limit: u32) -> Result<Vec<CommitInfo>, VaultError> {
    let repo = PathBuf::from(root);
    let relative = relative_within(&repo, &path)?;
    Ok(SystemGit::new().log_for_path(&repo, &relative, limit)?)
}

#[tauri::command]
fn note_at_commit(root: String, commit: String, path: String) -> Result<String, VaultError> {
    let repo = PathBuf::from(root);
    let relative = relative_within(&repo, &path)?;
    Ok(SystemGit::new().file_at_commit(&repo, &commit, &relative)?)
}

#[tauri::command]
fn note_diff(
    root: String,
    from: String,
    to: Option<String>,
    path: String,
) -> Result<String, VaultError> {
    let repo = PathBuf::from(root);
    let relative = relative_within(&repo, &path)?;
    Ok(SystemGit::new().diff_file(&repo, &from, to.as_deref(), &relative)?)
}

#[tauri::command]
fn discard_note_changes(root: String, path: String) -> Result<(), VaultError> {
    let repo = PathBuf::from(root);
    let relative = relative_within(&repo, &path)?;
    Ok(SystemGit::new().discard_file(&repo, &relative)?)
}

#[tauri::command]
fn restore_note(root: String, commit: String, path: String) -> Result<(), VaultError> {
    let repo = PathBuf::from(root);
    let relative = relative_within(&repo, &path)?;
    Ok(SystemGit::new().restore_file(&repo, &commit, &relative)?)
}

/// Validate a webview-supplied path and return it relative to the vault.
///
/// Every path that reaches git goes through this: a path argument is still
/// untrusted input even when it names a file the user just clicked.
fn relative_within(repo: &PathBuf, path: &str) -> Result<PathBuf, VaultError> {
    let resolved = vault::resolve_within(repo, path)?;
    Ok(resolved
        .strip_prefix(repo)
        .unwrap_or(&resolved)
        .to_path_buf())
}

#[tauri::command]
fn resolve_conflict(root: String, path: String, side: ConflictSide) -> Result<(), VaultError> {
    let repo = PathBuf::from(root);
    // Guard the path even here: a conflicted path still comes from the webview.
    let resolved = vault::resolve_within(&repo, &path)?;
    let relative = resolved
        .strip_prefix(&repo)
        .unwrap_or(&resolved)
        .to_path_buf();
    Ok(SystemGit::new().resolve_with(&repo, &relative, side)?)
}

#[tauri::command]
fn stage_resolution(root: String, path: String) -> Result<(), VaultError> {
    let repo = PathBuf::from(root);
    let resolved = vault::resolve_within(&repo, &path)?;
    let relative = resolved
        .strip_prefix(&repo)
        .unwrap_or(&resolved)
        .to_path_buf();
    Ok(SystemGit::new().stage(&repo, &[relative])?)
}

#[tauri::command]
fn rebase_continue(root: String) -> Result<MergeOutcome, VaultError> {
    Ok(SystemGit::new().rebase_continue(&PathBuf::from(root))?)
}

#[tauri::command]
fn rebase_abort(root: String) -> Result<(), VaultError> {
    Ok(SystemGit::new().rebase_abort(&PathBuf::from(root))?)
}

#[tauri::command]
fn rebase_in_progress(root: String) -> bool {
    SystemGit::new().rebase_in_progress(&PathBuf::from(root))
}

/// Read a file exactly as it sits on disk, conflict markers and all.
///
/// `read_note` is for editing; this is for showing the user what git left behind.
#[tauri::command]
fn read_raw(root: String, path: String) -> Result<String, VaultError> {
    vault::read_raw(&PathBuf::from(root), &path)
}

#[tauri::command]
fn read_drawing(root: String, path: String) -> Result<String, VaultError> {
    vault::read_drawing(&PathBuf::from(root), &path)
}

#[tauri::command]
fn write_drawing(root: String, path: String, contents: String) -> Result<(), VaultError> {
    vault::write_drawing(&PathBuf::from(root), &path, &contents)
}

// ---------------------------------------------------------------------------
// File management.
// ---------------------------------------------------------------------------

/// Destinations the user actually chose in an OS dialog.
///
/// Exports deliberately write outside the vault — that is their point — but
/// "outside the vault" must not mean "anywhere the webview names". A write is
/// only honoured at a path (or under a folder) that came back from a dialog,
/// so a compromised webview cannot aim `write_export` at `~/.zshrc`.
static APPROVED_EXPORTS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn approve_export(path: &Path) {
    let mut approved = APPROVED_EXPORTS.lock().expect("approved exports lock");
    approved.push(path.to_path_buf());
    // The window's export history is small; keep the list from growing forever.
    let excess = approved.len().saturating_sub(64);
    if excess > 0 {
        approved.drain(..excess);
    }
}

fn export_destination(path: &str) -> Result<PathBuf, VaultError> {
    let wanted = PathBuf::from(path);
    // Reject `..` outright: it could walk out from under an approved folder.
    if wanted
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(VaultError::Io("export path may not contain ..".into()));
    }
    let approved = APPROVED_EXPORTS.lock().expect("approved exports lock");
    if approved
        .iter()
        .any(|a| wanted == *a || wanted.starts_with(a))
    {
        return Ok(wanted);
    }
    Err(VaultError::Io(
        "export destination was not chosen in a dialog".into(),
    ))
}

/// Ask where an export should be written. `None` means the user cancelled.
#[tauri::command]
async fn pick_export_path(app: tauri::AppHandle, suggested: String) -> Option<String> {
    // The filter follows the format being exported, not a hard-coded one —
    // a DOCX export offered a "Web page" filter mis-names files on macOS.
    let extension = suggested.rsplit('.').next().unwrap_or("html").to_string();
    let label = match extension.as_str() {
        "html" => "Web page",
        "docx" => "Word document",
        "textpack" => "Textbundle archive",
        "md" => "Markdown",
        _ => "File",
    };

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Export note")
        .set_file_name(&suggested)
        .add_filter(label, &[&extension])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.recv().ok().flatten().and_then(|p| p.into_path().ok())?;
    approve_export(&picked);
    Some(picked.display().to_string())
}

/// Write an exported file to a path the user chose in the save dialog.
#[tauri::command]
fn write_export(path: String, contents: String) -> Result<(), VaultError> {
    let destination = export_destination(&path)?;
    // Bulk export preserves the vault's folder tree under the picked directory,
    // so parents may not exist yet.
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| VaultError::Io(e.to_string()))?;
    }
    std::fs::write(&destination, contents).map_err(|e| VaultError::Io(e.to_string()))
}

/// As `write_export`, for formats that are bytes rather than text.
#[tauri::command]
fn write_export_binary(path: String, data: String) -> Result<(), VaultError> {
    use base64::Engine;
    let destination = export_destination(&path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| VaultError::Io(format!("invalid export payload: {e}")))?;
    std::fs::write(&destination, bytes).map_err(|e| VaultError::Io(e.to_string()))
}

/// The `<title>` of a web page, for turning a pasted URL into a named link.
///
/// Guarded by a setting that is off by default — this is a network request
/// triggered by a keystroke. The read is bounded and the errors are silent by
/// design: a failed lookup means the paste stays a bare URL, not a dialog.
#[tauri::command]
async fn fetch_page_title(url: String) -> Option<String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }
    // A pasted URL is untrusted input pointed at the network from inside the
    // user's machine: loopback, private-range and link-local destinations are
    // refused, and redirects are not followed — a public URL redirecting to
    // 169.254.169.254 is the classic way around a host check.
    if let Some(host) = url
        .split("//")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
    {
        let bare = host.rsplit('@').next().unwrap_or(host);
        let name = bare.trim_start_matches('[');
        let name = name.split([']', ':']).next().unwrap_or(name);
        if is_private_host(name) {
            return None;
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(std::time::Duration::from_secs(5))
            .build();
        let response = agent.get(&url).call().ok()?;
        if !response
            .content_type()
            .to_ascii_lowercase()
            .contains("html")
        {
            return None;
        }
        // Titles live in the head; 128 KiB is generous and bounds the read.
        let mut buffer = String::new();
        use std::io::Read;
        response
            .into_reader()
            .take(128 * 1024)
            .read_to_string(&mut buffer)
            .ok()?;

        let lower = buffer.to_lowercase();
        let start = lower.find("<title")?;
        let open = buffer[start..].find('>')? + start + 1;
        let close = lower[open..].find("</title")? + open;
        let raw = buffer[open..close].trim();
        if raw.is_empty() {
            return None;
        }
        // The handful of entities that actually appear in titles.
        let title = raw
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace(char::is_control, " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        (!title.is_empty()).then(|| title.chars().take(200).collect())
    })
    .await
    .ok()
    .flatten()
}

/// Hosts a title lookup must never reach: the machine itself and its networks.
fn is_private_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
        return true;
    }
    if let Ok(v4) = lower.parse::<std::net::Ipv4Addr>() {
        return v4.is_loopback()
            || v4.is_private()
            || v4.is_link_local()
            || v4.is_unspecified()
            || v4.is_broadcast()
            // Carrier-grade NAT, 100.64.0.0/10.
            || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64);
    }
    if let Ok(v6) = lower.parse::<std::net::Ipv6Addr>() {
        return v6.is_loopback()
            || v6.is_unspecified()
            // Unique-local fc00::/7 and link-local fe80::/10.
            || (v6.segments()[0] & 0xfe00) == 0xfc00
            || (v6.segments()[0] & 0xffc0) == 0xfe80
            || v6.to_ipv4_mapped().is_some_and(|v4| {
                v4.is_loopback() || v4.is_private() || v4.is_link_local()
            });
    }
    false
}

/// Store a pasted or dropped attachment; returns its vault-relative path.
///
/// Bytes arrive base64-encoded because that is what survives the IPC bridge
/// intact. Hashing and naming happen in Rust, where the bytes already are.
#[tauri::command]
fn write_attachment(
    root: String,
    folder: String,
    extension: String,
    data: String,
) -> Result<String, VaultError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| VaultError::Io(format!("attachment is not valid base64: {e}")))?;
    vault::write_attachment(&PathBuf::from(root), &folder, &extension, &bytes)
}

#[tauri::command]
fn create_folder(root: String, path: String) -> Result<(), VaultError> {
    vault::create_folder(&PathBuf::from(root), &path)
}

#[tauri::command]
fn create_note(root: String, path: String, contents: String) -> Result<(), VaultError> {
    vault::create_note(&PathBuf::from(root), &path, &contents)
}

#[tauri::command]
fn duplicate_note(root: String, path: String) -> Result<String, VaultError> {
    vault::duplicate_note(&PathBuf::from(root), &path)
}

#[tauri::command]
fn rename_entry(root: String, from: String, to: String) -> Result<(), VaultError> {
    vault::rename_entry(&PathBuf::from(root), &from, &to)
}

#[tauri::command]
fn delete_entry(root: String, path: String) -> Result<(), VaultError> {
    vault::delete_entry(&PathBuf::from(root), &path)
}

/// Whether git has this path in a commit.
///
/// The delete confirmation asks first: a tracked note can be recovered from
/// history, an untracked one cannot be recovered at all.
#[tauri::command]
fn is_tracked(root: String, path: String) -> Result<bool, VaultError> {
    let repo = PathBuf::from(root);
    let relative = relative_within(&repo, &path)?;
    Ok(SystemGit::new().is_tracked(&repo, &relative)?)
}

#[tauri::command]
fn read_all_notes(root: String) -> Result<Vec<vault::NoteSource>, VaultError> {
    vault::read_all_notes(&SystemGit::new(), &PathBuf::from(root))
}

#[tauri::command]
fn read_vault_keymap(root: String) -> Result<Option<String>, VaultError> {
    vault::read_keymap(&PathBuf::from(root))
}

#[tauri::command]
fn write_vault_keymap(root: String, json: String) -> Result<(), VaultError> {
    vault::write_keymap(&PathBuf::from(root), &json)
}

#[tauri::command]
fn read_vault_settings(root: String) -> Result<Option<String>, VaultError> {
    vault::read_settings(&PathBuf::from(root))
}

#[tauri::command]
fn write_vault_settings(root: String, json: String) -> Result<(), VaultError> {
    vault::write_settings(&PathBuf::from(root), &json)
}

#[tauri::command]
fn read_vault_themes(root: String) -> Result<Vec<String>, VaultError> {
    vault::read_themes(&PathBuf::from(root))
}

/// Path to the author time of the first commit that added it — the app's
/// definition of a note's created date. A repo with no commits yet simply has
/// no dates, which is not a failure.
#[tauri::command]
fn created_dates(root: String) -> std::collections::HashMap<String, u64> {
    SystemGit::new()
        .first_commit_dates(&PathBuf::from(root))
        .unwrap_or_default()
}

/// What a manual sync actually did, so the UI can say something specific rather
/// than just "done".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub committed: bool,
    pub pulled: Option<MergeOutcome>,
    pub pushed: bool,
    /// Set when the sync stopped early. Conflicts land here, and the vault is
    /// left for the user to resolve — we never resolve on their behalf.
    pub blocked: Option<String>,
    pub status: RepoStatus,
}

/// Commit anything outstanding, integrate upstream work, then publish.
///
/// Ordering matters: committing first means a rebase never has to stash the
/// user's in-progress notes, and pulling before pushing means we do not race a
/// collaborator into a rejected push.
#[tauri::command]
fn sync_vault(root: String) -> Result<SyncReport, VaultError> {
    let git = SystemGit::new();
    let repo = PathBuf::from(root);

    let committed = match git.commit(&repo, &[], "notes: sync from Open Note") {
        Ok(_) => true,
        // Routine: there was simply nothing new to record.
        Err(git_port::GitError::NothingToCommit) => false,
        Err(e) => return Err(e.into()),
    };

    let status = git.status(&repo)?;
    if status.upstream.is_none() {
        return Ok(SyncReport {
            committed,
            pulled: None,
            pushed: false,
            blocked: Some(format!(
                "Branch '{}' has no upstream. Push it once from your terminal to set one.",
                status.branch
            )),
            status,
        });
    }

    let pulled = git.pull_rebase(&repo)?;
    if let MergeOutcome::Conflicted { ref paths } = pulled {
        let names: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
        return Ok(SyncReport {
            committed,
            pulled: Some(pulled.clone()),
            pushed: false,
            blocked: Some(format!("Conflicts need resolving in {}", names.join(", "))),
            status: git.status(&repo)?,
        });
    }

    git.push(&repo, "origin", &status.branch)?;
    Ok(SyncReport {
        committed,
        pulled: Some(pulled),
        pushed: true,
        blocked: None,
        status: git.status(&repo)?,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            menu::install(app.handle())?;
            // The list is read at startup anyway; doing it here fills the
            // submenu before the window is first shown.
            recents(app.handle());
            Ok(())
        })
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            git_probe,
            pick_vault,
            open_vault,
            recent_vaults,
            forget_vault,
            clear_recent_vaults,
            set_open_accelerator,
            list_vault_files,
            read_note,
            write_note,
            read_image,
            vault_status,
            vault_commit,
            vault_fetch,
            vault_pull_rebase,
            vault_push,
            remote_url,
            clone_vault,
            import_folder_as_vault,
            pick_folder,
            list_branches,
            create_branch,
            switch_branch,
            merge_branch,
            delete_branch,
            note_history,
            note_at_commit,
            note_diff,
            discard_note_changes,
            restore_note,
            resolve_conflict,
            stage_resolution,
            rebase_continue,
            rebase_abort,
            rebase_in_progress,
            read_raw,
            read_drawing,
            write_drawing,
            pick_export_path,
            write_export,
            write_export_binary,
            fetch_page_title,
            write_attachment,
            read_pdf,
            pick_attachment,
            open_in_default_app,
            reveal_in_file_manager,
            create_folder,
            create_note,
            duplicate_note,
            rename_entry,
            delete_entry,
            is_tracked,
            read_all_notes,
            read_vault_keymap,
            write_vault_keymap,
            read_vault_settings,
            write_vault_settings,
            read_vault_themes,
            created_dates,
            sync_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Open Note");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_only_write_where_a_dialog_pointed() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let inside = dir.path().join("out.html");
        let elsewhere = std::env::temp_dir().join("open-note-unapproved.html");

        // Unapproved: refused, nothing written.
        assert!(write_export(elsewhere.display().to_string(), "x".into()).is_err());
        assert!(!elsewhere.exists());

        // Approved folder: files under it may be written, `..` may not.
        approve_export(dir.path());
        write_export(inside.display().to_string(), "ok".into()).expect("approved write");
        assert_eq!(std::fs::read_to_string(&inside).unwrap(), "ok");
        let escape = dir.path().join("../escape.html");
        assert!(write_export(escape.display().to_string(), "x".into()).is_err());
    }

    #[test]
    fn private_hosts_are_refused_for_title_lookups() {
        for host in [
            "localhost",
            "sub.localhost",
            "printer.local",
            "127.0.0.1",
            "10.1.2.3",
            "192.168.1.1",
            "172.16.0.9",
            "169.254.169.254",
            "100.64.1.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fd00::2",
        ] {
            assert!(is_private_host(host), "{host} should be refused");
        }
        for host in ["example.com", "93.184.216.34", "2606:2800:220:1::1"] {
            assert!(!is_private_host(host), "{host} should be allowed");
        }
    }

    #[test]
    fn git_probe_reports_the_system_git() {
        // CI and dev machines always have git; a None here means PATH resolution
        // broke, which would silently disable every sync feature.
        let probed = git_probe().expect("system git should be discoverable");
        assert!(
            probed.starts_with("git version"),
            "unexpected output: {probed}"
        );
    }
}
