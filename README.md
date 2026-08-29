<h1 align="center">Open Note</h1>

<p align="center">
  A local-first Markdown notes and todo app that uses <b>any Git repository as its backend</b>.
  <br />
  <a href="https://theopennote.com">theopennote.com</a>
</p>

---

> **Status: Phase 0 — Foundations.** Not yet usable. See the [roadmap](docs/ROADMAP.md).

## What it is

Open Note stores your notes as plain `.md` files in a Git repository you own. There is no Open
Note server and no account to create — Git is the sync layer, the history layer and the backup
layer. Connect a repo from GitHub, GitLab, Bitbucket, a self-hosted forge, or anywhere else that
speaks Git.

- **Your files stay yours.** Ordinary Markdown in an ordinary repo. Open it in Vim, on github.com,
  or in any other editor. Nothing is locked in.
- **Sync happens by itself.** Autosave, autocommit, autopush and periodic fetch are on by default —
  and every one of them is configurable or switchable off.
- **Git when you want it.** Branches, per-note history, diffs and pull requests are there when you
  need them, and invisible when you don't.
- **Multiple repos at once.** Work notes and personal notes, side by side, syncing independently.
- **Diagrams as text.** Mermaid, Excalidraw and Graphviz — all stored as plaintext, all diffable.

## Principles

1. **The files are the product.** Notes must remain readable and editable without Open Note.
2. **No backend, ever.** Git is the only sync layer.
3. **Never silently lose a note.** Automation is aggressive but never destructive.
4. **Easy by default, powerful on demand.**
5. **Your local Git config is the source of truth** — SSH keys, credential helpers and signing
   keys all work exactly as they already do.

## Development

Requires **Node 22+**, **pnpm 10+** and a **stable Rust toolchain**.

```bash
pnpm install
pnpm desktop:dev
```

Other tasks:

```bash
pnpm lint          # Biome check
pnpm typecheck     # tsc across the workspace
pnpm test          # Vitest
pnpm desktop:build # Bundle the desktop app
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](docs/ROADMAP.md).

## License

[MIT](LICENSE)
