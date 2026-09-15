/**
 * The seam every importer shares.
 *
 * Importing from an app that already keeps notes as Markdown files is
 * `vault.importFolder`, and that is the cheap half. The expensive half is the
 * apps that do not — Evernote, Notion, Apple Notes, OneNote — and each of
 * those needs its own reader. What none of them may have is its own idea of
 * how a note becomes a file, because four ideas would mean four ways a vault
 * can be laid out and three of them would be discovered later.
 *
 * So a reader's whole job is to produce {@link SourceNote}s — a title, a body
 * as HTML, tags, dates, and resources identified by content hash — and this
 * module decides everything after that: the filename ({@link NameAllocator}),
 * where the attachments go (`attachmentFolderFor`, which reads the vault's own
 * setting rather than hard-coding `assets/`), the Markdown dialect
 * (`htmlToMarkdown`, extended rather than forked) and the frontmatter.
 *
 * Nothing here touches a filesystem: a plan is a value, which is what lets the
 * hard cases be tested against fixtures instead of against a vault.
 */

import { htmlToMarkdown } from '../notes/htmlToMarkdown';
import { relativeFrom } from '../notes/paths';
import { attachmentFolderFor } from '../sync/settings';
import { NameAllocator, sanitiseSegment, splitExtension } from './names';

/** A file carried alongside a note, named by the hash of its bytes. */
export interface SourceResource {
  /** Lowercase hex MD5 of the decoded bytes — how the body references it. */
  hash: string;
  mime: string;
  /** The name it had in the source app, if it had one. */
  fileName: string | null;
  size: number;
}

/** One note as the reader found it, before any decision about files. */
export interface SourceNote {
  title: string;
  /** The body. Every source worth importing from stores this as HTML. */
  html: string;
  tags: string[];
  /** ISO 8601, or null when the source did not record one. */
  created: string | null;
  updated: string | null;
  /** The page it was clipped from, when the source kept that. */
  sourceUrl: string | null;
  resources: SourceResource[];
}

export interface PlannedAsset {
  hash: string;
  /** Vault-relative. */
  path: string;
}

/**
 * An attachment whose bytes arrived *inside* the body, as a data URL.
 *
 * Two shapes are needed because the two sources differ in where the bytes
 * live. Evernote names a resource by hash and keeps the bytes in the file, so
 * only the path is decided here and Rust writes from what it already holds
 * ({@link PlannedAsset}). Apple Notes cannot hand over an attachment at all,
 * but inlines images into the body — so the payload comes through here and the
 * caller writes it.
 */
export interface InlineAsset {
  /** Vault-relative. */
  path: string;
  /** Base64, exactly as the data URL carried it. */
  base64: string;
}

/** Something the import could not carry across, named so it can be reported. */
export interface ImportWarning {
  /** The note it happened in, as the user will recognise it. */
  note: string;
  reason: string;
}

export interface PlannedNote {
  /** Vault-relative path for the note. */
  path: string;
  markdown: string;
  /** Every resource of the note, deduplicated by hash. */
  assets: PlannedAsset[];
  /** Images the body carried inline, for the caller to write. */
  inline: InlineAsset[];
  warnings: ImportWarning[];
}

export interface PlanOptions {
  /** Where the notes go — the notebook's folder, vault-relative. */
  folder: string;
  /** The vault's `attachmentFolder` setting, verbatim. */
  attachmentFolder: string;
  /** Shared across the whole run, and seeded with what the vault already has. */
  names: NameAllocator;
}

/** Enough of the common types to name a file sensibly; the rest keep `bin`. */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

function extensionFor(resource: SourceResource): string {
  const fromName = resource.fileName ? splitExtension(resource.fileName).extension : '';
  if (fromName) return fromName;
  const mime = resource.mime.toLowerCase().split(';')[0]?.trim() ?? '';
  return MIME_EXTENSIONS[mime] ?? 'bin';
}

/**
 * An attachment's stem.
 *
 * Spaces become hyphens, which nothing else in the app needs but every
 * Markdown link does: `![](my file.png)` is not a link in CommonMark, and the
 * alternatives — percent-encoding, or angle brackets — put an escape into a
 * path the user will later see in the tree and type by hand.
 */
function assetStem(resource: SourceResource, fallback: string): string {
  const raw = resource.fileName ? splitExtension(resource.fileName).stem : '';
  return sanitiseSegment(raw || fallback, fallback).replace(/\s+/g, '-');
}

/**
 * Close the gaps in a converted checklist.
 *
 * Evernote writes each line of a note as its own `<div>`, so a checklist
 * converts to task items separated by blank lines. That is a *loose* list:
 * still tasks, but rendered with a paragraph between every item, which is not
 * what the note looked like. Only a blank line directly between two task
 * items is closed, so a deliberate gap elsewhere survives.
 */
function tightenTaskLists(markdown: string): string {
  return markdown.replace(/^(\s*- \[[ xX]\] .*)\n\n(?=\s*- \[[ xX]\] )/gm, '$1\n');
}

/**
 * Tidy the blank space a converted note arrives with.
 *
 * Both sources write a line per block and use empty ones for spacing — Apple
 * Notes especially, where `<div><br></div>` is how a gap is drawn. Turndown
 * renders a `<br>` as two trailing spaces, so those become *lines of
 * whitespace*, and a run of them becomes several blank lines. Neither means
 * anything in Markdown, both show up as noise in the first `git diff` of a
 * freshly imported vault, and many editors strip trailing whitespace on save
 * — which would turn the next edit of any imported note into a whole-file
 * diff.
 *
 * Trailing spaces after real text are left alone: two of those are a hard line
 * break, which is content. And nothing inside a fenced code block is touched,
 * where a blank line is content too.
 */
function tidyBlankLines(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  let blanks = 0;

  for (const line of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;

    if (fenced) {
      out.push(line);
      continue;
    }

    const tidied = line.trim() === '' ? '' : line;
    if (tidied === '') {
      blanks += 1;
      // One blank line separates blocks; more is just the source's spacing.
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(tidied);
  }

  return out.join('\n').trim();
}

function isImage(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/');
}

/**
 * Frontmatter for an imported note.
 *
 * Written by hand rather than through a YAML serialiser because the file is
 * being authored here, not edited: there is no existing block whose key order,
 * quoting and comments have to survive, and hand-writing keeps the header a
 * predictable five lines that a human reads at a glance. Values are quoted
 * only when they would otherwise be ambiguous.
 */
function frontmatter(fields: Array<[string, string | string[]]>): string {
  const lines: string[] = [];
  for (const [key, value] of fields) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${scalar(item)}`);
    } else if (value) {
      lines.push(`${key}: ${scalar(value)}`);
    }
  }
  return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

/** Quote when YAML would otherwise read the value as something other than text. */
function scalar(value: string): string {
  const plain =
    /^[A-Za-z0-9][\w .\-/+@]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value);
  return plain ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Turn one source note into the files it becomes.
 *
 * Resources are deduplicated by hash: a note that embeds the same image twice
 * carries it once, which is also what makes the body's two references resolve
 * to one path.
 */
export function planNote(source: SourceNote, options: PlanOptions): PlannedNote {
  const { names, folder, attachmentFolder } = options;
  const label = source.title.trim() || 'Untitled';

  const notePath = names.take(folder, source.title);
  const assetFolder = attachmentFolderFor(notePath, attachmentFolder);

  // Placed before the body is converted, because the body's links need paths.
  const assets: PlannedAsset[] = [];
  const byHash = new Map<string, { asset: PlannedAsset; resource: SourceResource }>();
  for (const resource of source.resources) {
    const hash = resource.hash.toLowerCase();
    if (!hash || byHash.has(hash)) continue;
    const path = names.take(
      assetFolder,
      assetStem(resource, sanitiseSegment(label, 'attachment')),
      extensionFor(resource),
      'attachment',
    );
    const asset = { hash, path };
    assets.push(asset);
    byHash.set(hash, { asset, resource });
  }

  const warnings: ImportWarning[] = [];
  const referenced = new Set<string>();
  const inline: InlineAsset[] = [];
  let encrypted = 0;

  const body = tidyBlankLines(
    tightenTaskLists(
      htmlToMarkdown(source.html, {
        media: (hash, type) => {
          const found = byHash.get(hash);
          if (!found) {
            // The body references bytes the file did not carry. Saying so is the
            // point: the alternative is a note that quietly lost a picture.
            warnings.push({ note: label, reason: 'an attachment was missing from the export' });
            return null;
          }
          referenced.add(hash);
          const mime = type || found.resource.mime;
          const name = found.resource.fileName ?? found.asset.path.split('/').pop() ?? 'attachment';
          return {
            href: relativeFrom(notePath, found.asset.path),
            text: isImage(mime) ? splitExtension(name).stem : name,
            embed: isImage(mime),
          };
        },
        // An image the body carried itself. Named after the note, numbered in
        // the order it appears, because a data URL says nothing about what the
        // picture was called — and left in the same folder as any other
        // attachment, so one vault setting governs all of them.
        dataUrl: (mime, base64, index) => {
          const stem = sanitiseSegment(label, 'image').replace(/\s+/g, '-');
          const path = names.take(
            assetFolder,
            index === 0 ? stem : `${stem}-${index + 1}`,
            extensionFor({ hash: '', mime, fileName: null, size: 0 }),
            'image',
          );
          inline.push({ path, base64 });
          return { href: relativeFrom(notePath, path), text: stem, embed: true };
        },
        onEncrypted: () => {
          encrypted += 1;
        },
      }) ?? '',
    ),
  );

  if (encrypted > 0) {
    warnings.push({
      note: label,
      reason: `${encrypted} encrypted block${encrypted === 1 ? '' : 's'} could not be decrypted`,
    });
  }

  // A resource the body never referenced is still the note's attachment, and a
  // file written into the vault that nothing links to is a file nobody finds.
  const orphans = assets.filter((asset) => !referenced.has(asset.hash));
  const trailer =
    orphans.length === 0
      ? ''
      : `\n\n## Attachments\n\n${orphans
          .map((asset) => {
            const name = asset.path.split('/').pop() ?? 'attachment';
            const href = relativeFrom(notePath, asset.path);
            const resource = byHash.get(asset.hash)?.resource;
            return resource && isImage(resource.mime)
              ? `- ![${splitExtension(name).stem}](${href})`
              : `- [${name}](${href})`;
          })
          .join('\n')}`;

  // The original title is kept only when the filename could not carry it —
  // sanitised, truncated or given a collision suffix. Repeating a title the
  // filename already states is noise in every note of the import.
  const stem = notePath.slice(notePath.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const header = frontmatter([
    ['title', stem === source.title.trim() ? '' : source.title.trim()],
    ['created', source.created ?? ''],
    ['updated', source.updated ?? ''],
    ['source', source.sourceUrl ?? ''],
    ['tags', [...new Set(source.tags.map((tag) => tag.trim()).filter(Boolean))]],
  ]);

  return { path: notePath, markdown: `${header}${body}${trailer}\n`, assets, inline, warnings };
}

/** What an import did, for the message shown when it finishes. */
export interface ImportSummary {
  notes: number;
  attachments: number;
  warnings: ImportWarning[];
  /** True when the user stopped it part-way. */
  cancelled: boolean;
}

/**
 * The sentence the app reports.
 *
 * Counted rather than listed. An Evernote archive can have hundreds of
 * encrypted notes and an Apple Notes library hundreds of attachments it cannot
 * export, and a sentence that tried to name them all would be a sentence
 * nobody reads. The names matter — they are how the user goes and deals with
 * what was left behind — so the dialog lists them underneath this, and
 * repeating the reasons here only made both harder to read.
 */
export function describeImport(summary: ImportSummary): string {
  const parts = [`${summary.notes} note${summary.notes === 1 ? '' : 's'}`];
  if (summary.attachments > 0) {
    parts.push(`${summary.attachments} attachment${summary.attachments === 1 ? '' : 's'}`);
  }
  const head = `${summary.cancelled ? 'Stopped after importing' : 'Imported'} ${parts.join(' and ')}`;
  if (summary.warnings.length === 0) return `${head}.`;

  const count = summary.warnings.length;
  return `${head}. ${count} thing${count === 1 ? '' : 's'} could not be carried across:`;
}
