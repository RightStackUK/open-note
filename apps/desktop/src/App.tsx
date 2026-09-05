import {
  archivePathFor,
  attachmentFolderFor,
  bindingToAccelerator,
  buildNoteList,
  buildTextpack,
  bytesToBase64,
  COMMANDS,
  type Collection,
  clampZoom,
  collectionTitle,
  DEFAULT_TYPOGRAPHY,
  dailyNotePath,
  dailyNoteTemplate,
  dataUrlToBytes,
  exportAnchor,
  exportFileName,
  exportNotesToHtml,
  exportNoteToDocx,
  exportNoteToHtml,
  formatBinding,
  isArchivedPath,
  localAssetReferences,
  maskCode,
  mentionPattern,
  mergeNotes,
  noteHasTag,
  noteStats,
  parseTheme,
  removeTagFromNote,
  renameTagInNote,
  renderNoteBody,
  renderTemplate,
  resolveTheme,
  rewriteLinks,
  searchCommands,
  splitFrontmatter,
  stripTags,
  TEMPLATES_FOLDER,
  type Theme,
  type TodoItem,
  themeCssVariables,
  toPlainText,
  typographyCssVariables,
  ZOOM_STEP,
} from '@open-note/core';
import { sanitiseSvg } from '@open-note/diagrams';
import { editorCommands } from '@open-note/editor';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type VaultFile } from './api';
import { BranchMenu } from './components/BranchMenu';
import { CloneDialog } from './components/CloneDialog';
import { ConflictPanel } from './components/ConflictPanel';
import { DrawingEditor } from './components/DrawingEditor';
import {
  ConfirmAction,
  ConfirmDelete,
  ContextMenu,
  type ContextTarget,
  Prompt,
} from './components/FileActions';
import { HistoryPanel } from './components/HistoryPanel';
import { InfoPanel, type InfoTab } from './components/InfoPanel';
import { KeymapPanel } from './components/KeymapPanel';
import { NoteEditor, type NoteEditorHandle } from './components/NoteEditor';
import { NoteList } from './components/NoteList';
import {
  commandItems,
  noteItems,
  Palette,
  type PaletteMode,
  searchItems,
} from './components/Palette';
import { PaneResizer } from './components/PaneResizer';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';
import { SyncBadge } from './components/SyncBadge';
import { TagPanel } from './components/TagPanel';
import { TextEditor } from './components/TextEditor';
import { TodoView } from './components/TodoView';
import { MENU_EVENT, MENU_ONLY, type MenuCommand } from './menu';
import { PANE_DEFAULTS, PANE_LIMITS, type PaneWidths, readPaneWidths } from './panes';
import { relativeFrom, resolveAgainst } from './paths';
import { PLATFORM, useCommandKeys } from './useCommands';
import { useDarkMode } from './useDarkMode';
import { useVaultIndex } from './useVaultIndex';
import { errorText, useWorkspace } from './useWorkspace';

/** Bring the window forward, for global hotkeys and `opennote://` URLs. */
async function focusWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const current = getCurrentWindow();
    await current.show();
    await current.unminimize();
    await current.setFocus();
  } catch {
    // Outside the desktop shell there is no window to raise.
  }
}

/** Loose path equality, for matching a deep link's vault against known ones. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** How long the editor sits idle before the note is written to disk. */
const AUTOSAVE_IDLE_MS = 500;

/** Marks a quick-switcher row that creates rather than opens. */
const CREATE_PREFIX = 'create:';
/** Marks a tag row in the tag quick-open palette. */
const TAG_PREFIX = 'tag:';
/** Marks a template row when creating a note from one. */
const TEMPLATE_PREFIX = 'template:use:';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface OpenNote {
  /**
   * The vault this document came from.
   *
   * Carried on the note rather than read from `activeRoot` at write time: a
   * queued autosave outlives a vault switch, and without this it would land in
   * whichever vault happened to be active when the timer fired.
   */
  root: string;
  path: string;
  doc: string;
  /**
   * Which editor to use. A vault holds ordinary files as well as notes, and a
   * `.ts` wants line numbers and a monospace face, not a serif measure.
   */
  kind: 'markdown' | 'text';
  /** Bumped to force the editor to reload, e.g. after an upstream change. */
  revision: number;
}

export function App() {
  const [note, setNote] = useState<OpenNote | null>(null);
  const [preview, setPreview] = useState<{
    path: string;
    url: string;
    kind: 'image' | 'pdf';
  } | null>(null);
  /** Embeds collapsed in this window, by path. A reading posture, unpersisted. */
  const [collapsedEmbeds, setCollapsedEmbeds] = useState<Set<string>>(new Set());
  /** Notes whose `readOnly` frontmatter has been overridden this session. */
  const [readOnlyOverrides, setReadOnlyOverrides] = useState<Set<string>>(new Set());
  const [drawing, setDrawing] = useState<{ path: string; source: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [recents, setRecents] = useState<string[]>([]);
  const [booting, setBooting] = useState(true);
  /**
   * The right-hand inspector. Only one at a time: with the sidebar, the
   * backlinks column and two inspectors open at once the editor was squeezed
   * off the screen entirely.
   */
  const [panel, setPanel] = useState<
    'settings' | 'keymap' | 'history' | 'branches' | 'tags' | 'outline' | null
  >(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [info, setInfo] = useState<{ open: boolean; tab: InfoTab }>({
    open: true,
    tab: 'backlinks',
  });
  const [showSidebar, setShowSidebar] = useState(
    () => localStorage.getItem('opennote:pane:tree') !== 'off',
  );
  const [showList, setShowList] = useState(
    () => localStorage.getItem('opennote:pane:list') !== 'off',
  );
  // Pane widths, in px, machine-local like the pane visibility above: how wide
  // the tree is on this screen has nothing to do with the vault, so it does not
  // belong in `.opennote/` where it would travel to a laptop with a different
  // display. Read once; `PANE_DEFAULTS` covers a first run or a corrupt value.
  const [paneWidths, setPaneWidths] = useState(readPaneWidths);
  const setPaneWidth = useCallback((pane: keyof PaneWidths, next: (previous: number) => number) => {
    setPaneWidths((prev) => ({ ...prev, [pane]: Math.round(next(prev[pane])) }));
  }, []);
  const [collection, setCollection] = useState<Collection>({ kind: 'all' });
  /** Search follows the active collection until the chip is dismissed. */
  const [searchScoped, setSearchScoped] = useState(true);
  const [showTodos, setShowTodos] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [prompt, setPrompt] = useState<
    | { kind: 'newNote' | 'newFolder'; parent: string }
    | { kind: 'rename'; path: string }
    | { kind: 'addTag' }
    | { kind: 'renameTag'; tag: string; count: number }
    | { kind: 'fromTemplate'; template: string }
    | { kind: 'mergeFolder'; folder: string; paths: string[] }
    | null
  >(null);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    run: () => void;
  } | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; tracked: boolean | null } | null>(null);

  const saveTimer = useRef<number | null>(null);
  /**
   * Navigation history: where you have been, with the reading position.
   *
   * Above the editor, not inside it — CodeMirror's history is document undo,
   * and conflating the two would make ⌘Z navigate. Per window, deliberately
   * not persisted.
   */
  const backStack = useRef<Array<{ path: string; view: { scroll: number; anchor: number } }>>([]);
  const forwardStack = useRef<Array<{ path: string; view: { scroll: number; anchor: number } }>>(
    [],
  );
  /** Set while nav.back/forward drives the change, so it is not re-recorded. */
  const navigating = useRef(false);
  /** A view to restore once the target note has mounted. */
  const pendingView = useRef<{ scroll: number; anchor: number } | null>(null);
  /**
   * The path most recently navigated to, updated synchronously.
   *
   * `noteRef` only updates when React re-renders, so two rapid navigations
   * would both see the original note as "where we came from" and push it
   * twice. This ref is the same fact without the render lag.
   */
  const currentNavPath = useRef<string | null>(null);
  const pending = useRef<OpenNote | null>(null);
  const noteRef = useRef<OpenNote | null>(null);
  const editorRef = useRef<NoteEditorHandle>(null);
  /** Line to jump to once the editor has mounted the incoming note. */
  const pendingLine = useRef<number | null>(null);
  /** Which vault the editor is currently showing, to spot a tab switch. */
  const lastActiveRoot = useRef<string | null>(null);
  /** The note each vault was last on, so switching back resumes it. */
  const lastNoteByVault = useRef(new Map<string, string>());
  noteRef.current = note;

  // When a pull rewrites the open note underneath us, reload it rather than
  // letting the user keep typing into a stale document.
  const onExternalChange = useCallback((root: string) => {
    const open = noteRef.current;
    if (!open || open.root !== root) return;
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
  const systemDark = useDarkMode();

  useEffect(() => {
    localStorage.setItem('opennote:pane:tree', showSidebar ? 'on' : 'off');
    localStorage.setItem('opennote:pane:list', showList ? 'on' : 'off');
  }, [showSidebar, showList]);

  useEffect(() => {
    localStorage.setItem('opennote:pane:widths', JSON.stringify(paneWidths));
  }, [paneWidths]);

  /**
   * Created dates, from the first commit that added each path.
   *
   * Loaded once per vault: the definition survives a clone, and a note created
   * this session simply has no entry, which the list treats as "as new as its
   * mtime". Not refreshed per commit — the created date of an existing file
   * cannot change.
   */
  const [createdDates, setCreatedDates] = useState<Map<string, number>>(new Map());
  // Both a sync and a plain local commit can mint created dates.
  const lastSyncedAt = `${session?.state.lastSyncedAt ?? 0}:${session?.state.ahead ?? 0}`;
  useEffect(() => {
    setCreatedDates(new Map());
    const root = ws.activeRoot;
    if (!root) return;
    let cancelled = false;
    void api
      .createdDates(root)
      .then((dates) => {
        if (!cancelled) setCreatedDates(new Map(Object.entries(dates)));
      })
      .catch(() => {
        // No history yet, or git is unhappy: created falls back to mtime.
      });
    return () => {
      cancelled = true;
    };
    // `lastSyncedAt` is a real dependency by design: a sync can commit a new
    // note, which is the moment it acquires a created date.
  }, [ws.activeRoot, lastSyncedAt]);

  /**
   * The local date, as a render input.
   *
   * "Today" is an mtime comparison against midnight, and a list left open
   * across midnight would otherwise keep yesterday until something else
   * happened to re-render it. One check a minute is invisible and enough.
   */
  const [dayStamp, setDayStamp] = useState(() => new Date().toDateString());
  useEffect(() => {
    const timer = window.setInterval(() => setDayStamp(new Date().toDateString()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // -- appearance -----------------------------------------------------------

  const [vaultThemes, setVaultThemes] = useState<Theme[]>([]);
  useEffect(() => {
    // Cleared before fetching: the old vault's themes must not stay applied to
    // the new one while its own are still loading — a same-named theme would
    // wear the wrong colours.
    setVaultThemes([]);
    const root = ws.activeRoot;
    if (!root) return;
    let cancelled = false;
    void api
      .readThemes(root)
      .then((raws) => {
        if (cancelled) return;
        // parseTheme returns null for unusable files; they are simply absent
        // from the picker rather than an error in the way.
        setVaultThemes(raws.map(parseTheme).filter((t): t is Theme => t !== null));
      })
      .catch(() => {
        // A late rejection from the vault being left must not clear the new
        // vault's already-loaded themes.
        if (!cancelled) setVaultThemes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ws.activeRoot]);

  // An explicit theme pins the appearance; no theme follows the OS.
  const activeTheme = session?.theme ? resolveTheme(session.theme, vaultThemes) : null;
  const dark = activeTheme ? activeTheme.appearance === 'dark' : systemDark;

  /** Zoom is a per-machine reading posture, not a property of the vault. */
  const [zoom, setZoom] = useState(() =>
    clampZoom(Number(localStorage.getItem('opennote:zoom') ?? '1')),
  );
  const changeZoom = useCallback((next: number) => {
    const clamped = clampZoom(next);
    setZoom(clamped);
    localStorage.setItem('opennote:zoom', String(clamped));
  }, []);

  // Everything lands as CSS custom properties on the root element: the theme's
  // colours, then typography. Nothing rebuilds; the text reflows.
  useEffect(() => {
    const style = document.documentElement.style;
    const vars: Record<string, string> = {
      ...(activeTheme ? themeCssVariables(activeTheme) : {}),
      ...typographyCssVariables(session?.typography ?? DEFAULT_TYPOGRAPHY, zoom),
    };
    for (const [key, value] of Object.entries(vars)) style.setProperty(key, value);
    // A pinned theme also pins the chrome; otherwise both schemes stay allowed.
    style.setProperty('color-scheme', activeTheme ? activeTheme.appearance : 'light dark');
    return () => {
      for (const key of Object.keys(vars)) style.removeProperty(key);
      style.removeProperty('color-scheme');
    };
  }, [activeTheme, session?.typography, zoom]);

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

  const openRecent = useCallback(
    async (root: string) => {
      await ws.openVault(root);
      // Opening reorders the list, and a vault that has since been deleted is
      // pruned on the way back out.
      setRecents(await api.recentVaults());
    },
    [ws],
  );

  const clearRecents = useCallback(async () => {
    await api.clearRecentVaults();
    setRecents(await api.recentVaults());
  }, []);

  const flush = useCallback(async () => {
    const outstanding = pending.current;
    if (!outstanding) return;
    // The write goes to the vault the document was opened from, never to
    // whichever vault is active now — the two differ for a save queued just
    // before a tab switch.
    const root = outstanding.root;
    pending.current = null;
    setSaveState('saving');
    try {
      await api.writeNote(root, outstanding.path, outstanding.doc);
      setSaveState('saved');
      // Adopt what was just written as the open document. Without this the
      // counters, the outline and an export all read the text as it was when
      // the note was opened. Doing it here rather than per keystroke means the
      // app re-renders when typing pauses, not on every character; `revision`
      // deliberately does not change, so the editor is not torn down.
      setNote((prev) =>
        prev && prev.root === root && prev.path === outstanding.path && prev.doc !== outstanding.doc
          ? { ...prev, doc: outstanding.doc }
          : prev,
      );
      // Search, backlinks and tasks must reflect what was just written — but
      // the index belongs to the active vault, so only when they are the same.
      if (root === ws.activeRoot) vaultIndex.updateNote(outstanding.path, outstanding.doc);
      // Tell the sync engine a file landed; it owns the commit decision.
      ws.noteSaved(root);
    } catch (e) {
      setSaveState('error');
      ws.setError(errorText(e));
    }
  }, [ws, vaultIndex]);

  /**
   * The freshest known text for the open note.
   *
   * Typing lands in `pending` (a ref) ahead of the autosave, so remounting the
   * editor from `note.doc` alone — which a theme flip does, via the React key —
   * would resurrect a version up to 500ms stale and let the next keystroke
   * overwrite what was really written.
   */
  const freshestDoc = (open: OpenNote): string =>
    pending.current && pending.current.root === open.root && pending.current.path === open.path
      ? pending.current.doc
      : open.doc;

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

  /**
   * Close one vault, leaving the others open.
   *
   * `closeVault` stops the engine and drops the session. What has to happen
   * first is the save that has not landed yet: a debounced write may still be
   * queued against this vault, and the engine that would commit it is about to
   * go away. Closing a vault is not discarding what you last typed in it.
   */
  const closeVaultAt = useCallback(
    async (root: string) => {
      if (pending.current?.root === root) await flush();
      ws.closeVault(root);
    },
    [ws, flush],
  );

  /**
   * Push where we are leaving onto the back stack, browser-style: every
   * ordinary navigation extends the trail and burns the forward path.
   *
   * The reading position is only captured when the editor is actually showing
   * the departing note — during a rapid navigation burst it may still be
   * rendering an earlier one, and attributing that scroll to this path would
   * restore somewhere nonsensical.
   */
  const recordDeparture = useCallback((root: string, to: string) => {
    const leavingPath = currentNavPath.current ?? noteRef.current?.path ?? null;
    currentNavPath.current = to;
    if (navigating.current) return;
    if (!leavingPath || leavingPath === to) return;
    if (noteRef.current && noteRef.current.root !== root) return;
    // A repeat of the top entry is the rapid-click artefact, not a revisit.
    if (backStack.current[backStack.current.length - 1]?.path === leavingPath) return;

    const editorShowsLeaving = noteRef.current?.path === leavingPath;
    backStack.current.push({
      path: leavingPath,
      view: editorShowsLeaving
        ? (editorRef.current?.captureView() ?? { scroll: 0, anchor: 0 })
        : { scroll: 0, anchor: 0 },
    });
    forwardStack.current = [];
  }, []);

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
          setPreview({ path: file.path, url: await api.readImage(root, file.path), kind: 'image' });
          return;
        }
        if (file.kind === 'pdf') {
          setNote(null);
          setDrawing(null);
          // The webview's own viewer does the rendering; nothing to bundle.
          setPreview({ path: file.path, url: await api.readPdf(root, file.path), kind: 'pdf' });
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
        // The tree and the list are navigations like any other; skipping the
        // trail here would make Back unable to return to where you were.
        recordDeparture(root, file.path);
        setNote({
          root,
          path: file.path,
          doc: await api.readNote(root, file.path),
          kind: file.kind === 'text' ? 'text' : 'markdown',
          revision: 0,
        });
        setSaveState('saved');
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, flush, recordDeparture],
  );

  const openConflicted = useCallback(
    async (path: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        // Raw, so git's markers are visible and can be merged by hand.
        setPreview(null);
        setNote({ root, path, doc: await api.readRaw(root, path), kind: 'markdown', revision: 0 });
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

  /**
   * Open a note, optionally landing the caret on a given 1-based line.
   *
   * The jump is deferred through a ref because the editor is remounted for the
   * new document; calling `goToLine` here would address the outgoing view.
   */

  const openNoteAt = useCallback(
    async (path: string, line?: number, explicitRoot?: string) => {
      // A deep link may name a vault other than the active one, and the store's
      // active root has not reached this closure yet — so the caller can pass
      // the resolved root explicitly.
      const root = explicitRoot ?? ws.activeRoot;
      if (!root) return;
      if (explicitRoot && ws.activeRoot !== explicitRoot) ws.setActiveRoot(explicitRoot);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flush();
      try {
        recordDeparture(root, path);
        setShowTodos(false);
        setPreview(null);
        setDrawing(null);
        pendingLine.current = line ?? null;
        setNote({ root, path, doc: await api.readNote(root, path), kind: 'markdown', revision: 0 });
        setSaveState('saved');
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, flush, recordDeparture],
  );

  /** Walk the history one step; `direction` names the stack being popped. */
  const navigateHistory = useCallback(
    async (direction: 'back' | 'forward') => {
      const from = direction === 'back' ? backStack.current : forwardStack.current;
      const onto = direction === 'back' ? forwardStack.current : backStack.current;
      const target = from.pop();
      if (!target) return;

      const leaving = noteRef.current;
      if (leaving) {
        onto.push({
          path: leaving.path,
          view: editorRef.current?.captureView() ?? { scroll: 0, anchor: 0 },
        });
      }

      navigating.current = true;
      pendingView.current = target.view;
      currentNavPath.current = target.path;
      try {
        await openNoteAt(target.path);
      } finally {
        navigating.current = false;
      }
    },
    [openNoteAt],
  );

  /**
   * Follow the active vault: park the outgoing note and restore this vault's.
   *
   * Without this the editor kept showing a note from the vault you just left,
   * and typing into it created that file in the new repository. Which note was
   * last open is remembered per vault, so switching tabs returns you to where
   * you were rather than to an empty pane.
   */
  useEffect(() => {
    const root = ws.activeRoot;
    if (lastActiveRoot.current === root) return;
    const leaving = lastActiveRoot.current;
    lastActiveRoot.current = root;

    const open = noteRef.current;
    if (leaving) {
      if (open && open.root === leaving) lastNoteByVault.current.set(leaving, open.path);
      else lastNoteByVault.current.delete(leaving);
    }

    // A queued save still belongs to the vault being left; land it there.
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    void flush();

    setNote(null);
    setPreview(null);
    setDrawing(null);
    setShowTodos(false);
    setPanel(null);
    setSaveState('saved');
    backStack.current = [];
    forwardStack.current = [];
    currentNavPath.current = null;
    setCollection({ kind: 'all' });

    if (!root) return;
    const remembered = lastNoteByVault.current.get(root);
    // Only if it is still there: the note may have been deleted, or the vault
    // may have moved to a branch without it.
    const stillThere = ws.sessions[root]?.files.some((file) => file.path === remembered);
    if (remembered && stillThere) void openNoteAt(remembered);
  }, [ws.activeRoot, ws.sessions, flush, openNoteAt]);

  useEffect(() => {
    if (!note) return;
    const line = pendingLine.current;
    if (line !== null) {
      pendingLine.current = null;
      editorRef.current?.goToLine(line);
    }
    const view = pendingView.current;
    if (view) {
      pendingView.current = null;
      editorRef.current?.restoreView(view);
    }
  }, [note]);

  /** What a fresh note contains, per the vault's `newNoteHeading` preference. */
  const newNoteBody = useCallback(
    (title: string) => (session?.newNoteHeading === 'none' ? '' : `# ${title}\n\n`),
    [session?.newNoteHeading],
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
      void createNote(path, newNoteBody(target));
    },
    [openNoteAt, createNote, newNoteBody],
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
    // Branch switches and restores run git outside the engine, so the status
    // it publishes — the branch name in particular — is stale until asked.
    await Promise.all([ws.refreshFiles(root), ws.refreshStatus(root)]);
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
    (which: 'settings' | 'keymap' | 'history' | 'branches' | 'tags' | 'outline') =>
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
        const body = newNoteBody(fileName.replace(/\.md$/, ''));
        await api.createNote(root, path, body);
        vaultIndex.updateNote(path, body);
        ws.noteSaved(root);
        await ws.refreshFiles(root);
        await openNoteAt(path);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex, openNoteAt, newNoteBody],
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
   * Move a note or folder to a new path, keeping `[[wikilinks]]` pointing at it.
   *
   * Renaming and dragging into a folder are the same operation with a different
   * destination, so they share this one. The link rewrites go in before the move
   * is announced, so both land in the same automatic commit and can be reviewed
   * — and reverted — as one change.
   */
  const relocate = useCallback(
    async (from: string, to: string, verb: 'Renamed' | 'Moved') => {
      const root = ws.activeRoot;
      if (!root || to === from) return;
      const isFolder = !from.includes('.') || !/\.[a-z0-9]+$/i.test(from);

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
        setMessage(
          updated > 0
            ? `${verb}, and updated ${updated} link${updated === 1 ? '' : 's'}.`
            : `${verb} to ${to}.`,
        );
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex, openNoteAt],
  );

  const rename = useCallback(
    (from: string, name: string) => {
      const slash = from.lastIndexOf('/');
      const parent = slash === -1 ? '' : from.slice(0, slash);
      const isFolder = !from.includes('.') || !/\.[a-z0-9]+$/i.test(from);
      const target = !isFolder && !name.includes('.') ? `${name}.md` : name;
      return relocate(from, joinPath(parent, target), 'Renamed');
    },
    [relocate],
  );

  /**
   * Drag a note or folder onto another folder.
   *
   * A move is a rename that keeps the name, so it goes through the same path —
   * which is what keeps `[[wikilinks]]` pointing at the note afterwards.
   */
  const move = useCallback(
    (from: string, toFolder: string) => {
      const name = from.slice(from.lastIndexOf('/') + 1);
      // Refuse to drop a folder inside itself; git would happily do it.
      if (toFolder === from || toFolder.startsWith(`${from}/`)) return;
      return relocate(from, joinPath(toFolder, name), 'Moved');
    },
    [relocate],
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

  const attachments = useMemo(
    () => ({
      async store(file: File) {
        const root = ws.activeRoot;
        const open = noteRef.current;
        if (!root || !open) throw new Error('no note is open');
        // The bytes are materialised four times on the way to disk; a ceiling
        // keeps a dropped ISO from taking the window with it.
        if (file.size > 256 * 1024 * 1024) {
          setMessage(`${file.name} is too large to attach (over 256 MB).`);
          throw new Error('attachment too large');
        }

        const buffer = await file.arrayBuffer();
        // btoa needs a binary string, and spreading a large array blows the
        // call stack, so build it in chunks.
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }

        const extension = file.name.includes('.')
          ? (file.name.split('.').pop() ?? '')
          : (file.type.split('/').pop() ?? 'png');
        const folder = attachmentFolderFor(open.path, session?.attachmentFolder ?? 'assets');

        const path = await api.writeAttachment(root, folder, extension, btoa(binary));
        void ws.refreshFiles(root);
        ws.noteSaved(root);
        // The honest caveat: a vault is a Git repo, and large binaries make it
        // a slow one. Stored anyway — it is the user's repository — but said.
        if (file.size > 10 * 1024 * 1024) {
          setMessage(
            `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Large binaries slow a Git repository — consider git-lfs, which Open Note picks up automatically.`,
          );
        }
        return relativeFrom(open.path, path);
      },
      fileMeta(path: string) {
        const open = noteRef.current;
        const root = ws.activeRoot;
        if (!root || !open) return null;
        const absolute = resolveAgainst(open.path, path);
        const file = ws.sessions[root]?.files.find((f) => f.path === absolute);
        return file ? { size: file.size, kind: file.kind } : null;
      },
      openFile(path: string) {
        const open = noteRef.current;
        const root = ws.activeRoot;
        if (!root || !open) return;
        const absolute = resolveAgainst(open.path, path);
        const file = ws.sessions[root]?.files.find((f) => f.path === absolute);
        if (!file) return;
        if (file.kind === 'other') {
          // The OS knows what handles a zip; the app does not pretend to.
          void api.openInDefaultApp(root, absolute).catch((e) => ws.setError(errorText(e)));
          return;
        }
        void select(file);
      },
      async renderDrawing(path: string) {
        const open = noteRef.current;
        const root = ws.activeRoot;
        if (!root || !open) return null;
        try {
          const absolute = resolveAgainst(open.path, path);
          const source = await api.readDrawing(root, absolute);
          const scene = JSON.parse(source) as {
            elements?: unknown[];
            appState?: Record<string, unknown>;
            files?: Record<string, unknown>;
          };
          const { exportToSvg } = await import('@excalidraw/excalidraw');
          const svg = await exportToSvg({
            elements: (scene.elements ?? []) as never,
            appState: { ...(scene.appState ?? {}), exportBackground: false } as never,
            files: (scene.files ?? null) as never,
          });
          // A vault can be cloned from anywhere; drawings get the same
          // sanitiser every rendered diagram goes through — and anchors go
          // entirely, because a linked shape must not navigate the webview.
          return sanitiseSvg(svg.outerHTML)
            .replace(/<a\b[^>]*>/gi, '<g>')
            .replace(/<\/a>/gi, '</g>');
        } catch {
          return null;
        }
      },
      display: () => sessionsRef.current?.imageDisplay ?? 'full',
      isCollapsed: (path: string) => collapsedEmbedsRef.current.has(path),
      toggleCollapsed(path: string) {
        setCollapsedEmbeds((prev) => {
          const next = new Set(prev);
          if (!next.delete(path)) next.add(path);
          return next;
        });
      },
      async resolveImage(path: string) {
        const root = ws.activeRoot;
        const open = noteRef.current;
        if (!root || !open) return null;
        try {
          return await api.readImage(root, resolveAgainst(open.path, path));
        } catch {
          return null;
        }
      },
    }),
    [ws, session?.attachmentFolder, select],
  );

  // Changes only when the chips' inputs change, so the repaint nudge fires
  // exactly then and not on every render.
  const attachmentsStamp = useMemo(
    () => [session?.files, session?.imageDisplay] as const,
    [session?.files, session?.imageDisplay],
  );

  // Refs so the attachment callbacks read current values without rebuilding
  // the editor, matching how every other option is threaded.
  const sessionsRef = useRef(session);
  sessionsRef.current = session;
  const collapsedEmbedsRef = useRef(collapsedEmbeds);
  collapsedEmbedsRef.current = collapsedEmbeds;

  /**
   * Vault data for `[[`, `#` and `:` completion.
   *
   * Every field is a callback the editor calls at query time, so the editor is
   * never rebuilt when the index or the file listing changes — and a note
   * created a moment ago is offered immediately.
   */
  const completion = useMemo(
    () => ({
      notes: () =>
        vaultIndex.index.paths().map((path) => ({
          path,
          title: vaultIndex.index.get(path)?.title ?? baseName(path),
        })),
      tags: () => vaultIndex.index.tags().map((t) => t.tag),
      // Recency comes from the file listing rather than the index: the index
      // parses note content and has no reason to know about mtimes.
      recency: () =>
        new Map(
          (ws.activeRoot ? (ws.sessions[ws.activeRoot]?.files ?? []) : []).map((file) => [
            file.path,
            file.modified,
          ]),
        ),
      enabled: () => (ws.activeRoot ? ws.sessions[ws.activeRoot]?.completion !== false : true),
    }),
    [vaultIndex, ws.activeRoot, ws.sessions],
  );

  /** Export the open note as a self-contained HTML page. */
  const exportNote = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open) return;
    // Rendering a `.ts` file through the Markdown pipeline produces nonsense.
    if (open.kind !== 'markdown') {
      setMessage('Only notes can be exported as HTML.');
      return;
    }
    try {
      const suggested = `${(open.path.split('/').pop() ?? 'note').replace(/\.md$/i, '')}.html`;
      const destination = await api.pickExportPath(suggested);
      if (!destination) return;

      const html = await exportNoteToHtml(open.doc, {
        title: vaultIndex.index.get(open.path)?.title ?? suggested,
        resolveImage: async (reference) => {
          try {
            return await api.readImage(root, resolveAgainst(open.path, reference));
          } catch {
            return null;
          }
        },
      });
      await api.writeExport(destination, html);
      setMessage(`Exported to ${destination}`);
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws, vaultIndex]);

  /** Pinned notes ride at the top of the tree; the list lives in the vault. */
  const togglePin = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open || !session) return;
    const pinned = session.pinned.includes(open.path)
      ? session.pinned.filter((p) => p !== open.path)
      : [...session.pinned, open.path];
    await ws.updatePinned(root, pinned);
  }, [ws, session]);

  /** Copy the open note beside itself and open the copy. */
  const duplicateNote = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open) return;
    try {
      await flush();
      const copy = await api.duplicateNote(root, open.path);
      vaultIndex.updateNote(copy, open.doc);
      ws.noteSaved(root);
      await openNoteAt(copy);
      setMessage(`Duplicated to ${copy}`);
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws, vaultIndex, flush, openNoteAt]);

  /**
   * Cut the selection into a new note, leaving a `[[wikilink]]` behind.
   *
   * The move people make constantly as a note outgrows itself. The title comes
   * from the first heading in the selection when there is one, since that is
   * what the author already chose to call it, and otherwise from its first line.
   */
  const noteFromSelection = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open) return;

    const range = editorRef.current?.selection();
    const selected = range?.text ?? '';
    if (!range || !selected.trim()) {
      setMessage('Select the text to move into a new note first.');
      return;
    }

    const lines = selected.split('\n');
    const heading = lines.find((line) => /^\s*#{1,6}\s+\S/.test(line));
    const rawTitle = heading
      ? heading.replace(/^\s*#{1,6}\s+/, '')
      : (lines.find((line) => line.trim()) ?? '');
    // A note name cannot carry the characters a path separator or a wikilink
    // delimiter would claim, so they come out rather than breaking the link.
    const cleaned = rawTitle
      .trim()
      .replace(/[[\]/\\:|#^]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Truncate by code point: slicing UTF-16 units can cut an emoji in half and
    // leave a lone surrogate, which the Rust side then refuses as invalid text.
    const title = [...cleaned].slice(0, 80).join('');
    if (!title) {
      setMessage('That selection has no usable title.');
      return;
    }

    const slash = open.path.lastIndexOf('/');
    const folder = slash === -1 ? '' : open.path.slice(0, slash + 1);
    const path = `${folder}${title}.md`;

    try {
      const body = heading ? `${selected.trim()}\n` : `# ${title}\n\n${selected.trim()}\n`;
      await api.createNote(root, path, body);
      vaultIndex.updateNote(path, body);
      // The note may have been switched, or the text edited, while the write
      // was in flight. Replacing "the selection" blindly would then cut from a
      // different note, or from text the user has since typed — so the exact
      // range is re-checked and the link is only left where the text still is.
      const sameNote = noteRef.current?.path === open.path && noteRef.current?.root === root;
      const linked =
        sameNote &&
        editorRef.current?.replaceRangeIfUnchanged(range.from, range.to, selected, `[[${title}]]`);

      ws.noteSaved(root);
      setMessage(
        linked
          ? `Moved into ${path}`
          : `Created ${path}. The original text moved on, so no link was inserted.`,
      );
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws, vaultIndex]);

  /** The open note's Markdown, honouring the strip-tags copy preference. */
  const copySource = useCallback((): { doc: string; title: string } | null => {
    const open = noteRef.current;
    if (!open) return null;
    const doc = freshestDoc(open);
    return {
      doc: session?.copyStripsTags ? stripTags(doc) : doc,
      title: vaultIndex.index.get(open.path)?.title ?? open.path,
    };
  }, [session?.copyStripsTags, vaultIndex]);

  const copyAs = useCallback(
    async (format: 'markdown' | 'plain' | 'html' | 'rich') => {
      const source = copySource();
      if (!source) return;
      try {
        if (format === 'markdown') {
          await navigator.clipboard.writeText(source.doc);
        } else if (format === 'plain') {
          await navigator.clipboard.writeText(toPlainText(splitFrontmatter(source.doc).body));
        } else {
          // The clipboard write must begin inside the user gesture: WebKit
          // drops the activation across an await, so the HTML is handed over
          // as a *promised* blob rather than awaited first.
          const html = renderNoteBody(source.doc, { title: source.title });
          if (format === 'html') {
            await navigator.clipboard.write([
              new ClipboardItem({
                'text/plain': html.then((h) => new Blob([h], { type: 'text/plain' })),
              }),
            ]);
          } else {
            // Rich text is `text/html` beside a plain fallback — how a note
            // lands formatted in an email without carrying its syntax along.
            await navigator.clipboard.write([
              new ClipboardItem({
                'text/html': html.then((h) => new Blob([h], { type: 'text/html' })),
                'text/plain': new Blob([toPlainText(splitFrontmatter(source.doc).body)], {
                  type: 'text/plain',
                }),
              }),
            ]);
          }
        }
        setMessage('Copied.');
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [copySource, ws],
  );

  const pasteAs = useCallback(
    async (format: 'plain' | 'html' | 'codeBlock') => {
      try {
        let text = '';
        if (format === 'html') {
          // The HTML flavour if the clipboard has one; the plain text if not.
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (item.types.includes('text/html')) {
              text = await (await item.getType('text/html')).text();
              break;
            }
          }
          if (!text) text = await navigator.clipboard.readText();
        } else {
          text = await navigator.clipboard.readText();
        }
        if (!text) return;
        if (format === 'codeBlock') {
          // The fence must be longer than any run of backticks inside, or the
          // pasted content closes its own block early.
          const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
          const fence = '`'.repeat(Math.max(3, longest + 1));
          text = `${fence}\n${text.replace(/\n$/, '')}\n${fence}`;
        }
        editorRef.current?.insertAtSelection(text);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws],
  );

  /**
   * Print, and therefore PDF, through the webview's own pipeline against the
   * HTML export — one renderer, two outputs. The honest limit, stated in the
   * plan: this is the OS print dialog, not a silent file writer.
   */
  const printNote = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open || open.kind !== 'markdown') return;
    try {
      const html = await exportNoteToHtml(freshestDoc(open), {
        title: vaultIndex.index.get(open.path)?.title ?? open.path,
        resolveImage: async (reference) => {
          try {
            return await api.readImage(root, resolveAgainst(open.path, reference));
          } catch {
            return null;
          }
        },
      });

      // Printed from the top-level document: WKWebView ignores an iframe's
      // contentWindow.print() (tauri#13451), but window.print() works. The
      // export body goes into a surface only @media print shows, the app is
      // hidden for the duration, and everything is removed afterwards.
      const parser = new DOMParser();
      const exported = parser.parseFromString(html, 'text/html');

      const surface = document.createElement('div');
      surface.className = 'print-surface';
      surface.innerHTML = exported.body.innerHTML;

      // Styled by the app stylesheet's @media print rules, not by the export's
      // own <style> — that one targets `body` and would restyle the app for as
      // long as it was attached.
      document.body.append(surface);
      document.body.classList.add('is-printing');
      const cleanup = () => {
        document.body.classList.remove('is-printing');
        surface.remove();
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
      // afterprint is unreliable on some WebKit builds; never leave the app hidden.
      window.setTimeout(cleanup, 1_000);
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws, vaultIndex]);

  const exportDocx = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open || open.kind !== 'markdown') return;
    try {
      const title = vaultIndex.index.get(open.path)?.title ?? open.path;
      const destination = await api.pickExportPath(
        `${exportFileName(open.path, 'docx').replace(/\.docx$/, '')}.docx`,
      );
      if (!destination) return;
      const base64 = await exportNoteToDocx(freshestDoc(open), title);
      await api.writeExportBinary(destination, base64);
      setMessage(`Exported to ${destination}`);
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws, vaultIndex]);

  const exportTextbundle = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open || open.kind !== 'markdown') return;
    try {
      const destination = await api.pickExportPath(
        `${exportFileName(open.path, 'textpack').replace(/\.textpack$/, '')}.textpack`,
      );
      if (!destination) return;

      const doc = freshestDoc(open);
      // Each reference maps to a unique flat name inside `assets/` — two
      // folders can both hold a `logo.png`, and flattening must not let one
      // silently replace the other.
      const assets: Array<{ name: string; data: Uint8Array }> = [];
      const nameFor = new Map<string, string>();
      const used = new Set<string>();
      for (const reference of localAssetReferences(doc)) {
        try {
          const dataUrl = await api.readImage(root, resolveAgainst(open.path, reference));
          const bytes = dataUrlToBytes(dataUrl);
          if (!bytes) continue;
          const base = reference.split('/').pop() ?? reference;
          let name = base;
          for (let n = 2; used.has(name); n++) {
            const dot = base.lastIndexOf('.');
            name = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
          }
          used.add(name);
          nameFor.set(reference, name);
          assets.push({ name, data: bytes });
        } catch {
          // A missing attachment is not a reason to lose the text.
        }
      }

      // Every form a reference takes moves onto the container's assets/
      // folder: `](ref)`, the URL-encoded spelling, and `![[ref]]` embeds —
      // which become standard image syntax so any textbundle reader shows them.
      let text = doc;
      for (const [reference, name] of nameFor) {
        text = text.split(`](${reference})`).join(`](assets/${name})`);
        const encoded = encodeURI(reference);
        if (encoded !== reference) {
          text = text.split(`](${encoded})`).join(`](assets/${name})`);
        }
        text = text
          .split(`![[${reference}]]`)
          .join(`![${reference.split('/').pop() ?? ''}](assets/${name})`);
      }

      await api.writeExportBinary(destination, bytesToBase64(buildTextpack(text, assets)));
      setMessage(`Exported to ${destination}`);
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws]);

  /**
   * Rewrite a tag across the vault — the machinery behind rename and delete.
   *
   * The rewrites land in **one commit** named for what happened, the pattern
   * the plan carries over from note renames: reviewable in history and
   * revertable in one action.
   */
  const rewriteTagEverywhere = useCallback(
    async (
      rewrite: (source: string) => { text: string; count: number },
      commitMessage: (notes: number) => string,
      done: (notes: number, occurrences: number) => string,
    ) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        await flush();
        let notes = 0;
        let occurrences = 0;
        // Reserved before the first write, so the idle timer cannot slice the
        // rename across two commits.
        await ws.runNamedCommit(root, async () => {
          for (const path of vaultIndex.index.paths()) {
            // The open note may have typing newer than the file; rewriting the
            // disk copy would resurrect the stale text under the editor.
            const open = noteRef.current;
            const source =
              open && open.root === root && open.path === path
                ? freshestDoc(open)
                : await api.readNote(root, path);
            const result = rewrite(source);
            if (result.count === 0 || result.text === source) continue;
            await api.writeNote(root, path, result.text);
            vaultIndex.updateNote(path, result.text);
            notes += 1;
            occurrences += result.count;
            if (noteRef.current?.path === path) {
              pending.current = null;
              setNote((prev) =>
                prev && prev.path === path
                  ? { ...prev, doc: result.text, revision: prev.revision + 1 }
                  : prev,
              );
            }
          }
          return notes > 0 ? commitMessage(notes) : null;
        });
        setMessage(done(notes, occurrences));
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex, flush],
  );

  /** Presentation settings follow the tag: pins and icons rename or vanish. */
  const migrateTagPrefs = useCallback(
    (from: string, to: string | null) => {
      const root = ws.activeRoot;
      const current = root ? ws.sessions[root] : undefined;
      if (!root || !current) return;
      const covers = (tag: string) =>
        tag.toLowerCase() === from.toLowerCase() ||
        tag.toLowerCase().startsWith(`${from.toLowerCase()}/`);
      const moved = (tag: string) => (to === null ? null : `${to}${tag.slice(from.length)}`);

      const pinnedTags = current.pinnedTags
        .map((tag) => (covers(tag) ? moved(tag) : tag))
        .filter((tag): tag is string => tag !== null);
      const tagIcons: Record<string, string> = {};
      for (const [tag, icon] of Object.entries(current.tagIcons)) {
        const next = covers(tag) ? moved(tag) : tag;
        if (next !== null) tagIcons[next] = icon;
      }
      void ws.updatePrefs(root, { pinnedTags, tagIcons });
    },
    [ws],
  );

  const renameTag = useCallback(
    (from: string, to: string) =>
      rewriteTagEverywhere(
        (source) => renameTagInNote(source, from, to),
        (notes) => `notes: rename #${from} to #${to} (${notes} note${notes === 1 ? '' : 's'})`,
        (notes, occurrences) =>
          notes === 0
            ? `No occurrences of #${from} were found.`
            : `Renamed #${from} to #${to}: ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${notes} note${notes === 1 ? '' : 's'}.`,
      ).then(() => migrateTagPrefs(from, to)),
    [rewriteTagEverywhere, migrateTagPrefs],
  );

  const deleteTag = useCallback(
    (tag: string) =>
      rewriteTagEverywhere(
        (source) => removeTagFromNote(source, tag),
        (notes) => `notes: remove #${tag} (${notes} note${notes === 1 ? '' : 's'})`,
        (notes) =>
          notes === 0
            ? `No occurrences of #${tag} were found.`
            : `Removed #${tag} from ${notes} note${notes === 1 ? '' : 's'}. The notes themselves are untouched.`,
      ).then(() => migrateTagPrefs(tag, null)),
    [rewriteTagEverywhere, migrateTagPrefs],
  );

  /**
   * Turn an unlinked mention into a `[[wikilink]]`, in the mentioning note.
   *
   * The first occurrence outside brackets is wrapped as written — its own
   * casing resolves fine, since links match case-insensitively.
   */
  const linkMention = useCallback(
    async (mentioningPath: string, targetPath: string, title: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        // The mentioning note may be the one on screen — then its freshest
        // text is the buffer, and the result must land back in the editor
        // rather than under it.
        const open = noteRef.current;
        const isOpen = open?.root === root && open?.path === mentioningPath;
        const source =
          isOpen && open ? freshestDoc(open) : await api.readNote(root, mentioningPath);

        // Whole words, never inside brackets, and never inside code or
        // frontmatter — the mask blanks those the same way the indexer does.
        const { bodyOffset } = splitFrontmatter(source);
        const masked =
          source.slice(0, bodyOffset).replace(/[^\n]/g, ' ') + maskCode(source.slice(bodyOffset));
        const pattern = new RegExp(mentionPattern(title).source, 'giu');
        let at = -1;
        for (const match of masked.matchAll(pattern)) {
          const before = source.slice(Math.max(0, match.index - 2), match.index);
          const after = source.slice(match.index + title.length, match.index + title.length + 2);
          if (before.includes('[') || after.includes(']')) continue;
          at = match.index;
          break;
        }
        if (at === -1) {
          setMessage('The mention sits in code or frontmatter, so it was left alone.');
          return;
        }
        const occurrence = source.slice(at, at + title.length);
        // The link must actually resolve to the target: when the title is not
        // the note's basename, it gets the path as target and the mention as
        // its alias — the same rule completion applies.
        const resolves = vaultIndex.index.resolveLink(occurrence) === targetPath;
        const target = targetPath.replace(/\.(md|markdown|mdown|mkd)$/i, '');
        const link = resolves ? `[[${occurrence}]]` : `[[${target}|${occurrence}]]`;
        const text = `${source.slice(0, at)}${link}${source.slice(at + title.length)}`;

        await api.writeNote(root, mentioningPath, text);
        vaultIndex.updateNote(mentioningPath, text);
        if (isOpen) {
          pending.current = null;
          setNote((prev) =>
            prev && prev.path === mentioningPath
              ? { ...prev, doc: text, revision: prev.revision + 1 }
              : prev,
          );
        }
        ws.noteSaved(root);
        setMessage(`Linked the mention in ${mentioningPath}.`);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex],
  );

  /**
   * Distinct notes per tag *family* — the tag or any child. Summing child
   * counts double-counts a note that carries both `#work` and `#work/urgent`;
   * only a set per prefix answers "what would selecting this parent list".
   */
  // biome-ignore format: single-expression memo
  const tagFamilyCounts = useMemo(() => {
    const sets = new Map<string, Set<string>>();
    for (const path of vaultIndex.index.paths()) {
      const entry = vaultIndex.index.get(path);
      if (!entry) continue;
      for (const tag of entry.tags) {
        const parts = tag.split('/');
        for (let depth = 1; depth <= parts.length; depth++) {
          const prefix = parts.slice(0, depth).join('/');
          const set = sets.get(prefix) ?? new Set<string>();
          set.add(path);
          sets.set(prefix, set);
        }
      }
    }
    return new Map([...sets.entries()].map(([tag, set]) => [tag, set.size]));
  }, [vaultIndex]);

  /** Progress of a running bulk export; null when none is. */
  const [bulkExport, setBulkExport] = useState<{ done: number; total: number } | null>(null);
  const bulkCancelled = useRef(false);

  /**
   * Export every note under a folder — as one HTML file per note with the
   * folder tree preserved, or merged into a single page in tree order.
   *
   * Wikilinks between exported notes become working relative links (or `#`
   * anchors in the merged file); links pointing outside the set flatten to
   * text, exactly like the single-note export. Without this an export of a
   * linked vault is a set of dead ends.
   */
  const exportFolder = useCallback(
    async (folder: string, mode: 'files' | 'merged') => {
      const root = ws.activeRoot;
      if (!root) return;
      const prefix = folder ? `${folder}/` : '';
      const paths = vaultIndex.index
        .paths()
        .filter((path) => path.startsWith(prefix))
        .sort();
      if (paths.length === 0) {
        setMessage('There are no notes to export there.');
        return;
      }
      const included = new Set(paths);

      // Output names dedupe up front: `foo.md` and `foo.markdown` both want
      // `foo.html`, and the second must not silently replace the first.
      const htmlNames = new Map<string, string>();
      const usedNames = new Set<string>();
      const anchors = new Map<string, string>();
      const usedAnchors = new Set<string>();
      for (const path of paths) {
        const base = path.slice(prefix.length).replace(/\.(md|markdown|mdown|mkd)$/i, '');
        let name = `${base}.html`;
        for (let n = 2; usedNames.has(name); n++) name = `${base} ${n}.html`;
        usedNames.add(name);
        htmlNames.set(path, name);

        const baseAnchor = exportAnchor(path);
        let anchor = baseAnchor;
        for (let n = 2; usedAnchors.has(anchor); n++) anchor = `${baseAnchor}-${n}`;
        usedAnchors.add(anchor);
        anchors.set(path, anchor);
      }

      /** Where a wikilink goes, relative to the note that carries it. */
      const resolveFor = (fromPath: string) => (target: string) => {
        const resolved = vaultIndex.index.resolveLink(target);
        if (!resolved || !included.has(resolved)) return null;
        if (mode === 'merged') return `#${anchors.get(resolved) ?? ''}`;
        return relativeFrom(htmlNames.get(fromPath) ?? '', htmlNames.get(resolved) ?? '');
      };

      const resolveImageFor = (fromPath: string) => async (reference: string) => {
        try {
          return await api.readImage(root, resolveAgainst(fromPath, reference));
        } catch {
          return null;
        }
      };

      try {
        if (mode === 'merged') {
          const suggested = `${(folder.split('/').pop() || 'vault').toLowerCase()}.html`;
          const destination = await api.pickExportPath(suggested);
          if (!destination) return;

          bulkCancelled.current = false;
          setBulkExport({ done: 0, total: paths.length });
          const notes: Array<{
            title: string;
            source: string;
            anchor: string;
            resolveImage: (reference: string) => Promise<string | null>;
          }> = [];
          for (const path of paths) {
            if (bulkCancelled.current) return;
            notes.push({
              title: vaultIndex.index.get(path)?.title ?? path,
              source: await api.readNote(root, path),
              anchor: anchors.get(path) ?? exportAnchor(path),
              // Against the note's own folder: `assets/x.png` in
              // `projects/note.md` means `projects/assets/x.png`.
              resolveImage: resolveImageFor(path),
            });
            setBulkExport({ done: notes.length, total: paths.length });
          }
          const html = await exportNotesToHtml(notes, {
            title: folder || 'Vault',
            resolveWikiLink: resolveFor(''),
          });
          await api.writeExport(destination, html);
          setMessage(`Exported ${paths.length} notes to ${destination}`);
          return;
        }

        const destination = await api.pickFolder();
        if (!destination) return;

        bulkCancelled.current = false;
        setBulkExport({ done: 0, total: paths.length });
        let done = 0;
        for (const path of paths) {
          if (bulkCancelled.current) {
            setMessage(`Export cancelled after ${done} of ${paths.length} notes.`);
            return;
          }
          const source = await api.readNote(root, path);
          const html = await exportNoteToHtml(source, {
            title: vaultIndex.index.get(path)?.title ?? path,
            resolveImage: resolveImageFor(path),
            resolveWikiLink: resolveFor(path),
          });
          await api.writeExport(`${destination}/${htmlNames.get(path) ?? ''}`, html);
          done += 1;
          setBulkExport({ done, total: paths.length });
        }
        setMessage(`Exported ${done} notes to ${destination}`);
      } catch (e) {
        ws.setError(errorText(e));
      } finally {
        setBulkExport(null);
      }
    },
    [ws, vaultIndex],
  );

  /**
   * Archive a note: move it into the archive folder — a visible move, in the
   * tree and in the commit, never a hidden flag. Unarchiving is the same move
   * back out. Wikilinks follow, because a move is a rename.
   */
  const archiveNote = useCallback(
    (path: string) => {
      const folder = session?.archiveFolder ?? 'archive';
      const taken = new Set(session?.files.map((file) => file.path) ?? []);
      // Two folders can both hold a `plan.md`; the archive keeps both.
      const free = (wanted: string): string => {
        if (!taken.has(wanted)) return wanted;
        const dot = wanted.lastIndexOf('.');
        for (let n = 2; ; n++) {
          const candidate =
            dot > 0 ? `${wanted.slice(0, dot)} ${n}${wanted.slice(dot)}` : `${wanted} ${n}`;
          if (!taken.has(candidate)) return candidate;
        }
      };
      if (isArchivedPath(path, folder)) {
        const name = path.slice(path.lastIndexOf('/') + 1);
        return relocate(path, free(name), 'Moved');
      }
      return relocate(path, free(archivePathFor(path, folder)), 'Moved');
    },
    [relocate, session?.archiveFolder, session?.files],
  );

  /**
   * Merge a folder's notes into one, tree order, a heading per source.
   *
   * Links that pointed at the merged notes point at the result afterwards, and
   * the sources are deleted in the same commit — one revertable action.
   */
  const mergeFolder = useCallback(
    async (folder: string, paths: string[], name: string) => {
      const root = ws.activeRoot;
      if (!root || paths.length < 2) return;
      try {
        await flush();
        const sources: Array<{ title: string; body: string }> = [];
        for (const path of paths) {
          const source = await api.readNote(root, path);
          sources.push({
            title: vaultIndex.index.get(path)?.title ?? path,
            body: splitFrontmatter(source).body,
          });
        }
        const fileName = name.endsWith('.md') ? name : `${name}.md`;
        const target = folder ? `${folder}/${fileName}` : fileName;
        await api.createNote(root, target, mergeNotes(sources));

        // Links to any source now point at the merged note.
        const sourceSet = new Set(paths);
        for (const path of vaultIndex.index.paths()) {
          if (sourceSet.has(path) || path === target) continue;
          const text = await api.readNote(root, path);
          const rewrite = rewriteLinks(
            text,
            (candidate) => {
              const resolved = vaultIndex.index.resolveLink(candidate);
              return resolved !== null && sourceSet.has(resolved);
            },
            target,
          );
          if (rewrite.count > 0) {
            await api.writeNote(root, path, rewrite.text);
            vaultIndex.updateNote(path, rewrite.text);
          }
        }

        for (const path of paths) {
          await api.deleteEntry(root, path);
          vaultIndex.removeNote(path);
        }
        await ws.commitWith(root, `notes: merge ${paths.length} notes into ${target}`);
        await ws.refreshFiles(root);
        await vaultIndex.rebuild(root);
        await openNoteAt(target);
        setMessage(`Merged ${paths.length} notes into ${target}.`);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, vaultIndex, flush, openNoteAt],
  );

  /** Create a note from a template, `{{title}}`/`{{date}}`/`{{time}}` filled. */
  const createFromTemplate = useCallback(
    async (templatePath: string, title: string) => {
      const root = ws.activeRoot;
      if (!root) return;
      try {
        const template = await api.readNote(root, templatePath);
        const body = renderTemplate(template, { title });
        await createNote(`${title}.md`, body);
      } catch (e) {
        ws.setError(errorText(e));
      }
    },
    [ws, createNote],
  );

  const importFolder = useCallback(async () => {
    try {
      const info = await api.importFolderAsVault();
      if (info) await ws.openVault(info.root);
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws]);

  /** Pick any file and reference it from the caret, via the paste pipeline. */
  const attachFile = useCallback(async () => {
    const root = ws.activeRoot;
    const open = noteRef.current;
    if (!root || !open) return;
    try {
      const folder = attachmentFolderFor(open.path, session?.attachmentFolder ?? 'assets');
      const stored = await api.pickAttachment(root, folder);
      if (!stored) return;
      const relative = relativeFrom(open.path, stored.path);
      const isImage = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(stored.path);
      editorRef.current?.insertAtSelection(
        isImage
          ? `![${stored.name.replace(/\.[^.]+$/, '')}](${relative})`
          : `[${stored.name}](${relative})`,
      );
      void ws.refreshFiles(root);
      ws.noteSaved(root);
      if (stored.size > 10 * 1024 * 1024) {
        setMessage(
          `${stored.name} is ${(stored.size / (1024 * 1024)).toFixed(1)} MB. Large binaries slow a Git repository — consider git-lfs.`,
        );
      }
    } catch (e) {
      ws.setError(errorText(e));
    }
  }, [ws, session?.attachmentFolder]);

  /**
   * `opennote://` URLs, from browsers, scripts and the CLI.
   *
   * A URL is untrusted input: the vocabulary is deliberately small, every
   * path crosses the same vault-scoped commands the UI uses, and nothing
   * destructive is reachable — `append` is additive, `new` refuses to
   * clobber and opens the existing note instead.
   */
  /**
   * A queue of pending `opennote://` actions, drained one at a time.
   *
   * A URL is untrusted, remote-triggerable input: a web page can fire one with
   * no consent. So the vocabulary is small, every path goes through the same
   * vault-scoped commands the UI uses, nothing destructive is reachable, and
   * `vault` may only name a vault this machine already knows — opening an
   * arbitrary directory would start the sync engine committing and pushing it.
   *
   * Actions queue rather than drop: a launch batch or a burst of URLs all run,
   * in order, instead of the first winning and the rest being lost.
   */
  const deepLinkQueue = useRef<string[]>([]);
  const deepLinkDraining = useRef(false);

  const runDeepLink = useCallback(
    async (raw: string) => {
      const url = new URL(raw);
      if (url.protocol !== 'opennote:') return;
      const verb = url.host || url.pathname.replace(/^\/+/, '');
      const params = url.searchParams;

      void focusWindow();

      const vault = params.get('vault');
      if (vault) {
        const known =
          recents.some((recent) => samePath(recent, vault)) || Boolean(ws.sessions[vault]);
        if (!known) {
          setMessage(
            'That link points at a vault this app has not opened before — open it once yourself first.',
          );
          return;
        }
        const opened = await ws.openVault(vault);
        if (!opened) return;
      }
      // `openVault` set the active root synchronously in the store; read the
      // resolved value rather than the stale closure capture.
      const root = vault ? (ws.sessions[vault]?.info.root ?? vault) : ws.activeRoot;
      if (!root) return;

      if (verb === 'open') {
        const path = params.get('path');
        if (path) await openNoteAt(path.endsWith('.md') ? path : `${path}.md`, undefined, root);
        return;
      }
      if (verb === 'new') {
        const title = (params.get('title') ?? 'Untitled').trim() || 'Untitled';
        const folder = (params.get('folder') ?? '').trim().replace(/^\/+|\/+$/g, '');
        const tags = (params.get('tags') ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => `#${t.replace(/^#+/, '')}`)
          .join(' ');
        const body = params.get('body') ?? '';
        const path = `${folder ? `${folder}/` : ''}${title.replace(/[/\\]/g, ' ')}.md`;
        const content = `# ${title}\n\n${body}${body ? '\n' : ''}${tags ? `\n${tags}\n` : ''}`;
        // Rust `create_note` refuses to overwrite — the clobber guard lives
        // where the write happens, not in a racy exists() check up here.
        try {
          await api.createNote(root, path, content);
          vaultIndex.updateNote(path, content);
          ws.noteSaved(root);
          await openNoteAt(path, undefined, root);
        } catch {
          // Already there: open it rather than failing or clobbering.
          await openNoteAt(path, undefined, root);
          setMessage(`${path} already exists, so it was opened instead.`);
        }
        return;
      }
      if (verb === 'append') {
        const path = params.get('path');
        const text = params.get('text') ?? '';
        if (!path || !text) return;
        const target = path.endsWith('.md') ? path : `${path}.md`;
        // The open note's freshest text is the buffer, not the disk copy — a
        // blind read would discard keystrokes still inside the autosave window.
        const open = noteRef.current;
        const isOpen = open?.root === root && open?.path === target;
        let existing: string | null;
        if (isOpen && open) {
          existing = freshestDoc(open);
        } else {
          try {
            existing = await api.readNote(root, target);
          } catch {
            // A note that exists but will not read (too large, not UTF-8) must
            // not be silently truncated; only a genuine miss is treated as new.
            const known = vaultIndex.index.get(target);
            if (known) {
              setMessage(`${target} could not be read, so nothing was appended.`);
              return;
            }
            existing = null;
          }
        }
        const next =
          existing === null
            ? `${text}\n`
            : `${existing}${existing.endsWith('\n') ? '' : '\n'}${text}\n`;
        await api.writeNote(root, target, next);
        vaultIndex.updateNote(target, next);
        ws.noteSaved(root);
        if (isOpen) {
          pending.current = null;
          setNote((prev) =>
            prev && prev.path === target
              ? { ...prev, doc: next, revision: prev.revision + 1 }
              : prev,
          );
        }
        setMessage(`Appended to ${target}.`);
        return;
      }
      if (verb === 'search') {
        setPaletteQuery(params.get('q') ?? '');
        setSearchScoped(false);
        setPalette('search');
        return;
      }
      if (verb === 'tag') {
        const name = (params.get('name') ?? '').replace(/^#+/, '');
        if (name) {
          setCollection({ kind: 'tag', tag: name });
          setShowList(true);
        }
      }
    },
    [ws, vaultIndex, openNoteAt, recents],
  );

  const handleDeepLink = useCallback(
    async (raw: string) => {
      deepLinkQueue.current.push(raw);
      if (deepLinkDraining.current) return;
      deepLinkDraining.current = true;
      try {
        while (deepLinkQueue.current.length > 0) {
          const next = deepLinkQueue.current.shift();
          if (!next) continue;
          try {
            await runDeepLink(next);
          } catch (e) {
            ws.setError(errorText(e));
          }
        }
      } finally {
        deepLinkDraining.current = false;
      }
    },
    [runDeepLink, ws],
  );
  const deepLinkRef = useRef(handleDeepLink);
  deepLinkRef.current = handleDeepLink;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
      // A URL may have launched the app before this listener existed.
      const initial = await getCurrent().catch(() => null);
      for (const url of initial ?? []) void deepLinkRef.current(url);
      unlisten = await onOpenUrl((urls) => {
        for (const url of urls) void deepLinkRef.current(url);
      });
    })().catch(() => {
      // The plugin is desktop-only and can be absent in the browser harness.
    });
    return () => unlisten?.();
  }, []);

  /**
   * Global hotkeys: show the window, and new note. Both unbound by default —
   * a global hotkey that squats on a chord another app wants is a support
   * ticket — and bound in the same keymap panel as everything else.
   */
  const globalBindings = useMemo(
    () => ({
      'global.showWindow': vaultIndex.keymap.byCommand.get('global.showWindow') ?? null,
      'global.newNote': vaultIndex.keymap.byCommand.get('global.newNote') ?? null,
    }),
    [vaultIndex.keymap],
  );
  const handlersRef = useRef<Record<string, () => void>>({});
  useEffect(() => {
    let cancelled = false;
    const registered: string[] = [];
    void (async () => {
      try {
        const shortcuts = await import('@tauri-apps/plugin-global-shortcut');
        for (const [command, binding] of Object.entries(globalBindings)) {
          if (!binding || cancelled) continue;
          const accelerator = bindingToAccelerator(binding);
          if (!accelerator) continue;
          try {
            await shortcuts.register(accelerator, (event) => {
              if (event.state === 'Pressed') handlersRef.current[command]?.();
            });
            registered.push(accelerator);
          } catch {
            // Another app holds the chord; the in-app keymap still works.
          }
        }
      } catch {
        // Plugin absent outside the desktop shell.
      }
    })();
    return () => {
      cancelled = true;
      void (async () => {
        const shortcuts = await import('@tauri-apps/plugin-global-shortcut');
        for (const accelerator of registered) {
          await shortcuts.unregister(accelerator).catch(() => {});
        }
      })().catch(() => {});
    };
  }, [globalBindings]);

  const openPalette = useCallback((mode: PaletteMode) => {
    setPaletteQuery('');
    // Each opening starts scoped to where you are; dismissing the chip widens.
    setSearchScoped(true);
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
        const path = dailyNotePath(today);
        // Daily notes ride the same template mechanism: templates/daily.md
        // wins when it exists, the built-in heading otherwise.
        const custom = vaultIndex.index.get(`${TEMPLATES_FOLDER}/daily.md`);
        void (async () => {
          if (custom && ws.activeRoot) {
            const template = await api.readNote(ws.activeRoot, custom.path);
            await createNote(
              path,
              renderTemplate(template, {
                title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
              }),
            );
          } else {
            await createNote(path, dailyNoteTemplate(today));
          }
        })();
      },
      'sync.now': () => void sync(),
      'sync.togglePause': () => {
        if (ws.activeRoot) ws.setPaused(ws.activeRoot, !paused);
      },
      'sync.settings': () => togglePanel('settings'),
      'view.toggleSidebar': () => setShowSidebar((v) => !v),
      'view.toggleList': () => setShowList((v) => !v),
      'view.toggleBacklinks': () =>
        setInfo((prev) =>
          prev.open && prev.tab === 'backlinks'
            ? { ...prev, open: false }
            : { open: true, tab: 'backlinks' },
        ),
      'view.keymap': () => togglePanel('keymap'),
      'view.tags': () => togglePanel('tags'),
      'view.outline': () => {
        setPanel(null);
        setInfo((prev) =>
          prev.open && prev.tab === 'outline'
            ? { ...prev, open: false }
            : { open: true, tab: 'outline' },
        );
      },
      'note.export': () => void exportNote(),
      'note.togglePin': () => void togglePin(),
      'note.duplicate': () => void duplicateNote(),
      'note.archive': () => {
        if (noteRef.current) void archiveNote(noteRef.current.path);
      },
      'note.fromTemplate': () => openPalette('templates'),
      // The in-app halves of the global hotkeys; the registration against the
      // OS lives in an effect watching the keymap.
      'global.showWindow': () => void focusWindow(),
      'global.newNote': () => {
        void focusWindow();
        setPrompt({ kind: 'newNote', parent: '' });
      },
      'vault.open': () => void choose(),
      'vault.close': () => {
        if (ws.activeRoot) void closeVaultAt(ws.activeRoot);
      },
      'vault.importFolder': () => void importFolder(),
      'note.fromSelection': () => void noteFromSelection(),
      'note.addTag': () => {
        if (noteRef.current) setPrompt({ kind: 'addTag' });
      },
      'copy.markdown': () => void copyAs('markdown'),
      'copy.plain': () => void copyAs('plain'),
      'copy.html': () => void copyAs('html'),
      'copy.rich': () => void copyAs('rich'),
      'paste.plain': () => void pasteAs('plain'),
      'paste.html': () => void pasteAs('html'),
      'paste.codeBlock': () => void pasteAs('codeBlock'),
      'insert.file': () => void attachFile(),
      'note.reveal': () => {
        const open = noteRef.current;
        if (ws.activeRoot && open) {
          void api
            .revealInFileManager(ws.activeRoot, open.path)
            .catch((e) => ws.setError(errorText(e)));
        }
      },
      'note.openWith': () => {
        const open = noteRef.current;
        if (ws.activeRoot && open) {
          void api
            .openInDefaultApp(ws.activeRoot, open.path)
            .catch((e) => ws.setError(errorText(e)));
        }
      },
      'note.print': () => void printNote(),
      'note.exportPdf': () => void printNote(),
      'note.exportDocx': () => void exportDocx(),
      'note.exportTextbundle': () => void exportTextbundle(),
      'view.zoomIn': () => changeZoom(zoom + ZOOM_STEP),
      'view.zoomOut': () => changeZoom(zoom - ZOOM_STEP),
      'view.zoomReset': () => changeZoom(1),
      'nav.back': () => void navigateHistory('back'),
      'nav.forward': () => void navigateHistory('forward'),
      'tags.open': () => openPalette('tags'),
      'view.layoutEditor': () => {
        setShowSidebar(false);
        setShowList(false);
      },
      'view.layoutList': () => {
        setShowSidebar(false);
        setShowList(true);
      },
      'view.layoutFull': () => {
        setShowSidebar(true);
        setShowList(true);
      },
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
    [
      openPalette,
      createNote,
      choose,
      closeVaultAt,
      sync,
      ws,
      paused,
      togglePanel,
      duplicateNote,
      noteFromSelection,
      changeZoom,
      zoom,
      navigateHistory,
      archiveNote,
      importFolder,
      copyAs,
      pasteAs,
      printNote,
      exportDocx,
      exportTextbundle,
      attachFile,
    ],
  );

  useCommandKeys(vaultIndex.keymap, handlers, palette === null);
  handlersRef.current = handlers;

  /**
   * The application menu.
   *
   * It is built in Rust but performs nothing there: each item emits one event
   * and the work happens here, so opening a vault has a single implementation.
   * Anything that names a `COMMANDS` id runs the registry handler — the same
   * one the palette and the keymap reach — rather than becoming a second
   * dispatcher beside it. The recent-vault items are the exception, and
   * deliberately so: they take an argument, which a registry command cannot.
   */
  const onMenuRef = useRef<(payload: MenuCommand) => void>(() => {});
  onMenuRef.current = ({ command, arg }) => {
    if (command === MENU_ONLY.openRecent) {
      if (arg) void openRecent(arg);
      return;
    }
    if (command === MENU_ONLY.clearRecents) {
      void clearRecents();
      return;
    }
    (handlers as Record<string, (() => void) | undefined>)[command]?.();
  };
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    // Unmounting before `listen` resolves would otherwise leave the listener
    // attached and the next mount would add a second one — which under
    // StrictMode is every mount, and shows up as two folder pickers.
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen<MenuCommand>(MENU_EVENT, (event) => {
        onMenuRef.current(event.payload);
      });
      if (cancelled) stop();
      else unlisten = stop;
    })().catch(() => {
      // No shell, no menu — the browser harness.
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // File → Open… shows whatever the keymap currently binds, and claims the
  // chord only while the keymap does. Declaring it in Rust would go stale the
  // moment someone rebinds the command.
  const openBinding = vaultIndex.keymap.byCommand.get('vault.open') ?? null;
  useEffect(() => {
    void api
      .setOpenAccelerator(openBinding ? bindingToAccelerator(openBinding) : null)
      .catch(() => {
        // Older shell, or the browser harness.
      });
  }, [openBinding]);

  // File → Close <vault> is named after whichever vault is active, so the
  // label has to follow the tab strip. Rust cannot know this: which vault is
  // active is frontend state.
  const activeVaultName = session?.info.name ?? null;
  useEffect(() => {
    void api.setCloseTarget(activeVaultName).catch(() => {
      // Older shell, or the browser harness.
    });
  }, [activeVaultName]);

  // Confirmations should not need dismissing; errors should, because an error
  // the user never read is an error they will hit again.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (pending.current) void flush();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [flush]);

  /**
   * What the note list pane shows: the vault through the active collection,
   * in the configured order. All the logic lives in core and is tested there;
   * this just feeds it the index, the mtimes and the created dates.
   *
   * Dependencies are the narrow facts, not the session object — a sync phase
   * tick must not re-excerpt and re-sort ten thousand notes.
   */
  const sessionFiles = session?.files;
  const noteListPrefs = session?.noteList;
  const archiveFolder = session?.archiveFolder;
  // `vaultIndex.revision` stands in for the index contents; `dayStamp`
  // re-evaluates "Today" after midnight.
  const noteListEntries = useMemo(() => {
    if (!sessionFiles || !noteListPrefs || !showList) return [];
    return buildNoteList({
      notes: vaultIndex.index
        .paths()
        .map((path) => vaultIndex.index.get(path))
        .filter((n): n is NonNullable<typeof n> => n !== undefined),
      modified: new Map(sessionFiles.map((file) => [file.path, file.modified])),
      created: createdDates,
      collection,
      sort: noteListPrefs.sort,
      descending: noteListPrefs.descending,
      includeNestedTags: noteListPrefs.includeNestedTags,
      archiveFolder,
    });
  }, [
    sessionFiles,
    noteListPrefs,
    archiveFolder,
    showList,
    collection,
    createdDates,
    vaultIndex.revision,
    dayStamp,
  ]);

  // Hoisted above the `booting` / `!session` early returns: it is a hook, and
  // a hook that renders only on some passes makes React count a different
  // number each time and tear the component down.
  // Every title against every body is real work, so it runs off the cached
  // plain text, only while the panel is up, and capped — as the plan asks.
  // biome-ignore format: the memo deps line up better unwrapped
  const notePath = note?.path ?? null;
  const infoOpen = info.open && info.tab === 'backlinks';
  const mentions = useMemo(
    () => (notePath && infoOpen ? vaultIndex.index.unlinkedMentions(notePath, 12) : []),
    [notePath, infoOpen, vaultIndex],
  );

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
        <button type="button" className="linky" onClick={() => void importFolder()}>
          …or turn a folder of Markdown into a vault
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

  /**
   * Whether anything is docked on the right, and so whether the divider that
   * sizes it should be there at all.
   *
   * Derived once rather than repeated at the resizer: six panels share that
   * edge, and a condition copied beside them would drift the first time one of
   * them grew a new guard.
   */
  const infoPanelOpen = Boolean(
    note?.kind === 'markdown' && info.open && !conflicted && !showTodos && panel === null,
  );
  const historyPanelOpen = panel === 'history' && Boolean(note);
  const rightPanelOpen =
    infoPanelOpen ||
    historyPanelOpen ||
    panel === 'tags' ||
    panel === 'branches' ||
    panel === 'keymap' ||
    panel === 'settings';

  // `revision` is the dependency that matters: the index object is stable and
  // mutated in place, so React cannot see changes without it.
  // `readOnly: true` in frontmatter locks the editor; the frontmatter travels
  // with the file, which app-local state would not. The unlock is per window,
  // per session — the file keeps saying what it says.
  const noteReadOnly = Boolean(
    note &&
      vaultIndex.index.get(note.path)?.frontmatter.readOnly === true &&
      !readOnlyOverrides.has(`${note.root}:${note.path}`),
  );

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
    if (palette === 'notes') {
      const matches = vaultIndex.index.quickSwitch(paletteQuery);
      const typed = paletteQuery.trim();
      if (!typed) {
        // With nothing typed, the most useful order is what you touched last.
        const recency = new Map(session.files.map((file) => [file.path, file.modified]));
        return noteItems(
          [...matches].sort((a, b) => (recency.get(b.path) ?? 0) - (recency.get(a.path) ?? 0)),
        );
      }
      const rows = noteItems(matches);
      // Searching for a note that does not exist is how people decide to write
      // it, so the switcher offers that rather than dead-ending on "no match".
      const exists = matches.some(
        (match) => match.title.toLowerCase() === typed.toLowerCase() || match.path === typed,
      );
      if (exists) return rows;
      return [
        ...rows,
        {
          id: `${CREATE_PREFIX}${typed}`,
          title: `Create “${typed}”`,
          detail: `${typed}.md`,
          isAction: true,
        },
      ];
    }
    if (palette === 'search') {
      const scope =
        searchScoped && collection.kind !== 'all'
          ? collection.kind === 'tag'
            ? ({ kind: 'tag', tag: collection.tag } as const)
            : ({ kind: collection.kind } as const)
          : undefined;

      return searchItems(
        vaultIndex.index.query(paletteQuery, 30, {
          scope,
          modified: new Map(session.files.map((file) => [file.path, file.modified])),
          archiveFolder: session.archiveFolder,
        }),
      );
    }
    if (palette === 'templates') {
      const needle = paletteQuery.trim().toLowerCase();
      const templates = vaultIndex.index
        .paths()
        .filter((path) => path.startsWith(`${TEMPLATES_FOLDER}/`))
        .filter((path) => !needle || path.toLowerCase().includes(needle))
        .map((path) => ({
          id: `${TEMPLATE_PREFIX}${path}`,
          title: vaultIndex.index.get(path)?.title ?? path,
          detail: path,
        }));
      if (templates.length > 0) return templates;
      return [
        {
          id: 'template:none',
          title: 'No templates yet',
          detail: `Create notes under ${TEMPLATES_FOLDER}/ — {{title}}, {{date}} and {{time}} are filled in.`,
        },
      ];
    }
    if (palette === 'tags') {
      const needle = paletteQuery.trim().toLowerCase();
      return (
        vaultIndex.index
          .tags()
          .filter(({ tag }) => !needle || tag.toLowerCase().includes(needle))
          // The list is already most-used-first; past this depth, typing narrows.
          .slice(0, 100)
          .map(({ tag, count }) => ({
            id: `${TAG_PREFIX}${tag}`,
            title: `#${tag}`,
            detail: `${count} note${count === 1 ? '' : 's'}`,
          }))
      );
    }
    return [];
  })();

  const onPaletteChoose = (id: string) => {
    setPalette(null);
    if (palette === 'commands') {
      handlers[id as keyof typeof handlers]?.();
      return;
    }
    if (id.startsWith(CREATE_PREFIX)) {
      const name = id.slice(CREATE_PREFIX.length);
      void createNote(`${name}.md`, newNoteBody(name));
      return;
    }
    if (id.startsWith(TEMPLATE_PREFIX)) {
      setPrompt({ kind: 'fromTemplate', template: id.slice(TEMPLATE_PREFIX.length) });
      return;
    }
    if (id === 'template:none') return;
    if (id.startsWith(TAG_PREFIX)) {
      // A tag is a place to go: the list becomes that tag's notes.
      setCollection({ kind: 'tag', tag: id.slice(TAG_PREFIX.length) });
      setShowList(true);
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

  /** A command's current shortcut, for tooltips. Empty when it is unbound. */
  const shortcut = (id: string) => {
    const binding = vaultIndex.keymap.byCommand.get(id);
    return binding ? formatBinding(binding, PLATFORM) : 'unbound';
  };

  const stats = note?.kind === 'markdown' ? readingStats(note.doc) : null;
  const lineCount = note?.kind === 'text' ? note.doc.split('\n').length : null;
  const noteTitle = note ? (vaultIndex.index.get(note.path)?.title ?? baseName(note.path)) : null;
  const noteFolder =
    note && note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
  const pinnedHere = note ? session.pinned.includes(note.path) : false;

  /** Most recently touched notes, for the empty state. */
  const recentNotes = [...session.files]
    .filter((file) => file.kind === 'markdown')
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 6);

  return (
    <div className="app">
      {/* WKWebView ignores `-webkit-app-region`, so the drag region is
          declared for Tauri instead. "deep" makes the whole strip
          grabbable; the runtime still lets buttons take their own
          clicks. Needs `core:window:allow-start-dragging`. */}
      <header className="titlebar" data-tauri-drag-region="deep">
        <nav className="vault-tabs">
          {/* Two buttons, not one: a close control nested inside the tab
              button would be a button inside a button. The wrapper carries the
              tab's look, and the name button carries its padding, so the hit
              area for selecting a vault is the whole tab bar the ×. */}
          {openVaults.map((s) => (
            <span
              key={s.info.root}
              className={`vault-tab ${s.info.root === ws.activeRoot ? 'is-active' : ''}`}
            >
              <button
                type="button"
                className="vault-tab-name"
                onClick={() => ws.setActiveRoot(s.info.root)}
                title={s.info.root}
              >
                <span className={`tab-dot is-${s.state.phase}`} />
                {s.info.name}
              </button>
              <button
                type="button"
                className="vault-tab-close"
                onClick={() => void closeVaultAt(s.info.root)}
                aria-label={`Close ${s.info.name}`}
                title={`Close ${s.info.name}`}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="vault-tab is-add" onClick={choose} title="Open a vault">
            +
          </button>
        </nav>

        {/* Vault-scoped actions only. Anything about the open note lives on the
            note bar below, and anything ambient lives in the status bar. */}
        <div className="actions">
          <button
            type="button"
            onClick={() => openPalette('search')}
            title={`Search in vault (${shortcut('search.open')})`}
          >
            <span className="glyph">⌕</span> Search
          </button>
          <button
            type="button"
            className={showTodos ? 'is-on' : ''}
            onClick={() => {
              setShowTodos((v) => !v);
              setPreview(null);
            }}
            title={`All tasks (${shortcut('todos.open')})`}
          >
            <span className="glyph">☑</span> Tasks
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={sync}
            title={`Commit, pull and push now (${shortcut('sync.now')})`}
          >
            Sync now
          </button>
          <button
            type="button"
            className={panel === 'settings' ? 'is-on' : ''}
            onClick={() => togglePanel('settings')}
            aria-label="Settings"
            title={`Settings (${shortcut('sync.settings')})`}
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

      {/* The widths ride down as custom properties rather than as props: the
          right-hand panels are six different components sharing one rule, and
          threading a width through each of them would be six chances to
          forget one. */}
      <div
        className="body"
        style={
          {
            '--sidebar-width': `${paneWidths.sidebar}px`,
            '--list-width': `${paneWidths.list}px`,
            '--panel-width': `${paneWidths.panel}px`,
          } as CSSProperties
        }
      >
        {showSidebar && (
          <aside className="sidebar">
            <Sidebar
              files={session.files}
              activePath={note?.path ?? preview?.path ?? drawing?.path ?? null}
              changedPaths={new Set(session.state.conflicts)}
              onSelect={select}
              onContext={(path, kind, x, y) => setContextTarget({ path, kind, x, y })}
              onNewNote={() => setPrompt({ kind: 'newNote', parent: '' })}
              onNewFolder={() => setPrompt({ kind: 'newFolder', parent: '' })}
              onMove={(from, toFolder) => void move(from, toFolder)}
              pinned={session.pinned}
            />
          </aside>
        )}
        {showSidebar && (
          <PaneResizer
            pane="before"
            label="Resize sidebar"
            width={paneWidths.sidebar}
            min={PANE_LIMITS.sidebar.min}
            max={PANE_LIMITS.sidebar.max}
            fallback={PANE_DEFAULTS.sidebar}
            onResize={(next) => setPaneWidth('sidebar', next)}
          />
        )}

        {showList && (
          <aside className="list-pane">
            <NoteList
              entries={noteListEntries}
              collection={collection}
              activePath={note?.path ?? null}
              sort={session.noteList.sort}
              descending={session.noteList.descending}
              density={session.noteList.density}
              showBadges={session.noteList.showBadges}
              onSelect={(path) => void openNoteAt(path)}
              onCollectionChange={setCollection}
              onSortChange={(sort) =>
                void ws.updatePrefs(session.info.root, {
                  noteList: { ...session.noteList, sort },
                })
              }
              onDescendingChange={(descending) =>
                void ws.updatePrefs(session.info.root, {
                  noteList: { ...session.noteList, descending },
                })
              }
              onContext={(path, x, y) => setContextTarget({ path, kind: 'file', x, y })}
            />
          </aside>
        )}
        {showList && (
          <PaneResizer
            pane="before"
            label="Resize note list"
            width={paneWidths.list}
            min={PANE_LIMITS.list.min}
            max={PANE_LIMITS.list.max}
            fallback={PANE_DEFAULTS.list}
            onResize={(next) => setPaneWidth('list', next)}
          />
        )}

        <section className="pane">
          {/* Note-scoped actions sit with the note, not in the window chrome,
              so it is never ambiguous what "History" is the history of. */}
          {note && !conflicted && !showTodos && (
            <div className="note-bar">
              <div className="note-id" title={note.path}>
                {noteFolder && <span className="note-folder">{noteFolder}/</span>}
                <span className="note-title">{noteTitle}</span>
              </div>
              <div className="note-actions">
                {noteReadOnly && (
                  <button
                    type="button"
                    className="is-on"
                    title="readOnly: true in this note's frontmatter. Click to edit anyway, for this window."
                    onClick={() => setReadOnlyOverrides((prev) => new Set(prev).add(note.path))}
                  >
                    🔒 Read-only
                  </button>
                )}
                <button
                  type="button"
                  className={pinnedHere ? 'is-on' : ''}
                  onClick={() => void togglePin()}
                  title={pinnedHere ? 'Unpin from the sidebar' : 'Pin to the top of the sidebar'}
                >
                  {pinnedHere ? '★' : '☆'}
                </button>
                {note.kind === 'markdown' && (
                  <button
                    type="button"
                    className={info.open && info.tab === 'outline' && panel === null ? 'is-on' : ''}
                    onClick={() => handlers['view.outline']()}
                    title={`Outline (${shortcut('view.outline')})`}
                  >
                    Outline
                  </button>
                )}
                <button
                  type="button"
                  className={panel === 'history' ? 'is-on' : ''}
                  onClick={() => togglePanel('history')}
                  title={`History of this note (${shortcut('view.history')})`}
                >
                  History
                </button>
                {note.kind === 'markdown' && (
                  <button
                    type="button"
                    className={info.open && panel === null ? 'is-on' : ''}
                    onClick={() => {
                      setPanel(null);
                      setInfo((prev) => ({ ...prev, open: !prev.open }));
                    }}
                    title={
                      backlinks.length === 0 && noteTags.length === 0
                        ? 'No tags, and no note links here yet'
                        : `Links and tags (${shortcut('view.toggleBacklinks')})`
                    }
                  >
                    Links{backlinks.length > 0 ? ` ${backlinks.length}` : ''}
                  </button>
                )}
              </div>
            </div>
          )}

          {showTodos ? (
            <TodoView
              todos={todos}
              onOpen={(path, line) => void openNoteAt(path, line)}
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
          ) : note?.kind === 'text' ? (
            <TextEditor
              key={`${session.info.root}:${note.path}:${note.revision}`}
              path={note.path}
              doc={freshestDoc(note)}
              onChange={onDocChange}
            />
          ) : note ? (
            <NoteEditor
              // `dark` is in the key because diagram SVGs bake in their colours
              // and must be redrawn when the appearance flips. That remount is
              // why the doc comes from `freshestDoc`: state can be an autosave
              // interval behind the editor. Typography changes stay pure CSS
              // and never come through here.
              key={`${session.info.root}:${note.path}:${note.revision}:${dark}:${noteReadOnly}:${session.spellcheck}`}
              path={note.path}
              readOnly={noteReadOnly}
              spellcheck={session.spellcheck}
              doc={freshestDoc(note)}
              onChange={onDocChange}
              resolveLink={(target) => vaultIndex.index.resolveLink(target)}
              onFollowLink={followLink}
              dark={dark}
              attachments={attachments}
              sortTodosOnCompletion={session.sortTodosOnCompletion}
              completion={completion}
              concealEverywhere={session.concealEverywhere}
              collapsedEmbeds={collapsedEmbeds}
              attachmentsStamp={attachmentsStamp}
              paste={{
                asMarkdown: session.pasteAsMarkdown,
                fetchTitles: session.fetchLinkTitles,
                fetchTitle: (url) => api.fetchPageTitle(url),
              }}
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
              {preview.kind === 'pdf' ? (
                <embed
                  className="preview-pdf"
                  src={preview.url}
                  type="application/pdf"
                  title={preview.path}
                />
              ) : (
                <img src={preview.url} alt={preview.path} />
              )}
              <p className="preview-caption">{preview.path} — preview only</p>
            </div>
          ) : (
            /* An empty pane is the first thing a new vault shows, so it does
               the job a blank canvas cannot: name the next three moves. */
            <div className="pane-empty">
              <h2>{session.info.name}</h2>
              <p className="muted-note">
                {session.files.filter((f) => f.kind === 'markdown').length} notes in this vault.
              </p>

              <div className="empty-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => setPrompt({ kind: 'newNote', parent: '' })}
                >
                  New note <kbd>{shortcut('note.new')}</kbd>
                </button>
                <button type="button" className="ghost" onClick={() => openPalette('notes')}>
                  Go to note <kbd>{shortcut('switcher.open')}</kbd>
                </button>
                <button type="button" className="ghost" onClick={() => handlers['note.daily']()}>
                  Today's note <kbd>{shortcut('note.daily')}</kbd>
                </button>
              </div>

              {recentNotes.length > 0 && (
                <section className="empty-recents">
                  <h3>Recent</h3>
                  <ul>
                    {recentNotes.map((file) => (
                      <li key={file.path}>
                        <button type="button" onClick={() => void openNoteAt(file.path)}>
                          <span className="recent-note-title">
                            {vaultIndex.index.get(file.path)?.title ?? baseName(file.path)}
                          </span>
                          <span className="recent-note-path">{file.path}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </section>

        {rightPanelOpen && (
          <PaneResizer
            pane="after"
            label="Resize panel"
            width={paneWidths.panel}
            min={PANE_LIMITS.panel.min}
            max={PANE_LIMITS.panel.max}
            fallback={PANE_DEFAULTS.panel}
            onResize={(next) => setPaneWidth('panel', next)}
          />
        )}

        {infoPanelOpen && note && (
          <InfoPanel
            path={note.path}
            tab={info.tab}
            onTabChange={(tab) => setInfo({ open: true, tab })}
            stats={noteStats(splitFrontmatter(freshestDoc(note)).body)}
            created={createdDates.get(note.path) ?? null}
            modified={session.files.find((f) => f.path === note.path)?.modified ?? 0}
            headings={vaultIndex.index.get(note.path)?.headings ?? []}
            onGoToLine={(line) => editorRef.current?.goToLine(line)}
            backlinks={backlinks}
            tags={noteTags}
            mentions={mentions}
            onOpen={(path) => void openNoteAt(path)}
            onSelectTag={(tag) => {
              setSelectedTag(tag);
              setPanel('tags');
            }}
            onLinkMention={(mentioning) => {
              const title = vaultIndex.index.get(note.path)?.title;
              if (title) void linkMention(mentioning, note.path, title);
            }}
            onClose={() => setInfo((prev) => ({ ...prev, open: false }))}
          />
        )}

        {historyPanelOpen && note && (
          <HistoryPanel
            root={session.info.root}
            path={note.path}
            dirty={session.state.phase === 'dirty'}
            onClose={() => setPanel(null)}
            onRestored={() => void reloadFromDisk()}
          />
        )}

        {panel === 'tags' && (
          <TagPanel
            tags={vaultIndex.index.tags()}
            initialTag={selectedTag}
            notesForTag={(tag) =>
              vaultIndex.index
                .paths()
                .filter((path) => {
                  const entry = vaultIndex.index.get(path);
                  // Children count: selecting #work lists #work/urgent notes too.
                  return entry ? noteHasTag(entry.tags, tag, true) : false;
                })
                .map((path) => ({
                  path,
                  title: vaultIndex.index.get(path)?.title ?? path,
                }))
            }
            familyCounts={tagFamilyCounts}
            pinnedTags={session.pinnedTags}
            tagIcons={session.tagIcons}
            sort={session.tagSort}
            onSortChange={(tagSort) => void ws.updatePrefs(session.info.root, { tagSort })}
            onTogglePin={(tag) =>
              void ws.updatePrefs(session.info.root, {
                pinnedTags: session.pinnedTags.includes(tag)
                  ? session.pinnedTags.filter((t) => t !== tag)
                  : [...session.pinnedTags, tag],
              })
            }
            onSetIcon={(tag, icon) => {
              const tagIcons = { ...session.tagIcons };
              if (icon) tagIcons[tag] = icon;
              else delete tagIcons[tag];
              void ws.updatePrefs(session.info.root, { tagIcons });
            }}
            onRename={(tag, count) => setPrompt({ kind: 'renameTag', tag, count })}
            onDelete={(tag, count) =>
              setConfirmAction({
                title: `Remove #${tag} everywhere?`,
                body: `The tag and its children come out of ${count} note${count === 1 ? '' : 's'}, as one commit. The notes themselves are not deleted.`,
                confirmLabel: 'Remove tag',
                run: () => void deleteTag(tag),
              })
            }
            onShowInList={(tag) => {
              setCollection({ kind: 'tag', tag });
              setShowList(true);
              setPanel(null);
            }}
            onOpen={(path) => void openNoteAt(path)}
            onClose={() => {
              setPanel(null);
              setSelectedTag(null);
            }}
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
            prefs={{
              sortTodosOnCompletion: session.sortTodosOnCompletion,
              completion: session.completion,
              concealEverywhere: session.concealEverywhere,
              newNoteHeading: session.newNoteHeading,
              insertTagsAt: session.insertTagsAt,
              theme: session.theme,
              typography: session.typography,
              noteList: session.noteList,
              attachmentFolder: session.attachmentFolder,
              imageDisplay: session.imageDisplay,
              archiveFolder: session.archiveFolder,
              spellcheck: session.spellcheck,
              pasteAsMarkdown: session.pasteAsMarkdown,
              fetchLinkTitles: session.fetchLinkTitles,
              copyStripsTags: session.copyStripsTags,
            }}
            themes={vaultThemes}
            onChange={(next) => void ws.updateSettings(session.info.root, next)}
            onPausedChange={(p) => ws.setPaused(session.info.root, p)}
            onPrefsChange={(next) => void ws.updatePrefs(session.info.root, next)}
            onClose={() => setPanel(null)}
          />
        )}
      </div>

      {/* Ambient state, always on screen and never in the way: which branch,
          whether the work is safe, and how long the note is. */}
      <footer className="statusbar">
        <div className="status-left">
          <button
            type="button"
            className={`status-button ${showSidebar ? '' : 'is-off'}`}
            onClick={() => setShowSidebar((v) => !v)}
            title={`Toggle sidebar (${shortcut('view.toggleSidebar')})`}
            aria-label="Toggle sidebar"
          >
            ▤
          </button>
          <button
            type="button"
            className={`status-button ${panel === 'branches' ? 'is-on' : ''}`}
            onClick={() => togglePanel('branches')}
            title={`Branches and pull requests (${shortcut('view.branches')})`}
          >
            ⑂ {session.state.branch || session.info.branch}
          </button>
          {!session.state.upstream && <span className="no-upstream">no upstream</span>}
          <button
            type="button"
            className="status-button"
            onClick={() => {
              if (ws.activeRoot) ws.setPaused(ws.activeRoot, !paused);
            }}
            title={
              paused
                ? `Resume syncing (${shortcut('sync.togglePause')})`
                : `Pause syncing (${shortcut('sync.togglePause')})`
            }
          >
            <SyncBadge state={session.state} paused={paused} />
          </button>
        </div>

        <div className="status-right">
          <span className={`save-state is-${saveState}`}>{saveLabel(saveState)}</span>
          {lineCount !== null && (
            <span className="status-plain">
              {lineCount.toLocaleString()} line{lineCount === 1 ? '' : 's'}
            </span>
          )}
          {stats && (
            <button
              type="button"
              className={`status-button ${info.open && info.tab === 'stats' ? 'is-on' : ''}`}
              onClick={() => {
                setPanel(null);
                setInfo((prev) =>
                  prev.open && prev.tab === 'stats'
                    ? { ...prev, open: false }
                    : { open: true, tab: 'stats' },
                );
              }}
              title="Statistics"
            >
              {stats.words.toLocaleString()} word{stats.words === 1 ? '' : 's'} · {stats.minutes}{' '}
              min read
            </button>
          )}
        </div>
      </footer>

      {contextTarget && (
        <ContextMenu
          target={contextTarget}
          onExportFolder={(folder, mode) => {
            setContextTarget(null);
            void exportFolder(folder, mode);
          }}
          onArchive={(path) => {
            setContextTarget(null);
            void archiveNote(path);
          }}
          isArchived={(path) => isArchivedPath(path, session.archiveFolder)}
          onMergeFolder={(folder) => {
            setContextTarget(null);
            const prefix = folder ? `${folder}/` : '';
            const paths = vaultIndex.index
              .paths()
              .filter((path) => path.startsWith(prefix))
              .filter((path) => !isArchivedPath(path, session.archiveFolder))
              .filter((path) => !path.startsWith(`${TEMPLATES_FOLDER}/`))
              // Tree order — folders before files at each level, names
              // case-insensitive — because that is the order on screen.
              .sort(treeOrder);
            if (paths.length < 2) {
              setMessage('Merging needs at least two notes in the folder.');
              return;
            }
            setPrompt({ kind: 'mergeFolder', folder, paths });
          }}
          onReveal={(path) => {
            setContextTarget(null);
            if (ws.activeRoot) {
              void api
                .revealInFileManager(ws.activeRoot, path)
                .catch((e) => ws.setError(errorText(e)));
            }
          }}
          onOpenWith={(path) => {
            setContextTarget(null);
            if (ws.activeRoot) {
              void api
                .openInDefaultApp(ws.activeRoot, path)
                .catch((e) => ws.setError(errorText(e)));
            }
          }}
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

      {prompt?.kind === 'addTag' && (
        <Prompt
          title="Add tag"
          label="Tag"
          hint={`Added at the ${session?.insertTagsAt ?? 'bottom'} of the note. Nested tags like project/alpha work too.`}
          confirmLabel="Add"
          onClose={() => setPrompt(null)}
          onConfirm={(tag) => {
            setPrompt(null);
            // Normalise to something the indexer will actually record —
            // inserting `#hello world` and reporting success while the index
            // only sees `#hello` would be a quiet lie.
            const cleaned = tag.trim().replace(/^#+/, '').replace(/\s+/g, '-');
            const valid = /^[\p{L}\p{N}][\p{L}\p{N}_/-]*$/u.test(cleaned) && !/^\d+$/.test(cleaned);
            if (!cleaned) return;
            if (!valid) {
              setMessage(`“${cleaned}” cannot be a tag — tags are letters, numbers, - _ and /.`);
              return;
            }
            editorRef.current?.insertTag(cleaned, session?.insertTagsAt ?? 'bottom');
          }}
        />
      )}

      {prompt?.kind === 'fromTemplate' && (
        <Prompt
          title="New note from template"
          label="Title"
          hint={`From ${prompt.template}. {{title}}, {{date}} and {{time}} are filled in.`}
          onClose={() => setPrompt(null)}
          onConfirm={(title) => {
            const template = prompt.template;
            setPrompt(null);
            void createFromTemplate(template, title);
          }}
        />
      )}

      {prompt?.kind === 'mergeFolder' && (
        <Prompt
          title={`Merge ${prompt.paths.length} notes`}
          label="Name for the merged note"
          confirmLabel="Merge"
          hint="Tree order, a heading per source. The sources are deleted in the same commit, so it reverts in one action."
          onClose={() => setPrompt(null)}
          onConfirm={(name) => {
            const { folder, paths } = prompt;
            setPrompt(null);
            void mergeFolder(folder, paths, name);
          }}
        />
      )}

      {prompt?.kind === 'renameTag' && (
        <Prompt
          title={`Rename #${prompt.tag}`}
          label="New name"
          initial={prompt.tag}
          confirmLabel="Rename"
          hint={`Rewrites ${prompt.count} note${prompt.count === 1 ? '' : 's'} as one commit. Children like #${prompt.tag}/x are carried along.`}
          onClose={() => setPrompt(null)}
          onConfirm={(name) => {
            const from = prompt.tag;
            setPrompt(null);
            const to = name.trim().replace(/^#+/, '').replace(/\s+/g, '-');
            if (!to || to === from) return;
            if (!/^[\p{L}\p{N}][\p{L}\p{N}_/-]*$/u.test(to) || /^\d+$/.test(to)) {
              setMessage(`“${to}” cannot be a tag — tags are letters, numbers, - _ and /.`);
              return;
            }
            void renameTag(from, to);
          }}
        />
      )}

      {confirmAction && (
        <ConfirmAction
          title={confirmAction.title}
          body={confirmAction.body}
          confirmLabel={confirmAction.confirmLabel}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => {
            const { run } = confirmAction;
            setConfirmAction(null);
            run();
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

      {bulkExport && (
        <div className="bulk-export" role="status">
          <span>
            Exporting {bulkExport.done} of {bulkExport.total}…
          </span>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              bulkCancelled.current = true;
            }}
          >
            Cancel
          </button>
        </div>
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
          scopeLabel={
            palette === 'search' && searchScoped && collection.kind !== 'all'
              ? collectionTitle(collection)
              : null
          }
          onClearScope={() => setSearchScoped(false)}
          onQueryChange={setPaletteQuery}
          onChoose={onPaletteChoose}
          onClose={() => setPalette(null)}
        />
      )}
    </div>
  );
}

/** The last path segment, without its extension. */
function baseName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

/**
 * Length as a reader experiences it.
 *
 * 200 wpm is the conventional figure for prose; the minute count is floored at
 * one so a short note reads "1 min" rather than "0 min".
 */
function readingStats(text: string): { words: number; minutes: number } {
  const words = countWords(text);
  return { words, minutes: Math.max(1, Math.round(words / 200)) };
}

/** Words as a person counts them, ignoring markdown punctuation. */
/**
 * The sidebar's ordering, as a comparator: folders sort before files at each
 * level, names case-insensitively - so a merge reads top to bottom the way
 * the tree does.
 */
function treeOrder(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const depth = Math.min(as.length, bs.length);
  for (let i = 0; i < depth; i++) {
    const aIsLeaf = i === as.length - 1;
    const bIsLeaf = i === bs.length - 1;
    if (aIsLeaf !== bIsLeaf) return aIsLeaf ? 1 : -1;
    const cmp = (as[i] ?? '').localeCompare(bs[i] ?? '', undefined, { sensitivity: 'base' });
    if (cmp !== 0) return cmp;
  }
  return as.length - bs.length;
}

function countWords(text: string): number {
  const words = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`~[\]()|-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length;
}

function saveLabel(state: SaveState): string {
  if (state === 'saving') return 'Saving…';
  if (state === 'dirty') return 'Unsaved';
  if (state === 'error') return 'Save failed';
  return 'Saved';
}
