import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, describe, expect, it } from 'vitest';

import { markdownEditorExtensions } from './index';
import { toggleTaskAt } from './tasks';

beforeAll(() => {
  if (!document.createRange) return;
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

function view(doc: string, cursor = doc.length) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdownEditorExtensions({ parent })],
  });
  return new EditorView({ state, parent });
}

describe('task checkboxes', () => {
  it('ticks an open task, changing only the marker', () => {
    const v = view('- [ ] buy milk\n\ntail', 18);
    expect(toggleTaskAt(v, 2)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [x] buy milk\n\ntail');
    v.destroy();
  });

  it('unticks a done task', () => {
    const v = view('- [x] buy milk\n\ntail', 18);
    toggleTaskAt(v, 2);
    expect(v.state.doc.toString()).toBe('- [ ] buy milk\n\ntail');
    v.destroy();
  });

  it('refuses a position that is not a task marker', () => {
    const v = view('- buy milk');
    expect(toggleTaskAt(v, 2)).toBe(false);
    expect(v.state.doc.toString()).toBe('- buy milk');
    v.destroy();
  });

  it('draws a checkbox for tasks off the active line', () => {
    const v = view('- [ ] buy milk\n\ntail', 18);
    expect(v.dom.querySelectorAll('.cm-task-checkbox')).toHaveLength(1);
    v.destroy();
  });

  it('shows the raw marker on the line being edited', () => {
    const v = view('- [ ] buy milk\n\ntail', 3);
    expect(v.dom.querySelectorAll('.cm-task-checkbox')).toHaveLength(0);
    v.destroy();
  });

  it('strikes through a completed task', () => {
    const v = view('- [x] buy milk\n\ntail', 18);
    expect(v.dom.querySelectorAll('.cm-task-done')).toHaveLength(1);
    v.destroy();
  });
});

describe('sorting completed tasks down automatically', () => {
  /** As `view`, but with the auto-sort wired to a flag the test controls. */
  function sortingView(doc: string, cursor: number, enabled = true) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdownEditorExtensions({ parent, sortTodosOnCompletion: () => enabled })],
    });
    return new EditorView({ state, parent });
  }

  /** The sort lands in a follow-up transaction, so let the microtask run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('moves a task to the bottom of its list when it is ticked', async () => {
    const v = sortingView('- [ ] one\n- [ ] two\n- [ ] three', 2);
    toggleTaskAt(v, 2);
    await settle();
    expect(v.state.doc.toString()).toBe('- [ ] two\n- [ ] three\n- [x] one');
    v.destroy();
  });

  it('does nothing when the setting is off', async () => {
    const v = sortingView('- [ ] one\n- [ ] two', 2, false);
    toggleTaskAt(v, 2);
    await settle();
    expect(v.state.doc.toString()).toBe('- [x] one\n- [ ] two');
    v.destroy();
  });

  it('does not move a task that was un-ticked', async () => {
    const v = sortingView('- [x] one\n- [ ] two', 2);
    toggleTaskAt(v, 2);
    await settle();
    expect(v.state.doc.toString()).toBe('- [ ] one\n- [ ] two');
    v.destroy();
  });

  it('leaves a second list alone', async () => {
    const v = sortingView('- [ ] a\n\n- [ ] b\n- [ ] c', 2);
    toggleTaskAt(v, 2);
    await settle();
    expect(v.state.doc.toString()).toBe('- [x] a\n\n- [ ] b\n- [ ] c');
    v.destroy();
  });

  it('sorts around the ticked box, not around the caret', async () => {
    // A checkbox is only clickable off the active line, so on every real click
    // the caret is elsewhere. Sorting around the caret sorted the wrong list.
    const v = sortingView('- [ ] one\n- [ ] two\n- [ ] three', 25);
    toggleTaskAt(v, 2);
    await settle();
    expect(v.state.doc.toString()).toBe('- [ ] two\n- [ ] three\n- [x] one');
    v.destroy();
  });

  it('carries nested subtasks with their parent', async () => {
    const v = sortingView('- [ ] parent\n  - [ ] child\n- [ ] sibling', 2);
    toggleTaskAt(v, 2);
    await settle();
    // Sorting line by line stranded the child under `sibling`.
    expect(v.state.doc.toString()).toBe('- [ ] sibling\n- [x] parent\n  - [ ] child');
    v.destroy();
  });

  it('reports the sorted document last, so autosave writes the sorted one', async () => {
    // Update listeners run innermost-last, so a nested dispatch reported the
    // pre-sort document after the sorted one and autosave persisted the wrong
    // order. The document the app sees last must be the one on screen.
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const seen: string[] = [];
    const state = EditorState.create({
      doc: '- [ ] one\n- [ ] two',
      selection: { anchor: 2 },
      extensions: [
        markdownEditorExtensions({ parent, sortTodosOnCompletion: () => true }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) seen.push(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent });
    toggleTaskAt(v, 2);
    await settle();

    expect(seen[seen.length - 1]).toBe('- [ ] two\n- [x] one');
    expect(v.state.doc.toString()).toBe(seen[seen.length - 1]);
    v.destroy();
  });

  it('does not fire a queued sort into a destroyed view', async () => {
    const v = sortingView('- [ ] one\n- [ ] two', 2);
    toggleTaskAt(v, 2);
    v.destroy();
    // Must not throw once the microtask runs.
    await settle();
  });
});
