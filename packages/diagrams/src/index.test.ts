import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearDiagramCache,
  clearRenderers,
  type DiagramRenderer,
  knownLanguages,
  registerRenderer,
  renderDiagram,
  rendererFor,
  sanitiseSvg,
} from './index';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

function fakeRenderer(over: Partial<DiagramRenderer> = {}): DiagramRenderer {
  return {
    id: 'fake',
    label: 'Fake',
    languages: ['fake'],
    render: async () => SVG,
    ...over,
  };
}

const ctx = { dark: false, id: 'test' };

beforeEach(() => {
  clearRenderers();
  clearDiagramCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registry', () => {
  it('finds a renderer by language', () => {
    registerRenderer(fakeRenderer());
    expect(rendererFor('fake')?.id).toBe('fake');
  });

  it('matches case-insensitively and ignores surrounding space', () => {
    registerRenderer(fakeRenderer());
    expect(rendererFor('  FAKE ')?.id).toBe('fake');
  });

  it('registers every language a renderer claims', () => {
    registerRenderer(fakeRenderer({ languages: ['dot', 'graphviz'] }));
    expect(rendererFor('dot')?.id).toBe('fake');
    expect(rendererFor('graphviz')?.id).toBe('fake');
  });

  it('returns nothing for an unknown language', () => {
    expect(rendererFor('klingon')).toBeUndefined();
  });

  it('lists known languages', () => {
    registerRenderer(fakeRenderer({ languages: ['b', 'a'] }));
    expect(knownLanguages()).toEqual(['a', 'b']);
  });
});

describe('renderDiagram', () => {
  it('renders through the matching renderer', async () => {
    registerRenderer(fakeRenderer());
    const result = await renderDiagram('fake', 'graph TD; A-->B', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.svg).toContain('<rect');
  });

  it('reports an unknown language rather than throwing', async () => {
    const result = await renderDiagram('klingon', 'x', ctx);
    expect(result).toEqual({ ok: false, error: 'No renderer for “klingon”.' });
  });

  it('reports an empty diagram', async () => {
    registerRenderer(fakeRenderer());
    const result = await renderDiagram('fake', '   \n  ', ctx);
    expect(result.ok).toBe(false);
  });

  it('turns a renderer error into a displayable message', async () => {
    // Half-typed diagrams are the normal case, not an exceptional one.
    registerRenderer(
      fakeRenderer({
        render: async () => {
          throw new Error('Parse error on line 2');
        },
      }),
    );
    const result = await renderDiagram('fake', 'broken', ctx);
    expect(result).toEqual({ ok: false, error: 'Parse error on line 2' });
  });

  it('survives a renderer that throws a non-Error', async () => {
    registerRenderer(
      fakeRenderer({
        render: async () => {
          throw 'plain string failure';
        },
      }),
    );
    const result = await renderDiagram('fake', 'x', ctx);
    expect(result).toEqual({ ok: false, error: 'plain string failure' });
  });

  it('caches repeated renders of the same source', async () => {
    const render = vi.fn(async () => SVG);
    registerRenderer(fakeRenderer({ render }));

    await renderDiagram('fake', 'same', ctx);
    await renderDiagram('fake', 'same', ctx);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('ignores leading and trailing whitespace when caching', async () => {
    const render = vi.fn(async () => SVG);
    registerRenderer(fakeRenderer({ render }));

    await renderDiagram('fake', 'same', ctx);
    await renderDiagram('fake', '  same\n', ctx);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('re-renders when the theme changes', async () => {
    // A dark diagram on a light background would be unreadable.
    const render = vi.fn(async () => SVG);
    registerRenderer(fakeRenderer({ render }));

    await renderDiagram('fake', 'same', { dark: false, id: 'a' });
    await renderDiagram('fake', 'same', { dark: true, id: 'b' });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('caches failures too, so a broken diagram is not retried endlessly', async () => {
    const render = vi.fn(async () => {
      throw new Error('nope');
    });
    registerRenderer(fakeRenderer({ render }));

    await renderDiagram('fake', 'broken', ctx);
    await renderDiagram('fake', 'broken', ctx);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('rejects output that sanitisation empties', async () => {
    registerRenderer(fakeRenderer({ render: async () => 'not svg at all' }));
    const result = await renderDiagram('fake', 'x', ctx);
    expect(result.ok).toBe(false);
  });
});

describe('sanitiseSvg', () => {
  it('keeps ordinary shapes', () => {
    expect(sanitiseSvg(SVG)).toContain('<rect');
  });

  it('strips a script element', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>`;
    const clean = sanitiseSvg(dirty);
    expect(clean).not.toContain('script');
    expect(clean).toContain('<rect');
  });

  it('strips a nested script element', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><g><g><script>alert(1)</script></g></g></svg>`;
    expect(sanitiseSvg(dirty)).not.toContain('script');
  });

  it('strips inline event handlers', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" onload="x()"/></svg>`;
    const clean = sanitiseSvg(dirty);
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onload');
  });

  it('strips javascript: links but keeps ordinary ones', () => {
    const dirty =
      `<svg xmlns="http://www.w3.org/2000/svg">` +
      `<a href="javascript:alert(1)"><rect/></a>` +
      `<a href="https://example.com"><rect/></a></svg>`;
    const clean = sanitiseSvg(dirty);
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('https://example.com');
  });

  it('strips foreignObject, which can host arbitrary HTML', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body/></foreignObject></svg>`;
    expect(sanitiseSvg(dirty).toLowerCase()).not.toContain('foreignobject');
  });

  it('rejects markup that is not an SVG', () => {
    expect(sanitiseSvg('<div>hello</div>')).toBe('');
  });

  it('rejects unparseable input', () => {
    expect(sanitiseSvg('<svg><unclosed>')).toBe('');
  });

  it('rejects an empty string', () => {
    expect(sanitiseSvg('')).toBe('');
  });
});
