# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Open Note is a local-first Markdown notes and todo app that uses **any Git repository as its
backend**. There is no server. Desktop (Tauri v2) now; mobile later.

Design reasoning lives in [docs/ROADMAP.md](docs/ROADMAP.md). Read its §3 before changing
architecture — most of the non-obvious decisions are recorded there with their rationale.

## Commands

Requires Node 24+, pnpm 10+, and a stable Rust toolchain (`. "$HOME/.cargo/env"` if cargo is not
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

The application menu (`apps/desktop/src-tauri/src/menu.rs`) is the third surface and does **nothing
in Rust**: each item emits one `menu://command` event and `App.tsx` runs the registry handler, so
the menu is not a second dispatcher. Two consequences worth knowing. Setting a menu *replaces* the
platform default wholesale, so Quit, Hide, Edit's Cut/Copy/Paste and the rest are re-declared there
— dropping one is silent. And File → Open Recent is **rebuilt from the recent list on every change**
rather than built once at startup: `lib.rs`'s `recents()` is the only path that reads the list, and
every command that changes it ends there. A submenu built at setup is wrong by the second vault
opened and goes on offering vaults that have since been deleted, which reads as stale data rather
than a bug. Menu accelerators are pushed from the webview (`set_open_accelerator`) for the same
reason: one declared in Rust would both show a stale chord after a rebind and swallow it before the
webview saw it.

### Two editor panes, one focused

The window holds one or two editor panes (`editorPanes.ts`), and everything that
used to mean "the open note" now means **the focused pane's** note: autosave,
the history panel, backlinks, wikilink navigation and the note-scoped commands
all read `note`, which `App` derives from the focused pane. That is deliberate —
the alternative was teaching every one of those consumers which pane it is
talking about, and there are dozens. The setters (`setNote`, `setPreview`,
`setDrawing`) address the focused pane, so opening from the tree, the switcher,
a wikilink or a deep link lands where you are working without any of those
callers knowing a second pane exists.

Three rules hold it together, and all three have a failure they were written for:

1. **A note lives in at most one pane.** Opening one the other pane already
   shows moves focus there instead (`sideShowing`). Two editors over one file
   each hold their own buffer and take turns overwriting the other's autosave,
   which no care at the write end can fix.
2. **The unsaved-text buffer is keyed by document**, not by "the open note":
   two panes can be dirty at once, and typing in one then clicking into the
   other must not strand the first pane's keystrokes. `flush` drains every
   entry, each to the vault and path its own entry names.
3. **Focus moves before the click is handled.** `focusPane` writes a ref as
   well as state, because pressing History in the pane you were *not* in has
   to mean that pane's history. Anything reading "the open note" from a handler
   goes through `noteRef`/`editorRef`, which are getters over that ref.

Two consequences worth knowing. Anything a pane resolves *relative to its own
note* has to be built per pane — attachments are, because `assets/plan.png`
means something different in `Projects/` than at the root. And the editor only
takes the caret on mount or a document swap when its pane is focused
(`autoFocus`), or a remount from a theme flip or an incoming pull would pull the
caret out of the pane being typed in.

### A workspace is one predicate, applied everywhere

A workspace scopes the whole app to one tag (`workspace.enter`, `⌘⇧W`). The
risk is not that the filter is hard but that it is easy to apply in seven
places and forget the eighth — and a view that leaks notes from outside a scope
it promised to respect is worse than not having the feature, because the
promise was the only thing being sold. So `inWorkspace` in
`packages/core/src/notes/workspace.ts` is the **only** definition of "inside",
and every surface takes it: the note list, search, the task list, backlinks,
unlinked mentions, the tag browser, the tree (`filterToWorkspace`), the quick
switcher, pinned notes, the empty pane's Recent and its note count.

Two deliberate exceptions, both because a *link* is not a *view*:
`resolveLink` and `[[` completion cross the boundary. Following an explicit
link out of the workspace is the user asking to go there, and a link that
silently failed to resolve would look like a broken link rather than a
boundary.

**Creation has one seam.** `createNoteFile` in `App.tsx` is the only place a new
note's bytes are decided, because there are six ways to make one — the prompt, a
wikilink to nothing, a daily note, a template, a merge, a deep link — and
"every new note stays inside the workspace" is only as true as the least-used
of them. A new note without the tag is created straight into a view that hides
it, which reads as the note not having been created at all. That bug shipped
once during development precisely because `newNote` wrote through its own call
to `api.createNote`. The tag itself goes *below* any frontmatter
(`withWorkspaceTag`): a `---` block is only frontmatter on the first line, so a
tag written above one turns the note's own header into prose — which templates
with a header, and every imported note, would meet immediately.

The active workspace is machine-local, per vault (`workspaces.ts`), and it
persists: the app stays inside it "until you leave", and dropping you back into
the whole vault overnight would be a different promise.

### Note ids are minted, not assigned

See ROADMAP §3.6 for the storage-format decision. In short: inside the vault a
note's identity is its path, and a rename rewrites the `[[wikilinks]]`. A note
gains `id:` in its frontmatter only when someone copies a permanent link to it
(`note.copyLink`), so a vault accumulates that bookkeeping for the handful of
notes linked from outside and no others. `withNoteId` edits the frontmatter as
*text* rather than re-serialising YAML — a round-trip would reorder keys and
drop comments, and "we copied a link" must not diff as a rewrite of the
reader's file. Anything that copies a note's text strips the id
(`withoutNoteId`): duplicating, and creating from a template.

### Importing: a reader per source, one seam after it

Arriving from another Markdown app is `vault.importFolder` — `git init` over a
picked folder — and that is the cheap half. The expensive half is the apps that
do not keep notes as files: Evernote, Notion, Apple Notes, OneNote. Each needs
its own reader, and **none of them may have its own idea of how a note becomes
a file**, or a vault ends up laid out four ways and three of them are
discovered later. So a reader's whole job is to produce `SourceNote`s — title,
body as HTML, tags, dates, resources identified by content hash — and
`planNote` (`packages/core/src/import/pipeline.ts`) decides everything after
that. Evernote is the only one implemented; the second one is what will prove
the seam is in the right place.

`packages/core/src/import/names.ts` is where the bodies are buried, and it is
the same problem for every source: titles hold `/` and `:` and newlines, notes
are untitled, `Meeting: 3/4` and `Meeting - 3-4` sanitise to one name, macOS
and Windows are case-insensitive where Linux is not, and the 255 limit is in
**bytes**. So names are *allocated* rather than derived — one `NameAllocator`
per run, seeded with the paths the vault already has, because the collision to
avoid is as much with an existing note as with one imported a second ago.

**The split between Rust and TypeScript is about size, not about layers.** A
ten-year Evernote archive is a multi-gigabyte `.enex` of base64, so the file
never enters the webview: `src-tauri/src/enex.rs` holds it open and hands over
one note at a time, plus the decoded bytes of *that note only*
(`enex_open` → `enex_next` → `enex_write_media` → `enex_close`). Memory is
bounded by the largest note rather than the archive, and no attachment crosses
the IPC. Everything that decides what the note *says* stays in core, where it
is a pure function over a fixture. Cancelling is simply not asking for the next
note; what has already landed stays, because it is in the vault and in Git.

Three things an importer must not reinvent, all of which have a home already:

- **HTML → Markdown is `htmlToMarkdown.ts`**, extended rather than forked —
  two converters would mean two dialects and the difference would show up in
  the diffs of a vault that was half typed and half imported. Evernote's own
  elements are rewritten to *void* HTML ones (`<en-todo>` → `<input>`,
  `<en-media>` → `<img>`) before parsing, because Turndown discards any element
  whose text is empty before consulting a rule, and recursively: a `<div>`
  holding nothing but an image is blank too, so a note of photographs would
  convert to nothing at all.
- **Where attachments go is `attachmentFolderFor`**, which reads the vault's
  own setting. An importer that hard-codes `assets/` is wrong in every vault
  whose owner chose otherwise.
- **Notes are written through `createNoteFile`**, like every other new note, so
  an import inside a workspace stays inside it. It takes `{ index: false }` for
  bulk: patching the search index per note re-renders the window per note, so
  an import rebuilds it once at the end. The decision about a note's *bytes*
  still happens in that one place.

What cannot come across is **reported, not dropped**: an encrypted block leaves
a visible marker, a reference to bytes the export did not carry becomes a
warning, and a resource the body never mentioned is linked from an Attachments
list rather than written where nothing points at it.

### Templates are notes that are not notes

Templates are ordinary Markdown files in a folder (`templatesFolder` in
`.opennote/settings.json`, `templates/` by default), so they sync and version
like everything else and are editable in the app. `renderTemplate` fills
`{{title}}`, `{{date}}` and `{{time}}`, leaving anything it does not know
exactly as written — another tool's `{{mustache}}` passing through unchanged is
correct, and swallowing it would hide typos. Daily notes go through the same
path: a `daily.md` in that folder wins over the built-in heading.

They stay **indexed** — their links and tags are real — but they are kept out
of every surface that answers "what have I got?", because a template is a shape
to fill in rather than something to read: the note list, content search
(`is:template` is the way back in), the task list (an unticked box in a
template is a task that can never be completed), the empty pane's Recent, and
the switcher's nothing-typed list. Typing a name in the switcher still finds
one, which is how you reach a template to edit it; so does the tree, which goes
on showing everything the repository contains.

The folder is configurable because `templates/` is not everyone's word for it,
and because a vault that already uses that name for notes should not have them
silently reclassified. An **empty** setting means "this vault has no
templates", which is why the parse keeps an explicit `""` instead of falling
back to the default.

### Tabs belong to the pane

Each pane owns a list of open documents and an active one (`Tab`, `Pane` in
`editorPanes.ts`), and a **vault owns a layout** — `App` holds
`Record<root, PaneLayout>`, so switching vaults finds each as you left it
rather than empty. Per pane rather than per window because a split pane is a
second place to read, which also disposes of the question "which pane does a
tab click land in?".

The rule from the split extends rather than changes: a document lives in **at
most one tab, in one pane** (`locate`), and every opener — tree, list,
switcher, wikilink, deep link — goes through `openInPane`, which is what makes
that true rather than aspirational. A new tab lands *after* the active one, so
following a link puts the target next to where you came from.

Open tabs are remembered per vault in `localStorage` (`openTabs.ts`), as paths
only: the content is re-read on restore, because the vault is a Git repository
that anything may have changed since. Previews and drawings are not
remembered — an image is something you glanced at.

### Several windows, and who owns a vault

Tauri windows share one process, so a second window is a second webview and a
second copy of the sync engine. Two engines on one vault would run two commit,
push and fetch loops against one working copy and contend for git's index lock
— the failure the engine serialises its own calls to avoid.

So a vault is **owned** by one window (`src-tauri/src/windows.rs`): the owner
runs the engine, and any other window with that vault open is a **follower**
that reads and writes files — plain IO, no git — and forwards "a file landed"
to the owner, whose commit loop then does what it always did. Consequences
worth knowing:

- **Claims are atomic, in Rust.** Two windows opening a vault in the same
  instant must not both believe they won, which a broadcast election cannot
  promise. The same registry, keyed by document, extends "one tab per
  document" across windows: opening a note another window has open reveals it
  there (`revealElsewhere`) instead of starting a second editor over one file.
- **Closing a window hands over.** `on_window_event` releases its claims and
  broadcasts `vault://ownerless`; the remaining windows race to claim, and the
  winner builds an engine. Without this a vault would go on being edited with
  nothing committing it.
- **Followers may not run git.** Branch switches, history restores and
  conflict resolution are disabled with one shared explanation
  (`MANAGED_ELSEWHERE`), because each of them takes the lock the owner holds.
  Reading history is fine from anywhere.
- **Capabilities are per window label.** `capabilities/default.json` listed
  only `main`; a created window matched nothing and every `invoke` in it
  failed. It is `["main", "w*"]`, and `windows.rs` hands out exactly those
  labels.
- **Claim failures fail open.** A window with no engine *and* no owner is worse
  than the contention the claim prevents, so an unavailable claim is treated
  as ownership — which is also what happens outside the desktop shell.
- **Some Tauri builder methods are platform-gated.** `title_bar_style` is
  `#[cfg(target_os = "macos")]`, so chaining it compiles on a Mac and fails the
  Linux and Windows jobs — development happens on one platform and CI builds
  three. Apply such a call through a `cfg`-shadowed `let`, and prefer
  `tauri.conf.json`, which is configuration and simply ignored elsewhere.

### Two editors, one package

`createMarkdownEditor` is for notes; `createTextEditor` (`text.ts`) is for everything else a
repository contains. They deliberately share nothing but the package: a `.ts` file wants line
numbers, monospace and full width, and none of the note editor's concealment. Languages come from
`@codemirror/language-data`, which describes every language without loading any — `load()` pulls in
one parser, so a vault of Markdown never pays for the rest.

`FileKind` in `vault.rs` classifies with a **denylist** of binary extensions. Anything else is
offered as text and refused at read time if it is not UTF-8; an allowlist would have to grow
forever to cover what people keep in a repo.

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

### The window chrome is ours to draw

`titleBarStyle: "Overlay"` means there is no native bar, so the header strip carries
`data-tauri-drag-region="deep"` and the runtime moves the window. `-webkit-app-region` is a
Chromium property that WKWebView does not implement — it looks right and does nothing on macOS.
The drag also needs `core:window:allow-start-dragging` in `capabilities/default.json`, which
`core:default` does **not** include; without it the strip is dead and nothing says why.
`apps/desktop/src/titlebarDrag.test.ts` pins all three.

### Settings live in the repo

Per-vault settings are `.opennote/settings.json` and `.opennote/keymap.json`, so they travel with
the vault between machines. Both are hand-editable, so parsing **degrades field by field** to
defaults rather than failing. Machine-local state (recent vaults) goes in the OS config dir and is
never committed.

Posture is not settings, and the line is drawn at whether the sync engine would commit it. Pane
widths and visibility (`panes.ts`) and which folders the tree has expanded (`treeExpansion.ts`)
live in `localStorage`, keyed by vault root where they are per-vault: a caret click writing a
tracked file would have the sync engine commit and push on every toggle, then have two machines
argue about the result. Folders default to **collapsed**, so what is stored is the *expanded* set —
storing the collapsed set instead would mean writing down every folder in the vault to express the
default. `apps/site/scripts/screenshots/stub.js` seeds that key, because the shots click rows that
live inside folders.

### Rendered SVG is sanitised

A vault can be cloned from anywhere, so `packages/diagrams` strips scripts, event handlers,
`javascript:` URLs and `foreignObject` before any rendered SVG reaches the DOM. Mermaid is
configured with `htmlLabels: false` because it otherwise draws labels inside `foreignObject`, which
sanitisation removes — silently blanking every label.

### The website is static, and its downloads are not

`apps/site` is Astro with `output: 'static'` — `pnpm site:build` writes `dist/`,
and that directory is the whole website. Nothing runs at request time, because the
deploy target is an object store behind a CDN.

The download page fetches GitHub Releases **in the visitor's browser**, not at build
time: a build-time fetch would freeze the version at the last deploy. `/releases/latest`
is unusable — GitHub omits pre-releases from it — so `pickRelease` takes the newest
stable and falls back to a pre-release. The response is cached in `localStorage` for an
hour, because the anonymous API allows 60 requests per hour per IP.

Screenshots under `apps/site/public/screenshots/` are captured from the real app by
`pnpm site:screenshots`, which serves the desktop web build with a stubbed IPC and
photographs it with headless Chrome. Regenerate them after a UI change rather than
letting them drift.

`infra/site` is Terraform for the hosting — a private bucket, CloudFront, DNS, and the IAM
role GitHub Actions assumes over OIDC — and it is applied **by hand**, with state in S3
(`open-note-terraform-state`) locked via `use_lockfile`. That state bucket is deliberately
not managed by the stack: Terraform would need it to exist in order to record its own
existence. `deploy-site.yml`
runs on push to `main` and can replace the site's contents and invalidate the cache, and
deliberately nothing else.

The bucket is private, so CloudFront hits the S3 **REST** endpoint, which serves keys
literally and answers 403 for a missing one. A CloudFront Function therefore maps
`/features` onto `features/index.html` (and 301s `www` to the apex), and the distribution
maps 403 as well as 404 onto `/404.html`. The deploy uploads in ordered passes because
`Cache-Control` is set per object at upload time and `aws s3 sync` will not revisit an
unchanged object to correct it — the passes must partition `dist/` exactly. See
[docs/DEPLOYING-SITE.md](docs/DEPLOYING-SITE.md).

**No analytics, ever.** The product's argument is that it does not phone home; the
website must not undercut it.

## Conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). A Jira ticket number goes
  at the end of the first line when one exists.
- **Releases:** tag `vX.Y.Z` on `main`; CI builds and publishes. Pre-release tags get no `.msi`
  (Windows Installer cannot express a non-numeric pre-release identifier). macOS builds are
  signed and notarised, and the release fails fast if any of the six `APPLE_*` secrets is
  missing rather than shipping a `.dmg` Gatekeeper rejects — see
  [docs/RELEASING.md](docs/RELEASING.md). Windows is still unsigned. Nightlies are unsigned
  by design.
- Biome reformats and reorders imports on `--write`, which breaks scripted string edits against
  import blocks. Prefer editing by line position, or re-read the file after formatting.
