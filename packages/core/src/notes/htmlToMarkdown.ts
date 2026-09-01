import TurndownService from 'turndown';
// @ts-expect-error — the gfm plugin ships no types; its surface is one function.
import { gfm } from 'turndown-plugin-gfm';

/**
 * HTML → Markdown, for paste.
 *
 * Configured to produce exactly the dialect the rest of the app writes: ATX
 * headings, `-` bullets, fenced code blocks — so a pasted page reads like a
 * note that was typed here, not like a second dialect living in the file.
 */
let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
    linkStyle: 'inlined',
  });
  // Tables, strikethrough and task lists — the GFM the editor already parses.
  service.use(gfm);
  // Scripts and styles are not content under any conversion.
  service.remove(['script', 'style']);
  return service;
}

/**
 * Convert pasted HTML to Markdown. Returns null when the result carries no
 * text at all, so the caller can fall back to the plain-text flavour rather
 * than inserting an empty string over the selection.
 */
export function htmlToMarkdown(html: string): string | null {
  try {
    const markdown = turndown()
      .turndown(html)
      // Turndown pads list markers to a tab stop (`-   one`); the app writes
      // `- one`, and two dialects in one file is exactly what this avoids.
      .replace(/^([ \t]*(?:[-*+]|\d+\.))[ \t]{2,}/gm, '$1 ')
      .trim();
    return markdown.length > 0 ? markdown : null;
  } catch {
    return null;
  }
}

/** A whole line that is one absolute URL and nothing else. */
const BARE_URL = /^https?:\/\/[^\s]+$/i;

export function isBareUrl(text: string): boolean {
  return BARE_URL.test(text.trim());
}
