//! End-to-end exercise of the flow the UI drives: open a vault, list it, read a
//! note, edit it, then sync to a remote.
//!
//! These call the same `vault` and `git_port` functions the Tauri commands wrap,
//! against a real repository and a real (local, bare) remote. The commands
//! themselves are thin, so this covers everything below the IPC boundary.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use git_port::{GitPort, MergeOutcome, SystemGit};
use open_note_desktop_lib::vault;
use tempfile::TempDir;

fn run_git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn identify(repo: &Path) {
    run_git(repo, &["config", "user.email", "test@example.com"]);
    run_git(repo, &["config", "user.name", "Test"]);
    run_git(repo, &["config", "commit.gpgsign", "false"]);
}

/// A working vault with an `origin` it can actually push to.
fn vault_with_remote() -> (TempDir, PathBuf, PathBuf) {
    let dir = TempDir::new().expect("temp dir");
    let base = dir.path().canonicalize().expect("canonicalize");
    let origin = base.join("origin.git");
    let work = base.join("vault");

    run_git(
        &base,
        &["init", "--bare", "-b", "main", origin.to_str().unwrap()],
    );
    run_git(
        &base,
        &["clone", origin.to_str().unwrap(), work.to_str().unwrap()],
    );
    identify(&work);
    (dir, origin, work)
}

#[test]
fn refuses_a_folder_that_is_not_a_repository() {
    let dir = TempDir::new().unwrap();
    let err = vault::open(&SystemGit::new(), dir.path()).unwrap_err();
    assert!(
        matches!(err, vault::VaultError::NotARepository(_)),
        "got {err:?}"
    );
}

#[test]
fn opens_a_repository_and_reports_its_branch() {
    let (_d, _origin, work) = vault_with_remote();
    let info = vault::open(&SystemGit::new(), &work).expect("open");
    assert_eq!(info.branch, "main");
    assert_eq!(info.name, "vault");
}

#[test]
fn lists_notes_images_and_other_files_but_never_ignored_ones() {
    let (_d, _origin, work) = vault_with_remote();
    fs::create_dir_all(work.join("daily")).unwrap();
    fs::write(work.join("README.md"), "# hi").unwrap();
    fs::write(work.join("daily/today.md"), "# today").unwrap();
    fs::write(work.join("logo.png"), b"\x89PNG").unwrap();
    fs::write(work.join("data.bin"), b"\x00\x01").unwrap();
    fs::write(work.join(".gitignore"), "ignored.md\n").unwrap();
    fs::write(work.join("ignored.md"), "secret").unwrap();

    let files = vault::list(&SystemGit::new(), &work).expect("list");
    let by_path = |p: &str| files.iter().find(|f| f.path == p).cloned();

    assert_eq!(
        by_path("README.md").unwrap().kind,
        vault::FileKind::Markdown
    );
    assert_eq!(
        by_path("daily/today.md").unwrap().kind,
        vault::FileKind::Markdown
    );
    assert_eq!(by_path("logo.png").unwrap().kind, vault::FileKind::Image);
    assert_eq!(by_path("data.bin").unwrap().kind, vault::FileKind::Other);
    assert!(by_path("ignored.md").is_none(), "ignored file was listed");
}

#[test]
fn nested_paths_use_forward_slashes_on_every_platform() {
    let (_d, _origin, work) = vault_with_remote();
    fs::create_dir_all(work.join("a/b")).unwrap();
    fs::write(work.join("a/b/note.md"), "x").unwrap();

    let files = vault::list(&SystemGit::new(), &work).expect("list");
    assert!(files.iter().any(|f| f.path == "a/b/note.md"), "{files:?}");
}

#[test]
fn edits_round_trip_through_disk() {
    let (_d, _origin, work) = vault_with_remote();
    vault::write_note(&work, "note.md", "# first").expect("write");
    assert_eq!(vault::read_note(&work, "note.md").unwrap(), "# first");

    vault::write_note(&work, "note.md", "# second").expect("rewrite");
    assert_eq!(vault::read_note(&work, "note.md").unwrap(), "# second");
    // The editor is the source of truth for the file's bytes.
    assert_eq!(
        fs::read_to_string(work.join("note.md")).unwrap(),
        "# second"
    );
}

#[test]
fn a_new_note_appears_in_the_listing_as_untracked() {
    let (_d, _origin, work) = vault_with_remote();
    vault::write_note(&work, "daily/2026-08-29.md", "# today").expect("write");

    let git = SystemGit::new();
    let files = vault::list(&git, &work).expect("list");
    assert!(files.iter().any(|f| f.path == "daily/2026-08-29.md"));

    let status = git.status(&work).expect("status");
    assert!(!status.is_clean());
}

#[test]
fn sync_commits_and_pushes_a_new_note() {
    let (_d, origin, work) = vault_with_remote();
    let git = SystemGit::new();

    vault::write_note(&work, "note.md", "# hello").expect("write");
    git.commit(&work, &[], "notes: sync from Open Note")
        .expect("commit");
    git.push(&work, "origin", "main").expect("push");

    // The note is really on the remote, not just committed locally.
    let out = Command::new("git")
        .args(["show", "main:note.md"])
        .current_dir(&origin)
        .output()
        .expect("git show");
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "# hello");

    assert!(git.status(&work).expect("status").is_clean());
}

#[test]
fn sync_pulls_a_collaborators_note_into_the_vault() {
    let (dir, origin, work) = vault_with_remote();
    let git = SystemGit::new();

    vault::write_note(&work, "mine.md", "# mine").expect("write");
    git.commit(&work, &[], "notes: mine").expect("commit");
    git.push(&work, "origin", "main").expect("push");

    // Somebody else pushes a note.
    let other = dir.path().join("other");
    let out = Command::new("git")
        .args(["clone", origin.to_str().unwrap(), other.to_str().unwrap()])
        .output()
        .expect("clone");
    assert!(out.status.success());
    identify(&other);
    fs::write(other.join("theirs.md"), "# theirs").unwrap();
    run_git(&other, &["add", "-A"]);
    run_git(&other, &["commit", "-m", "notes: theirs"]);
    run_git(&other, &["push", "origin", "main"]);

    git.fetch(&work, "origin").expect("fetch");
    let outcome = git.pull_rebase(&work).expect("pull");
    assert!(
        matches!(outcome, MergeOutcome::Rebased { .. }),
        "{outcome:?}"
    );
    assert_eq!(
        vault::read_note(&work, "theirs.md").expect("read"),
        "# theirs"
    );
}

#[test]
fn a_note_cannot_be_written_outside_the_vault() {
    let (_d, _origin, work) = vault_with_remote();
    let err = vault::write_note(&work, "../escaped.md", "nope").unwrap_err();
    assert!(matches!(err, vault::VaultError::PathEscapesVault));
    assert!(
        !work.parent().unwrap().join("escaped.md").exists(),
        "a file was written outside the vault"
    );
}
