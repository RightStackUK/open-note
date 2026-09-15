import type { EnexNote } from '@open-note/core';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';

export type FileKind = 'markdown' | 'image' | 'drawing' | 'pdf' | 'text' | 'other' | 'folder';

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
  clearRecentVaults: () => invoke<void>('clear_recent_vaults'),
  setOpenAccelerator: (accelerator: string | null) =>
    invoke<void>('set_open_accelerator', { accelerator }),
  setCloseTarget: (name: string | null) => invoke<void>('set_close_target', { name }),
  listFiles: (root: string) => invoke<VaultFile[]>('list_vault_files', { root }),
  readNote: (root: string, path: string) => invoke<string>('read_note', { root, path }),
  writeNote: (root: string, path: string, contents: string) =>
    invoke<void>('write_note', { root, path, contents }),
  readImage: (root: string, path: string) => invoke<string>('read_image', { root, path }),
  readPdf: (root: string, path: string) => invoke<string>('read_pdf', { root, path }),
  /** Pick any file and store it as an attachment. Null means cancelled. */
  pickAttachment: (root: string, folder: string) =>
    invoke<{ path: string; name: string; size: number } | null>('pick_attachment', {
      root,
      folder,
    }),
  openInDefaultApp: (root: string, path: string) =>
    invoke<void>('open_in_default_app', { root, path }),
  revealInFileManager: (root: string, path: string) =>
    invoke<void>('reveal_in_file_manager', { root, path }),
  /** Where a vault-relative path lives on this machine, symlinks resolved. */
  absolutePath: (root: string, path: string) => invoke<string>('absolute_path', { root, path }),
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
  writeExportBinary: (path: string, data: string) =>
    invoke<void>('write_export_binary', { path, data }),
  /** Page title of a URL, or null. Only called when the user opted in. */
  fetchPageTitle: (url: string) => invoke<string | null>('fetch_page_title', { url }),

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
  /** Path → epoch seconds of the first commit that added it. */
  createdDates: (root: string) => invoke<Record<string, number>>('created_dates', { root }),
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
  /** Pick a folder of Markdown, git init it, first commit, open it. */
  importFolderAsVault: () => invoke<VaultInfo | null>('import_folder_as_vault'),

  /**
   * Importing an Evernote `.enex` export, one note at a time.
   *
   * A session rather than one call because an archive can be gigabytes: Rust
   * holds the open file and the bytes of the note being worked on, and the
   * webview pulls notes through it. Cancelling is stopping the pull, which is
   * why there is no cancel command.
   */
  pickEnexFiles: () => invoke<string[]>('pick_enex_files'),
  enexOpen: (path: string) => invoke<{ id: number; bytesTotal: number }>('enex_open', { path }),
  enexNext: (id: number) =>
    invoke<{ note: EnexNote | null; bytesRead: number; bytesTotal: number }>('enex_next', { id }),
  /** Write the current note's attachments where the planner decided. */
  enexWriteMedia: (id: number, root: string, items: Array<{ hash: string; path: string }>) =>
    invoke<number>('enex_write_media', { id, root, items }),
  enexClose: (id: number) => invoke<void>('enex_close', { id }),

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

  // Windows. A vault is owned by one window, which is the one that runs its
  // sync engine; see `src-tauri/src/windows.rs`.
  openWindow: (root?: string, path?: string) =>
    invoke<string>('open_window', { root: root ?? null, path: path ?? null }),
  /** What this window was asked to open, if it was opened for something. */
  windowIntent: (label: string) =>
    invoke<{ root: string | null; path: string | null }>('window_intent', { label }),
  claimVault: (root: string, label: string) => invoke<boolean>('claim_vault', { root, label }),
  releaseVault: (root: string, label: string) => invoke<void>('release_vault', { root, label }),
  vaultOwner: (root: string) => invoke<string | null>('vault_owner', { root }),
  windowLabels: () => invoke<string[]>('window_labels'),
  /**
   * Take a document for this window, or learn which window has it.
   *
   * `null` means it is ours now. A label means that window has it open, and the
   * caller should reveal it there rather than opening a second editor over one
   * file — the autosave fight that "a document lives in one tab" prevents
   * inside a window does not stop at the window's edge.
   */
  claimDocument: (key: string, label: string) =>
    invoke<string | null>('claim_document', { key, label }),
  releaseDocument: (key: string, label: string) => invoke<void>('release_document', { key, label }),
  focusWindow: (label: string) => invoke<void>('focus_window', { label }),
};

/**
 * Why a git action is refused in a window that does not own the vault.
 *
 * One string, because three surfaces refuse for the same reason and a user who
 * meets it twice should not have to work out that it is the same rule.
 */
export const MANAGED_ELSEWHERE =
  'Another window owns this vault and runs its Git operations. Switch to that window to change branches or restore a version.';

/** This window's label. `main` is the one the app starts with. */
export function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Outside the desktop shell — the screenshot harness — there is one window.
    return 'main';
  }
}

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

/**
 * Cross-window messages.
 *
 * Tauri's `emit` reaches every window in the process, so these are broadcasts
 * with a vault root in the payload and a listener that ignores what is not its
 * business. Deliberately a handful of facts rather than a command channel: the
 * owner publishes what it knows, and a follower says when a file landed.
 */
export const VaultEvents = {
  /** Owner → all: this is the vault's sync state now. */
  state: 'vault://state',
  /** Follower → owner: I wrote a file; your commit loop should look. */
  saved: 'vault://saved',
  /** Owner → all: I pulled, so re-read what you have open. */
  changed: 'vault://changed',
  /** Follower → owner: sync this vault now. */
  syncNow: 'vault://sync-now',
  /** Rust → all: a window closed and this vault has no owner. */
  ownerless: 'vault://ownerless',
  /** Window → the window holding a note: bring it forward and show it. */
  reveal: 'doc://reveal',
} as const;

export function emitVault<T>(event: string, payload: T): void {
  try {
    void emit(event, payload).catch(() => {
      // A single-window app with no listeners is the normal case, not an error.
    });
  } catch {
    // No event layer at all — a plain browser, or the screenshot harness.
  }
}

/**
 * Subscribe, and return the unsubscribe.
 *
 * Everything is swallowed. The whole window layer is an enhancement: a build
 * running outside the desktop shell has no events, and an app that failed to
 * start over a missing broadcast channel would be a poor trade.
 */
export function listenVault<T>(event: string, handler: (payload: T) => void): () => void {
  let stop: Promise<() => void> | null = null;
  try {
    stop = listen<T>(event, ({ payload }) => handler(payload)).catch(() => () => {});
  } catch {
    return () => {};
  }
  return () => {
    void stop
      ?.then((off) => {
        try {
          off();
        } catch {
          // Unsubscribing from a channel that never existed.
        }
      })
      .catch(() => {});
  };
}
