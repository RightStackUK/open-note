import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

/**
 * A checkbox drawn in place of `[ ]` / `[x]`.
 *
 * The source is still the GFM task marker — this only changes how it is drawn,
 * the same bargain the rest of the editor makes. `from` is carried on the
 * element so the click handler can flip exactly the character it stands for
 * without re-parsing.
 */
class CheckboxWidget extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly from: number,
  ) {
    super();
  }

  override eq(other: CheckboxWidget) {
    return other.done === this.done && other.from === this.from;
  }

  toDOM() {
    const box = document.createElement('span');
    box.className = `cm-task-checkbox ${this.done ? 'is-done' : ''}`;
    box.setAttribute('data-task-at', String(this.from));
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', this.done ? 'true' : 'false');
    box.setAttribute('title', this.done ? 'Mark as not done' : 'Mark as done');
    return box;
  }

  override ignoreEvent() {
    // The extension's own mousedown handler owns the click; letting CodeMirror
    // also process it would move the caret into the marker.
    return false;
  }
}

const doneLine = Decoration.line({ class: 'cm-task-done' });
/* The line through a finished task covers its words, not its checkbox: a
   struck-through control reads as disabled rather than ticked. */
const doneText = Decoration.mark({ class: 'cm-task-text-done' });

interface Marker {
  from: number;
  to: number;
  done: boolean;
  line: number;
}

/** Every GFM task marker in view, with the state its checkbox should show. */
function markers(view: EditorView): Marker[] {
  const found: Marker[] = [];
  const { state } = view;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'TaskMarker') return;
        const text = state.doc.sliceString(node.from, node.to);
        found.push({
          from: node.from,
          to: node.to,
          done: /\[[xX]\]/.test(text),
          line: state.doc.lineAt(node.from).number,
        });
      },
    });
  }

  return found;
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;

  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  // Line decorations must be added before any mark starting on the same line,
  // so collect first and sort rather than emitting as we walk the tree.
  const all = markers(view);
  const ranges: Array<{ from: number; to: number; value: Decoration }> = [];

  for (const marker of all) {
    if (marker.done) {
      const line = state.doc.line(marker.line);
      ranges.push({ from: line.from, to: line.from, value: doneLine });
      if (marker.to < line.to) {
        ranges.push({ from: marker.to, to: line.to, value: doneText });
      }
    }
    // The line being edited shows its real source, like every other marker.
    if (activeLines.has(marker.line)) continue;
    ranges.push({
      from: marker.from,
      to: marker.to,
      value: Decoration.replace({ widget: new CheckboxWidget(marker.done, marker.from) }),
    });
  }

  // `Decoration.set` sorts by the side rules a RangeSetBuilder would demand of
  // us, which line and mark decorations sharing a position otherwise trip over.
  return Decoration.set(
    ranges.map((range) => range.value.range(range.from, range.to)),
    true,
  );
}

class TaskPlugin implements PluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}

const taskPlugin: ViewPlugin<TaskPlugin> = ViewPlugin.fromClass(TaskPlugin, {
  decorations: (plugin) => plugin.decorations,
});

/** Flip the marker starting at `from`, leaving the rest of the line alone. */
export function toggleTaskAt(view: EditorView, from: number): boolean {
  const marker = view.state.doc.sliceString(from, from + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return false;
  view.dispatch({
    changes: { from: from + 1, to: from + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
  });
  return true;
}

const taskStyles = EditorView.theme({
  '.cm-task-checkbox': {
    display: 'inline-block',
    position: 'relative',
    top: '0.12em',
    width: '1em',
    height: '1em',
    marginRight: '0.15em',
    border: '1.5px solid var(--muted)',
    borderRadius: '3px',
    cursor: 'pointer',
    verticalAlign: 'baseline',
  },
  '.cm-task-checkbox:hover': { borderColor: 'var(--accent)' },
  '.cm-task-checkbox.is-done': {
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  // The tick is drawn rather than typed so it scales with the note font.
  '.cm-task-checkbox.is-done::after': {
    content: '""',
    position: 'absolute',
    left: '0.28em',
    top: '0.08em',
    width: '0.24em',
    height: '0.5em',
    border: 'solid #fff',
    borderWidth: '0 2px 2px 0',
    transform: 'rotate(42deg)',
  },
  '.cm-task-done': { color: 'var(--muted)' },
  '.cm-task-text-done': { textDecoration: 'line-through' },
});

/**
 * Clickable GFM task checkboxes.
 *
 * A notes app whose todo lists cannot be ticked without editing text is a notes
 * app people keep a second todo app beside, so the checkbox is a first-class
 * control everywhere a task appears — here, and in the tasks view.
 */
export const taskCheckboxes: Extension = [
  taskPlugin,
  taskStyles,
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const element = event.target as HTMLElement | null;
      const box = element?.closest?.('.cm-task-checkbox') as HTMLElement | null;
      if (!box) return false;
      const at = Number(box.getAttribute('data-task-at'));
      if (!Number.isFinite(at)) return false;
      event.preventDefault();
      return toggleTaskAt(view, at);
    },
  }),
];
