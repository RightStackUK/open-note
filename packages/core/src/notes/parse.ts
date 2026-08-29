import { parse as parseYaml } from 'yaml';

/**
 * Note parsing.
 *
 * Everything here reads plain Markdown and invents no storage format of its own.
 * Tags are `#tag`, links are `[[wikilinks]]`, todos are GFM task lists. A note
 * written in Open Note must still render correctly on github.com.
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  /** Where the body starts, so offsets into `body` can be mapped back. */
  bodyOffset: number;
  body: string;
}

export interface WikiLink {
  /** The vault-relative-ish target, without extension or alias. */
  target: string;
  /** Display text, when the link used `[[target|alias]]`. */
  alias: string | null;
  /** A `#heading` fragment, when present. */
  heading: string | null;
}

export type TodoPriority = 'low' | 'med' | 'high';

export interface Todo {
  done: boolean;
  /** The task text with metadata tokens removed. */
  text: string;
  /** Raw line, so the UI can rewrite exactly what it found. */
  raw: string;
  /** 1-based line number within the file. */
  line: number;
  due: string | null;
  priority: TodoPriority | null;
  tags: string[];
  people: string[];
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedNote {
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  links: WikiLink[];
  todos: Todo[];
  headings: Heading[];
  /** Body text with markup stripped, for indexing. */
  plain: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Split YAML frontmatter from the body.
 *
 * Malformed YAML yields empty data rather than throwing: a note with a broken
 * header must still open and still be searchable.
 */
export function splitFrontmatter(source: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { data: {}, bodyOffset: 0, body: source };

  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Leave data empty; the body is what matters.
  }

  const bodyOffset = match[0].length;
  return { data, bodyOffset, body: source.slice(bodyOffset) };
}

/** Regions we must not scan for tags or links: code must stay literal. */
function maskCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

const TAG_RE = /(^|[\s(\[{])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
const LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * Tags written inline in the body.
 *
 * A `#` only starts a tag at the beginning of a line or after whitespace or an
 * opening bracket, so `https://example.com/#anchor` and `C#` in prose do not
 * become tags.
 */
export function extractTags(body: string): string[] {
  const masked = maskCode(body);
  const found = new Set<string>();
  for (const match of masked.matchAll(TAG_RE)) {
    const tag = match[2];
    // A bare number is a heading-ish false positive, not a tag.
    if (tag && !/^\d+$/.test(tag)) found.add(tag);
  }
  return [...found];
}

export function extractLinks(body: string): WikiLink[] {
  const masked = maskCode(body);
  const links: WikiLink[] = [];
  const seen = new Set<string>();
  for (const match of masked.matchAll(LINK_RE)) {
    const target = (match[1] ?? '').trim();
    if (!target) continue;
    const heading = match[2]?.trim() ?? null;
    const alias = match[3]?.trim() ?? null;
    const key = `${target}#${heading ?? ''}|${alias ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ target, alias, heading });
  }
  return links;
}

const TODO_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const DUE_RE = /(?:^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const PRIO_RE = /(?:^|\s)prio:(low|med|high)(?=\s|$)/i;
const PERSON_RE = /(?:^|\s)@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;

/**
 * GFM task lists, with the optional trailing metadata described in the roadmap.
 *
 * Every token is optional and unknown tokens are left in the text, so a todo
 * written by hand — or by another app — still parses.
 */
export function extractTodos(body: string, lineOffset = 0): Todo[] {
  const todos: Todo[] = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const match = TODO_RE.exec(raw);
    if (!match) continue;

    const done = (match[2] ?? ' ').toLowerCase() === 'x';
    let text = match[3] ?? '';

    const due = DUE_RE.exec(text)?.[1] ?? null;
    if (due) text = text.replace(DUE_RE, ' ');

    const prio = PRIO_RE.exec(text)?.[1]?.toLowerCase() ?? null;
    if (prio) text = text.replace(PRIO_RE, ' ');

    const tags = extractTags(text);
    const people = [...text.matchAll(PERSON_RE)].map((m) => m[1] ?? '').filter(Boolean);

    text = text
      .replace(TAG_RE, (_m, lead: string) => lead)
      .replace(PERSON_RE, '')
      .replace(/\s+/g, ' ')
      .trim();

    todos.push({
      done,
      text,
      raw,
      line: lineOffset + i + 1,
      due,
      priority: prio as TodoPriority | null,
      tags,
      people,
    });
  }

  return todos;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function extractHeadings(body: string, lineOffset = 0): Heading[] {
  const headings: Heading[] = [];
  const masked = maskCode(body).split('\n');
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Skip anything the mask blanked out — a `#` inside a fenced block is code.
    if ((masked[i] ?? '').trim() === '' && (lines[i] ?? '').trim() !== '') continue;
    const match = HEADING_RE.exec(lines[i] ?? '');
    if (!match) continue;
    headings.push({
      level: (match[1] ?? '#').length,
      text: (match[2] ?? '').trim(),
      line: lineOffset + i + 1,
    });
  }
  return headings;
}

/** Strip Markdown down to prose, for the search index. */
export function toPlainText(body: string): string {
  return maskCode(body)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a || t)
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The note's display title.
 *
 * Frontmatter `title` wins, then the first heading, then the filename — the
 * order a reader would expect.
 */
export function noteTitle(
  path: string,
  frontmatter: Record<string, unknown>,
  headings: Heading[],
): string {
  const fromMatter = frontmatter.title;
  if (typeof fromMatter === 'string' && fromMatter.trim()) return fromMatter.trim();
  const first = headings[0];
  if (first?.text) return first.text;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.(md|markdown|mdown|mkd)$/i, '');
}

/** Tags declared in frontmatter, as a string or a list. */
function frontmatterTags(data: Record<string, unknown>): string[] {
  const raw = data.tags ?? data.tag;
  if (typeof raw === 'string') {
    return raw
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
  }
  return [];
}

export function parseNote(path: string, source: string): ParsedNote {
  const { data, body } = splitFrontmatter(source);
  // Frontmatter occupies whole lines, so todo and heading line numbers must be
  // shifted back to the real file.
  const consumed = source.slice(0, source.length - body.length);
  const lineOffset = consumed === '' ? 0 : consumed.split('\n').length - 1;

  const headings = extractHeadings(body, lineOffset);
  const tags = [...new Set([...frontmatterTags(data), ...extractTags(body)])];

  return {
    title: noteTitle(path, data, headings),
    frontmatter: data,
    tags,
    links: extractLinks(body),
    todos: extractTodos(body, lineOffset),
    headings,
    plain: toPlainText(body),
  };
}
