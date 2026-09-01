/**
 * Themes: a name, whether it is light or dark, and a flat map of the CSS
 * variables the app already uses.
 *
 * Vault themes live in `.opennote/themes/*.json`, so they sync, version and
 * can be shared like notes. Built-ins ship as the same shape, so there is
 * exactly one code path from "a theme" to "colours on screen".
 */

export type ThemeAppearance = 'light' | 'dark';

export interface Theme {
  name: string;
  /** Drives `color-scheme` and the native window chrome. */
  appearance: ThemeAppearance;
  /** Variable name (without the `--`) to colour value. */
  colors: Record<string, string>;
}

/**
 * The variables a theme may set.
 *
 * A whitelist because a vault can be cloned from anywhere: a theme file is
 * untrusted input, and it gets to recolour the app, not to define arbitrary
 * custom properties that selectors elsewhere might consume in surprising ways.
 */
export const THEME_COLOR_KEYS = [
  'bg',
  'bg-raised',
  'fg',
  'muted',
  'border',
  'accent',
  'selection',
  'code-bg',
  'danger',
  'success',
  'on-accent',
  'shadow',
  'shadow-base',
  'code-string',
  'code-literal',
  'code-callable',
  'code-type',
  'code-property',
] as const;

const KEY_SET = new Set<string>(THEME_COLOR_KEYS);

/**
 * A CSS colour value, conservatively.
 *
 * Hex, rgb/hsl/oklch functions, color-mix and bare keywords all pass; anything
 * with the machinery to reach further than a colour — semicolons, braces,
 * `url(`, `var(` — does not. `style.setProperty` cannot be escaped by a value,
 * but a theme that plays games deserves to lose the game quietly.
 */
const COLOR_VALUE = /^[\w#%(),.\s/-]+$/;

function isColorValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    COLOR_VALUE.test(value) &&
    !/url\s*\(|var\s*\(/i.test(value)
  );
}

/**
 * Parse one theme file. Returns null only when the file is unusable — no name
 * or no valid appearance. Unknown keys and malformed colours are dropped
 * field by field, like every other hand-editable file the app reads.
 */
export function parseTheme(raw: string): Theme | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, 60) : '';
  if (!name) return null;
  const appearance =
    record.appearance === 'dark' ? 'dark' : record.appearance === 'light' ? 'light' : null;
  if (!appearance) return null;

  const colors: Record<string, string> = {};
  if (typeof record.colors === 'object' && record.colors !== null) {
    for (const [key, value] of Object.entries(record.colors as Record<string, unknown>)) {
      if (KEY_SET.has(key) && isColorValue(value)) colors[key] = value;
    }
  }

  return { name, appearance, colors };
}

/**
 * The theme's colours as ready-to-apply CSS custom properties.
 *
 * Keys the theme does not set are filled from the built-in of the same
 * appearance. Without this a light theme under a dark OS would inherit the
 * *dark* stylesheet fallbacks for whatever it left unset — the half-applied
 * state the plan calls out. A theme declares its appearance precisely so the
 * gaps can be filled from the right side.
 */
export function themeCssVariables(theme: Theme): Record<string, string> {
  const base = BUILT_IN_THEMES.find((t) => t.appearance === theme.appearance);
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base?.colors, ...theme.colors })) {
    if (KEY_SET.has(key)) vars[`--${key}`] = value;
  }
  return vars;
}

/**
 * Built-in themes.
 *
 * Light and Dark restate the stylesheet's own palette so that picking them
 * explicitly pins the appearance instead of following the OS. The others are
 * deliberately few — themes are meant to come from the vault.
 */
export const BUILT_IN_THEMES: Theme[] = [
  {
    name: 'Light',
    appearance: 'light',
    colors: {
      bg: '#fbfaf8',
      'bg-raised': '#f3f1ed',
      fg: '#1c1b19',
      muted: '#85807a',
      border: '#e2ded7',
      accent: '#c2410c',
      selection: '#f8d9c6',
      'code-bg': '#ece8e1',
      danger: '#b91c1c',
      success: '#2f855a',
      'on-accent': '#fff',
      shadow: 'rgb(0 0 0 / 38%)',
      'shadow-base': '#000',
      'code-string': '#0f766e',
      'code-literal': '#a16207',
      'code-callable': '#1d4ed8',
      'code-type': '#7c3aed',
      'code-property': '#b45309',
    },
  },
  {
    name: 'Dark',
    appearance: 'dark',
    colors: {
      bg: '#171614',
      'bg-raised': '#1f1e1b',
      fg: '#eae7e2',
      muted: '#8b857e',
      border: '#302e2a',
      accent: '#fb923c',
      selection: '#45301f',
      'code-bg': '#26241f',
      danger: '#f87171',
      success: '#57b98a',
      'on-accent': '#1c1207',
      shadow: 'rgb(0 0 0 / 55%)',
      'shadow-base': '#000',
      'code-string': '#5eead4',
      'code-literal': '#fcd34d',
      'code-callable': '#93c5fd',
      'code-type': '#c4b5fd',
      'code-property': '#fbbf24',
    },
  },
  {
    name: 'Sepia',
    appearance: 'light',
    colors: {
      bg: '#f6efe2',
      'bg-raised': '#eee4d2',
      fg: '#3d3427',
      muted: '#8a7d68',
      border: '#ddd0ba',
      accent: '#9a5b2d',
      selection: '#ecd9bb',
      'code-bg': '#eadfc9',
      danger: '#a03a2e',
      'code-string': '#3f6f5f',
      'code-literal': '#8a6a1f',
      'code-callable': '#4a5f8a',
      'code-type': '#6f5a8a',
      'code-property': '#8a5f2d',
    },
  },
  {
    name: 'Slate',
    appearance: 'dark',
    colors: {
      bg: '#0f172a',
      'bg-raised': '#1e293b',
      fg: '#e2e8f0',
      muted: '#94a3b8',
      border: '#334155',
      accent: '#38bdf8',
      selection: '#164e63',
      'code-bg': '#1e293b',
      danger: '#f87171',
      'code-string': '#5eead4',
      'code-literal': '#fde68a',
      'code-callable': '#93c5fd',
      'code-type': '#c4b5fd',
      'code-property': '#fbbf24',
    },
  },
];

/**
 * The theme a settings value names, or null for "follow the system".
 *
 * Vault themes are searched first so someone can override a built-in by
 * shipping a theme with the same name — their file, their call.
 */
export function resolveTheme(name: string, vaultThemes: Theme[] = []): Theme | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return (
    vaultThemes.find((t) => t.name.toLowerCase() === wanted) ??
    BUILT_IN_THEMES.find((t) => t.name.toLowerCase() === wanted) ??
    null
  );
}
