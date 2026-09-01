import { describe, expect, it } from 'vitest';

import {
  archivePathFor,
  isArchivedPath,
  isTemplatePath,
  mergeNotes,
  noteStats,
  renderTemplate,
} from './lifecycle';
import { buildNoteList } from './noteList';
import { parseNote } from './parse';
import type { IndexedNote } from './vaultIndex';
import { VaultIndex } from './vaultIndex';

describe('noteStats', () => {
  it('counts words, characters, paragraphs and reading time', () => {
    const stats = noteStats('One two three.\n\nFour five.\n\n\nSix.');
    expect(stats.words).toBe(6);
    expect(stats.paragraphs).toBe(3);
    expect(stats.readMinutes).toBe(1);
  });

  it('never reports zero minutes — nothing reads in no time', () => {
    expect(noteStats('hi').readMinutes).toBe(1);
  });

  it('estimates longer texts at ~220 wpm', () => {
    expect(noteStats(Array(660).fill('word').join(' ')).readMinutes).toBe(3);
  });
});

describe('renderTemplate', () => {
  const now = new Date(2026, 8, 1, 9, 5);

  it('fills title, date and time', () => {
    expect(renderTemplate('# {{title}}\n\n{{date}} {{time}}', { title: 'Plan', now })).toBe(
      '# Plan\n\n2026-09-01 09:05',
    );
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(renderTemplate('{{ Title }} on {{DATE}}', { title: 'X', now })).toBe('X on 2026-09-01');
  });

  it('leaves unknown placeholders exactly as written', () => {
    expect(renderTemplate('{{weather}} stays', { title: 'X', now })).toBe('{{weather}} stays');
  });
});

describe('archive rules', () => {
  it('recognises template paths', () => {
    expect(isTemplatePath('templates/daily.md')).toBe(true);
    expect(isTemplatePath('notes/templates.md')).toBe(false);
  });

  it('detects archived paths under the configured folder', () => {
    expect(isArchivedPath('archive/old.md', 'archive')).toBe(true);
    expect(isArchivedPath('archives/old.md', 'archive')).toBe(false);
    expect(isArchivedPath('old.md', 'archive')).toBe(false);
  });

  it('computes the archive destination, keeping the name', () => {
    expect(archivePathFor('projects/plan.md', 'archive')).toBe('archive/plan.md');
  });

  it('archived and template notes stay out of the default list', () => {
    const note = (path: string, source: string): IndexedNote => ({
      ...parseNote(path, source),
      path,
      slug: path.toLowerCase(),
    });
    const notes = [
      note('a.md', 'live'),
      note('archive/b.md', 'put away'),
      note('templates/daily.md', '# {{title}}'),
    ];
    const modified = new Map([
      ['a.md', 10],
      ['archive/b.md', 20],
      ['templates/daily.md', 5],
    ]);
    const base = {
      notes,
      modified,
      created: new Map<string, number>(),
      sort: 'modified' as const,
      descending: true,
      includeNestedTags: true,
    };

    expect(buildNoteList({ ...base, collection: { kind: 'all' } }).map((e) => e.path)).toEqual([
      'a.md',
    ]);
    expect(buildNoteList({ ...base, collection: { kind: 'archive' } }).map((e) => e.path)).toEqual([
      'archive/b.md',
    ]);
  });

  it('archived notes stay indexed but out of search, unless scoped there', () => {
    const idx = new VaultIndex();
    idx.put('a.md', 'the plan lives here');
    idx.put('archive/b.md', 'the plan was archived');

    expect(idx.query('plan').map((h) => h.path)).toEqual(['a.md']);
    expect(idx.query('plan', 30, { scope: { kind: 'archive' } }).map((h) => h.path)).toEqual([
      'archive/b.md',
    ]);
  });
});

describe('mergeNotes', () => {
  it('concatenates with a heading per source and demotes inner headings', () => {
    const merged = mergeNotes([
      { title: 'First', body: '# Inner\n\ntext' },
      { title: 'Second', body: 'plain' },
    ]);
    expect(merged).toBe('# First\n\n## Inner\n\ntext\n\n---\n\n# Second\n\nplain\n');
  });

  it('caps demotion at H6', () => {
    expect(mergeNotes([{ title: 'T', body: '###### deep' }])).toContain('###### deep');
  });
});
