import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * `==highlight==` and `<u>underline</u>`.
 *
 * Two decisions from the plan, recorded there: highlight uses `==text==`
 * because people paste it in from every other app in this class, while being
 * honest that github.com shows the `==`; underline is `<u>…</u>` and not
 * `~text~`, because the HTML renders everywhere and the tilde collides with
 * strikethrough. Off the active line the markers conceal and the style shows;
 * on it, the source.
 */

const HIGHLIGHT = /==([^=\n](?:[^\n]*?[^=\n])?)==/g;
// Content may span lines — the command happily wraps a multi-line selection —
// but must not be empty: a zero-length mark decoration is an exception, and
// the freshly inserted `<u></u>` pair sits empty until something is typed.
const UNDERLINE = /<u>([^<]+)<\/u>/g;

function inCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node.parent) {
    if (
      node.name === 'FencedCode' ||
      node.name === 'CodeBlock' ||
      node.name === 'InlineCode' ||
      node.name === 'CodeText'
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

const hidden = Decoration.replace({});
const highlightMark = Decoration.mark({ class: 'cm-highlight' });
const underlineMark = Decoration.mark({ class: 'cm-underline' });

function build(state: EditorState): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const text = state.doc.toString();

  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const add = (
    match: RegExpExecArray | RegExpMatchArray,
    mark: Decoration,
    openLength: number,
    closeLength: number,
  ) => {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (inCode(state, from)) return;
    const active = activeLines.has(state.doc.lineAt(from).number);
    // The style applies always; the markers conceal only off the active line,
    // the same bargain every other marker in the editor makes.
    decorations.push(mark.range(from + openLength, to - closeLength));
    if (!active) {
      decorations.push(hidden.range(from, from + openLength));
      decorations.push(hidden.range(to - closeLength, to));
    }
  };

  for (const match of text.matchAll(HIGHLIGHT)) add(match, highlightMark, 2, 2);
  for (const match of text.matchAll(UNDERLINE)) add(match, underlineMark, 3, 4);

  return Decoration.set(decorations, true);
}

const inlineStylesField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (decorations, transaction) => {
    if (transaction.docChanged || transaction.selection) return build(transaction.state);
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const inlineStyleTheme = EditorView.theme({
  '.cm-highlight': {
    background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    borderRadius: '2px',
  },
  '.cm-underline': { textDecoration: 'underline' },
});

export const inlineStyles: Extension = [inlineStylesField, inlineStyleTheme];

/** Exposed for tests: `[from, to, class]` of the styled (not hidden) spans. */
export function inlineStyleSpansForTest(state: EditorState): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  const set = build(state);
  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec as { class?: string };
    if (spec.class) out.push([iter.from, iter.to, spec.class]);
    iter.next();
  }
  return out;
}
