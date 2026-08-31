---
title: Sync
description: What Open Note commits, pushes and fetches on your behalf, when it does it, and how to change or stop any of it.
---

Open Note automates Git so you do not have to think about it. Everything it does
is one of four loops, each independently configurable and independently
switchable off.

Open the settings panel with <kbd>⌘,</kbd> or the gear icon.

## The four loops

### Write — every 500ms

The open note is written to disk half a second after your last keystroke.

**This one cannot be turned off.** Everything else in the app is a convenience;
losing what you just typed is not a trade worth offering.

### Commit — 30s idle, or every 5 minutes

Dirty files are batched into a single commit. Two triggers, whichever comes
first: thirty seconds after you stop typing, or five minutes since the last
commit if you have been typing continuously.

Batching is deliberate. A commit per keystroke would make `git log` useless, and
the point of a Git backend is a history you can actually read.

Commit messages are generated — `notes: update daily/2026-08-31.md` for one file,
`notes: update 3 notes` for a batch.

### Push — 10s after a commit

Commits are pushed to the branch's upstream ten seconds later. Failures back off
exponentially rather than hammering the remote.

**Open Note never force-pushes.** There is no setting for it.

### Fetch — every 60 seconds

While the window is focused and you are online, the remote is checked for new
commits.

- **Upstream commits, clean worktree** — fast-forwarded silently. If the note you
  have open changed, it is reloaded and you are told.
- **Upstream commits, uncommitted changes** — `pull --rebase --autostash`.
- **Conflict** — everything stops. See [Conflicts](/docs/conflicts).

## Changing it

Every interval is editable in the settings panel, and each loop has its own
switch. Turning off *push* while leaving *commit* on is a reasonable way to work
offline deliberately.

**Pause everything** with <kbd>⇧⌘S</kbd>, or by clicking the sync badge. While
paused, nothing commits, pushes or fetches. Writes still happen — your work is
still on disk, it is simply not leaving the machine.

## Sync now

<kbd>⌘S</kbd> does the whole cycle immediately: flush the open note, commit, pull,
push. Useful before closing the lid.

## Where the settings live

`.opennote/settings.json`, inside the vault. It is committed, so your intervals
travel with the vault to your other machines. It is plain JSON and safe to edit
by hand — an unreadable field falls back to its default rather than stopping the
app from opening.

## Two things it will not do

**It will not resolve a conflict.** Not automatically, not on a timer, not ever.

**It will not run two Git operations at once.** Git's index lock makes overlapping
commands fail in confusing ways, so every operation is queued.

## A known limitation

Cross-*process* contention is not handled. If you run Open Note twice against the
same vault, or use a terminal in it while the app is running, both can reach for
Git's index lock at the same time and one will fail. It is not destructive — the
failed operation retries — but it is worth knowing about.
