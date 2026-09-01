/**
 * The note list: what the middle pane shows, in what order.
 *
 * All of the filtering and ordering lives here rather than in the component,
 * because "which notes is Today, sorted by created date" is exactly the kind
 * of logic that grows subtly wrong branches without tests — and the component
 * only wants an array to draw.
 */

import { isArchivedPath, isTemplatePath } from './lifecycle';
import type { IndexedNote } from './vaultIndex';

export type NoteListSort = 'modified' | 'created' | 'title';
export type NoteListDensity = 'small' | 'medium' | 'large';

/** The per-vault note list preferences, stored in `.opennote/settings.json`. */
export interface NoteListPrefs {
  sort: NoteListSort;
  /** Newest (or Z) first. */
  descending: boolean;
  density: NoteListDensity;
  /** Show the paperclip on notes with attachments. */
  showBadges: boolean;
  /** Selecting a parent tag includes its children's notes. */
  includeNestedTags: boolean;
}

export const DEFAULT_NOTE_LIST_PREFS: NoteListPrefs = {
  sort: 'modified',
  descending: true,
  density: 'medium',
  showBadges: true,
  includeNestedTags: true,
};

/** Parse the `noteList` value of a settings file, field by field. */
export function parseNoteListPrefs(raw: unknown): NoteListPrefs {
  const d = DEFAULT_NOTE_LIST_PREFS;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const record = raw as Record<string, unknown>;
  return {
    sort:
      record.sort === 'created' || record.sort === 'title' || record.sort === 'modified'
        ? record.sort
        : d.sort,
    descending: typeof record.descending === 'boolean' ? record.descending : d.descending,
    density:
      record.density === 'small' || record.density === 'large' || record.density === 'medium'
        ? record.density
        : d.density,
    showBadges: typeof record.showBadges === 'boolean' ? record.showBadges : d.showBadges,
    includeNestedTags:
      typeof record.includeNestedTags === 'boolean'
        ? record.includeNestedTags
        : d.includeNestedTags,
  };
}

/** What subset of the vault the list shows. */
export type Collection =
  | { kind: 'all' }
  | { kind: 'today' }
  | { kind: 'untagged' }
  | { kind: 'archive' }
  | { kind: 'tag'; tag: string };

export function collectionTitle(collection: Collection): string {
  switch (collection.kind) {
    case 'all':
      return 'All notes';
    case 'today':
      return 'Today';
    case 'untagged':
      return 'Untagged';
    case 'archive':
      return 'Archive';
    case 'tag':
      return `#${collection.tag}`;
  }
}

export interface NoteListEntry {
  path: string;
  title: string;
  /** A line or two of body text, title excluded. */
  excerpt: string;
  /** Last modified, seconds since the epoch; 0 when unknown. */
  modified: number;
  /** First commit that added the file, seconds; null when never committed. */
  created: number | null;
  hasAttachments: boolean;
}

/** Whether a note carries `tag`, optionally counting nested children. */
export function noteHasTag(tags: string[], tag: string, includeNested: boolean): boolean {
  const wanted = tag.toLowerCase();
  return tags.some((t) => {
    const lower = t.toLowerCase();
    return lower === wanted || (includeNested && lower.startsWith(`${wanted}/`));
  });
}

/**
 * The excerpt shown under a title.
 *
 * The title itself is dropped when it leads the text — a list where every row
 * says its title twice reads like a stutter — and whitespace collapses so a
 * note of short lines still fills its two lines of preview.
 */
export function excerptFor(note: Pick<IndexedNote, 'title' | 'plain'>, length = 160): string {
  let text = note.plain.replace(/\s+/g, ' ').trim();
  if (text.toLowerCase().startsWith(note.title.toLowerCase())) {
    text = text.slice(note.title.length).trim();
  }
  // Code-point aware: slicing UTF-16 units in half makes mojibake.
  return [...text].slice(0, length).join('');
}

/** Local midnight of `now` in epoch seconds — the boundary "Today" uses. */
function startOfToday(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(midnight.getTime() / 1000);
}

export interface BuildNoteListInput {
  notes: IndexedNote[];
  /** Path to mtime, seconds; from the file listing. */
  modified: Map<string, number>;
  /** Path to first-commit time, seconds; from git, may be empty. */
  created: Map<string, number>;
  collection: Collection;
  sort: NoteListSort;
  descending: boolean;
  includeNestedTags: boolean;
  /**
   * The archive folder. Archived notes appear only in the Archive collection;
   * everywhere else they have been deliberately put away. Templates never
   * list — they are scaffolding, not notes.
   */
  archiveFolder?: string;
  /** Injected so "Today" is testable. */
  now?: Date;
}

export function buildNoteList(input: BuildNoteListInput): NoteListEntry[] {
  const { collection, includeNestedTags } = input;
  const today = startOfToday(input.now ?? new Date());

  const archiveFolder = input.archiveFolder ?? 'archive';

  const entries: NoteListEntry[] = [];
  for (const note of input.notes) {
    const modified = input.modified.get(note.path) ?? 0;

    if (isTemplatePath(note.path)) continue;
    const archived = isArchivedPath(note.path, archiveFolder);
    if (collection.kind === 'archive' ? !archived : archived) continue;

    if (collection.kind === 'untagged' && note.tags.length > 0) continue;
    if (collection.kind === 'today' && modified < today) continue;
    if (collection.kind === 'tag' && !noteHasTag(note.tags, collection.tag, includeNestedTags)) {
      continue;
    }

    entries.push({
      path: note.path,
      title: note.title,
      excerpt: excerptFor(note),
      modified,
      created: input.created.get(note.path) ?? null,
      hasAttachments: note.hasAttachments,
    });
  }

  const direction = input.descending ? -1 : 1;
  entries.sort((a, b) => {
    if (input.sort === 'title') {
      return (
        direction * a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
        a.path.localeCompare(b.path)
      );
    }
    // A never-committed note has no created date; its mtime is the honest
    // stand-in, and ranks it as brand new — which it is.
    const aKey = input.sort === 'created' ? (a.created ?? a.modified) : a.modified;
    const bKey = input.sort === 'created' ? (b.created ?? b.modified) : b.modified;
    return (
      direction * (aKey - bKey) || a.title.localeCompare(b.title) || a.path.localeCompare(b.path)
    );
  });

  return entries;
}
