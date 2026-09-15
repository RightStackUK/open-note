import type { ImportWarning } from '@open-note/core';

import type { NotesFolder } from '../api';

/**
 * What an import is doing, while it does it.
 *
 * An Evernote archive or an Apple Notes library can hold thousands of notes
 * and take minutes, so an import cannot be a spinner: it reports what it is
 * reading, how far through it is, and what has landed.
 *
 * A union rather than one shape with optional fields, because two of these
 * states are not progress at all. Choosing folders happens *before* anything
 * is written — which is the only moment at which telling someone what will not
 * come across is any use to them — and a missing Automation permission is
 * fixed in System Settings, so it needs an explanation rather than an error.
 *
 * Stopping takes effect after the note in flight rather than unwinding.
 * Everything already written stays: it is in the vault and in Git, and taking
 * it back would be the destructive half of an operation that promised not to
 * be.
 */
export type ImportState =
  | { phase: 'permission' }
  | { phase: 'folders'; folders: NotesFolder[]; selected: Record<string, boolean> }
  | { phase: 'running'; label: string; notes: number; attachments: number; percent: number }
  | {
      phase: 'done';
      notes: number;
      attachments: number;
      summary: string;
      warnings: ImportWarning[];
    };

interface ImportDialogProps {
  title: string;
  state: ImportState;
  onCancel: () => void;
  onClose: () => void;
  /** Folder step only. */
  onToggle?: (id: string) => void;
  onStart?: () => void;
  /** Permission step only. */
  onOpenSettings?: () => void;
}

/** Warnings name the notes they happened in, and there can be hundreds. */
const NAMED_LIMIT = 12;

export function ImportDialog({
  title,
  state,
  onCancel,
  onClose,
  onToggle,
  onStart,
  onOpenSettings,
}: ImportDialogProps) {
  return (
    <div className="palette-backdrop" role="presentation">
      <div className="clone import" role="dialog" aria-modal="true" aria-label={title}>
        {state.phase === 'permission' && (
          <>
            <h2>Open Note needs permission</h2>
            <p className="muted-note">
              macOS asks before one app may read another's data. Open Note is not yet allowed to
              read Apple Notes, so there is nothing it can import.
            </p>
            <p className="muted-note">
              In <strong>System Settings → Privacy &amp; Security → Automation</strong>, find Open
              Note and switch <strong>Notes</strong> on. Then try the import again.
            </p>
            <div className="clone-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button type="button" className="primary" onClick={onOpenSettings}>
                Open System Settings
              </button>
            </div>
          </>
        )}

        {state.phase === 'folders' && (
          <>
            <h2>Import from Apple Notes</h2>
            <p className="muted-note">
              Folders become folders in your vault, and each note keeps the date Notes recorded.
            </p>
            {state.folders.length === 0 ? (
              <p className="muted-note">Apple Notes has no folders to import.</p>
            ) : (
              <ul className="import-folders">
                {state.folders.map((folder) => (
                  <li key={folder.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={state.selected[folder.id] ?? false}
                        onChange={() => onToggle?.(folder.id)}
                      />
                      <span>{folder.path}</span>
                      <span className="muted-note">
                        {folder.count} note{folder.count === 1 ? '' : 's'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {/*
              Said before the import rather than after it. Apple Notes can hand
              over a note's text and the images inside it, and nothing else —
              so a PDF or a voice memo stays where it is, and a locked note
              cannot be read at all. Finding that out afterwards, from a vault
              that is missing things, is the bad version of this.
            */}
            <p className="muted-note import-caveat">
              Text and inline images come across. Other attachments — PDFs, scans, voice memos —
              cannot be exported by Apple Notes and stay there; so do locked notes. Both are listed
              when the import finishes.
            </p>
            <div className="clone-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={onStart}
                disabled={!Object.values(state.selected).some(Boolean)}
              >
                Import
              </button>
            </div>
          </>
        )}

        {state.phase === 'running' && (
          <>
            <h2>{title}</h2>
            <p className="muted-note">{state.label || 'Starting…'}</p>
            <div
              className="import-bar"
              role="progressbar"
              aria-valuenow={state.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="import-bar-fill" style={{ width: `${state.percent}%` }} />
            </div>
            <p className="muted-note">
              {state.notes} note{state.notes === 1 ? '' : 's'}
              {state.attachments > 0
                ? `, ${state.attachments} attachment${state.attachments === 1 ? '' : 's'}`
                : ''}
            </p>
            <div className="clone-actions">
              <button type="button" onClick={onCancel}>
                Stop
              </button>
            </div>
          </>
        )}

        {state.phase === 'done' && (
          <>
            <h2>Import finished</h2>
            <p className="muted-note">{state.summary}</p>
            {state.warnings.length > 0 && (
              <>
                {/*
                  Named, not only counted: "3 notes were locked" does not tell
                  anyone which three, and the whole point of reporting them is
                  that the user can go and deal with them.
                */}
                <ul className="import-warnings">
                  {state.warnings.slice(0, NAMED_LIMIT).map((warning, index) => (
                    <li key={`${warning.note}-${warning.reason}-${index}`}>
                      <strong>{warning.note || 'The import'}</strong> — {warning.reason}
                    </li>
                  ))}
                </ul>
                {state.warnings.length > NAMED_LIMIT && (
                  <p className="muted-note">…and {state.warnings.length - NAMED_LIMIT} more.</p>
                )}
              </>
            )}
            <div className="clone-actions">
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
