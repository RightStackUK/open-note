/**
 * Note statistics, templates, and the archive rule — the lifecycle helpers
 * Block 9 hangs off. All pure functions, tested here, drawn by the app.
 */

import { maskCode, toPlainText } from './parse';

export interface NoteStats {
  words: number;
  characters: number;
  paragraphs: number;
  /** Estimated reading time in whole minutes, never below one. */
  readMinutes: number;
}

/**
 * Statistics over a note body.
 *
 * Words and characters count the prose (markup stripped); paragraphs come from
 * the body's own blank lines — the plain text has its whitespace collapsed, so
 * counting paragraphs there always says one.
 */
export function noteStats(body: string): NoteStats {
  const plain = toPlainText(body);
  const words = plain.split(/\s+/).filter(Boolean).length;
  // ~220 wpm is the usual middle of the published range for prose.
  return {
    words,
    characters: plain.replace(/\s/g, '').length,
    paragraphs: body
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean).length,
    readMinutes: Math.max(1, Math.round(words / 220)),
  };
}

/**
 * Fill a template's placeholders: `{{title}}`, `{{date}}`, `{{time}}`.
 *
 * The vocabulary is issue #4's, deliberately small. Unknown placeholders stay
 * exactly as written — swallowing them would hide typos, and another tool's
 * `{{mustache}}` syntax passing through unchanged is correct behaviour.
 */
export function renderTemplate(source: string, values: { title: string; now?: Date }): string {
  const now = values.now ?? new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // One pass with a function replacer: a title of `{{date}}` — or one carrying
  // `$&` — must land literally, not be re-substituted or re-interpreted.
  return source.replace(/\{\{\s*(title|date|time)\s*\}\}/gi, (_whole, key: string) => {
    switch (key.toLowerCase()) {
      case 'title':
        return values.title;
      case 'date':
        return date;
      default:
        return time;
    }
  });
}

/** Where templates live. Fixed, per issue #4: a folder is the whole design. */
export const TEMPLATES_FOLDER = 'templates';

export function isTemplatePath(path: string): boolean {
  return path === TEMPLATES_FOLDER || path.startsWith(`${TEMPLATES_FOLDER}/`);
}

/**
 * Whether a path sits in the archive.
 *
 * An `archive/` folder and not a hidden flag: moving the file is visible in
 * the tree, on github.com, and in the commit — invisible metadata that hides
 * notes is what principle 1 forbids.
 */
export function isArchivedPath(path: string, archiveFolder: string): boolean {
  const folder = archiveFolder.trim().replace(/^\/+|\/+$/g, '');
  if (!folder) return false;
  return path === folder || path.startsWith(`${folder}/`);
}

/** The archive destination for a note, keeping its name. */
export function archivePathFor(path: string, archiveFolder: string): string {
  const folder = archiveFolder.trim().replace(/^\/+|\/+$/g, '') || 'archive';
  const name = path.slice(path.lastIndexOf('/') + 1);
  return `${folder}/${name}`;
}

/**
 * Merge notes into one document: an H1 per source, contents demoted under it
 * never losing structure — an H1 inside a source becomes an H2, and so on,
 * capped at H6.
 */
export function mergeNotes(notes: Array<{ title: string; body: string }>): string {
  const sections = notes.map(({ title, body }) => {
    // Demote against the masked text, so a `# comment` in a code fence stays
    // exactly what it was.
    const masked = maskCode(body);
    const bodyLines = body.split('\n');
    const maskedLines = masked.split('\n');
    const demoted = bodyLines
      .map((line, i) => {
        const match = /^(#{1,6})(\s)/.exec(maskedLines[i] ?? '');
        if (!match) return line;
        const hashes = match[1] ?? '#';
        return `#${hashes}`.slice(0, 6) + line.slice(hashes.length);
      })
      .join('\n')
      .trim();
    return `# ${title}\n\n${demoted}`.trim();
  });
  return `${sections.join('\n\n---\n\n')}\n`;
}
