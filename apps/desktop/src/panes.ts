/**
 * Pane widths, in px.
 *
 * Machine-local, in `localStorage` beside which panes are shown: how wide the
 * tree is depends on the screen in front of you, not on the vault, so this must
 * not travel in `.opennote/` to a laptop with a different display.
 */
export interface PaneWidths {
  sidebar: number;
  list: number;
  panel: number;
}

/** Also what a double-click on a divider restores. */
export const PANE_DEFAULTS: PaneWidths = { sidebar: 248, list: 296, panel: 320 };

/**
 * How far each pane can be dragged.
 *
 * The minimums are the point below which the pane stops being usable rather
 * than merely narrow; the maximums stop a drag from swallowing the editor,
 * which cannot be recovered by dragging back if the divider has gone off-screen.
 */
export const PANE_LIMITS: Record<keyof PaneWidths, { min: number; max: number }> = {
  sidebar: { min: 150, max: 560 },
  list: { min: 200, max: 640 },
  panel: { min: 200, max: 640 },
};

export const PANE_WIDTHS_KEY = 'opennote:pane:widths';

function clamp(pane: keyof PaneWidths, value: unknown): number {
  const { min, max } = PANE_LIMITS[pane];
  // Rejecting NaN and Infinity as well as the wrong type: a stored width the
  // browser cannot lay out would collapse the pane with no way back.
  if (typeof value !== 'number' || !Number.isFinite(value)) return PANE_DEFAULTS[pane];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Read the stored widths, degrading field by field.
 *
 * `localStorage` is hand-editable and survives across versions, so anything
 * unreadable falls back to that pane's default rather than failing the render.
 * One bad number must not cost the other two panes their width.
 */
export function parsePaneWidths(stored: string | null): PaneWidths {
  if (!stored) return { ...PANE_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { ...PANE_DEFAULTS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...PANE_DEFAULTS };
  const source = parsed as Partial<Record<keyof PaneWidths, unknown>>;
  return {
    sidebar: clamp('sidebar', source.sidebar),
    list: clamp('list', source.list),
    panel: clamp('panel', source.panel),
  };
}

export function readPaneWidths(): PaneWidths {
  try {
    return parsePaneWidths(localStorage.getItem(PANE_WIDTHS_KEY));
  } catch {
    // Storage can be unavailable outright; a default layout still renders.
    return { ...PANE_DEFAULTS };
  }
}
