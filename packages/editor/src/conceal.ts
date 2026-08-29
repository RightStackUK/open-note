import { syntaxTree } from '@codemirror/language';
import type { Extension, Range } from '@codemirror/state';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * Markdown syntax markers hidden while the cursor is elsewhere.
 *
 * List markers are deliberately absent: hiding a bullet removes information
 * rather than punctuation. Fenced-code markers are handled separately, since
 * hiding a fence makes it impossible to see where a code block ends.
 */
const CONCEALED_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrongMark',
  'StrikethroughMark',
  'CodeMark',
  'QuoteMark',
]);

const hidden = Decoration.replace({});

/**
 * Bear's central trick: show the prose, not the punctuation. Markers are
 * revealed on whichever lines the selection touches, so editing the raw
 * Markdown is always one caret movement away — nothing is ever rewritten
 * behind the user's back, since this is presentation only.
 */
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;

  // Lines touched by any selection range stay fully revealed.
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (!CONCEALED_MARKS.has(node.name)) return;

        // Never hide a fence: without it there is no way to see where a code
        // block starts or ends.
        if (node.name === 'CodeMark' && node.node.parent?.name === 'FencedCode') return;

        const line = state.doc.lineAt(node.from);
        if (activeLines.has(line.number)) return;

        // `# ` and `> ` carry a trailing space that would otherwise indent the
        // text by one character once the marker is gone.
        let end = node.to;
        if (
          (node.name === 'HeaderMark' || node.name === 'QuoteMark') &&
          state.doc.sliceString(end, end + 1) === ' '
        ) {
          end += 1;
        }

        if (end > node.from) builder.add(node.from, end, hidden);
      },
    });
  }

  return builder.finish();
}

class ConcealPlugin implements PluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate) {
    // Selection changes matter as much as edits here: moving the caret onto a
    // line is what reveals its markers.
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}

const concealPlugin: ViewPlugin<ConcealPlugin> = ViewPlugin.fromClass(ConcealPlugin, {
  decorations: (plugin) => plugin.decorations,
});

export const concealMarkdownSyntax: Extension = [
  concealPlugin,
  // Treat hidden markers as single units so arrow keys step over them instead
  // of appearing to stall on invisible characters.
  EditorView.atomicRanges.of((view) => view.plugin(concealPlugin)?.decorations ?? Decoration.none),
];

/** Exposed for tests: which ranges would be hidden for a given view. */
export function concealedRangesForTest(view: EditorView): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = [];
  const set = buildDecorations(view);
  const iter = set.iter();
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to, value: iter.value });
    iter.next();
  }
  return out;
}
