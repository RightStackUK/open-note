import TurndownService from 'turndown';
// @ts-expect-error — the gfm plugin ships no types; its surface is one function.
import { gfm } from 'turndown-plugin-gfm';

/**
 * HTML → Markdown, for paste and for import.
 *
 * Configured to produce exactly the dialect the rest of the app writes: ATX
 * headings, `-` bullets, fenced code blocks — so a pasted page reads like a
 * note that was typed here, not like a second dialect living in the file.
 *
 * Every notes app worth importing from stores its bodies as HTML, so this is
 * also the importers' converter. They **extend** it rather than fork it: two
 * converters would mean two dialects, and the difference would show up in the
 * diffs of a vault that was half typed and half imported.
 */

/** Where an imported attachment ended up, as the note should reference it. */
export interface MediaRef {
  /** The link target — note-relative, and free of characters needing escapes. */
  href: string;
  /** Link or alt text. */
  text: string;
  /** Embed it (`![]`) rather than link to it. */
  embed: boolean;
}

export interface HtmlToMarkdownOptions {
  /**
   * Resolve Evernote's `<en-media hash="…">` to a reference.
   *
   * The hash is the MD5 of the resource's decoded bytes — the body never names
   * the file — so only the importer holding the decoded resources can answer
   * this. `null` drops the reference, for a resource the file did not carry.
   */
  media?: (hash: string, mime: string) => MediaRef | null;
  /** Called once per `<en-crypt>` block met, so the caller can report it. */
  onEncrypted?: () => void;
}

/**
 * The options for the conversion in progress.
 *
 * Turndown rules are registered on one long-lived service and receive no
 * context of their own, so the call parameterises them through here. Safe
 * because conversion is synchronous from first to last rule: nothing can
 * interleave, and the value is cleared in a `finally`.
 */
let current: HtmlToMarkdownOptions = {};

/** Whether `node` sits inside a list item, where a marker is already present. */
function insideListItem(node: Node): boolean {
  let parent = node.parentNode;
  while (parent) {
    if (parent.nodeName === 'LI') return true;
    parent = parent.parentNode;
  }
  return false;
}

function attribute(node: Node, name: string): string {
  const element = node as { getAttribute?: (name: string) => string | null };
  return element.getAttribute?.(name) ?? '';
}

function marks(node: Node, name: string): boolean {
  const element = node as { hasAttribute?: (name: string) => boolean };
  return element.hasAttribute?.(name) ?? false;
}

/**
 * Rewrite Evernote's own elements as HTML ones before parsing.
 *
 * Two problems, one pass, and both are silent losses rather than errors:
 *
 * 1. `.enex` bodies are XHTML, where `<en-media …/>` is a complete element.
 *    The HTML parser Turndown runs on does not honour self-closing syntax on
 *    an unknown tag, so a run of them *nests* — and a note with three images
 *    comes out with one.
 * 2. Turndown discards any element whose text content is empty before it
 *    consults a single rule, and `<en-todo/>` and `<en-media/>` are empty by
 *    definition. Worse, it is recursive: a `<div>` holding nothing but an
 *    image is blank too, so a note of photographs converts to nothing at all.
 *
 * Becoming `<input>` and `<img>` — real *void* elements — answers both at
 * once, because a void element is neither nested into by the parser nor
 * considered blank. The Evernote attributes ride along untouched and the
 * rules below read them off. Pasted HTML has none of these tags, so this is a
 * no-op everywhere except an import.
 */
function asHtmlElements(html: string): string {
  return html
    .replace(/<en-todo\b/gi, '<input data-en-todo=""')
    .replace(/<\/en-todo\s*>/gi, '')
    .replace(/<en-media\b/gi, '<img data-en-media=""')
    .replace(/<\/en-media\s*>/gi, '');
}

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

  /**
   * Evernote's checkbox.
   *
   * It sits *inline* at the start of the line rather than wrapping the item,
   * so without this the note silently loses every todo it had. Mapping it onto
   * the GFM checkbox is most of the value of importing for anyone who used
   * Evernote as a todo list, and it is the syntax the app's own task view
   * reads. Registered after the GFM plugin, whose task-list rule would
   * otherwise claim the same element — `addRule` prepends, so this wins.
   */
  service.addRule('en-todo', {
    filter: (node) => marks(node, 'data-en-todo'),
    replacement: (_content, node) => {
      const box = attribute(node, 'checked').toLowerCase() === 'true' ? '[x]' : '[ ]';
      // In a list the marker is already there; adding ours would nest a list
      // inside a list item.
      return insideListItem(node) ? `${box} ` : `- ${box} `;
    },
  });

  /** The body's reference to a resource, by the MD5 of the resource's bytes. */
  service.addRule('en-media', {
    filter: (node) => marks(node, 'data-en-media'),
    replacement: (_content, node) => {
      const resolved = current.media?.(
        attribute(node, 'hash').toLowerCase(),
        attribute(node, 'type').toLowerCase(),
      );
      if (!resolved) return '';
      return resolved.embed
        ? `![${resolved.text}](${resolved.href})`
        : `[${resolved.text}](${resolved.href})`;
    },
  });

  /**
   * An encrypted block cannot be decrypted without the passphrase, which the
   * export does not carry. It leaves a visible marker rather than vanishing:
   * a note that silently lost a paragraph is worse than one that says so.
   */
  service.addRule('en-crypt', {
    filter: (node) => node.nodeName === 'EN-CRYPT',
    replacement: () => {
      current.onEncrypted?.();
      return '*[encrypted in Evernote — not importable]*';
    },
  });

  return service;
}

/**
 * Convert HTML to Markdown. Returns null when the result carries no text at
 * all, so a paste can fall back to the plain-text flavour rather than
 * inserting an empty string over the selection.
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string | null {
  current = options;
  try {
    const markdown = turndown()
      .turndown(asHtmlElements(html))
      // Turndown pads list markers to a tab stop (`-   one`); the app writes
      // `- one`, and two dialects in one file is exactly what this avoids.
      .replace(/^([ \t]*(?:[-*+]|\d+\.))[ \t]{2,}/gm, '$1 ')
      .trim();
    return markdown.length > 0 ? markdown : null;
  } catch {
    return null;
  } finally {
    current = {};
  }
}

/** A whole line that is one absolute URL and nothing else. */
const BARE_URL = /^https?:\/\/[^\s]+$/i;

export function isBareUrl(text: string): boolean {
  return BARE_URL.test(text.trim());
}
