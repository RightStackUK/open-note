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

**Implementation note.** Mermaid is configured with `htmlLabels: false`. Its default
is to draw labels as HTML inside a `<foreignObject>`, which the SVG sanitiser strips
as an XSS vector — silently erasing every label in the diagram. It also has
`suppressErrorRendering: true`, because on a parse failure it otherwise appends a
large error graphic to `document.body`, outside the editor entirely.
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
- [x] Green CI on macOS, Windows and Linux

### Phase 1 — MVP: edit a local repo
*Goal: replace whatever you currently take notes in.*

- [x] Open an existing local Git repo as a vault; recent vaults remembered and
      the last one reopened on launch
- [x] File tree: Markdown files openable; other files listed but inert; images previewable
- [x] CodeMirror 6 editor with Bear-style syntax concealment
- [x] Autosave to disk (write loop only, 500 ms idle)
- [x] A single manual **Sync** button: `commit → pull --rebase → push`
- [x] `SystemGit` fully implemented behind `GitPort`
- [x] Light/dark themes
- [x] Single vault only
- [ ] Settings screen — deferred to Phase 2, where the sync controls it would
      contain actually exist

### Phase 2 — The sync engine
*Goal: never think about Git again.*

- [x] Commit loop (idle + max-wait ceiling) and push loop with exponential backoff
- [x] Periodic fetch with jitter, automatic rebase, hot-reload of the open buffer
- [x] Conflict detection and a `conflict` phase that halts all automation
- [x] Conflict resolution UI: keep mine / keep theirs / edit by hand, then continue
      or abort the rebase
- [x] Sync status indicator covering every phase; per-vault settings; global pause
- [x] Multi-vault support, one engine per vault with independent state
- [x] `.opennote/settings.json` read/write, degrading to defaults field by field
- [x] Commits left unpushed by a previous session are published on next launch

### Phase 3 — A real notes app
*Goal: it is nice to use.*

- [x] Command palette, quick switcher and full-text search sharing one overlay
- [x] Configurable keymap in `.opennote/keymap.json`, with a settings panel that
      records a real key press rather than asking for a binding string
- [x] Preset schemes: Default and Bear. Conflict detection, tested to ensure
      neither shipped scheme has a clash
- [x] Full-text search over titles, body and tags (MiniSearch, in memory)
- [x] Tags, `[[wikilinks]]` that are clickable and create the note when missing,
      backlinks panel
- [x] YAML frontmatter, degrading to an empty header when malformed
- [x] Task view across the whole vault, sorted by state, due date then priority
- [x] Daily notes
- [ ] **Vim mode deferred.** Vim is modal editing, not a keymap — it needs a
      CodeMirror editing mode (`@replit/codemirror-vim`), which belongs with the
      editor rather than with shortcut configuration. Tracked for a later phase.
- [ ] SQLite FTS5 migration, once vaults outgrow an in-memory index

### Phase 4 — Diagrams
- [x] Mermaid rendered in place, replacing the fenced block unless the cursor is
      inside it
- [x] Graphviz DOT via `viz.js` (WASM) — no external binary, no JVM
- [x] Excalidraw: `.excalidraw` files open in an in-app canvas and save back as
      pretty-printed JSON
- [x] Rendered SVG is sanitised before it reaches the DOM, since a vault can be
      cloned from anywhere
- [ ] D2 — still deferred; needs a bundled Go binary. Revisit on demand
- [ ] Embedding a drawing inside a note (`![[sketch.excalidraw]]`)

### Phase 5 — Advanced Git
*Goal: the power users arrive.*

- [x] Branch create / switch / merge / delete. Switching never force-discards, and
      merging reports conflicts rather than resolving them
- [x] Per-note history timeline with a coloured diff per commit
- [x] Restore an older version as a reviewable working-tree change, and discard
      uncommitted changes to one note
- [x] Clone-from-remote onboarding, using the user's own git setup
- [x] Remote parsing for GitHub / GitLab / Bitbucket, including nested GitLab
      groups and self-hosted installs
- [x] Pull requests: open the forge's own "new pull request" page in the browser

**Pull requests deliberately do not use the REST APIs.** Posting a PR through an
API needs an OAuth app registered per provider (a client ID this project does not
yet have) or a token pasted by the user and then stored. Opening the forge's own
compare page needs neither, works on self-hosted installs, and leaves the user
reviewing the change on the site that will host it. Revisit if PR *listing* inside
the app is ever wanted — that genuinely does need the API.

**Stash was dropped rather than deferred.** With autosave and autocommit, a vault
is rarely sitting on uncommitted work worth stashing, and the app's answer to "put
this aside for a moment" is a branch. Adding a second, subtly different mechanism
would be a worse product, not a more complete one.

### Phase 6 — Ship properly
- [x] Tag-triggered releases: pushing `vX.Y.Z` on `main` builds all three
      platforms and publishes a GitHub Release with the installers attached.
      See [RELEASING.md](RELEASING.md)
- [x] macOS ships as a single universal binary, so nobody has to know whether
      their Mac is Intel or Apple silicon
- [x] Linux: AppImage, `.deb`, `.rpm`
- [ ] macOS Developer ID signing and notarisation — [#1](https://github.com/RightStackUK/open-note/issues/1)
- [ ] Windows signing — [#2](https://github.com/RightStackUK/open-note/issues/2)
- [ ] theopennote.com — [#3](https://github.com/RightStackUK/open-note/issues/3)
- [ ] Tauri updater plugin against GitHub Releases. Deliberately after signing:
      an updater that installs unsigned binaries is a worse problem than having
      no updater
- [ ] Flathub

### Stabilisation — before mobile

An audit after Phase 5 found ten editor commands that were declared, bound and
listed in the palette but did nothing, along with several table-stakes gaps: no
folder creation, no rename, no delete, and a tag index with no view on top of it.

Mobile waits until those are closed — porting an app with no delete button to a
second platform is the wrong order.

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
