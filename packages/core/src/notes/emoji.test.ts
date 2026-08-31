import { describe, expect, it } from 'vitest';

import { EMOJI, searchEmoji } from './emoji';

describe('the emoji table', () => {
  it('has unique shortcodes', () => {
    const codes = EMOJI.map((e) => e.shortcode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every entry a character and a shortcode', () => {
    for (const emoji of EMOJI) {
      expect(emoji.shortcode).toMatch(/^[a-z0-9_+-]+$/);
      expect(emoji.char.length).toBeGreaterThan(0);
    }
  });

  it('uses no colons in the shortcodes themselves', () => {
    // The colons are the delimiter; storing them would double them up.
    for (const emoji of EMOJI) expect(emoji.shortcode).not.toContain(':');
  });
});

describe('searchEmoji', () => {
  it('returns the table for an empty query', () => {
    expect(searchEmoji('').length).toBeGreaterThan(0);
  });

  it('ranks an exact shortcode first', () => {
    expect(searchEmoji('x')[0]?.char).toBe('❌');
  });

  it('ranks a prefix above a substring', () => {
    const table = [
      { shortcode: 'unchecked', char: 'A' },
      { shortcode: 'check', char: 'B' },
    ];
    expect(searchEmoji('check', 30, table)[0]?.char).toBe('B');
  });

  it('matches on keywords', () => {
    expect(searchEmoji('urgent').map((e) => e.char)).toContain('🔥');
  });

  it('is case insensitive', () => {
    expect(searchEmoji('ROCKET').map((e) => e.char)).toContain('🚀');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchEmoji('zzzzqqq')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchEmoji('', 3).length).toBe(3);
  });
});
