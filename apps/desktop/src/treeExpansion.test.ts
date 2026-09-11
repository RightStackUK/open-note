import { beforeEach, describe, expect, it } from 'vitest';
import { expandedKey, parseExpanded, readExpanded, writeExpanded } from './treeExpansion';

/**
 * The stored set is hand-editable and outlives the version that wrote it, so
 * the parse degrades entry by entry — the rule the pane widths and the vault
 * settings follow. Nothing here may throw: a bad value costs the tree its
 * memory, never its render.
 */
describe('parseExpanded', () => {
  it('treats a first run as everything collapsed', () => {
    expect(parseExpanded(null)).toEqual(new Set());
  });

  it('reads stored folders back', () => {
    expect(parseExpanded(JSON.stringify(['work', 'work/2026']))).toEqual(
      new Set(['work', 'work/2026']),
    );
  });

  it('keeps the good entries when one is not a path', () => {
    expect(parseExpanded(JSON.stringify(['work', 7, null, '', 'inbox']))).toEqual(
      new Set(['work', 'inbox']),
    );
  });

  it('falls back to collapsed on unparseable or wrongly shaped storage', () => {
    expect(parseExpanded('{ not json')).toEqual(new Set());
    expect(parseExpanded(JSON.stringify({ work: true }))).toEqual(new Set());
  });
});

describe('per-vault storage', () => {
  beforeEach(() => localStorage.clear());

  it('remembers each vault under its own key', () => {
    writeExpanded('/vaults/a', new Set(['work']));
    writeExpanded('/vaults/b', new Set(['journal', 'journal/2026']));

    expect(readExpanded('/vaults/a')).toEqual(new Set(['work']));
    expect(readExpanded('/vaults/b')).toEqual(new Set(['journal', 'journal/2026']));
    expect(readExpanded('/vaults/never-opened')).toEqual(new Set());
  });

  it('drops the key once every folder is collapsed again', () => {
    writeExpanded('/vaults/a', new Set(['work']));
    writeExpanded('/vaults/a', new Set());

    expect(localStorage.getItem(expandedKey('/vaults/a'))).toBeNull();
    expect(readExpanded('/vaults/a')).toEqual(new Set());
  });
});
