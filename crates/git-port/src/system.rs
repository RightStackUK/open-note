//! Adapter that shells out to the user's own `git` binary.
//!
//! This is the desktop implementation. It exists so that credential helpers,
//! `ssh-agent`, commit signing, proxies, custom CA bundles and `git-lfs` all keep
//! working exactly as the user already configured them — none of which we would
//! get from an embedded Git library without reimplementing it.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::error::{GitError, Result};
use crate::types::{
    CommitId, ConflictSide, FetchOutcome, FileChange, FileState, MergeOutcome, RepoStatus,
};
use crate::GitPort;

#[derive(Debug, Clone)]
pub struct SystemGit {
    /// Path to the `git` executable. Defaults to resolving `git` on PATH.
    program: PathBuf,
}

impl Default for SystemGit {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
        }
    }
}

impl SystemGit {
    pub fn new() -> Self {
        Self::default()
    }

    /// Use a specific `git` executable instead of resolving one on PATH.
    pub fn with_program(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
        }
    }

    fn run(&self, cwd: Option<&Path>, args: &[&str]) -> Result<Output> {
        let mut cmd = Command::new(&self.program);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // Keep git strictly non-interactive. A credential or editor prompt would
        // block the sync engine forever with no visible cause.
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
        cmd.env("GIT_EDITOR", "true");

        cmd.output().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => GitError::GitNotFound,
            _ => GitError::Io(e),
        })
    }

    /// Run a command, returning trimmed stdout, or a classified error.
    fn run_ok(&self, cwd: Option<&Path>, args: &[&str]) -> Result<String> {
        let out = self.run(cwd, args)?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        Err(classify(args, &out))
    }

    /// Raw stdout bytes, needed where `-z` output contains NUL separators.
    fn run_ok_bytes(&self, cwd: Option<&Path>, args: &[&str]) -> Result<Vec<u8>> {
        let out = self.run(cwd, args)?;
        if out.status.success() {
            return Ok(out.stdout);
        }
        Err(classify(args, &out))
    }

    fn conflicted_paths(&self, repo: &Path) -> Result<Vec<PathBuf>> {
        let out = self.run_ok(Some(repo), &["diff", "--name-only", "--diff-filter=U"])?;
        Ok(out.lines().map(PathBuf::from).collect())
    }
}

/// Map a failed `git` invocation onto a specific error where we can recognise it.
///
/// Recognising these matters: the sync engine reacts very differently to "nothing
/// to commit" (routine) than to "push rejected" (needs a rebase) or "offline"
/// (retry later with backoff).
fn classify(args: &[&str], out: &Output) -> GitError {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let combined = format!("{stdout}\n{stderr}").to_lowercase();

    if combined.contains("nothing to commit")
        || combined.contains("no changes added to commit")
        || combined.contains("nothing added to commit")
    {
        return GitError::NothingToCommit;
    }
    if combined.contains("could not resolve host")
        || combined.contains("could not resolve hostname")
        || combined.contains("network is unreachable")
        || combined.contains("connection timed out")
        || combined.contains("temporary failure in name resolution")
    {
        return GitError::Offline;
    }
    if combined.contains("[rejected]") || combined.contains("failed to push") {
        return GitError::PushRejected(stderr.trim().to_string());
    }
    if combined.contains("no upstream") || combined.contains("no such ref was fetched") {
        return GitError::NoUpstream(String::new());
    }

    GitError::CommandFailed {
        command: args.join(" "),
        stderr: stderr.trim().to_string(),
    }
}

/// Parse `git status --porcelain=v2 --branch -z`.
///
/// `-z` is not optional here: paths may contain spaces or newlines, and the
/// non-`-z` form quotes and escapes them ambiguously.
/// Returns the status plus whether git supplied a `branch.ab` header. It omits
/// that header when the upstream ref does not exist locally — which happens on a
/// clone of an empty remote — and the caller must then work the counts out itself.
fn parse_status_v2(bytes: &[u8]) -> Result<(RepoStatus, bool)> {
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0').filter(|s| !s.is_empty()).peekable();

    let mut branch = String::from("HEAD");
    let mut upstream = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut ab_known = false;
    let mut changes = Vec::new();

    while let Some(entry) = fields.next() {
        let mut parts = entry.split(' ');
        match parts.next() {
            Some("#") => {
                let key = parts.next().unwrap_or_default();
                let value = parts.collect::<Vec<_>>().join(" ");
                match key {
                    "branch.head" => branch = value,
                    "branch.upstream" => upstream = Some(value),
                    "branch.ab" => {
                        ab_known = true;
                        // Format: "+<ahead> -<behind>"
                        for token in value.split_whitespace() {
                            let (sign, num) = token.split_at(1);
                            let n = num.parse::<u32>().unwrap_or(0);
                            match sign {
                                "+" => ahead = n,
                                "-" => behind = n,
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            // Ordinary changed entry: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            Some("1") => {
                let xy = parts.next().unwrap_or("..");
                let path = parts.clone().skip(6).collect::<Vec<_>>().join(" ");
                if !path.is_empty() {
                    changes.push(FileChange {
                        path: PathBuf::from(path),
                        state: state_from_xy(xy),
                    });
                }
            }
            // Rename/copy: 2 <XY> ... <Xscore> <path>\0<origPath>
            Some("2") => {
                let path = parts.clone().skip(7).collect::<Vec<_>>().join(" ");
                // The original path follows as its own NUL-separated field.
                fields.next();
                if !path.is_empty() {
                    changes.push(FileChange {
                        path: PathBuf::from(path),
                        state: FileState::Renamed,
                    });
                }
            }
            // Unmerged: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            Some("u") => {
                let path = parts.clone().skip(9).collect::<Vec<_>>().join(" ");
                if !path.is_empty() {
                    changes.push(FileChange {
                        path: PathBuf::from(path),
                        state: FileState::Conflicted,
                    });
                }
            }
            Some("?") => {
                let path = parts.collect::<Vec<_>>().join(" ");
                if !path.is_empty() {
                    changes.push(FileChange {
                        path: PathBuf::from(path),
                        state: FileState::Untracked,
                    });
                }
            }
            // "!" is an ignored file; we never surface those.
            _ => {}
        }
    }

    Ok((
        RepoStatus {
            branch,
            upstream,
            ahead,
            behind,
            changes,
        },
        ab_known,
    ))
}

/// `XY` is a two-character staged/unstaged status pair.
fn state_from_xy(xy: &str) -> FileState {
    let mut chars = xy.chars();
    let staged = chars.next().unwrap_or('.');
    let unstaged = chars.next().unwrap_or('.');
    match (staged, unstaged) {
        ('A', _) => FileState::Added,
        ('D', _) | (_, 'D') => FileState::Deleted,
        ('R', _) => FileState::Renamed,
        _ => FileState::Modified,
    }
}

impl GitPort for SystemGit {
    fn describe(&self) -> Result<String> {
        self.run_ok(None, &["--version"])
    }

    fn is_repository(&self, path: &Path) -> bool {
        self.run_ok(Some(path), &["rev-parse", "--is-inside-work-tree"])
            .is_ok_and(|out| out == "true")
    }

    fn status(&self, repo: &Path) -> Result<RepoStatus> {
        let bytes =
            self.run_ok_bytes(Some(repo), &["status", "--porcelain=v2", "--branch", "-z"])?;
        let (mut status, ab_known) = parse_status_v2(&bytes)?;

        // Cloning an empty remote leaves an upstream configured but no upstream
        // ref, so git reports no ahead/behind. Every local commit is unpushed.
        // Without this the sync indicator would claim there is nothing to push.
        if !ab_known && status.upstream.is_some() {
            if let Ok(count) = self.run_ok(Some(repo), &["rev-list", "--count", "HEAD"]) {
                status.ahead = count.parse::<u32>().unwrap_or(0);
            }
        }
        Ok(status)
    }

    fn list_files(&self, repo: &Path) -> Result<Vec<PathBuf>> {
        let bytes = self.run_ok_bytes(
            Some(repo),
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )?;
        let text = String::from_utf8_lossy(&bytes);
        let mut files: Vec<PathBuf> = text
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        files.sort();
        files.dedup();
        Ok(files)
    }

    fn commit(&self, repo: &Path, paths: &[PathBuf], message: &str) -> Result<CommitId> {
        // `add -A` honours .gitignore, so ignored files never enter a commit.
        let mut add: Vec<String> = vec!["add".into(), "-A".into(), "--".into()];
        if paths.is_empty() {
            add.push(".".into());
        } else {
            add.extend(paths.iter().map(|p| p.to_string_lossy().into_owned()));
        }
        let add_refs: Vec<&str> = add.iter().map(String::as_str).collect();
        self.run_ok(Some(repo), &add_refs)?;

        self.run_ok(Some(repo), &["commit", "-m", message])?;
        let oid = self.run_ok(Some(repo), &["rev-parse", "HEAD"])?;
        Ok(CommitId(oid))
    }

    fn fetch(&self, repo: &Path, remote: &str) -> Result<FetchOutcome> {
        self.run_ok(Some(repo), &["fetch", "--quiet", remote])?;

        // How far the upstream has moved ahead of us. No upstream means nothing
        // to integrate, which is a valid state rather than a failure.
        let new_commits = match self.run_ok(Some(repo), &["rev-list", "--count", "HEAD..@{u}"]) {
            Ok(count) => count.parse::<u32>().unwrap_or(0),
            Err(GitError::NoUpstream(_)) | Err(GitError::CommandFailed { .. }) => 0,
            Err(e) => return Err(e),
        };
        Ok(FetchOutcome { new_commits })
    }

    fn pull_rebase(&self, repo: &Path) -> Result<MergeOutcome> {
        let before = self.run_ok(Some(repo), &["rev-parse", "HEAD"])?;

        match self.run_ok(Some(repo), &["pull", "--rebase", "--autostash"]) {
            Ok(_) => {}
            Err(GitError::CommandFailed { .. }) => {
                // A failed rebase usually means conflicts. Confirm, and if so
                // report them: resolution is the user's call, never ours.
                let paths = self.conflicted_paths(repo)?;
                if !paths.is_empty() {
                    return Ok(MergeOutcome::Conflicted { paths });
                }
                return Err(GitError::CommandFailed {
                    command: "pull --rebase --autostash".into(),
                    stderr: "rebase failed with no conflicted paths".into(),
                });
            }
            Err(e) => return Err(e),
        }

        let after = self.run_ok(Some(repo), &["rev-parse", "HEAD"])?;
        if before == after {
            return Ok(MergeOutcome::AlreadyUpToDate);
        }
        let count = self
            .run_ok(
                Some(repo),
                &["rev-list", "--count", &format!("{before}..{after}")],
            )
            .ok()
            .and_then(|c| c.parse::<u32>().ok())
            .unwrap_or(0);
        Ok(MergeOutcome::Rebased { commits: count })
    }

    fn push(&self, repo: &Path, remote: &str, branch: &str) -> Result<()> {
        // Deliberately no --force, and no --force-with-lease. Automated pushes
        // must never be able to destroy remote history.
        self.run_ok(Some(repo), &["push", remote, branch])?;
        Ok(())
    }

    fn resolve_with(&self, repo: &Path, path: &Path, side: ConflictSide) -> Result<()> {
        // During a rebase the user's own commit is being replayed on top of the
        // upstream work, so git's --ours is the upstream and --theirs is the
        // user. Invert here so callers can speak in user terms.
        let flag = if self.rebase_in_progress(repo) {
            match side {
                ConflictSide::Mine => "--theirs",
                ConflictSide::Theirs => "--ours",
            }
        } else {
            match side {
                ConflictSide::Mine => "--ours",
                ConflictSide::Theirs => "--theirs",
            }
        };
        let path_str = path.to_string_lossy();
        self.run_ok(Some(repo), &["checkout", flag, "--", &path_str])?;
        self.run_ok(Some(repo), &["add", "--", &path_str])?;
        Ok(())
    }

    fn stage(&self, repo: &Path, paths: &[PathBuf]) -> Result<()> {
        let mut args: Vec<String> = vec!["add".into(), "--".into()];
        if paths.is_empty() {
            args.push(".".into());
        } else {
            args.extend(paths.iter().map(|p| p.to_string_lossy().into_owned()));
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_ok(Some(repo), &refs)?;
        Ok(())
    }

    fn rebase_continue(&self, repo: &Path) -> Result<MergeOutcome> {
        match self.run_ok(Some(repo), &["rebase", "--continue"]) {
            Ok(_) => {}
            Err(GitError::CommandFailed { .. }) => {
                // Still conflicted, or nothing staged. Report which.
                let paths = self.conflicted_paths(repo)?;
                if !paths.is_empty() {
                    return Ok(MergeOutcome::Conflicted { paths });
                }
                return Err(GitError::CommandFailed {
                    command: "rebase --continue".into(),
                    stderr: "rebase could not continue".into(),
                });
            }
            Err(e) => return Err(e),
        }

        if self.rebase_in_progress(repo) {
            // Multi-commit rebases can stop again on the next commit.
            let paths = self.conflicted_paths(repo)?;
            if !paths.is_empty() {
                return Ok(MergeOutcome::Conflicted { paths });
            }
        }
        let head = self.run_ok(Some(repo), &["rev-parse", "HEAD"])?;
        Ok(MergeOutcome::FastForwarded { to: CommitId(head) })
    }

    fn rebase_abort(&self, repo: &Path) -> Result<()> {
        self.run_ok(Some(repo), &["rebase", "--abort"])?;
        Ok(())
    }

    fn rebase_in_progress(&self, repo: &Path) -> bool {
        let git_dir = match self.run_ok(Some(repo), &["rev-parse", "--git-dir"]) {
            Ok(d) => d,
            Err(_) => return false,
        };
        let base = if Path::new(&git_dir).is_absolute() {
            PathBuf::from(git_dir)
        } else {
            repo.join(git_dir)
        };
        base.join("rebase-merge").exists() || base.join("rebase-apply").exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// A throwaway repo with deterministic identity, so tests do not depend on
    /// (or interact with) the developer's global git config.
    fn fixture() -> (TempDir, PathBuf, SystemGit) {
        let dir = TempDir::new().expect("temp dir");
        let repo = dir.path().to_path_buf();
        let git = SystemGit::new();

        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git.run_ok(Some(&repo), &args).expect("git setup");
        }
        (dir, repo, git)
    }

    fn write(repo: &Path, name: &str, body: &str) {
        fs::write(repo.join(name), body).expect("write file");
    }

    #[test]
    fn describe_reports_a_git_version() {
        let git = SystemGit::new();
        let version = git
            .describe()
            .expect("a git binary is required to run the test suite");
        assert!(version.starts_with("git version"), "got: {version}");
    }

    #[test]
    fn missing_binary_reports_git_not_found() {
        let git = SystemGit::with_program("definitely-not-a-real-git-binary");
        assert!(matches!(git.describe(), Err(GitError::GitNotFound)));
    }

    #[test]
    fn detects_a_working_tree() {
        let git = SystemGit::new();
        assert!(git.is_repository(Path::new(env!("CARGO_MANIFEST_DIR"))));
    }

    #[test]
    fn rejects_a_non_repository() {
        assert!(!SystemGit::new().is_repository(Path::new("/")));
    }

    #[test]
    fn status_reports_branch_and_untracked_files() {
        let (_dir, repo, git) = fixture();
        write(&repo, "note.md", "# hello");

        let status = git.status(&repo).expect("status");
        assert_eq!(status.branch, "main");
        assert_eq!(status.upstream, None);
        assert!(!status.is_clean());
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].path, PathBuf::from("note.md"));
        assert_eq!(status.changes[0].state, FileState::Untracked);
    }

    #[test]
    fn status_is_clean_after_commit() {
        let (_dir, repo, git) = fixture();
        write(&repo, "note.md", "# hello");
        git.commit(&repo, &[], "notes: add note").expect("commit");

        let status = git.status(&repo).expect("status");
        assert!(
            status.is_clean(),
            "unexpected changes: {:?}",
            status.changes
        );
        assert!(!status.has_conflicts());
    }

    #[test]
    fn status_reports_modified_tracked_files() {
        let (_dir, repo, git) = fixture();
        write(&repo, "note.md", "# hello");
        git.commit(&repo, &[], "notes: add note").expect("commit");
        write(&repo, "note.md", "# hello, edited");

        let status = git.status(&repo).expect("status");
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].state, FileState::Modified);
    }

    #[test]
    fn status_handles_paths_containing_spaces() {
        let (_dir, repo, git) = fixture();
        write(&repo, "my daily note.md", "# hello");

        let status = git.status(&repo).expect("status");
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].path, PathBuf::from("my daily note.md"));
    }

    #[test]
    fn commit_returns_the_new_head() {
        let (_dir, repo, git) = fixture();
        write(&repo, "note.md", "# hello");

        let id = git.commit(&repo, &[], "notes: add note").expect("commit");
        assert_eq!(id.0.len(), 40, "expected a full sha, got {}", id.0);

        let head = git.run_ok(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(id.0, head);
    }

    #[test]
    fn commit_with_nothing_staged_is_reported_distinctly() {
        let (_dir, repo, git) = fixture();
        write(&repo, "note.md", "# hello");
        git.commit(&repo, &[], "notes: add note").expect("commit");

        // The commit loop hits this constantly; it must not look like a failure.
        let err = git.commit(&repo, &[], "notes: nothing").unwrap_err();
        assert!(matches!(err, GitError::NothingToCommit), "got {err:?}");
    }

    #[test]
    fn commit_respects_gitignore() {
        let (_dir, repo, git) = fixture();
        write(&repo, ".gitignore", "secret.md\n");
        write(&repo, "note.md", "# hello");
        write(&repo, "secret.md", "# private");
        git.commit(&repo, &[], "notes: add").expect("commit");

        let tracked = git.run_ok(Some(&repo), &["ls-files"]).expect("ls-files");
        assert!(tracked.contains("note.md"));
        assert!(
            !tracked.contains("secret.md"),
            "ignored file was committed: {tracked}"
        );
    }

    #[test]
    fn commit_can_be_scoped_to_specific_paths() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "a");
        write(&repo, "b.md", "b");

        git.commit(&repo, &[PathBuf::from("a.md")], "notes: only a")
            .expect("commit");

        let tracked = git.run_ok(Some(&repo), &["ls-files"]).expect("ls-files");
        assert!(tracked.contains("a.md"));
        assert!(!tracked.contains("b.md"), "b.md should be unstaged");
    }

    #[test]
    fn parses_ahead_behind_counters() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0\
                   # branch.ab +2 -3\0";
        let (status, ab_known) = parse_status_v2(raw.as_bytes()).expect("parse");
        assert!(ab_known);
        assert_eq!(status.branch, "main");
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 3);
    }

    #[test]
    fn parses_unmerged_entries_as_conflicts() {
        let raw = "# branch.head main\0\
                   u UU N... 100644 100644 100644 100644 aaa bbb ccc note.md\0";
        let (status, _) = parse_status_v2(raw.as_bytes()).expect("parse");
        assert!(status.has_conflicts());
        assert_eq!(status.changes[0].path, PathBuf::from("note.md"));
    }

    /// A clone of `origin` plus the bare remote itself, so the full
    /// fetch/rebase/push path can be exercised without a network.
    fn cloned_fixture() -> (TempDir, PathBuf, PathBuf, SystemGit) {
        let dir = TempDir::new().expect("temp dir");
        let git = SystemGit::new();
        let origin = dir.path().join("origin.git");
        let work = dir.path().join("work");

        git.run_ok(
            None,
            &["init", "--bare", "-b", "main", origin.to_str().unwrap()],
        )
        .expect("init bare");
        git.run_ok(
            None,
            &["clone", origin.to_str().unwrap(), work.to_str().unwrap()],
        )
        .expect("clone");
        for args in [
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git.run_ok(Some(&work), &args).expect("config");
        }
        (dir, origin, work, git)
    }

    /// Simulate somebody else pushing, by committing through a second clone.
    fn push_from_a_second_clone(dir: &TempDir, origin: &Path, git: &SystemGit, name: &str) {
        let other = dir.path().join(format!("other-{name}"));
        git.run_ok(
            None,
            &["clone", origin.to_str().unwrap(), other.to_str().unwrap()],
        )
        .expect("clone");
        for args in [
            vec!["config", "user.email", "other@example.com"],
            vec!["config", "user.name", "Other"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git.run_ok(Some(&other), &args).expect("config");
        }
        write(&other, name, "from elsewhere");
        git.commit(&other, &[], "notes: remote change")
            .expect("commit");
        git.push(&other, "origin", "main").expect("push");
    }

    #[test]
    fn push_publishes_commits_to_the_remote() {
        let (_dir, origin, work, git) = cloned_fixture();
        write(&work, "note.md", "# hello");
        let id = git.commit(&work, &[], "notes: add note").expect("commit");

        git.push(&work, "origin", "main").expect("push");

        let remote_head = git
            .run_ok(Some(&origin), &["rev-parse", "main"])
            .expect("remote head");
        assert_eq!(remote_head, id.0);
    }

    #[test]
    fn status_tracks_upstream_and_ahead_count() {
        let (_dir, _origin, work, git) = cloned_fixture();
        write(&work, "seed.md", "seed");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        write(&work, "note.md", "# hello");
        git.commit(&work, &[], "notes: add note").expect("commit");

        let status = git.status(&work).expect("status");
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 0);
    }

    #[test]
    fn ahead_is_known_even_when_the_remote_is_still_empty() {
        // git omits branch.ab here because origin/main does not exist yet.
        let (_dir, _origin, work, git) = cloned_fixture();
        write(&work, "note.md", "# hello");
        git.commit(&work, &[], "notes: add note").expect("commit");

        let status = git.status(&work).expect("status");
        assert_eq!(
            status.ahead, 1,
            "unpushed commit must be visible to the user"
        );
    }

    #[test]
    fn fetch_counts_new_upstream_commits() {
        let (dir, origin, work, git) = cloned_fixture();
        write(&work, "seed.md", "seed");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        push_from_a_second_clone(&dir, &origin, &git, "remote.md");

        let outcome = git.fetch(&work, "origin").expect("fetch");
        assert_eq!(outcome.new_commits, 1);
    }

    #[test]
    fn fetch_with_no_upstream_work_reports_zero() {
        let (_dir, _origin, work, git) = cloned_fixture();
        write(&work, "seed.md", "seed");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        let outcome = git.fetch(&work, "origin").expect("fetch");
        assert_eq!(outcome.new_commits, 0);
    }

    #[test]
    fn pull_rebase_reports_up_to_date_when_nothing_changed() {
        let (_dir, _origin, work, git) = cloned_fixture();
        write(&work, "seed.md", "seed");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        let outcome = git.pull_rebase(&work).expect("pull");
        assert!(
            matches!(outcome, MergeOutcome::AlreadyUpToDate),
            "{outcome:?}"
        );
    }

    #[test]
    fn pull_rebase_integrates_remote_commits() {
        let (dir, origin, work, git) = cloned_fixture();
        write(&work, "seed.md", "seed");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        push_from_a_second_clone(&dir, &origin, &git, "remote.md");
        git.fetch(&work, "origin").expect("fetch");

        let outcome = git.pull_rebase(&work).expect("pull");
        assert!(
            matches!(outcome, MergeOutcome::Rebased { commits: 1 }),
            "{outcome:?}"
        );
        assert!(
            work.join("remote.md").exists(),
            "remote file not checked out"
        );
    }

    #[test]
    fn pull_rebase_reports_conflicts_instead_of_resolving_them() {
        let (dir, origin, work, git) = cloned_fixture();
        write(&work, "shared.md", "original\n");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        // Both sides edit the same line.
        let other = dir.path().join("other");
        git.run_ok(
            None,
            &["clone", origin.to_str().unwrap(), other.to_str().unwrap()],
        )
        .expect("clone");
        for args in [
            vec!["config", "user.email", "other@example.com"],
            vec!["config", "user.name", "Other"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git.run_ok(Some(&other), &args).expect("config");
        }
        write(&other, "shared.md", "theirs\n");
        git.commit(&other, &[], "notes: theirs").expect("commit");
        git.push(&other, "origin", "main").expect("push");

        write(&work, "shared.md", "ours\n");
        git.commit(&work, &[], "notes: ours").expect("commit");
        git.fetch(&work, "origin").expect("fetch");

        let outcome = git
            .pull_rebase(&work)
            .expect("pull should report, not fail");
        match outcome {
            MergeOutcome::Conflicted { paths } => {
                assert_eq!(paths, vec![PathBuf::from("shared.md")]);
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
    }

    #[test]
    fn list_files_includes_tracked_and_new_files() {
        let (_dir, repo, git) = fixture();
        write(&repo, "tracked.md", "a");
        git.commit(&repo, &[], "notes: seed").expect("commit");
        write(&repo, "brand-new.md", "b");

        let files = git.list_files(&repo).expect("list");
        assert!(files.contains(&PathBuf::from("tracked.md")));
        assert!(files.contains(&PathBuf::from("brand-new.md")));
    }

    #[test]
    fn list_files_excludes_ignored_paths() {
        let (_dir, repo, git) = fixture();
        write(&repo, ".gitignore", "node_modules/\nsecret.md\n");
        fs::create_dir_all(repo.join("node_modules/pkg")).expect("mkdir");
        write(&repo, "node_modules/pkg/index.js", "junk");
        write(&repo, "secret.md", "private");
        write(&repo, "note.md", "a");

        let files = git.list_files(&repo).expect("list");
        assert!(files.contains(&PathBuf::from("note.md")));
        assert!(
            !files.iter().any(|f| f.starts_with("node_modules")),
            "ignored dir leaked into the tree: {files:?}"
        );
        assert!(!files.contains(&PathBuf::from("secret.md")));
    }

    #[test]
    fn list_files_never_includes_the_git_directory() {
        let (_dir, repo, git) = fixture();
        write(&repo, "note.md", "a");
        let files = git.list_files(&repo).expect("list");
        assert!(!files.iter().any(|f| f.starts_with(".git")), "{files:?}");
    }

    /// Drive two clones into a genuine conflict on the same line.
    fn conflicted_fixture() -> (TempDir, PathBuf, SystemGit) {
        let (dir, origin, work, git) = cloned_fixture();
        write(&work, "shared.md", "original\n");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        let other = dir.path().join("other");
        git.run_ok(
            None,
            &["clone", origin.to_str().unwrap(), other.to_str().unwrap()],
        )
        .expect("clone");
        for args in [
            vec!["config", "user.email", "other@example.com"],
            vec!["config", "user.name", "Other"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git.run_ok(Some(&other), &args).expect("config");
        }
        write(&other, "shared.md", "theirs\n");
        git.commit(&other, &[], "notes: theirs").expect("commit");
        git.push(&other, "origin", "main").expect("push");

        write(&work, "shared.md", "mine\n");
        git.commit(&work, &[], "notes: mine").expect("commit");
        git.fetch(&work, "origin").expect("fetch");
        let outcome = git.pull_rebase(&work).expect("pull");
        assert!(
            matches!(outcome, MergeOutcome::Conflicted { .. }),
            "{outcome:?}"
        );
        (dir, work, git)
    }

    #[test]
    fn detects_an_in_progress_rebase() {
        let (_d, work, git) = conflicted_fixture();
        assert!(git.rebase_in_progress(&work));
    }

    #[test]
    fn keeping_my_side_preserves_my_text() {
        let (_d, work, git) = conflicted_fixture();
        git.resolve_with(&work, Path::new("shared.md"), ConflictSide::Mine)
            .expect("resolve");
        assert_eq!(
            fs::read_to_string(work.join("shared.md")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn keeping_their_side_preserves_the_remote_text() {
        let (_d, work, git) = conflicted_fixture();
        git.resolve_with(&work, Path::new("shared.md"), ConflictSide::Theirs)
            .expect("resolve");
        assert_eq!(
            fs::read_to_string(work.join("shared.md")).unwrap(),
            "theirs\n"
        );
    }

    #[test]
    fn continuing_the_rebase_after_resolution_finishes_it() {
        let (_d, work, git) = conflicted_fixture();
        git.resolve_with(&work, Path::new("shared.md"), ConflictSide::Mine)
            .expect("resolve");

        let outcome = git.rebase_continue(&work).expect("continue");
        assert!(
            !matches!(outcome, MergeOutcome::Conflicted { .. }),
            "{outcome:?}"
        );
        assert!(!git.rebase_in_progress(&work));
        assert!(git.status(&work).expect("status").is_clean());
    }

    #[test]
    fn aborting_the_rebase_restores_my_work() {
        let (_d, work, git) = conflicted_fixture();
        git.rebase_abort(&work).expect("abort");

        assert!(!git.rebase_in_progress(&work));
        // My commit is back, untouched.
        assert_eq!(
            fs::read_to_string(work.join("shared.md")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn a_hand_edited_resolution_can_be_staged_and_continued() {
        let (_d, work, git) = conflicted_fixture();
        // What the editor does: the user merges both by hand.
        write(&work, "shared.md", "mine and theirs\n");
        git.stage(&work, &[PathBuf::from("shared.md")])
            .expect("stage");

        let outcome = git.rebase_continue(&work).expect("continue");
        assert!(
            !matches!(outcome, MergeOutcome::Conflicted { .. }),
            "{outcome:?}"
        );
        assert_eq!(
            fs::read_to_string(work.join("shared.md")).unwrap(),
            "mine and theirs\n"
        );
    }

    #[test]
    fn continuing_with_conflicts_still_unresolved_reports_them_again() {
        let (_d, work, git) = conflicted_fixture();
        let outcome = git.rebase_continue(&work).expect("continue");
        assert!(
            matches!(outcome, MergeOutcome::Conflicted { .. }),
            "{outcome:?}"
        );
    }

    #[test]
    fn ignored_entries_are_not_surfaced() {
        let raw = "# branch.head main\0! ignored.md\0";
        let (status, _) = parse_status_v2(raw.as_bytes()).expect("parse");
        assert!(status.is_clean());
    }
}
