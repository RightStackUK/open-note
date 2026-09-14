//! Several windows, and who owns which vault.
//!
//! Tauri windows share one process, so a second window is a second webview —
//! and a second copy of the sync engine, which lives in the frontend. Two
//! engines on one vault would run two commit, push and fetch loops against one
//! working copy and contend for git's index lock, which is exactly the failure
//! the engine serialises its own calls to avoid.
//!
//! So a vault is **owned** by one window. The owner runs the engine; any other
//! window with that vault open is a follower that reads and writes files —
//! plain IO, no git — and forwards "a file landed" to the owner, whose commit
//! loop then does what it always did. Ownership is claimed here rather than
//! negotiated over events because a claim has to be atomic: two windows opening
//! the same vault in the same instant must not both believe they won.
//!
//! Nothing in here talks to git, and nothing decides policy. It hands out
//! claims and remembers what a new window was asked to open.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Vault root → the label of the window that owns it.
#[derive(Default)]
pub struct Owners(pub Mutex<HashMap<String, String>>);

/// Document key → the label of the window that has it open.
///
/// The same rule as within a window, where a document lives in at most one tab:
/// two editors over one file each hold their own buffer and take turns
/// overwriting the other's autosave. A window boundary does not make that safe,
/// so opening a note another window has open reveals it there instead.
#[derive(Default)]
pub struct Documents(pub Mutex<HashMap<String, String>>);

/// What a freshly created window should open once its webview is up.
///
/// Held here rather than passed in the URL: a vault path is not URL-shaped, and
/// a query string is visible in a way a filesystem path should not have to be.
#[derive(Default)]
pub struct Intents(pub Mutex<HashMap<String, WindowIntent>>);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIntent {
    /// The vault to open, if the new window was asked for from one.
    pub root: Option<String>,
    /// A note in that vault to open, for "open this in a new window".
    pub path: Option<String>,
}

/// Claim `root` for `label`.
///
/// Returns whether the caller may run the engine: true when the vault was
/// unowned, and true when the caller already owns it, because a window
/// reopening its own vault has not lost anything.
pub fn claim(owners: &mut HashMap<String, String>, root: &str, label: &str) -> bool {
    match owners.get(root) {
        Some(existing) if existing != label => false,
        _ => {
            owners.insert(root.to_string(), label.to_string());
            true
        }
    }
}

/// Give up a claim. Releasing a vault someone else owns does nothing.
pub fn release(owners: &mut HashMap<String, String>, root: &str, label: &str) {
    if owners.get(root).is_some_and(|owner| owner == label) {
        owners.remove(root);
    }
}

/// Give up everything a window owned, for when it closes.
///
/// Returns the vaults that are now unowned, so the remaining windows can be
/// told to take over: a follower whose owner just went away is otherwise a
/// window with an open vault that nothing is committing.
pub fn release_all(owners: &mut HashMap<String, String>, label: &str) -> Vec<String> {
    let freed: Vec<String> = owners
        .iter()
        .filter(|(_, owner)| *owner == label)
        .map(|(root, _)| root.clone())
        .collect();
    for root in &freed {
        owners.remove(root);
    }
    freed
}

pub fn owner(owners: &HashMap<String, String>, root: &str) -> Option<String> {
    owners.get(root).cloned()
}

/// The next free `w<N>` label. `main` is the window the app starts with.
fn next_label<R: Runtime>(app: &AppHandle<R>) -> String {
    (2..)
        .map(|n| format!("w{n}"))
        .find(|label| app.get_webview_window(label).is_none())
        .unwrap_or_else(|| "w".to_string())
}

/// Open another window, optionally pointed at a vault and a note.
///
/// The new window loads the same page as the first: which vault it shows is a
/// frontend decision, taken once it asks for its intent. Size and decorations
/// are deliberately not copied from the caller — a second window is a new place
/// to work, not a clone of the first one's geometry.
#[tauri::command]
pub fn open_window<R: Runtime>(
    app: AppHandle<R>,
    root: Option<String>,
    path: Option<String>,
) -> Result<String, String> {
    let label = next_label(&app);
    app.state::<Intents>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), WindowIntent { root, path });

    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Open Note")
        .inner_size(1100.0, 760.0);
    // The same chrome as the first window: the header strip is ours to draw,
    // and a native title bar here would look like a different app. Shadowed
    // under a `cfg` rather than chained, because `title_bar_style` only exists
    // on macOS — chaining it compiles here and breaks the Linux and Windows
    // builds, which is what `tauri.conf.json` avoids for the first window by
    // being configuration rather than code.
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    let built = builder.build();

    match built {
        Ok(_) => Ok(label),
        Err(e) => {
            // Do not leave an intent behind for a window that never appeared:
            // the label would be reused and the next window would inherit it.
            if let Ok(mut intents) = app.state::<Intents>().0.lock() {
                intents.remove(&label);
            }
            Err(e.to_string())
        }
    }
}

/// What this window was asked to open. Consumed, so a reload starts clean.
#[tauri::command]
pub fn window_intent<R: Runtime>(app: AppHandle<R>, label: String) -> Result<WindowIntent, String> {
    Ok(app
        .state::<Intents>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&label)
        .unwrap_or_default())
}

/// Try to become the window that runs the engine for `root`.
#[tauri::command]
pub fn claim_vault<R: Runtime>(
    app: AppHandle<R>,
    root: String,
    label: String,
) -> Result<bool, String> {
    let owners = app.state::<Owners>();
    let mut map = owners.0.lock().map_err(|e| e.to_string())?;
    Ok(claim(&mut map, &root, &label))
}

#[tauri::command]
pub fn release_vault<R: Runtime>(
    app: AppHandle<R>,
    root: String,
    label: String,
) -> Result<(), String> {
    let owners = app.state::<Owners>();
    let mut map = owners.0.lock().map_err(|e| e.to_string())?;
    release(&mut map, &root, &label);
    Ok(())
}

#[tauri::command]
pub fn vault_owner<R: Runtime>(app: AppHandle<R>, root: String) -> Result<Option<String>, String> {
    let owners = app.state::<Owners>();
    let map = owners.0.lock().map_err(|e| e.to_string())?;
    Ok(owner(&map, &root))
}

/// Take a document for this window, or learn who has it.
///
/// Returns `None` when the caller now has it — including when it already did —
/// and otherwise the label of the window that does.
#[tauri::command]
pub fn claim_document<R: Runtime>(
    app: AppHandle<R>,
    key: String,
    label: String,
) -> Result<Option<String>, String> {
    let docs = app.state::<Documents>();
    let mut map = docs.0.lock().map_err(|e| e.to_string())?;
    if claim(&mut map, &key, &label) {
        return Ok(None);
    }
    Ok(owner(&map, &key))
}

#[tauri::command]
pub fn release_document<R: Runtime>(
    app: AppHandle<R>,
    key: String,
    label: String,
) -> Result<(), String> {
    let docs = app.state::<Documents>();
    let mut map = docs.0.lock().map_err(|e| e.to_string())?;
    release(&mut map, &key, &label);
    Ok(())
}

/// Bring a window to the front, for revealing a note that is open in it.
#[tauri::command]
pub fn focus_window<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    let Some(window) = app.get_webview_window(&label) else {
        // It closed between the claim and the reveal; the caller can open it.
        return Ok(());
    };
    window.unminimize().ok();
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// Every window currently open, so one can tell how alone it is.
#[tauri::command]
pub fn window_labels<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unowned_vault_is_claimable() {
        let mut owners = HashMap::new();
        assert!(claim(&mut owners, "/vault", "main"));
        assert_eq!(owner(&owners, "/vault").as_deref(), Some("main"));
    }

    #[test]
    fn a_second_window_does_not_win_a_claimed_vault() {
        let mut owners = HashMap::new();
        assert!(claim(&mut owners, "/vault", "main"));
        assert!(!claim(&mut owners, "/vault", "w2"));
        assert_eq!(owner(&owners, "/vault").as_deref(), Some("main"));
    }

    #[test]
    fn reclaiming_your_own_vault_succeeds() {
        // A window reopening a vault it already owns has not lost the engine.
        let mut owners = HashMap::new();
        assert!(claim(&mut owners, "/vault", "main"));
        assert!(claim(&mut owners, "/vault", "main"));
    }

    #[test]
    fn releasing_frees_it_for_the_other_window() {
        let mut owners = HashMap::new();
        claim(&mut owners, "/vault", "main");
        release(&mut owners, "/vault", "main");
        assert!(claim(&mut owners, "/vault", "w2"));
    }

    #[test]
    fn releasing_a_vault_you_do_not_own_changes_nothing() {
        let mut owners = HashMap::new();
        claim(&mut owners, "/vault", "main");
        release(&mut owners, "/vault", "w2");
        assert_eq!(owner(&owners, "/vault").as_deref(), Some("main"));
    }

    #[test]
    fn closing_a_window_frees_only_its_own_vaults() {
        let mut owners = HashMap::new();
        claim(&mut owners, "/a", "main");
        claim(&mut owners, "/b", "w2");
        claim(&mut owners, "/c", "main");

        let mut freed = release_all(&mut owners, "main");
        freed.sort();
        assert_eq!(freed, vec!["/a".to_string(), "/c".to_string()]);
        assert_eq!(owner(&owners, "/b").as_deref(), Some("w2"));
        assert!(owner(&owners, "/a").is_none());
    }

    #[test]
    fn closing_a_window_that_owned_nothing_frees_nothing() {
        let mut owners = HashMap::new();
        claim(&mut owners, "/a", "main");
        assert!(release_all(&mut owners, "w2").is_empty());
        assert_eq!(owner(&owners, "/a").as_deref(), Some("main"));
    }
}
