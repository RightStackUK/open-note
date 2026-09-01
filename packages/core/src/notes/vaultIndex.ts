import MiniSearch from 'minisearch';

import { noteHasTag } from './noteList';
import { type ParsedNote, parseNote, type Todo } from './parse';
import { isEmptyQuery, type ParsedQuery, parseSearchQuery } from './searchQuery';

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

/** What the search may be narrowed to, shown in the field so it is no surprise. */
export type SearchScope =
  | { kind: 'folder'; folder: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'untagged' }
  | { kind: 'today' };

export interface QueryOptions {
  scope?: SearchScope;
  /** Path to mtime seconds, for `is:today` and no-term recency ordering. */
  modified?: Map<string, number>;
  /** Injected so `is:today` is testable. */
  now?: Date;
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

  query(text: string, limit = 30, options: QueryOptions = {}): SearchHit[] {
    const parsed = parseSearchQuery(text);
    if (isEmptyQuery(parsed)) return [];

    // Bare terms go through MiniSearch — prefix and fuzzy, as before. With no
    // terms (a pure phrase, filter or scope query) every note is a candidate,
    // because an inverted index cannot answer those alone.
    const termQuery = parsed.terms.join(' ').trim();
    const ranked: Array<{ path: string; score: number }> = termQuery
      ? this.search.search(termQuery).map((r) => ({ path: r.id as string, score: r.score }))
      : [...this.notes.keys()].map((path) => ({ path, score: 0 }));

    const startOfToday = (() => {
      const now = options.now ?? new Date();
      return Math.floor(
        new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000,
      );
    })();

    const hits: SearchHit[] = [];
    const highlight = parsed.phrases[0] ?? termQuery;
    for (const { path, score } of ranked) {
      // With terms the candidates arrive ranked, so the cap is free; without,
      // ordering happens below and cutting early would drop the newest note.
      if (termQuery && hits.length >= limit) break;
      const note = this.notes.get(path);
      if (!note) continue;
      if (!this.matches(note, parsed, options, startOfToday)) continue;

      hits.push({
        path,
        title: note.title,
        score,
        snippet: snippetFor(note.plain, highlight),
      });
    }

    // Without terms there is no relevance score; recency reads best.
    if (!termQuery) {
      const modified = options.modified;
      hits.sort((a, b) =>
        modified
          ? (modified.get(b.path) ?? 0) - (modified.get(a.path) ?? 0)
          : a.title.localeCompare(b.title),
      );
    }
    return hits.slice(0, limit);
  }

  /** Every check past the inverted index: phrases, exclusions, fields, filters, scope. */
  private matches(
    note: IndexedNote,
    parsed: ParsedQuery,
    options: QueryOptions,
    startOfToday: number,
  ): boolean {
    const plain = note.plain.toLowerCase();
    const title = note.title.toLowerCase();

    // Phrases post-filter the stored body: adjacency is not a question an
    // inverted index can answer, and fuzziness stays off inside quotes.
    for (const phrase of parsed.phrases) {
      const needle = phrase.toLowerCase();
      if (!plain.includes(needle) && !title.includes(needle)) return false;
    }
    for (const excluded of parsed.excluded) {
      const needle = excluded.toLowerCase();
      if (excluded.includes(' ')) {
        // An excluded phrase is a substring, symmetric with included phrases.
        if (plain.includes(needle) || title.includes(needle)) return false;
        continue;
      }
      // A single excluded word matches whole words — `-draft` must not
      // disqualify a note for containing "redrafting" — and excluded tags
      // cover their children, like every other tag comparison here.
      const word = mentionPattern(excluded);
      if (word.test(note.plain) || word.test(note.title)) return false;
      if (noteHasTag(note.tags, needle.replace(/^#/, ''), true)) return false;
    }
    for (const wanted of parsed.title) {
      if (!title.includes(wanted.toLowerCase())) return false;
    }
    for (const tag of parsed.tags) {
      if (!noteHasTag(note.tags, tag, true)) return false;
    }

    for (const filter of parsed.filters) {
      const modified = options.modified?.get(note.path) ?? 0;
      switch (filter) {
        case 'is:todo':
          if (!note.todos.some((t) => !t.done)) return false;
          break;
        case 'is:done':
          if (!note.todos.some((t) => t.done)) return false;
          break;
        case 'is:image':
          if (!note.hasImage) return false;
          break;
        case 'is:attachment':
          if (!note.hasAttachments) return false;
          break;
        case 'is:untagged':
          if (note.tags.length > 0) return false;
          break;
        case 'is:today':
          if (modified < startOfToday) return false;
          break;
        case 'has:math':
          if (!note.hasMath) return false;
          break;
      }
    }

    const scope = options.scope;
    if (scope) {
      if (scope.kind === 'folder' && !note.path.startsWith(`${scope.folder}/`)) return false;
      if (scope.kind === 'tag' && !noteHasTag(note.tags, scope.tag, true)) return false;
      if (scope.kind === 'untagged' && note.tags.length > 0) return false;
      if (scope.kind === 'today' && (options.modified?.get(note.path) ?? 0) < startOfToday) {
        return false;
      }
    }

    return true;
  }

  /**
   * Notes whose text mentions `path`'s title without linking to it — the link
   * you forgot to make, which is what actually grows a wiki.
   *
   * Runs over the index's cached plain text and is capped; the caller decides
   * when it is worth asking (the backlinks panel, debounced).
   */
  unlinkedMentions(path: string, limit = 20): Array<{ path: string; title: string }> {
    const note = this.notes.get(path);
    if (!note) return [];
    // A two-letter title would mention itself everywhere; that is noise.
    if (note.title.length < 3) return [];
    // Whole words only: a note titled "Research" is not mentioned by the word
    // "Researcher".
    const needle = mentionPattern(note.title);

    const linked = new Set(this.backlinks(path).map((b) => b.from));
    const mentions: Array<{ path: string; title: string }> = [];
    for (const other of this.notes.values()) {
      if (mentions.length >= limit) break;
      if (other.path === path || linked.has(other.path)) continue;
      if (!needle.test(other.plain)) continue;
      mentions.push({ path: other.path, title: other.title });
    }
    return mentions.sort((a, b) => a.title.localeCompare(b.title));
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

/** A title as a whole-word, case-insensitive pattern — for mentions. */
export function mentionPattern(title: string): RegExp {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
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
