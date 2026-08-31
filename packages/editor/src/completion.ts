import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionKeymap,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { fuzzyScore, partialTagBefore, searchEmoji } from '@open-note/core';

/**
 * Completion for `[[` note links, `#` tags and `:` emoji.
 *
 * All three read the vault through injected callbacks rather than importing an
 * index: the index lives in the app, and the editor package stays a library
 * that can be driven from a test with three arrays.
 */

/** A note the `[[` source can offer. */
export interface CompletionNote {
  path: string;
  title: string;
}

export interface CompletionOptions {
  /** Every note in the vault. */
  notes: () => CompletionNote[];
  /** Every tag in the vault, most used first. */
  tags: () => string[];
  /**
   * Vault-relative path to last-modified time, for ranking.
   *
   * Optional because recency is a nicety and the sources must work without it —
   * a vault that has never been listed still has to offer completions.
   */
  recency?: () => Map<string, number>;
  /** All three sources off together. */
  enabled?: () => boolean;
}

/**
 * Whether `pos` sits inside code, where none of these sigils mean anything.
 *
 * Read from the syntax tree rather than by re-running the indexer's regex mask:
 * the tree is what the editor itself uses to decide where code is, so agreeing
 * with it is what keeps the decoration, the highlighting and the completion
 * consistent on screen. The *tag grammar* is shared with the indexer through
 * `partialTagBefore`, which is where a disagreement would actually matter.
 */
function inCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node.parent) {
    const { name } = node;
    if (
      name === 'FencedCode' ||
      name === 'CodeBlock' ||
      name === 'InlineCode' ||
      name === 'CodeText'
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/**
 * A bare `#` at the start of a line's content is a heading marker being typed,
 * not a tag — so no panel until a tag character follows it.
 *
 * Deliberately this narrow: a tag *with characters* at the start of a line, or
 * anywhere on a heading line (`# Heading #work`), is a tag to `extractTags`,
 * and completion suppressing what the indexer records would be a disagreement.
 * Quote markers count as lead-in, so `> #` while typing a quoted heading stays
 * quiet too.
 */
function atHeadingMarker(lineText: string, start: number, query: string): boolean {
  if (query) return false;
  return /^[\s>]*$/.test(lineText.slice(0, start));
}

/**
 * `[[` note links.
 *
 * Ranked by recency, then title match, then path match — the order the plan
 * specifies, because the note being linked is usually the note just worked on.
 * A novel name is never blocked: nothing is filtered or auto-selected, so
 * typing a title no note has yet and pressing `]]` still creates it on follow,
 * which is behaviour the app already had and completion must not take away.
 */
function wikiLinkSource(options: CompletionOptions) {
  return (context: CompletionContext): CompletionResult | null => {
    // Everything between the opening `[[` and the caret, with no `]` in it.
    const before = context.matchBefore(/\[\[[^\]\n]*$/);
    if (!before) return null;
    if (inCode(context.state, context.pos)) return null;

    const typed = before.text.slice(2);
    // An explicit alias or heading is being written, not a target.
    if (typed.includes('|')) return null;

    const query = typed.toLowerCase();
    const recency = options.recency?.() ?? new Map<string, number>();

    const scored: Array<{ note: CompletionNote; title: number; path: number }> = [];
    for (const note of options.notes()) {
      if (!query) {
        scored.push({ note, title: 0, path: 0 });
        continue;
      }
      const title = fuzzyScore(note.title.toLowerCase(), query);
      const path = fuzzyScore(note.path.toLowerCase(), query);
      if (title > 0 || path > 0) scored.push({ note, title, path });
    }

    scored.sort(
      (a, b) =>
        (recency.get(b.note.path) ?? 0) - (recency.get(a.note.path) ?? 0) ||
        b.title - a.title ||
        b.path - a.path ||
        a.note.title.localeCompare(b.note.title),
    );

    const noteTarget = (note: CompletionNote) => {
      // The path without its extension is what a wikilink addresses.
      const target = note.path.replace(/\.(md|markdown|mdown|mkd)$/i, '');
      const basename = target.slice(target.lastIndexOf('/') + 1);
      // `[[path|Title]]` only when the two differ; a bare `[[path]]` otherwise,
      // since an alias that repeats the title is noise in the source.
      return basename === note.title ? target : `${target}|${note.title}`;
    };

    const seen = new Set<string>();
    const dedupedOptions: Completion[] = [];
    for (const { note } of scored.slice(0, 50)) {
      const target = noteTarget(note);
      if (seen.has(target)) continue;
      seen.add(target);
      dedupedOptions.push({
        label: note.title,
        detail: note.path,
        // Accepting must close the link: inserting only the target left the
        // user with `[[Research` and no `]]`. Any brackets already ahead of
        // the caret — from `edit.wikilink`'s `[[]]`, or typed by hand — are
        // reused rather than doubled, and the caret lands after them.
        apply: (view, _completion, from, to) => {
          const following = view.state.doc.sliceString(to, to + 2);
          const existing = following === ']]' ? 2 : following.startsWith(']') ? 1 : 0;
          view.dispatch({
            changes: { from, to, insert: target + ']]'.slice(existing) },
            selection: { anchor: from + target.length + 2 },
            userEvent: 'input.complete',
          });
        },
        type: 'note',
      });
    }

    return {
      from: before.from + 2,
      options: dedupedOptions,
      // Re-query on every keystroke: the ranking depends on the whole query, so
      // letting CodeMirror filter a stale list would reorder it wrongly, and a
      // title no note has yet must stay typeable rather than being filtered to
      // an empty panel.
      filter: false,
    };
  };
}

/**
 * `#` tags.
 *
 * Where a `#` starts a tag is decided by `partialTagBefore` in `core`, the same
 * rule `extractTags` applies — so completion never offers a tag the index would
 * then refuse to record.
 */
function tagSource(options: CompletionOptions) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);

    const partial = partialTagBefore(before);
    if (!partial) return null;
    if (inCode(context.state, context.pos)) return null;
    if (atHeadingMarker(line.text, partial.start, partial.query)) return null;

    const query = partial.query.toLowerCase();
    const matches = options
      .tags()
      .filter((tag) => !query || tag.toLowerCase().includes(query))
      // Nested tags come with their parents, so `#a/b` is offered under `a`.
      .slice(0, 50)
      .map<Completion>((tag) => ({ label: `#${tag}`, apply: `#${tag}`, type: 'tag' }));

    if (matches.length === 0) return null;

    return {
      from: line.from + partial.start,
      options: matches,
      // No `validFor`: it would freeze this result and let CodeMirror filter
      // it, so with more than 50 tags a tag past the cap could never surface
      // however much of it was typed. Re-running per keystroke is cheap.
      filter: false,
    };
  };
}

/** `:shortcode:` emoji, inserting the character itself. */
function emojiSource() {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/:[a-z0-9_+-]*$/);
    if (!before) return null;
    // A bare `:` is punctuation far more often than the start of an emoji, so
    // wait for a letter before offering anything.
    if (before.text.length < 2) return null;
    if (inCode(context.state, context.pos)) return null;

    const query = before.text.slice(1);
    const matches = searchEmoji(query).map<Completion>((emoji) => ({
      label: `:${emoji.shortcode}:`,
      detail: emoji.char,
      apply: emoji.char,
      type: 'emoji',
    }));
    if (matches.length === 0) return null;

    // `filter: false`, because CodeMirror re-filters options against their
    // labels: a keyword hit like `:urgent` → 🔥 would be shown by this source
    // and then silently removed because "urgent" is not in ":fire:".
    return { from: before.from, options: matches, filter: false };
  };
}

type Source = (context: CompletionContext) => CompletionResult | null;

/**
 * The three sources, each gated on the `completion` setting.
 *
 * Built in one place so the extension below and the tests exercise exactly the
 * same functions — a test that reimplemented the gating would not be testing
 * the gating.
 */
function sources(options: CompletionOptions): Record<'wikiLink' | 'tag' | 'emoji', Source> {
  const gate =
    (source: Source): Source =>
    (context) => {
      if (options.enabled && !options.enabled()) return null;
      return source(context);
    };

  return {
    wikiLink: gate(wikiLinkSource(options)),
    tag: gate(tagSource(options)),
    emoji: gate(emojiSource()),
  };
}

/** The sources alone, for tests. Not part of the editor's public surface. */
export function completionSourcesForTest(options: CompletionOptions) {
  return sources(options);
}

/**
 * The three completion sources, plus the keymap they need.
 *
 * `defaultKeymap: false` because the app owns its bindings; the completion
 * keymap is added explicitly and placed before the editor's other keymaps so
 * Escape and Enter reach the open panel first.
 */
export function noteCompletion(options: CompletionOptions): Extension {
  const { wikiLink, tag, emoji } = sources(options);

  return [
    autocompletion({
      override: [wikiLink, tag, emoji],
      // Never complete a word the user has not asked to complete; these sources
      // are all sigil-triggered and an implicit list would fire while writing
      // prose.
      activateOnTyping: true,
      // A novel note title must stay typeable, so nothing is ever selected by
      // default — Enter inserts a newline unless the user has chosen an option.
      selectOnOpen: false,
      defaultKeymap: false,
      icons: false,
    }),
    keymap.of(completionKeymap),
  ];
}
