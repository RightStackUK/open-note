import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

/**
 * Callouts: GitHub's alert syntax, `> [!NOTE]` through `> [!CAUTION]`.
 *
 * Chosen because it is a real standard that renders natively on the forge —
 * the ordering principle for syntax is "prefer what still renders when someone
 * opens the vault on github.com". The blockquote is decorated in place with a
 * coloured rule, an icon and a label; the source is never rewritten.
 *
 * Block-adjacent decorations come from a `StateField`, as `diagrams.ts`
 * records: a `ViewPlugin` is rejected outright for this.
 */

export const CALLOUT_KINDS = {
  note: { label: 'Note', icon: 'ℹ' },
  tip: { label: 'Tip', icon: '💡' },
  important: { label: 'Important', icon: '❗' },
  warning: { label: 'Warning', icon: '⚠' },
  caution: { label: 'Caution', icon: '⛔' },
} as const;

export type CalloutKind = keyof typeof CALLOUT_KINDS;

const MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/** The `[!KIND]` marker drawn as its icon and label. */
class CalloutLabel extends WidgetType {
  constructor(private readonly kind: CalloutKind) {
    super();
  }

  override eq(other: CalloutLabel) {
    return other.kind === this.kind;
  }

  toDOM() {
    const { label, icon } = CALLOUT_KINDS[this.kind];
    const el = document.createElement('span');
    el.className = `cm-callout-label is-${this.kind}`;
    el.textContent = `${icon} ${label}`;
    return el;
  }
}

function build(state: EditorState): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Blockquote') return;

      const firstLine = state.doc.lineAt(node.from);
      // Text after the `>` marker on the first line decides whether this
      // blockquote is a callout at all.
      const afterMark = firstLine.text.replace(/^\s*>\s?/, '');
      const match = MARKER.exec(afterMark);
      if (!match) return;
      const kind = (match[1] ?? 'note').toLowerCase() as CalloutKind;

      const lastLine = state.doc.lineAt(node.to);
      for (let n = firstLine.number; n <= lastLine.number; n++) {
        const line = state.doc.line(n);
        decorations.push(
          Decoration.line({ class: `cm-callout is-${kind}` }).range(line.from, line.from),
        );
      }

      // The marker itself reads as its label — except on the active line,
      // where the source is being edited and must show as written.
      if (!activeLines.has(firstLine.number)) {
        const at = firstLine.text.indexOf('[!');
        if (at !== -1) {
          decorations.push(
            Decoration.replace({ widget: new CalloutLabel(kind) }).range(
              firstLine.from + at,
              firstLine.from + at + (match[0]?.trim().length ?? 0),
            ),
          );
        }
      }
    },
  });

  return Decoration.set(decorations, true);
}

const calloutField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (decorations, transaction) => {
    if (transaction.docChanged || transaction.selection) return build(transaction.state);
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const calloutStyles = EditorView.theme({
  '.cm-callout': {
    borderLeft: '3px solid var(--muted)',
    paddingLeft: '0.5rem',
    background: 'color-mix(in srgb, var(--muted) 6%, transparent)',
  },
  '.cm-callout.is-note': { borderLeftColor: '#3b82f6' },
  '.cm-callout.is-tip': { borderLeftColor: 'var(--success, #2f855a)' },
  '.cm-callout.is-important': { borderLeftColor: '#8b5cf6' },
  '.cm-callout.is-warning': { borderLeftColor: '#d97706' },
  '.cm-callout.is-caution': { borderLeftColor: 'var(--danger, #b91c1c)' },
  '.cm-callout-label': {
    fontWeight: '600',
    fontFamily: 'var(--ui-font, ui-sans-serif, sans-serif)',
    fontSize: '0.85em',
  },
  '.cm-callout-label.is-note': { color: '#3b82f6' },
  '.cm-callout-label.is-tip': { color: 'var(--success, #2f855a)' },
  '.cm-callout-label.is-important': { color: '#8b5cf6' },
  '.cm-callout-label.is-warning': { color: '#d97706' },
  '.cm-callout-label.is-caution': { color: 'var(--danger, #b91c1c)' },
});

export const callouts: Extension = [calloutField, calloutStyles];

/** Exposed for tests: which callout each line of `state` belongs to. */
export function calloutLinesForTest(state: EditorState): Map<number, string> {
  const out = new Map<number, string>();
  const set = build(state);
  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec as { class?: string };
    const match = /is-(\w+)/.exec(spec.class ?? '');
    if (match?.[1]) out.set(state.doc.lineAt(iter.from).number, match[1]);
    iter.next();
  }
  return out;
}
