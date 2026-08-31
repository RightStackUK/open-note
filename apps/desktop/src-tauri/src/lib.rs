pub mod prefs;
// Public so the integration tests can drive the same code the commands wrap.
pub mod vault;

use std::path::PathBuf;

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

/// Vaults opened before, most recent first. Entries whose folder has since been
/// moved or deleted are dropped rather than offered.
#[tauri::command]
fn recent_vaults(app: tauri::AppHandle) -> Vec<String> {
    let dir = config_dir(&app);
    let mut p = prefs::load(&dir);
    let before = p.recent_vaults.len();
    prefs::prune_missing(&mut p);
    if p.recent_vaults.len() != before {
        let _ = prefs::save(&dir, &p);
    }
    p.recent_vaults
}

#[tauri::command]
fn forget_vault(app: tauri::AppHandle, root: String) {
    let dir = config_dir(&app);
    let mut p = prefs::load(&dir);
    prefs::forget(&mut p, &root);
    let _ = prefs::save(&dir, &p);
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
    rx.recv()
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
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

/// Ask where an export should be written. `None` means the user cancelled.
#[tauri::command]
async fn pick_export_path(app: tauri::AppHandle, suggested: String) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Export note")
        .set_file_name(&suggested)
        .add_filter("Web page", &["html"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    rx.recv()
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

/// Write an exported file to a path the user chose in the save dialog.
///
/// Deliberately not vault-scoped: the whole point of an export is to put a copy
/// somewhere else. The path comes from the OS dialog rather than the webview.
#[tauri::command]
fn write_export(path: String, contents: String) -> Result<(), VaultError> {
    std::fs::write(&path, contents).map_err(|e| VaultError::Io(e.to_string()))
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
        .invoke_handler(tauri::generate_handler![
            git_probe,
            pick_vault,
            open_vault,
            recent_vaults,
            forget_vault,
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
            write_attachment,
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
            sync_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Open Note");
}

#[cfg(test)]
mod tests {
    use super::*;

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
