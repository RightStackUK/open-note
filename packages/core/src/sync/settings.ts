import { DEFAULT_NOTE_LIST_PREFS, type NoteListPrefs, parseNoteListPrefs } from '../notes/noteList';
import { DEFAULT_TYPOGRAPHY, parseTypography, type TypographySettings } from './typography';

/**
 * Per-vault sync settings, stored in `.opennote/settings.json` inside the repo
 * so they travel between a user's machines.
 */
export interface SyncSettings {
  /** Batch outstanding edits into a commit automatically. */
  autoCommit: boolean;
  /** Publish commits automatically. On by default, per product decision. */
  autoPush: boolean;
  /** Poll the remote for other people's work. */
  autoFetch: boolean;
  /** Quiet period after the last edit before committing. */
  commitIdleMs: number;
  /** Commit anyway once edits have been outstanding this long. */
  commitMaxWaitMs: number;
  /** Delay between a commit and the push that publishes it. */
  pushDebounceMs: number;
  /** How often to look for upstream work. */
  fetchIntervalMs: number;
  /** First retry delay after a failed push; doubles up to `retryMaxMs`. */
  retryBaseMs: number;
  retryMaxMs: number;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  autoCommit: true,
  autoPush: true,
  autoFetch: true,
  commitIdleMs: 30_000,
  commitMaxWaitMs: 300_000,
  pushDebounceMs: 10_000,
  fetchIntervalMs: 60_000,
  retryBaseMs: 5_000,
  retryMaxMs: 300_000,
};

export interface VaultSettings {
  sync: SyncSettings;
  /**
   * Where pasted images and other attachments go, vault-relative.
   *
   * `.` means "beside the note", which is what people who keep self-contained
   * folders want. A fixed folder would be simpler but is the kind of decision
   * people end up fighting.
   */
  attachmentFolder: string;
  /** Vault-relative paths kept at the top of the tree. */
  pinned: string[];
  /** Move a task to the bottom of its list automatically when it is completed. */
  sortTodosOnCompletion: boolean;
  /** Offer `[[` link, `#` tag and `:` emoji completion while typing. */
  completion: boolean;
  /** How the prose looks. Applied as CSS variables, never a rebuild. */
  typography: TypographySettings;
  /** Theme name — a built-in or a `.opennote/themes/*.json` file. Empty follows the OS. */
  theme: string;
  /** Conceal Markdown syntax on every line, not just off the active one. */
  concealEverywhere: boolean;
  /** What a new note starts with: an H1 of its title, or an empty buffer. */
  newNoteHeading: 'h1' | 'none';
  /** Where `note.addTag` puts the tag. */
  insertTagsAt: 'top' | 'bottom';
  /** How the note list pane filters, sorts and draws. */
  noteList: NoteListPrefs;
  /** Convert pasted HTML to Markdown. The default, and the point of pasting. */
  pasteAsMarkdown: boolean;
  /** Fetch a pasted bare URL's page title. A network request per keystroke, so off by default. */
  fetchLinkTitles: boolean;
  /** Copy As drops `#tag` tokens from what lands on the clipboard. */
  copyStripsTags: boolean;
  /** Tags kept at the top of the tag browser. */
  pinnedTags: string[];
  /** Tag → emoji character, purely cosmetic. */
  tagIcons: Record<string, string>;
  /** Tag browser order. */
  tagSort: 'name' | 'count';
  /** Images in notes: full width, or contained thumbnails. */
  imageDisplay: 'full' | 'thumbnail';
}

export const DEFAULT_ATTACHMENT_FOLDER = 'assets';

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  sync: DEFAULT_SYNC_SETTINGS,
  attachmentFolder: DEFAULT_ATTACHMENT_FOLDER,
  pinned: [],
  sortTodosOnCompletion: false,
  completion: true,
  typography: DEFAULT_TYPOGRAPHY,
  theme: '',
  concealEverywhere: false,
  newNoteHeading: 'h1',
  insertTagsAt: 'bottom',
  noteList: DEFAULT_NOTE_LIST_PREFS,
  pasteAsMarkdown: true,
  fetchLinkTitles: false,
  copyStripsTags: false,
  pinnedTags: [],
  tagIcons: {},
  tagSort: 'count',
  imageDisplay: 'full',
};

/**
 * Resolve where an attachment for `notePath` should be written.
 *
 * Returns a folder path, or the empty string for the vault root.
 */
export function attachmentFolderFor(notePath: string, setting: string): string {
  const folder = setting.trim().replace(/^\/+|\/+$/g, '');
  if (folder === '.' || folder === '') {
    const slash = notePath.lastIndexOf('/');
    return slash === -1 ? '' : notePath.slice(0, slash);
  }
  return folder;
}

/** Guard against a hand-edited settings file producing a runaway timer. */
const LIMITS: Record<string, [min: number, max: number]> = {
  commitIdleMs: [1_000, 3_600_000],
  commitMaxWaitMs: [5_000, 86_400_000],
  pushDebounceMs: [0, 3_600_000],
  fetchIntervalMs: [10_000, 86_400_000],
  retryBaseMs: [1_000, 600_000],
  retryMaxMs: [5_000, 3_600_000],
};

function clampNumber(key: string, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const limit = LIMITS[key];
  if (!limit) return value;
  return Math.min(Math.max(value, limit[0]), limit[1]);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Parse settings from the repo, falling back to defaults field by field.
 *
 * These files are hand-editable and synced between machines, so a partial,
 * stale or malformed file must never stop a vault from syncing — it degrades to
 * defaults for whatever it got wrong.
 */
export function parseVaultSettings(raw: string | null | undefined): VaultSettings {
  const defaults = (): VaultSettings => ({
    sync: { ...DEFAULT_SYNC_SETTINGS },
    attachmentFolder: DEFAULT_ATTACHMENT_FOLDER,
    pinned: [],
    sortTodosOnCompletion: false,
    completion: true,
    typography: { ...DEFAULT_TYPOGRAPHY },
    theme: '',
    concealEverywhere: false,
    newNoteHeading: 'h1',
    insertTagsAt: 'bottom',
    noteList: { ...DEFAULT_NOTE_LIST_PREFS },
    pasteAsMarkdown: true,
    fetchLinkTitles: false,
    copyStripsTags: false,
    pinnedTags: [],
    tagIcons: {},
    tagSort: 'count',
    imageDisplay: 'full',
  });
  if (!raw) return defaults();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults();
  }

  const sync =
    typeof parsed === 'object' && parsed !== null && 'sync' in parsed
      ? ((parsed as { sync: unknown }).sync as Record<string, unknown> | null)
      : null;

  const attachmentFolder =
    typeof (parsed as { attachmentFolder?: unknown }).attachmentFolder === 'string'
      ? ((parsed as { attachmentFolder: string }).attachmentFolder as string)
      : DEFAULT_ATTACHMENT_FOLDER;

  const rawPinned = (parsed as { pinned?: unknown }).pinned;
  const pinned = Array.isArray(rawPinned)
    ? rawPinned.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const sortTodosOnCompletion = bool(
    (parsed as { sortTodosOnCompletion?: unknown }).sortTodosOnCompletion,
    false,
  );
  const completion = bool((parsed as { completion?: unknown }).completion, true);
  const typography = parseTypography((parsed as { typography?: unknown }).typography);
  const rawTheme = (parsed as { theme?: unknown }).theme;
  const theme = typeof rawTheme === 'string' ? rawTheme.trim().slice(0, 60) : '';
  const concealEverywhere = bool(
    (parsed as { concealEverywhere?: unknown }).concealEverywhere,
    false,
  );
  const rawHeading = (parsed as { newNoteHeading?: unknown }).newNoteHeading;
  const newNoteHeading = rawHeading === 'none' ? 'none' : 'h1';
  const rawInsertAt = (parsed as { insertTagsAt?: unknown }).insertTagsAt;
  const insertTagsAt = rawInsertAt === 'top' ? 'top' : 'bottom';
  const noteList = parseNoteListPrefs((parsed as { noteList?: unknown }).noteList);
  const pasteAsMarkdown = bool((parsed as { pasteAsMarkdown?: unknown }).pasteAsMarkdown, true);
  const fetchLinkTitles = bool((parsed as { fetchLinkTitles?: unknown }).fetchLinkTitles, false);
  const copyStripsTags = bool((parsed as { copyStripsTags?: unknown }).copyStripsTags, false);
  const rawPinnedTags = (parsed as { pinnedTags?: unknown }).pinnedTags;
  const pinnedTags = Array.isArray(rawPinnedTags)
    ? rawPinnedTags.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const rawIcons = (parsed as { tagIcons?: unknown }).tagIcons;
  const tagIcons: Record<string, string> = {};
  if (typeof rawIcons === 'object' && rawIcons !== null) {
    for (const [tag, icon] of Object.entries(rawIcons as Record<string, unknown>)) {
      // An icon is one emoji, not a paragraph someone pasted into the file.
      if (typeof icon === 'string' && icon.length > 0 && icon.length <= 8) tagIcons[tag] = icon;
    }
  }
  const tagSort = (parsed as { tagSort?: unknown }).tagSort === 'name' ? 'name' : 'count';
  const imageDisplay =
    (parsed as { imageDisplay?: unknown }).imageDisplay === 'thumbnail' ? 'thumbnail' : 'full';

  const prefs = {
    attachmentFolder,
    pinned,
    sortTodosOnCompletion,
    completion,
    typography,
    theme,
    concealEverywhere,
    newNoteHeading,
    insertTagsAt,
    noteList,
    pasteAsMarkdown,
    fetchLinkTitles,
    copyStripsTags,
    pinnedTags,
    tagIcons,
    tagSort,
    imageDisplay,
  } as const;

  if (typeof sync !== 'object' || sync === null) {
    return { sync: { ...DEFAULT_SYNC_SETTINGS }, ...prefs };
  }

  const d = DEFAULT_SYNC_SETTINGS;
  return {
    ...prefs,
    sync: {
      autoCommit: bool(sync.autoCommit, d.autoCommit),
      autoPush: bool(sync.autoPush, d.autoPush),
      autoFetch: bool(sync.autoFetch, d.autoFetch),
      commitIdleMs: clampNumber('commitIdleMs', sync.commitIdleMs, d.commitIdleMs),
      commitMaxWaitMs: clampNumber('commitMaxWaitMs', sync.commitMaxWaitMs, d.commitMaxWaitMs),
      pushDebounceMs: clampNumber('pushDebounceMs', sync.pushDebounceMs, d.pushDebounceMs),
      fetchIntervalMs: clampNumber('fetchIntervalMs', sync.fetchIntervalMs, d.fetchIntervalMs),
      retryBaseMs: clampNumber('retryBaseMs', sync.retryBaseMs, d.retryBaseMs),
      retryMaxMs: clampNumber('retryMaxMs', sync.retryMaxMs, d.retryMaxMs),
    },
  };
}

export function serialiseVaultSettings(settings: VaultSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
