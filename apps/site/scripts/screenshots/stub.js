/**
 * A fake Tauri IPC, so the desktop UI can be driven in a plain browser.
 *
 * This exists to photograph the app for the website. The alternative — capturing
 * a real vault — would mean either publishing someone's actual notes or keeping
 * a hand-curated repository in sync with every screenshot, so the sample content
 * lives here instead, in one file, next to the script that uses it.
 *
 * `?shot=<name>` drives the app into the state a given screenshot needs and then
 * marks the document ready, which is the signal the capture script waits for.
 */
(() => {
  // Never hijack the real Tauri window: it injects this before page scripts.
  if (window.__TAURI_INTERNALS__) return;

  const ROOT = '/Users/you/notes';
  // Fixed, so the same commit always produces the same screenshots.
  const NOW = Math.floor(new Date('2026-08-31T09:00:00Z').getTime() / 1000);

  const files = new Map();
  const folders = new Set(['Archive']);
  const put = (path, contents, ago = 0) => files.set(path, { contents, modified: NOW - ago });

  put(
    'Welcome.md',
    `# Welcome

Your notes are ordinary Markdown files in a Git repository you own.

- Link notes with [[Projects/Open Note]]
- Tag them with #inbox or #idea

## Things to try

- [x] Open a vault
- [ ] Write a note
- [ ] Sync it somewhere
`,
    100,
  );

  put(
    'Projects/Open Note.md',
    `# Open Note

#idea #project

A local-first Markdown app backed by Git. Related: [[Reading/Books]].

## Goals

- Never lose a note
- No backend, ever
- The files stay readable without the app

## Tasks

- [x] Ship the editor
- [ ] Write the docs @sam !high ~2026-09-14
- [ ] Record a demo
`,
    300,
  );

  put(
    'Projects/Architecture.md',
    `# Architecture

#project

Every Git call goes through one port, so mobile is a port rather than a rewrite.

\`\`\`mermaid
flowchart LR
  Edit["You type"] --> Write["Write to disk"]
  Write --> Commit["Commit"]
  Commit --> Push["Push"]
  Fetch["Fetch remote"] --> Q{"Conflict?"}
  Q -->|no| Write
  Q -->|yes| Stop["Stop and ask"]
\`\`\`

The sync engine never resolves a conflict on your behalf.
`,
    250,
  );

  put('Inbox.md', '# Inbox\n\n#inbox\n\n- [ ] Buy milk\n- [ ] Call the dentist\n', 200);
  put(
    'Reading/Books.md',
    '# Books\n\n#reading\n\n- Thinking in Systems\n- The Timeless Way of Building\n',
    5000,
  );
  put('Reading/Articles.md', '# Articles\n\n#reading\n', 8000);
  put(
    'daily/2026-08-31.md',
    '# 2026-08-31\n\n## Notes\n\nStarted on [[Projects/Open Note]].\n\n## Tasks\n\n- [ ] Review the pull requests\n',
    60,
  );
  put('daily/2026-08-30.md', '# 2026-08-30\n\nWrote up [[Projects/Architecture]].\n', 90000);
  put(
    'Meetings/2026-08-28 Standup.md',
    '# Standup\n\n#meeting\n\n- [ ] Follow up with Sam\n',
    200000,
  );
  put(
    'Meetings/Retro.md',
    '# Retro\n\n<<<<<<< ours\n- [ ] Call the dentist on Tuesday\n=======\n- [ ] Call the dentist on Thursday\n>>>>>>> theirs\n',
    100,
  );
  put(
    'scripts/build.ts',
    `import { join } from 'node:path';

/** Build one target and report how long it took. */
export async function build(target: string): Promise<number> {
  const out = join('dist', target);
  const started = Date.now();
  await bundle(out, { minify: true, sourcemap: false });
  return Date.now() - started;
}
`,
    300000,
  );
  put('assets/diagram.png', '', 400000);
  put('.opennote/settings.json', '{}', 400000);
  put('README.md', '# notes\n\nMy vault.\n', 1000000);

  const BINARY = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'zip'];
  const kindOf = (p) => {
    if (/\.(md|markdown)$/i.test(p)) return 'markdown';
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(p)) return 'image';
    if (p.endsWith('.excalidraw')) return 'drawing';
    const ext = (p.split('.').pop() || '').toLowerCase();
    return BINARY.includes(ext) ? 'other' : 'text';
  };

  const hidden = (p) => p === '.opennote' || p.startsWith('.opennote/');

  function list() {
    const out = [];
    const dirs = new Set(folders);
    for (const [path, file] of files) {
      if (hidden(path)) continue;
      out.push({
        path,
        name: path.split('/').pop(),
        kind: kindOf(path),
        size: file.contents.length,
        modified: file.modified,
      });
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const dir of dirs) {
      if (hidden(dir)) continue;
      out.push({ path: dir, name: dir.split('/').pop(), kind: 'folder', size: 0, modified: 0 });
    }
    return out;
  }

  const status = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: [] };
  let settings = null;
  let keymap = null;

  const commands = {
    git_probe: () => 'git version 2.50.1',
    pick_vault: () => ROOT,
    open_vault: () => ({ root: ROOT, name: 'notes', branch: 'main', upstream: 'origin/main' }),
    recent_vaults: () => [ROOT],
    forget_vault: () => null,
    list_vault_files: () => list(),
    read_note: (a) => {
      const file = files.get(a.path);
      if (!file) throw new Error(`no such note: ${a.path}`);
      return file.contents;
    },
    write_note: (a) => (put(a.path, a.contents), null),
    create_note: (a) => (put(a.path, a.contents), null),
    create_folder: (a) => (folders.add(a.path), null),
    rename_entry: (a) => {
      const file = files.get(a.from);
      files.delete(a.from);
      put(a.to, file ? file.contents : '');
      return null;
    },
    delete_entry: (a) => (files.delete(a.path), null),
    is_tracked: () => true,
    read_image: () =>
      `data:image/svg+xml;base64,${btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#e2ded7"/></svg>',
      )}`,
    read_drawing: () => '{"type":"excalidraw","version":2,"elements":[],"appState":{}}',
    write_drawing: () => null,
    vault_status: () => status,
    sync_vault: () => ({ committed: false, pulled: null, pushed: false, blocked: null, status }),
    vault_commit: () => 'abc1234',
    vault_fetch: () => ({ newCommits: 0 }),
    vault_pull_rebase: () => ({ kind: 'alreadyUpToDate' }),
    vault_push: () => null,
    resolve_conflict: () => null,
    stage_resolution: () => null,
    rebase_continue: () => ({ kind: 'alreadyUpToDate' }),
    rebase_abort: () => null,
    rebase_in_progress: () => true,
    read_raw: (a) => files.get(a.path)?.contents ?? '',
    pick_export_path: (a) => `/Users/you/Desktop/${a.suggested}`,
    write_export: () => null,
    write_attachment: (a) => {
      const path = `${a.folder ? `${a.folder}/` : ''}pasted.${a.extension}`;
      put(path, '');
      return path;
    },
    read_all_notes: () =>
      [...files.entries()]
        .filter(([path]) => path.endsWith('.md') && !hidden(path))
        .map(([path, file]) => ({ path, content: file.contents })),
    read_vault_keymap: () => keymap,
    write_vault_keymap: (a) => ((keymap = a.json), null),
    read_vault_settings: () => settings,
    write_vault_settings: (a) => ((settings = a.json), null),
    list_branches: () => [
      { name: 'main', isCurrent: true, upstream: 'origin/main', isRemote: false },
      { name: 'reorganise', isCurrent: false, upstream: null, isRemote: false },
      { name: 'origin/main', isCurrent: false, upstream: null, isRemote: true },
    ],
    create_branch: () => null,
    switch_branch: () => null,
    merge_branch: () => ({ kind: 'alreadyUpToDate' }),
    delete_branch: () => null,
    note_history: () => [
      {
        id: 'a'.repeat(40),
        shortId: '9f3c1ab',
        author: 'You',
        date: '2026-08-30T10:04:00Z',
        subject: 'notes: update Projects/Open Note.md',
      },
      {
        id: 'b'.repeat(40),
        shortId: '2c81de4',
        author: 'You',
        date: '2026-08-28T16:20:00Z',
        subject: 'notes: update 3 notes',
      },
      {
        id: 'c'.repeat(40),
        shortId: 'ba09f77',
        author: 'You',
        date: '2026-08-27T09:11:00Z',
        subject: 'notes: update Projects/Open Note.md',
      },
    ],
    note_at_commit: () => '# Open Note\n\nAn earlier draft.\n',
    note_diff: () =>
      '@@ -1,6 +1,8 @@\n # Open Note\n \n-A local-first markdown app.\n+A local-first Markdown app backed by Git.\n+\n+Related: [[Reading/Books]].\n',
    discard_note_changes: () => null,
    restore_note: () => null,
    remote_url: () => 'git@github.com:you/notes.git',
    pick_folder: () => '/Users/you',
    clone_vault: () => ({ root: ROOT, name: 'notes', branch: 'main', upstream: 'origin/main' }),
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => cb,
    invoke: async (cmd, args) => {
      const handler = commands[cmd];
      if (!handler) {
        if (cmd.startsWith('plugin:')) return null;
        console.warn('[shot-stub] unhandled command', cmd);
        return null;
      }
      return handler(args || {});
    },
  };

  // ---- Driving the app into each screenshot's state ------------------------

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const find = (selector, text) =>
    [...document.querySelectorAll(selector)].find((el) => el.textContent.includes(text));

  async function openNote(name) {
    const row = find('.tree-file', name);
    if (!row) throw new Error(`no tree row for ${name}`);
    row.click();
    await wait(600);
  }

  /**
   * Put the caret on the last line, so line one is not showing its `#`.
   *
   * Real coordinates matter: a MouseEvent with no clientX/clientY lands at 0,0,
   * which CodeMirror reads as "select the first line".
   */
  async function parkCaret() {
    const lines = [...document.querySelectorAll('.cm-line')];
    const target = lines[lines.length - 1] ?? lines[0];
    if (!target) return;
    const box = target.getBoundingClientRect();
    const at = { clientX: box.left + 2, clientY: box.top + box.height / 2, bubbles: true };
    target.dispatchEvent(new MouseEvent('mousedown', at));
    target.dispatchEvent(new MouseEvent('mouseup', at));
    await wait(250);
  }

  const isMac = /mac/i.test(navigator.platform || navigator.userAgent);

  /** Fire a shortcut the way the app's own key dispatcher expects to see it. */
  function press(key, extra = {}) {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        [isMac ? 'metaKey' : 'ctrlKey']: true,
        ...extra,
      }),
    );
  }

  const shots = {
    async editor() {
      await openNote('Open Note');
      await parkCaret();
    },
    async tasks() {
      find('.actions button', 'Tasks')?.click();
      await wait(500);
    },
    async diagram() {
      await openNote('Architecture');
      await parkCaret();
      // Mermaid renders asynchronously.
      await wait(1800);
    },
    async conflict() {
      // Nothing to do: the change is seeded before the app boots, below.
      await wait(500);
    },
    async sync() {
      await openNote('Open Note');
      find('.actions button[aria-label="Settings"]')?.click();
      document.querySelector('.actions button[aria-label="Settings"]')?.click();
      await wait(500);
    },
    async links() {
      await openNote('Open Note');
      await parkCaret();
      press('A', { shiftKey: true });
      await wait(700);
    },
    async history() {
      await openNote('Open Note');
      await parkCaret();
      find('.note-actions button', 'History')?.click();
      await wait(900);
    },
    async palette() {
      await openNote('Open Note');
      await parkCaret();
      press('P', { shiftKey: true });
      await wait(700);
    },
    async code() {
      await openNote('build.ts');
      await wait(1200);
    },
  };

  const requested = new URLSearchParams(location.search).get('shot');

  // Seeded before the app boots: the sync engine enters the conflict phase when
  // it reads a status with unmerged paths, and the first read happens on open.
  if (requested === 'conflict') {
    status.changes = [{ path: 'Meetings/Retro.md', state: 'conflicted' }];
  }
  if (requested) {
    void (async () => {
      // Give the app time to boot and open its vault.
      await wait(2000);
      try {
        await (shots[requested] ?? shots.editor)();
      } catch (error) {
        console.error('[shot-stub]', error);
      }
      await wait(400);
      document.documentElement.setAttribute('data-shot-ready', requested);
    })();
  }
})();
