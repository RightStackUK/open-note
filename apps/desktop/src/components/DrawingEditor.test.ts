import { describe, expect, it } from 'vitest';

import { sceneSignature, serialiseScene } from './DrawingEditor';

const rect = { id: 'a', type: 'rectangle', x: 0, y: 0 };

describe('serialiseScene', () => {
  it('writes the excalidraw file format', () => {
    const parsed = JSON.parse(serialiseScene([rect], {}, {}));
    expect(parsed.type).toBe('excalidraw');
    expect(parsed.elements).toEqual([rect]);
  });

  it('pretty-prints so git diffs stay readable', () => {
    // The whole reason this format is acceptable in a repo is that it diffs.
    const text = serialiseScene([rect], {}, {});
    expect(text.split('\n').length).toBeGreaterThan(5);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('drops transient view state', () => {
    // Panning or switching tool must not count as a change to commit.
    const text = serialiseScene(
      [rect],
      {
        scrollX: 120,
        scrollY: -40,
        zoom: { value: 2 },
        activeTool: { type: 'rectangle' },
        cursorButton: 'down',
      },
      {},
    );
    expect(text).not.toContain('scrollX');
    expect(text).not.toContain('zoom');
    expect(text).not.toContain('activeTool');
  });

  it('keeps view state that is part of the drawing', () => {
    const text = serialiseScene([], { viewBackgroundColor: '#ffeedd', gridSize: 20 }, {});
    expect(text).toContain('viewBackgroundColor');
    expect(text).toContain('gridSize');
  });

  it('is stable for an unchanged scene, so no spurious save is triggered', () => {
    const a = serialiseScene([rect], { scrollX: 1 }, {});
    const b = serialiseScene([rect], { scrollX: 999 }, {});
    expect(a).toBe(b);
  });

  it('changes when an element moves', () => {
    const a = serialiseScene([rect], {}, {});
    const b = serialiseScene([{ ...rect, x: 50 }], {}, {});
    expect(a).not.toBe(b);
  });

  it('carries embedded files through', () => {
    const text = serialiseScene([], {}, { abc: { mimeType: 'image/png' } });
    expect(JSON.parse(text).files.abc.mimeType).toBe('image/png');
  });
});

describe('sceneSignature', () => {
  const scene = (elements: unknown[]) =>
    JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {}, files: {} });

  it('ignores the version bump Excalidraw applies on load', () => {
    // Opening a drawing must never look like an edit.
    const before = scene([{ id: 'a', x: 0, version: 1, versionNonce: 11, updated: 100 }]);
    const after = scene([{ id: 'a', x: 0, version: 2, versionNonce: 99, updated: 999 }]);
    expect(sceneSignature(before)).toBe(sceneSignature(after));
  });

  it('still notices a real change', () => {
    const before = scene([{ id: 'a', x: 0, version: 1 }]);
    const after = scene([{ id: 'a', x: 42, version: 2 }]);
    expect(sceneSignature(before)).not.toBe(sceneSignature(after));
  });

  it('notices an added element', () => {
    expect(sceneSignature(scene([{ id: 'a' }]))).not.toBe(
      sceneSignature(scene([{ id: 'a' }, { id: 'b' }])),
    );
  });

  it('notices a removed element', () => {
    expect(sceneSignature(scene([{ id: 'a' }, { id: 'b' }]))).not.toBe(
      sceneSignature(scene([{ id: 'a' }])),
    );
  });

  it('falls back to the raw text when the JSON is unparseable', () => {
    expect(sceneSignature('not json')).toBe('not json');
  });
});
