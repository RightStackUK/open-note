//! The application menu.
//!
//! Setting a menu **replaces** the platform default wholesale, so everything a
//! macOS user expects — Quit, Hide, Services, the Edit menu with Undo and
//! Cut/Copy/Paste, Minimise, Zoom, Close Window — is re-declared here. Losing
//! system Cut/Paste in an editor would be a nasty regression, and it would
//! disappear silently.
//!
//! Nothing here *does* anything. Every item we add emits an event the webview
//! handles: opening a vault means starting a session and refreshing state, and
//! that lives in the frontend. A second copy of it in Rust would drift.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The single event every custom menu item reaches the webview through.
pub const MENU_EVENT: &str = "menu://command";

const OPEN: &str = "file.open";
const CLEAR_RECENTS: &str = "file.clearRecents";
const RECENTS_SUBMENU: &str = "file.recents";

/// A recent-vault item carries its vault path in its own id. A menu id is an
/// arbitrary string, so the path *is* the lookup — no parallel table to keep
/// in step with the submenu.
const RECENT_PREFIX: &str = "file.recent:";

/// What a menu item asks the frontend to do.
///
/// `command` is a `COMMANDS` id where one exists, so the menu dispatches
/// *through* the registry rather than beside it. The recent-vault items are
/// deliberately not registry commands: they are parameterised — "open *this*
/// vault" — and the registry has no shape for an argument, nor any use for
/// eight commands that cannot be bound to a key or listed in the palette.
#[derive(Clone, Serialize)]
pub struct MenuCommand {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arg: Option<String>,
}

/// The recents submenu, kept so it can be repopulated. See [`refresh_recents`].
struct RecentsMenu<R: Runtime>(Submenu<R>);

/// File → Open…, kept so its accelerator can follow the keymap.
struct OpenItem<R: Runtime>(MenuItem<R>);

/// Build the menu and set it on the app.
///
/// The recents submenu starts empty and disabled; `refresh_recents` fills it.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let recents = Submenu::with_id_and_items(app, RECENTS_SUBMENU, "Open Recent", false, &[])?;

    // No accelerator here. A menu accelerator is drawn by the OS from whatever
    // was declared when the menu was built, and on macOS it also *swallows* the
    // chord before the webview sees it — so a hard-coded ⌘O would both show a
    // stale shortcut to anyone who rebinds `vault.open` and steal the chord
    // from whatever they rebound it to. `set_open_accelerator` pushes the
    // resolved binding instead, which makes the keymap the only source.
    let open = MenuItem::with_id(app, OPEN, "Open…", true, None::<&str>)?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &open,
            &recents,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about.clone()))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &file,
            &edit,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window,
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_items(
                app,
                "Help",
                true,
                &[&PredefinedMenuItem::about(app, None, Some(about))?],
            )?,
        ],
    )?;

    app.set_menu(menu)?;
    app.manage(RecentsMenu(recents));
    app.manage(OpenItem(open));
    Ok(())
}

/// Show the keymap's current binding for `vault.open` next to File → Open…
///
/// `None` clears it, which is also what an unbound command means — the
/// alternative keymap scheme gives ⌘O to the note switcher, and the menu must
/// not go on claiming it.
pub fn set_open_accelerator<R: Runtime>(
    app: &AppHandle<R>,
    accelerator: Option<&str>,
) -> tauri::Result<()> {
    let Some(state) = app.try_state::<OpenItem<R>>() else {
        return Ok(());
    };
    state.0.clone().set_accelerator(accelerator)
}

/// Repopulate File → Open Recent from the current list.
///
/// The submenu is rebuilt rather than built once at startup, and this is the
/// only path that fills it. The list reorders on every vault opened, shrinks
/// when an entry is removed from the welcome screen, and is pruned of missing
/// folders at read time — so a submenu populated during setup is wrong by the
/// second vault opened in a session, and goes on offering vaults that have
/// since been deleted. That reads as stale data rather than a bug.
pub fn refresh_recents<R: Runtime>(app: &AppHandle<R>, recents: &[String]) -> tauri::Result<()> {
    // Absent before `install`, and in the test harness, where there is no menu.
    let Some(state) = app.try_state::<RecentsMenu<R>>() else {
        return Ok(());
    };
    let submenu = state.0.clone();

    while submenu.remove_at(0)?.is_some() {}

    let home = app.path().home_dir().ok().map(|p| p.display().to_string());
    for (path, label) in recents.iter().zip(labels(recents, home.as_deref())) {
        let id = format!("{RECENT_PREFIX}{path}");
        submenu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }

    if !recents.is_empty() {
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
        let clear = MenuItem::with_id(app, CLEAR_RECENTS, "Clear Menu", true, None::<&str>)?;
        submenu.append(&clear)?;
    }

    // An empty submenu that still opens looks broken, so the parent goes dim
    // instead. This is also the state on first run.
    submenu.set_enabled(!recents.is_empty())?;
    Ok(())
}

/// Translate a menu activation into an instruction for the webview.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    let payload = if let Some(path) = id.strip_prefix(RECENT_PREFIX) {
        MenuCommand {
            command: "vault.openRecent".into(),
            arg: Some(path.to_string()),
        }
    } else if id == OPEN {
        MenuCommand {
            command: "vault.open".into(),
            arg: None,
        }
    } else if id == CLEAR_RECENTS {
        MenuCommand {
            command: "vault.clearRecents".into(),
            arg: None,
        }
    } else {
        // A predefined item the OS handles itself.
        return;
    };
    let _ = app.emit(MENU_EVENT, payload);
}

/// Menu labels for a list of vault paths, in the same order.
///
/// The folder name is what people recognise, but two vaults can share one —
/// `work/notes` and `personal/notes`. The welcome screen shows name and path
/// together and can afford to; a menu row cannot, so only the names that
/// actually clash get their parent folder appended, and anything still
/// ambiguous after that falls back to the whole path.
pub fn labels(paths: &[String], home: Option<&str>) -> Vec<String> {
    let names: Vec<String> = paths.iter().map(|p| leaf(p)).collect();

    let mut out: Vec<String> = Vec::with_capacity(paths.len());
    for (i, name) in names.iter().enumerate() {
        if !is_duplicated(&names, i) {
            out.push(name.clone());
            continue;
        }
        out.push(match parent_leaf(&paths[i]) {
            Some(parent) => format!("{name} — {parent}"),
            None => shorten(&paths[i], home),
        });
    }

    // Parents clash too: two `notes` folders under two different `work`
    // folders are still one label. Whatever is left ambiguous gets the path.
    let disambiguated = out.clone();
    for (i, label) in out.iter_mut().enumerate() {
        if is_duplicated(&disambiguated, i) {
            *label = shorten(&paths[i], home);
        }
    }
    out
}

fn is_duplicated(values: &[String], index: usize) -> bool {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for value in values {
        *counts.entry(value.as_str()).or_default() += 1;
    }
    counts.get(values[index].as_str()).copied().unwrap_or(0) > 1
}

fn leaf(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn parent_leaf(path: &str) -> Option<String> {
    Path::new(path)
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
}

/// `/Users/me/notes` reads better as `~/notes`, and a menu row is short on
/// room. Matching on the separator too, so `/Users/meredith` is not mistaken
/// for a path inside `/Users/me`.
fn shorten(path: &str, home: Option<&str>) -> String {
    let Some(home) = home.filter(|h| !h.is_empty()) else {
        return path.to_string();
    };
    let home = home.trim_end_matches(is_separator);
    match path.strip_prefix(home) {
        Some("") => "~".to_string(),
        Some(rest) if rest.starts_with(is_separator) => format!("~{rest}"),
        _ => path.to_string(),
    }
}

/// Both separators, always: a vault path recorded on one platform can be read
/// back on another, and the tests here are written with `/` either way.
fn is_separator(c: char) -> bool {
    c == '/' || c == std::path::MAIN_SEPARATOR
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn a_unique_folder_name_is_the_whole_label() {
        let labelled = labels(&paths(&["/home/me/notes", "/home/me/journal"]), None);
        assert_eq!(labelled, vec!["notes", "journal"]);
    }

    #[test]
    fn clashing_names_gain_their_parent_folder() {
        let labelled = labels(
            &paths(&["/home/me/work/notes", "/home/me/personal/notes"]),
            None,
        );
        assert_eq!(labelled, vec!["notes — work", "notes — personal"]);
    }

    #[test]
    fn only_the_clashing_entries_are_disambiguated() {
        let labelled = labels(
            &paths(&["/a/work/notes", "/b/personal/notes", "/c/journal"]),
            None,
        );
        assert_eq!(
            labelled,
            vec!["notes — work", "notes — personal", "journal"]
        );
    }

    #[test]
    fn a_clashing_parent_falls_back_to_the_path() {
        let labelled = labels(&paths(&["/a/work/notes", "/b/work/notes"]), None);
        assert_eq!(labelled, vec!["/a/work/notes", "/b/work/notes"]);
    }

    #[test]
    fn the_home_directory_is_abbreviated_in_the_fallback() {
        let labelled = labels(
            &paths(&["/home/me/work/notes", "/other/work/notes"]),
            Some("/home/me"),
        );
        assert_eq!(labelled, vec!["~/work/notes", "/other/work/notes"]);
    }

    #[test]
    fn a_home_prefix_only_matches_whole_path_segments() {
        // `/home/meredith` is not inside `/home/me`.
        assert_eq!(
            shorten("/home/meredith/notes", Some("/home/me")),
            "/home/meredith/notes"
        );
        assert_eq!(shorten("/home/me/notes", Some("/home/me")), "~/notes");
        assert_eq!(shorten("/home/me", Some("/home/me")), "~");
    }

    #[test]
    fn an_empty_list_produces_no_labels() {
        assert!(labels(&[], None).is_empty());
    }
}
