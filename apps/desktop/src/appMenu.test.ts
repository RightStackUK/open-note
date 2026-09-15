import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, KEYMAP_SCHEMES, resolveKeymap } from '@open-note/core';
import { describe, expect, it } from 'vitest';
import { MENU_EVENT, MENU_ONLY, VIEW_MENU_COMMANDS } from './menu';

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

  it('routes File → Close … through the command registry rather than beside it', () => {
    expect(menuSource).toContain('command: "vault.close"');
    expect(COMMANDS.some((c) => c.id === 'vault.close')).toBe(true);
  });

  it('routes Check for Updates through the command registry', () => {
    expect(menuSource).toContain('command: "app.checkUpdates"');
    expect(COMMANDS.some((c) => c.id === 'app.checkUpdates')).toBe(true);
    expect(appSource).toContain("'app.checkUpdates':");
  });

  it('places Check for Updates beside About on every platform', () => {
    expect(menuSource).toContain('"Check for Updates…"');
    expect(menuSource).toMatch(
      /PredefinedMenuItem::about\(app, None, Some\(about\.clone\(\)\)\).*?&check_updates/s,
    );
    expect(menuSource).toMatch(/"Help".*?&check_updates.*?PredefinedMenuItem::about/s);
  });

  it('routes File → Import from Evernote… through the command registry', () => {
    expect(menuSource).toContain('command: "vault.importEnex"');
    expect(COMMANDS.some((c) => c.id === 'vault.importEnex')).toBe(true);
    expect(appSource).toContain("'vault.importEnex':");
  });

  it('leaves Import disabled until there is a vault to import into', () => {
    // An item that does nothing when clicked is the command-coverage failure
    // arrived at from the other direction, so it turns on with the same push
    // that names File → Close ….
    expect(menuSource).toMatch(/IMPORT_ENEX,\s*"Import from Evernote…",\s*false/);
    expect(menuSource).toMatch(/ImportItem<R>>\(\) \{\s*state\.0\.clone\(\)\.set_enabled/);
  });

  it('names File → Close … after a vault rather than leaving it generic', () => {
    // The label is the whole point of the item: with several vaults open,
    // "Close Vault" does not say which one is about to go.
    expect(menuSource).toContain('format!("Close {name}")');
    // And it is disabled until there is something to close, rather than
    // offering to close nothing on first run.
    expect(menuSource).toContain('MenuItem::with_id(app, CLOSE, "Close Vault", false');
  });

  it('backs every menu-only verb with a Rust emitter and a frontend branch', () => {
    for (const command of Object.values(MENU_ONLY)) {
      expect(menuSource, `${command} is never emitted`).toContain(`command: "${command}"`);
    }
    expect(appSource).toContain('MENU_ONLY.openRecent');
    expect(appSource).toContain('MENU_ONLY.clearRecents');
  });

  it('exposes the commands the menu items call back into', () => {
    for (const command of ['clear_recent_vaults', 'set_open_accelerator', 'set_close_target']) {
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

  it('builds every View item from a declared command with a frontend handler', () => {
    // The View items dispatch their menu id as a command id, so an id that is
    // not declared, or declared but unhandled, is a menu item that does
    // nothing — silently.
    const declared = new Set(COMMANDS.map((c) => c.id));
    for (const id of VIEW_MENU_COMMANDS) {
      expect(declared.has(id), `${id} is not a declared command`).toBe(true);
      expect(appSource, `${id} has no handler in App`).toContain(`'${id}':`);
    }
  });

  it('lists the same View commands in the Rust half, in the same order', () => {
    // The two halves agree only by matching strings, like the rest of the
    // menu; this is the check that they go on matching.
    const rust = [...menuSource.matchAll(/\("(view\.[\w.]+)", "/g)].map((m) => m[1] as string);
    expect(rust).toEqual([...VIEW_MENU_COMMANDS]);
  });

  it('turns the vault-dependent View items on with the push that names Close', () => {
    expect(menuSource).toMatch(/ViewMenu<R>>\(\)[\s\S]*?set_enabled\(name\.is_some\(\)\)/);
  });

  it('pushes View accelerators from the webview rather than declaring them', () => {
    // An accelerator declared in Rust would go stale after a rebind and
    // swallow the chord from whatever it moved to — the Open… reasoning.
    for (const command of ['set_view_accelerators']) {
      expect(libSource).toContain(`fn ${command}(`);
      expect(libSource).toMatch(new RegExp(`^\\s+${command},$`, 'm'));
    }
    expect(appSource).toContain('setViewAccelerators');
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
