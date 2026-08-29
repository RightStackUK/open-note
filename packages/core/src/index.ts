// Sync

export type { KeyEventLike, Platform } from './commands/keys';
// Commands and keys
export { bindingFromEvent, formatBinding, normaliseBinding } from './commands/keys';
export type {
  CommandCategory,
  CommandDefinition,
  Keymap,
  KeymapConfig,
  ResolvedKeymap,
} from './commands/registry';
export {
  COMMANDS,
  DEFAULT_KEYMAP_CONFIG,
  KEYMAP_SCHEMES,
  parseKeymapConfig,
  resolveKeymap,
  searchCommands,
  serialiseKeymapConfig,
} from './commands/registry';
export type { DailyNoteSettings } from './notes/daily';
export {
  DEFAULT_DAILY_SETTINGS,
  dailyNotePath,
  dailyNoteTemplate,
  localIsoDate,
} from './notes/daily';
export type {
  Frontmatter,
  Heading,
  ParsedNote,
  Todo,
  TodoPriority,
  WikiLink,
} from './notes/parse';
// Notes
export {
  extractHeadings,
  extractLinks,
  extractTags,
  extractTodos,
  noteTitle,
  parseNote,
  splitFrontmatter,
  toPlainText,
} from './notes/parse';
export type { Backlink, IndexedNote, SearchHit, TagCount, TodoItem } from './notes/vaultIndex';
export { fuzzyScore, snippetFor, VaultIndex } from './notes/vaultIndex';
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
