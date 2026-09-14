/**
 * A note's permanent identity, for links other apps can hold onto.
 *
 * `[[wikilinks]]` resolve by path and are rewritten when a note is renamed, so
 * inside the vault nothing needs an id. What cannot be rewritten is a link that
 * has left — pasted into a ticket, a calendar entry, another app — and that is
 * the whole of what this exists for.
 *
 * So an id is written **only when someone copies such a link**. A vault
 * accumulates this bookkeeping for the handful of notes that were linked to
 * from outside and for no others, which is as close to principle 1 as a durable
 * external link can get: the files are still the product, and the ones nobody
 * linked stay exactly as the writer left them.
 *
 * The id is 24 lowercase hex characters — 96 bits, which makes a collision
 * across every note anyone will ever write vanishingly unlikely. Hex rather
 * than base64url because a value beginning with `-` is ambiguous in YAML and a
 * quoted id would invite someone to edit the quotes off.
 */

/** The frontmatter key. Chosen for brevity; it is read by nothing else. */
export const NOTE_ID_KEY = 'id';

const ID_RE = /^[0-9a-f]{24}$/;
const ID_BYTES = 12;

/**
 * Mint an id.
 *
 * `random` is injected for tests only; the default is the platform CSPRNG,
 * because a predictable id would let one vault's link resolve in another.
 */
export function newNoteId(random?: (bytes: Uint8Array) => void): string {
  const buffer = new Uint8Array(ID_BYTES);
  if (random) random(buffer);
  else crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isNoteId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * The id a note carries, if it carries a usable one.
 *
 * Anything that is not a well-formed id is treated as absent: the field is
 * hand-editable like the rest of the frontmatter, and half an id is not an
 * identity. A number is the likely accident — `id: 42` parses as one — and
 * resolving that to a note would be worse than not resolving it.
 */
export function noteIdOf(frontmatter: Record<string, unknown>): string | null {
  const raw = frontmatter[NOTE_ID_KEY];
  return isNoteId(raw) ? raw : null;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Whatever this file already uses, so writing an id does not change the rest. */
function newlineOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Write `id` into a note's frontmatter, byte-for-byte otherwise.
 *
 * The existing block is edited as *text* rather than parsed and re-serialised:
 * a YAML round-trip would reorder keys, restyle quotes and drop comments, and
 * the diff of "we copied a link" must not be a rewrite of the reader's own
 * file. A note with no frontmatter gains the smallest possible block.
 *
 * Idempotent: a note that already carries this id is returned unchanged.
 */
export function withNoteId(source: string, id: string): string {
  const match = FRONTMATTER_RE.exec(source);
  const nl = newlineOf(source);

  if (!match) {
    return `---${nl}${NOTE_ID_KEY}: ${id}${nl}---${nl}${nl}${source}`;
  }

  const block = match[1] ?? '';
  const existing = new RegExp(`^${NOTE_ID_KEY}\\s*:.*$`, 'm');
  const line = `${NOTE_ID_KEY}: ${id}`;
  const nextBlock = existing.test(block)
    ? block.replace(existing, line)
    : `${block}${block.endsWith(nl) || block === '' ? '' : nl}${line}`;

  const opening = `---${nl}`;
  const closing = match[0].slice(match[0].indexOf(`${nl}---`));
  return `${opening}${nextBlock}${closing}${source.slice(match[0].length)}`;
}

/**
 * Strip a note's id.
 *
 * For every path that copies a file's *text* into a new note — duplicating one,
 * creating one from a template. Two notes with one id is an identity that
 * resolves to whichever the index reached first, which is the kind of bug that
 * looks like the app losing a note.
 */
export function withoutNoteId(source: string): string {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return source;

  const block = match[1] ?? '';
  const nl = newlineOf(source);
  const kept = block
    .split(/\r?\n/)
    .filter((line) => !new RegExp(`^${NOTE_ID_KEY}\\s*:`).test(line));

  // A block that held nothing but the id goes entirely, rather than being left
  // as an empty `---` sandwich for the reader to wonder about. The blank line
  // that separated it from the body goes with it — one, not every one, so a
  // deliberate gap at the top of a note survives.
  if (kept.filter((line) => line.trim()).length === 0) {
    return source.slice(match[0].length).replace(/^\r?\n/, '');
  }
  return `---${nl}${kept.join(nl)}${nl}---${match[0].slice(match[0].lastIndexOf('---') + 3)}${source.slice(match[0].length)}`;
}

/**
 * The link to put on the clipboard.
 *
 * It carries the vault as well as the id: the app can have several open, and an
 * id is only unique within the vault that minted it. The receiving window
 * refuses a vault it has never opened, so the path is not a capability.
 */
export function noteLink(vaultRoot: string, id: string): string {
  return `opennote://open?vault=${encodeURIComponent(vaultRoot)}&id=${id}`;
}
