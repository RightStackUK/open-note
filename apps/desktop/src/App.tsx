import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/**
 * Phase 0 placeholder shell.
 *
 * Its only job is to prove the frontend can reach the Rust core: it calls the
 * `git_probe` command, which reports whether a usable system `git` binary is
 * available. Phase 1 replaces this entirely with the vault window.
 */
export function App() {
  const [git, setGit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string | null>('git_probe')
      .then((version) => setGit(version ?? 'not found'))
      .catch((err: unknown) => setError(String(err)));
  }, []);

  return (
    <main className="shell">
      <h1>Open Note</h1>
      <p className="tagline">Markdown notes, backed by Git.</p>

      <dl className="status">
        <dt>Phase</dt>
        <dd>0 — Foundations</dd>
        <dt>System git</dt>
        <dd>{error ?? git ?? 'checking…'}</dd>
      </dl>
    </main>
  );
}
