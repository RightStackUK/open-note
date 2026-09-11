import { describe, expect, it } from 'vitest';
import {
  adoptDoc,
  clearAll,
  closePane,
  docKey,
  focus,
  focusedPane,
  focusOther,
  initialLayout,
  isSplit,
  type OpenNote,
  type PaneLayout,
  paneAt,
  pathIn,
  setPane,
  sideShowing,
  sides,
  split,
  updatePane,
} from './editorPanes';

const note = (path: string, doc = '', root = '/vault'): OpenNote => ({
  root,
  path,
  doc,
  kind: 'markdown',
  revision: 0,
});

/** A split window with a note in each pane, left focused. */
function twoNotes(): PaneLayout {
  let layout = updatePane(initialLayout(), 'left', (pane) => ({ ...pane, note: note('a.md') }));
  layout = split(layout);
  layout = updatePane(layout, 'right', (pane) => ({ ...pane, note: note('b.md') }));
  return focus(layout, 'left');
}

describe('splitting', () => {
  it('starts unsplit, with the left pane focused', () => {
    const layout = initialLayout();
    expect(isSplit(layout)).toBe(false);
    expect(sides(layout)).toEqual(['left']);
    expect(layout.focused).toBe('left');
  });

  it('opens the second pane empty and focused', () => {
    const layout = split(
      updatePane(initialLayout(), 'left', (pane) => ({ ...pane, note: note('a.md') })),
    );
    expect(isSplit(layout)).toBe(true);
    expect(layout.focused).toBe('right');
    expect(focusedPane(layout).note).toBeNull();
    // The pane you were reading is untouched.
    expect(layout.left.note?.path).toBe('a.md');
  });

  it('focuses the second pane rather than making a third', () => {
    const layout = split(focus(twoNotes(), 'left'));
    expect(layout.focused).toBe('right');
    expect(layout.right?.note?.path).toBe('b.md');
  });

  it('ignores a write to a pane that is not open', () => {
    const layout = setPane(initialLayout(), 'right', { ...paneAt(initialLayout(), 'right') });
    expect(isSplit(layout)).toBe(false);
  });

  it('cannot focus a pane that is not open', () => {
    expect(focus(initialLayout(), 'right').focused).toBe('left');
  });
});

describe('closing a pane', () => {
  it('keeps what the surviving pane was showing', () => {
    const closed = closePane(twoNotes(), 'right');
    expect(isSplit(closed)).toBe(false);
    expect(closed.left.note?.path).toBe('a.md');
    expect(closed.focused).toBe('left');
  });

  it('promotes the right pane when the left one is closed', () => {
    // Closing the pane you pointed at must not take the other pane's note with
    // it — that would be the opposite of what was asked.
    const closed = closePane(twoNotes(), 'left');
    expect(closed.left.note?.path).toBe('b.md');
    expect(isSplit(closed)).toBe(false);
  });

  it('does nothing when there is only one pane', () => {
    const one = updatePane(initialLayout(), 'left', (pane) => ({ ...pane, note: note('a.md') }));
    expect(closePane(one, 'left')).toEqual(one);
  });
});

describe('focus', () => {
  it('cycles between the two panes', () => {
    const layout = twoNotes();
    expect(focusOther(layout).focused).toBe('right');
    expect(focusOther(focusOther(layout)).focused).toBe('left');
  });

  it('stays put when there is nowhere to go', () => {
    expect(focusOther(initialLayout()).focused).toBe('left');
  });

  it('reports the focused pane, which is where an open lands', () => {
    expect(focusedPane(focus(twoNotes(), 'right')).note?.path).toBe('b.md');
  });
});

describe('a note lives in at most one pane', () => {
  it('finds the pane already showing a note', () => {
    const layout = twoNotes();
    expect(sideShowing(layout, '/vault', 'b.md')).toBe('right');
    expect(sideShowing(layout, '/vault', 'a.md')).toBe('left');
    expect(sideShowing(layout, '/vault', 'c.md')).toBeNull();
  });

  it('does not confuse the same path in another vault', () => {
    expect(sideShowing(twoNotes(), '/other', 'b.md')).toBeNull();
  });

  it('matches a preview or a drawing on its path', () => {
    const layout = updatePane(split(initialLayout()), 'right', (pane) => ({
      ...pane,
      preview: { path: 'diagram.png', url: 'blob:x', kind: 'image' },
    }));
    expect(sideShowing(layout, '/vault', 'diagram.png')).toBe('right');
    expect(pathIn(paneAt(layout, 'right'))).toBe('diagram.png');
  });
});

describe('adopting a written document', () => {
  it('updates the pane holding it, focused or not', () => {
    const layout = adoptDoc(twoNotes(), '/vault', 'b.md', 'written');
    expect(layout.right?.note?.doc).toBe('written');
    expect(layout.focused).toBe('left');
  });

  it('leaves the revision alone, so the editor is not torn down', () => {
    const layout = adoptDoc(twoNotes(), '/vault', 'a.md', 'written');
    expect(layout.left.note?.revision).toBe(0);
  });

  it('bumps the revision for a change from outside the editor', () => {
    const layout = adoptDoc(twoNotes(), '/vault', 'a.md', 'pulled', true);
    expect(layout.left.note?.revision).toBe(1);
  });

  it('ignores a document no pane is showing', () => {
    const layout = twoNotes();
    expect(adoptDoc(layout, '/vault', 'elsewhere.md', 'x')).toBe(layout);
  });

  it('ignores a vault that happens to share the path', () => {
    const layout = adoptDoc(twoNotes(), '/other', 'a.md', 'x');
    expect(layout.left.note?.doc).toBe('');
  });
});

describe('clearing on a vault switch', () => {
  it('empties both panes but keeps the split', () => {
    const cleared = clearAll(focus(twoNotes(), 'right'));
    expect(cleared.left.note).toBeNull();
    expect(cleared.right?.note).toBeNull();
    expect(isSplit(cleared)).toBe(true);
    expect(cleared.focused).toBe('right');
  });
});

describe('docKey', () => {
  it('cannot collide between vaults that share a prefix', () => {
    // `a` + `b/c` and `a/b` + `c` are different documents, and a naive
    // colon-joined key would make them the same autosave buffer.
    expect(docKey('a', 'b/c')).not.toBe(docKey('a/b', 'c'));
  });
});
