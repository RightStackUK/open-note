/**
 * Evernote's export format, on the side of it that is a pure function.
 *
 * The scanning itself lives in Rust, because a ten-year archive is a
 * multi-gigabyte file of base64 and reading it into one string is not an
 * option. What remains here is everything that decides what the note *says* —
 * its dates, its folder, and the shape the shared pipeline consumes — so it
 * can be tested against fixtures rather than against a file.
 */

import { sanitiseSegment } from './names';
import type { SourceNote } from './pipeline';

/** A note exactly as the reader found it, dates still in Evernote's spelling. */
export interface EnexNote {
  title: string;
  /** The `<en-note>` XHTML body. */
  content: string;
  /** `20240115T093000Z`, Evernote's ISO 8601 *basic* format. */
  created: string | null;
  updated: string | null;
  tags: string[];
  sourceUrl: string | null;
  resources: Array<{
    hash: string;
    mime: string;
    fileName: string | null;
    size: number;
  }>;
}

const BASIC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/;

/**
 * `20240115T093000Z` → `2024-01-15T09:30:00Z`.
 *
 * The extended spelling is what every other date in the app is written in, and
 * what a reader of the frontmatter expects. Anything that does not match is
 * returned as null rather than guessed at: a wrong creation date is worse than
 * an absent one, because it is the only record of when the note was written —
 * git will say it was written today.
 */
export function enexTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = BASIC.exec(raw.trim());
  if (!match) {
    // Some exporters write the extended form already; keep it if it parses.
    const parsed = Date.parse(raw.trim());
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/**
 * The folder a notebook's notes land in.
 *
 * One `.enex` file is one notebook, and the file's own name is the only record
 * of which — Evernote does not write the notebook name inside the export.
 */
export function enexFolderName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  return sanitiseSegment(base.replace(/\.enex$/i, ''), 'Evernote');
}

/** Adapt a scanned note to what the shared pipeline consumes. */
export function enexSourceNote(raw: EnexNote): SourceNote {
  return {
    title: raw.title.trim(),
    html: raw.content,
    tags: raw.tags.map((tag) => tag.trim()).filter(Boolean),
    created: enexTimestamp(raw.created),
    updated: enexTimestamp(raw.updated),
    sourceUrl: raw.sourceUrl?.trim() || null,
    resources: raw.resources.map((resource) => ({
      hash: resource.hash.toLowerCase(),
      mime: resource.mime,
      fileName: resource.fileName,
      size: resource.size,
    })),
  };
}
