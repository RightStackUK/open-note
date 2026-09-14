/**
 * Which notes a vault had open, per vault.
 *
 * Machine-local in `localStorage`, beside the pane widths and the tree's
 * expanded folders: which tabs are open is this machine's posture, and a
 * tracked file would have the sync engine commit and push every time you
 * opened a note.
 *
 * Only *paths* are stored. The content is read from disk on restore, because
 * the vault is a Git repository that anything else may have changed in the
 * meantime — a remembered buffer would be a stale copy presented as current.
 *
 * Previews and drawings are deliberately not remembered. An image is something
 * you glanced at, and restoring one means holding a blob URL for a file that
 * may be gone.
 *
 * Written by the window that **owns** the vault (see `windowVaults.ts`), so two
 * windows on one vault do not take turns overwriting each other's list.
 */
import type { PaneLayout, PaneSide } from './editorPanes';

export const OPEN_TABS_PREFIX = 'opennote:tabs:';

export function openTabsKey(root: string): string {
  return `${OPEN_TABS_PREFIX}${root}`;
}

export interface StoredTabs {
  /** Vault-relative note paths, in tab order. */
  left: string[];
  /** `null` means the window was not split. */
  right: string[] | null;
  focused: 'left' | 'right';
  activeLeft: number;
  activeRight: number;
}

export const NO_TABS: StoredTabs = {
  left: [],
  right: null,
  focused: 'left',
  activeLeft: 0,
  activeRight: 0,
};

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((path): path is string => typeof path === 'string' && path !== '');
}

function index(value: unknown, within: string[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  // A stored index past the end would render an empty pane while the strip
  // showed tabs, which reads as the app having lost the note.
  return Math.min(value, Math.max(0, within.length - 1));
}

/**
 * Read a stored set, degrading field by field.
 *
 * `localStorage` is hand-editable and outlives the version that wrote it, so
 * anything unreadable falls back to "no tabs" rather than failing the render —
 * the same rule the vault settings and the pane widths follow. A path that no
 * longer exists is dropped by the caller, which is the only one that knows
 * what the vault contains.
 */
export function parseOpenTabs(stored: string | null): StoredTabs {
  if (!stored) return { ...NO_TABS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { ...NO_TABS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...NO_TABS };
  const source = parsed as Record<string, unknown>;
  const left = paths(source.left);
  const right = source.right === null || source.right === undefined ? null : paths(source.right);
  return {
    left,
    // An empty second pane is not a split: restoring one would leave a divider
    // with nothing behind it.
    right: right && right.length > 0 ? right : null,
    focused: source.focused === 'right' && right && right.length > 0 ? 'right' : 'left',
    activeLeft: index(source.activeLeft, left),
    activeRight: index(source.activeRight, right ?? []),
  };
}

export function readOpenTabs(root: string): StoredTabs {
  try {
    return parseOpenTabs(localStorage.getItem(openTabsKey(root)));
  } catch {
    // Storage can be unavailable outright; an empty pane still renders.
    return { ...NO_TABS };
  }
}

/** Persist the list. Nothing open means "the default", so the key goes rather than sits. */
export function writeOpenTabs(root: string, tabs: StoredTabs): void {
  try {
    if (tabs.left.length === 0 && !tabs.right) {
      localStorage.removeItem(openTabsKey(root));
      return;
    }
    localStorage.setItem(openTabsKey(root), JSON.stringify(tabs));
  } catch {
    // Full or unavailable storage costs the window its memory, nothing more.
  }
}

/**
 * What to remember about a layout.
 *
 * Only note tabs survive, so the active index is the active tab's position
 * *among the notes* — with a preview active there is no such position, and 0 is
 * the honest answer rather than an index into a different list.
 */
export function storedFrom(layout: PaneLayout): StoredTabs {
  const notesIn = (side: PaneSide) => {
    const pane = side === 'left' ? layout.left : layout.right;
    if (!pane) return { paths: [], active: 0 };
    const paths: string[] = [];
    let active = 0;
    pane.tabs.forEach((tab, index) => {
      if (!tab.note) return;
      if (index === pane.active) active = paths.length;
      paths.push(tab.note.path);
    });
    return { paths, active };
  };

  const left = notesIn('left');
  const right = layout.right ? notesIn('right') : null;
  return {
    left: left.paths,
    right: right && right.paths.length > 0 ? right.paths : null,
    focused: layout.focused,
    activeLeft: left.active,
    activeRight: right?.active ?? 0,
  };
}
