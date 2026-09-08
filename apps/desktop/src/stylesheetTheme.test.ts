import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILT_IN_THEMES, THEME_COLOR_KEYS } from '@open-note/core';
import { describe, expect, it } from 'vitest';

/**
 * The stylesheet and the built-in themes must agree.
 *
 * `styles.css` carries the palette for "follow the system", and the Light and
 * Dark built-ins restate it for "pin the appearance". Two copies of the same
 * numbers drift: change one and picking Light explicitly quietly looks
 * different from letting the OS pick it. Read as text because a `.css` file is
 * not importable here, and only the custom properties are of interest anyway.
 */
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');

/** The custom properties declared in one `{ ... }` block. */
function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) out[name] = value.trim();
  }
  return out;
}

function block(startsWith: string): string {
  const at = css.indexOf(startsWith);
  if (at < 0) throw new Error(`no ${startsWith} block in styles.css`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open, close);
}

const root = declarations(block(':root {'));
const darkOverrides = declarations(block('@media (prefers-color-scheme: dark)'));

function themed(name: string): Record<string, string> {
  const theme = BUILT_IN_THEMES.find((t) => t.name === name);
  if (!theme) throw new Error(`no built-in named ${name}`);
  return theme.colors;
}

describe('styles.css and the built-in themes', () => {
  it('declares the light palette exactly as the Light theme states it', () => {
    const light = themed('Light');
    for (const key of THEME_COLOR_KEYS) {
      expect(root[key], `--${key} in :root`).toBe(light[key]);
    }
  });

  it('declares the dark palette exactly as the Dark theme states it', () => {
    const dark = themed('Dark');
    for (const key of THEME_COLOR_KEYS) {
      // A key the dark block leaves out keeps its `:root` value — which is
      // only correct when the two themes agree on it.
      expect(darkOverrides[key] ?? root[key], `--${key} under prefers-color-scheme: dark`).toBe(
        dark[key],
      );
    }
  });

  it('paints text selection with the theme colour', () => {
    // Without this rule the OS highlight is used, which knows nothing about
    // the active theme — the readability bug themes alone cannot fix.
    expect(css).toMatch(/::selection\s*\{[^}]*background-color:\s*var\(--selection\)/);
  });
});
