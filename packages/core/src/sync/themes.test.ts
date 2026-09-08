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

/**
 * WCAG relative luminance and contrast, from the definitions in WCAG 2.2.
 *
 * Only hex is handled: every built-in colour is hex on purpose, and the audit
 * below asserts that, so a colour it cannot measure fails loudly rather than
 * slipping through unmeasured.
 */
function channels(color: string): [number, number, number] {
  const hex = color.replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour, the surfaces it is drawn on, and the ratio it must clear. */
const CONTRAST_RULES: Array<{ fg: string; on: string[]; min: number }> = [
  // Body text: AAA, because a notes app is read for hours at a time.
  { fg: 'fg', on: ['bg', 'bg-raised', 'code-bg', 'selection'], min: 7 },
  // Secondary text, links and status text: AA.
  { fg: 'muted', on: ['bg', 'bg-raised', 'selection'], min: 4.5 },
  { fg: 'accent', on: ['bg', 'bg-raised'], min: 4.5 },
  { fg: 'danger', on: ['bg', 'bg-raised'], min: 4.5 },
  { fg: 'success', on: ['bg', 'bg-raised'], min: 4.5 },
  { fg: 'on-accent', on: ['accent'], min: 4.5 },
  { fg: 'code-string', on: ['code-bg'], min: 4.5 },
  { fg: 'code-literal', on: ['code-bg'], min: 4.5 },
  { fg: 'code-callable', on: ['code-bg'], min: 4.5 },
  { fg: 'code-type', on: ['code-bg'], min: 4.5 },
  { fg: 'code-property', on: ['code-bg'], min: 4.5 },
  // A link inside a selection is still a link. Accents are saturated and the
  // selection is a wash of one, so this is the 3:1 non-text floor, not 4.5.
  { fg: 'accent', on: ['selection'], min: 3 },
];

describe('built-in theme contrast', () => {
  /**
   * The palette a theme actually renders with — its own colours over the
   * built-in of the same appearance, exactly as the app applies them. Sepia
   * and Slate leave keys unset, and the inherited value is what a reader sees.
   */
  const resolved = (theme: (typeof BUILT_IN_THEMES)[number]) =>
    Object.fromEntries(
      Object.entries(themeCssVariables(theme)).map(([key, value]) => [key.slice(2), value]),
    );

  for (const theme of BUILT_IN_THEMES) {
    describe(theme.name, () => {
      const colors = resolved(theme);

      it('states every colour as hex, so the audit can measure it', () => {
        for (const [key, value] of Object.entries(colors)) {
          // Shadows are alpha over an unknown backdrop; contrast does not apply.
          if (key.startsWith('shadow')) continue;
          expect(value, `${theme.name}.${key}`).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        }
      });

      for (const rule of CONTRAST_RULES) {
        for (const surface of rule.on) {
          it(`reads ${rule.fg} on ${surface}`, () => {
            const fg = colors[rule.fg];
            const bg = colors[surface];
            if (!fg || !bg) throw new Error(`${theme.name} resolves no ${rule.fg}/${surface}`);
            const ratio = contrast(fg, bg);
            expect(
              Number(ratio.toFixed(2)),
              `${theme.name}: ${rule.fg} on ${surface} is ${ratio.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(rule.min);
          });
        }
      }

      it('keeps the selection visible against the page', () => {
        // The other half of the selection problem: a wash subtle enough to
        // keep muted text legible can stop reading as a highlight at all.
        const bg = colors.bg;
        const selection = colors.selection;
        if (!bg || !selection) throw new Error(`${theme.name} resolves no bg/selection`);
        expect(contrast(bg, selection)).toBeGreaterThan(1.15);
      });
    });
  }
});
