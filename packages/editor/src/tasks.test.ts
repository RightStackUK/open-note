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
