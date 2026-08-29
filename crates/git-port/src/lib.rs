//! Git access abstraction for Open Note.
//!
//! Every Git operation in the app goes through [`GitPort`]. Nothing calls `git`
//! or a Git library directly. That indirection exists for one reason: desktop and
//! mobile need fundamentally different implementations.
//!
//! - [`system::SystemGit`] shells out to the user's own `git` binary. This is the
//!   desktop default, and it is what makes credential helpers, `ssh-agent`, commit
//!   signing, proxies and `git-lfs` work without us reimplementing any of them.
//! - `LibGit2Adapter` (Phase 7) will use `git2-rs` on mobile, where there is no
//!   shell and no `git` binary to call.

pub mod error;
pub mod system;
pub mod types;

use std::path::{Path, PathBuf};

pub use error::{GitError, Result};
pub use system::SystemGit;
pub use types::*;

pub trait GitPort: Send + Sync {
    /// Human-readable identity of the backing implementation, e.g. `"git 2.50.1"`.
    fn describe(&self) -> Result<String>;

    /// Whether `path` is inside a Git working tree.
    fn is_repository(&self, path: &Path) -> bool;

    fn status(&self, repo: &Path) -> Result<RepoStatus>;

    /// Every file the vault owns: tracked files plus untracked ones that are not
    /// ignored. Delegating this to git means `.gitignore` is honoured for free,
    /// so we never walk `node_modules` or `target`.
    fn list_files(&self, repo: &Path) -> Result<Vec<PathBuf>>;

    /// Stage `paths` and create a commit. An empty `paths` stages everything the
    /// vault owns (respecting `.gitignore`).
    fn commit(&self, repo: &Path, paths: &[PathBuf], message: &str) -> Result<CommitId>;

    fn fetch(&self, repo: &Path, remote: &str) -> Result<FetchOutcome>;

    /// Integrate upstream commits via rebase with autostash.
    fn pull_rebase(&self, repo: &Path) -> Result<MergeOutcome>;

    /// Push `branch` to `remote`. Implementations must never force-push.
    fn push(&self, repo: &Path, remote: &str, branch: &str) -> Result<()>;

    /// Resolve a conflicted path by taking one side wholesale.
    ///
    /// Mid-rebase the sides are inverted relative to intuition: "ours" is the
    /// upstream work being replayed onto, and "theirs" is the user's own commit.
    /// [`ConflictSide`] is named from the user's point of view and the adapter
    /// does the translation, so callers never have to think about it.
    fn resolve_with(&self, repo: &Path, path: &Path, side: ConflictSide) -> Result<()>;

    /// Stage paths, marking them resolved.
    fn stage(&self, repo: &Path, paths: &[PathBuf]) -> Result<()>;

    /// Continue an in-progress rebase once conflicts are staged.
    fn rebase_continue(&self, repo: &Path) -> Result<MergeOutcome>;

    /// Abandon an in-progress rebase, returning the vault to where it was.
    fn rebase_abort(&self, repo: &Path) -> Result<()>;

    /// Whether a rebase is currently in progress.
    fn rebase_in_progress(&self, repo: &Path) -> bool;
}
