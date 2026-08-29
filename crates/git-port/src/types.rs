use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A 40-character hex commit hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Untracked,
    Modified,
    Added,
    Deleted,
    Renamed,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: PathBuf,
    pub state: FileState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: String,
    /// `None` when the branch has no configured upstream.
    pub upstream: Option<String>,
    /// Commits the local branch is ahead of its upstream.
    pub ahead: u32,
    /// Commits the local branch is behind its upstream.
    pub behind: u32,
    pub changes: Vec<FileChange>,
}

impl RepoStatus {
    pub fn is_clean(&self) -> bool {
        self.changes.is_empty()
    }

    pub fn has_conflicts(&self) -> bool {
        self.changes.iter().any(|c| c.state == FileState::Conflicted)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchOutcome {
    /// New commits available on the upstream branch.
    pub new_commits: u32,
}

/// The result of integrating upstream work. Conflicts are reported, never resolved:
/// the sync engine parks the vault and asks the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MergeOutcome {
    AlreadyUpToDate,
    FastForwarded { to: CommitId },
    Rebased { commits: u32 },
    Conflicted { paths: Vec<PathBuf> },
}
