import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_THEMES,
  parseTheme,
  resolveTheme,
  THEME_COLOR_KEYS,
  themeCssVariables,
} from './themes';

describe('parseTheme', () => {
  it('reads a well-formed theme', () => {
    const theme = parseTheme(
      JSON.stringify({ name: 'Mine', appearance: 'dark', colors: { bg: '#111', fg: '#eee' } }),
    );
    expect(theme).toEqual({ name: 'Mine', appearance: 'dark', colors: { bg: '#111', fg: '#eee' } });
  });

  it('returns null for malformed JSON', () => {
    expect(parseTheme('{ not json')).toBeNull();
  });

  it('returns null without a name or a valid appearance', () => {
    expect(parseTheme('{"appearance":"dark"}')).toBeNull();
    expect(parseTheme('{"name":"X","appearance":"sparkly"}')).toBeNull();
  });

  it('drops unknown colour keys — a theme recolours, it does not define', () => {
    const theme = parseTheme(
      JSON.stringify({
        name: 'Sneaky',
        appearance: 'light',
        colors: { bg: '#fff', 'anything-else': 'red' },
      }),
    );
    expect(theme?.colors).toEqual({ bg: '#fff' });
  });

  it('drops values that are not plausibly colours', () => {
    // A vault can be cloned from anywhere; a theme file is untrusted input.
    const theme = parseTheme(
      JSON.stringify({
        name: 'Hostile',
        appearance: 'light',
        colors: {
          bg: 'url(javascript:alert(1))',
          fg: 'red; background: pink',
          accent: 'var(--fg)',
          muted: 'color-mix(in srgb, red 50%, blue)',
        },
      }),
    );
    // color-mix is a real colour; the others are machinery.
    expect(theme?.colors).toEqual({ muted: 'color-mix(in srgb, red 50%, blue)' });
  });

  it('accepts every built-in, since they share the format', () => {
    for (const theme of BUILT_IN_THEMES) {
      const reparsed = parseTheme(JSON.stringify(theme));
      expect(reparsed).toEqual(theme);
    }
  });
});

describe('themeCssVariables', () => {
  it('prefixes every key with --', () => {
    const theme = BUILT_IN_THEMES[0];
    if (!theme) throw new Error('no built-ins');
    const vars = themeCssVariables(theme);
    expect(vars['--bg']).toBe(theme.colors.bg);
    for (const key of Object.keys(vars)) expect(key.startsWith('--')).toBe(true);
  });

  it('fills unset keys from the built-in of the same appearance', () => {
    // A light theme under a dark OS must not inherit dark fallbacks for the
    // keys it leaves unset — that is the half-applied state the plan warns of.
    const sparse = { name: 'Sparse', appearance: 'light' as const, colors: { accent: '#ff0000' } };
    const vars = themeCssVariables(sparse);
    expect(vars['--accent']).toBe('#ff0000');
    expect(vars['--bg']).toBe('#fbfaf8');
    expect(vars['--fg']).toBe('#1c1b19');
  });
});

describe('resolveTheme', () => {
  it('finds a built-in case-insensitively', () => {
    expect(resolveTheme('dark')?.name).toBe('Dark');
  });

  it('returns null for the empty name — follow the system', () => {
    expect(resolveTheme('')).toBeNull();
  });

  it('returns null for an unknown name rather than guessing', () => {
    expect(resolveTheme('no such theme')).toBeNull();
  });

  it('lets a vault theme shadow a built-in of the same name', () => {
    const mine = { name: 'Dark', appearance: 'light' as const, colors: {} };
    expect(resolveTheme('Dark', [mine])).toBe(mine);
  });
});

describe('the built-ins', () => {
  it('have unique names and declare an appearance', () => {
    const names = BUILT_IN_THEMES.map((t) => t.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const theme of BUILT_IN_THEMES) {
      expect(['light', 'dark']).toContain(theme.appearance);
    }
  });

  it('set only whitelisted keys', () => {
    const allowed = new Set<string>(THEME_COLOR_KEYS);
    for (const theme of BUILT_IN_THEMES) {
      for (const key of Object.keys(theme.colors)) expect(allowed.has(key)).toBe(true);
    }
  });
});
