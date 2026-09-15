/**
 * Every note in one folder, without its body.
 *
 * `argv[0]` is a folder id. Properties are read in **bulk** —
 * `folder.notes.name()` is one Apple event for the whole folder, where a loop
 * calling `note.name()` is one per note — so enumeration stays fast and only
 * fetching bodies is slow. That split is what makes a progress bar honest:
 * the total is known before the expensive part starts.
 *
 * Dates come back as `Date`s and serialise as ISO 8601 in UTC, which is what
 * the vault stores.
 */
function run(argv) {
  const notes = Application('Notes');
  const folder = notes.folders.byId(argv[0]);

  const ids = folder.notes.id();
  const names = folder.notes.name();
  const locked = folder.notes.passwordProtected();
  const created = folder.notes.creationDate();
  const modified = folder.notes.modificationDate();

  const out = ids.map((id, i) => ({
    id,
    name: names[i] ?? '',
    locked: locked[i] === true,
    created: created[i] ? created[i].toISOString() : null,
    modified: modified[i] ? modified[i].toISOString() : null,
  }));
  return JSON.stringify(out);
}
