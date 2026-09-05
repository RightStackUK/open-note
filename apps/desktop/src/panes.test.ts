import { describe, expect, it } from 'vitest';
import { PANE_DEFAULTS, PANE_LIMITS, parsePaneWidths } from './panes';

/**
 * These widths are hand-editable and outlive the version that wrote them, so
 * the parse degrades field by field — the same rule the vault settings follow.
 * A pane that cannot be laid out has no divider left to drag back.
 */
describe('parsePaneWidths', () => {
  it('uses the defaults when nothing is stored', () => {
    expect(parsePaneWidths(null)).toEqual(PANE_DEFAULTS);
  });

  it('reads stored widths back', () => {
    const stored = JSON.stringify({ sidebar: 200, list: 300, panel: 400 });
    expect(parsePaneWidths(stored)).toEqual({ sidebar: 200, list: 300, panel: 400 });
  });

  it('keeps the good fields when one is unreadable', () => {
    const stored = JSON.stringify({ sidebar: 200, list: 'wide', panel: 400 });
    expect(parsePaneWidths(stored)).toEqual({
      sidebar: 200,
      list: PANE_DEFAULTS.list,
      panel: 400,
    });
  });

  it('clamps a width that would swallow the editor', () => {
    const stored = JSON.stringify({ sidebar: 99999, list: 296, panel: 320 });
    expect(parsePaneWidths(stored).sidebar).toBe(PANE_LIMITS.sidebar.max);
  });

  it('clamps a width that would collapse the pane', () => {
    const stored = JSON.stringify({ sidebar: 0, list: 296, panel: 320 });
    expect(parsePaneWidths(stored).sidebar).toBe(PANE_LIMITS.sidebar.min);
  });

  it('rejects numbers that cannot be laid out', () => {
    // JSON has no NaN or Infinity, but a hand-edited null arrives as one.
    expect(parsePaneWidths('{"sidebar":null}').sidebar).toBe(PANE_DEFAULTS.sidebar);
  });

  it('falls back whole when the value is not an object', () => {
    expect(parsePaneWidths('"248"')).toEqual(PANE_DEFAULTS);
    expect(parsePaneWidths('not json')).toEqual(PANE_DEFAULTS);
  });
});
