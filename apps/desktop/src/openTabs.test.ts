import { beforeEach, describe, expect, it } from 'vitest';
import { initialLayout, openTab, type PaneLayout, split } from './editorPanes';
import {
  NO_TABS,
  openTabsKey,
  parseOpenTabs,
  readOpenTabs,
  storedFrom,
  writeOpenTabs,
} from './openTabs';

const noteTab = (path: string) => ({
  note: { root: '/vault', path, doc: '', kind: 'markdown' as const, revision: 0 },
  preview: null,
  drawing: null,
});

/**
 * Hand-editable and outliving the version that wrote it, like the pane widths
 * and the vault settings. Nothing here may throw: a bad value costs the window
 * its remembered tabs, never its render.
 */
describe('parseOpenTabs', () => {
  it('treats a first run as nothing open', () => {
    expect(parseOpenTabs(null)).toEqual(NO_TABS);
    expect(parseOpenTabs('{ not json')).toEqual(NO_TABS);
    expect(parseOpenTabs('"a string"')).toEqual(NO_TABS);
  });

  it('reads a split window back', () => {
    const stored = JSON.stringify({
      left: ['a.md', 'b.md'],
      right: ['c.md'],
      focused: 'right',
      activeLeft: 1,
      activeRight: 0,
    });
    expect(parseOpenTabs(stored)).toEqual({
      left: ['a.md', 'b.md'],
      right: ['c.md'],
      focused: 'right',
      activeLeft: 1,
      activeRight: 0,
    });
  });

  it('drops entries that are not paths and keeps the rest', () => {
    expect(parseOpenTabs(JSON.stringify({ left: ['a.md', 3, '', null, 'b.md'] })).left).toEqual([
      'a.md',
      'b.md',
    ]);
  });

  it('clamps an active index that is past the end', () => {
    // Otherwise the pane renders empty while the strip shows tabs, which reads
    // as the app having lost the note.
    const stored = JSON.stringify({ left: ['a.md'], activeLeft: 7 });
    expect(parseOpenTabs(stored).activeLeft).toBe(0);
  });

  it('rejects a nonsense index rather than trusting it', () => {
    expect(
      parseOpenTabs(JSON.stringify({ left: ['a.md', 'b.md'], activeLeft: -2 })).activeLeft,
    ).toBe(0);
    expect(
      parseOpenTabs(JSON.stringify({ left: ['a.md', 'b.md'], activeLeft: 1.5 })).activeLeft,
    ).toBe(0);
  });

  it('does not restore a split with an empty second pane', () => {
    const stored = JSON.stringify({ left: ['a.md'], right: [], focused: 'right' });
    expect(parseOpenTabs(stored).right).toBeNull();
    expect(parseOpenTabs(stored).focused).toBe('left');
  });
});

describe('per-vault storage', () => {
  beforeEach(() => localStorage.clear());

  it('remembers each vault under its own key', () => {
    writeOpenTabs('/vaults/a', { ...NO_TABS, left: ['one.md'] });
    writeOpenTabs('/vaults/b', { ...NO_TABS, left: ['two.md'], right: ['three.md'] });

    expect(readOpenTabs('/vaults/a').left).toEqual(['one.md']);
    expect(readOpenTabs('/vaults/b').right).toEqual(['three.md']);
    expect(readOpenTabs('/vaults/never-opened')).toEqual(NO_TABS);
  });

  it('drops the key once everything is closed', () => {
    writeOpenTabs('/vaults/a', { ...NO_TABS, left: ['one.md'] });
    writeOpenTabs('/vaults/a', NO_TABS);
    expect(localStorage.getItem(openTabsKey('/vaults/a'))).toBeNull();
  });
});

describe('storedFrom', () => {
  it('records both panes, in tab order', () => {
    let layout: PaneLayout = openTab(initialLayout(), 'left', noteTab('a.md'));
    layout = openTab(layout, 'left', noteTab('b.md'));
    layout = split(layout);
    layout = openTab(layout, 'right', noteTab('c.md'));

    expect(storedFrom(layout)).toEqual({
      left: ['a.md', 'b.md'],
      right: ['c.md'],
      focused: 'right',
      activeLeft: 1,
      activeRight: 0,
    });
  });

  it('keeps only notes, and indexes the active tab among them', () => {
    // A preview is not remembered, so an index into the full tab list would
    // point at the wrong note on the way back.
    let layout = openTab(initialLayout(), 'left', {
      note: null,
      preview: { path: 'shot.png', url: 'blob:x', kind: 'image' as const },
      drawing: null,
    });
    layout = openTab(layout, 'left', noteTab('a.md'));

    expect(storedFrom(layout)).toMatchObject({ left: ['a.md'], activeLeft: 0 });
  });

  it('says 0 when the active tab is not a note at all', () => {
    const layout = openTab(openTab(initialLayout(), 'left', noteTab('a.md')), 'left', {
      note: null,
      preview: { path: 'shot.png', url: 'blob:x', kind: 'image' as const },
      drawing: null,
    });
    expect(storedFrom(layout)).toMatchObject({ left: ['a.md'], activeLeft: 0 });
  });

  it('round-trips through storage', () => {
    localStorage.clear();
    let layout = openTab(initialLayout(), 'left', noteTab('a.md'));
    layout = openTab(layout, 'left', noteTab('b.md'));
    writeOpenTabs('/vault', storedFrom(layout));
    expect(readOpenTabs('/vault')).toEqual(storedFrom(layout));
  });
});
