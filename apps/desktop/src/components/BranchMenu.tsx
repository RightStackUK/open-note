import { forgeLabel, newPullRequestUrl, parseRemote } from '@open-note/core';
import { useCallback, useEffect, useState } from 'react';

import { api, type Branch } from '../api';
import { errorText } from '../useWorkspace';

interface BranchMenuProps {
  root: string;
  current: string;
  onClose: () => void;
  /** Called after anything that changes the working tree. */
  onChanged: () => void;
}

/**
 * Branches, and the route from a branch to a pull request.
 *
 * Opening the forge's own "new pull request" page in a browser rather than
 * posting through its API: it needs no token, works on every forge including
 * self-hosted ones, and leaves the user reviewing the change on the site that
 * will host it.
 */
export function BranchMenu({ root, current, onClose, onChanged }: BranchMenuProps) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [remote, setRemote] = useState<ReturnType<typeof parseRemote>>(null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, url] = await Promise.all([api.branches(root), api.remoteUrl(root)]);
      setBranches(list);
      setRemote(url ? parseRemote(url) : null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await refresh();
        onChanged();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh, onChanged],
  );

  const create = useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    void act(async () => {
      await api.createBranch(root, name);
      setNewName('');
    });
  }, [act, newName, root]);

  const local = branches.filter((b) => !b.isRemote);
  // A pull request only makes sense from a branch that is not the default one.
  const canOpenPr = remote && current !== 'main' && current !== 'master';
  const prUrl = canOpenPr ? newPullRequestUrl(remote, current, 'main') : null;

  return (
    <aside className="settings branches">
      <header className="settings-head">
        <h2>Branches</h2>
        <button type="button" className="dismiss" onClick={onClose} aria-label="Close branches">
          ×
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="branch-new">
        <input
          value={newName}
          placeholder="New branch name…"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <button type="button" onClick={create} disabled={busy || !newName.trim()}>
          Create
        </button>
      </div>

      <ul className="branch-list">
        {local.map((branch) => (
          <li key={branch.name} className={branch.isCurrent ? 'is-current' : ''}>
            <button
              type="button"
              className="branch-name"
              disabled={busy || branch.isCurrent}
              onClick={() => void act(() => api.switchBranch(root, branch.name))}
              title={branch.isCurrent ? 'Current branch' : `Switch to ${branch.name}`}
            >
              <span className="branch-dot">{branch.isCurrent ? '●' : '○'}</span>
              {branch.name}
              {branch.upstream && <small>{branch.upstream}</small>}
            </button>
            {!branch.isCurrent && (
              <span className="branch-actions">
                <button
                  type="button"
                  className="linky"
                  disabled={busy}
                  onClick={() => void act(() => api.mergeBranch(root, branch.name))}
                  title={`Merge ${branch.name} into ${current}`}
                >
                  Merge
                </button>
                <button
                  type="button"
                  className="linky danger"
                  disabled={busy}
                  onClick={() => void act(() => api.deleteBranch(root, branch.name, false))}
                  title="Delete; refuses if it has unmerged work"
                >
                  Delete
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      <section className="branch-pr">
        <h3>Pull request</h3>
        {!remote ? (
          <p className="muted-note">
            This vault has no remote, so there is nowhere to open a pull request.
          </p>
        ) : prUrl ? (
          <>
            <p className="muted-note">
              Open a pull request on {forgeLabel(remote.kind)} from <code>{current}</code> into{' '}
              <code>main</code>. Push your branch first.
            </p>
            <button
              type="button"
              className="primary as-button"
              onClick={() => void api.openExternal(prUrl).catch((e) => setError(errorText(e)))}
            >
              Open on {forgeLabel(remote.kind)}
            </button>
          </>
        ) : canOpenPr ? (
          <p className="muted-note">
            {remote.host} was not recognised, so there is no reliable pull-request URL to offer.
          </p>
        ) : (
          <p className="muted-note">
            You are on <code>{current}</code>. Create a branch to open a pull request.
          </p>
        )}
      </section>
    </aside>
  );
}
