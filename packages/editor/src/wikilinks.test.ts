import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { markdownEditorExtensions } from './index';

beforeAll(() => {
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

/** `cursor` is clamped, so tests can say "somewhere after the link" as a big number. */
function mount(doc: string, resolve: (t: string) => string | null, cursor = 0) {
  const anchor = Math.min(cursor, doc.length);
  const onOpen = vi.fn();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdownEditorExtensions({ parent, wikiLinks: { resolve, onOpen } })],
    }),
    parent,
  });
  return { view, onOpen, parent };
}

function links(parent: HTMLElement) {
  return [...parent.querySelectorAll('.cm-wikilink')] as HTMLElement[];
}

describe('wikiLinks', () => {
  it('decorates a wikilink', () => {
    const { parent, view } = mount('see [[Research]] here', () => 'research.md', 30);
    expect(links(parent)).toHaveLength(1);
    expect(links(parent)[0]?.getAttribute('data-wikilink')).toBe('Research');
    view.destroy();
  });

  it('marks an unresolved target differently', () => {
    const { parent, view } = mount('see [[Ghost]]', () => null, 30);
    expect(links(parent)[0]?.classList.contains('cm-wikilink-missing')).toBe(true);
    view.destroy();
  });

  it('does not mark a resolved target as missing', () => {
    const { parent, view } = mount('see [[Real]]', () => 'real.md', 30);
    expect(links(parent)[0]?.classList.contains('cm-wikilink-missing')).toBe(false);
    view.destroy();
  });

  it('flags a link on the line being edited', () => {
    // Cursor on line 1, so this link is being edited rather than read.
    const { parent, view } = mount('see [[Research]]', () => 'research.md', 2);
    expect(links(parent)[0]?.classList.contains('cm-wikilink-editing')).toBe(true);
    view.destroy();
  });

  it('does not flag links on other lines as being edited', () => {
    const { parent, view } = mount('[[One]]\n\nsecond line', () => 'one.md', 10);
    expect(links(parent)[0]?.classList.contains('cm-wikilink-editing')).toBe(false);
    view.destroy();
  });

  it('reads the target from an aliased link', () => {
    const { parent, view } = mount('[[target|shown]]', () => 'target.md', 30);
    expect(links(parent)[0]?.getAttribute('data-wikilink')).toBe('target');
    view.destroy();
  });

  it('titles a resolved link with its destination', () => {
    const { parent, view } = mount('[[Research]]', () => 'notes/research.md', 30);
    expect(links(parent)[0]?.getAttribute('title')).toBe('Open notes/research.md');
    view.destroy();
  });

  it('explains an unresolved link in its title', () => {
    const { parent, view } = mount('[[Ghost]]', () => null, 30);
    expect(links(parent)[0]?.getAttribute('title')).toContain('no note with this name yet');
    view.destroy();
  });

  it('ignores text that is not a link', () => {
    const { parent, view } = mount('just [ brackets ] here', () => null, 30);
    expect(links(parent)).toHaveLength(0);
    view.destroy();
  });

  it('handles several links on one line', () => {
    const { parent, view } = mount('[[a]] and [[b]]', () => 'x.md', 40);
    expect(links(parent)).toHaveLength(2);
    view.destroy();
  });
});
