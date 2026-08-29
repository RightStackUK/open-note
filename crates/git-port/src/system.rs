//! Adapter that shells out to the user's own `git` binary.
//!
//! Phase 0 implements discovery only ([`SystemGit::describe`] and
//! [`SystemGit::is_repository`]). Phase 1 fills in the rest.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::error::{GitError, Result};
use crate::types::{CommitId, FetchOutcome, MergeOutcome, RepoStatus};
use crate::GitPort;

#[derive(Debug, Clone)]
pub struct SystemGit {
    /// Path to the `git` executable. Defaults to resolving `git` on PATH.
    program: PathBuf,
}

impl Default for SystemGit {
    fn default() -> Self {
        Self { program: PathBuf::from("git") }
    }
}

impl SystemGit {
    pub fn new() -> Self {
        Self::default()
    }

    /// Use a specific `git` executable instead of resolving one on PATH.
    pub fn with_program(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into() }
    }

    fn run(&self, cwd: Option<&Path>, args: &[&str]) -> Result<Output> {
        let mut cmd = Command::new(&self.program);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // Keep git non-interactive: a hung credential or editor prompt would
        // block the sync engine invisibly.
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("GIT_OPTIONAL_LOCKS", "0");

        cmd.output().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => GitError::GitNotFound,
            _ => GitError::Io(e),
        })
    }

    fn run_ok(&self, cwd: Option<&Path>, args: &[&str]) -> Result<String> {
        let out = self.run(cwd, args)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(GitError::CommandFailed {
                command: args.join(" "),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            })
        }
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

    fn status(&self, _repo: &Path) -> Result<RepoStatus> {
        Err(GitError::Unsupported("status"))
    }

    fn commit(&self, _repo: &Path, _paths: &[PathBuf], _message: &str) -> Result<CommitId> {
        Err(GitError::Unsupported("commit"))
    }

    fn fetch(&self, _repo: &Path, _remote: &str) -> Result<FetchOutcome> {
        Err(GitError::Unsupported("fetch"))
    }

    fn pull_rebase(&self, _repo: &Path) -> Result<MergeOutcome> {
        Err(GitError::Unsupported("pull_rebase"))
    }

    fn push(&self, _repo: &Path, _remote: &str, _branch: &str) -> Result<()> {
        Err(GitError::Unsupported("push"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_reports_a_git_version() {
        let git = SystemGit::new();
        let version = git.describe().expect("a git binary is required to run the test suite");
        assert!(version.starts_with("git version"), "unexpected output: {version}");
    }

    #[test]
    fn missing_binary_reports_git_not_found() {
        let git = SystemGit::with_program("definitely-not-a-real-git-binary");
        assert!(matches!(git.describe(), Err(GitError::GitNotFound)));
    }

    #[test]
    fn detects_a_working_tree() {
        let git = SystemGit::new();
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(git.is_repository(here));
    }

    #[test]
    fn rejects_a_non_repository() {
        let git = SystemGit::new();
        assert!(!git.is_repository(Path::new("/")));
    }
}
