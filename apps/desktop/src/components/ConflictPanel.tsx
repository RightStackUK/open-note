import { useCallback, useEffect, useState } from 'react';

import { api, type ConflictSide } from '../api';
import { errorText } from '../useWorkspace';

interface ConflictPanelProps {
  root: string;
  conflicts: string[];
  onResolved: () => void;
  onOpenFile: (path: string) => void;
}

/**
 * Conflict resolution.
 *
 * The engine parks the vault here and does nothing further on its own. Every
 * option below is an explicit choice by the user, including "keep both" which
 * simply hands them the file with git's markers still in it.
 */
export function ConflictPanel({ root, conflicts, onResolved, onOpenFile }: ConflictPanelProps) {
  const [pending, setPending] = useState<string[]>(conflicts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);

  useEffect(() => setPending(conflicts), [conflicts]);

  const take = useCallback(
    async (path: string, side: ConflictSide) => {
      setBusy(true);
      setError(null);
      try {
        await api.resolveConflict(root, path, side);
        setPending((prev) => prev.filter((p) => p !== path));
        if (preview?.path === path) setPreview(null);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [root, preview],
  );

  const finish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.rebaseContinue(root);
      if (outcome.kind === 'conflicted') {
        // A multi-commit rebase can stop again on the next commit.
        setPending(outcome.paths);
        setError('More conflicts to resolve.');
        return;
      }
      onResolved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [root, onResolved]);

  const abort = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.rebaseAbort(root);
      onResolved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [root, onResolved]);

  const inspect = useCallback(
    async (path: string) => {
      try {
        setPreview({ path, text: await api.readRaw(root, path) });
      } catch (e) {
        setError(errorText(e));
      }
    },
    [root],
  );

  return (
    <div className="conflict">
      <header className="conflict-head">
        <h2>Conflicting edits</h2>
        <p>
          This note was changed both here and elsewhere. Nothing has been discarded — choose which
          version to keep, or edit the file yourself.
        </p>
      </header>

      {error && <p className="error">{error}</p>}

      <ul className="conflict-list">
        {pending.map((path) => (
          <li key={path}>
            <div className="conflict-file">
              <code>{path}</code>
              <button type="button" className="linky" onClick={() => inspect(path)}>
                Show both versions
              </button>
            </div>
            <div className="conflict-actions">
              <button type="button" disabled={busy} onClick={() => take(path, 'mine')}>
                Keep mine
              </button>
              <button type="button" disabled={busy} onClick={() => take(path, 'theirs')}>
                Keep theirs
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onOpenFile(path)}
                title="Open the file with git's conflict markers and merge it by hand"
              >
                Edit by hand
              </button>
            </div>
          </li>
        ))}
        {pending.length === 0 && <li className="conflict-done">All conflicts resolved.</li>}
      </ul>

      {preview && (
        <pre className="conflict-preview">
          <code>{preview.text}</code>
        </pre>
      )}

      <footer className="conflict-foot">
        <button
          type="button"
          className="primary"
          disabled={busy || pending.length > 0}
          onClick={finish}
        >
          Finish merge
        </button>
        <button type="button" disabled={busy} onClick={abort}>
          Cancel the merge
        </button>
        <small>Cancelling puts the vault back exactly as it was before the update arrived.</small>
      </footer>
    </div>
  );
}
