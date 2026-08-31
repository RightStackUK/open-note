import { marked } from 'marked';

import { splitFrontmatter } from './parse';

export interface ExportOptions {
  title: string;
  /** Resolve a local image reference to a data URL, or null to leave it out. */
  resolveImage?: (path: string) => Promise<string | null>;
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
  const { body } = splitFrontmatter(source);

  // Wikilinks have no meaning outside the vault; show the text they carried.
  const withoutWikiLinks = body.replace(
    /\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|([^\]\n]+))?\]\]/g,
    (_whole, target: string, alias: string | undefined) => alias ?? target,
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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style>
</head>
<body>
${html}</body>
</html>
`;
}
