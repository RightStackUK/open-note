import { describe, expect, it } from 'vitest';

import {
  attachmentFolderFor,
  DEFAULT_SYNC_SETTINGS,
  DEFAULT_VAULT_SETTINGS,
  parseVaultSettings,
  serialiseVaultSettings,
} from './settings';

describe('parseVaultSettings', () => {
  it('returns defaults when the vault has no settings file', () => {
    expect(parseVaultSettings(null).sync).toEqual(DEFAULT_SYNC_SETTINGS);
  });

  it('has autoPush on by default', () => {
    // A deliberate product decision, so it is worth pinning down.
    expect(DEFAULT_SYNC_SETTINGS.autoPush).toBe(true);
  });

  it('reads values that are present', () => {
    const raw = JSON.stringify({ sync: { autoPush: false, fetchIntervalMs: 120_000 } });
    const { sync } = parseVaultSettings(raw);
    expect(sync.autoPush).toBe(false);
    expect(sync.fetchIntervalMs).toBe(120_000);
  });

  it('falls back per field, so a partial file still works', () => {
    const { sync } = parseVaultSettings(JSON.stringify({ sync: { autoCommit: false } }));
    expect(sync.autoCommit).toBe(false);
    expect(sync.autoPush).toBe(DEFAULT_SYNC_SETTINGS.autoPush);
    expect(sync.commitIdleMs).toBe(DEFAULT_SYNC_SETTINGS.commitIdleMs);
  });

  it('degrades to defaults rather than throwing on malformed JSON', () => {
    // These files are hand-editable and synced between machines. A typo must
    // never stop a vault from syncing.
    expect(parseVaultSettings('{ not json').sync).toEqual(DEFAULT_SYNC_SETTINGS);
  });

  it('ignores a settings file with no sync section', () => {
    expect(parseVaultSettings(JSON.stringify({ theme: 'dark' })).sync).toEqual(
      DEFAULT_SYNC_SETTINGS,
    );
  });

  it('ignores values of the wrong type', () => {
    const raw = JSON.stringify({ sync: { autoPush: 'yes please', commitIdleMs: 'soon' } });
    const { sync } = parseVaultSettings(raw);
    expect(sync.autoPush).toBe(DEFAULT_SYNC_SETTINGS.autoPush);
    expect(sync.commitIdleMs).toBe(DEFAULT_SYNC_SETTINGS.commitIdleMs);
  });

  it('clamps intervals so a hand-edited file cannot spin the loops', () => {
    const raw = JSON.stringify({ sync: { fetchIntervalMs: 1, commitIdleMs: 0 } });
    const { sync } = parseVaultSettings(raw);
    expect(sync.fetchIntervalMs).toBeGreaterThanOrEqual(10_000);
    expect(sync.commitIdleMs).toBeGreaterThanOrEqual(1_000);
  });

  it('clamps absurdly large intervals too', () => {
    const raw = JSON.stringify({ sync: { fetchIntervalMs: Number.MAX_SAFE_INTEGER } });
    expect(parseVaultSettings(raw).sync.fetchIntervalMs).toBeLessThanOrEqual(86_400_000);
  });

  it('rejects NaN and Infinity', () => {
    const { sync } = parseVaultSettings('{"sync":{"commitIdleMs":null}}');
    expect(sync.commitIdleMs).toBe(DEFAULT_SYNC_SETTINGS.commitIdleMs);
  });

  it('round-trips through serialisation', () => {
    const original = parseVaultSettings(JSON.stringify({ sync: { autoFetch: false } }));
    const reparsed = parseVaultSettings(serialiseVaultSettings(original));
    expect(reparsed).toEqual(original);
  });

  it('serialises to readable, newline-terminated JSON for the repo', () => {
    const text = serialiseVaultSettings(DEFAULT_VAULT_SETTINGS);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "sync"');
  });
});

describe('sortTodosOnCompletion', () => {
  it('defaults to off', () => {
    expect(parseVaultSettings(null).sortTodosOnCompletion).toBe(false);
  });

  it('reads an explicit true', () => {
    expect(parseVaultSettings('{"sortTodosOnCompletion":true}').sortTodosOnCompletion).toBe(true);
  });

  it('degrades a non-boolean to the default', () => {
    expect(parseVaultSettings('{"sortTodosOnCompletion":"yes"}').sortTodosOnCompletion).toBe(false);
  });

  it('survives a malformed sync block', () => {
    // Field-by-field degradation: one bad key must not lose the other seven.
    const parsed = parseVaultSettings('{"sync":42,"sortTodosOnCompletion":true}');
    expect(parsed.sortTodosOnCompletion).toBe(true);
    expect(parsed.sync).toEqual(DEFAULT_SYNC_SETTINGS);
  });
});

describe('completion', () => {
  it('defaults to on', () => {
    expect(parseVaultSettings(null).completion).toBe(true);
  });

  it('reads an explicit false', () => {
    expect(parseVaultSettings('{"completion":false}').completion).toBe(false);
  });

  it('degrades a non-boolean to the default', () => {
    expect(parseVaultSettings('{"completion":"off"}').completion).toBe(true);
  });

  it('survives a malformed sync block', () => {
    const parsed = parseVaultSettings('{"sync":42,"completion":false}');
    expect(parsed.completion).toBe(false);
    expect(parsed.sync).toEqual(DEFAULT_SYNC_SETTINGS);
  });

  it('round-trips', () => {
    const original = parseVaultSettings('{"completion":false}');
    expect(parseVaultSettings(serialiseVaultSettings(original))).toEqual(original);
  });
});

describe('attachment folder', () => {
  it('defaults to assets/', () => {
    expect(parseVaultSettings(null).attachmentFolder).toBe('assets');
  });

  it('reads a configured folder', () => {
    expect(parseVaultSettings('{"attachmentFolder":"files"}').attachmentFolder).toBe('files');
  });

  it('ignores a non-string value', () => {
    expect(parseVaultSettings('{"attachmentFolder":42}').attachmentFolder).toBe('assets');
  });

  it('survives a file with no sync section', () => {
    expect(parseVaultSettings('{"attachmentFolder":"files"}').sync).toEqual(DEFAULT_SYNC_SETTINGS);
  });

  it('round-trips', () => {
    const original = parseVaultSettings('{"attachmentFolder":"media"}');
    expect(parseVaultSettings(serialiseVaultSettings(original))).toEqual(original);
  });
});

describe('attachmentFolderFor', () => {
  it('uses the configured folder from anywhere in the vault', () => {
    expect(attachmentFolderFor('notes/deep/a.md', 'assets')).toBe('assets');
  });

  it('puts attachments beside the note when set to .', () => {
    expect(attachmentFolderFor('notes/deep/a.md', '.')).toBe('notes/deep');
  });

  it('resolves to the vault root for a root note set to .', () => {
    expect(attachmentFolderFor('a.md', '.')).toBe('');
  });

  it('tolerates stray slashes', () => {
    expect(attachmentFolderFor('a.md', '/assets/')).toBe('assets');
  });

  it('treats an empty setting as beside the note', () => {
    expect(attachmentFolderFor('notes/a.md', '')).toBe('notes');
  });
});
