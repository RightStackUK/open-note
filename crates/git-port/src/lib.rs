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
pub use types::*;

pub trait GitPort: Send + Sync {
    /// Human-readable identity of the backing implementation, e.g. `"git 2.50.1"`.
    fn describe(&self) -> Result<String>;

    /// Whether `path` is inside a Git working tree.
    fn is_repository(&self, path: &Path) -> bool;

    fn status(&self, repo: &Path) -> Result<RepoStatus>;

    /// Stage `paths` and create a commit. An empty `paths` stages everything the
    /// vault owns (respecting `.gitignore`).
    fn commit(&self, repo: &Path, paths: &[PathBuf], message: &str) -> Result<CommitId>;

    fn fetch(&self, repo: &Path, remote: &str) -> Result<FetchOutcome>;

    /// Integrate upstream commits via rebase with autostash.
    fn pull_rebase(&self, repo: &Path) -> Result<MergeOutcome>;

    /// Push `branch` to `remote`. Implementations must never force-push.
    fn push(&self, repo: &Path, remote: &str, branch: &str) -> Result<()>;
}
