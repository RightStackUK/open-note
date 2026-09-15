/**
 * Apple Notes, on the side of it that is a pure function.
 *
 * Fetching lives in Rust because it means scripting another application; what
 * is here is what turns a fetched note into something the shared pipeline can
 * plan — and the two rules that must not be got wrong, both of which are about
 * *not* importing something.
 */

import { sanitiseSegment } from './names';
import type { ImportWarning, SourceNote } from './pipeline';

/** A note as `notes_enumerate.js` reports it, before its body is fetched. */
export interface AppleNoteRef {
  id: string;
  name: string;
  locked: boolean;
  /** ISO 8601, in UTC, as JXA serialises a `Date`. */
  created: string | null;
  modified: string | null;
}

/** A note's body as `notes_bodies.js` reports it. */
export interface AppleNoteBody {
  id: string;
  body: string | null;
  /** Attachment names. Bytes are not available; see the module note in Rust. */
  attachments: string[];
  /** `locked`, or whatever the scripting bridge said went wrong. */
  error: string | null;
}

/**
 * Names Apple Notes gives its trash, which must never be imported.
 *
 * Importing someone's deleted notes into a permanent Git history is a bad
 * surprise and effectively irreversible once pushed, so it is excluded by
 * name. The name is *localised* and the scripting interface exposes no flag
 * for it, which is why this is a list and why it cannot be complete — the
 * second guard is the one that actually holds: the importer only ever visits
 * folders the user has ticked, and the picker shows exactly what it will take.
 */
const RECENTLY_DELETED = [
  'recently deleted',
  'trash',
  'récemment supprimés',
  'zuletzt gelöscht',
  'eliminados recientemente',
  'eliminati di recente',
  'recentemente eliminadas',
  'recentelijk verwijderd',
  'senast borttagna',
  'nyligt slettede',
  'nylig slettet',
  'viimeksi poistetut',
  'ostatnio usunięte',
  'недавно удалённые',
  'son silinenler',
  '最近削除した項目',
  '最近删除',
  '最近刪除的項目',
  '최근 삭제된 항목',
];

/** Whether a folder path names the trash, at any level. */
export function isRecentlyDeleted(path: string): boolean {
  return path.split('/').some((segment) => RECENTLY_DELETED.includes(segment.trim().toLowerCase()));
}

/**
 * A Notes folder path as a vault folder path.
 *
 * Nested folders become nested directories, which is the mapping people
 * expect; each segment is sanitised on its own so a folder called `Q1: 2024`
 * does not silently become two levels deep.
 */
export function appleNotesFolder(path: string): string {
  return path
    .split('/')
    .map((segment) => sanitiseSegment(segment, 'Notes'))
    .filter(Boolean)
    .join('/');
}

/** `2026-03-29T20:55:05.000Z` → `2026-03-29T20:55:05Z`, as the vault writes it. */
export function appleNotesDate(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const IMAGE_NAME = /\.(png|jpe?g|gif|heic|heif|webp|tiff?|bmp)$/i;

/**
 * What the import could not carry across from one note.
 *
 * Images arrive inside the body as data URLs and are written like any other
 * attachment. Everything else — a PDF, a scan, a voice memo — cannot be
 * reached: `attachment` exposes a name and no bytes, and Notes scripts no
 * command that would save one. So each is named, because a note that quietly
 * lost its attachment is the failure the user finds out about last.
 */
export function appleNotesWarnings(ref: AppleNoteRef, body: AppleNoteBody): ImportWarning[] {
  const label = ref.name.trim() || 'Untitled';
  if (ref.locked || body.error === 'locked') {
    return [{ note: label, reason: 'locked in Apple Notes, so it could not be read' }];
  }
  if (body.error) {
    return [{ note: label, reason: `Apple Notes refused it: ${body.error}` }];
  }
  return body.attachments
    .filter((name) => name && !IMAGE_NAME.test(name))
    .map((name) => ({
      note: label,
      reason: `“${name}” stayed in Apple Notes — only images can be exported`,
    }));
}

/**
 * Adapt a fetched note to what the shared pipeline consumes.
 *
 * Returns null for a note there is nothing to import — a locked one, or one
 * the bridge refused. The caller reports those from
 * {@link appleNotesWarnings}; creating an empty note in their place would
 * claim to have imported something that was not read.
 */
export function appleNotesSourceNote(ref: AppleNoteRef, body: AppleNoteBody): SourceNote | null {
  if (ref.locked || body.error || body.body === null) return null;

  return {
    title: ref.name.trim(),
    html: body.body,
    // Apple Notes has no tags; a note's folder is its only classification, and
    // that becomes the directory.
    tags: [],
    created: appleNotesDate(ref.created),
    updated: appleNotesDate(ref.modified),
    sourceUrl: null,
    // Nothing referenced by hash: the bytes that exist are inline in the body,
    // and `planNote` extracts them.
    resources: [],
  };
}
