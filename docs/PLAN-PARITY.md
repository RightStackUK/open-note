# Plan — feature parity

The gap between "Open Note edits Markdown in a Git repo" and "Open Note is the
notes app someone picks over the mature commercial ones".

A feature audit against the established Markdown notes apps in this category
found **72 things they do that we do not**. Ten of those are either genuine
architecture changes or need a separate build target, and are deferred with
issues. The other 62 are grouped into ten blocks below, ordered so that the
cheap work that changes the daily feel of the app lands first.

This plan does **not** revisit the decisions in
[ROADMAP.md](ROADMAP.md) §1. Six audited features were rejected outright because
they conflict with them — recorded in [Rejected](#rejected) at the end so they
stop coming back as feature requests.

**Status:** in progress. Blocks 1 and 2 landed; Block 3 next.

---

## What the audit found

| | State |
|---|---|
| Block-level editor commands | **Missing.** No list, ordered list, quote, code block, or headings 4–6. The registry has nine editing commands; a Markdown editor needs about thirty. |
| Move a line up or down | **No.** `indentWithTab` is the only line-level binding. |
| Table editing | **None.** GFM tables parse and highlight, but nothing inserts or edits one. |
| Autocomplete | **None of any kind.** `@codemirror/autocomplete` is not even a dependency, so `[[` gives you empty brackets and you must recall the exact path. |
| Typography settings | **None.** `SettingsPanel` exposes six sync toggles. There is no way to change the font size. |
| Themes | Light and dark. |
| A note list | **No.** The sidebar is a file tree with a name filter — no excerpt, no date, no sort order. |
| Back / forward | **No navigation history.** Following a wikilink is one-way. |
| Search | Prefix and fuzzy over title, body, tags, path. **No phrase search, no exclusion, no filters.** |
| Attachments | Pasted images only. No drag-and-drop, no non-image files, no PDF preview. |
| Export | **One format: HTML.** No PDF, no print path at all. |
| Paste | Raw only. Pasting a web page yields HTML source or nothing useful. |
| Tag management | The tag browser is read-only. Renaming a tag means find-and-replace by hand. |
| Syntax coverage | No callouts, math, footnotes, highlight or heading folding. |
| Automation | **No URL scheme, no CLI, no global hotkey.** Nothing outside the window can reach the app. |

Four of these are worse than missing: the app is a *writing* tool with no
typography controls, a *linking* tool with no link completion, a *notes* app with
no note list, and a *Markdown* editor that cannot make a bulleted list from the
menu.

---

## Block 1 — The missing editor verbs ✅

*Landed. Two decisions were taken during implementation and are recorded in
[Decisions recorded](#decisions-recorded): tables are found by scanning lines
rather than by walking the syntax tree, and the automatic todo sort is a
deferred follow-up transaction.*


*The cheapest block and the one that most changes how finished the app feels.
Same shape as the stabilisation work: implementations in
`packages/editor/src/commands.ts`, ids in `COMMANDS`, reached through
`NoteEditorHandle.runCommand`. **One dispatcher, not two** — nothing here gets
registered in a CodeMirror keymap.*

Every id added here needs a handler or an implementation or
`apps/desktop/src/commandCoverage.test.ts` fails, which is exactly what that test
is for.

### 1.1 Block commands

`list`, `orderedList`, `quote`, `codeBlock`, `heading4`–`heading6`,
`lineSeparator`.

Same edge cases the existing commands are tested against, and the tests go in
the same places: toggle off when already applied, per-line across a multi-line
selection, replace rather than stack when converting one block type to another,
and a predictable caret afterwards so typing can continue.

Ordered lists renumber on toggle. `codeBlock` wraps the selection in a fence and
puts the caret on the info string, so a language can be typed immediately.

### 1.2 Line manipulation

`moveLineUp`, `moveLineDown`, `indentLine`, `outdentLine`.

The first two are `moveLineUp` / `moveLineDown` straight out of
`@codemirror/commands` — an import and two registry entries. Indent and outdent
need list awareness: inside a list item they should shift the item and its
continuation lines together, not insert a tab.

### 1.3 Table editing

`table.insert`, `table.addRow`, `table.addRowAbove`, `table.addColumn`,
`table.addColumnBefore`, `table.moveRow{Up,Down}`, `table.moveColumn{Left,Right}`,
`table.deleteRow`, `table.deleteColumn`, `table.alignColumn`.

The largest item in the block. There is no CodeMirror table package, so these
are hand-written over the `Table`/`TableRow`/`TableCell` nodes the GFM parser
already produces. Two things make it tractable: the syntax tree gives cell
boundaries for free, and every operation is a whole-table rewrite followed by a
single `dispatch`, so realignment is not a special case — it is the normal path.

Pipes get re-padded so the source stays readable in another editor. That is the
whole reason to write these rather than tell people to align pipes by hand.

### 1.4 Todo operations

`task.markAllComplete`, `task.markAllIncomplete`, `task.moveCompletedToBottom`,
and a `sortTodosOnCompletion` setting that runs the last one automatically.

Scoped to the list containing the cursor, not the whole note — a note with a
shopping list and a project list should not have them merged.

### 1.5 Insert date and time

`insert.date`, `insert.dateIso`, `insert.dateTime`, `insert.dateTimeIso`,
`insert.time`, `insert.timeIso`.

Locale forms come from `Intl.DateTimeFormat`. The ISO forms reuse `localIsoDate`
from `daily.ts` rather than a second implementation.

### 1.6 Duplicate a note

`note.duplicate`. A new Rust command beside `create_note`, going through
`resolve_within` like everything else, refusing to overwrite. Names the copy
`<name> copy.md`, then `copy 2`, and opens it.

### 1.7 New note from selection

`note.fromSelection`. Cuts the selection into a new note and leaves a
`[[wikilink]]` where it was.

The title comes from the first heading in the selection if there is one, and
otherwise from its first line. This is the move people make constantly as a note
outgrows itself, and doing it by hand today takes six steps.

---

## Block 2 — Completion ✅

*One dependency, three providers, and the single largest change to how the app
feels to type in.*

Add `@codemirror/autocomplete` and register three sources against the vault
index, which already holds everything they need:

| Trigger | Source | Inserts |
|---|---|---|
| `[[` | Every note title and path in the index | `[[path\|Title]]`, or bare `[[path]]` when they match |
| `#` | Every tag in the index, nested tags included | The tag |
| `:` | An emoji shortcode table | The emoji character |

Details that decide whether this is good or annoying:

- **`[[` completion ranks by recency, then title match, then path match.** The
  index already tracks mtimes for the recency list. Fuzzy matching reuses
  `fuzzyScore` from `vaultIndex.ts` rather than a second scorer.
- **It offers notes that do not exist yet.** Typing a title with no match keeps
  the "create on follow" behaviour we already have, so completion must not block
  a novel name — the panel always leaves the typed text selectable.
- **`#` must not fire inside code or on a heading.** The `maskCode` logic in
  `parse.ts` already encodes where a `#` is a tag and where it is not; the
  completion source has to agree with it or the index and the editor will
  disagree about what a tag is.
- **`:` completion is off inside code blocks** for the same reason.
- One setting, `completion`, turns all three off together.

---

## Block 3 — Typography, themes and the settings surface

*The app is for writing prose and offers no control over how the prose looks.
`editorTheme` was deliberately written CSS-variable-first for exactly this and
nothing has ever used that.*

### 3.1 Typography settings

Text font, headings font, code font, font size, line height, line width,
paragraph spacing, paragraph indent, and a **Restore defaults** button.

All of it writes CSS custom properties on the editor root, so nothing rebuilds
the editor. Stored under a new `typography` key in `.opennote/settings.json`,
parsed with the same field-by-field degradation the sync settings already use —
a hand-edited file with one bad value must not lose the other seven.

Font pickers list the system fonts plus the bundled defaults. No web fonts: an
offline-first app should not need the network to render text.

### 3.2 Zoom

`view.zoomIn`, `view.zoomOut`, `view.zoomReset`. A multiplier over the
configured font size rather than a separate mechanism, so the two cannot
disagree.

### 3.3 A theme system

Themes as JSON in `.opennote/themes/`, plus a set of built-ins.

- A theme is a flat map of the CSS variables the app already uses. This is the
  work: auditing `apps/desktop/src` for hard-coded colours and moving every one
  behind a variable. Until that is done a theme can only ever be half applied.
- Because they live in the vault, themes **sync and version like notes**, and a
  theme is a file someone can share. That is a better answer than a theme store.
- Built-ins ship as the same JSON, so there is exactly one code path.
- Every theme declares whether it is light or dark, so the editor's
  `color-scheme` and the native window chrome follow it.

### 3.4 The remaining preferences

- **Conceal Markdown everywhere**, not just off the active line. Our active-line
  rule is the better default, but it should be a preference and not a law.
- **New notes start with** a chosen heading style, replacing the current empty
  buffer.
- **Insert tags at** the top or the bottom of the note, used by a new
  `note.addTag` command.

---

## Block 4 — The note list and navigation

*The structural reason the app reads as a text editor rather than a notes app.
The biggest UI block here, and the one with the most design in it.*

### 4.1 A note list pane

A third pane between the tree and the editor: title, a body excerpt, the
modified date, and a badge when the note has attachments.

The excerpt comes from `toPlainText`, which the index already computes. The pane
is virtualised from the start — a vault of ten thousand notes is a normal vault
and retrofitting virtualisation into a list with per-row state is much worse than
starting with it.

### 4.2 Sorting

By modified date, created date or title, with a newest-first toggle. Persisted
per vault.

Created date is the honest problem here: the filesystem's creation time is
unreliable and not portable, so **created date comes from the first commit that
touched the file**, cached in the index. That is slower to compute and it is also
the only definition that survives a clone, which is the one that matters.

### 4.3 Density and view options

Small, medium and large row heights; a toggle to hide attachment badges; a toggle
to hide notes from nested tags when a parent tag is selected.

### 4.4 Layout modes

`view.layoutEditor`, `view.layoutList`, `view.layoutFull` — editor only, list
plus editor, tree plus list plus editor. These are just which panes are visible,
and they are cheap once 4.1 exists.

### 4.5 Smart collections

**Untagged** and **Today** join the existing Tasks and Pinned views. Both are
index queries and neither needs new parsing: untagged is `tags.length === 0`,
today is an mtime comparison.

### 4.6 Navigation history

`nav.back` and `nav.forward` over a per-window stack of opened notes, with the
scroll position and selection restored.

This has to live above the editor, not inside it — CodeMirror's own history is
document undo, which is a different thing, and conflating them would make ⌘Z
navigate.

### 4.7 Tag quick open

A second mode on the existing overlay rather than a second overlay. The overlay
already hosts the palette, the switcher and search; tags are a fourth source, not
a fourth component.

---

## Block 5 — Clipboard, export and print

*Everything in this block shares one piece of machinery: a Markdown ↔ HTML
converter in both directions. `marked` already gives us one direction.*

### 5.1 Paste, properly

- **Paste as Markdown** — the default. The paste event already carries
  `text/html`; convert it with `turndown` and insert clean Markdown. Pasting a
  web page is a daily action and today it produces either raw HTML or a wall of
  unstyled text.
- **Paste as plain text**, **as raw HTML** and **as a code block**, as explicit
  commands.
- **Paste a URL onto a selection** wraps it as a link.
- **Paste a bare URL** fetches the page title and inserts `[Title](url)`, behind
  a setting that is **off by default** — it is a network request triggered by a
  keystroke, and an offline-first app should ask before adding one.

### 5.2 Copy As

Plain text, Markdown, rich text and HTML, each with an option to strip tags.
Rich text means writing `text/html` to the clipboard alongside the plain
fallback. This is how a note gets into an email or a chat message without
carrying its syntax with it.

### 5.3 Print and PDF

Both go through the webview's print pipeline against the existing HTML export —
one renderer, two outputs, and the print stylesheet is a theme like any other.

Be honest about the limit: this routes through the OS print dialog, so "export to
PDF" is a dialog and not a silent file write. A silent writer means bundling a
PDF engine, which is a large dependency for a small gain. Revisit if it turns out
to matter.

### 5.4 Export options

- Rewrite `[[wikilinks]]` to relative HTML links so exported HTML is navigable.
  Without this an export of a linked vault is a set of dead ends.
- Copy attachments alongside, or keep inlining them as data URLs.
- Merge a selection of notes into one file, in tree order.

### 5.5 Bulk export

Export a folder, or every note carrying a tag, in any supported format. The
existing per-note path becomes a loop with a progress indicator and a cancel.

### 5.6 Two more formats

**DOCX** for people who have to send a document, via the `docx` package.
**Textbundle** for lossless round-tripping, because it is a documented open
container of Markdown plus its attachments — it is a zip and a manifest, not a
new format to invent.

ePub, RTF and JPG are deferred — see below.

---

## Block 6 — Markdown syntax coverage

*Five extensions to the parser and its decorations. The ordering principle from
ROADMAP §4 applies to syntax too: **prefer what still renders when someone opens
the vault on github.com.***

| | Syntax | Renders on GitHub |
|---|---|---|
| 6.1 | Callouts — `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` | ✅ natively |
| 6.2 | Math — `$inline$` and `$$block$$` | ✅ natively |
| 6.3 | Footnotes — `[^1]` | ✅ natively |
| 6.4 | Highlight — `==text==` | ❌ shows the `==` |
| 6.5 | Underline — `<u>text</u>` | ✅ (HTML passthrough) |

6.1–6.3 are the priority, and all three are worth having on their own merits:
GitHub's alert syntax is a real standard, and maths and footnotes are what
academic and technical vaults are full of.

- **Callouts** decorate the blockquote in place with a coloured rule, an icon and
  a label. A block decoration, so it comes from a `StateField` — a `ViewPlugin`
  is rejected outright, as `diagrams.ts` records.
- **Math** renders through KaTeX, off the active line, using the same async
  widget pattern the diagram blocks use. KaTeX is ~280 KB of CSS and fonts, so it
  loads on first use rather than at startup, the way `language-data` pulls one
  parser rather than all of them.
- **Footnotes** get a `renumberFootnotes` command and a hover preview of the
  definition. The reference is concealed to a superscript off the active line.
- **Highlight** ships last, and the settings copy says plainly that it shows as
  `==` outside the app. It is included because it is near-universal across this
  class of app and people paste it in from elsewhere; it is honest about the cost.
- **Underline** deliberately inserts `<u>…</u>` rather than the `~text~` some
  apps use. `~text~` collides with strikethrough and renders as literal tildes
  everywhere else, which principle 1 rules out.

### 6.6 Heading folding

Fold a heading and its content, plus `foldAll` and `unfoldAll`.
`@codemirror/language` provides the fold service; the work is a fold range
function over the Markdown tree that ends a section at the next heading of equal
or higher level. Fold state is per-window and not persisted — a fold is a reading
posture, not a property of the note.

---

## Block 7 — Tags and search

### 7.1 Tag management

Rename, delete and pin a tag from the sidebar.

**Rename rewrites every occurrence across the vault**, and it reuses the pattern
already established and argued for note renames: the rewrites land in **one
commit** with a message naming what happened — `notes: rename #a to #b (14
notes)` — so it is reviewable in history and revertable in one action. The count
of affected notes is shown before it happens.

Renaming a parent renames its children with it. Deleting a tag removes the
occurrences and says how many notes it will touch first; it never deletes notes.

### 7.2 Nested tags as a tree

`#a/b/c` already parses — the regex allows slashes and nothing renders the
hierarchy. Sidebar gets a collapsible tree with `expandAllTags` and
`collapseAllTags`, and selecting a parent includes its children's notes subject
to the 4.3 toggle.

### 7.3 Tag sorting and icons

Sort by name or by note count. Per-tag icon, stored as a tag→emoji map in
`.opennote/settings.json` and picked from the same emoji table Block 2 uses for
`:` completion. Cosmetic, and cosmetics are part of why people choose one notes
app over another.

### 7.4 A search query language

Phrase search with `"quotes"`, exclusion with `-term`, field scoping with
`title:`, and `tag:`.

MiniSearch handles the term combinators; phrases need a post-filter over the
stored body because an inverted index cannot answer adjacency on its own. The
parser is small and belongs in `packages/core` with tests — it is exactly the
kind of thing that gets subtly wrong behaviour without them.

Fuzzy matching stays on for bare terms and is **off inside quotes**. An exact
phrase search that returns approximate matches is not an exact phrase search.

### 7.5 Content filters

`is:todo`, `is:done`, `is:image`, `is:attachment`, `is:untagged`, `is:today`,
`has:math` — composable with text and with each other.

The index already extracts todos, links, tags and headings per note; this adds a
few booleans to the stored record. Chosen `is:`/`has:` over a bare `@` prefix
because `@` is already an assignee token in our todo format and two meanings for
one sigil is a bug waiting to happen.

### 7.6 Scoped search

Search within the selected tag, folder or collection rather than always the whole
vault, with the scope shown in the field so it is never a surprise.

### 7.7 Unlinked mentions

The backlinks panel gains a second section: notes whose text contains this note's
title without linking to it.

This is what actually grows a wiki — the link you forgot to make. Cost is real:
it is every title against every body, so it runs against the index's cached plain
text, is debounced, and is capped. Each result gets a one-click "link it".

---

## Block 8 — Attachments and media

### 8.1 Attach any file

Drag and drop onto the editor, and an `insert.file` command.

Extends the existing paste pipeline rather than replacing it: same
content-hash naming, same configurable `attachmentFolder`, same `write_binary`
command. Non-image attachments render as a chip with the filename, size and
icon, and open in the OS handler on click.

The honest caveat, and the settings copy should say it: **a vault is a Git repo,
and large binaries make it a slow one.** A size warning above a threshold, and a
pointer to `git-lfs`, which `SystemGit` already inherits.

### 8.2 PDF preview

`pdf` comes out of `BINARY_EXTENSIONS` in `vault.rs` and gets its own
`FileKind::Pdf`, previewed in the webview's native PDF viewer. Inline in a note
as a page-one thumbnail that expands.

Check the webview CSP admits it on all three platforms before committing to it —
WebKitGTK is the usual one to disappoint here, as ROADMAP §6 already notes.

### 8.3 A drawing inside a note

`![[sketch.excalidraw]]` renders the drawing inline and opens the canvas on
click. This is the open item from ROADMAP Phase 4, and it is the half that
matters: a drawing you have to leave the note to see is barely part of the note.

### 8.4 Display controls

Thumbnails rather than full-width images; collapse an individual embed. Both are
per-vault settings plus a per-embed toggle.

---

## Block 9 — Note info and lifecycle

### 9.1 One info panel

Fold `OutlinePanel`, `BacklinksPanel` and the word count into a single tabbed
panel: **Statistics · Outline · Backlinks**.

Three panels showing three facets of one note is more chrome and three things to
learn. This is a consolidation, not a feature — but it is the frame 9.2 and 7.7
both hang off.

### 9.2 Fuller statistics

Paragraphs, estimated read time, created and modified dates. All cheap: the
first two come from the already-computed plain text, and the dates come from git
via the same first-commit lookup 4.2 introduces.

### 9.3 Archive

**An `archive/` folder, not a hidden flag.** A note the app has hidden from you
via metadata you cannot see in the file is exactly what principle 1 forbids;
moving the file is visible in the tree, visible on github.com, and visible in the
commit. The sidebar gets an Archive collection scoped to that folder, the folder
is configurable, and archived notes drop out of the default list and search
while staying indexed.

### 9.4 Read-only notes

`readOnly: true` in frontmatter, honoured by the editor, which already accepts
the flag and has nothing exposing it. Frontmatter travels with the file, which
app-local state would not.

### 9.5 Reveal and open with

Reveal in Finder / Explorer / file manager, and open in the default handler.
Covers the "preview it in my other Markdown app" case without us integrating with
any particular one.

### 9.6 Merge notes

Concatenate selected notes in tree order into one, with a heading per source, and
rewrite links that pointed at the merged notes to point at the result. The
sources are deleted in the same commit as the merge, so it is one revertable
action.

### 9.7 Templates

Implement [#4](https://github.com/RightStackUK/open-note/issues/4), which already
has its design: a `templates/` folder, a **New from template…** command,
`{{date}}` / `{{time}}` / `{{title}}` substitution, and daily notes moved onto
the same mechanism instead of their hardcoded heading.

### 9.8 Import a folder of Markdown

A **New vault from a folder** path: pick a directory of `.md` files, `git init`,
first commit, open it.

This is the cheap half of importing and it covers everyone arriving from another
Markdown app. Proprietary-format importers are deferred.

---

## Block 10 — Reaching the app from outside it

*Nothing outside the window can reach Open Note today. This block is small and it
unblocks everything anyone would ever want to automate.*

### 10.1 A URL scheme

`opennote://` via `tauri-plugin-deep-link`, with a deliberately small first
vocabulary: `open` (note, by vault and path), `new` (note, with optional title,
body, tags and folder), `append` (text to a note), `search` (open the overlay with
a query), `tag` (open a tag).

Two rules from the start, because a URL is untrusted input arriving from a
browser:

- Every path goes through `resolve_within`, exactly like the IPC boundary.
- **Nothing destructive is reachable by URL.** No delete, no overwrite. `append`
  is additive; `new` refuses to clobber.

### 10.2 Global hotkeys

`tauri-plugin-global-shortcut` for **show the window** and **new note**, both
configurable in the keymap panel and both unbound by default — a global hotkey
that squats on a chord the user's other apps want is a support ticket.

### 10.3 A CLI

`opennote new`, `open`, `search`, `append`, reading from stdin where it makes
sense.

This is deliberately our answer instead of platform-native automation
frameworks: it works on all three desktop platforms, it composes with everything
a shell can do, and it needs no native extension target. It also gives the
scripting story a home that survives the move to mobile.

### 10.4 Spell check and text substitution

Expose spell check as a setting, and **disable automatic quote and dash
substitution inside the editor**. Smart quotes turn `"key"` into `"key"` in a
YAML block and a code fence, which silently corrupts the file — in a Markdown
editor this is a bug, not a nicety.

Spotlight needs nothing beyond 10.1: a vault of plain `.md` files in the user's
home directory is already indexed by the OS, so what was missing was only a link
to hand off to.

---

## Sequencing

Blocks 1 and 2 first, and they are worth doing before anything else here: they
are the smallest and they change the daily feel of the app more than the rest of
the list combined.

1. **Block 1** — the missing verbs. Mechanical, well-precedented, high visible return.
2. **Block 2** — completion. One dependency, and it fixes the worst thing about wikilinks.
3. **Block 3** — typography and themes. Ships the settings surface the app has been missing.
4. **Block 4** — the note list. The first block with real design work in it.
5. **Block 5** — clipboard and export. Do 5.1 early even if the rest of the block waits; pasting is a daily action.
6. **Block 6** — syntax. 6.1–6.3 only on the first pass.
7. **Block 7** — tags and search. 7.1 and 7.4 are the valuable halves.
8. **Blocks 8, 9, 10** — largely independent of each other and can be picked up piecemeal.

**Blocks 1–5 are what a first public release should contain.** Everything before
Block 4 is small enough to land in single sittings, which is the argument for
that order: the app improves continuously rather than in one large step.

Blocks 4 and 5 both want the `created date from first commit` lookup. Build it
once, in `packages/core`, when Block 4 needs it.

---

## Deferred

Each of these is either a genuine architecture change or needs a build target we
do not have. All ten are filed as issues so they are visible on the board rather
than only in this file.

### D1 — Multiple windows, and opening a link in a new window — [#6](https://github.com/RightStackUK/open-note/issues/6)

The editor pane assumes a single open note: `App` holds one `note` object, and
autosave flush, the history panel, the backlinks panel and wikilink navigation
all key off it. A second window also raises a question the sync engine has no
answer for — it is one engine per vault, and two windows on one vault would
either contend for the index lock or need an elected owner.

Related to but larger than [#5](https://github.com/RightStackUK/open-note/issues/5),
which is split view within one window. **Do #5 first**: it forces the
single-open-note refactor while keeping state in one process, and multiple
windows becomes tractable afterwards.

### D2 — Workspaces — [#7](https://github.com/RightStackUK/open-note/issues/7)

Scoping the entire app to one tag — every view, search, and new note staying
inside it — means threading a global scope through the vault index, search, the
sidebar, the note list and note creation. That is a cross-cutting concern touching
most of the frontend, and it is easy to leave one path unscoped, which is worse
than not having it.

Revisit after Block 4, when the note list has settled and there is one obvious
place for the filter to live.

### D3 — Stable note identifiers — [#8](https://github.com/RightStackUK/open-note/issues/8)

Links resolve by path. A copyable permanent link that survives retitling and
moving needs an identity that is not the path — realistically an `id:` in
frontmatter plus an index.

This is a **storage format decision** and belongs in ROADMAP §3, not in a feature
block: it puts a field in every note that only this app understands, which is in
tension with principle 1. Our current answer — rewriting links on rename — covers
most of the need at no such cost. Deferred pending a decision, not pending
effort.

### D4 — A web clipper — [#9](https://github.com/RightStackUK/open-note/issues/9)

Saving a web page or a selection as a note is the strongest capture story we do
not have. It needs a browser extension: a separate build target, a manifest per
browser, and review by three stores. That is a project rather than a block.

Cheaper interim: 10.1 plus 10.3 make a bookmarklet or a shell one-liner possible,
which covers the people who will script it themselves.

### D5 — Platform-native extensions — [#10](https://github.com/RightStackUK/open-note/issues/10), [#11](https://github.com/RightStackUK/open-note/issues/11), [#12](https://github.com/RightStackUK/open-note/issues/12), [#13](https://github.com/RightStackUK/open-note/issues/13)

OS automation actions, widgets, file-browser previews, and a system share or
services entry all need native extension targets — and the platforms disagree
about what one even is — inside what is otherwise a cross-platform Rust and
TypeScript app. Each is macOS-only, so each is a
platform-specific maintenance burden that Block 10's CLI and URL scheme address
generically.

Reconsider individually after mobile (ROADMAP Phase 7), when there is a native
target being maintained anyway.

### D6 — ePub, RTF and JPG export — [#14](https://github.com/RightStackUK/open-note/issues/14)

Each needs its own renderer or encoder for a format almost nobody exports a note
to. DOCX and Textbundle in 5.6 cover the real demand. Revisit on request.

### D7 — Alternate app icons — [#15](https://github.com/RightStackUK/open-note/issues/15)

Trivial to implement and blocked on something else: the icon set is still a
placeholder mark (ROADMAP Phase 0). Alternates only make sense once there is a
real one to make variants of.

---

## Rejected

Audited, and deliberately not planned. Recorded so they do not return.

| Feature | Why not |
|---|---|
| **Trash with restore** | Delete stays hard. Git history is the recovery mechanism and a second half-recovery mechanism is a worse product than one clear one. Already decided and already implemented that way in `vault.rs`. |
| **Per-note password encryption** | ROADMAP §3.6. An encrypted note is an opaque blob in a Git repo, which breaks principle 1 outright. The documented answer stays an encrypted volume or a private repo. |
| **Multi-word tags** (`#two words#`) | A proprietary delimiter that renders as literal hashes everywhere else. Principle 1. |
| **Search inside attachments / image OCR** | Needs an OCR pipeline and a persistent index for a feature that is nice rather than needed. Not before the SQLite FTS5 migration, and probably not after. |
| **AI image generation into a note** | Platform-locked, and it writes a non-diffable binary into a Git repo. |
| **Per-domain web content policy** | Only meaningful if the app fetches remote content in notes. It does not. Revisit if 5.1's title lookup ever grows into link previews. |

---

## Decisions recorded

| Question | Answer |
|---|---|
| Register editing commands in a CodeMirror keymap? | **No.** One dispatcher, as established. Implementations in `packages/editor`, reached via `runCommand`. |
| Find tables via the syntax tree, or by scanning lines? | **By scanning lines**, anchored on the delimiter row. Splitting a row on its unescaped pipes gives the same cell boundaries the GFM parser would, and it keeps the table commands testable against a bare `EditorState` — which is how every other command in `commands.ts` is tested. |
| How does the automatic todo sort reach the document? | **A deferred follow-up transaction**, not a nested dispatch. Update listeners run innermost-last, so dispatching inline reports the sorted document first and the *pre-sort* document afterwards — and autosave then writes the stale one. Deferring to a microtask makes the sort a plainly separate update, and keeps the tick and the reorder as two undo steps. |
| Does the automatic sort apply in the all-tasks pane? | **No.** That pane edits notes on disk, including notes that are not open. Reordering a note the user cannot see is a surprise rather than a feature. |
| Where do themes live? | **`.opennote/themes/*.json`**, so they sync, version and can be shared. Built-ins use the same format and code path. |
| Which highlight syntax? | **`==text==`**, shipping last, with settings copy stating plainly that it shows as `==` outside the app. |
| Which underline syntax? | **`<u>text</u>`**, not `~text~`. It renders everywhere; `~text~` collides with strikethrough. |
| Which callout syntax? | **GitHub's `> [!NOTE]`.** It is a real standard and it renders on the forge. |
| How is a note archived? | **Moved to an `archive/` folder**, configurable. Not a hidden frontmatter flag — invisible metadata that hides your notes is what principle 1 forbids. |
| Where does created date come from? | **The first commit that touched the file**, cached in the index. Filesystem creation time does not survive a clone. |
| Search filter sigil? | **`is:` / `has:`**, not `@`. `@` is already the assignee token in our todo format. |
| Fuzzy matching inside quotes? | **Off.** An exact phrase search that returns approximate matches is not one. |
| Silent PDF writer, or the print dialog? | **The print dialog**, reusing the HTML export. A bundled PDF engine is a large dependency for a small gain. |
| Fetch page titles for pasted URLs? | **Yes, but off by default.** It is a network request triggered by a keystroke. |
| Where does completion decide what a `#` means? | **The tag grammar is shared with the indexer** via `partialTagBefore` in `parse.ts`, so completion can never offer a tag the index then refuses to record. Whether the caret is *in code* comes from the editor's own syntax tree rather than the indexer's regex mask — on screen, agreeing with the tree is what looks right. |
| A full emoji table, or a curated one? | **Curated (~100 entries), GitHub shortcode names.** The full Unicode set is ~1,800 entries loaded on every `:` keystroke for choices nobody scrolls to. It lives in `core` because the Block 7 tag-icon picker needs the same table. |
| Is anything destructive reachable by URL? | **No.** No delete, no overwrite. `append` is additive, `new` refuses to clobber. |
| Automation surface: native frameworks or a CLI? | **A CLI plus a URL scheme.** Works on all three platforms, needs no native target, and survives the move to mobile. |
| Multiple windows, or split view first? | **Split view first** ([#5](https://github.com/RightStackUK/open-note/issues/5)). It forces the same refactor while keeping state in one process. |
