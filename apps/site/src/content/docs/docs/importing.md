---
title: Importing
description: Bringing notes in from another app — what comes across, and what cannot.
---

Open Note can bring notes in from another app, and the answer to "will
everything come across?" depends entirely on what the other app is willing to
hand over. That is worth knowing **before** you import rather than afterwards,
so each route says plainly what it can and cannot do.

Every import writes ordinary Markdown files into the vault you have open, the
same as if you had typed them. Nothing is deleted from the app you are leaving.

## From another Markdown app

**New vault from a folder…** takes a folder of `.md` files, runs `git init` over
it and opens it as a vault. Nothing is converted, because nothing needs to be —
your notes were already files.

This is the route for Obsidian, iA Writer, Bear's Markdown export, Logseq,
Zettlr, and anything else that keeps notes as files on disk.

## From Evernote

**Import from Evernote…** reads one or more `.enex` export files. Export them
from Evernote's desktop app — one file per notebook — and the notebook's name
becomes a folder in your vault.

What comes across:

- Note text, converted to Markdown.
- **Checklists**, as `- [ ]` task items, so they appear in the task view.
- Attachments, into your attachment folder, referenced from the note.
- Tags, as frontmatter tags.
- The original creation date, in frontmatter. Git will say the file was created
  today, so this is the only record of when the note was written.

What does not:

- **Encrypted notes.** Evernote's encrypted blocks cannot be decrypted without
  the passphrase, which the export file does not contain. The note is imported
  with a marker where the encrypted text was, and it is listed when the import
  finishes.

A ten-year archive can be several gigabytes and take a few minutes. It reads
one note at a time, shows progress, and can be stopped — anything already
imported stays.

## From Apple Notes

**Import from Apple Notes…** is macOS only, and reads your local Notes library
directly — including anything iCloud has synced to that Mac. There is no export
file to make first.

The first time, macOS will ask whether Open Note may control Notes. It has to
be allowed, because reading your notes *is* the import; if you have already said
no, switch Open Note on under **System Settings → Privacy & Security →
Automation → Notes**.

You choose which folders to import. Nested folders become nested directories.
**Recently Deleted is not selected**, because deleted notes in a permanent Git
history are hard to undo once they have been pushed.

What comes across:

- Note text, converted to Markdown, with headings, lists and tables.
- **Checklists**, as `- [ ]` task items.
- **Images** that are inside a note.
- The creation and modification dates Notes recorded, in frontmatter.

What does not:

- **Attachments that are not images** — PDFs, scans, voice memos, documents.
  Apple Notes offers no way for another app to read them: it will name them but
  not hand them over. Each one is listed by name when the import finishes, so
  you know which notes to go back to.
- **Locked notes.** These cannot be read at all. They are named in the summary
  and no empty note is created in their place.

Fetching is a few notes a second, because each note is a separate request to
the Notes app, so a large library takes minutes. Progress is shown and it can be
stopped at any point.

## Where things land

Notes go into the folder for the notebook or Notes folder they came from.
Attachments go wherever the vault's **attachment folder** setting says —
`assets/` by default, or beside the note if you have set it that way.

Filenames come from note titles, which are not filenames: `Meeting: 3/4`
becomes `Meeting-3-4.md`. Two notes whose titles end up the same get ` 2`,
` 3` and so on, and the original title is kept in the note's frontmatter
whenever the filename could not carry it.

Nothing is ever overwritten. An import only ever creates new files, so running
one twice gives you a second copy rather than replacing the first.
