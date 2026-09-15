/**
 * The bodies of a batch of notes, by id.
 *
 * `argv[0]` is a JSON array of note ids — a batch rather than the whole
 * selection, so one Apple event stays well inside the 120-second default that
 * JXA cannot extend, and so the import can report progress and stop between
 * batches.
 *
 * A note that will not read is reported as an `error` rather than failing the
 * batch: a locked note is the ordinary case of that, and one unreadable note
 * must not cost the other nine in the batch.
 *
 * Attachments are **names only**, and that is not an oversight. The `attachment`
 * class exposes `name`, `id`, `content identifier` and `URL`, and the only
 * commands Notes scripts are `open note location` and `show` — there is no way
 * to ask for an attachment's bytes. The alternative route, reading
 * `NoteStore.sqlite`, wants Full Disk Access and parses an undocumented gzipped
 * protobuf that Apple changes between releases. So the names come across and
 * the import says so.
 */
function run(argv) {
  const notes = Application('Notes');
  const ids = JSON.parse(argv[0]);
  const out = [];

  for (const id of ids) {
    const record = { id, body: null, attachments: [], error: null };
    try {
      const note = notes.notes.byId(id);
      if (note.passwordProtected()) {
        record.error = 'locked';
      } else {
        record.body = note.body();
      }
      try {
        record.attachments = note.attachments.name().filter((name) => name);
      } catch (e) {
        // A note with no attachments answers with an empty list; anything else
        // here is the attachment API being unhelpful, which is not worth
        // losing the note over.
        record.attachments = [];
      }
    } catch (e) {
      record.error = String(e && e.message ? e.message : e);
    }
    out.push(record);
  }

  return JSON.stringify(out);
}
