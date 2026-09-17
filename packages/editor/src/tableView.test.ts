import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { markdownEditorExtensions } from './index';

beforeAll(() => {
  // jsdom measures nothing, and CodeMirror's selection layer asks. Same stubs
  // as `diagrams.test.ts`, for the same reason.
  Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0 }) as DOMRect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

interface MountOptions {
  cursor?: number;
  resolve?: (target: string) => string | null;
  onOpen?: (target: string, path: string | null) => void;
}

function mount(doc: string, options: MountOptions = {}) {
  const { cursor = 0, resolve = () => null, onOpen = () => {} } = options;
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(cursor, doc.length) },
      extensions: [
        markdownEditorExtensions({
          parent,
          wikiLinks: { resolve, onOpen: (target, path) => onOpen(target, path) },
        }),
      ],
    }),
    parent,
  });
  return view;
}

const cells = (view: EditorView, selector: string) =>
  [...view.dom.querySelectorAll(selector)].map((cell) => cell.textContent);

const TABLE = `Before

| Area | Decision | Why |
|---|---|---|
| Monorepo | **pnpm** | Standard for *one* tree |
| Errors | \`Sentry\` | RN + Node |

After
`;

describe('rendered tables', () => {
  it('draws a table off the caret', () => {
    const view = mount(TABLE, { cursor: 0 });

    const table = view.dom.querySelector('table.cm-table');
    expect(table).not.toBeNull();
    expect(cells(view, '.cm-table th')).toEqual(['Area', 'Decision', 'Why']);
    expect(cells(view, '.cm-table tbody tr:first-child td')).toEqual([
      'Monorepo',
      'pnpm',
      'Standard for one tree',
    ]);
  });

  it('shows the emphasis, not its markers', () => {
    const view = mount(TABLE, { cursor: 0 });

    expect(view.dom.querySelector('.cm-table strong')?.textContent).toBe('pnpm');
    expect(view.dom.querySelector('.cm-table em')?.textContent).toBe('one');
    expect(view.dom.querySelector('.cm-table code')?.textContent).toBe('Sentry');
    // The source itself is untouched: this is presentation only.
    expect(view.state.doc.toString()).toContain('**pnpm**');
  });

  it('shows the source of the table the caret is in', () => {
    const inside = TABLE.indexOf('Monorepo');
    const view = mount(TABLE, { cursor: inside });

    expect(view.dom.querySelector('table.cm-table')).toBeNull();
    expect(view.dom.textContent).toContain('| Monorepo | **pnpm** |');
  });

  it('leaves every other table rendered', () => {
    const doc = `| A |\n|---|\n| 1 |\n\ntext\n\n| B |\n|---|\n| 2 |\n`;
    const view = mount(doc, { cursor: doc.indexOf('| B |') + 2 });

    expect(cells(view, '.cm-table th')).toEqual(['A']);
  });

  it('takes alignment from the delimiter row', () => {
    const doc = `| l | c | r | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |\n`;
    const view = mount(doc, { cursor: doc.length });

    const aligned = [...view.dom.querySelectorAll<HTMLElement>('.cm-table th')].map(
      (cell) => cell.style.textAlign,
    );
    // The unaligned column is left to the stylesheet rather than pinned here.
    expect(aligned).toEqual(['left', 'center', 'right', '']);
  });

  it('pads a short row to the column count', () => {
    const doc = `| a | b | c |\n|---|---|---|\n| 1 |\n`;
    const view = mount(doc, { cursor: doc.length });

    const row = view.dom.querySelectorAll('.cm-table tbody td');
    expect(row.length).toBe(3);
    expect([...row].map((cell) => cell.textContent)).toEqual(['1', '', '']);
  });

  it('keeps an escaped pipe inside its cell, as a pipe', () => {
    const doc = `| a | b |\n|---|---|\n| x \\| y | z |\n`;
    const view = mount(doc, { cursor: doc.length });

    expect(cells(view, '.cm-table tbody td')).toEqual(['x | y', 'z']);
  });

  it('renders a wikilink as one, and follows it when clicked', () => {
    const onOpen = vi.fn();
    const doc = `| note |\n|---|\n| [[Projects/Plan]] |\n`;
    const view = mount(doc, {
      cursor: doc.length,
      resolve: (target) => (target === 'Projects/Plan' ? 'Projects/Plan.md' : null),
      onOpen,
    });

    const link = view.dom.querySelector<HTMLElement>('.cm-table .cm-wikilink');
    expect(link?.textContent).toBe('Projects/Plan');
    expect(link?.classList.contains('cm-wikilink-missing')).toBe(false);

    link?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith('Projects/Plan', 'Projects/Plan.md');
  });

  it('marks a wikilink to nothing as missing', () => {
    const doc = `| note |\n|---|\n| [[Nowhere]] |\n`;
    const view = mount(doc, { cursor: doc.length });

    expect(
      view.dom.querySelector('.cm-table .cm-wikilink')?.classList.contains('cm-wikilink-missing'),
    ).toBe(true);
  });

  it('puts the caret in the cell that was clicked', () => {
    const view = mount(TABLE, { cursor: 0 });

    const cell = view.dom.querySelectorAll<HTMLElement>('.cm-table tbody td')[2];
    cell?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    // The source is back, with the caret on the text that was clicked.
    expect(view.dom.querySelector('table.cm-table')).toBeNull();
    expect(view.state.doc.sliceString(view.state.selection.main.head)).toMatch(
      /^Standard for \*one\* tree/,
    );
  });

  it('leaves a table inside a blockquote as source', () => {
    // The block decoration would swallow the `>` that puts it there.
    const doc = `> | a | b |\n> |---|---|\n> | 1 | 2 |\n`;
    const view = mount(doc, { cursor: doc.length });

    expect(view.dom.querySelector('table.cm-table')).toBeNull();
  });
});
