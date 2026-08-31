import type { SyncSettings } from '@open-note/core';

/** The editing preferences this panel exposes, from the vault settings file. */
export interface EditingPrefs {
  sortTodosOnCompletion: boolean;
  completion: boolean;
}

interface SettingsPanelProps {
  settings: SyncSettings;
  paused: boolean;
  prefs: EditingPrefs;
  onChange: (next: Partial<SyncSettings>) => void;
  onPausedChange: (paused: boolean) => void;
  onPrefsChange: (next: Partial<EditingPrefs>) => void;
  onClose: () => void;
}

const SECONDS: Array<{ key: keyof SyncSettings; label: string; hint: string }> = [
  { key: 'commitIdleMs', label: 'Commit after idle', hint: 'Quiet period before committing' },
  { key: 'commitMaxWaitMs', label: 'Commit at the latest', hint: 'Even while still typing' },
  { key: 'pushDebounceMs', label: 'Push delay', hint: 'Wait after a commit before pushing' },
  { key: 'fetchIntervalMs', label: 'Check for updates', hint: 'How often to poll the remote' },
];

export function SettingsPanel({
  settings,
  paused,
  prefs,
  onChange,
  onPausedChange,
  onPrefsChange,
  onClose,
}: SettingsPanelProps) {
  return (
    <aside className="settings">
      <header className="settings-head">
        <h2>Sync</h2>
        <button type="button" className="dismiss" onClick={onClose} aria-label="Close settings">
          ×
        </button>
      </header>

      <label className="setting-row is-prominent">
        <input
          type="checkbox"
          checked={paused}
          onChange={(e) => onPausedChange(e.target.checked)}
        />
        <span>
          <strong>Pause all syncing</strong>
          <small>Nothing is committed, pushed or fetched. Your files stay on disk.</small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={settings.autoCommit}
          onChange={(e) => onChange({ autoCommit: e.target.checked })}
        />
        <span>
          <strong>Commit automatically</strong>
          <small>Batch edits into a commit once you stop typing</small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={settings.autoPush}
          onChange={(e) => onChange({ autoPush: e.target.checked })}
        />
        <span>
          <strong>Push automatically</strong>
          <small>Publish commits to the remote</small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={settings.autoFetch}
          onChange={(e) => onChange({ autoFetch: e.target.checked })}
        />
        <span>
          <strong>Check for updates</strong>
          <small>Pull in work from your other machines and collaborators</small>
        </span>
      </label>

      <div className="settings-numbers">
        {SECONDS.map(({ key, label, hint }) => (
          <label key={key} className="setting-number">
            <span className="setting-label">
              {label}
              <small>{hint}</small>
            </span>
            <span className="setting-input">
              <input
                type="number"
                min={1}
                value={Math.round((settings[key] as number) / 1000)}
                onChange={(e) => {
                  const seconds = Number(e.target.value);
                  if (Number.isFinite(seconds) && seconds > 0) {
                    onChange({ [key]: seconds * 1000 } as Partial<SyncSettings>);
                  }
                }}
              />
              <em>sec</em>
            </span>
          </label>
        ))}
      </div>

      <h2 className="settings-section">Editing</h2>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.completion}
          onChange={(e) => onPrefsChange({ completion: e.target.checked })}
        />
        <span>
          <strong>Suggest while typing</strong>
          <small>
            Complete <code>[[</code> note links, <code>#</code> tags and <code>:</code> emoji
          </small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.sortTodosOnCompletion}
          onChange={(e) => onPrefsChange({ sortTodosOnCompletion: e.target.checked })}
        />
        <span>
          <strong>Sort completed tasks down</strong>
          <small>Move a task to the bottom of its list when you tick it</small>
        </span>
      </label>

      <p className="settings-note">
        Saved to <code>.opennote/settings.json</code> in this vault, so it follows the repo.
      </p>
    </aside>
  );
}
