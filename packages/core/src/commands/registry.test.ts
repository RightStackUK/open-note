import { describe, expect, it } from 'vitest';

import { bindingFromEvent, formatBinding, normaliseBinding } from './keys';
import {
  COMMANDS,
  parseKeymapConfig,
  resolveKeymap,
  searchCommands,
  serialiseKeymapConfig,
} from './registry';

function keyEvent(over: Partial<Parameters<typeof bindingFromEvent>[0]> & { key: string }) {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over };
}

describe('normaliseBinding', () => {
  it('orders modifiers consistently', () => {
    expect(normaliseBinding('Shift-Mod-P')).toBe('Mod-Shift-P');
  });

  it('accepts + as a separator', () => {
    expect(normaliseBinding('Mod+Shift+P')).toBe('Mod-Shift-P');
  });

  it('folds platform aliases onto Mod', () => {
    expect(normaliseBinding('cmd-k')).toBe('Mod-K');
    expect(normaliseBinding('command-k')).toBe('Mod-K');
  });

  it('keeps Ctrl distinct from Mod', () => {
    expect(normaliseBinding('ctrl-k')).toBe('Ctrl-K');
  });

  it('uppercases single letters', () => {
    expect(normaliseBinding('mod-p')).toBe('Mod-P');
  });

  it('canonicalises named keys', () => {
    expect(normaliseBinding('mod-return')).toBe('Mod-Enter');
    expect(normaliseBinding('esc')).toBe('Escape');
  });

  it('preserves arrow keys', () => {
    expect(normaliseBinding('alt-ArrowUp')).toBe('Alt-ArrowUp');
  });

  it('returns empty for a modifier with no key', () => {
    expect(normaliseBinding('Mod-Shift')).toBe('');
  });

  it('returns empty for nonsense', () => {
    expect(normaliseBinding('   ')).toBe('');
  });
});

describe('bindingFromEvent', () => {
  it('maps Command to Mod on macOS', () => {
    expect(bindingFromEvent(keyEvent({ key: 'p', metaKey: true }), 'mac')).toBe('Mod-P');
  });

  it('maps Control to Mod elsewhere', () => {
    expect(bindingFromEvent(keyEvent({ key: 'p', ctrlKey: true }), 'other')).toBe('Mod-P');
  });

  it('keeps Control separate from Command on macOS', () => {
    expect(bindingFromEvent(keyEvent({ key: 'p', ctrlKey: true }), 'mac')).toBe('Ctrl-P');
  });

  it('includes Shift and Alt', () => {
    const binding = bindingFromEvent(
      keyEvent({ key: 'p', metaKey: true, shiftKey: true, altKey: true }),
      'mac',
    );
    expect(binding).toBe('Mod-Alt-Shift-P');
  });

  it('ignores a bare modifier press', () => {
    expect(bindingFromEvent(keyEvent({ key: 'Shift', shiftKey: true }), 'mac')).toBe('');
  });

  it('round-trips with normaliseBinding', () => {
    const event = keyEvent({ key: 'k', metaKey: true, shiftKey: true });
    expect(bindingFromEvent(event, 'mac')).toBe(normaliseBinding('Mod-Shift-K'));
  });
});

describe('formatBinding', () => {
  it('uses symbols on macOS', () => {
    expect(formatBinding('Mod-Shift-P', 'mac')).toBe('⌘⇧P');
  });

  it('spells modifiers out elsewhere', () => {
    expect(formatBinding('Mod-Shift-P', 'other')).toBe('Ctrl+Shift+P');
  });

  it('names the space key', () => {
    expect(formatBinding('Mod- ', 'mac')).toContain('Space');
  });
});

describe('resolveKeymap', () => {
  it('uses the default binding for every command', () => {
    const { byCommand } = resolveKeymap();
    expect(byCommand.get('switcher.open')).toBe('Mod-P');
  });

  it('applies a named scheme over the defaults', () => {
    const { byCommand } = resolveKeymap({ scheme: 'bear', bindings: {} });
    expect(byCommand.get('search.open')).toBe('Mod-K');
    // Untouched commands keep their default.
    expect(byCommand.get('edit.bold')).toBe('Mod-B');
  });

  it('lets a user override beat the scheme', () => {
    const { byCommand } = resolveKeymap({ scheme: 'bear', bindings: { 'search.open': 'Mod-G' } });
    expect(byCommand.get('search.open')).toBe('Mod-G');
  });

  it('unbinds a command set to null', () => {
    const { byCommand } = resolveKeymap({ scheme: 'default', bindings: { 'edit.bold': null } });
    expect(byCommand.has('edit.bold')).toBe(false);
  });

  it('normalises user bindings', () => {
    const { byCommand } = resolveKeymap({
      scheme: 'default',
      bindings: { 'edit.bold': 'shift+cmd+b' },
    });
    expect(byCommand.get('edit.bold')).toBe('Mod-Shift-B');
  });

  it('maps bindings back to commands', () => {
    const { byBinding } = resolveKeymap();
    expect(byBinding.get('Mod-P')).toBe('switcher.open');
  });

  it('reports a conflict when two commands claim one binding', () => {
    const { conflicts } = resolveKeymap({
      scheme: 'default',
      bindings: { 'edit.bold': 'Mod-P' },
    });
    const clash = conflicts.find((c) => c.binding === 'Mod-P');
    expect(clash?.commands).toContain('edit.bold');
    expect(clash?.commands).toContain('switcher.open');
  });

  it('ships without conflicts in the default scheme', () => {
    // A shipped conflict would mean a shortcut silently does the wrong thing.
    expect(resolveKeymap().conflicts).toEqual([]);
  });

  it('ships without conflicts in the alternative scheme', () => {
    expect(resolveKeymap({ scheme: 'bear', bindings: {} }).conflicts).toEqual([]);
  });

  it('falls back to defaults for an unknown scheme', () => {
    const { byCommand } = resolveKeymap({ scheme: 'nonsense', bindings: {} });
    expect(byCommand.get('switcher.open')).toBe('Mod-P');
  });
});

describe('parseKeymapConfig', () => {
  it('returns defaults with no file', () => {
    expect(parseKeymapConfig(null)).toEqual({ scheme: 'default', bindings: {} });
  });

  it('reads a scheme and overrides', () => {
    const raw = JSON.stringify({ scheme: 'bear', bindings: { 'edit.bold': 'Mod-Shift-B' } });
    expect(parseKeymapConfig(raw)).toEqual({
      scheme: 'bear',
      bindings: { 'edit.bold': 'Mod-Shift-B' },
    });
  });

  it('keeps an explicit null unbinding', () => {
    expect(parseKeymapConfig('{"bindings":{"edit.bold":null}}').bindings['edit.bold']).toBeNull();
  });

  it('drops values that are not strings or null', () => {
    expect(parseKeymapConfig('{"bindings":{"edit.bold":42}}').bindings).toEqual({});
  });

  it('degrades to defaults on malformed JSON', () => {
    expect(parseKeymapConfig('{ not json')).toEqual({ scheme: 'default', bindings: {} });
  });

  it('ignores an unknown scheme name', () => {
    expect(parseKeymapConfig('{"scheme":"emacs"}').scheme).toBe('default');
  });

  it('round-trips', () => {
    const config = { scheme: 'bear', bindings: { 'edit.bold': 'Mod-Shift-B' } };
    expect(parseKeymapConfig(serialiseKeymapConfig(config))).toEqual(config);
  });
});

describe('searchCommands', () => {
  it('returns everything for an empty query', () => {
    expect(searchCommands('')).toHaveLength(COMMANDS.length);
  });

  it('ranks a title prefix first', () => {
    expect(searchCommands('sync')[0]?.title).toMatch(/^Sync/);
  });

  it('matches on keywords', () => {
    expect(searchCommands('push').map((c) => c.id)).toContain('sync.now');
  });

  it('matches on category', () => {
    expect(searchCommands('navigate').length).toBeGreaterThan(0);
  });

  it('matches a scattered subsequence', () => {
    expect(searchCommands('nwnt').map((c) => c.id)).toContain('note.new');
  });

  it('returns nothing when nothing matches', () => {
    expect(searchCommands('zzzzqqq')).toEqual([]);
  });
});

describe('command definitions', () => {
  it('has unique ids', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every command a title and category', () => {
    for (const command of COMMANDS) {
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.category.length).toBeGreaterThan(0);
    }
  });

  it('uses only bindings that normalise cleanly', () => {
    for (const command of COMMANDS) {
      if (!command.binding) continue;
      expect(normaliseBinding(command.binding)).not.toBe('');
    }
  });
});
