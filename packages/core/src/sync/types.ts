export type FileState = 'untracked' | 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted';

export interface FileChange {
  path: string;
  state: FileState;
}

export interface RepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: FileChange[];
}

export type MergeOutcome =
  | { kind: 'alreadyUpToDate' }
  | { kind: 'fastForwarded'; to: string }
  | { kind: 'rebased'; commits: number }
  | { kind: 'conflicted'; paths: string[] };

/**
 * Error codes the backend attaches to failures. The engine branches on these:
 * reacting to prose would break the moment a git version changed its wording.
 */
export type SyncErrorCode =
  | 'nothingToCommit'
  | 'pushRejected'
  | 'offline'
  | 'noUpstream'
  | 'conflicted'
  | 'gitNotFound'
  | 'gitFailed'
  | 'io';

export interface SyncError {
  code: SyncErrorCode | string;
  message: string;
}

export function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    return String((e as { code: unknown }).code);
  }
  return 'unknown';
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** The git operations the engine needs. Mirrors the Rust `GitPort` trait. */
export interface SyncPort {
  status(root: string): Promise<RepoStatus>;
  commit(root: string, message: string): Promise<string>;
  fetch(root: string, remote: string): Promise<{ newCommits: number }>;
  pullRebase(root: string): Promise<MergeOutcome>;
  push(root: string, remote: string, branch: string): Promise<void>;
}

/**
 * What the vault is doing right now. Shown to the user verbatim, so every state
 * the engine can be in must be one a person can act on.
 */
export type SyncPhase =
  | 'idle'
  | 'dirty'
  | 'committing'
  | 'pushing'
  | 'fetching'
  | 'behind'
  | 'conflict'
  | 'offline'
  | 'paused'
  | 'error';

export interface SyncState {
  phase: SyncPhase;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Paths git reports as conflicted. Non-empty only in the `conflict` phase. */
  conflicts: string[];
  lastError: SyncError | null;
  lastSyncedAt: number | null;
}
