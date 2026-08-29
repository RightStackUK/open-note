import {
  type KeymapConfig,
  parseKeymapConfig,
  resolveKeymap,
  serialiseKeymapConfig,
  VaultIndex,
} from '@open-note/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api';

/**
 * Keeps a search index in step with a vault.
 *
 * The index is rebuilt in bulk on open and patched per note afterwards: a full
 * reindex on every keystroke would be wasteful, and a stale index makes search
 * quietly wrong, which is worse than slow.
 */
export function useVaultIndex(root: string | null) {
  const index = useRef(new VaultIndex());
  // Bumped whenever the index changes, so consumers recompute.
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [keymapConfig, setKeymapConfig] = useState<KeymapConfig>({
    scheme: 'default',
    bindings: {},
  });

  const rebuild = useCallback(async (vaultRoot: string) => {
    setLoading(true);
    try {
      const notes = await api.readAllNotes(vaultRoot);
      index.current.clear();
      for (const note of notes) index.current.put(note.path, note.content);
      setRevision((r) => r + 1);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!root) {
      index.current.clear();
      setRevision((r) => r + 1);
      return;
    }
    void rebuild(root);
    void api
      .readKeymap(root)
      .then((raw) => setKeymapConfig(parseKeymapConfig(raw)))
      .catch(() => setKeymapConfig({ scheme: 'default', bindings: {} }));
  }, [root, rebuild]);

  /** Patch a single note after a save, without touching the rest. */
  const updateNote = useCallback((path: string, content: string) => {
    index.current.put(path, content);
    setRevision((r) => r + 1);
  }, []);

  const removeNote = useCallback((path: string) => {
    index.current.remove(path);
    setRevision((r) => r + 1);
  }, []);

  const keymap = useMemo(() => resolveKeymap(keymapConfig), [keymapConfig]);

  /** Apply a keymap change and persist it into the vault. */
  const updateKeymap = useCallback(
    (next: KeymapConfig) => {
      setKeymapConfig(next);
      if (!root) return;
      void api.writeKeymap(root, serialiseKeymapConfig(next)).catch(() => {
        // A failed write is not worth blocking the UI; the change still applies
        // for this session and the sync engine will surface repo problems.
      });
    },
    [root],
  );

  return {
    index: index.current,
    revision,
    loading,
    rebuild,
    updateNote,
    removeNote,
    keymap,
    keymapConfig,
    updateKeymap,
  };
}
