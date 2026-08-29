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
};
