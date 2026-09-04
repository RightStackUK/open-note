import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, KEYMAP_SCHEMES, resolveKeymap } from '@open-note/core';
import { describe, expect, it } from 'vitest';
import { MENU_EVENT, MENU_ONLY } from './menu';

/**
 * The application menu is built in Rust and handled in TypeScript, so the two
 * halves agree only by matching strings. Nothing fails loudly when they stop:
 * the menu item simply does nothing, which is indistinguishable from a menu
 * that was never wired up.
 *
 * Read as text for the same reason as the command-coverage check: importing
 * `App` drags in CodeMirror, Excalidraw and the Tauri bridge.
 */
const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
const menuSource = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'menu.rs'), 'utf8');
const libSource = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');

describe('application menu', () => {
  it('emits on the event the webview listens for', () => {
    expect(menuSource).toContain(`pub const MENU_EVENT: &str = "${MENU_EVENT}";`);
    expect(appSource).toContain('listen<MenuCommand>(MENU_EVENT');
  });

  it('names commands the frontend can dispatch', () => {
    const emitted = [...menuSource.matchAll(/command: "([\w.]+)"\.into\(\)/g)].map(
      (m) => m[1] as string,
    );
    expect(emitted.length).toBeGreaterThan(0);

    const declared = new Set(COMMANDS.map((c) => c.id));
    const menuOnly = new Set<string>(Object.values(MENU_ONLY));
    for (const command of emitted) {
      expect(
        declared.has(command) || menuOnly.has(command),
        `${command} is neither a declared command nor handled as a menu-only verb`,
      ).toBe(true);
    }
  });

  it('routes File → Open… through the command registry rather than beside it', () => {
    expect(menuSource).toContain('command: "vault.open"');
    expect(COMMANDS.some((c) => c.id === 'vault.open')).toBe(true);
  });

  it('backs every menu-only verb with a Rust emitter and a frontend branch', () => {
    for (const command of Object.values(MENU_ONLY)) {
      expect(menuSource, `${command} is never emitted`).toContain(`command: "${command}"`);
    }
    expect(appSource).toContain('MENU_ONLY.openRecent');
    expect(appSource).toContain('MENU_ONLY.clearRecents');
  });

  it('exposes the commands the menu items call back into', () => {
    for (const command of ['clear_recent_vaults', 'set_open_accelerator']) {
      // Declared *and* registered: an unregistered command compiles fine and
      // fails only at the call site, in the shell, at runtime.
      expect(libSource).toContain(`fn ${command}(`);
      expect(libSource).toMatch(new RegExp(`^\\s+${command},$`, 'm'));
    }
  });

  it('rebuilds the recents submenu from every path that changes the list', () => {
    // A submenu populated once at startup is wrong by the second vault opened.
    for (const command of ['fn open_vault', 'fn forget_vault', 'fn clear_recent_vaults']) {
      const body = libSource.slice(libSource.indexOf(command));
      expect(body.slice(0, body.indexOf('\n}')), `${command} does not refresh the menu`).toContain(
        'recents(&app)',
      );
    }
  });

  it('leaves no keymap scheme with two commands on one chord', () => {
    // `vault.open` defaults to the platform's Open chord, which the
    // alternative scheme already gives to the note switcher.
    for (const scheme of Object.keys(KEYMAP_SCHEMES)) {
      const resolved = resolveKeymap({ scheme, bindings: {} });
      expect(resolved.conflicts, `${scheme} scheme`).toEqual([]);
    }
  });
});
