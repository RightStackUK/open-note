import { describe, expect, it } from 'vitest';

import {
  byteLength,
  MAX_FILENAME_BYTES,
  NameAllocator,
  sanitiseSegment,
  splitExtension,
  truncateBytes,
} from './names';

describe('sanitiseSegment', () => {
  it('replaces what a filesystem refuses', () => {
    expect(sanitiseSegment('Meeting: 3/4?')).toBe('Meeting-3-4');
    expect(sanitiseSegment('a\\b|c<d>e"f*g')).toBe('a-b-c-d-e-f-g');
  });

  it('keeps a multi-line title on one line', () => {
    expect(sanitiseSegment('Shopping\nlist')).toBe('Shopping list');
  });

  it('never returns a hidden file or a trailing dot', () => {
    // Windows strips a trailing dot silently, so a name ending in one is a
    // name the filesystem rewrites behind us.
    expect(sanitiseSegment('...notes...')).toBe('notes');
    expect(sanitiseSegment('.gitignore')).toBe('gitignore');
  });

  it('escapes the Windows device names', () => {
    expect(sanitiseSegment('CON')).toBe('_CON');
    expect(sanitiseSegment('lpt1')).toBe('_lpt1');
    expect(sanitiseSegment('console')).toBe('console');
  });

  it('falls back rather than returning nothing', () => {
    expect(sanitiseSegment('')).toBe('Untitled');
    expect(sanitiseSegment('   ///   ')).toBe('Untitled');
  });
});

describe('truncateBytes', () => {
  it('counts bytes, not characters', () => {
    // Four characters, twelve bytes.
    expect(byteLength('日本語だ')).toBe(12);
    expect(truncateBytes('日本語だ', 9)).toBe('日本語');
  });

  it('never splits a surrogate pair', () => {
    const emoji = '😀😀';
    expect(byteLength(emoji)).toBe(8);
    expect(truncateBytes(emoji, 6)).toBe('😀');
    expect(truncateBytes(emoji, 3)).toBe('');
  });
});

describe('NameAllocator', () => {
  it('hands out the obvious name first', () => {
    const names = new NameAllocator();
    expect(names.take('Inbox', 'Groceries')).toBe('Inbox/Groceries.md');
  });

  it('numbers collisions after sanitising, which creates more of them', () => {
    const names = new NameAllocator();
    expect(names.take('', 'Meeting: 3/4')).toBe('Meeting-3-4.md');
    expect(names.take('', 'Meeting - 3-4')).toBe('Meeting-3-4 2.md');
  });

  it('treats case as a collision, because two filesystems do', () => {
    const names = new NameAllocator(['Notes/Ideas.md']);
    expect(names.take('Notes', 'ideas')).toBe('Notes/ideas 2.md');
  });

  it('avoids what the vault already contains', () => {
    const names = new NameAllocator(['Inbox/Groceries.md']);
    expect(names.take('Inbox', 'Groceries')).toBe('Inbox/Groceries 2.md');
  });

  it('keeps a suffixed name inside the byte limit', () => {
    const long = 'あ'.repeat(200); // 600 bytes
    const names = new NameAllocator();
    const first = names.take('', long);
    const second = names.take('', long);
    expect(byteLength(first)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
    expect(byteLength(second)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
    expect(second).not.toBe(first);
    expect(second.endsWith(' 2.md')).toBe(true);
  });

  it('allocates attachments with their own extension', () => {
    const names = new NameAllocator();
    expect(names.take('assets', 'diagram', 'png')).toBe('assets/diagram.png');
    expect(names.take('assets', 'diagram', 'png')).toBe('assets/diagram 2.png');
  });
});

describe('splitExtension', () => {
  it('splits a normal filename', () => {
    expect(splitExtension('Scan 001.PNG')).toEqual({ stem: 'Scan 001', extension: 'png' });
  });

  it('treats a leading dot as a hidden file, not an extension', () => {
    expect(splitExtension('.profile')).toEqual({ stem: 'profile', extension: '' });
  });

  it('refuses a suffix that is prose rather than an extension', () => {
    expect(splitExtension('notes.from the meeting')).toEqual({
      stem: 'notes.from the meeting',
      extension: '',
    });
  });
});
