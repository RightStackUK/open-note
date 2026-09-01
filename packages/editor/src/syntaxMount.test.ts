import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { markdownEditorExtensions } from './index';

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

describe('block 6 syntax in a mounted editor', () => {
  it('renders a document using every new syntax without throwing', () => {
    const doc = [
      '> [!WARNING]',
      '> mind the gap',
      '',
      'inline $x^2$ and a block:',
      '',
      '$$',
      '\\int_0^1 x\\,dx',
      '$$',
      '',
      'a ==mark== and <u>under</u> and a note[^1]',
      '',
      '[^1]: the footnote',
      '',
      '# Heading',
      'content',
      '',
      'tail',
    ].join('\n');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownEditorExtensions({ parent })],
    });
    const view = new EditorView({ state, parent });
    expect(view.dom.querySelectorAll('.cm-callout').length).toBeGreaterThan(0);
    view.dispatch({ selection: { anchor: 0 } });
    view.destroy();
  });
});
