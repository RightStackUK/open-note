import MiniSearch from 'minisearch';

import { type ParsedNote, parseNote, type Todo } from './parse';

export interface IndexedNote extends ParsedNote {
  path: string;
  /** Lowercase basename without extension, for link resolution. */
  slug: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  /** A short excerpt around the first match, for the result list. */
  snippet: string;
}

export interface Backlink {
  /** The note containing the link. */
  from: string;
  fromTitle: string;
  alias: string | null;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TodoItem extends Todo {
  path: string;
  noteTitle: string;
}

const MD_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

function slugOf(path: string): string {
  return path
    .slice(path.lastIndexOf('/') + 1)
    .replace(MD_EXTENSION, '')
    .toLowerCase();
}

/**
 * An in-memory index of every note in a vault.
 *
 * MiniSearch is used rather than SQLite FTS because a personal vault is
 * thousands of notes, not millions, and keeping the index in memory avoids a
 * schema to migrate. The roadmap has the SQLite move waiting if vaults outgrow
 * this.
 */
export class VaultIndex {
  private notes = new Map<string, IndexedNote>();
  /** Lowercase slug to the paths that share it, for link resolution. */
  private bySlug = new Map<string, Set<string>>();
  private search: MiniSearch<{
    id: string;
    title: string;
    body: string;
    tags: string;
    path: string;
  }>;

  constructor() {
    this.search = new MiniSearch({
      fields: ['title', 'body', 'tags', 'path'],
      storeFields: ['title'],
      searchOptions: {
        // A title match should beat a passing mention in the body.
        boost: { title: 4, tags: 2, path: 1.5 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
  }

  get size(): number {
    return this.notes.size;
  }

  paths(): string[] {
    return [...this.notes.keys()];
  }

  get(path: string): IndexedNote | undefined {
    return this.notes.get(path);
  }

  /** Add or replace a note. */
  put(path: string, source: string) {
    if (this.notes.has(path)) this.remove(path);

    const parsed = parseNote(path, source);
    const note: IndexedNote = { ...parsed, path, slug: slugOf(path) };
    this.notes.set(path, note);

    const existing = this.bySlug.get(note.slug) ?? new Set<string>();
    existing.add(path);
    this.bySlug.set(note.slug, existing);

    this.search.add({
      id: path,
      title: note.title,
      body: note.plain,
      tags: note.tags.join(' '),
      path,
    });
  }

  remove(path: string) {
    const note = this.notes.get(path);
    if (!note) return;
    this.notes.delete(path);

    const slugged = this.bySlug.get(note.slug);
    if (slugged) {
      slugged.delete(path);
      if (slugged.size === 0) this.bySlug.delete(note.slug);
    }
    this.search.discard(path);
  }

  clear() {
    this.notes.clear();
    this.bySlug.clear();
    this.search.removeAll();
  }

  /**
   * Resolve a `[[wikilink]]` target to a note path.
   *
   * Tries the literal path first, then a unique basename match. An ambiguous
   * basename resolves to nothing rather than guessing, because silently linking
   * to the wrong note is worse than showing the link as unresolved.
   */
  resolveLink(target: string): string | null {
    const cleaned = target.trim().replace(/^\.\//, '');
    if (!cleaned) return null;

    if (this.notes.has(cleaned)) return cleaned;
    const withExtension = MD_EXTENSION.test(cleaned) ? cleaned : `${cleaned}.md`;
    if (this.notes.has(withExtension)) return withExtension;

    // Case-insensitive full-path match.
    const lowered = withExtension.toLowerCase();
    for (const path of this.notes.keys()) {
      if (path.toLowerCase() === lowered) return path;
    }

    const candidates = this.bySlug.get(slugOf(withExtension));
    if (candidates?.size === 1) return [...candidates][0] ?? null;
    return null;
  }

  /** Notes that link to `path`. */
  backlinks(path: string): Backlink[] {
    const links: Backlink[] = [];
    for (const note of this.notes.values()) {
      if (note.path === path) continue;
      for (const link of note.links) {
        if (this.resolveLink(link.target) === path) {
          links.push({ from: note.path, fromTitle: note.title, alias: link.alias });
          break;
        }
      }
    }
    return links.sort((a, b) => a.fromTitle.localeCompare(b.fromTitle));
  }

  /** Link targets that do not resolve to any note, with who points at them. */
  unresolvedLinks(): Array<{ target: string; from: string[] }> {
    const map = new Map<string, string[]>();
    for (const note of this.notes.values()) {
      for (const link of note.links) {
        if (this.resolveLink(link.target)) continue;
        const list = map.get(link.target) ?? [];
        if (!list.includes(note.path)) list.push(note.path);
        map.set(link.target, list);
      }
    }
    return [...map.entries()]
      .map(([target, from]) => ({ target, from }))
      .sort((a, b) => a.target.localeCompare(b.target));
  }

  /** Every tag in the vault, most used first. */
  tags(): TagCount[] {
    const counts = new Map<string, number>();
    for (const note of this.notes.values()) {
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  notesWithTag(tag: string): string[] {
    const wanted = tag.toLowerCase();
    return [...this.notes.values()]
      .filter((n) => n.tags.some((t) => t.toLowerCase() === wanted))
      .map((n) => n.path)
      .sort();
  }

  /**
   * Every task in the vault.
   *
   * Sorted the way someone triaging work would want them: open before done,
   * then by due date with undated last, then by priority.
   */
  todos(): TodoItem[] {
    const items: TodoItem[] = [];
    for (const note of this.notes.values()) {
      for (const todo of note.todos) {
        items.push({ ...todo, path: note.path, noteTitle: note.title });
      }
    }

    const priorityRank = { high: 0, med: 1, low: 2 } as const;
    return items.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.due !== b.due) {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due.localeCompare(b.due);
      }
      const ap = a.priority ? priorityRank[a.priority] : 3;
      const bp = b.priority ? priorityRank[b.priority] : 3;
      if (ap !== bp) return ap - bp;
      return a.path.localeCompare(b.path);
    });
  }

  query(text: string, limit = 30): SearchHit[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    return this.search
      .search(trimmed)
      .slice(0, limit)
      .map((result) => {
        const note = this.notes.get(result.id as string);
        return {
          path: result.id as string,
          title: (result.title as string) ?? result.id,
          score: result.score,
          snippet: note ? snippetFor(note.plain, trimmed) : '',
        };
      });
  }

  /**
   * Fuzzy match over paths and titles, for the quick switcher.
   *
   * Separate from `query` because jumping to a note by name is a different job
   * from searching its contents, and mixing them makes both worse.
   */
  quickSwitch(text: string, limit = 20): Array<{ path: string; title: string }> {
    const all = [...this.notes.values()];
    const trimmed = text.trim().toLowerCase();
    if (!trimmed) {
      return all
        .slice(0, limit)
        .map((n) => ({ path: n.path, title: n.title }))
        .sort((a, b) => a.title.localeCompare(b.title));
    }

    const scored: Array<{ path: string; title: string; score: number }> = [];
    for (const note of all) {
      const score = Math.max(
        fuzzyScore(note.title.toLowerCase(), trimmed),
        fuzzyScore(note.path.toLowerCase(), trimmed),
      );
      if (score > 0) scored.push({ path: note.path, title: note.title, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit)
      .map(({ path, title }) => ({ path, title }));
  }
}

/**
 * Subsequence match, scoring contiguous runs and word starts higher.
 *
 * Returns 0 when `needle` is not a subsequence of `haystack` at all.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  if (haystack.includes(needle)) {
    // A literal substring always beats a scattered subsequence.
    return 1000 + (haystack.startsWith(needle) ? 500 : 0) - haystack.length;
  }

  let score = 0;
  let index = 0;
  let previous = -1;
  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found === -1) return 0;
    score += 10;
    if (found === previous + 1) score += 8;
    if (found === 0 || ' /-_.'.includes(haystack[found - 1] ?? '')) score += 6;
    previous = found;
    index = found + 1;
  }
  return score;
}

/** A window of text around the first occurrence of any query word. */
export function snippetFor(text: string, query: string, width = 140): string {
  if (!text) return '';
  const lowered = text.toLowerCase();
  let at = -1;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    at = lowered.indexOf(word);
    if (at !== -1) break;
  }
  if (at === -1) return text.slice(0, width) + (text.length > width ? '…' : '');

  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
