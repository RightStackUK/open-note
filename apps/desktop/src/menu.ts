/**
 * The webview half of the application menu.
 *
 * The menu itself is built in Rust (`src-tauri/src/menu.rs`) because that is
 * where the platform menu lives, but it performs nothing: every item we add
 * emits one event, and this is what it says. Opening a vault means starting a
 * session and refreshing state, which lives here.
 */
export const MENU_EVENT = 'menu://command';

/**
 * Items that map onto a `COMMANDS` id dispatch through the registry, so the
 * menu is not a second dispatcher. These two cannot: "open *this* vault" takes
 * an argument, which a registry command has no shape for, and neither is
 * something you would bind a key to or look for in the palette.
 */
export const MENU_ONLY = {
  openRecent: 'vault.openRecent',
  clearRecents: 'vault.clearRecents',
} as const;

export interface MenuCommand {
  command: string;
  arg?: string;
}
