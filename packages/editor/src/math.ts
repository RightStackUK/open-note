import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

/**
 * Math: `$inline$` and `$$block$$`, rendered through KaTeX off the active line.
 *
 * The syntax renders natively on github.com, which is what earns it a place.
 * KaTeX is ~280 KB of CSS and fonts, so it loads on first use rather than at
 * startup — the same bargain `language-data` makes with parsers. Until the
 * library arrives the source shows as written, which is never wrong.
 */

type Katex = typeof import('katex').default;

let katexPromise: Promise<Katex | null> | null = null;

function loadKatex(): Promise<Katex | null> {
  katexPromise ??= Promise.all([
    import('katex'),
    // Side-effect import; the bundler turns it into a stylesheet. The
    // specifier is opaque to TypeScript, hence the ts-ignore.
    // @ts-ignore -- a CSS module has no type declarations
    import('katex/dist/katex.min.css').catch(() => null),
  ])
    .then(([module]) => module.default)
    .catch(() => null);
  return katexPromise;
}

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget) {
    return other.source === this.source && other.display === this.display;
  }

  toDOM() {
    // Always a span: the replace decoration is inline (a `$$` block may start
    // mid-line, where a block widget is not allowed), and the display styling
    // comes from the class instead.
    const el = document.createElement('span');
    el.className = this.display ? 'cm-math cm-math-block' : 'cm-math';
    el.textContent = this.source;

    void loadKatex().then((katex) => {
      if (!katex || !el.isConnected) return;
      try {
        // `throwOnError: false` renders the offending TeX in red instead;
        // `trust` stays off so \\href and friends cannot smuggle URLs in.
        el.innerHTML = katex.renderToString(this.source, {
          displayMode: this.display,
          throwOnError: false,
        });
      } catch {
        // Malformed enough to throw anyway: the source text stays.
      }
    });

    return el;
  }
}

/** `$$…$$` first — greedy on purpose, so `$$x$$` is never read as two `$x$`. */
// `\$` inside is legal TeX (`\text{Cost: \$5}`), hence the escape alternative.
const BLOCK_MATH = /\$\$((?:\\.|[^$\\])+?)\$\$/gs;
const INLINE_MATH = /(?<![$\\])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<![\s\\])\$(?!\$)/g;

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

function build(state: EditorState): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const text = state.doc.toString();

  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const touchesActive = (from: number, to: number) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let n = first; n <= last; n++) if (activeLines.has(n)) return true;
    return false;
  };

  const covered: Array<[number, number]> = [];

  for (const match of text.matchAll(BLOCK_MATH)) {
    const from = match.index;
    const to = from + match[0].length;
    covered.push([from, to]);
    if (touchesActive(from, to) || inCode(state, from)) continue;
    const source = (match[1] ?? '').trim();
    if (!source) continue;
    decorations.push(Decoration.replace({ widget: new MathWidget(source, true) }).range(from, to));
  }

  // Both match lists ascend, so one pointer answers containment — `.some()`
  // over every block for every inline span goes quadratic on a formula-heavy
  // note.
  let coveredAt = 0;
  for (const match of text.matchAll(INLINE_MATH)) {
    const from = match.index;
    const to = from + match[0].length;
    while (coveredAt < covered.length && (covered[coveredAt]?.[1] ?? 0) <= from) coveredAt += 1;
    const block = covered[coveredAt];
    // Inside a `$$…$$` already handled above.
    if (block && from >= block[0] && to <= block[1]) continue;
    if (touchesActive(from, to) || inCode(state, from)) continue;
    const source = match[1] ?? '';
    // A lone number like `$5` and `$10` in prose is money, not math; require
    // something that reads as TeX — a letter, a command, or an operator.
    if (!/[\\a-zA-Z^_={}+*/<>-]/.test(source)) continue;
    decorations.push(Decoration.replace({ widget: new MathWidget(source, false) }).range(from, to));
  }

  return Decoration.set(decorations, true);
}

const mathField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (decorations, transaction) => {
    if (transaction.docChanged || transaction.selection) return build(transaction.state);
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const mathStyles = EditorView.theme({
  '.cm-math': { color: 'var(--fg)' },
  '.cm-math-block': {
    display: 'inline-block',
    width: '100%',
    textAlign: 'center',
    padding: '0.5rem 0',
    overflowX: 'auto',
  },
});

export const mathRendering: Extension = [mathField, mathStyles];

/** Exposed for tests: the `[from, to, display]` spans that would render. */
export function mathSpansForTest(state: EditorState): Array<[number, number, boolean]> {
  const out: Array<[number, number, boolean]> = [];
  const set = build(state);
  const iter = set.iter();
  while (iter.value) {
    const widget = (iter.value.spec as { widget?: MathWidget }).widget;
    out.push([iter.from, iter.to, widget?.display ?? false]);
    iter.next();
  }
  return out;
}
