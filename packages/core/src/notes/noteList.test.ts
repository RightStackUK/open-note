import { describe, expect, it } from 'vitest';

import {
  buildNoteList,
  type Collection,
  collectionTitle,
  DEFAULT_NOTE_LIST_PREFS,
  excerptFor,
  noteHasTag,
  parseNoteListPrefs,
} from './noteList';
import { parseNote } from './parse';
import type { IndexedNote } from './vaultIndex';

function note(path: string, source: string): IndexedNote {
  const slug = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return { ...parseNote(path, source), path, slug: slug.toLowerCase() };
}

const NOTES = [
  note('a.md', '# Alpha\n\nFirst body text. #work'),
  note('b.md', '# Beta\n\nSecond body. #home #work/urgent'),
  note('c.md', '# Gamma\n\nNo tags here at all.'),
  note('d.md', '# Delta\n\nAn image: ![shot](img.png)'),
];

/** Fixed clock: 2026-08-31 15:00 local. */
const NOW = new Date(2026, 7, 31, 15, 0, 0);
const TODAY_10AM = Math.floor(new Date(2026, 7, 31, 10, 0, 0).getTime() / 1000);
const YESTERDAY = Math.floor(new Date(2026, 7, 30, 10, 0, 0).getTime() / 1000);

const MODIFIED = new Map([
  ['a.md', TODAY_10AM],
  ['b.md', YESTERDAY],
  ['c.md', YESTERDAY - 100],
  ['d.md', TODAY_10AM + 60],
]);

function build(over: Partial<Parameters<typeof buildNoteList>[0]> = {}) {
  return buildNoteList({
    notes: NOTES,
    modified: MODIFIED,
    created: new Map(),
    collection: { kind: 'all' },
    sort: 'modified',
    descending: true,
    includeNestedTags: true,
    now: NOW,
    ...over,
  });
}

describe('collections', () => {
  it('all shows everything', () => {
    expect(build().map((e) => e.path)).toHaveLength(4);
  });

  it('today keeps only notes modified since local midnight', () => {
    expect(build({ collection: { kind: 'today' } }).map((e) => e.path)).toEqual(['d.md', 'a.md']);
  });

  it('untagged keeps only notes with no tags', () => {
    expect(build({ collection: { kind: 'untagged' } }).map((e) => e.path)).toEqual([
      'd.md',
      'c.md',
    ]);
  });

  it('a tag collection includes nested tags by default', () => {
    expect(build({ collection: { kind: 'tag', tag: 'work' } }).map((e) => e.path)).toEqual([
      'a.md',
      'b.md',
    ]);
  });

  it('the nested toggle excludes children', () => {
    const entries = build({
      collection: { kind: 'tag', tag: 'work' },
      includeNestedTags: false,
    });
    expect(entries.map((e) => e.path)).toEqual(['a.md']);
  });

  it('titles the collections for the pane header', () => {
    const cases: Array<[Collection, string]> = [
      [{ kind: 'all' }, 'All notes'],
      [{ kind: 'today' }, 'Today'],
      [{ kind: 'untagged' }, 'Untagged'],
      [{ kind: 'tag', tag: 'work' }, '#work'],
    ];
    for (const [collection, title] of cases) expect(collectionTitle(collection)).toBe(title);
  });
});

describe('sorting', () => {
  it('sorts by modified, newest first, by default', () => {
    expect(build().map((e) => e.path)).toEqual(['d.md', 'a.md', 'b.md', 'c.md']);
  });

  it('flips with the descending toggle', () => {
    expect(build({ descending: false }).map((e) => e.path)).toEqual([
      'c.md',
      'b.md',
      'a.md',
      'd.md',
    ]);
  });

  it('sorts by title case-insensitively', () => {
    expect(build({ sort: 'title', descending: false }).map((e) => e.title)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ]);
  });

  it('sorts by created date from the first commit', () => {
    const created = new Map([
      ['a.md', 100],
      ['b.md', 300],
      ['c.md', 200],
      ['d.md', 400],
    ]);
    expect(build({ sort: 'created', created, descending: false }).map((e) => e.path)).toEqual([
      'a.md',
      'c.md',
      'b.md',
      'd.md',
    ]);
  });

  it('ranks a never-committed note by its mtime — it is brand new', () => {
    const created = new Map([
      ['a.md', 100],
      ['b.md', 300],
      ['c.md', 200],
      // d.md has no first commit.
    ]);
    const paths = build({ sort: 'created', created, descending: true }).map((e) => e.path);
    expect(paths[0]).toBe('d.md');
  });
});

describe('entries', () => {
  it('carries the attachment flag', () => {
    const byPath = new Map(build().map((e) => [e.path, e]));
    expect(byPath.get('d.md')?.hasAttachments).toBe(true);
    expect(byPath.get('a.md')?.hasAttachments).toBe(false);
  });

  it('excerpts skip the title and collapse whitespace', () => {
    const entry = build().find((e) => e.path === 'a.md');
    expect(entry?.excerpt).toBe('First body text. #work');
  });

  it('excerpts truncate by code point', () => {
    const long = note('e.md', `# E\n\n${'😀'.repeat(200)}`);
    const excerpt = excerptFor(long, 10);
    expect([...excerpt]).toHaveLength(10);
    // No emoji cut in half: a trailing HIGH surrogate would be a lone one.
    const last = excerpt.charCodeAt(excerpt.length - 1);
    expect(last >= 0xd800 && last < 0xdc00).toBe(false);
  });
});

describe('noteHasTag', () => {
  it('matches exactly and case-insensitively', () => {
    expect(noteHasTag(['Work'], 'work', false)).toBe(true);
    expect(noteHasTag(['working'], 'work', true)).toBe(false);
  });

  it('matches children only when asked', () => {
    expect(noteHasTag(['work/urgent'], 'work', true)).toBe(true);
    expect(noteHasTag(['work/urgent'], 'work', false)).toBe(false);
  });
});

describe('parseNoteListPrefs', () => {
  it('returns defaults for anything unusable', () => {
    expect(parseNoteListPrefs(undefined)).toEqual(DEFAULT_NOTE_LIST_PREFS);
    expect(parseNoteListPrefs('x')).toEqual(DEFAULT_NOTE_LIST_PREFS);
  });

  it('reads valid fields and degrades the rest', () => {
    const parsed = parseNoteListPrefs({ sort: 'title', density: 'gigantic', descending: false });
    expect(parsed.sort).toBe('title');
    expect(parsed.descending).toBe(false);
    expect(parsed.density).toBe('medium');
  });
});
