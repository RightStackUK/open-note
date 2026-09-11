/**
 * Two editor panes, one of them focused.
 *
 * The window used to hold exactly one open note, and autosave, the history
 * panel, backlinks and wikilink navigation all keyed off it. Rather than teach
 * every one of those which pane it is talking about, they all talk to the
 * **focused** pane: this module owns which pane that is, so a consumer asking
 * for "the open note" keeps asking one question and gets the right answer.
 *
 * The state lives here, as plain functions over a value, because the
 * interesting rules — what splitting does, what closing a pane promotes, where
 * a document lands — are worth testing without a window.
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
 * What one pane is showing. At most one of the three is set; they are separate
 * fields rather than a union because that is how the surfaces that render them
 * already ask.
 */
export interface Pane {
  note: OpenNote | null;
  preview: OpenPreview | null;
  drawing: OpenDrawing | null;
}

export interface PaneLayout {
  left: Pane;
  /** `null` is an unsplit window: splitting is what brings a second pane into being. */
  right: Pane | null;
  focused: PaneSide;
}

export const EMPTY_PANE: Pane = { note: null, preview: null, drawing: null };

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
 * Empty rather than a copy of what you were reading, because a note lives in
 * at most one pane — see `sideShowing`. The empty pane already offers the
 * "what next" actions a new vault shows, which is the right prompt for a pane
 * you just made.
 */
export function split(layout: PaneLayout): PaneLayout {
  if (layout.right) return { ...layout, focused: 'right' };
  return { ...layout, right: EMPTY_PANE, focused: 'right' };
}

/**
 * Close a pane. The survivor keeps what it was showing and takes focus.
 *
 * Closing the left pane promotes the right one's content rather than discarding
 * it: the pane you closed is the one you pointed at, and losing the *other*
 * pane's note would be the opposite of what you asked for.
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

/** What a pane is showing, whichever kind of thing it is. */
export function pathIn(pane: Pane): string | null {
  return pane.note?.path ?? pane.preview?.path ?? pane.drawing?.path ?? null;
}

/**
 * Which pane already shows `path`, if any.
 *
 * The rule this exists for: a note lives in at most one pane, and opening it
 * again moves focus there instead of making a second copy. Two editors over one
 * file would each hold their own buffer and take turns overwriting the other's
 * autosave — the note fighting itself, which no amount of care at the write
 * end can fix.
 *
 * Previews and drawings are matched on path alone: they carry no root because
 * they are always the active vault's, and switching vaults clears both panes.
 */
export function sideShowing(layout: PaneLayout, root: string, path: string): PaneSide | null {
  for (const side of sides(layout)) {
    const pane = paneAt(layout, side);
    if (pane.note) {
      if (pane.note.root === root && pane.note.path === path) return side;
      continue;
    }
    if (pathIn(pane) === path) return side;
  }
  return null;
}

/**
 * Adopt text that has just been written to disk into every pane showing it.
 *
 * Addressed by document rather than by focus: the write may well have come from
 * the pane you are no longer looking at, and the counters, the outline and an
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
  let next = layout;
  for (const side of sides(layout)) {
    const pane = paneAt(next, side);
    const open = pane.note;
    if (!open || open.root !== root || open.path !== path) continue;
    if (open.doc === doc && !remount) continue;
    next = setPane(next, side, {
      ...pane,
      note: { ...open, doc, revision: open.revision + (remount ? 1 : 0) },
    });
  }
  return next;
}

/** Empty every pane, keeping the split itself. A vault switch is a fresh start. */
export function clearAll(layout: PaneLayout): PaneLayout {
  return {
    left: EMPTY_PANE,
    right: layout.right ? EMPTY_PANE : null,
    focused: layout.focused,
  };
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
