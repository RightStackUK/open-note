/**
 * The search query language: `"exact phrases"`, `-exclusion`, `title:` and
 * `tag:` scoping, and `is:` / `has:` content filters.
 *
 * `is:`/`has:` and not a bare `@`, because `@` is already the assignee token
 * in the todo format and two meanings for one sigil is a bug waiting to
 * happen. The parser is small and it lives here, with tests, because query
 * grammars are exactly the kind of thing that grows subtly wrong branches.
 */

export const CONTENT_FILTERS = [
  'is:todo',
  'is:done',
  'is:image',
  'is:attachment',
  'is:untagged',
  'is:today',
  'has:math',
] as const;

export type ContentFilter = (typeof CONTENT_FILTERS)[number];

export interface ParsedQuery {
  /** Free terms, searched fuzzily — fuzziness is the default for bare words. */
  terms: string[];
  /** Quoted phrases. Exact, case-insensitive, never fuzzy: an exact phrase
   * search that returns approximate matches is not one. */
  phrases: string[];
  /** `-term` and `-"phrase"`: notes containing these are dropped. */
  excluded: string[];
  /** `title:foo` — the title must contain each. */
  title: string[];
  /** `tag:foo` — the note must carry each (children included). */
  tags: string[];
  filters: ContentFilter[];
}

const TOKEN = /(-?)(?:(title|tag):)?"([^"]*)"|(\S+)/g;

export function parseSearchQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = {
    terms: [],
    phrases: [],
    excluded: [],
    title: [],
    tags: [],
    filters: [],
  };

  for (const match of raw.matchAll(TOKEN)) {
    const negated = match[1] === '-';
    const field = match[2]?.toLowerCase();
    const quoted = match[3];
    const word = match[4];

    if (quoted !== undefined) {
      const phrase = quoted.trim();
      if (!phrase) continue;
      // `title:"Quarterly Plan"` scopes the whole phrase to the field.
      if (field === 'title') parsed.title.push(phrase);
      else if (field === 'tag') parsed.tags.push(phrase.replace(/^#/, ''));
      else if (negated) parsed.excluded.push(phrase);
      else parsed.phrases.push(phrase);
      continue;
    }
    if (word === undefined) continue;

    if ((CONTENT_FILTERS as readonly string[]).includes(word.toLowerCase())) {
      parsed.filters.push(word.toLowerCase() as ContentFilter);
      continue;
    }
    if (word.toLowerCase().startsWith('title:')) {
      const value = word.slice('title:'.length);
      if (value) parsed.title.push(value);
      continue;
    }
    if (word.toLowerCase().startsWith('tag:')) {
      const value = word.slice('tag:'.length).replace(/^#/, '');
      if (value) parsed.tags.push(value);
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      parsed.excluded.push(word.slice(1));
      continue;
    }
    parsed.terms.push(word);
  }

  return parsed;
}

/** Whether the query asks for anything at all. */
export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return (
    parsed.terms.length === 0 &&
    parsed.phrases.length === 0 &&
    parsed.excluded.length === 0 &&
    parsed.title.length === 0 &&
    parsed.tags.length === 0 &&
    parsed.filters.length === 0
  );
}
