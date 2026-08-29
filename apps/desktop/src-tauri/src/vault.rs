//! Vault: a Git repository opened as a set of notes.
//!
//! Everything here is deliberately path-paranoid. The frontend supplies relative
//! paths, and a webview is not a trust boundary we want to rely on — so every
//! path is resolved and checked to be inside the vault before any IO happens.

use std::fs;
use std::path::{Component, Path, PathBuf};

use git_port::{GitPort, SystemGit};
use serde::{Deserialize, Serialize};

/// Files we render in the editor.
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd"];
/// Files we can show a preview for, but never open for editing.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

/// Refuse to load anything absurd into the editor. Notes are prose, and a
/// multi-megabyte "note" is a sign something has gone wrong.
const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;

/// Preview images are inlined as data URLs, so the ceiling is lower than for
/// notes — base64 inflates by a third and the whole string crosses the IPC bridge.
const MAX_PREVIEW_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("{0} is not a git repository — open a folder that has been initialised with git")]
    NotARepository(String),

    #[error("path escapes the vault")]
    PathEscapesVault,

    #[error("{0} is not a text note and cannot be opened")]
    NotEditable(String),

    #[error("file is too large to open ({0} bytes)")]
    TooLarge(u64),

    #[error("file is not valid UTF-8 text")]
    NotUtf8,

    #[error(transparent)]
    Git(#[from] git_port::GitError),

    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        VaultError::Io(e.to_string())
    }
}

impl VaultError {
    /// A stable machine-readable tag.
    ///
    /// The sync engine reacts very differently to each of these — `nothingToCommit`
    /// is routine, `offline` means back off and retry, `conflicted` means stop and
    /// ask the user — so the frontend must be able to branch on the kind of failure
    /// rather than pattern-match on English prose.
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::NotARepository(_) => "notARepository",
            VaultError::PathEscapesVault => "pathEscapesVault",
            VaultError::NotEditable(_) => "notEditable",
            VaultError::TooLarge(_) => "tooLarge",
            VaultError::NotUtf8 => "notUtf8",
            VaultError::Io(_) => "io",
            VaultError::Git(e) => match e {
                git_port::GitError::GitNotFound => "gitNotFound",
                git_port::GitError::NotARepository(_) => "notARepository",
                git_port::GitError::NothingToCommit => "nothingToCommit",
                git_port::GitError::PushRejected(_) => "pushRejected",
                git_port::GitError::Offline => "offline",
                git_port::GitError::NoUpstream(_) => "noUpstream",
                git_port::GitError::Conflicted { .. } => "conflicted",
                _ => "gitFailed",
            },
        }
    }
}

// Tauri requires command errors to be serialisable. Emitting an object rather
// than a bare string lets the frontend branch on `code` and still show `message`.
impl serde::Serialize for VaultError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("VaultError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    /// Editable in the app.
    Markdown,
    /// Previewable, not editable.
    Image,
    /// Listed by name only.
    Other,
}

impl FileKind {
    fn of(path: &Path) -> Self {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if MARKDOWN_EXTENSIONS.contains(&ext.as_str()) {
            FileKind::Markdown
        } else if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            FileKind::Image
        } else {
            FileKind::Other
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    /// Vault-relative path, always with forward slashes so the UI can treat it
    /// as a stable identifier on every platform.
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub branch: String,
    pub upstream: Option<String>,
}

/// Resolve a vault-relative path, rejecting anything that escapes the vault.
///
/// Rejects absolute paths and `..` components before touching the filesystem,
/// then canonicalises so symlinks pointing outside the vault are caught too.
pub fn resolve_within(root: &Path, relative: &str) -> Result<PathBuf> {
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(VaultError::PathEscapesVault);
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(VaultError::PathEscapesVault),
        }
    }

    let candidate = root.join(rel);
    let root_real = root.canonicalize()?;

    if let Ok(real) = candidate.canonicalize() {
        // Exists: canonicalising also resolves symlinks, so a link pointing out
        // of the vault is caught here.
        if !real.starts_with(&root_real) {
            return Err(VaultError::PathEscapesVault);
        }
        return Ok(real);
    }

    // Does not exist yet, and neither may several of its parents — creating
    // `daily/2026/notes.md` in a fresh vault is normal. Canonicalise the deepest
    // ancestor that does exist and check that instead; `..` was already rejected
    // above, so nothing below an in-vault ancestor can climb back out.
    let mut ancestor = candidate.parent();
    while let Some(dir) = ancestor {
        if let Ok(real) = dir.canonicalize() {
            if !real.starts_with(&root_real) {
                return Err(VaultError::PathEscapesVault);
            }
            return Ok(candidate);
        }
        ancestor = dir.parent();
    }
    Err(VaultError::PathEscapesVault)
}

fn to_slash(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Validate that `root` is a Git repository and report its identity.
pub fn open(git: &SystemGit, root: &Path) -> Result<VaultInfo> {
    if !git.is_repository(root) {
        return Err(VaultError::NotARepository(root.display().to_string()));
    }
    let status = git.status(root)?;
    Ok(VaultInfo {
        root: root.display().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string()),
        branch: status.branch,
        upstream: status.upstream,
    })
}

/// Every file in the vault, classified. Ordering is stable so the tree does not
/// jump around between refreshes.
pub fn list(git: &SystemGit, root: &Path) -> Result<Vec<VaultFile>> {
    let mut files: Vec<VaultFile> = git
        .list_files(root)?
        .into_iter()
        .map(|rel| {
            let abs = root.join(&rel);
            VaultFile {
                path: to_slash(&rel),
                name: rel
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                kind: FileKind::of(&rel),
                size: fs::metadata(&abs).map(|m| m.len()).unwrap_or(0),
            }
        })
        .filter(|f| !f.path.is_empty())
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

pub fn read_note(root: &Path, relative: &str) -> Result<String> {
    let path = resolve_within(root, relative)?;
    if FileKind::of(&path) != FileKind::Markdown {
        return Err(VaultError::NotEditable(relative.to_string()));
    }
    let size = fs::metadata(&path)?.len();
    if size > MAX_NOTE_BYTES {
        return Err(VaultError::TooLarge(size));
    }
    let bytes = fs::read(&path)?;
    String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8)
}

/// Read a text file verbatim, without the markdown-only restriction.
///
/// Used for conflicted files, which must be shown with their markers intact so
/// the user can see exactly what git produced.
pub fn read_raw(root: &Path, relative: &str) -> Result<String> {
    let path = resolve_within(root, relative)?;
    let size = fs::metadata(&path)?.len();
    if size > MAX_NOTE_BYTES {
        return Err(VaultError::TooLarge(size));
    }
    String::from_utf8(fs::read(&path)?).map_err(|_| VaultError::NotUtf8)
}

pub fn write_note(root: &Path, relative: &str, contents: &str) -> Result<()> {
    let path = resolve_within(root, relative)?;
    if FileKind::of(&path) != FileKind::Markdown {
        return Err(VaultError::NotEditable(relative.to_string()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, contents)?;
    Ok(())
}

/// An image as a `data:` URL, for preview only.
///
/// Inlining avoids configuring Tauri's asset protocol and, more usefully, means
/// the vault's files are never exposed to the webview by path.
pub fn read_image_data_url(root: &Path, relative: &str) -> Result<String> {
    let path = resolve_within(root, relative)?;
    if FileKind::of(&path) != FileKind::Image {
        return Err(VaultError::NotEditable(relative.to_string()));
    }
    let size = fs::metadata(&path)?.len();
    if size > MAX_PREVIEW_BYTES {
        return Err(VaultError::TooLarge(size));
    }

    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };

    let bytes = fs::read(&path)?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
    ))
}

/// Per-vault settings file, relative to the vault root.
pub const SETTINGS_PATH: &str = ".opennote/settings.json";

/// Raw settings JSON, or `None` when the vault has none yet.
///
/// The schema is owned by the frontend, which is where the sync engine and its
/// defaults live; this side only moves bytes.
pub fn read_settings(root: &Path) -> Result<Option<String>> {
    let path = resolve_within(root, SETTINGS_PATH)?;
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn write_settings(root: &Path, json: &str) -> Result<()> {
    // Reject anything unparseable rather than writing a file that will fail to
    // load on next launch.
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| VaultError::Io(format!("settings are not valid JSON: {e}")))?;

    let path = resolve_within(root, SETTINGS_PATH)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault() -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonicalize");
        (dir, root)
    }

    #[test]
    fn classifies_by_extension() {
        assert_eq!(FileKind::of(Path::new("a.md")), FileKind::Markdown);
        assert_eq!(FileKind::of(Path::new("a.MD")), FileKind::Markdown);
        assert_eq!(FileKind::of(Path::new("a.markdown")), FileKind::Markdown);
        assert_eq!(FileKind::of(Path::new("a.png")), FileKind::Image);
        assert_eq!(FileKind::of(Path::new("a.JPEG")), FileKind::Image);
        assert_eq!(FileKind::of(Path::new("a.pdf")), FileKind::Other);
        assert_eq!(FileKind::of(Path::new("Makefile")), FileKind::Other);
    }

    #[test]
    fn resolves_a_normal_relative_path() {
        let (_d, root) = vault();
        fs::write(root.join("note.md"), "x").unwrap();
        let p = resolve_within(&root, "note.md").expect("resolve");
        assert_eq!(p, root.join("note.md"));
    }

    #[test]
    fn resolves_a_path_that_does_not_exist_yet() {
        let (_d, root) = vault();
        let p = resolve_within(&root, "new.md").expect("resolve");
        assert_eq!(p, root.join("new.md"));
    }

    #[test]
    fn rejects_parent_traversal() {
        let (_d, root) = vault();
        for attempt in ["../escape.md", "a/../../escape.md", "../../etc/passwd"] {
            assert!(
                matches!(
                    resolve_within(&root, attempt),
                    Err(VaultError::PathEscapesVault)
                ),
                "traversal not blocked: {attempt}"
            );
        }
    }

    #[test]
    fn rejects_absolute_paths() {
        let (_d, root) = vault();
        assert!(matches!(
            resolve_within(&root, "/etc/passwd"),
            Err(VaultError::PathEscapesVault)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_pointing_outside_the_vault() {
        let (_d, root) = vault();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.md");
        fs::write(&secret, "private").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("link.md")).unwrap();

        assert!(
            matches!(
                resolve_within(&root, "link.md"),
                Err(VaultError::PathEscapesVault)
            ),
            "symlink escape was not blocked"
        );
    }

    #[test]
    fn resolves_a_path_whose_parent_directories_do_not_exist_yet() {
        let (_d, root) = vault();
        let p = resolve_within(&root, "daily/2026/08/note.md").expect("resolve");
        assert_eq!(p, root.join("daily/2026/08/note.md"));
    }

    #[test]
    fn writes_notes_into_directories_that_do_not_exist_yet() {
        let (_d, root) = vault();
        write_note(&root, "a/b/c/deep.md", "# deep").expect("write");
        assert_eq!(read_note(&root, "a/b/c/deep.md").expect("read"), "# deep");
    }

    #[test]
    fn reads_and_writes_notes_round_trip() {
        let (_d, root) = vault();
        write_note(&root, "daily/2026-08-29.md", "# Today").expect("write");
        assert_eq!(
            read_note(&root, "daily/2026-08-29.md").expect("read"),
            "# Today"
        );
    }

    #[test]
    fn refuses_to_open_non_markdown_files() {
        let (_d, root) = vault();
        fs::write(root.join("photo.png"), [0u8, 1, 2]).unwrap();
        assert!(matches!(
            read_note(&root, "photo.png"),
            Err(VaultError::NotEditable(_))
        ));
    }

    #[test]
    fn builds_a_data_url_for_images() {
        let (_d, root) = vault();
        // A one-pixel GIF is enough to prove the encoding path.
        fs::write(root.join("pixel.gif"), b"GIF89a").unwrap();
        let url = read_image_data_url(&root, "pixel.gif").expect("data url");
        assert!(url.starts_with("data:image/gif;base64,"), "got {url}");
    }

    #[test]
    fn refuses_to_preview_non_images() {
        let (_d, root) = vault();
        fs::write(root.join("note.md"), "# hi").unwrap();
        assert!(matches!(
            read_image_data_url(&root, "note.md"),
            Err(VaultError::NotEditable(_))
        ));
    }

    #[test]
    fn refuses_to_preview_outside_the_vault() {
        let (_d, root) = vault();
        assert!(matches!(
            read_image_data_url(&root, "../secret.png"),
            Err(VaultError::PathEscapesVault)
        ));
    }

    #[test]
    fn settings_are_absent_until_written() {
        let (_d, root) = vault();
        assert_eq!(read_settings(&root).expect("read"), None);
    }

    #[test]
    fn settings_round_trip_into_the_repo() {
        let (_d, root) = vault();
        write_settings(&root, r#"{"sync":{"autoPush":true}}"#).expect("write");
        assert!(root.join(SETTINGS_PATH).exists(), "settings not written");
        assert_eq!(
            read_settings(&root).expect("read").as_deref(),
            Some(r#"{"sync":{"autoPush":true}}"#)
        );
    }

    #[test]
    fn invalid_settings_json_is_refused_rather_than_written() {
        let (_d, root) = vault();
        assert!(write_settings(&root, "{ not json").is_err());
        assert!(
            !root.join(SETTINGS_PATH).exists(),
            "a broken settings file was written"
        );
    }

    #[test]
    fn error_codes_are_stable_for_the_frontend() {
        assert_eq!(VaultError::PathEscapesVault.code(), "pathEscapesVault");
        assert_eq!(VaultError::NotUtf8.code(), "notUtf8");
        assert_eq!(
            VaultError::Git(git_port::GitError::NothingToCommit).code(),
            "nothingToCommit"
        );
        assert_eq!(
            VaultError::Git(git_port::GitError::Offline).code(),
            "offline"
        );
    }

    #[test]
    fn refuses_to_write_outside_the_vault() {
        let (_d, root) = vault();
        assert!(matches!(
            write_note(&root, "../escape.md", "nope"),
            Err(VaultError::PathEscapesVault)
        ));
    }

    #[test]
    fn reports_invalid_utf8_rather_than_mangling_it() {
        let (_d, root) = vault();
        fs::write(root.join("bad.md"), [0xff, 0xfe, 0xfd]).unwrap();
        assert!(matches!(
            read_note(&root, "bad.md"),
            Err(VaultError::NotUtf8)
        ));
    }
}
