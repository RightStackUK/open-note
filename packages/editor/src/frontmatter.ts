import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { styleTags, tags } from '@lezer/highlight';
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';

/**
 * YAML frontmatter, which Markdown itself has never heard of.
 *
 * Left alone, a note that opens with a header parses as something else
 * entirely: `---` on the first line is a thematic break, and the keys that
 * follow are a paragraph terminated by `---`, which is the CommonMark spelling
 * of a **setext heading**. So the note's metadata rendered as a giant title —
 * `title: "Q1: plans"` in 1.42em bold — and the real first heading came second.
 *
 * That is not only a styling problem, which is why this is a parser extension
 * and not a regular expression over the first few lines: the *tree* was wrong,
 * and anything that reads it inherits the mistake. It never mattered much
 * while only a note that had been linked to carried an `id:`, and then the
 * importers arrived and gave every imported note a header.
 *
 * The block is styled rather than hidden. Concealment is for punctuation, and
 * frontmatter is content — dates, tags, the id another app may be holding — so
 * it stays legible and stays editable, just visibly not prose.
 */

/** `---`, and the `----` a stray keystroke makes of it. */
const FENCE = /^-{3,}\s*$/;

/**
 * A line that could plausibly be YAML: `key:`, or a list item under one.
 *
 * Checked against the line *after* the opening fence, because the parser
 * cannot see far enough ahead to know whether a closing fence exists (the
 * block context peeks exactly one line). Without this narrowing, a note whose
 * first line is a thematic break would be swallowed as an unterminated header.
 * With it, that requires the second line to look like YAML as well, which a
 * note beginning with a horizontal rule does not.
 */
const YAML_ISH = /^\s*(?:[A-Za-z0-9_$.-]+\s*:|-\s)/;

function isFence(line: Line): boolean {
  return FENCE.test(line.text);
}

/**
 * The frontmatter block parser.
 *
 * Ordered before `HorizontalRule`, which would otherwise claim the opening
 * `---`. It only ever fires at position 0: frontmatter is frontmatter because
 * of where it is, and a `---` further down the note is the thematic break it
 * has always been.
 */
export const frontmatterSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true }, { name: 'FrontmatterMark' }],
  props: [
    styleTags({
      Frontmatter: tags.meta,
      FrontmatterMark: tags.processingInstruction,
    }),
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx: BlockContext, line: Line): boolean {
        if (cx.lineStart !== 0 || !isFence(line) || !YAML_ISH.test(cx.peekLine())) return false;

        const start = cx.lineStart;
        const marks = [cx.elt('FrontmatterMark', start, start + line.text.length)];

        while (cx.nextLine()) {
          if (!isFence(line)) continue;

          const end = cx.lineStart + line.text.length;
          marks.push(cx.elt('FrontmatterMark', cx.lineStart, end));
          cx.addElement(cx.elt('Frontmatter', start, end, marks));
          cx.nextLine();
          return true;
        }

        // The document ended with the header still open. What was consumed is
        // kept as the block rather than handed back — a block parser that has
        // advanced the context cannot decline — and showing it as metadata is
        // also the clearest way to say the closing `---` is missing.
        cx.addElement(cx.elt('Frontmatter', start, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};

const metadataLine = Decoration.line({ class: 'cm-frontmatter' });
const fenceLine = Decoration.line({ class: 'cm-frontmatter cm-frontmatter-fence' });

/**
 * One line decoration per line of the header.
 *
 * Per line rather than one span over the block, because the styling is a
 * block-level treatment — its own font, its own colour — and a mark
 * decoration cannot round the corners of something it does not own the lines
 * of.
 */
function build(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Only ever the document's first block, so there is nothing to iterate.
  const first = syntaxTree(state).topNode.firstChild;
  if (first?.name === 'Frontmatter') {
    const last = state.doc.lineAt(Math.min(first.to, state.doc.length)).number;
    for (let n = state.doc.lineAt(first.from).number; n <= last; n++) {
      const line = state.doc.line(n);
      builder.add(line.from, line.from, FENCE.test(line.text) ? fenceLine : metadataLine);
    }
  }

  return builder.finish();
}

/**
 * A `StateField` rather than a `ViewPlugin`, for once not because CodeMirror
 * insists: the header is at position 0, which is inside the first chunk the
 * parser ever produces, so there is no later parse to wait for — and a field
 * keeps the decorations available to anything reading the state rather than
 * only to a view.
 */
export const frontmatterStyling: Extension = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (current, tr) => (tr.docChanged ? build(tr.state) : current),
  provide: (field) => EditorView.decorations.from(field),
});

/** The lines the header covers, for tests. */
export function frontmatterLinesForTest(state: EditorState): number[] {
  const lines: number[] = [];
  const set = build(state);
  const iter = set.iter();
  while (iter.value) {
    lines.push(state.doc.lineAt(iter.from).number);
    iter.next();
  }
  return lines;
}
