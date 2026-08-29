import {
  COMMANDS,
  dailyNotePath,
  dailyNoteTemplate,
  searchCommands,
  type TodoItem,
} from '@open-note/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type VaultFile } from './api';
import { BacklinksPanel } from './components/BacklinksPanel';
import { ConflictPanel } from './components/ConflictPanel';
import { KeymapPanel } from './components/KeymapPanel';
import { NoteEditor } from './components/NoteEditor';
import {
  commandItems,
  noteItems,
  Palette,
  type PaletteMode,
  searchItems,
} from './components/Palette';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { SyncBadge } from './components/SyncBadge';
import { TodoView } from './components/TodoView';
import { PLATFORM, useCommandKeys } from './useCommands';
import { useVaultIndex } from './useVaultIndex';
import { errorText, useWorkspace } from './useWorkspace';

/** How long the editor sits idle before the note is written to disk. */
const AUTOSAVE_IDLE_MS = 500;

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface OpenNote {
  path: string;
  doc: string;
  /** Bumped to force the editor to reload, e.g. after an upstream change. */
  revision: number;
}

export function App() {
  const [note, setNote] = useState<OpenNote | null>(null);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [recents, setRecents] = useState<string[]>([]);
  const [booting, setBooting] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [showBacklinks, setShowBacklinks] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTodos, setShowTodos] = useState(false);
  const [showKeymap, setShowKeymap] = useState(false);

  const saveTimer = useRef<number | null>(null);
  const pending = useRef<OpenNote | null>(null);
  const noteRef = useRef<OpenNote | null>(null);
  noteRef.current = note;

  // When a pull rewrites the open note underneath us, reload it rather than
  // letting the user keep typing into a stale document.
  const onExternalChange = useCallback((root: string) => {
    const open = noteRef.current;
    if (!open) return;
    void api
      .readNote(root, open.path)
      .then((fresh) => {
        if (fresh !== noteRef.current?.doc) {
          setNote((prev) => (prev ? { ...prev, doc: fresh, revision: prev.revision + 1 } : prev));
          setMessage(`${open.path} was updated from the remote.`);
        }
      })
      .catch(() => {
        // The note may have been deleted upstream; the tree refresh covers that.
      });
  }, []);

  const ws = useWorkspace(onExternalChange);
  const session = ws.activeRoot ? ws.sessions[ws.activeRoot] : undefined;
  const paused = ws.activeRoot ? ws.isPaused(ws.activeRoot) : false;
  const vaultIndex = useVaultIndex(ws.activeRoot);

  const openVault = ws.openVault;
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
    if (!picked) return;
    await ws.openVault(picked);
    setRecents(await api.recentVaults());
  }, [ws]);

  const flush = useCallback(async () => {
    const outstanding = pending.current;
    const root = ws.activeRoot;
    if (!outstanding || !root) return;
    pending.current = null;
    setSaveState('saving');
    try {
      await api.writeNote(root, outstanding.path, outstanding.doc);
      setSaveState('saved');
      // Search, backlinks and tasks must reflect what was just written.
      vaultIndex.updateNote(outstanding.path, outstanding.doc);
      // Tell the sync engine a file landed; it owns the commit decision.
      ws.noteSaved(root);
    } catch (e) {
      setSaveState('error');
      ws.setError(errorText(e));
    }
  }, [ws, vaultIndex]);

  const onDocChange = useCallback(
    (doc: string) => {
      const open = noteRef.current;
      if (!open) return;
      pending.current = { ...open, doc };
      setSaveState('dirty');
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, AUTOSAVE_IDLE_MS);
    },
    [flush],
  );

  const select = useCallback(
    async (file: VaultFile) => {
      const root = ws.activeRoot;
      if (!root) return;
      // A queued write must never land under a different note.
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flush();
      ws.setError(null);

      try {
        if (file.kind === 'image') {
          setNote(null);
          setPreview({ path: file.path, url: await api.readImage(root, file.path) });
          return;
        }
        setPreview(null);
        setNote({ path: file.path, doc: await api.readNote(root, file.path), revision: 0 });
        setSaveState('saved');
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, flush],
  );

  const openConflicted = useCallback(
    async (path: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        // Raw, so git's markers are visible and can be merged by hand.
        setPreview(null);
        setNote({ path, doc: await api.readRaw(root, path), revision: 0 });
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws],
  );

  const sync = useCallback(async () => {
    const root = ws.activeRoot;
    if (!root) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    await flush();
    await ws.syncNow(root);
  }, [ws, flush]);

  const openNoteAt = useCallback(
    async (path: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flush();
      try {
        setShowTodos(false);
        setPreview(null);
        setNote({ path, doc: await api.readNote(root, path), revision: 0 });
        setSaveState('saved');
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, flush],
  );

  const createNote = useCallback(
    async (path: string, body: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        const existing = await api.readNote(root, path).catch(() => null);
        if (existing === null) {
          await api.writeNote(root, path, body);
          vaultIndex.updateNote(path, body);
          ws.noteSaved(root);
        }
        await openNoteAt(path);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex, openNoteAt],
  );

  /**
   * Follow a `[[wikilink]]`.
   *
   * An unresolved target creates the note rather than doing nothing: writing the
   * link is how you say the note should exist.
   */
  const followLink = useCallback(
    (target: string, resolved: string | null) => {
      if (resolved) {
        void openNoteAt(resolved);
        return;
      }
      const path = target.endsWith('.md') ? target : `${target}.md`;
      void createNote(path, `# ${target}\n\n`);
    },
    [openNoteAt, createNote],
  );

  const openPalette = useCallback((mode: PaletteMode) => {
    setPaletteQuery('');
    setPalette(mode);
  }, []);

  const handlers = useMemo(
    () => ({
      'palette.open': () => openPalette('commands'),
      'switcher.open': () => openPalette('notes'),
      'search.open': () => openPalette('search'),
      'todos.open': () => {
        setShowTodos(true);
        setNote(null);
        setPreview(null);
      },
      'note.new': () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        void createNote(`untitled-${stamp}.md`, '# \n\n');
      },
      'note.daily': () => {
        const today = new Date();
        void createNote(dailyNotePath(today), dailyNoteTemplate(today));
      },
      'sync.now': () => void sync(),
      'sync.togglePause': () => {
        if (ws.activeRoot) ws.setPaused(ws.activeRoot, !paused);
      },
      'sync.settings': () => setShowSettings((v) => !v),
      'view.toggleSidebar': () => setShowSidebar((v) => !v),
      'view.toggleBacklinks': () => setShowBacklinks((v) => !v),
      'view.keymap': () => setShowKeymap((v) => !v),
    }),
    [openPalette, createNote, sync, ws, paused],
  );

  useCommandKeys(vaultIndex.keymap, handlers, palette === null);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (pending.current) void flush();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [flush]);

  if (booting) return <main className="welcome" />;

  if (!session) {
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
                <button type="button" className="recent" onClick={() => ws.openVault(root)}>
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
        {ws.error && <p className="error">{ws.error}</p>}
      </main>
    );
  }

  const openVaults = Object.values(ws.sessions);
  const conflicted = session.state.phase === 'conflict';

  // `revision` is the dependency that matters: the index object is stable and
  // mutated in place, so React cannot see changes without it.
  const backlinks = note ? vaultIndex.index.backlinks(note.path) : [];
  const noteTags = note ? (vaultIndex.index.get(note.path)?.tags ?? []) : [];
  const todos = showTodos ? vaultIndex.index.todos() : [];

  const paletteItems = (() => {
    if (palette === 'commands') {
      return commandItems(
        searchCommands(paletteQuery, COMMANDS),
        vaultIndex.keymap.byCommand,
        PLATFORM,
      );
    }
    if (palette === 'notes') return noteItems(vaultIndex.index.quickSwitch(paletteQuery));
    if (palette === 'search') return searchItems(vaultIndex.index.query(paletteQuery));
    return [];
  })();

  const onPaletteChoose = (id: string) => {
    setPalette(null);
    if (palette === 'commands') {
      handlers[id as keyof typeof handlers]?.();
      return;
    }
    void openNoteAt(id);
  };

  const toggleTodo = async (todo: TodoItem) => {
    const root = ws.activeRoot;
    if (!root) return;
    try {
      const source = await api.readNote(root, todo.path);
      const lines = source.split('\n');
      const line = lines[todo.line - 1];
      if (line === undefined) return;
      // Flip only the checkbox character, leaving the rest of the line alone.
      lines[todo.line - 1] = todo.done
        ? line.replace(/\[[xX]\]/, '[ ]')
        : line.replace(/\[ \]/, '[x]');
      const updated = lines.join('\n');
      await api.writeNote(root, todo.path, updated);
      vaultIndex.updateNote(todo.path, updated);
      ws.noteSaved(root);
      if (note?.path === todo.path) {
        setNote((prev) => (prev ? { ...prev, doc: updated, revision: prev.revision + 1 } : prev));
      }
    } catch (e) {
      ws.setError(errorText(e));
    }
  };

  return (
    <div className="app">
      <header className="titlebar">
        <nav className="vault-tabs">
          {openVaults.map((s) => (
            <button
              key={s.info.root}
              type="button"
              className={`vault-tab ${s.info.root === ws.activeRoot ? 'is-active' : ''}`}
              onClick={() => ws.setActiveRoot(s.info.root)}
              title={s.info.root}
            >
              <span className={`tab-dot is-${s.state.phase}`} />
              {s.info.name}
            </button>
          ))}
          <button type="button" className="vault-tab is-add" onClick={choose} title="Open a vault">
            +
          </button>
        </nav>

        <div className="actions">
          <span className={`save-state is-${saveState}`}>{saveLabel(saveState)}</span>
          <SyncBadge state={session.state} paused={paused} />
          <button type="button" onClick={() => openPalette('search')} title="Search (Mod-Shift-F)">
            Search
          </button>
          <button
            type="button"
            className={showTodos ? 'is-on' : ''}
            onClick={() => {
              setShowTodos((v) => !v);
              setPreview(null);
            }}
            title="Tasks"
          >
            Tasks
          </button>
          <button type="button" onClick={sync}>
            Sync now
          </button>
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-label="Sync settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {(ws.error || message) && (
        <div className={`banner ${ws.error ? 'is-error' : ''}`}>
          {ws.error ?? message}
          <button
            type="button"
            className="dismiss"
            onClick={() => {
              ws.setError(null);
              setMessage(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      <div className="body">
        {showSidebar && (
          <aside className="sidebar">
            <div className="sidebar-branch">
              <span className="branch">{session.state.branch || session.info.branch}</span>
              {!session.state.upstream && <span className="no-upstream">no upstream</span>}
            </div>
            <Sidebar
              files={session.files}
              activePath={note?.path ?? preview?.path ?? null}
              changedPaths={new Set(session.state.conflicts)}
              onSelect={select}
            />
          </aside>
        )}

        <section className="pane">
          {showTodos ? (
            <TodoView
              todos={todos}
              onOpen={(path) => void openNoteAt(path)}
              onToggle={(todo) => void toggleTodo(todo)}
            />
          ) : conflicted ? (
            <ConflictPanel
              root={session.info.root}
              conflicts={session.state.conflicts}
              onOpenFile={openConflicted}
              onResolved={() => {
                void ws.conflictResolved(session.info.root);
                void ws.refreshFiles(session.info.root);
              }}
            />
          ) : note ? (
            <NoteEditor
              key={`${session.info.root}:${note.path}:${note.revision}`}
              path={note.path}
              doc={note.doc}
              onChange={onDocChange}
              resolveLink={(target) => vaultIndex.index.resolveLink(target)}
              onFollowLink={followLink}
            />
          ) : preview ? (
            <div className="preview">
              <img src={preview.url} alt={preview.path} />
              <p className="preview-caption">{preview.path} — preview only</p>
            </div>
          ) : (
            <p className="pane-empty">Select a note to start writing.</p>
          )}
        </section>

        {note && showBacklinks && !conflicted && !showTodos && (
          <BacklinksPanel
            path={note.path}
            backlinks={backlinks}
            tags={noteTags}
            onOpen={(path) => void openNoteAt(path)}
            onSelectTag={(tag) => {
              setPaletteQuery(tag);
              setPalette('search');
            }}
          />
        )}

        {showKeymap && (
          <KeymapPanel
            config={vaultIndex.keymapConfig}
            keymap={vaultIndex.keymap}
            onChange={vaultIndex.updateKeymap}
            onClose={() => setShowKeymap(false)}
          />
        )}

        {showSettings && (
          <SettingsPanel
            settings={session.settings}
            paused={paused}
            onChange={(next) => void ws.updateSettings(session.info.root, next)}
            onPausedChange={(p) => ws.setPaused(session.info.root, p)}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>

      {palette && (
        <Palette
          mode={palette}
          query={paletteQuery}
          items={paletteItems}
          onQueryChange={setPaletteQuery}
          onChoose={onPaletteChoose}
          onClose={() => setPalette(null)}
        />
      )}
    </div>
  );
}

function saveLabel(state: SaveState): string {
  if (state === 'saving') return 'Saving…';
  if (state === 'dirty') return 'Unsaved';
  if (state === 'error') return 'Save failed';
  return 'Saved';
}
