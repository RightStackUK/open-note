import {
  type MergeOutcome,
  parseVaultSettings,
  type SyncSettings,
  type SyncState,
  serialiseVaultSettings,
  VaultSync,
} from '@open-note/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, createSyncPort, type VaultFile, type VaultInfo } from './api';

export interface VaultSession {
  info: VaultInfo;
  files: VaultFile[];
  state: SyncState;
  settings: SyncSettings;
  /** Where pasted attachments go; `.` means beside the note. */
  attachmentFolder: string;
}

/**
 * Holds every open vault, each with its own sync engine.
 *
 * Engines live in a ref rather than state: they are long-lived objects with
 * timers, and putting them in state would risk React recreating them and
 * orphaning the timers of the old instance.
 */
export function useWorkspace(onExternalChange: (root: string, outcome: MergeOutcome) => void) {
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
        if (engines.current.has(info.root)) {
          setActiveRoot(info.root);
          return info;
        }

        const vaultSettings = parseVaultSettings(await api.readSettings(info.root));
        const settings = vaultSettings.sync;
        const [files] = await Promise.all([api.listFiles(info.root)]);

        const engine = new VaultSync({
          root: info.root,
          port: createSyncPort(),
          settings,
          onState: (state) => patch(info.root, { state }),
          onExternalChange: (outcome) => {
            void refreshFiles(info.root);
            externalRef.current(info.root, outcome);
          },
        });
        engines.current.set(info.root, engine);

        setSessions((prev) => ({
          ...prev,
          [info.root]: {
            info,
            files,
            state: engine.getState(),
            settings,
            attachmentFolder: vaultSettings.attachmentFolder,
          },
        }));
        setActiveRoot(info.root);
        await engine.start();
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
    setSessions((prev) => {
      const { [root]: _removed, ...rest } = prev;
      return rest;
    });
    setActiveRoot((current) =>
      current === root ? (Object.keys(sessionsRef.current)[0] ?? null) : current,
    );
  }, []);

  // Mirror sessions into a ref so closeVault can pick a replacement without
  // taking a dependency on the sessions object.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const noteSaved = useCallback((root: string) => {
    engines.current.get(root)?.noteChanged();
    void api.listFiles(root).then((files) => {
      setSessions((prev) => (prev[root] ? { ...prev, [root]: { ...prev[root], files } } : prev));
    });
  }, []);

  const syncNow = useCallback(async (root: string) => {
    await engines.current.get(root)?.syncNow();
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

  const updateSettings = useCallback(
    async (root: string, next: Partial<SyncSettings>) => {
      const engine = engines.current.get(root);
      if (!engine) return;
      engine.updateSettings(next);
      const merged = engine.getSettings();
      patch(root, { settings: merged });
      try {
        // Persisted inside the repo, so the choice follows the vault between
        // machines rather than living on this one.
        const folder = sessionsRef.current[root]?.attachmentFolder ?? 'assets';
        await api.writeSettings(
          root,
          serialiseVaultSettings({ sync: merged, attachmentFolder: folder }),
        );
      } catch (e) {
        setError(errorText(e));
      }
    },
    [patch],
  );

  const conflictResolved = useCallback(async (root: string) => {
    await engines.current.get(root)?.conflictResolved();
  }, []);

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
    refreshFiles,
    isPaused: (root: string) => engines.current.get(root)?.isPaused() ?? false,
  };
}

/** Backend errors arrive as `{ code, message }`; show the message. */
export function errorText(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
