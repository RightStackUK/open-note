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
    Branch, CommitId, CommitInfo, ConflictSide, FetchOutcome, FileChange, FileState, MergeOutcome,
    MergeResult, RepoStatus,
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

    fn ignored_directories(&self, repo: &Path) -> Result<Vec<PathBuf>> {
        // `--directory` collapses a wholly-ignored tree to its top entry, which
        // is exactly the prefix a caller needs in order to prune.
        let bytes = self.run_ok_bytes(
            Some(repo),
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
        )?;
        let text = String::from_utf8_lossy(&bytes);
        let mut dirs: Vec<PathBuf> = text
            .split('\0')
            .filter(|s| !s.is_empty())
            // Only directories; git marks them with a trailing slash.
            .filter_map(|s| s.strip_suffix('/'))
            .map(PathBuf::from)
            .collect();
        dirs.sort();
        dirs.dedup();
        Ok(dirs)
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

    fn is_tracked(&self, repo: &Path, path: &Path) -> Result<bool> {
        let path_str = path.to_string_lossy();
        // `ls-files --error-unmatch` exits non-zero for anything git does not
        // know about, which is exactly the question being asked.
        Ok(self
            .run_ok(
                Some(repo),
                &["ls-files", "--error-unmatch", "--", &path_str],
            )
            .is_ok())
    }

    fn remote_url(&self, repo: &Path, remote: &str) -> Result<Option<String>> {
        match self.run_ok(Some(repo), &["remote", "get-url", remote]) {
            Ok(url) if !url.is_empty() => Ok(Some(url)),
            Ok(_) => Ok(None),
            // A repo with no remote configured is a normal state, not a failure.
            Err(GitError::CommandFailed { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn clone_repository(&self, url: &str, dest: &Path) -> Result<()> {
        if dest.exists() {
            return Err(GitError::CommandFailed {
                command: "clone".into(),
                stderr: format!("{} already exists", dest.display()),
            });
        }
        let dest_str = dest.to_string_lossy();
        // The parent must exist for git to write into it.
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        self.run_ok(None, &["clone", url, &dest_str])?;
        Ok(())
    }

    fn branches(&self, repo: &Path) -> Result<Vec<Branch>> {
        // A custom format keeps parsing unambiguous; branch names may contain
        // slashes but never the separator used here.
        let out = self.run_ok(
            Some(repo),
            &[
                "for-each-ref",
                "--format=%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(refname)",
                "refs/heads",
                "refs/remotes",
            ],
        )?;

        let mut branches = Vec::new();
        for line in out.lines() {
            let mut parts = line.split('\x1f');
            let name = parts.next().unwrap_or_default().to_string();
            let head = parts.next().unwrap_or_default();
            let upstream = parts.next().unwrap_or_default();
            let full = parts.next().unwrap_or_default();
            // `refs/remotes/origin/HEAD` abbreviates to just `origin`, so the
            // symbolic default-branch pointer has to be filtered on its full
            // refname or it shows up as a branch called `origin`.
            if name.is_empty() || full.ends_with("/HEAD") {
                continue;
            }
            branches.push(Branch {
                is_current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                is_remote: full.starts_with("refs/remotes/"),
                name,
            });
        }
        Ok(branches)
    }

    fn create_branch(&self, repo: &Path, name: &str, start: Option<&str>) -> Result<()> {
        let mut args = vec!["switch", "--create", name];
        if let Some(start) = start {
            args.push(start);
        }
        self.run_ok(Some(repo), &args)?;
        Ok(())
    }

    fn switch_branch(&self, repo: &Path, name: &str) -> Result<()> {
        // No --force and no --discard-changes: switching must never be able to
        // throw away notes the user has not committed.
        self.run_ok(Some(repo), &["switch", name])?;
        Ok(())
    }

    fn merge_branch(&self, repo: &Path, name: &str) -> Result<MergeResult> {
        let before = self.run_ok(Some(repo), &["rev-parse", "HEAD"])?;

        match self.run_ok(Some(repo), &["merge", "--no-edit", name]) {
            Ok(_) => {}
            Err(GitError::CommandFailed { .. }) => {
                let paths = self.conflicted_paths(repo)?;
                if !paths.is_empty() {
                    return Ok(MergeResult::Conflicted { paths });
                }
                return Err(GitError::CommandFailed {
                    command: format!("merge {name}"),
                    stderr: "merge failed with no conflicted paths".into(),
                });
            }
            Err(e) => return Err(e),
        }

        let after = self.run_ok(Some(repo), &["rev-parse", "HEAD"])?;
        if before == after {
            return Ok(MergeResult::AlreadyUpToDate);
        }
        // A merge commit has two parents; a fast-forward does not.
        let parents = self
            .run_ok(Some(repo), &["rev-list", "--parents", "-n", "1", "HEAD"])
            .unwrap_or_default();
        let is_merge = parents.split_whitespace().count() > 2;
        let to = CommitId(after);
        Ok(if is_merge {
            MergeResult::Merged { to }
        } else {
            MergeResult::FastForwarded { to }
        })
    }

    fn delete_branch(&self, repo: &Path, name: &str, force: bool) -> Result<()> {
        // -d refuses to drop unmerged commits; -D is only reachable when the
        // user has explicitly confirmed.
        let flag = if force { "-D" } else { "-d" };
        self.run_ok(Some(repo), &["branch", flag, name])?;
        Ok(())
    }

    fn init_repository(&self, path: &Path) -> Result<()> {
        self.run_ok(Some(path), &["init", "-b", "main"])?;
        Ok(())
    }

    fn repo_root(&self, path: &Path) -> Result<PathBuf> {
        let out = self.run_ok(Some(path), &["rev-parse", "--show-toplevel"])?;
        Ok(PathBuf::from(out.trim()))
    }

    fn first_commit_dates(&self, repo: &Path) -> Result<std::collections::HashMap<String, u64>> {
        // Oldest first, so the first time a path appears is the record kept —
        // a plain insert-if-absent, no comparisons. `--diff-filter=A` limits
        // the name lists to additions, so a touch or a delete never counts.
        //
        // `core.quotepath=false` because the default octal-escapes any
        // non-ASCII path — `café.md` would never match its real name and would
        // quietly fall back to its mtime. `--no-renames` because with rename
        // detection on, a moved file is an `R` rather than an `A` and would
        // otherwise get no created date at all; forcing the add keeps the
        // documented rule — a rename starts a new history — true regardless of
        // the user's git config.
        let out = self.run_ok(
            Some(repo),
            &[
                "-c",
                "core.quotepath=false",
                "log",
                "--reverse",
                "--no-renames",
                "--diff-filter=A",
                "--name-only",
                "--format=\x01%at",
            ],
        )?;

        let mut dates = std::collections::HashMap::new();
        let mut current: u64 = 0;
        for line in out.lines() {
            if let Some(stamp) = line.strip_prefix('\x01') {
                current = stamp.trim().parse().unwrap_or(0);
                continue;
            }
            // Not trimmed: a leading or trailing space is part of the name.
            let path = line.strip_suffix('\r').unwrap_or(line);
            if path.is_empty() || current == 0 {
                continue;
            }
            dates.entry(path.to_string()).or_insert(current);
        }
        Ok(dates)
    }

    fn log_for_path(&self, repo: &Path, path: &Path, limit: u32) -> Result<Vec<CommitInfo>> {
        let limit = limit.to_string();
        let path_str = path.to_string_lossy();
        let out = self.run_ok(
            Some(repo),
            &[
                "log",
                "--max-count",
                &limit,
                "--format=%H\x1f%h\x1f%an\x1f%aI\x1f%s",
                "--follow",
                "--",
                &path_str,
            ],
        )?;

        Ok(out
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\x1f');
                Some(CommitInfo {
                    id: parts.next()?.to_string(),
                    short_id: parts.next()?.to_string(),
                    author: parts.next()?.to_string(),
                    date: parts.next()?.to_string(),
                    subject: parts.next().unwrap_or_default().to_string(),
                })
            })
            .collect())
    }

    fn file_at_commit(&self, repo: &Path, commit: &str, path: &Path) -> Result<String> {
        let spec = format!("{commit}:{}", path.to_string_lossy());
        self.run_ok(Some(repo), &["show", &spec])
    }

    fn diff_file(&self, repo: &Path, from: &str, to: Option<&str>, path: &Path) -> Result<String> {
        let path_str = path.to_string_lossy();
        let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", from];
        if let Some(to) = to {
            args.push(to);
        }
        args.push("--");
        args.push(&path_str);
        self.run_ok(Some(repo), &args)
    }

    fn discard_file(&self, repo: &Path, path: &Path) -> Result<()> {
        let path_str = path.to_string_lossy();
        self.run_ok(
            Some(repo),
            &["restore", "--staged", "--worktree", "--", &path_str],
        )?;
        Ok(())
    }

    fn restore_file(&self, repo: &Path, commit: &str, path: &Path) -> Result<()> {
        let path_str = path.to_string_lossy();
        // Working tree only, so the change is reviewable before it is committed.
        self.run_ok(
            Some(repo),
            &["restore", "--source", commit, "--", &path_str],
        )?;
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
    fn first_commit_dates_report_when_each_path_was_added() {
        let (_dir, repo, git) = fixture();

        write(&repo, "first.md", "one");
        git.run_ok(Some(&repo), &["add", "-A"]).expect("add");
        git.run_ok(
            Some(&repo),
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "--date",
                "2020-01-02T03:04:05Z",
                "-m",
                "first",
            ],
        )
        .expect("commit");

        write(&repo, "second.md", "two");
        // Touch the first file too: an edit must not move its created date.
        write(&repo, "first.md", "one, edited");
        git.run_ok(Some(&repo), &["add", "-A"]).expect("add");
        git.run_ok(
            Some(&repo),
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "--date",
                "2021-06-07T08:09:10Z",
                "-m",
                "second",
            ],
        )
        .expect("commit");

        let dates = git.first_commit_dates(&repo).expect("dates");
        let first = *dates.get("first.md").expect("first.md");
        let second = *dates.get("second.md").expect("second.md");
        assert!(
            first < second,
            "edit moved the created date: {first} {second}"
        );
        // 2020-01-02T03:04:05Z, whatever this machine's timezone says.
        assert_eq!(first, 1_577_934_245);
    }

    #[test]
    fn first_commit_dates_keep_non_ascii_names_literal() {
        // Default quotepath octal-escapes these, and an escaped key matches
        // nothing the frontend asks about.
        let (_dir, repo, git) = fixture();
        write(&repo, "café.md", "x");
        git.run_ok(Some(&repo), &["add", "-A"]).expect("add");
        git.run_ok(Some(&repo), &["commit", "-m", "add"])
            .expect("commit");

        let dates = git.first_commit_dates(&repo).expect("dates");
        assert!(dates.contains_key("café.md"), "got: {:?}", dates.keys());
    }

    #[test]
    fn a_renamed_file_gets_a_created_date_for_its_new_path() {
        // With rename detection on, `git mv` is an R, not an A — and the new
        // path would silently have no created date. --no-renames forces the A.
        let (_dir, repo, git) = fixture();
        write(&repo, "old.md", "body");
        git.run_ok(Some(&repo), &["add", "-A"]).expect("add");
        git.run_ok(Some(&repo), &["commit", "-m", "add"])
            .expect("commit");
        git.run_ok(Some(&repo), &["mv", "old.md", "new.md"])
            .expect("mv");
        git.run_ok(Some(&repo), &["commit", "-m", "rename"])
            .expect("commit");

        let dates = git.first_commit_dates(&repo).expect("dates");
        assert!(dates.contains_key("new.md"), "got: {:?}", dates.keys());
    }

    #[test]
    fn first_commit_dates_error_on_a_repo_with_no_commits() {
        // `git log` refuses an unborn branch. The command layer above maps
        // this to an empty map, because "no history yet" is not a failure.
        let (_dir, repo, git) = fixture();
        assert!(git.first_commit_dates(&repo).is_err());
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
    fn ignored_directories_reports_the_top_of_each_ignored_tree() {
        let (_dir, repo, git) = fixture();
        write(&repo, ".gitignore", "node_modules/\nbuild/\n");
        fs::create_dir_all(repo.join("node_modules/pkg")).expect("mkdir");
        write(&repo, "node_modules/pkg/index.js", "junk");
        fs::create_dir_all(repo.join("build/out")).expect("mkdir");
        write(&repo, "build/out/app.js", "junk");
        write(&repo, "notes.md", "keep");

        let dirs = git.ignored_directories(&repo).expect("ignored dirs");
        assert!(dirs.contains(&PathBuf::from("node_modules")));
        assert!(dirs.contains(&PathBuf::from("build")));
        // Collapsed at the top: a caller pruning on these never descends.
        assert!(!dirs.contains(&PathBuf::from("node_modules/pkg")));
    }

    #[test]
    fn ignored_directories_is_empty_when_nothing_is_ignored() {
        let (_dir, repo, git) = fixture();
        write(&repo, "notes.md", "keep");
        assert!(git
            .ignored_directories(&repo)
            .expect("ignored dirs")
            .is_empty());
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
    fn knows_whether_a_path_is_tracked() {
        // The difference decides whether a delete is recoverable.
        let (_dir, repo, git) = fixture();
        write(&repo, "committed.md", "a");
        git.commit(&repo, &[], "notes: seed").expect("commit");
        write(&repo, "brand-new.md", "b");

        assert!(git.is_tracked(&repo, Path::new("committed.md")).unwrap());
        assert!(!git.is_tracked(&repo, Path::new("brand-new.md")).unwrap());
        assert!(!git.is_tracked(&repo, Path::new("absent.md")).unwrap());
    }

    #[test]
    fn reads_the_remote_url() {
        let (_dir, origin, work, git) = cloned_fixture();
        let url = git
            .remote_url(&work, "origin")
            .expect("remote")
            .expect("some");
        assert!(url.contains(origin.to_str().unwrap()), "got {url}");
    }

    #[test]
    fn a_repo_with_no_remote_reports_none() {
        let (_dir, repo, git) = fixture();
        assert_eq!(git.remote_url(&repo, "origin").expect("remote"), None);
    }

    #[test]
    fn clones_a_repository() {
        let (dir, _origin, work, git) = cloned_fixture();
        write(&work, "note.md", "# hello");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");

        let source = git.remote_url(&work, "origin").unwrap().unwrap();
        let dest = dir.path().join("fresh-clone");
        git.clone_repository(&source, &dest).expect("clone");

        assert!(git.is_repository(&dest));
        assert_eq!(fs::read_to_string(dest.join("note.md")).unwrap(), "# hello");
    }

    #[test]
    fn refuses_to_clone_over_an_existing_directory() {
        let (dir, _origin, work, git) = cloned_fixture();
        let source = git.remote_url(&work, "origin").unwrap().unwrap();
        let dest = dir.path().join("occupied");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("important.md"), "do not clobber").unwrap();

        assert!(git.clone_repository(&source, &dest).is_err());
        assert_eq!(
            fs::read_to_string(dest.join("important.md")).unwrap(),
            "do not clobber"
        );
    }

    // -- branches ----------------------------------------------------------

    #[test]
    fn lists_the_current_branch() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "a");
        git.commit(&repo, &[], "notes: seed").expect("commit");

        let branches = git.branches(&repo).expect("branches");
        let main = branches.iter().find(|b| b.name == "main").expect("main");
        assert!(main.is_current);
        assert!(!main.is_remote);
    }

    #[test]
    fn the_remote_head_pointer_is_not_listed_as_a_branch() {
        // refs/remotes/origin/HEAD abbreviates to "origin", which is not a branch.
        let (_dir, _origin, work, git) = cloned_fixture();
        write(&work, "a.md", "a");
        git.commit(&work, &[], "notes: seed").expect("commit");
        git.push(&work, "origin", "main").expect("push");
        git.run_ok(Some(&work), &["remote", "set-head", "origin", "--auto"])
            .expect("set-head");

        let branches = git.branches(&work).expect("branches");
        assert!(
            !branches.iter().any(|b| b.name == "origin"),
            "remote HEAD leaked into the branch list: {:?}",
            branches.iter().map(|b| &b.name).collect::<Vec<_>>()
        );
        assert!(branches.iter().any(|b| b.name == "origin/main"));
    }

    #[test]
    fn creates_and_switches_to_a_branch() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "a");
        git.commit(&repo, &[], "notes: seed").expect("commit");

        git.create_branch(&repo, "feature", None).expect("create");
        let branches = git.branches(&repo).expect("branches");
        assert!(branches.iter().any(|b| b.name == "feature" && b.is_current));
    }

    #[test]
    fn switches_between_existing_branches() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "a");
        git.commit(&repo, &[], "notes: seed").expect("commit");
        git.create_branch(&repo, "feature", None).expect("create");

        git.switch_branch(&repo, "main").expect("switch");
        assert_eq!(git.status(&repo).expect("status").branch, "main");
    }

    #[test]
    fn refuses_to_switch_away_from_uncommitted_work_it_would_clobber() {
        // Losing an uncommitted note to a branch switch is exactly the kind of
        // silent loss the app must never cause.
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "original");
        git.commit(&repo, &[], "notes: seed").expect("commit");
        git.create_branch(&repo, "feature", None).expect("create");
        write(&repo, "a.md", "feature version");
        git.commit(&repo, &[], "notes: feature").expect("commit");

        git.switch_branch(&repo, "main").expect("switch back");
        write(&repo, "a.md", "uncommitted edit");

        assert!(git.switch_branch(&repo, "feature").is_err());
        assert_eq!(
            fs::read_to_string(repo.join("a.md")).unwrap(),
            "uncommitted edit"
        );
    }

    #[test]
    fn branches_from_an_explicit_start_point() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "one");
        git.commit(&repo, &[], "notes: one").expect("commit");
        let first = git.run_ok(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        write(&repo, "a.md", "two");
        git.commit(&repo, &[], "notes: two").expect("commit");

        git.create_branch(&repo, "from-first", Some(&first))
            .expect("create");
        assert_eq!(fs::read_to_string(repo.join("a.md")).unwrap(), "one");
    }

    #[test]
    fn merges_a_branch_by_fast_forward() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "base");
        git.commit(&repo, &[], "notes: base").expect("commit");
        git.create_branch(&repo, "feature", None).expect("create");
        write(&repo, "b.md", "new");
        git.commit(&repo, &[], "notes: feature").expect("commit");
        git.switch_branch(&repo, "main").expect("switch");

        let result = git.merge_branch(&repo, "feature").expect("merge");
        assert!(
            matches!(result, MergeResult::FastForwarded { .. }),
            "{result:?}"
        );
        assert!(repo.join("b.md").exists());
    }

    #[test]
    fn merging_an_ancestor_reports_up_to_date() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "base");
        git.commit(&repo, &[], "notes: base").expect("commit");
        git.create_branch(&repo, "feature", None).expect("create");
        git.switch_branch(&repo, "main").expect("switch");

        let result = git.merge_branch(&repo, "feature").expect("merge");
        assert!(matches!(result, MergeResult::AlreadyUpToDate), "{result:?}");
    }

    #[test]
    fn a_conflicting_merge_is_reported_not_resolved() {
        let (_dir, repo, git) = fixture();
        write(&repo, "shared.md", "base\n");
        git.commit(&repo, &[], "notes: base").expect("commit");

        git.create_branch(&repo, "feature", None).expect("create");
        write(&repo, "shared.md", "feature\n");
        git.commit(&repo, &[], "notes: feature").expect("commit");

        git.switch_branch(&repo, "main").expect("switch");
        write(&repo, "shared.md", "main\n");
        git.commit(&repo, &[], "notes: main").expect("commit");

        let result = git.merge_branch(&repo, "feature").expect("merge reports");
        match result {
            MergeResult::Conflicted { paths } => {
                assert_eq!(paths, vec![PathBuf::from("shared.md")]);
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
    }

    #[test]
    fn refuses_to_delete_a_branch_with_unmerged_work() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "base");
        git.commit(&repo, &[], "notes: base").expect("commit");
        git.create_branch(&repo, "feature", None).expect("create");
        write(&repo, "b.md", "only here");
        git.commit(&repo, &[], "notes: feature").expect("commit");
        git.switch_branch(&repo, "main").expect("switch");

        assert!(git.delete_branch(&repo, "feature", false).is_err());
        assert!(git.delete_branch(&repo, "feature", true).is_ok());
    }

    // -- history -----------------------------------------------------------

    #[test]
    fn logs_only_commits_touching_a_path() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "one");
        git.commit(&repo, &[], "notes: a first").expect("commit");
        write(&repo, "b.md", "unrelated");
        git.commit(&repo, &[], "notes: b").expect("commit");
        write(&repo, "a.md", "two");
        git.commit(&repo, &[], "notes: a second").expect("commit");

        let log = git.log_for_path(&repo, Path::new("a.md"), 10).expect("log");
        assert_eq!(log.len(), 2);
        // Newest first.
        assert_eq!(log[0].subject, "notes: a second");
        assert_eq!(log[1].subject, "notes: a first");
        assert_eq!(log[0].author, "Test");
        assert_eq!(log[0].short_id.len(), 7);
    }

    #[test]
    fn honours_the_log_limit() {
        let (_dir, repo, git) = fixture();
        for i in 0..5 {
            write(&repo, "a.md", &format!("v{i}"));
            git.commit(&repo, &[], &format!("notes: v{i}"))
                .expect("commit");
        }
        assert_eq!(
            git.log_for_path(&repo, Path::new("a.md"), 2).unwrap().len(),
            2
        );
    }

    #[test]
    fn history_is_empty_for_an_uncommitted_file() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "x");
        git.commit(&repo, &[], "notes: seed").expect("commit");
        write(&repo, "new.md", "never committed");

        assert!(git
            .log_for_path(&repo, Path::new("new.md"), 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reads_a_file_as_it_was_at_a_commit() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "first");
        git.commit(&repo, &[], "notes: first").expect("commit");
        let first = git.run_ok(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        write(&repo, "a.md", "second");
        git.commit(&repo, &[], "notes: second").expect("commit");

        assert_eq!(
            git.file_at_commit(&repo, &first, Path::new("a.md"))
                .unwrap(),
            "first"
        );
    }

    #[test]
    fn diffs_a_file_between_commits() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "first\n");
        git.commit(&repo, &[], "notes: first").expect("commit");
        let first = git.run_ok(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        write(&repo, "a.md", "second\n");
        git.commit(&repo, &[], "notes: second").expect("commit");
        let second = git.run_ok(Some(&repo), &["rev-parse", "HEAD"]).unwrap();

        let diff = git
            .diff_file(&repo, &first, Some(&second), Path::new("a.md"))
            .expect("diff");
        assert!(diff.contains("-first"), "{diff}");
        assert!(diff.contains("+second"), "{diff}");
    }

    #[test]
    fn diffs_a_commit_against_the_working_tree() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "committed\n");
        git.commit(&repo, &[], "notes: seed").expect("commit");
        let head = git.run_ok(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        write(&repo, "a.md", "edited\n");

        let diff = git
            .diff_file(&repo, &head, None, Path::new("a.md"))
            .expect("diff");
        assert!(diff.contains("+edited"), "{diff}");
    }

    // -- restoring ----------------------------------------------------------

    #[test]
    fn discards_uncommitted_changes_to_one_file() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "committed");
        write(&repo, "b.md", "also committed");
        git.commit(&repo, &[], "notes: seed").expect("commit");
        write(&repo, "a.md", "edited");
        write(&repo, "b.md", "edited too");

        git.discard_file(&repo, Path::new("a.md")).expect("discard");

        assert_eq!(fs::read_to_string(repo.join("a.md")).unwrap(), "committed");
        // Only the named file is touched.
        assert_eq!(fs::read_to_string(repo.join("b.md")).unwrap(), "edited too");
    }

    #[test]
    fn restores_a_file_from_an_older_commit_without_committing_it() {
        let (_dir, repo, git) = fixture();
        write(&repo, "a.md", "first");
        git.commit(&repo, &[], "notes: first").expect("commit");
        let first = git.run_ok(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        write(&repo, "a.md", "second");
        git.commit(&repo, &[], "notes: second").expect("commit");

        git.restore_file(&repo, &first, Path::new("a.md"))
            .expect("restore");

        assert_eq!(fs::read_to_string(repo.join("a.md")).unwrap(), "first");
        // Left as a reviewable working-tree change, not a commit.
        assert!(!git.status(&repo).expect("status").is_clean());
    }

    #[test]
    fn ignored_entries_are_not_surfaced() {
        let raw = "# branch.head main\0! ignored.md\0";
        let (status, _) = parse_status_v2(raw.as_bytes()).expect("parse");
        assert!(status.is_clean());
    }
}
