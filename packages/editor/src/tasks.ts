import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
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
    userEvent: TASK_TOGGLE_EVENT,
  });
  return true;
}

/** Marks a transaction that ticked a box, so the auto-sort knows to look. */
export const TASK_TOGGLE_EVENT = 'input.task';

/** `- [x] ` and friends: indent, then the whole task marker. */
const TASK_LINE = /^(\s*)([-*+][ \t]+\[([ xX])\][ \t]?)/;

function isDone(lineText: string): boolean {
  return TASK_LINE.exec(lineText)?.[3]?.toLowerCase() === 'x';
}

/** The contiguous run of task lines around `pos`, or null when there is none. */
export function taskListAround(
  state: EditorState,
  pos: number,
): { first: number; last: number } | null {
  const start = state.doc.lineAt(pos).number;
  if (!TASK_LINE.test(state.doc.line(start).text)) return null;

  let first = start;
  while (first > 1 && TASK_LINE.test(state.doc.line(first - 1).text)) first -= 1;
  let last = start;
  while (last < state.doc.lines && TASK_LINE.test(state.doc.line(last + 1).text)) last += 1;
  return { first, last };
}

/** Leading whitespace width, with a tab counting as one level of indent. */
function indentOf(text: string): number {
  return (/^[ \t]*/.exec(text)?.[0] ?? '').length;
}

/**
 * Completed tasks moved to the bottom of the list containing `pos`.
 *
 * Returns null when nothing needs to move. Scoped to one contiguous list, not
 * the note: a note with a shopping list and a project list must not have them
 * merged by a sort.
 *
 * Only the outermost items are reordered, and each carries its nested subtasks
 * with it — sorting the lines individually would leave a child stranded under
 * whichever unrelated item happened to end up above it.
 */
export function sortCompletedTasksAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; insert: string } | null {
  const range = taskListAround(state, pos);
  if (!range) return null;

  const lines: string[] = [];
  for (let n = range.first; n <= range.last; n++) lines.push(state.doc.line(n).text);

  // The shallowest indent in the list is its top level; anything deeper belongs
  // to the item above it.
  const top = Math.min(...lines.map(indentOf));
  const items: Array<{ lines: string[]; done: boolean }> = [];
  for (const line of lines) {
    if (indentOf(line) === top || items.length === 0) {
      items.push({ lines: [line], done: isDone(line) });
    } else {
      (items[items.length - 1] as { lines: string[] }).lines.push(line);
    }
  }

  const insert = [...items.filter((i) => !i.done), ...items.filter((i) => i.done)]
    .flatMap((i) => i.lines)
    .join('\n');

  const from = state.doc.line(range.first).from;
  const to = state.doc.line(range.last).to;
  if (state.doc.sliceString(from, to) === insert) return null;
  return { from, to, insert };
}

/**
 * Move a task to the bottom of its list as soon as it is completed.
 *
 * Two things here are less obvious than they look.
 *
 * The position sorted around comes from the change, not from the selection: a
 * checkbox is only clickable *off* the active line, so on a click the caret is
 * by definition somewhere else and sorting around it would sort the wrong list
 * — or, usually, no list at all.
 *
 * And the follow-up transaction is deferred to a microtask rather than
 * dispatched inline. Update listeners run innermost-last, so a nested dispatch
 * reports the sorted document first and the *pre-sort* document afterwards —
 * which is the version autosave would then write to disk. Deferring makes the
 * sort a plainly separate update, so the last document the app sees is the
 * sorted one. It also keeps the tick and the reorder as two undo steps.
 */
export function autoSortCompletedTasks(enabled: () => boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      /** Set on destroy so a queued sort never fires into a torn-down view. */
      private gone = false;

      update(update: ViewUpdate) {
        if (!update.docChanged || !enabled()) return;
        // Only react to a tick, and never to our own reordering, which loops.
        if (!update.transactions.some((t) => t.isUserEvent(TASK_TOGGLE_EVENT))) return;

        // Where the edit landed, in the new document.
        let at = -1;
        update.changes.iterChanges((_fromA, _toA, fromB) => {
          if (at === -1) at = fromB;
        });
        if (at === -1) return;

        const { view } = update;
        const doc = update.state.doc;
        const line = doc.lineAt(Math.min(at, doc.length));
        // Nothing to do unless the line just edited is now a completed task.
        if (!isDone(line.text)) return;

        void Promise.resolve().then(() => {
          if (this.gone) return;
          const change = sortCompletedTasksAt(view.state, line.from);
          if (!change) return;
          view.dispatch({ changes: change, userEvent: 'input.taskSort' });
        });
      }

      destroy() {
        this.gone = true;
      }
    },
  );
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
    border: 'solid var(--on-accent, #fff)',
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
