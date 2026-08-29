# Contributing to Open Note

Thanks for considering a contribution. This document covers the practical bits; the design
reasoning lives in [docs/ROADMAP.md](docs/ROADMAP.md).

## Prerequisites

| Tool | Version |
|---|---|
| Node | 22+ |
| pnpm | 10+ |
| Rust | stable (via [rustup](https://rustup.rs)) |

Tauri also needs platform build dependencies — see the
[Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

## Getting started

```bash
pnpm install
pnpm desktop:dev
```

## Project layout

```
apps/desktop/       Tauri v2 app — React frontend in src/, Rust in src-tauri/
apps/site/          theopennote.com (Phase 6)
packages/core/      Platform-agnostic domain logic. Must not import Tauri.
packages/editor/    CodeMirror 6 Markdown editor
packages/ui/        Design system
packages/diagrams/  Mermaid / Excalidraw / DOT renderers
packages/forge/     GitHub / GitLab / Bitbucket API clients
crates/git-port/    GitPort trait and its adapters
crates/vault-watch/ Filesystem watcher
```

### Two rules that matter

1. **`packages/core` must not import Tauri.** Keeping the domain layer platform-agnostic is what
   makes the sync engine unit-testable and what makes mobile a port rather than a rewrite.
2. **All Git access goes through the `GitPort` trait.** Never call `git` directly from a Tauri
   command. The trait is the seam that lets mobile swap in a different implementation.

## Conventions

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-note history timeline
fix: debounce the commit loop correctly on rapid edits
chore: bump tauri to 2.10
docs: clarify the conflict resolution flow
```

**Branches:** `feat/<short-desc>` or `fix/<short-desc>`.

## Before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

CI runs the same checks on macOS, Windows and Linux.

## Reporting bugs

Include your OS, app version, `git --version`, and — if it is a sync issue — the sync status
shown in the app and whether the vault was in a conflicted state. Please don't paste note
contents; a redacted `git status` is usually enough.
