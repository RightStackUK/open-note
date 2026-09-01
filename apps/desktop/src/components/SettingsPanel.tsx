import {
  BUILT_IN_THEMES,
  DEFAULT_TYPOGRAPHY,
  type NoteListDensity,
  type NoteListPrefs,
  parseTypography,
  type SyncSettings,
  type Theme,
  type TypographySettings,
} from '@open-note/core';

/** The editing preferences this panel exposes, from the vault settings file. */
export interface EditingPrefs {
  sortTodosOnCompletion: boolean;
  completion: boolean;
  concealEverywhere: boolean;
  newNoteHeading: 'h1' | 'none';
  insertTagsAt: 'top' | 'bottom';
  theme: string;
  typography: TypographySettings;
  noteList: NoteListPrefs;
  attachmentFolder: string;
  imageDisplay: 'full' | 'thumbnail';
  archiveFolder: string;
  spellcheck: boolean;
  pasteAsMarkdown: boolean;
  fetchLinkTitles: boolean;
  copyStripsTags: boolean;
}

interface SettingsPanelProps {
  settings: SyncSettings;
  paused: boolean;
  prefs: EditingPrefs;
  /** Themes found in `.opennote/themes/`, offered beside the built-ins. */
  themes: Theme[];
  onChange: (next: Partial<SyncSettings>) => void;
  onPausedChange: (paused: boolean) => void;
  onPrefsChange: (next: Partial<EditingPrefs>) => void;
  onClose: () => void;
}

/**
 * Fonts offered in the pickers. Suggestions, not a fence: the input is free
 * text via a datalist, because the webview cannot enumerate the system's fonts
 * and an unknown family degrades gracefully to the default stack anyway.
 */
const TEXT_FONTS = [
  'Charter',
  'Georgia',
  'Iowan Old Style',
  'Palatino',
  'Baskerville',
  'New York',
  'Helvetica Neue',
  'Avenir Next',
  'Seravek',
  'Verdana',
];
const CODE_FONTS = ['SF Mono', 'Menlo', 'Consolas', 'JetBrains Mono', 'Fira Code', 'Courier New'];

const TYPO_NUMBERS: Array<{
  key: keyof TypographySettings;
  label: string;
  hint: string;
  step: number;
  unit: string;
}> = [
  { key: 'fontSize', label: 'Font size', hint: 'Base size for note text', step: 1, unit: 'px' },
  { key: 'lineHeight', label: 'Line height', hint: 'Space between lines', step: 0.05, unit: '×' },
  { key: 'lineWidth', label: 'Line width', hint: 'How wide a line may run', step: 2, unit: 'rem' },
  {
    key: 'paragraphSpacing',
    label: 'Paragraph spacing',
    hint: 'Extra space below each line',
    step: 1,
    unit: 'px',
  },
  {
    key: 'paragraphIndent',
    label: 'Paragraph indent',
    hint: 'First-line indent',
    step: 0.25,
    unit: 'em',
  },
];

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
  themes,
  onChange,
  onPausedChange,
  onPrefsChange,
  onClose,
}: SettingsPanelProps) {
  const typography = prefs.typography;
  // Through the same parser that reads the file, so the UI cannot store what a
  // reload would then clamp — clearing the size field must not apply 0px.
  const setTypography = (next: Partial<TypographySettings>) =>
    onPrefsChange({ typography: parseTypography({ ...typography, ...next }) });

  // Vault themes first — they can shadow a built-in of the same name.
  const themeNames = [
    ...themes.map((t) => t.name),
    ...BUILT_IN_THEMES.filter(
      (b) => !themes.some((t) => t.name.toLowerCase() === b.name.toLowerCase()),
    ).map((b) => b.name),
  ];
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

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.concealEverywhere}
          onChange={(e) => onPrefsChange({ concealEverywhere: e.target.checked })}
        />
        <span>
          <strong>Always hide Markdown syntax</strong>
          <small>Conceal markers on the line being edited too</small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.spellcheck}
          onChange={(e) => onPrefsChange({ spellcheck: e.target.checked })}
        />
        <span>
          <strong>Spell check</strong>
          <small>
            The OS checker also smart-substitutes quotes and dashes, which corrupts code and YAML —
            hence off by default
          </small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.pasteAsMarkdown}
          onChange={(e) => onPrefsChange({ pasteAsMarkdown: e.target.checked })}
        />
        <span>
          <strong>Paste as Markdown</strong>
          <small>Convert pasted web content to clean Markdown</small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.fetchLinkTitles}
          onChange={(e) => onPrefsChange({ fetchLinkTitles: e.target.checked })}
        />
        <span>
          <strong>Fetch titles for pasted links</strong>
          <small>Turns a pasted URL into a named link. Makes a network request per paste.</small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.copyStripsTags}
          onChange={(e) => onPrefsChange({ copyStripsTags: e.target.checked })}
        />
        <span>
          <strong>Copy As strips tags</strong>
          <small>
            Drop <code>#tag</code> tokens from copied text
          </small>
        </span>
      </label>

      <label className="setting-select">
        <span className="setting-label">
          New notes start with
          <small>What a freshly created note contains</small>
        </span>
        <select
          value={prefs.newNoteHeading}
          onChange={(e) => onPrefsChange({ newNoteHeading: e.target.value as 'h1' | 'none' })}
        >
          <option value="h1">A heading with the title</option>
          <option value="none">An empty page</option>
        </select>
      </label>

      <label className="setting-select">
        <span className="setting-label">
          Insert tags at
          <small>Where “Add tag to note” puts the tag</small>
        </span>
        <select
          value={prefs.insertTagsAt}
          onChange={(e) => onPrefsChange({ insertTagsAt: e.target.value as 'top' | 'bottom' })}
        >
          <option value="top">The top of the note</option>
          <option value="bottom">The bottom of the note</option>
        </select>
      </label>

      <h2 className="settings-section">Note list</h2>

      <label className="setting-select">
        <span className="setting-label">
          Row size
          <small>Small rows drop the excerpt</small>
        </span>
        <select
          value={prefs.noteList.density}
          onChange={(e) =>
            onPrefsChange({
              noteList: { ...prefs.noteList, density: e.target.value as NoteListDensity },
            })
          }
        >
          <option value="small">Small</option>
          <option value="medium">Medium</option>
          <option value="large">Large</option>
        </select>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.noteList.showBadges}
          onChange={(e) =>
            onPrefsChange({ noteList: { ...prefs.noteList, showBadges: e.target.checked } })
          }
        />
        <span>
          <strong>Show attachment badges</strong>
          <small>Mark notes that embed images or files</small>
        </span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={prefs.noteList.includeNestedTags}
          onChange={(e) =>
            onPrefsChange({ noteList: { ...prefs.noteList, includeNestedTags: e.target.checked } })
          }
        />
        <span>
          <strong>Parent tags include children</strong>
          <small>
            Selecting <code>#work</code> also lists notes tagged <code>#work/urgent</code>
          </small>
        </span>
      </label>

      <h2 className="settings-section">Attachments</h2>

      <label className="setting-number">
        <span className="setting-label">
          Attachment folder
          <small>
            Vault-relative. <code>.</code> keeps files beside their note.
          </small>
        </span>
        <span className="setting-input">
          <input
            type="text"
            value={prefs.attachmentFolder}
            onChange={(e) => onPrefsChange({ attachmentFolder: e.target.value })}
          />
        </span>
      </label>

      <label className="setting-number">
        <span className="setting-label">
          Archive folder
          <small>Archived notes move here — a visible folder, never a hidden flag</small>
        </span>
        <span className="setting-input">
          <input
            type="text"
            value={prefs.archiveFolder}
            onChange={(e) => onPrefsChange({ archiveFolder: e.target.value })}
          />
        </span>
      </label>

      <label className="setting-select">
        <span className="setting-label">
          Images in notes
          <small>Full width, or contained thumbnails</small>
        </span>
        <select
          value={prefs.imageDisplay}
          onChange={(e) => onPrefsChange({ imageDisplay: e.target.value as 'full' | 'thumbnail' })}
        >
          <option value="full">Full width</option>
          <option value="thumbnail">Thumbnails</option>
        </select>
      </label>

      <p className="settings-note">
        A vault is a Git repository, and large binaries make it a slow one. For big attachments,
        consider <code>git-lfs</code> — Open Note uses your own <code>git</code>, so it is picked up
        automatically.
      </p>

      <h2 className="settings-section">Appearance</h2>

      <label className="setting-select">
        <span className="setting-label">
          Theme
          <small>
            Vault themes live in <code>.opennote/themes/</code> and sync like notes
          </small>
        </span>
        <select value={prefs.theme} onChange={(e) => onPrefsChange({ theme: e.target.value })}>
          <option value="">Follow the system</option>
          {themeNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <h2 className="settings-section">Typography</h2>

      <div className="settings-numbers">
        <label className="setting-number">
          <span className="setting-label">
            Text font
            <small>Empty uses the built-in serif</small>
          </span>
          <span className="setting-input">
            <input
              type="text"
              list="text-fonts"
              placeholder="Default"
              value={typography.textFont}
              onChange={(e) => setTypography({ textFont: e.target.value })}
            />
          </span>
        </label>
        <label className="setting-number">
          <span className="setting-label">
            Headings font
            <small>Empty matches the app UI</small>
          </span>
          <span className="setting-input">
            <input
              type="text"
              list="text-fonts"
              placeholder="Default"
              value={typography.headingFont}
              onChange={(e) => setTypography({ headingFont: e.target.value })}
            />
          </span>
        </label>
        <label className="setting-number">
          <span className="setting-label">
            Code font
            <small>Empty uses the built-in monospace</small>
          </span>
          <span className="setting-input">
            <input
              type="text"
              list="code-fonts"
              placeholder="Default"
              value={typography.codeFont}
              onChange={(e) => setTypography({ codeFont: e.target.value })}
            />
          </span>
        </label>
        <datalist id="text-fonts">
          {TEXT_FONTS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <datalist id="code-fonts">
          {CODE_FONTS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>

        {TYPO_NUMBERS.map(({ key, label, hint, step, unit }) => (
          <label key={key} className="setting-number">
            <span className="setting-label">
              {label}
              <small>{hint}</small>
            </span>
            <span className="setting-input">
              <input
                type="number"
                step={step}
                value={typography[key] as number}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value)) setTypography({ [key]: value });
                }}
              />
              <em>{unit}</em>
            </span>
          </label>
        ))}
      </div>

      <button
        type="button"
        className="ghost settings-restore"
        onClick={() => onPrefsChange({ typography: { ...DEFAULT_TYPOGRAPHY } })}
      >
        Restore default typography
      </button>

      <p className="settings-note">
        Saved to <code>.opennote/settings.json</code> in this vault, so it follows the repo.
      </p>
    </aside>
  );
}
