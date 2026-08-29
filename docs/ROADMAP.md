# Open Note — Roadmap

> A local-first Markdown notes & todo app that uses **any Git repository as its backend**.
> Desktop first (macOS / Windows / Linux), mobile later. Open source, MIT.

- **Domain:** theopennote.com
- **Status:** Phase 0 — Foundations

---

## 1. Product principles

These are the constraints every design decision is checked against.

1. **The files are the product.** A vault is a normal Git repo full of normal `.md` files.
   Everything must remain readable and editable without Open Note — on github.com, in Vim, in
   another editor. We never invent a storage format when a conventional one exists.
2. **No backend, ever.** There is no Open Note server. Git *is* the sync layer, the history layer
   and the collaboration layer. This is why the app can be free and private by default.
3. **Never silently lose a note.** Automation is aggressive (autosave, autocommit, autopush,
   autofetch) but it is never destructive. No auto-force-push, no auto-conflict-resolution,
   no auto-discard. Trust is the whole product.
4. **Easy by default, powerful on demand.** A user who has never heard of Git should be able to
   write notes. A user who wants branches and pull requests should find them.
5. **Local Git config is the source of truth.** If the user already has SSH keys, credential
   helpers, signing keys and a `.gitconfig`, we use them. We do not re-implement authentication.

---

## 2. Stack

| Layer | Choice | Rationale |
|---|---|---|
| App shell | **Tauri v2** | Single Rust core targets desktop **and** iOS/Android. ~3 MB bundles vs Electron's ~96 MB. Electron cannot reach mobile at all — choosing it would mean a rewrite at Phase 7. |
| Frontend | **React + TypeScript + Vite** | Excalidraw ships as a React component, which pins this choice. |
| Editor | **CodeMirror 6** | Bear's model — real Markdown source, decorated inline — is exactly CM6's decoration system. A WYSIWYG editor (ProseMirror/Lexical/Tiptap) requires a Markdown↔document round-trip that loses fidelity and produces noisy Git diffs. Same reasoning Obsidian used. |
| MD (editor) | `@lezer/markdown` | Incremental parsing while typing. |
| MD (indexing) | `unified` + `remark-gfm` | Batch AST work: outline, todo extraction, wikilinks, backlinks. |
| Monorepo | **pnpm workspaces + Turborepo** | |
| Lint/format | **Biome** | One tool, no ESLint+Prettier config negotiation. |
| Tests | **Vitest** (TS), `cargo test` (Rust) | |
| Website | **Astro + Starlight**, Cloudflare Pages | Docs + download page for theopennote.com. |
| License | **MIT** | See §7. |

---

## 3. Architecture

### 3.1 Repository layout

```
open-note/
├── apps/
│   ├── desktop/            # Tauri v2 app (React frontend + src-tauri)
│   └── site/               # theopennote.com (Phase 6)
├── packages/
│   ├── core/               # Platform-agnostic domain logic. NO Tauri imports.
│   ├── editor/             # CodeMirror 6 Markdown editor + keymap registry
│   ├── ui/                 # Design system, themes, primitives
│   ├── diagrams/           # Mermaid / Excalidraw / DOT renderers
│   └── forge/              # GitHub / GitLab / Bitbucket API clients
├── crates/
│   ├── git-port/           # GitPort trait + SystemGit and LibGit2 adapters
│   └── vault-watch/        # Filesystem watcher + debounce
└── docs/
```

**`packages/core` must never import Tauri.** That boundary is what lets the sync engine be
unit-tested without a window, and what makes Phase 7 (mobile) a port rather than a rewrite.

### 3.2 The Git strategy — shell out to the user's `git`

The single most important architectural decision.

On desktop, Open Note **spawns the system `git` binary** rather than embedding a Git library.
This inherits, for free and correctly:

- credential helpers (macOS Keychain, Windows Credential Manager, `gh auth`, etc.)
- `ssh-agent`, SSH config, deploy keys, 1Password/Secretive agents
- GPG and SSH commit signing
- the user's `.gitconfig` (name, email, aliases, `core.autocrlf`, merge drivers)
- corporate HTTP proxies and custom CA bundles
- `git-lfs`, hooks, sparse checkout

Every embedded-library alternative means reimplementing all of the above, badly. Notably
`gitoxide` still has **push under active development**, which disqualifies it for a sync-heavy
app today.

This is expressed as a Rust trait with two implementations:

```rust
trait GitPort {
    fn status(&self, repo: &Path) -> Result<Status>;
    fn stage_and_commit(&self, repo: &Path, paths: &[PathBuf], msg: &str) -> Result<Oid>;
    fn fetch(&self, repo: &Path, remote: &str) -> Result<FetchOutcome>;
    fn pull_rebase(&self, repo: &Path) -> Result<MergeOutcome>;
    fn push(&self, repo: &Path, remote: &str, branch: &str) -> Result<()>;
    // ... branches, log, diff, resolve
}
```

| Adapter | Used on | Backed by |
|---|---|---|
| `SystemGitAdapter` | Desktop (primary) | `std::process::Command` → `git` |
| `LibGit2Adapter` | Mobile; desktop fallback when `git` is absent | `git2-rs` |

Only `SystemGitAdapter` is implemented before Phase 7 — but the trait exists from Phase 1, because
retrofitting this boundary later is what turns Phase 7 into a rewrite.

### 3.3 The sync engine

Three **independent debounced loops** per repository. Each is separately configurable and
separately killable.

| Loop | Default trigger | Behaviour |
|---|---|---|
| **Write** | 500 ms after last keystroke | Write buffer to disk. Always on; not configurable off. |
| **Commit** | 30 s idle, or 5 min elapsed since last commit | Batch all dirty vault files into one commit. Scoped to the vault; respects `.gitignore`. |
| **Push** | 10 s after a commit | Exponential backoff on failure. **Never `--force`.** |

**Fetch loop:** every 60 s (+ jitter), only while online and the window is focused.

- Upstream commits + clean worktree → fast-forward silently, hot-reload open buffers.
- Upstream commits + dirty worktree → `pull --rebase --autostash`.

**Conflicts are never auto-resolved.** The repo enters a `conflicted` state, the affected files
are badged in the sidebar, and a three-way merge view is offered. Because notes are one file each,
true conflicts are rare — but "rare" is not "never", and one silently clobbered note permanently
destroys trust in the app.

**Commit messages** are generated: `notes: update daily/2026-08-29.md` for one file,
`notes: update 3 notes` for a batch. Configurable template.

**Sync status** is always visible: `idle · dirty · committing · pushing · behind · conflict · offline`.

### 3.4 Vault model

- A **vault is an entire Git repository**. No subfolder scoping.
- **Non-Markdown files are listed but not opened.** Images (`png/jpg/gif/webp/svg`) get a
  read-only preview; everything else shows its name, size and a "open in system editor" action.
  This keeps the tree honest about what's in the repo without turning Open Note into an IDE.
- **Multiple vaults** are open simultaneously, each with independent sync state and settings.
- **Per-vault config lives in `.opennote/` inside the repo** (`settings.json`, `keymap.json`) so
  it travels between machines. Machine-local state (window layout, recent files, cached index)
  stays in the OS app-data dir and is never committed.

### 3.5 Todo format

Base format is **GFM task lists** — nothing else is required:

```markdown
- [ ] Ship the first release
```

Optional trailing tokens add structure, all of which degrade to readable plain text:

```markdown
- [ ] Ship the first release due:2026-09-15 prio:high #work @fatih
```

| Token | Meaning |
|---|---|
| `due:YYYY-MM-DD` | Due date |
| `prio:low\|med\|high` | Priority |
| `#tag` | Tag (shared with note tags) |
| `@name` | Assignee |

The parser is tolerant — unknown tokens are left as text. Rendered as subtle inline chips in the
editor. There is deliberately no proprietary block syntax: a todo written in Open Note must still
render as a checkbox on github.com.

### 3.6 Encryption

Out of scope. The stance is "your repo, your call" — users who need encryption at rest should use
an encrypted volume or a private repo. Documented explicitly rather than left ambiguous.

---

## 4. Diagram formats

Research summary. The selection principle: **prefer formats that degrade gracefully when someone
opens the repo on github.com without Open Note.**

| Format | Storage | Renders on GitHub | Decision |
|---|---|---|---|
| **Mermaid** | ` ```mermaid ` fence, inline in the `.md` | ✅ native (GitHub + GitLab) | **Primary.** The only format where notes stay readable outside the app. |
| **Excalidraw** | `.excalidraw` — plaintext JSON | ❌ | **Secondary.** The only credible freehand/whiteboard-as-text option. Diffs are noisy (every drag rewrites coordinates) but it is genuinely text. Optionally emit a sibling `.svg` on save for web viewability. |
| **Graphviz DOT** | `.dot` or fenced block | ❌ | **Cheap add.** `viz.js` compiles to WASM — no external binary, no Java. Unmatched for dense dependency graphs. |
| **D2** | `.d2` | ❌ | **Deferred.** Best auto-layout (TALA) for architecture diagrams, but requires bundling a Go binary. Revisit on demand. |
| **PlantUML** | `.puml` | ❌ | **Rejected.** Requires a JVM or a remote render server. Both are unacceptable for an offline local-first app. |
| **SVG** | `.svg` | ✅ | Supported as an embed target, free. |

Order of implementation: Mermaid → Excalidraw → DOT → (maybe) D2.

---

## 5. Phases

Each phase ends with something usable. Phase 1 is the version we dogfood daily; every later phase
is earned by actually using the previous one.

### Phase 0 — Foundations
*Goal: `pnpm dev` opens a Tauri window, and CI is green on three operating systems.*

- [x] pnpm + Turborepo monorepo, shared TS config, Biome, Vitest
- [x] `apps/desktop` — Tauri v2 + React + Vite frontend; `pnpm build:web` green
- [x] `crates/git-port` — `GitPort` trait, `SystemGit` adapter (discovery implemented, rest stubbed)
- [x] App icon set generated for desktop, iOS and Android (placeholder mark — replace before Phase 6)
- [x] MIT `LICENSE`, `README.md`, `CONTRIBUTING.md`, PR template, conventional commits
- [x] CI workflow: lint, typecheck, test, `cargo fmt`/`clippy`/`test`, bundle on macOS + Windows + Linux
- [x] Nightly workflow producing unsigned artifacts for dogfooding
- [x] Rust workspace compiles; `cargo fmt`, `clippy -D warnings` and `cargo test` all clean
- [x] `pnpm desktop:dev` opens the app; webview↔Rust IPC verified end to end
- [x] `pnpm desktop:build` produces a 9.4 MB `.app` and a valid 2.6 MB `.dmg`
- [ ] First green CI run once the repo has a remote

### Phase 1 — MVP: edit a local repo  (~3–4 weeks)
*Goal: replace whatever you currently take notes in.*

- Open an existing local Git repo as a vault; remember recent vaults
- File tree: Markdown files openable; other files listed, images previewable
- CodeMirror 6 editor with Bear-style inline Markdown decoration
- Autosave to disk (write loop only)
- A single manual **Sync** button: `commit → pull --rebase → push`
- `SystemGitAdapter` fully implemented behind `GitPort`
- Light/dark themes, basic settings screen
- Single vault only

### Phase 2 — The sync engine  (~3 weeks)
*Goal: never think about Git again.*

- Commit loop + push loop with backoff
- Periodic fetch, auto fast-forward, hot-reload of open buffers
- Conflict detection, `conflicted` repo state, three-way merge UI
- Sync status indicator; per-vault sync settings; global kill switch
- Multi-vault support with independent sync state
- `.opennote/settings.json` read/write

### Phase 3 — A real notes app  (~4 weeks)
*Goal: it is nice to use.*

- Command palette
- Configurable keymap (`.opennote/keymap.json`) with preset schemes: Default / Bear / Vim
- Full-text search — MiniSearch in-memory, migrating to SQLite FTS5 for large vaults
- Tags, `[[wikilinks]]`, backlinks panel, quick switcher
- YAML frontmatter support
- Todo view aggregating tasks across the vault (§3.5)
- Daily notes

### Phase 4 — Diagrams  (~2 weeks)
- Mermaid rendering with live preview
- Excalidraw embed + in-app editing
- Graphviz DOT via `viz.js` (WASM)

### Phase 5 — Advanced Git  (~3 weeks)
*Goal: the power users arrive.*

- Branch create / switch / merge
- Per-note history timeline and diff view
- Pull request creation via `packages/forge` — provider detected from the remote URL,
  OAuth device flow, GitHub / GitLab / Bitbucket REST
- Clone-from-remote onboarding (no local repo required)
- Stash, revert-file, discard-changes

### Phase 6 — Ship properly  (~2 weeks)
- macOS: Developer ID signing + notarization
- Windows: Azure Trusted Signing
- Linux: AppImage, `.deb`, `.rpm`, Flathub
- Tauri updater plugin against GitHub Releases
- theopennote.com — download page with OS detection, docs, screenshots

### Phase 7 — Mobile
- Implement `LibGit2Adapter`; swap it in on mobile targets
- Mobile UI shell reusing `packages/core` and `packages/editor`
- OS keychain token storage
- Handle background-execution limits in the sync engine
- App Store / Play Store submission

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Code signing is a recurring cost** — Apple Developer Program $99/yr, Azure Trusted Signing ~$10/mo | Unsigned binaries are blocked by Gatekeeper and SmartScreen. For a "download from our website" model this is fatal, not cosmetic. | Budget it before Phase 6. Ship unsigned nightlies to early adopters meanwhile. |
| **WebKitGTK is Tauri's weakest webview** — IME and text-rendering quirks hit text editors hardest | Linux users get a bad editing experience | Test on Linux from Phase 1, not Phase 6. |
| **Mobile Git is a different problem, not a port** — no shell, no credential helpers, background-execution limits | Phase 7 slips badly | `GitPort` contains it; budget real time rather than assuming reuse. |
| **Excalidraw JSON diffs are noisy** | `git log` gets ugly in drawing-heavy vaults | Accepted. Document it. Consider pretty-printing JSON to improve line-level diffs. |
| **Aggressive autopush on a shared repo** | Users push half-finished thoughts to a team repo | Autopush is on by default (per product decision) but per-vault; make the status indicator unmissable and the kill switch one click away. |

---

## 7. License — why MIT

The decisive factor is Phase 7. **GPL and AGPL terms conflict with the Apple App Store's
distribution terms** (the well-documented VLC removal). Choosing a copyleft license would block
the mobile distribution path this project explicitly plans for.

MIT additionally lets `packages/editor` be reused independently, which is the most likely route to
outside contributors.

---

## 8. Conventions

- **Commits:** Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **Branches:** `feat/<short-desc>`, `fix/<short-desc>`
- **Node:** 22+ · **pnpm:** 10+ · **Rust:** stable
