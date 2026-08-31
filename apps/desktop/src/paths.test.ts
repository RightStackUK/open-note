import { describe, expect, it } from 'vitest';

import { relativeFrom, resolveAgainst } from './paths';

describe('relativeFrom', () => {
  it('leaves a target alone for a note at the vault root', () => {
    expect(relativeFrom('note.md', 'assets/a.png')).toBe('assets/a.png');
  });

  it('steps up out of the note folder', () => {
    expect(relativeFrom('notes/note.md', 'assets/a.png')).toBe('../assets/a.png');
  });

  it('steps up twice from a deeper note', () => {
    expect(relativeFrom('a/b/note.md', 'assets/x.png')).toBe('../../assets/x.png');
  });

  it('keeps it short when the file is beside the note', () => {
    expect(relativeFrom('notes/note.md', 'notes/a.png')).toBe('a.png');
  });

  it('descends into a subfolder of the note folder', () => {
    expect(relativeFrom('notes/note.md', 'notes/assets/a.png')).toBe('assets/a.png');
  });
});

describe('resolveAgainst', () => {
  it('resolves a sibling reference', () => {
    expect(resolveAgainst('notes/note.md', 'a.png')).toBe('notes/a.png');
  });

  it('resolves a parent reference', () => {
    expect(resolveAgainst('notes/note.md', '../assets/a.png')).toBe('assets/a.png');
  });

  it('resolves several levels up', () => {
    expect(resolveAgainst('a/b/note.md', '../../assets/x.png')).toBe('assets/x.png');
  });

  it('handles a note at the vault root', () => {
    expect(resolveAgainst('note.md', 'assets/a.png')).toBe('assets/a.png');
  });

  it('ignores a leading ./', () => {
    expect(resolveAgainst('notes/note.md', './a.png')).toBe('notes/a.png');
  });

  it('round-trips with relativeFrom', () => {
    for (const [note, target] of [
      ['note.md', 'assets/a.png'],
      ['notes/note.md', 'assets/a.png'],
      ['a/b/note.md', 'assets/x.png'],
      ['notes/note.md', 'notes/a.png'],
    ] as const) {
      expect(resolveAgainst(note, relativeFrom(note, target))).toBe(target);
    }
  });
});
