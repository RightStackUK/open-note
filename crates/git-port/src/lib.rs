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

    /// The top level of the working tree `path` is inside.
    ///
    /// The vault is the whole repository, so the CLI's cwd discovery climbs to
    /// this rather than opening whatever subdirectory the shell happens to be in.
    fn repo_root(&self, path: &Path) -> Result<PathBuf>;

    fn status(&self, repo: &Path) -> Result<RepoStatus>;

    /// Every file the vault owns: tracked files plus untracked ones that are not
    /// ignored. Delegating this to git means `.gitignore` is honoured for free,
    /// so we never walk `node_modules` or `target`.
    fn list_files(&self, repo: &Path) -> Result<Vec<PathBuf>>;

    /// Directories `.gitignore` excludes, collapsed at their topmost level.
    ///
    /// Git cannot store an empty directory, so listing folders means walking the
    /// filesystem — and a vault may be any repository, including one with a
    /// `node_modules`. These prefixes are what lets that walk stop at the top of
    /// an ignored tree instead of descending into it.
    fn ignored_directories(&self, repo: &Path) -> Result<Vec<PathBuf>>;

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

    // -- branches ----------------------------------------------------------

    /// Whether git tracks this path — that is, whether it exists in a commit.
    ///
    /// The difference matters before a delete: a tracked note is recoverable
    /// from history, an untracked one is gone for good.
    fn is_tracked(&self, repo: &Path, path: &Path) -> Result<bool>;

    /// The configured URL for a remote, if it has one.
    fn remote_url(&self, repo: &Path, remote: &str) -> Result<Option<String>>;

    /// Clone `url` into `dest`, which must not already exist.
    ///
    /// Named `clone_repository`: both `clone` and `clone_into` collide with std
    /// trait methods (`Clone::clone`, `ToOwned::clone_into`) at every call site.
    fn clone_repository(&self, url: &str, dest: &Path) -> Result<()>;

    /// Local branches, plus remote-tracking ones.
    fn branches(&self, repo: &Path) -> Result<Vec<Branch>>;

    /// Create a branch and switch to it. `start` defaults to the current HEAD.
    fn create_branch(&self, repo: &Path, name: &str, start: Option<&str>) -> Result<()>;

    /// Switch branches. Fails rather than discarding uncommitted work.
    fn switch_branch(&self, repo: &Path, name: &str) -> Result<()>;

    /// Merge `name` into the current branch, reporting conflicts rather than
    /// resolving them.
    fn merge_branch(&self, repo: &Path, name: &str) -> Result<MergeResult>;

    /// Delete a local branch. Refuses to drop unmerged work unless `force`.
    fn delete_branch(&self, repo: &Path, name: &str, force: bool) -> Result<()>;

    // -- history -----------------------------------------------------------

    /// Commits touching `path`, newest first.
    fn log_for_path(&self, repo: &Path, path: &Path, limit: u32) -> Result<Vec<CommitInfo>>;

    /// Turn an ordinary folder into a repository, on a `main` branch.
    ///
    /// The cheap half of importing: a directory of `.md` files from any other
    /// Markdown app becomes a vault with `git init` and a first commit.
    fn init_repository(&self, path: &Path) -> Result<()>;

    /// For every path in history: the author time, in epoch seconds, of the
    /// first commit that added it.
    ///
    /// This is what the app calls a note's *created* date. The filesystem's
    /// creation time is neither portable nor preserved by a clone; the first
    /// commit is the only definition that survives moving machines, which is
    /// the case that matters. One walk over the whole history rather than a
    /// `git log --follow` per file, because a vault has thousands of files and
    /// follow is quadratic in practice. A rename therefore starts a new
    /// history for the new path — documented behaviour, not an oversight.
    fn first_commit_dates(&self, repo: &Path) -> Result<std::collections::HashMap<String, u64>>;

    /// A file's contents at a given commit.
    fn file_at_commit(&self, repo: &Path, commit: &str, path: &Path) -> Result<String>;

    /// Unified diff of `path` between two commits. `to` of `None` means the
    /// working tree.
    fn diff_file(&self, repo: &Path, from: &str, to: Option<&str>, path: &Path) -> Result<String>;

    // -- restoring ---------------------------------------------------------

    /// Throw away uncommitted changes to a file. Destructive, so it is only
    /// ever called from an explicit user action.
    fn discard_file(&self, repo: &Path, path: &Path) -> Result<()>;

    /// Put a file back to how it was at `commit`, as a working-tree change the
    /// user can still review before it is committed.
    fn restore_file(&self, repo: &Path, commit: &str, path: &Path) -> Result<()>;
}
