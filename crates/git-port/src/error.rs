use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, GitError>;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// No usable `git` binary was found on PATH.
    #[error("no usable git binary found on PATH")]
    GitNotFound,

    /// The path is not inside a Git working tree.
    #[error("{0} is not a git repository")]
    NotARepository(PathBuf),

    /// A `git` invocation exited non-zero.
    #[error("git {command} failed: {stderr}")]
    CommandFailed { command: String, stderr: String },

    /// The working tree has unresolved conflicts. Callers must surface this to the
    /// user rather than resolving it themselves — see the roadmap, §3.3.
    #[error("repository has unresolved conflicts in {} file(s)", .paths.len())]
    Conflicted { paths: Vec<PathBuf> },

    /// The remote rejected the push, typically because the branch moved upstream.
    #[error("push rejected: {0}")]
    PushRejected(String),

    #[error("network unavailable")]
    Offline,

    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// The active adapter does not implement this operation yet.
    #[error("{0} is not implemented by this adapter")]
    Unsupported(&'static str),
}
