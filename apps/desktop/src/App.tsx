import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type RepoStatus, type SyncReport, type VaultFile, type VaultInfo } from './api';
import { NoteEditor } from './components/NoteEditor';
import { Sidebar } from './components/Sidebar';

/** How long the editor sits idle before the note is written to disk. */
const AUTOSAVE_IDLE_MS = 500;

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface OpenNote {
  path: string;
  doc: string;
}

export function App() {
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [note, setNote] = useState<OpenNote | null>(null);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [booting, setBooting] = useState(true);

  const saveTimer = useRef<number | null>(null);
  // The editor calls back with plain strings; this holds whatever is not yet
  // on disk so the autosave timer always writes the newest text.
  const pending = useRef<OpenNote | null>(null);

  const refresh = useCallback(async (root: string) => {
    const [list, repoStatus] = await Promise.all([api.listFiles(root), api.status(root)]);
    setFiles(list);
    setStatus(repoStatus);
  }, []);

  const openVault = useCallback(
    async (root: string) => {
      setError(null);
      try {
        const info = await api.openVault(root);
        setVault(info);
        setRecents(await api.recentVaults());
        setNote(null);
        setPreview(null);
        await refresh(root);
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  // Reopen wherever we left off. Having to re-pick a folder on every launch
  // makes the app unusable as a daily notes tool.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.recentVaults();
        if (cancelled) return;
        setRecents(list);
        const last = list[0];
        if (last) await openVault(last);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openVault]);

  const choose = useCallback(async () => {
    const picked = await api.pickVault();
    if (picked) await openVault(picked);
  }, [openVault]);

  const flush = useCallback(async () => {
    const outstanding = pending.current;
    if (!outstanding || !vault) return;
    pending.current = null;
    setSaveState('saving');
    try {
      await api.writeNote(vault.root, outstanding.path, outstanding.doc);
      setSaveState('saved');
      // A new note only appears in the tree once it exists on disk.
      await refresh(vault.root);
    } catch (e) {
      setSaveState('error');
      setError(String(e));
    }
  }, [vault, refresh]);

  const onDocChange = useCallback(
    (doc: string) => {
      if (!note) return;
      pending.current = { path: note.path, doc };
      setSaveState('dirty');
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, AUTOSAVE_IDLE_MS);
    },
    [note, flush],
  );

  const select = useCallback(
    async (file: VaultFile) => {
      if (!vault) return;
      // Never let a pending write land under a different note.
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flush();
      setError(null);

      if (file.kind === 'image') {
        try {
          setNote(null);
          setPreview({ path: file.path, url: await api.readImage(vault.root, file.path) });
        } catch (e) {
          setError(String(e));
        }
        return;
      }

      try {
        setPreview(null);
        setNote({ path: file.path, doc: await api.readNote(vault.root, file.path) });
        setSaveState('saved');
      } catch (e) {
        setError(String(e));
      }
    },
    [vault, flush],
  );

  const sync = useCallback(async () => {
    if (!vault || syncing) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    await flush();

    setSyncing(true);
    setError(null);
    setMessage(null);
    try {
      const report: SyncReport = await api.sync(vault.root);
      setStatus(report.status);
      setMessage(describeSync(report));
      if (report.blocked) setError(report.blocked);
      await refresh(vault.root);

      // Upstream work may have rewritten the open note underneath us.
      if (note) {
        const fresh = await api.readNote(vault.root, note.path);
        if (fresh !== note.doc) setNote({ path: note.path, doc: fresh });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [vault, syncing, flush, refresh, note]);

  // Write anything outstanding before the window disappears.
  useEffect(() => {
    const onBeforeUnload = () => {
      if (pending.current) void flush();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [flush]);

  const changedPaths = new Set(status?.changes.map((c) => c.path) ?? []);

  if (booting) return <main className="welcome" />;

  if (!vault) {
    return (
      <main className="welcome">
        <h1>Open Note</h1>
        <p className="tagline">Markdown notes, backed by Git.</p>
        <button type="button" className="primary" onClick={choose}>
          Open a vault…
        </button>
        <p className="hint">Choose any folder that is a Git repository.</p>

        {recents.length > 0 && (
          <ul className="recents">
            {recents.map((root) => (
              <li key={root}>
                <button type="button" className="recent" onClick={() => openVault(root)}>
                  <span className="recent-name">{root.split('/').pop()}</span>
                  <span className="recent-path">{root}</span>
                </button>
                <button
                  type="button"
                  className="dismiss"
                  title="Forget this vault"
                  onClick={async () => {
                    await api.forgetVault(root);
                    setRecents(await api.recentVaults());
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="vault-id">
          <strong>{vault.name}</strong>
          <span className="branch">{status?.branch ?? vault.branch}</span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="counters">
              {status.ahead > 0 && <span title="commits to push">↑{status.ahead}</span>}
              {status.behind > 0 && <span title="commits to pull">↓{status.behind}</span>}
            </span>
          )}
        </div>
        <div className="actions">
          <span className={`save-state is-${saveState}`}>{saveLabel(saveState)}</span>
          <button type="button" onClick={sync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button type="button" onClick={choose}>
            Open…
          </button>
        </div>
      </header>

      {(error || message) && (
        <div className={`banner ${error ? 'is-error' : ''}`}>
          {error ?? message}
          <button
            type="button"
            className="dismiss"
            onClick={() => (setError(null), setMessage(null))}
          >
            ×
          </button>
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <Sidebar
            files={files}
            activePath={note?.path ?? preview?.path ?? null}
            changedPaths={changedPaths}
            onSelect={select}
          />
        </aside>

        <section className="pane">
          {note ? (
            <NoteEditor path={note.path} doc={note.doc} onChange={onDocChange} />
          ) : preview ? (
            <div className="preview">
              <img src={preview.url} alt={preview.path} />
              <p className="preview-caption">{preview.path} — preview only</p>
            </div>
          ) : (
            <p className="pane-empty">Select a note to start writing.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function saveLabel(state: SaveState): string {
  if (state === 'saving') return 'Saving…';
  if (state === 'dirty') return 'Unsaved';
  if (state === 'error') return 'Save failed';
  return 'Saved';
}

/** Turn a sync report into one honest sentence. */
function describeSync(report: SyncReport): string {
  if (report.blocked) return report.blocked;

  const parts: string[] = [];
  if (report.committed) parts.push('committed');
  if (report.pulled && report.pulled.kind === 'rebased') {
    parts.push(`pulled ${report.pulled.commits} commit${report.pulled.commits === 1 ? '' : 's'}`);
  }
  if (report.pushed) parts.push('pushed');
  return parts.length > 0 ? `Sync: ${parts.join(', ')}.` : 'Already up to date.';
}
