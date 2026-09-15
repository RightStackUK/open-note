//! Reading an Evernote `.enex` export, one note at a time.
//!
//! The rest of importing is in `packages/core`, where it can be a pure
//! function over a fixture: what a note is called, how its body converts to
//! Markdown, where its attachments go. This module exists because of one fact
//! that cannot be handled there — **size**. A ten-year Evernote archive is a
//! multi-gigabyte XML file of base64, and the webview cannot hold it. Neither
//! can it hold one note's resources *and* send them back across the IPC to be
//! written.
//!
//! So the file stays here. A session is an open reader plus the decoded bytes
//! of exactly one note, and the frontend pulls notes through it:
//!
//! 1. `enex_open` — take the file, report its size for a progress bar.
//! 2. `enex_next` — scan up to the next `</note>` and hand over its text,
//!    its metadata, and a *description* of its resources: an MD5, a MIME type
//!    and a size. The bytes stay here.
//! 3. The frontend decides the note's path and its attachments' paths, writes
//!    the note through the same seam every other new note goes through, and
//!    calls `enex_write_media` with hash → path for the files.
//! 4. `enex_close` — release it. Cancelling is simply stopping at step 2.
//!
//! Memory is therefore bounded by the largest single note rather than by the
//! archive, and no attachment ever crosses the bridge.
//!
//! The MD5 is not a checksum here, it is the *name*: `<en-media hash="…"/>` is
//! how a body references a resource, and the file never states it. Decoding
//! and hashing every resource is the only way to resolve the reference.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use md5::{Digest, Md5};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

use crate::vault::{self, Result, VaultError};

/// Evernote's own ceiling for one attachment is 200 MB. This is a backstop
/// against a malformed file claiming to hold something far larger, not a
/// policy — anything over it is left out and reported as missing.
const MAX_RESOURCE_BYTES: usize = 256 * 1024 * 1024;

/// A resource as the frontend sees it: named by its hash, without its bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawResource {
    /// Lowercase hex MD5 of the decoded bytes — what `<en-media>` references.
    pub hash: String,
    pub mime: String,
    pub file_name: Option<String>,
    pub size: usize,
}

/// One note, with its dates still in Evernote's spelling: converting them is
/// `packages/core`'s job, and a fixture there is a better place to prove it.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawNote {
    pub title: String,
    /// The `<en-note>` XHTML body.
    pub content: String,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub tags: Vec<String>,
    pub source_url: Option<String>,
    pub resources: Vec<RawResource>,
}

/// The answer to "give me the next note", with progress attached.
///
/// Progress is measured in bytes rather than notes because the note count is
/// unknowable without a first pass over the whole file — which for the files
/// that need a progress bar is the expensive thing being reported on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextNote {
    /// `None` at the end of the file.
    pub note: Option<RawNote>,
    pub bytes_read: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedEnex {
    pub id: u64,
    pub bytes_total: u64,
}

/// Where the frontend decided one resource should be written.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaWrite {
    pub hash: String,
    /// Vault-relative, and as untrusted as any other path from the webview.
    pub path: String,
}

#[derive(Debug, Default)]
struct PendingResource {
    mime: String,
    file_name: Option<String>,
    data: String,
}

/// An open `.enex` file, positioned between notes.
pub struct Scanner<R: BufRead> {
    reader: Reader<R>,
    total: u64,
    /// The decoded resources of the note last handed over, keyed by hash.
    /// Cleared when the next note is asked for, which is what bounds memory.
    pending: HashMap<String, Vec<u8>>,
}

fn local_name(name: &[u8]) -> String {
    let after_colon = name.rsplit(|b| *b == b':').next().unwrap_or(name);
    String::from_utf8_lossy(after_colon).to_ascii_lowercase()
}

impl<R: BufRead> Scanner<R> {
    pub fn new(inner: R, total: u64) -> Self {
        let mut reader = Reader::from_reader(inner);
        // Whitespace is content inside `<content>`, and the base64 in `<data>`
        // is wrapped across lines; both are handled where they are read.
        reader.config_mut().trim_text(false);
        // An export written by hand, or by a third-party tool, is not worth
        // failing over: a mismatched tag loses that note, not the archive.
        reader.config_mut().check_end_names = false;
        Self {
            reader,
            total,
            pending: HashMap::new(),
        }
    }

    pub fn bytes_read(&self) -> u64 {
        self.reader.buffer_position()
    }

    /// The bytes of the resource `hash`, if it belongs to the current note.
    pub fn resource(&self, hash: &str) -> Option<&[u8]> {
        self.pending.get(hash).map(Vec::as_slice)
    }

    /// Scan forward to the end of the next `<note>`.
    ///
    /// Returns `Ok(None)` at the end of the file. The element names are
    /// matched without their namespace prefix and case-insensitively, because
    /// a file written by an exporter other than Evernote's own still deserves
    /// to import.
    pub fn next_note(&mut self) -> Result<Option<RawNote>> {
        self.pending.clear();

        let mut note: Option<RawNote> = None;
        let mut resource: Option<PendingResource> = None;
        let mut text = String::new();
        // Local rather than a field: the event borrows this buffer, and a
        // field would hold `self` borrowed while a resource is being stored.
        let mut buf = Vec::new();

        loop {
            buf.clear();
            let event = self
                .reader
                .read_event_into(&mut buf)
                .map_err(|e| VaultError::Io(format!("the export is not readable XML: {e}")))?;

            match event {
                Event::Eof => return Ok(None),

                Event::Start(tag) => {
                    match local_name(tag.name().as_ref()).as_str() {
                        "note" => note = Some(RawNote::default()),
                        "resource" if note.is_some() => resource = Some(PendingResource::default()),
                        _ => {}
                    }
                    text.clear();
                }

                Event::Text(chunk) if note.is_some() => {
                    // `xml10_content` resolves the entities; some exports use
                    // HTML ones like `&nbsp;` that XML never defined, and a
                    // title is not worth failing an archive over, so the raw
                    // decoding stands in when that happens.
                    let decoded = chunk
                        .xml10_content()
                        .or_else(|_| chunk.decode())
                        .map_err(|e| VaultError::Io(format!("the export is not readable: {e}")))?;
                    text.push_str(&decoded);
                }

                // An entity reference. Since quick-xml 0.38 these arrive as
                // their own event rather than inside the text, so ignoring
                // them would silently drop the `&` out of every
                // `First &amp; foremost`.
                Event::GeneralRef(entity) if note.is_some() => {
                    if let Ok(Some(character)) = entity.resolve_char_ref() {
                        text.push(character);
                        continue;
                    }
                    let name = entity.decode().unwrap_or_default();
                    match quick_xml::escape::unescape(&format!("&{name};")) {
                        Ok(resolved) => text.push_str(&resolved),
                        // An HTML entity XML never defined. `&nbsp;` is the one
                        // that actually turns up, in titles pasted from a web
                        // page; anything else is kept as written rather than
                        // thrown away.
                        Err(_) if name == "nbsp" => text.push(' '),
                        Err(_) => text.push_str(&format!("&{name};")),
                    }
                }

                // `<content>` is a CDATA block holding the body as XHTML.
                Event::CData(chunk) if note.is_some() => {
                    text.push_str(&String::from_utf8_lossy(&chunk));
                }

                Event::End(tag) => {
                    let name = local_name(tag.name().as_ref());
                    let value = std::mem::take(&mut text);

                    if name == "note" {
                        // A `</note>` with no `<note>` is a malformed file, not
                        // a note; keep reading rather than inventing one.
                        if let Some(mut finished) = note.take() {
                            finished.title = finished.title.trim().to_string();
                            return Ok(Some(finished));
                        }
                        continue;
                    }

                    let Some(current) = note.as_mut() else {
                        continue;
                    };

                    if name == "resource" {
                        if let Some(done) = resource.take() {
                            absorb(&mut self.pending, current, done);
                        }
                        continue;
                    }

                    if let Some(pending) = resource.as_mut() {
                        match name.as_str() {
                            "mime" => pending.mime = value.trim().to_string(),
                            "file-name" => {
                                let trimmed = value.trim();
                                if !trimmed.is_empty() {
                                    pending.file_name = Some(trimmed.to_string());
                                }
                            }
                            "data" => pending.data = value,
                            _ => {}
                        }
                        continue;
                    }

                    match name.as_str() {
                        "title" => current.title = value,
                        "content" => current.content = value,
                        "created" => current.created = non_empty(&value),
                        "updated" => current.updated = non_empty(&value),
                        "source-url" => current.source_url = non_empty(&value),
                        "tag" => {
                            if let Some(tag) = non_empty(&value) {
                                current.tags.push(tag);
                            }
                        }
                        _ => {}
                    }
                }

                _ => {}
            }
        }
    }
}

/// Decode a finished `<resource>`, hash it, and keep its bytes.
///
/// A resource that will not decode is dropped rather than failing the import:
/// the body's reference to it then resolves to nothing, which the frontend
/// already reports as an attachment missing from the export.
fn absorb(store: &mut HashMap<String, Vec<u8>>, note: &mut RawNote, pending: PendingResource) {
    let mut encoded = pending.data;
    encoded.retain(|c| !c.is_whitespace());
    if encoded.is_empty() {
        return;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()) else {
        return;
    };
    if bytes.is_empty() || bytes.len() > MAX_RESOURCE_BYTES {
        return;
    }

    let hash = format!("{:x}", Md5::digest(&bytes));
    note.resources.push(RawResource {
        hash: hash.clone(),
        mime: pending.mime,
        file_name: pending.file_name,
        size: bytes.len(),
    });
    store.insert(hash, bytes);
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

type FileScanner = Scanner<BufReader<File>>;

#[derive(Default)]
struct Registry {
    next: u64,
    open: HashMap<u64, FileScanner>,
}

/// The `.enex` files currently being read. One per file, not one per import:
/// an import of four notebooks opens and closes four of these in turn.
#[derive(Default)]
pub struct Sessions(Mutex<Registry>);

fn locked(sessions: &Sessions) -> Result<std::sync::MutexGuard<'_, Registry>> {
    sessions
        .0
        .lock()
        .map_err(|_| VaultError::Io("the importer is in a bad state; reopen the file".into()))
}

/// Ask for `.enex` files to import. An empty list means the user cancelled.
#[tauri::command]
pub async fn pick_enex_files(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Choose Evernote exports")
        .add_filter("Evernote export", &["enex"])
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    rx.recv()
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
        .collect()
}

#[tauri::command]
pub fn enex_open(sessions: tauri::State<'_, Sessions>, path: String) -> Result<OpenedEnex> {
    let file_path = Path::new(&path);
    let file = File::open(file_path)?;
    let bytes_total = file.metadata().map(|m| m.len()).unwrap_or(0);
    // 1 MiB, because the notes being reassembled are large and the file may be
    // measured in gigabytes.
    let scanner = Scanner::new(BufReader::with_capacity(1024 * 1024, file), bytes_total);

    let mut registry = locked(&sessions)?;
    registry.next += 1;
    let id = registry.next;
    registry.open.insert(id, scanner);
    Ok(OpenedEnex { id, bytes_total })
}

#[tauri::command]
pub fn enex_next(sessions: tauri::State<'_, Sessions>, id: u64) -> Result<NextNote> {
    let mut registry = locked(&sessions)?;
    let scanner = registry
        .open
        .get_mut(&id)
        .ok_or_else(|| VaultError::Io("that import is no longer open".into()))?;

    let note = scanner.next_note()?;
    Ok(NextNote {
        note,
        bytes_read: scanner.bytes_read(),
        bytes_total: scanner.total,
    })
}

/// Write the current note's resources where the frontend decided they go.
///
/// Returns how many were written. A hash that is not the current note's is
/// skipped rather than refused: the note itself has already landed, and
/// failing the whole import over one attachment would be the worse trade.
#[tauri::command]
pub fn enex_write_media(
    sessions: tauri::State<'_, Sessions>,
    id: u64,
    root: String,
    items: Vec<MediaWrite>,
) -> Result<u32> {
    let registry = locked(&sessions)?;
    let scanner = registry
        .open
        .get(&id)
        .ok_or_else(|| VaultError::Io("that import is no longer open".into()))?;

    let root = Path::new(&root);
    let mut written = 0;
    for item in items {
        let Some(bytes) = scanner.resource(&item.hash.to_ascii_lowercase()) else {
            continue;
        };
        vault::write_new_file(root, &item.path, bytes)?;
        written += 1;
    }
    Ok(written)
}

#[tauri::command]
pub fn enex_close(sessions: tauri::State<'_, Sessions>, id: u64) {
    if let Ok(mut registry) = locked(&sessions) {
        registry.open.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn scan(xml: &str) -> Vec<RawNote> {
        let mut scanner = Scanner::new(Cursor::new(xml.as_bytes().to_vec()), xml.len() as u64);
        let mut notes = Vec::new();
        while let Some(note) = scanner.next_note().expect("scans") {
            notes.push(note);
        }
        notes
    }

    const TWO_NOTES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>First &amp; foremost</title>
    <content><![CDATA[<en-note><div>Hello</div></en-note>]]></content>
    <created>20240115T093000Z</created>
    <updated>20240116T101500Z</updated>
    <tag>work</tag>
    <tag>reading</tag>
    <note-attributes><source-url>https://example.com</source-url></note-attributes>
  </note>
  <note>
    <title>Second</title>
    <content><![CDATA[<en-note/>]]></content>
  </note>
</en-export>"#;

    #[test]
    fn scans_notes_one_at_a_time() {
        let notes = scan(TWO_NOTES);
        assert_eq!(notes.len(), 2);

        let first = &notes[0];
        assert_eq!(first.title, "First & foremost");
        assert_eq!(first.content, "<en-note><div>Hello</div></en-note>");
        assert_eq!(first.created.as_deref(), Some("20240115T093000Z"));
        assert_eq!(first.updated.as_deref(), Some("20240116T101500Z"));
        assert_eq!(first.tags, vec!["work", "reading"]);
        assert_eq!(first.source_url.as_deref(), Some("https://example.com"));
        assert_eq!(notes[1].title, "Second");
    }

    #[test]
    fn hashes_a_resource_so_the_body_can_reference_it() {
        // "hi" — MD5 49f68a5c8493ec2c0bf489821c21fc3b.
        let xml = r#"<en-export><note><title>With a file</title>
          <content><![CDATA[<en-note><en-media hash="49f68a5c8493ec2c0bf489821c21fc3b" type="image/png"/></en-note>]]></content>
          <resource>
            <data encoding="base64">a
            Gk=</data>
            <mime>image/png</mime>
            <resource-attributes><file-name>shot.png</file-name></resource-attributes>
          </resource>
        </note></en-export>"#;

        let mut scanner = Scanner::new(Cursor::new(xml.as_bytes().to_vec()), xml.len() as u64);
        let note = scanner.next_note().expect("scans").expect("a note");

        assert_eq!(note.resources.len(), 1);
        let resource = &note.resources[0];
        assert_eq!(resource.hash, "49f68a5c8493ec2c0bf489821c21fc3b");
        assert_eq!(resource.mime, "image/png");
        assert_eq!(resource.file_name.as_deref(), Some("shot.png"));
        assert_eq!(resource.size, 2);
        // The body references the hash, so the bytes must be reachable by it.
        assert_eq!(scanner.resource(&resource.hash), Some(&b"hi"[..]));
    }

    #[test]
    fn forgets_a_note_s_resources_when_the_next_is_asked_for() {
        let xml = r#"<en-export>
          <note><title>One</title><resource><data encoding="base64">aGk=</data><mime>image/png</mime></resource></note>
          <note><title>Two</title></note>
        </en-export>"#;

        let mut scanner = Scanner::new(Cursor::new(xml.as_bytes().to_vec()), xml.len() as u64);
        let first = scanner.next_note().expect("scans").expect("a note");
        let hash = first.resources[0].hash.clone();
        assert!(scanner.resource(&hash).is_some());

        scanner.next_note().expect("scans").expect("a second note");
        // Memory is bounded by the largest note, not by the archive.
        assert!(scanner.resource(&hash).is_none());
    }

    #[test]
    fn drops_a_resource_it_cannot_decode_rather_than_failing_the_import() {
        let xml = r#"<en-export><note><title>Broken</title>
          <resource><data encoding="base64">!!!not base64!!!</data><mime>image/png</mime></resource>
        </note></en-export>"#;

        let notes = scan(xml);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].resources.is_empty());
    }

    #[test]
    fn reports_progress_against_the_size_of_the_file() {
        let mut scanner = Scanner::new(
            Cursor::new(TWO_NOTES.as_bytes().to_vec()),
            TWO_NOTES.len() as u64,
        );
        scanner.next_note().expect("scans");
        let after_first = scanner.bytes_read();
        assert!(after_first > 0 && after_first < TWO_NOTES.len() as u64);

        while scanner.next_note().expect("scans").is_some() {}
        assert_eq!(scanner.bytes_read(), TWO_NOTES.len() as u64);
    }
}
