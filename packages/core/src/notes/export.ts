import { marked } from 'marked';

import { splitFrontmatter } from './parse';

export interface ExportOptions {
  title: string;
  /** Resolve a local image reference to a data URL, or null to leave it out. */
  resolveImage?: (path: string) => Promise<string | null>;
  /**
   * Resolve a `[[wikilink]]` target to an href — typically the relative HTML
   * file exported beside this one. Without it, links flatten to their text:
   * an export of one note has nothing for them to point at, but an export of
   * a folder does, and dead ends there would make the export a maze.
   */
  resolveWikiLink?: (target: string) => string | null;
}

/** Minimal, readable styling — this has to stand on its own outside the app. */
const STYLES = `
  :root { color-scheme: light dark; }
  body {
    max-width: 46rem;
    margin: 3rem auto;
    padding: 0 1.5rem;
    font-family: ui-serif, Charter, Georgia, Cambria, serif;
    font-size: 17px;
    line-height: 1.7;
    color: #1c1b19;
    background: #fbfaf8;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: ui-sans-serif, system-ui, sans-serif;
    line-height: 1.3;
    letter-spacing: -0.015em;
  }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  pre { padding: 0.9rem; border-radius: 7px; background: #ece8e1; overflow-x: auto; }
  code { background: #ece8e1; border-radius: 3px; padding: 0.1em 0.3em; }
  pre code { background: none; padding: 0; }
  blockquote {
    margin: 0; padding-left: 1rem;
    border-left: 3px solid #e2ded7; color: #6f6b66; font-style: italic;
  }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #e2ded7; padding: 0.35rem 0.6rem; }
  a { color: #c2410c; }
  ul.contains-task-list { list-style: none; padding-left: 1.2rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #eae7e2; background: #171614; }
    pre, code { background: #26241f; }
    blockquote { border-color: #302e2a; color: #8b857e; }
    th, td { border-color: #302e2a; }
    a { color: #fb923c; }
  }
  /* Print is a first-class output: ink on paper, no dark scheme, no cropped code. */
  @media print {
    body { max-width: none; margin: 0; color: #000; background: #fff; }
    pre { white-space: pre-wrap; }
    a { color: inherit; }
    section { break-inside: avoid-page; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a note to a self-contained HTML page.
 *
 * Self-contained is the point: an export with a broken image, or one that only
 * works next to the vault, is not really an export. Images are inlined as data
 * URLs and `[[wikilinks]]` become plain text, since there is nothing for them to
 * point at outside the app.
 */
export async function exportNoteToHtml(source: string, options: ExportOptions): Promise<string> {
  const html = await renderNoteBody(source, options);
  return htmlPage(options.title, html);
}

/**
 * The body of a note as HTML, without the page shell.
 *
 * Shared by the file export, Copy as HTML/rich text, and the print path — one
 * renderer, several outputs, exactly so they can never disagree about what a
 * note looks like.
 */
export async function renderNoteBody(source: string, options: ExportOptions): Promise<string> {
  const { body } = splitFrontmatter(source);

  // A wikilink becomes a link when the caller can say where it goes, and its
  // text when it cannot — outside the vault there is nothing to point at.
  const withoutWikiLinks = body.replace(
    /\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|([^\]\n]+))?\]\]/g,
    (_whole, target: string, alias: string | undefined) => {
      const text = alias ?? target;
      const href = options.resolveWikiLink?.(target.trim()) ?? null;
      if (!href) return text;
      // Per-segment encoding, because `#` and `?` are legal in note names and
      // `encodeURI` would leave them structural — `C# Notes.html` must not
      // become a fragment. A `#anchor` href from a merged export is already
      // structural and passes through whole.
      const encoded = href.startsWith('#')
        ? `#${encodeURIComponent(href.slice(1))}`
        : href.split('/').map(encodeURIComponent).join('/');
      return `[${text}](${encoded})`;
    },
  );

  let html = await marked.parse(withoutWikiLinks, { async: true, gfm: true });

  if (options.resolveImage) {
    const sources = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)]
      .map((match) => match[1] ?? '')
      .filter((src) => src && !/^(https?:|data:)/i.test(src));

    for (const src of [...new Set(sources)]) {
      const dataUrl = await options.resolveImage(decodeURIComponent(src));
      if (!dataUrl) continue;
      html = html.split(`src="${src}"`).join(`src="${dataUrl}"`);
    }
  }

  return html;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}</body>
</html>
`;
}

/**
 * Merge several notes into one page, in the order given — which the caller
 * makes tree order. Each note gets an `id` anchor so wikilinks between the
 * merged notes stay meaningful inside the single file.
 */
export async function exportNotesToHtml(
  notes: Array<{
    title: string;
    source: string;
    anchor: string;
    /** Per note, because relative image references resolve against *its* folder. */
    resolveImage?: ExportOptions['resolveImage'];
  }>,
  options: Omit<ExportOptions, 'title' | 'resolveImage'> & { title: string },
): Promise<string> {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    // Anchors must be unique or links jump to whichever twin renders first.
    let anchor = note.anchor;
    for (let n = 2; seen.has(anchor); n++) anchor = `${note.anchor}-${n}`;
    seen.add(anchor);

    const body = await renderNoteBody(note.source, { ...options, resolveImage: note.resolveImage });
    sections.push(
      `<section id="${escapeHtml(anchor)}">\n<h1>${escapeHtml(note.title)}</h1>\n${body}</section>`,
    );
  }
  return htmlPage(options.title, sections.join('\n<hr>\n'));
}

/** The anchor a note gets inside a merged export. */
export function exportAnchor(path: string): string {
  return path
    .replace(/\.(md|markdown|mdown|mkd)$/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** The file name a note gets when exported beside its neighbours. */
export function exportFileName(path: string, extension: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|markdown|mdown|mkd)$/i, '');
  return `${base}.${extension}`;
}
