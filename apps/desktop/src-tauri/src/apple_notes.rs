//! Apple Notes, over the scripting bridge.
//!
//! Unlike Evernote there is no export file: Apple Notes exports one note at a
//! time, to PDF, so the app has to go and fetch the notes itself. There are two
//! ways and this takes the sanctioned one.
//!
//! **Not the SQLite store.** `NoteStore.sqlite` is faster and is what most
//! third-party scripts read, but note bodies there are gzipped protobuf in an
//! undocumented schema Apple has changed between releases, it needs Full Disk
//! Access — a permission a notes app has no business asking for, granted in
//! System Settings with no way to explain itself — and the database is live, so
//! reading it while Notes runs risks a torn read. That trade buys a speed-up on
//! a one-time operation in exchange for a permission users should refuse and a
//! format that breaks yearly.
//!
//! **So: scripting.** Documented, prompted properly through Automation with a
//! usage string we control (`Info.plist`), and stable across releases. Its cost
//! is speed — a few notes a second — which is what the importer's progress and
//! cancel are for.
//!
//! Three scripts, in `scripts/`, embedded here and piped to `osascript` on
//! stdin so they stay real files that can be run by hand. They are JXA rather
//! than AppleScript because they have to return structured data and honest
//! dates; the one thing JXA cannot do is extend the 120-second Apple event
//! timeout, so **no request here covers the whole library**. Folders, then one
//! folder's notes, then bodies in small batches.

use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::vault::{Result, VaultError};

const FOLDERS: &str = include_str!("../scripts/notes_folders.js");
const ENUMERATE: &str = include_str!("../scripts/notes_enumerate.js");
const BODIES: &str = include_str!("../scripts/notes_bodies.js");

/// A folder, as the picker shows it. `path` is nested with `/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesFolder {
    pub id: String,
    pub path: String,
    pub count: usize,
}

/// A note before its body has been fetched — the cheap half of the import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    pub id: String,
    pub name: String,
    pub locked: bool,
    pub created: Option<String>,
    pub modified: Option<String>,
}

/// A note's body, or why there isn't one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBody {
    pub id: String,
    pub body: Option<String>,
    /// Names only. There is no way to ask Notes for an attachment's bytes.
    pub attachments: Vec<String>,
    pub error: Option<String>,
}

/// What a failed `osascript` run was actually about.
///
/// Classified rather than passed through as prose because the frontend has to
/// treat the first case completely differently: Automation access is granted
/// somewhere else entirely, and the underlying message is `-1743`, which
/// explains nothing to anybody.
fn classify(stderr: &str) -> VaultError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("-1743") || lower.contains("not authorized") || lower.contains("-600") {
        return VaultError::NotPermitted;
    }
    if lower.contains("-1712") || lower.contains("timed out") {
        return VaultError::Io(
            "Notes stopped answering. It may be busy syncing — try again, or import one folder at \
             a time."
                .into(),
        );
    }
    if lower.contains("-1728") {
        return VaultError::Io("Notes no longer has that folder or note.".into());
    }
    let message = stderr.trim();
    VaultError::Io(if message.is_empty() {
        "Notes could not be read.".into()
    } else {
        message.to_string()
    })
}

/// Run one of the embedded scripts and return its stdout.
fn osascript(script: &str, args: &[&str]) -> Result<String> {
    // Windows and Linux have no Notes and no `osascript`; the command is absent
    // from `COMMANDS` on those platforms, so this is a backstop rather than a
    // path anyone should reach.
    if !cfg!(target_os = "macos") {
        return Err(VaultError::Io(
            "Apple Notes is only available on macOS".into(),
        ));
    }

    let mut child = Command::new("osascript")
        .arg("-l")
        .arg("JavaScript")
        // `-` reads the script from stdin, and arguments after it still reach
        // the script's `run(argv)`.
        .arg("-")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| VaultError::Io(format!("could not run osascript: {e}")))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| VaultError::Io("osascript refused its input".into()))?
        .write_all(script.as_bytes())?;
    // Closed before waiting, or osascript goes on waiting for more script.
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .map_err(|e| VaultError::Io(e.to_string()))?;
    if !output.status.success() {
        return Err(classify(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T> {
    if json.is_empty() {
        return Err(VaultError::Io("Notes answered with nothing".into()));
    }
    serde_json::from_str(json)
        .map_err(|e| VaultError::Io(format!("Notes answered with something unreadable: {e}")))
}

/// Every folder in the library, nested paths included.
#[tauri::command]
pub async fn apple_notes_folders() -> Result<Vec<NotesFolder>> {
    parse(&osascript(FOLDERS, &[])?)
}

/// One folder's notes, without bodies.
#[tauri::command]
pub async fn apple_notes_enumerate(folder: String) -> Result<Vec<NoteRef>> {
    parse(&osascript(ENUMERATE, &[&folder])?)
}

/// The bodies of a batch of notes. Keep batches small — see the module note.
#[tauri::command]
pub async fn apple_notes_bodies(ids: Vec<String>) -> Result<Vec<NoteBody>> {
    let payload = serde_json::to_string(&ids).map_err(|e| VaultError::Io(e.to_string()))?;
    parse(&osascript(BODIES, &[&payload])?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_apple_event_is_its_own_failure() {
        // The message macOS actually produces when Automation is off.
        let stderr = "execution error: Not authorized to send Apple events to Notes. (-1743)";
        assert!(matches!(classify(stderr), VaultError::NotPermitted));
        assert_eq!(classify(stderr).code(), "notPermitted");
    }

    #[test]
    fn a_timeout_says_what_to_do_about_it() {
        let error = classify("execution error: AppleEvent timed out. (-1712)");
        assert_eq!(error.code(), "io");
        assert!(error.to_string().contains("one folder at a time"));
    }

    #[test]
    fn anything_else_is_passed_through_rather_than_guessed_at() {
        let error = classify("execution error: something new in the next macOS (-9999)");
        assert!(error.to_string().contains("something new"));
    }

    #[test]
    fn an_empty_answer_is_not_an_empty_library() {
        // A script that printed nothing failed in a way that would otherwise
        // read as "you have no notes".
        let parsed: Result<Vec<NotesFolder>> = parse("");
        assert!(parsed.is_err());
    }
}
