import { parseRemote } from '@open-note/core';
import { useMemo, useState } from 'react';

import { api } from '../api';
import { errorText } from '../useWorkspace';

interface CloneDialogProps {
  onCloned: (root: string) => void;
  onClose: () => void;
}

/** Clone a repository and open it, for someone with no local copy yet. */
export function CloneDialog({ onCloned, onClose }: CloneDialogProps) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseRemote(url), [url]);
  // Default the folder name to the repository name, until the user edits it.
  const folder = name.trim() || parsed?.repo || '';
  const ready = Boolean(url.trim() && parent && folder);

  const choose = async () => {
    const picked = await api.pickFolder();
    if (picked) setParent(picked);
  };

  const clone = async () => {
    if (!parent || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const info = await api.cloneVault(url.trim(), parent, folder);
      onCloned(info.root);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="clone" role="dialog" aria-modal="true" aria-label="Clone a vault">
        <h2>Clone a vault</h2>
        <p className="muted-note">
          Uses your existing git setup, so SSH keys and credential helpers work as they already do.
        </p>

        <label className="clone-field">
          <span>Repository URL</span>
          <input
            value={url}
            autoFocus
            placeholder="git@github.com:you/notes.git"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        <label className="clone-field">
          <span>Folder name</span>
          <input value={folder} placeholder="notes" onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="clone-field">
          <span>Location</span>
          <button type="button" className="clone-location" onClick={choose}>
            {parent ?? 'Choose a folder…'}
          </button>
        </div>

        {parsed && (
          <p className="muted-note">
            Will clone into <code>{parent ? `${parent}/${folder}` : folder}</code>
          </p>
        )}
        {error && <p className="error">{error}</p>}

        <div className="clone-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={clone} disabled={!ready || busy}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  );
}
