# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Open Note is a local-first Markdown notes and todo app that uses **any Git repository as its
backend**. There is no server. Desktop (Tauri v2) now; mobile later.

Design reasoning lives in [docs/ROADMAP.md](docs/ROADMAP.md); the current work plan is
[docs/PLAN-STABILISATION.md](docs/PLAN-STABILISATION.md). Read the roadmap's §3 before changing
architecture — most of the non-obvious decisions are recorded there with their rationale.

## Commands

Requires Node 22+, pnpm 10+, and a stable Rust toolchain (`. "$HOME/.cargo/env"` if cargo is not
on PATH).

```bash
pnpm install
pnpm desktop:dev        # run the app
pnpm lint               # biome check (add --write via pnpm lint:fix)
pnpm typecheck          # tsc across the workspace
pnpm test               # vitest across the workspace
```

Rust lives in a Cargo workspace at the repo root (`crates/*` plus `apps/desktop/src-tauri`):

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
```

Running a single test:

```bash
# One TypeScript file, or one test by name
pnpm --filter @open-note/core exec vitest run src/notes/parse.test.ts
pnpm --filter @open-note/editor exec vitest run -t 'unwraps when already bold'

# One Rust test, or one crate
cargo test -p git-port status_reports_branch_and_untracked_files
cargo test -p open-note-desktop
```

CI runs exactly the six checks above. Run them all before committing.

### macOS: `pnpm desktop:build` fails at the DMG step

`bundle_dmg.sh` drives Finder over AppleScript. Without Finder automation permission it times out
(`-1712`) *after* the `.app` has built fine. Use `CI=true pnpm desktop:build` to skip the cosmetic
step. See [docs/RELEASING.md](docs/RELEASING.md).

### Verifying UI changes

The Tauri window cannot be driven programmatically here. The pattern that works: temporarily inject
a `window.__TAURI_INTERNALS__` stub into `apps/desktop/index.html`, run `pnpm --filter
@open-note/desktop dev:web`, and drive it in a browser — then **revert the stub**. For the real
IPC, temporarily `eprintln!` in the Rust command and read the `tauri dev` output.

## Architecture

### All Git access goes through `GitPort`

`crates/git-port` defines the trait; `SystemGit` implements it by **spawning the user's own `git`
binary**. That is deliberate: it inherits credential helpers, `ssh-agent`, commit signing, proxies
and `git-lfs` for free, none of which an embedded library would give without reimplementation. A
second `LibGit2Adapter` is planned for mobile, where there is no shell.

Never call `git` directly from a Tauri command — add a trait method instead. Errors are
**classified** (`NothingToCommit`, `PushRejected`, `Offline`, `NoUpstream`, `Conflicted`) because
the sync engine reacts differently to each; the frontend branches on a stable `code` string, never
on message text.

### The sync engine is TypeScript, in `packages/core`

`packages/core` must **never import Tauri**. That boundary is what makes the engine unit-testable
without a window and mobile a port rather than a rewrite. `VaultSync` runs three independent
debounced loops (commit, push, fetch) against an injected `SyncPort`, so tests drive it with a fake
git and fake timers.

Two invariants it enforces, both tested — do not weaken either:

1. **It never resolves a conflict.** On conflict it halts all automation and waits for the user, and
   refuses to believe a claimed resolution if git still reports unmerged paths.
2. **It never runs two git operations at once.** Git's index lock makes overlapping commands fail
   confusingly, so everything is serialised through a promise queue.

Cross-*process* contention is a known gap: two app copies, or the app plus a terminal, on one vault
will contend for the index lock.

### Commands and keybindings: one dispatcher

`COMMANDS` in `packages/core/src/commands/registry.ts` is the single source of truth — the palette
lists it, the keymap binds it, the settings UI edits it. `useCommandKeys` listens on `window` in the
**capture phase**, so it beats CodeMirror's own keymap; editing commands therefore live in
`packages/editor/src/commands.ts` and are reached through `NoteEditorHandle.runCommand`, *not*
registered in a CodeMirror keymap. Two dispatchers would race.

Ten commands once shipped declared, bound and listed while doing nothing.
`apps/desktop/src/commandCoverage.test.ts` exists to stop that recurring — any new command needs an
app handler or an editor implementation.

### Editor conventions (`packages/editor`)

The editor is CodeMirror 6 over **real Markdown source**, decorated inline — not a WYSIWYG
round-trip, which would lose fidelity and produce noisy Git diffs.

One rule runs through every extension: **the line the cursor is on is being edited; every other line
is being read.** Syntax markers are concealed off the active line, wikilinks are clickable off it,
and diagram blocks render off it. Follow that when adding decorations.

Block decorations must come from a `StateField`, not a `ViewPlugin` — CodeMirror rejects them
otherwise (see `diagrams.ts`).

### Paths from the webview are untrusted

Every path crossing the IPC goes through `vault::resolve_within`, which rejects absolute paths and
`..`, and canonicalises to catch symlink escapes. Destructive operations additionally go through
`reject_protected`, which refuses the vault root and anything under `.git` — deleting is recursive,
so either would be catastrophic.

### Settings live in the repo

Per-vault settings are `.opennote/settings.json` and `.opennote/keymap.json`, so they travel with
the vault between machines. Both are hand-editable, so parsing **degrades field by field** to
defaults rather than failing. Machine-local state (recent vaults) goes in the OS config dir and is
never committed.

### Rendered SVG is sanitised

A vault can be cloned from anywhere, so `packages/diagrams` strips scripts, event handlers,
`javascript:` URLs and `foreignObject` before any rendered SVG reaches the DOM. Mermaid is
configured with `htmlLabels: false` because it otherwise draws labels inside `foreignObject`, which
sanitisation removes — silently blanking every label.

## Conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). A Jira ticket number goes
  at the end of the first line when one exists.
- **Releases:** tag `vX.Y.Z` on `main`; CI builds and publishes. Pre-release tags get no `.msi`
  (Windows Installer cannot express a non-numeric pre-release identifier).
- Biome reformats and reorders imports on `--write`, which breaks scripted string edits against
  import blocks. Prefer editing by line position, or re-read the file after formatting.
