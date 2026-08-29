import {
  bindingFromEvent,
  COMMANDS,
  type CommandDefinition,
  formatBinding,
  KEYMAP_SCHEMES,
  type KeymapConfig,
  type ResolvedKeymap,
} from '@open-note/core';
import { useEffect, useState } from 'react';

import { PLATFORM } from '../useCommands';

interface KeymapPanelProps {
  config: KeymapConfig;
  keymap: ResolvedKeymap;
  onChange: (next: KeymapConfig) => void;
  onClose: () => void;
}

const CATEGORY_ORDER = ['Navigate', 'Note', 'Edit', 'Sync', 'View'] as const;

/**
 * Rebind any command.
 *
 * Recording listens for one real key press rather than asking the user to type
 * a binding string — nobody should have to know that Command is spelled `Mod`.
 */
export function KeymapPanel({ config, keymap, onChange, onClose }: KeymapPanelProps) {
  const [recording, setRecording] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecording(null);
        return;
      }
      const binding = bindingFromEvent(event, PLATFORM);
      // Ignore a bare modifier press; wait for the real key.
      if (!binding) return;

      onChange({ ...config, bindings: { ...config.bindings, [recording]: binding } });
      setRecording(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, config, onChange]);

  const conflictsFor = (id: string) =>
    keymap.conflicts.filter((c) => c.commands.includes(id) && c.commands.at(-1) !== id);

  const reset = (id: string) => {
    const { [id]: _dropped, ...rest } = config.bindings;
    onChange({ ...config, bindings: rest });
  };

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    commands: COMMANDS.filter((c) => c.category === category),
  })).filter((group) => group.commands.length > 0);

  return (
    <aside className="settings keymap">
      <header className="settings-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" className="dismiss" onClick={onClose} aria-label="Close shortcuts">
          ×
        </button>
      </header>

      <label className="setting-number">
        <span className="setting-label">
          Scheme
          <small>A starting point; your own changes sit on top</small>
        </span>
        <select
          className="scheme-select"
          value={config.scheme}
          onChange={(e) => onChange({ ...config, scheme: e.target.value })}
        >
          {Object.keys(KEYMAP_SCHEMES).map((name) => (
            <option key={name} value={name}>
              {name === 'default' ? 'Default' : name[0]?.toUpperCase() + name.slice(1)}
            </option>
          ))}
        </select>
      </label>

      {grouped.map(({ category, commands }) => (
        <section key={category} className="keymap-group">
          <h3>{category}</h3>
          {commands.map((command: CommandDefinition) => {
            const binding = keymap.byCommand.get(command.id);
            const clashes = conflictsFor(command.id);
            const customised = command.id in config.bindings;
            return (
              <div key={command.id} className="keymap-row">
                <span className="keymap-title">
                  {command.title}
                  {clashes.length > 0 && (
                    <small className="keymap-clash">
                      shadowed by another command on this shortcut
                    </small>
                  )}
                </span>
                <span className="keymap-controls">
                  <button
                    type="button"
                    className={`keymap-binding ${recording === command.id ? 'is-recording' : ''}`}
                    onClick={() => setRecording(command.id)}
                    title="Click, then press the keys you want"
                  >
                    {recording === command.id
                      ? 'Press keys…'
                      : binding
                        ? formatBinding(binding, PLATFORM)
                        : 'Unbound'}
                  </button>
                  {customised && (
                    <button
                      type="button"
                      className="keymap-reset"
                      onClick={() => reset(command.id)}
                      title="Restore the default"
                    >
                      ↺
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </section>
      ))}

      <p className="settings-note">
        Saved to <code>.opennote/keymap.json</code> in this vault. Press Escape while recording to
        cancel.
      </p>
    </aside>
  );
}
