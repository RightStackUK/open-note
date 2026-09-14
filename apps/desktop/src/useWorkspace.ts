import {
  type MergeOutcome,
  type NoteListPrefs,
  parseVaultSettings,
  type SyncSettings,
  type SyncState,
  serialiseVaultSettings,
  type TypographySettings,
  type VaultSettings,
  VaultSync,
} from '@open-note/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  api,
  createSyncPort,
  emitVault,
  listenVault,
  VaultEvents,
  type VaultFile,
  type VaultInfo,
  windowLabel,
} from './api';

/**
 * Which vault to show once `closing` is gone.
 *
 * `open` is the list *before* the close is applied, because the caller reads it
 * from state that React has not re-rendered yet — so `closing` is still in it
 * and has to be skipped explicitly. Picking the first entry blind selects the
 * vault that was just closed whenever it happens to sort first, which leaves
 * the app pointed at a session that no longer exists.
 *
 * Closing a vault that is not the active one changes nothing.
 */
export function nextActiveRoot(
  open: string[],
  closing: string,
  current: string | null,
): string | null {
  if (current !== closing) return current;
  return open.find((root) => root !== closing) ?? null;
}

/**
 * The per-vault preferences, as they sit in `.opennote/settings.json` beside
 * the `sync` block. Named separately so a setter can take a partial of exactly
 * these without also accepting `info` or `files`.
 */
export type VaultPrefs = Omit<VaultSettings, 'sync'> & { sync?: SyncSettings };

export interface VaultSession {
  info: VaultInfo;
  files: VaultFile[];
  state: SyncState;
  settings: SyncSettings;
  /** Where pasted attachments go; `.` means beside the note. */
  attachmentFolder: string;
  /** Vault-relative paths kept at the top of the tree. */
  pinned: string[];
  /** Move a completed task to the bottom of its list automatically. */
  sortTodosOnCompletion: boolean;
  /** Offer `[[`, `#` and `:` completion while typing. */
  completion: boolean;
  /** How the prose looks; applied as CSS variables. */
  typography: TypographySettings;
  /** Theme name; empty follows the OS. */
  theme: string;
  /** Conceal Markdown syntax on every line, not just off the active one. */
  concealEverywhere: boolean;
  /** What a new note starts with. */
  newNoteHeading: 'h1' | 'none';
  /** Where `note.addTag` puts the tag. */
  insertTagsAt: 'top' | 'bottom';
  /** How the note list pane filters, sorts and draws. */
  noteList: NoteListPrefs;
  /** Convert pasted HTML to Markdown. */
  pasteAsMarkdown: boolean;
  /** Fetch a pasted bare URL's page title. */
  fetchLinkTitles: boolean;
  /** Copy As drops `#tag` tokens. */
  copyStripsTags: boolean;
  /** Tags kept at the top of the tag browser. */
  pinnedTags: string[];
  /** Tag → emoji, purely cosmetic. */
  tagIcons: Record<string, string>;
  /** Tag browser order. */
  tagSort: 'name' | 'count';
  /** Images: full width, or thumbnails. */
  imageDisplay: 'full' | 'thumbnail';
  /** Where archived notes live. */
  archiveFolder: string;
  /** OS spell checker in notes. */
  spellcheck: boolean;
}

/**
 * Holds every open vault, each with its own sync engine.
 *
 * Engines live in a ref rather than state: they are long-lived objects with
 * timers, and putting them in state would risk React recreating them and
 * orphaning the timers of the old instance.
 */
/**
 * What a follower shows until the owner publishes its state.
 *
 * Not an error and not "synced": the vault's state is simply another window's
 * to report, and a moment of "idle" reads better than a wrong badge.
 */
const FOLLOWER_STATE: SyncState = {
  phase: 'idle',
  branch: '',
  upstream: null,
  ahead: 0,
  behind: 0,
  conflicts: [],
  lastError: null,
  lastSyncedAt: null,
};

export function useWorkspace(onExternalChange: (root: string, outcome: MergeOutcome) => void) {
  /** This window, for claiming vaults. Fixed for the life of the window. */
  const label = useMemo(() => windowLabel(), []);
  const [sessions, setSessions] = useState<Record<string, VaultSession>>({});
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const engines = useRef(new Map<string, VaultSync>());
  // Keep the callback current without re-creating engines.
  const externalRef = useRef(onExternalChange);
  externalRef.current = onExternalChange;

  const patch = useCallback((root: string, next: Partial<VaultSession>) => {
    setSessions((prev) => {
      const existing = prev[root];
      if (!existing) return prev;
      return { ...prev, [root]: { ...existing, ...next } };
    });
  }, []);

  const refreshFiles = useCallback(
    async (root: string) => {
      try {
        patch(root, { files: await api.listFiles(root) });
      } catch (e) {
        setError(String(e));
      }
    },
    [patch],
  );

  const openVault = useCallback(
    async (root: string): Promise<VaultInfo | null> => {
      setError(null);
      try {
        const info = await api.openVault(root);
        if (sessionsRef.current[info.root]) {
          setActiveRoot(info.root);
          return info;
        }

        const vaultSettings = parseVaultSettings(await api.readSettings(info.root));
        const settings = vaultSettings.sync;
        const [files] = await Promise.all([api.listFiles(info.root)]);

        /**
         * One engine per vault, in the window that claimed it.
         *
         * A second window on the same vault opens as a **follower**: it reads
         * and writes files, which is plain IO, and leaves every git call to the
         * owner. Two engines would run two commit, push and fetch loops against
         * one working copy and contend for the index lock — the failure the
         * engine serialises its own calls to avoid.
         */
        // Fail *open*: a window with no engine and no owner is worse than the
        // contention the claim exists to prevent, and the claim is unavailable
        // only where there is no window layer at all.
        const owns = (await api.claimVault(info.root, label).catch(() => true)) !== false;
        const engine = owns
          ? new VaultSync({
              root: info.root,
              port: createSyncPort(),
              settings,
              onState: (state) => {
                patch(info.root, { state });
                // Followers have no engine to ask, so the owner publishes.
                emitVault(VaultEvents.state, { root: info.root, state });
              },
              onExternalChange: (outcome) => {
                void refreshFiles(info.root);
                externalRef.current(info.root, outcome);
                // A pull rewrote files under every window, not just this one.
                emitVault(VaultEvents.changed, { root: info.root });
              },
            })
          : null;
        if (engine) engines.current.set(info.root, engine);

        setSessions((prev) => ({
          ...prev,
          [info.root]: {
            info,
            files,
            state: engine?.getState() ?? FOLLOWER_STATE,
            settings,
            attachmentFolder: vaultSettings.attachmentFolder,
            pinned: vaultSettings.pinned,
            sortTodosOnCompletion: vaultSettings.sortTodosOnCompletion,
            completion: vaultSettings.completion,
            typography: vaultSettings.typography,
            theme: vaultSettings.theme,
            concealEverywhere: vaultSettings.concealEverywhere,
            newNoteHeading: vaultSettings.newNoteHeading,
            insertTagsAt: vaultSettings.insertTagsAt,
            noteList: vaultSettings.noteList,
            pasteAsMarkdown: vaultSettings.pasteAsMarkdown,
            fetchLinkTitles: vaultSettings.fetchLinkTitles,
            copyStripsTags: vaultSettings.copyStripsTags,
            pinnedTags: vaultSettings.pinnedTags,
            tagIcons: vaultSettings.tagIcons,
            tagSort: vaultSettings.tagSort,
            imageDisplay: vaultSettings.imageDisplay,
            archiveFolder: vaultSettings.archiveFolder,
            spellcheck: vaultSettings.spellcheck,
          },
        }));
        setActiveRoot(info.root);
        await engine?.start();
        return info;
      } catch (e) {
        setError(errorText(e));
        return null;
      }
    },
    [patch, refreshFiles],
  );

  const closeVault = useCallback((root: string) => {
    engines.current.get(root)?.stop();
    engines.current.delete(root);
    // Another window may be waiting to run this vault's engine.
    void api.releaseVault(root, label);
    setSessions((prev) => {
      const { [root]: _removed, ...rest } = prev;
      return rest;
    });
    setActiveRoot((current) => nextActiveRoot(Object.keys(sessionsRef.current), root, current));
  }, []);

  // Mirror sessions into a ref so closeVault can pick a replacement without
  // taking a dependency on the sessions object.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /**
   * A file landed on disk.
   *
   * In the owning window that is a nudge to its engine, which decides whether
   * to commit. In a follower there is no engine, so the fact is forwarded and
   * the owner's commit loop picks it up — a note written in the second window
   * is committed by the first, which is the only one holding the index lock.
   */
  const noteSaved = useCallback((root: string) => {
    const engine = engines.current.get(root);
    if (engine) engine.noteChanged();
    else emitVault(VaultEvents.saved, { root });
    void api.listFiles(root).then((files) => {
      setSessions((prev) => (prev[root] ? { ...prev, [root]: { ...prev[root], files } } : prev));
    });
  }, []);

  const syncNow = useCallback(async (root: string) => {
    const engine = engines.current.get(root);
    // Asking the owner rather than refusing: "Sync now" in a follower means
    // the same thing to the user, and the owner is the one that can do it.
    if (!engine) {
      emitVault(VaultEvents.syncNow, { root });
      return;
    }
    await engine.syncNow();
    await api
      .listFiles(root)
      .then((files) =>
        setSessions((prev) => (prev[root] ? { ...prev, [root]: { ...prev[root], files } } : prev)),
      );
  }, []);

  const setPaused = useCallback((root: string, paused: boolean) => {
    const engine = engines.current.get(root);
    if (!engine) return;
    if (paused) engine.pause();
    else engine.resume();
  }, []);

  /**
   * Persist the whole settings file from a session plus an override.
   *
   * One place assembles the file so that adding a setting means adding it to
   * `VaultPrefs` and nowhere else. Reassembling it in each setter meant every
   * new field had to be threaded through all of them, and a setter that forgot
   * one silently reset it on the next unrelated change.
   */
  const writeSettingsFile = useCallback(
    async (root: string, session: VaultSession, override: Partial<VaultPrefs> = {}) => {
      try {
        // Persisted inside the repo, so the choice follows the vault between
        // machines rather than living on this one.
        await api.writeSettings(
          root,
          serialiseVaultSettings({
            sync: session.settings,
            attachmentFolder: session.attachmentFolder,
            pinned: session.pinned,
            sortTodosOnCompletion: session.sortTodosOnCompletion,
            completion: session.completion,
            typography: session.typography,
            theme: session.theme,
            concealEverywhere: session.concealEverywhere,
            newNoteHeading: session.newNoteHeading,
            insertTagsAt: session.insertTagsAt,
            noteList: session.noteList,
            pasteAsMarkdown: session.pasteAsMarkdown,
            fetchLinkTitles: session.fetchLinkTitles,
            copyStripsTags: session.copyStripsTags,
            pinnedTags: session.pinnedTags,
            tagIcons: session.tagIcons,
            tagSort: session.tagSort,
            imageDisplay: session.imageDisplay,
            archiveFolder: session.archiveFolder,
            spellcheck: session.spellcheck,
            ...override,
          }),
        );
      } catch (e) {
        setError(errorText(e));
      }
    },
    [],
  );

  const updateSettings = useCallback(
    async (root: string, next: Partial<SyncSettings>) => {
      const engine = engines.current.get(root);
      const session = sessionsRef.current[root];
      if (!engine || !session) return;
      engine.updateSettings(next);
      const merged = engine.getSettings();
      patch(root, { settings: merged });
      await writeSettingsFile(root, session, { sync: merged });
    },
    [patch, writeSettingsFile],
  );

  /** Change any of the per-vault editor preferences. */
  const updatePrefs = useCallback(
    async (root: string, next: Partial<VaultPrefs>) => {
      const session = sessionsRef.current[root];
      if (!session) return;
      patch(root, next);
      await writeSettingsFile(root, session, next);
    },
    [patch, writeSettingsFile],
  );

  const updatePinned = useCallback(
    (root: string, pinned: string[]) => updatePrefs(root, { pinned }),
    [updatePrefs],
  );

  /** One named commit, for vault-wide operations that must be revertable whole. */
  const commitWith = useCallback(async (root: string, message: string): Promise<boolean> => {
    return (await engines.current.get(root)?.commitWith(message)) ?? false;
  }, []);

  /**
   * Run a slow vault-wide rewrite whose result must land as one named commit.
   *
   * The reservation happens before the first write, not when the commit is
   * finally requested — the idle timer firing mid-operation would otherwise
   * commit half the files under a generic message. `work` returns the commit
   * message, or null to walk away with nothing to commit.
   */
  const runNamedCommit = useCallback(
    async (root: string, work: () => Promise<string | null>): Promise<boolean> => {
      const engine = engines.current.get(root);
      if (!engine) return false;
      engine.reserveNamedCommit();
      try {
        const message = await work();
        if (message === null) return false;
        return await engine.commitWith(message);
      } finally {
        engine.releaseNamedCommit();
      }
    },
    [],
  );

  const conflictResolved = useCallback(async (root: string) => {
    await engines.current.get(root)?.conflictResolved();
  }, []);

  /**
   * Re-read git's status for a vault.
   *
   * Branch switches and history restores run git behind the engine's back, so
   * the badge and the branch label would otherwise sit stale until the next
   * fetch tick — which, with automatic fetching off, never comes.
   */
  const refreshStatus = useCallback(async (root: string) => {
    await engines.current.get(root)?.refresh();
  }, []);

  const ownsVault = useCallback((root: string) => engines.current.has(root), []);

  /**
   * Take over a vault this window was following.
   *
   * Only the window that wins the claim builds an engine, so a third window
   * that loses the race goes on following — under whoever won.
   */
  const adoptVault = useCallback(
    async (root: string) => {
      const session = sessionsRef.current[root];
      if (!session || engines.current.has(root)) return;
      if (!(await api.claimVault(root, label))) return;
      const engine = new VaultSync({
        root,
        port: createSyncPort(),
        settings: session.settings,
        onState: (state) => {
          patch(root, { state });
          emitVault(VaultEvents.state, { root, state });
        },
        onExternalChange: (outcome) => {
          void refreshFiles(root);
          externalRef.current(root, outcome);
          emitVault(VaultEvents.changed, { root });
        },
      });
      engines.current.set(root, engine);
      patch(root, { state: engine.getState() });
      await engine.start();
    },
    [label, patch, refreshFiles],
  );

  /**
   * Cross-window traffic.
   *
   * Every window listens to all of it and ignores what is not its business:
   * a broadcast with a vault root in it is cheaper to reason about than a
   * directed channel that has to know who is listening.
   */
  useEffect(() => {
    const offState = listenVault<{ root: string; state: SyncState }>(
      VaultEvents.state,
      ({ root, state }) => {
        // Only a follower takes state from outside: the owner's engine is the
        // authority on its own vault, and adopting an echo would fight it.
        if (engines.current.has(root)) return;
        setSessions((prev) => (prev[root] ? { ...prev, [root]: { ...prev[root], state } } : prev));
      },
    );

    const offSaved = listenVault<{ root: string }>(VaultEvents.saved, ({ root }) => {
      const engine = engines.current.get(root);
      if (!engine) return;
      engine.noteChanged();
      void refreshFiles(root);
    });

    const offSync = listenVault<{ root: string }>(VaultEvents.syncNow, ({ root }) => {
      const engine = engines.current.get(root);
      if (!engine) return;
      void engine.syncNow().then(() => refreshFiles(root));
    });

    const offChanged = listenVault<{ root: string }>(VaultEvents.changed, ({ root }) => {
      if (engines.current.has(root)) return;
      void refreshFiles(root);
      externalRef.current(root, { kind: 'alreadyUpToDate' });
    });

    /**
     * The owner closed. Whoever still has the vault open takes it over.
     *
     * Every remaining window races to claim, and the registry settles it — the
     * one that wins builds an engine for a vault it was following, so the
     * repository does not silently stop being committed.
     */
    const offOwnerless = listenVault<string>(VaultEvents.ownerless, (root) => {
      if (!sessionsRef.current[root] || engines.current.has(root)) return;
      void adoptVault(root);
    });

    return () => {
      offState();
      offSaved();
      offSync();
      offChanged();
      offOwnerless();
    };
  }, [refreshFiles, adoptVault]);

  // Stop every engine when the window goes away, so no timer fires into a
  // torn-down app.
  useEffect(() => {
    const map = engines.current;
    return () => {
      for (const engine of map.values()) engine.stop();
      map.clear();
    };
  }, []);

  return {
    sessions,
    activeRoot,
    setActiveRoot,
    error,
    setError,
    openVault,
    closeVault,
    noteSaved,
    syncNow,
    setPaused,
    updateSettings,
    conflictResolved,
    refreshStatus,
    updatePinned,
    updatePrefs,
    commitWith,
    runNamedCommit,
    refreshFiles,
    isPaused: (root: string) => engines.current.get(root)?.isPaused() ?? false,
    /**
     * Whether this window runs the sync engine for a vault.
     *
     * One engine per vault, and it lives in the window that opened it first —
     * so this is also the answer to "whose tabs does that vault remember?" and
     * "who may write to the repository's own state?".
     */
    ownsVault,
  };
}

/** Backend errors arrive as `{ code, message }`; show the message. */
export function errorText(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
