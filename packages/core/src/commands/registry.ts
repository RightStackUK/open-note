import { normaliseBinding } from './keys';

export type CommandCategory = 'Navigate' | 'Note' | 'Edit' | 'Sync' | 'View';

export interface CommandDefinition {
  id: string;
  title: string;
  category: CommandCategory;
  /** Binding in the default scheme; `null` means unbound by default. */
  binding: string | null;
  /** Keywords the palette should also match on. */
  keywords?: string[];
}

/**
 * Every command the app exposes.
 *
 * This is the single source of truth: the palette lists these, the keymap binds
 * these, and the settings UI edits these. Adding a command anywhere else means
 * it cannot be rebound, which defeats the point of a configurable keymap.
 */
export const COMMANDS: CommandDefinition[] = [
  // Navigate
  { id: 'palette.open', title: 'Command palette', category: 'Navigate', binding: 'Mod-Shift-P' },
  {
    id: 'switcher.open',
    title: 'Go to note',
    category: 'Navigate',
    binding: 'Mod-P',
    keywords: ['quick', 'switch', 'open', 'jump'],
  },
  {
    id: 'search.open',
    title: 'Search in vault',
    category: 'Navigate',
    binding: 'Mod-Shift-F',
    keywords: ['find', 'grep'],
  },
  {
    id: 'todos.open',
    title: 'Show all tasks',
    category: 'Navigate',
    binding: 'Mod-Shift-T',
    keywords: ['todo', 'task', 'checklist'],
  },

  // Note
  { id: 'note.new', title: 'New note', category: 'Note', binding: 'Mod-N' },
  {
    id: 'note.newFolder',
    title: 'New folder',
    category: 'Note',
    binding: 'Mod-Shift-N',
    keywords: ['directory', 'group'],
  },
  {
    id: 'note.export',
    title: 'Export note as HTML…',
    category: 'Note',
    binding: null,
    keywords: ['save', 'pdf', 'print', 'share'],
  },
  {
    id: 'note.togglePin',
    title: 'Pin or unpin this note',
    category: 'Note',
    binding: null,
    keywords: ['favourite', 'favorite', 'star'],
  },
  {
    id: 'note.daily',
    title: "Open today's note",
    category: 'Note',
    binding: 'Mod-Shift-D',
    keywords: ['daily', 'journal', 'today'],
  },

  // Edit
  { id: 'edit.bold', title: 'Bold', category: 'Edit', binding: 'Mod-B' },
  { id: 'edit.italic', title: 'Italic', category: 'Edit', binding: 'Mod-I' },
  { id: 'edit.code', title: 'Inline code', category: 'Edit', binding: 'Mod-E' },
  { id: 'edit.link', title: 'Insert link', category: 'Edit', binding: 'Mod-K' },
  { id: 'edit.wikilink', title: 'Insert note link', category: 'Edit', binding: 'Mod-Shift-K' },
  { id: 'edit.task', title: 'Toggle task', category: 'Edit', binding: 'Mod-Enter' },
  { id: 'edit.heading1', title: 'Heading 1', category: 'Edit', binding: 'Mod-1' },
  { id: 'edit.heading2', title: 'Heading 2', category: 'Edit', binding: 'Mod-2' },
  { id: 'edit.heading3', title: 'Heading 3', category: 'Edit', binding: 'Mod-3' },
  { id: 'edit.paragraph', title: 'Plain paragraph', category: 'Edit', binding: 'Mod-0' },

  // Sync
  {
    id: 'sync.now',
    title: 'Sync now',
    category: 'Sync',
    binding: 'Mod-S',
    keywords: ['commit', 'push', 'pull'],
  },
  {
    id: 'sync.togglePause',
    title: 'Pause or resume syncing',
    category: 'Sync',
    binding: 'Mod-Shift-S',
  },
  { id: 'sync.settings', title: 'Sync settings', category: 'Sync', binding: 'Mod-,' },

  {
    id: 'vault.clone',
    title: 'Clone a vault…',
    category: 'Note',
    binding: null,
    keywords: ['git', 'remote', 'download'],
  },

  // View
  { id: 'view.toggleSidebar', title: 'Toggle sidebar', category: 'View', binding: 'Mod-\\' },
  {
    id: 'view.outline',
    title: 'Outline and word count',
    category: 'View',
    binding: 'Mod-Shift-O',
    keywords: ['headings', 'contents', 'words'],
  },
  {
    id: 'view.tags',
    title: 'Browse tags',
    category: 'View',
    binding: 'Mod-Shift-A',
    keywords: ['tag', 'label', 'topic'],
  },
  {
    id: 'view.history',
    title: 'Note history',
    category: 'View',
    binding: 'Mod-Shift-H',
    keywords: ['git', 'log', 'versions', 'diff'],
  },
  {
    id: 'view.branches',
    title: 'Branches and pull requests',
    category: 'View',
    binding: 'Mod-Shift-G',
    keywords: ['git', 'branch', 'merge', 'pr'],
  },
  {
    id: 'view.toggleBacklinks',
    title: 'Toggle backlinks',
    category: 'View',
    binding: 'Mod-Shift-B',
  },
  {
    id: 'view.keymap',
    title: 'Keyboard shortcuts',
    category: 'View',
    binding: null,
    keywords: ['keys', 'bindings', 'shortcuts'],
  },
];

/**
 * Named schemes.
 *
 * A scheme only lists what it changes; everything else falls back to the
 * command's default binding.
 */
export const KEYMAP_SCHEMES: Record<string, Record<string, string | null>> = {
  default: {},
  /**
   * Keeps headings on Mod-1..3 as the default scheme does, but moves the task
   * toggle to Mod-Shift-Enter and reserves Mod-K for search rather than links,
   * which is what several other notes apps do.
   *
   * The key stays `bear` because it is written into existing
   * `.opennote/keymap.json` files; `KEYMAP_SCHEME_LABELS` owns what the UI
   * calls it.
   */
  bear: {
    'edit.task': 'Mod-Shift-Enter',
    'edit.link': 'Mod-Shift-L',
    'search.open': 'Mod-K',
    'edit.wikilink': 'Mod-Shift-K',
    'switcher.open': 'Mod-O',
  },
};

/**
 * What the settings UI calls each scheme.
 *
 * Separate from the keys above because those are persisted in the vault and
 * renaming one would silently reset somebody's keymap. Anything missing here
 * falls back to its capitalised key.
 */
export const KEYMAP_SCHEME_LABELS: Record<string, string> = {
  default: 'Default',
  bear: 'Alternative',
};

export type Keymap = Map<string, string>;

export interface KeymapConfig {
  /** Named scheme to start from. Unknown names fall back to `default`. */
  scheme: string;
  /** Per-command overrides. `null` unbinds a command entirely. */
  bindings: Record<string, string | null>;
}

export const DEFAULT_KEYMAP_CONFIG: KeymapConfig = { scheme: 'default', bindings: {} };

export interface ResolvedKeymap {
  /** Binding string to command id. */
  byBinding: Keymap;
  /** Command id to binding string, for display. */
  byCommand: Map<string, string>;
  /**
   * Bindings claimed by more than one command. The later command wins, but the
   * conflict is reported so the settings UI can flag it rather than leaving the
   * user wondering why a shortcut does the wrong thing.
   */
  conflicts: Array<{ binding: string; commands: string[] }>;
}

/**
 * Work out the effective keymap: command defaults, then the scheme, then the
 * user's own overrides.
 */
export function resolveKeymap(
  config: KeymapConfig = DEFAULT_KEYMAP_CONFIG,
  commands: CommandDefinition[] = COMMANDS,
): ResolvedKeymap {
  const scheme = KEYMAP_SCHEMES[config.scheme] ?? KEYMAP_SCHEMES.default ?? {};

  const byCommand = new Map<string, string>();
  const claimants = new Map<string, string[]>();

  for (const command of commands) {
    let binding: string | null | undefined = command.binding;
    if (command.id in scheme) binding = scheme[command.id];
    if (command.id in config.bindings) binding = config.bindings[command.id];
    if (!binding) continue;

    const normalised = normaliseBinding(binding);
    if (!normalised) continue;

    byCommand.set(command.id, normalised);
    claimants.set(normalised, [...(claimants.get(normalised) ?? []), command.id]);
  }

  const byBinding: Keymap = new Map();
  const conflicts: ResolvedKeymap['conflicts'] = [];
  for (const [binding, ids] of claimants) {
    byBinding.set(binding, ids[ids.length - 1] as string);
    if (ids.length > 1) conflicts.push({ binding, commands: ids });
  }

  return { byBinding, byCommand, conflicts };
}

/**
 * Read `.opennote/keymap.json`.
 *
 * Like the sync settings, this is hand-editable and synced between machines, so
 * anything malformed degrades to defaults instead of leaving the app unusable.
 */
export function parseKeymapConfig(raw: string | null | undefined): KeymapConfig {
  if (!raw) return { ...DEFAULT_KEYMAP_CONFIG, bindings: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_KEYMAP_CONFIG, bindings: {} };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...DEFAULT_KEYMAP_CONFIG, bindings: {} };
  }

  const record = parsed as Record<string, unknown>;
  const scheme =
    typeof record.scheme === 'string' && record.scheme in KEYMAP_SCHEMES
      ? record.scheme
      : 'default';

  const bindings: Record<string, string | null> = {};
  const rawBindings = record.bindings;
  if (typeof rawBindings === 'object' && rawBindings !== null) {
    for (const [id, value] of Object.entries(rawBindings as Record<string, unknown>)) {
      if (value === null) bindings[id] = null;
      else if (typeof value === 'string') bindings[id] = value;
    }
  }

  return { scheme, bindings };
}

export function serialiseKeymapConfig(config: KeymapConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Palette matching: title, category and keywords, ranked. */
export function searchCommands(
  query: string,
  commands: CommandDefinition[] = COMMANDS,
): CommandDefinition[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return commands;

  const scored: Array<{ command: CommandDefinition; score: number }> = [];
  for (const command of commands) {
    const title = command.title.toLowerCase();
    let score = 0;
    if (title.startsWith(trimmed)) score = 100;
    else if (title.includes(trimmed)) score = 60;
    else if (command.category.toLowerCase().includes(trimmed)) score = 30;
    else if (command.keywords?.some((k) => k.includes(trimmed))) score = 25;
    else if (isSubsequence(title, trimmed)) score = 10;
    if (score > 0) scored.push({ command, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
    .map((s) => s.command);
}

function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}
