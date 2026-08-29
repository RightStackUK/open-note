import { type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

export interface WikiLinkOptions {
  /** Map a link target to a note path, or `null` when nothing matches. */
  resolve: (target: string) => string | null;
  /** Follow a link. `path` is null for an unresolved target. */
  onOpen: (target: string, path: string | null) => void;
}

const LINK_RE = /\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g;

/**
 * Make `[[wikilinks]]` navigable.
 *
 * Clicking follows the link, except on the line the cursor is already on, where
 * a click places the caret instead. That mirrors the syntax concealment: the
 * active line is the one you are editing, every other line is one you are
 * reading.
 */
export function wikiLinks(options: WikiLinkOptions): Extension {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const { state } = view;

    const activeLines = new Set<number>();
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }

    for (const { from, to } of view.visibleRanges) {
      const text = state.doc.sliceString(from, to);
      LINK_RE.lastIndex = 0;
      for (const match of text.matchAll(LINK_RE)) {
        if (match.index === undefined) continue;
        const start = from + match.index;
        const end = start + match[0].length;
        const target = (match[1] ?? '').trim();
        if (!target) continue;

        const resolved = options.resolve(target);
        const onActiveLine = activeLines.has(state.doc.lineAt(start).number);

        builder.add(
          start,
          end,
          Decoration.mark({
            class: [
              'cm-wikilink',
              resolved ? '' : 'cm-wikilink-missing',
              onActiveLine ? 'cm-wikilink-editing' : '',
            ]
              .filter(Boolean)
              .join(' '),
            attributes: {
              'data-wikilink': target,
              title: resolved ? `Open ${resolved}` : `${target} — no note with this name yet`,
            },
          }),
        );
      }
    }
    return builder.finish();
  };

  class WikiLinkPlugin implements PluginValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = build(update.view);
      }
    }
  }

  const plugin: ViewPlugin<WikiLinkPlugin> = ViewPlugin.fromClass(WikiLinkPlugin, {
    decorations: (p) => p.decorations,
  });

  return [
    plugin,
    linkStyles,
    EditorView.domEventHandlers({
      mousedown(event) {
        const element = event.target as HTMLElement | null;
        const anchor = element?.closest?.('.cm-wikilink') as HTMLElement | null;
        if (!anchor) return false;

        // On the line being edited, a click means "put the caret here".
        if (anchor.classList.contains('cm-wikilink-editing') && !event.metaKey && !event.ctrlKey) {
          return false;
        }

        const target = anchor.getAttribute('data-wikilink');
        if (!target) return false;

        event.preventDefault();
        options.onOpen(target, options.resolve(target));
        // Returning true stops CodeMirror moving the caret into the link.
        return true;
      },
    }),
  ];
}

const linkStyles = EditorView.theme({
  '.cm-wikilink': {
    color: 'var(--accent)',
    cursor: 'pointer',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  '.cm-wikilink-missing': {
    color: 'var(--muted)',
    textDecorationStyle: 'dashed',
  },
  // On the active line the link is being edited, so it should not invite a click.
  '.cm-wikilink-editing': {
    cursor: 'text',
  },
});
