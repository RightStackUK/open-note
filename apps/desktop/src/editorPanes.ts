/**
 * One or two editor panes, each with its own tabs, one of them focused.
 *
 * The window used to hold exactly one open note, and autosave, the history
 * panel, backlinks and wikilink navigation all keyed off it. Rather than teach
 * every one of those which document it is talking about, they all talk to the
 * **focused pane's active tab**: this module owns which that is, so a consumer
 * asking for "the open note" keeps asking one question and gets the right
 * answer.
 *
 * Tabs belong to the pane rather than to the window. A split pane is a second
 * place to read, so it needs its own set of open notes — and it keeps the
 * question "which pane does this tab click land in?" from arising at all.
 *
 * The state lives here, as plain functions over a value, because the
 * interesting rules — what splitting does, what closing promotes, where a
 * document lands — are worth testing without a window.
 */

export type PaneSide = 'left' | 'right';

export interface OpenNote {
  /**
   * The vault this document came from.
   *
   * Carried on the note rather than read from `activeRoot` at write time: a
   * queued autosave outlives a vault switch, and without this it would land in
   * whichever vault happened to be active when the timer fired.
   */
  root: string;
  path: string;
  doc: string;
  /**
   * Which editor to use. A vault holds ordinary files as well as notes, and a
   * `.ts` wants line numbers and a monospace face, not a serif measure.
   */
  kind: 'markdown' | 'text';
  /** Bumped to force the editor to reload, e.g. after an upstream change. */
  revision: number;
}

/** An image or PDF, shown rather than edited. */
export interface OpenPreview {
  path: string;
  url: string;
  kind: 'image' | 'pdf';
}

export interface OpenDrawing {
  path: string;
  source: string;
}

/**
 * One open document. At most one of the three is set; they are separate fields
 * rather than a union because that is how the surfaces that render them already
 * ask.
 */
export interface Tab {
  note: OpenNote | null;
  preview: OpenPreview | null;
  drawing: OpenDrawing | null;
}

export interface Pane {
  tabs: Tab[];
  /** Index into `tabs`. Meaningless, and ignored, when there are none. */
  active: number;
}

export interface PaneLayout {
  left: Pane;
  /** `null` is an unsplit window: splitting is what brings a second pane into being. */
  right: Pane | null;
  focused: PaneSide;
}

export const EMPTY_TAB: Tab = { note: null, preview: null, drawing: null };
export const EMPTY_PANE: Pane = { tabs: [], active: 0 };

export function initialLayout(): PaneLayout {
  return { left: EMPTY_PANE, right: null, focused: 'left' };
}

export function isSplit(layout: PaneLayout): boolean {
  return layout.right !== null;
}

/** Left to right, so rendering and cycling agree on the order. */
export function sides(layout: PaneLayout): PaneSide[] {
  return layout.right ? ['left', 'right'] : ['left'];
}

export function otherSide(side: PaneSide): PaneSide {
  return side === 'left' ? 'right' : 'left';
}

/**
 * The pane on `side`, or an empty one.
 *
 * An empty pane rather than null for the closed side: a caller reading "what is
 * the right pane showing" while unsplit means "nothing", and every consumer
 * having to null-check a side that cannot be focused buys nothing.
 */
export function paneAt(layout: PaneLayout, side: PaneSide): Pane {
  return (side === 'left' ? layout.left : layout.right) ?? EMPTY_PANE;
}

export function focusedPane(layout: PaneLayout): Pane {
  return paneAt(layout, layout.focused);
}

/** The document a pane is showing. */
export function activeTab(pane: Pane): Tab {
  return pane.tabs[pane.active] ?? EMPTY_TAB;
}

/** The document on a side; `EMPTY_TAB` when that pane has nothing open. */
export function tabAt(layout: PaneLayout, side: PaneSide): Tab {
  return activeTab(paneAt(layout, side));
}

/** What everything outside this module means by "the open note". */
export function focusedTab(layout: PaneLayout): Tab {
  return activeTab(focusedPane(layout));
}

/** Replace one pane. A write to a closed right pane is dropped, not resurrected. */
export function setPane(layout: PaneLayout, side: PaneSide, pane: Pane): PaneLayout {
  if (side === 'left') return { ...layout, left: pane };
  if (!layout.right) return layout;
  return { ...layout, right: pane };
}

export function updatePane(
  layout: PaneLayout,
  side: PaneSide,
  change: (pane: Pane) => Pane,
): PaneLayout {
  return setPane(layout, side, change(paneAt(layout, side)));
}

/**
 * Open the second pane, empty and focused.
 *
 * Empty rather than a copy of what you were reading, because a document lives
 * in at most one tab in one pane — see `locate`. The empty pane already offers
 * the "what next" actions a new vault shows, which is the right prompt for a
 * pane you just made.
 */
export function split(layout: PaneLayout): PaneLayout {
  if (layout.right) return { ...layout, focused: 'right' };
  return { ...layout, right: EMPTY_PANE, focused: 'right' };
}

/**
 * Close a pane. The survivor keeps its tabs and takes focus.
 *
 * Closing the left pane promotes the right one rather than discarding it: the
 * pane you closed is the one you pointed at, and losing the *other* pane's
 * notes would be the opposite of what you asked for.
 */
export function closePane(layout: PaneLayout, side: PaneSide): PaneLayout {
  if (!layout.right) return layout;
  const surviving = side === 'left' ? layout.right : layout.left;
  return { left: surviving, right: null, focused: 'left' };
}

export function focus(layout: PaneLayout, side: PaneSide): PaneLayout {
  if (layout.focused === side) return layout;
  if (side === 'right' && !layout.right) return layout;
  return { ...layout, focused: side };
}

export function focusOther(layout: PaneLayout): PaneLayout {
  return focus(layout, otherSide(layout.focused));
}

/** What a tab is showing, whichever kind of thing it is. */
export function tabPath(tab: Tab): string | null {
  return tab.note?.path ?? tab.preview?.path ?? tab.drawing?.path ?? null;
}

/** The vault a tab belongs to, when it is one that carries its root. */
export function tabRoot(tab: Tab): string | null {
  return tab.note?.root ?? null;
}

/**
 * Where `path` is already open, if anywhere.
 *
 * The rule this exists for: a document lives in at most one tab, in one pane.
 * Opening it again activates that tab rather than making a second copy. Two
 * editors over one file would each hold their own buffer and take turns
 * overwriting the other's autosave — the note fighting itself, which no amount
 * of care at the write end can fix.
 *
 * Previews and drawings are matched on path alone: they carry no root because
 * they are always the active vault's, and each vault has its own layout.
 */
export function locate(
  layout: PaneLayout,
  root: string,
  path: string,
): { side: PaneSide; index: number } | null {
  for (const side of sides(layout)) {
    const { tabs } = paneAt(layout, side);
    const index = tabs.findIndex((tab) =>
      tab.note ? tab.note.root === root && tab.note.path === path : tabPath(tab) === path,
    );
    if (index !== -1) return { side, index };
  }
  return null;
}

/**
 * Open a document in a pane, or refresh and activate the tab it already has.
 *
 * A new tab lands immediately after the active one, not at the end: following a
 * link puts what you followed next to where you came from, which is how the
 * strip stays readable after a few hops.
 */
export function openTab(layout: PaneLayout, side: PaneSide, tab: Tab): PaneLayout {
  const path = tabPath(tab);
  return focus(
    updatePane(layout, side, (pane) => {
      const existing = pane.tabs.findIndex((open) => tabPath(open) === path);
      if (existing !== -1) {
        const tabs = [...pane.tabs];
        tabs[existing] = tab;
        return { tabs, active: existing };
      }
      const at = pane.tabs.length === 0 ? 0 : Math.min(pane.active + 1, pane.tabs.length);
      const tabs = [...pane.tabs.slice(0, at), tab, ...pane.tabs.slice(at)];
      return { tabs, active: at };
    }),
    side,
  );
}

/**
 * Close one tab.
 *
 * Focus moves to the tab that slides into its place — the one to its right —
 * falling back to the new last tab. Closing the tab you are on should leave you
 * somewhere, and the right neighbour is where the eye already is.
 */
export function closeTab(layout: PaneLayout, side: PaneSide, index: number): PaneLayout {
  return updatePane(layout, side, (pane) => {
    if (index < 0 || index >= pane.tabs.length) return pane;
    const tabs = pane.tabs.filter((_, i) => i !== index);
    if (tabs.length === 0) return EMPTY_PANE;
    const active =
      index < pane.active
        ? pane.active - 1
        : index === pane.active
          ? Math.min(index, tabs.length - 1)
          : pane.active;
    return { tabs, active };
  });
}

/** Close whichever tab holds a document, wherever it is. For a delete or a move. */
export function closeTabFor(layout: PaneLayout, root: string, path: string): PaneLayout {
  const found = locate(layout, root, path);
  return found ? closeTab(layout, found.side, found.index) : layout;
}

export function activateTab(layout: PaneLayout, side: PaneSide, index: number): PaneLayout {
  const pane = paneAt(layout, side);
  if (index < 0 || index >= pane.tabs.length) return layout;
  return focus(setPane(layout, side, { ...pane, active: index }), side);
}

/** Next or previous tab in a pane, wrapping. `delta` is +1 or -1. */
export function cycleTab(layout: PaneLayout, side: PaneSide, delta: number): PaneLayout {
  const pane = paneAt(layout, side);
  if (pane.tabs.length < 2) return layout;
  const next = (pane.active + delta + pane.tabs.length) % pane.tabs.length;
  return activateTab(layout, side, next);
}

/** Change the active tab of a pane in place. */
export function updateActiveTab(
  layout: PaneLayout,
  side: PaneSide,
  change: (tab: Tab) => Tab,
): PaneLayout {
  return updatePane(layout, side, (pane) => {
    if (pane.tabs.length === 0) return pane;
    const tabs = [...pane.tabs];
    tabs[pane.active] = change(tabs[pane.active] ?? EMPTY_TAB);
    return { ...pane, tabs };
  });
}

/**
 * Adopt text that has just been written to disk into the tab holding it.
 *
 * Addressed by document rather than by focus: the write may well have come from
 * a tab you are no longer looking at, and the counters, the outline and an
 * export all read the note's text from here.
 *
 * `remount` bumps the revision, which is in the editor's React key — for a
 * change that came from outside the editor, where the buffer has to be replaced
 * rather than caught up.
 */
export function adoptDoc(
  layout: PaneLayout,
  root: string,
  path: string,
  doc: string,
  remount = false,
): PaneLayout {
  const found = locate(layout, root, path);
  if (!found) return layout;
  const pane = paneAt(layout, found.side);
  const tab = pane.tabs[found.index];
  const open = tab?.note;
  if (!tab || !open) return layout;
  if (open.doc === doc && !remount) return layout;
  const tabs = [...pane.tabs];
  tabs[found.index] = {
    ...tab,
    note: { ...open, doc, revision: open.revision + (remount ? 1 : 0) },
  };
  return setPane(layout, found.side, { ...pane, tabs });
}

/** Every note open in the layout, left to right. For restoring and for saving. */
export function openNotes(layout: PaneLayout): OpenNote[] {
  return sides(layout).flatMap((side) =>
    paneAt(layout, side)
      .tabs.map((tab) => tab.note)
      .filter((note): note is OpenNote => note !== null),
  );
}

/**
 * Key for the per-document autosave buffer.
 *
 * A newline separates the two halves because it cannot appear in either: a
 * naive `root:path` would collide between a vault named `a` holding `b/c` and
 * one named `a/b` holding `c`.
 */
export function docKey(root: string, path: string): string {
  return `${root}\n${path}`;
}
