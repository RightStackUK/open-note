/**
 * What an import is doing, while it does it.
 *
 * An Evernote archive can hold thousands of notes and take minutes, so the
 * import cannot be a spinner: it reports the notebook it is reading, how far
 * through the file it is, and what has landed so far. Progress is in bytes
 * because the note count is unknowable without reading the whole file first.
 *
 * Cancel stops after the note in flight rather than unwinding. Everything
 * already written stays — it is in the vault and in Git, and taking it back
 * would be the destructive half of an operation that promised not to be.
 */
export interface ImportState {
  phase: 'running' | 'done';
  /** The notebook being read. */
  file: string;
  notes: number;
  attachments: number;
  percent: number;
  /** The closing summary, once there is one. */
  summary: string | null;
}

interface ImportDialogProps {
  state: ImportState;
  onCancel: () => void;
  onClose: () => void;
}

export function ImportDialog({ state, onCancel, onClose }: ImportDialogProps) {
  const running = state.phase === 'running';

  return (
    <div className="palette-backdrop" role="presentation">
      <div className="clone" role="dialog" aria-modal="true" aria-label="Import from Evernote">
        <h2>{running ? 'Importing from Evernote' : 'Import finished'}</h2>

        {running ? (
          <>
            <p className="muted-note">
              {state.file ? `Reading ${state.file}…` : 'Opening the export…'}
            </p>
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
          </>
        ) : (
          <p className="muted-note">{state.summary}</p>
        )}

        <div className="clone-actions">
          {running ? (
            <button type="button" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
