export type { VaultSyncOptions } from './sync/engine';
export { defaultCommitMessage, VaultSync } from './sync/engine';
export type { SyncSettings, VaultSettings } from './sync/settings';
export {
  DEFAULT_SYNC_SETTINGS,
  DEFAULT_VAULT_SETTINGS,
  parseVaultSettings,
  serialiseVaultSettings,
} from './sync/settings';
export type {
  FileChange,
  FileState,
  MergeOutcome,
  RepoStatus,
  SyncError,
  SyncErrorCode,
  SyncPhase,
  SyncPort,
  SyncState,
} from './sync/types';
export { errorCode, errorMessage } from './sync/types';
