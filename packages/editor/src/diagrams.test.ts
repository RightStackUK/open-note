import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { type DiagramRenderResult, markdownEditorExtensions } from './index';

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

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

type Render = (language: string, source: string, id: string) => Promise<DiagramRenderResult>;

function mount(doc: string, cursor = 0, render?: Render) {
  const spy = vi.fn(render ?? defaultRender);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(cursor, doc.length) },
      extensions: [
        markdownEditorExtensions({
          parent,
          diagrams: { languages: ['mermaid', 'dot'], render: spy, dark: false },
        }),
      ],
    }),
    parent,
  });
  return { view, parent, render: spy };
}

const defaultRender: Render = async () => ({ ok: true, svg: SVG });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('diagramBlocks', () => {
  it('replaces a mermaid block with a rendered diagram', async () => {
    const doc = 'text\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nmore';
    const { parent, view } = mount(doc, 0);
    await flush();
    expect(parent.querySelector('.cm-diagram')).not.toBeNull();
    expect(parent.querySelector('.cm-diagram svg')).not.toBeNull();
    view.destroy();
  });

  it('passes the language and source to the renderer', async () => {
    const doc = '```dot\ndigraph { a -> b }\n```';
    const { render, view } = mount(`intro\n\n${doc}`, 0);
    await flush();
    expect(render).toHaveBeenCalledWith('dot', 'digraph { a -> b }', expect.any(String));
    view.destroy();
  });

  it('shows the source instead when the cursor is inside the block', async () => {
    const doc = 'text\n\n```mermaid\ngraph TD;\n```';
    // Cursor inside the fence.
    const { parent, view } = mount(doc, doc.indexOf('graph'));
    await flush();
    expect(parent.querySelector('.cm-diagram')).toBeNull();
    view.destroy();
  });

  it('leaves ordinary code blocks alone', async () => {
    const doc = 'text\n\n```js\nconst x = 1;\n```';
    const { parent, render, view } = mount(doc, 0);
    await flush();
    expect(parent.querySelector('.cm-diagram')).toBeNull();
    expect(render).not.toHaveBeenCalled();
    view.destroy();
  });

  it('leaves a fence with no language alone', async () => {
    const doc = 'text\n\n```\nplain\n```';
    const { parent, view } = mount(doc, 0);
    await flush();
    expect(parent.querySelector('.cm-diagram')).toBeNull();
    view.destroy();
  });

  it('ignores an empty diagram block', async () => {
    const doc = 'text\n\n```mermaid\n\n```';
    const { render, view } = mount(doc, 0);
    await flush();
    expect(render).not.toHaveBeenCalled();
    view.destroy();
  });

  it('shows an error message when rendering fails', async () => {
    const doc = 'text\n\n```mermaid\nbroken\n```';
    const { parent, view } = mount(doc, 0, async () => ({
      ok: false,
      error: 'Parse error line 1',
    }));
    await flush();
    const body = parent.querySelector('.cm-diagram-body');
    expect(body?.classList.contains('is-error')).toBe(true);
    expect(body?.textContent).toBe('Parse error line 1');
    view.destroy();
  });

  it('survives a renderer that rejects', async () => {
    const doc = 'text\n\n```mermaid\nx\n```';
    const { parent, view } = mount(doc, 0, async () => {
      throw new Error('exploded');
    });
    await flush();
    expect(parent.querySelector('.cm-diagram-body')?.classList.contains('is-error')).toBe(true);
    view.destroy();
  });

  it('renders several diagrams in one note', async () => {
    const doc = '```mermaid\na\n```\n\ntext\n\n```dot\nb\n```';
    const { parent, view } = mount(`intro\n\n${doc}`, 0);
    await flush();
    expect(parent.querySelectorAll('.cm-diagram')).toHaveLength(2);
    view.destroy();
  });

  it('offers an edit affordance on the rendered diagram', async () => {
    const doc = 'text\n\n```mermaid\ngraph TD;\n```';
    const { parent, view } = mount(doc, 0);
    await flush();
    expect(parent.querySelector('.cm-diagram-edit')).not.toBeNull();
    view.destroy();
  });

  it('is inert when no diagram options are supplied', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: '```mermaid\ngraph TD;\n```',
        extensions: [markdownEditorExtensions({ parent })],
      }),
      parent,
    });
    await flush();
    expect(parent.querySelector('.cm-diagram')).toBeNull();
    view.destroy();
  });
});
