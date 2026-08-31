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
/// Freehand drawings. Plaintext JSON, so they diff and merge like any other file.
const DRAWING_EXTENSIONS: &[&str] = &["excalidraw"];
/// Formats that are definitely not text, so we never offer to edit them.
///
/// The list is a denylist rather than an allowlist of text extensions because a
/// vault is an ordinary repository: it may hold a `Makefile`, a `.env`, a
/// `Dockerfile` or any of a hundred config formats, and an allowlist would have
/// to grow forever to keep up. Anything not listed here is offered as text and
/// refused at read time if it turns out not to decode as UTF-8.
const BINARY_EXTENSIONS: &[&str] = &[
    "pdf", "zip", "gz", "tar", "bz2", "xz", "7z", "rar", "dmg", "iso", "exe", "dll", "so", "dylib",
    "a", "o", "bin", "wasm", "class", "jar", "pyc", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "odt", "ods", "key", "pages", "numbers", "mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4",
    "mov", "avi", "mkv", "webm", "ttf", "otf", "woff", "woff2", "eot", "psd", "ai", "sketch",
    "sqlite", "db", "ico", "icns", "heic", "tiff", "tif",
];

/// Per-vault configuration, hidden from the tree.
///
/// It is the app's own storage and the settings and shortcuts panels are the way
/// to change it; listing it invites hand-edits that race those panels. It stays
/// a plain committed file, so it is still there for anyone who wants it.
const CONFIG_DIR: &str = ".opennote";

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

    #[error("{0} already exists")]
    AlreadyExists(String),

    #[error("{0} cannot be modified")]
    Protected(String),

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
            VaultError::AlreadyExists(_) => "alreadyExists",
            VaultError::Protected(_) => "protected",
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
    /// Editable in the drawing canvas.
    Drawing,
    /// Editable as plain text, with syntax highlighting where we know the format.
    Text,
    /// Listed by name only.
    Other,
    /// A directory. Reported so that empty folders are visible: git cannot
    /// store one, so nothing in the file listing would imply it exists.
    Folder,
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
        } else if DRAWING_EXTENSIONS.contains(&ext.as_str()) {
            FileKind::Drawing
        } else if BINARY_EXTENSIONS.contains(&ext.as_str()) {
            FileKind::Other
        } else {
            FileKind::Text
        }
    }

    /// Whether the app will open this in a text editor and write it back.
    fn is_editable_text(self) -> bool {
        matches!(self, FileKind::Markdown | FileKind::Text)
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
    /// Last modified, as seconds since the epoch. Zero when unknown, which
    /// simply sorts the file last rather than failing the whole listing.
    pub modified: u64,
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

/// How deep the folder walk goes, and how many folders it will report.
///
/// A vault is an ordinary repository and may be enormous. Both caps exist so a
/// pathological one degrades to a shallow tree instead of freezing the window.
const MAX_FOLDER_DEPTH: usize = 12;
const MAX_FOLDERS: usize = 4096;

/// Whether a vault-relative path is the app's own config directory.
fn is_config_path(rel: &str) -> bool {
    rel == CONFIG_DIR || rel.starts_with(&format!("{CONFIG_DIR}/"))
}

/// Every directory in the vault, so that empty folders are visible.
///
/// Git has no concept of an empty directory, so this is the one listing that has
/// to come from the filesystem rather than from git. `ignored` prunes the walk at
/// the top of each ignored tree, which is what keeps a `node_modules` from being
/// walked at all.
fn walk_folders(root: &Path, ignored: &[PathBuf]) -> Vec<VaultFile> {
    let mut found = Vec::new();
    let mut queue: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];

    while let Some((dir, rel, depth)) = queue.pop() {
        if depth >= MAX_FOLDER_DEPTH || found.len() >= MAX_FOLDERS {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // `.git` would be catastrophic to expose, and the config directory is
            // ours; every other dot-directory is tooling the notes app has no
            // business showing either.
            if name.starts_with('.') {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if ignored.iter().any(|i| to_slash(i) == child_rel) {
                continue;
            }
            found.push(VaultFile {
                path: child_rel.clone(),
                name,
                kind: FileKind::Folder,
                size: 0,
                modified: 0,
            });
            queue.push((entry.path(), child_rel, depth + 1));
        }
    }

    found
}

/// Every file and folder in the vault, classified. Ordering is stable so the tree
/// does not jump around between refreshes.
pub fn list(git: &SystemGit, root: &Path) -> Result<Vec<VaultFile>> {
    let mut files: Vec<VaultFile> = git
        .list_files(root)?
        .into_iter()
        .map(|rel| {
            let abs = root.join(&rel);
            let metadata = fs::metadata(&abs);
            VaultFile {
                path: to_slash(&rel),
                name: rel
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                kind: FileKind::of(&rel),
                size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: metadata
                    .as_ref()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            }
        })
        .filter(|f| !f.path.is_empty() && !is_config_path(&f.path))
        .collect();

    // Folders never fail the listing: a walk that cannot read a directory should
    // cost that folder, not the whole tree.
    let ignored = git.ignored_directories(root).unwrap_or_default();
    files.extend(walk_folders(root, &ignored));

    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    Ok(files)
}

/// Read a note, or any other file the app will edit as text.
///
/// A vault is an ordinary repository, so it holds `.txt` scratch files and the
/// odd script alongside the notes. Refusing to open those made the app less
/// useful than the text editor the user already had open beside it.
pub fn read_note(root: &Path, relative: &str) -> Result<String> {
    let path = resolve_within(root, relative)?;
    if !FileKind::of(&path).is_editable_text() {
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

/// Read a drawing's JSON.
pub fn read_drawing(root: &Path, relative: &str) -> Result<String> {
    let path = resolve_within(root, relative)?;
    if FileKind::of(&path) != FileKind::Drawing {
        return Err(VaultError::NotEditable(relative.to_string()));
    }
    let size = fs::metadata(&path)?.len();
    if size > MAX_NOTE_BYTES {
        return Err(VaultError::TooLarge(size));
    }
    String::from_utf8(fs::read(&path)?).map_err(|_| VaultError::NotUtf8)
}

/// Write a drawing, rejecting anything that is not valid JSON.
///
/// A corrupt `.excalidraw` file would be unopenable, and because these are
/// committed automatically a bad write would be published before anyone noticed.
pub fn write_drawing(root: &Path, relative: &str, contents: &str) -> Result<()> {
    let path = resolve_within(root, relative)?;
    if FileKind::of(&path) != FileKind::Drawing {
        return Err(VaultError::NotEditable(relative.to_string()));
    }
    serde_json::from_str::<serde_json::Value>(contents)
        .map_err(|e| VaultError::Io(format!("drawing is not valid JSON: {e}")))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, contents)?;
    Ok(())
}

pub fn write_note(root: &Path, relative: &str, contents: &str) -> Result<()> {
    let path = resolve_within(root, relative)?;
    if !FileKind::of(&path).is_editable_text() {
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

/// Reject a path that must never be written to or removed.
///
/// `resolve_within` already blocks escaping the vault, but not the two ways to
/// destroy it from the inside: naming the vault root itself, or naming `.git`.
/// A delete is recursive, so either would be catastrophic.
fn reject_protected(root: &Path, relative: &str) -> Result<PathBuf> {
    let trimmed = relative.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Err(VaultError::Protected("the vault root".into()));
    }
    let first = trimmed.split('/').next().unwrap_or_default();
    if first == ".git" {
        return Err(VaultError::Protected(".git".into()));
    }

    let resolved = resolve_within(root, trimmed)?;
    if resolved == root.canonicalize()? {
        return Err(VaultError::Protected("the vault root".into()));
    }
    Ok(resolved)
}

pub fn create_folder(root: &Path, relative: &str) -> Result<()> {
    let path = reject_protected(root, relative)?;
    if path.exists() {
        return Err(VaultError::AlreadyExists(relative.to_string()));
    }
    fs::create_dir_all(&path)?;
    Ok(())
}

/// Create a note, refusing to overwrite anything that is already there.
pub fn create_note(root: &Path, relative: &str, contents: &str) -> Result<()> {
    let path = reject_protected(root, relative)?;
    if path.exists() {
        return Err(VaultError::AlreadyExists(relative.to_string()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, contents)?;
    Ok(())
}

/// Rename or move a file or folder.
///
/// A plain rename: git detects renames itself and `add -A` already stages them,
/// so `git mv` would buy nothing and would fail on untracked files.
pub fn rename_entry(root: &Path, from: &str, to: &str) -> Result<()> {
    let source = reject_protected(root, from)?;
    let target = reject_protected(root, to)?;

    if !source.exists() {
        return Err(VaultError::Io(format!("{from} does not exist")));
    }
    // Case-only renames land on the same path on a case-insensitive filesystem,
    // and must not be mistaken for a collision.
    if target.exists() && source != target {
        return Err(VaultError::AlreadyExists(to.to_string()));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&source, &target)?;
    Ok(())
}

/// Delete a file or folder permanently.
///
/// There is no trash: git history is the recovery mechanism, and a second
/// half-mechanism would be worse than one clear one. The caller is responsible
/// for telling the user when a path is untracked and therefore unrecoverable.
pub fn delete_entry(root: &Path, relative: &str) -> Result<()> {
    let path = reject_protected(root, relative)?;
    if !path.exists() {
        return Err(VaultError::Io(format!("{relative} does not exist")));
    }
    if path.is_dir() {
        fs::remove_dir_all(&path)?;
    } else {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Longest attachment extension we will honour; anything else is suspicious.
const MAX_EXTENSION: usize = 8;

/// Store a pasted or dropped file and return its vault-relative path.
///
/// The name is a hash of the contents, which does two useful things at once:
/// pasting the same screenshot twice reuses one file instead of making a second
/// copy, and there is no collision to resolve with a counter. It also means the
/// name can never carry anything hostile in from the clipboard.
pub fn write_attachment(
    root: &Path,
    folder: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<String> {
    use sha2::{Digest, Sha256};

    let ext: String = extension
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(MAX_EXTENSION)
        .collect::<String>()
        .to_ascii_lowercase();
    if ext.is_empty() {
        return Err(VaultError::Io(
            "attachment has no usable file extension".into(),
        ));
    }

    let digest = Sha256::digest(bytes);
    let name = format!("{:x}", digest);
    let relative = match folder.trim().trim_matches('/') {
        "" | "." => format!("{}.{ext}", &name[..16]),
        dir => format!("{dir}/{}.{ext}", &name[..16]),
    };

    let path = reject_protected(root, &relative)?;
    // Identical contents mean the file is already correct; leave it alone.
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, bytes)?;
    }
    Ok(relative)
}

/// Read any vault file as raw bytes, for previewing an attachment.
pub fn read_bytes(root: &Path, relative: &str) -> Result<Vec<u8>> {
    let path = resolve_within(root, relative)?;
    let size = fs::metadata(&path)?.len();
    if size > MAX_PREVIEW_BYTES {
        return Err(VaultError::TooLarge(size));
    }
    Ok(fs::read(&path)?)
}

/// Per-vault settings file, relative to the vault root.
pub const SETTINGS_PATH: &str = ".opennote/settings.json";
/// Per-vault keymap file, relative to the vault root.
pub const KEYMAP_PATH: &str = ".opennote/keymap.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSource {
    pub path: String,
    pub content: String,
}

/// Every markdown note in the vault, with its text.
///
/// One call rather than one per note: a vault of a few thousand notes would
/// otherwise mean a few thousand IPC round trips to build the search index.
/// Unreadable or non-UTF-8 files are skipped rather than failing the whole load.
pub fn read_all_notes(git: &SystemGit, root: &Path) -> Result<Vec<NoteSource>> {
    let mut out = Vec::new();
    for rel in git.list_files(root)? {
        if FileKind::of(&rel) != FileKind::Markdown {
            continue;
        }
        let abs = root.join(&rel);
        let Ok(meta) = fs::metadata(&abs) else {
            continue;
        };
        if meta.len() > MAX_NOTE_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&abs) else { continue };
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        out.push(NoteSource {
            path: to_slash(&rel),
            content,
        });
    }
    Ok(out)
}

/// Raw settings JSON, or `None` when the vault has none yet.
///
/// The schema is owned by the frontend, which is where the sync engine and its
/// defaults live; this side only moves bytes.
pub fn read_settings(root: &Path) -> Result<Option<String>> {
    read_config(root, SETTINGS_PATH)
}

pub fn write_settings(root: &Path, json: &str) -> Result<()> {
    write_config(root, SETTINGS_PATH, json)
}

pub fn read_keymap(root: &Path) -> Result<Option<String>> {
    read_config(root, KEYMAP_PATH)
}

pub fn write_keymap(root: &Path, json: &str) -> Result<()> {
    write_config(root, KEYMAP_PATH, json)
}

fn read_config(root: &Path, relative: &str) -> Result<Option<String>> {
    let path = resolve_within(root, relative)?;
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_config(root: &Path, relative: &str, json: &str) -> Result<()> {
    // Reject anything unparseable rather than writing a file that will fail to
    // load on next launch.
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| VaultError::Io(format!("{relative} is not valid JSON: {e}")))?;

    let path = resolve_within(root, relative)?;
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
        assert_eq!(FileKind::of(Path::new("a.zip")), FileKind::Other);
    }

    #[test]
    fn treats_unrecognised_extensions_as_editable_text() {
        // A vault is an ordinary repository; an allowlist of text extensions
        // would never keep up with what people actually keep in one.
        assert_eq!(FileKind::of(Path::new("a.txt")), FileKind::Text);
        assert_eq!(FileKind::of(Path::new("a.ts")), FileKind::Text);
        assert_eq!(FileKind::of(Path::new("Makefile")), FileKind::Text);
        assert_eq!(FileKind::of(Path::new(".gitignore")), FileKind::Text);
        assert!(FileKind::Text.is_editable_text());
        assert!(FileKind::Markdown.is_editable_text());
        assert!(!FileKind::Other.is_editable_text());
        assert!(!FileKind::Image.is_editable_text());
    }

    #[test]
    fn reads_and_writes_a_plain_text_file() {
        let (_d, root) = vault();
        write_note(&root, "scripts/build.sh", "#!/bin/sh\necho hi\n").expect("write");
        assert_eq!(
            read_note(&root, "scripts/build.sh").expect("read"),
            "#!/bin/sh\necho hi\n"
        );
    }

    #[test]
    fn refuses_to_open_a_binary_file_as_text() {
        let (_d, root) = vault();
        fs::write(root.join("a.pdf"), b"%PDF-1.4").unwrap();
        assert!(matches!(
            read_note(&root, "a.pdf"),
            Err(VaultError::NotEditable(_))
        ));
    }

    #[test]
    fn hides_the_config_directory_from_the_tree() {
        assert!(is_config_path(".opennote"));
        assert!(is_config_path(".opennote/settings.json"));
        assert!(!is_config_path(".opennoteworthy.md"));
        assert!(!is_config_path("notes/.opennote.md"));
    }

    #[test]
    fn walks_folders_including_empty_ones() {
        let (_d, root) = vault();
        fs::create_dir_all(root.join("Projects/2026")).unwrap();
        fs::create_dir_all(root.join("Empty")).unwrap();
        fs::create_dir_all(root.join(".opennote")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();

        let folders = walk_folders(&root, &[PathBuf::from("node_modules")]);
        let paths: Vec<&str> = folders.iter().map(|f| f.path.as_str()).collect();

        // The point of the walk: git cannot report an empty directory at all.
        assert!(paths.contains(&"Empty"));
        assert!(paths.contains(&"Projects"));
        assert!(paths.contains(&"Projects/2026"));
        // Ignored trees are pruned at the top, and never descended into.
        assert!(!paths.contains(&"node_modules"));
        assert!(!paths.contains(&"node_modules/pkg"));
        // Dot-directories are the app's own or someone's tooling.
        assert!(!paths.contains(&".opennote"));
        assert!(folders.iter().all(|f| f.kind == FileKind::Folder));
    }

    #[test]
    fn folder_walk_stops_at_the_depth_cap() {
        let (_d, root) = vault();
        let mut deep = root.clone();
        for i in 0..(MAX_FOLDER_DEPTH + 3) {
            deep = deep.join(format!("d{i}"));
        }
        fs::create_dir_all(&deep).unwrap();

        let folders = walk_folders(&root, &[]);
        assert_eq!(folders.len(), MAX_FOLDER_DEPTH);
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
    fn classifies_drawings() {
        assert_eq!(FileKind::of(Path::new("a.excalidraw")), FileKind::Drawing);
        assert_eq!(FileKind::of(Path::new("a.EXCALIDRAW")), FileKind::Drawing);
    }

    #[test]
    fn drawings_round_trip() {
        let (_d, root) = vault();
        let json = r#"{"type":"excalidraw","elements":[]}"#;
        write_drawing(&root, "diagrams/sketch.excalidraw", json).expect("write");
        assert_eq!(
            read_drawing(&root, "diagrams/sketch.excalidraw").expect("read"),
            json
        );
    }

    #[test]
    fn refuses_to_write_a_corrupt_drawing() {
        // These are auto-committed, so a bad write would be published unnoticed.
        let (_d, root) = vault();
        assert!(write_drawing(&root, "a.excalidraw", "not json").is_err());
        assert!(!root.join("a.excalidraw").exists());
    }

    #[test]
    fn a_drawing_is_not_a_note() {
        let (_d, root) = vault();
        write_drawing(&root, "a.excalidraw", "{}").expect("write");
        assert!(matches!(
            read_note(&root, "a.excalidraw"),
            Err(VaultError::NotEditable(_))
        ));
    }

    #[test]
    fn refuses_to_write_a_drawing_outside_the_vault() {
        let (_d, root) = vault();
        assert!(matches!(
            write_drawing(&root, "../escape.excalidraw", "{}"),
            Err(VaultError::PathEscapesVault)
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

    // -- file operations ----------------------------------------------------

    #[test]
    fn stores_an_attachment_under_a_content_hash() {
        let (_d, root) = vault();
        let path = write_attachment(&root, "assets", "png", b"\x89PNG fake").expect("write");
        assert!(path.starts_with("assets/"));
        assert!(path.ends_with(".png"));
        assert!(root.join(&path).exists());
    }

    #[test]
    fn the_same_bytes_reuse_one_file() {
        // Pasting the same screenshot twice should not leave two copies behind.
        let (_d, root) = vault();
        let a = write_attachment(&root, "assets", "png", b"same").expect("write");
        let b = write_attachment(&root, "assets", "png", b"same").expect("write");
        assert_eq!(a, b);
    }

    #[test]
    fn different_bytes_get_different_names() {
        let (_d, root) = vault();
        let a = write_attachment(&root, "assets", "png", b"one").expect("write");
        let b = write_attachment(&root, "assets", "png", b"two").expect("write");
        assert_ne!(a, b);
    }

    #[test]
    fn an_empty_folder_setting_puts_attachments_at_the_root() {
        let (_d, root) = vault();
        let path = write_attachment(&root, ".", "png", b"x").expect("write");
        assert!(!path.contains('/'), "got {path}");
    }

    #[test]
    fn a_hostile_extension_cannot_escape_the_attachment_folder() {
        // The extension comes from the clipboard, so it is untrusted input.
        // Everything but alphanumerics is dropped rather than rejected, so the
        // paste still works — it just cannot carry a path with it.
        let (_d, root) = vault();
        let path = write_attachment(&root, "assets", "../../evil", b"x").expect("write");
        assert!(path.starts_with("assets/"), "escaped to {path}");
        assert!(!path.contains(".."), "traversal survived in {path}");
        assert!(path.ends_with(".evil"));
    }

    #[test]
    fn an_extension_with_nothing_usable_in_it_is_refused() {
        let (_d, root) = vault();
        assert!(write_attachment(&root, "assets", "", b"x").is_err());
        assert!(write_attachment(&root, "assets", "../..", b"x").is_err());
    }

    #[test]
    fn a_long_extension_is_truncated() {
        let (_d, root) = vault();
        let path = write_attachment(&root, "assets", "averylongextension", b"x").expect("write");
        let ext = path.rsplit('.').next().unwrap();
        assert!(ext.len() <= 8, "got {ext}");
    }

    #[test]
    fn attachments_round_trip_as_bytes() {
        let (_d, root) = vault();
        let path = write_attachment(&root, "assets", "png", b"payload").expect("write");
        assert_eq!(read_bytes(&root, &path).expect("read"), b"payload");
    }

    #[test]
    fn creates_a_folder() {
        let (_d, root) = vault();
        create_folder(&root, "projects").expect("create");
        assert!(root.join("projects").is_dir());
    }

    #[test]
    fn creates_nested_folders_in_one_go() {
        let (_d, root) = vault();
        create_folder(&root, "a/b/c").expect("create");
        assert!(root.join("a/b/c").is_dir());
    }

    #[test]
    fn refuses_to_create_a_folder_that_exists() {
        let (_d, root) = vault();
        create_folder(&root, "projects").expect("create");
        assert!(matches!(
            create_folder(&root, "projects"),
            Err(VaultError::AlreadyExists(_))
        ));
    }

    #[test]
    fn creates_a_note_with_its_folders() {
        let (_d, root) = vault();
        create_note(&root, "a/b/note.md", "# hi").expect("create");
        assert_eq!(
            fs::read_to_string(root.join("a/b/note.md")).unwrap(),
            "# hi"
        );
    }

    #[test]
    fn refuses_to_overwrite_an_existing_note() {
        // Creating over someone's note would destroy it with no undo.
        let (_d, root) = vault();
        create_note(&root, "note.md", "original").expect("create");
        assert!(matches!(
            create_note(&root, "note.md", "replacement"),
            Err(VaultError::AlreadyExists(_))
        ));
        assert_eq!(
            fs::read_to_string(root.join("note.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn renames_a_note() {
        let (_d, root) = vault();
        create_note(&root, "old.md", "body").expect("create");
        rename_entry(&root, "old.md", "new.md").expect("rename");
        assert!(!root.join("old.md").exists());
        assert_eq!(fs::read_to_string(root.join("new.md")).unwrap(), "body");
    }

    #[test]
    fn renaming_into_a_new_folder_creates_it() {
        let (_d, root) = vault();
        create_note(&root, "note.md", "body").expect("create");
        rename_entry(&root, "note.md", "archive/2026/note.md").expect("rename");
        assert!(root.join("archive/2026/note.md").exists());
    }

    #[test]
    fn refuses_a_rename_that_would_overwrite() {
        let (_d, root) = vault();
        create_note(&root, "a.md", "a").expect("create");
        create_note(&root, "b.md", "b").expect("create");
        assert!(matches!(
            rename_entry(&root, "a.md", "b.md"),
            Err(VaultError::AlreadyExists(_))
        ));
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "b");
    }

    #[test]
    fn allows_a_case_only_rename() {
        // On a case-insensitive filesystem both names are the same path, which
        // must not be mistaken for a collision.
        let (_d, root) = vault();
        create_note(&root, "note.md", "body").expect("create");
        rename_entry(&root, "note.md", "Note.md").expect("rename");
        assert_eq!(fs::read_to_string(root.join("Note.md")).unwrap(), "body");
    }

    #[test]
    fn renames_a_folder_and_everything_in_it() {
        let (_d, root) = vault();
        create_note(&root, "old/inner.md", "body").expect("create");
        rename_entry(&root, "old", "new").expect("rename");
        assert_eq!(
            fs::read_to_string(root.join("new/inner.md")).unwrap(),
            "body"
        );
    }

    #[test]
    fn deletes_a_note() {
        let (_d, root) = vault();
        create_note(&root, "note.md", "body").expect("create");
        delete_entry(&root, "note.md").expect("delete");
        assert!(!root.join("note.md").exists());
    }

    #[test]
    fn deletes_a_folder_and_its_contents() {
        let (_d, root) = vault();
        create_note(&root, "folder/inner.md", "body").expect("create");
        delete_entry(&root, "folder").expect("delete");
        assert!(!root.join("folder").exists());
    }

    #[test]
    fn refuses_to_delete_a_path_that_is_not_there() {
        let (_d, root) = vault();
        assert!(delete_entry(&root, "ghost.md").is_err());
    }

    // -- the guards that matter ---------------------------------------------

    #[test]
    fn refuses_to_delete_the_vault_root() {
        // Deleting is recursive; naming the root would destroy everything.
        let (_d, root) = vault();
        create_note(&root, "note.md", "body").expect("create");
        for attempt in ["", ".", "/", "   "] {
            assert!(
                matches!(delete_entry(&root, attempt), Err(VaultError::Protected(_))),
                "root delete not blocked for {attempt:?}"
            );
        }
        assert!(root.join("note.md").exists());
    }

    #[test]
    fn refuses_to_touch_the_git_directory() {
        let (_d, root) = vault();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main").unwrap();

        assert!(matches!(
            delete_entry(&root, ".git"),
            Err(VaultError::Protected(_))
        ));
        assert!(matches!(
            delete_entry(&root, ".git/HEAD"),
            Err(VaultError::Protected(_))
        ));
        assert!(matches!(
            create_note(&root, ".git/hooks/evil", "x"),
            Err(VaultError::Protected(_))
        ));
        assert!(root.join(".git/HEAD").exists());
    }

    #[test]
    fn refuses_operations_outside_the_vault() {
        let (_d, root) = vault();
        assert!(matches!(
            create_note(&root, "../escape.md", "x"),
            Err(VaultError::PathEscapesVault)
        ));
        assert!(matches!(
            delete_entry(&root, "../escape.md"),
            Err(VaultError::PathEscapesVault)
        ));
        assert!(matches!(
            rename_entry(&root, "../a.md", "../b.md"),
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
    fn keymap_round_trips_separately_from_settings() {
        let (_d, root) = vault();
        write_settings(&root, r#"{"sync":{}}"#).expect("settings");
        write_keymap(&root, r#"{"scheme":"bear"}"#).expect("keymap");
        assert_eq!(
            read_keymap(&root).expect("read").as_deref(),
            Some(r#"{"scheme":"bear"}"#)
        );
        assert_eq!(
            read_settings(&root).expect("read").as_deref(),
            Some(r#"{"sync":{}}"#)
        );
    }

    #[test]
    fn invalid_keymap_json_is_refused() {
        let (_d, root) = vault();
        assert!(write_keymap(&root, "nope").is_err());
        assert!(!root.join(KEYMAP_PATH).exists());
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
