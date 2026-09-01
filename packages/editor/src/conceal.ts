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
 * The central trick: show the prose, not the punctuation. Markers are
 * revealed on whichever lines the selection touches, so editing the raw
 * Markdown is always one caret movement away — nothing is ever rewritten
 * behind the user's back, since this is presentation only.
 */
function buildDecorations(view: EditorView, everywhere: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;

  // Lines touched by any selection range stay fully revealed — unless the
  // conceal-everywhere preference is on, in which case nothing ever is.
  const activeLines = new Set<number>();
  if (!everywhere) {
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }
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

export interface ConcealOptions {
  /**
   * Hide markers on the active line too.
   *
   * A callback so the preference can flip without rebuilding the editor; the
   * decorations recompute on the next update either way.
   */
  everywhere?: () => boolean;
}

/**
 * The active-line reveal is the better default, but it is a preference and not
 * a law — `everywhere` turns it off for people who never want to see syntax.
 */
export function concealMarkdown(options: ConcealOptions = {}): Extension {
  class ConcealPlugin implements PluginValue {
    decorations: DecorationSet;
    /** What `everywhere` said last build, to catch the setting flipping. */
    private mode: boolean;

    constructor(view: EditorView) {
      this.mode = options.everywhere?.() ?? false;
      this.decorations = buildDecorations(view, this.mode);
    }

    update(update: ViewUpdate) {
      const mode = options.everywhere?.() ?? false;
      // Selection changes matter as much as edits here: moving the caret onto
      // a line is what reveals its markers.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        mode !== this.mode
      ) {
        this.mode = mode;
        this.decorations = buildDecorations(update.view, mode);
      }
    }
  }

  const concealPlugin: ViewPlugin<ConcealPlugin> = ViewPlugin.fromClass(ConcealPlugin, {
    decorations: (plugin) => plugin.decorations,
  });

  return [
    concealPlugin,
    // Treat hidden markers as single units so arrow keys step over them
    // instead of appearing to stall on invisible characters.
    EditorView.atomicRanges.of(
      (view) => view.plugin(concealPlugin)?.decorations ?? Decoration.none,
    ),
  ];
}

/** The default behaviour, kept for callers that predate the option. */
export const concealMarkdownSyntax: Extension = concealMarkdown();

/** Exposed for tests: which ranges would be hidden for a given view. */
export function concealedRangesForTest(
  view: EditorView,
  everywhere = false,
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = [];
  const set = buildDecorations(view, everywhere);
  const iter = set.iter();
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to, value: iter.value });
    iter.next();
  }
  return out;
}
