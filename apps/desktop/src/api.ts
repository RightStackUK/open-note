import { invoke } from '@tauri-apps/api/core';

export type FileKind = 'markdown' | 'image' | 'other';

export interface VaultFile {
  path: string;
  name: string;
  kind: FileKind;
  size: number;
}

export interface VaultInfo {
  root: string;
  name: string;
  branch: string;
  upstream: string | null;
}

export type FileState = 'untracked' | 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted';

export interface RepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; state: FileState }>;
}

export type MergeOutcome =
  | { kind: 'alreadyUpToDate' }
  | { kind: 'fastForwarded'; to: string }
  | { kind: 'rebased'; commits: number }
  | { kind: 'conflicted'; paths: string[] };

export interface SyncReport {
  committed: boolean;
  pulled: MergeOutcome | null;
  pushed: boolean;
  /** Set when sync stopped early — a conflict, or a missing upstream. */
  blocked: string | null;
  status: RepoStatus;
}

export type ConflictSide = 'mine' | 'theirs';

export const api = {
  gitProbe: () => invoke<string | null>('git_probe'),
  pickVault: () => invoke<string | null>('pick_vault'),
  openVault: (root: string) => invoke<VaultInfo>('open_vault', { root }),
  recentVaults: () => invoke<string[]>('recent_vaults'),
  forgetVault: (root: string) => invoke<void>('forget_vault', { root }),
  listFiles: (root: string) => invoke<VaultFile[]>('list_vault_files', { root }),
  readNote: (root: string, path: string) => invoke<string>('read_note', { root, path }),
  writeNote: (root: string, path: string, contents: string) =>
    invoke<void>('write_note', { root, path, contents }),
  readImage: (root: string, path: string) => invoke<string>('read_image', { root, path }),
  status: (root: string) => invoke<RepoStatus>('vault_status', { root }),
  sync: (root: string) => invoke<SyncReport>('sync_vault', { root }),

  // Granular operations the sync engine drives.
  commit: (root: string, message: string) => invoke<string>('vault_commit', { root, message }),
  fetch: (root: string, remote: string) =>
    invoke<{ newCommits: number }>('vault_fetch', { root, remote }),
  pullRebase: (root: string) => invoke<MergeOutcome>('vault_pull_rebase', { root }),
  push: (root: string, remote: string, branch: string) =>
    invoke<void>('vault_push', { root, remote, branch }),

  // Conflict resolution.
  resolveConflict: (root: string, path: string, side: ConflictSide) =>
    invoke<void>('resolve_conflict', { root, path, side }),
  stageResolution: (root: string, path: string) => invoke<void>('stage_resolution', { root, path }),
  rebaseContinue: (root: string) => invoke<MergeOutcome>('rebase_continue', { root }),
  rebaseAbort: (root: string) => invoke<void>('rebase_abort', { root }),
  rebaseInProgress: (root: string) => invoke<boolean>('rebase_in_progress', { root }),
  readRaw: (root: string, path: string) => invoke<string>('read_raw', { root, path }),

  // Per-vault settings, stored in .opennote/settings.json.
  readSettings: (root: string) => invoke<string | null>('read_vault_settings', { root }),
  writeSettings: (root: string, json: string) =>
    invoke<void>('write_vault_settings', { root, json }),
};

/** Binds the Tauri commands to the shape the sync engine expects. */
export function createSyncPort(): import('@open-note/core').SyncPort {
  return {
    status: (root) => api.status(root),
    commit: (root, message) => api.commit(root, message),
    fetch: (root, remote) => api.fetch(root, remote),
    pullRebase: (root) => api.pullRebase(root),
    push: (root, remote, branch) => api.push(root, remote, branch),
  };
}
