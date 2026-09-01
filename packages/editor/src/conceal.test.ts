import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, describe, expect, it } from 'vitest';

import { concealedRangesForTest } from './conceal';
import { markdownEditorExtensions } from './index';

/**
 * CodeMirror needs a DOM to construct a view. jsdom lacks a few layout APIs
 * that `EditorView` touches on construction, so we stub the minimum.
 */
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

/** The exact substrings that would be hidden from the reader. */
function concealed(doc: string, cursor: number): string[] {
  const v = view(doc, cursor);
  const ranges = concealedRangesForTest(v);
  const out = ranges.map((r) => v.state.doc.sliceString(r.from, r.to));
  v.destroy();
  return out;
}

describe('conceal', () => {
  it('hides heading markers on inactive lines', () => {
    // Cursor parked on line 2, so line 1's marker should vanish.
    const hidden = concealed('# Title\n\nbody', 10);
    expect(hidden).toContain('# ');
  });

  it('reveals markers on the line the cursor is on', () => {
    const hidden = concealed('# Title\n\nbody', 3);
    expect(hidden).not.toContain('# ');
  });

  it('hides emphasis and strong markers', () => {
    const hidden = concealed('text **bold** and *italic*\n\nelsewhere', 30);
    expect(hidden.filter((s) => s === '**')).toHaveLength(2);
    expect(hidden.filter((s) => s === '*')).toHaveLength(2);
  });

  it('hides inline code backticks but never fenced-code fences', () => {
    const doc = 'use `npm` here\n\n```\ncode block\n```\n\ntail';
    const hidden = concealed(doc, doc.length);
    expect(hidden.filter((s) => s === '`')).toHaveLength(2);
    expect(hidden).not.toContain('```');
  });

  it('never hides list bullets', () => {
    const hidden = concealed('- one\n- two\n\ntail', 15);
    expect(hidden.join('')).not.toContain('-');
  });

  it('swallows the space after a heading marker so text is not indented', () => {
    // "# " together, not "#" alone, or the heading would shift right by one.
    expect(concealed('## Heading\n\ntail', 14)).toContain('## ');
  });

  it('hides blockquote markers on inactive lines', () => {
    expect(concealed('> quoted\n\ntail', 12)).toContain('> ');
  });

  it('reveals every line touched by a multi-line selection', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const doc = '# One\n# Two\n# Three';
    const v = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 0, head: doc.indexOf('Two') },
        extensions: [markdownEditorExtensions({ parent })],
      }),
      parent,
    });
    const hidden = concealedRangesForTest(v).map((r) => v.state.doc.sliceString(r.from, r.to));
    // Lines 1 and 2 are selected and revealed; only line 3 stays concealed.
    expect(hidden).toHaveLength(1);
    v.destroy();
  });

  it('leaves plain prose completely untouched', () => {
    expect(concealed('just some ordinary words', 0)).toHaveLength(0);
  });
});

describe('conceal everywhere', () => {
  /** Same as `concealed`, with the always-conceal preference on. */
  function concealedEverywhere(doc: string, cursor: number): string[] {
    const v = view(doc, cursor);
    const ranges = concealedRangesForTest(v, true);
    const out = ranges.map((r) => v.state.doc.sliceString(r.from, r.to));
    v.destroy();
    return out;
  }

  it('hides markers on the active line too', () => {
    // Caret inside the bold text: the default reveals `**`, the preference
    // keeps hiding it.
    expect(concealed('some **bold** text', 9)).toEqual([]);
    expect(concealedEverywhere('some **bold** text', 9)).toEqual(['**', '**']);
  });

  it('changes nothing off the active line', () => {
    const doc = '# Title\n\nprose';
    expect(concealedEverywhere(doc, doc.length)).toEqual(concealed(doc, doc.length));
  });
});
