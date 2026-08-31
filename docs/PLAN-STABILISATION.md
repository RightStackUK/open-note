# Plan — stabilisation

The gap between "the phases are done" and "this is an app someone could rely on".

An audit after Phase 5 found three commands-that-do-nothing bugs and several
table-stakes features with no implementation at all. This plan closes them.
Mobile (Phase 7 of the [roadmap](ROADMAP.md)) waits until this is finished:
porting an app with no delete button to a second platform is the wrong order.

**Status:** Blocks 1–2 done. Blocks 3–4 in progress.

---

## What the audit found

| | State |
|---|---|
| Ten `edit.*` commands | **Declared, bound, listed in the palette — and dead.** ⌘B does nothing. |
| Enter continues a list | **No.** `markdownKeymap` was never added. |
| ⌘F find in note | **No.** `searchKeymap` was wired without the `search()` extension it depends on. |
| Create a folder | **No support at all.** Folders only appear as a side effect of a note path containing a slash. |
| Create a note | Root only, auto-named `untitled-<timestamp>.md`. No name, no location. |
| Rename / delete / move | **None.** A note cannot be deleted from inside the app. |
| Tag browser | `index.tags()` and `index.notesWithTag()` are written and tested, with **zero callers**. Clicking a tag runs a full-text search, which also matches the word in prose. |
| Attachments | Images can be previewed, never added. |

The first three are worse than missing features: the UI advertises them.

---

## Block 1 — Fix what is broken ✅

*Ships as `v0.1.0` before any of the later blocks start.*

### The decision that shapes this: one dispatcher, not two

`useCommandKeys` listens on `window` in the capture phase and calls
`preventDefault`, so it beats CodeMirror's own keymap. Registering edit commands
inside CodeMirror as well would mean two dispatchers racing, and bindings that
behave differently depending on what has focus.

So there stays **one** dispatcher — the existing global one:

- `packages/editor` exports the command *implementations* as CodeMirror
  `Command` functions, keyed by command id.
- `NoteEditor` exposes an imperative `runCommand(id)` handle.
- `App` adds `edit.*` entries to the `handlers` map it already has.

Editing logic lives in the editor package, where it is testable against
`EditorState` without a window. Bindings stay in one place, so the keymap editor
keeps working for them.

### 1.1 — The ten dead commands

`bold`, `italic`, `code`, `link`, `wikilink`, `task`, `heading1`, `heading2`,
`heading3`, `paragraph`.

The edge cases are the work, and are where the tests go:

- **No selection** — wrap the word under the caret; with no word, insert the
  markers and put the caret between them.
- **Already applied** — toggle off. `**bold**` with the caret inside becomes
  `bold`, not `****bold****`.
- **Multi-line selection** — per-line for `task` and headings; span-wrapping for
  emphasis.
- **Headings replace rather than stack** — `# Title` at heading 2 becomes
  `## Title`, never `## # Title`.
- **Caret position afterwards is predictable**, so typing can continue.

### 1.2 — List continuation

Add `markdownKeymap` from `@codemirror/lang-markdown`, ordered **before**
`defaultKeymap` so its Enter binding wins. Gives `- ` continuation, ordered-list
renumbering, GFM task lists, and Backspace out of a list.

### 1.3 — Find in note

Add the `search()` extension that `searchKeymap` already assumes, and style the
panel to match the theme. No clash with vault search: in-note find is ⌘F, vault
search is ⌘⇧F.

### 1.4 — A guard so this cannot recur

A test asserting every id in `COMMANDS` has either an app handler or an editor
implementation. The absence of exactly this test is why ten dead commands
shipped.

---

## Block 2 — File management ✅

The largest gap. Everything here goes through the existing `resolve_within`
path validation; a path from the webview is untrusted input even when it names a
file the user just clicked.

### Rust commands

| Command | Notes |
|---|---|
| `create_folder` | |
| `create_note` | Refuses to overwrite an existing file. |
| `rename_entry` | Plain `fs::rename`. Git detects renames on its own and `add -A` already stages them, so `git mv` buys nothing. Refuses to overwrite the target. |
| `delete_entry` | **Hard delete.** See below. |

### Deleting is a hard delete

Decided: no trash. Git history is the recovery mechanism, and a second
half-recovery mechanism would be a worse product than one clear one.

The honest consequence, which the UI must say plainly: **a note that has never
been committed cannot be recovered.** So the delete confirmation states whether
the note is committed, and for an uncommitted one says so explicitly rather than
using the same wording for both cases. That is a one-line difference in a dialog
and the whole difference between a safe delete and a lost note.

### Renaming updates `[[wikilinks]]` — by default

A rename otherwise silently breaks every link pointing at the note.

[Obsidian updates internal links automatically on rename](https://forum.obsidian.md/t/allow-file-renaming-from-its-internal-link/4897),
with a setting to prompt instead; Logseq, Foam and Zettlr all do the same. Users
of this class of app expect it.

This does mean editing files the user did not open, which normally this project
refuses to do. What makes it acceptable here is git: the rename and the link
rewrites land in **one commit**, with a message naming what happened —
`notes: rename X to Y (updated 4 links)` — so it is reviewable in history and
revertable in one action. That is the app's answer to "was that safe?", and it is
a better answer than leaving the links broken.

- Default on, with a setting to turn it off.
- The count of affected notes is shown before it happens.
- The index already knows who links where, so finding them is free.

### UI

- Sidebar context menu: new note here, new folder, rename, delete, reveal in
  Finder.
- Inline rename in the tree.
- "New note" from a folder creates it *in* that folder — the current command
  always uses the vault root.
- Naming a note at creation, rather than `untitled-<timestamp>`.
- After a rename, the open note follows, and the index is patched rather than
  rebuilt.

Drag-to-move comes last in this block. It is fiddly and the context menu already
covers the need.

---

## Block 3 — Tags and attachments

### 3.1 Tag browser

A panel listing every tag with its count; selecting one lists the notes carrying
it. `index.tags()` and `index.notesWithTag()` already do the work and are
already tested — this is a view, not new logic.

It also **fixes current wrong behaviour**: a tag chip today runs a full-text
search, which matches the word in ordinary prose as well as real tags.

### 3.2 Pasting an image

Paste or drop into the editor writes the file into the vault and inserts
`![](path)`.

- New `write_binary` Rust command; bytes cross the IPC as base64.
- **Content-hash filenames.** Pasting the same screenshot twice should not
  produce two copies, and a hash makes collisions impossible without a
  uniqueness counter.
- **Location is configurable**, `attachmentFolder` in `.opennote/settings.json`,
  defaulting to `assets/`. The literal value `.` means "beside the note", which
  is what people who keep self-contained folders want. A fixed folder would be
  simpler but is the kind of decision that makes people fight the app.

### 3.3 Inline image rendering

Pasting an image you then cannot see is worse than not pasting it. A CodeMirror
widget for `![](path)`, using the same async pattern as the diagram widget and
reusing the existing `readImage` command.

---

## Block 4 — Polish

Cheap, because the index already parses what they need:

- **Outline panel** — headings are already extracted per note.
- **Word count** — from the already-computed `plain` text.
- **Recently edited** — file mtimes.
- **Pinned notes** — a list in `.opennote/settings.json`.
- **Export to PDF/HTML** — via the webview's print pipeline.

Templates and split view are deliberately **not** here — tracked as
[#4](https://github.com/RightStackUK/open-note/issues/4) and
[#5](https://github.com/RightStackUK/open-note/issues/5). Split view in
particular is a refactor of the single-open-note model rather than a feature
bolted on, so it should not be squeezed in alongside file management.

---

## Sequencing

1. **Block 1**, then tag `v0.1.0`. It is bug-fixing, so it should land regardless
   of what happens to the rest.
2. **Block 2** — the biggest functional gap.
3. **Block 3**.
4. **Block 4**, which is mostly independent and can be picked up piecemeal.

Mobile follows once this is done and the app has been used in anger for a while.

---

## Decisions recorded

| Question | Answer |
|---|---|
| Trash or hard delete? | **Hard delete.** Git history is the recovery mechanism. The dialog must say when a note is uncommitted and therefore unrecoverable. |
| Rewrite wikilinks on rename? | **Yes, by default**, with a setting. Matches Obsidian, Logseq, Foam and Zettlr. Safe here because the rename and rewrites are one reviewable, revertable commit. |
| Attachments folder? | **Configurable**, default `assets/`; `.` means beside the note. |
| Templates, split view? | **Deferred** — [#4](https://github.com/RightStackUK/open-note/issues/4), [#5](https://github.com/RightStackUK/open-note/issues/5). |
| Ship Block 1 first? | **Yes**, as `v0.1.0`. |
