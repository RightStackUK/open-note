---
title: Conflicts
description: What Open Note does when two versions of a note disagree — and, more importantly, what it deliberately does not do.
---

A conflict happens when the same note changed in two places since they last
agreed — usually two machines, occasionally you and a colleague on a shared
vault.

Because a note is a single file, and files are edited by one person at a time far
more often than not, real conflicts are rare. But rare is not never, and one note
silently overwritten destroys any reason to trust a notes app with the rest.

## What Open Note does

**It stops.** The vault enters a conflicted state and every automatic loop halts.
Nothing commits, nothing pushes, nothing pulls. The status bar turns red and says
**Conflict**.

**It tells you which notes.** Conflicted files are listed on the conflict screen
and badged in the sidebar.

**It offers you three ways out**, per file:

- **Keep mine** — your version wins, wholesale.
- **Keep theirs** — the incoming version wins, wholesale.
- **Merge by hand** — the note opens with Git's conflict markers left in, exactly
  as Git wrote them, and you edit it into the version you want.

**It checks your work.** When you say a file is resolved, Open Note asks Git
whether it agrees. If Git still reports unmerged paths, the app does not believe
you and stays conflicted. This is deliberate: an app that takes your word for it
would happily let you push a note with `<<<<<<<` in it.

Once every file is resolved the rebase continues and normal syncing resumes.

## What it will never do

- **Auto-merge.** No heuristics, no "last write wins", no clever three-way guess.
- **Auto-discard.** Neither side is thrown away without you choosing it.
- **Force-push.** There is no setting for it, in any state.

Automation in Open Note is aggressive but never destructive. That distinction is
the whole product.

## Reading the markers

If you merge by hand, this is what you will see:

```markdown
<<<<<<< ours
- [ ] Call the dentist on Tuesday
=======
- [ ] Call the dentist on Thursday
>>>>>>> theirs
```

Delete the markers and the line you do not want, leaving the note as it should
read. Save, then mark it resolved.

**A note on "ours" and "theirs".** Mid-rebase Git inverts these relative to
intuition: "ours" is the upstream work being replayed onto, and "theirs" is your
own commit. Open Note's buttons are labelled from *your* point of view and do the
translation for you, so **Keep mine** always means your work. If you are editing
the raw file, the markers are Git's own and follow Git's convention.

## Starting over

If a merge is going badly, **Abort** runs `git rebase --abort` and returns the
vault to exactly where it was before the pull. Nothing is lost; you are simply
back to being behind the remote.

## Avoiding them

- **Let a machine finish syncing before you move to another.** Watch for
  **Synced** in the status bar.
- **Press <kbd>Mod S</kbd> before closing the lid**, which commits and pushes
  immediately rather than waiting on a timer.
- **For genuinely shared vaults, use branches.** Two people on separate branches
  merging deliberately is far calmer than two people on `main`.
