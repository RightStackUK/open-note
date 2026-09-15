//! An Evernote export, read and landed in a vault.
//!
//! The scanner's own behaviour is unit-tested in `enex.rs`; what this covers is
//! the join it cannot: a realistic file scanned note by note, and its
//! resources written into a real repository through the same guarded path the
//! Tauri command uses. Deciding *where* they go is `packages/core`'s job and is
//! tested there, so the paths here stand in for what the planner would choose.

use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::process::Command;

use open_note_desktop_lib::enex::Scanner;
use open_note_desktop_lib::vault;
use tempfile::TempDir;

/// Two notes, one of them with an attachment referenced from the body by its
/// MD5, an encrypted block, tags, and a title no filesystem would accept.
const ARCHIVE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20240210T101500Z" application="Evernote" version="10.0">
  <note>
    <title>Q1: plans/ideas</title>
    <content>
      <![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>
  <div><en-todo checked="true"/>Book the room</div>
  <div><en-todo checked="false"/>Send the deck</div>
  <div><en-media hash="49f68a5c8493ec2c0bf489821c21fc3b" type="image/png"/></div>
  <div><en-crypt cipher="AES" length="128">U2FsdGVk</en-crypt></div>
</en-note>]]>
    </content>
    <created>20240115T093000Z</created>
    <updated>20240116T101500Z</updated>
    <tag>work</tag>
    <tag>planning</tag>
    <note-attributes>
      <source-url>https://example.com/plans</source-url>
    </note-attributes>
    <resource>
      <data encoding="base64">
        aGk=
      </data>
      <mime>image/png</mime>
      <width>16</width>
      <resource-attributes>
        <file-name>Screen Shot.png</file-name>
      </resource-attributes>
    </resource>
  </note>
  <note>
    <title>Plain &amp; simple</title>
    <content><![CDATA[<en-note><div>Nothing attached.</div></en-note>]]></content>
    <created>20240201T080000Z</created>
  </note>
</en-export>"#;

fn scanner() -> Scanner<Cursor<Vec<u8>>> {
    Scanner::new(
        Cursor::new(ARCHIVE.as_bytes().to_vec()),
        ARCHIVE.len() as u64,
    )
}

fn init_repo(root: &Path) {
    let out = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(root)
        .output()
        .expect("run git");
    assert!(out.status.success());
}

#[test]
fn reads_a_realistic_archive_note_by_note() {
    let mut scanner = scanner();

    let first = scanner.next_note().expect("scans").expect("a first note");
    assert_eq!(first.title, "Q1: plans/ideas");
    assert_eq!(first.tags, vec!["work", "planning"]);
    assert_eq!(first.created.as_deref(), Some("20240115T093000Z"));
    assert_eq!(
        first.source_url.as_deref(),
        Some("https://example.com/plans")
    );
    // The body is handed over as written: converting it is the frontend's job.
    assert!(first.content.contains("<en-todo checked=\"true\"/>"));
    assert!(first.content.contains("<en-crypt"));

    // The hash in the body is the MD5 of the decoded bytes, and nothing else
    // in the file states it.
    assert_eq!(first.resources.len(), 1);
    let resource = &first.resources[0];
    assert_eq!(resource.hash, "49f68a5c8493ec2c0bf489821c21fc3b");
    assert!(first.content.contains(&resource.hash));
    assert_eq!(resource.file_name.as_deref(), Some("Screen Shot.png"));
    assert_eq!(resource.mime, "image/png");

    let second = scanner.next_note().expect("scans").expect("a second note");
    assert_eq!(second.title, "Plain & simple");
    assert!(second.resources.is_empty());

    assert!(scanner.next_note().expect("scans").is_none());
}

#[test]
fn writes_a_resource_into_the_vault_where_it_was_told_to() {
    let dir = TempDir::new().expect("temp dir");
    let root = dir.path();
    init_repo(root);

    let mut scanner = scanner();
    let note = scanner.next_note().expect("scans").expect("a note");
    let bytes = scanner
        .resource(&note.resources[0].hash)
        .expect("the bytes are held for the current note")
        .to_vec();

    vault::write_new_file(root, "assets/Screen-Shot.png", &bytes).expect("writes");
    assert_eq!(
        fs::read(root.join("assets/Screen-Shot.png")).unwrap(),
        b"hi"
    );

    // Names come from note titles, which come from an export file — so the
    // write is guarded exactly like every other path out of the webview.
    assert!(vault::write_new_file(root, "../escaped.png", &bytes).is_err());
    assert!(vault::write_new_file(root, ".git/hooks/pre-commit", &bytes).is_err());
    // And it never overwrites: a second import must not eat the first's file.
    assert!(vault::write_new_file(root, "assets/Screen-Shot.png", b"other").is_err());
    assert_eq!(
        fs::read(root.join("assets/Screen-Shot.png")).unwrap(),
        b"hi"
    );
}
