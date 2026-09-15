/**
 * Every folder in the Apple Notes library, with its nested path.
 *
 * JXA rather than AppleScript for two reasons that both showed up in practice:
 * it can `JSON.stringify` (AppleScript cannot serialise anything, so the
 * alternative was a control-character-delimited stream), and its dates are
 * real `Date`s, where AppleScript coerces a date to a *localised* string and
 * computing an epoch offset from it reintroduces the DST error it was meant
 * to avoid.
 *
 * What JXA cannot say is `with timeout`, so every request here is small. The
 * rule the rest of this importer follows: never ask for the whole library in
 * one Apple event. Asking for `Application('Notes').notes()` on a real library
 * reaches the 120-second default and fails with `-1712`.
 *
 * A folder's parent cannot be asked for — the `folder` class has no
 * `container` — so the path is built walking down.
 */
function run() {
  const notes = Application('Notes');
  const out = [];

  function walk(container, prefix) {
    for (const folder of container.folders()) {
      const name = folder.name();
      const path = prefix ? `${prefix}/${name}` : name;
      out.push({ id: folder.id(), path, count: folder.notes.id().length });
      walk(folder, path);
    }
  }

  for (const account of notes.accounts()) walk(account, '');
  return JSON.stringify(out);
}
