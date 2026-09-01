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
| <kbd>Mod ⌥ ←</kbd> / <kbd>→</kbd> | Go back / forward |

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
| <kbd>Mod ⇧ M</kbd> | Highlight |
| <kbd>Mod U</kbd> | Underline |
| <kbd>Mod K</kbd> | Insert link |
| <kbd>Mod ⇧ K</kbd> | Insert note link |
| <kbd>Mod ↵</kbd> | Toggle task |
| <kbd>Mod 1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> | Heading 1, 2, 3 |
| <kbd>Mod 0</kbd> | Plain paragraph |
| <kbd>Mod ⇧ 8</kbd> / <kbd>7</kbd> / <kbd>9</kbd> | Bulleted list, numbered list, quote |
| <kbd>Mod ⇧ C</kbd> | Code block |
| <kbd>⌥ ↑</kbd> / <kbd>↓</kbd> | Move line up / down |
| <kbd>Mod ]</kbd> / <kbd>[</kbd> | Indent / outdent |

Tables, dates, todo bulk actions, footnote renumbering and more are unbound by
default — find them in the palette and bind any you reach for.

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
| <kbd>Mod ⇧ O</kbd> | Outline |
| <kbd>Mod ⇧ A</kbd> | Browse tags |
| <kbd>Mod ⇧ H</kbd> | Note history |
| <kbd>Mod ⇧ G</kbd> | Branches and pull requests |
| <kbd>Mod ⇧ B</kbd> | Toggle info panel |
| <kbd>Mod =</kbd> / <kbd>Mod −</kbd> | Zoom in / out |
| <kbd>Mod ⌥ −</kbd> / <kbd>Mod ⌥ =</kbd> | Fold / unfold this section |
| — | Keyboard shortcuts |

## Rebinding

Open **Keyboard shortcuts** from the command palette. Every command can be
rebound, and any command can be unbound entirely.

Two commands claiming the same key is flagged rather than silently resolved —
otherwise you are left wondering why a shortcut does the wrong thing.

### Presets

**Default** is the scheme above. **Alternative** follows the conventions several
other notes apps use, for people arriving from one of them: <kbd>Mod ⇧ ↵</kbd> for
a task, <kbd>Mod K</kbd> for search rather than links, <kbd>Mod O</kbd> for the
quick switcher.

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
