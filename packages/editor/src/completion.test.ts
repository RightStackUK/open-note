import { CompletionContext } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { type CompletionNote, completionSourcesForTest } from './completion';

/**
 * The sources are exercised directly against a `CompletionContext` rather than
 * through a mounted editor: what needs testing is which options come back for a
 * given caret position, and a real view adds a DOM and a panel to that without
 * adding any coverage.
 *
 * `‸` marks the caret, as everywhere else in this package.
 */
const NOTES: CompletionNote[] = [
  { path: 'Research.md', title: 'Research' },
  { path: 'projects/Open Note.md', title: 'Open Note' },
  { path: 'daily/2026-08-31.md', title: '2026-08-31' },
  { path: 'notes/deep/Shipping.md', title: 'Release checklist' },
];

const TAGS = ['work', 'work/urgent', 'home', 'reading'];

interface RunOptions {
  notes?: CompletionNote[];
  tags?: string[];
  recency?: Map<string, number>;
  enabled?: boolean;
}

/** Every option the given source returns at the caret, in order. */
function complete(which: 'wikiLink' | 'tag' | 'emoji', input: string, options: RunOptions = {}) {
  const caret = input.indexOf('‸');
  if (caret === -1) throw new Error('no caret in fixture');
  const doc = input.replace('‸', '');

  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    // The real markdown parser, so `inCode` sees the tree the editor sees.
    extensions: [markdown({ base: markdownLanguage, codeLanguages: [] })],
  });

  const sources = completionSourcesForTest({
    notes: () => options.notes ?? NOTES,
    tags: () => options.tags ?? TAGS,
    recency: () => options.recency ?? new Map(),
    enabled: () => options.enabled ?? true,
  });

  const context = new CompletionContext(state, caret, true);
  const result = sources[which](context);
  if (!result) return null;
  return {
    from: result.from,
    filter: result.filter,
    labels: result.options.map((o) => o.label),
    applied: result.options.map((o) => (typeof o.apply === 'string' ? o.apply : o.label)),
  };
}

describe('[[ note links', () => {
  it('offers every note on a bare [[', () => {
    const result = complete('wikiLink', 'see [[‸');
    expect(result?.labels).toEqual(expect.arrayContaining(['Research', 'Open Note']));
  });

  it('starts the replacement after the brackets', () => {
    // `from` must not swallow the `[[`, or accepting an option would eat it.
    expect(complete('wikiLink', 'see [[‸')?.from).toBe(6);
  });

  it('ranks a title match above a path match', () => {
    const result = complete('wikiLink', '[[research‸');
    expect(result?.labels[0]).toBe('Research');
  });

  it('finds a note by its title when the filename differs', () => {
    const result = complete('wikiLink', '[[release‸');
    expect(result?.labels).toContain('Release checklist');
  });

  it('writes an alias only when the basename and title differ', () => {
    const applied = complete('wikiLink', '[[‸')?.applied ?? [];
    // Basename equals title, so no alias is needed.
    expect(applied).toContain('Research');
    // Basename `Shipping` differs from the title, so the alias is carried.
    expect(applied).toContain('notes/deep/Shipping|Release checklist');
  });

  it('breaks a tie on recency', () => {
    const recency = new Map([
      ['Research.md', 1],
      ['projects/Open Note.md', 99],
    ]);
    const result = complete('wikiLink', '[[‸', {
      notes: [NOTES[0] as CompletionNote, NOTES[1] as CompletionNote],
      recency,
    });
    expect(result?.labels[0]).toBe('Open Note');
  });

  it('does not filter out a title no note has yet', () => {
    // Completion must never block a novel name: "create on follow" depends on
    // the typed text surviving.
    const result = complete('wikiLink', '[[Some Brand New Note‸');
    expect(result?.filter ?? false).toBe(false);
  });

  it('stops offering once an alias is being written', () => {
    expect(complete('wikiLink', '[[Research|my‸')).toBeNull();
  });

  it('does not fire inside a fenced code block', () => {
    expect(complete('wikiLink', '```\n[[‸\n```')).toBeNull();
  });

  it('does not fire inside inline code', () => {
    expect(complete('wikiLink', 'the `[[‸` syntax')).toBeNull();
  });

  it('does not fire after the link is closed', () => {
    expect(complete('wikiLink', '[[Research]]‸')).toBeNull();
  });
});

describe('# tags', () => {
  it('offers every tag after a bare #', () => {
    expect(complete('tag', 'about ‸')).toBeNull();
    expect(complete('tag', 'about #‸')?.labels).toEqual([
      '#work',
      '#work/urgent',
      '#home',
      '#reading',
    ]);
  });

  it('replaces from the # itself', () => {
    expect(complete('tag', 'about #wo‸')?.from).toBe(6);
  });

  it('filters on what has been typed', () => {
    expect(complete('tag', 'about #wo‸')?.labels).toEqual(['#work', '#work/urgent']);
  });

  it('offers nested tags', () => {
    expect(complete('tag', 'about #work/‸')?.labels).toEqual(['#work/urgent']);
  });

  it('does not fire mid-word, where a # is not a tag', () => {
    // `C#` in prose must not open a tag panel, matching extractTags.
    expect(complete('tag', 'I write C#‸')).toBeNull();
  });

  it('does not fire in a URL fragment', () => {
    expect(complete('tag', 'https://example.com/#‸')).toBeNull();
  });

  it('does not fire on a heading line', () => {
    expect(complete('tag', '# Heading‸')).toBeNull();
    expect(complete('tag', '### ‸')).toBeNull();
  });

  it('does not fire inside a fenced code block', () => {
    expect(complete('tag', '```\n#wo‸\n```')).toBeNull();
  });

  it('does not fire inside inline code', () => {
    expect(complete('tag', 'the `#wo‸` sigil')).toBeNull();
  });

  it('returns nothing when no tag matches', () => {
    expect(complete('tag', 'about #zzz‸')).toBeNull();
  });
});

describe(': emoji', () => {
  it('offers matches once a letter follows the colon', () => {
    const result = complete('emoji', 'ship it :rocket‸');
    expect(result?.labels).toContain(':rocket:');
    expect(result?.applied).toContain('🚀');
  });

  it('inserts the character, not the shortcode', () => {
    const result = complete('emoji', 'done :white_check_mark‸');
    expect(result?.applied[0]).toBe('✅');
  });

  it('does not fire on a bare colon', () => {
    // A colon is punctuation far more often than the start of an emoji.
    expect(complete('emoji', 'note: ‸')).toBeNull();
    expect(complete('emoji', 'note:‸')).toBeNull();
  });

  it('matches on a keyword as well as the shortcode', () => {
    expect(complete('emoji', ':urgent‸')?.applied).toContain('🔥');
  });

  it('does not fire inside a fenced code block', () => {
    expect(complete('emoji', '```\n:rocket‸\n```')).toBeNull();
  });

  it('returns nothing for an unknown shortcode', () => {
    expect(complete('emoji', ':zzzzzz‸')).toBeNull();
  });
});

describe('the completion setting', () => {
  it('turns all three sources off together', () => {
    expect(complete('wikiLink', '[[‸', { enabled: false })).toBeNull();
    expect(complete('tag', 'a #wo‸', { enabled: false })).toBeNull();
    expect(complete('emoji', ':rocket‸', { enabled: false })).toBeNull();
  });
});
