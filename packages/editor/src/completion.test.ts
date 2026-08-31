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
    state,
    from: result.from,
    filter: result.filter,
    labels: result.options.map((o) => o.label),
    options: result.options,
  };
}

/**
 * Accept the option with `label` and return the document with `‸` at the
 * caret. This drives the option's real `apply` — which is where the closing
 * brackets are decided — through a minimal stand-in for the view.
 */
function accept(which: 'wikiLink' | 'tag' | 'emoji', input: string, label: string): string {
  const result = complete(which, input);
  if (!result) throw new Error('no completion result');
  const option = result.options.find((o) => o.label === label);
  if (!option) throw new Error(`no option labelled ${label}`);

  const caret = input.indexOf('‸');
  let doc = input.replace('‸', '');
  let head = caret;
  const view = {
    state: result.state,
    dispatch(spec: {
      changes: { from: number; to: number; insert: string };
      selection?: { anchor: number };
    }) {
      const { from, to, insert } = spec.changes;
      doc = doc.slice(0, from) + insert + doc.slice(to);
      head = spec.selection?.anchor ?? from + insert.length;
    },
  };

  if (typeof option.apply === 'string') {
    view.dispatch({ changes: { from: result.from, to: caret, insert: option.apply } });
  } else if (typeof option.apply === 'function') {
    (option.apply as (v: unknown, c: unknown, f: number, t: number) => void)(
      view,
      option,
      result.from,
      caret,
    );
  } else {
    view.dispatch({ changes: { from: result.from, to: caret, insert: option.label } });
  }

  return `${doc.slice(0, head)}‸${doc.slice(head)}`;
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

  it('closes the link on accept', () => {
    // Inserting only the target left `[[Research` with no way out but typing
    // the brackets yourself.
    expect(accept('wikiLink', 'see [[res‸ now', 'Research')).toBe('see [[Research]]‸ now');
  });

  it('reuses closing brackets that are already there', () => {
    // `edit.wikilink` inserts `[[]]` with the caret inside; accepting must not
    // produce `]]]]`.
    expect(accept('wikiLink', 'see [[res‸]] now', 'Research')).toBe('see [[Research]]‸ now');
  });

  it('completes a single closing bracket to a pair', () => {
    expect(accept('wikiLink', 'see [[res‸] now', 'Research')).toBe('see [[Research]]‸ now');
  });

  it('writes an alias only when the basename and title differ', () => {
    // Basename equals title, so no alias is needed.
    expect(accept('wikiLink', '[[research‸', 'Research')).toBe('[[Research]]‸');
    // Basename `Shipping` differs from the title, so the alias is carried.
    expect(accept('wikiLink', '[[release‸', 'Release checklist')).toBe(
      '[[notes/deep/Shipping|Release checklist]]‸',
    );
  });

  it('ranks recency above match strength, as the plan specifies', () => {
    const notes = [
      { path: 'a.md', title: 'Notebook' },
      { path: 'b.md', title: 'Note taking tips' },
    ];
    const recency = new Map([
      ['a.md', 1],
      ['b.md', 99],
    ]);
    // `Notebook` scores higher on the query, but `b.md` was edited last — and
    // the note being linked is usually the note just worked on.
    const result = complete('wikiLink', '[[note‸', { notes, recency });
    expect(result?.labels).toEqual(['Note taking tips', 'Notebook']);
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

  it('does not fire on a bare # at the start of a line', () => {
    // That # is a heading being typed; a tag panel there interrupts it.
    expect(complete('tag', '#‸')).toBeNull();
    expect(complete('tag', '> #‸')).toBeNull();
  });

  it('fires for a tag written on a heading line, as the indexer records it', () => {
    // `extractTags('# Heading #wo…')` indexes the tag, so completion offering
    // it is agreement, not a leak.
    expect(complete('tag', '# Heading #wo‸')?.labels).toEqual(['#work', '#work/urgent']);
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
  });

  it('inserts the character, not the shortcode', () => {
    expect(accept('emoji', 'done :white_check_mark‸', ':white_check_mark:')).toBe('done ✅‸');
  });

  it('keeps keyword matches visible by disabling the panel filter', () => {
    // CodeMirror re-filters options against their labels: a keyword hit like
    // `:urgent` → 🔥 would otherwise be offered and then silently removed
    // because "urgent" is not in ":fire:".
    const result = complete('emoji', ':urgent‸');
    expect(result?.labels).toContain(':fire:');
    expect(result?.filter).toBe(false);
  });

  it('does not fire on a bare colon', () => {
    // A colon is punctuation far more often than the start of an emoji.
    expect(complete('emoji', 'note: ‸')).toBeNull();
    expect(complete('emoji', 'note:‸')).toBeNull();
  });

  it('matches on a keyword as well as the shortcode', () => {
    expect(complete('emoji', ':urgent‸')?.labels).toContain(':fire:');
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
