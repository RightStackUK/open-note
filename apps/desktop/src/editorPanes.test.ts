import { describe, expect, it } from 'vitest';
import {
  activateTab,
  activeTab,
  adoptDoc,
  closePane,
  closeTab,
  closeTabFor,
  cycleTab,
  docKey,
  focus,
  focusedPane,
  focusedTab,
  focusOther,
  initialLayout,
  isSplit,
  locate,
  type OpenNote,
  openNotes,
  openTab,
  type PaneLayout,
  paneAt,
  setPane,
  sides,
  split,
  type Tab,
  tabAt,
  tabPath,
  updateActiveTab,
} from './editorPanes';

const note = (path: string, doc = '', root = '/vault'): OpenNote => ({
  root,
  path,
  doc,
  kind: 'markdown',
  revision: 0,
});

const noteTab = (path: string, doc = '', root = '/vault'): Tab => ({
  note: note(path, doc, root),
  preview: null,
  drawing: null,
});

/** Three tabs in the left pane, the middle one active. */
function threeTabs(): PaneLayout {
  let layout = openTab(initialLayout(), 'left', noteTab('a.md'));
  layout = openTab(layout, 'left', noteTab('b.md'));
  layout = openTab(layout, 'left', noteTab('c.md'));
  return activateTab(layout, 'left', 1);
}

/** A split window: two tabs on the left, one on the right, left focused. */
function splitLayout(): PaneLayout {
  let layout = openTab(initialLayout(), 'left', noteTab('a.md'));
  layout = openTab(layout, 'left', noteTab('b.md'));
  layout = split(layout);
  layout = openTab(layout, 'right', noteTab('c.md'));
  return focus(layout, 'left');
}

describe('opening tabs', () => {
  it('starts with nothing open, and one pane', () => {
    const layout = initialLayout();
    expect(sides(layout)).toEqual(['left']);
    expect(paneAt(layout, 'left').tabs).toEqual([]);
    expect(focusedTab(layout).note).toBeNull();
    expect(tabPath(focusedTab(layout))).toBeNull();
  });

  it('opens a tab and makes it active', () => {
    const layout = openTab(initialLayout(), 'left', noteTab('a.md'));
    expect(paneAt(layout, 'left').tabs).toHaveLength(1);
    expect(focusedTab(layout).note?.path).toBe('a.md');
  });

  it('lands a new tab next to the one you came from, not at the end', () => {
    // Following a link from the middle tab should put the target beside it.
    const layout = openTab(threeTabs(), 'left', noteTab('d.md'));
    expect(paneAt(layout, 'left').tabs.map((tab) => tabPath(tab))).toEqual([
      'a.md',
      'b.md',
      'd.md',
      'c.md',
    ]);
    expect(focusedTab(layout).note?.path).toBe('d.md');
  });

  it('refreshes and activates the existing tab rather than opening a second', () => {
    const layout = openTab(threeTabs(), 'left', noteTab('a.md', 'reread from disk'));
    expect(paneAt(layout, 'left').tabs).toHaveLength(3);
    expect(paneAt(layout, 'left').active).toBe(0);
    expect(focusedTab(layout).note?.doc).toBe('reread from disk');
  });

  it('focuses the pane it opens into', () => {
    const layout = openTab(splitLayout(), 'right', noteTab('d.md'));
    expect(layout.focused).toBe('right');
    expect(tabAt(layout, 'left').note?.path).toBe('b.md');
  });

  it('ignores an open into a pane that is not there', () => {
    const layout = openTab(initialLayout(), 'right', noteTab('a.md'));
    expect(isSplit(layout)).toBe(false);
    expect(paneAt(layout, 'left').tabs).toEqual([]);
  });
});

describe('closing tabs', () => {
  it('activates the tab that slides into its place', () => {
    const layout = closeTab(threeTabs(), 'left', 1);
    expect(paneAt(layout, 'left').tabs.map(tabPath)).toEqual(['a.md', 'c.md']);
    expect(focusedTab(layout).note?.path).toBe('c.md');
  });

  it('falls back to the new last tab when the closed one was last', () => {
    const layout = closeTab(activateTab(threeTabs(), 'left', 2), 'left', 2);
    expect(focusedTab(layout).note?.path).toBe('b.md');
  });

  it('keeps the active tab active when an earlier one closes', () => {
    const layout = closeTab(threeTabs(), 'left', 0);
    expect(focusedTab(layout).note?.path).toBe('b.md');
  });

  it('leaves an empty pane, not a broken one, when the last tab goes', () => {
    const layout = closeTab(openTab(initialLayout(), 'left', noteTab('a.md')), 'left', 0);
    expect(paneAt(layout, 'left').tabs).toEqual([]);
    expect(focusedTab(layout).note).toBeNull();
  });

  it('closes a document wherever it is open', () => {
    const layout = closeTabFor(splitLayout(), '/vault', 'c.md');
    expect(paneAt(layout, 'right').tabs).toEqual([]);
    expect(paneAt(layout, 'left').tabs).toHaveLength(2);
  });

  it('ignores an index that is not there', () => {
    const layout = threeTabs();
    expect(closeTab(layout, 'left', 9)).toEqual(layout);
    expect(closeTabFor(layout, '/vault', 'nope.md')).toBe(layout);
  });
});

describe('moving between tabs', () => {
  it('cycles forwards and wraps', () => {
    const layout = cycleTab(activateTab(threeTabs(), 'left', 2), 'left', 1);
    expect(focusedTab(layout).note?.path).toBe('a.md');
  });

  it('cycles backwards and wraps', () => {
    const layout = cycleTab(activateTab(threeTabs(), 'left', 0), 'left', -1);
    expect(focusedTab(layout).note?.path).toBe('c.md');
  });

  it('does nothing with fewer than two tabs', () => {
    const one = openTab(initialLayout(), 'left', noteTab('a.md'));
    expect(cycleTab(one, 'left', 1)).toBe(one);
  });

  it('cycles the focused pane only', () => {
    const layout = cycleTab(splitLayout(), 'left', 1);
    expect(tabAt(layout, 'left').note?.path).toBe('a.md');
    expect(tabAt(layout, 'right').note?.path).toBe('c.md');
  });

  it('refuses an index outside the pane', () => {
    const layout = threeTabs();
    expect(activateTab(layout, 'left', 7)).toBe(layout);
  });
});

describe('panes keep their own tabs', () => {
  it('lists both sides once split', () => {
    expect(sides(splitLayout())).toEqual(['left', 'right']);
  });

  it('splits into an empty, focused pane', () => {
    const layout = split(openTab(initialLayout(), 'left', noteTab('a.md')));
    expect(isSplit(layout)).toBe(true);
    expect(layout.focused).toBe('right');
    expect(focusedPane(layout).tabs).toEqual([]);
    expect(tabAt(layout, 'left').note?.path).toBe('a.md');
  });

  it('keeps the surviving pane’s tabs when a pane closes', () => {
    const closed = closePane(splitLayout(), 'right');
    expect(paneAt(closed, 'left').tabs.map(tabPath)).toEqual(['a.md', 'b.md']);
    expect(isSplit(closed)).toBe(false);
  });

  it('promotes the right pane, with its tabs, when the left one closes', () => {
    const closed = closePane(splitLayout(), 'left');
    expect(paneAt(closed, 'left').tabs.map(tabPath)).toEqual(['c.md']);
    expect(isSplit(closed)).toBe(false);
  });

  it('cycles focus between panes', () => {
    expect(focusOther(splitLayout()).focused).toBe('right');
    expect(focusOther(initialLayout()).focused).toBe('left');
  });

  it('ignores a write to a pane that is not open', () => {
    const layout = setPane(initialLayout(), 'right', { tabs: [noteTab('a.md')], active: 0 });
    expect(isSplit(layout)).toBe(false);
  });

  it('reports the empty tab for a pane with nothing in it', () => {
    expect(activeTab({ tabs: [], active: 3 }).note).toBeNull();
  });
});

describe('a document lives in one tab', () => {
  it('finds where a note is open', () => {
    const layout = splitLayout();
    expect(locate(layout, '/vault', 'b.md')).toEqual({ side: 'left', index: 1 });
    expect(locate(layout, '/vault', 'c.md')).toEqual({ side: 'right', index: 0 });
    expect(locate(layout, '/vault', 'nope.md')).toBeNull();
  });

  it('does not confuse the same path in another vault', () => {
    expect(locate(splitLayout(), '/other', 'b.md')).toBeNull();
  });

  it('matches a preview on its path', () => {
    const layout = openTab(initialLayout(), 'left', {
      note: null,
      preview: { path: 'diagram.png', url: 'blob:x', kind: 'image' },
      drawing: null,
    });
    expect(locate(layout, '/vault', 'diagram.png')).toEqual({ side: 'left', index: 0 });
  });

  it('lists every open note in order, for persistence', () => {
    expect(openNotes(splitLayout()).map((open) => open.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

describe('adopting a written document', () => {
  it('updates the tab holding it, active or not', () => {
    const layout = adoptDoc(threeTabs(), '/vault', 'c.md', 'written');
    expect(paneAt(layout, 'left').tabs[2]?.note?.doc).toBe('written');
    expect(paneAt(layout, 'left').active).toBe(1);
  });

  it('reaches a tab in the other pane', () => {
    const layout = adoptDoc(splitLayout(), '/vault', 'c.md', 'written');
    expect(tabAt(layout, 'right').note?.doc).toBe('written');
    expect(layout.focused).toBe('left');
  });

  it('leaves the revision alone, so the editor is not torn down', () => {
    const layout = adoptDoc(threeTabs(), '/vault', 'b.md', 'written');
    expect(focusedTab(layout).note?.revision).toBe(0);
  });

  it('bumps the revision for a change from outside the editor', () => {
    const layout = adoptDoc(threeTabs(), '/vault', 'b.md', 'pulled', true);
    expect(focusedTab(layout).note?.revision).toBe(1);
  });

  it('ignores a document nothing has open', () => {
    const layout = threeTabs();
    expect(adoptDoc(layout, '/vault', 'elsewhere.md', 'x')).toBe(layout);
    expect(adoptDoc(layout, '/other', 'b.md', 'x')).toBe(layout);
  });
});

describe('updateActiveTab', () => {
  it('changes only the active tab', () => {
    const layout = updateActiveTab(threeTabs(), 'left', (tab) => ({ ...tab, note: null }));
    expect(focusedTab(layout).note).toBeNull();
    expect(paneAt(layout, 'left').tabs[0]?.note?.path).toBe('a.md');
  });

  it('does nothing to an empty pane', () => {
    const layout = initialLayout();
    expect(updateActiveTab(layout, 'left', () => noteTab('a.md'))).toEqual(layout);
  });
});

describe('docKey', () => {
  it('cannot collide between vaults that share a prefix', () => {
    // `a` + `b/c` and `a/b` + `c` are different documents, and a naive
    // colon-joined key would make them the same autosave buffer.
    expect(docKey('a', 'b/c')).not.toBe(docKey('a/b', 'c'));
  });
});
