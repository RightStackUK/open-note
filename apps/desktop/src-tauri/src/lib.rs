pub mod prefs;
// Public so the integration tests can drive the same code the commands wrap.
pub mod vault;

use std::path::PathBuf;

use git_port::{GitPort, MergeOutcome, RepoStatus, SystemGit};
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
