import { describe, expect, it } from 'vitest';
import type { VaultFile } from './api';
import { buildTree, type TreeFolder } from './tree';

const file = (path: string, kind: VaultFile['kind'] = 'markdown'): VaultFile => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind,
  size: 0,
  modified: 0,
});

describe('buildTree', () => {
  it('keeps root-level files at the root', () => {
    const tree = buildTree([file('a.md'), file('b.md')]);
    expect(tree.map((n) => n.name)).toEqual(['a.md', 'b.md']);
  });

  it('nests files under their folders', () => {
    const tree = buildTree([file('daily/2026-08-29.md')]);
    expect(tree).toHaveLength(1);
    const folder = tree[0] as TreeFolder;
    expect(folder.type).toBe('folder');
    expect(folder.name).toBe('daily');
    expect(folder.children[0]?.name).toBe('2026-08-29.md');
  });

  it('creates intermediate folders that have no files of their own', () => {
    const tree = buildTree([file('a/b/c/deep.md')]);
    let node = tree[0] as TreeFolder;
    for (const name of ['a', 'b', 'c']) {
      expect(node.name).toBe(name);
      node = node.children[0] as TreeFolder;
    }
    expect(node.name).toBe('deep.md');
  });

  it('reuses a folder across sibling files rather than duplicating it', () => {
    const tree = buildTree([file('notes/one.md'), file('notes/two.md')]);
    expect(tree).toHaveLength(1);
    expect((tree[0] as TreeFolder).children).toHaveLength(2);
  });

  it('sorts folders before files', () => {
    const tree = buildTree([file('zzz.md'), file('aaa/inner.md')]);
    expect(tree.map((n) => n.type)).toEqual(['folder', 'file']);
  });

  it('sorts case-insensitively so capitalised names are not exiled', () => {
    const tree = buildTree([file('banana.md'), file('Apple.md'), file('cherry.md')]);
    expect(tree.map((n) => n.name)).toEqual(['Apple.md', 'banana.md', 'cherry.md']);
  });

  it('carries the file kind through so the UI can tell notes from images', () => {
    const tree = buildTree([file('img/photo.png', 'image')]);
    const folder = tree[0] as TreeFolder;
    const child = folder.children[0];
    expect(child?.type === 'file' && child.file.kind).toBe('image');
  });

  it('handles an empty vault', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('buildTree with folder entries', () => {
  it('shows a folder that holds no files', () => {
    // The case that has no other evidence: git cannot store an empty directory.
    const tree = buildTree([file('a.md'), file('Ideas', 'folder')]);
    expect(tree.map((n) => n.name)).toEqual(['Ideas', 'a.md']);
    expect(tree[0]?.type).toBe('folder');
    expect((tree[0] as TreeFolder).children).toEqual([]);
  });

  it('does not duplicate a folder that also has files in it', () => {
    const tree = buildTree([file('daily/note.md'), file('daily', 'folder')]);
    expect(tree).toHaveLength(1);
    expect((tree[0] as TreeFolder).children.map((c) => c.name)).toEqual(['note.md']);
  });

  it('nests an empty folder inside a folder that has files', () => {
    const tree = buildTree([file('Projects/p.md'), file('Projects/2026', 'folder')]);
    const projects = tree[0] as TreeFolder;
    expect(projects.children.map((c) => c.name)).toEqual(['2026', 'p.md']);
  });
});
