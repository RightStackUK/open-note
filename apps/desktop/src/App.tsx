import {
  attachmentFolderFor,
  COMMANDS,
  dailyNotePath,
  dailyNoteTemplate,
  exportNoteToHtml,
  formatBinding,
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
import { OutlinePanel } from './components/OutlinePanel';
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
import { TagPanel } from './components/TagPanel';
import { TextEditor } from './components/TextEditor';
import { TodoView } from './components/TodoView';
import { relativeFrom, resolveAgainst } from './paths';
import { PLATFORM, useCommandKeys } from './useCommands';
import { useDarkMode } from './useDarkMode';
import { useVaultIndex } from './useVaultIndex';
import { errorText, useWorkspace } from './useWorkspace';

/** How long the editor sits idle before the note is written to disk. */
const AUTOSAVE_IDLE_MS = 500;

/** Marks a quick-switcher row that creates rather than opens. */
const CREATE_PREFIX = 'create:';

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
  const [panel, setPanel] = useState<
    'settings' | 'keymap' | 'history' | 'branches' | 'tags' | 'outline' | null
  >(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
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
    [ws, flush],
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
    async (path: string, line?: number) => {
      const root = ws.activeRoot;
      if (!root) return;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      await flush();
      try {
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
    [ws, flush],
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

    if (!root) return;
    const remembered = lastNoteByVault.current.get(root);
    // Only if it is still there: the note may have been deleted, or the vault
    // may have moved to a branch without it.
    const stillThere = ws.sessions[root]?.files.some((file) => file.path === remembered);
    if (remembered && stillThere) void openNoteAt(remembered);
  }, [ws.activeRoot, ws.sessions, flush, openNoteAt]);

  useEffect(() => {
    const line = pendingLine.current;
    if (line === null || !note) return;
    pendingLine.current = null;
    editorRef.current?.goToLine(line);
  }, [note]);

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
        return relativeFrom(open.path, path);
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
    [ws, session?.attachmentFolder],
  );

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
      'view.tags': () => togglePanel('tags'),
      'view.outline': () => togglePanel('outline'),
      'note.export': () => void exportNote(),
      'note.togglePin': () => void togglePin(),
      'note.duplicate': () => void duplicateNote(),
      'note.fromSelection': () => void noteFromSelection(),
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
    [openPalette, createNote, sync, ws, paused, togglePanel, duplicateNote, noteFromSelection],
  );

  useCommandKeys(vaultIndex.keymap, handlers, palette === null);

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
    if (palette === 'search') return searchItems(vaultIndex.index.query(paletteQuery));
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
      void createNote(`${name}.md`, `# ${name}\n\n`);
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

      <div className="body">
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
                    className={panel === 'outline' ? 'is-on' : ''}
                    onClick={() => togglePanel('outline')}
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
                    className={showBacklinks && panel === null ? 'is-on' : ''}
                    // Nothing links here and nothing is tagged, so there is no
                    // panel to show; saying so beats a button that does nothing.
                    disabled={backlinks.length === 0 && noteTags.length === 0}
                    onClick={() => {
                      setPanel(null);
                      setShowBacklinks((v) => !v);
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
              doc={note.doc}
              onChange={onDocChange}
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
              attachments={attachments}
              sortTodosOnCompletion={session.sortTodosOnCompletion}
              completion={completion}
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

        {note?.kind === 'markdown' &&
          showBacklinks &&
          !conflicted &&
          !showTodos &&
          panel === null &&
          (backlinks.length > 0 || noteTags.length > 0) && (
            <BacklinksPanel
              path={note.path}
              backlinks={backlinks}
              tags={noteTags}
              onOpen={(path) => void openNoteAt(path)}
              onSelectTag={(tag) => {
                setSelectedTag(tag);
                setPanel('tags');
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

        {panel === 'outline' && note?.kind === 'markdown' && (
          <OutlinePanel
            headings={vaultIndex.index.get(note.path)?.headings ?? []}
            words={countWords(note.doc)}
            characters={note.doc.length}
            onGoToLine={(line) => editorRef.current?.goToLine(line)}
            onClose={() => setPanel(null)}
          />
        )}

        {panel === 'tags' && (
          <TagPanel
            tags={vaultIndex.index.tags()}
            initialTag={selectedTag}
            notesForTag={(tag) =>
              vaultIndex.index.notesWithTag(tag).map((path) => ({
                path,
                title: vaultIndex.index.get(path)?.title ?? path,
              }))
            }
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
            }}
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
              className={`status-button ${panel === 'outline' ? 'is-on' : ''}`}
              onClick={() => togglePanel('outline')}
              title={`Outline (${shortcut('view.outline')})`}
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
