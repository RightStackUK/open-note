import { useCallback, useEffect, useState } from 'react';

import { api, type CommitInfo } from '../api';
import { errorText } from '../useWorkspace';
import { DiffView } from './DiffView';

interface HistoryPanelProps {
  root: string;
  path: string;
  /** True when the note has uncommitted edits, so "now" is worth showing. */
  dirty: boolean;
  onClose: () => void;
  onRestored: () => void;
}

/** Turn an ISO date into something a person reads at a glance. */
function relativeDate(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export { relativeDate };

/**
 * A note's history.
 *
 * Selecting a commit shows what changed in it. Restoring writes the old version
 * into the working tree rather than committing it, so the user still sees the
 * change and can undo it before it is published.
 */
export function HistoryPanel({ root, path, dirty, onClose, onRestored }: HistoryPanelProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected(null);
    setDiff('');
    api
      .history(root, path)
      .then((list) => {
        if (!cancelled) setCommits(list);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, path]);

  const showCommit = useCallback(
    async (commit: CommitInfo, index: number) => {
      setSelected(commit.id);
      setError(null);
      try {
        // Diff against the previous commit that touched this note, so the view
        // shows what that commit changed rather than everything since.
        const previous = commits[index + 1];
        setDiff(
          previous
            ? await api.noteDiff(root, previous.id, commit.id, path)
            : await api.noteDiff(root, `${commit.id}^`, commit.id, path).catch(async () => {
                // No parent: this is the commit that created the note.
                const content = await api.noteAtCommit(root, commit.id, path);
                return content
                  .split('\n')
                  .map((line) => `+${line}`)
                  .join('\n');
              }),
        );
      } catch (e) {
        setError(errorText(e));
      }
    },
    [root, path, commits],
  );

  const showUncommitted = useCallback(async () => {
    setSelected('working');
    setError(null);
    try {
      setDiff(await api.noteDiff(root, 'HEAD', null, path));
    } catch (e) {
      setError(errorText(e));
    }
  }, [root, path]);

  const restore = useCallback(
    async (commit: CommitInfo) => {
      setError(null);
      try {
        await api.restoreNote(root, commit.id, path);
        onRestored();
      } catch (e) {
        setError(errorText(e));
      }
    },
    [root, path, onRestored],
  );

  const discard = useCallback(async () => {
    setError(null);
    try {
      await api.discardChanges(root, path);
      onRestored();
    } catch (e) {
      setError(errorText(e));
    }
  }, [root, path, onRestored]);

  return (
    <aside className="settings history">
      <header className="settings-head">
        <h2>History</h2>
        <button type="button" className="dismiss" onClick={onClose} aria-label="Close history">
          ×
        </button>
      </header>
      <p className="muted-note history-path">{path}</p>

      {error && <p className="error">{error}</p>}

      {dirty && (
        <div className="history-uncommitted">
          <button
            type="button"
            className={`history-item ${selected === 'working' ? 'is-active' : ''}`}
            onClick={showUncommitted}
          >
            <span className="history-subject">Uncommitted changes</span>
            <span className="history-meta">not yet saved to git</span>
          </button>
          <button type="button" className="linky danger" onClick={discard}>
            Discard them
          </button>
        </div>
      )}

      {loading ? (
        <p className="muted-note">Reading history…</p>
      ) : commits.length === 0 ? (
        <p className="muted-note">This note has no history yet — it has never been committed.</p>
      ) : (
        <ul className="history-list">
          {commits.map((commit, index) => (
            <li key={commit.id}>
              <button
                type="button"
                className={`history-item ${selected === commit.id ? 'is-active' : ''}`}
                onClick={() => void showCommit(commit, index)}
              >
                <span className="history-subject">{commit.subject}</span>
                <span className="history-meta">
                  {commit.author} · {relativeDate(commit.date)} · <code>{commit.shortId}</code>
                </span>
              </button>
              {selected === commit.id && index > 0 && (
                <button
                  type="button"
                  className="linky"
                  onClick={() => void restore(commit)}
                  title="Put this version back as an uncommitted change"
                >
                  Restore this version
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="history-diff">
          <DiffView diff={diff} />
        </div>
      )}
    </aside>
  );
}
