---
title: Getting started
description: Connect a Git repository, write your first note, and learn to read the sync indicator.
---

Open Note keeps your notes in a Git repository you control. Before it can do
anything, it needs two things: `git`, and a repository to point at.

## 1. Check you have Git

Open Note runs your own `git` binary rather than embedding one. That is what
makes your SSH keys, credential helpers, commit signing and proxy settings work
without configuring any of them twice.

```bash
git --version
```

If that prints a version, you are ready.

- **macOS** — running the command above offers to install the Xcode command line
  tools, which include Git.
- **Windows** — install [Git for Windows](https://git-scm.com/download/win).
- **Linux** — `sudo apt install git`, `sudo dnf install git`, or your
  distribution's equivalent.

## 2. Get a vault

A **vault** is an entire Git repository. Not a folder inside one — the whole
thing. You have two ways in.

### Clone one you already have

On the welcome screen, choose **…or clone one from a URL**, paste an SSH or
HTTPS remote, and pick where it should live. Because the clone runs through your
own Git, a private repo works exactly as it does in your terminal.

### Open a folder you already have

Choose **Open a vault…** and pick any folder that is a Git repository. An empty
repository is fine — a new vault with no notes is a normal starting point.

If the folder is not a repository yet, choose **New vault from a folder…**
instead: Open Note runs `git init` and makes the first commit for you. Or do it
by hand:

```bash
mkdir notes && cd notes
git init
```

Either way, you can add a remote later; Open Note will commit locally in the
meantime and say `no upstream` in the status bar until you do.

## 3. Write something

Press <kbd>⌘N</kbd> (<kbd>Ctrl+N</kbd> on Windows and Linux), or the **＋**
button above the file tree. Give it a name — `.md` is added if you leave it off.

Type. The note is written to disk half a second after you stop, and the status
bar goes from **Unsaved** to **Saved**.

That file is now a real Markdown file on your disk. Open it in any other editor
and it will look exactly as you would expect.

## 4. Read the sync indicator

The bottom-left of the window always says what the vault is doing. It is never
silent, because a notes app quietly doing nothing is the one outcome that cannot
be allowed.

| It says | It means |
|---|---|
| **Synced** | Everything is committed and pushed. Your work is safe on the remote. |
| **Unsaved changes** | Edits are on disk, waiting to be batched into a commit. |
| **Committing…** / **Pushing…** | In progress. |
| **Updates available** | The remote has commits you do not. They will be pulled shortly. |
| **Offline** | No network. Work continues locally and pushes when you are back. |
| **No upstream** | The branch has no remote to push to. Local commits still happen. |
| **Sync paused** | You turned automation off. Nothing will commit or push. |
| **Conflict** | Two versions of a note disagree. Everything stops until you decide. See [Conflicts](/docs/conflicts). |

Click the badge to pause and resume syncing. Click the branch name beside it to
switch branches or open a pull request.

## Where to go next

- [Sync](/docs/sync) — what each automatic behaviour actually does, and how to
  change it.
- [Keyboard shortcuts](/docs/shortcuts) — the full list, and how to rebind any of
  it.
- [Files and folders](/docs/files) — what else a vault can hold.
