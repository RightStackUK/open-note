import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export type FileKind = 'markdown' | 'image' | 'drawing' | 'text' | 'other' | 'folder';

export interface VaultFile {
  path: string;
  name: string;
  kind: FileKind;
  size: number;
  /** Last modified, seconds since the epoch; 0 when unknown. */
  modified: number;
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

export interface Branch {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  isRemote: boolean;
}

export interface CommitInfo {
  id: string;
  shortId: string;
  author: string;
  date: string;
  subject: string;
}

export type MergeResult =
  | { kind: 'alreadyUpToDate' }
  | { kind: 'fastForwarded'; to: string }
  | { kind: 'merged'; to: string }
  | { kind: 'conflicted'; paths: string[] };

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
  readDrawing: (root: string, path: string) => invoke<string>('read_drawing', { root, path }),
  writeDrawing: (root: string, path: string, contents: string) =>
    invoke<void>('write_drawing', { root, path, contents }),
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

  /** Ask where to export; resolves to null if the user cancelled. */
  pickExportPath: (suggested: string) => invoke<string | null>('pick_export_path', { suggested }),
  writeExport: (path: string, contents: string) => invoke<void>('write_export', { path, contents }),

  /** Store a pasted attachment; resolves to its vault-relative path. */
  writeAttachment: (root: string, folder: string, extension: string, data: string) =>
    invoke<string>('write_attachment', { root, folder, extension, data }),

  // File management.
  createFolder: (root: string, path: string) => invoke<void>('create_folder', { root, path }),
  createNote: (root: string, path: string, contents: string) =>
    invoke<void>('create_note', { root, path, contents }),
  /** Returns the vault-relative path of the copy. */
  duplicateNote: (root: string, path: string) => invoke<string>('duplicate_note', { root, path }),
  /** Raw JSON of every `.opennote/themes/*.json`; parsing happens in core. */
  readThemes: (root: string) => invoke<string[]>('read_vault_themes', { root }),
  renameEntry: (root: string, from: string, to: string) =>
    invoke<void>('rename_entry', { root, from, to }),
  deleteEntry: (root: string, path: string) => invoke<void>('delete_entry', { root, path }),
  isTracked: (root: string, path: string) => invoke<boolean>('is_tracked', { root, path }),

  // Bulk note load, for building the search index in one round trip.
  readAllNotes: (root: string) =>
    invoke<Array<{ path: string; content: string }>>('read_all_notes', { root }),

  // Keymap, stored in .opennote/keymap.json.
  readKeymap: (root: string) => invoke<string | null>('read_vault_keymap', { root }),
  writeKeymap: (root: string, json: string) => invoke<void>('write_vault_keymap', { root, json }),

  // Branches.
  branches: (root: string) => invoke<Branch[]>('list_branches', { root }),
  createBranch: (root: string, name: string, start?: string) =>
    invoke<void>('create_branch', { root, name, start: start ?? null }),
  switchBranch: (root: string, name: string) => invoke<void>('switch_branch', { root, name }),
  mergeBranch: (root: string, name: string) => invoke<MergeResult>('merge_branch', { root, name }),
  deleteBranch: (root: string, name: string, force: boolean) =>
    invoke<void>('delete_branch', { root, name, force }),

  // History.
  history: (root: string, path: string, limit = 50) =>
    invoke<CommitInfo[]>('note_history', { root, path, limit }),
  noteAtCommit: (root: string, commit: string, path: string) =>
    invoke<string>('note_at_commit', { root, commit, path }),
  noteDiff: (root: string, from: string, to: string | null, path: string) =>
    invoke<string>('note_diff', { root, from, to, path }),
  discardChanges: (root: string, path: string) =>
    invoke<void>('discard_note_changes', { root, path }),
  restoreNote: (root: string, commit: string, path: string) =>
    invoke<void>('restore_note', { root, commit, path }),

  // Remotes and cloning.
  remoteUrl: (root: string, remote = 'origin') =>
    invoke<string | null>('remote_url', { root, remote }),
  pickFolder: () => invoke<string | null>('pick_folder'),
  cloneVault: (url: string, parent: string, name: string) =>
    invoke<VaultInfo>('clone_vault', { url, parent, name }),

  /**
   * Open a URL in the user's real browser.
   *
   * A plain `target="_blank"` link does not reliably escape the Tauri webview,
   * and a pull-request page belongs in the browser where the user is signed in.
   */
  openExternal: (url: string) => openUrl(url),

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
