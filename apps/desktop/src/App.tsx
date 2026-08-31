import {
  COMMANDS,
  dailyNotePath,
  dailyNoteTemplate,
  rewriteLinks,
  searchCommands,
  type TodoItem,
} from '@open-note/core';
import { editorCommands } from '@open-note/editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type VaultFile } from './api';
import { BacklinksPanel } from './components/BacklinksPanel';
import { BranchMenu } from './components/BranchMenu';
import { CloneDialog } from './components/CloneDialog';
import { ConflictPanel } from './components/ConflictPanel';
import { DrawingEditor } from './components/DrawingEditor';
import { ConfirmDelete, ContextMenu, type ContextTarget, Prompt } from './components/FileActions';
import { HistoryPanel } from './components/HistoryPanel';
import { KeymapPanel } from './components/KeymapPanel';
import { NoteEditor, type NoteEditorHandle } from './components/NoteEditor';
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
import { useDarkMode } from './useDarkMode';
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
  const [drawing, setDrawing] = useState<{ path: string; source: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [recents, setRecents] = useState<string[]>([]);
  const [booting, setBooting] = useState(true);
  /**
   * The right-hand inspector. Only one at a time: with the sidebar, the
   * backlinks column and two inspectors open at once the editor was squeezed
   * off the screen entirely.
   */
  const [panel, setPanel] = useState<'settings' | 'keymap' | 'history' | 'branches' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [showBacklinks, setShowBacklinks] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTodos, setShowTodos] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [prompt, setPrompt] = useState<
    { kind: 'newNote' | 'newFolder'; parent: string } | { kind: 'rename'; path: string } | null
  >(null);
  const [deleting, setDeleting] = useState<{ path: string; tracked: boolean | null } | null>(null);

  const saveTimer = useRef<number | null>(null);
  const pending = useRef<OpenNote | null>(null);
  const noteRef = useRef<OpenNote | null>(null);
  const editorRef = useRef<NoteEditorHandle>(null);
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
  const dark = useDarkMode();

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
          setDrawing(null);
          setPreview({ path: file.path, url: await api.readImage(root, file.path) });
          return;
        }
        if (file.kind === 'drawing') {
          setNote(null);
          setPreview(null);
          setDrawing({ path: file.path, source: await api.readDrawing(root, file.path) });
          return;
        }
        setPreview(null);
        setDrawing(null);
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

  const saveDrawing = useCallback(
    async (path: string, json: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        setSaveState('saving');
        await api.writeDrawing(root, path, json);
        setSaveState('saved');
        ws.noteSaved(root);
      } catch (e) {
        setSaveState('error');
        ws.setError(errorText(e));
      }
    },
    [ws],
  );

  /** Re-read the open note and the tree after git changed the working copy. */
  const reloadFromDisk = useCallback(async () => {
    const root = ws.activeRoot;
    if (!root) return;
    await ws.refreshFiles(root);
    const open = noteRef.current;
    if (!open) return;
    try {
      const fresh = await api.readNote(root, open.path);
      setNote((prev) => (prev ? { ...prev, doc: fresh, revision: prev.revision + 1 } : prev));
      vaultIndex.updateNote(open.path, fresh);
    } catch {
      // The note may not exist on the branch we just moved to.
      setNote(null);
    }
  }, [ws, vaultIndex]);

  const togglePanel = useCallback(
    (which: 'settings' | 'keymap' | 'history' | 'branches') =>
      setPanel((current) => (current === which ? null : which)),
    [],
  );

  // -- file management ----------------------------------------------------

  const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

  const newNote = useCallback(
    async (parent: string, name: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      const fileName = name.endsWith('.md') ? name : `${name}.md`;
      const path = joinPath(parent, fileName);
      try {
        const body = `# ${fileName.replace(/\.md$/, '')}\n\n`;
        await api.createNote(root, path, body);
        vaultIndex.updateNote(path, body);
        ws.noteSaved(root);
        await ws.refreshFiles(root);
        await openNoteAt(path);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex, openNoteAt],
  );

  const newFolder = useCallback(
    async (parent: string, name: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        await api.createFolder(root, joinPath(parent, name));
        // Git does not track empty folders, so the tree is the only place this
        // shows up until a note is put in it.
        await ws.refreshFiles(root);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws],
  );

  /**
   * Rename a note or folder, keeping `[[wikilinks]]` pointing at it.
   *
   * The link rewrites go in before the rename is announced, so both land in the
   * same automatic commit and can be reviewed — and reverted — as one change.
   */
  const rename = useCallback(
    async (from: string, name: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      const slash = from.lastIndexOf('/');
      const parent = slash === -1 ? '' : from.slice(0, slash);
      const isFolder = !from.includes('.') || !/\.[a-z0-9]+$/i.test(from);
      const target = !isFolder && !name.includes('.') ? `${name}.md` : name;
      const to = joinPath(parent, target);
      if (to === from) return;

      try {
        await api.renameEntry(root, from, to);

        let updated = 0;
        if (!isFolder) {
          const linkers = vaultIndex.index
            .backlinks(from)
            .map((link) => link.from)
            .filter((path) => path !== from);

          for (const path of linkers) {
            const source = await api.readNote(root, path);
            const rewrite = rewriteLinks(
              source,
              (candidate) => vaultIndex.index.resolveLink(candidate) === from,
              to,
            );
            if (rewrite.count === 0) continue;
            await api.writeNote(root, path, rewrite.text);
            vaultIndex.updateNote(path, rewrite.text);
            updated += rewrite.count;
          }
        }

        vaultIndex.removeNote(from);
        ws.noteSaved(root);
        await ws.refreshFiles(root);
        await vaultIndex.rebuild(root);

        if (noteRef.current?.path === from) await openNoteAt(to);
        if (updated > 0) {
          setMessage(`Renamed, and updated ${updated} link${updated === 1 ? '' : 's'}.`);
        }
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex, openNoteAt],
  );

  const remove = useCallback(
    async (path: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        await api.deleteEntry(root, path);
        vaultIndex.removeNote(path);
        ws.noteSaved(root);
        await ws.refreshFiles(root);
        if (noteRef.current?.path === path) {
          setNote(null);
          setPreview(null);
        }
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex],
  );

  const askDelete = useCallback(
    async (path: string) => {
      const root = ws.activeRoot;
      setDeleting({ path, tracked: null });
      if (!root) return;
      try {
        setDeleting({ path, tracked: await api.isTracked(root, path) });
      } catch {
        // Unknown: the dialog keeps its cautious wording.
        setDeleting({ path, tracked: false });
      }
    },
    [ws],
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
      'note.new': () => setPrompt({ kind: 'newNote', parent: '' }),
      'note.newFolder': () => setPrompt({ kind: 'newFolder', parent: '' }),
      'note.daily': () => {
        const today = new Date();
        void createNote(dailyNotePath(today), dailyNoteTemplate(today));
      },
      'sync.now': () => void sync(),
      'sync.togglePause': () => {
        if (ws.activeRoot) ws.setPaused(ws.activeRoot, !paused);
      },
      'sync.settings': () => togglePanel('settings'),
      'view.toggleSidebar': () => setShowSidebar((v) => !v),
      'view.toggleBacklinks': () => setShowBacklinks((v) => !v),
      'view.keymap': () => togglePanel('keymap'),
      // Editing commands are implemented in the editor package and reached
      // through the handle, so there is still exactly one key dispatcher.
      ...Object.fromEntries(
        Object.keys(editorCommands).map((id) => [
          id,
          () => {
            editorRef.current?.runCommand(id);
          },
        ]),
      ),
      'view.history': () => togglePanel('history'),
      'view.branches': () => togglePanel('branches'),
      'vault.clone': () => setShowClone(true),
    }),
    [openPalette, createNote, sync, ws, paused, togglePanel],
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
        <button type="button" className="linky" onClick={() => setShowClone(true)}>
          …or clone one from a URL
        </button>

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

        {showClone && (
          <CloneDialog
            onClose={() => setShowClone(false)}
            onCloned={(root) => {
              setShowClone(false);
              void ws.openVault(root);
            }}
          />
        )}
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
          <button
            type="button"
            className={panel === 'branches' ? 'is-on' : ''}
            onClick={() => togglePanel('branches')}
            title="Branches and pull requests"
          >
            {session.state.branch || session.info.branch}
          </button>
          <button
            type="button"
            className={panel === 'history' ? 'is-on' : ''}
            onClick={() => togglePanel('history')}
            disabled={!note}
            title={note ? 'History of this note' : 'Open a note to see its history'}
          >
            History
          </button>
          <button type="button" onClick={sync}>
            Sync now
          </button>
          <button type="button" onClick={() => togglePanel('settings')} aria-label="Sync settings">
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
              activePath={note?.path ?? preview?.path ?? drawing?.path ?? null}
              changedPaths={new Set(session.state.conflicts)}
              onSelect={select}
              onContext={(path, kind, x, y) => setContextTarget({ path, kind, x, y })}
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
              // `dark` is in the key because diagram SVGs bake in their colours
              // and must be redrawn when the theme changes.
              key={`${session.info.root}:${note.path}:${note.revision}:${dark}`}
              path={note.path}
              doc={note.doc}
              onChange={onDocChange}
              resolveLink={(target) => vaultIndex.index.resolveLink(target)}
              onFollowLink={followLink}
              dark={dark}
              ref={editorRef}
            />
          ) : drawing ? (
            <DrawingEditor
              path={drawing.path}
              source={drawing.source}
              dark={dark}
              onSave={(json) => void saveDrawing(drawing.path, json)}
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

        {note && showBacklinks && !conflicted && !showTodos && panel === null && (
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

        {panel === 'history' && note && (
          <HistoryPanel
            root={session.info.root}
            path={note.path}
            dirty={session.state.phase === 'dirty'}
            onClose={() => setPanel(null)}
            onRestored={() => void reloadFromDisk()}
          />
        )}

        {panel === 'branches' && (
          <BranchMenu
            root={session.info.root}
            current={session.state.branch || session.info.branch}
            onClose={() => setPanel(null)}
            onChanged={() => void reloadFromDisk()}
          />
        )}

        {panel === 'keymap' && (
          <KeymapPanel
            config={vaultIndex.keymapConfig}
            keymap={vaultIndex.keymap}
            onChange={vaultIndex.updateKeymap}
            onClose={() => setPanel(null)}
          />
        )}

        {panel === 'settings' && (
          <SettingsPanel
            settings={session.settings}
            paused={paused}
            onChange={(next) => void ws.updateSettings(session.info.root, next)}
            onPausedChange={(p) => ws.setPaused(session.info.root, p)}
            onClose={() => setPanel(null)}
          />
        )}
      </div>

      {contextTarget && (
        <ContextMenu
          target={contextTarget}
          onClose={() => setContextTarget(null)}
          onNewNote={(parent) => {
            setContextTarget(null);
            setPrompt({ kind: 'newNote', parent });
          }}
          onNewFolder={(parent) => {
            setContextTarget(null);
            setPrompt({ kind: 'newFolder', parent });
          }}
          onRename={(path) => {
            setContextTarget(null);
            setPrompt({ kind: 'rename', path });
          }}
          onDelete={(path) => {
            setContextTarget(null);
            void askDelete(path);
          }}
        />
      )}

      {prompt?.kind === 'newNote' && (
        <Prompt
          title="New note"
          label={prompt.parent ? `Name, in ${prompt.parent}` : 'Name'}
          hint="`.md` is added if you leave it off."
          onClose={() => setPrompt(null)}
          onConfirm={(name) => {
            setPrompt(null);
            void newNote(prompt.parent, name);
          }}
        />
      )}

      {prompt?.kind === 'newFolder' && (
        <Prompt
          title="New folder"
          label={prompt.parent ? `Name, in ${prompt.parent}` : 'Name'}
          onClose={() => setPrompt(null)}
          onConfirm={(name) => {
            setPrompt(null);
            void newFolder(prompt.parent, name);
          }}
        />
      )}

      {prompt?.kind === 'rename' && (
        <Prompt
          title="Rename"
          label="New name"
          initial={prompt.path.split('/').pop() ?? ''}
          confirmLabel="Rename"
          hint="Notes linking here with [[wikilinks]] are updated to match."
          onClose={() => setPrompt(null)}
          onConfirm={(name) => {
            const from = prompt.path;
            setPrompt(null);
            void rename(from, name);
          }}
        />
      )}

      {deleting && (
        <ConfirmDelete
          path={deleting.path}
          tracked={deleting.tracked}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const path = deleting.path;
            setDeleting(null);
            void remove(path);
          }}
        />
      )}

      {showClone && (
        <CloneDialog
          onClose={() => setShowClone(false)}
          onCloned={(root) => {
            setShowClone(false);
            void ws.openVault(root);
          }}
        />
      )}

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
