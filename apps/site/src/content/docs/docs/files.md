---
title: Files and folders
description: What a vault can hold, which files Open Note will edit, and where its own settings live.
---

A vault is an entire Git repository, so it holds whatever repositories hold.
Open Note tries to be honest about that rather than pretending a repo contains
only notes.

## What opens in what

| Kind | What happens |
|---|---|
| **Markdown** (`.md`, `.markdown`, `.mdown`, `.mkd`) | The note editor: inline decoration, wikilinks, tasks, diagrams. |
| **Text and code** (anything not a known binary) | A plain editor with line numbers, monospace and syntax highlighting for around 150 languages. |
| **Images** (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.avif`, `.bmp`) | Read-only preview. |
| **Drawings** (`.excalidraw`) | The drawing canvas. |
| **Binaries** (`.pdf`, `.zip`, archives, media, fonts…) | Listed, greyed out, never opened. |

Classification is a **denylist** of binary extensions rather than an allowlist of
text ones. A repository can hold a `Makefile`, a `.env`, a `Dockerfile` or any of
a hundred config formats, and an allowlist would never keep up. Anything that
turns out not to be valid UTF-8 is refused when you try to open it.

## Creating, renaming, moving, deleting

- **＋** and **⊞** above the file tree create a note or folder at the vault root.
- **Right-click** anywhere in the tree to create inside a folder, or to rename or
  delete.
- **Drag** a note or folder onto another folder to move it.

Renaming or moving a note **rewrites the `[[wikilinks]]` that point at it**. The
rewrites and the rename land in the same commit, so the whole change can be
reviewed — and reverted — as one thing.

Deleting is permanent as far as the working tree goes; there is no trash. Git
history is the recovery mechanism, and a second half-mechanism would be worse
than one clear one. If a file has never been committed, the app says so before
deleting it, because in that case there is genuinely nothing to recover from.

## Empty folders

Git cannot store an empty directory. Open Note lists folders from the filesystem
so a folder you just made does not appear to vanish — but be aware that an empty
folder **will not sync to another machine**. It shows up there as soon as it
contains a file.

## What is hidden

- **`.git/`** — never listed, and destructive operations refuse to touch it.
- **`.opennote/`** — the app's own settings. Hidden because the settings and
  shortcuts panels own it, and listing it invites hand-edits that race them.
- **Anything in `.gitignore`** — the file tree comes from Git, so your ignore
  rules are respected for free. A `node_modules` is never even walked.
- **Other dot-directories** — tooling, not notes.

## Attachments

Paste an image into a note and it is written into the vault as a real file, then
linked relatively. It is never embedded as base64 — that would bloat the note,
ruin the diff, and make the image invisible to everything except Open Note.

Where they land is configurable in settings: a folder name puts them all in one
place (`assets/` by default), and `.` puts each one beside the note that uses it.

## Where Open Note's own files live

**In the vault**, committed, so they travel between machines:

- `.opennote/settings.json` — sync intervals, attachment folder, pinned notes.
- `.opennote/keymap.json` — your keyboard shortcuts.

Both are plain JSON and safe to edit by hand. Parsing degrades field by field: a
broken entry falls back to its default rather than stopping the vault from
opening.

**On the machine**, in your OS config directory, never committed:

- The list of vaults you have opened recently.

## Multiple vaults

Several vaults can be open at once, each with its own sync state, settings,
branch and keymap. They appear as tabs at the top of the window.

They are genuinely independent — one can be mid-conflict while another pushes
happily.
