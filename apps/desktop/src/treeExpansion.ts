/**
 * Which folders of the note tree are expanded, per vault.
 *
 * Machine-local in `localStorage`, beside the pane layout rather than in
 * `.opennote/settings.json`: a caret click is a reading posture, and a tracked
 * file would have the sync engine commit and push on every toggle, then have
 * two machines argue about the result.
 *
 * Folders start collapsed, so what is stored is the *expanded* set — the
 * exceptions. Storing the collapsed set instead would mean writing down every
 * folder in the vault to express the default.
 *
 * Keyed by vault root, so each repo is remembered on its own.
 */
export const EXPANDED_PREFIX = 'opennote:tree:expanded:';

export function expandedKey(root: string): string {
  return `${EXPANDED_PREFIX}${root}`;
}

/**
 * Read a stored set, degrading entry by entry.
 *
 * `localStorage` is hand-editable and outlives the version that wrote it, so
 * anything that is not a path is dropped and the rest is kept — the same rule
 * the vault settings and the pane widths follow. A folder that has since been
 * renamed or deleted is simply a path nothing matches, which costs nothing.
 */
export function parseExpanded(stored: string | null): Set<string> {
  if (!stored) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((path): path is string => typeof path === 'string' && path !== ''));
}

export function readExpanded(root: string): Set<string> {
  try {
    return parseExpanded(localStorage.getItem(expandedKey(root)));
  } catch {
    // Storage can be unavailable outright; a collapsed tree still renders.
    return new Set();
  }
}

/** Persist the set. Empty means "the default", so the key goes rather than sits. */
export function writeExpanded(root: string, expanded: Set<string>): void {
  try {
    if (expanded.size === 0) localStorage.removeItem(expandedKey(root));
    else localStorage.setItem(expandedKey(root), JSON.stringify([...expanded]));
  } catch {
    // Full or unavailable storage costs the tree its memory, nothing more.
  }
}
