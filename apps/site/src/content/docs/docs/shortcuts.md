---
title: Keyboard shortcuts
description: Every shortcut in Open Note, and how to rebind any of them.
---

<kbd>Mod</kbd> is <kbd>⌘</kbd> on macOS and <kbd>Ctrl</kbd> on Windows and Linux.

The command palette (<kbd>Mod ⇧ P</kbd>) lists every command with its current
shortcut, which is always more up to date than a page like this one.

## Navigate

| Shortcut | Command |
|---|---|
| <kbd>Mod ⇧ P</kbd> | Command palette |
| <kbd>Mod P</kbd> | Go to note |
| <kbd>Mod ⇧ F</kbd> | Search in vault |
| <kbd>Mod ⇧ T</kbd> | Show all tasks |

## Notes

| Shortcut | Command |
|---|---|
| <kbd>Mod N</kbd> | New note |
| <kbd>Mod ⇧ N</kbd> | New folder |
| <kbd>Mod ⇧ D</kbd> | Open today's note |
| — | Export note as HTML |
| — | Pin or unpin this note |
| — | Clone a vault |

## Editing

| Shortcut | Command |
|---|---|
| <kbd>Mod B</kbd> | Bold |
| <kbd>Mod I</kbd> | Italic |
| <kbd>Mod E</kbd> | Inline code |
| <kbd>Mod K</kbd> | Insert link |
| <kbd>Mod ⇧ K</kbd> | Insert note link |
| <kbd>Mod ↵</kbd> | Toggle task |
| <kbd>Mod 1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> | Heading 1, 2, 3 |
| <kbd>Mod 0</kbd> | Plain paragraph |

## Sync

| Shortcut | Command |
|---|---|
| <kbd>Mod S</kbd> | Sync now |
| <kbd>Mod ⇧ S</kbd> | Pause or resume syncing |
| <kbd>Mod ,</kbd> | Settings |

## View

| Shortcut | Command |
|---|---|
| <kbd>Mod \\</kbd> | Toggle sidebar |
| <kbd>Mod ⇧ O</kbd> | Outline and word count |
| <kbd>Mod ⇧ A</kbd> | Browse tags |
| <kbd>Mod ⇧ H</kbd> | Note history |
| <kbd>Mod ⇧ G</kbd> | Branches and pull requests |
| <kbd>Mod ⇧ B</kbd> | Toggle links panel |
| — | Keyboard shortcuts |

## Rebinding

Open **Keyboard shortcuts** from the command palette. Every command can be
rebound, and any command can be unbound entirely.

Two commands claiming the same key is flagged rather than silently resolved —
otherwise you are left wondering why a shortcut does the wrong thing.

### Presets

**Default** is the scheme above. **Bear** matches Bear's conventions for people
coming from it: <kbd>Mod ⇧ ↵</kbd> for a task, <kbd>Mod K</kbd> for search rather
than links, <kbd>Mod O</kbd> for the quick switcher.

A preset only states what it changes; everything else falls back to the default.

### Where it is stored

`.opennote/keymap.json`, inside the vault, so your bindings travel with it. It is
plain JSON and safe to edit by hand.

```json
{
  "scheme": "default",
  "bindings": {
    "note.daily": "Mod-J",
    "view.tags": null
  }
}
```

`null` unbinds a command. An unreadable entry falls back to its default rather
than breaking the whole keymap.
